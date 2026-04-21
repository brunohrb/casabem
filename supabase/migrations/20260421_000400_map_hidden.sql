-- ============================================================
-- casa BEM · Dispositivos podem ser ocultados no Mapa
-- ------------------------------------------------------------
-- Adiciona `hidden_in_map` em devices. Um dispositivo "escondido"
-- continua aparecendo na Lista (para gestão) mas some do Mapa
-- (pensado pro tablet de parede em modo quiosque).
--
-- IDEMPOTENTE.
-- ============================================================

alter table public.devices
  add column if not exists hidden_in_map boolean not null default false;

comment on column public.devices.hidden_in_map
  is 'Se true, o dispositivo é ocultado da view Mapa (modo quiosque, tablet na parede).';
