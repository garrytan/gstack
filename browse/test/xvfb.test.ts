import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  shouldSpawnXvfb,
  isOurXvfb,
  readPidStartTime,
  readPidCmdline,
  cleanupXvfb,
  pickFreeDisplay,
  isDisplayFree,
} from '../src/xvfb';

const HAS_XVFB = (() => {
  if (process.platform !== 'linux') return false;
  const result = Bun.spawnSync(['which', 'Xvfb'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  return result.exitCode === 0;
})();

describe('shouldSpawnXvfb', () => {
  test('skips when not headed', () => {
    const d = shouldSpawnXvfb({}, 'linux');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('not headed');
  });

  test('skips on macOS even when headed', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1' }, 'darwin');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('darwin');
  });

  test('skips on Windows even when headed', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1' }, 'win32');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('win32');
  });

  test('skips on Linux when DISPLAY already set', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1', DISPLAY: ':0' }, 'linux');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('DISPLAY=:0');
  });

  test('skips on Linux when WAYLAND_DISPLAY set (codex F2)', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1', WAYLAND_DISPLAY: 'wayland-0' }, 'linux');
    expect(d.spawn).toBe(false);
    expect(d.reason).toContain('Wayland');
  });

  test('spawns on Linux + headed + no DISPLAY/WAYLAND_DISPLAY', () => {
    const d = shouldSpawnXvfb({ BROWSE_HEADED: '1' }, 'linux');
    expect(d.spawn).toBe(true);
  });
});

describe('isOurXvfb (PID validation)', () => {
  test('returns false when pid is 0', () => {
    expect(isOurXvfb(0, 'whatever')).toBe(false);
  });

  test('returns false when startTime is empty', () => {
    expect(isOurXvfb(process.pid, '')).toBe(false);
  });

  test('returns false when cmdline does not contain Xvfb', () => {
    // Current bun process is not Xvfb. PID-correct, cmdline-wrong → reject.
    // NOTE: this very suite's argv CONTAINS "xvfb.test.ts" — a substring
    // match over the whole cmdline identified the test runner as our Xvfb
    // on the first Linux CI run. Identity rests on argv[0]'s basename.
    const myStart = readPidStartTime(process.pid);
    expect(isOurXvfb(process.pid, myStart)).toBe(false);
  });

  test('a process whose ARGUMENTS mention xvfb is not ours (argv0 identity)', async () => {
    // sh's $0 trick plants "xvfb" in the child's args while argv[0] stays sh.
    // Killing this process because its arguments mention xvfb is the exact
    // sibling-kill class the identity check exists to prevent.
    const child = Bun.spawn(['/bin/sh', '-c', 'sleep 2', 'xvfb-lookalike-arg']);
    try {
      const start = readPidStartTime(child.pid);
      // On non-Linux, /proc is absent and both reads return '' → false either way.
      expect(isOurXvfb(child.pid, start || 'recorded')).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test('returns false when start-time differs (PID reuse defense)', () => {
    // Even if we somehow had the right PID, a stale start-time means it's a
    // different process. We never fake the cmdline test, so this assertion
    // is structural: the function must not pass on stale start-time alone.
    expect(isOurXvfb(process.pid, 'Mon Jan  1 00:00:00 1970')).toBe(false);
  });
});

describe('readPidStartTime', () => {
  test('returns non-empty for current process', () => {
    if (process.platform === 'win32') return; // ps not available
    const t = readPidStartTime(process.pid);
    expect(t.length).toBeGreaterThan(0);
  });

  test('returns empty string for nonexistent PID', () => {
    expect(readPidStartTime(99999999)).toBe('');
  });
});

describe('readPidCmdline', () => {
  test('returns non-empty for current process on Linux', () => {
    if (process.platform !== 'linux') return; // /proc unavailable
    const c = readPidCmdline(process.pid);
    expect(c.length).toBeGreaterThan(0);
  });

  test('returns empty for nonexistent PID', () => {
    expect(readPidCmdline(99999999)).toBe('');
  });
});

describe('cleanupXvfb', () => {
  test('no-op when pid is 0', () => {
    expect(() => cleanupXvfb({ pid: 0, startTime: '', display: ':99' })).not.toThrow();
  });

  test('no-op when not our Xvfb (won\'t kill unrelated process)', () => {
    // Pass the current bun process's PID + a stale start-time. cleanupXvfb
    // should refuse to send signals because cmdline doesn't match Xvfb.
    expect(() => cleanupXvfb({
      pid: process.pid,
      startTime: 'Mon Jan  1 00:00:00 1970',
      display: ':99',
    })).not.toThrow();
    // The current process is still alive after the no-op cleanup attempt.
    expect(process.kill(process.pid, 0)).toBe(true);
  });
});

describe('pickFreeDisplay (Xvfb installed)', () => {
  test.skipIf(!HAS_XVFB)('returns a number in the requested range', () => {
    const n = pickFreeDisplay(99, 105);
    if (n != null) {
      expect(n).toBeGreaterThanOrEqual(99);
      expect(n).toBeLessThanOrEqual(105);
    }
    // null means all displays in range are busy — also valid.
  });

  test.skipIf(!HAS_XVFB)('isDisplayFree returns boolean', () => {
    const result = isDisplayFree(99);
    expect(typeof result).toBe('boolean');
  });
});

describe('xvfb spawn → cleanup round trip (Linux + Xvfb only)', () => {
  test.skipIf(!HAS_XVFB)('spawn, validate ownership, cleanup', async () => {
    const { spawnXvfb } = await import('../src/xvfb');
    const display = pickFreeDisplay(99, 110);
    if (display == null) {
      // No free display in range — skip.
      return;
    }
    const handle = await spawnXvfb(display);
    try {
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.display).toBe(`:${display}`);
      expect(handle.startTime.length).toBeGreaterThan(0);
      // Validation should pass.
      expect(isOurXvfb(handle.pid, handle.startTime)).toBe(true);
      const lockPath = `/tmp/.X${display}-lock`;
      const lock = fs.readFileSync(lockPath, 'utf8');
      cleanupXvfb({ ...handle, startTime: 'stale-start-time' });
      expect(isOurXvfb(handle.pid, handle.startTime)).toBe(true);
      await expect(spawnXvfb(display)).rejects.toThrow('already reserved');
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(lock);
      expect(isOurXvfb(handle.pid, handle.startTime)).toBe(true);
    } finally {
      handle.close();
      // After cleanup, our Xvfb should be gone.
      await new Promise((r) => setTimeout(r, 200));
      expect(isOurXvfb(handle.pid, handle.startTime)).toBe(false);
    }
  });
});

describe.skipIf(process.platform !== 'linux')('display allocation failure controls', () => {
  test('missing ownership tooling fails before spawning Xvfb', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-xvfb-no-ps-'));
    const marker = path.join(root, 'spawned');
    fs.writeFileSync(path.join(root, 'Xvfb'), `#!/bin/sh\nprintf started > ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
    try {
      const display = pickFreeDisplay();
      expect(display).not.toBeNull();
      const child = Bun.spawnSync([process.execPath, '-e', `
        import { spawnXvfb } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/xvfb.ts'))};
        try { const handle = await spawnXvfb(${display}); handle.close(); process.exitCode = 1; }
        catch (err) { console.log(err.message); }
      `], { env: { ...process.env, PATH: root }, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toContain('without process start-time ownership checks');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unreachable reserved display is not free and its lock is not removed', async () => {
    const display = pickFreeDisplay(20000, 20100);
    expect(display).not.toBeNull();
    const lockPath = `/tmp/.X${display}-lock`;
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    const inode = fs.statSync(lockPath).ino;
    try {
      expect(isDisplayFree(display!)).toBe(false);
      expect(pickFreeDisplay(display!, display!)).toBeNull();
      const { spawnXvfb } = await import('../src/xvfb');
      await expect(spawnXvfb(display!)).rejects.toThrow('already reserved');
      expect(fs.statSync(lockPath).ino).toBe(inode);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`);
    } finally {
      if (fs.statSync(lockPath).ino === inode) fs.unlinkSync(lockPath);
    }
  });

  test('a dangling display lock remains reserved and is not replaced', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-display-link-'));
    const display = pickFreeDisplay(21000, 21100);
    expect(display).not.toBeNull();
    const lockPath = `/tmp/.X${display}-lock`;
    const target = path.join(root, 'missing-owner');
    fs.symlinkSync(target, lockPath);
    try {
      expect(isDisplayFree(display!)).toBe(false);
      const { spawnXvfb } = await import('../src/xvfb');
      await expect(spawnXvfb(display!)).rejects.toThrow('already reserved');
      expect(fs.readlinkSync(lockPath)).toBe(target);
    } finally {
      if (fs.readlinkSync(lockPath) === target) fs.unlinkSync(lockPath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed Xvfb process reports startup failure without claiming a display', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-xvfb-failure-'));
    fs.writeFileSync(path.join(root, 'Xvfb'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    try {
      const display = pickFreeDisplay();
      expect(display).not.toBeNull();
      const child = Bun.spawnSync([process.execPath, '-e', `
        import { spawnXvfb } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/xvfb.ts'))};
        try { const handle = await spawnXvfb(${display}); handle.close(); process.exitCode = 1; }
        catch (err) { console.log(err.message); }
      `], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe', timeout: 10000 });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toContain('exited during startup (code 42)');
      expect(isDisplayFree(display!)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'linux')('daemon-owned display lifecycle', () => {
  test('registered shutdown waits for owned display allocation before process exit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-display-exit-'));
    const marker = path.join(root, 'xvfb.pid');
    const realXvfb = Bun.which('Xvfb');
    expect(realXvfb).not.toBeNull();
    fs.writeFileSync(path.join(root, 'Xvfb'), `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(marker)}\n/bin/sleep 0.8\nexec ${JSON.stringify(realXvfb)} "$@"\n`, { mode: 0o755 });
    const script = path.join(root, 'shutdown.ts');
    fs.writeFileSync(script, `
      import { BrowserManager } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/browser-manager.ts'))};
      import { buildFetchHandler, resolveConfigFromEnv } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/server.ts'))};
      const manager = new BrowserManager();
      await manager.launch();
      manager.closeRaceMs = 50;
      const handler = buildFetchHandler({ ...resolveConfigFromEnv(), browserManager: manager });
      void manager.ensureHeadedDisplay().catch(() => {});
      await handler.shutdown();
    `);
    const child = Bun.spawn([process.execPath, script], {
      cwd: root,
      env: {
        ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`,
        DISPLAY: '', WAYLAND_DISPLAY: '', BROWSE_HEADED: '', BROWSE_PARENT_PID: '0',
        GSTACK_HOME: path.join(root, 'home-state'), BROWSE_STATE_FILE: path.join(root, 'state', 'browse.json'),
        CHROMIUM_PROFILE: path.join(root, 'profile'), GSTACK_CHROMIUM_NO_SANDBOX: '1',
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright'),
      }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    });
    let pid = 0;
    let startTime = '';
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
      expect(fs.existsSync(marker)).toBe(true);
      pid = Number(fs.readFileSync(marker, 'utf8'));
      startTime = readPidStartTime(pid);
      expect(startTime).not.toBe('');
      expect(await Promise.race([child.exited, Bun.sleep(10000).then(() => 'timeout')])).toBe(0);
      await Bun.sleep(1000);
      expect(isOurXvfb(pid, startTime)).toBe(false);
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
      if (pid && startTime) cleanupXvfb({ pid, startTime, display: '' });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  for (const mode of ['welcome', 'welcome failure', 'shutdown', 'restored page', 'headless'] as const) {
    test(`${mode}: startup settles welcome before publishing daemon readiness`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-welcome-ready-'));
      const stateFile = path.join(root, 'state', 'browse.json');
      const entered = path.join(root, 'entered');
      const release = path.join(root, 'release');
      const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<h1>Requested page remains usable</h1>', { headers: { 'Content-Type': 'text/html' } }) });
      const requestedUrl = `http://127.0.0.1:${fixture.port}/requested`;
      const preload = path.join(root, 'preload.ts');
      fs.writeFileSync(preload, `
        import * as fs from 'node:fs';
        import { BrowserManager } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/browser-manager.ts'))};
        const getPage = BrowserManager.prototype.getPage;
        const wrapped = new WeakSet();
        let rejectWelcome;
        BrowserManager.prototype.getPage = function(...args) {
          const page = getPage.apply(this, args);
          if (!wrapped.has(page)) {
            wrapped.add(page);
            const goto = page.goto.bind(page);
            page.goto = async (url, options) => {
              if (new URL(url).pathname === '/welcome') {
                fs.writeFileSync(${JSON.stringify(entered)}, JSON.stringify(this.getXvfbHandle()));
                if (${JSON.stringify(mode)} === 'shutdown') {
                  return new Promise((resolve, reject) => {
                    rejectWelcome = () => reject(new Error('Welcome interrupted during shutdown'));
                  });
                }
                const deadline = Date.now() + 15000;
                while (!fs.existsSync(${JSON.stringify(release)})) {
                  if (Date.now() >= deadline) throw new Error('Welcome test barrier expired');
                  await Bun.sleep(10);
                }
                if (${JSON.stringify(mode)} === 'welcome failure') throw new Error('Welcome test navigation failure');
              }
              return goto(url, options);
            };
          }
          return page;
        };
        if (${JSON.stringify(mode)} === 'shutdown') {
          const close = BrowserManager.prototype.close;
          BrowserManager.prototype.close = async function(...args) {
            rejectWelcome?.();
            await Bun.sleep(0);
            return close.apply(this, args);
          };
        }
        if (${JSON.stringify(mode)} === 'restored page') {
          const launch = BrowserManager.prototype.launchHeaded;
          BrowserManager.prototype.launchHeaded = async function(...args) {
            await launch.apply(this, args);
            await this.getPage().goto(${JSON.stringify(requestedUrl)});
          };
        }
      `);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/^(BROWSE_|GSTACK_|CHROMIUM_PROFILE$|CLAUDE_PLUGIN_DATA$|DISPLAY$|WAYLAND_DISPLAY$)/.test(key)) env[key] = value;
      }
      Object.assign(env, {
        HOME: root, GSTACK_HOME: path.join(root, 'home-state'),
        CHROMIUM_PROFILE: path.join(root, 'profile'), BROWSE_STATE_FILE: stateFile,
        BROWSE_PORT: '0', BROWSE_PARENT_PID: '0', GSTACK_STATE_WATCH_MS: '0',
        BROWSE_HEADED: mode === 'headless' ? '' : '1',
        GSTACK_CHROMIUM_NO_SANDBOX: '1', GSTACK_SECURITY_OFF: '1',
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright'),
      });
      const log = fs.openSync(path.join(root, 'daemon.log'), 'w', 0o600);
      const child = Bun.spawn([process.execPath, '--preload', preload, path.resolve(import.meta.dir, '../src/server.ts')], {
        cwd: root, env, stdin: 'ignore', stdout: log, stderr: log,
      });
      let owned: { pid: number; startTime: string; display: string } | undefined;
      const waitUntil = async (check: () => boolean) => {
        const deadline = Date.now() + 15000;
        while (!check() && Date.now() < deadline) await Bun.sleep(20);
        expect(check()).toBe(true);
      };
      try {
        if (mode === 'welcome' || mode === 'welcome failure' || mode === 'shutdown') {
          await waitUntil(() => fs.existsSync(entered));
          owned = JSON.parse(fs.readFileSync(entered, 'utf8'));
          expect(fs.existsSync(stateFile)).toBe(false);
          if (mode === 'shutdown') {
            const foreign = `${JSON.stringify({ pid: process.pid, instanceId: 'foreign-fixture-instance' })}\n`;
            fs.writeFileSync(stateFile, foreign, { mode: 0o600 });
            child.kill('SIGTERM');
            await waitUntil(() => child.exitCode !== null);
            expect(await child.exited).toBe(0);
            expect(fs.readFileSync(stateFile, 'utf8') === foreign).toBe(true);
            expect(owned).toBeDefined();
            expect(isOurXvfb(owned!.pid, owned!.startTime)).toBe(false);
            return;
          }
          fs.writeFileSync(release, 'release');
        }
        await waitUntil(() => fs.existsSync(stateFile));
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.xvfbPid) owned = { pid: state.xvfbPid, startTime: state.xvfbStartTime, display: state.xvfbDisplay };
        const health = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(3000) });
        expect((await health.json() as { status: string }).status).toBe('healthy');
        const command = async (name: string, args: string[] = []) => {
          const response = await fetch(`http://127.0.0.1:${state.port}/command`, {
            method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: name, args }), signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error(`${name}: ${response.status}: ${await response.text()}`);
          return response.text();
        };
        if (mode === 'welcome') expect(await command('url')).toContain('/welcome');
        if (mode === 'welcome failure') {
          expect(fs.readFileSync(path.join(root, 'daemon.log'), 'utf8')).toContain('Welcome test navigation failure');
          expect(await command('url')).toContain('about:blank');
        }
        if (mode === 'restored page' || mode === 'headless') expect(fs.existsSync(entered)).toBe(false);
        if (mode === 'restored page') expect(await command('text')).toContain('Requested page remains usable');
        await command('goto', [requestedUrl]);
        expect(await command('text')).toContain('Requested page remains usable');
        expect(await command('url')).toContain(requestedUrl);
        await command('stop');
        await waitUntil(() => child.exitCode !== null);
        expect(await child.exited).toBe(0);
        if (owned) expect(isOurXvfb(owned.pid, owned.startTime)).toBe(false);
      } finally {
        fs.writeFileSync(release, 'release');
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await Promise.race([child.exited, Bun.sleep(10000)]);
          if (child.exitCode === null) child.kill('SIGKILL');
          await child.exited;
        }
        if (owned) cleanupXvfb(owned);
        fs.closeSync(log);
        fixture.stop(true);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 60000);
  }

  for (const mode of ['lazy', 'existing', 'headed boot', 'exhausted'] as const) {
    test(`${mode}: registered daemon commands and shutdown respect display ownership`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-display-daemon-'));
      const stateFile = path.join(root, 'state', 'browse.json');
      const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<title>Display fixture</title><h1>Promotion remains usable</h1>', { headers: { 'Content-Type': 'text/html' } }) });
      let external: Awaited<ReturnType<typeof import('../src/xvfb').spawnXvfb>> | undefined;
      let owned: { pid: number; startTime: string; display: string } | undefined;
      let child: ReturnType<typeof Bun.spawn> | undefined;
      const log = fs.openSync(path.join(root, 'daemon.log'), 'w', 0o600);
      const waitUntil = async (check: () => boolean) => {
        const deadline = Date.now() + 15000;
        while (!check() && Date.now() < deadline) await Bun.sleep(50);
        expect(check()).toBe(true);
      };
      try {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined && !/^(BROWSE_|GSTACK_|CHROMIUM_PROFILE$|CLAUDE_PLUGIN_DATA$|DISPLAY$|WAYLAND_DISPLAY$)/.test(key)) env[key] = value;
        }
        Object.assign(env, {
          HOME: root, GSTACK_HOME: path.join(root, 'home-state'),
          CHROMIUM_PROFILE: path.join(root, 'profile'), BROWSE_STATE_FILE: stateFile,
          BROWSE_PORT: '0', BROWSE_PARENT_PID: '0', GSTACK_STATE_WATCH_MS: '0',
          GSTACK_CHROMIUM_NO_SANDBOX: '1', GSTACK_SECURITY_OFF: '1',
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright'),
        });
        if (mode === 'existing') {
          const display = pickFreeDisplay();
          expect(display).not.toBeNull();
          external = await (await import('../src/xvfb')).spawnXvfb(display!);
          env.DISPLAY = external.display;
        }
        if (mode === 'headed boot') env.BROWSE_HEADED = '1';
        if (mode === 'exhausted') {
          const bin = path.join(root, 'bin');
          fs.mkdirSync(bin);
          fs.writeFileSync(path.join(bin, 'xdpyinfo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
          env.PATH = `${bin}:${env.PATH}`;
        }
        child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../src/server.ts')], {
          cwd: root, env, stdin: 'ignore', stdout: log, stderr: log,
        });
        await waitUntil(() => fs.existsSync(stateFile));
        const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(before.mode).toBe(mode === 'headed boot' ? 'headed' : 'launched');
        if (mode !== 'headed boot') expect(before.xvfbPid).toBeUndefined();
        const command = async (name: string, args: string[] = []) => {
          const response = await fetch(`http://127.0.0.1:${before.port}/command`, {
            method: 'POST', headers: { Authorization: `Bearer ${before.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: name, args }), signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error(`${name}: ${response.status}: ${await response.text()}`);
          return response.text();
        };
        await command('goto', [`http://127.0.0.1:${fixture.port}`]);
        const handoff = await command('handoff', ['display fixture']);
        const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (mode === 'exhausted') {
          expect(handoff).toContain('no free X display');
          expect(after.mode).toBe('launched');
          expect(after.xvfbPid).toBeUndefined();
        } else {
          expect(handoff).toContain('HANDOFF:');
          expect(handoff).not.toContain('ERROR:');
          expect(after.mode).toBe('headed');
        }
        if (mode === 'existing') {
          expect(after.xvfbPid).toBeUndefined();
          expect(isOurXvfb(external!.pid, external!.startTime)).toBe(true);
        } else if (mode !== 'exhausted') {
          owned = { pid: after.xvfbPid, startTime: after.xvfbStartTime, display: after.xvfbDisplay };
          expect(isOurXvfb(owned.pid, owned.startTime)).toBe(true);
          if (mode === 'lazy') expect(handoff).toContain('Off-screen Xvfb');
          else expect(after.xvfbPid).toBe(before.xvfbPid);
        }
        expect(await command('text')).toContain('Promotion remains usable');
        expect(await command('resume')).toContain('RESUMED');
        await command('handoff', ['idempotent']);
        expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).xvfbPid).toBe(after.xvfbPid);
        await command('stop');
        await waitUntil(() => child!.exitCode !== null);
        expect(await child.exited).toBe(0);
        if (owned) expect(isOurXvfb(owned.pid, owned.startTime)).toBe(false);
        if (external) expect(isOurXvfb(external.pid, external.startTime)).toBe(true);
      } finally {
        if (child && child.exitCode === null) {
          child.kill('SIGTERM');
          await Promise.race([child.exited, Bun.sleep(10000)]);
          if (child.exitCode === null) child.kill('SIGKILL');
          await child.exited;
        }
        if (owned) cleanupXvfb(owned);
        external?.close();
        fs.closeSync(log);
        fixture.stop(true);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 60000);
  }
});
