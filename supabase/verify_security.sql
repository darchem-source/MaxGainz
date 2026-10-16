-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — security check (READ-ONLY: changes nothing, safe to run any time)
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--
-- How to read the result
--   • The FIRST row is the verdict: OVERALL PASS, PASS (with warnings) or FAIL,
--     and it names anything that failed.
--   • FAIL = a real hole: someone could read or change data they shouldn't,
--            or account deletion isn't installed. Fix these.
--     WARN = worth a look, not a hole by itself. Each row says why.
--     PASS = checked and fine.   INFO = listed for completeness.
--   • Columns: result · area · object (table / function) · policy · roles ·
--     cmd (which action the policy covers) · detail (plain English, with the fix).
--
-- What it checks
--   1. Every table in the public schema: is row-level security (RLS) on?
--      Every policy: who it applies to (roles), what it allows (cmd), and
--      whether it limits people to THEIR OWN rows (a user_id = auth.uid()
--      check). The public anon key ships inside the app, so anything anon
--      can reach, anyone can reach.
--   2. Views, which can quietly skip RLS.
--   3. SECURITY DEFINER functions (they run with owner rights and skip RLS):
--      who can call them, and is their search_path pinned?
--   4. Storage buckets and file policies (the app stores no files).
--   5. Account deletion: is delete_my_account() installed, does every
--      user-data table have the guard trigger, and is any table holding data
--      that deletion would miss?
--   6. Rows left behind by accounts that no longer exist.
--
-- Relationship to the other files
--   • rls_owner_only.sql is still the FIX for RLS on sessions / custom_weights /
--     feedback. This file checks the result of it, and of anything changed
--     since, across ALL tables.
--   • This file SUPERSEDES checks 1–4 of post_fix_checks.sql. Checks 5–7 there
--     (stray HTML, custom_weights keys, feedback volume) are data-hygiene
--     checks and still useful.
-- ─────────────────────────────────────────────────────────────────────────────

with
-- Every ordinary table in public. "user data" = has a user_id column.
tbls as (
  select c.oid,
         c.relname::text                         as tbl,
         c.relrowsecurity                        as rls_on,
         ua.atttypid                             as uid_type,   -- null: no user_id column
         ua.atttypid is not null                 as user_data,
         exists (select 1 from pg_constraint k
                  where k.conrelid = c.oid and k.contype = 'f'
                    and k.confrelid = 'auth.users'::regclass) as fk_to_auth,
         (   has_table_privilege('anon',          c.oid, 'SELECT, INSERT, UPDATE, DELETE')
          or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')) as api_grants,
         (select count(*) from pg_policies p
           where p.schemaname = 'public' and p.tablename = c.relname) as npol
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attribute ua on ua.attrelid = c.oid and ua.attname = 'user_id' and not ua.attisdropped
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
),

-- Every policy on those tables, with the owner check worked out.
-- "Owner check" = the expression compares user_id with auth.uid() (in either
-- order, with or without casts / "(select auth.uid())").
pol0 as (
  select p.tablename::text as tbl, p.policyname::text as policy, p.permissive, p.cmd, p.roles,
         p.qual as using_expr,
         -- the rule new or changed rows must pass (UPDATE / ALL fall back to USING)
         coalesce(p.with_check, case when p.cmd in ('UPDATE', 'ALL') then p.qual end) as check_expr,
         t.user_data,
         p.roles && array['public', 'anon']::name[] as to_anon
    from pg_policies p
    join tbls t on t.tbl = p.tablename
   where p.schemaname = 'public'
),
pol1 as (
  select pol0.*,
         regexp_replace(regexp_replace(regexp_replace(lower(coalesce(using_expr, '')),
           '::\s*(text|uuid|character varying)', '', 'g'), '\mselect\M|\mas\s+uid\M', '', 'g'), '[\s()]', '', 'g') as u_norm,
         regexp_replace(regexp_replace(regexp_replace(lower(coalesce(check_expr, '')),
           '::\s*(text|uuid|character varying)', '', 'g'), '\mselect\M|\mas\s+uid\M', '', 'g'), '[\s()]', '', 'g') as c_norm,
         coalesce(using_expr, '') ~* '\sor\s' as u_or,
         coalesce(check_expr, '') ~* '\sor\s' as c_or,
         case cmd when 'SELECT' then 'read' when 'UPDATE' then 'change' when 'DELETE' then 'delete'
                  when 'INSERT' then 'add' else 'read, add, change and delete' end as verb
    from pol0
),
pols as (
  select pol1.*,
         strpos(u_norm, 'user_id=auth.uid') > 0 or strpos(u_norm, 'auth.uid=user_id') > 0 as u_owner,
         strpos(c_norm, 'user_id=auth.uid') > 0 or strpos(c_norm, 'auth.uid=user_id') > 0 as c_owner
    from pol1
),

-- Functions in public that are ours (not installed by an extension).
fns as (
  select p.oid, p.proname::text as fn, pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef as definer,
         p.prorettype = 'trigger'::regtype as is_trigger,
         exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%') as path_pinned,
         has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f', 'p')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),

checks (area_ord, sort_key, result, area, object, policy, roles, cmd, detail) as (

  -- ── 1a. Each table: RLS on/off ─────────────────────────────────────────────
  select 1, t.tbl || ' 0',
         case when not t.rls_on and t.api_grants then 'FAIL'
              when not t.rls_on then 'WARN'
              else 'PASS' end,
         'Tables & RLS', 'public.' || t.tbl, null::text, null::text, null::text,
         case when not t.rls_on and t.api_grants then
                'RLS is OFF: anyone with the public anon key (it is inside the app) can read and change every row'
                || case when t.user_data then ', and this table holds per-user data' else '' end
                || '. Fix: ' || case when t.tbl in ('sessions', 'custom_weights', 'feedback') then 'run rls_owner_only.sql'
                                     else 'alter table public.' || quote_ident(t.tbl) || ' enable row level security;' end
              when not t.rls_on then
                'RLS is OFF. The API roles currently have no access to it, but turn RLS on anyway: alter table public.'
                || quote_ident(t.tbl) || ' enable row level security;'
              when t.npol = 0 then
                'RLS ON with no policies: locked, so the API can neither read nor write it.'
              else 'RLS ON, ' || t.npol || ' policy(ies) listed below.'
                   || case when t.user_data then ' Holds per-user data (user_id column).' else '' end
         end
    from tbls t

  union all
  -- ── 1b. Each policy: who, what, and is it limited to the user's own rows ───
  select 1, p.tbl || ' 1 ' || p.policy,
         case
           when p.permissive = 'RESTRICTIVE' then 'INFO'
           when not p.user_data then
             case when p.to_anon and p.cmd <> 'SELECT' and not (p.u_owner or p.c_owner) then 'WARN' else 'INFO' end
           when p.cmd in ('SELECT', 'UPDATE', 'DELETE', 'ALL') and not p.u_owner then 'FAIL'
           when p.cmd in ('INSERT', 'UPDATE', 'ALL') and not p.c_owner then 'FAIL'
           when p.cmd = 'INSERT' and p.tbl = 'feedback' and p.c_or and strpos(p.c_norm, 'user_idisnull') > 0 then 'PASS'
           when (p.cmd in ('SELECT', 'UPDATE', 'DELETE', 'ALL') and p.u_or)
             or (p.cmd in ('INSERT', 'UPDATE', 'ALL') and p.c_or) then 'WARN'
           else 'PASS'
         end,
         'Tables & RLS', 'public.' || p.tbl, p.policy, array_to_string(p.roles, ', '), p.cmd,
         case
           when p.permissive = 'RESTRICTIVE' then
             'Restrictive policy: it can only narrow access further.'
           when not p.user_data then
             case when p.to_anon and p.cmd <> 'SELECT' and not (p.u_owner or p.c_owner)
                  then 'Anyone with the public anon key can ' || p.verb || ' rows in this table. Fine only if that is intended.'
                  else 'No user_id column (not per-user data). Lets ' || array_to_string(p.roles, ', ') || ' ' || p.verb || ' rows.' end
           when p.cmd in ('SELECT', 'UPDATE', 'DELETE', 'ALL') and not p.u_owner then
             case when p.to_anon
                  then 'Anyone with the public anon key can ' || p.verb || ' rows here: there is no user_id = auth.uid() check. Fix: run rls_owner_only.sql (or drop this policy).'
                  else 'Any signed-in user can ' || p.verb || ' OTHER users'' rows: there is no user_id = auth.uid() check. Fix: run rls_owner_only.sql (or drop this policy).' end
           when p.cmd in ('INSERT', 'UPDATE', 'ALL') and not p.c_owner then
             'Rows written through this policy are not tied to the signed-in user, so someone could write rows into another person''s account. Fix: run rls_owner_only.sql (or drop this policy).'
           when p.cmd = 'INSERT' and p.tbl = 'feedback' and p.c_or and strpos(p.c_norm, 'user_idisnull') > 0 then
             'Expected: anyone can send feedback, filed under their own account or under nobody (anonymous). Nobody can read feedback back through this policy.'
           when (p.cmd in ('SELECT', 'UPDATE', 'DELETE', 'ALL') and p.u_or)
             or (p.cmd in ('INSERT', 'UPDATE', 'ALL') and p.c_or) then
             'Has an owner check plus an extra OR condition. Make sure the OR does not open up other people''s rows.'
           when p.to_anon then
             'Owner-only. It also lists anon, but anon has no user id, so it matches nothing.'
           else
             'Owner-only: a signed-in user can only ' || p.verb || ' their own rows.'
         end
    from pols p

  union all
  -- ── 2. Views: they run with their owner's rights and skip RLS ─────────────
  select 2, c.relname::text,
         case when not (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT')) then 'PASS'
              when c.relkind = 'v' and array_to_string(c.reloptions, ',') ~* 'security_invoker=(true|on|1|yes)' then 'PASS'
              else 'FAIL' end,
         'Views', 'public.' || c.relname, null, null, null,
         case when not (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'))
                then 'Not readable through the API.'
              when c.relkind = 'v' and array_to_string(c.reloptions, ',') ~* 'security_invoker=(true|on|1|yes)'
                then 'View uses security_invoker, so RLS still applies.'
              when c.relkind = 'm'
                then 'Materialized view readable through the API: these ignore RLS entirely. Fix: revoke select on public.' || quote_ident(c.relname) || ' from anon, authenticated;'
              else 'View readable through the API that runs with its owner''s rights, so RLS on the tables underneath is skipped. Fix: alter view public.' || quote_ident(c.relname) || ' set (security_invoker = true);'
         end
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v', 'm')

  union all
  select 2, '', 'PASS', 'Views', '(none)', null, null, null, 'No views in public.'
   where not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relkind in ('v', 'm'))

  union all
  -- ── 3. SECURITY DEFINER functions (they skip RLS) ──────────────────────────
  select 3, f.fn,
         case
           when f.fn = 'delete_my_account' and f.args = '' then
             case when f.definer and f.path_pinned and not f.anon_exec and f.auth_exec then 'PASS' else 'FAIL' end
           when f.is_trigger then case when f.path_pinned then 'PASS' else 'FAIL' end
           when f.anon_exec or not f.path_pinned then 'FAIL'
           when f.auth_exec then 'WARN'
           else 'PASS'
         end,
         'Functions', 'public.' || f.fn || '(' || f.args || ')', null,
         concat_ws(', ', case when f.anon_exec then 'anon' end, case when f.auth_exec then 'authenticated' end),
         'EXECUTE',
         case
           when f.fn = 'delete_my_account' and f.args = '' then
             case when f.definer and f.path_pinned and not f.anon_exec and f.auth_exec
                  then 'Account deletion: signed-in users only, acts on their own account only, search_path pinned.'
                  else 'Account deletion is set up wrongly ('
                       || concat_ws('; ',
                            case when not f.definer then 'not security definer' end,
                            case when not f.path_pinned then 'search_path not pinned' end,
                            case when f.anon_exec then 'the anon key alone can call it' end,
                            case when not f.auth_exec then 'signed-in users cannot call it' end)
                       || '). Fix: re-run delete_my_account.sql.' end
           when f.is_trigger then
             case when f.path_pinned then 'Trigger function: it cannot be called through the API, and its search_path is pinned.'
                  else 'Trigger function without a pinned search_path. Fix: alter function public.' || quote_ident(f.fn) || '() set search_path = '''';' end
           when f.anon_exec then
             'Anyone with the public anon key can run this with owner rights, bypassing RLS. Fix: revoke execute on function public.'
             || quote_ident(f.fn) || '(' || f.args || ') from public, anon;'
           when not f.path_pinned then
             'search_path is not pinned, so it can be tricked into using look-alike tables. Fix: alter function public.'
             || quote_ident(f.fn) || '(' || f.args || ') set search_path = '''';'
           when f.auth_exec then
             'Any signed-in user can run this with owner rights (it bypasses RLS). Make sure it only touches the caller''s own data.'
           else 'Not callable through the API.'
         end
    from fns f
   where f.definer

  union all
  select 3, 'delete_my_account', 'FAIL', 'Functions', 'public.delete_my_account()', null, null, null,
         'Account deletion is NOT installed: the app cannot delete accounts (App Store blocker). Fix: run delete_my_account.sql.'
   where to_regprocedure('public.delete_my_account()') is null

  union all
  -- ── 4. Storage (the app stores no files) ───────────────────────────────────
  select 4, 'bucket ' || b.id,
         case when b.public then 'WARN' else 'INFO' end,
         'Storage', 'bucket "' || b.id || '"', null, null, null,
         case when b.public then 'Public bucket: anyone with a file''s link can download it, with no sign-in.'
              else 'Private bucket: access is controlled by the storage policies below.' end
    from storage.buckets b

  union all
  select 4, 'bucket', 'PASS', 'Storage', '(no buckets)', null, null, null,
         'No storage buckets, so there are no files to leak. The app keeps feedback screenshots inside the feedback table.'
   where not exists (select 1 from storage.buckets)

  union all
  select 4, 'policy ' || p.policyname,
         case when p.roles && array['public', 'anon']::name[] then 'WARN' else 'INFO' end,
         'Storage', 'storage.' || p.tablename, p.policyname::text, array_to_string(p.roles, ', '), p.cmd,
         case when p.roles && array['public', 'anon']::name[]
              then 'File policy that applies to anyone with the anon key. Fine only for deliberately public files.'
              else 'File policy for signed-in users.' end
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename in ('objects', 'buckets')

  union all
  -- ── 5a. Account deletion: guard trigger on each user-data table ───────────
  select 5, t.tbl,
         case when tg.tgname is not null and tg.tgenabled <> 'D' then 'PASS' else 'WARN' end,
         'Account deletion', 'public.' || t.tbl, null, null, null,
         case when t.uid_type not in ('uuid'::regtype, 'text'::regtype, 'character varying'::regtype) then
                'user_id has type ' || format_type(t.uid_type, null) || ', so account deletion cannot match it. Tell the developer. '
              else 'Covered by account deletion: delete_my_account() clears this table. ' end
         || case when tg.tgname is null then 'Guard trigger MISSING: a deleted account''s token could still write here for up to an hour. Fix: re-run delete_my_account.sql.'
                 when tg.tgenabled = 'D' then 'Guard trigger is DISABLED. Fix: re-run delete_my_account.sql.'
                 else 'Guard trigger on: a deleted account''s token cannot write here.' end
    from tbls t
    left join pg_trigger tg on tg.tgrelid = t.oid and tg.tgname = 'mg_refuse_deleted_account_writes'
   where t.user_data

  union all
  -- ── 5b. Tables that account deletion does not touch ────────────────────────
  select 5, t.tbl,
         case when x.n = 0 then 'INFO' else 'WARN' end,
         'Account deletion', 'public.' || t.tbl, null, null, null,
         'Not touched by account deletion (no user_id column, no link to auth.users). It has ' || x.n || ' row(s). '
         || case when x.n = 0 then 'It is empty, so nothing is missed today.'
                 else 'If it stores anything about a person, tell the developer.' end
    from tbls t
    cross join lateral (
      select (xpath('/row/n/text()',
               query_to_xml(format('select count(*) as n from public.%I', t.tbl), false, true, '')))[1]::text::bigint as n
    ) x
   where not t.user_data and not t.fk_to_auth

  union all
  -- ── 5c. Foreign keys to auth.users (how each behaves when a login is deleted)
  select 5, n.nspname || '.' || c.relname || ' ' || con.conname,
         case when con.confdeltype in ('n', 'd') then 'WARN' else 'PASS' end,
         'Account deletion', n.nspname || '.' || c.relname, con.conname::text, null, null,
         'Foreign key to auth.users: '
         || case con.confdeltype
              when 'c' then 'ON DELETE CASCADE, so these rows are removed with the login.'
              when 'n' then 'ON DELETE SET NULL, so these rows SURVIVE account deletion, just unlinked. Make sure they hold nothing personal.'
              when 'd' then 'ON DELETE SET DEFAULT, so these rows SURVIVE account deletion. Make sure they hold nothing personal.'
              else 'NO ACTION / RESTRICT, so delete_my_account() clears these rows before removing the login.' end
    from pg_constraint con
    join pg_class c     on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
     and n.nspname not in ('auth', 'storage')

  union all
  -- ── 6. Rows left behind by accounts that no longer exist ───────────────────
  select 6, t.tbl,
         case when x.n = 0 then 'PASS' else 'WARN' end,
         'Leftover rows', 'public.' || t.tbl, null, null, null,
         case when x.n = 0 then 'No rows belong to accounts that no longer exist.'
              else x.n || ' row(s) belong to accounts that no longer exist (left over from before, or planted while the table was open). '
                   || 'To remove them: delete from public.' || quote_ident(t.tbl)
                   || ' t where t.user_id is not null and not exists (select 1 from auth.users u where u.id::text = t.user_id::text);' end
    from tbls t
    cross join lateral (
      select (xpath('/row/n/text()',
               query_to_xml(format(
                 'select count(*) as n from public.%I t where t.user_id is not null
                     and not exists (select 1 from auth.users u where u.id::text = t.user_id::text)', t.tbl),
               false, true, '')))[1]::text::bigint as n
    ) x
   where t.uid_type in ('uuid'::regtype, 'text'::regtype, 'character varying'::regtype)
)

select r.result, r.area, r.object, r.policy, r.roles, r.cmd, r.detail
from (
  select 0 as area_ord, '' as sort_key,
         case when count(*) filter (where result = 'FAIL') > 0 then 'FAIL'
              when count(*) filter (where result = 'WARN') > 0 then 'PASS (with warnings)'
              else 'PASS' end as result,
         'OVERALL' as area, null::text as object, null::text as policy, null::text as roles, null::text as cmd,
         count(*) filter (where result = 'FAIL') || ' problem(s), '
         || count(*) filter (where result = 'WARN') || ' warning(s) across '
         || (select count(*) from tbls) || ' table(s).'
         || coalesce(' FAIL: ' || string_agg(object || coalesce(' / ' || policy, ''), '; ') filter (where result = 'FAIL'), '')
         || coalesce(' WARN: ' || string_agg(object || coalesce(' / ' || policy, ''), '; ') filter (where result = 'WARN'), '')
         as detail
    from checks
  union all
  select area_ord, sort_key, result, area, object, policy, roles, cmd, detail from checks
) r
order by r.area_ord, r.sort_key, r.object;
