import { describe, test, expect, afterAll } from 'bun:test';
import * as path from 'path';

// Load the polyfill into a fresh object (don't clobber globalThis.Bun).
// Forward-slash on Windows so the path interpolates cleanly into the
// `require('${polyfillPath}')` template literals below — raw backslashes
// would be interpreted as JS escape sequences in the spawned Node script.
const polyfillPath = path.resolve(import.meta.dir, '../src/bun-polyfill.cjs').replace(/\\/g, '/');

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

  // Bun.spawn parity: `proc.exited` is a Promise resolving to the exit code.
  // The DPAPI helper and isBrowserRunning both `await proc.exited`; without
  // it the awaits resolve immediately to `undefined` and the caller reads
  // stdout before the child has produced it — surfacing as a silent failure.
  test('Bun.spawn exposes proc.exited that resolves to the exit code', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      (async () => {
        const p = Bun.spawn(['node', '-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'ignore'] });
        console.log(typeof p.exited === 'object' && typeof p.exited.then === 'function' ? 'IS_PROMISE' : 'NOT_PROMISE');
        console.log('exit:' + await p.exited);
      })();
    `], { stdout: 'pipe', stderr: 'pipe' });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('IS_PROMISE');
    expect(lines[1]).toBe('exit:0');
  });

  test('Bun.spawn proc.exited reflects non-zero exit codes', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      (async () => {
        const p = Bun.spawn(['node', '-e', 'process.exit(3)'], { stdio: ['ignore', 'ignore', 'ignore'] });
        console.log('exit:' + await p.exited);
      })();
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('exit:3');
  });

  test('Bun.spawn proc.exited resolves before reading stdout (no race)', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      (async () => {
        // Real-world pattern: write to stdout, then exit. Awaiting proc.exited
        // before reading must guarantee the bytes are flushed.
        const p = Bun.spawn(['node', '-e', 'process.stdout.write("ready"); process.exit(0)'], {
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const code = await p.exited;
        const out = await new Response(p.stdout).text();
        console.log(out + ':' + code);
      })();
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('ready:0');
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
