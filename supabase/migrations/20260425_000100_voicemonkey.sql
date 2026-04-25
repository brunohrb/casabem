-- ============================================================
-- casa BEM · Integração Voice Monkey (aspirador via Alexa)
-- ------------------------------------------------------------
-- Pra dispositivos que não estão no SmartLife/Tuya (como o robô
-- Roborock S10+ no Mi Home), usamos a Alexa como ponte:
--
--   casa BEM card → POST Voice Monkey API → Alexa Routine →
--   Mi Home Skill → S10+
--
-- vm_token  : API token único da conta Voice Monkey (mesmo pra
--             todos os dispositivos da casa).
-- vm_prefix : prefixo que casa BEM usa pra montar o nome do
--             trigger Voice Monkey. Exemplo: prefix="s10" →
--             botões disparam s10start, s10pause, s10dock,
--             s10locate (4 ações fixas).
--
-- IDEMPOTENTE.
-- ============================================================

alter table public.devices
  add column if not exists vm_token  text,
  add column if not exists vm_prefix text;

comment on column public.devices.vm_token
  is 'API token Voice Monkey (Settings → API Credentials no voicemonkey.io). Único da conta.';
comment on column public.devices.vm_prefix
  is 'Prefixo dos triggers Voice Monkey deste dispositivo. Ex: s10 → s10start, s10pause, s10dock, s10locate.';
