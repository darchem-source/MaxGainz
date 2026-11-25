-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — feedback limits (Priority 5)
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER rls_owner_only.sql. Idempotent: safe to run again.
--
-- What it does (the insert-only RLS policy from rls_owner_only.sql stays):
--   1. request_id: the app sends one per submission and reuses it for retries.
--      A retry of something already stored is dropped silently (the app shows
--      the receipt), and a unique index catches two retries racing.
--   2. Bounds on every new row: message 10–4000 characters, screenshot only
--      as a JPEG/PNG/WebP data URL of at most 700 KB (the app sends ≤ 600 KB),
--      short file name / email / category / location. Existing rows are not
--      re-checked (NOT VALID), so old 5 MB screenshots don't block this.
--   3. Rate limits, enforced by a trigger nobody can call directly:
--        per account (signed in) or per hashed IP (anonymous):
--          5 per 10 minutes, 30 per day
--        all anonymous feedback together: 300 per day
--      Only an md5 of the IP is kept, in feedback_rate, for one day. If the
--      gateway sends no IP header, anonymous senders share one bucket.
--
-- Before this runs the app still works: it retries without request_id.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.feedback add column if not exists request_id uuid;
create unique index if not exists feedback_request_id_key
  on public.feedback (request_id) where request_id is not null;

alter table public.feedback drop constraint if exists mg_feedback_bounds;
alter table public.feedback add constraint mg_feedback_bounds check (
      char_length(message) between 10 and 4000
  and (image_data is null or (
        octet_length(image_data) <= 716800
    and image_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'))
  and (image_filename is null or char_length(image_filename) <= 120)
  and (user_email is null or char_length(user_email) <= 320)
  and char_length(coalesce(category::text, '')) <= 40
  and char_length(coalesce(location::text, '')) <= 40
) not valid;

-- Rate-limit ledger: no policies, no grants → unreachable through the API.
create table if not exists public.feedback_rate (
  key text not null,
  at  timestamptz not null default now()
);
create index if not exists feedback_rate_key_at on public.feedback_rate (key, at);
alter table public.feedback_rate enable row level security;
revoke all on public.feedback_rate from anon, authenticated;

create or replace function public.mg_feedback_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $mg$
declare
  k   text;
  n   int;
  hdr json;
  ip  text;
begin
  -- 1. A retry of a submission that is already stored: keep one copy.
  if new.request_id is not null
     and exists (select 1 from public.feedback f where f.request_id = new.request_id) then
    return null;
  end if;

  -- 2. Who is sending: the account, else a hash of the client IP.
  if auth.uid() is not null then
    k := 'u:' || auth.uid()::text;
  else
    begin
      hdr := current_setting('request.headers', true)::json;
    exception when others then
      hdr := null;
    end;
    ip := btrim(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'x-real-ip', ''), ',', 1));
    k := 'a:' || md5(ip || ':mg-feedback');
  end if;

  delete from public.feedback_rate where at < now() - interval '1 day';

  select count(*) into n from public.feedback_rate where key = k and at > now() - interval '10 minutes';
  if n >= 5 then raise exception 'mg_rate_limited' using errcode = 'P0001'; end if;

  select count(*) into n from public.feedback_rate where key = k and at > now() - interval '1 day';
  if n >= 30 then raise exception 'mg_rate_limited' using errcode = 'P0001'; end if;

  if auth.uid() is null then
    select count(*) into n from public.feedback_rate where key like 'a:%' and at > now() - interval '1 day';
    if n >= 300 then raise exception 'mg_rate_limited' using errcode = 'P0001'; end if;
  end if;

  insert into public.feedback_rate (key) values (k);
  return new;
end
$mg$;

revoke all on function public.mg_feedback_guard() from public, anon, authenticated;

drop trigger if exists mg_feedback_guard on public.feedback;
create trigger mg_feedback_guard
  before insert on public.feedback
  for each row execute function public.mg_feedback_guard();

-- ── Result grid ──────────────────────────────────────────────────────────────
-- Expect: every row "ok".
select 'request_id column' as "check",
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'feedback' and column_name = 'request_id')
            then 'ok' else 'MISSING' end as status
union all
select 'bounds constraint',
       case when exists (select 1 from pg_constraint where conname = 'mg_feedback_bounds') then 'ok' else 'MISSING' end
union all
select 'guard trigger',
       case when exists (select 1 from pg_trigger where tgname = 'mg_feedback_guard' and not tgisinternal) then 'ok' else 'MISSING' end
union all
select 'rate ledger closed to the API',
       case when (select relrowsecurity from pg_class where oid = 'public.feedback_rate'::regclass)
             and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'feedback_rate')
            then 'ok' else 'OPEN' end
union all
select 'feedback still insert-only',
       case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'feedback') = 1
             and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'feedback' and cmd = 'INSERT')
            then 'ok' else 'CHECK POLICIES' end;
