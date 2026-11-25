-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — controlled AI beta cohort (Priority 6)
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Run AFTER ai_usage.sql. Idempotent: safe to run again.
--
-- What it does
--   ai_beta            → the cohort: one row per account allowed to use AI.
--                        RLS on, no policies, no grants: only you (SQL editor /
--                        Table Editor) can add or remove people.
--   ai_beta_status()   → the app asks this at sign-in; returns only
--                        {ok, member} for the CALLER. Members get the three beta
--                        surfaces switched on for their device; they still have
--                        to turn AI coaching on themselves (consent).
--   ai_reserve(...)    → re-created exactly as in ai_usage.sql plus ONE check
--                        (marked BEGIN/END ai_beta check): accounts outside the
--                        cohort get reason 'not_in_beta' and the app shows its
--                        own text. The cohort is enforced here, not in the app.
--
-- Add someone (they must have signed up first):
--   insert into public.ai_beta (user_id, note)
--     select id, 'beta wave 1' from auth.users where email = 'person@example.com'
--   on conflict (user_id) do nothing;
-- Remove someone:
--   delete from public.ai_beta where user_id = (select id from auth.users where email = 'person@example.com');
-- End the beta for everyone (AI keeps refusing; the app falls back): truncate public.ai_beta;
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ai_beta (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  note     text check (note is null or char_length(note) <= 80)
);
alter table public.ai_beta enable row level security;
revoke all on public.ai_beta from anon, authenticated;

create or replace function public.ai_beta_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  return jsonb_build_object('ok', true, 'member', exists (select 1 from ai_beta b where b.user_id = uid));
end
$$;
revoke all on function public.ai_beta_status() from public;
revoke all on function public.ai_beta_status() from anon;
grant execute on function public.ai_beta_status() to authenticated;

create or replace function public.ai_reserve(p_kind text, p_note boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  d date := (now() at time zone 'utc')::date;
  per_call bigint := 1000;
  consent_version int := 1;   -- must equal AI_CONSENT_VERSION in index.html
  user_max_calls int := 30;
  global_max bigint := 1500000;
  u_calls int;
  g_res bigint;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if p_kind is null or p_kind not in ('coach', 'nl', 'recap') then
    return jsonb_build_object('ok', false, 'reason', 'kind');
  end if;
  -- Priority 6: only the beta cohort (BEGIN ai_beta check)
  if not exists (select 1 from ai_beta b where b.user_id = uid) then
    return jsonb_build_object('ok', false, 'reason', 'not_in_beta');
  end if;
  -- (END ai_beta check)
  if not exists (select 1 from ai_consent c where c.user_id = uid and c.enabled and c.version = consent_version
                  and (not coalesce(p_note, false) or c.notes)) then
    return jsonb_build_object('ok', false, 'reason', 'consent_off');
  end if;
  insert into ai_usage_global(day) values (d) on conflict (day) do nothing;
  select reserved_micro_usd into g_res from ai_usage_global where day = d for update;
  if g_res + per_call > global_max then return jsonb_build_object('ok', false, 'reason', 'global_cap'); end if;
  insert into ai_usage(user_id, day) values (uid, d) on conflict (user_id, day) do nothing;
  select calls into u_calls from ai_usage where user_id = uid and day = d for update;
  if u_calls >= user_max_calls then return jsonb_build_object('ok', false, 'reason', 'user_cap'); end if;
  update ai_usage set calls = calls + 1, reserved_micro_usd = reserved_micro_usd + per_call
    where user_id = uid and day = d;
  update ai_usage_global set calls = calls + 1, reserved_micro_usd = reserved_micro_usd + per_call
    where day = d;
  return jsonb_build_object('ok', true, 'remaining', user_max_calls - u_calls - 1);
end
$$;

revoke all on function public.ai_reserve(text, boolean) from public;
revoke all on function public.ai_reserve(text, boolean) from anon;
grant execute on function public.ai_reserve(text, boolean) to authenticated;

-- ── Result grid ──────────────────────────────────────────────────────────────
-- Expect: every row "ok" and the number of beta members you added.
select 'ai_beta closed to the API' as "check",
       case when (select relrowsecurity from pg_class where oid = 'public.ai_beta'::regclass)
             and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_beta')
            then 'ok' else 'OPEN' end as status
union all
select 'ai_reserve checks the cohort',
       case when position('not_in_beta' in (select prosrc from pg_proc where proname = 'ai_reserve' limit 1)) > 0 then 'ok' else 'MISSING' end
union all
select 'beta members', (select count(*)::text from public.ai_beta);
