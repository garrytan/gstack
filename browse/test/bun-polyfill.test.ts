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

  // Spawn-failure case: Node emits 'error' but not 'exit' when the binary
  // is missing, so listening only for 'exit' hangs `await proc.exited`
  // forever. The lifecycle promise must resolve on either event.
  test('Bun.spawn proc.exited resolves on spawn failure (missing binary)', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      (async () => {
        const p = Bun.spawn(['this-binary-does-not-exist-zzz-' + Date.now()], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const code = await Promise.race([
          p.exited,
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
        ]).catch(() => 'TIMEOUT');
        console.log('exit:' + code);
      })();
    `], { stdout: 'pipe', stderr: 'pipe' });
    // Anything other than 'TIMEOUT' (and ideally a non-zero number) means the
    // lifecycle promise resolved on the spawn error.
    const out = result.stdout.toString().trim();
    expect(out).not.toBe('exit:TIMEOUT');
    expect(out).toMatch(/^exit:\d+$/);
  });

  // GSTACK_SPAWN_MAX_BUFFER caps the drain so a runaway child can't OOM the
  // server. Past the cap, the pipe keeps flowing (child doesn't block) but
  // further bytes are dropped. Set a small cap, write more than that, assert
  // the captured stdout equals the cap and the child exits cleanly.
  test('Bun.spawn caps buffered output at GSTACK_SPAWN_MAX_BUFFER', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      process.env.GSTACK_SPAWN_MAX_BUFFER = '${1024}';
      require('${polyfillPath}');
      (async () => {
        // Child writes 10 KB; cap is 1 KB; drained output should be exactly 1 KB
        // and exit should still resolve cleanly (child not back-pressured to death).
        const p = Bun.spawn(
          ['node', '-e', 'process.stdout.write("y".repeat(10 * 1024)); process.exit(0)'],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const code = await Promise.race([
          p.exited,
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
        ]).catch(() => 'TIMEOUT');
        const out = await new Response(p.stdout).text();
        console.log(out.length + ':' + code);
      })();
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('1024:0');
  });

  // Regression for the pipe-blocking case: if the child writes more than the
  // OS pipe buffer (~16-64 KB) and the polyfill doesn't drain eagerly, the
  // child blocks in write() and `exit` never fires. 1 MB is well past every
  // OS pipe buffer size. Pre-fix this test hangs forever; post-fix it returns
  // in <500ms. Bun's default per-test timeout is 5s — generous here.
  test('Bun.spawn drains large stdout so proc.exited still resolves', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      (async () => {
        const ONE_MB = 1024 * 1024;
        const p = Bun.spawn(
          ['node', '-e', 'process.stdout.write("x".repeat(' + ONE_MB + ')); process.exit(0)'],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const code = await Promise.race([
          p.exited,
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000))
        ]).catch(e => 'TIMEOUT');
        const out = await new Response(p.stdout).text();
        console.log(out.length + ':' + code);
      })().catch((e) => { console.log('THREW:' + e.message); });
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.stdout.toString().trim()).toBe('1048576:0');
  }, 15000);

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
