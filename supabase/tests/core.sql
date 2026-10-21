\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %', message; end if; end $$;

insert into auth.users(id,email,email_confirmed_at) values
 ('10000000-0000-0000-0000-000000000001','one@example.test',now()),
 ('10000000-0000-0000-0000-000000000002','two@example.test',now());
insert into auth.sessions(id,user_id) values
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","session_id":"20000000-0000-0000-0000-000000000001"}',true);
select pg_temp.assert((public.account_status()->>'allowed')::boolean,'valid session allowed');
select pg_temp.assert((public.save_user_state('{"workouts":[],"routines":[],"active":{"private":true}}',0,'30000000-0000-0000-0000-000000000001')->>'version')::int=1,'first state version');
select pg_temp.assert((select not (state ? 'active') from public.user_states),'active stripped');
select pg_temp.assert((public.save_user_state('{"workouts":[]}',0,'30000000-0000-0000-0000-000000000001')->>'version')::int=1,'lost response retry idempotent');
select pg_temp.assert(public.save_user_state('{}',0,'30000000-0000-0000-0000-000000000002')->>'status'='conflict','stale write rejected');
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000002","session_id":"20000000-0000-0000-0000-000000000002"}',true);
select pg_temp.assert((select count(*)=0 from public.user_states),'other user cannot read');
do $$ begin
  perform public.admin_users();
  raise exception 'FAIL: non-admin accepted';
exception when insufficient_privilege then null; end $$;
reset role;
update private.accounts set disabled=true where user_id='10000000-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.assert(not (public.account_status()->>'allowed')::boolean,'disabled denied');
do $$ begin
  perform public.save_user_state('{}',0,'30000000-0000-0000-0000-000000000003');
  raise exception 'FAIL: disabled write accepted';
exception when insufficient_privilege then null; end $$;
reset role;
delete from auth.sessions where user_id='10000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","session_id":"20000000-0000-0000-0000-000000000001"}',true);
select pg_temp.assert((select count(*)=0 from public.user_states),'revoked JWT cannot read');
do $$ begin
  perform public.save_user_state('{}',1,'30000000-0000-0000-0000-000000000004');
  raise exception 'FAIL: revoked JWT write accepted';
exception when insufficient_privilege then null; end $$;
reset role;
set local role anon;
select pg_temp.assert((select count(*)=0 from public.user_states),'anonymous cannot read');
reset role;
rollback;
