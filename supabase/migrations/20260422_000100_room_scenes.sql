-- ============================================================
-- casa BEM · Cenas por cômodo
-- ------------------------------------------------------------
-- Liga cada cômodo a até 2 cenas Tuya (Tap-to-Run):
--   scene_on_id   → disparada por um "💡 Ligar tudo" no header do cômodo
--   scene_off_id  → disparada por um "🌙 Apagar tudo" no header
--
-- Bypassa a necessidade de iterar device-por-device no frontend.
-- Usa a mesma infra do casa BEM pra cenas (tuya-control/trigger_scene).
--
-- IDEMPOTENTE.
-- ============================================================

alter table public.room_order
  add column if not exists scene_on_id  text,
  add column if not exists scene_off_id text;

comment on column public.room_order.scene_on_id
  is 'scene_id Tuya Tap-to-Run que liga tudo neste cômodo (header mostra botão 💡 Ligar).';
comment on column public.room_order.scene_off_id
  is 'scene_id Tuya Tap-to-Run que apaga tudo neste cômodo (header mostra botão 🌙 Apagar).';
