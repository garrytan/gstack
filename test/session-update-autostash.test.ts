import { afterEach, describe, test, expect } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'child_process';
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
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-supd-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  fs.mkdirSync(state, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });

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
  execFileSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
  return { base, origin, seed, install, state };
}

// Each fixture owns its state root (GSTACK_STATE_ROOT tops the chain in
// bin/gstack-state-root.sh) and its workflow-lease directory. The preload's
// GSTACK_LEASE_DIR is shared by every test file in this Bun process, so a lease
// another file leaves there made the updater log SKIP leased (#3385).
function fixtureEnv(base: string, install: string, state: string) {
  return { ...process.env, GSTACK_DIR: install, GSTACK_STATE_ROOT: state, GSTACK_LEASE_DIR: path.join(base, 'leases') };
}

function runScript(base: string, install: string, state: string) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: fixtureEnv(base, install, state),
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

      const r = runScript(base, install, state);
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

      const r = runScript(base, install, state);
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

describe.skipIf(process.platform === 'win32')('gstack-session-update fixtures ignore leases outside their own (#3385)', () => {
  const LEASE = path.join(ROOT, 'bin', 'gstack-lease');
  const sleepers: ReturnType<typeof spawn>[] = [];
  afterEach(() => { for (const s of sleepers.splice(0)) s.kill('SIGKILL'); });

  function holdLease(install: string, leaseDir: string): number {
    const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
    sleepers.push(sleeper);
    const touch = spawnSync('bash', [LEASE, 'touch', '--root', install, '--pid', String(sleeper.pid)], {
      encoding: 'utf8', env: { ...process.env, GSTACK_LEASE_DIR: leaseDir }, timeout: 10_000,
    });
    expect(touch.status, touch.stderr).toBe(0);
    return sleeper.pid!;
  }

  function advanceUpstream(seed: string): string {
    fs.writeFileSync(path.join(seed, 'VERSION'), '1.1.0\n');
    git(seed, 'commit', '-aqm', 'upstream release');
    git(seed, 'push', '-q', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  }

  test('a live lease in the shared preload lease directory does not stop the fixture update (negative control)', async () => {
    const shared = process.env.GSTACK_LEASE_DIR!;
    expect(shared).toBeTruthy();
    const { base, seed, install, state } = makeFixture();
    let pid = 0;
    try {
      const upstreamHead = advanceUpstream(seed);
      pid = holdLease(install, shared);
      const ambient = spawnSync('bash', [LEASE, 'live', '--root', install], { encoding: 'utf8', env: process.env, timeout: 10_000 });
      expect(ambient.status).toBe(0);
      expect(ambient.stdout).toContain(`${pid} `);

      expect(runScript(base, install, state).status).toBe(0);
      const log = await waitForLog(state, /UPDATING|PULL_FAILED|SKIP /);
      expect(log).not.toContain('SKIP leased');
      expect(log).toContain('UPDATING');
      expect(git(install, 'rev-parse', 'HEAD')).toBe(upstreamHead);
    } finally {
      if (pid) fs.rmSync(path.join(shared, String(pid)), { force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);

  test("the fixture's own live lease still skips the update", async () => {
    const { base, seed, install, state } = makeFixture();
    try {
      const before = git(install, 'rev-parse', 'HEAD');
      advanceUpstream(seed);
      const pid = holdLease(install, path.join(base, 'leases'));

      expect(runScript(base, install, state).status).toBe(0);
      const log = await waitForLog(state, /SKIP leased /);
      expect(log).toMatch(new RegExp(`SKIP leased pid=${pid}/\\d+m`));
      expect(log).not.toContain('UPDATING');
      expect(git(install, 'rev-parse', 'HEAD')).toBe(before);
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
      `#!/usr/bin/env bash\ncase "$*" in *fetch*) sleep ${sleepSecs};; esac\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    return shimDir;
  }

  function runScriptWithPath(base: string, install: string, state: string, shimDir: string) {
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...fixtureEnv(base, install, state), PATH: `${shimDir}:${process.env.PATH}` },
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
      const r = runScriptWithPath(base, install, state, shimDir);
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
      const r = runScript(base, install, state);
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
      const dead = spawnSync('true', { encoding: 'utf8', timeout: 30_000 }); // reaped by the time spawnSync returns
      const lockDir = path.join(state, '.setup-lock');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'pid'), String(dead.pid));
      const r = runScript(base, install, state);
      expect(r.status).toBe(0);
      const log = await waitForLog(state, /UP_TO_DATE|UPDATING/);
      const lockPid = fs.existsSync(path.join(lockDir, 'pid')) ? fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim() : 'no lock';
      expect(log, `planted dead pid ${dead.pid} (alive now: ${isAlive(dead.pid)}); lock pid after 15 s: ${lockPid} (alive: ${isAlive(Number(lockPid))}); script exit ${r.status}, stderr: ${r.stderr}`).toMatch(/UP_TO_DATE|UPDATING/);
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
      const r = runScript(base, install, state);
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
    expect(src).toContain('[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$MYPID" ] && rm -rf "$LOCK_DIR" 2>/dev/null');
    expect(src).toContain('trap cleanup_session_update EXIT');
  });

  test('EXIT trap is ownership-checked and a heartbeat runs during pull/setup (static pins)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // (a) After a TTL reclaim by another updater, $LOCK_DIR belongs to the
    // NEW holder — the old holder's trap must remove the lock ONLY while the
    // pidfile still contains ITS pid (MYPID captured at write time).
    const cleanup = src.match(/\n  cleanup_session_update\(\) \{\n[\s\S]*?\n  \}\n/)?.[0];
    expect(cleanup).toBeDefined();
    expect(src).toContain('trap cleanup_session_update EXIT');
    expect(cleanup!).toContain('[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$MYPID" ] && rm -rf "$LOCK_DIR"');
    // MYPID is written to the pidfile (the identity the trap compares against).
    expect(src).toContain('MYPID="${BASHPID:-$(sh -c \'echo $PPID\')}"');
    expect(src).toContain('echo "$MYPID" > "$LOCK_DIR/pid"');
    // (b) In-flight heartbeat: the step-boundary touches only fire AFTER the
    // pull / setup return, so a legitimately-slow step past the 30-min TTL
    // got reclaimed while ALIVE. The loop re-checks ownership each beat and
    // exits instead of touching a reclaimed holder's pidfile.
    expect(src).toMatch(
      /while :; do\n\s+sleep 300 &\n\s+wait "\$!" \|\| exit 0\n\s+\[ "\$\(cat "\$LOCK_DIR\/pid" 2>\/dev\/null\)" = "\$MYPID" \] \|\| exit 0\n\s+touch "\$LOCK_DIR\/pid" 2>\/dev\/null\n\s+done/,
    );
    expect(src).toContain('HB_PID=$!');
    // The trap stops the heartbeat so it can never outlive the holder.
    expect(cleanup!).toContain('kill "$heartbeat"');
    expect(cleanup!).toContain('${HB_PID:-$(jobs -p)}');
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
      const r = runScript(base, install, state);
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

// ── A conflicting autostash pop: judged by unmerged files, never by exit code ──
//
// When the carried-over edits conflict with the incoming revision, git (2.56
// at least) still exits 0 from `merge --ff-only --autostash` and leaves
// conflict markers in the live checkout, where Claude Code runs hooks from.
// The updater reads the unmerged files instead: it puts the checked revision
// back and keeps the edits. It never drops a stash entry, because refs/stash is
// shared with every worktree and its top entry may not be the autostash.

describe.skipIf(process.platform === 'win32')('gstack-session-update: a conflicting autostash pop', () => {
  const bases: string[] = [];
  afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

  function makeConflictFixture() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-supd-pop-')));
    bases.push(base);
    const origin = path.join(base, 'origin.git');
    const seed = path.join(base, 'seed');
    const install = path.join(base, 'install');
    const state = path.join(base, 'state');
    const home = path.join(base, 'home');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
    fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
    fs.writeFileSync(path.join(seed, 'notes.txt'), 'top\nmiddle\nbottom\n');
    fs.writeFileSync(path.join(seed, 'bin', 'gstack-config'),
      '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; *) echo "";; esac; fi\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(seed, 'setup'), '#!/usr/bin/env bash\necho "$*" >> "$SETUP_CALLS"\nexit 0\n', { mode: 0o755 });
    git(seed, 'init', '-q');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'branch', '-M', 'main');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    execFileSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
    return { base, seed, install, state, home, calls: path.join(base, 'calls') };
  }
  type Fx = ReturnType<typeof makeConflictFixture>;

  function release(fx: Fx, version: string, notes: string): string {
    fs.writeFileSync(path.join(fx.seed, 'notes.txt'), notes);
    fs.writeFileSync(path.join(fx.seed, 'VERSION'), `${version}\n`);
    git(fx.seed, 'add', '-A');
    git(fx.seed, 'commit', '-qm', `release ${version}`);
    git(fx.seed, 'push', '-q', 'origin', 'main');
    return git(fx.seed, 'rev-parse', 'HEAD');
  }

  function runHook(fx: Fx, pathPrefix = '', extraEnv: Record<string, string> = {}) {
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: `${pathPrefix}${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: fx.home, GSTACK_DIR: fx.install, GSTACK_STATE_ROOT: fx.state, SETUP_CALLS: fx.calls, TMPDIR: fx.base, ...extraEnv },
      timeout: 20_000,
    });
  }

  // The real git binary, pinned once: `git --exec-path` runs through any PATH
  // wrapper (a guard that resolves "the next git on PATH" would loop back
  // into a shim) and names the directory of the binary itself.
  function realGit(): string {
    const dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 30_000 }).trim();
    const bin = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
    try { fs.accessSync(bin, fs.constants.X_OK); } catch { throw new Error(`cannot pin the real git binary: ${bin} (from git --exec-path) is not executable`); }
    return bin;
  }
  // shim(fx, name, tool, body): a PATH prefix whose <tool> runs <body> first
  // and otherwise execs the real one ("$REAL").
  function shim(fx: Fx, name: string, tool: string, body: string): string {
    const dir = path.join(fx.base, name);
    fs.mkdirSync(dir, { recursive: true });
    const real = tool === 'git' ? realGit() : execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8', timeout: 30_000 }).trim();
    fs.writeFileSync(path.join(dir, tool), `#!/bin/bash\nREAL="${real}"\n${body}\nexec "$REAL" "$@"\n`, { mode: 0o755 });
    return `${dir}:`;
  }
  const FIXED_DATES = { GIT_AUTHOR_DATE: '2026-10-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T12:00:00Z' };
  /** The rescue commit id gstack-ff-update makes for this install, from a copy of it. */
  function predictRescue(fx: Fx): string {
    const copy = path.join(fx.base, 'predict');
    fs.cpSync(fx.install, copy, { recursive: true });
    const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-ff-update'), copy, 'origin/main'], { encoding: 'utf8', env: { ...process.env, ...FIXED_DATES }, timeout: 30_000 });
    const m = r.stdout.match(/^rescued \S+ \S+ refs\/gstack\/rescue\/([0-9a-f]{40}) /);
    if (!m) throw new Error(`no rescue predicted: ${r.stdout}${r.stderr}`);
    fs.rmSync(copy, { recursive: true, force: true });
    return m[1];
  }
  // A git whose `ls-files -u` fails with empty output from call <from> on.
  const unreadableIndexGit = (fx: Fx, from: number) =>
    shim(fx, 'unreadable-index-git', 'git', [
      'case " $* " in *" ls-files -u "*)',
      `  n=$(( $(cat "${fx.base}/ls-files-calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${fx.base}/ls-files-calls"`,
      `  [ "$n" -ge ${from} ] && { echo "fatal: index file corrupt" >&2; exit 128; } ;;`,
      'esac',
    ].join('\n'));

  async function waitFor(fx: Fx, pattern: RegExp, ms = 30_000): Promise<string> {
    const logFile = path.join(fx.state, 'analytics', 'session-update.log');
    const deadline = Date.now() + ms;
    let content = '';
    while (Date.now() < deadline) {
      content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      if (pattern.test(content) && !fs.existsSync(path.join(fx.state, '.setup-lock'))) return content;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${pattern}; log:\n${content}`);
  }

  const unmerged = (fx: Fx) => git(fx.install, 'ls-files', '-u');
  const notes = (fx: Fx) => fs.readFileSync(path.join(fx.install, 'notes.txt'), 'utf8');

  test('leaves no conflict markers, keeps the edits, and still sets up', async () => {
    const fx = makeConflictFixture();
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    const incoming = release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');

    runHook(fx);
    const log = await waitFor(fx, /Z UPDATED from=1\.0\.0 to=1\.1\.0/);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(incoming);
    expect(unmerged(fx)).toBe('');
    expect(notes(fx)).toBe('top UPSTREAM\nmiddle\nbottom\n');
    const kept = log.match(/AUTOSTASH_CONFLICT_RECOVERED tree_reset=1 kept_stash=([0-9a-f]{40}) kept_ref=refs\/gstack\/rescue\/([0-9a-f]{40}) unmerged=0/);
    expect(kept, log).not.toBeNull();
    expect(kept![2]).toBe(kept![1]);
    expect(git(fx.install, 'stash', 'show', '-p', kept![1])).toContain('+top LOCAL');
    expect(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/stash'], { cwd: fx.install, timeout: 30_000 }).status).not.toBe(0);
    expect(fs.readFileSync(fx.calls, 'utf8')).toContain('--refresh-registered');
  }, 60_000);

  test('never drops a stash entry it did not make', async () => {
    const fx = makeConflictFixture();
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top\nmiddle\nbottom MINE\n');
    git(fx.install, 'stash', 'push', '-q', '-m', 'keep me');
    const mine = git(fx.install, 'rev-parse', 'refs/stash');
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');

    runHook(fx);
    const log = await waitFor(fx, /Z UPDATED /);
    const kept = log.match(/kept_stash=([0-9a-f]{40})/);
    expect(kept, log).not.toBeNull();
    expect(git(fx.install, 'stash', 'list', '--format=%H').split('\n')).toEqual([mine]);
    expect(git(fx.install, 'rev-parse', 'refs/stash')).toBe(mine);
    expect(git(fx.install, 'rev-parse', `refs/gstack/rescue/${kept![1]}`)).toBe(kept![1]);
  }, 60_000);

  test('a held refs/stash.lock does not matter: the edits are anchored outside refs/stash', async () => {
    const fx = makeConflictFixture();
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');
    // A held lock: git prints "cannot store <id>" and nothing references the
    // autostash commit.
    const lock = path.join(fx.install, '.git', 'refs', 'stash.lock');
    fs.writeFileSync(lock, '');

    runHook(fx);
    const log = await waitFor(fx, /Z UPDATED /);
    fs.rmSync(lock);
    expect(unmerged(fx)).toBe('');
    const kept = log.match(/kept_stash=([0-9a-f]{40}) kept_ref=(refs\/gstack\/rescue\/[0-9a-f]{40})/);
    expect(kept, log).not.toBeNull();
    expect(git(fx.install, 'rev-parse', kept![2])).toBe(kept![1]);
    expect(git(fx.install, 'stash', 'show', '-p', kept![1])).toContain('+top LOCAL');
  }, 60_000);

  test('a rescue ref that already names another commit is never overwritten, and nothing moves', async () => {
    const fx = makeConflictFixture();
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');
    git(fx.install, 'fetch', '-q');
    const oid = predictRescue(fx);
    git(fx.install, 'update-ref', `refs/gstack/rescue/${oid}`, oldHead);

    runHook(fx, '', FIXED_DATES);
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toContain(`HELD autostash-unrecoverable: rescue ref refs/gstack/rescue/${oid} already exists and names another commit`);
    expect(log).not.toContain('AUTOSTASH_CONFLICT_RECOVERED');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(git(fx.install, 'rev-parse', `refs/gstack/rescue/${oid}`)).toBe(oldHead);
    expect(notes(fx)).toBe('top LOCAL\nmiddle\nbottom\n');
    expect(fs.existsSync(fx.calls)).toBe(false);
  }, 60_000);

  test('a held update clears once its cause is gone, and setup runs', async () => {
    const fx = makeConflictFixture();
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    const incoming = release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');
    git(fx.install, 'fetch', '-q');
    const oid = predictRescue(fx);
    git(fx.install, 'update-ref', `refs/gstack/rescue/${oid}`, oldHead);
    runHook(fx, '', FIXED_DATES);
    await waitFor(fx, /Z HELD autostash-unrecoverable/);
    expect(runHook(fx, '', FIXED_DATES).stdout).toContain('update held (autostash-unrecoverable: ');

    // The person deletes the unrelated ref; the next check (past the throttle) updates.
    git(fx.install, 'update-ref', '-d', `refs/gstack/rescue/${oid}`);
    fs.rmSync(path.join(fx.state, '.last-session-update'), { force: true });
    runHook(fx, '', FIXED_DATES);
    const after = await waitFor(fx, /Z UPDATED from=1\.0\.0 to=1\.1\.0/);
    expect(after).toContain(`kept_ref=refs/gstack/rescue/${oid}`);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(incoming);
    expect(notes(fx)).toBe('top UPSTREAM\nmiddle\nbottom\n');
    expect(fs.readFileSync(fx.calls, 'utf8')).toContain('--refresh-registered');
  }, 90_000);

  test('an index that cannot be read before the merge holds the checkout where it is', async () => {
    const fx = makeConflictFixture();
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');

    runHook(fx, unreadableIndexGit(fx, 1));
    const log = await waitFor(fx, /Z PULL_FAILED /);
    expect(log).toContain('cannot read the index');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(notes(fx)).toBe('top LOCAL\nmiddle\nbottom\n');
    expect(fs.existsSync(fx.calls)).toBe(false);
  }, 60_000);

  test('an index that cannot be read after the merge is never taken as clean', async () => {
    const fx = makeConflictFixture();
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');

    runHook(fx, unreadableIndexGit(fx, 2));
    const log = await waitFor(fx, /Z PULL_FAILED /);
    expect(log).toContain('cannot read the index');
    expect(log).not.toContain('UPDATED');
    expect(fs.existsSync(fx.calls)).toBe(false);
  }, 60_000);

  test('without a file for git\'s messages, the update is held before the merge', async () => {
    const fx = makeConflictFixture();
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');

    runHook(fx, shim(fx, 'no-pull-tmp', 'mktemp', 'case " $* " in *gstack-session-pull*) exit 1 ;; esac'));
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toContain('HELD temp-file-unavailable');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(notes(fx)).toBe('top LOCAL\nmiddle\nbottom\n');
    expect(fs.existsSync(fx.calls)).toBe(false);
  }, 60_000);

  test('files left unmerged before the update hold the checkout where it is', async () => {
    const fx = makeConflictFixture();
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    // Someone's own merge or stash pop left a conflict: three index stages.
    const blob = (body: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: fx.install, input: body, encoding: 'utf8', timeout: 30_000 }).trim();
    const stages = [blob('top\nmiddle\nbottom\n'), blob('top OURS\nmiddle\nbottom\n'), blob('top THEIRS\nmiddle\nbottom\n')];
    git(fx.install, 'update-index', '--force-remove', 'notes.txt');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: fx.install, timeout: 30_000,
      input: stages.map((sha, i) => `100644 ${sha} ${i + 1}\tnotes.txt\n`).join(''),
    });
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), '<<<<<<< ours\ntop OURS\n=======\ntop THEIRS\n>>>>>>> theirs\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');

    runHook(fx);
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toContain('HELD unmerged-files: 1 unmerged file(s) in the install (first: notes.txt)');
    expect(log).not.toContain('AUTOSTASH_CONFLICT_RECOVERED');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(unmerged(fx).split('\n')).toHaveLength(3);
    expect(notes(fx)).toContain('top THEIRS');
    expect(fs.existsSync(fx.calls)).toBe(false);
  }, 60_000);

  test('a local edit that does not conflict rides over the update (control)', async () => {
    const fx = makeConflictFixture();
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top\nmiddle\nbottom LOCAL\n');
    release(fx, '1.1.0', 'top UPSTREAM\nmiddle\nbottom\n');

    runHook(fx);
    const log = await waitFor(fx, /Z UPDATED /);
    expect(log).not.toContain('AUTOSTASH_CONFLICT_RECOVERED');
    expect(notes(fx)).toBe('top UPSTREAM\nmiddle\nbottom LOCAL\n');
  }, 60_000);
});
