/**
 * Conductor host detection — single source of truth for TS consumers.
 *
 * Conductor (the Mac app that runs many coding agents in parallel) sets
 * CONDUCTOR_WORKSPACE_PATH / CONDUCTOR_PORT in the session env. The same two
 * vars are what `bin/gstack-session-kind` keys on (it collapses Conductor into
 * `interactive`, so it can't be reused to distinguish Conductor specifically —
 * hence this dedicated helper).
 *
 * IMPORTANT: detection is a CALL-TIME read of the passed-in env (default
 * `process.env`), never a module-load-time snapshot. ESM hoists static imports
 * above any in-file `process.env.X = ...`, so a load-time read can't be pinned
 * by a test without Bun --preload. Reading at call time lets unit tests set
 * `process.env.CONDUCTOR_WORKSPACE_PATH` inline before invoking. See the
 * `esm-hoist-breaks-env-pin-bootstrap` learning.
 */
export function isConductor(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.CONDUCTOR_WORKSPACE_PATH || env.CONDUCTOR_PORT);
}
