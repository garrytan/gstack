-- 003_installations_upsert_policy.sql
-- Re-add a scoped UPDATE policy for installations so the telemetry-ingest
-- edge function can upsert (update last_seen) using the caller's anon key
-- instead of the service role key.
--
-- Migration 002 dropped the overly broad "anon_update_last_seen" policy
-- (which allowed UPDATE on ALL columns). This replacement uses:
--   1. An RLS policy to allow UPDATE (required for any row access)
--   2. Column-level GRANT to restrict anon to only the tracking columns
--      the edge function actually writes (last_seen, gstack_version, os)
--
-- This means anon callers cannot UPDATE first_seen or installation_id,
-- closing the residual risk from the broad RLS-only approach.

-- RLS policy: allow UPDATE on rows (required for PostgREST/upsert)
CREATE POLICY "anon_update_tracking" ON installations
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Column-level restriction: anon can only UPDATE these three columns.
-- PostgreSQL GRANT UPDATE (col, ...) is enforced at the query level —
-- any UPDATE touching other columns will be rejected with a permission error.
REVOKE UPDATE ON installations FROM anon;
GRANT UPDATE (last_seen, gstack_version, os) ON installations TO anon;
