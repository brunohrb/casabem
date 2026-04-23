// Supabase Edge Function: tuya-control
// Proxies device control commands to Tuya IoT Cloud API
// Deploy with: supabase functions deploy tuya-control

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encode as hexEncode } from "https://deno.land/std@0.168.0/encoding/hex.ts";

// ── Tuya credentials (set as Supabase secrets) ───────────────────────────────
const TUYA_ACCESS_ID     = Deno.env.get("TUYA_ACCESS_ID")!;
const TUYA_ACCESS_SECRET = Deno.env.get("TUYA_ACCESS_SECRET")!;
const TUYA_BASE_URL      = Deno.env.get("TUYA_BASE_URL") ?? "https://openapi.tuyaus.com";

// ── Supabase credentials (auto-injected in Edge Functions) ───────────────────
const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY  = Deno.env.get("SUPABASE_ANON_KEY")!;

// ─────────────────────────────────────────────────────────────────────────────
// Tuya API signature helpers
// ─────────────────────────────────────────────────────────────────────────────

async function hmacSHA256(key: string, data: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key);
  const dataBytes = new TextEncoder().encode(data);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function sha256(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getTuyaToken(): Promise<string> {
  const t = Date.now().toString();
  const nonce = "";
  const method = "GET";
  const path = "/v1.0/token?grant_type=1";
  const contentHash = await sha256("");

  // Tuya v2: stringToSign = METHOD\n + sha256(body)\n + headers\n + url
  // signStr = client_id + t + nonce + stringToSign  (sem access_token no endpoint de token)
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const signStr = `${TUYA_ACCESS_ID}${t}${nonce}${stringToSign}`;
  const sign = await hmacSHA256(TUYA_ACCESS_SECRET, signStr);

  const resp = await fetch(`${TUYA_BASE_URL}${path}`, {
    headers: {
      "client_id":    TUYA_ACCESS_ID,
      "sign":         sign,
      "t":            t,
      "sign_method":  "HMAC-SHA256",
      "nonce":        nonce,
    },
  });

  const data = await resp.json();
  if (!data.success) throw new Error("Tuya token error: " + JSON.stringify(data));
  return data.result.access_token;
}

// Blindagem: alguns endpoints da Tuya às vezes devolvem `result` como
// objeto em vez de array (dependendo da versão). Este helper garante
// que toda iteração seja sobre array — evita "object is not iterable".
function asArray<T = any>(x: any): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x == null) return [];
  // Formatos aninhados comuns: { list: [...] }, { devices: [...] }, etc.
  for (const key of ["list", "devices", "remote_list", "remotes", "items", "data"]) {
    if (Array.isArray(x?.[key])) return x[key] as T[];
  }
  return [];
}

async function tuyaRequest(
  method: string,
  path: string,
  token: string,
  body?: object
): Promise<unknown> {
  const t = Date.now().toString();
  const nonce = "";
  const bodyStr = body ? JSON.stringify(body) : "";
  const bodyHash = await sha256(bodyStr);

  const stringToSign = `${method}\n${bodyHash}\n\n${path}`;
  const signStr = `${TUYA_ACCESS_ID}${token}${t}${nonce}${stringToSign}`;
  const sign = await hmacSHA256(TUYA_ACCESS_SECRET, signStr);

  const resp = await fetch(`${TUYA_BASE_URL}${path}`, {
    method,
    headers: {
      "client_id":    TUYA_ACCESS_ID,
      "access_token": token,
      "sign":         sign,
      "t":            t,
      "sign_method":  "HMAC-SHA256",
      "nonce":        nonce,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });

  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (!TUYA_ACCESS_ID || !TUYA_ACCESS_SECRET) {
    return new Response(
      JSON.stringify({
        error: "Tuya credentials missing",
        detail: "Set TUYA_ACCESS_ID and TUYA_ACCESS_SECRET as Supabase Edge Function secrets.",
      }),
      { status: 500, headers: corsHeaders },
    );
  }

  try {
    const body = await req.json();
    const { action, device_id, value, switch_code, ir_parent_id } = body;

    // action: "control" | "status" | "list_devices" | "ir_send"
    const token = await getTuyaToken();

    if (action === "list_devices") {
      // List all devices for the linked Smart Life account
      const uid = body.uid;
      if (!uid) throw new Error("uid required for list_devices");
      const result = await tuyaRequest("GET", `/v1.0/users/${uid}/devices`, token);
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    if (action === "status") {
      if (!device_id) throw new Error("device_id required");
      const result = await tuyaRequest("GET", `/v1.0/devices/${device_id}/status`, token);
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    if (action === "control") {
      if (!device_id) throw new Error("device_id required");

      // ── Dispositivo controlado por hub IR (ar, TV, etc.) ──────────
      // Quando o frontend passa `ir_parent_id`, tem que ir pelo
      // endpoint /v2.0/infrareds/... do hub (o device_id aqui é o
      // id do "controle remoto" pareado). Diferencia AC de
      // genérico (TV) pelo campo opcional body.device_type.
      if (ir_parent_id) {
        // Tuya tem VÁRIOS endpoints IR dependendo da versão/região e
        // de qual API o projeto subscreveu. Tentamos em ordem até um
        // devolver success:true. Retornamos attempts[] pro frontend
        // conseguir debugar se nenhum funcionar.
        const deviceType = body.device_type || "tv";
        const on = value === true || value === 1 || value === "1";
        const keyName = body.ir_key ?? "Power";

        type Attempt = {
          label:   string;
          method:  string;
          path:    string;
          body?:   object;
          resp?:   any;
          error?:  string;
        };
        const attempts: Attempt[] = [];

        if (deviceType === "ac") {
          // AC Standard Command — Tuya docs oficiais
          attempts.push({
            label: "v2 air-conditioners/command",
            method: "POST",
            path: `/v2.0/infrareds/${ir_parent_id}/air-conditioners/${device_id}/command`,
            body: { code: body.ir_code ?? "power", value: body.ir_value ?? (on ? 1 : 0) },
          });
          // Fallback v1
          attempts.push({
            label: "v1 air-conditioners/command",
            method: "POST",
            path: `/v1.0/infrareds/${ir_parent_id}/air-conditioners/${device_id}/command`,
            body: { code: body.ir_code ?? "power", value: body.ir_value ?? (on ? 1 : 0) },
          });
          // Alguns projetos usam send-command com string
          attempts.push({
            label: "v1 air-conditioners/send-command",
            method: "POST",
            path: `/v1.0/infrareds/${ir_parent_id}/air-conditioners/${device_id}/send-command`,
            body: { code: body.ir_code ?? "power", value: String(body.ir_value ?? (on ? 1 : 0)) },
          });
        } else {
          // Genérico (TV, fan, etc.) — Tuya docs oficiais
          //
          // Tem que TENTAR em ordem porque cada versão da API aceita
          // um formato diferente.
          //
          // 1) Send Standard Command (novo, v2.0):
          attempts.push({
            label: "v2 remotes/command (standard)",
            method: "POST",
            path: `/v2.0/infrareds/${ir_parent_id}/remotes/${device_id}/command`,
            body: { code: keyName.toLowerCase(), value: on ? 1 : 0 },
          });
          // 2) Send Key Command — "raw" (v2.0):
          attempts.push({
            label: "v2 remotes/raw/command",
            method: "POST",
            path: `/v2.0/infrareds/${ir_parent_id}/remotes/${device_id}/raw/command`,
            body: { category_id: 2, key: keyName, key_id: 1 },
          });
          // 3) Legacy send-keys (v1.0) — body simples, funciona em conta antiga:
          attempts.push({
            label: "v1 remotes/send-keys",
            method: "POST",
            path: `/v1.0/infrareds/${ir_parent_id}/remotes/${device_id}/send-keys`,
            body: { key: keyName },
          });
          // 4) Endpoint /keys/{key_id} sem body (tentativa anterior):
          attempts.push({
            label: "v2 remotes/keys/{key}",
            method: "POST",
            path: `/v2.0/infrareds/${ir_parent_id}/remotes/${device_id}/keys/${encodeURIComponent(keyName)}`,
            body: undefined,
          });
        }

        let winner = "";
        let finalResp: any = null;
        for (const a of attempts) {
          try {
            a.resp = await tuyaRequest(a.method, a.path, token, a.body);
            if (a.resp?.success) {
              winner = a.label;
              finalResp = a.resp;
              break;
            }
          } catch (e) {
            a.error = String(e);
          }
        }

        return new Response(
          JSON.stringify({
            success:  !!winner,
            winner:   winner || null,
            result:   finalResp?.result ?? null,
            msg:      finalResp?.msg ?? (attempts.find(a => a.resp?.msg)?.resp?.msg ?? null),
            code:     finalResp?.code ?? (attempts.find(a => a.resp?.code)?.resp?.code ?? null),
            attempts: attempts.map(a => ({
              label:   a.label,
              path:    a.path,
              sent:    a.body ?? null,
              success: a.resp?.success ?? null,
              code:    a.resp?.code ?? null,
              msg:     a.resp?.msg ?? null,
              error:   a.error ?? null,
            })),
          }),
          { headers: corsHeaders },
        );
      }

      // ── Dispositivo direto (relé, tomada, lâmpada Wi-Fi) ──────────
      // value:
      //   - boolean         → usa `switch_code` do body (default 'switch_1')
      //   - { code, value } → comando custom (permite brightness, mode, etc.)
      //   - [ {code,value} ]→ lista de comandos
      const code = switch_code || "switch_1";
      const commands = typeof value === "boolean"
        ? [{ code, value }]
        : Array.isArray(value) ? value : [value];

      const result = await tuyaRequest(
        "POST",
        `/v1.0/devices/${device_id}/commands`,
        token,
        { commands }
      );
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    if (action === "ir_list_remotes") {
      // Dado o tuya_device_id do hub IR, tenta descobrir os aparelhos
      // pareados. A Tuya tem VÁRIOS endpoints que fazem isso dependendo
      // de versão da API, região e se o projeto subscreveu "Universal IR
      // Remote Control". Tentamos todos e devolvemos o que conseguiu +
      // diagnóstico bruto pra debug.
      const hub = body.ir_parent_id || body.hub_id || device_id;
      if (!hub) throw new Error("ir_parent_id (hub) required");

      const tries: Array<{ path: string; label: string; resp?: any; error?: string }> = [
        { path: `/v2.0/infrareds/${hub}/remotes`,             label: "v2.0 infrareds/remotes" },
        { path: `/v1.0/infrareds/${hub}/remotes`,             label: "v1.0 infrareds/remotes" },
        { path: `/v2.0/infrareds/${hub}/remote-devices`,      label: "v2.0 infrareds/remote-devices" },
        { path: `/v1.0/devices/${hub}/sub-devices`,           label: "v1.0 devices/sub-devices" },
      ];

      // Também puxa info do próprio hub pra diagnóstico (categoria, online).
      let hubInfo: any = null;
      try {
        hubInfo = await tuyaRequest("GET", `/v1.0/devices/${hub}`, token);
      } catch (e) {
        hubInfo = { error: String(e) };
      }

      let remotes: any[] = [];
      let winner = "";
      for (const t of tries) {
        try {
          t.resp = await tuyaRequest("GET", t.path, token);
          const list = asArray<any>(t.resp?.result);
          if (list.length > 0) {
            remotes = list.map((rr: any) => {
              const cat = String(rr.category_id ?? rr.category ?? "").toLowerCase();
              let device_type = "other";
              if (cat === "5" || cat.includes("ac") || cat.includes("air")) device_type = "ac";
              else if (cat === "1" || cat.includes("tv"))                    device_type = "tv";
              else if (cat === "4" || cat.includes("fan"))                   device_type = "fan";
              return {
                remote_id:    rr.remote_id || rr.device_id || rr.id || rr.sub_id,
                remote_name:  rr.remote_name || rr.name || "",
                brand_name:   rr.brand_name || "",
                category_id:  rr.category_id ?? rr.category ?? null,
                device_type,
              };
            }).filter((r: any) => r.remote_id);
            if (remotes.length > 0) {
              winner = t.label;
              break;
            }
          }
        } catch (e) {
          t.error = String(e);
        }
      }

      return new Response(
        JSON.stringify({
          success:   true,
          hub,
          remotes,
          winner:    winner || null,
          hub_info:  hubInfo,
          attempts:  tries.map(t => ({
            label:    t.label,
            path:     t.path,
            success:  t.resp?.success ?? null,
            msg:      t.resp?.msg ?? null,
            code:     t.resp?.code ?? null,
            count:    asArray(t.resp?.result).length,
            error:    t.error ?? null,
          })),
        }),
        { headers: corsHeaders },
      );
    }

    if (action === "ir_send") {
      // Envio IR custom: usado por futuras funções (aprender/tocar chave
      // específica, mudar temperatura, etc). Body esperado:
      //   { ir_parent_id, device_id, device_type: 'ac'|'tv',
      //     ir_code?: string, ir_value?: any, ir_key?: string }
      if (!ir_parent_id || !device_id) {
        throw new Error("ir_parent_id + device_id required");
      }
      const deviceType = body.device_type || "tv";
      let path: string;
      let reqBody: object | undefined;
      if (deviceType === "ac") {
        path = `/v2.0/infrareds/${ir_parent_id}/air-conditioners/${device_id}/command`;
        reqBody = { code: body.ir_code ?? "power", value: body.ir_value ?? 1 };
      } else {
        const keyId = body.ir_key ?? "Power";
        path = `/v2.0/infrareds/${ir_parent_id}/remotes/${device_id}/keys/${encodeURIComponent(keyId)}`;
        reqBody = undefined;
      }
      const result = await tuyaRequest("POST", path, token, reqBody);
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    if (action === "get_devices_by_home") {
      // Get all homes then all devices
      const result = await tuyaRequest("GET", `/v1.0/homes?page_size=20&page_no=1`, token);
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    if (action === "list_scenes") {
      // Lista todas as cenas (Tap-to-Run / Scenario) de todas as homes
      // associadas. Essas cenas usam Smart Home Basic Service (sem quota
      // de IR) e são o caminho que a skill Alexa nativa usa pra disparar
      // ações em ares/TVs controlados pelo hub IR.
      //
      // Tuya tem DUAS APIs de cenas dependendo da versão do app:
      //   - /v1.0/homes/{home_id}/scenes  (legacy, "Tap-to-Run")
      //   - /v2.0/scenes                  (novo, "Scene Linkage")
      //
      // Tentamos as duas e mergeamos.
      const allScenes: any[] = [];
      const diagnostics: any[] = [];

      // 1) Descobre homes pelos UIDs ligados ao projeto
      const uidSet = new Set<string>();
      let lastRowKey = "";
      for (let page = 0; page < 5; page++) {
        const qs = lastRowKey
          ? `?last_row_key=${encodeURIComponent(lastRowKey)}&size=50`
          : `?size=50`;
        const r: any = await tuyaRequest(
          "GET", `/v1.0/iot-01/associated-users/devices${qs}`, token,
        );
        if (!r?.success) break;
        const assocDevices = Array.isArray(r.result?.devices)
          ? r.result.devices : asArray(r.result);
        for (const d of assocDevices) if (d.uid) uidSet.add(d.uid);
        if (!r.result?.has_more) break;
        lastRowKey = r.result?.last_row_key ?? "";
        if (!lastRowKey) break;
      }

      // 2) Pra cada uid, pega as homes
      const homes: Array<{ home_id: string | number; name: string }> = [];
      for (const uid of uidSet) {
        const homesResp: any = await tuyaRequest("GET", `/v1.0/users/${uid}/homes`, token);
        if (!homesResp?.success) continue;
        for (const h of asArray<any>(homesResp.result)) {
          homes.push({ home_id: h.home_id, name: h.name });
        }
      }

      // 3) Pra cada home, lista as scenes (duas APIs)
      for (const home of homes) {
        // v1.0 — Tap-to-Run tradicional
        try {
          const r1: any = await tuyaRequest(
            "GET", `/v1.0/homes/${home.home_id}/scenes`, token,
          );
          diagnostics.push({
            home: home.name, api: "v1.0/homes/{id}/scenes",
            success: r1?.success, msg: r1?.msg, count: asArray(r1?.result).length,
          });
          for (const sc of asArray<any>(r1?.result)) {
            allScenes.push({
              scene_id:   sc.scene_id || sc.id,
              name:       sc.name,
              home_id:    home.home_id,
              home_name:  home.name,
              enabled:    sc.enabled ?? true,
              api:        "v1.0",
            });
          }
        } catch (e) {
          diagnostics.push({ home: home.name, api: "v1.0", error: String(e) });
        }

        // v2.0 — Scene Linkage (novo)
        try {
          const r2: any = await tuyaRequest(
            "GET", `/v2.0/homes/${home.home_id}/scenes?space_id=${home.home_id}`, token,
          );
          diagnostics.push({
            home: home.name, api: "v2.0/homes/{id}/scenes",
            success: r2?.success, msg: r2?.msg,
            count: asArray(r2?.result?.list ?? r2?.result).length,
          });
          const list = asArray<any>(r2?.result?.list ?? r2?.result);
          for (const sc of list) {
            // Evita duplicata se já veio na v1
            const id = sc.scene_id || sc.id;
            if (!allScenes.some(s => s.scene_id === id)) {
              allScenes.push({
                scene_id:   id,
                name:       sc.name,
                home_id:    home.home_id,
                home_name:  home.name,
                enabled:    sc.enabled ?? true,
                api:        "v2.0",
              });
            }
          }
        } catch (e) {
          diagnostics.push({ home: home.name, api: "v2.0", error: String(e) });
        }
      }

      return new Response(
        JSON.stringify({
          success:     true,
          scenes:      allScenes,
          homes:       homes.map(h => ({ id: h.home_id, name: h.name })),
          diagnostics,
        }),
        { headers: corsHeaders },
      );
    }

    if (action === "trigger_scene") {
      // Dispara uma cena Tuya. Aceita scene_id e (opcional) home_id/api.
      // Como cada API tem um path diferente de trigger, tentamos vários.
      const sid = body.scene_id || body.sceneId;
      let   hid = body.home_id;
      if (!sid) throw new Error("scene_id required");

      // Se o cliente não passou home_id (ex.: toggle do card direto),
      // descobre sozinho: varre homes do projeto e olha qual contém
      // essa scene_id. Evita forçar o frontend a carregar cenas antes.
      if (!hid) {
        try {
          const uidSet = new Set<string>();
          let lastRowKey = "";
          for (let page = 0; page < 3; page++) {
            const qs = lastRowKey
              ? `?last_row_key=${encodeURIComponent(lastRowKey)}&size=50`
              : `?size=50`;
            const r: any = await tuyaRequest(
              "GET", `/v1.0/iot-01/associated-users/devices${qs}`, token,
            );
            if (!r?.success) break;
            const assocDevices = Array.isArray(r.result?.devices)
              ? r.result.devices : asArray(r.result);
            for (const d of assocDevices) if (d.uid) uidSet.add(d.uid);
            if (!r.result?.has_more) break;
            lastRowKey = r.result?.last_row_key ?? "";
            if (!lastRowKey) break;
          }
          outer:
          for (const uid of uidSet) {
            const homesResp: any = await tuyaRequest(
              "GET", `/v1.0/users/${uid}/homes`, token,
            );
            for (const h of asArray<any>(homesResp?.result)) {
              const s: any = await tuyaRequest(
                "GET", `/v1.0/homes/${h.home_id}/scenes`, token,
              );
              if (asArray<any>(s?.result).some(x =>
                (x.scene_id || x.id) === sid
              )) {
                hid = h.home_id;
                break outer;
              }
            }
          }
        } catch (e) {
          console.warn("home_id auto-discover failed", e);
        }
      }

      const tries: Array<{ label: string; method: string; path: string; body?: object }> = [];
      if (hid) {
        tries.push({
          label: "v1.0 homes/{hid}/scenes/{sid}/trigger",
          method: "POST",
          path: `/v1.0/homes/${hid}/scenes/${sid}/trigger`,
        });
      }
      tries.push(
        {
          label: "v1.0 scenes/{sid}/trigger",
          method: "POST",
          path: `/v1.0/scenes/${sid}/trigger`,
        },
        {
          label: "v2.0 cloud/scene/rule/trigger",
          method: "POST",
          path: `/v2.0/cloud/scene/rule/trigger`,
          body: { ids: [sid] },
        },
        {
          label: "v2.0 scenes/{sid}/actions/trigger",
          method: "POST",
          path: `/v2.0/scenes/${sid}/actions/trigger`,
        },
      );

      let winner = "";
      let finalResp: any = null;
      for (const t of tries) {
        try {
          const r: any = await tuyaRequest(t.method, t.path, token, t.body);
          (t as any).resp = r;
          if (r?.success) {
            winner = t.label;
            finalResp = r;
            break;
          }
        } catch (e) {
          (t as any).error = String(e);
        }
      }

      return new Response(
        JSON.stringify({
          success:  !!winner,
          winner:   winner || null,
          home_id:  hid || null,          // pro frontend cachear se quiser
          result:   finalResp?.result ?? null,
          attempts: tries.map((t: any) => ({
            label:   t.label,
            path:    t.path,
            success: t.resp?.success ?? null,
            code:    t.resp?.code ?? null,
            msg:     t.resp?.msg ?? null,
            error:   t.error ?? null,
          })),
        }),
        { headers: corsHeaders },
      );
    }

    if (action === "list_all_devices") {
      // Discovery flow for the "Sincronizar com SmartLife" modal.
      //
      // Tuya Cloud has no global "/v1.0/homes" endpoint — homes are scoped to
      // a user (uid). So we first discover the uid(s) of every SmartLife
      // account linked to this Tuya Cloud project via
      // /v1.0/iot-01/associated-users/devices, then for each uid we walk
      // homes → rooms+devices to build a flat list.
      //
      // Shape: { success, devices: [{ tuya_id, name, home, room, online,
      //          icon, category, product_id }] }

      // 1) Collect uids of all linked SmartLife users (paginated).
      const uidSet = new Set<string>();
      let lastRowKey = "";
      for (let page = 0; page < 10; page++) {
        const qs = lastRowKey
          ? `?last_row_key=${encodeURIComponent(lastRowKey)}&size=50`
          : `?size=50`;
        const assocResp: any = await tuyaRequest(
          "GET", `/v1.0/iot-01/associated-users/devices${qs}`, token,
        );
        if (!assocResp?.success) {
          return new Response(
            JSON.stringify({
              error: "Tuya associated-users lookup failed",
              detail: assocResp,
            }),
            { status: 500, headers: corsHeaders },
          );
        }
        const assocDevices = Array.isArray(assocResp.result?.devices)
          ? assocResp.result.devices
          : asArray(assocResp.result);
        for (const d of assocDevices) {
          if (d.uid) uidSet.add(d.uid);
        }
        if (!assocResp.result?.has_more) break;
        lastRowKey = assocResp.result?.last_row_key ?? "";
        if (!lastRowKey) break;
      }

      if (uidSet.size === 0) {
        return new Response(
          JSON.stringify({
            success: true,
            devices: [],
            warning: "Nenhuma conta SmartLife vinculada ao projeto Tuya Cloud. " +
                     "Vincule em: Tuya IoT Platform → Cloud → (seu projeto) → Devices → Link Tuya App Account.",
          }),
          { headers: corsHeaders },
        );
      }

      // 2) For each uid, get homes → rooms + devices.
      const devices: any[] = [];
      for (const uid of uidSet) {
        const homesResp: any = await tuyaRequest(
          "GET", `/v1.0/users/${uid}/homes`, token,
        );
        if (!homesResp?.success) continue;
        const homes = asArray<any>(homesResp.result);

        for (const home of homes) {
          const [roomsResp, devsResp]: any[] = await Promise.all([
            tuyaRequest("GET", `/v1.0/homes/${home.home_id}/rooms`, token),
            tuyaRequest("GET", `/v1.0/homes/${home.home_id}/devices`, token),
          ]);

          const roomMap: Record<string, string> = {};
          if (roomsResp?.success) {
            for (const r of asArray<any>(roomsResp.result)) roomMap[r.room_id] = r.name;
          }
          if (devsResp?.success) {
            for (const d of asArray<any>(devsResp.result)) {
              devices.push({
                tuya_id:    d.id,
                name:       d.name,
                home:       home.name,
                home_id:    home.home_id,
                room:       d.room_id && roomMap[d.room_id] ? roomMap[d.room_id] : home.name,
                online:     !!d.online,
                icon:       d.icon,
                category:   d.category,
                product_id: d.product_id,
                biz_type:   d.biz_type,
                channels:   [] as string[],
              });
            }
          }
        }
      }

      // 3) Para cada device, consulta /status pra descobrir os canais
      //    (switch_1, switch_2, ..., switch_led). Interruptores multi-tecla
      //    têm >1 canal — o front usa isso pra criar uma entrada por tecla.
      const CHANNEL_RE = /^switch_(\d+|led)$/;
      const statusResps = await Promise.all(
        devices.map(d =>
          tuyaRequest("GET", `/v1.0/devices/${d.tuya_id}/status`, token)
            .catch(() => null)
        )
      );
      for (let i = 0; i < devices.length; i++) {
        const r: any = statusResps[i];
        const status = asArray<any>(r?.result);
        const channels = status
          .map((s: any) => s.code)
          .filter((c: string) => CHANNEL_RE.test(c));
        // Ordena: numéricos ascendentes, switch_led por último
        channels.sort((a: string, b: string) => {
          if (a === "switch_led") return 1;
          if (b === "switch_led") return -1;
          return parseInt(a.split("_")[1]) - parseInt(b.split("_")[1]);
        });
        devices[i].channels = channels;
      }

      // 4) Descoberta IR: identifica hubs (category wnykq / ykq) e
      //    busca a lista de remotes pareados. Marca cada aparelho
      //    filho com { ir_parent_id, ir_device_type } para o front
      //    cadastrar direto certo.
      const IR_HUB_CATEGORIES = new Set(["wnykq", "ykq", "infrared_remote"]);
      const hubs = devices.filter(d => IR_HUB_CATEGORIES.has(d.category));
      const remoteToHub = new Map<string, string>();      // remote_id → hub_id
      const remoteTypes = new Map<string, string>();      // remote_id → 'ac'|'tv'|'fan'|...
      const remoteNames = new Map<string, string>();      // remote_id → nome bonito do remote

      for (const hub of hubs) {
        try {
          const resp: any = await tuyaRequest(
            "GET",
            `/v2.0/infrareds/${hub.tuya_id}/remotes`,
            token,
          );
          const remotes = asArray<any>(resp?.result);
          for (const rr of remotes) {
            // API às vezes devolve remote_id, às vezes device_id.
            const rid = rr.remote_id || rr.device_id || rr.id;
            if (!rid) continue;
            remoteToHub.set(rid, hub.tuya_id);
            remoteNames.set(rid, rr.remote_name || rr.name || "");

            // Tipo do aparelho. Tuya categoriza (1 = TV, 2 = STB,
            // 3 = Som, 4 = Fan, 5 = AC, 6 = Box, 7 = Aircleaner,
            // 8 = Projector, 9 = DVD, 10 = AmpLifier, 11 = Camera,
            // 12 = Light, 13 = Others).
            const cat = String(rr.category_id ?? rr.category ?? "").toLowerCase();
            if (cat === "5" || cat.includes("ac") || cat.includes("air")) {
              remoteTypes.set(rid, "ac");
            } else if (cat === "1" || cat.includes("tv")) {
              remoteTypes.set(rid, "tv");
            } else if (cat === "4" || cat.includes("fan")) {
              remoteTypes.set(rid, "fan");
            } else {
              remoteTypes.set(rid, "other");
            }
          }
        } catch (e) {
          // Hub sem permissão ou API fora — segue.
          console.warn("IR hub remotes fetch error", hub.tuya_id, e);
        }
      }

      for (const d of devices) {
        // Se esse tuya_id é um remote pareado, anota o hub pai.
        if (remoteToHub.has(d.tuya_id)) {
          d.ir_parent_id = remoteToHub.get(d.tuya_id);
          d.ir_device_type = remoteTypes.get(d.tuya_id) ?? "other";
        }
        // Categoria por sub-device (quando Tuya devolve separado)
        const cat = String(d.category ?? "").toLowerCase();
        if (!d.ir_device_type) {
          if (cat === "infrared_ac")   d.ir_device_type = "ac";
          else if (cat === "infrared_tv") d.ir_device_type = "tv";
          else if (cat === "infrared_fan") d.ir_device_type = "fan";
        }
      }

      return new Response(JSON.stringify({
        success: true,
        devices,
        ir_hubs: hubs.map(h => ({ tuya_id: h.tuya_id, name: h.name })),
      }), { headers: corsHeaders });
    }

    throw new Error("Unknown action: " + action);

  } catch (err) {
    const msg = err instanceof Error
      ? `${err.name}: ${err.message}${err.stack ? "\n" + err.stack.split("\n").slice(0, 3).join("\n") : ""}`
      : String(err);
    console.error("tuya-control error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: corsHeaders }
    );
  }
});
