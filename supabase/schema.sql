-- ─────────────────────────────────────────────────────────────
--  Άδειες v2 — Supabase schema
--  Run once in Supabase → SQL Editor → New query → Run.
--  BEFORE running: change the two e-mails and names at the bottom.
-- ─────────────────────────────────────────────────────────────

-- People (the two of you). Rows are created only from this SQL,
-- never from the app, so nobody else can add themselves.
create table public.people (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null check (char_length(name) between 1 and 40),
  color         text not null default '#0f766e' check (color ~ '^#[0-9a-fA-F]{6}$'),
  -- JS weekday numbers: 0 = Sunday … 6 = Saturday
  work_days     smallint[] not null default '{1,2,3,4,5}'
                check (work_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  -- keys of default Greek holidays this person works on (e.g. 'whit_monday')
  skip_holidays text[] not null default '{}',
  sort          smallint not null default 0,
  created_at    timestamptz not null default now()
);

-- Leave allowance per person per year
create table public.allowances (
  person_id    uuid not null references public.people(id) on delete cascade,
  year         smallint not null check (year between 2000 and 2100),
  total_days   numeric(5,1) not null default 0 check (total_days >= 0 and total_days <= 366),
  carried_over numeric(5,1) not null default 0 check (carried_over >= 0 and carried_over <= 366),
  primary key (person_id, year)
);

-- Leaves. Working days are computed in the app from the dates
-- (weekends + Greek holidays excluded), so they never go out of sync.
create table public.leaves (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people(id) on delete cascade,
  type        text not null default 'annual'
              check (type in ('annual','sick','special','unpaid')),
  title       text not null check (char_length(title) between 1 and 80),
  start_date  date not null,
  end_date    date not null,
  half_day    boolean not null default false,
  note        text check (note is null or char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint leaves_dates_ok   check (end_date >= start_date),
  constraint leaves_span_ok    check (end_date - start_date <= 366),
  constraint leaves_half_day_ok check (not half_day or start_date = end_date)
);
create index leaves_person_start on public.leaves (person_id, start_date);

-- Extra days off: local holidays (e.g. 26/10 Αγίου Δημητρίου), company days…
create table public.extra_holidays (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid references public.people(id) on delete cascade, -- null = both
  date       date not null,
  name       text not null check (char_length(name) between 1 and 60),
  yearly     boolean not null default false,  -- repeat every year on the same day/month
  created_at timestamptz not null default now()
);

-- keep updated_at fresh
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger leaves_touch before update on public.leaves
  for each row execute function public.touch_updated_at();

-- ── Security ────────────────────────────────────────────────
-- Only e-mails listed in people can see or change anything.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.people
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_member() from public;
grant execute on function public.is_member() to authenticated;

alter table public.people         enable row level security;
alter table public.allowances     enable row level security;
alter table public.leaves         enable row level security;
alter table public.extra_holidays enable row level security;

revoke all on public.people, public.allowances, public.leaves, public.extra_holidays from anon;
revoke all on public.people from authenticated;
grant select on public.people to authenticated;
-- members may edit these columns only (not e-mail → can't lock anyone out)
grant update (name, color, work_days, skip_holidays) on public.people to authenticated;
grant select, insert, update, delete on public.allowances, public.leaves, public.extra_holidays to authenticated;

create policy people_read   on public.people for select to authenticated using (public.is_member());
create policy people_update on public.people for update to authenticated
  using (public.is_member()) with check (public.is_member());

create policy allowances_all on public.allowances for all to authenticated
  using (public.is_member()) with check (public.is_member());
create policy leaves_all on public.leaves for all to authenticated
  using (public.is_member()) with check (public.is_member());
create policy extras_all on public.extra_holidays for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- Tiny public function for the daily keep-alive (returns no data).
create or replace function public.ping() returns boolean
language sql stable as $$ select true $$;
grant execute on function public.ping() to anon;

-- Live sync between your two phones
alter publication supabase_realtime add table public.people, public.allowances, public.leaves, public.extra_holidays;

-- ── YOUR DATA — edit the e-mails/names, then run ─────────────
insert into public.people (email, name, color, sort) values
  ('giannisdelikostas@gmail.com', 'Γιάννης', '#0f766e', 0),
  ('anastasiadiam@gmail.com',  'Αναστασία',  '#d9573b', 1);

-- Thessaloniki's local holiday for both of you (delete if not needed)
insert into public.extra_holidays (person_id, date, name, yearly)
values (null, '2026-10-26', 'Αγίου Δημητρίου', true);
