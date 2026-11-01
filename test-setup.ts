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
import * as os from 'node:os';
import * as path from 'node:path';
import { LIVE_BRAIN_ENV_KEYS } from './lib/live-brain-env';
import { CAPY_LAUNCH_MARKERS } from './scripts/lib/shard-engine';

// State-root hermeticity (docs/state-root.md). Tests isolate state with
// GSTACK_HOME, but GSTACK_STATE_ROOT and GSTACK_STATE_DIR outrank or join it
// in the chain, so an ambient value from the parent shell would redirect
// every test's state. Strip them before any test module loads. The merged
// privacy keys also read $HOME/.gstack; point that second root at a
// per-process path that is never created (an empty root that leaves no
// residue in fixtures that audit their temp dirs), so a developer's real
// config never changes a result (only the dedicated merge tests unset
// GSTACK_TEST_LEGACY_ROOT).
for (const name of ['GSTACK_STATE_ROOT', 'GSTACK_STATE_DIR']) {
  if (process.env[name] === undefined) continue;
  delete process.env[name];
  process.stderr.write(`test-setup: stripped inherited ${name}; tests isolate state via GSTACK_HOME\n`);
}
// The Capy installer's launch markers (GSTA-99, GSTA-104): a focused `bun test`
// run from a shell that sourced the launch file would hand every product child
// an unattended Capy session it never set up. The shard engine strips the same
// list for the lanes; this reaches direct runs too.
for (const name of CAPY_LAUNCH_MARKERS) delete process.env[name];
// A developer's exported brain URL: tests spread process.env into the bins
// they spawn, and a real gbrain on PATH would write test pages and sources
// into that live brain. Children spawned without `env:` still get the
// startup env in Bun; the shard sandbox (createShardSandbox) covers those.
for (const name of LIVE_BRAIN_ENV_KEYS) {
  if (process.env[name] === undefined) continue;
  delete process.env[name];
  process.stderr.write(`test-setup: stripped inherited ${name}; tests must not reach a live gbrain\n`);
}
process.env.GSTACK_TEST_LEGACY_ROOT = path.join(os.tmpdir(), `gstack-test-legacy-root-${process.pid}-${Date.now()}-unused`);
// Workflow leases (bin/gstack-lease) default to the installation's git dir;
// for the dev checkout under test that is this repo's .git, and a live test
// runner's lease would make `bin/gstack-upgrade` here refuse UPGRADE_BUSY.
// Every spawned bin inherits a per-process scratch lease directory instead.
process.env.GSTACK_LEASE_DIR ??= path.join(os.tmpdir(), `gstack-test-leases-${process.pid}`);

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
