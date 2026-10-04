import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isProcessAlive } from '../src/error-handling';
import { readPidStartTime } from '../src/xvfb';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
const LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

function killDaemonGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err: any) {
    if (err?.code === 'ESRCH') return;
    if (err?.code !== 'EPERM') throw err;
    if (!isProcessAlive(pid)) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (leaderErr: any) {
      if (leaderErr?.code === 'ESRCH') return;
      throw err;
    }
  }
}

describe('Chromium profile isolation cleanup (#2908)', () => {
  test('a group kill on an already-stopped daemon tolerates macOS EPERM', () => {
    const exited = Bun.spawnSync([process.execPath, '-e', '0'], { timeout: 30_000 }).pid;
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -exited) throw Object.assign(new Error('kill() failed: EPERM'), { code: 'EPERM' });
      if (pid === exited && signal === 0) throw Object.assign(new Error('kill() failed: ESRCH'), { code: 'ESRCH' });
      throw Object.assign(new Error('unexpected signal target'), { code: 'EINVAL' });
    }) as typeof process.kill);
    try {
      expect(() => killDaemonGroup(exited)).not.toThrow();
    } finally { kill.mockRestore(); }
  });

  test('a group kill still surfaces EPERM while the daemon is alive', () => {
    const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -process.pid) throw Object.assign(new Error('kill() failed: EPERM'), { code: 'EPERM' });
      if (pid === process.pid && signal === 0) return true;
      throw Object.assign(new Error('unexpected signal target'), { code: 'EINVAL' });
    }) as typeof process.kill);
    try {
      expect(() => killDaemonGroup(process.pid)).toThrow('EPERM');
    } finally { kill.mockRestore(); }
  });
});

describe.skipIf(process.platform === 'win32')('Chromium profile isolation (#2817)', () => {
  let scratch: string;
  let profile: string;
  let projectProfile: string;
  let stateFile: string;
  let orphans: number[];
  let env: Record<string, string>;
  let children: ReturnType<typeof Bun.spawn>[];
  let daemonPid: number | undefined;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-profile-isolation-'));
    profile = path.join(scratch, '.gstack', 'chromium-profile');
    stateFile = path.join(scratch, 'project-b', '.gstack', 'browse.json');
    projectProfile = path.join(scratch, 'project-b', '.gstack', 'chromium-profile');
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(BROWSE_|GSTACK_|CHROMIUM_PROFILE$|CLAUDE_PLUGIN_DATA$)/.test(key)) {
        env[key] = value;
      }
    }
    Object.assign(env, {
      HOME: scratch,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(
        process.env.XDG_CACHE_HOME || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache'),
        'ms-playwright',
      ),
      GSTACK_HOME: path.join(scratch, '.gstack'),
      GSTACK_SECURITY_OFF: '1',
      BROWSE_STATE_FILE: stateFile,
      BROWSE_PORT: '0',
      BROWSE_PARENT_PID: '0',
      BROWSE_START_TIMEOUT: '30000',
    });
    children = [];
    orphans = [];
    daemonPid = undefined;
  });

  afterEach(async () => {
    if (fs.existsSync(stateFile)) {
      daemonPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
    }
    if (daemonPid) killDaemonGroup(daemonPid);
    for (const child of children) child.kill('SIGKILL');
    for (const pid of orphans) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await Promise.all(children.map(child => child.exited));
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** A stand-in Chromium: its command line names Chromium and the profile it uses. */
  async function spawnChromiumHolder(userDataDir = profile) {
    const script = path.join(scratch, `chromium-holder-${children.length}.ts`);
    fs.writeFileSync(script, 'console.log("ready"); await Bun.sleep(60000);');
    const child = Bun.spawn([process.execPath, script, `--user-data-dir=${userDataDir}`], {
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    children.push(child);
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain('ready');
    return child;
  }

  /** A stand-in Chromium whose daemon is gone: reparented to init. */
  async function spawnOrphanedChromium(userDataDir: string) {
    const script = path.join(scratch, `chromium-orphan-${orphans.length}.ts`);
    const ready = `${script}.ready`;
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); await Bun.sleep(60000);`);
    const launcher = Bun.spawnSync(['sh', '-c', `"$0" "$1" "$2" >/dev/null 2>&1 & echo $!`, process.execPath, script, `--user-data-dir=${userDataDir}`], { env, stdout: 'pipe', timeout: 10_000 });
    const pid = Number(launcher.stdout.toString().trim());
    orphans.push(pid);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(fs.existsSync(ready)).toBe(true);
    return { pid };
  }

  function seedLocks(pid: number, dir = profile, host = os.hostname()) {
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(`${host}-${pid}`, path.join(dir, LOCKS[0]));
    fs.symlinkSync('socket-target', path.join(dir, LOCKS[1]));
    fs.symlinkSync('cookie-target', path.join(dir, LOCKS[2]));
  }

  function expectLocksIntact(pid: number, dir = profile, host = os.hostname()) {
    expect(isProcessAlive(pid)).toBe(true);
    expect(fs.readlinkSync(path.join(dir, LOCKS[0]))).toBe(`${host}-${pid}`);
    expect(fs.readlinkSync(path.join(dir, LOCKS[1]))).toBe('socket-target');
    expect(fs.readlinkSync(path.join(dir, LOCKS[2]))).toBe('cookie-target');
  }

  function writeStubServer() {
    const serverScript = path.join(scratch, 'stub-server.ts');
    fs.writeFileSync(serverScript, `
      import * as fs from 'node:fs';
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch: () => Response.json({ status: 'healthy' }),
      });
      fs.writeFileSync(process.env.BROWSE_STATE_FILE!, JSON.stringify({
        pid: process.pid, port: server.port, token: 'test-token',
        mode: process.env.BROWSE_HEADED === '1' ? 'headed' : 'launched',
      }));
    `);
    env.BROWSE_SERVER_SCRIPT = serverScript;
  }

  async function runCliRaw(args: string[]) {
    const child = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: path.join(scratch, 'project-b'),
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (fs.existsSync(stateFile)) daemonPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
    return { code, stdout, stderr };
  }

  async function runCli(args: string[]) {
    const child = Bun.spawn([process.execPath, CLI, ...args], {
      cwd: path.join(scratch, 'project-b'),
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (fs.existsSync(stateFile)) daemonPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
    const log = path.join(path.dirname(stateFile), 'browse-daemon.log');
    expect(code, stdout + stderr + (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '')).toBe(0);
  }

  test('headless startup leaves another project\'s live headed lock holder and locks alone', async () => {
    const holder = await spawnChromiumHolder();
    seedLocks(holder.pid);

    await runCli(['status']);

    expect(daemonPid).toBeGreaterThan(0);
    expect(isProcessAlive(daemonPid!)).toBe(true);
    expectLocksIntact(holder.pid);
  }, 60_000);

  test('headless startup still reaps its own recorded orphan without touching the headed profile', async () => {
    const holder = await spawnChromiumHolder();
    const orphan = await spawnChromiumHolder();
    seedLocks(holder.pid);
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: 999_999_999,
      port: 0,
      token: 'test-token',
      mode: 'launched',
      chromiumPid: orphan.pid,
      chromiumStartTime: readPidStartTime(orphan.pid),
    }));

    await runCli(['status']);

    expect(isProcessAlive(orphan.pid)).toBe(false);
    expectLocksIntact(holder.pid);
  }, 60_000);

  for (const mode of ['flag', 'environment'] as const) {
    test(`headed startup via ${mode} reaps an orphaned Chromium on this project's profile and removes stale locks`, async () => {
      const orphan = await spawnOrphanedChromium(projectProfile);
      seedLocks(orphan.pid, projectProfile);
      env.BROWSE_HEADED = mode === 'environment' ? '1' : '0';
      writeStubServer();

      await runCli(mode === 'flag' ? ['--headed', 'status'] : ['status']);

      expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).mode).toBe('headed');
      expect(isProcessAlive(orphan.pid)).toBe(false);
      for (const lock of LOCKS) expect(fs.readdirSync(projectProfile)).not.toContain(lock);
    }, 60_000);
  }

  test('headed startup in one project leaves another project\'s live headed Chromium alone (D5, #2492)', async () => {
    const otherProject = path.join(scratch, 'project-a', '.gstack', 'chromium-profile');
    const holder = await spawnChromiumHolder(otherProject);
    seedLocks(holder.pid, otherProject);
    writeStubServer();

    await runCli(['--headed', 'status']);

    expectLocksIntact(holder.pid, otherProject);
    expect(fs.existsSync(projectProfile)).toBe(true);
  }, 60_000);

  test('a live owner of this project\'s profile is never killed; browse names it and stops', async () => {
    const holder = await spawnChromiumHolder(projectProfile);
    seedLocks(holder.pid, projectProfile);
    writeStubServer();

    const r = await runCliRaw(['--headed', 'status']);

    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(`in use by Chromium PID ${holder.pid}`);
    expectLocksIntact(holder.pid, projectProfile);
  }, 60_000);

  test('a lock written by another host is never acted on', async () => {
    const holder = await spawnOrphanedChromium(projectProfile);
    seedLocks(holder.pid, projectProfile, 'some-other-host');
    writeStubServer();

    const r = await runCliRaw(['--headed', 'status']);

    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('on another host (some-other-host)');
    expectLocksIntact(holder.pid, projectProfile, 'some-other-host');
  }, 60_000);

  test('first headed use seeds the project profile from a quiescent shared profile, without singleton files', async () => {
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Cookies'), 'cookie-db');
    seedLocks(999_999_999);
    writeStubServer();

    const r = await runCliRaw(['--headed', 'status']);

    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Copied your logins and settings from ${profile} to ${projectProfile}`);
    expect(fs.readFileSync(path.join(projectProfile, 'Default', 'Cookies'), 'utf-8')).toBe('cookie-db');
    expect(fs.statSync(projectProfile).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(projectProfile).filter(f => f.startsWith('Singleton') || f.includes('.seed-'))).toEqual([]);
    expect(fs.readdirSync(path.dirname(projectProfile)).filter(f => f.includes('.seed-'))).toEqual([]);
  }, 60_000);

  test('a shared profile in use is not copied; the project starts fresh and says how to import later', async () => {
    fs.writeFileSync(path.join(profile, 'Cookies'), 'cookie-db');
    const holder = await spawnChromiumHolder(profile);
    seedLocks(holder.pid);
    writeStubServer();

    const r = await runCliRaw(['--headed', 'status']);

    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('starts with a fresh profile. To import it later');
    expect(fs.existsSync(path.join(projectProfile, 'Cookies'))).toBe(false);
    expectLocksIntact(holder.pid);
  }, 60_000);

  test('browse profiles lists per-project profiles and prune removes idle ones but never one in use', async () => {
    writeStubServer();
    await runCli(['--headed', 'status']);
    const listed = await runCliRaw(['profiles']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(projectProfile);
    expect(listed.stdout).toContain('(old shared profile)');

    const holder = await spawnChromiumHolder(projectProfile);
    seedLocks(holder.pid, projectProfile);
    await runCliRaw(['profiles', 'prune', '--days', '0']);
    expect(fs.existsSync(projectProfile)).toBe(true);

    holder.kill('SIGKILL');
    await holder.exited;
    const pruned = await runCliRaw(['profiles', 'prune', '--days', '0']);
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain(`removed ${projectProfile}`);
    expect(fs.existsSync(projectProfile)).toBe(false);
    expect(fs.existsSync(profile)).toBe(true);
  }, 60_000);

  for (const args of [['stop'], ['--force-restart', 'stop'], ['disconnect']]) {
    test(`headless ${args.join(' ')} preserves another project's headed profile`, async () => {
      await runCli(['status']);
      if (args[0] === 'disconnect') {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        state.configHash = 'proxy-only-config';
        fs.writeFileSync(stateFile, JSON.stringify(state));
      }
      const holder = await spawnChromiumHolder();
      seedLocks(holder.pid);

      await runCli(args);
      const deadline = Date.now() + 10000;
      while (fs.existsSync(stateFile) && Date.now() < deadline) await Bun.sleep(50);

      expect(fs.existsSync(stateFile)).toBe(false);
      expectLocksIntact(holder.pid);
    }, 60_000);
  }

  for (const mode of ['launched', 'headed'] as const) {
    test(`${mode} factory shutdown scopes profile cleanup to the active browser mode`, async () => {
      const holder = await spawnChromiumHolder();
      seedLocks(holder.pid);
      seedLocks(999_999_999, projectProfile);
      const child = Bun.spawn([process.execPath, '-e', `
        import { buildFetchHandler } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/server.ts'))};
        import { resolveConfig } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/config.ts'))};
        const handle = buildFetchHandler({
          authToken: 'profile-isolation-test-token',
          browsePort: 0,
          idleTimeoutMs: 1800000,
          config: resolveConfig(),
          ownsTerminalAgent: false,
          browserManager: {
            getConnectionMode: () => ${JSON.stringify(mode)},
            isWatching: () => false,
            close: async () => {},
          },
        });
        await handle.shutdown();
      `], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
      children.push(child);
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

      expect(code, stderr).toBe(0);
      // Headed shutdown cleans only this project's profile; another
      // project's (here the old shared one) is never touched (D5).
      expectLocksIntact(holder.pid);
      if (mode === 'headed') {
        for (const lock of LOCKS) expect(fs.readdirSync(projectProfile)).not.toContain(lock);
      } else {
        expect(fs.readdirSync(projectProfile)).toContain(LOCKS[0]);
      }
    }, 60_000);
  }
});

describe('explicit CHROMIUM_PROFILE (D5)', () => {
  test('an explicit profile is neither seeded from the shared profile nor registered for pruning', async () => {
    const { ensureProjectProfile } = await import('../src/chromium-profiles');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-explicit-profile-'));
    const saved = { CHROMIUM_PROFILE: process.env.CHROMIUM_PROFILE, GSTACK_HOME: process.env.GSTACK_HOME };
    try {
      process.env.GSTACK_HOME = path.join(root, 'state');
      fs.mkdirSync(path.join(process.env.GSTACK_HOME, 'chromium-profile'), { recursive: true });
      fs.writeFileSync(path.join(process.env.GSTACK_HOME, 'chromium-profile', 'Cookies'), 'shared logins');
      const explicit = path.join(root, 'workspace-profile');
      process.env.CHROMIUM_PROFILE = explicit;
      const logs: string[] = [];
      ensureProjectProfile(explicit, msg => logs.push(msg));
      expect(fs.existsSync(explicit)).toBe(false);
      expect(fs.existsSync(path.join(process.env.GSTACK_HOME, 'browse-profiles.json'))).toBe(false);
      expect(logs).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
