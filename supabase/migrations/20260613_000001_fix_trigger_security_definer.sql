-- Trigger functions on public.devices were running as SECURITY INVOKER (the
-- calling user, e.g. service_role from edge functions). This caused them to
-- fail with "permission denied for view device_sessions" when trying to write
-- to alexa.device_sessions, silently rolling back every UPDATE on devices
-- from tuya-sync (status changes never persisted).
-- Fix: run all three trigger functions as their owner (postgres).
ALTER FUNCTION alexa.devices_log_sessions() SECURITY DEFINER;
ALTER FUNCTION alexa.devices_manage_on_since() SECURITY DEFINER;
ALTER FUNCTION alexa.update_updated_at() SECURITY DEFINER;
