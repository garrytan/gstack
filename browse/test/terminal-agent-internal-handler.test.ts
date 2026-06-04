import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Static-grep tripwire for the v1.44 internalHandler refactor.
//
// /internal/grant and /internal/revoke were copies of the same dance:
// bearer-auth → x-browse-gen check → req.json().then(...).catch(...).
// internalHandler<T>(req, fn) collapses that into a single helper call.
// This test fails CI if the helper goes away or the existing routes
// regress to inline auth + JSON parse boilerplate. Wiring tests
// (token grant/revoke behavior) already live in
// browse/test/terminal-agent-integration.test.ts.

const AGENT_TS = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'terminal-agent.ts');

describe('terminal-agent internalHandler refactor (v1.44+)', () => {
  test('1. internalHandler<T> exists with the documented signature', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    expect(src).toMatch(/async function internalHandler<T>\s*\(/);
    // Body must include the auth gate, body parse, and result coercion.
    expect(src).toContain('checkInternalAuth(req)');
    expect(src).toContain('await req.json()');
    expect(src).toContain('instanceof Response');
  });

  test('2. /internal/grant routes through internalHandler', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    // Match the route handler block.
    const block = sliceBetween(src, "url.pathname === '/internal/grant'", "url.pathname === '/internal/revoke'");
    expect(block).toContain('internalHandler(req');
    // Must NOT have the old inline pattern (would be a regression).
    expect(block).not.toContain('req.headers.get(\'authorization\')');
    expect(block).not.toContain('req.json().then(');
  });

  test('3. /internal/revoke routes through internalHandler', () => {
    const src = fs.readFileSync(AGENT_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/internal/revoke'", "url.pathname === '/internal/healthz'");
    expect(block).toContain('internalHandler(req');
    expect(block).not.toContain('req.json().then(');
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
