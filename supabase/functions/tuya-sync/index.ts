// ============================================================
// casa BEM · tuya-sync
// ------------------------------------------------------------
// Cron dispara a cada 5 min. A função decide se executa ou pula
// baseado no horário (BRT) e no orçamento mensal Tuya.
//
// Agenda (horário de Brasília, UTC-3):
//   Seg–Sex  07:30–12:30  a cada 30 min
//   Seg–Sex  12:30–18:00  a cada  5 min
//   Seg–Sex  18:00–23:30  a cada 40 min
//   Seg–Sex  23:30–07:30  parado
//   Sábado   08:00–23:00  a cada  2 h
//   Domingo  09:00–22:00  a cada  3 h
//
// Orçamento: 21 IDs × 2 chamadas = 42/sync. Limite 95% de 80.645.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TUYA_CONTROL_URL = Deno.env.get("TUYA_CONTROL_URL")
                      ?? `${SUPABASE_URL}/functions/v1/tuya-control`;
const SERVICE_AUTH_KEY = Deno.env.get("SERVICE_AUTH_KEY") ?? SERVICE_KEY;

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const CALLS_PER_SYNC  = 42;
const MAX_CALLS_MONTH = 76_600; // 95% de 80.645

// ── Agenda BRT ───────────────────────────────────────────────
function getRequiredInterval(): number | null {
  const now = new Date();
  // BRT = UTC-3 (Brasil não usa horário de verão desde 2019)
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const dow = brt.getUTCDay();
  const t   = brt.getUTCHours() * 60 + brt.getUTCMinutes();

  if (dow >= 1 && dow <= 5) {
    if (t >= 7*60+30 && t < 12*60+30) return 30;
    if (t >= 12*60+30 && t < 18*60)   return 5;
    if (t >= 18*60 && t < 23*60+30)   return 40;
    return null;
  }
  if (dow === 6 && t >= 8*60 && t < 23*60)  return 120;
  if (dow === 0 && t >= 9*60 && t < 22*60)  return 180;
  return null;
}

// ── Orçamento mensal ─────────────────────────────────────────
async function checkBudget(): Promise<boolean> {
  const month = new Date().toISOString().slice(0, 7);
  await db.from("sync_budget").upsert(
    { month, runs: 0, calls_used: 0, skipped: 0 },
    { onConflict: "month", ignoreDuplicates: true },
  );
  const { data } = await db.from("sync_budget")
    .select("calls_used").eq("month", month).single();
  return ((data?.calls_used ?? 0) + CALLS_PER_SYNC) <= MAX_CALLS_MONTH;
}

async function recordRun(skipped = false) {
  const month = new Date().toISOString().slice(0, 7);
  const { data } = await db.from("sync_budget")
    .select("runs, calls_used, skipped").eq("month", month).single();
  if (skipped) {
    await db.from("sync_budget")
      .update({ skipped: (data?.skipped ?? 0) + 1, updated_at: new Date().toISOString() })
      .eq("month", month);
  } else {
    await db.from("sync_budget").update({
      runs: (data?.runs ?? 0) + 1,
      calls_used: (data?.calls_used ?? 0) + CALLS_PER_SYNC,
      updated_at: new Date().toISOString(),
    }).eq("month", month);
  }
}

// ── Helpers Tuya ─────────────────────────────────────────────
async function tuyaStatus(tuyaDeviceId: string): Promise<any> {
  const r = await fetch(TUYA_CONTROL_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${SERVICE_AUTH_KEY}`,
      "apikey":        SERVICE_AUTH_KEY,
    },
    body: JSON.stringify({ action: "status", device_id: tuyaDeviceId }),
  });
  return r.json();
}

function extractStatus(
  points: Array<{ code: string; value: unknown }>,
  switchCode: string | null | undefined,
  multi: boolean,
): boolean | null {
  if (!Array.isArray(points)) return null;
  if (switchCode) {
    const p = points.find(x => x.code === switchCode);
    if (p && typeof p.value === "boolean") return p.value;
  }
  if (!multi) {
    for (const code of ["switch_led", "switch_1", "switch", "led_switch"]) {
      const p = points.find(x => x.code === code);
      if (p && typeof p.value === "boolean") return p.value;
    }
    const power = points.find(x => x.code === "power" || x.code === "work_state");
    if (power && typeof power.value === "boolean") return power.value;
  }
  return null;
}

function extractBrightness(points: Array<{ code: string; value: unknown }>): number | null {
  if (!Array.isArray(points)) return null;
  for (const code of ["bright_value", "bright_value_v2", "brightness"]) {
    const p = points.find(x => x.code === code);
    if (p && typeof p.value === "number") return Math.round((p.value / 1000) * 100);
  }
  return null;
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Handler principal ─────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const started = Date.now();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const force = body?.force === true; // sync manual ignora agenda e tempo

  // 1. Pausa manual (force ignora pausa)
  const { data: settings } = await db.from("app_settings")
    .select("sync_paused, last_sync_at").eq("id", 1).single();
  if (!force && settings?.sync_paused) {
    return json({ success: true, skipped: true, reason: "paused" });
  }

  // 2. Agenda horária (force ignora agenda)
  const requiredInterval = getRequiredInterval();
  if (!force && requiredInterval === null) {
    return json({ success: true, skipped: true, reason: "outside_schedule" });
  }

  // 3. Tempo mínimo desde último sync (force ignora)
  if (!force && settings?.last_sync_at) {
    const minutesSince = (Date.now() - new Date(settings.last_sync_at).getTime()) / 60000;
    if (minutesSince < (requiredInterval ?? 5) - 0.5) {
      return json({ success: true, skipped: true, reason: "too_soon", minutes_since: Math.round(minutesSince), required: requiredInterval });
    }
  }

  // 4. Orçamento mensal (force também respeita — não queremos estourar)
  if (!(await checkBudget())) {
    await recordRun(true);
    return json({ success: true, skipped: true, reason: "budget_exhausted" });
  }

  // 5. Executar sync
  try {
    const { data: devices, error } = await db
      .from("devices")
      .select("id, name, type, room, status, brightness, tuya_device_id, tuya_switch_code")
      .not("tuya_device_id", "is", null);
    if (error) throw error;
    if (!devices || devices.length === 0) {
      await recordRun();
      return json({ success: true, checked: 0, changed: 0 });
    }

    let changed = 0;
    const changes: any[] = [];
    const statusCache = new Map<string, any>();
    const mapCount    = new Map<string, number>();
    for (const d of devices) {
      mapCount.set(d.tuya_device_id!, (mapCount.get(d.tuya_device_id!) ?? 0) + 1);
    }

    for (const d of devices) {
      try {
        let res = statusCache.get(d.tuya_device_id!);
        if (!res) {
          res = await tuyaStatus(d.tuya_device_id!);
          statusCache.set(d.tuya_device_id!, res);
        }
        if (!res || !res.success) {
          changes.push({ id: d.id, error: res?.msg ?? "tuya fail" });
          continue;
        }
        const points     = res.result ?? [];
        const isMulti    = (mapCount.get(d.tuya_device_id!) ?? 1) > 1;
        const realStatus = extractStatus(points, d.tuya_switch_code, isMulti);
        const realBright = extractBrightness(points);

        if (realStatus === null) {
          await db.from("devices").update({ last_tuya_sync_at: new Date().toISOString() }).eq("id", d.id);
          continue;
        }

        const diffStatus = realStatus !== d.status;
        const diffBright = realBright != null && d.type === "light" && realBright !== (d.brightness ?? 0);
        const patch: Record<string, unknown> = { last_tuya_sync_at: new Date().toISOString() };
        if (diffStatus) { patch.status = realStatus; patch.last_source = "manual"; patch.last_changed = "manual"; }
        if (diffBright)  patch.brightness = realBright;

        if (Object.keys(patch).length > 1) {
          await db.from("devices").update(patch).eq("id", d.id);
          if (diffStatus || diffBright) {
            changed++;
            changes.push({ id: d.id, name: d.name, status: diffStatus ? realStatus : undefined, brightness: diffBright ? realBright : undefined });
            await db.from("commands_log").insert({
              device_id: d.id, device_name: d.name,
              command:   diffStatus ? `Interruptor físico: ${realStatus ? "ligado" : "desligado"}` : `Brilho alterado: ${realBright}%`,
              source:    "manual", success: true,
            });
          }
        }
      } catch (e) {
        console.warn("sync error for", d.id, e);
        changes.push({ id: d.id, error: String(e) });
      }
    }

    await db.from("app_settings")
      .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", 1);
    await recordRun();

    return json({ success: true, checked: devices.length, changed, changes, took_ms: Date.now() - started, interval: requiredInterval });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});
