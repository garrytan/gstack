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
 * Uses a CLI-compatible wrapper around /bin/bash via BROWSE_TERMINAL_BINARY
 * so CI doesn't need the `claude` binary installed.
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
  const terminalCli = path.join(stateDir, 'terminal-cli');
  // Production supplies Claude's CLI arguments. Validate that contract before
  // handing the real PTY to Bash; bare Bash rejects --append-system-prompt.
  fs.writeFileSync(terminalCli, [
    `#!${BASH}`,
    'if [ "$#" -ne 2 ] || [ "$1" != "--append-system-prompt" ] || [ -z "$2" ]; then',
    '  echo "unexpected terminal CLI arguments" >&2; exit 64',
    'fi',
    'shift 2',
    `exec ${BASH} --noprofile --norc "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(terminalCli, 0o755);
  agentProc = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_SERVER_PORT: '0', // not used in this test
      BROWSE_TERMINAL_BINARY: terminalCli,
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

    // Lazy-spawn trigger: any binary frame causes the agent to spawn the fixture CLI.
    // The expected token must not occur in the input: PTY echo alone is not
    // proof that the child accepted its arguments and executed the command.
    ws.send(new TextEncoder().encode("printf 'hello-%s-world\\n' pty\nexit\n"));

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

  test('upgrade response contains exactly ONE Sec-WebSocket-Protocol header', async () => {
    // RFC 6455: the server MUST select at most one subprotocol. Bun >= 1.3
    // auto-echoes the first offered protocol in server.upgrade(), so a
    // manual echo on top of that produced TWO Sec-WebSocket-Protocol
    // headers — and strict clients (Chromium, python websockets) reject the
    // handshake, leaving the sidebar terminal permanently disconnected.
    //
    // Headers.get() normalizes duplicates away, so this test handshakes
    // over a raw socket and counts header lines in the response head.
    const token = 'dup-proto-token-must-be-at-least-seventeen-chars';
    await grantToken(token);

    const head = await new Promise<string>((resolve, reject) => {
      const req =
        'GET /ws HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${agentPort}\r\n` +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        `Sec-WebSocket-Protocol: gstack-pty.${token}\r\n` +
        'Origin: chrome-extension://test-extension-id\r\n' +
        '\r\n';
      let buf = '';
      const socket = require('net').connect(agentPort, '127.0.0.1', () => socket.write(req));
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('handshake timeout')); });
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const end = buf.indexOf('\r\n\r\n');
        if (end !== -1) { socket.destroy(); resolve(buf.slice(0, end)); }
      });
      socket.on('error', reject);
    });

    expect(head).toContain('101');
    const protoLines = head.split('\r\n').filter(l => l.toLowerCase().startsWith('sec-websocket-protocol:'));
    expect(protoLines).toEqual([`Sec-WebSocket-Protocol: gstack-pty.${token}`]);
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

// Route-level lifecycle regressions use the same owned Bash CLI fixture and
// real PTY/WS transport above. Every expected result is absent from typed input.
describe('terminal-agent: owned PTY completion and restart', () => {
  async function internal(route: string, body: unknown) {
    return fetch(`http://127.0.0.1:${agentPort}/internal/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` },
      body: JSON.stringify(body),
    });
  }

  async function until(check: () => boolean | Promise<boolean>, label: string) {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(10);
    }
  }

  async function attach(sessionId: string, token: string) {
    const granted = await internal('grant', { token, sessionId });
    expect(granted.status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${agentPort}/ws`, {
      headers: { Origin: 'chrome-extension://test-extension-id', Cookie: `gstack_pty=${token}` },
    } as any);
    const events: Array<{ type: string; [key: string]: any }> = [];
    let output = '';
    let closed: number | null = null;
    ws.addEventListener('message', (event: any) => {
      if (typeof event.data === 'string') events.push(JSON.parse(event.data));
      else {
        const chunk = new TextDecoder().decode(event.data);
        output += chunk;
        events.push({ type: 'output', text: chunk });
      }
    });
    ws.addEventListener('close', event => { closed = event.code; events.push({ type: 'closed', code: event.code }); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
    });
    return { ws, events, output: () => output, closed: () => closed };
  }

  test('restart closes the old socket and grants a fresh child only to its replacement', async () => {
    const sessionId = 'owned-restart-session';
    const old = await attach(sessionId, 'owned-restart-old-token-long-enough');
    let replacement: Awaited<ReturnType<typeof attach>> | undefined;
    try {
      old.ws.send(new TextEncoder().encode("printf 'restart-%s:%s\\n' old $$\n"));
      await until(() => /restart-old:\d+\r?\n/.test(old.output()), 'old child output');
      const oldPid = /restart-old:(\d+)\r?\n/.exec(old.output())![1];
      const response = await internal('restart', { sessionId });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ killed: 1 });
      // A message can already be queued while the close handshake completes.
      try { old.ws.send(new TextEncoder().encode("printf 'restart-%s\\n' forbidden\n")); } catch {}
      await until(() => old.closed() !== null, 'old socket close');
      expect(old.closed()).toBe(4001);
      expect(old.output()).not.toContain('restart-forbidden');

      replacement = await attach(sessionId, 'owned-restart-new-token-long-enough');
      replacement.ws.send(new TextEncoder().encode("printf 'restart-%s:%s\\n' new $$\nexit\n"));
      await until(() => replacement!.closed() !== null, 'replacement completion');
      expect(replacement.output()).toContain('restart-new:');
      const newPid = /restart-new:(\d+)/.exec(replacement.output())?.[1];
      expect(newPid).toBeDefined();
      expect(newPid).not.toBe(oldPid);
      expect(replacement.events.find(event => event.type === 'pty-exit')?.process.exitCode).toBe(0);
      expect(old.output()).not.toContain('restart-new:');
    } finally {
      try { old.ws.close(1000); } catch {}
      try { replacement?.ws.close(1000); } catch {}
      await internal('restart', { sessionId });
    }
  });

  test('replacement attachment ignores stale input and survives the old socket close', async () => {
    const sessionId = 'owned-overlapping-attachment-session';
    const oldToken = 'owned-overlapping-old-token-long-enough';
    const old = await attach(sessionId, oldToken);
    let replacement: Awaited<ReturnType<typeof attach>> | undefined;
    try {
      old.ws.send(new TextEncoder().encode("printf 'overlap-%s:%s\\n' original $$\n"));
      await until(() => /overlap-original:\d+\r?\n/.test(old.output()), 'original child output');
      const pid = /overlap-original:(\d+)\r?\n/.exec(old.output())![1];

      // Reattach while the original is still open. The replay proves open()
      // has replaced liveWs before we deliver the stale socket's final input.
      replacement = await attach(sessionId, 'owned-overlapping-new-token-long-enough');
      await until(() => replacement!.events.some(event => event.type === 'reattach-begin')
        && replacement!.output().includes(`overlap-original:${pid}`), 'replacement replay');
      expect(old.ws.readyState).toBe(WebSocket.OPEN);
      old.ws.send(new TextEncoder().encode("printf 'overlap-%s\\n' forbidden\n"));
      old.ws.close(1000);
      // Frames on the old connection are ordered: its close follows the late
      // input. No guessed sleep is needed before probing replacement ownership.
      await until(() => old.closed() !== null, 'stale socket close');
      expect(old.closed()).toBe(1000);
      expect(replacement.closed()).toBeNull();
      const revoked = await fetch(`http://127.0.0.1:${agentPort}/ws`, {
        headers: { Origin: 'chrome-extension://test-extension-id', Cookie: `gstack_pty=${oldToken}` },
      });
      expect(revoked.status).toBe(401);

      replacement.ws.send(new TextEncoder().encode("printf 'overlap-%s:%s\\n' current $$\nexit\n"));
      await until(() => replacement!.closed() !== null, 'replacement child completion');
      expect(replacement.output()).toContain(`overlap-current:${pid}`);
      expect(replacement.output()).not.toContain('overlap-forbidden');
      expect(replacement.events.find(event => event.type === 'pty-exit')?.process.exitCode).toBe(0);
      expect(replacement.closed()).toBe(1000);
      expect(old.output()).not.toContain('overlap-current:');
    } finally {
      try { old.ws.close(1000); } catch {}
      try { replacement?.ws.close(1000); } catch {}
      await internal('restart', { sessionId });
    }
  });

  test('completion while detached replays final output before closing without a new child', async () => {
    const sessionId = 'owned-detached-completion-session';
    const release = path.join(stateDir, 'release-detached-child');
    const quotedRelease = `'${release.replace(/'/g, "'\\''")}'`;
    const old = await attach(sessionId, 'owned-detached-old-token-long-enough');
    let replacement: Awaited<ReturnType<typeof attach>> | undefined;
    try {
      const command = `printf 'detached-%s:%s\\n' start $$; while [ ! -e ${quotedRelease} ]; do sleep 0.01; done; printf 'detached-%s:%s\\n' final $$; exit\n`;
      old.ws.send(new TextEncoder().encode(command));
      await until(() => /detached-start:\d+\r?\n/.test(old.output()), 'child waiting at release barrier');
      const pid = /detached-start:(\d+)\r?\n/.exec(old.output())![1];
      old.ws.close(1001);
      await until(() => old.closed() !== null, 'detach handshake');
      fs.writeFileSync(release, 'release\n');
      // Authenticated completion state proves BOTH native callbacks happened
      // while detached; no guessed post-exit sleep or early reattachment.
      await until(async () => {
        const health = await fetch(`http://127.0.0.1:${agentPort}/internal/healthz`, {
          headers: { Authorization: `Bearer ${internalToken}` },
        });
        return (await health.json()).completedSessions === 1;
      }, 'detached completion');

      replacement = await attach(sessionId, 'owned-detached-new-token-long-enough');
      await until(() => replacement!.closed() !== null, 'replayed completion close');
      const kinds = replacement.events.map(event => event.type);
      expect(kinds).toEqual(['reattach-begin', 'output', 'pty-exit', 'closed']);
      expect(replacement.output()).toContain(`detached-start:${pid}`);
      expect(replacement.output()).toContain(`detached-final:${pid}`);
      const completion = replacement.events.find(event => event.type === 'pty-exit')!;
      expect(completion.process.exitCode).toBe(0);
      expect(completion.drainTimedOut).toBe(false);
      expect(completion.exitTimedOut).toBe(false);
      expect(completion.reader).not.toBeNull();
      expect(replacement.closed()).toBe(1000);
    } finally {
      fs.writeFileSync(release, 'release\n');
      try { old.ws.close(1000); } catch {}
      try { replacement?.ws.close(1000); } catch {}
      await internal('restart', { sessionId });
    }
  });
});
