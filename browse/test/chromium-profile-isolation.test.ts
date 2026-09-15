import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isProcessAlive, safeKill } from '../src/error-handling';
import { readPidStartTime } from '../src/xvfb';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
const LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

describe.skipIf(process.platform === 'win32')('Chromium profile isolation (#2817)', () => {
  let scratch: string;
  let profile: string;
  let stateFile: string;
  let env: Record<string, string>;
  let children: ReturnType<typeof Bun.spawn>[];
  let daemonPid: number | undefined;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-profile-isolation-'));
    profile = path.join(scratch, '.gstack', 'chromium-profile');
    stateFile = path.join(scratch, 'project-b', '.gstack', 'browse.json');
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
    daemonPid = undefined;
  });

  afterEach(async () => {
    if (fs.existsSync(stateFile)) {
      daemonPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
    }
    if (daemonPid) safeKill(-daemonPid, 'SIGKILL');
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited));
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function spawnChromiumHolder() {
    const script = path.join(scratch, `chromium-holder-${children.length}.ts`);
    fs.writeFileSync(script, 'console.log("ready"); await Bun.sleep(60000);');
    const child = Bun.spawn([process.execPath, script], {
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

  function seedLocks(pid: number) {
    fs.symlinkSync(`${os.hostname()}-${pid}`, path.join(profile, LOCKS[0]));
    fs.symlinkSync('socket-target', path.join(profile, LOCKS[1]));
    fs.symlinkSync('cookie-target', path.join(profile, LOCKS[2]));
  }

  function expectLocksIntact(pid: number) {
    expect(isProcessAlive(pid)).toBe(true);
    expect(fs.readlinkSync(path.join(profile, LOCKS[0]))).toBe(`${os.hostname()}-${pid}`);
    expect(fs.readlinkSync(path.join(profile, LOCKS[1]))).toBe('socket-target');
    expect(fs.readlinkSync(path.join(profile, LOCKS[2]))).toBe('cookie-target');
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
    test(`headed startup via ${mode} still reaps a profile orphan and removes stale locks`, async () => {
      const orphan = await spawnChromiumHolder();
      seedLocks(orphan.pid);
      env.BROWSE_HEADED = mode === 'environment' ? '1' : '0';
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

      await runCli(mode === 'flag' ? ['--headed', 'status'] : ['status']);

      expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).mode).toBe('headed');
      expect(isProcessAlive(orphan.pid)).toBe(false);
      expect(fs.readdirSync(profile)).not.toContain(LOCKS[0]);
      expect(fs.readdirSync(profile)).not.toContain(LOCKS[1]);
      expect(fs.readdirSync(profile)).not.toContain(LOCKS[2]);
    }, 60_000);
  }

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
      if (mode === 'headed') {
        for (const lock of LOCKS) expect(fs.readdirSync(profile)).not.toContain(lock);
      } else {
        expectLocksIntact(holder.pid);
      }
    }, 60_000);
  }
});
