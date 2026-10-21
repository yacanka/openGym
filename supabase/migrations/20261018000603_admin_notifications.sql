-- Admin campaigns reuse the existing per-user delivery queue and scheduler.
create table private.admin_notifications (
  id uuid primary key,
  created_by uuid references public.profiles(id) on delete set null,
  title text not null check(length(title) between 1 and 80),
  body text not null check(length(body) between 1 and 500),
  audience text not null check(audience in ('all','user')),
  target_user uuid references public.profiles(id) on delete set null,
  target_name text,
  scheduled_for timestamptz,
  due_at timestamptz not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  interrupted_users integer not null default 0,
  recipient_count integer not null default 0
);
create index admin_notifications_created on private.admin_notifications(created_at desc,id desc);
create index admin_notifications_author on private.admin_notifications(created_by);
create index admin_notifications_target on private.admin_notifications(target_user);
alter table private.admin_notifications enable row level security;
revoke all on private.admin_notifications from public,anon,authenticated;
grant all on private.admin_notifications to service_role;

alter table private.notification_jobs drop constraint notification_jobs_kind_check;
alter table private.notification_jobs add constraint notification_jobs_kind_check check(kind in ('rest','reminder','test','admin'));
alter table private.notification_jobs add column campaign_id uuid references private.admin_notifications(id) on delete cascade;
create index notification_jobs_campaign on private.notification_jobs(campaign_id) where campaign_id is not null;
-- A 404/410 is a terminal receipt, not provider acceptance. Old receipts are unknown.
alter table private.notification_deliveries add column gone boolean;

create function public.admin_create_notification(message_title text,message_body text,audience text,
  target_user uuid,scheduled_for timestamptz,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.require_admin(); existing private.admin_notifications;
  clean_title text:=btrim(message_title); clean_body text:=btrim(message_body);
  due timestamptz:=coalesce(scheduled_for,now()); targets uuid[]; target_name text;
begin
  -- Serializes rate limiting and identical retries across tabs/requests.
  perform 1 from private.accounts where user_id=uid for update;
  if request_id is null or clean_title is null or length(clean_title) not between 1 and 80
    or clean_body is null or length(clean_body) not between 1 and 500
    or audience is null or audience not in ('all','user')
    or (audience='user' and target_user is null) or (audience='all' and target_user is not null) then
    raise invalid_parameter_value using message='Check title, message and recipients';
  end if;
  select * into existing from private.admin_notifications c where c.id=request_id;
  if found then
    if existing.created_by is distinct from uid or existing.title<>clean_title or existing.body<>clean_body
      or existing.audience<>audience or existing.target_user is distinct from target_user
      or existing.scheduled_for is distinct from scheduled_for then
      raise invalid_parameter_value using message='Request identifier already used; refresh and try again';
    end if;
    return jsonb_build_object('id',existing.id,'recipient_count',existing.recipient_count);
  end if;
  if scheduled_for is not null and (not isfinite(scheduled_for) or scheduled_for<=now() or scheduled_for>now()+interval '30 days') then
    raise invalid_parameter_value using message='Choose a future time within 30 days';
  end if;
  if (select count(*) from private.admin_notifications where created_by=uid and created_at>now()-interval '1 minute')>=10 then
    raise invalid_parameter_value using message='Please wait before creating another notification';
  end if;
  select array_agg(a.user_id order by a.user_id) into targets
  from private.accounts a join auth.users u on u.id=a.user_id
  where not a.disabled and a.admitted and u.email_confirmed_at is not null
    and (audience='all' or a.user_id=target_user)
    and exists(select 1 from private.push_subscriptions p join auth.sessions s on s.id::text=p.session_id and s.user_id=p.user_id
      where p.user_id=a.user_id);
  if coalesce(cardinality(targets),0)=0 then
    raise invalid_parameter_value using message='No eligible users with active push subscriptions';
  end if;
  if cardinality(targets)>10000 then
    raise invalid_parameter_value using message='Recipient limit exceeded';
  end if;
  if audience='user' then select p.name into target_name from public.profiles p where p.id=target_user; end if;
  insert into private.admin_notifications(id,created_by,title,body,audience,target_user,target_name,scheduled_for,due_at,recipient_count)
    values(request_id,uid,clean_title,clean_body,audience,target_user,target_name,scheduled_for,due,cardinality(targets));
  insert into private.notification_jobs(user_id,kind,job_key,payload,due_at,expires_at,campaign_id)
    select recipient,'admin','admin:'||request_id,jsonb_build_object('title',clean_title,'body',clean_body,'tag','admin:'||request_id),
      due,due+interval '24 hours',request_id from unnest(targets) recipient;
  return jsonb_build_object('id',request_id,'recipient_count',cardinality(targets));
end $$;

create function public.admin_cancel_notification(campaign uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item private.admin_notifications;
begin
  perform private.require_admin();
  select * into item from private.admin_notifications c where c.id=campaign for update;
  if not found then raise no_data_found using message='Notification not found'; end if;
  if item.cancelled_at is not null then return '{"ok":true}'; end if;
  perform 1 from private.notification_jobs where campaign_id=campaign and status in ('pending','sending') for update;
  if not exists(select 1 from private.notification_jobs where campaign_id=campaign and status in ('pending','sending') and expires_at>now()) then
    raise invalid_parameter_value using message='This notification has already finished';
  end if;
  update private.admin_notifications set cancelled_at=now(),interrupted_users=(
    select count(*) from private.notification_jobs where campaign_id=campaign and status='sending') where id=campaign;
  update private.notification_jobs set status='cancelled',lease=null,lease_until=null
    where campaign_id=campaign and status in ('pending','sending');
  return '{"ok":true}';
end $$;

create function public.admin_notifications(page_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_admin();
  if page_offset is null or page_offset<0 or page_offset>100000 then
    raise invalid_parameter_value using message='Invalid history page';
  end if;
  select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at desc,item.id desc),'[]') into result
  from (
    select c.id,c.title,c.body,c.audience,c.target_name,c.due_at,c.created_at,c.recipient_count,c.interrupted_users,
      case when c.cancelled_at is not null then 'cancelled'
        when stats.pending>0 then case when c.due_at>now() then 'scheduled' else 'sending' end
        when stats.failed>0 then 'completed_with_errors' else 'completed' end as status,
      c.cancelled_at is null and stats.pending>0 as can_cancel,
      stats.pending,stats.failed,stats.completed,receipts.accepted_devices,receipts.expired_devices
    from private.admin_notifications c
    cross join lateral (select
      count(*) filter(where j.status in ('pending','sending') and j.expires_at>now()) as pending,
      count(*) filter(where j.status='failed' or (j.status in ('pending','sending') and j.expires_at<=now())) as failed,
      count(*) filter(where j.status='done') as completed
      from private.notification_jobs j where j.campaign_id=c.id) stats
    cross join lateral (select count(*) filter(where d.gone=false) as accepted_devices,
      count(*) filter(where d.gone=true) as expired_devices
      from private.notification_deliveries d join private.notification_jobs j on j.id=d.job_id where j.campaign_id=c.id) receipts
    order by c.created_at desc,c.id desc limit 20 offset page_offset
  ) item;
  return jsonb_build_object('notifications',result,'has_more',exists(
    select 1 from private.admin_notifications order by created_at desc,id desc offset page_offset+20 limit 1));
end $$;

-- Earliest expiry first protects rest timers/reminders from bulk campaign backlog,
-- while aging announcements gain priority as their own expiry approaches.
create or replace function public.claim_notifications() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  update private.notification_jobs set status='failed',lease=null where status in ('pending','sending')
    and (expires_at<=now() or (attempts>=4 and (lease_until is null or lease_until<=now())));
  with due as (
    select j.id from private.notification_jobs j join private.accounts a on a.user_id=j.user_id
    where j.status in ('pending','sending') and not a.disabled and a.admitted and j.due_at<=now() and j.expires_at>now()
      and (j.lease_until is null or j.lease_until<now()) and j.attempts<4
      and (j.session_id is null or exists(select 1 from auth.sessions where id::text=j.session_id))
    order by j.expires_at,j.due_at,j.id for update of j skip locked limit 1
  ), claimed as (
    update private.notification_jobs j set status='sending',lease=gen_random_uuid(),lease_until=now()+interval '60 seconds',attempts=attempts+1
      from due where j.id=due.id returning j.id,j.lease,j.payload,j.attempts,j.expires_at
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
  return result;
end $$;
create or replace function public.notification_targets(job uuid, token uuid) returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint',s.endpoint,'keys',s.keys)),'[]')
  from private.notification_jobs j join private.accounts a on a.user_id=j.user_id
  join private.push_subscriptions s on s.user_id=j.user_id join auth.sessions se on se.id::text=s.session_id and se.user_id=s.user_id
  where j.id=job and j.lease=token and j.status='sending' and j.lease_until>now() and j.expires_at>now()
    and not a.disabled and a.admitted
    and (j.session_id is null or exists(select 1 from auth.sessions where id::text=j.session_id))
    and (j.campaign_id is null or exists(select 1 from private.admin_notifications c
      join private.accounts author on author.user_id=c.created_by
      where c.id=j.campaign_id and c.cancelled_at is null and author.role='admin' and not author.disabled and author.admitted))
    and not exists(select 1 from private.notification_deliveries d where d.job_id=job and d.endpoint=s.endpoint)
$$;
create or replace function public.record_notification_delivery(job uuid, token uuid, endpoint text, gone boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from private.notification_jobs where id=job and lease=token and status='sending') then return; end if;
  insert into private.notification_deliveries(job_id,endpoint,gone) values(job,endpoint,gone) on conflict do nothing;
  if gone then delete from private.push_subscriptions p where p.endpoint=record_notification_delivery.endpoint; end if;
end $$;
revoke all on function public.admin_create_notification(text,text,text,uuid,timestamptz,uuid),public.admin_cancel_notification(uuid),public.admin_notifications(integer) from public,anon;
grant execute on function public.admin_create_notification(text,text,text,uuid,timestamptz,uuid),public.admin_cancel_notification(uuid),public.admin_notifications(integer) to authenticated;

-- Retain campaign receipts with their history for 90 days, instead of the normal 7.
select cron.schedule('opengym-housekeeping','17 * * * *',$job$
  delete from private.activity where updated_at<now()-interval '5 minutes';
  delete from private.push_subscriptions p where not exists(select 1 from auth.sessions s where s.id::text=p.session_id);
  update private.notification_jobs set status='failed',lease=null,lease_until=null
    where status in ('pending','sending') and (expires_at<now() or (attempts>=4 and lease_until<now()));
  delete from private.notification_jobs where campaign_id is null and expires_at<now()-interval '7 days';
  delete from private.admin_notifications where created_at<now()-interval '90 days';
  delete from private.state_receipts where created_at<now()-interval '30 days';
  delete from cron.job_run_details where start_time<now()-interval '1 day';
$job$);
