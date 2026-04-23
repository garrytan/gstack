/**
 * Layer 2: Server HTTP integration tests for sidebar endpoints.
 * Starts the browse server as a subprocess (no browser via BROWSE_HEADLESS_SKIP),
 * exercises sidebar HTTP endpoints with fetch(). No Chrome, no Claude, no sidebar-agent.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let serverProc: Subprocess | null = null;
let serverPort: number = 0;
let authToken: string = '';
let tmpDir: string = '';
let stateFile: string = '';
let queueFile: string = '';

async function api(pathname: string, opts: RequestInit & { noAuth?: boolean } = {}): Promise<Response> {
  const { noAuth, ...fetchOpts } = opts;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOpts.headers as Record<string, string> || {}),
  };
  if (!noAuth && !headers['Authorization'] && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, { ...fetchOpts, headers });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-integ-'));
  stateFile = path.join(tmpDir, 'browse.json');
  queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');

  // Ensure queue dir exists
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });

  const serverScript = path.resolve(__dirname, '..', 'src', 'server.ts');
  serverProc = spawn(['bun', 'run', serverScript], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_PORT: '0',
      SIDEBAR_QUEUE_PATH: queueFile,
      BROWSE_IDLE_TIMEOUT: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for state file
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        if (state.port && state.token) {
          serverPort = state.port;
          authToken = state.token;
          break;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!serverPort) throw new Error('Server did not start in time');
}, 20000);

afterAll(() => {
  if (serverProc) { try { serverProc.kill(); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// Reset state between tests — creates a fresh session, clears all queues
async function resetState() {
  await api('/sidebar-session/new', { method: 'POST' });
  fs.writeFileSync(queueFile, '');
}

describe('sidebar auth', () => {
  test('rejects request without auth token', async () => {
    const resp = await api('/sidebar-command', {
      method: 'POST',
      noAuth: true,
      body: JSON.stringify({ message: 'test' }),
    });
    expect(resp.status).toBe(401);
  });

  test('rejects request with wrong token', async () => {
    const resp = await api('/sidebar-command', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong-token' },
      body: JSON.stringify({ message: 'test' }),
    });
    expect(resp.status).toBe(401);
  });

  test('accepts request with correct token', async () => {
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(resp.status).toBe(200);
    // Clean up
    await api('/sidebar-agent/kill', { method: 'POST' });
  });
});

describe('sidebar-command → queue', () => {
  test('writes queue entry with activeTabUrl', async () => {
    await resetState();

    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: 'what is on this page?',
        activeTabUrl: 'https://example.com/test-page',
      }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);

    // Give server a moment to write queue
    await new Promise(r => setTimeout(r, 100));

    const content = fs.readFileSync(queueFile, 'utf-8').trim();
    const lines = content.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[lines.length - 1]);
    // Active tab URL is carried on the queue entry metadata (entry.pageUrl),
    // NOT inlined into the prompt.  The system prompt deliberately tells
    // Claude to run `browse url` instead of trusting any URL in the prompt
    // body — that's the prompt-injection-via-URL defense.  See spawnClaude
    // in browse/src/server.ts.
    expect(entry.pageUrl).toBe('https://example.com/test-page');

    await api('/sidebar-agent/kill', { method: 'POST' });
  });

  test('falls back when activeTabUrl is null', async () => {
    await resetState();

    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'test', activeTabUrl: null }),
    });
    await new Promise(r => setTimeout(r, 100));

    const lines = fs.readFileSync(queueFile, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[lines.length - 1]);
    // No browser → playwright URL is 'about:blank'
    expect(entry.pageUrl).toBe('about:blank');

    await api('/sidebar-agent/kill', { method: 'POST' });
  });

  test('rejects chrome:// activeTabUrl and falls back', async () => {
    await resetState();

    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'test', activeTabUrl: 'chrome://extensions' }),
    });
    await new Promise(r => setTimeout(r, 100));

    const lines = fs.readFileSync(queueFile, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.pageUrl).toBe('about:blank');

    await api('/sidebar-agent/kill', { method: 'POST' });
  });

  test('rejects empty message', async () => {
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: '' }),
    });
    expect(resp.status).toBe(400);
  });
});

describe('sidebar-agent/event → chat buffer', () => {
  test('agent events appear in /sidebar-chat', async () => {
    await resetState();

    // Post pre-processed agent event.  The server's processAgentEvent
    // handles the simplified types that sidebar-agent.ts emits (text,
    // text_delta, tool_use, result, agent_error, security_event), NOT
    // the raw Claude streaming format — pre-processing lives in
    // sidebar-agent.ts, not in the server.
    await api('/sidebar-agent/event', {
      method: 'POST',
      body: JSON.stringify({
        type: 'text',
        text: 'Hello from mock agent',
      }),
    });

    const chatData = await (await api('/sidebar-chat?after=0')).json();
    const textEntry = chatData.entries.find((e: any) => e.type === 'text');
    expect(textEntry).toBeDefined();
    expect(textEntry.text).toBe('Hello from mock agent');
  });

  test('agent_done transitions status to idle', async () => {
    await resetState();
    // Start a command so agent is processing
    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'test' }),
    });

    // Verify processing
    let session = await (await api('/sidebar-session')).json();
    expect(session.agent.status).toBe('processing');

    // Send agent_done
    await api('/sidebar-agent/event', {
      method: 'POST',
      body: JSON.stringify({ type: 'agent_done' }),
    });

    session = await (await api('/sidebar-session')).json();
    expect(session.agent.status).toBe('idle');
  });
});

describe('message queuing', () => {
  test('queues message when agent is processing', async () => {
    await resetState();

    // First message starts processing
    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'first' }),
    });

    // Second message gets queued
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'second' }),
    });
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.queued).toBe(true);
    expect(data.position).toBe(1);

    await api('/sidebar-agent/kill', { method: 'POST' });
  });

  test('returns 429 when queue is full', async () => {
    await resetState();

    // First message starts processing
    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'first' }),
    });

    // Fill queue (max 5)
    for (let i = 0; i < 5; i++) {
      await api('/sidebar-command', {
        method: 'POST',
        body: JSON.stringify({ message: `fill-${i}` }),
      });
    }

    // 7th message should be rejected
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'overflow' }),
    });
    expect(resp.status).toBe(429);

    await api('/sidebar-agent/kill', { method: 'POST' });
  });
});

describe('chat clear', () => {
  test('clears chat buffer', async () => {
    await resetState();
    // Add some entries
    await api('/sidebar-agent/event', {
      method: 'POST',
      body: JSON.stringify({ type: 'text', text: 'to be cleared' }),
    });

    await api('/sidebar-chat/clear', { method: 'POST' });

    const data = await (await api('/sidebar-chat?after=0')).json();
    expect(data.entries.length).toBe(0);
    expect(data.total).toBe(0);
  });
});

describe('agent kill', () => {
  test('kill adds error entry and returns to idle', async () => {
    await resetState();

    // Start a command so agent is processing
    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'kill me' }),
    });

    let session = await (await api('/sidebar-session')).json();
    expect(session.agent.status).toBe('processing');

    // Kill the agent
    const killResp = await api('/sidebar-agent/kill', { method: 'POST' });
    expect(killResp.status).toBe(200);

    // Check chat for error entry
    const chatData = await (await api('/sidebar-chat?after=0')).json();
    const errorEntry = chatData.entries.find((e: any) => e.error === 'Killed by user');
    expect(errorEntry).toBeDefined();

    // Agent should be idle (no queue items to auto-process)
    session = await (await api('/sidebar-session')).json();
    expect(session.agent.status).toBe('idle');
  });
});
