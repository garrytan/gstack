/**
 * #1781 busy-vs-dead pinning test — the "recover from a busy daemon" leg of
 * the browser-lifecycle contract, previously untested.
 *
 * Wedges a fake daemon: /health answers healthy, but the FIRST POST /command
 * hard-destroys the socket (the CLI sees ECONNRESET — exactly what a
 * single-threaded daemon under beacon load looks like). The daemon "PID"
 * is a live sleep child.
 *
 * Contract under test (cli.ts sendCommand + probeHealthWithBackoff):
 *   - CLI must NOT kill the live PID and must NOT restart the daemon
 *     (a restart drops tab/cookie state — the original crash-loop bug).
 *   - It probes /health, sees alive, and retries the SAME command against
 *     the SAME daemon instance.
 *
 * Fails on pre-#1781 code (which killed + restarted on any conn error) and
 * on any regression that reorders the busy-probe before the alive check.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { isProcessAlive } from '../src/error-handling';

const BOOT_ID = `boot-${Date.now()}`;

interface FakeDaemon {
  port: number;
  commandRequests: number;
  close: () => Promise<void>;
}

/** /health healthy; first POST /command → socket destroy; then 200 + BOOT_ID. */
async function startWedgedDaemon(): Promise<FakeDaemon> {
  const state = { commandRequests: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
      return;
    }
    if (req.url === '/command' && req.method === 'POST') {
      state.commandRequests += 1;
      if (state.commandRequests === 1) {
        req.socket.destroy(); // wedged: connection dies mid-request
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`RECOVERED ${BOOT_ID}`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('fake daemon: bad address');
  return {
    port: addr.port,
    get commandRequests() { return state.commandRequests; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function runCli(args: string[], env: Record<string, string>, timeoutMs = 20_000):
  Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = path.resolve(__dirname, '../src/cli.ts');
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', cliPath, ...args], { timeout: timeoutMs, env });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

let daemonPidChild: ChildProcess | null = null;
afterAll(() => { daemonPidChild?.kill('SIGKILL'); });

describe('#1781 busy-daemon recovery (CLI integration)', () => {
  test('retries without kill; same daemon instance, state file untouched', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-busy-'));
    const stateFile = path.join(tmpDir, 'browse.json');
    const daemon = await startWedgedDaemon();
    try {
      // A live process standing in for the daemon PID. If the CLI takes the
      // dead path it SIGTERMs this child — the aliveness assert catches it.
      daemonPidChild = spawn('sleep', ['60'], { stdio: 'ignore' });
      const daemonPid = daemonPidChild.pid!;

      const stateContent = {
        pid: daemonPid,
        port: daemon.port,
        token: 'busy-test-token',
        startedAt: new Date().toISOString(),
        serverPath: '',
        mode: 'launched' as const,
      };
      fs.writeFileSync(stateFile, JSON.stringify(stateContent, null, 2));

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      env.BROWSE_STATE_FILE = stateFile;

      const result = await runCli(['status'], env);

      // Recovered: retried the same command against the same daemon instance.
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`RECOVERED ${BOOT_ID}`);
      // The fork's CLI announces the busy retry on stderr; ours retries at the
      // probe layer without a message. Either is fine — the load-bearing
      // behavior is retry-without-kill, asserted below.
      expect(daemon.commandRequests).toBe(2); // wedged once, served once

      // Never killed, never restarted — tab/cookie state intact.
      expect(result.stderr).not.toContain('Restarting');
      expect(isProcessAlive(daemonPid)).toBe(true);
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8'))).toEqual(stateContent);
    } finally {
      // Cleanup must run even when an assertion throws — otherwise a failed
      // run leaks the wedged fake daemon and the tmp dir.
      await daemon.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
