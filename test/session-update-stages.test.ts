import { afterEach, describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// B11: the auto-updater wrote the "just upgraded" marker after setup failed
// (or was skipped because bun was missing), and only re-ran setup when HEAD
// moved, so a failed install was never retried. Pull, setup and migrations
// are now separate stages: the marker is written only when all succeed, a
// failed stage is persisted and retried with backoff even when HEAD did not
// move, and every session start prints one failure line with the fix.

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-session-update');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

/** PATH without any bun: directories holding bun are replaced by shims of everything else. */
function pathWithoutBun(base: string): string {
  return (process.env.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean).map((dir, i) => {
    if (!fs.existsSync(path.join(dir, 'bun'))) return dir;
    const shim = path.join(base, `nobun-${i}`);
    if (fs.existsSync(shim)) return shim;
    fs.mkdirSync(shim, { recursive: true });
    for (const name of fs.readdirSync(dir)) if (name !== 'bun') fs.symlinkSync(path.join(dir, name), path.join(shim, name));
    return shim;
  }).join(':');
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-supd-stages-'));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-config'),
    '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; *) echo "";; esac; fi\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  // Stub setup: records each run; $SETUP_CONTROL selects the outcome.
  fs.writeFileSync(path.join(seed, 'setup'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$SETUP_CALLS"',
    'case "$(cat "$SETUP_CONTROL" 2>/dev/null)" in',
    '  fail) echo "error: could not build browse" >&2; exit 1 ;;',
    '  migfail) echo "  warning: migration 1.1.0 failed; the state root stays marked at 1.0.0, so the next ./setup retries it" >&2; exit 1 ;;',
    'esac',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
  const control = path.join(base, 'control');
  const calls = path.join(base, 'calls');
  return { base, seed, install, state, home, control, calls };
}

type Fx = ReturnType<typeof makeFixture>;

function upstreamRelease(fx: Fx, version: string) {
  fs.writeFileSync(path.join(fx.seed, 'VERSION'), `${version}\n`);
  git(fx.seed, 'commit', '-aqm', `release ${version}`);
  git(fx.seed, 'push', '-q', 'origin', 'main');
}

function runHook(fx: Fx, opts: { noBun?: boolean } = {}) {
  const PATH = opts.noBun ? pathWithoutBun(fx.base) : `${path.dirname(process.execPath)}:${process.env.PATH}`;
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH, HOME: fx.home, GSTACK_DIR: fx.install, GSTACK_STATE_ROOT: fx.state, SETUP_CONTROL: fx.control, SETUP_CALLS: fx.calls, TMPDIR: fx.base },
    timeout: 20_000,
  });
}

/** Wait for the forked updater to log `pattern` `count` times and release its lock. */
async function waitFor(fx: Fx, pattern: RegExp, count = 1, ms = 15_000): Promise<string> {
  const logFile = path.join(fx.state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  let content = '';
  while (Date.now() < deadline) {
    content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const hits = content.split('\n').filter(l => pattern.test(l)).length;
    if (hits >= count && !fs.existsSync(path.join(fx.state, '.setup-lock'))) return content;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${pattern} x${count}; log:\n${content}`);
}

const marker = (fx: Fx) => path.join(fx.state, 'just-upgraded-from');
const pending = (fx: Fx) => path.join(fx.state, 'session-update-pending');
const setupRuns = (fx: Fx) => (fs.existsSync(fx.calls) ? fs.readFileSync(fx.calls, 'utf8').trim().split('\n').length : 0);
/** Let the next hook run start a check: the hourly throttle has elapsed. */
const expireThrottle = (fx: Fx) => fs.rmSync(path.join(fx.state, '.last-session-update'), { force: true });
const expireBackoff = (fx: Fx) => fs.writeFileSync(pending(fx), fs.readFileSync(pending(fx), 'utf8').replace(/^next=\d+$/m, 'next=0'));

describe.skipIf(process.platform === 'win32')('gstack-session-update stages (B11)', () => {
  test('setup failure: no upgrade announcement, one failure line, retried with HEAD unchanged after backoff', async () => {
    const fx = makeFixture();
    fs.writeFileSync(fx.control, 'fail');
    upstreamRelease(fx, '1.1.0');

    expect(runHook(fx).stdout).toBe('');
    await waitFor(fx, /Z PENDING stages=setup attempt=1/);
    expect(fs.existsSync(marker(fx))).toBe(false);
    expect(setupRuns(fx)).toBe(1);
    const state = fs.readFileSync(pending(fx), 'utf8');
    expect(state).toContain('stages=setup\n');
    expect(state).toContain('from=1.0.0\n');
    expect(state).toMatch(/reason=\.\/setup exited 1: error: could not build browse\n/);

    // Next session start inside the backoff window: the line, but no setup run.
    expireThrottle(fx);
    const second = runHook(fx);
    expect(second.stdout.trim().split('\n')).toEqual([
      `gstack auto-update: setup did not finish (./setup exited 1: error: could not build browse); installed skills may be out of date. gstack retries automatically. Fix now: cd ${fx.install} && ./setup`,
    ]);
    await waitFor(fx, /PENDING_BACKOFF stages=setup/);
    expect(setupRuns(fx)).toBe(1);

    // After the backoff, the pending stage is retried although HEAD is unchanged.
    fs.writeFileSync(fx.control, 'ok');
    expireThrottle(fx);
    expireBackoff(fx);
    runHook(fx);
    await waitFor(fx, /UPDATED from=1\.0\.0 to=1\.1\.0/);
    expect(setupRuns(fx)).toBe(2);
    expect(fs.readFileSync(marker(fx), 'utf8').trim()).toBe('1.0.0');
    expect(fs.existsSync(pending(fx))).toBe(false);
    expireThrottle(fx);
    expect(runHook(fx).stdout).toBe('');
    await waitFor(fx, /UP_TO_DATE/);
  });

  test('backoff grows: update-check interval, then 6h, then 24h', async () => {
    const fx = makeFixture();
    fs.writeFileSync(fx.control, 'fail');
    upstreamRelease(fx, '1.1.0');
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (attempt > 1) { expireThrottle(fx); expireBackoff(fx); }
      const before = Math.floor(Date.now() / 1000);
      runHook(fx);
      await waitFor(fx, /Z PENDING stages=setup attempt=/, attempt);
      const next = Number(fs.readFileSync(pending(fx), 'utf8').match(/^next=(\d+)$/m)![1]);
      waits.push(Math.round((next - before) / 3600));
    }
    expect(waits).toEqual([1, 6, 24, 24]);
    expect(setupRuns(fx)).toBe(4);
    expect(fs.existsSync(marker(fx))).toBe(false);
  });

  test('bun missing: setup skipped is a pending stage with the install-Bun fix, never an announced upgrade', async () => {
    const fx = makeFixture();
    upstreamRelease(fx, '1.1.0');
    runHook(fx, { noBun: true });
    await waitFor(fx, /Z PENDING stages=setup attempt=1/);
    expect(fs.readFileSync(path.join(fx.state, 'analytics', 'session-update.log'), 'utf8')).toContain('SETUP_SKIPPED bun_missing');
    expect(fs.existsSync(marker(fx))).toBe(false);
    expect(setupRuns(fx)).toBe(0);
    expireThrottle(fx);
    expect(runHook(fx, { noBun: true }).stdout).toContain(`(bun not found on PATH); installed skills may be out of date. gstack retries automatically. Fix now: install Bun (https://bun.sh), then cd ${fx.install} && ./setup`);
  });

  test('a failed migration is its own stage', async () => {
    const fx = makeFixture();
    fs.writeFileSync(fx.control, 'migfail');
    upstreamRelease(fx, '1.1.0');
    runHook(fx);
    await waitFor(fx, /MIGRATIONS_FAILED reason=migration 1\.1\.0 failed/);
    expect(fs.readFileSync(pending(fx), 'utf8')).toContain('stages=migrations\n');
    expect(fs.existsSync(marker(fx))).toBe(false);
    expireThrottle(fx);
    expect(runHook(fx).stdout).toContain('gstack auto-update: migrations did not finish (migration 1.1.0 failed)');
  });

  test('all stages pass: the marker is written once and nothing is printed', async () => {
    const fx = makeFixture();
    upstreamRelease(fx, '1.1.0');
    expect(runHook(fx).stdout).toBe('');
    await waitFor(fx, /UPDATED from=1\.0\.0 to=1\.1\.0/);
    expect(fs.readFileSync(marker(fx), 'utf8').trim()).toBe('1.0.0');
    expect(fs.existsSync(pending(fx))).toBe(false);
    expect(setupRuns(fx)).toBe(1);
  });
});
