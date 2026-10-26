/**
 * The variables gbrain reads to choose which brain it connects to:
 * GBRAIN_DATABASE_URL (always honored), DATABASE_URL (its fallback),
 * GBRAIN_DIRECT_DATABASE_URL (the direct-pool override for DDL and bulk
 * writes), and GBRAIN_HOME (which config.json it reads).
 *
 * Test runs drop them (createShardSandbox, test-setup.ts) so a developer's
 * exported brain URL never reaches a real `gbrain` spawned by a test: without
 * a gbrain config under the temp HOME, buildGbrainEnv passes the inherited
 * URL through and the test writes pages and sources into the live brain.
 *
 * Dependency-free on purpose: the shard engine imports it, and fixtures copy
 * the engine's imports into scratch checkouts.
 */
export const LIVE_BRAIN_ENV_KEYS = [
  'GBRAIN_DATABASE_URL',
  'GBRAIN_DIRECT_DATABASE_URL',
  'DATABASE_URL',
  'GBRAIN_HOME',
] as const;

/** A copy of `env` without LIVE_BRAIN_ENV_KEYS. */
export function withoutLiveBrainEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of LIVE_BRAIN_ENV_KEYS) delete out[key];
  return out;
}
