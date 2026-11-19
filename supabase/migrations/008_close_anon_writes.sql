-- 008_close_anon_writes.sql
-- Closes the last direct write path. Since v0.11.16.0 every gstack client
-- writes through the edge functions (telemetry-ingest, update-check); only
-- older clients POST straight to the tables with the public key. The policies
-- kept for them in 002 also let anyone write arbitrary rows: probes on
-- 2026-11-16..19 added about 2,000 junk events and 500 fake installs.
--
-- What this drops: clients older than v0.11.16.0 (released 2026-03-24) stop
-- landing. In the 30 days to 2026-11-19 that was 245 events from 13 to 22
-- installs and 163 update checks. Their sync keeps the batch and retries, so
-- nothing breaks on their side; it just never arrives.
--
-- Deploy order: telemetry-ingest must already use the service role key
-- (this PR) before this runs, or every new event is refused.

DROP POLICY IF EXISTS "anon_insert_only" ON telemetry_events;
DROP POLICY IF EXISTS "anon_insert_only" ON installations;
DROP POLICY IF EXISTS "anon_insert_only" ON update_checks;
DROP POLICY IF EXISTS "anon_update_tracking" ON installations;
DROP POLICY IF EXISTS "anon_update_last_seen" ON installations;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

DO $$
BEGIN
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
EXCEPTION
  WHEN insufficient_privilege OR undefined_object THEN
    RAISE NOTICE 'supabase_admin default privileges unchanged (%): objects it creates later still grant anon', SQLERRM;
END
$$;
