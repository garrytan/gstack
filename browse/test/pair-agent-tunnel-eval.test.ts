/**
 * Tunnel-surface behavioral eval for the pair-agent flow.
 *
 * Spawns the daemon under `BROWSE_HEADLESS_SKIP=1 BROWSE_TUNNEL_LOCAL_ONLY=1`
 * so BOTH listeners come up: the local listener on `port` and the tunnel
 * listener on `tunnelLocalPort`. No ngrok, no live network — the surface tag
 * (`local` vs `tunnel`) is set by which listener received the request, which
 * is testable as long as both bind locally.
 *
 * This file is the only place that exercises the tunnel-surface gate
 * end-to-end. The source-level guards in `dual-listener.test.ts` catch
 * literal/exemption regressions, the unit test in `tunnel-gate-unit.test.ts`
 * catches gate-logic regressions, and this file catches routing-or-listener
 * regressions (e.g. someone accidentally swaps `'local'` and `'tunnel'` at
 * the makeFetchHandler call site).
 *
 * The browser dispatch path under BROWSE_HEADLESS_SKIP=1 surfaces an error
 * because there is no Playwright context, so the assertion target is
 * specifically that the GATE was passed (i.e. the response is NOT a 403 with
 * `disallowed_command:<x>`), not that the dispatch succeeded.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '../..');
const SERVER_ENTRY = path.join(ROOT, 'browse/src/server.ts');
const CLEANUP_GRACE_MS = 1000;
// Reserve cleanup and diagnostic reporting inside the unchanged 30s hook.
const SETUP_WORK_MS = 28_000;

type DaemonProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

// Drain immediately so a noisy startup cannot block on an unread pipe. Keep
// bounded diagnostic tails; setup failures print these into the shard log.
function captureOutput(stream: ReadableStream<Uint8Array>) {
  let tail = '';
  let finished = false;
  const reader = stream.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail = (tail + decoder.decode(value, { stream: true })).slice(-64_000);
      }
      tail = (tail + decoder.decode()).slice(-64_000);
    } catch (error) {
      tail += `\n[output capture failed: ${error instanceof Error ? error.message : String(error)}]`;
    } finally { finished = true; reader.releaseLock(); }
  })();
  return { done, isFinished: () => finished, text: () => tail, cancel: () => {
    if (finished) return;
    tail += '\n[output incomplete: cleanup grace expired]';
    void reader.cancel().catch(() => {});
  } };
}

type OutputCapture = ReturnType<typeof captureOutput>;

interface DaemonHandle {
  proc: DaemonProcess;
  stdout: OutputCapture;
  stderr: OutputCapture;
  localPort: number;
  tunnelPort: number;
  rootToken: string;
  scopedToken: string;
  stateFile: string;
  tempDir: string;
  localUrl: string;
  tunnelUrl: string;
  attemptsLogPath: string;
}

async function waitForReady(proc: DaemonProcess, stateFile: string, assertRunning: () => void, signal: AbortSignal): Promise<{ port: number; token: string }> {
  for (;;) {
    signal.throwIfAborted();
    assertRunning();
    let state: { pid?: unknown; port?: unknown; token?: unknown } | undefined;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (state !== undefined) {
      if (!state || state.pid !== proc.pid || typeof state.port !== 'number' ||
          !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 ||
          typeof state.token !== 'string' || !state.token.length) {
        throw new Error('Daemon state does not identify the owned child with a valid port and token');
      }
      let ready = false;
      try {
        const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
        ready = resp.ok;
        void resp.body?.cancel().catch(() => {});
      } catch { /* not ready yet; the single setup deadline still applies */ }
      signal.throwIfAborted();
      assertRunning();
      if (ready) return { port: state.port, token: state.token };
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function waitForTunnelPort(proc: DaemonProcess, stateFile: string, assertRunning: () => void, signal: AbortSignal, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    assertRunning();
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      if (state.pid === proc.pid && Number.isInteger(state.tunnelLocalPort) &&
          state.tunnelLocalPort > 0 && state.tunnelLocalPort <= 65535) return state.tunnelLocalPort;
    } catch {
      // state file not written yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Tunnel local port did not appear in ${stateFile} within ${timeoutMs}ms`);
}

async function stopProcess(proc: DaemonProcess, stdout: OutputCapture, stderr: OutputCapture): Promise<void> {
  let killError: unknown;
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL'); } catch (error) { killError = error; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = proc.exited;
  let exitSettled = false;
  void exited.then(() => { exitSettled = true; }, () => {});
  try {
    const settled = await Promise.race([
      Promise.all([exited, stdout.done, stderr.done]).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), CLEANUP_GRACE_MS); }),
    ]);
    if (!settled) {
      const waits = `exit=${exitSettled ? 'settled' : 'pending'}; stdout=${stdout.isFinished() ? 'finished' : 'pending'}; stderr=${stderr.isFinished() ? 'finished' : 'pending'}`;
      stdout.cancel();
      stderr.cancel();
      throw new Error([
        `owned child or output did not settle within ${CLEANUP_GRACE_MS}ms cleanup grace`,
        `Cleanup waits: ${waits}`,
        `Owned daemon PID: ${proc.pid}; exit: ${proc.exitCode ?? 'none'}; signal: ${proc.signalCode ?? 'none'}`,
        ...(killError ? [`Kill attempt failed: ${String(killError)}`] : []),
        `stdout tail:\n${stdout.text() || '(empty)'}`,
        `stderr tail:\n${stderr.text() || '(empty)'}`,
      ].join('\n'));
    }
  } finally { if (timer) clearTimeout(timer); }
}

async function spawnDaemonWithTunnel(options: {
  // Fixture-local injection exercises startup failures with real free children.
  launch?: (env: NodeJS.ProcessEnv) => DaemonProcess;
  setupWorkMs?: number;
} = {}): Promise<DaemonHandle> {
  // Isolate this test's analytics + denial log directory so we can assert on a
  // fresh attempts.jsonl without colliding with the user's real ~/.gstack.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-agent-tunnel-eval-'));
  const stateFile = path.join(tempDir, 'browse.json');
  const fakeHome = path.join(tempDir, 'home');
  const attemptsLogPath = path.join(fakeHome, '.gstack', 'security', 'attempts.jsonl');
  let proc: DaemonProcess | undefined;
  let stdout: OutputCapture | undefined;
  let stderr: OutputCapture | undefined;
  const controller = new AbortController();
  const workMs = Math.min(options.setupWorkMs ?? SETUP_WORK_MS, SETUP_WORK_MS);
  let workTimer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    workTimer = setTimeout(() => {
      const error = new Error(`Daemon setup timed out after ${workMs}ms`);
      controller.abort(error);
      reject(error);
    }, workMs);
  });
  try {
    return await Promise.race([expired, (async () => {
      fs.mkdirSync(fakeHome, { recursive: true });
      const env = {
        ...process.env,
        HOME: fakeHome,
        BROWSE_HEADLESS_SKIP: '1',
        BROWSE_TUNNEL_LOCAL_ONLY: '1',
        BROWSE_PORT: '0', // Let the owned daemon choose and publish a checked port.
        BROWSE_STATE_FILE: stateFile,
        BROWSE_PARENT_PID: '0',
        BROWSE_IDLE_TIMEOUT: '600000',
      };
      proc = options.launch ? options.launch(env) : Bun.spawn(['bun', 'run', SERVER_ENTRY], {
        cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      stdout = captureOutput(proc.stdout);
      stderr = captureOutput(proc.stderr);
      let exitCode: number | undefined;
      void proc.exited.then(code => { exitCode = code; });
      const assertRunning = () => {
        if (exitCode !== undefined) throw new Error(`Daemon exited before setup completed (code ${exitCode}, signal ${proc!.signalCode ?? 'none'})`);
      };

      const state = await waitForReady(proc, stateFile, assertRunning, controller.signal);
      const localPort = state.port;
      const localUrl = `http://127.0.0.1:${localPort}`;
      const tunnelPort = await waitForTunnelPort(proc, stateFile, assertRunning, controller.signal);
      const tunnelUrl = `http://127.0.0.1:${tunnelPort}`;
      controller.signal.throwIfAborted();
      assertRunning();

      // Read the root token, then exchange it for a scoped token via /pair → /connect.
      const rootToken = state.token;

      const pairResp = await fetch(`${localUrl}/pair`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootToken}` },
        body: JSON.stringify({ clientId: 'tunnel-eval' }),
      });
      if (!pairResp.ok) throw new Error(`/pair failed: ${pairResp.status}`);
      const { setup_key } = await pairResp.json() as any;

      controller.signal.throwIfAborted();
      const connectResp = await fetch(`${localUrl}/connect`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_key }),
      });
      if (!connectResp.ok) throw new Error(`/connect failed: ${connectResp.status}`);
      const { token: scopedToken } = await connectResp.json() as any;

      controller.signal.throwIfAborted();
      return { proc, stdout, stderr, localPort, tunnelPort, rootToken, scopedToken, stateFile, tempDir, localUrl, tunnelUrl, attemptsLogPath };
    })()]);
  } catch (cause) {
    let cleanupError: unknown;
    try { if (proc && stdout && stderr) await stopProcess(proc, stdout, stderr); }
    catch (error) { cleanupError = error; }
    let startupError = '';
    try { startupError = fs.readFileSync(path.join(tempDir, 'browse-startup-error.log'), 'utf8').slice(-64_000); } catch { /* may fail before writing it */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); }
    catch (error) { cleanupError ??= error; }
    throw new Error([
      cause instanceof Error ? cause.message : String(cause),
      `Owned daemon PID: ${proc?.pid ?? 'not spawned'}; exit: ${proc?.exitCode ?? 'none'}; signal: ${proc?.signalCode ?? 'none'}`,
      `stdout tail:\n${stdout?.text() || '(empty)'}`,
      `stderr tail:\n${stderr?.text() || '(empty)'}`,
      ...(startupError ? [`startup error file:\n${startupError}`] : []),
      ...(cleanupError ? [`cleanup failed: ${String(cleanupError)}`] : []),
    ].join('\n'), { cause });
  } finally { clearTimeout(workTimer!); controller.abort(new Error('setup finished')); }
}

async function killDaemon(handle: DaemonHandle): Promise<void> {
  try { await stopProcess(handle.proc, handle.stdout, handle.stderr); }
  finally { fs.rmSync(handle.tempDir, { recursive: true, force: true }); }
}

async function postCommand(baseUrl: string, token: string, body: any): Promise<{ status: number; bodyText: string }> {
  const resp = await fetch(`${baseUrl}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: resp.status, bodyText: await resp.text() };
}

describe('pair-agent over tunnel surface — gate fires on the right surface only', () => {
  let daemon: DaemonHandle;

  beforeAll(async () => {
    daemon = await spawnDaemonWithTunnel();
  }, 30_000);

  afterAll(async () => {
    if (daemon) await killDaemon(daemon);
  });

  test('newtab on tunnel surface passes the allowlist gate (not 403 disallowed_command)', async () => {
    const { status, bodyText } = await postCommand(daemon.tunnelUrl, daemon.scopedToken, { command: 'newtab' });
    // Browser dispatch under BROWSE_HEADLESS_SKIP=1 will fail differently
    // (no Playwright context), but the gate must NOT 403 with
    // disallowed_command.
    if (status === 403) {
      expect(bodyText).not.toContain('disallowed_command:newtab');
      expect(bodyText).not.toContain('is not allowed over the tunnel surface');
    }
  });

  test('pair on tunnel surface 403s with disallowed_command and writes a denial-log entry', async () => {
    // Snapshot attempts.jsonl size before the call so we can detect the new entry.
    let beforeBytes = 0;
    try { beforeBytes = fs.statSync(daemon.attemptsLogPath).size; } catch {}

    const { status, bodyText } = await postCommand(daemon.tunnelUrl, daemon.scopedToken, { command: 'pair' });
    expect(status).toBe(403);
    expect(bodyText).toContain('is not allowed over the tunnel surface');

    // Wait briefly for the denial-log writer (it's synchronous fs.appendFile in
    // tunnel-denial-log.ts but the OS may need a tick to flush).
    await new Promise(r => setTimeout(r, 250));
    expect(fs.existsSync(daemon.attemptsLogPath)).toBe(true);
    const after = fs.readFileSync(daemon.attemptsLogPath, 'utf-8');
    const newSection = after.slice(beforeBytes);
    expect(newSection).toContain('disallowed_command:pair');
  });

  test('pair on local surface does NOT trigger the tunnel allowlist gate', async () => {
    // The same scoped token over the LOCAL listener must not see the
    // disallowed_command path — the tunnel gate is surface-scoped.
    const { status, bodyText } = await postCommand(daemon.localUrl, daemon.scopedToken, { command: 'pair' });
    // Whatever happens (404 unknown command, 403 from a token-scope check, or
    // 200 if the local handler accepts it) the response must NOT come from the
    // tunnel allowlist gate.
    expect(bodyText).not.toContain('disallowed_command:pair');
    expect(bodyText).not.toContain('is not allowed over the tunnel surface');
    expect([200, 400, 403, 404, 500]).toContain(status);
  });

  test('catch-22 regression: newtab + goto on the just-created tab passes ownership check', async () => {
    // Without the `command !== 'newtab'` exemption at server.ts:613, scoped
    // agents can't open a tab (newtab fails ownership) and can't goto an
    // existing tab (also fails ownership). This proves the exemption holds:
    // newtab succeeds the gate AND the ownership check, then the agent can
    // hand off the tabId to a follow-up command without hitting the
    // "Tab not owned by your agent" error.
    const newtabResp = await postCommand(daemon.tunnelUrl, daemon.scopedToken, { command: 'newtab' });
    if (newtabResp.status === 403) {
      expect(newtabResp.bodyText).not.toContain('disallowed_command');
      expect(newtabResp.bodyText).not.toContain('Tab not owned by your agent');
    }

    // Even if the headless-skip dispatch fails before returning a tabId, a
    // follow-up `goto` over the tunnel surface must not 403 with
    // `disallowed_command:goto`. We are NOT asserting that the goto
    // succeeds — only that the allowlist + ownership exemption don't reject
    // it as a class.
    const gotoResp = await postCommand(daemon.tunnelUrl, daemon.scopedToken, { command: 'goto', args: ['http://127.0.0.1:1/'] });
    expect(gotoResp.bodyText).not.toContain('disallowed_command:goto');
    expect(gotoResp.bodyText).not.toContain('is not allowed over the tunnel surface');
  });
});

describe('tunnel fixture startup diagnostics and ownership', () => {
  test('an early child exit drains large output, reports its cause, and removes its workspace', async () => {
    let proc: DaemonProcess | undefined;
    let tempDir = '';
    const started = Date.now();
    let failure: Error | undefined;
    try {
      await spawnDaemonWithTunnel({ launch: env => {
        tempDir = path.dirname(env.BROWSE_STATE_FILE!);
        proc = Bun.spawn([process.execPath, '-e', `
          await new Promise(resolve => process.stdout.write('x'.repeat(256_000) + '\\nstdout-final\\n', resolve));
          await new Promise(resolve => process.stderr.write('y'.repeat(256_000) + '\\nstderr-final\\n', resolve));
          process.exit(23);
        `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        return proc;
      } });
    } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('Daemon exited before setup completed (code 23');
    expect(failure?.message).toContain('stdout-final');
    expect(failure?.message).toContain('stderr-final');
    expect(failure?.message).not.toContain('did not become ready within');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await proc!.exited).toBe(23);
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 10_000);

  test('a pairing failure stops the already-running owned child and retains startup diagnostics', async () => {
    let proc: DaemonProcess | undefined;
    let tempDir = '';
    let failure: Error | undefined;
    try {
      await spawnDaemonWithTunnel({ launch: env => {
        tempDir = path.dirname(env.BROWSE_STATE_FILE!);
        proc = Bun.spawn([process.execPath, '-e', `
          const fs = require('node:fs');
          const port = Number(process.env.BROWSE_PORT);
          const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: req => new Response('fixture', {
            status: new URL(req.url).pathname === '/health' ? 200 : 503,
          }) });
          fs.writeFileSync(process.env.BROWSE_STATE_FILE, JSON.stringify({ pid: process.pid, port: server.port, token: 'fixture-only', tunnelLocalPort: server.port }));
          fs.writeFileSync(require('node:path').join(require('node:path').dirname(process.env.BROWSE_STATE_FILE), 'browse-startup-error.log'), 'owned startup diagnostic');
          console.error('owned child reached health');
        `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        return proc;
      } });
    } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('/pair failed: 503');
    expect(failure?.message).toContain('owned child reached health');
    expect(failure?.message).toContain('owned startup diagnostic');
    await proc!.exited;
    expect(proc!.exitCode !== null || proc!.signalCode !== null).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(false);
  }, 10_000);

  test('a launch exception still removes the temporary workspace', async () => {
    let tempDir = '';
    await expect(spawnDaemonWithTunnel({ launch: env => {
      tempDir = path.dirname(env.BROWSE_STATE_FILE!);
      throw new Error('owned launch failure');
    } })).rejects.toThrow('owned launch failure');
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  test.each([
    ['/pair', 'request'], ['/pair', 'body'],
    ['/connect', 'request'], ['/connect', 'body'],
  ])('a stalled %s %s respects the setup deadline and cleans up', async (endpoint, phase) => {
    let proc: DaemonProcess | undefined;
    let tempDir = '';
    let failure: Error | undefined;
    const started = Date.now();
    try {
      await spawnDaemonWithTunnel({ setupWorkMs: 1000, launch: env => {
        tempDir = path.dirname(env.BROWSE_STATE_FILE!);
        proc = Bun.spawn([process.execPath, '-e', `
          const port = Number(process.env.BROWSE_PORT);
          const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: req => {
            const pathname = new URL(req.url).pathname;
            if (pathname === '/health') return new Response('ready');
            if (pathname === ${JSON.stringify(endpoint)}) {
              console.error('stalled ' + pathname + ' ${phase}');
              if (${JSON.stringify(phase)} === 'request') return new Promise(() => {});
              return new Response(new ReadableStream({ start: controller => controller.enqueue(new TextEncoder().encode('{')) }), {
                headers: { 'Content-Type': 'application/json' },
              });
            }
            return Response.json({ setup_key: 'fixture-only' });
          } });
          require('node:fs').writeFileSync(process.env.BROWSE_STATE_FILE, JSON.stringify({ pid: process.pid, port: server.port, token: 'fixture-only', tunnelLocalPort: server.port }));
        `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        return proc;
      } });
    } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('Daemon setup timed out after 1000ms');
    expect(failure?.message).toContain(`stalled ${endpoint} ${phase}`);
    await proc!.exited;
    expect(proc!.exitCode !== null || proc!.signalCode !== null).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  test('an inherited pipe that stays open is cancelled without hiding the original startup exit', async () => {
    let tempDir = '';
    let cancelled = false;
    const heldPipe = new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new TextEncoder().encode('inherited stdout stayed open\n')),
      cancel: () => { cancelled = true; },
    });
    const started = Date.now();
    let failure: Error | undefined;
    try {
      await spawnDaemonWithTunnel({ launch: env => {
        tempDir = path.dirname(env.BROWSE_STATE_FILE!);
        const child = Bun.spawn([process.execPath, '-e', "console.error('primary startup failure'); process.exit(19);"],
          { env, stdio: ['ignore', 'pipe', 'pipe'] });
        // Model an exited child whose descendant still holds stdout open;
        // no unrelated process is started or killed by this regression.
        return new Proxy(child, { get(target, property) {
          if (property === 'stdout') return heldPipe;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      } });
    } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('Daemon exited before setup completed (code 19');
    expect(failure?.message).toContain('primary startup failure');
    expect(failure?.message).toContain('inherited stdout stayed open');
    expect(failure?.message).toContain('output incomplete: cleanup grace expired');
    expect(failure?.message).toContain('cleanup failed:');
    expect(failure?.message).toContain('Cleanup waits: exit=settled; stdout=pending; stderr=finished');
    expect(cancelled).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  test('cleanup distinguishes an unresolved exit waiter from already-finished output', async () => {
    const child = Bun.spawn([process.execPath, '-e', "console.log('exit-wait stdout'); console.error('exit-wait stderr'); process.exit(17);"],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = captureOutput(child.stdout);
    const stderr = captureOutput(child.stderr);
    await Promise.all([child.exited, stdout.done, stderr.done]);
    const heldExit = new Promise<number>(() => {});
    // The real child is already reaped; only its exposed waiter is held.
    const held = new Proxy(child, { get(target, property) {
      if (property === 'exited') return heldExit;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let failure: Error | undefined;
    try { await stopProcess(held, stdout, stderr); }
    catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('did not settle within 1000ms cleanup grace');
    expect(failure?.message).toContain('Cleanup waits: exit=pending; stdout=finished; stderr=finished');
    expect(failure?.message).toContain(`Owned daemon PID: ${child.pid}; exit: 17; signal: none`);
    expect(failure?.message).toContain('stdout tail:\nexit-wait stdout');
    expect(failure?.message).toContain('stderr tail:\nexit-wait stderr');
    expect(child.exitCode).toBe(17);
  }, 10_000);
});
