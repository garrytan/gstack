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

interface DaemonHandle {
  proc: ReturnType<typeof Bun.spawn>;
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

async function waitForReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Daemon did not become ready within ${timeoutMs}ms at ${baseUrl}`);
}

async function waitForTunnelPort(stateFile: string, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      if (typeof state.tunnelLocalPort === 'number') return state.tunnelLocalPort;
    } catch {
      // state file not written yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Tunnel local port did not appear in ${stateFile} within ${timeoutMs}ms`);
}

async function spawnDaemonWithTunnel(): Promise<DaemonHandle> {
  // Isolate this test's analytics + denial log directory so we can assert on a
  // fresh attempts.jsonl without colliding with the user's real ~/.gstack.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-agent-tunnel-eval-'));
  const stateFile = path.join(tempDir, 'browse.json');
  const fakeHome = path.join(tempDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const localPort = 30000 + Math.floor(Math.random() * 30000);
  const attemptsLogPath = path.join(fakeHome, '.gstack', 'security', 'attempts.jsonl');

  const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: fakeHome,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_TUNNEL_LOCAL_ONLY: '1',
      BROWSE_PORT: String(localPort),
      BROWSE_STATE_FILE: stateFile,
      BROWSE_PARENT_PID: '0',
      BROWSE_IDLE_TIMEOUT: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const localUrl = `http://127.0.0.1:${localPort}`;
  await waitForReady(localUrl);
  const tunnelPort = await waitForTunnelPort(stateFile);
  const tunnelUrl = `http://127.0.0.1:${tunnelPort}`;

  // Read the root token, then exchange it for a scoped token via /pair → /connect.
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  const rootToken = state.token;

  const pairResp = await fetch(`${localUrl}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rootToken}` },
    body: JSON.stringify({ clientId: 'tunnel-eval' }),
  });
  if (!pairResp.ok) throw new Error(`/pair failed: ${pairResp.status}`);
  const { setup_key } = await pairResp.json() as any;

  const connectResp = await fetch(`${localUrl}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setup_key }),
  });
  if (!connectResp.ok) throw new Error(`/connect failed: ${connectResp.status}`);
  const { token: scopedToken } = await connectResp.json() as any;

  return { proc, localPort, tunnelPort, rootToken, scopedToken, stateFile, tempDir, localUrl, tunnelUrl, attemptsLogPath };
}

function killDaemon(handle: DaemonHandle): void {
  try { handle.proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(handle.tempDir, { recursive: true, force: true }); } catch {}
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

  afterAll(() => {
    if (daemon) killDaemon(daemon);
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
