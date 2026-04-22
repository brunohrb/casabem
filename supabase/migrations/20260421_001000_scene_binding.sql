-- ============================================================
-- casa BEM · Binding de dispositivos a Cenas Tuya (Tap-to-Run)
-- ------------------------------------------------------------
-- Quando o IR Control Hub Open Service está com quota travada
-- (muito comum em Western America DC), o caminho viável pra
-- controlar ares/TVs pareados num hub IR é disparar CENAS Tuya
-- criadas no SmartLife (ou que já persistem na cloud). Essa API
-- usa Smart Home Basic Service e não consome quota.
--
-- Um dispositivo pode ter:
--   scene_on_id  → cena a disparar quando o toggle vai pra ON
--   scene_off_id → cena a disparar quando o toggle vai pra OFF
--
-- Pra aparelhos com toggle único (TV "Power"), usa-se só
-- scene_on_id — o OFF dispara a mesma cena.
--
-- IDEMPOTENTE.
-- ============================================================

alter table public.devices
  add column if not exists scene_on_id  text,
  add column if not exists scene_off_id text;

comment on column public.devices.scene_on_id
  is 'scene_id da cena Tuya Tap-to-Run que liga o aparelho. Quando preenchido, o toggle usa /trigger_scene em vez de /v2.0/infrareds/... (bypassa a quota do IR Control Hub).';
comment on column public.devices.scene_off_id
  is 'scene_id da cena Tuya Tap-to-Run que desliga o aparelho. Se NULL e scene_on_id setado, usa scene_on_id pros dois estados (toggle único).';
