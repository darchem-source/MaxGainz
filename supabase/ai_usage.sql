-- Max Gainz Phase 2 — AI usage limits (run once in the Supabase SQL editor).
--
-- The Netlify function /api/ai calls ai_reserve() WITH THE USER'S OWN JWT
-- before every model call. The function books a worst-case cost per call and
-- refuses when the user's daily call limit or the global daily budget is hit.
-- No service-role key is needed: the function is SECURITY DEFINER, clients
-- cannot write either table directly, and calling ai_reserve() yourself only
-- spends your own allowance.
--
-- Limits (change here, re-run to apply):
--   per user : 30 calls / UTC day
--   global   : 1,500,000 micro-USD (US$1.50) / UTC day
--   per call : 700 micro-USD reserved (Haiku 5.5 worst case: ≤4 KB facts
--              ≈ ≤2k input tokens @ $0.10/M + ≤1,024 output tokens @ $0.50/M)

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

create or replace function public.ai_reserve(p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  d date := (now() at time zone 'utc')::date;
  per_call bigint := 700;
  user_max_calls int := 30;
  global_max bigint := 1500000;
  u_calls int;
  g_res bigint;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if p_kind is null or p_kind not in ('coach', 'nl', 'recap') then
    return jsonb_build_object('ok', false, 'reason', 'kind');
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

revoke all on function public.ai_reserve(text) from public;
revoke all on function public.ai_reserve(text) from anon;
grant execute on function public.ai_reserve(text) to authenticated;

-- Check after running (expect: 2 tables with RLS on, function owned by postgres):
-- select relname, relrowsecurity from pg_class where relname in ('ai_usage','ai_usage_global');
-- select proname, prosecdef from pg_proc where proname = 'ai_reserve';
