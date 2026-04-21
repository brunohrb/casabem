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
      // Strategy: use /v1.3/iot-03/devices to list every device in the
      // Cloud project in one shot, then enrich with home/room names by
      // calling /v1.0/users/{uid}/homes + /v1.0/homes/{home_id}/rooms
      // per unique uid.
      const VERSION = "2026-04-21-v3";
      const trace: any = { version: VERSION, steps: [] };

      const arr = (v: any): any[] => {
        if (Array.isArray(v)) return v;
        if (v && typeof v === "object") {
          for (const k of ["list", "devices", "homes", "rooms", "data", "records"]) {
            if (Array.isArray(v[k])) return v[k];
          }
        }
        return [];
      };

      const safe = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
          const r = await fn();
          trace.steps.push({ label, ok: true });
          return r;
        } catch (e: any) {
          trace.steps.push({ label, ok: false, error: String(e?.message || e) });
          return null;
        }
      };

      // 1) List all project devices in one call.
      const listResp: any = await safe("iot03-devices", () =>
        tuyaRequest("GET", "/v1.3/iot-03/devices?page_size=50&page_no=1", token),
      );
      trace.list_success = listResp?.success;
      trace.list_has_result = !!listResp?.result;

      if (!listResp?.success) {
        return new Response(JSON.stringify({
          version: VERSION,
          error: "Tuya /v1.3/iot-03/devices failed",
          detail: listResp,
          trace,
        }), { status: 500, headers: corsHeaders });
      }

      const rawDevices = arr(listResp.result);
      trace.raw_devices_count = rawDevices.length;

      if (rawDevices.length === 0) {
        return new Response(JSON.stringify({
          version: VERSION,
          success: true,
          devices: [],
          warning:
            "Nenhum dispositivo no projeto Tuya Cloud. Vincule sua conta SmartLife " +
            "em: Tuya IoT Platform → Cloud → (seu projeto) → Devices → Link Tuya App Account.",
          trace,
        }), { headers: corsHeaders });
      }

      // 2) Enrich with home + room names per unique uid.
      const uidSet = new Set<string>();
      for (const d of rawDevices) { if (d?.uid) uidSet.add(String(d.uid)); }
      trace.unique_uids = uidSet.size;

      const homeByUid: Record<string, { name: string; home_id: any }> = {};
      const roomNameById: Record<string, string> = {};

      for (const uid of uidSet) {
        const homesResp: any = await safe(`homes-${uid}`, () =>
          tuyaRequest("GET", `/v1.0/users/${uid}/homes`, token),
        );
        if (!homesResp?.success) continue;
        const homes = arr(homesResp.result);
        if (homes.length === 0) continue;
        const primary = homes[0];
        homeByUid[uid] = { name: primary.name, home_id: primary.home_id };

        for (const h of homes) {
          if (!h?.home_id) continue;
          const roomsResp: any = await safe(`rooms-${h.home_id}`, () =>
            tuyaRequest("GET", `/v1.0/homes/${h.home_id}/rooms`, token),
          );
          if (!roomsResp?.success) continue;
          for (const r of arr(roomsResp.result)) {
            if (r?.room_id) roomNameById[String(r.room_id)] = r.name;
          }
        }
      }

      const devices = rawDevices.map((d: any) => {
        const home = homeByUid[String(d.uid)] ?? { name: "", home_id: null };
        const roomName = d.room_id ? roomNameById[String(d.room_id)] : undefined;
        return {
          tuya_id:    d.id,
          name:       d.name,
          home:       home.name || "Casa",
          home_id:    home.home_id,
          room:       roomName || home.name || "Casa",
          online:     !!d.online,
          icon:       d.icon,
          category:   d.category,
          product_id: d.product_id,
        };
      });

      return new Response(JSON.stringify({
        version: VERSION,
        success: true,
        devices,
        trace,
      }), { headers: corsHeaders });
    }

    throw new Error("Unknown action: " + action);

  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: err?.message ? String(err.message) : String(err),
        stack: err?.stack ? String(err.stack).split("\n").slice(0, 5).join("\n") : undefined,
      }),
      { status: 500, headers: corsHeaders },
    );
  }
});
