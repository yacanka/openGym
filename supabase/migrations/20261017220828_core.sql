-- Application-owned authorization stays outside the exposed Data API schema.
create schema if not exists private;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create table private.app_config (
  singleton boolean primary key default true check (singleton),
  invite_only boolean not null default false
);
insert into private.app_config default values;
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  created_at timestamptz not null default now()
);
create table private.accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  role text not null default 'user' check (role in ('user','admin')),
  disabled boolean not null default false,
  admitted boolean not null default true,
  invited_by text
);
create table public.user_states (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  state jsonb not null default '{}' check (jsonb_typeof(state)='object' and not state ? 'active'),
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table private.state_receipts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  mutation_id uuid not null,
  version bigint not null,
  created_at timestamptz not null default now(),
  primary key (user_id, mutation_id)
);

create function private.create_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,name) values (new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),
      nullif(trim(new.raw_user_meta_data->>'full_name'),''),'Athlete'),40));
  insert into private.accounts(user_id,admitted)
    select new.id, not invite_only from private.app_config;
  return new;
end $$;
create trigger opengym_create_profile after insert on auth.users
  for each row execute function private.create_profile();

-- JWT signature checks alone do not revoke an already-issued access token.
create function private.session_live() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id
    where s.id::text=auth.jwt()->>'session_id' and s.user_id=auth.uid()
      and u.email_confirmed_at is not null)
$$;
create function private.allowed() returns boolean language sql stable security definer set search_path='' as $$
  select private.session_live() and exists(select 1 from private.accounts
    where user_id=auth.uid() and not disabled and admitted)
$$;
create function private.is_admin() returns boolean language sql stable security definer set search_path='' as $$
  select private.allowed() and exists(select 1 from private.accounts where user_id=auth.uid() and role='admin')
$$;
create function private.require_user() returns uuid language plpgsql stable security definer set search_path='' as $$
begin
  if not private.allowed() then raise insufficient_privilege using message='Account access denied'; end if;
  return auth.uid();
end $$;
create function private.require_admin() returns uuid language plpgsql stable security definer set search_path='' as $$
begin
  if not private.is_admin() then raise insufficient_privilege using message='Admin access required'; end if;
  return auth.uid();
end $$;

alter table public.profiles enable row level security;
alter table public.user_states enable row level security;
revoke all on public.profiles, public.user_states from anon, authenticated;
grant select on public.profiles, public.user_states to anon, authenticated;
create policy own_profile on public.profiles for select to authenticated
  using (id=(select auth.uid()) and (select private.allowed()));
create policy own_state on public.user_states for select to authenticated
  using (user_id=(select auth.uid()) and (select private.allowed()));

create function public.account_status() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.session_live() then raise insufficient_privilege using message='Session expired'; end if;
  select jsonb_build_object('id',p.id,'name',p.name,'admin',a.role='admin',
    'disabled',a.disabled,'allowed',not a.disabled and a.admitted,
    'invite_only',c.invite_only,'needs_invite',not a.admitted)
    into result from public.profiles p join private.accounts a on a.user_id=p.id
    cross join private.app_config c where p.id=auth.uid();
  return result;
end $$;

create function public.save_user_state(state jsonb, expected_version bigint, mutation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=private.require_user(); current_row public.user_states; receipt bigint; key text;
begin
  if jsonb_typeof(state) is distinct from 'object' or octet_length(state::text)>5242880
    or expected_version is null or expected_version<0 or mutation_id is null then
    raise invalid_parameter_value using message='Invalid state';
  end if;
  foreach key in array array['workouts','routines','bodyweight','customEx'] loop
    if state ? key and jsonb_typeof(state->key)<>'array' then
      raise invalid_parameter_value using message='Invalid state collection';
    end if;
  end loop;
  -- Also serializes first writes, where no state row exists to lock yet.
  perform 1 from private.accounts where user_id=uid and admitted and not disabled for update;
  if not found then raise insufficient_privilege using message='Account access denied'; end if;
  select r.version into receipt from private.state_receipts r
    where r.user_id=uid and r.mutation_id=save_user_state.mutation_id;
  if found then return jsonb_build_object('status','saved','version',receipt); end if;
  select * into current_row from public.user_states where user_id=uid;
  if coalesce(current_row.version,0)<>expected_version then
    return jsonb_build_object('status','conflict','version',current_row.version,
      'state',current_row.state,'updated_at',current_row.updated_at);
  end if;
  insert into public.user_states as saved(user_id,state,version) values(uid,state-'active',expected_version+1)
    on conflict(user_id) do update set state=excluded.state,version=excluded.version,updated_at=now();
  insert into private.state_receipts(user_id,mutation_id,version) values(uid,mutation_id,expected_version+1);
  return jsonb_build_object('status','saved','version',expected_version+1);
end $$;

-- No new function should inherit PUBLIC execution privileges.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.allowed() to authenticated;
revoke all on function public.account_status(), public.save_user_state(jsonb,bigint,uuid) from public, anon;
grant execute on function public.account_status(), public.save_user_state(jsonb,bigint,uuid) to authenticated;
grant all on all tables in schema private, public to service_role;
revoke all on all tables in schema private from public, anon, authenticated;
