-- Max Gainz Phase 2 — AI consent + usage limits (run once in the Supabase SQL editor).
--
-- Consent lives HERE, not only on the device: the app calls ai_set_consent()
-- when the user switches AI coaching (or notes) on or off, and the Netlify
-- function /api/ai calls ai_reserve() WITH THE USER'S OWN JWT before every
-- model call. ai_reserve() refuses unless consent is on (and notes consent is
-- on when a note is included), then books a worst-case cost per call and
-- refuses when the user's daily call limit or the global daily budget is hit.
-- So switching AI off on one device stops every other device at once.
-- No service-role key is needed: the function is SECURITY DEFINER, clients
-- cannot write either table directly, and calling ai_reserve() yourself only
-- spends your own allowance.
--
-- Limits (change here, re-run to apply):
--   per user : 30 calls / UTC day
--   global   : 1,500,000 micro-USD (US$1.50) / UTC day
--   per call : 1,000 micro-USD reserved (Haiku 5.5 worst case: ≤4,000-char
--              request ≈ ≤4,000 tokens + ~600 system/schema tokens @ $0.10/M
--              = 460 µ$, + ≤1,024 output tokens incl. thinking @ $0.50/M
--              = 512 µ$ → 972 µ$)

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  calls int not null default 0,
  reserved_micro_usd bigint not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
drop policy if exists ai_usage_select_own on public.ai_usage;
create policy ai_usage_select_own on public.ai_usage for select using (auth.uid() = user_id);
-- No insert/update/delete policies: only ai_reserve() writes.

create table if not exists public.ai_usage_global (
  day date primary key,
  calls int not null default 0,
  reserved_micro_usd bigint not null default 0
);
alter table public.ai_usage_global enable row level security;
-- No policies at all: invisible to clients.

create table if not exists public.ai_consent (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  notes boolean not null default false,
  version int not null default 0,
  changed_at timestamptz not null default now()
);
alter table public.ai_consent enable row level security;
drop policy if exists ai_consent_select_own on public.ai_consent;
create policy ai_consent_select_own on public.ai_consent for select using (auth.uid() = user_id);
-- No write policies: only ai_set_consent() writes.

create or replace function public.ai_set_consent(p_enabled boolean, p_notes boolean, p_version int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  insert into ai_consent(user_id, enabled, notes, version, changed_at)
    values (uid, coalesce(p_enabled, false), coalesce(p_enabled, false) and coalesce(p_notes, false), coalesce(p_version, 0), now())
  on conflict (user_id) do update set
    enabled = excluded.enabled, notes = excluded.notes, version = excluded.version, changed_at = now();
  return jsonb_build_object('ok', true);
end
$$;

drop function if exists public.ai_reserve(text);
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
revoke all on function public.ai_set_consent(boolean, boolean, int) from public;
revoke all on function public.ai_set_consent(boolean, boolean, int) from anon;
grant execute on function public.ai_set_consent(boolean, boolean, int) to authenticated;

-- Check after running (expect: 3 tables with RLS on, both functions security definer):
-- select relname, relrowsecurity from pg_class where relname in ('ai_usage','ai_usage_global','ai_consent');
-- select proname, prosecdef from pg_proc where proname in ('ai_reserve','ai_set_consent');
