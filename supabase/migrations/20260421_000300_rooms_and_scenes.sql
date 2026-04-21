-- ============================================================
-- casa BEM · Cômodos ordenáveis + Cenas (atalhos dinâmicos)
-- ------------------------------------------------------------
-- 1. `room_order`: guarda a posição manual de cada cômodo na UI.
--    Os cômodos continuam sendo derivados de devices.room — esta
--    tabela só armazena a ordem escolhida pelo usuário.
--
-- 2. `scenes` + `scene_actions`: atalhos dinâmicos criados pelo
--    usuário (ex.: "Climatizar Casa" = liga Ar 1 + Ar 2;
--    "Modo Cinema" = liga Ar 1 + luz painel). Um card clicável
--    executa uma sequência de ações ligar/desligar.
--
-- IDEMPOTENTE.
-- ============================================================

-- ───────────────────────── room_order ─────────────────────────
create table if not exists public.room_order (
  name        text        primary key,
  position    integer     not null default 0,
  updated_at  timestamptz not null default now()
);

comment on table public.room_order
  is 'Ordem manual dos cômodos (Sala, Quarto, etc.) na UI. PK = nome do cômodo.';


-- ───────────────────────── scenes ─────────────────────────
create table if not exists public.scenes (
  id            uuid         primary key default gen_random_uuid(),
  name          text         not null,
  icon          text         default '⭐',
  color         text         default '#1a6bb5',
  position      integer      not null default 0,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now()
);

create index if not exists idx_scenes_position
  on public.scenes (position);

comment on table public.scenes
  is 'Cenas/atalhos dinâmicos criados pelo usuário (ex.: Modo Cinema).';


-- ───────────────────────── scene_actions ─────────────────────────
create table if not exists public.scene_actions (
  id          bigserial    primary key,
  scene_id    uuid         not null references public.scenes(id) on delete cascade,
  device_id   uuid         not null references public.devices(id) on delete cascade,
  action      text         not null check (action in ('on','off')),
  order_idx   integer      not null default 0,
  created_at  timestamptz  not null default now()
);

create index if not exists idx_scene_actions_scene
  on public.scene_actions (scene_id, order_idx);

comment on table public.scene_actions
  is 'Ações que cada cena executa: para cada dispositivo, liga (on) ou desliga (off).';


-- ───────────────────────── trigger updated_at ─────────────────────────
drop trigger if exists trg_scenes_updated_at on public.scenes;
create trigger trg_scenes_updated_at
  before update on public.scenes
  for each row execute function public.update_updated_at();


-- ───────────────────────── Realtime ─────────────────────────
do $$
begin
  begin alter publication supabase_realtime add table public.room_order;
    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.scenes;
    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.scene_actions;
    exception when duplicate_object then null; end;
end$$;


-- ───────────────────────── RLS ─────────────────────────
alter table public.room_order    enable row level security;
alter table public.scenes        enable row level security;
alter table public.scene_actions enable row level security;

drop policy if exists "acesso_total_room_order" on public.room_order;
create policy "acesso_total_room_order"
  on public.room_order for all using (true) with check (true);

drop policy if exists "acesso_total_scenes" on public.scenes;
create policy "acesso_total_scenes"
  on public.scenes for all using (true) with check (true);

drop policy if exists "acesso_total_scene_actions" on public.scene_actions;
create policy "acesso_total_scene_actions"
  on public.scene_actions for all using (true) with check (true);
