-- ---------------------------------------------------------------------------
-- RLS verification.
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -f supabase/verify-rls.sql
--
-- Every assertion below must pass. A failure means a user could reach another
-- user's rows, which is the one class of bug this product cannot ship with.
-- ---------------------------------------------------------------------------

do $$
declare
  user_a uuid := '00000000-0000-0000-0000-00000000000a';
  user_b uuid := '00000000-0000-0000-0000-00000000000b';
  visible_count integer;
  table_name text;
begin
  -- 1. Every user-owned table has RLS enabled.
  foreach table_name in array array[
    'buyer_profiles', 'watchlist', 'portfolio_assets', 'alerts',
    'analysis_documents', 'document_findings', 'admin_audit_log'
  ] loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = table_name and c.relrowsecurity
    ) then
      raise exception 'RLS is NOT enabled on %', table_name;
    end if;
  end loop;

  -- 2. User A cannot see User B's watchlist rows.
  perform set_config('request.jwt.claims', json_build_object('sub', user_a)::text, true);
  select count(*) into visible_count from watchlist where user_id = user_b;
  if visible_count > 0 then
    raise exception 'ISOLATION FAILURE: user A can read % watchlist rows owned by user B', visible_count;
  end if;

  -- 3. User A cannot see User B's portfolio.
  select count(*) into visible_count from portfolio_assets where user_id = user_b;
  if visible_count > 0 then
    raise exception 'ISOLATION FAILURE: user A can read % portfolio rows owned by user B', visible_count;
  end if;

  -- 4. Demo rows are not visible to a non-service reader.
  select count(*) into visible_count from properties where data_status = 'demo';
  if visible_count > 0 then
    raise exception 'DEMO LEAK: % demo properties are readable through RLS', visible_count;
  end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'RLS verification passed.';
end $$;
