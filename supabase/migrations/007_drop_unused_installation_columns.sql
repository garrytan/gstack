-- 007_drop_unused_installation_columns.sql
-- The live installations table carries seven columns that no migration in
-- this repo defines and no gstack code reads or writes: user_id, email,
-- config_snapshot, analytics_snapshot, retro_history, last_backup_at and
-- backup_version. On 2026-11-19 all seven were empty in all 37,566 rows.
-- An email column has no place in a telemetry table (docs/privacy.md: no
-- personal data), so drop them. The guard refuses if any row holds a value,
-- so this can never delete data; it does nothing where the columns are absent.

DO $$
DECLARE
  col text;
  filled bigint;
BEGIN
  FOREACH col IN ARRAY ARRAY['user_id', 'email', 'config_snapshot', 'analytics_snapshot',
                             'retro_history', 'last_backup_at', 'backup_version'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'installations' AND column_name = col) THEN
      EXECUTE format('SELECT COUNT(*) FROM public.installations WHERE %I IS NOT NULL', col) INTO filled;
      IF filled > 0 THEN
        RAISE EXCEPTION 'installations.% holds % values; refusing to drop it', col, filled;
      END IF;
      EXECUTE format('ALTER TABLE public.installations DROP COLUMN %I', col);
    END IF;
  END LOOP;
END
$$;
