-- 006_live_traffic_and_pulse_summary.sql
-- Separates real use from test traffic and moves community-pulse's counting
-- into SQL.
--
-- Why: until v1.86.0.0 test/telemetry.test.ts posted to this project, and
-- older checkouts still do when their tests run; about 41% of skill_run rows
-- to 2026-11-19 carry test-fixture session ids (`a-1`, `inj-3`, ...). The
-- community-pulse function also counted only the first 1,000 rows of a week
-- and reported update-check rows as "weekly active".
--
-- What counts as live (telemetry_live_events):
--   * source is 'live' (rows from before this column default to 'live'),
--   * a numeric gstack version other than 0.0.0 (probes used 0.0.0-*),
--   * an event type the ingest function accepts, and
--   * for skill_run, a session id in the shape bin/gstack-skill-start mints
--     (<pid>-<epoch> or <pid>-<epoch>-<suffix>); for upgrade_prompted, the
--     shape bin/gstack-update-check mints (update-<pid>-<epoch>).
--

ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_telemetry_received_at ON telemetry_events (received_at);

CREATE OR REPLACE VIEW telemetry_live_events WITH (security_invoker = true) AS
SELECT *
FROM telemetry_events
WHERE source = 'live'
  AND gstack_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$'
  AND gstack_version NOT LIKE '0.0.0%'
  AND event_type IN ('skill_run', 'upgrade_prompted', 'upgrade_completed', 'onboarding',
                     'first_task_scaffold_shown', 'handoff', 'route', 'attack_attempt')
  AND (
    (event_type = 'skill_run' AND session_id ~ '^[0-9]+-[0-9]+(-[0-9A-Za-z]+)?$')
    OR (event_type = 'upgrade_prompted' AND session_id ~ '^update-[0-9]+-[0-9]+$')
    OR event_type NOT IN ('skill_run', 'upgrade_prompted')
  );

REVOKE ALL ON telemetry_live_events FROM PUBLIC, anon, authenticated;

-- Same columns as 001's view; it now reads live rows only.
CREATE OR REPLACE VIEW crash_clusters WITH (security_invoker = true) AS
SELECT
  error_class,
  gstack_version,
  COUNT(*) as total_occurrences,
  COUNT(DISTINCT installation_id) as identified_users,
  COUNT(*) - COUNT(installation_id) as anonymous_occurrences,
  MIN(event_timestamp) as first_seen,
  MAX(event_timestamp) as last_seen
FROM telemetry_live_events
WHERE outcome = 'error' AND error_class IS NOT NULL
GROUP BY error_class, gstack_version
ORDER BY total_occurrences DESC;

REVOKE ALL ON crash_clusters FROM PUBLIC, anon, authenticated;

-- One call returns everything community-pulse shows, counted over every live
-- row of the last 7 days (by server receive time). weekly_active is distinct
-- community-tier installs that ran a skill; anonymous-tier use has no id and
-- is not in it. Attack domains and layers need 5 distinct installs (k-anonymity).
CREATE OR REPLACE FUNCTION community_pulse_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH week AS (
  SELECT * FROM telemetry_live_events WHERE received_at >= now() - interval '7 days'
),
prev AS (
  SELECT * FROM telemetry_live_events
  WHERE received_at >= now() - interval '14 days' AND received_at < now() - interval '7 days'
),
runs AS (
  SELECT * FROM week WHERE event_type = 'skill_run' AND skill IS NOT NULL AND skill NOT LIKE '\_%'
),
active AS (
  SELECT
    (SELECT COUNT(DISTINCT installation_id) FROM runs) AS this_week,
    (SELECT COUNT(DISTINCT installation_id) FROM prev
      WHERE event_type = 'skill_run' AND skill IS NOT NULL AND skill NOT LIKE '\_%') AS last_week
),
attacks AS (
  SELECT * FROM week WHERE event_type = 'attack_attempt'
)
SELECT jsonb_build_object(
  'weekly_active', (SELECT this_week FROM active),
  'change_pct', (SELECT CASE WHEN last_week > 0
                   THEN round(((this_week - last_week)::numeric / last_week) * 100)::int
                   ELSE 0 END FROM active),
  'weekly_update_checks', (
    SELECT COUNT(*) FROM update_checks
    WHERE checked_at >= now() - interval '7 days'
      AND gstack_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$'
      AND gstack_version NOT LIKE '0.0.0%'
  ),
  'top_skills', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('skill', skill, 'count', n) ORDER BY n DESC, skill)
    FROM (SELECT skill, COUNT(*) AS n FROM runs GROUP BY skill ORDER BY n DESC, skill LIMIT 10) t
  ), '[]'::jsonb),
  'crashes', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'error_class', error_class, 'gstack_version', gstack_version,
      'total_occurrences', total_occurrences, 'identified_users', identified_users))
    FROM (SELECT * FROM crash_clusters LIMIT 5) t
  ), '[]'::jsonb),
  'versions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('version', gstack_version, 'count', n) ORDER BY n DESC, gstack_version)
    FROM (SELECT gstack_version, COUNT(*) AS n FROM runs GROUP BY gstack_version
          ORDER BY n DESC, gstack_version LIMIT 5) t
  ), '[]'::jsonb),
  'security', jsonb_build_object(
    'attacks_last_7_days', (SELECT COUNT(*) FROM attacks),
    'top_attack_domains', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('domain', security_url_domain, 'count', n) ORDER BY n DESC, security_url_domain)
      FROM (SELECT security_url_domain, COUNT(*) AS n FROM attacks
            WHERE security_url_domain IS NOT NULL
            GROUP BY security_url_domain
            HAVING COUNT(DISTINCT installation_id) >= 5
            ORDER BY n DESC, security_url_domain LIMIT 10) t
    ), '[]'::jsonb),
    'top_attack_layers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('layer', security_layer, 'count', n) ORDER BY n DESC, security_layer)
      FROM (SELECT security_layer, COUNT(*) AS n FROM attacks
            WHERE security_layer IS NOT NULL
            GROUP BY security_layer
            HAVING COUNT(DISTINCT installation_id) >= 5) t
    ), '[]'::jsonb),
    'verdict_distribution', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('verdict', security_verdict, 'count', n) ORDER BY n DESC, security_verdict)
      FROM (SELECT security_verdict, COUNT(*) AS n FROM attacks
            WHERE security_verdict IS NOT NULL GROUP BY security_verdict) t
    ), '[]'::jsonb)
  )
);
$$;

REVOKE EXECUTE ON FUNCTION community_pulse_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION community_pulse_summary() TO service_role;
