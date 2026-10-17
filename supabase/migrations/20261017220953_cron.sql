-- Hosted Supabase extensions; core SQL tests run without these on stock PostgreSQL.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create function private.wake_dispatch() returns void language plpgsql security definer set search_path='' as $$
declare project_url text; dispatch_secret text;
begin
  if not exists(select 1 from private.notification_jobs j join private.accounts a on a.user_id=j.user_id
    where j.status in ('pending','sending') and j.attempts<4 and j.due_at<=now() and j.expires_at>now()
      and not a.disabled and a.admitted and (j.lease_until is null or j.lease_until<now())
      and (j.session_id is null or exists(select 1 from auth.sessions s where s.id::text=j.session_id))) then return; end if;
  select decrypted_secret into project_url from vault.decrypted_secrets where name='opengym_project_url';
  select decrypted_secret into dispatch_secret from vault.decrypted_secrets where name='opengym_dispatch_secret';
  -- Migration can be applied before secrets/functions are configured.
  if project_url is null or dispatch_secret is null then return; end if;
  perform net.http_post(url:=rtrim(project_url,'/')||'/functions/v1/notification-dispatch',
    headers:=jsonb_build_object('Content-Type','application/json','x-dispatch-secret',dispatch_secret),
    body:='{}'::jsonb, timeout_milliseconds:=65000);
end $$;
revoke all on function private.wake_dispatch() from public,anon,authenticated;
select cron.schedule('opengym-dispatch','1 second','select private.wake_dispatch()');
select cron.schedule('opengym-reminders','10 seconds','select private.enqueue_reminders()');
select cron.schedule('opengym-housekeeping','17 * * * *',$job$
  delete from private.activity where updated_at<now()-interval '5 minutes';
  delete from private.push_subscriptions p where not exists(select 1 from auth.sessions s where s.id::text=p.session_id);
  update private.notification_jobs set status='failed',lease=null,lease_until=null
    where status in ('pending','sending') and (expires_at<now() or (attempts>=4 and lease_until<now()));
  delete from private.notification_jobs where expires_at<now()-interval '7 days';
  delete from private.state_receipts where created_at<now()-interval '30 days';
  delete from cron.job_run_details where start_time<now()-interval '1 day';
$job$);
