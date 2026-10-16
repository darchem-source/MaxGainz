-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — complete in-app account deletion
-- (Apple App Store guideline 5.1.1(v): the account itself must be deleted,
--  not just emptied)
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste this WHOLE file → Run.
--   • Safe to run again at any time: it replaces the same functions and triggers.
--   • Running this file deletes no data. It only installs what the app calls.
--   • The SQL Editor runs the file as one transaction, and step 0 only checks
--     things. If a check fails you get an error starting "STOP" and nothing in
--     the database is changed.
--   • Supabase may warn that the query has "destructive operations" (the word
--     DELETE inside the function, DROP TRIGGER IF EXISTS). That is expected:
--     confirm and run.
--
-- What it installs
--   1. public.delete_my_account()
--        The app calls it as  POST /rest/v1/rpc/delete_my_account  with the
--        signed-in user's token. In ONE transaction it deletes every row that
--        belongs to that user, then their login (auth.users). Either all of it
--        happens or none of it does. It never stops half way.
--   2. A guard trigger on every table that has a user_id column
--        A Supabase sign-in token keeps working for up to an hour, even after
--        the account is deleted. Without the guard, the app still open on a
--        second phone could upload the whole workout history again under the
--        deleted account. With the guard, any write made with a deleted
--        account's token is refused.
--
-- What delete_my_account() deletes (for the caller only, nobody else)
--   • Every row in every public table that has a user_id column. Today that is:
--       sessions        workout history
--       custom_weights  working weights, plus the "__profile__" row (name, email,
--                       date of birth, body-weight log, measurements, daily
--                       notes, custom workouts, preferences) and the
--                       "__dashboard__" summary row
--       feedback        feedback sent while signed in, including attached
--                       screenshots (also matched by the account's email)
--     It also covers any table added later that has a user_id column.
--   • Rows in any other table that point at the user through a foreign key
--     that would otherwise stop the login from being deleted.
--   • The login itself (auth.users). Supabase then removes the user's
--     identities, sign-in sessions and refresh tokens automatically. The
--     email/password stops working at once, and every device is signed out
--     when its current token expires (at most 1 hour).
--
-- What it does NOT delete
--   • Feedback sent with "anonymous" switched on. It has no user id or email,
--     so it can't be linked to the account.
--   • Files in Supabase Storage. The app stores none (feedback screenshots
--     are kept inside the feedback table). If an account ever owns files,
--     deletion stops with a clear error instead of leaving orphaned files.
--     Delete the files through the Storage API first.
--   • An App Store subscription. Apple bills it, and the user cancels it in
--     iPhone Settings. The app tells them this before they confirm.
--
-- Security
--   • It takes no input. It only ever acts on auth.uid(), the user inside the
--     caller's verified token, so it cannot be aimed at another account.
--   • It is SECURITY DEFINER, which means it runs with the owner's rights so
--     it is allowed to delete the login. Its search_path is pinned to empty
--     and every name is written out in full, so nothing can be slipped in
--     ahead of the real tables.
--   • Callers with only the public anon key cannot run it. Signed-in users can.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Step 0: pre-flight checks (these change nothing) ──────────────────────────
do $mg$
declare
  t record;
begin
  if to_regclass('auth.users') is null or to_regprocedure('auth.uid()') is null then
    raise exception 'STOP — nothing was changed: auth.users or auth.uid() is missing. Run this in the Supabase SQL Editor of the Max Gainz project.';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'STOP — nothing was changed: the Supabase roles anon / authenticated are missing.';
  end if;

  -- The function runs with the rights of whoever runs this file (normally
  -- "postgres", the SQL Editor default). That role must be able to remove a login.
  if not (    has_table_privilege(current_user, 'auth.users', 'SELECT')
          and has_table_privilege(current_user, 'auth.users', 'DELETE')
          and has_any_column_privilege(current_user, 'auth.users', 'UPDATE')) then
    raise exception 'STOP — nothing was changed: role "%" is not allowed to delete from auth.users. Run this file as "postgres" (the SQL Editor default). If it still fails, Supabase has changed its permissions: see "Plan B" in the runbook.', current_user;
  end if;

  -- If row-level security hid auth.users from this role, deleting a login
  -- would quietly do nothing and the app would wrongly report success.
  if exists (select 1 from pg_class c
              where c.oid = 'auth.users'::regclass and c.relrowsecurity
                and not (pg_has_role(current_user, c.relowner, 'USAGE') and not c.relforcerowsecurity))
     and not exists (select 1 from pg_roles r
                      where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'STOP — nothing was changed: auth.users has row-level security that role "%" cannot see past.', current_user;
  end if;

  -- Every table the function will clear must be deletable, and must accept
  -- the guard trigger.
  for t in
    select c.oid, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  loop
    if not (has_table_privilege(current_user, t.oid, 'DELETE')
            and has_table_privilege(current_user, t.oid, 'TRIGGER')) then
      raise exception 'STOP — nothing was changed: role "%" cannot delete from / add a trigger to public.%.', current_user, t.relname;
    end if;
  end loop;
end
$mg$;


-- ── Step 1: the function the app calls ────────────────────────────────────────
create or replace function public.delete_my_account()
returns json
language plpgsql
security definer
set search_path = ''   -- nothing is looked up implicitly; every name below is schema-qualified
as $fn$
declare
  v_uid     uuid := auth.uid();   -- the user inside the caller's token (never an argument)
  v_email   text;
  v_existed boolean;
  v_files   bigint := 0;
  v_n       bigint;
  v_deleted jsonb := '{}'::jsonb; -- rows removed per table, returned to the caller
  r         record;
begin
  -- Only a signed-in user can call this, and only for themselves.
  if v_uid is null then
    raise exception 'Not signed in: delete_my_account needs the user''s own sign-in token'
      using errcode = '42501';
  end if;

  -- Safety net: if row-level security could hide auth.users from this
  -- function, a delete would silently do nothing. Refuse instead of
  -- reporting a false success.
  if exists (select 1 from pg_class c
              where c.oid = 'auth.users'::regclass and c.relrowsecurity
                and not (pg_has_role(current_user, c.relowner, 'USAGE') and not c.relforcerowsecurity))
     and not exists (select 1 from pg_roles ro
                      where ro.rolname = current_user and (ro.rolsuper or ro.rolbypassrls)) then
    raise exception 'Account deletion is misconfigured (auth.users is hidden by row-level security); nothing was deleted';
  end if;

  -- 1. Lock the login row first. Until this transaction ends, any write made
  --    with this user's token waits at the guard trigger, and once it commits
  --    those writes are refused. So no row can slip in between the deletes
  --    below and the commit.
  select u.email into v_email from auth.users u where u.id = v_uid for update;
  v_existed := found;
  -- If the login is already gone (the app retrying after a lost reply), carry
  -- on anyway. Any leftovers are swept up and the call still reports success.
  v_email := coalesce(v_email, nullif(auth.jwt() ->> 'email', ''));

  -- 2. Files in Supabase Storage. SQL can't remove a file's stored data
  --    (only Storage's own API can), and files can block deleting the login.
  --    The app stores no files. If that ever changes, stop here, with nothing
  --    deleted, and say why.
  --    Storage records the owner in "owner" (older) and/or "owner_id" (newer).
  for r in
    select c.oid::regclass::text as tbl,
           string_agg(format('%I::text = $1', a.attname), ' or ') as owned_by_me
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid
                         and a.attname in ('owner', 'owner_id') and not a.attisdropped
     where c.oid in (to_regclass('storage.objects'), to_regclass('storage.buckets'))
     group by c.oid
  loop
    execute format('select count(*) from %s where %s', r.tbl, r.owned_by_me) into v_n using v_uid::text;
    v_files := v_files + v_n;
  end loop;
  if v_files > 0 then
    raise exception 'Account deletion blocked: this account still owns % file(s) or bucket(s) in Supabase Storage; nothing was deleted', v_files
      using hint = 'Delete them through the Storage API first, then call delete_my_account again.';
  end if;

  -- 3. Every row in every public table that has a user_id column
  --    (sessions, custom_weights, feedback today, plus anything added later).
  for r in
    select c.relname, a.atttypid
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
     order by c.relname
  loop
    if r.atttypid = 'uuid'::regtype then
      execute format('delete from public.%I where user_id = $1', r.relname) using v_uid;
    elsif r.atttypid in ('text'::regtype, 'character varying'::regtype) then
      execute format('delete from public.%I where user_id = $1', r.relname) using v_uid::text;
    else
      continue;  -- a user_id column that can't hold an account id (verify_security.sql flags these)
    end if;
    get diagnostics v_n = row_count;
    v_deleted := v_deleted || jsonb_build_object('public.' || r.relname, v_n);
  end loop;

  -- 4. Feedback that carries this account's email address but no user id.
  if v_email is not null and exists (
       select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.feedback')
          and a.attname = 'user_email' and not a.attisdropped) then
    execute 'delete from public.feedback where lower(user_email) = lower($1)' using v_email;
    get diagnostics v_n = row_count;
    v_deleted := jsonb_set(v_deleted, '{public.feedback}',
                   to_jsonb(coalesce((v_deleted ->> 'public.feedback')::bigint, 0) + v_n));
  end if;

  -- 5. Any other table pointing at auth.users through a foreign key that would
  --    block the delete (NO ACTION / RESTRICT). CASCADE and SET NULL keys are
  --    left to Postgres. Supabase's own auth tables all cascade.
  for r in
    select n.nspname, c.relname, a.attname
      from pg_constraint con
      join pg_class c       on c.oid = con.conrelid
      join pg_namespace n   on n.oid = c.relnamespace
      join pg_attribute a   on a.attrelid = con.conrelid  and a.attnum = con.conkey[1]
      join pg_attribute ref on ref.attrelid = con.confrelid and ref.attnum = con.confkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::regclass
       and ref.attname = 'id'
       and cardinality(con.conkey) = 1
       and con.confdeltype in ('a', 'r')
       and n.nspname not in ('auth', 'storage')
  loop
    execute format('delete from %I.%I where %I = $1', r.nspname, r.relname, r.attname) using v_uid;
    get diagnostics v_n = row_count;
    v_deleted := jsonb_set(v_deleted, array[r.nspname || '.' || r.relname],
                   to_jsonb(coalesce((v_deleted ->> (r.nspname || '.' || r.relname))::bigint, 0) + v_n));
  end loop;

  -- 6. Finally the login itself. Supabase's own tables (identities, sign-in
  --    sessions, refresh tokens, MFA factors) are removed with it automatically.
  delete from auth.users u where u.id = v_uid;
  get diagnostics v_n = row_count;
  if (v_existed and v_n <> 1) or exists (select 1 from auth.users u where u.id = v_uid) then
    raise exception 'Account deletion failed: the login could not be removed; nothing was deleted';
  end if;

  return json_build_object(
    'ok',                true,
    'user_id',           v_uid,
    'auth_user_deleted', v_existed,  -- false means it was already gone (a retry); still a success
    'rows_deleted',      v_deleted
  );
end
$fn$;

comment on function public.delete_my_account() is
  'Max Gainz: deletes the calling user''s rows in every user-data table and then their auth.users login, in one transaction. Called by the app as POST /rest/v1/rpc/delete_my_account with the user''s JWT. See supabase/delete_my_account.sql.';

-- Supabase lets every role run new functions by default. Take that away from
-- PUBLIC and anon (the public anon key alone), then allow signed-in users.
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;


-- ── Step 2: the guard that refuses writes from a deleted account's token ──────
create or replace function public.mg_refuse_deleted_account_writes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- Only requests made with a user's sign-in token are checked. The anon key,
  -- the service role and the SQL Editor carry no user id and pass straight on.
  if auth.uid() is not null then
    -- FOR KEY SHARE waits while delete_my_account() is running for this
    -- user, then finds no row once that has committed.
    perform 1 from auth.users u where u.id = auth.uid() for key share;
    if not found then
      raise exception 'MG_ACCOUNT_DELETED: this account has been deleted'
        using errcode = '42501',
              hint    = 'Sign out on this device. The account no longer exists.';
    end if;
  end if;
  return null;  -- statement-level trigger: the return value is not used
end
$fn$;

comment on function public.mg_refuse_deleted_account_writes() is
  'Max Gainz: trigger that refuses inserts/updates made with the token of an account that no longer exists. Installed by supabase/delete_my_account.sql.';

-- A trigger function can't be called through the API, and nobody needs to
-- call it directly, so remove every role's right to.
revoke all on function public.mg_refuse_deleted_account_writes() from public, anon, authenticated;

-- Attach it, once per statement, to every public table with a user_id column.
do $mg$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  loop
    execute format('drop trigger if exists mg_refuse_deleted_account_writes on public.%I', t.relname);
    execute format('create trigger mg_refuse_deleted_account_writes
                      before insert or update on public.%I
                      for each statement
                      execute function public.mg_refuse_deleted_account_writes()', t.relname);
  end loop;
end
$mg$;

-- Tell the API (PostgREST) to pick up the new function straight away.
notify pgrst, 'reload schema';


-- ── Result grid: what is now in place ─────────────────────────────────────────
-- Expect PASS on every row. Run verify_security.sql for the full security check.
select r.result, r.item, r.detail
from (
  select 1 as ord, p.proname::text as sort_key,
         case when p.prosecdef
                   and exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%')
                   and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and has_function_privilege('authenticated', p.oid, 'EXECUTE')
              then 'PASS' else 'FAIL' end as result,
         'public.delete_my_account()' as item,
         'security definer: ' || case when p.prosecdef then 'yes' else 'NO' end
         || ' · search_path pinned: '
         || case when exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%') then 'yes' else 'NO' end
         || ' · signed-in users can run it: '
         || case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'yes' else 'NO' end
         || ' · anon key alone can run it: '
         || case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'YES (wrong)' else 'no' end as detail
    from pg_proc p
   where p.oid = to_regprocedure('public.delete_my_account()')
  union all
  select 2, c.relname::text,
         case when tg.tgname is not null and tg.tgenabled <> 'D' then 'PASS' else 'FAIL' end,
         'public.' || c.relname,
         'Cleared by delete_my_account() (user_id is ' || format_type(a.atttypid, a.atttypmod) || ') · guard trigger: '
         || case when tg.tgname is null then 'MISSING' when tg.tgenabled = 'D' then 'DISABLED' else 'on' end
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
    left join pg_trigger tg on tg.tgrelid = c.oid and tg.tgname = 'mg_refuse_deleted_account_writes'
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  union all
  select 3, n.nspname || '.' || c.relname,
         'PASS',
         n.nspname || '.' || c.relname,
         'Linked to auth.users by foreign key "' || con.conname || '" (' ||
         case con.confdeltype when 'c' then 'ON DELETE CASCADE: removed with the login'
                              when 'n' then 'ON DELETE SET NULL: rows stay, unlinked'
                              when 'd' then 'ON DELETE SET DEFAULT: rows stay, unlinked'
                              else 'cleared by delete_my_account() before the login is removed' end || ')'
    from pg_constraint con
    join pg_class c     on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
     and n.nspname not in ('auth', 'storage')
) r
order by r.ord, r.sort_key;
