import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// #2566: on a normal install, tracked files are locally patched (skill-prefix
// name rewrites, gbrain-refresh blocks), so a bare `git pull --ff-only`
// refused FOREVER — 308 consecutive PULL_FAILED entries observed, with the
// reason discarded by 2>/dev/null. The fix: --autostash un-wedges the pull
// over local edits, and stderr is captured into the log so a real failure
// names its cause.

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-session-update');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-supd-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  fs.mkdirSync(state, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'SKILL.md'), '# top\nname: qa\nbody line\n');
  // Stub config: auto_upgrade on, prefix off; gbrain-refresh no-op.
  fs.writeFileSync(
    path.join(seed, 'bin', 'gstack-config'),
    '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; *) echo "";; esac; fi\nexit 0\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  });
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install]);
  return { base, origin, seed, install, state };
}

function runScript(install: string, state: string) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, GSTACK_DIR: install, GSTACK_STATE_DIR: state },
    timeout: 20000,
  });
}

async function waitForLog(state: string, pattern: RegExp, ms = 15000): Promise<string> {
  const logFile = path.join(state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (pattern.test(content)) return content;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

describe('gstack-session-update pull wedge (#2566)', () => {
  test('locally-patched tracked files no longer wedge the ff-only pull', async () => {
    const { base, seed, install, state } = makeFixture();
    try {
      // Upstream advances (edit at the TOP of SKILL.md)…
      fs.writeFileSync(
        path.join(seed, 'SKILL.md'),
        '# top v2\nname: qa\nbody line\n',
      );
      git(seed, 'commit', '-aqm', 'upstream change');
      git(seed, 'push', '-q', 'origin', 'main');
      const upstreamHead = git(seed, 'rev-parse', 'HEAD');

      // …while the install carries a local patch at the BOTTOM (the
      // prefix-rename / gbrain-block shape: tracked file, modified).
      fs.appendFileSync(path.join(install, 'SKILL.md'), 'locally patched line\n');

      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /UPDATING|UP_TO_DATE|PULL_FAILED/);
      expect(log).not.toContain('PULL_FAILED');
      expect(log).toContain('UPDATING');
      expect(git(install, 'rev-parse', 'HEAD')).toBe(upstreamHead);
      // The autostash pop preserved the local patch over the new tree.
      expect(fs.readFileSync(path.join(install, 'SKILL.md'), 'utf8')).toContain(
        'locally patched line',
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  test('a genuinely failing pull logs its REASON, not just an exit code', async () => {
    const { base, seed, install, state } = makeFixture();
    try {
      // Diverge: local commit the remote doesn't have + remote advance → non-ff.
      fs.appendFileSync(path.join(install, 'VERSION'), 'local\n');
      git(install, 'commit', '-aqm', 'local divergence');
      fs.appendFileSync(path.join(seed, 'VERSION'), 'remote\n');
      git(seed, 'commit', '-aqm', 'remote divergence');
      git(seed, 'push', '-q', 'origin', 'main');

      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /PULL_FAILED/);
      expect(log).toContain('PULL_FAILED');
      const line = log.split('\n').find((l) => l.includes('PULL_FAILED')) ?? '';
      expect(line).toContain('reason=');
      expect(line).not.toContain('reason=unknown');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);
});

// ── #2613: the lock pidfile must record the LIVE holder, not the exited parent ──
//
// `echo $$` inside the backgrounded subshell recorded the parent hook's PID.
// The parent exits immediately, so every subsequent session judged the lock
// stale and rm -rf'd a LIVE holder's lock — concurrent updaters, the exact
// state the lock exists to prevent. Plus: a hard TTL (heartbeat-refreshed)
// bounds PID-reuse wedges and the empty/missing-pidfile races.

describe('gstack-session-update lock identity + TTL (#2613)', () => {
  function makeSlowGitShim(base: string, sleepSecs: number): string {
    const shimDir = path.join(base, 'shim');
    fs.mkdirSync(shimDir, { recursive: true });
    const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(
      path.join(shimDir, 'git'),
      `#!/usr/bin/env bash\ncase "$*" in *pull*) sleep ${sleepSecs};; esac\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    return shimDir;
  }

  function runScriptWithPath(install: string, state: string, shimDir: string) {
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, GSTACK_DIR: install, GSTACK_STATE_DIR: state, PATH: `${shimDir}:${process.env.PATH}` },
      timeout: 20000,
    });
  }

  function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  test('recorded pid is the live holder subshell, not the exited parent', async () => {
    const { base, install, state } = makeFixture();
    const shimDir = makeSlowGitShim(base, 3);
    try {
      const r = runScriptWithPath(install, state, shimDir);
      expect(r.status).toBe(0); // parent hook has EXITED by now (spawnSync waited)
      // Poll for the pidfile the detached subshell writes.
      const pidPath = path.join(state, '.setup-lock', 'pid');
      const deadline = Date.now() + 5000;
      let pid = 0;
      while (Date.now() < deadline) {
        if (fs.existsSync(pidPath)) {
          pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
          if (pid > 0) break;
        }
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(pid).toBeGreaterThan(0);
      // The lock is held (slow pull) — its recorded PID must be ALIVE.
      // Pre-fix this held the dead parent's PID and the assertion fails.
      expect(fs.existsSync(path.join(state, '.setup-lock'))).toBe(true);
      expect(isAlive(pid)).toBe(true);
      await waitForLog(state, /UP_TO_DATE|UPDATING|PULL_FAILED/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  test('a live lock with a live pid is respected and survives', async () => {
    const { base, install, state } = makeFixture();
    const holder = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const lockDir = path.join(state, '.setup-lock');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'pid'), String(holder.pid));
      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /SKIP locked_by=/);
      expect(log).toContain(`SKIP locked_by=${holder.pid}`);
      expect(fs.existsSync(lockDir)).toBe(true); // NOT rm -rf'd (#2613)
    } finally {
      holder.kill();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  test('a dead pid is reclaimed and the run proceeds', async () => {
    const { base, install, state } = makeFixture();
    try {
      const dead = spawnSync('true', { encoding: 'utf8' }); // reaped by the time spawnSync returns
      const lockDir = path.join(state, '.setup-lock');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'pid'), String(dead.pid));
      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /UP_TO_DATE|UPDATING/);
      expect(log).toMatch(/UP_TO_DATE|UPDATING/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  test('an empty pidfile inside the TTL window is NOT instantly reaped', async () => {
    const { base, install, state } = makeFixture();
    try {
      const lockDir = path.join(state, '.setup-lock');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'pid'), ''); // mkdir→echo race window
      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /SKIP locked_by=/);
      expect(log).toContain('SKIP locked_by=');
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  test('reclaim is TOCTOU-safe: both reclaim branches mv the lock aside atomically (static pin)', () => {
    // `rm -rf "$LOCK_DIR"` then `mkdir` lets TWO contenders both judge the
    // lock stale and both win (one rm can land between the other's rm and
    // mkdir). The atomic mv-aside makes exactly one contender own the reap:
    // the loser's mv fails and it backs off with SKIP lock_contested. Pin
    // that BOTH reclaim branches (TTL-expired and dead-PID) use it, and that
    // no bare in-place `rm -rf "$LOCK_DIR"` survives outside the holder's
    // own EXIT trap.
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const mvAside = src.match(/mv "\$LOCK_DIR" "\$LOCK_DIR\.reap\.\$\$" 2>\/dev\/null \|\| \{ log_entry "SKIP lock_contested"; exit 0; \}/g) || [];
    expect(mvAside.length).toBe(2); // TTL branch + dead-PID branch
    // The only rm -rf of the live lock dir is the holder's EXIT trap — and
    // even that one is ownership-checked (see the static pin below).
    const bareRms = src.match(/rm -rf "\$LOCK_DIR"(?!\.)/g) || [];
    expect(bareRms.length).toBe(1);
    expect(src).toContain(
      `trap 'kill "$HB_PID" 2>/dev/null; [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$MYPID" ] && rm -rf "$LOCK_DIR" 2>/dev/null' EXIT`,
    );
  });

  test('EXIT trap is ownership-checked and a heartbeat runs during pull/setup (static pins)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // (a) After a TTL reclaim by another updater, $LOCK_DIR belongs to the
    // NEW holder — the old holder's trap must remove the lock ONLY while the
    // pidfile still contains ITS pid (MYPID captured at write time).
    const trapLine = src.split('\n').find((l) => l.includes("trap '") && l.includes('rm -rf "$LOCK_DIR"'));
    expect(trapLine).toBeDefined();
    expect(trapLine!).toContain('[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$MYPID" ] && rm -rf "$LOCK_DIR"');
    // MYPID is written to the pidfile (the identity the trap compares against).
    expect(src).toContain('MYPID="${BASHPID:-$(sh -c \'echo $PPID\')}"');
    expect(src).toContain('echo "$MYPID" > "$LOCK_DIR/pid"');
    // (b) In-flight heartbeat: the step-boundary touches only fire AFTER the
    // pull / setup return, so a legitimately-slow step past the 30-min TTL
    // got reclaimed while ALIVE. The loop re-checks ownership each beat and
    // exits instead of touching a reclaimed holder's pidfile.
    expect(src).toMatch(
      /while :; do sleep 300; \[ "\$\(cat "\$LOCK_DIR\/pid" 2>\/dev\/null\)" = "\$MYPID" \] \|\| exit 0; touch "\$LOCK_DIR\/pid" 2>\/dev\/null; done/,
    );
    expect(src).toContain('HB_PID=$!');
    // The trap stops the heartbeat so it can never outlive the holder.
    expect(trapLine!).toContain('kill "$HB_PID"');
  });

  test('an expired-TTL lock is reclaimed even when its pid is alive (PID reuse)', async () => {
    const { base, install, state } = makeFixture();
    const holder = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const lockDir = path.join(state, '.setup-lock');
      fs.mkdirSync(lockDir, { recursive: true });
      const pidPath = path.join(lockDir, 'pid');
      fs.writeFileSync(pidPath, String(holder.pid));
      // Age the heartbeat past the 30-min TTL: a recycled PID looks alive
      // forever, so liveness alone can never clear this wedge.
      const past = new Date(Date.now() - 40 * 60 * 1000);
      fs.utimesSync(pidPath, past, past);
      const r = runScript(install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /RECLAIMED lock_ttl_expired/);
      expect(log).toContain('RECLAIMED lock_ttl_expired');
      await waitForLog(state, /UP_TO_DATE|UPDATING/);
    } finally {
      holder.kill();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);
});
