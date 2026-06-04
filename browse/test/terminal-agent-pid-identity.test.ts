import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  readAgentRecord,
  writeAgentRecord,
  clearAgentRecord,
  killAgentByRecord,
  agentRecordPath,
  type AgentRecord,
} from '../src/terminal-agent-control';

// REGRESSION TEST for the v1.44 PID-identity migration.
//
// Pre-v1.44, both `cli.ts` and `server.ts` killed the terminal-agent with
// `spawnSync('pkill', ['-f', 'terminal-agent\\.ts'])`. That command matches
// by argv regex — any process whose command line contains the string
// `terminal-agent.ts` got SIGTERM'd. In practice this killed:
//
//   * sibling gstack sessions on the same host
//   * editor processes (vim, code, less) that had the file open
//   * any second gstack run on the host
//
// The v1.44 migration replaces both kill sites with identity-based PID kill
// against the record written at `<stateDir>/terminal-agent-pid` by the
// agent's own boot path. This test is the static-grep tripwire that prevents
// reintroducing the regex teardown anywhere in the source tree.
//
// Pattern mirrors browse/test/server-embedder-terminal-port.test.ts (Test 4)
// and browse/test/server-sanitize-surrogates.test.ts: read source files
// directly, assert an invariant on their contents.

const SRC_DIR = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src');

function readAllSourceFiles(): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  for (const entry of fs.readdirSync(SRC_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const full = path.join(SRC_DIR, entry);
    out.push({ file: entry, content: fs.readFileSync(full, 'utf-8') });
  }
  return out;
}

describe('terminal-agent PID identity (v1.44+)', () => {
  test('1. no source file calls `pkill -f terminal-agent`', () => {
    // The regex matches both `pkill -f terminal-agent\.ts` (escaped form
    // used in spawnSync args) and `pkill -f terminal-agent.ts` (literal),
    // since the dot is the only difference and both are footguns.
    const offenders: string[] = [];
    for (const { file, content } of readAllSourceFiles()) {
      // Walk line by line so we can skip comments that mention the historical
      // pattern (acceptable as documentation, not as code).
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/pkill/.test(line)) continue;
        if (!/terminal-agent/.test(line)) continue;
        // Skip comment lines — historical mentions in JSDoc are fine.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        offenders.push(`${file}:${i + 1}: ${trimmed}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('2. neither cli.ts nor server.ts calls spawnSync with pkill', () => {
    // Tighter check — even if someone routes through a different code path,
    // any spawnSync('pkill', ...) anywhere in src/ is the smell.
    const offenders: string[] = [];
    for (const { file, content } of readAllSourceFiles()) {
      if (/spawnSync\s*\(\s*['"]pkill['"]/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('3. readAgentRecord round-trips writeAgentRecord', () => {
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gstack-pid-id-'));
    try {
      const record: AgentRecord = {
        pid: 12345,
        gen: 'test-gen-abcdef',
        startedAt: Date.now(),
      };
      writeAgentRecord(tmpDir, record);
      const read = readAgentRecord(tmpDir);
      expect(read).toEqual(record);
      expect(fs.existsSync(agentRecordPath(tmpDir))).toBe(true);

      clearAgentRecord(tmpDir);
      expect(readAgentRecord(tmpDir)).toBeNull();
      expect(fs.existsSync(agentRecordPath(tmpDir))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('4. readAgentRecord returns null on missing or malformed file', () => {
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gstack-pid-id-'));
    try {
      // Missing.
      expect(readAgentRecord(tmpDir)).toBeNull();

      // Malformed: wrong type for pid.
      fs.writeFileSync(agentRecordPath(tmpDir), JSON.stringify({ pid: 'not-a-number', gen: 'x', startedAt: 0 }));
      expect(readAgentRecord(tmpDir)).toBeNull();

      // Malformed: not JSON.
      fs.writeFileSync(agentRecordPath(tmpDir), 'definitely not json');
      expect(readAgentRecord(tmpDir)).toBeNull();

      // Missing field.
      fs.writeFileSync(agentRecordPath(tmpDir), JSON.stringify({ pid: 1, gen: 'x' }));
      expect(readAgentRecord(tmpDir)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('5. killAgentByRecord returns false for a dead PID and never throws', () => {
    // PID 2147483646 is below Linux PID_MAX_LIMIT but way above macOS's
    // typical max — no real process will ever hold it. isProcessAlive
    // returns false; killAgentByRecord no-ops.
    const record: AgentRecord = {
      pid: 2147483646,
      gen: 'sentinel',
      startedAt: Date.now(),
    };
    const result = killAgentByRecord(record, 'SIGTERM');
    expect(result).toBe(false);
  });

  test('6. killAgentByRecord skips the kill when isProcessAlive is false', () => {
    // Guard via process.kill stub: confirm killAgentByRecord does NOT call
    // process.kill with a non-zero signal when the PID is dead. This is the
    // belt-and-suspenders defense against PID-reuse: even if isProcessAlive
    // changes implementation, killAgentByRecord must validate liveness first.
    const origKill = process.kill;
    const kills: Array<[number, NodeJS.Signals | number]> = [];
    (process as any).kill = ((pid: number, sig: NodeJS.Signals | number) => {
      kills.push([pid, sig ?? 'SIGTERM']);
      if (sig === 0) {
        const err: any = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as any;
    try {
      const record: AgentRecord = { pid: 9999999, gen: 'x', startedAt: Date.now() };
      killAgentByRecord(record, 'SIGTERM');
      const terminations = kills.filter(([, s]) => s !== 0);
      expect(terminations).toEqual([]);
    } finally {
      (process as any).kill = origKill;
    }
  });
});
