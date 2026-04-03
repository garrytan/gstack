-- 004_screenshot_storage.sql
-- PR screenshot storage + device code auth for CLI → web auth flow

-- ─── Storage bucket (PRIVATE — proxy adds watermark) ─────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('pr-screenshots', 'pr-screenshots', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: authenticated users upload to their own prefix
CREATE POLICY "auth_upload_own_prefix" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pr-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Storage RLS: service_role reads (proxy fetches via service key)
-- No public read — raw images must go through watermark proxy
CREATE POLICY "service_read_screenshots" ON storage.objects
  FOR SELECT TO service_role
  USING (bucket_id = 'pr-screenshots');

-- Storage RLS: authenticated users can delete their own uploads
CREATE POLICY "auth_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'pr-screenshots' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ─── Screenshots metadata table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS screenshots (
  id TEXT PRIMARY KEY,              -- 8-char nanoid
  user_id UUID NOT NULL REFERENCES auth.users(id),
  storage_path TEXT NOT NULL,       -- path in pr-screenshots bucket
  repo_slug TEXT NOT NULL,          -- slugified repo name
  branch TEXT NOT NULL,             -- slugified branch name
  viewport TEXT,                    -- e.g. 'mobile', 'tablet', 'desktop'
  pr_number INTEGER,               -- populated after PR creation
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_screenshots_user ON screenshots(user_id);
CREATE INDEX idx_screenshots_repo_branch ON screenshots(repo_slug, branch);

-- RLS on screenshots: auth insert own, public read metadata, auth delete own
ALTER TABLE screenshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_insert_own_screenshots" ON screenshots
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "public_read_screenshots" ON screenshots
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "auth_delete_own_screenshots" ON screenshots
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ─── Device codes table (RFC 8628 pattern) ───────────────────────
CREATE TABLE IF NOT EXISTS device_codes (
  code TEXT PRIMARY KEY,            -- server-generated device code
  device_secret TEXT NOT NULL,      -- PKCE-like secret for verification
  user_code TEXT NOT NULL,          -- short human-readable code (e.g. ABCD-1234)
  user_id UUID REFERENCES auth.users(id), -- NULL until user approves
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | expired
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL   -- 10 minutes from creation
);

-- Index for polling (CLI polls by device_code + secret)
CREATE INDEX idx_device_codes_status ON device_codes(code, status);

-- RLS: service_role only (all access goes through API routes)
ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_only_device_codes" ON device_codes
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── Cleanup: expired device codes + orphan screenshots ──────────
-- Delete expired device codes (> 15 minutes old, generous buffer over 10min expiry)
-- Delete orphan screenshots (no PR number after 24h)
-- Run via pg_cron if available, otherwise manual/API trigger
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'cleanup_device_codes',
      '*/15 * * * *',  -- every 15 minutes
      $$DELETE FROM device_codes WHERE expires_at < now() - interval '5 minutes'$$
    );
    PERFORM cron.schedule(
      'cleanup_orphan_screenshots',
      '0 */6 * * *',  -- every 6 hours
      $$DELETE FROM screenshots WHERE pr_number IS NULL AND created_at < now() - interval '24 hours'$$
    );
  END IF;
END $$;
