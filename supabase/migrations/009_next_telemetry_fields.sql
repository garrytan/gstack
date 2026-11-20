-- 009_next_telemetry_fields.sql
-- The next telemetry fields (docs/privacy.md, "What each skill run sends"),
-- approved by Garry on 2026-11-19. Every new column is nullable and holds a
-- pick from a fixed list, a random 16-hex agent-session id or a version: no
-- free text. telemetry-ingest and bin/gstack-telemetry-log enforce the same
-- lists; the CHECKs here are the last line.
--
-- Deploy order (each step only after the one before it):
--   1. PR #4537's telemetry-ingest and migrations 004-006 and 008 (done live
--      2026-11-19; 007 waits for this PR and is applied after step 4),
--   2. this migration,
--   3. this PR's telemetry-ingest (it writes these columns; deployed before
--      step 2, every insert fails and telemetry stalls until step 2 lands),
--   4. the client release. Clients are safe in any order: an older ingest
--      ignores keys it does not know.

ALTER TABLE telemetry_events
  ADD COLUMN IF NOT EXISTS host TEXT CHECK (host IN ('claude_code', 'codex', 'cursor', 'openclaw',
    'hermes', 'other', 'unknown')),
  ADD COLUMN IF NOT EXISTS model_family TEXT CHECK (model_family IN ('claude_opus', 'claude_sonnet',
    'claude_haiku', 'claude_other', 'gpt', 'gemini', 'other', 'unknown')),
  ADD COLUMN IF NOT EXISTS invoked TEXT CHECK (invoked IN ('user', 'model', 'chained', 'unknown')),
  ADD COLUMN IF NOT EXISTS exit_reason TEXT CHECK (exit_reason IN ('completed', 'user_stopped', 'blocked',
    'tool_error', 'test_failed', 'context_limit', 'gave_up', 'unknown')),
  ADD COLUMN IF NOT EXISTS checks TEXT CHECK (checks IN ('passed', 'failed', 'not_run', 'unknown')),
  ADD COLUMN IF NOT EXISTS routing TEXT CHECK (routing IN ('none', 'block', 'hooks', 'both', 'unknown')),
  ADD COLUMN IF NOT EXISTS harness_session_id TEXT CHECK (harness_session_id ~ '^[0-9a-f]{16}$'),
  ADD COLUMN IF NOT EXISTS from_version TEXT CHECK (from_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$'),
  ADD COLUMN IF NOT EXISTS upgrade_error TEXT CHECK (upgrade_error IN ('none', 'refused_dirty', 'busy',
    'fetch_failed', 'setup_failed', 'other', 'unknown')),
  ADD COLUMN IF NOT EXISTS outcome_raw TEXT;

-- Skill sequences and reruns are counted per agent session on the server.
CREATE INDEX IF NOT EXISTS idx_telemetry_harness_session
  ON telemetry_events (harness_session_id, event_timestamp)
  WHERE harness_session_id IS NOT NULL;

-- A view's SELECT * is fixed when it is created, so recreate 006's live view
-- (same filter) to carry the new columns.
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

-- On the hosted project, objects postgres creates give service_role no SELECT
-- by default, so the pulse function (security invoker, called with the
-- service-role key) needs these explicitly. Applied live with 006 on 2026-11-19.
REVOKE ALL ON telemetry_live_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON telemetry_live_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON community_pulse_cache TO service_role;
