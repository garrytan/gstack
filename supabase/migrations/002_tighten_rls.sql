-- 002_tighten_rls.sql
-- Lock down read/update access. Keep INSERT policies so old clients can still
-- write via PostgREST while new clients migrate to edge functions.

-- Drop all SELECT policies (anon key should not read telemetry data)
DROP POLICY IF EXISTS "anon_select" ON telemetry_events;
DROP POLICY IF EXISTS "anon_select" ON installations;
DROP POLICY IF EXISTS "anon_select" ON update_checks;

-- Drop dangerous UPDATE policy (was unrestricted on all columns)
DROP POLICY IF EXISTS "anon_update_last_seen" ON installations;

-- Keep INSERT policies — old clients (pre-v0.11.16) still POST directly to
-- PostgREST. These will be dropped in a future migration once adoption of
-- edge-function-based sync is widespread.
-- (anon_insert_only ON telemetry_events — kept)
-- (anon_insert_only ON installations — kept)
-- (anon_insert_only ON update_checks — kept)

-- Explicitly revoke view access (belt-and-suspenders)
REVOKE SELECT ON crash_clusters FROM anon;
REVOKE SELECT ON skill_sequences FROM anon;

-- Keep error_message and failed_step columns (exist on live schema, may be
-- used in future). Add them to the migration record so repo matches live.
ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS failed_step TEXT;

-- Cache table for community-pulse aggregation (prevents DoS via repeated queries)
CREATE TABLE IF NOT EXISTS community_pulse_cache (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  refreshed_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE community_pulse_cache ENABLE ROW LEVEL SECURITY;
-- No anon policies — only service_role_key (used by edge functions) can read/write
