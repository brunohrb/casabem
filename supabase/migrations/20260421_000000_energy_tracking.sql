-- ============================================================
-- casa BEM · 2026-04-21
-- Energia, detecção de interruptor manual e timers persistidos
-- ============================================================
--
-- Esta migração adiciona, em cima do schema existente
-- (casa_inteligente/supabase-schema.sql):
--
--   1. Colunas em `devices` para rastrear tempo ligado e a fonte
--      da última mudança (app / alexa / manual / rule / tuya).
--   2. Tabela `device_sessions` — histórico de cada vez que o
--      aparelho ligou e por quanto tempo ficou ligado.
--   3. Tabela `pending_timers` — timers de auto-desligar que
--      sobrevivem ao fechamento do app (executados pelo
--      Edge Function `timer-worker` via cron do Supabase).
--   4. Triggers: `on_since`, `total_on_time_seconds` e
--      `device_sessions` ficam sincronizados automaticamente,
--      mesmo quando a Alexa Skill escreve direto na tabela.
--   5. Constraint de `commands_log.source` expandida p/ aceitar
--      'manual', 'rule', 'manual_timer', 'tuya-sync'.
--
-- IDEMPOTENTE — pode rodar mais de uma vez.
-- ============================================================

-- ───────────────────────── devices ─────────────────────────
alter table public.devices
  add column if not exists on_since              timestamptz,
  add column if not exists total_on_time_seconds bigint      not null default 0,
  add column if not exists last_tuya_sync_at     timestamptz,
  add column if not exists last_source           text;

-- Backfill para registros existentes.
update public.devices
   set last_source = case
         when last_changed = 'alexa' then 'alexa'
         else 'app'
       end
 where last_source is null;

-- Tipo 'vacuum' foi adicionado depois do schema inicial — relaxa a constraint.
alter table public.devices drop constraint if exists devices_type_check;
alter table public.devices
  add  constraint devices_type_check
  check (type in ('light','ac','tv','vacuum','other'));

comment on column public.devices.on_since
  is 'Instante em que o dispositivo foi ligado (null quando desligado). Gerenciado por trigger.';
comment on column public.devices.total_on_time_seconds
  is 'Tempo acumulado ligado — atualizado ao desligar (soma das sessões).';
comment on column public.devices.last_tuya_sync_at
  is 'Última vez que o tuya-sync confirmou o estado físico deste device.';
comment on column public.devices.last_source
  is 'Fonte da última mudança: app | alexa | manual | rule | tuya | manual_timer.';


-- ─────────────────────── device_sessions ───────────────────────
create table if not exists public.device_sessions (
  id               bigserial    primary key,
  device_id        uuid         not null references public.devices(id) on delete cascade,
  device_name      text         not null,
  room             text,
  type             text,
  started_at       timestamptz  not null,
  ended_at         timestamptz,
  duration_seconds integer,
  start_source     text,
  end_source       text,
  created_at       timestamptz  not null default now()
);

create index if not exists idx_device_sessions_device
  on public.device_sessions (device_id);

-- Garante só uma sessão aberta por dispositivo.
create unique index if not exists idx_device_sessions_open_one_per_device
  on public.device_sessions (device_id)
  where ended_at is null;

create index if not exists idx_device_sessions_started_desc
  on public.device_sessions (started_at desc);

comment on table public.device_sessions
  is 'Histórico de sessões ligada→desligada. Cada linha = 1 sessão. Gerado por trigger.';


-- ─────────────────────── pending_timers ───────────────────────
create table if not exists public.pending_timers (
  id            bigserial    primary key,
  device_id     uuid         not null references public.devices(id) on delete cascade,
  device_name   text,
  action        text         not null check (action in ('on','off')),
  fire_at       timestamptz  not null,
  label         text,
  source        text         not null default 'manual_timer',  -- manual_timer | rule
  rule_id       text,
  created_at    timestamptz  not null default now(),
  executed_at   timestamptz,
  cancelled_at  timestamptz,
  error         text
);

create index if not exists idx_pending_timers_due
  on public.pending_timers (fire_at)
  where executed_at is null and cancelled_at is null;

create index if not exists idx_pending_timers_device
  on public.pending_timers (device_id);


-- ─────────────────── commands_log.source constraint ───────────────────
-- O schema original trava em ('dashboard','alexa','automacao').
-- Expandimos para o vocabulário completo que o novo sistema usa.
alter table public.commands_log drop constraint if exists commands_log_source_check;
alter table public.commands_log
  add  constraint commands_log_source_check
  check (source in (
    'dashboard', 'alexa', 'automacao',
    'manual', 'rule', 'manual_timer', 'tuya-sync', 'app'
  ));


-- ─────────────────── TRIGGERS · on_since + sessions ───────────────────
-- Fonte única da verdade: quem escreve em `devices` (app, Alexa Skill,
-- tuya-sync, timer-worker, SQL manual) não precisa se preocupar com
-- on_since, total_on_time_seconds ou device_sessions — os triggers
-- cuidam de tudo.

create or replace function public.devices_manage_on_since()
returns trigger
language plpgsql
as $$
declare
  dur integer;
begin
  if (tg_op = 'UPDATE' and new.status is distinct from old.status)
     or (tg_op = 'INSERT' and new.status = true)
  then
    if new.status = true then
      -- Ligou: marca início se não veio explícito
      new.on_since := coalesce(new.on_since, now());
    else
      -- Desligou: acumula duração e limpa on_since
      if old.on_since is not null then
        dur := greatest(0, extract(epoch from (now() - old.on_since))::int);
        new.total_on_time_seconds := coalesce(old.total_on_time_seconds, 0) + dur;
      end if;
      new.on_since := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_devices_on_since on public.devices;
create trigger trg_devices_on_since
  before insert or update on public.devices
  for each row execute function public.devices_manage_on_since();


create or replace function public.devices_log_sessions()
returns trigger
language plpgsql
as $$
declare
  src text;
begin
  src := coalesce(new.last_source, new.last_changed, 'app');

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = true then
      -- fecha qualquer sessão "órfã" (defensivo) e abre nova
      update public.device_sessions
         set ended_at         = now(),
             end_source       = 'cleanup',
             duration_seconds = greatest(0, extract(epoch from (now() - started_at))::int)
       where device_id = new.id and ended_at is null;

      insert into public.device_sessions
        (device_id, device_name, room, type, started_at, start_source)
      values
        (new.id, new.name, new.room, new.type, now(), src);
    else
      update public.device_sessions
         set ended_at         = now(),
             end_source       = src,
             duration_seconds = greatest(0, extract(epoch from (now() - started_at))::int)
       where device_id = new.id and ended_at is null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_devices_sessions on public.devices;
create trigger trg_devices_sessions
  after update on public.devices
  for each row execute function public.devices_log_sessions();


-- ─────────────────── RPC: add_on_time (fallback) ───────────────────
create or replace function public.add_on_time(p_device_id uuid, p_seconds integer)
returns void
language sql
as $$
  update public.devices
     set total_on_time_seconds = coalesce(total_on_time_seconds, 0) + greatest(p_seconds, 0)
   where id = p_device_id;
$$;


-- ─────────────────── Realtime ───────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.device_sessions;
    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.pending_timers;
    exception when duplicate_object then null; end;
end$$;


-- ─────────────────── RLS ───────────────────
alter table public.device_sessions enable row level security;
alter table public.pending_timers  enable row level security;

drop policy if exists "acesso_total_device_sessions" on public.device_sessions;
create policy "acesso_total_device_sessions"
  on public.device_sessions for all using (true) with check (true);

drop policy if exists "acesso_total_pending_timers" on public.pending_timers;
create policy "acesso_total_pending_timers"
  on public.pending_timers for all using (true) with check (true);
