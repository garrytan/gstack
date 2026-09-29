/**
 * Tests for bin/gstack-update-check bash script.
 *
 * Uses Bun.spawnSync to invoke the script with temp dirs and
 * GSTACK_DIR / GSTACK_STATE_DIR / GSTACK_REMOTE_URL env overrides
 * for full isolation.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(import.meta.dir, '..', '..', 'bin', 'gstack-update-check');
const ROOT = join(import.meta.dir, '..', '..');

// Shared per-file scratch root, removed in afterAll. Everything the
// commit-clock block creates goes UNDER a per-test fixtureRoot inside this,
// so afterEach reclaims the git clones and afterAll reclaims the root itself.
const tmpRoot = mkdtempSync(join(tmpdir(), 'gstack-upd-clock-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let gstackDir: string;
let stateDir: string;

function run(extraEnv: Record<string, string> = {}, args: string[] = []) {
  // gstack-config (which this script shells out to for update_check) resolves
  // state as GSTACK_STATE_ROOT > GSTACK_HOME > GSTACK_STATE_DIR > ~/.gstack.
  // Strip the higher-precedence vars so harness-env leftovers can never
  // outrank the per-test GSTACK_STATE_DIR isolation. GSTACK_REMOTE_SHA and
  // GSTACK_REMOTE_REPO are stripped for the same reason: the tests that
  // assert "no remote SHA supplied" only mean anything if the ambient env
  // cannot supply one.
  const env: Record<string, string | undefined> = {
    ...process.env,
    GSTACK_DIR: gstackDir,
    GSTACK_STATE_DIR: stateDir,
    GSTACK_REMOTE_URL: `file://${join(gstackDir, 'REMOTE_VERSION')}`,
  };
  delete env.GSTACK_STATE_ROOT;
  delete env.GSTACK_HOME;
  delete env.GSTACK_REMOTE_SHA;
  delete env.GSTACK_REMOTE_REPO;
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
  let fixtureRoot: string;
  let sharedRoot: string;
  let upstreamBare: string;
  let seedClone: string;
  let plainDir: string;
  let templateBehind: string;
  let templateCurrent: string;
  let BASE_SHA: string;
  let TIP_SHA: string;
  let installSeq = 0;

  function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  }

  /** Copy a prepared fixture tree. Keeps symlinks as symlinks, and costs
   *  ~0.3 ms against ~400 ms for a local `git clone`. */
  function cpR(src: string, dest: string) {
    fs.cpSync(src, dest, { recursive: true });
  }

  // The upstream is built ONCE and never changes: two commits, where the
  // second bumps nothing (BASE ships VERSION 1.60.1.0, TIP is the "security
  // fix with no VERSION bump" that #2378 is about). Per-test isolation comes
  // from copying a prepared install template, not from rebuilding the world.
  //
  // Why a template copy instead of `git clone` per test: a local clone
  // measured 397 ms against 43 ms for `cp -R`, and this file already ran
  // longer than any other file in the free suite. An immutable upstream also
  // removes the shared-mutable-state hazard the previous fixture had, where
  // one test advancing main changed what a later test was looking at.
  beforeAll(() => {
    sharedRoot = mkdtempSync(join(tmpRoot, 'shared-'));
    upstreamBare = join(sharedRoot, 'upstream.git');
    seedClone = join(sharedRoot, 'seed');
    plainDir = join(sharedRoot, 'plain');
    templateBehind = join(sharedRoot, 'tpl-behind');
    templateCurrent = join(sharedRoot, 'tpl-current');

    git(sharedRoot, 'init', '--bare', '-q', upstreamBare);
    git(sharedRoot, 'clone', '-q', upstreamBare, seedClone);
    git(seedClone, 'config', 'user.email', 'test@example.com');
    git(seedClone, 'config', 'user.name', 'test');
    writeFileSync(join(seedClone, 'VERSION'), '1.60.1.0\n');
    git(seedClone, 'add', 'VERSION');
    git(seedClone, 'commit', '-q', '-m', 'release 1.60.1.0');
    BASE_SHA = git(seedClone, 'rev-parse', 'HEAD');
    git(seedClone, 'commit', '-q', '--allow-empty', '-m', 'security fix (no VERSION bump)');
    TIP_SHA = git(seedClone, 'rev-parse', 'HEAD');
    git(seedClone, 'push', '-q', 'origin', 'HEAD:main');
    git(seedClone, 'reset', '-q', '--hard', BASE_SHA); // seed VERSION == the install's

    // A pristine install of an OLDER main: origin slug matches REMOTE_REPO,
    // refs/remotes/origin/main exists, HEAD == origin/main == BASE.
    git(sharedRoot, 'clone', '-q', upstreamBare, templateBehind);
    git(templateBehind, 'remote', 'set-url', 'origin', 'https://github.com/garrytan/gstack.git');
    git(templateBehind, 'reset', '-q', '--hard', BASE_SHA);
    git(templateBehind, 'update-ref', 'refs/remotes/origin/main', BASE_SHA);
    mkdirSync(join(templateBehind, 'bin'), { recursive: true });
    symlinkSync(join(ROOT, 'bin', 'gstack-config'), join(templateBehind, 'bin', 'gstack-config'));
    symlinkSync(join(ROOT, 'bin', 'gstack-egress-lib.sh'), join(templateBehind, 'bin', 'gstack-egress-lib.sh'));

    // ...and the same install already sitting on the remote tip.
    cpR(templateBehind, templateCurrent);
    git(templateCurrent, 'reset', '-q', '--hard', TIP_SHA);
    git(templateCurrent, 'update-ref', 'refs/remotes/origin/main', TIP_SHA);

    // plain (non-git) install with the same VERSION and the same bin/ links
    fs.mkdirSync(join(plainDir, 'bin'), { recursive: true });
    writeFileSync(join(plainDir, 'VERSION'), '1.60.1.0\n');
    symlinkSync(join(ROOT, 'bin', 'gstack-config'), join(plainDir, 'bin', 'gstack-config'));
    symlinkSync(join(ROOT, 'bin', 'gstack-egress-lib.sh'), join(plainDir, 'bin', 'gstack-egress-lib.sh'));
  });

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpRoot, 'uc-clock-fixture-'));
    // gstackDir / stateDir come from the module-level beforeEach, which runs
    // first and already links bin/. Re-creating them here would orphan that
    // pair before any afterEach could see it.
    //
    // The cross-check needs both a remote SHA and a VERSION source; the seed's
    // VERSION (identical string, never bumped) stands in for the remote raw
    // file, so no network is touched.
    gitEnv = {
      GSTACK_REMOTE_URL: `file://${join(seedClone, 'VERSION')}`,
      GSTACK_REMOTE_SHA: TIP_SHA,
    };
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  /** An install one commit behind the remote tip, VERSION strings equal. */
  function makeInstall(origin?: string): string {
    const dir = join(fixtureRoot, `install-${installSeq++}`);
    cpR(templateBehind, dir);
    if (origin) git(dir, 'remote', 'set-url', 'origin', origin);
    return dir;
  }

  /** An install already sitting on the remote tip. */
  function makeCurrentInstall(): string {
    const dir = join(fixtureRoot, `current-${installSeq++}`);
    cpR(templateCurrent, dir);
    return dir;
  }

  /** What a `git fetch` does: move origin/main without moving HEAD. */
  function fetchOnly(install: string) {
    git(install, 'fetch', '-q', upstreamBare, 'main:refs/remotes/origin/main');
  }

  /** What a successful upgrade does: fast-forward HEAD to the fetched tip. */
  function fastForward(install: string, sha = TIP_SHA) {
    fetchOnly(install);
    git(install, 'reset', '-q', '--hard', sha);
  }

  /** The line the script emits for a commit-clock-behind install. */
  function expectedCommitsLine(install: string, remoteSha = TIP_SHA, version = '1.60.1.0'): string {
    const local = git(install, 'rev-parse', 'HEAD');
    return `UPGRADE_COMMITS ${version} ${local.slice(0, 7)} ${remoteSha.slice(0, 7)}`;
  }

  function ageCache(minutes: number) {
    const when = new Date(Date.now() - minutes * 60 * 1000);
    utimesSync(join(stateDir, 'last-update-check'), when, when);
  }

  /** Silence is the up-to-date signal, so a spurious line here is the whole
   *  bug class. Surface stdout AND stderr on failure: a bare toBe('') tells
   *  you the assertion failed and nothing about why. */
  function expectSilent(result: { stdout: string; stderr: string }, why: string) {
    expect(result.stdout, `${why}\nstderr: ${result.stderr}`).toBe('');
  }

  test('THE BUG: pristine sync, main moved without a VERSION bump → flags even though versions are equal', () => {
    const install = makeInstall();
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(expectedCommitsLine(install));
    // The flag is cached, so the TTL replay keeps nagging.
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe(expectedCommitsLine(install));
  });

  test('install on remote main HEAD, versions equal → silent', () => {
    const install = makeCurrentInstall();
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('install left its sync point (local commits) → silent, VERSION verdict stands', () => {
    const install = makeInstall();
    git(install, 'config', 'user.email', 'test@example.com');
    git(install, 'config', 'user.name', 'test');
    git(install, 'commit', '-q', '--allow-empty', '-m', 'local experiment');
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // Silent means UP_TO_DATE — the VERSION path is untouched, not the flag.
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toContain('UP_TO_DATE');
  });

  test('non-git install (plain dir) → silent, unchanged behavior', () => {
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: plainDir });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('fork origin (slug mismatch with REMOTE_REPO) while behind → silent', () => {
    const install = makeInstall('https://github.com/someone/else.git');
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('after the user upgrades (HEAD moves, VERSION unchanged) the cached flag goes silent', () => {
    const install = makeInstall();
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe(expectedCommitsLine(install));
    fastForward(install); // VERSION string is identical after the upgrade
    // The cache is still FRESH — only the install state moved.
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toContain('UP_TO_DATE');
  });

  test('snooze applies to the same-version flag (level 1, within 24h)', () => {
    const install = makeInstall();
    writeSnooze('1.60.1.0', 1, nowEpoch() - 3600);
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // The flag is still cached — the snooze only silences this replay.
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toContain('UPGRADE_COMMITS');
  });

  test('expired snooze → the same-version flag prints again', () => {
    const install = makeInstall();
    writeSnooze('1.60.1.0', 1, nowEpoch() - 90000);
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(expectedCommitsLine(install));
  });

  test('JUST_UPGRADED marker + stale install emits both lines', () => {
    const install = makeInstall();
    writeFileSync(join(stateDir, 'just-upgraded-from'), '1.59.0.0\n');
    const { exitCode, stdout } = run({ ...gitEnv, GSTACK_DIR: install });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('JUST_UPGRADED 1.59.0.0 1.60.1.0');
    expect(stdout).toContain(expectedCommitsLine(install));
  });

  test('missing state stamp forces a fresh check for git installs', () => {
    const install = makeInstall();
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 1.60.1.0\n');
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe(expectedCommitsLine(install));
  });

  test('URL and SHA overrides stay independent', () => {
    const install = makeInstall();
    const alternateVersion = join(fixtureRoot, 'alternate-VERSION');
    writeFileSync(alternateVersion, '1.60.2.0\n');
    const result = run({
      GSTACK_DIR: install,
      GSTACK_REMOTE_URL: `file://${alternateVersion}`,
      GSTACK_REMOTE_SHA: TIP_SHA,
    });
    expect(result.stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.60.2.0');
  });

  test('missing origin/main ref falls back to VERSION behavior', () => {
    const install = makeInstall();
    git(install, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe('');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toContain('UP_TO_DATE');
  });

  test('malformed remote SHA keeps the legacy VERSION verdict', () => {
    const install = makeInstall();
    expectSilent(run({ ...gitEnv, GSTACK_DIR: install, GSTACK_REMOTE_SHA: 'not-a-sha' }), 'a malformed remote SHA must be inconclusive');
  });

  test('uppercase remote SHA does not trigger the commit-clock check', () => {
    const install = makeInstall();
    expectSilent(run({ ...gitEnv, GSTACK_DIR: install, GSTACK_REMOTE_SHA: TIP_SHA.toUpperCase() }), 'an uppercase remote SHA must be inconclusive (ls-remote only ever returns lowercase)');
  });

  test('GSTACK_REMOTE_URL override alone (no SHA) keeps legacy behavior — cross-check inert', () => {
    const install = makeInstall();
    // Deliberately NO GSTACK_REMOTE_SHA: without a remote tip and without
    // ls-remote (URL override active), the cross-check cannot fire. The seed
    // VERSION matches the install, so the legacy verdict is silence.
    const { exitCode, stdout } = run({
      GSTACK_REMOTE_URL: `file://${join(seedClone, 'VERSION')}`,
      GSTACK_DIR: install,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Negative paths ────────────────────────────────────────
  // The states that made the first cut of this feature look green: a git repo
  // whose HEAD will not resolve, a moved origin/main ref, a remote tip on the
  // wrong side of HEAD, two installs sharing one state dir, and a real
  // release landing while a commit-clock verdict is cached.

  test('bare `git fetch` moves origin/main ahead of HEAD → still flags (ancestry, not equality)', () => {
    // /gstack-upgrade runs `git fetch origin` BEFORE `git pull --ff-only`, so
    // an upgrade that failed after the fetch leaves exactly this state. A
    // HEAD == origin/main gate would silence such an install permanently.
    const install = makeInstall();
    fetchOnly(install);
    expect(git(install, 'rev-parse', 'HEAD')).toBe(BASE_SHA);   // HEAD did NOT move
    expect(git(install, 'rev-parse', 'refs/remotes/origin/main')).toBe(TIP_SHA); // the ref did
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe(expectedCommitsLine(install));
  });

  test('remote tip is an ANCESTOR of HEAD (install ahead) → silent, never a backwards flag', () => {
    // The install is ON the tip and the supplied "remote tip" is the older
    // commit. Nothing to upgrade to; --ff-only could not apply it.
    const install = makeCurrentInstall();
    const result = run({ ...gitEnv, GSTACK_DIR: install, GSTACK_REMOTE_SHA: BASE_SHA });
    expect(result.exitCode).toBe(0);
    expectSilent(result, 'the install is AHEAD of the supplied tip');
  });

  test('remote tip on unrelated history (present locally) → silent', () => {
    const install = makeInstall();
    const alt = join(fixtureRoot, 'alt');
    git(fixtureRoot, 'init', '-q', alt);
    git(alt, 'config', 'user.email', 'test@example.com');
    git(alt, 'config', 'user.name', 'test');
    git(alt, 'commit', '-q', '--allow-empty', '-m', 'unrelated root');
    const altSha = git(alt, 'rev-parse', 'HEAD');
    git(install, 'fetch', '-q', alt, 'HEAD');
    const result = run({ ...gitEnv, GSTACK_DIR: install, GSTACK_REMOTE_SHA: altSha });
    expect(result.exitCode).toBe(0);
    expectSilent(result, 'an unrelated-history tip is not an upgrade');
  });

  test('git install whose HEAD will not resolve → VERSION verdict stands, no CHECK_FAILED leak', () => {
    // An unborn HEAD is inconclusive, not a crash: the design says fall back
    // to the VERSION verdict. What must never happen is the ERR trap firing
    // INSIDE a command substitution, which would put the #1974 sentinel into
    // a shell variable instead of on stdout — silently swallowing it.
    const broken = join(fixtureRoot, 'broken');
    mkdirSync(join(broken, 'bin'), { recursive: true });
    writeFileSync(join(broken, 'VERSION'), '1.60.1.0\n');
    symlinkSync(join(ROOT, 'bin', 'gstack-config'), join(broken, 'bin', 'gstack-config'));
    symlinkSync(join(ROOT, 'bin', 'gstack-egress-lib.sh'), join(broken, 'bin', 'gstack-egress-lib.sh'));
    git(fixtureRoot, 'init', '-q', broken); // .git exists, no commit → rev-parse HEAD fails
    const newer = join(fixtureRoot, 'VERSION-newer');
    writeFileSync(newer, '1.61.0.0\n');
    const { exitCode, stdout, stderr } = run({
      GSTACK_DIR: broken,
      GSTACK_REMOTE_URL: `file://${newer}`,
      GSTACK_REMOTE_SHA: TIP_SHA,
    });
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('CHECK_FAILED');
    expect(stderr).not.toContain('CHECK_FAILED');
    expect(stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.61.0.0');
  });

  test('git install whose HEAD will not resolve replays a fresh cache (no slow path per preamble)', () => {
    // Deliberate, and it matches upstream/main: this install's verdict never
    // depended on git state (the clock check cannot run for it), so a fresh
    // VERSION verdict is still valid. The interim version of this branch
    // forced a slow path here instead, which meant an ls-remote + curl on
    // EVERY skill preamble for a repo that is already broken.
    const broken = join(fixtureRoot, 'broken-cached');
    mkdirSync(join(broken, 'bin'), { recursive: true });
    writeFileSync(join(broken, 'VERSION'), '1.60.1.0\n');
    symlinkSync(join(ROOT, 'bin', 'gstack-config'), join(broken, 'bin', 'gstack-config'));
    symlinkSync(join(ROOT, 'bin', 'gstack-egress-lib.sh'), join(broken, 'bin', 'gstack-egress-lib.sh'));
    git(fixtureRoot, 'init', '-q', broken);
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 1.60.1.0\n');
    const newer = join(fixtureRoot, 'VERSION-newer-cached');
    writeFileSync(newer, '1.61.0.0\n');
    const result = run({ GSTACK_DIR: broken, GSTACK_REMOTE_URL: `file://${newer}` });
    expect(result.exitCode).toBe(0);
    expectSilent(result, 'a fresh UP_TO_DATE cache is replayable for an install with no usable git state');
    // The cache is untouched — nothing re-fetched and nothing overwrote it.
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8').trim()).toBe('UP_TO_DATE 1.60.1.0');
  });

  test('a cached commit-clock verdict does NOT hide a real release (60-min TTL, not the 720-min nag bucket)', () => {
    const install = makeInstall();
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe(expectedCommitsLine(install));
    ageCache(100); // past the 60-min bucket, well inside the 720-min one
    const realRelease = join(fixtureRoot, 'VERSION-161');
    writeFileSync(realRelease, '1.61.0.0\n');
    const { stdout } = run({ ...gitEnv, GSTACK_DIR: install, GSTACK_REMOTE_URL: `file://${realRelease}` });
    expect(stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.61.0.0');
  });

  test('a snooze on the commit-clock nag does NOT silence a later real release', () => {
    const install = makeInstall();
    writeSnooze('1.60.1.0', 1, nowEpoch() - 3600);
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe(''); // snoozed
    ageCache(100);
    const realRelease = join(fixtureRoot, 'VERSION-161');
    writeFileSync(realRelease, '1.61.0.0\n');
    const { stdout } = run({ ...gitEnv, GSTACK_DIR: install, GSTACK_REMOTE_URL: `file://${realRelease}` });
    expect(stdout).toBe('UPGRADE_AVAILABLE 1.60.1.0 1.61.0.0');
  });

  test('two installs sharing one state dir do not silence each other', () => {
    // STATE_DIR is machine-global ($HOME/.gstack). A global install plus a dev
    // clone — or sibling Conductor workspaces — land on the same cache file.
    const behind = makeInstall();
    const current = makeCurrentInstall();
    // The up-to-date install writes UP_TO_DATE first...
    expect(run({ ...gitEnv, GSTACK_DIR: current }).stdout).toBe('');
    // ...and must not mute the one that is genuinely behind, on any run.
    expect(run({ ...gitEnv, GSTACK_DIR: behind }).stdout).toBe(expectedCommitsLine(behind));
    expect(run({ ...gitEnv, GSTACK_DIR: behind }).stdout).toBe(expectedCommitsLine(behind));
  });

  test('same HEAD, different origin/main, shared state dir → no cross-replay', () => {
    const a = makeInstall();
    const b = makeInstall();
    fetchOnly(b); // only b fetched; both are still on the same commit
    expect(git(a, 'rev-parse', 'HEAD')).toBe(git(b, 'rev-parse', 'HEAD'));
    expect(git(a, 'rev-parse', 'refs/remotes/origin/main'))
      .not.toBe(git(b, 'rev-parse', 'refs/remotes/origin/main'));
    // Both are behind, so both must flag — neither replays the other's stamp.
    expect(run({ ...gitEnv, GSTACK_DIR: b }).stdout).toBe(expectedCommitsLine(b));
    expect(run({ ...gitEnv, GSTACK_DIR: a }).stdout).toBe(expectedCommitsLine(a));
  });

  test('invalid/empty remote response still stamps, so the fresh cache stays replayable', () => {
    const install = makeInstall();
    const { stdout } = run({
      GSTACK_DIR: install,
      GSTACK_REMOTE_URL: 'file:///nonexistent/VERSION',
      GSTACK_REMOTE_SHA: TIP_SHA,
    });
    expect(stdout).toBe('');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toContain('UP_TO_DATE');
    const stamp = readFileSync(join(stateDir, 'last-update-check-stamp'), 'utf-8').trim();
    expect(stamp.split(' ')[0]).toBe(git(install, 'rev-parse', 'HEAD'));
  });

  test('snoozed commit-clock verdict still stamps', () => {
    const install = makeInstall();
    writeSnooze('1.60.1.0', 1, nowEpoch() - 3600);
    expect(run({ ...gitEnv, GSTACK_DIR: install }).stdout).toBe('');
    expect(existsSync(join(stateDir, 'last-update-check-stamp'))).toBe(true);
  });

  test('non-git install leaves no stamp file at all', () => {
    // Not a 0-byte file and not the literal string "HEAD": either would fail
    // every later comparison and pin the install to the slow path.
    run({ ...gitEnv, GSTACK_DIR: plainDir });
    expect(existsSync(join(stateDir, 'last-update-check-stamp'))).toBe(false);
  });

  test('--force clears the state stamp along with the cache', () => {
    const install = makeInstall();
    run({ ...gitEnv, GSTACK_DIR: install });
    expect(existsSync(join(stateDir, 'last-update-check-stamp'))).toBe(true);
    // --force re-runs the check, so a fresh stamp exists afterwards; what
    // matters is that the pre-force one was removed rather than left behind
    // to authorize a replay against state it no longer describes.
    fastForward(install);
    run({ ...gitEnv, GSTACK_DIR: install }, ['--force']);
    const stamp = readFileSync(join(stateDir, 'last-update-check-stamp'), 'utf-8').trim();
    expect(stamp.split(' ')[0]).toBe(TIP_SHA);
  });

  test('canonical origin URL forms receive the commit-clock check', () => {
    // One install, re-pointed per form: a separate install per form costs a
    // template copy for no extra coverage. --force resets cache + stamp.
    const install = makeInstall();
    for (const origin of [
      'https://github.com/garrytan/gstack.git',
      'git@github.com:garrytan/gstack.git',
      'ssh://git@github.com/garrytan/gstack.git',
      'https://github.com/garrytan/gstack',                      // no .git suffix
    ]) {
      git(install, 'remote', 'set-url', 'origin', origin);
      const { stdout } = run({ ...gitEnv, GSTACK_DIR: install }, ['--force']);
      expect(stdout, `origin ${origin} should be checked`).toBe(expectedCommitsLine(install));
    }
  });

  test('origin URL forms the first cut silently skipped now receive the check', () => {
    const install = makeInstall();
    for (const origin of [
      'https://ghp_exampletoken@github.com/garrytan/gstack.git', // CI clone shape
      'ssh://github.com/garrytan/gstack.git',                    // no git@ userinfo
      'git://github.com/garrytan/gstack.git',
      'https://github.com:443/garrytan/gstack.git',              // explicit port
      'https://github.com/GarryTan/GStack.git',                  // mixed case
    ]) {
      git(install, 'remote', 'set-url', 'origin', origin);
      const { stdout } = run({ ...gitEnv, GSTACK_DIR: install }, ['--force']);
      expect(stdout, `origin ${origin} should be checked`).toBe(expectedCommitsLine(install));
    }
  });

  test('origin URL forms that are rejected → silent, VERSION verdict stands', () => {
    const install = makeInstall();
    for (const origin of [
      'https://evil.com/github.com/garrytan/gstack.git',   // host-confusion prefix
      'https://github.com.evil.com/garrytan/gstack.git',   // host-confusion suffix
      'https://github.com/garrytan/gstack/extra.git',      // deeper than owner/repo
      'https://gitlab.com/garrytan/gstack.git',            // different host
      'https://github.com/garrytan',                       // no repo half
      '/srv/mirrors/gstack.git',                           // local path, no host
    ]) {
      git(install, 'remote', 'set-url', 'origin', origin);
      const { stdout } = run({ ...gitEnv, GSTACK_DIR: install }, ['--force']);
      expect(stdout, `origin ${origin} should be rejected`).toBe('');
      // Non-vacuous: the install IS behind, so silence must come from the slug
      // gate, and the VERSION verdict must be what got cached.
      expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toContain('UP_TO_DATE');
    }
  });

  test('GSTACK_REMOTE_REPO mirror is compared against ITS OWN slug, not a hardcoded one', () => {
    // The origin slug gate used to hardcode garrytan/gstack, so any mirror
    // configured through GSTACK_REMOTE_REPO silently lost the check.
    const install = makeInstall('https://github.com/acme/gstack-mirror.git');
    expect(run({
      ...gitEnv,
      GSTACK_DIR: install,
      GSTACK_REMOTE_REPO: 'https://github.com/acme/gstack-mirror.git',
    }).stdout).toBe(expectedCommitsLine(install));
    // ...and a mirror whose origin does NOT match it still stays silent.
    expect(run({
      ...gitEnv,
      GSTACK_DIR: install,
      GSTACK_REMOTE_REPO: 'https://github.com/acme/other.git',
    }, ['--force']).stdout).toBe('');
  });
});
