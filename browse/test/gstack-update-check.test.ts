/**
 * Tests for bin/gstack-update-check bash script.
 *
 * Uses Bun.spawnSync to invoke the script with temp dirs and
 * GSTACK_DIR / GSTACK_STATE_DIR / GSTACK_REMOTE_URL env overrides
 * for full isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, utimesSync, chmodSync } from 'fs';
import { dirname, isAbsolute, join, relative } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(import.meta.dir, '..', '..', 'bin', 'gstack-update-check');
const BASH = Bun.which('bash') ?? 'bash';
const BASH_PATHS = new Map<string, string>();
const TEMP_ROOT = tmpdir();
const CYGPATH = process.platform === 'win32' && BASH !== 'bash'
  ? join(dirname(dirname(BASH)), 'usr', 'bin', 'cygpath.exe')
  : null;

let gstackDir: string;
let stateDir: string;
let mockBinDir: string;
let commandLog: string;

function bashPath(path: string) {
  if (process.platform !== 'win32') return path;
  const cached = BASH_PATHS.get(path);
  if (cached) return cached;

  const fromTempRoot = relative(TEMP_ROOT, path);
  if (fromTempRoot && !fromTempRoot.startsWith('..') && !isAbsolute(fromTempRoot)) {
    const resolved = `${bashPath(TEMP_ROOT)}/${fromTempRoot.replaceAll('\\', '/')}`;
    BASH_PATHS.set(path, resolved);
    return resolved;
  }

  const result = CYGPATH && existsSync(CYGPATH)
    ? Bun.spawnSync([CYGPATH, '-u', path], { stdout: 'pipe', stderr: 'pipe' })
    : Bun.spawnSync([BASH, '-lc', 'cygpath -u -- "$1"', 'bash', path], { stdout: 'pipe', stderr: 'pipe' });
  const resolved = result.exitCode === 0 ? result.stdout.toString().trim() : path;
  BASH_PATHS.set(path, resolved);
  return resolved;
}

function fileUrl(path: string) {
  if (process.platform === 'win32') return `file:///${path.replaceAll('\\', '/')}`;
  return `file://${path}`;
}

function run(extraEnv: Record<string, string> = {}, args: string[] = []) {
  const stateDirOverride = extraEnv.GSTACK_STATE_DIR ? bashPath(extraEnv.GSTACK_STATE_DIR) : bashPath(stateDir);
  const gstackDirOverride = extraEnv.GSTACK_DIR ? bashPath(extraEnv.GSTACK_DIR) : bashPath(gstackDir);
  const remoteUrlOverride = extraEnv.GSTACK_REMOTE_URL ?? fileUrl(join(gstackDir, 'REMOTE_VERSION'));
  const { PATH: bashSearchPath, ...otherEnv } = extraEnv;
  const command = bashSearchPath
    ? [BASH, '-c', 'PATH="$1"; export PATH; shift; exec "$@"', 'bash', bashSearchPath, bashPath(SCRIPT), ...args]
    : [BASH, bashPath(SCRIPT), ...args];
  const result = Bun.spawnSync(command, {
    env: {
      ...process.env,
      ...otherEnv,
      GSTACK_DIR: gstackDirOverride,
      GSTACK_STATE_DIR: stateDirOverride,
      GSTACK_REMOTE_URL: remoteUrlOverride,
      GSTACK_TEST_COMMAND_LOG: bashPath(commandLog),
      GSTACK_TEST_ALLOW_FILE_REMOTE_URL: '1',
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
  gstackDir = mkdtempSync(join(tmpdir(), 'gstack-upd-test-'));
  stateDir = mkdtempSync(join(tmpdir(), 'gstack-state-test-'));
  mockBinDir = mkdtempSync(join(tmpdir(), 'gstack-upd-bin-'));
  commandLog = join(stateDir, 'commands.log');
  // Link real gstack-config so update_check config check works
  const binDir = join(gstackDir, 'bin');
  mkdirSync(binDir);
  symlinkSync(join(import.meta.dir, '..', '..', 'bin', 'gstack-config'), join(binDir, 'gstack-config'));

  writeFileSync(join(mockBinDir, 'git'), `#!/usr/bin/env bash
set -eu
printf 'git %s\\n' "$*" >> "$GSTACK_TEST_COMMAND_LOG"
if [ "\${1:-}" = "-C" ]; then
  printf '%s\\n' "\${GSTACK_TEST_ORIGIN:-}"
elif [ "\${1:-}" = "ls-remote" ]; then
  if [ "\${2:-}" = "--symref" ]; then
    printf 'ref: refs/heads/%s\\tHEAD\\n' "\${GSTACK_TEST_DEFAULT_BRANCH:-main}"
  else
    printf '%040d\\trefs/heads/%s\\n' 0 "\${GSTACK_TEST_DEFAULT_BRANCH:-main}"
  fi
fi
`, { mode: 0o755 });
  writeFileSync(join(mockBinDir, 'curl'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$GSTACK_TEST_COMMAND_LOG"
case "$*" in
  *raw.githubusercontent.com/example-org/example-fork/*) printf '2.0.0.0\\n' ;;
  *raw.githubusercontent.com/acme/origin-repo/*) printf '2.0.0.0\\n' ;;
  *raw.githubusercontent.com/garrytan/gstack/*) printf '2.0.0.0\\n' ;;
esac
`, { mode: 0o755 });
  chmodSync(join(mockBinDir, 'git'), 0o755);
  chmodSync(join(mockBinDir, 'curl'), 0o755);
});

afterEach(() => {
  rmSync(gstackDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(mockBinDir, { recursive: true, force: true });
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
  }, 15_000);

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

  test('cache expiry does not depend on GNU find -mmin', () => {
    const bashEnv = join(stateDir, 'no-find-mmin.sh');
    writeFileSync(join(gstackDir, 'VERSION'), '0.3.3\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '0.4.0\n');
    writeFileSync(join(stateDir, 'last-update-check'), 'UP_TO_DATE 0.3.3');
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000);
    const cachePath = join(stateDir, 'last-update-check');
    utimesSync(cachePath, ninetyMinAgo, ninetyMinAgo);
    writeFileSync(bashEnv, 'find() { return 99; }\n');

    const { exitCode, stdout } = run({ BASH_ENV: bashPath(bashEnv) });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 0.3.3 0.4.0');
  });

  test('does not require GNU sort -V to compare dotted versions', () => {
    const bashEnv = join(stateDir, 'no-sort-v.sh');
    writeFileSync(join(gstackDir, 'VERSION'), '1.9.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1.10.0.0\n');
    writeFileSync(bashEnv, 'sort() { return 99; }\n');

    const { exitCode, stdout } = run({ BASH_ENV: bashPath(bashEnv) });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('UPGRADE_AVAILABLE 1.9.0.0 1.10.0.0');
  });

  test('treats malformed local or remote versions as invalid before numeric comparison', () => {
    writeFileSync(join(gstackDir, 'VERSION'), '1..2\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '2.0.0.0\n');
    const invalidLocal = run();
    expect(invalidLocal.exitCode).toBe(0);
    expect(invalidLocal.stdout).toBe('');

    rmSync(join(stateDir, 'last-update-check'), { force: true });
    writeFileSync(join(gstackDir, 'VERSION'), '1.0.0.0\n');
    writeFileSync(join(gstackDir, 'REMOTE_VERSION'), '1..2\n');
    const invalidRemote = run();
    expect(invalidRemote.exitCode).toBe(0);
    expect(invalidRemote.stdout).toBe('');
    expect(readFileSync(join(stateDir, 'last-update-check'), 'utf-8')).toContain('UP_TO_DATE 1.0.0.0');
  });

  describe('source-aware and non-destructive upgrades', () => {
    function runSourceCheck(extraEnv: Record<string, string> = {}) {
      writeFileSync(join(gstackDir, 'VERSION'), '1.0.0.0\n');
      return run({
        GSTACK_REMOTE_URL: '',
        PATH: `${bashPath(mockBinDir)}:/usr/bin:/bin`,
        ...extraEnv,
      });
    }

    test('uses a validated explicit GitHub HTTPS or SSH source for both SHA and raw VERSION lookup', () => {
      const https = runSourceCheck({ GSTACK_REMOTE_REPO: 'https://github.com/example-org/example-fork.git' });
      expect(https.exitCode).toBe(0);
      expect(https.stderr).toBe('');
      expect(existsSync(commandLog)).toBe(true);
      expect(https.stdout).toBe('UPGRADE_AVAILABLE 1.0.0.0 2.0.0.0');
      expect(readFileSync(commandLog, 'utf-8')).toContain('raw.githubusercontent.com/example-org/example-fork/');

      rmSync(join(stateDir, 'last-update-check'));
      const ssh = runSourceCheck({ GSTACK_REMOTE_REPO: 'git@github.com:example-org/example-fork.git' });
      expect(ssh.exitCode).toBe(0);
      expect(ssh.stdout).toBe('UPGRADE_AVAILABLE 1.0.0.0 2.0.0.0');
    }, 15_000);

    test('uses a supported local origin when no explicit source is configured', () => {
      const result = runSourceCheck({ GSTACK_TEST_ORIGIN: 'git@github.com:acme/origin-repo.git' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('UPGRADE_AVAILABLE 1.0.0.0 2.0.0.0');
      expect(readFileSync(commandLog, 'utf-8')).toContain('raw.githubusercontent.com/acme/origin-repo/');
    });

    test('resolves an alternate repository default branch before reading VERSION', () => {
      const result = runSourceCheck({
        GSTACK_REMOTE_REPO: 'https://github.com/example-org/example-fork.git',
        GSTACK_TEST_DEFAULT_BRANCH: 'release',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('UPGRADE_AVAILABLE 1.0.0.0 2.0.0.0');
      expect(readFileSync(commandLog, 'utf-8')).toContain('git ls-remote https://github.com/example-org/example-fork.git refs/heads/release');
    });

    test('falls back to the upstream repository and never exposes credentials from an untrusted source', () => {
      const secret = 'not-a-real-token';
      const result = runSourceCheck({
        GSTACK_REMOTE_REPO: `https://${secret}@github.com/acme/origin-repo.git`,
        GSTACK_TEST_ORIGIN: `https://${secret}@github.com/acme/origin-repo.git`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('UPGRADE_AVAILABLE 1.0.0.0 2.0.0.0');
      const output = `${result.stdout}\n${result.stderr}\n${readFileSync(commandLog, 'utf-8')}`;
      expect(output).not.toContain(secret);
      expect(output).toContain('raw.githubusercontent.com/garrytan/gstack/');
    });

    test('rejects a credential-bearing direct VERSION URL and falls back without exposing it', () => {
      const secret = 'not-a-real-direct-url-token';
      writeFileSync(join(gstackDir, 'VERSION'), '1.0.0.0\n');
      const result = run({
        GSTACK_REMOTE_URL: `https://${secret}@example.test/VERSION`,
        PATH: `${bashPath(mockBinDir)}:/usr/bin:/bin`,
      });
      expect(result.exitCode).toBe(0);
      const output = `${result.stdout}\n${result.stderr}\n${readFileSync(commandLog, 'utf-8')}`;
      expect(output).not.toContain(secret);
      expect(output).toContain('raw.githubusercontent.com/garrytan/gstack/');
    });

    test('upgrade guidance stops on a dirty worktree and only fast-forwards a clean checkout', () => {
      const template = readFileSync(join(import.meta.dir, '..', '..', 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf-8');
      expect(template).toContain('git diff --quiet');
      expect(template).toContain('git merge --ff-only');
      expect(template).not.toContain('git stash');
      expect(template).not.toContain('git reset --hard origin/main');
      expect(template).toContain('git clone --depth 1 --branch "$DEFAULT_BRANCH"');
      expect(template).toContain('if ! git clone');
      expect(template).toContain('mv "$INSTALL_DIR.bak" "$INSTALL_DIR"');
    });

    test('vendored guidance stops before replacement when a previous backup already exists', () => {
      const template = readFileSync(join(import.meta.dir, '..', '..', 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf-8');
      expect(template).toContain('[ -e "$INSTALL_DIR.bak" ]');
      expect(template).toContain('move or remove it manually');
      expect(template).toContain('exit 1');
    });

    test('local vendored sync preserves the old copy on backup, copy, or setup failure', () => {
      const template = readFileSync(join(import.meta.dir, '..', '..', 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf-8');
      const marker = '# Transactional local vendored sync:';
      const start = template.indexOf(marker);
      const end = template.indexOf('\n```', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);

      const fixture = mkdtempSync(join(tmpdir(), 'gstack-vendored-sync-'));
      const install = join(fixture, 'primary');
      const local = join(fixture, 'local');
      const script = join(fixture, 'sync.sh');
      mkdirSync(install, { recursive: true });
      writeFileSync(join(install, 'new.txt'), 'new');
      writeFileSync(script, `#!/usr/bin/env bash\nset -u\nINSTALL_DIR="$1"\nLOCAL_GSTACK="$2"\n${template.slice(start, end)}\n`);

      const prepareOld = () => {
        rmSync(local, { recursive: true, force: true });
        rmSync(`${local}.bak`, { recursive: true, force: true });
        mkdirSync(local, { recursive: true });
        writeFileSync(join(local, 'old.txt'), 'old');
      };
      const runSync = (bashEnv?: string) => Bun.spawnSync(
        [BASH, bashPath(script), bashPath(install), bashPath(local)],
        {
          env: { ...process.env, ...(bashEnv ? { BASH_ENV: bashPath(bashEnv) } : {}) },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      try {
        prepareOld();
        mkdirSync(`${local}.bak`);
        writeFileSync(join(`${local}.bak`, 'pending.txt'), 'pending');
        expect(runSync().exitCode).not.toBe(0);
        expect(readFileSync(join(local, 'old.txt'), 'utf-8')).toBe('old');
        expect(readFileSync(join(`${local}.bak`, 'pending.txt'), 'utf-8')).toBe('pending');

        prepareOld();
        const failCopy = join(fixture, 'fail-copy.sh');
        writeFileSync(failCopy, 'cp() { mkdir -p "$3"; printf partial > "$3/partial.txt"; return 1; }\n');
        expect(runSync(failCopy).exitCode).not.toBe(0);
        expect(readFileSync(join(local, 'old.txt'), 'utf-8')).toBe('old');
        expect(existsSync(`${local}.bak`)).toBe(false);
        expect(existsSync(`${local}.new`)).toBe(false);

        prepareOld();
        writeFileSync(join(install, 'setup'), '#!/usr/bin/env bash\nexit 1\n');
        chmodSync(join(install, 'setup'), 0o755);
        expect(runSync().exitCode).not.toBe(0);
        expect(readFileSync(join(local, 'old.txt'), 'utf-8')).toBe('old');
        expect(existsSync(`${local}.bak`)).toBe(false);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }, 15_000);
  });
});
