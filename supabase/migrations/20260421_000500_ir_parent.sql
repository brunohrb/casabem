-- ============================================================
-- casa BEM · Suporte a dispositivos IR (hub universal)
-- ------------------------------------------------------------
-- Quando o usuário tem um "Controle Remoto Universal" Tuya (hub IR)
-- com ares-condicionados e TVs pareados nele, cada aparelho vira
-- um sub-dispositivo com seu próprio tuya_device_id. Mas o endpoint
-- de controle não é o mesmo dos relés (/v1.0/devices/{id}/commands):
-- é /v2.0/infrareds/{hub_id}/remotes/{remote_id}/... e precisamos
-- saber o id do HUB pra mandar o comando.
--
-- Essa coluna guarda o tuya_device_id do hub IR para cada aparelho
-- IR. Se NULL → aparelho é controlado via /commands direto (relé,
-- tomada, lâmpada Wi-Fi etc).
--
-- IDEMPOTENTE.
-- ============================================================

alter table public.devices
  add column if not exists ir_parent_id text;

comment on column public.devices.ir_parent_id
  is 'tuya_device_id do hub IR pai (wnykq) quando o dispositivo é controlado via IR. NULL para dispositivos Wi-Fi diretos.';

-- Index para consultas "todos os meus IR devices do hub X".
create index if not exists idx_devices_ir_parent
  on public.devices (ir_parent_id)
  where ir_parent_id is not null;
