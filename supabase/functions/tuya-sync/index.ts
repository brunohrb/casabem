// ============================================================
// casa BEM · tuya-sync
// ------------------------------------------------------------
// Faz polling no Tuya Cloud para descobrir o estado real dos
// dispositivos (inclusive quando alguém aperta o interruptor na
// parede ou usa o app da Alexa nativa). Se o estado divergir do
// que está em `public.devices`, atualiza o banco — o Realtime
// do Supabase avisa o frontend.
//
// Delega a chamada Tuya pro Edge Function `tuya-control` (que já
// tem as credenciais TUYA_ACCESS_ID / TUYA_ACCESS_SECRET). Assim
// a lógica de assinatura fica em um lugar só.
//
// ENV necessários:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto)
//   TUYA_CONTROL_URL  (opcional, default = <SUPABASE_URL>/functions/v1/tuya-control)
//   SERVICE_AUTH_KEY  (opcional, default = service role key)
//
// Agendado via pg_cron a cada 20s — ver migração *_cron_jobs.sql.
// on_since / total_on_time_seconds / device_sessions são gerados
// automaticamente por triggers no banco.
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

// Tuya retorna um array de { code, value } por device. Códigos comuns
// que indicam estado ligado: switch_led, switch_1, switch.
function extractStatus(points: Array<{ code: string; value: unknown }>): boolean | null {
  if (!Array.isArray(points)) return null;
  for (const code of ["switch_led", "switch_1", "switch", "led_switch"]) {
    const p = points.find(x => x.code === code);
    if (p && typeof p.value === "boolean") return p.value;
  }
  const power = points.find(x => x.code === "power" || x.code === "work_state");
  if (power && typeof power.value === "boolean") return power.value;
  return null;
}

function extractBrightness(points: Array<{ code: string; value: unknown }>): number | null {
  if (!Array.isArray(points)) return null;
  for (const code of ["bright_value", "bright_value_v2", "brightness"]) {
    const p = points.find(x => x.code === code);
    if (p && typeof p.value === "number") {
      // Tuya normalmente usa 10–1000. Normaliza para 0–100.
      return Math.round((p.value / 1000) * 100);
    }
  }
  return null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const started = Date.now();

  try {
    const { data: devices, error } = await db
      .from("devices")
      .select("id, name, type, room, status, brightness, tuya_device_id")
      .not("tuya_device_id", "is", null);
    if (error) throw error;
    if (!devices || devices.length === 0) {
      return json({ success: true, checked: 0, changed: 0 });
    }

    let changed = 0;
    const changes: any[] = [];

    for (const d of devices) {
      try {
        const res = await tuyaStatus(d.tuya_device_id!);
        // tuya-control devolve o JSON puro da Tuya: { success, result: [...] }
        if (!res || !res.success) {
          changes.push({ id: d.id, error: res?.msg ?? "tuya fail" });
          continue;
        }
        const points     = res.result ?? [];
        const realStatus = extractStatus(points);
        const realBright = extractBrightness(points);

        if (realStatus === null) {
          await db.from("devices")
            .update({ last_tuya_sync_at: new Date().toISOString() })
            .eq("id", d.id);
          continue;
        }

        const diffStatus = realStatus !== d.status;
        const diffBright = realBright != null && d.type === "light"
                         && realBright !== (d.brightness ?? 0);

        const patch: Record<string, unknown> = {
          last_tuya_sync_at: new Date().toISOString(),
        };
        if (diffStatus) {
          patch.status       = realStatus;
          patch.last_source  = "manual";   // veio do interruptor / app externo
          patch.last_changed = "manual";
        }
        if (diffBright) patch.brightness = realBright;

        if (Object.keys(patch).length > 1 /* só 'last_tuya_sync_at' = no-op */) {
          await db.from("devices").update(patch).eq("id", d.id);
          if (diffStatus || diffBright) {
            changed++;
            changes.push({
              id: d.id, name: d.name,
              status:     diffStatus ? realStatus : undefined,
              brightness: diffBright ? realBright : undefined,
              source:     "manual",
            });
            await db.from("commands_log").insert({
              device_id:   d.id,
              device_name: d.name,
              command:     diffStatus
                           ? `Interruptor físico: ${realStatus ? "ligado" : "desligado"}`
                           : `Brilho alterado: ${realBright}%`,
              source:      "manual",
              success:     true,
            });
          }
        }
      } catch (e) {
        console.warn("sync error for", d.id, e);
        changes.push({ id: d.id, error: String(e) });
      }
    }

    return json({
      success: true,
      checked: devices.length,
      changed, changes,
      took_ms: Date.now() - started,
    });
  } catch (e) {
    return json({ success: false, error: String(e) }, 500);
  }
});

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
