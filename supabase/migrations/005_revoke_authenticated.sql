-- 005_revoke_authenticated.sql
-- gstack never uses Supabase Auth, so a signed-in user (the `authenticated`
-- role) must reach nothing. Supabase's default grants give `authenticated`
-- the same table privileges as `anon`, and views run as their owner, so
-- RLS does not protect them: migration 002 revoked crash_clusters and
-- skill_sequences from anon only. On 2026-11-19 someone signed up through the
-- public Auth endpoint, so this closes that path.
--
-- This mirrors the lockdown applied to the live project on 2026-11-19, and
-- also makes both views security_invoker so they read with the caller's
-- privileges and RLS instead of their owner's. 008 closes anon's write path.

BEGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
REVOKE ALL ON public.crash_clusters, public.skill_sequences FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
ALTER VIEW public.crash_clusters SET (security_invoker = true);
ALTER VIEW public.skill_sequences SET (security_invoker = true);
COMMIT;

-- The lines above change the running role's defaults only. Objects that
-- supabase_admin creates later still default to granting `authenticated`.
-- Only a member of supabase_admin can change that; on the hosted project the
-- migration role (postgres) is not one, so this says so and moves on.
DO $$
BEGIN
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
EXCEPTION
  WHEN insufficient_privilege OR undefined_object THEN
    RAISE NOTICE 'supabase_admin default privileges unchanged (%): objects it creates later still grant authenticated', SQLERRM;
END
$$;

-- Postgres also grants EXECUTE on every new function to PUBLIC, which
-- `authenticated` inherits, and the default-privilege line above does not
-- remove that. Every function a later migration adds must therefore
-- `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` itself (006 does).
