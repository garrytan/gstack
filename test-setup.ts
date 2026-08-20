/**
 * Global test preload (Bun: `[test] preload` in bunfig.toml).
 *
 * Snapshots `process.env` once at preload time, then restores it after
 * every test. Defends against the recurring pollution class where one
 * test file mutates `process.env.PATH` / `HOME` / etc. and leaks into
 * unrelated subsequent files in the same Bun process — surfaces as
 * `Executable not found in $PATH: "bun"` or `Bun.which('bash')` returning
 * null in tests that have no business touching env.
 *
 * `process.env = X` reassignment does work in Bun (it swaps the underlying
 * proxy), but several test files use the broken pattern of
 * `origEnv = {...process.env}` followed by per-test mutation without a
 * matching restore inside try/finally. Centralizing the safety net here
 * means new tests don't have to remember the dance, and the bug class
 * stays dead.
 */
import { afterEach, beforeAll } from 'bun:test';

// Narrowly restore PATH after every test. Defends against the recurring
// pollution class where one test sets `process.env.PATH = '/test/bin:/usr/bin'`
// to exercise a scrubbed-env fixture and either forgets to restore or uses
// the broken `process.env = origEnv` reassignment, then a downstream test
// (security.test.ts > resolveBashBinary, pair-agent-tunnel-eval, or
// server-no-import-side-effects) sees the wrong PATH and either has
// `Bun.which('bash')` return null or `Bun.spawn(['bun', ...])` ENOENT.
//
// Deliberately narrow: snapshotting + restoring all of process.env breaks
// tests that legitimately set per-file env at module top-level (e.g.,
// domain-skills-storage.test.ts assigns `process.env.GSTACK_HOME` at
// import time so the loaded module reads the test sandbox path on first
// invocation — wiping that on afterEach would route reads at the user's
// real ~/.gstack and the test would assert on the wrong filesystem).
//
// If a future test pollutes a different variable in the same broken way,
// add it to RESTORE_KEYS rather than widening the snapshot scope.
const RESTORE_KEYS = ['PATH', 'Path'] as const;
const baseline: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of RESTORE_KEYS) baseline[k] = process.env[k];
});

afterEach(() => {
  for (const k of RESTORE_KEYS) {
    const want = baseline[k];
    if (want === undefined) {
      if (process.env[k] !== undefined) delete process.env[k];
    } else if (process.env[k] !== want) {
      process.env[k] = want;
    }
  }
});
