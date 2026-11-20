-- gstack attack telemetry — schema extension for prompt injection events.
--
-- Ships alongside the gstack-telemetry-log `--event-type attack_attempt`
-- flag (bin/gstack-telemetry-log, commits 28ce883c + f68fa4a9). These
-- columns are nullable so the existing skill_run events continue inserting
-- unchanged.
--
-- Fields (1:1 with gstack-telemetry-log flags):
--   security_url_domain   — hostname only, never path/query
--   security_payload_hash — salted SHA-256 hex
--   security_confidence   — 0..1 numeric, clamped client-side
--   security_layer        — stackone_content | testsavant_content
--                           | transcript_classifier | aria_regex | canary
--                           | deberta_content
--   security_verdict      — block | warn | log_only
--
-- Indices:
--   * (security_url_domain, event_timestamp) — for "top domains last 7 days"
--   * (security_layer, event_timestamp) WHERE event_type='attack_attempt'
--     — for layer-distribution queries
--
-- Privacy rules (enforced client-side, documented here):
--   * domain only, never path or query string
--   * payload_hash is a salted hash, not the payload
--   * salt is per-device local file (~/.gstack/security/device-salt) —
--     preventing cross-device rainbow table attacks

-- IF NOT EXISTS: this migration was not applied to the live project until
-- after 006 was written, so it must be safe to run twice. It must run before
-- 006, whose view and function read these columns.
ALTER TABLE telemetry_events
  ADD COLUMN IF NOT EXISTS security_url_domain TEXT,
  ADD COLUMN IF NOT EXISTS security_payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS security_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS security_layer TEXT,
  ADD COLUMN IF NOT EXISTS security_verdict TEXT;

-- Top-domains query: ORDER BY count DESC WHERE event_type='attack_attempt'
-- AND event_timestamp > now() - interval '7 days'
CREATE INDEX IF NOT EXISTS idx_telemetry_attack_domain
  ON telemetry_events (security_url_domain, event_timestamp)
  WHERE event_type = 'attack_attempt';

-- Layer-distribution query
CREATE INDEX IF NOT EXISTS idx_telemetry_attack_layer
  ON telemetry_events (security_layer, event_timestamp)
  WHERE event_type = 'attack_attempt';
