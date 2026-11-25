-- Max Gainz Phase 3 — private, revocable share links (run once in the Supabase SQL editor).
--
-- Run in: Supabase dashboard → SQL Editor → New query → paste → Run.
-- Idempotent: safe to run again (re-creates the same functions and policies).
--
-- What a share is
--   A COPY of a session or weekly summary, made at share time, holding only the
--   whitelisted fields below (never email, user id, name, body measurements;
--   notes only when the user ticks them). Viewers never touch the user's own
--   tables, never get a JWT, and can only call share_get() with a link token.
--
-- Security model
--   • Token: 144 random bits (24 url-safe chars) made by the server. Only its
--     SHA-256 is stored, so a database read never reveals working links.
--   • Clients cannot insert/update/delete the table: share_create() and
--     share_revoke() (SECURITY DEFINER) are the only writers; owners can read
--     their own rows' metadata (for the "Shared links" list) through RLS.
--   • anon can execute share_get() and nothing else here; it returns only
--     {kind, created_at, expires_at, payload} for an unexpired link.
--   • Revoking DELETES the row (the copy is gone, not hidden).
--   • Payload checked against the same whitelist as SHARE_SCHEMA in index.html
--     (gate 21 keeps the two identical); ≤ 16 KB; per-user caps: 50 live links,
--     20 new links per UTC day; links expire after 1–90 days (default 30).
--   • Deleting the auth user cascades; the app also calls share_revoke_all()
--     when the user deletes their account.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shares (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  token_hash  bytea not null unique,
  kind        text not null check (kind in ('session', 'week')),
  title       text not null check (char_length(title) between 1 and 80),
  payload     jsonb not null check (octet_length(payload::text) <= 16384),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  view_count  int not null default 0
);
create index if not exists shares_user_idx on public.shares(user_id, created_at desc);

alter table public.shares enable row level security;
revoke all on table public.shares from anon;
revoke all on table public.shares from authenticated;
grant select (id, kind, title, created_at, expires_at, view_count) on public.shares to authenticated;
drop policy if exists shares_select_own on public.shares;
create policy shares_select_own on public.shares for select to authenticated using (user_id = (select auth.uid()));
-- No insert/update/delete policies: only the functions below write.

-- ── Whitelist (must match SHARE_SCHEMA in index.html — gate 21 compares them) ──
-- SHARE_KEYS session: v kind date title programme durationMin totals exercises unit
-- SHARE_KEYS week: v kind weekStart done planned trendPct newPBs sessions unit
-- SHARE_KEYS totals: sets volumeKg
-- SHARE_KEYS exercise: name sets pb note
-- SHARE_KEYS set: w r
-- SHARE_KEYS pb: name weight
-- SHARE_KEYS weeksession: date title
create or replace function public.share_keys_ok(o jsonb, allowed text[])
returns boolean language sql immutable as $$
  select jsonb_typeof(o) = 'object'
     and not exists (select 1 from jsonb_object_keys(o) k where k <> all(allowed))
$$;

create or replace function public.share_str_ok(v jsonb, maxlen int)
returns boolean language sql immutable as $$
  select v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and char_length(v #>> '{}') <= maxlen)
$$;

create or replace function public.share_num_ok(v jsonb)
returns boolean language sql immutable as $$
  select v is null or jsonb_typeof(v) in ('number', 'null')
$$;

create or replace function public.share_payload_ok(p jsonb, p_kind text)
returns boolean
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  e jsonb; st jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if (p->>'v') is distinct from '1' or (p->>'kind') is distinct from p_kind then return false; end if;
  if p_kind = 'session' then
    if not share_keys_ok(p, array['v','kind','date','title','programme','durationMin','totals','exercises','unit']) then return false; end if;
    if not (share_str_ok(p->'date', 10) and share_str_ok(p->'title', 60) and share_str_ok(p->'programme', 60) and share_str_ok(p->'unit', 3)) then return false; end if;
    if not share_num_ok(p->'durationMin') then return false; end if;
    if p ? 'totals' and jsonb_typeof(p->'totals') <> 'null' and not (share_keys_ok(p->'totals', array['sets','volumeKg'])
        and share_num_ok(p->'totals'->'sets') and share_num_ok(p->'totals'->'volumeKg')) then return false; end if;
    if p ? 'exercises' then
      if jsonb_typeof(p->'exercises') <> 'array' or jsonb_array_length(p->'exercises') > 25 then return false; end if;
      for e in select * from jsonb_array_elements(p->'exercises') loop
        if not share_keys_ok(e, array['name','sets','pb','note']) then return false; end if;
        if not (share_str_ok(e->'name', 60) and share_str_ok(e->'note', 200)) then return false; end if;
        if e ? 'pb' and jsonb_typeof(e->'pb') not in ('boolean', 'null') then return false; end if;
        if e ? 'sets' then
          if jsonb_typeof(e->'sets') <> 'array' or jsonb_array_length(e->'sets') > 15 then return false; end if;
          for st in select * from jsonb_array_elements(e->'sets') loop
            if not share_keys_ok(st, array['w','r']) or not share_num_ok(st->'w') or not share_num_ok(st->'r') then return false; end if;
          end loop;
        end if;
      end loop;
    end if;
  elsif p_kind = 'week' then
    if not share_keys_ok(p, array['v','kind','weekStart','done','planned','trendPct','newPBs','sessions','unit']) then return false; end if;
    if not (share_str_ok(p->'weekStart', 10) and share_str_ok(p->'unit', 3)
        and share_num_ok(p->'done') and share_num_ok(p->'planned') and share_num_ok(p->'trendPct')) then return false; end if;
    if p ? 'newPBs' then
      if jsonb_typeof(p->'newPBs') <> 'array' or jsonb_array_length(p->'newPBs') > 20 then return false; end if;
      for e in select * from jsonb_array_elements(p->'newPBs') loop
        if not share_keys_ok(e, array['name','weight']) or not share_str_ok(e->'name', 60) or not share_num_ok(e->'weight') then return false; end if;
      end loop;
    end if;
    if p ? 'sessions' then
      if jsonb_typeof(p->'sessions') <> 'array' or jsonb_array_length(p->'sessions') > 14 then return false; end if;
      for e in select * from jsonb_array_elements(p->'sessions') loop
        if not share_keys_ok(e, array['date','title']) or not share_str_ok(e->'title', 60) or not share_str_ok(e->'date', 10) then return false; end if;
      end loop;
    end if;
  else
    return false;
  end if;
  return true;
end
$$;

create or replace function public.share_create(p_kind text, p_title text, p_payload jsonb, p_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid uuid := auth.uid();
  tok text;
  new_id uuid;
  n_days int := least(greatest(coalesce(p_days, 30), 1), 90);
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  if p_kind is null or p_kind not in ('session', 'week') then return jsonb_build_object('ok', false, 'reason', 'kind'); end if;
  if p_title is null or char_length(p_title) < 1 or char_length(p_title) > 80 then return jsonb_build_object('ok', false, 'reason', 'title'); end if;
  if octet_length(coalesce(p_payload::text, '')) > 16384 or not share_payload_ok(p_payload, p_kind) then
    return jsonb_build_object('ok', false, 'reason', 'payload');
  end if;
  delete from shares where user_id = uid and expires_at < now();
  if (select count(*) from shares where user_id = uid) >= 50 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  if (select count(*) from shares where user_id = uid and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate');
  end if;
  tok := translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
  insert into shares(user_id, token_hash, kind, title, payload, expires_at)
    values (uid, digest(tok, 'sha256'), p_kind, p_title, p_payload, now() + n_days * interval '1 day')
    returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id, 'token', tok, 'expires_at', now() + n_days * interval '1 day');
end
$$;

create or replace function public.share_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  r record;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{24}$' then return jsonb_build_object('ok', false); end if;
  update shares set view_count = view_count + 1
    where token_hash = digest(p_token, 'sha256') and expires_at > now()
    returning kind, created_at, expires_at, payload into r;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'kind', r.kind, 'created_at', r.created_at, 'expires_at', r.expires_at, 'payload', r.payload);
end
$$;

create or replace function public.share_revoke(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  delete from shares where id = p_id and user_id = uid;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'deleted', n);
end
$$;

create or replace function public.share_revoke_all()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  delete from shares where user_id = uid;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'deleted', n);
end
$$;

revoke all on function public.share_create(text, text, jsonb, int) from public, anon;
grant execute on function public.share_create(text, text, jsonb, int) to authenticated;
revoke all on function public.share_revoke(uuid) from public, anon;
grant execute on function public.share_revoke(uuid) to authenticated;
revoke all on function public.share_revoke_all() from public, anon;
grant execute on function public.share_revoke_all() to authenticated;
revoke all on function public.share_get(text) from public;
grant execute on function public.share_get(text) to anon, authenticated;
revoke all on function public.share_payload_ok(jsonb, text) from public, anon;
revoke all on function public.share_keys_ok(jsonb, text[]) from public, anon;
revoke all on function public.share_str_ok(jsonb, int) from public, anon;
revoke all on function public.share_num_ok(jsonb) from public, anon;

-- Check after running (expect RLS on; four functions security definer; anon may only run share_get):
-- select relname, relrowsecurity from pg_class where relname = 'shares';
-- select proname, prosecdef from pg_proc where proname like 'share\_%';
-- select routine_name, grantee from information_schema.role_routine_grants where routine_name like 'share%' order by 1, 2;
