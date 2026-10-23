-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — look up ONE account, before and after the account-deletion test
-- READ-ONLY: changes nothing.
--
-- 1. Put the test account's email on the line marked  <<< TEST EMAIL
--    (keep the single quotes around it).
-- 2. Supabase dashboard → SQL Editor → New query → paste → Run.
--
-- Before deleting in the app, expect:
--   Account (login)                  FOUND
--   public.sessions / custom_weights rows owned by this account: 1 or more
--   "left behind by deleted accounts": write these numbers down (normally 0)
-- After deleting in the app, expect:
--   Account (login)                  NOT FOUND
--   feedback rows with this email    0
--   "left behind by deleted accounts": the SAME numbers as before. If a number
--   went up, the deleted account's rows were left behind: tell the developer.
-- ─────────────────────────────────────────────────────────────────────────────

with
input as (
  select lower(trim('PUT-TEST-EMAIL-HERE@example.com')) as email          -- <<< TEST EMAIL
),
acct as (
  select u.id, u.email, u.created_at, u.last_sign_in_at
    from auth.users u, input i
   where lower(u.email) = i.email
),
tbls as (
  select c.relname::text as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
     and a.atttypid in ('uuid'::regtype, 'text'::regtype, 'character varying'::regtype)
)
select r.check_name as "check", r.result
from (
  select 1 as ord, '' as tbl, 'Account (login) for ' || i.email as check_name,
         coalesce((select 'FOUND · id ' || a.id || ' · created ' || to_char(a.created_at, 'YYYY-MM-DD HH24:MI')
                          || ' · last sign-in ' || coalesce(to_char(a.last_sign_in_at, 'YYYY-MM-DD HH24:MI'), 'never')
                     from acct a limit 1),
                  'NOT FOUND (no login with this email exists)') as result
    from input i

  union all
  -- Rows owned by the account, table by table (only while the login exists)
  select 2, t.tbl, 'public.' || t.tbl || ' rows owned by this account',
         case when not exists (select 1 from acct) then 'n/a (login not found, see the "left behind" rows below)'
              else (xpath('/row/n/text()', query_to_xml(format(
                     'select count(*) as n from public.%I where user_id::text = %L', t.tbl, (select id::text from acct limit 1)),
                     false, true, '')))[1]::text end
    from tbls t

  union all
  -- Feedback that carries the email (covers feedback sent while signed in)
  select 3, '', 'public.feedback rows with this email',
         case when to_regclass('public.feedback') is null then 'n/a (no feedback table)'
              when not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.feedback')
                                  and a.attname = 'user_email' and not a.attisdropped) then 'n/a (no user_email column)'
              else (xpath('/row/n/text()', query_to_xml(format(
                     'select count(*) as n from public.feedback where lower(user_email) = %L', (select email from input)),
                     false, true, '')))[1]::text end

  union all
  -- Rows whose owner no longer exists, in each table (any deleted account)
  select 4, t.tbl, 'public.' || t.tbl || ' rows left behind by deleted accounts',
         (xpath('/row/n/text()', query_to_xml(format(
            'select count(*) as n from public.%I t where t.user_id is not null
                and not exists (select 1 from auth.users u where u.id::text = t.user_id::text)', t.tbl),
            false, true, '')))[1]::text
    from tbls t
) r
order by r.ord, r.tbl;
