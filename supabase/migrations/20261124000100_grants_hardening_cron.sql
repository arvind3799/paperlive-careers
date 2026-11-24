-- Applied after the schema migration.
grant usage on schema public to anon, authenticated;
grant select on public.jobs to anon;
grant select, insert, update, delete on public.jobs, public.job_pipeline, public.leads, public.settings, public.candidates, public.applications to authenticated;
grant select on public.email_log, public.automation_runs, public.admins, public.job_overview to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.is_admin() to authenticated;

revoke execute on function public.applications_check(), public.handle_new_user(), public.jobs_after_insert(), public.jobs_before_write(), public.candidates_guard() from public, anon, authenticated;
revoke execute on function public.is_admin() from anon;
revoke execute on function public.admin_stats() from anon;
drop extension if exists pg_net;
create extension if not exists pg_net with schema extensions;

-- Schedule password lives in a private schema; the function checks it through check_cron_secret()
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.config (key text primary key, value text not null);
insert into private.config values ('cron_secret', encode(extensions.gen_random_bytes(32), 'hex'));
create or replace function public.check_cron_secret(s text) returns boolean
language sql stable security definer set search_path = private as $$
  select exists (select 1 from private.config where key = 'cron_secret' and value = s);
$$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

select cron.schedule('paperlive-automation', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://ivtqfrvnuhifylyxkdpm.supabase.co/functions/v1/automation',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select value from private.config where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 140000);
$$);
