import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// v1.44 WS keepalive — static-grep invariants for the protocol contract.
//
// terminal-agent.ts and sidepanel-terminal.js cooperate on a 25s ping/pong +
// keepalive cycle so long-idle PTY connections survive NAT idle timeouts and
// Chromium's MV3 panel suspension heuristics. The wiring is invisible to
// integration tests (you'd have to wait 25s to observe a ping) but trivially
// regressed by a refactor. These tests fail CI if either side stops sending
// or stops accepting the protocol frames.

const AGENT_TS = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'terminal-agent.ts');
const CLIENT_JS = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..', 'extension', 'sidepanel-terminal.js');

describe('terminal-agent WS keepalive (v1.44+)', () => {
  test('1. agent has a KEEPALIVE_INTERVAL_MS env knob, default 25000', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    expect(src).toContain('GSTACK_PTY_KEEPALIVE_INTERVAL_MS');
    expect(src).toMatch(/KEEPALIVE_INTERVAL_MS\s*=\s*parseInt\(/);
    // Default constant present so the env knob has a fallback.
    expect(src).toContain("'25000'");
  });

  test('2. WS open handler starts a ping interval on the session', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    // The open(ws) handler in the websocket: { ... } block must call
    // setInterval to drive the ping cadence and store the handle.
    const wsBlock = sliceBetween(src, 'websocket: {', 'function handleTabState');
    expect(wsBlock).toMatch(/open\s*\(\s*ws\s*\)/);
    expect(wsBlock).toContain('setInterval');
    expect(wsBlock).toContain("type: 'ping'");
    expect(wsBlock).toContain('pingInterval');
  });

  test('3. WS close handler clears the ping interval', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    const wsBlock = sliceBetween(src, 'websocket: {', 'function handleTabState');
    // close(ws, code?, reason?) MUST clearInterval the pingInterval —
    // otherwise we leak timers across reconnects and the ping handler
    // captures a dead ws ref. Signature widened in Commit 3 to include
    // the close code for the detach state machine, hence the loose match.
    expect(wsBlock).toMatch(/close\s*\(\s*ws/);
    expect(wsBlock).toContain('clearInterval(session.pingInterval)');
  });

  test('4. message handler accepts pong / keepalive frames silently', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    // The text-frame router must recognize the keepalive vocabulary —
    // if a future refactor strips this branch, unknown-text-frame
    // suppression would still drop them but we lose intent.
    expect(src).toMatch(/msg\?\.type === 'pong'/);
    expect(src).toMatch(/msg\?\.type === 'keepalive'/);
  });

  test('5. client sends keepalive every 25s on ws.open', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    expect(src).toContain('keepaliveInterval');
    expect(src).toMatch(/setInterval\(/);
    expect(src).toContain("type: 'keepalive'");
    expect(src).toContain('KEEPALIVE_INTERVAL_MS = 25000');
  });

  test('6. client replies pong to server ping', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    // The ws.message handler must short-circuit on msg.type === 'ping'
    // and reply with {type: 'pong', ts: msg.ts}.
    expect(src).toMatch(/msg\.type === 'ping'/);
    expect(src).toMatch(/type: 'pong'/);
  });

  test('7. client clears keepalive in close + teardown + forceRestart', () => {
    const src = fs.readFileSync(CLIENT_JS, 'utf-8');
    // Three teardown paths exist; all three must drop the interval to
    // avoid leaking timers across reconnect attempts.
    const occurrences = (src.match(/clearInterval\(keepaliveInterval\)/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
