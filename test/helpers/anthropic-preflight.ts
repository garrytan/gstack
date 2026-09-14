/**
 * Anthropic-API preflight ping, shared by e2e-helpers (module load in every
 * paid test file) and the sharded paid runner (once, in the parent).
 *
 * The ping is a real `claude -p` call with a 30s timeout. Before the parent
 * dedup, every one of the ~30 paid test files that import e2e-helpers fired
 * it at module load — 30 paid pings per full sharded run for one bit of
 * information. The sharded runner now pings ONCE and sets
 * EVALS_PREFLIGHT_OK=1 in each shard's env; the module-load path honors the
 * flag and skips.
 *
 * Lives in its own module (not e2e-helpers) so the runner can import it
 * without dragging in bun:test.
 */

import { spawnSync } from 'child_process';

export type PreflightResult = 'skipped' | 'ok';

export function preflightAnthropicApi(
  env: NodeJS.ProcessEnv = process.env,
  spawn: typeof spawnSync = spawnSync,
): PreflightResult {
  if (env.EVALS_PREFLIGHT_OK === '1') return 'skipped';
  const check = spawn(
    'sh',
    ['-c', 'echo "ping" | claude -p --max-turns 1 --output-format stream-json --verbose --dangerously-skip-permissions'],
    { stdio: 'pipe', timeout: 30_000 },
  );
  // Fail fast on the failure modes that guarantee EVERY shard fails too:
  // spawn error (sh/claude unlaunchable), a timeout kill (signal set), or
  // exit 127 (command not found). Anything else stays fail-open — a flaky
  // preflight must not block a run the shards could complete (auth prompts
  // and transient non-zero exits are the shards' problem to report).
  if (check.error) {
    throw new Error(`Anthropic preflight could not run (${check.error.message}) — aborting E2E suite before spawning shards.`);
  }
  if (check.signal) {
    throw new Error(`Anthropic preflight timed out (killed with ${check.signal}) — aborting E2E suite. Check connectivity/auth and retry.`);
  }
  if (check.status === 127) {
    throw new Error('Anthropic preflight: `claude` not found on PATH (exit 127) — aborting E2E suite before spawning shards.');
  }
  const output = check.stdout?.toString() || '';
  if (output.includes('ConnectionRefused') || output.includes('Unable to connect')) {
    throw new Error('Anthropic API unreachable — aborting E2E suite. Fix connectivity and retry.');
  }
  return 'ok';
}
