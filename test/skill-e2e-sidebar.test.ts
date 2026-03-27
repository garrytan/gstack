/**
 * Layer 4: E2E tests for the sidebar agent.
 *
 * sidebar-url-accuracy: Deterministic test that verifies the activeTabUrl fix.
 *   Starts server (no browser), POSTs to /sidebar-command with different activeTabUrl
 *   values, reads the queue file, and verifies the prompt uses the extension URL.
 *   No real Claude needed — this is a fast, cheap, deterministic test.
 *
 * sidebar-navigate: Full E2E with real Claude (requires ANTHROPIC_API_KEY).
 *   Starts server + sidebar-agent, sends a message, waits for Claude to respond.
 *   Tests the complete message flow through the queue.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ROOT,
  describeIfSelected, testIfSelected,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';

const evalCollector = createEvalCollector('e2e-sidebar');

// --- Sidebar URL Accuracy (deterministic, no Claude) ---

describeIfSelected('Sidebar URL accuracy E2E', ['sidebar-url-accuracy'], () => {
  let serverProc: Subprocess | null = null;
  let serverPort: number = 0;
  let authToken: string = '';
  let tmpDir: string = '';
  let stateFile: string = '';
  let queueFile: string = '';

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

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-e2e-url-'));
    stateFile = path.join(tmpDir, 'browse.json');
    queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });

    const serverScript = path.resolve(ROOT, 'browse', 'src', 'server.ts');
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
    finalizeEvalCollector(evalCollector);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('sidebar-url-accuracy', async () => {
    // Fresh session
    await api('/sidebar-session/new', { method: 'POST' });
    fs.writeFileSync(queueFile, '');

    const extensionUrl = 'https://example.com/user-navigated-here';
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: 'What page am I on?',
        activeTabUrl: extensionUrl,
      }),
    });
    expect(resp.status).toBe(200);

    // Wait for queue entry
    let lastEntry: any = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      if (!fs.existsSync(queueFile)) continue;
      const lines = fs.readFileSync(queueFile, 'utf-8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        lastEntry = JSON.parse(lines[lines.length - 1]);
        break;
      }
    }

    expect(lastEntry).not.toBeNull();
    // Extension URL should be used, not the Playwright fallback
    expect(lastEntry.pageUrl).toBe(extensionUrl);
    expect(lastEntry.prompt).toContain(extensionUrl);
    expect(lastEntry.pageUrl).not.toBe('about:blank');

    // Also test: chrome:// URL should be rejected, falling back to about:blank
    await api('/sidebar-agent/kill', { method: 'POST' });
    fs.writeFileSync(queueFile, '');

    await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: 'test',
        activeTabUrl: 'chrome://settings',
      }),
    });
    await new Promise(r => setTimeout(r, 200));
    const lines2 = fs.readFileSync(queueFile, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines2.length > 0) {
      const entry2 = JSON.parse(lines2[lines2.length - 1]);
      expect(entry2.pageUrl).toBe('about:blank');
    }

    evalCollector?.addTest({
      name: 'sidebar-url-accuracy', suite: 'Sidebar URL accuracy E2E', tier: 'e2e',
      passed: true,
      duration_ms: 0,
      cost_usd: 0,
      exit_reason: 'success',
    });
  }, 30_000);
});

// --- Sidebar Navigate (real Claude, requires ANTHROPIC_API_KEY) ---

describeIfSelected('Sidebar navigate E2E', ['sidebar-navigate'], () => {
  let serverProc: Subprocess | null = null;
  let agentProc: Subprocess | null = null;
  let serverPort: number = 0;
  let authToken: string = '';
  let tmpDir: string = '';
  let stateFile: string = '';
  let queueFile: string = '';

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

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-e2e-nav-'));
    stateFile = path.join(tmpDir, 'browse.json');
    queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });

    // Start server WITHOUT headless skip — we need a real browser for Claude to use
    const serverScript = path.resolve(ROOT, 'browse', 'src', 'server.ts');
    serverProc = spawn(['bun', 'run', serverScript], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_HEADLESS_SKIP: '1',  // Still skip browser — Claude uses curl/fetch instead
        BROWSE_PORT: '0',
        SIDEBAR_QUEUE_PATH: queueFile,
        BROWSE_IDLE_TIMEOUT: '300',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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

    // Start sidebar-agent
    const agentScript = path.resolve(ROOT, 'browse', 'src', 'sidebar-agent.ts');
    agentProc = spawn(['bun', 'run', agentScript], {
      env: {
        ...process.env,
        BROWSE_SERVER_PORT: String(serverPort),
        BROWSE_STATE_FILE: stateFile,
        SIDEBAR_QUEUE_PATH: queueFile,
        SIDEBAR_AGENT_TIMEOUT: '90000',
        BROWSE_BIN: 'echo',  // browse commands won't work, but Claude can use curl
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise(r => setTimeout(r, 1500));
  }, 25000);

  afterAll(() => {
    if (agentProc) { try { agentProc.kill(); } catch {} }
    if (serverProc) { try { serverProc.kill(); } catch {} }
    finalizeEvalCollector(evalCollector);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('sidebar-navigate', async () => {
    await api('/sidebar-session/new', { method: 'POST' });
    fs.writeFileSync(queueFile, '');
    const startTime = Date.now();

    // Ask Claude a simple question — it doesn't need browse commands for this
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: 'Say exactly "SIDEBAR_TEST_OK" and nothing else.',
        activeTabUrl: 'https://example.com',
      }),
    });
    expect(resp.status).toBe(200);

    // Poll for agent_done
    const deadline = Date.now() + 90000;
    let entries: any[] = [];
    while (Date.now() < deadline) {
      const chatResp = await api('/sidebar-chat?after=0');
      const data = await chatResp.json();
      entries = data.entries;
      if (entries.some((e: any) => e.type === 'agent_done')) break;
      await new Promise(r => setTimeout(r, 2000));
    }

    const duration = Date.now() - startTime;
    const doneEntry = entries.find((e: any) => e.type === 'agent_done');
    expect(doneEntry).toBeDefined();

    // Claude should have responded with something
    const agentText = entries
      .filter((e: any) => e.role === 'agent' && (e.type === 'text' || e.type === 'result'))
      .map((e: any) => e.text || '')
      .join(' ');
    expect(agentText.length).toBeGreaterThan(0);

    evalCollector?.addTest({
      name: 'sidebar-navigate', suite: 'Sidebar navigate E2E', tier: 'e2e',
      passed: !!doneEntry && agentText.length > 0,
      duration_ms: duration,
      cost_usd: 0,
      exit_reason: doneEntry ? 'success' : 'timeout',
    });
  }, 120_000);
});
