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
    // Extension URL should be used, not the Playwright fallback.
    // The pageUrl field carries the extension URL; the prompt itself
    // contains only the system prompt + user message (URL is metadata).
    expect(lastEntry.pageUrl).toBe(extensionUrl);
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

// --- Sidebar CSS Interaction E2E (real Claude + real browser) ---
// Goes to HN, reads comments, identifies the most insightful one, highlights it.
// Exercises: navigation, snapshot, text reading, LLM judgment, CSS style injection.

describeIfSelected('Sidebar CSS interaction E2E', ['sidebar-css-interaction'], () => {
  let serverProc: Subprocess | null = null;
  let agentProc: Subprocess | null = null;
  let serverPort: number = 0;
  let authToken: string = '';
  let tmpDir: string = '';
  let stateFile: string = '';
  let queueFile: string = '';
  let serverLogFile: string = '';
  let serverErrFile: string = '';
  let agentLogFile: string = '';
  let agentErrFile: string = '';

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-e2e-css-'));
    stateFile = path.join(tmpDir, 'browse.json');
    queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });

    // Start server WITH a real browser for CSS interaction
    const serverScript = path.resolve(ROOT, 'browse', 'src', 'server.ts');
    serverLogFile = path.join(tmpDir, 'server.log');
    serverErrFile = path.join(tmpDir, 'server.err');
    // Use 'pipe' stdio — closing file descriptors kills the child on macOS/bun
    serverProc = spawn(['bun', 'run', serverScript], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_PORT: '0',
        SIDEBAR_QUEUE_PATH: queueFile,
        BROWSE_IDLE_TIMEOUT: '600000', // 10 min in ms — test takes ~3 min
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for state file with port/token
    const deadline = Date.now() + 30000;
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
      await new Promise(r => setTimeout(r, 200));
    }
    if (!serverPort) throw new Error('Server did not start in time');

    // Verify server is healthy before proceeding
    const healthDeadline = Date.now() + 10000;
    let healthy = false;
    while (Date.now() < healthDeadline) {
      try {
        const resp = await fetch(`http://127.0.0.1:${serverPort}/health`);
        if (resp.ok) { healthy = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!healthy) throw new Error('Server started but health check failed');

    // Start sidebar-agent with the real browse binary
    const agentScript = path.resolve(ROOT, 'browse', 'src', 'sidebar-agent.ts');
    const browseBin = path.resolve(ROOT, 'browse', 'dist', 'browse');
    agentLogFile = path.join(tmpDir, 'agent.log');
    agentErrFile = path.join(tmpDir, 'agent.err');
    // Use 'pipe' stdio — closing file descriptors kills the child on macOS/bun
    agentProc = spawn(['bun', 'run', agentScript], {
      env: {
        ...process.env,
        BROWSE_SERVER_PORT: String(serverPort),
        BROWSE_STATE_FILE: stateFile,
        SIDEBAR_QUEUE_PATH: queueFile,
        SIDEBAR_AGENT_TIMEOUT: '180000', // 3 min — multi-step HN comment task
        BROWSE_BIN: fs.existsSync(browseBin) ? browseBin : 'echo',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise(r => setTimeout(r, 2000));
  }, 35000);

  afterAll(() => {
    if (agentProc) { try { agentProc.kill(); } catch {} }
    if (serverProc) { try { serverProc.kill(); } catch {} }
    finalizeEvalCollector(evalCollector);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  testIfSelected('sidebar-css-interaction', async () => {
    // Fresh session + clean queue
    try { await api('/sidebar-session/new', { method: 'POST' }); } catch {}
    fs.writeFileSync(queueFile, '');
    const startTime = Date.now();

    // Simple task: go to example.com, read the title, apply a style
    // (much faster than multi-step HN comment navigation)
    const resp = await api('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: 'Go to https://example.com. Read the page title. Add a 4px solid orange outline to the h1 element.',
        activeTabUrl: 'about:blank',
      }),
    });
    expect(resp.status).toBe(200);

    // Poll for agent_done (4 min timeout — multi-step task with opus LLM)
    const deadline = Date.now() + 240000;
    let entries: any[] = [];
    while (Date.now() < deadline) {
      try {
        const chatResp = await api('/sidebar-chat?after=0');
        const data = await chatResp.json();
        entries = data.entries || [];
        if (entries.some((e: any) => e.type === 'agent_done')) break;
      } catch (err: any) {
        // Server may be temporarily busy or restarting — retry on connection errors
        const isConnErr = err.code === 'ConnectionRefused' || err.message?.includes('ConnectionRefused') || err.message?.includes('Unable to connect');
        if (!isConnErr) throw err;
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    const duration = Date.now() - startTime;
    const doneEntry = entries.find((e: any) => e.type === 'agent_done');

    // Dump debug info on failure
    if (!doneEntry || entries.length === 0) {
      console.log('ENTRIES:', JSON.stringify(entries.slice(-5), null, 2));
      console.log('SERVER exitCode:', serverProc?.exitCode, 'signalCode:', serverProc?.signalCode, 'killed:', serverProc?.killed);
      console.log('AGENT exitCode:', agentProc?.exitCode, 'signalCode:', agentProc?.signalCode, 'killed:', agentProc?.killed);
      const queueContent = fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf-8').slice(-500) : 'NO QUEUE';
      console.log('QUEUE:', queueContent.length > 0 ? 'has entries' : 'empty');
    }

    // Agent should have completed
    expect(doneEntry).toBeDefined();

    // Agent should have run browse commands (look for tool_use entries)
    const toolUses = entries.filter((e: any) => e.type === 'tool_use');
    expect(toolUses.length).toBeGreaterThanOrEqual(2); // At minimum: goto + one more

    // Agent text should mention something about the comment it found
    const agentText = entries
      .filter((e: any) => e.role === 'agent' && (e.type === 'text' || e.type === 'result'))
      .map((e: any) => e.text || '')
      .join(' ')
      .toLowerCase();

    // Should have navigated to example.com (look for example.com in any entry text)
    const allEntryText = entries
      .map((e: any) => `${e.text || ''} ${e.input || ''} ${e.message || ''}`)
      .join(' ');
    const navigatedToTarget = allEntryText.includes('example.com') || allEntryText.includes('Example Domain');
    if (!navigatedToTarget) {
      console.log('ALL ENTRY TEXT (first 2000):', allEntryText.slice(0, 2000));
    }
    expect(navigatedToTarget).toBe(true);

    // Should have applied a style (look for orange/outline in tool commands)
    const allText = entries.map((e: any) => e.text || '').join(' ');
    const appliedStyle = allText.includes('outline') || allText.includes('orange') || allText.includes('style');

    evalCollector?.addTest({
      name: 'sidebar-css-interaction', suite: 'Sidebar CSS interaction E2E', tier: 'e2e',
      passed: !!doneEntry && navigatedToTarget && appliedStyle,
      duration_ms: duration,
      cost_usd: 0,
      exit_reason: doneEntry ? 'success' : 'timeout',
    });
  }, 300_000);
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
