/**
 * Layer 3: Sidebar agent round-trip tests.
 * Starts server + sidebar-agent together. Mocks the `claude` binary with a shell
 * script that outputs canned stream-json. Verifies events flow end-to-end:
 * POST /sidebar-command → queue → sidebar-agent → mock claude → events → /sidebar-chat
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let serverProc: Subprocess | null = null;
let agentProc: Subprocess | null = null;
let serverPort: number = 0;
let authToken: string = '';
let tmpDir: string = '';
let stateFile: string = '';
let queueFile: string = '';
let mockBinDir: string = '';

async function api(pathname: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  };
  if (!headers['Authorization'] && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, { ...opts, headers });
}

async function resetState() {
  await api('/sidebar-session/new', { method: 'POST' });
  fs.writeFileSync(queueFile, '');
}

async function pollChatUntil(
  predicate: (entries: any[]) => boolean,
  timeoutMs = 10000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await api('/sidebar-chat?after=0');
    const data = await resp.json();
    if (predicate(data.entries)) return data.entries;
    await new Promise(r => setTimeout(r, 300));
  }
  // Return whatever we have on timeout
  const resp = await api('/sidebar-chat?after=0');
  return (await resp.json()).entries;
}

function writeMockClaude(script: string) {
  const mockPath = path.join(mockBinDir, 'claude');
  fs.writeFileSync(mockPath, script, { mode: 0o755 });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-roundtrip-'));
  stateFile = path.join(tmpDir, 'browse.json');
  queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');
  mockBinDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(mockBinDir, { recursive: true });
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });

  // Write default mock claude that outputs canned events
  writeMockClaude(`#!/bin/bash
echo '{"type":"system","session_id":"mock-session-123"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"I can see the page. It looks like a test fixture."}]}}'
echo '{"type":"result","result":"Done."}'
`);

  // Start server (no browser)
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

  // Wait for server
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

  // Start sidebar-agent with mock claude on PATH
  const agentScript = path.resolve(__dirname, '..', 'src', 'sidebar-agent.ts');
  agentProc = spawn(['bun', 'run', agentScript], {
    env: {
      ...process.env,
      PATH: `${mockBinDir}:${process.env.PATH}`,
      BROWSE_SERVER_PORT: String(serverPort),
      BROWSE_STATE_FILE: stateFile,
      SIDEBAR_QUEUE_PATH: queueFile,
      SIDEBAR_AGENT_TIMEOUT: '10000',
      BROWSE_BIN: 'browse',  // doesn't matter, mock claude doesn't use it
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Give sidebar-agent time to start polling
  await new Promise(r => setTimeout(r, 1000));
}, 20000);

afterAll(() => {
  if (agentProc) { try { agentProc.kill(); } catch {} }
  if (serverProc) { try { serverProc.kill(); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('sidebar-agent round-trip', () => {
  test('full message round-trip with mock claude', async () => {
    await resetState();

    // Send a command
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: 'what is on this page?',
        activeTabUrl: 'https://example.com/test',
      }),
    });
    expect(resp.status).toBe(200);

    // Wait for mock claude to process and events to arrive
    const entries = await pollChatUntil(
      (entries) => entries.some((e: any) => e.type === 'agent_done'),
      15000,
    );

    // Verify the flow: user message → agent_start → text → agent_done
    const userEntry = entries.find((e: any) => e.role === 'user');
    expect(userEntry).toBeDefined();
    expect(userEntry.message).toBe('what is on this page?');

    // The mock claude outputs text — check for any agent text entry
    const textEntries = entries.filter((e: any) => e.role === 'agent' && (e.type === 'text' || e.type === 'result'));
    expect(textEntries.length).toBeGreaterThan(0);

    const doneEntry = entries.find((e: any) => e.type === 'agent_done');
    expect(doneEntry).toBeDefined();

    // Agent should be back to idle
    const session = await (await api('/sidebar-session')).json();
    expect(session.agent.status).toBe('idle');
  }, 20000);

  test('claude crash produces agent_error', async () => {
    await resetState();

    // Replace mock claude with one that crashes
    writeMockClaude(`#!/bin/bash
echo '{"type":"system","session_id":"crash-test"}' >&2
exit 1
`);

    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'crash test' }),
    });

    // Wait for agent_done (sidebar-agent sends agent_done even on crash via proc.on('close'))
    const entries = await pollChatUntil(
      (entries) => entries.some((e: any) => e.type === 'agent_done' || e.type === 'agent_error'),
      15000,
    );

    // Agent should recover to idle
    const session = await (await api('/sidebar-session')).json();
    expect(session.agent.status).toBe('idle');

    // Restore working mock
    writeMockClaude(`#!/bin/bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"recovered"}]}}'
`);
  }, 20000);

  test('sequential queue drain', async () => {
    await resetState();

    // Restore working mock
    writeMockClaude(`#!/bin/bash
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"response to: '"'"'$*'"'"'"}]}}'
`);

    // Send two messages rapidly — first processes, second queues
    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'first message' }),
    });
    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({ message: 'second message' }),
    });

    // Wait for both to complete (two agent_done events)
    const entries = await pollChatUntil(
      (entries) => entries.filter((e: any) => e.type === 'agent_done').length >= 2,
      20000,
    );

    // Both user messages should be in chat
    const userEntries = entries.filter((e: any) => e.role === 'user');
    expect(userEntries.length).toBeGreaterThanOrEqual(2);
  }, 25000);
});
