/**
 * setup: Chromium bootstrap is best-effort and bounded (#1900, #1901, #1902,
 * #913, #2233).
 *
 * Before: `set -e` plus a bare `bunx playwright install chromium` (and an
 * explicit `exit 1` after the post-install probe) sat in section "# 2", ahead
 * of "# 4. Install for Claude". An offline, proxied, or AppArmor-restricted
 * box ended with ZERO skills registered, and a wedged download hung setup
 * forever. Now every failure records a reason code in _PW_FAIL_REASON, the
 * install is deadline-bounded, lock contention is a reason (not a fatal), and
 * skill registration always runs.
 *
 * Two layers, following test/setup-emoji-font.test.ts's convention:
 *   1. static invariants over the anchor-sliced block (line-number agnostic);
 *   2. an integration harness that executes the REAL block with stubbed
 *      probe/installer so the exit path and reason codes are exercised.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { runBashScript } from './helpers/bash-script';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

const BLOCK_START = "# 2. Ensure Playwright's Chromium is available";
const BLOCK_END = '# 2b. Ensure a color-emoji font';

function slice(startAnchor: string, endAnchor: string): string {
  const start = SETUP_SRC.indexOf(startAnchor);
  const end = SETUP_SRC.indexOf(endAnchor, start);
  if (start < 0 || end < 0) throw new Error(`anchor not found: ${startAnchor} .. ${endAnchor}`);
  return SETUP_SRC.slice(start, end);
}

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`function not found: ${name}`);
  return SETUP_SRC.slice(start, end + 2);
}

const block = slice(BLOCK_START, BLOCK_END);
const codeLines = block.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('setup: Chromium bootstrap static invariants', () => {
  test('no exit inside the bootstrap block (skills must always register)', () => {
    // The only `exit` allowed is inside the INT/TERM trap string (Ctrl-C must
    // still terminate setup after killing the installer); a bare statement is not.
    const statements = codeLines.split('\n').filter((l) => !/^\s*trap /.test(l)).join('\n');
    expect(statements).not.toMatch(/\bexit 1\b/);
    expect(statements).not.toMatch(/\bexit\b/);
    expect(codeLines).toMatch(/trap '_kill_tree "\$_PW_PID".*exit 130' INT TERM/);
    expect(codeLines).toContain('trap - INT TERM');
  });

  test('every failure arm records a reason code', () => {
    for (const code of [
      'skipped', 'chromium-install', 'chromium-install-timeout', 'chromium-install-locked',
      'windows-no-node', 'windows-node-modules', 'post-install-launch',
    ]) {
      expect(codeLines).toContain(`_pw_fail ${code} `);
    }
  });

  test('the download is deadline-bounded through the shared helper and env knob', () => {
    expect(codeLines).toContain('_wait_with_deadline "$_PW_PID" "$_PW_INSTALL_TIMEOUT"');
    expect(codeLines).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT');
    // Non-numeric and 0 fall back to the default instead of breaking arithmetic
    // or killing the install on the first poll.
    expect(codeLines).toMatch(/case "\$_PW_INSTALL_TIMEOUT" in ''\|\*\[!0-9\]\*\)/);
    expect(codeLines).toContain('_PW_INSTALL_TIMEOUT=$((10#$_PW_INSTALL_TIMEOUT))');
    expect(codeLines).toContain('[ "$_PW_INSTALL_TIMEOUT" -gt 0 ] || _PW_INSTALL_TIMEOUT=600');
    expect(codeLines).toContain('[ "${#_PW_INSTALL_TIMEOUT}" -le 9 ] || _PW_INSTALL_TIMEOUT=600');
  });

  test('lock contention is a reason code, not a fatal', () => {
    expect(codeLines).toContain('_pw_fail chromium-install-locked');
    expect(block).toContain('GSTACK_SKIP_PLAYWRIGHT');
  });

  test('the lock EXIT trap still chains cleanup_copied_bun and is restored', () => {
    expect(codeLines).toContain("trap 'rm -rf \"$_PW_LOCK\" 2>/dev/null || true; cleanup_copied_bun' EXIT");
    expect(codeLines).toContain('trap cleanup_copied_bun EXIT');
  });

  test('the daemon font refresh is skipped when Chromium is unavailable', () => {
    const emoji = slice(BLOCK_END, '# 3. Ensure ~/.gstack global state directory exists');
    expect(emoji).toContain('elif [ -z "$_PW_FAIL_REASON" ]; then');
    expect(emoji).toContain('refresh_browse_daemon_for_fonts');
  });

  test('the final summary names the affected skills and the reason', () => {
    const tail = SETUP_SRC.slice(SETUP_SRC.indexOf('Chromium bootstrap summary'));
    expect(tail).toContain('Browser unavailable');
    for (const skill of ['/qa', '/design-review', '/browse', 'make-pdf', '/pair-agent']) {
      expect(tail).toContain(skill);
    }
    expect(tail).toContain('$_PW_FAIL_REASON');
    expect(tail).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=1800');
    expect(tail).toContain('GSTACK_CHROMIUM_NO_SANDBOX=1');
  });
});

/**
 * Integration harness: the real block + the real deadline helpers, with the
 * probe and installer stubbed. `bunx` is a shell function, so the block's
 * subshell inherits the stub. Emits REASON=... and REACHED_END=1 so the test
 * can prove setup continued past the block.
 */
function runBlock(opts: {
  probe: 'ok' | 'fail' | 'fail-then-ok';  // fail-then-ok = fresh install: probe fails, install runs, probe passes
  bunx: string;             // body of the bunx stub
  env?: Record<string, string>;
  preLockPid?: string;      // pre-create the install lock held by this pid
  preLockNoPidAgeMin?: number; // pre-create a lock dir with NO pid file, this many minutes old
  preLockAgeMin?: number;   // with preLockPid: age the lock dir this many minutes
  markKill?: boolean;       // record _kill_tree invocations to $MARK
  isWindows?: '0' | '1';
  prelude?: string;         // extra shell lines (node/npm stubs) injected before the block
  platformOverride?: string; // value for _PLAYWRIGHT_PLATFORM_OVERRIDE (Ubuntu 26.04 path)
}): { stdout: string; stderr: string; status: number; elapsedMs: number; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pw-block-'));
  const mark = path.join(tmp, 'mark');
  const killTree = opts.markKill
    ? extractFn('_kill_tree').replace('_kill_tree() {', '_kill_tree_orig() {') +
      `\n_kill_tree() { echo killed >> "${mark}"; _kill_tree_orig "$1"; }\n`
    : extractFn('_kill_tree');
  if (opts.preLockPid) {
    const lock = path.join(tmp, 'gstack-playwright-install.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), opts.preLockPid);
    if (opts.preLockAgeMin !== undefined) {
      const t = new Date(Date.now() - opts.preLockAgeMin * 60_000);
      fs.utimesSync(lock, t, t);
    }
  }
  if (opts.preLockNoPidAgeMin !== undefined) {
    const lock = path.join(tmp, 'gstack-playwright-install.lock');
    fs.mkdirSync(lock);
    const t = new Date(Date.now() - opts.preLockNoPidAgeMin * 60_000);
    fs.utimesSync(lock, t, t);
  }
  const probeFn = opts.probe === 'fail-then-ok'
    ? 'ensure_playwright_browser() { if [ -f "$MARK.probed" ]; then return 0; fi; : > "$MARK.probed"; return 1; }'
    : `ensure_playwright_browser() { ${opts.probe === 'ok' ? 'return 0' : 'return 1'}; }`;
  const script = [
    'set -e',
    `IS_WINDOWS=${opts.isWindows ?? '0'}`,
    `SOURCE_GSTACK_DIR="${tmp}"`,
    `TMPDIR="${tmp}"`,
    `MARK="${mark}"`,
    `_PLAYWRIGHT_PLATFORM_OVERRIDE="${opts.platformOverride ?? ''}"`,
    // EXIT-trap witness: the block chains its lock trap onto cleanup_copied_bun
    // and must leave cleanup_copied_bun installed when it is done.
    'cleanup_copied_bun() { echo cleanup >> "$MARK.exit"; }',
    'trap cleanup_copied_bun EXIT',
    '_clear_playwright_quarantine() { :; }',
    probeFn,
    opts.prelude ?? '',
    `bunx() { echo "bunx-called override=${'$'}{PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-unset}" >> "$MARK"; ${opts.bunx}; }`,
    killTree,
    extractFn('_wait_with_deadline'),
    // The block opens with the /etc/os-release probe that RESETS the override
    // variable; a test that injects an override must start after that probe.
    opts.platformOverride !== undefined ? slice('# Chromium is BEST-EFFORT', BLOCK_END) : block,
    'echo "REASON=$_PW_FAIL_REASON"',
    'echo "REACHED_END=1"',
  ].join('\n');
  const scriptPath = path.join(tmp, 'block.sh');
  fs.writeFileSync(scriptPath, script);
  const t0 = Date.now();
  const r = spawnSync('bash', [scriptPath], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', HOME: tmp, ...(opts.env ?? {}) },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1, elapsedMs: Date.now() - t0, tmp };
}

describe('setup: Chromium bootstrap block executes best-effort', () => {
  test('probe ok: no reason recorded, no install attempted', () => {
    const r = runBlock({ probe: 'ok', bunx: 'exit 0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=\n');
    expect(r.stdout).toContain('REACHED_END=1');
    expect(fs.existsSync(path.join(r.tmp, 'mark'))).toBe(false);
  });

  test('install exits non-zero: reason chromium-install, setup continues (was: exit 1 before any skill registered)', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 7' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install\n');
    expect(r.stdout).toContain('REACHED_END=1');
    expect(r.stderr).toContain('chromium-install');
    expect(r.stderr).toContain('exited 7');
  });

  test('install hangs: killed at the deadline with reason chromium-install-timeout, tree kill recorded', () => {
    const r = runBlock({
      probe: 'fail', bunx: 'sleep 30', markKill: true,
      env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install-timeout\n');
    expect(r.stdout).toContain('REACHED_END=1');
    expect(r.elapsedMs).toBeLessThan(20_000);
    expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('killed');
  }, 15_000);

  test('non-numeric timeout knob falls back to the default instead of erroring', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 3', env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: 'soon' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install\n');
  });

  test('lock held by a live process: reason chromium-install-locked, setup continues (was: exit 1)', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', preLockPid: String(process.pid) });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install-locked\n');
    expect(r.stdout).toContain('REACHED_END=1');
    // The installer must not have run under a foreign lock.
    expect(fs.existsSync(path.join(r.tmp, 'mark'))).toBe(false);
    // And the foreign lock is left for its owner.
    expect(fs.existsSync(path.join(r.tmp, 'gstack-playwright-install.lock'))).toBe(true);
  });

  test('stale lock (dead pid) is reclaimed and the install proceeds', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', preLockPid: '4194305' /* above Linux's largest pid_max: never a live pid */ });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('reclaiming stale Chromium-install lock');
    expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('bunx-called');
  });

  test('a lock whose pid file is garbage (-1, abc, 0) is stale, not "locked": kill -0 -1 would signal everything and "succeed"', () => {
    for (const pid of ['-1', 'abc', '0']) {
      const r = runBlock({ probe: 'fail', bunx: 'exit 0', preLockPid: pid });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('bunx-called');
      expect(r.stdout).not.toContain('chromium-install-locked');
    }
  }, 15_000);

  test('a lock held by a LIVE pid but older than the install bound is reclaimed (holder past its deadline, or a recycled pid)', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', preLockPid: String(process.pid), preLockAgeMin: 30, env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '60' } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('bunx-called');
    expect(r.stdout).not.toContain('chromium-install-locked');
    expect(r.stderr).toContain('past the install bound');
  }, 15_000);

  test('a lock dir with NO pid file is reclaimed once older than the install bound, and honored while fresh', () => {
    const old = runBlock({ probe: 'fail', bunx: 'exit 0', preLockNoPidAgeMin: 30, env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '60' } });
    expect(old.status).toBe(0);
    expect(fs.readFileSync(path.join(old.tmp, 'mark'), 'utf-8')).toContain('bunx-called');
    expect(old.stdout).not.toContain('chromium-install-locked');
    const fresh = runBlock({ probe: 'fail', bunx: 'exit 0', preLockNoPidAgeMin: 0, env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '600' } });
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain('REASON=chromium-install-locked\n');
  }, 15_000);

  test('_kill_tree without pgrep on PATH still kills the grandchild (walks /proc)', () => {
    if (!fs.existsSync('/proc')) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-killtree-'));
    try {
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(bin);
      for (const name of ['bash', 'sleep', 'awk']) {
        const real = (spawnSync('which', [name], { encoding: 'utf-8', timeout: 10_000 }).stdout ?? '').trim();
        if (real) fs.symlinkSync(real, path.join(bin, name));
      }
      const script = [
        `export PATH="${bin}"`,
        'hash -r',
        'command -v pgrep >/dev/null 2>&1 && { echo "PGREP_PRESENT"; exit 0; }',
        extractFn('_kill_tree'),
        // two commands so bash forks a real subshell instead of exec-ing sleep directly
        '( sleep 30; true ) & pid=$!',
        'sleep 0.3',
        // find the sleep grandchild via /proc, the same way the fallback does
        'child=$(awk -v p="$pid" \'{ s=$0; sub(/^[^)]*\\) /, "", s); split(s, f, " "); if (f[2]==p) { print $1; exit } }\' /proc/[0-9]*/stat 2>/dev/null)',
        '[ -n "$child" ] || { echo "NO_CHILD"; exit 0; }',
        '_kill_tree "$pid"',
        'sleep 0.3',
        'if kill -0 "$child" 2>/dev/null; then echo "CHILD_ALIVE"; else echo "CHILD_DEAD"; fi',
      ].join('\n');
      const r = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf-8', timeout: 20_000 });
      expect(r.stdout).toContain('CHILD_DEAD');
      expect(r.stdout).not.toContain('PGREP_PRESENT');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test('install succeeds but the post-install probe fails: reason post-install-launch with the userns hint', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=post-install-launch\n');
    expect(r.stderr).toContain('GSTACK_CHROMIUM_NO_SANDBOX=1');
  });

  test('GSTACK_SKIP_PLAYWRIGHT=1: reason skipped, installer never invoked (#913)', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', env: { GSTACK_SKIP_PLAYWRIGHT: '1' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=skipped\n');
    expect(fs.existsSync(path.join(r.tmp, 'mark'))).toBe(false);
  });
});

/** A PATH that carries the tools the block needs but NO node — `command -v`
 *  also finds shell functions, so hiding node from PATH is the only faithful
 *  way to stand in for a Windows box without Node.js. */
function pathWithoutNode(): { bin: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-nonode-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['bash', 'mkdir', 'rm', 'sleep', 'cat', 'pgrep', 'grep', 'cut', 'tr', 'dirname', 'basename']) {
    const real = (spawnSync('which', [name], { encoding: 'utf-8', timeout: 10_000 }).stdout ?? '').trim();
    if (real) fs.symlinkSync(real, path.join(bin, name));
  }
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('setup: Chromium bootstrap block — fresh install, lock hygiene, override, Windows arms', () => {
  test('fresh install happy path: probe fails, install succeeds, re-probe passes → no reason, lock released, EXIT trap restored', () => {
    const r = runBlock({ probe: 'fail-then-ok', bunx: 'exit 0' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=\n');
    expect(r.stdout).toContain('REACHED_END=1');
    // Installer ran exactly once (no override on a non-26.04 path).
    const mark = fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8');
    expect(mark.split('\n').filter((l) => l.startsWith('bunx-called')).length).toBe(1);
    expect(mark).toContain('override=unset');
    // The mkdir-mutex is released for the next setup...
    expect(fs.existsSync(path.join(r.tmp, 'gstack-playwright-install.lock'))).toBe(false);
    // ...and the chained trap was restored, so cleanup_copied_bun still fires at exit.
    expect(fs.readFileSync(path.join(r.tmp, 'mark.exit'), 'utf-8')).toContain('cleanup');
  });

  test('failed install still releases the lock and keeps cleanup_copied_bun on the EXIT trap', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 7' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=chromium-install\n');
    expect(fs.existsSync(path.join(r.tmp, 'gstack-playwright-install.lock'))).toBe(false);
    expect(fs.readFileSync(path.join(r.tmp, 'mark.exit'), 'utf-8')).toContain('cleanup');
  });

  test('Ubuntu 26.04 override reaches the installer as PLAYWRIGHT_HOST_PLATFORM_OVERRIDE (#2101)', () => {
    const r = runBlock({ probe: 'fail-then-ok', bunx: 'exit 0', platformOverride: 'ubuntu24.04-x64' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=\n');
    expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('override=ubuntu24.04-x64');
  });

  test('Windows without Node.js: reason windows-no-node, setup continues (was: exit 1), post-install probe skipped', () => {
    const { bin, cleanup } = pathWithoutNode();
    try {
      const r = runBlock({ probe: 'fail', bunx: 'exit 0', isWindows: '1', env: { PATH: bin } });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('REASON=windows-no-node\n');
      expect(r.stdout).toContain('REACHED_END=1');
      expect(r.stderr).toContain('nodejs.org');
      // The install itself ran; only the Node verification failed.
      expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('bunx-called');
    } finally {
      cleanup();
    }
  });

  test('Windows with Node.js but npm cannot install playwright/@ngrok: reason windows-node-modules, setup continues', () => {
    const r = runBlock({
      probe: 'fail', bunx: 'exit 0', isWindows: '1',
      prelude: 'node() { return 1; }\nnpm() { echo "npm $*" >> "$MARK"; return 1; }',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=windows-node-modules\n');
    expect(r.stdout).toContain('REACHED_END=1');
    expect(r.stdout).toContain('Windows detected');
    expect(fs.readFileSync(path.join(r.tmp, 'mark'), 'utf-8')).toContain('npm install --no-save playwright');
  });

  test('Windows with Node.js loading Playwright but the launch probe failing: Windows-specific post-install-launch hint', () => {
    const r = runBlock({ probe: 'fail', bunx: 'exit 0', isWindows: '1', prelude: 'node() { return 0; }' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REASON=post-install-launch\n');
    expect(r.stderr).toContain('via Node.js');
    expect(r.stderr).toContain('oven-sh/bun#4253');
    // The Linux userns hint belongs to the other arm.
    expect(r.stderr).not.toContain('GSTACK_CHROMIUM_NO_SANDBOX');
  });
});

/** The 2b emoji-font step: the daemon font refresh must only run when the
 *  browser actually works — otherwise setup prints a second failure line. */
function runEmojiStep(reason: string, fontOk: boolean): { stdout: string; stderr: string; status: number } {
  const emoji = slice(BLOCK_END, '# 3. Ensure ~/.gstack global state directory exists');
  const script = [
    'set -e',
    `_PW_FAIL_REASON="${reason}"`,
    `ensure_emoji_font() { return ${fontOk ? 0 : 1}; }`,
    'refresh_browse_daemon_for_fonts() { echo REFRESHED; }',
    emoji,
    'echo "REACHED_END=1"',
  ].join('\n');
  const r = runBashScript(script, { timeout: 10_000 });
  if (/command not found/.test(r.stderr ?? '')) throw new Error(`harness drift (missing extracted helper):\n${r.stderr}`);
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

describe('setup: emoji-font daemon refresh is gated on Chromium availability', () => {
  test('font installed + Chromium usable → daemon refreshed; font installed + Chromium unavailable → no refresh; font missing → note, no refresh', () => {
    const usable = runEmojiStep('', true);
    expect(usable.status).toBe(0);
    expect(usable.stdout).toContain('REFRESHED');
    expect(usable.stdout).toContain('REACHED_END=1');

    const unavailable = runEmojiStep('chromium-install', true);
    expect(unavailable.status).toBe(0);
    expect(unavailable.stdout).not.toContain('REFRESHED');
    expect(unavailable.stdout).toContain('REACHED_END=1');

    const noFont = runEmojiStep('', false);
    expect(noFont.status).toBe(0);
    expect(noFont.stdout).not.toContain('REFRESHED');
    expect(noFont.stderr).toContain('could not auto-install a color-emoji font');
    expect(noFont.stdout).toContain('REACHED_END=1');
  });
});

/** The final summary block, executed with a recording telemetry stub. */
function runSummary(reason: string, telemetry: 'ok' | 'fail' | 'missing', prelude: string[] = []): { stdout: string; stderr: string; status: number; argv: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pw-summary-'));
  try {
    const argvFile = path.join(tmp, 'telemetry.argv');
    if (telemetry !== 'missing') {
      fs.mkdirSync(path.join(tmp, 'bin'));
      const stub = path.join(tmp, 'bin', 'gstack-telemetry-log');
      fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" >> "${argvFile}"\nexit ${telemetry === 'ok' ? 0 : 1}\n`);
      fs.chmodSync(stub, 0o755);
    }
    const tail = SETUP_SRC.slice(SETUP_SRC.indexOf('# ─── Chromium bootstrap summary'));
    const script = [
      'set -e',
      'QUIET=0',
      'log() { [ "$QUIET" -eq 0 ] && echo "$@" || true; }',
      `SOURCE_GSTACK_DIR="${tmp}"`,
      `_PW_FAIL_REASON="${reason}"`,
      ...prelude,
      tail,
      'echo "REACHED_END=1"',
    ].join('\n');
    const r = runBashScript(script, { timeout: 10_000 });
    if (/command not found/.test(r.stderr ?? '')) throw new Error(`harness drift (missing extracted helper):\n${r.stderr}`);
    const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf-8') : '';
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1, argv };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('setup: Chromium bootstrap summary block executes', () => {
  test('names the reason and the affected skills; hints are reason-specific; telemetry gets the reason code only', () => {
    const timeout = runSummary('chromium-install-timeout', 'ok');
    expect(timeout.status).toBe(0);
    expect(timeout.stdout).toContain('Browser unavailable: Chromium bootstrap did not complete (chromium-install-timeout)');
    for (const skill of ['/qa', '/qa-only', '/design-review', '/browse', 'make-pdf', '/pair-agent']) {
      expect(timeout.stdout).toContain(skill);
    }
    expect(timeout.stdout).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=1800');
    expect(timeout.stdout).not.toContain('GSTACK_CHROMIUM_NO_SANDBOX');
    // Reason code only, never a path or command line; --no-sweep keeps the
    // one-shot event from finalizing other sessions' pending markers.
    expect(timeout.argv.trim()).toBe('--event-type onboarding --skill _setup_playwright --outcome chromium-install-timeout --no-sweep');

    const launch = runSummary('post-install-launch', 'ok');
    expect(launch.stdout).toContain('GSTACK_CHROMIUM_NO_SANDBOX=1');
    expect(launch.stdout).not.toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=1800');
    expect(launch.argv).toContain('--outcome post-install-launch');

    const offline = runSummary('chromium-install', 'ok');
    expect(offline.stdout).toContain('Browser unavailable');
    expect(offline.stdout).not.toContain('GSTACK_CHROMIUM_NO_SANDBOX');
    expect(offline.stdout).not.toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=1800');
  });

  test('silent when Chromium is fine; a missing or failing telemetry binary never breaks the tail of setup', () => {
    const fine = runSummary('', 'ok');
    expect(fine.status).toBe(0);
    expect(fine.stdout).toBe('REACHED_END=1\n');
    expect(fine.argv).toBe('');

    const missing = runSummary('chromium-install', 'missing');
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('Browser unavailable');
    expect(missing.stdout).toContain('REACHED_END=1');

    const failing = runSummary('chromium-install', 'fail');
    expect(failing.status).toBe(0);
    expect(failing.stdout).toContain('REACHED_END=1');
    expect(failing.argv).toContain('--outcome chromium-install');
  });

  test('the summary names foreign entries left untouched and customized SKILL.md files moved to the backup root', () => {
    const r = runSummary('', 'missing', ['_FOREIGN_SKIPPED_ENTRIES=(qa)', '_BACKED_UP_SKILL_MDS=(ship review)', '_SKILL_BACKUP_ROOT="/tmp/gstack-bk/20260904"']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Not registered (a skill you own already uses the name; left untouched): qa');
    expect(r.stdout).toContain("Moved 2 customized SKILL.md file(s) to /tmp/gstack-bk/20260904 before installing gstack's: ship review");
    expect(r.stdout).not.toContain('Browser unavailable');
    expect(r.stdout).toContain('REACHED_END=1');
    // Nothing to report → neither line.
    const quiet = runSummary('', 'missing');
    expect(quiet.stdout).not.toContain('Not registered');
    expect(quiet.stdout).not.toContain('Moved ');
  });

  test('an explicit opt-out (skipped) is reported as a choice, not a failure, and sends no telemetry', () => {
    const skipped = runSummary('skipped', 'ok');
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain('Chromium install skipped by request (GSTACK_SKIP_PLAYWRIGHT=1)');
    expect(skipped.stdout).not.toContain('Browser unavailable');
    expect(skipped.stdout).not.toContain('Fix the cause');
    expect(skipped.argv).toBe('');
  });

  test('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT=0, 000, or a value past nine digits means the default, not kill-on-first-poll or unbounded', () => {
    for (const v of ['0', '000', '99999999999999999999', 'abc', '']) {
      const r = runBlock({ probe: 'fail', bunx: 'exit 3', env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: v } });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('REASON=chromium-install\n');
    }
    // A wedged installer under "000" is still bounded by the DEFAULT, so with a
    // 1s override written as "0001" it is killed and classified as a timeout.
    const bounded = runBlock({ probe: 'fail', bunx: 'sleep 30', env: { GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '0001' } });
    expect(bounded.stdout).toContain('REASON=chromium-install-timeout\n');
  }, 30_000);
});

/**
 * .gstack-owned marker (#2119): Windows installs COPY SKILL.md, so there is no
 * symlink to readlink. link_claude_skill_dirs writes the marker; gstack-relink
 * and cleanup_old_claude_symlinks prove provenance by it instead of by name.
 */
function runLinker(opts: {
  isWindows: '0' | '1';
  payload: string[];
  plant?: (skills: string, payload: string) => void;
}): { status: number; stdout: string; stderr: string; skills: string; payload: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-marker-'));
  const skills = path.join(tmp, 'skills');
  const payload = path.join(skills, 'gstack');
  fs.mkdirSync(payload, { recursive: true });
  for (const name of opts.payload) {
    fs.mkdirSync(path.join(payload, name));
    fs.writeFileSync(path.join(payload, name, 'SKILL.md'), `---\nname: ${name}\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n# ${name}\n`);
  }
  opts.plant?.(skills, payload);
  const script = [
    'set -e',
    `IS_WINDOWS=${opts.isWindows}`,
    'SKILL_PREFIX=0',
    // Keep the operator's real render dir out of the picture.
    `GSTACK_USER_RENDER_DIR="${path.join(tmp, 'no-render')}"`,
    '_link_skill_runtime_assets() { :; }',
    '_print_windows_copy_note_once() { :; }',
    '_FOREIGN_SKIPPED_ENTRIES=()',
    extractFn('_link_or_copy'),
    extractFn('_gstack_link_target_abs'),
    extractFn('_gstack_target_is_ours'),
    extractFn('_claude_entry_is_ours'),
    extractFn('_write_owned_marker'),
    extractFn('_gstack_generated_header'),
    extractFn('_claude_entry_owned_strongly'),
    extractFn('_backup_skill_md'),
    extractFn('_cleanup_weak_dir'),
    extractFn('_gstack_dir_only_links'),
    extractFn('_cleanup_linked_dir'),
    '_BACKED_UP_SKILL_MDS=()',
    '_SKILL_BACKUP_ROOT="$HOME/.gstack/backups/skills/test"',
    extractFn('link_claude_skill_dirs'),
    extractFn('cleanup_old_claude_symlinks'),
    `link_claude_skill_dirs "${payload}" "${skills}"`,
    'echo "FOREIGN=${_FOREIGN_SKIPPED_ENTRIES[*]:-}"',
  ].join('\n');
  const r = runBashScript(script, { timeout: 10_000, env: { PATH: process.env.PATH ?? '', HOME: tmp } });
  if (/command not found/.test(r.stderr ?? '')) throw new Error(`harness drift (missing extracted helper):\n${r.stderr}`);
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', skills, payload, tmp };
}

describe.skipIf(process.platform === 'win32')('setup: .gstack-owned ownership marker for Windows copy installs (#2119)', () => {
  test('the marker is written beside a COPIED SKILL.md (IS_WINDOWS=1) and beside a symlinked one (IS_WINDOWS=0): a directory we created is ours on every platform', () => {
    const win = runLinker({ isWindows: '1', payload: ['qa', 'ship'] });
    try {
      expect(win.status).toBe(0);
      for (const name of ['qa', 'ship']) {
        const md = path.join(win.skills, name, 'SKILL.md');
        expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
        expect(fs.existsSync(path.join(win.skills, name, '.gstack-owned'))).toBe(true);
      }
      expect(win.stdout).toContain('linked skills: qa ship');
    } finally {
      fs.rmSync(win.tmp, { recursive: true, force: true });
    }

    const unix = runLinker({ isWindows: '0', payload: ['qa'] });
    try {
      expect(unix.status).toBe(0);
      expect(fs.lstatSync(path.join(unix.skills, 'qa', 'SKILL.md')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(unix.skills, 'qa', '.gstack-owned'))).toBe(true);
    } finally {
      fs.rmSync(unix.tmp, { recursive: true, force: true });
    }
  });

  test('marker writer → cleanup reader: copies the Windows linker marked are reaped on a mode flip; an unmarked same-name skill survives', () => {
    // Phase 1: a Windows install links qa + ship (copies + markers).
    const r = runLinker({ isWindows: '1', payload: ['qa', 'ship'] });
    try {
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(r.skills, 'qa', '.gstack-owned'))).toBe(true);
      expect(fs.existsSync(path.join(r.skills, 'ship', '.gstack-owned'))).toBe(true);
      // Phase 2: the payload now also ships `review`, and the user has their
      // OWN hand-written `review` (no marker, not byte-identical, no generated
      // header) plus an unrelated `my-own`. A mode flip runs the cleanup.
      fs.mkdirSync(path.join(r.payload, 'review'));
      fs.writeFileSync(path.join(r.payload, 'review', 'SKILL.md'), '---\nname: review\n---\n<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n<!-- Regenerate: bun run gen:skill-docs -->\n# review\n');
      fs.mkdirSync(path.join(r.skills, 'review'));
      fs.writeFileSync(path.join(r.skills, 'review', 'SKILL.md'), '---\nname: review\n---\n# mine, hand-written\n');
      fs.mkdirSync(path.join(r.skills, 'my-own'));
      fs.writeFileSync(path.join(r.skills, 'my-own', 'SKILL.md'), '---\nname: my-own\n---\n');
      const flip = runBashScript([
        'set -e', 'IS_WINDOWS=1',
        extractFn('_gstack_link_target_abs'), extractFn('_gstack_target_is_ours'), extractFn('_gstack_dir_only_links'), extractFn('_cleanup_linked_dir'), extractFn('_gstack_generated_header'), extractFn('_cleanup_weak_dir'), extractFn('_backup_skill_md'), '_BACKED_UP_SKILL_MDS=()', '_SKILL_BACKUP_ROOT="$HOME/.gstack/backups/skills/test"',
        extractFn('cleanup_old_claude_symlinks'),
        `cleanup_old_claude_symlinks "${r.payload}" "${r.skills}"`,
      ].join('\n'), { timeout: 10_000 });
      expect(flip.status).toBe(0);
      expect(flip.stdout).toContain('cleaned up old entries:');
      expect(flip.stdout).toContain('qa');
      expect(flip.stdout).toContain('ship');
      expect(flip.stdout).not.toContain('review');
      expect(fs.readdirSync(r.skills).sort()).toEqual(['gstack', 'my-own', 'review']);
      expect(fs.readFileSync(path.join(r.skills, 'review', 'SKILL.md'), 'utf-8')).toContain('mine, hand-written');
    } finally {
      fs.rmSync(r.tmp, { recursive: true, force: true });
    }
  });
});
