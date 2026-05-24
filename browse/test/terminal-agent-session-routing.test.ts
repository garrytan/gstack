import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// v1.44 Commit 2 — terminal-agent sessionId routing + eager spawn.
//
// Live spawn tests would require a real claude binary on PATH and a Bun.serve
// listener; both are e2e-tier. These static-grep tripwires defend the load-
// bearing protocol changes:
//   - validTokens carries the sessionId binding (Map, not Set)
//   - sessionsById index exists for /internal/restart + (Commit 3) re-attach
//   - /internal/restart is scoped to one sessionId (codex T2 fix)
//   - {type:"start"} triggers spawn for eager UX after forceRestart
//   - maybeSpawnPty helper is the single entry point for both spawn paths

const AGENT_TS = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'terminal-agent.ts');

describe('terminal-agent session routing (v1.44+ Commit 2)', () => {
  test('1. validTokens is a Map binding token → sessionId', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    // Pre-Commit 2 was `Set<string>`; the Map carries the sessionId
    // binding that /internal/restart and (Commit 3) re-attach depend on.
    expect(src).toMatch(/const validTokens = new Map<string, string \| null>\(\)/);
    expect(src).not.toMatch(/const validTokens = new Set</);
  });

  test('2. sessionsById reverse index exists', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    expect(src).toMatch(/const sessionsById = new Map<string, PtySession>\(\)/);
    // Populated in open() — required so /internal/restart can find the session.
    expect(src).toMatch(/if \(sessionId\) sessionsById\.set\(sessionId, session\)/);
  });

  test('3. /internal/grant binds an optional sessionId to the token', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/internal/grant'", "url.pathname === '/internal/revoke'");
    expect(block).toContain('validTokens.set(body.token, sid)');
    expect(block).toContain('body?.sessionId');
  });

  test('4. /internal/restart is scoped to one sessionId, not dispose-all', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/internal/restart'", "// /claude-available");
    expect(block).toContain('sessionsById.get(sid)');
    expect(block).toContain('disposeSession(session)');
    expect(block).toContain('sessionsById.delete(sid)');
    // Negative: must NOT enumerate all live sessions and dispose them
    // (codex T2 caught this — pre-spec the route killed every PTY on the
    // agent, breaking multi-sidebar / pair-agent setups).
    expect(block).not.toMatch(/for\s*\(\s*const\s+\[?ws/);
  });

  test('5. WS upgrade surfaces sessionId on ws.data', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    expect(src).toContain('validTokens.get(token) ?? null');
    expect(src).toMatch(/data:\s*\{\s*cookie:\s*token,\s*sessionId\s*\}/);
  });

  test('6. eager spawn via {type:"start"} text frame', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    expect(src).toMatch(/msg\?\.type === 'start'/);
    // Both spawn paths route through the same helper for parity.
    expect(src).toContain('function maybeSpawnPty(');
    expect(src).toMatch(/maybeSpawnPty\(ws, session\)/);
  });

  test('7. close() drops sessionsById entry alongside ws cleanup', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    // Commit 3 widened the close signature to `close(ws, code, _reason)`
    // for the detach state machine. Match either shape so test is stable
    // across the rest of the long-lived-sidebar PR.
    const i = src.indexOf('close(ws');
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf('function handleTabState', i);
    const block = src.slice(i, j);
    expect(block).toContain('sessionsById.delete(session.sessionId)');
  });

  test('8. PtySession interface carries the sessionId field', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    // Whole interface — close paren is sufficient.
    const i = src.indexOf('interface PtySession {');
    expect(i).toBeGreaterThan(-1);
    const j = src.indexOf('\n}', i);
    const block = src.slice(i, j);
    expect(block).toContain('sessionId: string | null');
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
