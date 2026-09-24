import { describe, test, expect, afterAll, setDefaultTimeout } from 'bun:test';
import * as path from 'path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// Every test here spawnSync's a `node` child; Windows CI cold-start (AV scan,
// first-touch of node.exe) alone can blow bun's 5s default — observed 5,007ms
// on a 50ms sleep test. 20s was still not enough: on 2026-08-26 (PR #2700,
// run 32989821401) the 50ms sleep test blew 20s on BOTH bun retry attempts on
// a degraded windows-latest runner, so cold-start alone doesn't explain it —
// sustained AV/runner pressure does. Subprocess budget, not assertion
// looseness: every assertion still checks exact output, only the slowness
// allowance grows.
setDefaultTimeout(60_000);

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
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('OK');
    expect(result.exitCode).toBe(0);
  });

  test('Bun.spawnSync runs a command and returns stdout', () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      const r = Bun.spawnSync(['echo', 'hello'], { stdout: 'pipe' });
      console.log(r.stdout.toString().trim());
      console.log('exit:' + r.exitCode);
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
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
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
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
      require(${JSON.stringify(polyfillPath)});
      (async () => {
        const p = Bun.spawn(['node', '-e', 'process.exit(0)'], { stdio: ['ignore', 'ignore', 'ignore'] });
        console.log(typeof p.exited === 'object' && typeof p.exited.then === 'function' ? 'IS_PROMISE' : 'NOT_PROMISE');
        console.log('exit:' + await p.exited);
      })();
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('IS_PROMISE');
    expect(lines[1]).toBe('exit:0');
  });

  test('Bun.spawn proc.exited reflects non-zero exit codes', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      (async () => {
        const p = Bun.spawn(['node', '-e', 'process.exit(3)'], { stdio: ['ignore', 'ignore', 'ignore'] });
        console.log('exit:' + await p.exited);
      })();
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('exit:3');
  });

  test('Bun.spawn proc.exited resolves before reading stdout (no race)', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
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
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('ready:0');
  });

  // Spawn-failure case: Node emits 'error' but not 'exit' when the binary
  // is missing, so listening only for 'exit' hangs `await proc.exited`
  // forever. The lifecycle promise must resolve on either event.
  test('Bun.spawn proc.exited resolves on spawn failure (missing binary)', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      (async () => {
        const p = Bun.spawn(['this-binary-does-not-exist-zzz-' + Date.now()], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let deadline;
        const code = await Promise.race([
          p.exited,
          new Promise((_, r) => { deadline = setTimeout(() => r(new Error('timeout')), 3000); })
        ]).catch(() => 'TIMEOUT').finally(() => clearTimeout(deadline));
        console.log('exit:' + code);
      })();
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    // Anything other than 'TIMEOUT' (and ideally a non-zero number) means the
    // lifecycle promise resolved on the spawn error.
    const out = result.stdout.toString().trim();
    expect(out).not.toBe('exit:TIMEOUT');
    expect(out).toMatch(/^exit:\d+$/);
  });

  // Signal-exit branch: Bun reports 128 + signal number when a child is killed
  // by a signal (code === null). Skipped on Windows, whose kill() semantics
  // don't produce the POSIX 128+n mapping.
  test.skipIf(process.platform === 'win32')('Bun.spawn proc.exited maps a killing signal to 128+signal', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      (async () => {
        const p = Bun.spawn(['node', '-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
        setTimeout(() => p.kill('SIGTERM'), 150);
        console.log('exit:' + await p.exited);
      })();
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    // SIGTERM = 15 → 128 + 15 = 143.
    expect(result.stdout.toString().trim()).toBe('exit:143');
  });

  // GSTACK_SPAWN_MAX_BUFFER caps the drain so a runaway child can't OOM the
  // server. Past the cap, the pipe keeps flowing (child doesn't block) but
  // further bytes are dropped. Set a small cap, write more than that, assert
  // the captured stdout equals the cap and the child exits cleanly.
  test('Bun.spawn caps buffered output at GSTACK_SPAWN_MAX_BUFFER', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      process.env.GSTACK_SPAWN_MAX_BUFFER = '${1024}';
      require(${JSON.stringify(polyfillPath)});
      (async () => {
        // Child writes 10 KB; cap is 1 KB; drained output should be exactly 1 KB
        // and exit should still resolve cleanly (child not back-pressured to death).
        const p = Bun.spawn(
          ['node', '-e', 'process.stdout.write("y".repeat(10 * 1024)); process.exit(0)'],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        );
        let deadline;
        const code = await Promise.race([
          p.exited,
          new Promise((_, r) => { deadline = setTimeout(() => r(new Error('timeout')), 3000); })
        ]).catch(() => 'TIMEOUT').finally(() => clearTimeout(deadline));
        const out = await new Response(p.stdout).text();
        console.log(out.length + ':' + code);
      })();
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('1024:0');
  });

  // Regression for the pipe-blocking case: if the child writes more than the
  // OS pipe buffer (~16-64 KB) and the polyfill doesn't drain eagerly, the
  // child blocks in write() and `exit` never fires. 1 MB is well past every
  // OS pipe buffer size. Pre-fix this test hangs forever; post-fix it returns
  // in <500ms. Bun's default per-test timeout is 5s — generous here.
  test('Bun.spawn drains large stdout so proc.exited still resolves', async () => {
    const result = Bun.spawnSync(['node', '-e', `
      require(${JSON.stringify(polyfillPath)});
      (async () => {
        const ONE_MB = 1024 * 1024;
        // Exit in the write callback, not straight after write(): on modern
        // Node a pipe write past the OS buffer is async, and process.exit()
        // right after write() truncates at ~64 KB even with a live reader.
        // The callback only fires once the full MB is flushed — which still
        // requires the parent to drain, so the regression (no eager drain →
        // child blocks → timeout) is still caught.
        const p = Bun.spawn(
          ['node', '-e', 'process.stdout.write("x".repeat(' + ONE_MB + '), () => process.exit(0))'],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        );
        let deadline;
        const code = await Promise.race([
          p.exited,
          new Promise((_, r) => { deadline = setTimeout(() => r(new Error('timeout')), 10000); })
        ]).catch(e => 'TIMEOUT').finally(() => clearTimeout(deadline));
        const out = await new Response(p.stdout).text();
        console.log(out.length + ':' + code);
      })().catch((e) => { console.log('THREW:' + e.message); });
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('1048576:0');
  }, 15000);

  test('cancelled replay readers release inherited pipes after the direct child exits', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'polyfill-cancel-')));
    const marker = path.join(root, 'descendant.pid');
    const pidPath = path.join(root, 'spawned.pid');
    expect(fs.realpathSync(root)).toBe(root);
    try {
      const descendantScript = `
        const fs = require('node:fs');
        fs.writeSync(1, 'fixture-stdout');
        fs.writeSync(2, 'fixture-stderr');
        fs.writeFileSync(${JSON.stringify(marker + '.tmp')}, JSON.stringify({ pid: process.pid, stdout: true, stderr: true }));
        fs.renameSync(${JSON.stringify(marker + '.tmp')}, ${JSON.stringify(marker)});
        setInterval(() => {}, 1000);
      `;
      const childScript = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}],
          { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: process.platform === 'win32' });
        fs.writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
        const deadline = Date.now() + 5000;
        const ready = () => {
          if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
          if (descendant.exitCode !== null || Date.now() >= deadline) process.exit(1);
          setTimeout(ready, 10);
        };
        ready();
      `;
      const script = `
        const childProcess = require('node:child_process');
        const originalSpawn = childProcess.spawn;
        let direct;
        childProcess.spawn = (...args) => { direct = originalSpawn(...args); return direct; };
        require(${JSON.stringify(polyfillPath)});
        let stage = 'spawn';
        let directExitCode;
        let markerValid = false;
        let stdoutAck = false;
        let stderrAck = false;
        let descendantAlive = false;
        let checkErrorCode = null;
        (async () => {
          const proc = Bun.spawn([process.execPath, '-e', ${JSON.stringify(childScript)}],
            { stdio: ['ignore', 'pipe', 'pipe'] });
          if (!direct) throw new Error('capture_missing');
          const stdout = proc.stdout.getReader();
          const stderr = proc.stderr.getReader();
          const stdoutRead = stdout.read();
          const stderrRead = stderr.read();
          stage = 'direct_exit';
          directExitCode = await new Promise((resolve, reject) => { direct.once('exit', resolve); direct.once('error', reject); });
          let readyPid;
          try {
            const fs = require('node:fs');
            const marker = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, 'utf8'));
            readyPid = marker.pid;
            markerValid = Number.isSafeInteger(readyPid) && readyPid > 0
              && String(readyPid) === fs.readFileSync(${JSON.stringify(pidPath)}, 'utf8');
            stdoutAck = marker.stdout === true;
            stderrAck = marker.stderr === true;
          } catch (error) { checkErrorCode = typeof error.code === 'string' ? error.code : 'invalid_marker'; }
          if (markerValid) {
            try { process.kill(readyPid, 0); descendantAlive = true; }
            catch (error) { checkErrorCode = typeof error.code === 'string' ? error.code : 'liveness_error'; }
          }
          if (!markerValid || !stdoutAck || !stderrAck || !descendantAlive) throw new Error('descendant_not_ready');
          stage = 'pending_check';
          await new Promise(resolve => setImmediate(resolve));
          let settled = false;
          proc.exited.then(() => { settled = true; });
          await new Promise(resolve => setImmediate(resolve));
          if (settled) throw new Error('Inherited pipes unexpectedly closed before cancellation');
          stage = 'cancel';
          await Promise.all([stdout.cancel(), stderr.cancel()]);
          const reads = await Promise.all([stdoutRead, stderrRead]);
          stage = 'await_exited';
          let timer;
          const code = await Promise.race([proc.exited, new Promise((_, reject) =>
            { timer = setTimeout(() => reject(new Error('cancel did not settle exited')), 5000); })])
            .finally(() => clearTimeout(timer));
          console.log(JSON.stringify({ code, directExitCode, reads: reads.map(read => read.done), descendantAlive: (() => {
            try { process.kill(JSON.parse(require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8')).pid, 0); return true; }
            catch { return false; }
          })() }));
        })().catch(error => {
          const reason = error.message === 'Inherited pipes unexpectedly closed before cancellation' ? 'early_pipes'
            : error.message === 'cancel did not settle exited' ? 'cancel_stalled'
            : error.message === 'capture_missing' ? 'capture_missing'
            : error.message === 'descendant_not_ready' ? 'descendant_not_ready' : 'unexpected';
          console.error(JSON.stringify({ stage, reason, directExitCode, markerValid, stdoutAck, stderrAck,
            descendantAlive, checkErrorCode, errorCode: typeof error.code === 'string' ? error.code : null }));
          process.exitCode = 1;
        });
      `;
      const result = Bun.spawnSync(['node', '-e', script], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
      const errorOutput = result.stderr.toString().trim();
      let diagnostic: object | null = null;
      try { if (errorOutput) diagnostic = JSON.parse(errorOutput); }
      catch { diagnostic = { stage: 'unframed', stderrBytes: Buffer.byteLength(errorOutput) }; }
      expect({ exitCode: result.exitCode, diagnostic }).toEqual({ exitCode: 0, diagnostic: null });
      expect(JSON.parse(result.stdout.toString())).toEqual({ code: 0, directExitCode: 0, reads: [true, true], descendantAlive: true });
    } finally {
      if (fs.existsSync(pidPath)) {
        const pidText = fs.readFileSync(pidPath, 'utf8');
        if (/^[1-9]\d*$/.test(pidText)) {
          try { process.kill(Number(pidText)); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    const lines = result.stdout.toString().trim().split('\n');
    expect(lines[0]).toBe('HAS_STOP');
    expect(lines[1]).toBe('HAS_PORT');
  });

  // windowsHide is the one option where Node's default is the opposite of
  // Bun's: Node shows the child's console window, Bun hides it. Dropping it
  // in translation makes every spawned child pop a window on Windows, which
  // is the platform this whole file exists for. Both shims are covered, and
  // an explicit windowsHide:false must survive forwarding (#2523 + #2539).
  test('Bun.spawn defaults windowsHide to true', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawn;
      let seen;
      cp.spawn = (c, a, o) => { seen = o; return orig(c, a, o); };
      require(${JSON.stringify(polyfillPath)});
      Bun.spawn(['node', '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('windowsHide:true');
  });

  test('Bun.spawnSync defaults windowsHide to true', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawnSync;
      let seen;
      cp.spawnSync = (c, a, o) => { seen = o; return orig(c, a, o); };
      require(${JSON.stringify(polyfillPath)});
      Bun.spawnSync(['node', '-e', '']);
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('windowsHide:true');
  });

  test('an explicit windowsHide:false is honored', () => {
    const result = Bun.spawnSync(['node', '-e', `
      const cp = require('child_process');
      const orig = cp.spawn;
      let seen;
      cp.spawn = (c, a, o) => { seen = o; return orig(c, a, o); };
      require(${JSON.stringify(polyfillPath)});
      Bun.spawn(['node', '-e', ''], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
      console.log('windowsHide:' + seen.windowsHide);
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(result.stdout.toString().trim()).toBe('windowsHide:false');
  });
});
