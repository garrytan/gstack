/**
 * gstack-ship-budget calls (GSTA-167 calls plan, C9): count a driven /ship's parent calls from the
 * host's own transcript events, not from the agent's say-so, and split keep-alive polls from
 * decision calls; flag every gap over the 300 s prompt-cache lifetime.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { countCalls } from '../lib/ship-calls';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-ship-budget');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-calls-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const at = (s: string) => `2026-10-30T${s}.000Z`;
const exec = (t: string, calls: string[]) => ({ id: `x${t}`, source: 'tool', tool: 'execute', calls: calls.map(tool => ({ tool, durationMs: 1 })), text: '', createdAt: at(t) });
// Shapes copied from GSTA-189's transcript (tools.thread.get transcript items), times shortened.
const ITEMS = [
  { id: 'u', source: 'user', text: 'run /ship', createdAt: at('18:19:00') },
  exec('18:19:35', ['bash', 'thread_get', 'bash']),
  exec('18:23:17', ['bash']),
  { id: 'w1', source: 'tool', tool: 'wait', text: 'Waiting for preflight lanes to finish', createdAt: at('18:23:23') },
  exec('18:31:23', ['bash', 'read', 'subagent_create', 'subagent_create']),
  { id: 'w2', source: 'tool', tool: 'wait', text: 'Waiting for specialist readers to finish', createdAt: at('18:31:27') },
  exec('18:31:38', ['subagent_get', 'subagent_get']),
  exec('18:33:36', ['subagent_list', 'subagent_get', 'bash']),
  { id: 'a', source: 'assistant', text: 'Phase 3 running', createdAt: at('18:33:40') },
  { id: 'm', source: 'tool', tool: 'message_agent', text: 'GSTA-167', createdAt: at('18:40:00') },
];

describe('countCalls', () => {
  // Value: protects=acceptance counts calls from host events: each tool item is one call, a wait or a poll-only program (status reads plus at most one bash for the note) is a keep-alive, a lone bash is a decision, everything else is a decision call, and every gap over 300 s between calls is an idle gap; fails_when=user or assistant text is counted as a parent call, a poll with a note is counted as a decision, or a 6-minute gap is missed;
  //   why_new=calls were counted by hand from transcripts; seam=none; no_claim=the host's billing of a gap
  test('splits decision calls from keep-alives and flags gaps over 300 s', () => {
    const c = countCalls(ITEMS);
    expect(c).toMatchObject({ total: 8, decision: 4, keepalive: 4, idleGaps: 2, maxGapS: 480 });
    expect(c.first).toBe(at('18:19:35'));
    expect(c.last).toBe(at('18:40:00'));
  });

  test('--since and --until bound the window', () => {
    const c = countCalls(ITEMS, { since: at('18:31:00'), until: at('18:34:00') });
    expect(c).toMatchObject({ total: 4, decision: 1, keepalive: 3, idleGaps: 0 });
  });
});

describe('gstack-ship-budget calls', () => {
  test('prints one CALLS line from an events file; a missing file is a usage error', () => {
    const f = path.join(tmp, 'events.json');
    fs.writeFileSync(f, JSON.stringify({ items: ITEMS, cursor: '01M6719TXDC28B5ZS6712P5AB7' }));
    const r = spawnSync(BIN, ['calls', '--events', f], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(`CALLS: total=8 decision=4 keepalive=4 idle_gaps_over_300s=2 max_gap_s=480 first=${at('18:19:35')} last=${at('18:40:00')} source=01M6719TXDC28B5ZS6712P5AB7`);
    const missing = spawnSync(BIN, ['calls', '--events', path.join(tmp, 'nope.json')], { encoding: 'utf8', timeout: 30_000 });
    expect(missing.status).toBe(2);
  });
});
