-- Feed Log: run in Supabase → SQL Editor → New query → Run. Safe to run again.
-- Needs Authentication → Sign In / Providers → "Allow anonymous sign-ins" turned on.
--
-- Each phone signs in (anonymously, no password) and joins a log with the secret code in
-- the share link. Only members of a log can read or change its entries; the public key in
-- app.js on its own can do nothing.

create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  room       text not null,
  type       text not null,
  at         timestamptz not null default now(),
  by_name    text not null default '',
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Breast feeds, bottles, weight check-ins and the baby/settings record.
alter table public.events drop constraint if exists events_type_check;
alter table public.events add constraint events_type_check check (type in ('breast','bottle','weight','baby'));

create index if not exists events_room_at_idx on public.events (room, at desc);

-- ---------- logs and who has joined them ----------
create table if not exists public.rooms (
  room       text primary key check (room ~ '^[a-z0-9]{8,32}$'),
  join_code  text not null check (length(join_code) >= 20),
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  room      text not null references public.rooms (room) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room, user_id)
);

alter table public.events  enable row level security;
alter table public.rooms   enable row level security;
alter table public.members enable row level security;

-- rooms and members are only reached through the functions below.
revoke all on public.rooms, public.members from anon, authenticated;

create or replace function public.is_member(p_room text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where room = p_room and user_id = auth.uid());
$$;

-- Creates the log if it's new (the caller's code becomes its join code), otherwise checks the code.
create or replace function public.join_room(p_room text, p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_room is null or p_room !~ '^[a-z0-9]{8,32}$' then raise exception 'bad_room'; end if;
  select join_code into v_code from rooms where room = p_room;
  if v_code is null then
    if p_code is null or p_code !~ '^[A-Za-z0-9_-]{20,64}$' then raise exception 'bad_code'; end if;
    insert into rooms (room, join_code) values (p_room, p_code) on conflict (room) do nothing;
    select join_code into v_code from rooms where room = p_room;
  end if;
  if v_code is distinct from p_code then raise exception 'bad_code'; end if;
  insert into members (room, user_id) values (p_room, auth.uid()) on conflict do nothing;
  return p_room;
end;
$$;

-- After email recovery: which log is this person in?
create or replace function public.my_room() returns table (room text, join_code text)
language sql stable security definer set search_path = public as $$
  select r.room, r.join_code
  from members m join rooms r on r.room = m.room
  where m.user_id = auth.uid()
  order by m.joined_at desc
  limit 1;
$$;

revoke execute on function public.is_member(text), public.join_room(text, text), public.my_room() from public, anon;
grant execute on function public.is_member(text), public.join_room(text, text), public.my_room() to authenticated;

-- ---------- entries: members only ----------
revoke all on public.events from anon;
grant select, insert, delete on public.events to authenticated;
-- Edits may change only the time and the details, never which log or who logged it.
revoke update on public.events from authenticated;
grant update (at, data) on public.events to authenticated;

drop policy if exists "anon read"   on public.events;
drop policy if exists "anon insert" on public.events;
drop policy if exists "anon update" on public.events;
drop policy if exists "anon delete" on public.events;
drop policy if exists "member read"   on public.events;
drop policy if exists "member insert" on public.events;
drop policy if exists "member update" on public.events;
drop policy if exists "member delete" on public.events;

create policy "member read"   on public.events for select to authenticated using (public.is_member(room));
create policy "member insert" on public.events for insert to authenticated with check (public.is_member(room));
create policy "member update" on public.events for update to authenticated using (public.is_member(room)) with check (public.is_member(room));
create policy "member delete" on public.events for delete to authenticated using (public.is_member(room));

-- Live updates between both phones (realtime applies the read policy above)
do $$ begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null;
end $$;
