-- Max Gainz Phase 4 — training-day reminders (server-sent Web Push).
-- Run once in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Idempotent: safe to run again (re-creates the same tables, functions, grants).
--
-- What is stored
--   push_prefs          one row per account: reminder hour, weekdays (bitmask,
--                       Mon = 1 … Sun = 64), whether the days follow the Path, a
--                       label per weekday from a fixed list, the IANA time zone.
--   push_sent           which local dates an account was already reminded on
--                       (per scope: 'prod', or a Deploy Preview's origin). Written
--                       BEFORE sending (at most once: a run that dies mid-way can
--                       lose a reminder, never send it twice). Kept 3 days, so
--                       turning reminders off and on can't send twice either.
--   push_subscriptions  one row per opted-in device: the browser's push endpoint
--                       and its two public encryption keys, plus the site origin.
--   push_sends_daily    operations counts per UTC day (sent / skipped because the
--                       user already trained / endpoint gone / failed). No user ids.
--   push_cron           SHA-256 of the scheduler's secret key (one row).
--
-- Security model
--   • RLS on, all table privileges revoked from anon and authenticated, no
--     policies: nobody reads or writes these tables through the API. Only the
--     SECURITY DEFINER functions below touch them.
--   • Signed-in users: push_subscribe / push_set_prefs / push_get_prefs /
--     push_unsubscribe / push_unsubscribe_all / push_test_targets act on their
--     own rows only (auth.uid()). push_forget_endpoint removes one subscription
--     by its endpoint — the endpoint is an unguessable URL only that browser holds
--     (used when a sign-out couldn't reach the server).
--   • The scheduler (Netlify function, anon key + PUSH_CRON_KEY) can only:
--     list due-candidates (push_candidates), claim a send for a local date
--     (push_claim), release a claim after a failed send (push_release), and
--     report results (push_report). It never sees user ids, names or emails,
--     and it has no service-role key.
--   • Endpoints must be https on a known browser push service (push_endpoint_ok,
--     identical to PUSH_HOST_RE in index.html — gate 23 compares them), so the
--     scheduler can't be pointed at arbitrary URLs.
--   • Deleting the auth user cascades; account deletion in the app calls
--     push_unsubscribe_all() and refuses to report success if it fails.
--
-- After running: set the scheduler key (once). Generate a long random key, put it
-- in Netlify as PUSH_CRON_KEY, and store only its hash here:
--   insert into public.push_cron(id, key_hash) values (1, extensions.digest('<the key>', 'sha256'))
--   on conflict (id) do update set key_hash = excluded.key_hash;

create extension if not exists pgcrypto with schema extensions;

-- Known browser push services (Chrome/Edge-on-Android/Samsung/Opera via FCM,
-- Firefox, Safari/iOS, Edge on Windows). PUSH_HOST_RE in index.html must match.
-- PUSH_HOST_RE ^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$
-- PUSH_URL_RE ^https://([^/?#:@]+)(:[0-9]{1,5})?/
create or replace function public.push_endpoint_ok(e text)
returns boolean language sql immutable as $$
  select e is not null
     and char_length(e) <= 1024
     and e ~ '^https://([^/?#:@]+)(:[0-9]{1,5})?/'
     and substring(e from '^https://([^/?#:@]+)') ~ '^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$'
$$;

create or replace function public.push_labels_ok(l text[])
returns boolean language sql immutable as $$
  select l is not null and array_length(l, 1) = 7
     and l <@ array['upper','lower','full','push','pull','legs','hiit','cardio','train']
$$;

create table if not exists public.push_prefs (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  id           uuid not null unique default gen_random_uuid(),   -- what the scheduler sees instead of user_id
  hour         smallint not null check (hour between 0 and 23),
  days         smallint not null,
  follow_path  boolean not null default true,
  labels       text[] not null check (public.push_labels_ok(labels)),
  tz           text not null check (char_length(tz) between 1 and 64),
  tests_on     date,
  tests_n      smallint not null default 0,
  updated_at   timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique check (public.push_endpoint_ok(endpoint)),
  p256dh      text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}={0,2}$'),
  auth        text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}={0,2}$'),
  origin      text not null check (origin ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' and char_length(origin) <= 200),
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  fail_n      smallint not null default 0
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

-- One reminder per account per local date per scope, recorded when claimed.
create table if not exists public.push_sent (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope   text not null check (char_length(scope) between 1 and 200),
  day     date not null,
  at      timestamptz not null default now(),
  primary key (user_id, scope, day)
);

-- Re-runs over an earlier draft of these tables (never shipped): bring them in line.
alter table public.push_prefs add column if not exists follow_path boolean not null default true;
alter table public.push_prefs drop column if exists last_sent_on;
alter table public.push_subscriptions add column if not exists fail_n smallint not null default 0;
alter table public.push_sent drop column if exists state;
alter table public.push_prefs drop constraint if exists push_prefs_days_check;
alter table public.push_prefs add constraint push_prefs_days_check check (days between 1 and 127);

create table if not exists public.push_sends_daily (
  day             date primary key,
  sent            int not null default 0,
  skipped_trained int not null default 0,
  gone            int not null default 0,
  failed          int not null default 0
);

create table if not exists public.push_cron (
  id       int primary key check (id = 1),
  key_hash bytea not null
);

alter table public.push_prefs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_sent enable row level security;
alter table public.push_sends_daily enable row level security;
alter table public.push_cron enable row level security;
revoke all on table public.push_prefs, public.push_subscriptions, public.push_sent, public.push_sends_daily, public.push_cron from anon, authenticated;
-- No policies: invisible to clients; only the functions below read or write.

-- ── Helpers ────────────────────────────────────────────────────────────────
create or replace function public.push_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select p_key is not null and char_length(p_key) >= 32
     and exists (select 1 from push_cron where id = 1 and key_hash = digest(p_key, 'sha256'))
$$;

-- A session's date as a timestamp, or null if it isn't one (never errors).
create or replace function public.push_ts(v text)
returns timestamptz
language plpgsql
stable
as $$
begin
  return v::timestamptz;
exception when others then
  return null;
end
$$;

-- Remove an account's schedule once it has no device left.
create or replace function public.push_drop_orphan_prefs(p_users uuid[])
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from push_prefs p where p.user_id = any(p_users)
    and not exists (select 1 from push_subscriptions u where u.user_id = p.user_id)
$$;

-- ── Signed-in user ─────────────────────────────────────────────────────────
-- Register this device AND the account's schedule in one step (so a schedule
-- never exists without a device, and a device never without a schedule).
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_origin text,
                                                 p_hour int, p_days int, p_follow_path boolean, p_labels text[], p_tz text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  prev uuid;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if not push_endpoint_ok(p_endpoint) then return jsonb_build_object('ok', false, 'reason', 'endpoint'); end if;
  if p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{80,100}={0,2}$'
     or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{16,32}={0,2}$' then
    return jsonb_build_object('ok', false, 'reason', 'keys');
  end if;
  if p_origin is null or char_length(p_origin) > 200 or p_origin !~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' then
    return jsonb_build_object('ok', false, 'reason', 'origin');
  end if;
  if p_hour is null or p_hour < 0 or p_hour > 23 then return jsonb_build_object('ok', false, 'reason', 'hour'); end if;
  if p_days is null or p_days < 1 or p_days > 127 then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
  if not push_labels_ok(p_labels) then return jsonb_build_object('ok', false, 'reason', 'labels'); end if;
  if p_tz is null or char_length(p_tz) > 64 or not exists (select 1 from pg_timezone_names where name = p_tz) then
    return jsonb_build_object('ok', false, 'reason', 'tz');
  end if;
  perform pg_advisory_xact_lock(hashtext('push_subscribe:' || uid::text));
  insert into push_prefs(user_id, hour, days, follow_path, labels, tz, updated_at)
    values (uid, p_hour, p_days, coalesce(p_follow_path, false), p_labels, p_tz, now())
  on conflict (user_id) do update set
    hour = excluded.hour, days = excluded.days, follow_path = excluded.follow_path,
    labels = excluded.labels, tz = excluded.tz, updated_at = now();
  -- An endpoint identifies one browser on one device. If another account left
  -- it behind (its sign-out never reached us), this device now belongs to the caller.
  delete from push_subscriptions where endpoint = p_endpoint returning user_id into prev;
  if prev is not null and prev <> uid then perform push_drop_orphan_prefs(array[prev]); end if;
  insert into push_subscriptions(user_id, endpoint, p256dh, auth, origin)
    values (uid, p_endpoint, p_p256dh, p_auth, p_origin);
  -- At most 5 devices per account: drop the oldest.
  delete from push_subscriptions where id in (
    select id from push_subscriptions where user_id = uid order by created_at desc offset 5);
  return jsonb_build_object('ok', true, 'devices', (select count(*) from push_subscriptions where user_id = uid));
end
$$;

-- Update the schedule of an account that already has reminders on (never creates one).
create or replace function public.push_set_prefs(p_hour int, p_days int, p_follow_path boolean, p_labels text[], p_tz text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if p_hour is null or p_hour < 0 or p_hour > 23 then return jsonb_build_object('ok', false, 'reason', 'hour'); end if;
  if p_days is null or p_days < 1 or p_days > 127 then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
  if not push_labels_ok(p_labels) then return jsonb_build_object('ok', false, 'reason', 'labels'); end if;
  if p_tz is null or char_length(p_tz) > 64 or not exists (select 1 from pg_timezone_names where name = p_tz) then
    return jsonb_build_object('ok', false, 'reason', 'tz');
  end if;
  update push_prefs set hour = p_hour, days = p_days, follow_path = coalesce(p_follow_path, false),
         labels = p_labels, tz = p_tz, updated_at = now()
   where user_id = uid;
  if not found then return jsonb_build_object('ok', false, 'reason', 'none'); end if;
  return jsonb_build_object('ok', true);
end
$$;

create or replace function public.push_get_prefs(p_endpoint text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  r record;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  select hour, days, follow_path, labels, tz into r from push_prefs where user_id = uid;
  return jsonb_build_object('ok', true,
    'prefs', case when r is null then null else jsonb_build_object('hour', r.hour, 'days', r.days, 'follow_path', r.follow_path, 'labels', to_jsonb(r.labels), 'tz', r.tz) end,
    'this_device', exists (select 1 from push_subscriptions where user_id = uid and endpoint = p_endpoint),
    'devices', (select count(*) from push_subscriptions where user_id = uid));
end
$$;

create or replace function public.push_unsubscribe(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  delete from push_subscriptions where user_id = uid and endpoint = p_endpoint;
  get diagnostics n = row_count;
  perform push_drop_orphan_prefs(array[uid]);   -- no device left: the schedule goes too
  return jsonb_build_object('ok', true, 'deleted', n);
end
$$;

-- "Turn off on all my devices" (p_forget false) and account deletion (p_forget
-- true, which also removes the record of which days were reminded).
create or replace function public.push_unsubscribe_all(p_forget boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  delete from push_subscriptions where user_id = uid;
  get diagnostics n = row_count;
  delete from push_prefs where user_id = uid;
  if coalesce(p_forget, false) then delete from push_sent where user_id = uid; end if;
  return jsonb_build_object('ok', true, 'deleted', n);
end
$$;

-- A sign-out that couldn't reach the server: the next signed-in session on the
-- same device removes the old subscription by its endpoint.
create or replace function public.push_forget_endpoint(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  prev uuid;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if not push_endpoint_ok(p_endpoint) then return jsonb_build_object('ok', true, 'deleted', 0); end if;
  delete from push_subscriptions where endpoint = p_endpoint returning user_id into prev;
  if prev is not null then perform push_drop_orphan_prefs(array[prev]); end if;
  return jsonb_build_object('ok', true, 'deleted', case when prev is null then 0 else 1 end);
end
$$;

-- For the "Send a test notification" button (called by /api/push/test with the
-- user's own token). At most 5 tests per account per UTC day.
create or replace function public.push_test_targets()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
  n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  update push_prefs set tests_n = case when tests_on = today then tests_n + 1 else 1 end, tests_on = today
    where user_id = uid returning tests_n into n;
  if n is null then return jsonb_build_object('ok', false, 'reason', 'none'); end if;
  if n > 5 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  return jsonb_build_object('ok', true, 'subs', coalesce((
    select jsonb_agg(jsonb_build_object('sid', id, 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
      from push_subscriptions where user_id = uid), '[]'::jsonb));
end
$$;

-- ── Scheduler (anon key + PUSH_CRON_KEY) ────────────────────────────────────
-- Every account with a device on one of these origins, with what the scheduler
-- needs to decide "due now" in the account's own time zone: the last date this
-- scope already reminded it on, and its most recent session time (to skip days
-- the user already trained). Never user ids.
create or replace function public.push_candidates(p_key text, p_scope text, p_origins text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not push_cron_ok(p_key) then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
  return jsonb_build_object('ok', true, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'pid', p.id, 'hour', p.hour, 'days', p.days, 'labels', to_jsonb(p.labels), 'tz', p.tz,
      'last_sent_on', (select max(x.day) from push_sent x where x.user_id = p.user_id and x.scope = p_scope),
      'last_session_at', (select max(t.ts) from (
          select push_ts(s.date::text) as ts from sessions s where s.user_id = p.user_id::text) t
          where t.ts < now() + interval '1 day')))
    from push_prefs p
    where p.days > 0
      and exists (select 1 from push_subscriptions u where u.user_id = p.user_id and u.origin = any(p_origins))
  ), '[]'::jsonb));
end
$$;

-- Atomically claim "one reminder for this account on this local date in this
-- scope". Succeeds only once per date, so overlapping, repeated or crashed runs
-- never send twice. Returns the devices on these origins to send to.
create or replace function public.push_claim(p_key text, p_scope text, p_origins text[], p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  it jsonb;
  pid uuid;
  d date;
  uid uuid;
  claimed uuid[] := '{}';
begin
  if not push_cron_ok(p_key) then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
  if p_scope is null or char_length(p_scope) < 1 or char_length(p_scope) > 200 then return jsonb_build_object('ok', false, 'reason', 'scope'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then return jsonb_build_object('ok', false, 'reason', 'items'); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    begin
      pid := (it->>'pid')::uuid;
      d := (it->>'date')::date;
    exception when others then
      continue;
    end;
    -- A local date is always within a day of UTC.
    if d < (now() at time zone 'utc')::date - 1 or d > (now() at time zone 'utc')::date + 1 then continue; end if;
    select user_id into uid from push_prefs where id = pid;
    if uid is null then continue; end if;
    insert into push_sent(user_id, scope, day) values (uid, p_scope, d)
    on conflict (user_id, scope, day) do nothing;
    if found then claimed := claimed || pid; end if;
  end loop;
  return jsonb_build_object('ok', true, 'subs', coalesce((
    select jsonb_agg(jsonb_build_object('pid', p.id, 'sid', u.id, 'endpoint', u.endpoint, 'p256dh', u.p256dh, 'auth', u.auth))
      from push_prefs p join push_subscriptions u on u.user_id = p.user_id
     where p.id = any(claimed) and u.origin = any(p_origins)), '[]'::jsonb));
end
$$;

-- Undo a claim when no device was reached (temporary failure, or the run ran out
-- of time before sending), so the next hourly run (inside the 3-hour window) tries again.
create or replace function public.push_release(p_key text, p_scope text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  it jsonb;
begin
  if not push_cron_ok(p_key) then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then return jsonb_build_object('ok', false, 'reason', 'items'); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    begin
      delete from push_sent x using push_prefs p
       where p.id = (it->>'pid')::uuid and x.user_id = p.user_id and x.scope = p_scope
         and x.day = (it->>'date')::date;
    exception when others then
      continue;
    end;
  end loop;
  return jsonb_build_object('ok', true);
end
$$;

-- Results of a run: endpoints the push service says are gone are deleted; a device rejected 7 runs in a row
-- (e.g. after a key change) is deleted; an account left with no device loses
-- its schedule; the day's counts are added up (no user ids).
create or replace function public.push_report(p_key text,
                                              p_ok uuid[], p_gone uuid[], p_fail uuid[],
                                              p_sent int, p_skipped int, p_failed int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n_gone int := 0;
  touched uuid[];
  today date := (now() at time zone 'utc')::date;
begin
  if not push_cron_ok(p_key) then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
  if coalesce(array_length(p_ok, 1), 0) > 0 then
    update push_subscriptions set last_ok_at = now(), fail_n = 0 where id = any(p_ok);
  end if;
  if coalesce(array_length(p_fail, 1), 0) > 0 then
    update push_subscriptions set fail_n = least(fail_n + 1, 100) where id = any(p_fail);
  end if;
  select array_agg(distinct user_id) into touched from push_subscriptions
   where id = any(coalesce(p_gone, '{}')) or (id = any(coalesce(p_fail, '{}')) and fail_n >= 7);
  delete from push_subscriptions where id = any(coalesce(p_gone, '{}')) or (id = any(coalesce(p_fail, '{}')) and fail_n >= 7);
  get diagnostics n_gone = row_count;
  if touched is not null then perform push_drop_orphan_prefs(touched); end if;
  delete from push_sent where day < today - 3;
  insert into push_sends_daily(day, sent, skipped_trained, gone, failed)
    values (today, greatest(coalesce(p_sent, 0), 0), greatest(coalesce(p_skipped, 0), 0), n_gone, greatest(coalesce(p_failed, 0), 0))
  on conflict (day) do update set
    sent = push_sends_daily.sent + excluded.sent,
    skipped_trained = push_sends_daily.skipped_trained + excluded.skipped_trained,
    gone = push_sends_daily.gone + excluded.gone,
    failed = push_sends_daily.failed + excluded.failed;
  delete from push_sends_daily where day < today - 120;
  return jsonb_build_object('ok', true, 'gone', n_gone);
end
$$;

-- ── Older versions of these functions (earlier drafts) ──────────────────────
drop function if exists public.push_set_prefs(int, int, text[], text);
drop function if exists public.push_subscribe(text, text, text, text);
drop function if exists public.push_unsubscribe_all();
drop function if exists public.push_candidates(text, text);
drop function if exists public.push_claim(text, text, jsonb);
drop function if exists public.push_release(text, jsonb);
drop function if exists public.push_report(text, uuid[], uuid[], int, int, int);
drop function if exists public.push_report(text, text, jsonb, uuid[], uuid[], uuid[], int, int, int);

-- ── Grants ─────────────────────────────────────────────────────────────────
revoke all on function public.push_endpoint_ok(text) from public, anon, authenticated;
revoke all on function public.push_labels_ok(text[]) from public, anon, authenticated;
revoke all on function public.push_cron_ok(text) from public, anon, authenticated;
revoke all on function public.push_ts(text) from public, anon, authenticated;
revoke all on function public.push_drop_orphan_prefs(uuid[]) from public, anon, authenticated;
revoke all on function public.push_subscribe(text, text, text, text, int, int, boolean, text[], text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text, int, int, boolean, text[], text) to authenticated;
revoke all on function public.push_set_prefs(int, int, boolean, text[], text) from public, anon;
grant execute on function public.push_set_prefs(int, int, boolean, text[], text) to authenticated;
revoke all on function public.push_get_prefs(text) from public, anon;
grant execute on function public.push_get_prefs(text) to authenticated;
revoke all on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated;
revoke all on function public.push_unsubscribe_all(boolean) from public, anon;
grant execute on function public.push_unsubscribe_all(boolean) to authenticated;
revoke all on function public.push_forget_endpoint(text) from public, anon;
grant execute on function public.push_forget_endpoint(text) to authenticated;
revoke all on function public.push_test_targets() from public, anon;
grant execute on function public.push_test_targets() to authenticated;
revoke all on function public.push_candidates(text, text, text[]) from public, authenticated;
grant execute on function public.push_candidates(text, text, text[]) to anon;
revoke all on function public.push_claim(text, text, text[], jsonb) from public, authenticated;
grant execute on function public.push_claim(text, text, text[], jsonb) to anon;
revoke all on function public.push_release(text, text, jsonb) from public, authenticated;
grant execute on function public.push_release(text, text, jsonb) to anon;
revoke all on function public.push_report(text, uuid[], uuid[], uuid[], int, int, int) from public, authenticated;
grant execute on function public.push_report(text, uuid[], uuid[], uuid[], int, int, int) to anon;

notify pgrst, 'reload schema';

-- Check after running (expect 5 tables with RLS on, and every push_ function listed):
-- select relname, relrowsecurity from pg_class where relname like 'push\_%' and relkind = 'r';
-- select proname, prosecdef from pg_proc where proname like 'push\_%' order by 1;
