-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — read-only checks to run AFTER rls_owner_only.sql
-- Supabase dashboard → SQL Editor → paste → Run. Changes nothing.
-- One result grid; every row is a check with a count or a value.
-- ─────────────────────────────────────────────────────────────────────────────

select * from (

  -- 1. Any table in public still without RLS (e.g. the unused "workouts").
  --    Fix for an unused table:  alter table public.<name> enable row level security;
  select 1 as ord, 'RLS off: ' || c.relname as check_name, null::bigint as count, null::text as value
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity

  union all
  -- 2. Views / materialized views in public: they run as their owner and bypass
  --    RLS unless created with security_invoker. Expect no rows.
  select 2, 'view bypasses RLS: ' || c.relname, null,
         case when c.reloptions::text like '%security_invoker=true%' then 'ok (security_invoker)' else 'owner rights' end
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v','m')

  union all
  -- 3. SECURITY DEFINER functions in public callable through /rest/v1/rpc. Expect none.
  select 3, 'security definer fn: ' || p.proname, null, pg_get_function_identity_arguments(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef

  union all
  -- 4. Rows whose owner is not a real account (planted while the tables were
  --    open, or left over from an older version). Expect 0.
  select 4, 'sessions rows with no matching auth user', count(*), null
    from public.sessions s
   where not exists (select 1 from auth.users u where u.id::text = s.user_id)
  union all
  select 4, 'custom_weights rows with no matching auth user', count(*), null
    from public.custom_weights w
   where not exists (select 1 from auth.users u where u.id::text = w.user_id)

  union all
  -- 5. HTML markup in text the app renders. Anyone could also write while the
  --    tables were open; the app puts some of these values into innerHTML.
  --    Expect 0. If not, inspect the rows: user_id / day / exercise_name.
  select 5, 'sessions rows containing <tag', count(*), null
    from public.sessions
   where day ~ '<[a-zA-Z/!]' or coalesce(activity_type,'') ~ '<[a-zA-Z/!]'
  union all
  select 5, 'custom_weights rows containing <tag', count(*), null
    from public.custom_weights
   where exercise_name ~ '<[a-zA-Z/!]' or coalesce(notes,'') ~ '<[a-zA-Z/!]'

  union all
  -- 6. custom_weights keys. cloudSaveWeight upserts with
  --    Prefer: resolution=merge-duplicates and NO on_conflict, so PostgREST
  --    resolves duplicates on the PRIMARY KEY. Saving a weight twice only works
  --    if the primary key is (user_id, exercise_name); otherwise the second save
  --    gets a 409 that the app silently drops.
  select 6, 'custom_weights ' || lower(con.contype::text) || ' constraint ' || con.conname, null,
         pg_get_constraintdef(con.oid)
    from pg_constraint con
   where con.conrelid = 'public.custom_weights'::regclass and con.contype in ('p','u')

  union all
  -- 7. Feedback volume and largest attachment — the one table anon can write to.
  select 7, 'feedback rows', count(*),
         pg_size_pretty(coalesce(max(octet_length(to_jsonb(f)->>'image_data')), 0)::bigint) || ' largest image'
    from public.feedback f

) r order by ord, check_name;
