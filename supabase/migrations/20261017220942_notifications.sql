alter table private.push_subscriptions add column session_id text not null;
create table private.notification_jobs (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check(kind in ('rest','reminder','test')), job_key text not null,
  payload jsonb not null, due_at timestamptz not null, expires_at timestamptz not null,
  session_id text, lease uuid, lease_until timestamptz,
  attempts integer not null default 0, status text not null default 'pending' check(status in ('pending','sending','done','cancelled','failed')),
  created_at timestamptz not null default now(), unique(user_id,job_key)
);
create index notification_due on private.notification_jobs(due_at) where status in ('pending','sending');
create function public.push_subscription_status(endpoint text) returns boolean language sql stable security definer set search_path='' as $$
  select private.allowed() and exists(select 1 from private.push_subscriptions p
    where p.endpoint=push_subscription_status.endpoint and p.user_id=auth.uid() and p.session_id=auth.jwt()->>'session_id')
$$;
revoke all on function public.push_subscription_status(text) from public,anon;
grant execute on function public.push_subscription_status(text) to authenticated;
create table private.notification_deliveries (
  job_id uuid references private.notification_jobs(id) on delete cascade,
  endpoint text not null, delivered_at timestamptz not null default now(), primary key(job_id,endpoint)
);

create function public.put_push_subscription(subscription jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.require_user();
begin
  if subscription->>'endpoint' not like 'https://%' or length(subscription->>'endpoint')>4096
    or coalesce(length(subscription->'keys'->>'p256dh'),0) not between 1 and 256
    or coalesce(length(subscription->'keys'->>'auth'),0) not between 1 and 256 then
    raise invalid_parameter_value using message='Invalid subscription';
  end if;
  insert into private.push_subscriptions(endpoint,user_id,keys,session_id)
    values(subscription->>'endpoint',uid,subscription->'keys',auth.jwt()->>'session_id')
    on conflict(endpoint) do update set user_id=excluded.user_id,keys=excluded.keys,session_id=excluded.session_id,created_at=now();
  return '{"ok":true}';
end $$;
create function public.remove_push_subscription(endpoint text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  delete from private.push_subscriptions s where s.user_id=private.require_user() and s.endpoint=remove_push_subscription.endpoint;
  return '{"ok":true}';
end $$;
create function public.schedule_rest(seconds integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.require_user(); due timestamptz;
begin
  if seconds is null or seconds<1 or seconds>3600 then raise invalid_parameter_value using message='Seconds must be between 1 and 3600'; end if;
  perform 1 from private.accounts where user_id=uid for update;
  due:=now()+make_interval(secs=>seconds);
  -- A fresh id invalidates all claims and per-delivery receipts for the old timer.
  delete from private.notification_jobs where user_id=uid and job_key='rest';
  insert into private.notification_jobs(user_id,kind,job_key,payload,due_at,expires_at,session_id)
    values(uid,'rest','rest','{"title":"Rest over 💪","body":"Time for your next set.","tag":"rest-timer"}',due,due+interval '60 seconds',auth.jwt()->>'session_id');
  return '{"ok":true}';
end $$;
create function public.cancel_rest() returns jsonb language plpgsql security definer set search_path='' as $$
begin
  update private.notification_jobs set status='cancelled',lease=null,lease_until=null
    where user_id=private.require_user() and job_key='rest';
  return '{"ok":true}';
end $$;
create function public.request_test_push() returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.require_user();
begin
  perform 1 from private.accounts where user_id=uid for update;
  if (select count(*) from private.notification_jobs where user_id=uid and kind='test' and created_at>now()-interval '1 minute')>=3 then
    raise invalid_parameter_value using message='Please wait before sending another test';
  end if;
  insert into private.notification_jobs(user_id,kind,job_key,payload,due_at,expires_at,session_id)
    values(uid,'test','test:'||gen_random_uuid(),'{"title":"openGym","body":"Test notification ✅","tag":"test"}'::jsonb,now(),now()+interval '1 minute',auth.jwt()->>'session_id');
  return '{"ok":true}';
end $$;

-- Reminder producer runs every 10s. A unique per-user/local-date key prevents duplicates.
create function private.enqueue_reminders() returns void language plpgsql security definer set search_path='' as $$
declare item record; st jsonb; local_now timestamp; rid text; routine jsonb; date_key text;
begin
  for item in select s.user_id,s.state from public.user_states s join private.accounts a on a.user_id=s.user_id
    where not a.disabled and a.admitted and s.state->'reminder'->>'on'='true'
    and exists(select 1 from private.push_subscriptions p join auth.sessions se on se.id::text=p.session_id where p.user_id=s.user_id)
  loop
    st:=item.state;
    if not exists(select 1 from pg_timezone_names where name=coalesce(st->'reminder'->>'tz','UTC')) then continue; end if;
    local_now:=now() at time zone coalesce(st->'reminder'->>'tz','UTC');
    if to_char(local_now,'HH24:MI') is distinct from st->'reminder'->>'time' then continue; end if;
    date_key:=to_char(local_now,'YYYY-MM-DD');
    if exists(select 1 from jsonb_array_elements(coalesce(st->'workouts','[]')) w where w->>'d'=date_key) then continue; end if;
    rid:=nullif(st->'dayPlan'->>date_key,'');
    if rid='rest' then continue; end if;
    if rid is null or not exists(select 1 from jsonb_array_elements(coalesce(st->'routines','[]')) r where r->>'id'=rid) then
      rid:=st->'week'->>extract(dow from local_now)::integer::text;
    end if;
    if rid is null or rid='rest' then continue; end if;
    select r into routine from jsonb_array_elements(coalesce(st->'routines','[]')) r where r->>'id'=rid;
    if routine is null then continue; end if;
    insert into private.notification_jobs(user_id,kind,job_key,payload,due_at,expires_at)
      values(item.user_id,'reminder','reminder:'||date_key,jsonb_build_object(
        'title',coalesce(routine->>'emoji','🏋️')||' '||(routine->>'name')||' today',
        'body','It’s on your plan — let’s go 💪','tag','day-reminder'),now(),now()+interval '15 minutes')
      on conflict(user_id,job_key) do nothing;
  end loop;
end $$;

create function public.claim_notifications() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  update private.notification_jobs set status='failed',lease=null where status in ('pending','sending')
    and (expires_at<=now() or (attempts>=4 and (lease_until is null or lease_until<=now())));
  with due as (
    select j.id from private.notification_jobs j join private.accounts a on a.user_id=j.user_id
    where j.status in ('pending','sending') and not a.disabled and a.admitted and j.due_at<=now() and j.expires_at>now()
      and (j.lease_until is null or j.lease_until<now()) and j.attempts<4
      and (j.session_id is null or exists(select 1 from auth.sessions where id::text=j.session_id))
    order by j.due_at for update of j skip locked limit 1
  ), claimed as (
    update private.notification_jobs j set status='sending',lease=gen_random_uuid(),lease_until=now()+interval '60 seconds',attempts=attempts+1
      from due where j.id=due.id returning j.id,j.lease,j.payload,j.attempts,j.expires_at
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
  return result;
end $$;
create function public.notification_targets(job uuid, token uuid) returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint',s.endpoint,'keys',s.keys)),'[]')
  from private.notification_jobs j join private.accounts a on a.user_id=j.user_id
  join private.push_subscriptions s on s.user_id=j.user_id join auth.sessions se on se.id::text=s.session_id and se.user_id=s.user_id
  where j.id=job and j.lease=token and j.status='sending' and j.lease_until>now() and j.expires_at>now()
    and not a.disabled and a.admitted
    and (j.session_id is null or exists(select 1 from auth.sessions where id::text=j.session_id))
    and not exists(select 1 from private.notification_deliveries d where d.job_id=job and d.endpoint=s.endpoint)
$$;
create function public.finish_notification(job uuid, token uuid, success boolean) returns void language plpgsql security definer set search_path='' as $$
declare remaining boolean:=jsonb_array_length(public.notification_targets(job,token))>0;
begin
  update private.notification_jobs set status=case when success and not remaining then 'done' when not success and attempts>=4 then 'failed' else 'pending' end,
    attempts=case when success and remaining then 0 else attempts end,
    due_at=case when success then due_at else now()+make_interval(secs=>case attempts when 1 then 5 when 2 then 15 else 30 end) end,
    lease=null,lease_until=null where id=job and lease=token and lease_until>now();
end
$$;
create function public.record_notification_delivery(job uuid, token uuid, endpoint text, gone boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from private.notification_jobs where id=job and lease=token and status='sending') then return; end if;
  insert into private.notification_deliveries(job_id,endpoint) values(job,endpoint) on conflict do nothing;
  if gone then delete from private.push_subscriptions p where p.endpoint=record_notification_delivery.endpoint; end if;
end $$;

revoke all on function private.enqueue_reminders() from public, anon, authenticated;
revoke all on function public.put_push_subscription(jsonb),public.remove_push_subscription(text),public.schedule_rest(integer),
  public.cancel_rest(),public.request_test_push() from public,anon;
grant execute on function public.put_push_subscription(jsonb),public.remove_push_subscription(text),public.schedule_rest(integer),
  public.cancel_rest(),public.request_test_push() to authenticated;
revoke all on function public.claim_notifications(),public.notification_targets(uuid,uuid),public.finish_notification(uuid,uuid,boolean),
  public.record_notification_delivery(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_notifications(),public.notification_targets(uuid,uuid),public.finish_notification(uuid,uuid,boolean),
  public.record_notification_delivery(uuid,uuid,text,boolean) to service_role;
grant all on all tables in schema private to service_role;
revoke all on all tables in schema private from public, anon, authenticated;
