import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// v1.44 terminal-agent watchdog — static-grep invariants.
//
// The watchdog respawns terminal-agent when its PID dies. Live process-tree
// tests would require spawning, killing, and observing across two real Bun
// processes — slow and flaky in the free tier. These tripwires defend the
// load-bearing properties: identity-based liveness check (not name match),
// crash-loop guard, gated on ownsTerminalAgent, and cleared on shutdown.

const SERVER_TS = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'server.ts');
const CONTROL_TS = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'terminal-agent-control.ts');

describe('terminal-agent watchdog (v1.44+)', () => {
  test('1. spawnTerminalAgent helper exists with PID return type', () => {
    const src = fs.readFileSync(CONTROL_TS, 'utf-8');
    expect(src).toMatch(/export function spawnTerminalAgent\(/);
    // Must clean up prior PID before spawning (no zombies).
    expect(src).toContain('readAgentRecord(stateDir)');
    expect(src).toContain('killAgentByRecord(prior');
    expect(src).toContain('clearAgentRecord(stateDir)');
  });

  test('2. watchdog is gated on ownsTerminalAgent', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    // Match the comment + the guard. The guard MUST be a positive check;
    // an inverted check would respawn for embedders and trample their PTY.
    const block = sliceBetween(src, '─── Terminal-Agent Watchdog', 'Factory-scoped validateAuth');
    expect(block).toMatch(/if \(ownsTerminalAgent\)/);
    expect(block).toContain('agentWatchdogInterval = setInterval');
  });

  test('3. watchdog uses PID liveness, not process name probe', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const block = sliceBetween(src, '─── Terminal-Agent Watchdog', 'Factory-scoped validateAuth');
    // The whole point of the v1.44 watchdog over v1.43- pkill teardown:
    // identity-based liveness. Slow-but-alive agents must NOT trigger
    // respawn (split-brain defense).
    expect(block).toContain('readAgentRecord(stateDir)');
    expect(block).toContain('isProcessAlive(record.pid)');
    // Negative: no executable name-based process lookup. Allow the strings
    // to appear in prose comments (the watchdog doc explains what it
    // replaces), reject only actual invocations.
    expect(block).not.toMatch(/spawnSync\s*\(\s*['"]pkill/);
    expect(block).not.toMatch(/Bun\.spawn\s*\(\s*\[\s*['"]pgrep/);
  });

  test('4. crash-loop guard with rolling window', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const block = sliceBetween(src, '─── Terminal-Agent Watchdog', 'Factory-scoped validateAuth');
    expect(block).toContain('RESPAWN_GUARD_WINDOW_MS = 60_000');
    expect(block).toContain('RESPAWN_GUARD_MAX = 3');
    expect(block).toContain('respawnHistory');
    expect(block).toContain('agentRespawnGuardTripped');
    // Window pruning: old entries must be evicted before counting toward
    // the limit. Otherwise a daemon up for a week with one crash a day
    // would eventually trip the guard.
    expect(block).toMatch(/respawnHistory\.shift\(\)/);
  });

  test('5. watchdog interval is cleared on shutdown', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    expect(src).toContain('if (agentWatchdogInterval) clearInterval(agentWatchdogInterval)');
  });

  test('6. tick interval is env-overridable for tests', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    expect(src).toContain('GSTACK_AGENT_WATCHDOG_TICK_MS');
  });

  test('7. CLI cold-start path uses the same spawnTerminalAgent helper', () => {
    const cli = fs.readFileSync(
      path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'cli.ts'),
      'utf-8',
    );
    // Otherwise the CLI and watchdog could drift on spawn env/cwd, and
    // teardown invariants tested against one would silently miss the other.
    expect(cli).toContain('spawnTerminalAgent({');
    expect(cli).toContain("from './terminal-agent-control'");
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
