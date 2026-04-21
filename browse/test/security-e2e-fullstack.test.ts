/**
 * Full-stack E2E — the security-contract anchor test.
 *
 * Spins up a real browse server + real sidebar-agent subprocess, points
 * them at a MOCK claude binary (browse/test/fixtures/mock-claude/claude)
 * that deterministically emits a canary-leaking tool_use event, then
 * verifies the whole pipeline reacts:
 *
 *   1. Server canary-injects into the system prompt
 *   2. Server queues the message
 *   3. Sidebar-agent spawns mock-claude
 *   4. Mock-claude emits tool_use with CANARY-XXX in a URL arg
 *   5. Sidebar-agent's detectCanaryLeak fires on the stream event
 *   6. onCanaryLeaked logs, SIGTERM's mock-claude, emits security_event
 *   7. /sidebar-chat returns security_event + agent_error entries
 *
 * This test proves the end-to-end contract: when a canary leak happens,
 * the session terminates AND the sidepanel receives the events that drive
 * the approved banner render. No LLM cost, <10s total runtime.
 *
 * Fully deterministic — safe to run on every commit (gate tier).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let serverProc: Subprocess | null = null;
let agentProc: Subprocess | null = null;
let serverPort = 0;
let authToken = '';
let tmpDir = '';
let stateFile = '';
let queueFile = '';
const MOCK_CLAUDE_DIR = path.resolve(import.meta.dir, 'fixtures', 'mock-claude');

async function apiFetch(pathname: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
    ...(opts.headers as Record<string, string> | undefined),
  };
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, { ...opts, headers });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-e2e-fullstack-'));
  stateFile = path.join(tmpDir, 'browse.json');
  queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });

  const serverScript = path.resolve(import.meta.dir, '..', 'src', 'server.ts');
  const agentScript = path.resolve(import.meta.dir, '..', 'src', 'sidebar-agent.ts');

  // 1) Start the browse server.
  serverProc = spawn(['bun', 'run', serverScript], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_HEADLESS_SKIP: '1', // no Chromium for this test
      BROWSE_PORT: '0',
      SIDEBAR_QUEUE_PATH: queueFile,
      BROWSE_IDLE_TIMEOUT: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for state file with token + port
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
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!serverPort) throw new Error('Server did not start in time');

  // 2) Start the sidebar-agent with PATH prepended by the mock-claude dir.
  // sidebar-agent spawns `claude` via PATH lookup (spawn('claude', ...) — see
  // browse/src/sidebar-agent.ts spawnClaude), so prepending works without any
  // source change.
  const shimmedPath = `${MOCK_CLAUDE_DIR}:${process.env.PATH ?? ''}`;
  agentProc = spawn(['bun', 'run', agentScript], {
    env: {
      ...process.env,
      PATH: shimmedPath,
      BROWSE_STATE_FILE: stateFile,
      SIDEBAR_QUEUE_PATH: queueFile,
      BROWSE_SERVER_PORT: String(serverPort),
      BROWSE_PORT: String(serverPort),
      BROWSE_NO_AUTOSTART: '1',
      // Scenario for mock-claude inherits through spawn env below — the agent
      // itself doesn't read this, but the claude subprocess it spawns does.
      MOCK_CLAUDE_SCENARIO: 'canary_leak_in_tool_arg',
      // Force classifier off so pre-spawn ML scan doesn't fire on our
      // benign synthetic test prompt. This test exercises the canary
      // path specifically.
      GSTACK_SECURITY_OFF: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Give the agent a moment to establish its poll loop.
  await new Promise((r) => setTimeout(r, 500));
}, 30000);

async function drainStderr(proc: Subprocess | null, label: string): Promise<void> {
  if (!proc?.stderr) return;
  try {
    const reader = (proc.stderr as ReadableStream).getReader();
    // Drain briefly — don't block shutdown
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 100)
      ),
    ]);
    if (result?.value) {
      const text = new TextDecoder().decode(result.value);
      if (text.trim()) console.error(`[${label} stderr]`, text.slice(0, 2000));
    }
  } catch {}
}

afterAll(async () => {
  // Dump agent stderr for diagnostic
  await drainStderr(agentProc, 'agent');
  for (const proc of [serverProc, agentProc]) {
    if (proc) {
      try { proc.kill('SIGTERM'); } catch {}
      try { setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500); } catch {}
    }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('security pipeline E2E (mock claude)', () => {
  test('server injects canary, queues message, agent spawns mock claude', async () => {
    const resp = await apiFetch('/sidebar-command', {
      method: 'POST',
      body: JSON.stringify({
        message: "What's on this page?",
        activeTabUrl: 'https://attacker.example.com/',
      }),
    });
    expect(resp.status).toBe(200);

    // Wait for the sidebar-agent to pick up the entry and spawn mock-claude.
    // Queue entry must contain `canary` field (added by server.ts spawnClaude).
    await new Promise((r) => setTimeout(r, 250));
    const queueContent = fs.readFileSync(queueFile, 'utf-8').trim();
    const lines = queueContent.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.canary).toMatch(/^CANARY-[0-9A-F]+$/);
    expect(entry.prompt).toContain(entry.canary);
    expect(entry.prompt).toContain('NEVER include it');
  });

  test('canary leak triggers security_event + agent_error in /sidebar-chat', async () => {
    // By now the mock-claude subprocess has emitted the tool_use with the
    // leaked canary. Sidebar-agent's handleStreamEvent -> detectCanaryLeak
    // -> onCanaryLeaked should have fired security_event + agent_error and
    // SIGTERM'd the mock. Poll /sidebar-chat up to 10s for the events.
    const deadline = Date.now() + 10000;
    let securityEvent: any = null;
    let agentError: any = null;
    while (Date.now() < deadline && (!securityEvent || !agentError)) {
      const resp = await apiFetch('/sidebar-chat');
      const data: any = await resp.json();
      for (const entry of data.entries ?? []) {
        if (entry.type === 'security_event') securityEvent = entry;
        if (entry.type === 'agent_error') agentError = entry;
      }
      if (securityEvent && agentError) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(securityEvent).not.toBeNull();
    expect(securityEvent.verdict).toBe('block');
    expect(securityEvent.reason).toBe('canary_leaked');
    expect(securityEvent.layer).toBe('canary');
    // The leak is on a tool_use channel — onCanaryLeaked records "tool_use:Bash"
    expect(String(securityEvent.channel)).toContain('tool_use');
    expect(securityEvent.domain).toBe('attacker.example.com');

    expect(agentError).not.toBeNull();
    expect(agentError.error).toContain('Session terminated');
    expect(agentError.error).toContain('prompt injection detected');
  }, 15000);

  test('attempts.jsonl logged with salted payload_hash and verdict=block', async () => {
    // onCanaryLeaked also calls logAttempt — check the log file exists
    // and contains the event. The file lives at ~/.gstack/security/attempts.jsonl.
    const logPath = path.join(os.homedir(), '.gstack', 'security', 'attempts.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8');
    const recent = content.split('\n').filter(Boolean).slice(-10);
    // Find at least one entry with verdict=block and layer=canary from our run
    const ourEntry = recent
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((e) => e && e.layer === 'canary' && e.verdict === 'block' && e.urlDomain === 'attacker.example.com');
    expect(ourEntry).toBeTruthy();
    // payload_hash is a 64-char sha256 hex
    expect(String(ourEntry.payloadHash)).toMatch(/^[0-9a-f]{64}$/);
    // Never stored the payload itself — only the hash
    expect(JSON.stringify(ourEntry)).not.toContain('CANARY-');
  });
});
