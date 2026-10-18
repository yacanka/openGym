\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',message;end if;end $$;
insert into auth.users(id,email,email_confirmed_at)
select ('10000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'notification-fixture-'||i||'@example.test',now()
from generate_series(101,105) i;
insert into auth.sessions(id,user_id)
select ('20000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,('10000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid
from generate_series(101,104) i;
update private.accounts set role='admin' where user_id='10000000-0000-0000-0000-000000000101';
update private.accounts set disabled=true where user_id='10000000-0000-0000-0000-000000000103';
insert into private.push_subscriptions(endpoint,user_id,keys,session_id)
select 'https://fcm.googleapis.com/fixture-'||i,('10000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
'{"p256dh":"test-public","auth":"test-auth"}', '20000000-0000-0000-0000-'||lpad(i::text,12,'0') from generate_series(102,105) i;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000102","session_id":"20000000-0000-0000-0000-000000000102"}',true);
do $$ begin
  perform public.admin_notifications(0);
  raise exception 'ordinary user read admin history';
exception when insufficient_privilege then null;end $$;
do $$ begin
  perform public.admin_create_notification('Title','Body','all',null,null,'30000000-0000-0000-0000-000000000101');
  raise exception 'ordinary user sent admin push';
exception when insufficient_privilege then null;end $$;
do $$ begin
  perform public.admin_cancel_notification('30000000-0000-0000-0000-000000000101');
  raise exception 'ordinary user cancelled admin push';
exception when insufficient_privilege then null;end $$;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000101","session_id":"20000000-0000-0000-0000-000000000101"}',true);
select pg_temp.assert(not has_table_privilege('authenticated','private.admin_notifications','select'),'campaign table not exposed to clients');
select pg_temp.assert(not has_function_privilege('anon','public.admin_notifications(integer)','execute'),'anonymous history access denied');
do $$ begin
  perform public.admin_create_notification(' ','Body','all',null,null,gen_random_uuid());
  raise exception 'blank title accepted';
exception when invalid_parameter_value then null;end $$;
do $$ begin
  perform public.admin_create_notification('Title',repeat('x',501),'all',null,null,gen_random_uuid());
  raise exception 'oversized body accepted';
exception when invalid_parameter_value then null;end $$;
do $$ begin
  perform public.admin_create_notification('Title','Body','all',null,now()-interval '1 minute',gen_random_uuid());
  raise exception 'past schedule accepted';
exception when invalid_parameter_value then null;end $$;
do $$ begin
  perform public.admin_create_notification('Title','Body','all',null,now()+interval '31 days',gen_random_uuid());
  raise exception 'unbounded schedule accepted';
exception when invalid_parameter_value then null;end $$;
do $$ begin
  perform public.admin_create_notification('Title','Body','user','10000000-0000-0000-0000-000000000103',null,gen_random_uuid());
  raise exception 'disabled recipient accepted';
exception when invalid_parameter_value then null;end $$;
select public.admin_create_notification('  Announcement  ','  Hello 💪  ','all',null,now()+interval '1 hour','30000000-0000-0000-0000-000000000101');
-- Identical retries must not create another campaign or duplicate recipient jobs.
select public.admin_create_notification('  Announcement  ','  Hello 💪  ','all',null,now()+interval '1 hour','30000000-0000-0000-0000-000000000101');
do $$ begin
  perform public.admin_create_notification('Different','Hello','all',null,null,'30000000-0000-0000-0000-000000000101');
  raise exception 'request identifier reused with different content';
exception when invalid_parameter_value then null;end $$;
select pg_temp.assert((public.admin_notifications(0)->'notifications'->0->>'recipient_count')::int=2,'eligible recipients only; no stale or disabled users');
select pg_temp.assert(public.admin_notifications(0)::text not like '%fcm.googleapis.com%','history excludes endpoints and keys');
select pg_temp.assert(public.admin_notifications(0)->'notifications'->0->>'title'='Announcement','title trimmed');
select pg_temp.assert(public.admin_notifications(0)->'notifications'->0->>'status'='scheduled','future campaign shown scheduled');
reset role;
select pg_temp.assert((select count(*)=2 from private.notification_jobs where campaign_id='30000000-0000-0000-0000-000000000101'),'one durable job per eligible user, retry is idempotent');
update private.notification_jobs set due_at=now()-interval '1 second' where campaign_id is not null;
insert into private.notification_jobs(user_id,kind,job_key,payload,due_at,expires_at)
values('10000000-0000-0000-0000-000000000102','rest','priority-rest','{}',now(),now()+interval '60 seconds'),
('10000000-0000-0000-0000-000000000102','reminder','priority-reminder','{}',now(),now()+interval '15 minutes');
set local role service_role;
create temporary table priority_claim as select public.claim_notifications() as jobs;
reset role;
select pg_temp.assert((select kind='rest' from private.notification_jobs where id=(select (jobs->0->>'id')::uuid from priority_claim)),'bulk announcements must not block a due rest timer');
delete from private.notification_jobs where job_key='priority-rest';
set local role service_role;
create temporary table reminder_claim as select public.claim_notifications() as jobs;
reset role;
select pg_temp.assert((select kind='reminder' from private.notification_jobs where id=(select (jobs->0->>'id')::uuid from reminder_claim)),'bulk announcements must not block a due reminder');
delete from private.notification_jobs where job_key='priority-reminder';
set local role service_role;
create temporary table admin_claim as select public.claim_notifications() as jobs;
select pg_temp.assert(jsonb_array_length(jobs)=1,'admin jobs use existing worker') from admin_claim;
reset role;
set local role authenticated;
select public.admin_cancel_notification('30000000-0000-0000-0000-000000000101');
select public.admin_cancel_notification('30000000-0000-0000-0000-000000000101');
select pg_temp.assert(public.admin_notifications(0)->'notifications'->0->>'status'='cancelled','cancel is durable and idempotent');
select pg_temp.assert((public.admin_notifications(0)->'notifications'->0->>'interrupted_users')::int=1,'history exposes uncertain in-flight cancellation outcomes');
reset role;
set local role service_role;
select pg_temp.assert(public.notification_targets((jobs->0->>'id')::uuid,(jobs->0->>'lease')::uuid)='[]'::jsonb,'cancel revokes active lease before send') from admin_claim;
select public.finish_notification((jobs->0->>'id')::uuid,(jobs->0->>'lease')::uuid,true) from admin_claim;
select pg_temp.assert(public.claim_notifications()='[]'::jsonb,'cancelled campaign never reclaims');
reset role;
set local role authenticated;
select public.admin_create_notification('Single user','Message','user','10000000-0000-0000-0000-000000000102',null,'30000000-0000-0000-0000-000000000102');
reset role;
select pg_temp.assert((select count(*)=1 from private.notification_jobs where campaign_id='30000000-0000-0000-0000-000000000102'),'single-user scope');
set local role service_role;
create temporary table delivered_claim as select public.claim_notifications() as jobs;
select public.record_notification_delivery((jobs->0->>'id')::uuid,(jobs->0->>'lease')::uuid,'https://fcm.googleapis.com/fixture-102',false) from delivered_claim;
select public.finish_notification((jobs->0->>'id')::uuid,(jobs->0->>'lease')::uuid,true) from delivered_claim;
reset role;
set local role authenticated;
select pg_temp.assert(public.admin_notifications(0)->'notifications'->0->>'status'='completed','completed job shown in history');
select pg_temp.assert((public.admin_notifications(0)->'notifications'->0->>'accepted_devices')::int=1,'provider acceptance counted separately');
do $$ begin
  perform public.admin_cancel_notification('30000000-0000-0000-0000-000000000102');
  raise exception 'completed send can be cancelled';
exception when invalid_parameter_value then null;end $$;
select public.admin_create_notification('Expired device','Message','user','10000000-0000-0000-0000-000000000104',null,'30000000-0000-0000-0000-000000000103');
reset role;
set local role service_role;
create temporary table gone_claim as select public.claim_notifications() as jobs;
select public.record_notification_delivery((jobs->0->>'id')::uuid,(jobs->0->>'lease')::uuid,'https://fcm.googleapis.com/fixture-104',true) from gone_claim;
select public.finish_notification((jobs->0->>'id')::uuid,(jobs->0->>'lease')::uuid,true) from gone_claim;
reset role;
set local role authenticated;
select pg_temp.assert((public.admin_notifications(0)->'notifications'->0->>'accepted_devices')::int=0,'gone subscription never counted accepted');
select pg_temp.assert((public.admin_notifications(0)->'notifications'->0->>'expired_devices')::int=1,'gone provider outcome remains visible');
do $$ begin
  perform public.admin_create_notification('No device','Message','user','10000000-0000-0000-0000-000000000104',null,gen_random_uuid());
  raise exception 'removed subscription still eligible';
exception when invalid_parameter_value then null;end $$;
select public.admin_create_notification('Revoked author','Message','all',null,null,'30000000-0000-0000-0000-000000000104');
reset role;
set local role service_role;
create temporary table author_claim as select public.claim_notifications() as jobs;
reset role;
update private.accounts set role='user' where user_id='10000000-0000-0000-0000-000000000101';
set local role service_role;
select pg_temp.assert(public.notification_targets((jobs->0->>'id')::uuid,(jobs->0->>'lease')::uuid)='[]'::jsonb,'author privilege checked again before dispatch') from author_claim;
reset role;
update private.accounts set role='admin' where user_id='10000000-0000-0000-0000-000000000101';
delete from auth.sessions where user_id='10000000-0000-0000-0000-000000000101';
set local role authenticated;
do $$ begin
  perform public.admin_notifications(0);
  raise exception 'revoked session read history';
exception when insufficient_privilege then null;end $$;
reset role;
-- Housekeeping must preserve recent campaign receipts while removing old history.
insert into private.admin_notifications(id,title,body,audience,due_at,created_at)
values('30000000-0000-0000-0000-000000000105','Old','Body','all',now()-interval '91 days',now()-interval '91 days');
insert into private.notification_jobs(user_id,kind,job_key,payload,due_at,expires_at,campaign_id)
values('10000000-0000-0000-0000-000000000102','admin','old-fixture','{}',now()-interval '9 days',now()-interval '8 days','30000000-0000-0000-0000-000000000102');
do $$ declare command text; begin
  select j.command into command from cron.jobs j where name='opengym-housekeeping';
  execute command;
end $$;
select pg_temp.assert(exists(select 1 from private.notification_deliveries d join private.notification_jobs j on j.id=d.job_id where j.campaign_id='30000000-0000-0000-0000-000000000102'),'campaign receipts survive weekly queue cleanup');
select pg_temp.assert(not exists(select 1 from private.admin_notifications where id='30000000-0000-0000-0000-000000000105'),'history expires after 90 days');
rollback;
