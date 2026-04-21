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
        const deviceType = body.device_type || "tv";    // "ac" | "tv" | "other"
        const on = value === true || value === 1 || value === "1";

        let path: string;
        let reqBody: object | undefined;

        if (deviceType === "ac") {
          // AC: /air-conditioners/{remote_id}/command com {code, value}
          // code: "power" (0/1), "M" (mode), "T" (temp), "F" (fan)
          const acCode  = body.ir_code  ?? "power";
          const acValue = body.ir_value ?? (on ? 1 : 0);
          path = `/v2.0/infrareds/${ir_parent_id}/air-conditioners/${device_id}/command`;
          reqBody = { code: acCode, value: acValue };
        } else {
          // Genérico (TV, ventilador, som etc.): remotes/{remote_id}/keys/{key_id}
          // A chave padrão pra power é "Power" na biblioteca Tuya.
          const keyId = body.ir_key ?? "Power";
          path = `/v2.0/infrareds/${ir_parent_id}/remotes/${device_id}/keys/${encodeURIComponent(keyId)}`;
          reqBody = undefined;   // endpoint não recebe body
        }

        const result = await tuyaRequest("POST", path, token, reqBody);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
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
      // Dado o tuya_device_id do hub IR, lista os aparelhos ("remotes")
      // pareados nele. Cada resultado vem com o remote_id (= tuya_device_id
      // que o frontend deve cadastrar no casa BEM), nome e tipo.
      const hub = body.ir_parent_id || body.hub_id || device_id;
      if (!hub) throw new Error("ir_parent_id (hub) required");
      const resp: any = await tuyaRequest(
        "GET", `/v2.0/infrareds/${hub}/remotes`, token,
      );
      const remotes = asArray<any>(resp?.result).map((rr: any) => {
        const cat = String(rr.category_id ?? rr.category ?? "").toLowerCase();
        let device_type = "other";
        if (cat === "5" || cat.includes("ac") || cat.includes("air")) device_type = "ac";
        else if (cat === "1" || cat.includes("tv")) device_type = "tv";
        else if (cat === "4" || cat.includes("fan")) device_type = "fan";
        return {
          remote_id:    rr.remote_id || rr.device_id || rr.id,
          remote_name:  rr.remote_name || rr.name || "",
          brand_name:   rr.brand_name || "",
          category_id:  rr.category_id ?? rr.category ?? null,
          device_type,
        };
      });
      return new Response(
        JSON.stringify({ success: true, hub, remotes, raw: resp }),
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
