-- ─────────────────────────────────────────────────────────────────────────────
-- Max Gainz — idempotent session uploads (client_id)
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Idempotent: safe to run again. Non-destructive: adds a column + a unique
-- constraint, deletes nothing.
--
-- Why: the app retries uploads that fail (offline gym, timeouts). Without a
-- unique key, a retry after a POST whose RESPONSE was lost inserts the same
-- workout twice. The app now tags every session with a client-generated id and
-- UPSERTs on (user_id, client_id), so a retry can only ever update the same row.
--
-- The app works before and after this runs: until the constraint exists, its
-- first upsert gets a schema error and it falls back to plain inserts.
--
-- NULLs are distinct in a Postgres unique constraint, so existing rows (which
-- have no client_id) are unaffected. The owner-only RLS policies from
-- rls_owner_only.sql already include the UPDATE policy an upsert needs.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.sessions add column if not exists client_id text;

do $mg$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'sessions_user_client_uniq'
       and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions
      add constraint sessions_user_client_uniq unique (user_id, client_id);
  end if;
end
$mg$;

-- Make PostgREST pick up the new column/constraint immediately.
notify pgrst, 'reload schema';

-- ── Report: duplicate sessions created by older builds (read-only) ───────────
-- Same user, same start second, same day name = the same workout uploaded twice.
-- The app already shows each of these once, and deleting one in the app now
-- deletes every copy. To clean them up here instead, review this list first.
select user_id,
       date_trunc('second', date) as started,
       day,
       count(*)                   as copies,
       array_agg(id order by id)  as row_ids
  from public.sessions
 group by user_id, date_trunc('second', date), day
having count(*) > 1
 order by started desc;

-- Optional cleanup (keeps the lowest id of each group). Uncomment to run:
-- delete from public.sessions s
--  using public.sessions keep
--  where s.user_id = keep.user_id
--    and date_trunc('second', s.date) = date_trunc('second', keep.date)
--    and s.day = keep.day
--    and s.id > keep.id;
