-- ============================================================
-- Tuya: canal (DP code) por dispositivo
-- ------------------------------------------------------------
-- Interruptores multi-tecla Tuya expõem várias teclas no mesmo
-- device_id, separadas por um "DP code" (switch_1, switch_2, ...).
-- Cada linha em devices passa a guardar o canal usado para ligar
-- / desligar aquele aparelho.
-- ============================================================

alter table public.devices
  add column if not exists tuya_channel text default 'switch_1';

comment on column public.devices.tuya_channel
  is 'DP code da tecla no interruptor Tuya (switch_1, switch_2, switch_led, ...). Default: switch_1.';
