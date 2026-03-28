-- gstack telemetry data integrity + growth metrics
-- Adds source tagging, install fingerprinting, duration guards, and growth views.
--
-- ─── Phase 4A cleanup (inline — fixes 56-year durations from shell var bug) ──
UPDATE telemetry_events SET duration_s = NULL WHERE duration_s > 86400 OR duration_s < 0;

-- ─── Source field (live/test/dev tagging) ─────────────────────
ALTER TABLE telemetry_events ADD COLUMN source TEXT DEFAULT 'live';
ALTER TABLE update_checks ADD COLUMN source TEXT DEFAULT 'live';

-- ─── Install fingerprinting (expand-then-contract) ───────────
-- ADD new column (don't RENAME — old clients still POST installation_id)
ALTER TABLE telemetry_events ADD COLUMN install_fingerprint TEXT;
ALTER TABLE update_checks ADD COLUMN install_fingerprint TEXT;

-- Trigger: copy installation_id → install_fingerprint on INSERT (backward compat)
CREATE OR REPLACE FUNCTION copy_install_id_to_fingerprint()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.install_fingerprint IS NULL AND NEW.installation_id IS NOT NULL THEN
    NEW.install_fingerprint := NEW.installation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_copy_install_fingerprint
  BEFORE INSERT ON telemetry_events
  FOR EACH ROW
  EXECUTE FUNCTION copy_install_id_to_fingerprint();

-- Backfill existing rows
UPDATE telemetry_events
  SET install_fingerprint = installation_id
  WHERE installation_id IS NOT NULL AND install_fingerprint IS NULL;

-- ─── Duration guard ──────────────────────────────────────────
ALTER TABLE telemetry_events
  ADD CONSTRAINT duration_reasonable
  CHECK (duration_s IS NULL OR (duration_s >= 0 AND duration_s <= 86400));

-- ─── Indexes for fingerprint joins + source filtering ────────
CREATE INDEX idx_update_checks_fingerprint ON update_checks (install_fingerprint);
CREATE INDEX idx_telemetry_fingerprint ON telemetry_events (install_fingerprint);
CREATE INDEX idx_update_checks_source ON update_checks (source) WHERE source = 'live';
CREATE INDEX idx_telemetry_source ON telemetry_events (source) WHERE source = 'live';

-- ─── Recreate crash_clusters with source filter ──────────────
DROP VIEW IF EXISTS crash_clusters;
CREATE VIEW crash_clusters AS
SELECT
  error_class,
  gstack_version,
  COUNT(*) as total_occurrences,
  COUNT(DISTINCT install_fingerprint) as identified_users,
  COUNT(*) - COUNT(install_fingerprint) as anonymous_occurrences,
  MIN(event_timestamp) as first_seen,
  MAX(event_timestamp) as last_seen
FROM telemetry_events
WHERE outcome = 'error' AND error_class IS NOT NULL
  AND (source = 'live' OR source IS NULL)
GROUP BY error_class, gstack_version
ORDER BY total_occurrences DESC;

-- ─── Recreate skill_sequences with source filter ─────────────
DROP VIEW IF EXISTS skill_sequences;
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
  AND (a.source = 'live' OR a.source IS NULL)
  AND (b.source = 'live' OR b.source IS NULL)
GROUP BY a.skill, b.skill
HAVING COUNT(DISTINCT a.session_id) >= 10
ORDER BY co_occurrences DESC;

-- ─── Growth views ────────────────────────────────────────────

-- Daily active installs (materialized for dashboard perf)
CREATE MATERIALIZED VIEW daily_active_installs AS
SELECT DATE(checked_at) as day,
       COUNT(DISTINCT install_fingerprint) as unique_installs,
       COUNT(*) as total_pings
FROM update_checks
WHERE source = 'live' OR source IS NULL
GROUP BY DATE(checked_at)
ORDER BY day DESC;

-- Version adoption velocity (materialized)
CREATE MATERIALIZED VIEW version_adoption AS
SELECT DATE(checked_at) as day,
       gstack_version,
       COUNT(DISTINCT install_fingerprint) as unique_installs
FROM update_checks
WHERE source = 'live' OR source IS NULL
GROUP BY DATE(checked_at), gstack_version
ORDER BY day DESC;

-- Growth funnel: first-seen based (not heartbeat-based)
CREATE VIEW growth_funnel AS
WITH first_seen AS (
  SELECT install_fingerprint, MIN(checked_at) as first_check
  FROM update_checks
  WHERE install_fingerprint IS NOT NULL AND (source = 'live' OR source IS NULL)
  GROUP BY install_fingerprint
)
SELECT
  DATE(fs.first_check) as install_day,
  COUNT(DISTINCT fs.install_fingerprint) as installs,
  COUNT(DISTINCT CASE WHEN te.event_timestamp IS NOT NULL THEN fs.install_fingerprint END) as activated,
  COUNT(DISTINCT CASE WHEN uc2.checked_at IS NOT NULL THEN fs.install_fingerprint END) as retained_7d
FROM first_seen fs
LEFT JOIN telemetry_events te
  ON fs.install_fingerprint = te.install_fingerprint
  AND te.event_timestamp BETWEEN fs.first_check AND fs.first_check + INTERVAL '24 hours'
  AND te.event_type = 'skill_run'
  AND (te.source = 'live' OR te.source IS NULL)
LEFT JOIN update_checks uc2
  ON fs.install_fingerprint = uc2.install_fingerprint
  AND uc2.checked_at BETWEEN fs.first_check + INTERVAL '7 days' AND fs.first_check + INTERVAL '14 days'
WHERE fs.install_fingerprint IS NOT NULL
GROUP BY DATE(fs.first_check)
ORDER BY install_day DESC;
