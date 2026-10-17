\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',message;end if;end $$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('10000000-0000-0000-0000-000000000020','owner@example.test',now(),'{}'),
 ('10000000-0000-0000-0000-000000000021','member@example.test',now(),'{"admin":true,"role":"admin"}');
insert into auth.sessions(id,user_id) values
 ('20000000-0000-0000-0000-000000000020','10000000-0000-0000-0000-000000000020'),
 ('20000000-0000-0000-0000-000000000021','10000000-0000-0000-0000-000000000021');
select pg_temp.assert((select role='user' from private.accounts where user_id='10000000-0000-0000-0000-000000000021'),'metadata cannot grant admin');
update private.accounts set role='admin' where user_id='10000000-0000-0000-0000-000000000020';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000020","session_id":"20000000-0000-0000-0000-000000000020"}',true);
select pg_temp.assert(jsonb_array_length(public.admin_users()->'users')=2,'admin sees account summaries');
select pg_temp.assert(public.admin_user('10000000-0000-0000-0000-000000000021')->'user'->>'admin'='false','detail role is authoritative');
select public.admin_set_disabled('10000000-0000-0000-0000-000000000021',true);
select pg_temp.assert(public.admin_user('10000000-0000-0000-0000-000000000021')->'user'->>'disabled'='true','admin disable effective');
select public.admin_set_disabled('10000000-0000-0000-0000-000000000021',false);
do $$begin
 perform public.admin_set_disabled('10000000-0000-0000-0000-000000000020',true);
 raise exception 'FAIL: admin disabled';
exception when invalid_parameter_value then null;end$$;
select public.admin_new_invite('test invite');
reset role;
update private.accounts set admitted=false where user_id='10000000-0000-0000-0000-000000000021';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000021","session_id":"20000000-0000-0000-0000-000000000021"}',true);
select pg_temp.assert(not (public.account_status()->>'allowed')::boolean,'unadmitted account cannot access data');
do $$begin
 update public.user_states set state='{}' where user_id=auth.uid();
 raise exception 'FAIL: direct state update allowed';
exception when insufficient_privilege then null;end$$;
reset role;
create temporary table invite_code as select code from private.invites limit 1;
grant select on invite_code to authenticated;
set local role authenticated;
select pg_temp.assert((public.redeem_invite((select code from invite_code))->>'allowed')::boolean,'invite grants admission');
select public.update_activity('{"active":true,"name":"Workout","setsDone":1}');
reset role;
select pg_temp.assert((select payload->>'setsDone'='1' from private.activity),'activity recorded');
update private.activity set updated_at=now()-interval '71 seconds';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000020","session_id":"20000000-0000-0000-0000-000000000020"}',true);
select pg_temp.assert(public.admin_user('10000000-0000-0000-0000-000000000021')->'workouts'='[]'::jsonb,'missing state remains empty');
select pg_temp.assert(not exists(select 1 from jsonb_array_elements(public.admin_users()->'users') u where u->'live'<>'null'::jsonb),'stale activity hidden');
reset role;
-- The producer uses local date/day/time, skips completed workouts, deduplicates.
insert into private.push_subscriptions(endpoint,user_id,keys,session_id)
values('https://fcm.googleapis.com/daily','10000000-0000-0000-0000-000000000021','{}','20000000-0000-0000-0000-000000000021');
insert into public.user_states(user_id,state) values('10000000-0000-0000-0000-000000000021',jsonb_build_object(
 'reminder',jsonb_build_object('on',true,'tz','UTC','time',to_char(now() at time zone 'UTC','HH24:MI')),
 'week',jsonb_build_object(extract(dow from now() at time zone 'UTC')::int::text,'routine'),
 'routines','[{"id":"routine","name":"Routine"}]'::jsonb,'workouts','[]'::jsonb));
select private.enqueue_reminders();select private.enqueue_reminders();
select pg_temp.assert((select count(*)=1 from private.notification_jobs where kind='reminder'),'daily reminder deduplicated');
delete from private.notification_jobs;
update public.user_states set state=jsonb_set(state,'{dayPlan}',jsonb_build_object(to_char(now() at time zone 'UTC','YYYY-MM-DD'),'rest'));
select private.enqueue_reminders();
select pg_temp.assert((select count(*)=0 from private.notification_jobs),'rest-day override respected');
update public.user_states set state=jsonb_set(state,'{dayPlan}',jsonb_build_object(to_char(now() at time zone 'UTC','YYYY-MM-DD'),'missing-routine'));
select private.enqueue_reminders();
select pg_temp.assert((select count(*)=1 from private.notification_jobs),'missing override falls back to weekly plan');
delete from private.notification_jobs;
update public.user_states set state=(state-'dayPlan')||jsonb_build_object('workouts',jsonb_build_array(jsonb_build_object('d',to_char(now() at time zone 'UTC','YYYY-MM-DD'))));
select private.enqueue_reminders();
select pg_temp.assert((select count(*)=0 from private.notification_jobs),'completed workout suppresses reminder');
rollback;
