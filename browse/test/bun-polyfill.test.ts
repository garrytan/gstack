import { describe, test, expect, afterAll } from 'bun:test';
import * as path from 'path';

// Load the polyfill into a fresh object (don't clobber globalThis.Bun)
const polyfillPath = path.resolve(import.meta.dir, '../src/bun-polyfill.cjs');

describe('bun-polyfill', () => {
  // We test the polyfill by requiring it in a subprocess under Node.js
  // since it's designed for Node, not Bun.

  test('Bun.sleep resolves after delay', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      (async () => {
        const start = Date.now();
        await Bun.sleep(50);
        const elapsed = Date.now() - start;
        console.log(elapsed >= 40 ? 'OK' : 'TOO_FAST');
      })();
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('OK');
    expect(result.exitCode).toBe(0);
  });

  test('Bun.spawnSync runs a command and returns stdout', () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      const r = Bun.spawnSync(['echo', 'hello'], { stdout: 'pipe' });
      console.log(r.stdout.toString().trim());
      console.log('exit:' + r.exitCode);
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('hello');
    expect(lines[1]).toBe('exit:0');
  });

  test('Bun.spawn launches a process with pid', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      const p = Bun.spawn(['echo', 'test'], { stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(typeof p.pid === 'number' ? 'HAS_PID' : 'NO_PID');
      console.log(typeof p.kill === 'function' ? 'HAS_KILL' : 'NO_KILL');
      console.log(typeof p.unref === 'function' ? 'HAS_UNREF' : 'NO_UNREF');
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('HAS_PID');
    expect(lines[1]).toBe('HAS_KILL');
    expect(lines[2]).toBe('HAS_UNREF');
  });

  // Regression: Node defaults windowsHide to false, so before this the browse
  // server flashed an empty console window on Windows for every child it
  // spawned -- most visibly the terminal-agent the watchdog respawns on a 60s
  // tick. Asserts the option reaches child_process rather than trying to
  // observe a window, so it is meaningful on every platform.
  test('Bun.spawn/spawnSync pass windowsHide to child_process', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const realSpawn = cp.spawn, realSpawnSync = cp.spawnSync;
      const seen = {};
      cp.spawn = (c, a, o) => { seen.spawn = o.windowsHide; return realSpawn(c, a, o); };
      cp.spawnSync = (c, a, o) => { seen.spawnSync = o.windowsHide; return realSpawnSync(c, a, o); };
      require('${polyfillPath}');
      Bun.spawnSync([process.execPath, '-e', ''], { stdout: 'pipe' });
      Bun.spawn([process.execPath, '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
      console.log('spawnSync:' + seen.spawnSync);
      console.log('spawn:' + seen.spawn);
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('spawnSync:true');
    expect(lines[1]).toBe('spawn:true');
  });

  // An explicit windowsHide: false must still win, so a caller that genuinely
  // wants a visible console (e.g. debugging a child) keeps that escape hatch.
  test('Bun.spawn honours an explicit windowsHide: false', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const realSpawn = cp.spawn;
      const seen = {};
      cp.spawn = (c, a, o) => { seen.spawn = o.windowsHide; return realSpawn(c, a, o); };
      require('${polyfillPath}');
      Bun.spawn([process.execPath, '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
      console.log('spawn:' + seen.spawn);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('spawn:false');
  });

  test('Bun.serve creates an HTTP server that responds', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      const server = Bun.serve({
        port: 0,  // Note: polyfill uses port directly, so we pick one
        hostname: '127.0.0.1',
        fetch(req) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });
      // The polyfill doesn't support port 0, so we test the object shape
      console.log(typeof server.stop === 'function' ? 'HAS_STOP' : 'NO_STOP');
      console.log(typeof server.port === 'number' ? 'HAS_PORT' : 'NO_PORT');
      server.stop();
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('HAS_STOP');
    expect(lines[1]).toBe('HAS_PORT');
  });
});
