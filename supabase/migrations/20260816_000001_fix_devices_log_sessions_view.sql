-- devices_log_sessions was writing to alexa.device_sessions (a non-updatable
-- VIEW on public.device_sessions). After we set SECURITY DEFINER the trigger
-- could now SEE the view but still couldn't WRITE to it, causing every
-- UPDATE on public.devices to rollback silently.
-- Fix: write directly to public.device_sessions.
CREATE OR REPLACE FUNCTION alexa.devices_log_sessions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  src text;
begin
  src := coalesce(new.last_source, new.last_changed, 'app');
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = true then
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
