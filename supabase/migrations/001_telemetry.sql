-- gstack telemetry schema
-- Tables for tracking usage, installations, and update checks.

-- Main telemetry events (skill runs, upgrades)
CREATE TABLE telemetry_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  received_at TIMESTAMPTZ DEFAULT now(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL DEFAULT 'skill_run',
  gstack_version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT,
  event_timestamp TIMESTAMPTZ NOT NULL,
  skill TEXT,
  session_id TEXT,
  duration_s NUMERIC,
  outcome TEXT NOT NULL,
  error_class TEXT,
  used_browse BOOLEAN DEFAULT false,
  concurrent_sessions INTEGER DEFAULT 1,
  installation_id TEXT  -- nullable, only for "community" tier
);

-- Index for skill_sequences view performance
CREATE INDEX idx_telemetry_session_ts ON telemetry_events (session_id, event_timestamp);
-- Index for crash clustering
CREATE INDEX idx_telemetry_error ON telemetry_events (error_class, gstack_version) WHERE outcome = 'error';

-- Retention tracking per installation
CREATE TABLE installations (
  installation_id TEXT PRIMARY KEY,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  gstack_version TEXT,
  os TEXT
);

-- Install pings from update checks
CREATE TABLE update_checks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  checked_at TIMESTAMPTZ DEFAULT now(),
  gstack_version TEXT NOT NULL,
  os TEXT NOT NULL
);

-- RLS: anon key can INSERT and SELECT (all telemetry data is anonymous)
ALTER TABLE telemetry_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_insert_only" ON telemetry_events FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_select" ON telemetry_events FOR SELECT USING (true);

ALTER TABLE installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_insert_only" ON installations FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_select" ON installations FOR SELECT USING (true);
-- Allow upsert (update last_seen)
CREATE POLICY "anon_update_last_seen" ON installations FOR UPDATE USING (true) WITH CHECK (true);

ALTER TABLE update_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_insert_only" ON update_checks FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_select" ON update_checks FOR SELECT USING (true);

-- Crash clustering view
CREATE VIEW crash_clusters AS
SELECT
  error_class,
  gstack_version,
  COUNT(*) as total_occurrences,
  COUNT(DISTINCT installation_id) as identified_users,  -- community tier only
  COUNT(*) - COUNT(installation_id) as anonymous_occurrences,  -- events without installation_id
  MIN(event_timestamp) as first_seen,
  MAX(event_timestamp) as last_seen
FROM telemetry_events
WHERE outcome = 'error' AND error_class IS NOT NULL
GROUP BY error_class, gstack_version
ORDER BY total_occurrences DESC;

-- Skill sequence co-occurrence view
CREATE VIEW skill_sequences AS
SELECT
  a.skill as skill_a,
  b.skill as skill_b,
  COUNT(DISTINCT a.session_id) as co_occurrences
FROM telemetry_events a
JOIN telemetry_events b ON a.session_id = b.session_id
  AND a.skill != b.skill
  AND a.event_timestamp < b.event_timestamp
WHERE a.event_type = 'skill_run' AND b.event_type = 'skill_run'
GROUP BY a.skill, b.skill
HAVING COUNT(DISTINCT a.session_id) >= 10
ORDER BY co_occurrences DESC;
