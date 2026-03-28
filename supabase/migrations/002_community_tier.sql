-- gstack community tier schema
-- Adds authenticated backup, benchmarks, email, and richer error telemetry.

-- Add error context columns to telemetry_events
ALTER TABLE telemetry_events ADD COLUMN error_message TEXT;
ALTER TABLE telemetry_events ADD COLUMN failed_step TEXT;

-- Add columns to installations for backup + email + auth identity
ALTER TABLE installations ADD COLUMN user_id UUID UNIQUE;
ALTER TABLE installations ADD COLUMN email TEXT;
ALTER TABLE installations ADD COLUMN config_snapshot JSONB;
ALTER TABLE installations ADD COLUMN analytics_snapshot JSONB;
ALTER TABLE installations ADD COLUMN retro_history JSONB;
ALTER TABLE installations ADD COLUMN last_backup_at TIMESTAMPTZ;
ALTER TABLE installations ADD COLUMN backup_version INTEGER DEFAULT 0;

-- RLS: authenticated users can read/write their own installation row
CREATE POLICY "auth_read_own" ON installations
  FOR SELECT USING (
    (select auth.uid()) IS NOT NULL AND user_id = (select auth.uid())
  );
CREATE POLICY "auth_write_own" ON installations
  FOR INSERT WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "auth_update_own" ON installations
  FOR UPDATE USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- Community benchmarks (computed by edge function, cached)
CREATE TABLE community_benchmarks (
  skill TEXT PRIMARY KEY,
  median_duration_s NUMERIC,
  p25_duration_s NUMERIC,
  p75_duration_s NUMERIC,
  total_runs BIGINT,
  success_rate NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE community_benchmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_select" ON community_benchmarks FOR SELECT USING (true);
CREATE POLICY "service_upsert" ON community_benchmarks FOR ALL
  USING ((select auth.role()) = 'service_role')
  WITH CHECK ((select auth.role()) = 'service_role');
