/**
 * Tests for bin/nstack-update-check bash script.
 *
 * Uses Bun.spawnSync to invoke the script with temp dirs and
 * NSTACK_DIR / NSTACK_STATE_DIR / NSTACK_REMOTE_URL env overrides
 * for full isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(import.meta.dir, '..', '..', 'bin', 'nstack-update-check');

let nstackDir: string;
let stateDir: string;

function run(extraEnv: Record<string, string> = {}, args: string[] = []) {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: {
      ...process.env,
      NSTACK_DIR: nstackDir,
      NSTACK_STATE_DIR: stateDir,
      NSTACK_REMOTE_URL: `file://${join(nstackDir, 'REMOTE_VERSION')}`,
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

beforeEach(() => {
  nstackDir = mkdtempSync(join(tmpdir(), 'nstack-upd-test-'));
  stateDir = mkdtempSync(join(tmpdir(), 'nstack-state-test-'));
  // Link real nstack-config so update_check config check works
  const binDir = join(nstackDir, 'bin');
  mkdirSync(binDir);
  symlinkSync(join(import.meta.dir, '..', '..', 'bin', 'nstack-config'), join(binDir, 'nstack-config'));
});

afterEach(() => {
  rmSync(nstackDir, { recursive: true, force: true });
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

describe('nstack-update-check', () => {
  // ─── Path A: No VERSION file ────────────────────────────────
  test('exits 0 with no output when VERSION file is missing', () => {
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path B: Empty VERSION file ─────────────────────────────
  test('exits 0 with no output when VERSION file is empty', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '');
    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path C: Just-upgraded marker ───────────────────────────
  test('outputs JUST_UPGRADED and deletes marker', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.4.0\n');
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
    writeFileSync(join(nstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.5.0\n');

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
    writeFileSync(join(nstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path D1: Fresh cache, UP_TO_DATE ───────────────────────
  test('exits silently when cache says UP_TO_DATE and is fresh', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 0.3.3');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  // ─── Path D1b: Fresh UP_TO_DATE cache, but local version changed ──
  test('re-checks when UP_TO_DATE cache version does not match local', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.4.0\n');
    // Cache says UP_TO_DATE for 0.3.3, but local is now 0.4.0
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 0.3.3');
    // Remote says 0.5.0 — should detect upgrade
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.5.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.4.0 0.5.0');
  });

  // ─── Path D2: Fresh cache, UPGRADE_AVAILABLE ────────────────
  test('echoes cached UPGRADE_AVAILABLE when cache is fresh', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── Path D3: Fresh cache, but local version changed ────────
  test('re-checks when local version does not match cached old version', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.4.0\n');
    // Cache says 0.3.3 → 0.4.0 but we're already on 0.4.0
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    // Remote also says 0.4.0 — should be up to date
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe(''); // Up to date after re-check
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path E: Versions match (remote fetch) ─────────────────
  test('writes UP_TO_DATE cache when versions match', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path F: Versions differ (remote fetch) ─────────────────
  test('outputs UPGRADE_AVAILABLE when versions differ', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── Path G: Invalid remote response ────────────────────────
  test('treats invalid remote response as up to date', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '<html>404 Not Found</html>\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path H: Curl fails (bad URL) ──────────────────────────
  test('exits silently when remote URL is unreachable', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');

    const { exitCode, stdout } = run({
      NSTACK_REMOTE_URL: 'file:///nonexistent/path/VERSION',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  // ─── Path I: Corrupt cache file ─────────────────────────────
  test('falls through to remote fetch when cache is corrupt', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'garbage data here');
    // Remote says same version — should end up UP_TO_DATE
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.3.3\n');

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
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    const { exitCode } = run({ NSTACK_STATE_DIR: newStateDir });
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
    writeFileSync(join(nstackDir, 'VERSION'), version + '\n');

    // Remote is unreachable (simulates offline / CI / sandboxed agent)
    const { exitCode, stdout } = run({
      NSTACK_REMOTE_URL: 'file:///nonexistent/path/VERSION',
    });
    expect(exitCode).toBe(0);
    // Should write UP_TO_DATE cache (not crash)
    const cache = readFileSync(join(stateDir, 'last-update-check'), 'utf-8');
    expect(cache).toContain('UP_TO_DATE');
  });

  test('exits 0 when up to date (not exit 1)', () => {
    // Regression test: script previously exited 1 when versions matched.
    // This broke every skill preamble that called it without || true.
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.3.3\n');

    // First call: fetches remote, writes cache
    const first = run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe('');

    // Second call: reads fresh cache
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe('');

    // Third call with upgrade available: still exit 0
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    rmSync(join(stateDir, 'last-update-check')); // force re-fetch
    const third = run();
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── Snooze tests ───────────────────────────────────────────
  test('snoozed level 1 within 24h → silent (cached path)', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 1, nowEpoch() - 3600); // 1h ago (within 24h)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 1 expired (25h ago) → outputs UPGRADE_AVAILABLE', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 1, nowEpoch() - 90000); // 25h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snoozed level 2 within 48h → silent', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 2, nowEpoch() - 86400); // 24h ago (within 48h)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 2 expired (49h ago) → outputs', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 2, nowEpoch() - 176400); // 49h ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snoozed level 3 within 7d → silent', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 3, nowEpoch() - 518400); // 6d ago (within 7d)

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  test('snoozed level 3 expired (8d ago) → outputs', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeSnooze('0.4.0', 3, nowEpoch() - 691200); // 8d ago

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snooze ignored when version differs (new version resets snooze)', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.5.0');
    // Snoozed for 0.4.0, but remote is now 0.5.0
    writeSnooze('0.4.0', 3, nowEpoch() - 60); // very recent

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.5.0');
  });

  test('corrupt snooze file → outputs normally', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeFileSync(join(stateDir, 'update-snoozed'), 'garbage');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('non-numeric epoch in snooze file → outputs', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeFileSync(join(stateDir, 'update-snoozed'), '0.4.0 1 abc');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('non-numeric level in snooze file → outputs', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UPGRADE_AVAILABLE 0.3.3 0.4.0');
    writeFileSync(join(stateDir, 'update-snoozed'), `0.4.0 abc ${nowEpoch()}`);

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('snooze respected on remote fetch path (no cache)', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');
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
    writeFileSync(join(nstackDir, 'VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'just-upgraded-from'), '0.3.3\n');
    writeSnooze('0.4.0', 2, nowEpoch() - 3600);

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('JUST_UPGRADED 0.3.3 0.4.0');
    expect(existsSync(join(stateDir, 'update-snoozed'))).toBe(false);
  });

  // ─── Config tests ──────────────────────────────────────────
  test('update_check: false disables all checks', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeConfig('update_check: false\n');

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    // No cache should be written
    expect(existsSync(join(stateDir, 'last-update-check'))).toBe(false);
  });

  test('missing config.yaml does not crash', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    // No config file — should behave normally

    const { exitCode, stdout } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  // ─── --force flag tests ──────────────────────────────────────

  test('--force busts fresh UP_TO_DATE cache', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');
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
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.3.3\n');
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
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');
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

  test('UP_TO_DATE cache expires after 60 min (not 720)', () => {
    writeFileSync(join(nstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(nstackDir, 'REMOTE_VERSION'), '0.4.0\n');
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
