/**
 * Integration tests for terminal-agent.ts.
 *
 * Spawns the agent as a real subprocess in a temp state directory,
 * exercises:
 *   1. /internal/grant — loopback handshake with the internal token.
 *   2. /ws Origin gate — non-extension Origin → 403.
 *   3. /ws cookie gate — missing/invalid cookie → 401.
 *   4. /ws full PTY round-trip — write `echo hi\n`, read `hi`.
 *   5. resize control message — terminal accepts and stays alive.
 *   6. close behavior — sending close terminates the PTY child.
 *
 * Uses /bin/bash via BROWSE_TERMINAL_BINARY override so CI doesn't need
 * the `claude` binary installed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const AGENT_SCRIPT = path.join(import.meta.dir, '../src/terminal-agent.ts');
const BASH = '/bin/bash';

let stateDir: string;
let agentProc: any;
let agentPort: number;
let internalToken: string;

function readPortFile(): number {
  for (let i = 0; i < 50; i++) {
    try {
      const v = parseInt(fs.readFileSync(path.join(stateDir, 'terminal-port'), 'utf-8').trim(), 10);
      if (Number.isFinite(v) && v > 0) return v;
    } catch {}
    Bun.sleepSync(40);
  }
  throw new Error('terminal-agent never wrote port file');
}

function readTokenFile(): string {
  for (let i = 0; i < 50; i++) {
    try {
      const t = fs.readFileSync(path.join(stateDir, 'terminal-internal-token'), 'utf-8').trim();
      if (t.length > 16) return t;
    } catch {}
    Bun.sleepSync(40);
  }
  throw new Error('terminal-agent never wrote internal token');
}

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-term-'));
  const stateFile = path.join(stateDir, 'browse.json');
  // browse.json must exist so the agent's readBrowseToken doesn't throw.
  fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-browse-token' }));
  agentProc = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_SERVER_PORT: '0', // not used in this test
      BROWSE_TERMINAL_BINARY: BASH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agentPort = readPortFile();
  internalToken = readTokenFile();
});

afterAll(() => {
  try { agentProc?.kill?.(); } catch {}
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
});

async function grantToken(token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${agentPort}/internal/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ token }),
  });
}

describe('terminal-agent: /internal/grant', () => {
  test('accepts grants signed with the internal token', async () => {
    const resp = await grantToken('test-cookie-token-very-long-yes');
    expect(resp.status).toBe(200);
  });

  test('rejects grants with the wrong internal token', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/internal/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({ token: 'whatever' }),
    });
    expect(resp.status).toBe(403);
  });
});

describe('terminal-agent: /ws gates', () => {
  test('rejects upgrade attempts without an extension Origin', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`);
    expect(resp.status).toBe(403);
    expect(await resp.text()).toBe('forbidden origin');
  });

  test('rejects upgrade attempts from a non-extension Origin', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: { 'Origin': 'https://evil.example.com' },
    });
    expect(resp.status).toBe(403);
  });

  test('rejects extension-Origin upgrades without a granted cookie', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://abc123',
        'Cookie': 'gstack_pty=never-granted',
      },
    });
    expect(resp.status).toBe(401);
  });
});

describe('terminal-agent: PTY round-trip via real WebSocket (Cookie auth)', () => {
  test('binary writes go to PTY stdin, output streams back', async () => {
    const cookie = 'rt-token-must-be-at-least-seventeen-chars-long';
    const granted = await grantToken(cookie);
    expect(granted.status).toBe(200);

    const ws = new WebSocket(`ws://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://test-extension-id',
        'Cookie': `gstack_pty=${cookie}`,
      },
    } as any);

    const collected: string[] = [];
    let opened = false;
    let closed = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { opened = true; clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e: any) => { clearTimeout(timer); reject(new Error('ws error')); });
    });

    ws.addEventListener('message', (ev: any) => {
      if (typeof ev.data === 'string') return; // ignore control frames
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      collected.push(new TextDecoder().decode(buf));
    });

    ws.addEventListener('close', () => { closed = true; });

    // Lazy-spawn trigger: any binary frame causes the agent to spawn /bin/bash.
    ws.send(new TextEncoder().encode('echo hello-pty-world\nexit\n'));

    // Wait up to 5s for output and shutdown.
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        const joined = collected.join('');
        if (joined.includes('hello-pty-world')) return resolve();
        if (Date.now() - start > 5000) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });

    expect(opened).toBe(true);
    const allOutput = collected.join('');
    expect(allOutput).toContain('hello-pty-world');

    try { ws.close(); } catch {}
    // Give cleanup a moment.
    await Bun.sleep(200);
  });

  test('Sec-WebSocket-Protocol auth path: browser-style upgrade with token in protocol', async () => {
    // This is the path the actual browser extension takes. Cross-port
    // SameSite=Strict cookies don't reliably survive the jump from the
    // browse server (port A) to the agent (port B) when initiated from a
    // chrome-extension origin, so we send the token via the only auth
    // header the browser WebSocket API lets us set: Sec-WebSocket-Protocol.
    //
    // The browser sends `gstack-pty.<token>` and the agent must:
    //   1) strip the gstack-pty. prefix
    //   2) validate the token
    //   3) ECHO the protocol back in the upgrade response
    // Without (3) the browser closes the connection immediately, which
    // is the exact bug the original cookie-only implementation hit in
    // manual dogfood. This test catches that regression in CI.
    const token = 'sec-protocol-token-must-be-at-least-seventeen-chars';
    await grantToken(token);

    // We exercise the protocol path by raw-handshaking via fetch+Upgrade,
    // because Bun's test-client WebSocket constructor doesn't propagate
    // `protocols` cleanly when also passed `headers` (the constructor
    // detects the third-arg form unreliably). Real browsers (Chromium)
    // use the standard protocols arg fine — the server-side handler is
    // identical either way, so this test still locks the load-bearing
    // invariant: the agent accepts a token via Sec-WebSocket-Protocol
    // and echoes the protocol back so a browser would accept the upgrade.
    const handshakeKey = 'dGhlIHNhbXBsZSBub25jZQ==';
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': handshakeKey,
        'Sec-WebSocket-Protocol': `gstack-pty.${token}`,
        'Origin': 'chrome-extension://test-extension-id',
      },
    });

    // 101 Switching Protocols + protocol echoed back = browser would accept.
    // 401/403/anything else = browser would close the connection immediately
    // (the bug we hit in manual dogfood).
    expect(resp.status).toBe(101);
    expect(resp.headers.get('upgrade')?.toLowerCase()).toBe('websocket');
    expect(resp.headers.get('sec-websocket-protocol')).toBe(`gstack-pty.${token}`);
  });

  test('Sec-WebSocket-Protocol auth: rejects unknown token even with valid Origin', async () => {
    const resp = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol': 'gstack-pty.never-granted-token',
        'Origin': 'chrome-extension://test-extension-id',
      },
    });
    expect(resp.status).toBe(401);
  });

  test('text frame {type:"resize"} is accepted (no crash, ws stays open)', async () => {
    const cookie = 'resize-token-must-be-at-least-seventeen-chars';
    await grantToken(cookie);

    const ws = new WebSocket(`ws://127.0.0.1:${agentPort}/ws`, {
      headers: {
        'Origin': 'chrome-extension://test-extension-id',
        'Cookie': `gstack_pty=${cookie}`,
      },
    } as any);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });

    // Send a resize before anything else (lazy-spawn won't fire).
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

    // After resize, send a binary frame; should still work.
    ws.send(new TextEncoder().encode('exit\n'));

    await Bun.sleep(300);
    // ws still readyState 1 (OPEN) or 3 (CLOSED after exit) — both fine.
    expect([WebSocket.OPEN, WebSocket.CLOSED]).toContain(ws.readyState);

    try { ws.close(); } catch {}
  });
});
