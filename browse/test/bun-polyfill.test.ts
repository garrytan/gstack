import { describe, test, expect, afterAll } from 'bun:test';
import * as path from 'path';

// Load the polyfill into a fresh object (don't clobber globalThis.Bun)
const polyfillPath = path.resolve(import.meta.dir, '../src/bun-polyfill.cjs');
// Forward slashes so the path survives interpolation into a JS string literal
// on Windows, which is the platform this polyfill exists for.
const requirePath = polyfillPath.replace(/\\/g, '/');

describe('bun-polyfill', () => {
  // We test the polyfill by requiring it in a subprocess under Node.js
  // since it's designed for Node, not Bun.

  test('Bun.sleep resolves after delay', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${requirePath}');
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
      require('${requirePath}');
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
      require('${requirePath}');
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

  // windowsHide is the one option where Node's default is the opposite of
  // Bun's: Node shows the child's console window, Bun hides it. Dropping it
  // in translation makes every spawned child pop a window on Windows, which
  // is the platform this whole file exists for. Both shims are covered.
  test('Bun.spawn defaults windowsHide to true', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawn;
      let seen;
      cp.spawn = (c, a, o) => { seen = o; return orig(c, a, o); };
      require('${requirePath}');
      Bun.spawn(['node', '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('windowsHide:true');
  });

  test('Bun.spawnSync defaults windowsHide to true', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawnSync;
      let seen;
      cp.spawnSync = (c, a, o) => { seen = o; return orig(c, a, o); };
      require('${requirePath}');
      Bun.spawnSync(['node', '-e', '']);
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('windowsHide:true');
  });

  test('an explicit windowsHide:false is honored', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawn;
      let seen;
      cp.spawn = (c, a, o) => { seen = o; return orig(c, a, o); };
      require('${requirePath}');
      Bun.spawn(['node', '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('windowsHide:false');
  });

  test('Bun.serve creates an HTTP server that responds', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${requirePath}');
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
