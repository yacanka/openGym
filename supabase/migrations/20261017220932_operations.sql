create table private.invites (
  code text primary key, note text not null default '', created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), used_by uuid references public.profiles(id), used_at timestamptz
);
create table private.activity (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  payload jsonb not null, updated_at timestamptz not null default now()
);
create table private.push_subscriptions (
  endpoint text primary key, user_id uuid not null references public.profiles(id) on delete cascade,
  keys jsonb not null, created_at timestamptz not null default now()
);
create index push_subscriptions_user on private.push_subscriptions(user_id);

create function public.admin_users() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'created',p.created_at,'disabled',a.disabled,'admin',a.role='admin',
    'invitedBy',a.invited_by,'workouts',jsonb_array_length(coalesce(s.state->'workouts','[]')),
    'lastWorkout',s.state->'workouts'->-1->>'d','lastSync',s.state->'_ts',
    'hasPush',exists(select 1 from private.push_subscriptions b where b.user_id=p.id),
    'live',case when not a.disabled and l.updated_at>now()-interval '70 seconds' then l.payload else null end
  ) order by p.created_at),'[]') into result
  from public.profiles p join private.accounts a on a.user_id=p.id
  left join public.user_states s on s.user_id=p.id left join private.activity l on l.user_id=p.id;
  return jsonb_build_object('users',result,'invite_only',(select invite_only from private.app_config),
    'now',floor(extract(epoch from now())*1000));
end $$;
create function public.admin_user(id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_admin();
  select jsonb_build_object('user',jsonb_build_object('id',p.id,'name',p.name,'created',p.created_at,
    'disabled',a.disabled,'admin',a.role='admin','invitedBy',a.invited_by),
    'unit',coalesce(s.state->>'unit','kg'),'lastSync',s.state->'_ts',
    'routines',coalesce(s.state->'routines','[]'),'bodyweight',coalesce(s.state->'bodyweight','[]'),
    'workouts',coalesce((select jsonb_agg(w.value order by w.ordinality desc)
      from jsonb_array_elements(coalesce(s.state->'workouts','[]')) with ordinality w),'[]')) into result
  from public.profiles p join private.accounts a on a.user_id=p.id
  left join public.user_states s on s.user_id=p.id where p.id=admin_user.id;
  if result is null then raise no_data_found using message='No such user'; end if;
  return result;
end $$;
create function public.admin_set_disabled(id uuid, disabled boolean) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin();
  if exists(select 1 from private.accounts where user_id=id and role='admin') then
    raise invalid_parameter_value using message='Cannot disable an admin';
  end if;
  update private.accounts a set disabled=admin_set_disabled.disabled where a.user_id=id;
  if not found then raise no_data_found using message='No such user'; end if;
  if disabled then delete from private.activity where user_id=id; end if;
  return jsonb_build_object('ok',true,'id',id,'disabled',disabled);
end $$;
create function public.admin_invites() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_admin();
  return jsonb_build_object('invite_only',(select invite_only from private.app_config),'invites',
    coalesce((select jsonb_agg(jsonb_build_object('code',i.code,'note',i.note,'created',i.created_at,
      'createdBy',i.created_by,'usedBy',i.used_by,'usedAt',i.used_at,'usedByName',p.name) order by i.created_at)
      from private.invites i left join public.profiles p on p.id=i.used_by),'[]'));
end $$;
create function public.admin_new_invite(note text default '') returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.require_admin(); new_code text:=upper(encode(extensions.gen_random_bytes(8),'hex'));
begin
  insert into private.invites(code,note,created_by) values(new_code,left(coalesce(note,''),60),uid);
  return jsonb_build_object('invite',jsonb_build_object('code',new_code,'createdBy',uid,'created',now()));
end $$;
create function public.admin_revoke_invite(code text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin();
  delete from private.invites i where i.code=upper(trim(admin_revoke_invite.code)) and used_by is null;
  if not found then raise invalid_parameter_value using message='Invite missing or already used'; end if;
  return '{"ok":true}';
end $$;
create function public.redeem_invite(code text) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); accepted text;
begin
  if not private.session_live() or not exists(select 1 from private.accounts where user_id=uid and not disabled) then
    raise insufficient_privilege using message='Account access denied';
  end if;
  perform 1 from private.accounts where user_id=uid for update;
  if (select admitted from private.accounts where user_id=uid) then return public.account_status(); end if;
  update private.invites i set used_by=uid,used_at=now()
    where i.code=upper(trim(redeem_invite.code)) and used_by is null returning i.code into accepted;
  if accepted is null then raise invalid_parameter_value using message='Invalid invite code'; end if;
  update private.accounts set admitted=true,invited_by=accepted where user_id=uid;
  return public.account_status();
end $$;
create function public.update_activity(activity jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.require_user(); clean jsonb;
begin
  if activity->>'active'='true' then
    if octet_length(activity::text)>2048 then raise invalid_parameter_value using message='Invalid activity'; end if;
    clean:=jsonb_build_object('name',left(activity->>'name',60),'exIdx',activity->'exIdx',
      'exTotal',activity->'exTotal','setsDone',activity->'setsDone','setsTotal',activity->'setsTotal',
      'startedAt',activity->'startedAt','updatedAt',floor(extract(epoch from now())*1000));
    insert into private.activity(user_id,payload) values(uid,clean)
      on conflict(user_id) do update set payload=excluded.payload,updated_at=now();
  else delete from private.activity where user_id=uid; end if;
  return '{"ok":true}';
end $$;

-- Only narrow RPCs are exposed; no client can change roles or read subscriptions.
revoke all on function public.admin_users(), public.admin_user(uuid), public.admin_set_disabled(uuid,boolean),
  public.admin_invites(), public.admin_new_invite(text), public.admin_revoke_invite(text),
  public.redeem_invite(text), public.update_activity(jsonb) from public, anon;
grant execute on function public.admin_users(), public.admin_user(uuid), public.admin_set_disabled(uuid,boolean),
  public.admin_invites(), public.admin_new_invite(text), public.admin_revoke_invite(text),
  public.redeem_invite(text), public.update_activity(jsonb) to authenticated;
grant all on all tables in schema private to service_role;
revoke all on all tables in schema private from public, anon, authenticated;
