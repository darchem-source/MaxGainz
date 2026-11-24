-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — owner-only Row Level Security
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Idempotent: safe to run again at any time (it rebuilds the same policies).
-- Atomic: the work happens in one DO block, so a failure changes nothing.
--
-- What it does
--   sessions, custom_weights  → RLS on; a signed-in user can select / insert /
--                               update / delete ONLY rows where user_id is their
--                               own auth.uid(). The anon key alone sees nothing.
--   feedback                  → RLS on; insert-only (anon + signed-in), nobody
--                               can read it through the API. Read feedback in
--                               the dashboard Table Editor (bypasses RLS).
--
-- Every policy that already exists on these three tables is REMOVED first —
-- a leftover "allow all" policy would keep the data public even with RLS on.
-- Removed policies are listed in the result grid so nothing is lost silently.
--
-- user_id is text on sessions/custom_weights and uuid on feedback; the script
-- reads the real column type and casts auth.uid() to match.
-- ─────────────────────────────────────────────────────────────────────────────

create temp table if not exists _mg_rls_dropped (
  tbl text, policy text, cmd text, roles text, using_expr text, check_expr text
);
truncate _mg_rls_dropped;

do $mg$
declare
  t       text;
  coltype text;
  me      text;   -- SQL expression for "the calling user's id", cast to match user_id
  p       record;
begin
  foreach t in array array['sessions', 'custom_weights', 'feedback'] loop

    if to_regclass(format('public.%I', t)) is null then
      if t = 'feedback' then
        continue;  -- optional table
      end if;
      raise exception 'Table public.% not found — nothing was changed', t;
    end if;

    select format_type(a.atttypid, null) into coltype
      from pg_attribute a
     where a.attrelid = to_regclass(format('public.%I', t))
       and a.attname  = 'user_id'
       and not a.attisdropped;

    -- (select auth.uid()) is evaluated once per query instead of once per row
    if coltype = 'uuid' then
      me := '(select auth.uid())';
    elsif coltype in ('text', 'character varying') then
      me := '(select auth.uid())::text';
    else
      raise exception 'public.%.user_id has unexpected type "%" — nothing was changed', t, coalesce(coltype, 'missing column');
    end if;

    -- Remove every existing policy (remember the ones this script did not create)
    for p in select * from pg_policies where schemaname = 'public' and tablename = t loop
      if p.policyname not like 'mg\_%' then
        insert into _mg_rls_dropped
        values (t, p.policyname, p.cmd, array_to_string(p.roles, ', '), p.qual, p.with_check);
      end if;
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;

    execute format('alter table public.%I enable row level security', t);

    if t = 'feedback' then
      -- Insert-only. user_id must be NULL (anonymous) or the caller's own id, so
      -- feedback can't be filed under someone else's account. No select policy:
      -- the app posts with Prefer: return=minimal, which needs no read access.
      execute format(
        'create policy mg_feedback_insert on public.%I for insert to anon, authenticated
           with check (user_id is null or user_id = %s)', t, me);
    else
      execute format(
        'create policy mg_owner_select on public.%I for select to authenticated
           using (user_id = %s)', t, me);
      execute format(
        'create policy mg_owner_insert on public.%I for insert to authenticated
           with check (user_id = %s)', t, me);
      -- USING + WITH CHECK: can only touch own rows, and can't hand a row to
      -- another user. Upserts (INSERT … ON CONFLICT DO UPDATE) need the insert
      -- AND update policies, plus select on the row they collide with.
      execute format(
        'create policy mg_owner_update on public.%I for update to authenticated
           using (user_id = %s) with check (user_id = %s)', t, me, me);
      execute format(
        'create policy mg_owner_delete on public.%I for delete to authenticated
           using (user_id = %s)', t, me);
    end if;

  end loop;
end
$mg$;

-- Every policy filters on user_id; custom_weights already has its unique
-- (user_id, exercise_name) index, sessions needs one.
create index if not exists sessions_user_id_idx on public.sessions (user_id);

-- ── Result grid ──────────────────────────────────────────────────────────────
-- Expect: "RLS ON" for every table, 4 ACTIVE policies each on sessions and
-- custom_weights, 1 on feedback. Any "RLS OFF" row is a table that is still
-- readable with the public anon key.
select r."table", r.status, r.policy, r.cmd, r.roles, r.using_expr, r.check_expr
from (
  select 1 as ord, c.relname::text as "table",
         case when c.relrowsecurity then 'RLS ON' else 'RLS OFF  <-- still public!' end as status,
         null::text as policy, null::text as cmd, null::text as roles,
         null::text as using_expr, null::text as check_expr
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
  union all
  select 2, tablename::text, 'ACTIVE policy', policyname::text, cmd,
         array_to_string(roles, ', '), qual, with_check
    from pg_policies
   where schemaname = 'public'
  union all
  select 3, tbl, 'REMOVED old policy', policy, cmd, roles, using_expr, check_expr
    from _mg_rls_dropped
) r
order by r."table", r.ord, r.policy;
