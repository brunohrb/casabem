-- ============================================================
-- casa BEM · Cron jobs do Supabase
-- ------------------------------------------------------------
-- Agenda:
--   • tuya-sync       → a cada 20 s  (detecta interruptor manual)
--   • timer-worker    → a cada 10 s  (dispara auto-off pendentes)
--
-- PRÉ-REQUISITO: extensão `pg_cron` e `pg_net` habilitadas no
-- Supabase (Database → Extensions → procurar e habilitar).
--
-- *** EDITAR ANTES DE RODAR ***
--   1. Trocar SUPABASE_URL abaixo pela sua URL de projeto.
--   2. Trocar SERVICE_ROLE_KEY pela sua Service Role Key
--      (Project Settings → API → service_role).
-- ============================================================

-- Requer pg_net para fazer o POST HTTP e pg_cron para agendar.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Helper que faz o POST autenticado nas Edge Functions.
create or replace function public.casabem_invoke_edge(fn text)
returns bigint
language plpgsql
as $$
declare
  req_id bigint;
begin
  req_id := net.http_post(
    url     := 'https://SUPABASE_URL_AQUI.supabase.co/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer SERVICE_ROLE_KEY_AQUI'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  return req_id;
end;
$$;

-- Remove jobs antigos antes de recriar (idempotente).
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('casabem_tuya_sync','casabem_timer_worker')
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$$;

select cron.schedule(
  'casabem_tuya_sync',
  '*/20 * * * * *',  -- a cada 20s
  $$select public.casabem_invoke_edge('tuya-sync');$$
);

select cron.schedule(
  'casabem_timer_worker',
  '*/10 * * * * *',  -- a cada 10s
  $$select public.casabem_invoke_edge('timer-worker');$$
);
