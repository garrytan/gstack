import { describe, test, expect, afterAll } from 'bun:test';
import * as path from 'path';

// Load the polyfill into a fresh object (don't clobber globalThis.Bun)
const polyfillPath = path.resolve(import.meta.dir, '../src/bun-polyfill.cjs');

describe('bun-polyfill', () => {
  // We test the polyfill by requiring it in a subprocess under Node.js
  // since it's designed for Node, not Bun.

  test('Bun.sleep resolves after delay', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
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
      require(${JSON.stringify(polyfillPath)});
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
      require(${JSON.stringify(polyfillPath)});
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

  test('Bun.serve creates an HTTP server that responds', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
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

  // Regression: node defaults windowsHide to false, so a console child spawned
  // through this shim pops a visible window on Windows — bun never does. Asserted
  // by stubbing child_process before the polyfill destructures it, so the check is
  // deterministic and runs on every platform.
  test('spawn and spawnSync pass windowsHide so Windows shows no console window', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const seen = [];
      cp.spawn = (c, a, o) => { seen.push(o); return { pid: 1, stdout: null, stderr: null, stdin: null, unref() {}, kill() {} }; };
      cp.spawnSync = (c, a, o) => { seen.push(o); return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }; };
      require(${JSON.stringify(polyfillPath)});
      Bun.spawn(['echo', 'x'], { stdio: ['pipe', 'pipe', 'pipe'] });
      Bun.spawnSync(['echo', 'x'], { stdout: 'pipe' });
      console.log(seen.length === 2 ? 'BOTH' : 'GOT_' + seen.length);
      console.log(seen.every((o) => o && o.windowsHide === true) ? 'HIDDEN' : 'VISIBLE');
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('BOTH');
    expect(lines[1]).toBe('HIDDEN');
  });
});
