// ============================================================
// Supabase Edge Function — tuya-control
// ============================================================
// Responsável por falar com a Tuya Cloud API e controlar os
// dispositivos físicos da Casa BEM: smart plugs, lâmpadas,
// aspirador robô e controles IR (TV / Ar-condicionado).
//
// Deploy:
//   supabase functions deploy tuya-control --project-ref <seu-ref>
//
// Variáveis de ambiente necessárias (Supabase → Settings → Edge Functions):
//   TUYA_CLIENT_ID     — Access ID do Cloud Project da Tuya
//   TUYA_SECRET        — Access Secret do Cloud Project da Tuya
//   TUYA_BASE_URL      — Data center da conta (default: https://openapi.tuyaus.com)
//                        Brasil/América:  https://openapi.tuyaus.com
//                        Europa:          https://openapi.tuyaeu.com
//                        China:           https://openapi.tuyacn.com
//                        Índia:           https://openapi.tuyain.com
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE      = Deno.env.get("TUYA_BASE_URL") || "https://openapi.tuyaus.com";
const CLIENT_ID = Deno.env.get("TUYA_CLIENT_ID") || "";
const SECRET    = Deno.env.get("TUYA_SECRET")    || "";

// ─── HMAC-SHA256 helper ─────────────────────────────────────
async function hmacSha256(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

async function sha256Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Token (cache em memória) ───────────────────────────────
let tokenCache: { access_token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.access_token;
  }
  const path = "/v1.0/token?grant_type=1";
  const res  = await tuyaRequest("GET", path, "", "");
  if (!res.success) throw new Error(`token failed: ${JSON.stringify(res)}`);
  tokenCache = {
    access_token: res.result.access_token,
    expiresAt:    Date.now() + (res.result.expire_time * 1000),
  };
  return tokenCache.access_token;
}

// ─── Request assinado pra Tuya Cloud ────────────────────────
async function tuyaRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: string | object = "",
  token: string = "",
): Promise<any> {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const t       = Date.now().toString();
  const nonce   = crypto.randomUUID();
  const contentHash = await sha256Hex(bodyStr || "");
  // stringToSign = METHOD\nContent-SHA256\nHeaders\nURL
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const str = token
    ? CLIENT_ID + token + t + nonce + stringToSign
    : CLIENT_ID + t + nonce + stringToSign;
  const sign = await hmacSha256(SECRET, str);

  const headers: Record<string,string> = {
    "client_id":    CLIENT_ID,
    "sign":         sign,
    "t":            t,
    "sign_method":  "HMAC-SHA256",
    "nonce":        nonce,
    "Content-Type": "application/json",
  };
  if (token) headers["access_token"] = token;

  const url = BASE + path;
  const resp = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "DELETE" ? undefined : bodyStr,
  });
  const json = await resp.json();
  return json;
}

// ─── Helpers de alto nível ──────────────────────────────────
async function sendCommands(deviceId: string, commands: Array<{code:string; value:unknown}>) {
  const token = await getToken();
  return tuyaRequest(
    "POST",
    `/v1.0/iot-03/devices/${deviceId}/commands`,
    { commands },
    token,
  );
}

async function getStatus(deviceId: string): Promise<any[]> {
  const token = await getToken();
  const res = await tuyaRequest("GET", `/v1.0/iot-03/devices/${deviceId}/status`, "", token);
  return res.success ? res.result : [];
}

async function getStatusBatch(deviceIds: string[]): Promise<Record<string, any[]>> {
  // Endpoint batch da Tuya
  const token = await getToken();
  const ids = deviceIds.join(",");
  const res = await tuyaRequest("GET", `/v1.0/iot-03/devices/status?device_ids=${ids}`, "", token);
  if (!res.success) return {};
  const out: Record<string, any[]> = {};
  for (const entry of res.result || []) {
    out[entry.id] = entry.status;
  }
  return out;
}

// Extrai on/off do array de DPs retornado pela Tuya
function extractOnOff(dps: any[]): boolean | null {
  if (!Array.isArray(dps)) return null;
  const candidates = ["switch_led", "switch_1", "switch", "power", "power_go"];
  for (const c of candidates) {
    const dp = dps.find(x => x.code === c);
    if (dp) return !!dp.value;
  }
  return null;
}

// ─── IR Blaster (TV / AC) ───────────────────────────────────
// Para TVs a Tuya expõe:
//   POST /v2.0/infrareds/{ir_id}/remotes/{remote_id}/command
//   body: { category_id, remote_index, key, key_id }
// Para ARs um endpoint especializado:
//   POST /v2.0/infrareds/{ir_id}/air-conditioners/{remote_id}/command
//   body: { power, mode, temp, wind }
async function sendIRKey(irParent: string, remoteId: string, key: string) {
  const token = await getToken();
  return tuyaRequest(
    "POST",
    `/v2.0/infrareds/${irParent}/remotes/${remoteId}/command`,
    { key },
    token,
  );
}

async function sendACCommand(irParent: string, remoteId: string, cmd: {
  power?: 0|1; mode?: number; temp?: number; wind?: number;
}) {
  const token = await getToken();
  return tuyaRequest(
    "POST",
    `/v2.0/infrareds/${irParent}/air-conditioners/${remoteId}/command`,
    cmd,
    token,
  );
}

// ─── Handler principal ──────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // Sanity check
    if (!CLIENT_ID || !SECRET) {
      return json({
        success: false,
        error: "Configure TUYA_CLIENT_ID e TUYA_SECRET nas Edge Function Secrets.",
      });
    }

    // ──────────────────────────────────────────────────────
    // CONTROL — liga/desliga e comandos de parâmetros
    // ──────────────────────────────────────────────────────
    if (action === "control") {
      const type       = body.type as string;
      const devId      = body.device_id as string;
      const value      = body.value;
      const params     = body.params || {};
      const irParent   = body.device_ir_parent as string | null;
      const remoteId   = devId;   // Por convenção, devId = remote_id nos controles IR

      if (!devId) return json({ success: false, error: "device_id ausente" });

      // LUZ / SMART PLUG — switch_led ou switch_1
      if (type === "light" || type === "other" || !type) {
        const commands: any[] = [];
        if (typeof value === "boolean") {
          commands.push({ code: "switch_led", value });
          commands.push({ code: "switch_1",   value });
        }
        if (typeof params.brightness === "number") {
          // Tuya costuma usar 10..1000 em bright_value
          const bv = Math.round(10 + (Math.min(100, Math.max(0, params.brightness)) / 100) * 990);
          commands.push({ code: "bright_value",   value: bv });
          commands.push({ code: "bright_value_v2", value: bv });
        }
        const result = await sendCommands(devId, commands);
        return json({ success: !!result.success, result });
      }

      // ASPIRADOR ROBÔ
      if (type === "vacuum") {
        const commands: any[] = [];
        if (typeof value === "boolean") {
          commands.push({ code: "power_go", value });
          commands.push({ code: "power",    value });
          if (value)  commands.push({ code: "mode", value: "smart" });
          if (!value) commands.push({ code: "mode", value: "standby" });
        }
        if (params.vacuum_mode === "dock")  commands.push({ code: "mode", value: "chargego" });
        if (params.vacuum_mode === "spot")  commands.push({ code: "mode", value: "spot" });
        if (params.vacuum_mode === "pause") commands.push({ code: "power_go", value: false });
        const result = await sendCommands(devId, commands);
        return json({ success: !!result.success, result });
      }

      // TV (via IR Blaster)
      if (type === "tv") {
        if (!irParent) return json({
          success: false,
          error: "TV requer tuya_ir_parent_id (IR Blaster)",
        });
        const key = value ? "power" : "power"; // TV IR usa mesma tecla pra power toggle
        const result = await sendIRKey(irParent, remoteId, key);
        return json({ success: !!result.success, result });
      }

      // AR-CONDICIONADO (via IR Blaster — endpoint especializado)
      if (type === "ac") {
        if (!irParent) return json({
          success: false,
          error: "AC requer tuya_ir_parent_id (IR Blaster)",
        });
        // Mapa do modo Tuya: 0=cool, 1=heat, 2=auto, 3=fan, 4=dry
        const modeMap: Record<string, number> = { cool:0, heat:1, auto:2, fan:3, dry:4 };
        const cmd: any = {};
        if (typeof value === "boolean") cmd.power = value ? 1 : 0;
        if (typeof params.temperature === "number") cmd.temp = params.temperature;
        if (params.ac_mode && modeMap[params.ac_mode] !== undefined) cmd.mode = modeMap[params.ac_mode];
        const result = await sendACCommand(irParent, remoteId, cmd);
        return json({ success: !!result.success, result });
      }

      return json({ success: false, error: `tipo desconhecido: ${type}` });
    }

    // ──────────────────────────────────────────────────────
    // STATUS — consulta estado real (polling)
    // ──────────────────────────────────────────────────────
    if (action === "status") {
      const devId = body.device_id as string;
      if (!devId) return json({ success: false, error: "device_id ausente" });
      const dps = await getStatus(devId);
      const status = extractOnOff(dps);
      return json({ success: true, status, dps });
    }

    if (action === "status_all") {
      const ids = Array.isArray(body.device_ids) ? body.device_ids as string[] : [];
      if (ids.length === 0) return json({ success: true, statuses: {} });
      const batch = await getStatusBatch(ids);
      const statuses: Record<string, boolean | null> = {};
      for (const id of ids) {
        statuses[id] = extractOnOff(batch[id] || []);
      }
      return json({ success: true, statuses });
    }

    // ──────────────────────────────────────────────────────
    // AÇÕES ESPECIAIS DO ASPIRADOR
    // ──────────────────────────────────────────────────────
    if (action === "vacuum_dock") {
      const result = await sendCommands(body.device_id, [{ code: "mode", value: "chargego" }]);
      return json({ success: !!result.success, result });
    }

    if (action === "vacuum_locate") {
      const result = await sendCommands(body.device_id, [{ code: "seek", value: true }]);
      return json({ success: !!result.success, result });
    }

    // ──────────────────────────────────────────────────────
    // DISCOVERY — lista controles aprendidos num IR Blaster
    // (útil na UI pra escolher qual remote usar)
    // ──────────────────────────────────────────────────────
    if (action === "list_remotes") {
      const irParent = body.device_ir_parent as string;
      if (!irParent) return json({ success: false, error: "device_ir_parent ausente" });
      const token = await getToken();
      const res = await tuyaRequest("GET", `/v2.0/infrareds/${irParent}/remotes`, "", token);
      return json({ success: !!res.success, remotes: res.result || [] });
    }

    return json({ success: false, error: `action desconhecida: ${action}` });
  } catch (err) {
    console.error("[tuya-control] error:", err);
    return json({ success: false, error: String(err?.message || err) });
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
