// ============================================================
// casa BEM · timer-worker
// ------------------------------------------------------------
// Executa os timers agendados em `public.pending_timers` que já
// venceram. Chamado periodicamente via pg_cron (a cada 10s).
//
// Responsabilidades:
//   • Selecionar timers com fire_at <= now() que não foram
//     executados nem cancelados.
//   • Atualizar o device correspondente (status on/off) no
//     Supabase e chamar a Edge Function `tuya-control` para
//     refletir no mundo físico.
//   • Gravar sessão encerrada / aberta em `device_sessions`.
//   • Logar em `commands_log` com source='rule' (ou
//     'manual_timer' se foi timer pontual).
//
// ENV necessários:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (automáticos)
//   TUYA_CONTROL_URL   ex: https://<proj>.supabase.co/functions/v1/tuya-control
//   SERVICE_AUTH_KEY   chave usada para chamar tuya-control
//                      (pode ser a própria service role key)
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

Deno.serve(async () => {
  const started = Date.now();
  const nowIso  = new Date().toISOString();

  // 1. Seleciona timers vencidos (sem RLS bloqueando — service role).
  const { data: timers, error } = await db
    .from("pending_timers")
    .select("*")
    .lte("fire_at", nowIso)
    .is("executed_at", null)
    .is("cancelled_at", null)
    .order("fire_at", { ascending: true })
    .limit(50);

  if (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  if (!timers || timers.length === 0) {
    return new Response(JSON.stringify({ success: true, fired: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const results: any[] = [];

  for (const t of timers) {
    // Lock otimista: só executa se nenhum outro worker já marcou.
    const { data: locked, error: lockErr } = await db
      .from("pending_timers")
      .update({ executed_at: new Date().toISOString() })
      .eq("id", t.id)
      .is("executed_at", null)
      .is("cancelled_at", null)
      .select("id")
      .single();
    if (lockErr || !locked) { results.push({ id: t.id, skipped: true }); continue; }

    try {
      const { data: device } = await db
        .from("devices")
        .select("*")
        .eq("id", t.device_id)
        .single();

      if (!device) {
        await db.from("pending_timers")
          .update({ error: "device not found" }).eq("id", t.id);
        results.push({ id: t.id, error: "device not found" });
        continue;
      }

      const newStatus = t.action === "on";
      const srcLabel  = t.source === "rule" ? "rule" : "manual_timer";

      // Se já está no estado alvo, só carimba (não precisa acionar Tuya).
      if (device.status === newStatus) {
        await db.from("commands_log").insert({
          device_id:   device.id,
          device_name: device.name,
          command:     `⏱️ Timer "${t.label ?? ""}" venceu (já estava ${newStatus ? "ligado" : "desligado"})`,
          source:      srcLabel,
          success:     true,
        });
        results.push({ id: t.id, noop: true });
        continue;
      }

      // 2. Atualiza o device no Supabase — triggers gerenciam
      //    on_since / total_on_time_seconds / device_sessions.
      await db.from("devices").update({
        status:       newStatus,
        last_source:  srcLabel,
        last_changed: srcLabel,
      }).eq("id", device.id);

      // 3. Chama tuya-control para acionar o físico (se configurado).
      if (device.tuya_device_id) {
        try {
          await fetch(TUYA_CONTROL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${SERVICE_AUTH_KEY}`,
              "apikey":        SERVICE_AUTH_KEY,
            },
            body: JSON.stringify({
              action: "control",
              device_id: device.tuya_device_id,
              value: newStatus,
            }),
          });
        } catch (e) {
          console.warn("tuya-control call failed:", e);
        }
      }

      // 4. Log.
      await db.from("commands_log").insert({
        device_id:   device.id,
        device_name: device.name,
        command:     `⏱️ ${t.label ?? "Timer"}: ${newStatus ? "ligou" : "desligou"}`,
        source:      srcLabel,
        success:     true,
      });

      results.push({ id: t.id, fired: true, device: device.name });
    } catch (e) {
      await db.from("pending_timers")
        .update({ error: String(e) }).eq("id", t.id);
      results.push({ id: t.id, error: String(e) });
    }
  }

  return new Response(JSON.stringify({
    success: true, fired: results.length, results,
    took_ms: Date.now() - started,
  }), { headers: { "Content-Type": "application/json" } });
});
