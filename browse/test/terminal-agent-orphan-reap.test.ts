/**
 * terminal-agent orphan reaping + owner identity (2026-09 leak fix).
 *
 * Pure-function tests with injected `ps` output — no live process tree, no
 * spawning (the same "free-tier, no flaky process-tree tests" rule as
 * terminal-agent-watchdog.test.ts). The static-grep tripwires at the end
 * pin the wiring that the unit tests can't reach: the spawn env/argv, the
 * agent's owner watch, the confirmed-kill shutdown, and the CLI's ownerPid.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseAgentRows,
  reapOrphanAgents,
  killAgentAndConfirm,
  agentOwner,
  OWNER_PID_ARG,
} from '../src/terminal-agent-control';

const SCRIPT = '/x/terminal-agent.ts';
const SELF = process.pid;
const PS = [
  `   10     1 bun run ${SCRIPT} ${OWNER_PID_ARG} 100`,                    // owner 100 (dead in tests)
  `   11   200 /opt/homebrew/bin/bun run ${SCRIPT} ${OWNER_PID_ARG} 200`, // owner 200 (alive)
  `   12     1 bun run ${SCRIPT}`,                                         // legacy, reparented
  `   13   500 bun run ${SCRIPT}`,                                         // legacy, live parent
  `   14     1 bun run /x/other-script.ts ${OWNER_PID_ARG} 100`,           // other script
  `   15     1 node ${SCRIPT}`,                                            // not bun
  `   16     1 bun run ${SCRIPT}.bak`,                                     // suffix
  `   17     1 grep terminal-agent.ts`,                                    // grep itself
  `${SELF}     1 bun run ${SCRIPT} ${OWNER_PID_ARG} 100`,                  // ourselves
  ``,
].join('\n');

const srcDir = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src');
const read = (f: string) => fs.readFileSync(path.join(srcDir, f), 'utf-8');

describe('parseAgentRows', () => {
  test('1. matches only bun-run rows of the exact script path, extracting --owner-pid', () => {
    const rows = parseAgentRows(PS, SCRIPT);
    expect(rows.map((r) => r.pid)).toEqual([10, 11, 12, 13, SELF]);
    expect(rows.map((r) => r.ownerPid)).toEqual([100, 200, null, null, 100]);
    expect(rows.find((r) => r.pid === 11)!.ppid).toBe(200);
  });
});

describe('reapOrphanAgents', () => {
  const recorder = () => {
    const sent: Array<[number, string]> = [];
    return { sent, kill: (pid: number, sig: NodeJS.Signals) => { sent.push([pid, sig]); } };
  };

  test('2. reaps dead-owner and ppid-1 legacy rows; leaves live-owner and live-parent rows', () => {
    const r = recorder();
    const out = reapOrphanAgents(SCRIPT, { psOutput: PS, isAlive: (p) => p === 200, kill: r.kill, graceMs: 0 });
    expect(out.sort()).toEqual([10, 12]);
    expect(r.sent).toEqual([[10, 'SIGTERM'], [12, 'SIGTERM']]);
  });

  test('3. escalates to SIGKILL for a victim still alive after the grace period', () => {
    const r = recorder();
    const out = reapOrphanAgents(SCRIPT, { psOutput: PS, isAlive: (p) => p === 200 || p === 12, kill: r.kill, graceMs: 0 });
    expect(out.sort()).toEqual([10, 12]);
    expect(r.sent).toContainEqual([12, 'SIGKILL']);
    expect(r.sent).not.toContainEqual([10, 'SIGKILL']);
  });

  test('4. never signals the calling process', () => {
    const r = recorder();
    const out = reapOrphanAgents(SCRIPT, { psOutput: PS, isAlive: () => false, kill: r.kill, graceMs: 0 });
    expect(out).not.toContain(SELF);
    expect(r.sent.map(([p]) => p)).not.toContain(SELF);
  });

  test('5. ownerPid: reaps earlier agents of the same owner (marker) and legacy children of it', () => {
    const r = recorder();
    // Everything alive; owner 200 is about to spawn a replacement, so its
    // existing agent (11) is a duplicate. Legacy row 13 has ppid 500: a
    // caller with ownerPid 500 must reap it too (watchdog-spawned duplicate).
    // Legacy row 12 (ppid 1) is reaped by the migration rule in both cases.
    const out200 = reapOrphanAgents(SCRIPT, { psOutput: PS, isAlive: () => true, kill: r.kill, graceMs: 0, ownerPid: 200 });
    expect(out200.sort()).toEqual([11, 12]);
    const out500 = reapOrphanAgents(SCRIPT, { psOutput: PS, isAlive: () => true, kill: r.kill, graceMs: 0, ownerPid: 500 });
    expect(out500.sort()).toEqual([12, 13]);
    // And a live owner with no duplicates loses nothing but the legacy orphan.
    const out900 = reapOrphanAgents(SCRIPT, { psOutput: PS, isAlive: () => true, kill: r.kill, graceMs: 0, ownerPid: 900 });
    expect(out900).toEqual([12]);
  });
});

describe('agentOwner', () => {
  test('5b. marker owner / null for legacy / undefined for unknown pid', () => {
    expect(agentOwner(10, SCRIPT, PS)).toBe(100);
    expect(agentOwner(11, SCRIPT, PS)).toBe(200);
    expect(agentOwner(12, SCRIPT, PS)).toBeNull();
    expect(agentOwner(99999, SCRIPT, PS)).toBeUndefined();
  });
});

describe('killAgentAndConfirm', () => {
  test('6. dead PID → true immediately, no non-zero signal sent', () => {
    const orig = process.kill;
    const sent: Array<number | string> = [];
    (process as any).kill = (pid: number, sig?: any) => {
      if (sig === 0 || sig === undefined) { const e: any = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      sent.push(sig); return true;
    };
    try {
      expect(killAgentAndConfirm({ pid: 2147483646, gen: 'x', startedAt: 0 }, 100)).toBe(true);
      expect(sent).toEqual([]);
    } finally { (process as any).kill = orig; }
  });

  test('7. unkillable PID → SIGTERM then SIGKILL, waits ≥ grace, returns false', () => {
    const orig = process.kill;
    const sent: Array<number | string> = [];
    (process as any).kill = (_pid: number, sig?: any) => { if (sig !== 0 && sig !== undefined) sent.push(sig); return true; };
    const t0 = Date.now();
    try {
      expect(killAgentAndConfirm({ pid: 2147483645, gen: 'x', startedAt: 0 }, 100)).toBe(false);
    } finally { (process as any).kill = orig; }
    expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});

describe('static wiring tripwires', () => {
  test('8. spawnTerminalAgent passes owner identity in argv + env and records at spawn', () => {
    const src = read('terminal-agent-control.ts');
    expect(src).toContain('BROWSE_OWNER_PID: String(ownerPid)');
    expect(src).toContain('BROWSE_AGENT_GEN: gen');
    expect(src).toContain('OWNER_PID_ARG, String(ownerPid)');
    expect(src).toContain('writeAgentRecord(stateDir, { pid, gen, startedAt: Date.now(), ownerPid });');
    expect(src).toContain('reapOrphanAgents(script, { ownerPid })');
  });

  test('9. terminal-agent.ts watches its owner and never keys on ppid', () => {
    const src = read('terminal-agent.ts');
    expect(src).toContain('BROWSE_OWNER_PID');
    expect(src).toContain('GSTACK_TERMINAL_OWNER_WATCHDOG_MS');
    expect(src).toContain('rec.pid === process.pid');
    expect(src).not.toMatch(/process\.ppid\s*===/);
  });

  test('10. server.ts shutdown confirms the kill before unlinking the record', () => {
    const src = read('server.ts');
    expect(src).toContain('killAgentAndConfirm(record');
    expect(src).toContain('if (agentDead)');
    expect(src).toContain('lastAgentPid');
    expect(src).toContain('record.ownerPid ?? agentOwner(record.pid');
  });

  test('11. cli.ts passes the daemon PID as owner and reaps a late starter on timeout', () => {
    const src = read('cli.ts');
    expect(src).toContain('ownerPid: newState.pid');
    expect(src).toContain('ownerPid: respawned.pid');
    expect(src).toContain('reapLateStarter(');
    expect(src).toContain('BROWSE_NO_TERMINAL_AGENT');
  });
});
