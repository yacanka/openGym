-- Local PostgreSQL test fixture ONLY. Never apply this to a Supabase project.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
  created_at timestamptz default now(), email_confirmed_at timestamptz
);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id));
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
$$ select (auth.jwt()->>'sub')::uuid $$;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on function auth.uid(), auth.jwt() to authenticated, anon, service_role;
