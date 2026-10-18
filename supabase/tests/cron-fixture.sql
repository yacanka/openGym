-- Local test database adapters ONLY; never apply to Supabase.
create schema vault;
create table vault.decrypted_secrets(name text, decrypted_secret text);
create schema net;
create table net.requests(url text, timeout_ms integer);
create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) returns bigint language plpgsql as $$
begin insert into net.requests values(url,timeout_milliseconds);return 1;end $$;
create schema cron;
create table cron.jobs(name text primary key, schedule text, command text);
create table cron.job_run_details(start_time timestamptz);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$
begin insert into cron.jobs values(job_name,schedule,command)
on conflict(name) do update set schedule=excluded.schedule,command=excluded.command;return 1;end $$;
