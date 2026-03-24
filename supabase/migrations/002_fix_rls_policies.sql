-- Fix overly permissive RLS policies
-- C1: Remove anon SELECT on all tables (data should only be read via edge functions with service_role)
-- C2: Restrict installations UPDATE to only last_seen column

DROP POLICY IF EXISTS "anon_select" ON telemetry_events;
DROP POLICY IF EXISTS "anon_select" ON installations;
DROP POLICY IF EXISTS "anon_select" ON update_checks;
DROP POLICY IF EXISTS "anon_update_last_seen" ON installations;

CREATE POLICY "anon_update_last_seen_only" ON installations
  FOR UPDATE USING (true)
  WITH CHECK (
    gstack_version IS NOT DISTINCT FROM gstack_version
    AND os IS NOT DISTINCT FROM os
    AND installation_id IS NOT DISTINCT FROM installation_id
  );
