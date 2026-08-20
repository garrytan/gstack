import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');
const SETUP_SRC = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

// Slice out the ensure_emoji_font helper body via anchors so the test is
// resilient to line-number drift (same pattern as setup-windows-fallback).
function extractHelper(): string {
  const start = SETUP_SRC.indexOf('ensure_emoji_font() {');
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('Could not locate ensure_emoji_font() in setup');
  return SETUP_SRC.slice(start, end + 2);
}

describe('setup: ensure_emoji_font static invariants', () => {
  const helper = extractHelper();

  test('helper is defined and Linux-guarded', () => {
    expect(SETUP_SRC).toContain('ensure_emoji_font() {');
    expect(helper).toContain('[ "$(uname -s)" = "Linux" ] || return 0');
  });

  test('honors the GSTACK_SKIP_FONTS escape hatch', () => {
    expect(helper).toContain('GSTACK_SKIP_FONTS');
  });

  test('detects an installed COLOR emoji font via fc-match (not the broad fc-list query)', () => {
    expect(helper).toContain('fc-match');
    expect(helper).toContain(':lang=und-zsye:charset=1F600');
    // Must gate on color=True so symbol / last-resort fallback fonts don't
    // false-positive and skip a needed install.
    expect(helper).toMatch(/grep -qi ['"]True['"]/);
    // The broad fc-list query that matched LastResort is NOT used for detection.
    // (Check executable lines only — the docblock may mention fc-list to explain
    // why we avoid it.)
    const codeLines = helper
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(codeLines).not.toContain('fc-list');
  });

  test('uses non-interactive sudo so a password prompt fails fast (no hang)', () => {
    expect(helper).toContain('sudo -n');
  });

  test('install path is non-interactive and timeout-guarded', () => {
    expect(helper).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(helper).toMatch(/timeout 30 .*apt-get update/);
    // Every package-manager INSTALL (not just apt update) must be timeout-bound
    // so a stuck lock/mirror fails fast instead of hanging setup.
    expect(helper).toMatch(/timeout \d+ .*apt-get install/);
    expect(helper).toMatch(/timeout \d+ .*dnf install/);
    expect(helper).toMatch(/timeout \d+ .*pacman -Sy/);
    expect(helper).toMatch(/timeout \d+ .*apk add/);
  });

  test('covers all four package managers with the correct package names', () => {
    expect(helper).toContain('apt-get install -y -qq fonts-noto-color-emoji');
    expect(helper).toContain('dnf install -y google-noto-color-emoji-fonts');
    expect(helper).toContain('pacman -Sy --noconfirm noto-fonts-emoji');
    expect(helper).toContain('apk add --no-cache font-noto-emoji');
  });

  test('refreshes the fontconfig cache under sudo after install', () => {
    expect(helper).toMatch(/\$sudo fc-cache -f/);
  });

  test('marks EMOJI_FONT_INSTALLED on success and warns (not fails) elsewhere', () => {
    expect(helper).toContain('EMOJI_FONT_INSTALLED=1');
    // Failure branches return 1 (caller warns) rather than `exit`.
    expect(helper).not.toContain('exit 1');
  });

  test('refresh_browse_daemon_for_fonts stops the daemon gracefully (no broad pkill)', () => {
    const dStart = SETUP_SRC.indexOf('refresh_browse_daemon_for_fonts() {');
    const dEnd = SETUP_SRC.indexOf('\n}\n', dStart);
    expect(dStart).toBeGreaterThanOrEqual(0);
    const body = SETUP_SRC.slice(dStart, dEnd);
    expect(body).toContain('"$BROWSE_BIN" stop');
    expect(body).not.toMatch(/pkill/);
  });

  test('the call site warns-not-fails and never aborts setup', () => {
    expect(SETUP_SRC).toContain('if ! ensure_emoji_font; then');
    expect(SETUP_SRC).toContain('refresh_browse_daemon_for_fonts');
  });
});

// Behavior matrix: source the extracted helper into a temp shell with a faked
// PATH so we exercise the real control flow without touching the host system.
// We fake `uname` to report Linux so the guard doesn't short-circuit on the
// macOS/Linux test runner, and fake the package managers with sentinel-touching
// stubs so we can assert whether an install was attempted.
describe.skipIf(process.platform === 'win32')('setup: ensure_emoji_font behavior', () => {
  function runHelper(fcMatchOutput: string): {
    exit: number;
    installInstalled: string;
    aptCalled: boolean;
    fcCacheCalled: boolean;
    stderr: string;
  } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-emoji-'));
    try {
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      const sentinelApt = path.join(tmp, 'apt-called');
      const sentinelCache = path.join(tmp, 'fc-cache-called');

      const stub = (name: string, body: string) => {
        const p = path.join(bin, name);
        fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
        fs.chmodSync(p, 0o755);
      };
      stub('uname', 'echo Linux');
      // fc-match prints whatever the case wants; supports the -f format arg.
      stub('fc-match', `printf '%s\\n' ${JSON.stringify(fcMatchOutput)}`);
      stub('apt-get', `touch ${JSON.stringify(sentinelApt)}; exit 0`);
      stub('fc-cache', `touch ${JSON.stringify(sentinelCache)}; exit 0`);
      stub('sudo', 'shift; "$@"'); // sudo -n <cmd> → run <cmd> directly
      stub('command', ''); // never used; `command -v` is a builtin
      stub('timeout', 'shift; "$@"'); // timeout 30 <cmd> → run <cmd>
      stub('id', 'echo 1000'); // non-root so the sudo branch is taken

      const helper = extractHelper();
      const script = [
        'set -e',
        'EMOJI_FONT_INSTALLED=0',
        helper,
        'ensure_emoji_font; rc=$?',
        'echo "EXIT=$rc"',
        'echo "INSTALLED=$EMOJI_FONT_INSTALLED"',
      ].join('\n');

      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const out = result.stdout ?? '';
      return {
        exit: Number((out.match(/EXIT=(\d+)/) ?? [])[1] ?? -1),
        installInstalled: (out.match(/INSTALLED=(\d+)/) ?? [])[1] ?? '?',
        aptCalled: fs.existsSync(sentinelApt),
        fcCacheCalled: fs.existsSync(sentinelCache),
        stderr: result.stderr ?? '',
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('short-circuits when a color emoji font already resolves (no install)', () => {
    const r = runHelper('Noto Color Emoji\tTrue');
    expect(r.exit).toBe(0);
    expect(r.aptCalled).toBe(false);
    expect(r.installInstalled).toBe('0');
  });

  test('installs when only a non-color fallback resolves (color=False)', () => {
    const r = runHelper('LastResort\tFalse');
    expect(r.exit).toBe(0);
    expect(r.aptCalled).toBe(true);
    expect(r.fcCacheCalled).toBe(true);
    expect(r.installInstalled).toBe('1');
  });
});
