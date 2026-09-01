/**
 * Tests for bin/gstack-update-check bash script.
 *
 * Uses Bun.spawnSync to invoke the script with temp dirs and
 * GSTACK_DIR / GSTACK_STATE_DIR / GSTACK_REMOTE_URL env overrides
 * for full isolation.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import * as fs from 'fs';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(import.meta.dir, '..', '..', 'bin', 'gstack-update-check');
const ROOT = join(import.meta.dir, '..', '..');

// Shared per-file scratch root. Windows free-tests exclude bash-spawn tests,
// but mkdtemp cleanup uses force anyway; the tmpdir location keeps POSIX CI
// and macOS dev boxes on the same hermetic path (os.tmpdir(), never /tmp).
const tmpRoot = mkdtempSync(join(tmpdir(), 'gstack-upd-clock-'));

let gstackDir: string;
let stateDir: string;

function run(extraEnv: Record<string, string> = {}, args: string[] = []) {
  // gstack-config (which this script shells out to for update_check) resolves
  // state as GSTACK_STATE_ROOT > GSTACK_HOME > GSTACK_STATE_DIR > ~/.gstack.
  // Strip the higher-precedence vars so harness-env leftovers can never
  // outrank the per-test GSTACK_STATE_DIR isolation.
  const env: Record<string, string | undefined> = {
    ...process.env,
    GSTACK_DIR: gstackDir,
    GSTACK_STATE_DIR: stateDir,
    GSTACK_REMOTE_URL: `file://${join(gstackDir, 'REMOTE_VERSION')}`,
  };
  delete env.GSTACK_STATE_ROOT;
  delete env.GSTACK_HOME;
  Object.assign(env, extraEnv); // per-test overrides always win, deliberately
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

beforeEach(() => {
  gstackDir = mkdtempSync(join(tmpdir(), 'gstack-upd-test-'));
  stateDir = mkdtempSync(join(tmpdir(), 'gstack-state-test-'));
  // Link real gstack-config so update_check config check works
  const binDir = join(gstackDir, 'bin');
  mkdirSync(binDir);
  symlinkSync(join(import.meta.dir, '..', '..', 'bin', 'gstack-config'), join(binDir, 'gstack-config'));
  // v1.63+: the script sources bin/gstack-egress-lib.sh unconditionally
  // (receipted fetch helpers). A real install always has it beside
  // gstack-config; without this link every test failed at the source line —
  // masked until the suite-truncation fix because the runner died first.
  symlinkSync(
    join(import.meta.dir, '..', '..', 'bin', 'gstack-egress-lib.sh'),
    join(binDir, 'gstack-egress-lib.sh'),
  );
});

afterEach(() => {
  rmSync(gstackDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function writeSnooze(version: string, level: number, epochSeconds: number) {
  writeFileSync(join(stateDir, 'update-snoozed'), `${version} ${level} ${epochSeconds}`);
}

function writeConfig(content: string) {
  writeFileSync(join(stateDir, 'config.yaml'), content);
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

describe('gstack-update-check', () => {
  // ─── Path A: No VERSION file ────────────────────────────────
  test('exits 0 with no output when VERSION file is missing', () => {
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path B: Empty VERSION file ─────────────────────────────
  test('exits 0 with no output when VERSION file is empty', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '');
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path C: Just-upgraded marker ───────────────────────────
  test('outputs JUST_UPGRADED and deletes marker', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    // Marker should be deleted
    expect(existsSync(join(stateDir, 'just-upgraded-from'))).toBe(false);
    // Cache should be written
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path C2: Just-upgraded marker + newer remote ──────────
  test('just-upgraded marker does not mask newer remote version', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.5.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    // Should output both the just-upgraded notice AND the new upgrade
    expect(stdout).toContain('JUST_UPGRADED 0.3.3 0.4.0');
    expect(stdout).toContain('UPGRADE_AVAILABLE 0.4.0 0.5.0');
    // Cache should reflect the upgrade available, not UP_TO_DATE
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UPGRADE_AVAILABLE 0.4.0 0.5.0');
  });

  // ─── Path C3: Just-upgraded marker + remote matches local ──
  test('just-upgraded with no further updates writes UP_TO_DATE cache', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path D1: Fresh cache, UP_TO_DATE ───────────────────────
  test('exits silently when cache says UP_TO_DATE and is fresh', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 0.3.3');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path D1b: Fresh UP_TO_DATE cache, but local version changed ──
  test('re-checks when UP_TO_DATE cache version does not match local', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    // Cache says UP_TO_DATE for 0.3.3, but local is now 0.4.0
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 0.3.3');
    // Remote says 0.5.0 — should detect upgrade
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.5.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.4.0 0.5.0');
  });

  // ─── Path D2: Fresh cache, UPGRADE_AVAILABLE ────────────────
  test('echoes cached UPGRADE_AVAILABLE when cache is fresh', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── Path D3: Fresh cache, but local version changed ────────
  test('re-checks when local version does not match cached old version', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    // Cache says 0.3.3 → 0.4.0 but we're already on 0.4.0
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    // Remote also says 0.4.0 — should be up to date
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(''); // Up to date after re-check
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path E: Versions match (remote fetch) ─────────────────
  test('writes UP_TO_DATE cache when versions match', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path F: Versions differ (remote fetch) ─────────────────
  test('outputs UPGRADE_AVAILABLE when versions differ', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── Path G: Invalid remote response ────────────────────────
  test('treats invalid remote response as up to date', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '<html>404 Not Found</html>\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path H: Curl fails (bad URL) ──────────────────────────
  test('exits silently when remote URL is unreachable', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run({
      GSTACK_REMOTE_URL: 'file:///nonexistent/path/VERSION',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path I: Corrupt cache file ─────────────────────────────
  test('falls through to remote fetch when cache is corrupt', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'garbage data here');
    // Remote says same version — should end up UP_TO_DATE
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // Cache should be overwritten with valid content
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── State dir creation ─────────────────────────────────────
  test('creates state dir if it does not exist', () => {
    const newStateDir = join(stateDir, 'nested', 'dir');
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode } = run({ GSTACK_STATE_DIR: newStateDir });
    expect(exitCode).toBe(0);
    expect(existsSync(join(newStateDir, 'last-update-check'))).toBe(true);
  });

  // ─── E2E regression: always exit 0 ───────────────────────────
  // Agents call this on every skill invocation. Exit code 1 breaks
  // the preamble and confuses the agent. This test guards against
  // regressions like the "exits 1 when up to date" bug.
  test('exits 0 with real project VERSION and unreachable remote', () => {
    // Simulate agent context: real VERSION file, network unavailable
    const projectRoot = join(import.meta.dir, '..', '..');
    const versionFile = join(projectRoot, 'VERSION');
    if (!existsSync(versionFile)) return; // skip if no VERSION
    const version = readFileSync(versionFile, 'utf-8').trim();

    // Copy VERSION into test dir
    writeFileSync(join(gstackDir, 'VERSION'), version + '\n');

    // Remote is unreachable (simulates offline / CI / sandboxed agent)
    const { exitCode, stdout } = run({
      GSTACK_REMOTE_URL: 'file:///nonexistent/path/VERSION',
    });
    expect(exitCode).toBe(0);
    // Should write UP_TO_DATE cache (not crash)
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  test('exits 0 when up to date (not exit 1)', () => {
    // Regression test: script previously exited 1 when versions matched.
    // This broke every skill preamble that called it without || true.
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    // First call: fetches remote, writes cache
    const first = run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe('');

    // Second call: reads fresh cache
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe('');

    // Third call with upgrade available: still exit 0
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    rmSync(join(stateDir, 'last-update-check')); // force re-fetch
    const third = run();
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── Snooze tests ───────────────────────────────────────────
  test('snoozed level 1 within 24h → silent (cached path)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 1, nowEpoch() - 3600); // 1h ago (within 24h)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 1 expired (25h ago) → outputs UPGRADE_AVAILABLE', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 1, nowEpoch() - 90000); // 25h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snoozed level 2 within 48h → silent', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 2, nowEpoch() - 86400); // 24h ago (within 48h)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 2 expired (49h ago) → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 2, nowEpoch() - 176400); // 49h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snoozed level 3 within 7d → silent', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 3, nowEpoch() - 518400); // 6d ago (within 7d)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 3 expired (8d ago) → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 3, nowEpoch() - 691200); // 8d ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snooze ignored when version differs (new version resets snooze)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.5.0');
    // Snoozed for 0.4.0, but remote is now 0.5.0
    writeSnooze('0.4.0', 3, nowEpoch() - 60); // very recent

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.5.0');
  });

  test('corrupt snooze file → outputs normally', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeFileSync(join(stateDir, 'update-snoozed'), 'garbage');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('non-numeric epoch in snooze file → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeFileSync(join(stateDir, 'update-snoozed'), '0.4.0 1 abc');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('non-numeric level in snooze file → outputs', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeFileSync(join(stateDir, 'update-snoozed'), `0.4.0 abc ${nowEpoch()}`);

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snooze respected on remote fetch path (no cache)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    // No cache file — goes to remote fetch path
    writeSnooze('0.4.0', 1, nowEpoch() - 3600); // 1h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // Cache should still be written
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('just-upgraded clears snooze file', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeSnooze('0.4.0', 2, nowEpoch() - 3600);

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    expect(existsSync(join(stateDir, 'update-snoozed'))).toBe(false);
  });

  // ─── Config tests ──────────────────────────────────────────
  test('update_check: false disables all checks', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeConfig('update_check: false\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // No cache should be written
    expect(existsSync(join(stateDir, 'last-update-check'))).toBe(false);
  });

  test('missing config.yaml does not crash', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    // No config file — should behave normally

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── --force flag tests ──────────────────────────────────────

  test('--force busts fresh UP_TO_DATE cache', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 0.3.3');

    // Without --force: cache hit, silent
    const cached = run();
    expect(cached.stdout).toBe('');

    // With --force: cache busted, re-fetches, finds upgrade
    const forced = run({}, ['--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('--force busts fresh UPGRADE_AVAILABLE cache', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');

    // Without --force: cache hit, outputs stale upgrade
    const cached = run();
    expect(cached.stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');

    // With --force: cache busted, re-fetches, now up to date
    const forced = run({}, ['--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  test('--force clears snooze so user can upgrade after snoozing', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeSnooze('0.4.0', 1, nowEpoch() - 60); // snoozed 1 min ago (within 24h)

    // Without --force: snoozed, silent
    const snoozed = run();
    expect(snoozed.exitCode).toBe(0);
    expect(snoozed.stdout).toBe('');

    // With --force: snooze cleared, outputs upgrade
    const forced = run({}, ['--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
    // Snooze file should be deleted
    expect(existsSync(join(stateDir, 'update-snoozed'))).toBe(false);
  });

  // ─── Split TTL tests ─────────────────────────────────────────

  // ─── Semver-order guard ─────────────────────────────────────
  // When the upstream raw CDN serves a stale (older) VERSION right after a
  // release, the script previously emitted a backwards UPGRADE_AVAILABLE
  // line. The guard treats REMOTE < LOCAL as up-to-date.

  test('remote older than local (stale CDN) → silent, cache UP_TO_DATE', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.34.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.33.2.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE 1.34.0.0');
  });

  test('multi-segment sort: 1.9.0.0 < 1.10.0.0', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.9.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.10.0.0\n');

    const { stdout } = run();
    expect(stdout).toBe('UPGRADE_AVAILABLE 1.9.0.0 1.10.0.0');
  });

  test('multi-segment reverse sort: 1.10.0.0 > 1.9.0.0 → no rewind', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1.10.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.9.0.0\n');

    const { stdout } = run();
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE 1.10.0.0');
  });

  test('UP_TO_DATE cache expires after 60 min (not 720)', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 0.3.3');

    // Set cache mtime to 90 minutes ago (past 60-min TTL)
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000);
    const cachePath = join(stateDir, 'last-update-check');
    utimesSync(cachePath, ninetyMinAgo, ninetyMinAgo);

    // Cache should be stale at 60-min TTL, re-fetches and finds upgrade
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });
});

// ─── Commit-clock cross-check (#2378) ─────────────────────────
//
// update-check decides "current?" on VERSION strings, but /gstack-upgrade
// installs origin/main HEAD. Between releases the two agree while main moves,
// and a merge that bypasses the VERSION bump makes that window permanent —
// installs sit silently behind, including security fixes. The fix compares
// the remote main SHA (ls-remote / GSTACK_REMOTE_SHA) against the install's
// HEAD and its own origin/main sync ref, and flags only the provably-safe
// state: a pristine git sync of an older main. Every inconclusive state
// (non-git install, no git binary, fork origin, local commits) stays silent
// — the VERSION verdict is untouched.
describe('gstack-update-check commit-clock cross-check (#2378)', () => {
  let gitEnv: Record<string, string>;

  // A local bare "upstream" plus a seed clone for the VERSION file, built
  // once per describe. The fixture install's origin points at the garrytan
  // slug WITHOUT fetching from it: the SHA comes from GSTACK_REMOTE_SHA and
  // the VERSION from a file:// URL, so the whole block is hermetic.
  const upstreamBare = join(tmpRoot, 'uc-clock-upstream.git');
  const seedClone = join(tmpRoot, 'uc-clock-seed');
  const plainDir = join(tmpRoot, 'uc-clock-plain');

  function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  }

  beforeAll(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    git(tmpRoot, 'init', '--bare', '-q', upstreamBare);
    git(tmpRoot, 'clone', '-q', upstreamBare, seedClone);
    git(seedClone, 'config', 'user.email', 'test@example.com');
    git(seedClone, 'config', 'user.name', 'test');
    writeFileSync(join(seedClone, 'VERSION'), '1.60.1.0\n');
    git(seedClone, 'add', 'VERSION');
    git(seedClone, 'commit', '-q', '-m', 'release 1.60.1.0');
    git(seedClone, 'push', '-q', 'origin', 'HEAD:main');
    // plain (non-git) install with the same VERSION and the same bin/ links
    fs.mkdirSync(join(plainDir, 'bin'), { recursive: true });
    writeFileSync(join(plainDir, 'VERSION'), '1.60.1.0\n');
    symlinkSync(join(ROOT, 'bin', 'gstack-config'), join(plainDir, 'bin', 'gstack-config'));
    symlinkSync(join(ROOT, 'bin', 'gstack-egress-lib.sh'), join(plainDir, 'bin', 'gstack-egress-lib.sh'));
  });

  // A pristine install of the CURRENT remote main: origin slug matches
  // REMOTE_REPO, refs/remotes/origin/main exists, HEAD == origin/main.
  function makeInstall(): string {
    const dir = mkdtempSync(join(tmpRoot, 'uc-clock-install-'));
    git(tmpRoot, 'clone', '-q', upstreamBare, dir);
    git(dir, 'remote', 'set-url', 'origin', 'https://github.com/garrytan/gstack.git');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    symlinkSync(join(ROOT, 'bin', 'gstack-config'), join(dir, 'bin', 'gstack-config'));
    symlinkSync(join(ROOT, 'bin', 'gstack-egress-lib.sh'), join(dir, 'bin', 'gstack-egress-lib.sh'));
    return dir;
  }

  // One local commit on the fixture upstream that does NOT bump VERSION —
  // the #2378 scenario. Returns the new remote main SHA.
  function advanceRemoteMain(): string {
    git(seedClone, 'commit', '-q', '--allow-empty', '-m', 'security fix (no VERSION bump)');
    git(seedClone, 'push', '-q', 'origin', 'HEAD:main');
    return git(upstreamBare, 'rev-parse', 'main');
  }

  beforeEach(() => {
    gstackDir = mkdtempSync(join(tmpdir(), 'gstack-upd-test-'));
    stateDir = mkdtempSync(join(tmpdir(), 'gstack-state-test-'));
    const binDir = join(gstackDir, 'bin');
    mkdirSync(binDir);
    symlinkSync(join(import.meta.dir, '..', '..', 'bin', 'gstack-config'), join(binDir, 'gstack-config'));
    symlinkSync(
      join(import.meta.dir, '..', '..', 'bin', 'gstack-egress-lib.sh'),
      join(binDir, 'gstack-egress-lib.sh'),
    );
    // The cross-check needs both the remote SHA and a VERSION source; the
    // fixture seed's VERSION (identical string, never bumped) stands in for
    // the remote raw file so no network is touched.
    gitEnv = {
      GSTACK_REMOTE_URL: `file://${join(seedClone, 'VERSION')}`,
      GSTACK_REMOTE_SHA: git(upstreamBare, 'rev-parse', 'main'),
    };
  });

  afterEach(() => {
    rmSync(gstackDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test('THE BUG: pristine sync, main moved without a VERSION bump → flags even though versions are equal', () => {
    const install = makeInstall();
    advanceRemoteMain(); // upstream is now 1 ahead of the install, VERSION unchanged
    gitEnv.GSTACK_REMOTE_SHA = git(upstreamBare, 'rev-parse', 'main'); // refresh: the check compares against the CURRENT tip
    const { exitCode, stdout } = run(
      { ...gitEnv, GSTACK_DIR: install },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.60.1.0');
    // The flag is cached, so the TTL replay keeps nagging.
    const replay = run({ ...gitEnv, GSTACK_DIR: install });
    expect(replay.stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.60.1.0');
  });

  test('install on remote main HEAD, versions equal → silent', () => {
    const install = makeInstall(); // HEAD == origin/main == GSTACK_REMOTE_SHA
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('install left its sync point (local commits) → silent, VERSION verdict stands', () => {
    const install = makeInstall();
    advanceRemoteMain();
    gitEnv.GSTACK_REMOTE_SHA = git(upstreamBare, 'rev-parse', 'main');
    git(install, 'commit', '-q', '--allow-empty', '-m', 'local experiment');
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // Silent means UP_TO_DATE — the VERSION path is untouched, not the flag.
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  test('non-git install (plain dir) → silent, unchanged behavior', () => {
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: plainDir });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('fork origin (slug mismatch with REMOTE_REPO) while behind → silent', () => {
    const install = makeInstall();
    advanceRemoteMain();
    gitEnv.GSTACK_REMOTE_SHA = git(upstreamBare, 'rev-parse', 'main');
    git(install, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git');
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('after the user upgrades (HEAD moves, VERSION unchanged) the cached flag goes silent', () => {
    const install = makeInstall();
    const sha1 = advanceRemoteMain();
    gitEnv.GSTACK_REMOTE_SHA = git(upstreamBare, 'rev-parse', 'main');
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.60.1.0');
    // Upgrade = ff the install to the new main. VERSION string is identical.
    git(install, 'fetch', '-q', upstreamBare, 'main');
    git(install, 'reset', '-q', '--hard', sha1);
    // Fresh cache TTL (60 min) has NOT expired — only the HEAD moved.
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  test('snooze applies to the same-version flag (level 1, within 24h)', () => {
    const install = makeInstall();
    advanceRemoteMain();
    gitEnv.GSTACK_REMOTE_SHA = git(upstreamBare, 'rev-parse', 'main');
    writeSnooze('1.60.1.0', 1, nowEpoch() - 3600);
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // The flag is still cached — the snooze only silences this replay.
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UPGRADE_AVAILABLE');
  });

  test('expired snooze → the same-version flag prints again', () => {
    const install = makeInstall();
    advanceRemoteMain();
    gitEnv.GSTACK_REMOTE_SHA = git(upstreamBare, 'rev-parse', 'main');
    writeSnooze('1.60.1.0', 1, nowEpoch() - 90000);
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.60.1.0');
  });

  test('JUST_UPGRADED marker + stale install emits both lines', () => {
    const install = makeInstall();
    advanceRemoteMain();
    gitEnv.GSTACK_REMOTE_SHA = git(upstreamBare, 'rev-parse', 'main');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '1.59.0.0\n');
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('JUST_UPGRADED 1.59.0.0 1.60.1.0');
    expect(stdout).toContain('UPGRADE_AVAILABLE 1.60.1.0 1.60.1.0');
  });

  test('GSTACK_REMOTE_URL override alone (no SHA) keeps legacy behavior — cross-check inert', () => {
    const install = makeInstall();
    advanceRemoteMain();
    // Deliberately NO GSTACK_REMOTE_SHA here (delete the beforeEach default):
    // without a remote tip and without ls-remote (URL override active), the
    // cross-check cannot fire. The seed VERSION matches the install, so the
    // legacy verdict is silence.
    const { exitCode, stdout } = run({
      GSTACK_REMOTE_URL: `file://${join(seedClone, 'VERSION')}`,
      GSTACK_DIR: install,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});
