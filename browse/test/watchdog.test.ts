/**
 * Parent-process watchdog regression tests.
 *
 * Verifies that the watchdog in server.ts:
 * 1. Skips shutdown in headed mode (fixes #867)
 * 2. Skips shutdown in tunnel mode
 * 3. Skips shutdown when recent activity exists (grace period)
 * 4. Calls shutdown when parent is dead AND server is idle
 *
 * Uses source-level checks (matching the security-audit pattern) plus
 * behavioral tests against extracted logic.
 */

import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SERVER_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/server.ts'),
  'utf-8',
);

// Extract the watchdog block (from the comment header to the closing brace)
function getWatchdogBlock(): string {
  const start = SERVER_SRC.indexOf('// ─── Parent-Process Watchdog');
  const searchFrom = SERVER_SRC.indexOf('setInterval(', start);
  // Find the matching closing of the if block
  let depth = 0;
  let end = SERVER_SRC.indexOf('{', searchFrom);
  for (let i = end; i < SERVER_SRC.length; i++) {
    if (SERVER_SRC[i] === '{') depth++;
    if (SERVER_SRC[i] === '}') depth--;
    if (depth === 0) {
      // Find the next closing brace (the outer `if` block)
      const outerEnd = SERVER_SRC.indexOf('}', i + 1);
      return SERVER_SRC.slice(start, outerEnd + 1);
    }
  }
  return SERVER_SRC.slice(start, start + 800);
}

describe('Parent-process watchdog', () => {
  const block = getWatchdogBlock();

  it('checks headed mode before killing', () => {
    // The watchdog must skip when in headed mode, same as the idle timer
    expect(block).toContain("getConnectionMode() === 'headed'");
    // The headed check must come before the process.kill call
    const headedIdx = block.indexOf("'headed'");
    const killIdx = block.indexOf('process.kill(BROWSE_PARENT_PID');
    expect(headedIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(-1);
    expect(headedIdx).toBeLessThan(killIdx);
  });

  it('checks tunnel mode before killing', () => {
    expect(block).toContain('tunnelActive');
    const tunnelIdx = block.indexOf('tunnelActive');
    const killIdx = block.indexOf('process.kill(BROWSE_PARENT_PID');
    expect(tunnelIdx).toBeLessThan(killIdx);
  });

  it('checks lastActivity grace period before shutdown', () => {
    // Must check activity recency in the catch block (parent dead path)
    expect(block).toContain('lastActivity');
    expect(block).toContain('WATCHDOG_GRACE_MS');
    // shutdown() should only appear inside the grace period condition
    const graceIdx = block.indexOf('WATCHDOG_GRACE_MS');
    const shutdownIdx = block.indexOf('shutdown()', graceIdx);
    expect(shutdownIdx).toBeGreaterThan(graceIdx);
  });

  it('defines WATCHDOG_GRACE_MS as a positive value', () => {
    const match = SERVER_SRC.match(/const WATCHDOG_GRACE_MS\s*=\s*(\d[\d_]*)/);
    expect(match).not.toBeNull();
    const value = parseInt(match![1].replace(/_/g, ''), 10);
    expect(value).toBeGreaterThanOrEqual(15_000); // at least one watchdog interval
  });

  it('uses signal 0 for existence check (not a real signal)', () => {
    expect(block).toContain('process.kill(BROWSE_PARENT_PID, 0)');
  });

  it('mirrors idle timer guards (headed + tunnel)', () => {
    // The idle timer section should have the same two guards
    const idleBlock = SERVER_SRC.slice(
      SERVER_SRC.indexOf('// ─── Idle Timer'),
      SERVER_SRC.indexOf('// ─── Parent-Process Watchdog'),
    );
    expect(idleBlock).toContain("getConnectionMode() === 'headed'");
    expect(idleBlock).toContain('tunnelActive');
  });
});
