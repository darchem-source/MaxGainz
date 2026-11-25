-- Max Gainz Phase 4 — training-day reminders (server-sent Web Push).
-- Run once in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Idempotent: safe to run again (re-creates the same tables, functions, grants).
--
-- What is stored
--   push_prefs          one row per account: reminder hour, weekdays (bitmask,
--                       Mon = 1 … Sun = 64), a label per weekday from a fixed list,
--                       the IANA time zone, and the local date of the last send.
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
--   • Signed-in users: push_set_prefs / push_subscribe / push_get_prefs /
--     push_unsubscribe / push_unsubscribe_all / push_test_targets act on their
--     own rows only (auth.uid()).
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
create or replace function public.push_endpoint_ok(e text)
returns boolean language sql immutable as $$
  select e is not null
     and char_length(e) <= 1024
     and e ~ '^https://[^/?#]+/'
     and substring(e from '^https://([^/?#:]+)') ~ '^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$'
$$;

create table if not exists public.push_prefs (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  id           uuid not null unique default gen_random_uuid(),   -- what the scheduler sees instead of user_id
  hour         smallint not null check (hour between 0 and 23),
  days         smallint not null check (days between 0 and 127),
  labels       text[] not null check (array_length(labels, 1) = 7
                 and labels <@ array['upper','lower','full','push','pull','legs','hiit','cardio','train']),
  tz           text not null check (char_length(tz) between 1 and 64),
  last_sent_on date,
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
  last_ok_at  timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

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
alter table public.push_sends_daily enable row level security;
alter table public.push_cron enable row level security;
revoke all on table public.push_prefs, public.push_subscriptions, public.push_sends_daily, public.push_cron from anon, authenticated;
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

-- ── Signed-in user ─────────────────────────────────────────────────────────
create or replace function public.push_set_prefs(p_hour int, p_days int, p_labels text[], p_tz text)
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
  if p_days is null or p_days < 0 or p_days > 127 then return jsonb_build_object('ok', false, 'reason', 'days'); end if;
  if p_labels is null or array_length(p_labels, 1) is distinct from 7
     or not (p_labels <@ array['upper','lower','full','push','pull','legs','hiit','cardio','train']) then
    return jsonb_build_object('ok', false, 'reason', 'labels');
  end if;
  if p_tz is null or char_length(p_tz) > 64 or not exists (select 1 from pg_timezone_names where name = p_tz) then
    return jsonb_build_object('ok', false, 'reason', 'tz');
  end if;
  insert into push_prefs(user_id, hour, days, labels, tz, updated_at)
    values (uid, p_hour, p_days, p_labels, p_tz, now())
  on conflict (user_id) do update set
    hour = excluded.hour, days = excluded.days, labels = excluded.labels, tz = excluded.tz, updated_at = now();
  return jsonb_build_object('ok', true);
end
$$;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_origin text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
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
  if not exists (select 1 from push_prefs where user_id = uid) then return jsonb_build_object('ok', false, 'reason', 'prefs'); end if;
  perform pg_advisory_xact_lock(hashtext('push_subscribe:' || uid::text));
  -- An endpoint identifies one browser on one device. If another account left
  -- it behind (no sign-out cleanup ran), this device now belongs to the caller.
  delete from push_subscriptions where endpoint = p_endpoint;
  insert into push_subscriptions(user_id, endpoint, p256dh, auth, origin)
    values (uid, p_endpoint, p_p256dh, p_auth, p_origin);
  -- At most 5 devices per account: drop the oldest.
  delete from push_subscriptions where id in (
    select id from push_subscriptions where user_id = uid order by created_at desc offset 5);
  return jsonb_build_object('ok', true, 'devices', (select count(*) from push_subscriptions where user_id = uid));
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
  select hour, days, tz into r from push_prefs where user_id = uid;
  return jsonb_build_object('ok', true,
    'prefs', case when r is null then null else jsonb_build_object('hour', r.hour, 'days', r.days, 'tz', r.tz) end,
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
  -- No device left: the schedule itself goes too.
  if not exists (select 1 from push_subscriptions where user_id = uid) then
    delete from push_prefs where user_id = uid;
  end if;
  return jsonb_build_object('ok', true, 'deleted', n);
end
$$;

create or replace function public.push_unsubscribe_all()
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
  return jsonb_build_object('ok', true, 'deleted', n);
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
-- Every account with at least one device on this origin, with what the
-- scheduler needs to decide "due now" in the account's own time zone. The most
-- recent session time lets it skip days the user already trained.
create or replace function public.push_candidates(p_key text, p_origin text)
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
      'last_sent_on', p.last_sent_on,
      'last_session_at', (select max(push_ts(s.date::text)) from (
          select date from sessions where user_id = p.user_id::text order by id desc limit 20) s)))
    from push_prefs p
    where p.days > 0
      and exists (select 1 from push_subscriptions u where u.user_id = p.user_id and u.origin = p_origin)
  ), '[]'::jsonb));
end
$$;

-- Atomically claim "one reminder for this account on this local date". A claim
-- only succeeds if nothing was sent for that date yet, so overlapping or
-- repeated runs can never send twice. Returns the devices to send to.
create or replace function public.push_claim(p_key text, p_origin text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  it jsonb;
  pid uuid;
  d date;
  claimed uuid[] := '{}';
begin
  if not push_cron_ok(p_key) then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
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
    update push_prefs set last_sent_on = d
      where id = pid and (last_sent_on is null or last_sent_on < d);
    if found then claimed := claimed || pid; end if;
  end loop;
  return jsonb_build_object('ok', true, 'subs', coalesce((
    select jsonb_agg(jsonb_build_object('pid', p.id, 'sid', u.id, 'endpoint', u.endpoint, 'p256dh', u.p256dh, 'auth', u.auth))
      from push_prefs p join push_subscriptions u on u.user_id = p.user_id
     where p.id = any(claimed) and u.origin = p_origin), '[]'::jsonb));
end
$$;

-- Undo a claim when every device failed temporarily, so the next hourly run
-- (still inside the 3-hour window) tries again.
create or replace function public.push_release(p_key text, p_items jsonb)
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
      update push_prefs set last_sent_on = null where id = (it->>'pid')::uuid and last_sent_on = (it->>'date')::date;
    exception when others then
      continue;
    end;
  end loop;
  return jsonb_build_object('ok', true);
end
$$;

-- Results of a run: endpoints the push service says are gone are deleted (and
-- an account left with no device loses its schedule); delivered ones are
-- stamped; the day's counts are added up (no user ids).
create or replace function public.push_report(p_key text, p_ok uuid[], p_gone uuid[], p_sent int, p_skipped int, p_failed int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n_gone int := 0;
  today date := (now() at time zone 'utc')::date;
begin
  if not push_cron_ok(p_key) then return jsonb_build_object('ok', false, 'reason', 'key'); end if;
  if coalesce(array_length(p_gone, 1), 0) > 0 then
    delete from push_subscriptions where id = any(p_gone);
    get diagnostics n_gone = row_count;
    delete from push_prefs p where not exists (select 1 from push_subscriptions u where u.user_id = p.user_id);
  end if;
  if coalesce(array_length(p_ok, 1), 0) > 0 then
    update push_subscriptions set last_ok_at = now() where id = any(p_ok);
  end if;
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

-- ── Grants ─────────────────────────────────────────────────────────────────
revoke all on function public.push_endpoint_ok(text) from public, anon, authenticated;
revoke all on function public.push_cron_ok(text) from public, anon, authenticated;
revoke all on function public.push_ts(text) from public, anon, authenticated;
revoke all on function public.push_set_prefs(int, int, text[], text) from public, anon;
grant execute on function public.push_set_prefs(int, int, text[], text) to authenticated;
revoke all on function public.push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text) to authenticated;
revoke all on function public.push_get_prefs(text) from public, anon;
grant execute on function public.push_get_prefs(text) to authenticated;
revoke all on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated;
revoke all on function public.push_unsubscribe_all() from public, anon;
grant execute on function public.push_unsubscribe_all() to authenticated;
revoke all on function public.push_test_targets() from public, anon;
grant execute on function public.push_test_targets() to authenticated;
revoke all on function public.push_candidates(text, text) from public;
grant execute on function public.push_candidates(text, text) to anon;
revoke all on function public.push_claim(text, text, jsonb) from public;
grant execute on function public.push_claim(text, text, jsonb) to anon;
revoke all on function public.push_release(text, jsonb) from public;
grant execute on function public.push_release(text, jsonb) to anon;
revoke all on function public.push_report(text, uuid[], uuid[], int, int, int) from public;
grant execute on function public.push_report(text, uuid[], uuid[], int, int, int) to anon;

notify pgrst, 'reload schema';

-- Check after running (expect 4 tables with RLS on and no policies, 13 functions):
-- select relname, relrowsecurity from pg_class where relname like 'push\_%' and relkind = 'r';
-- select proname, prosecdef from pg_proc where proname like 'push\_%' order by 1;
-- Read-only check of the sessions date column the scheduler reads:
-- select data_type from information_schema.columns where table_schema = 'public' and table_name = 'sessions' and column_name in ('date', 'id', 'user_id');
