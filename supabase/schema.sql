-- Personal PACS – access control for the user software.
--
-- Run this once in your Supabase project: Dashboard › SQL Editor › New query › paste › Run.
-- Running it again is safe (it updates the functions and rules).
--
-- People sign up in the user software (name, email, password). Their request appears in the
-- master software, which approves it and sets on how many computers the account may be used.
-- The master software signs in with an account listed in public.admins (see the end of this file).

-- ------------------------------------------------------------------ tables

-- Accounts that may use the master software.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

-- One row per person using the user software: the access request and its decision.
create table if not exists public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'revoked')),
  max_devices integer not null default 1 check (max_devices between 1 and 100),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null
);

-- The computers an account is used on (at most members.max_devices of them).
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.members (user_id) on delete cascade,
  device_key text not null check (char_length(device_key) between 16 and 128),
  name text not null default '' check (char_length(name) <= 120),
  platform text not null default '' check (char_length(platform) <= 40),
  app_version text not null default '' check (char_length(app_version) <= 40),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (user_id, device_key)
);

create index if not exists members_status_idx on public.members (status, requested_at desc);
create index if not exists devices_user_idx on public.devices (user_id);

-- ------------------------------------------------------------------ rules (row level security)

alter table public.admins enable row level security;
alter table public.members enable row level security;
alter table public.devices enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.admins a where a.user_id = auth.uid()) $$;

-- Everyone reads only their own rows; the master reads everything. Nobody writes the tables
-- directly: all changes go through the functions below.
drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins for select to authenticated
  using (user_id = auth.uid());

revoke all on public.admins, public.members, public.devices from anon, authenticated;
grant select on public.admins, public.members, public.devices to authenticated;

-- ------------------------------------------------------------------ user software

-- Creates the access request of the signed-in account (or updates its name). With p_again,
-- a declined or withdrawn account asks again (it becomes pending).
create or replace function public.request_access(p_name text, p_again boolean default false)
returns public.members
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  mail text;
  clean text := left(btrim(coalesce(p_name, '')), 120);
  m public.members;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  select u.email into mail from auth.users u where u.id = uid;
  insert into public.members (user_id, name, email)
    values (uid, case when clean = '' then coalesce(mail, 'User') else clean end, coalesce(mail, ''))
  on conflict (user_id) do update set
    name = case when clean = '' then public.members.name else clean end,
    email = coalesce(mail, public.members.email),
    status = case when p_again and public.members.status in ('denied', 'revoked') then 'pending' else public.members.status end,
    requested_at = case when p_again and public.members.status in ('denied', 'revoked') then now() else public.members.requested_at end
  returning * into m;
  return m;
end
$$;

-- At every start of the user software: registers this computer (within the account's computer
-- limit) and returns the account's status. device = 'ok' or 'limit'; status 'none' = no request yet.
create or replace function public.check_in(p_device_key text, p_name text, p_platform text, p_version text)
returns json
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  m public.members;
  used integer;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  if char_length(coalesce(p_device_key, '')) not between 16 and 128 then
    raise exception 'Bad device key';
  end if;
  select * into m from public.members where user_id = uid;
  if not found then
    return json_build_object('status', 'none', 'server_time', now());
  end if;
  update public.devices
     set last_seen = now(),
         name = left(coalesce(p_name, ''), 120),
         platform = left(coalesce(p_platform, ''), 40),
         app_version = left(coalesce(p_version, ''), 40)
   where user_id = uid and device_key = p_device_key;
  if not found then
    select count(*) into used from public.devices where user_id = uid;
    if used >= m.max_devices then
      return json_build_object('status', m.status, 'name', m.name, 'device', 'limit',
        'max_devices', m.max_devices, 'devices', used, 'server_time', now());
    end if;
    insert into public.devices (user_id, device_key, name, platform, app_version)
      values (uid, p_device_key, left(coalesce(p_name, ''), 120), left(coalesce(p_platform, ''), 40), left(coalesce(p_version, ''), 40));
  end if;
  select count(*) into used from public.devices where user_id = uid;
  return json_build_object('status', m.status, 'name', m.name, 'device', 'ok',
    'max_devices', m.max_devices, 'devices', used, 'server_time', now());
end
$$;

-- ------------------------------------------------------------------ master software

-- Approve / decline / withdraw (and optionally set the computer limit).
create or replace function public.admin_decide(p_user uuid, p_status text, p_max_devices integer default null)
returns public.members
language plpgsql security definer set search_path = ''
as $$
declare
  m public.members;
begin
  if not public.is_admin() then
    raise exception 'Only the master account can do this';
  end if;
  if p_status not in ('pending', 'approved', 'denied', 'revoked') then
    raise exception 'Unknown status %', p_status;
  end if;
  update public.members
     set status = p_status,
         max_devices = coalesce(p_max_devices, max_devices),
         decided_at = now(),
         decided_by = auth.uid()
   where user_id = p_user
  returning * into m;
  if not found then
    raise exception 'No such user';
  end if;
  return m;
end
$$;

create or replace function public.admin_set_devices(p_user uuid, p_max_devices integer)
returns public.members
language plpgsql security definer set search_path = ''
as $$
declare
  m public.members;
begin
  if not public.is_admin() then
    raise exception 'Only the master account can do this';
  end if;
  update public.members set max_devices = p_max_devices where user_id = p_user returning * into m;
  if not found then
    raise exception 'No such user';
  end if;
  return m;
end
$$;

-- Frees a computer's place (for example when the person changed computers).
create or replace function public.admin_remove_device(p_device uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only the master account can do this';
  end if;
  delete from public.devices where id = p_device;
end
$$;

-- Removes a request entirely (the person can sign in and ask again).
create or replace function public.admin_delete_member(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only the master account can do this';
  end if;
  delete from public.members where user_id = p_user;
end
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.request_access(text, boolean) from public, anon;
revoke all on function public.check_in(text, text, text, text) from public, anon;
revoke all on function public.admin_decide(uuid, text, integer) from public, anon;
revoke all on function public.admin_set_devices(uuid, integer) from public, anon;
revoke all on function public.admin_remove_device(uuid) from public, anon;
revoke all on function public.admin_delete_member(uuid) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.request_access(text, boolean) to authenticated;
grant execute on function public.check_in(text, text, text, text) to authenticated;
grant execute on function public.admin_decide(uuid, text, integer) to authenticated;
grant execute on function public.admin_set_devices(uuid, integer) to authenticated;
grant execute on function public.admin_remove_device(uuid) to authenticated;
grant execute on function public.admin_delete_member(uuid) to authenticated;

-- ------------------------------------------------------------------ your master account
-- 1. Dashboard › Authentication › Users › Add user › Create new user: your email and a password
--    ("Auto Confirm User" on).
-- 2. Then run this line with that email (in a new query):
--
--    insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
