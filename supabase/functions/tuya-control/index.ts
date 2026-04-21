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
    const { action, device_id, value } = body;

    // action: "control" | "status" | "list_devices"
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
      // value: true/false for switch, or { code, value } for custom command
      const commands = typeof value === "boolean"
        ? [{ code: "switch_1", value }]
        : Array.isArray(value) ? value : [value];

      const result = await tuyaRequest(
        "POST",
        `/v1.0/devices/${device_id}/commands`,
        token,
        { commands }
      );
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
        for (const d of (assocResp.result?.devices ?? [])) {
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
        const homes = homesResp.result ?? [];

        for (const home of homes) {
          const [roomsResp, devsResp]: any[] = await Promise.all([
            tuyaRequest("GET", `/v1.0/homes/${home.home_id}/rooms`, token),
            tuyaRequest("GET", `/v1.0/homes/${home.home_id}/devices`, token),
          ]);

          const roomMap: Record<string, string> = {};
          if (roomsResp?.success) {
            for (const r of (roomsResp.result ?? [])) roomMap[r.room_id] = r.name;
          }
          if (devsResp?.success) {
            for (const d of (devsResp.result ?? [])) {
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
              });
            }
          }
        }
      }

      return new Response(JSON.stringify({ success: true, devices }), { headers: corsHeaders });
    }

    throw new Error("Unknown action: " + action);

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
