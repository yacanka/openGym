\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',message;end if;end $$;
select private.wake_dispatch();
select pg_temp.assert((select count(*)=0 from net.requests),'empty queue does not invoke Edge Function');
insert into auth.users(id,email,email_confirmed_at)values('10000000-0000-0000-0000-000000000030','scheduler@example.test',now());
insert into private.notification_jobs(user_id,kind,job_key,payload,due_at,expires_at)
 values('10000000-0000-0000-0000-000000000030','reminder','test','{}',now(),now()+interval '1 minute');
select private.wake_dispatch();
select pg_temp.assert((select count(*)=0 from net.requests),'missing Vault configuration is inert');
insert into vault.decrypted_secrets values('opengym_project_url','https://project.example.test'),('opengym_dispatch_secret',md5(random()::text)||md5(random()::text));
select private.wake_dispatch();
select pg_temp.assert((select count(*)=1 from net.requests),'due eligible queue invokes configured dispatcher');
select pg_temp.assert((select url='https://project.example.test/functions/v1/notification-dispatch' from net.requests),'only configured dispatcher called');
select pg_temp.assert((select schedule='1 second' from cron.jobs where name='opengym-dispatch'),'second-based dispatcher schedule');
select pg_temp.assert((select schedule='10 seconds' from cron.jobs where name='opengym-reminders'),'legacy reminder cadence');
update private.accounts set disabled=true where user_id='10000000-0000-0000-0000-000000000030';
select private.wake_dispatch();
select pg_temp.assert((select count(*)=1 from net.requests),'disabled account does not wake dispatcher');
rollback;
