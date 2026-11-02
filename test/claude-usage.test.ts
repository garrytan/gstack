/**
 * The Claude Code meter (GSTA-152 plan item 3): per (message.id, requestId)
 * maxima, compaction copies, subagent and child journals, explicit session
 * binding, and the incremental reader's offset, rewrite and timing guards.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newMeterState, nonceSessions, readClaudeUsage, sessionJournals } from '../lib/claude-usage';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'claude-usage-2.1.292.json'), 'utf8'));
const S = FIXTURE.sessions as Record<string, string>;
const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); while (harnesses.length) harnesses.pop()!.cleanup(); });

function configDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
  roots.push(root);
  const project = path.join(root, 'projects', '-tmp-repo');
  fs.mkdirSync(path.join(project, S.parent!, 'subagents'), { recursive: true });
  const write = (file: string, lines: string[]) => fs.writeFileSync(file, lines.map(l => l + '\n').join(''));
  write(path.join(project, `${S.parent}.jsonl`), FIXTURE.journals.parent);
  write(path.join(project, `${S.fork}.jsonl`), FIXTURE.journals.fork);
  write(path.join(project, S.parent!, 'subagents', 'agent-a1b2c3.jsonl'), FIXTURE.journals.subagent);
  write(path.join(project, `${S.child}.jsonl`), FIXTURE.journals.child);
  write(path.join(project, `${S.decoy}.jsonl`), FIXTURE.journals.decoy);
  return root;
}

describe('claude-usage meter', () => {
  test('streaming duplicates count once at the max of each field; sidechain and subagent charges count; the last root call is known', () => {
    const state = newMeterState(configDir(), [S.parent!]);
    const r = readClaudeUsage(state);
    expect(r.total).toBe(20_071 + 550);
    expect(r.lastCall).toBe(7_362);
    expect(r.files).toBe(2);
  });

  test('a compaction fork\'s copies of earlier calls are not counted twice; a headless child adds its own calls', () => {
    const dir = configDir();
    expect(readClaudeUsage(newMeterState(dir, [S.parent!, S.fork!])).total).toBe(20_621 + 36);
    expect(readClaudeUsage(newMeterState(dir, [S.parent!, S.child!])).total).toBe(20_621 + 100);
  });

  test('binding: a session id names one journal; a nonce must match exactly one journal', () => {
    const dir = configDir();
    expect(sessionJournals(dir, S.parent!)).toHaveLength(1);
    expect(sessionJournals(dir, 'not-a-session')).toEqual([]);
    expect(nonceSessions(dir, 'nonce0abc123')).toEqual([S.parent]);
    expect(nonceSessions(dir, 'nonce-nowhere-1')).toEqual([]);
    fs.appendFileSync(path.join(dir, 'projects', '-tmp-repo', `${S.decoy}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'GSTACK_BUDGET_NONCE=nonce0abc123' } }) + '\n');
    expect(nonceSessions(dir, 'nonce0abc123').sort()).toEqual([S.parent, S.decoy].sort());
  });

  test('incremental: an append reads only new complete lines; a partial line waits; a rewrite reads from the start', () => {
    const dir = configDir();
    const file = path.join(dir, 'projects', '-tmp-repo', `${S.parent}.jsonl`);
    const state = newMeterState(dir, [S.parent!]);
    expect(readClaudeUsage(state).total).toBe(20_621);
    const extra = JSON.parse(FIXTURE.journals.child[1]);
    extra.sessionId = S.parent;
    const line = JSON.stringify(extra);
    fs.appendFileSync(file, line.slice(0, 40));
    expect(readClaudeUsage(state).total).toBe(20_621);
    fs.appendFileSync(file, line.slice(40) + '\n');
    expect(readClaudeUsage(state).total).toBe(20_721);
    expect(readClaudeUsage(state).lastCall).toBe(100);
    fs.writeFileSync(file, FIXTURE.journals.parent.slice(0, 2).map((l: string) => l + '\n').join(''));
    expect(readClaudeUsage(state).total).toBe(6_253 + 550 - 240);
  });

  test('timing guard: after a 30 MB journal is read once, a small append is read incrementally', () => {
    const dir = configDir();
    const file = path.join(dir, 'projects', '-tmp-repo', `${S.parent}.jsonl`);
    const template = JSON.parse(FIXTURE.journals.parent[3]);
    template.message.content = [{ type: 'text', text: 'x'.repeat(900) }];
    const chunks: string[] = [];
    let bytes = fs.statSync(file).size;
    for (let i = 0; bytes < 30 * 1024 * 1024; i++) {
      template.message.id = `msg_big_${i}`;
      template.requestId = `req_big_${i}`;
      const line = JSON.stringify(template) + '\n';
      chunks.push(line);
      bytes += line.length;
    }
    fs.appendFileSync(file, chunks.join(''));
    const state = newMeterState(dir, [S.parent!]);
    let t0 = performance.now();
    const first = readClaudeUsage(state);
    const full = performance.now() - t0;
    expect(first.total).toBeGreaterThan(20_621);
    fs.appendFileSync(file, chunks[0]!.replace('msg_big_0', 'msg_tail').replace('req_big_0', 'req_tail'));
    t0 = performance.now();
    const second = readClaudeUsage(state);
    const incremental = performance.now() - t0;
    expect(second.total).toBe(first.total + 6_245);
    expect(full).toBeLessThan(15_000);
    expect(incremental).toBeLessThan(Math.max(250, full / 4));
  }, 60_000);

  test('gstack-ship-budget start --meter claude binds a session and meters it', () => {
    const h = budgetHarness();
    harnesses.push(h);
    const project = path.join(h.root, 'claude', 'projects', '-tmp-repo');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${S.parent}.jsonl`), FIXTURE.journals.parent.map((l: string) => l + '\n').join(''));
    const record = h.record();
    const none = h.sb(['start', '--record', record, '--token-cap', '25M', '--meter', 'claude']);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/echo GSTACK_BUDGET_NONCE=[0-9a-f]{16} once.*\(BUDGET_METER_UNAVAILABLE\)/);
    const r = h.sb(['start', '--record', record, '--token-cap', '25M', '--nonce', 'nonce0abc123']);
    expect(r.code).toBe(0);
    expect(h.field(r.out, 'BUDGET', 'meter')).toBe('claude');
    expect(h.field(r.out, 'BUDGET', 'unit')).toBe('claude-usage-tokens');
    expect(h.field(r.out, 'BUDGET', 'call')).toBe('7362');
    expect(h.field(r.out, 'BUDGET', 'used')).toBe('0');
    const run = h.field(r.out, 'BUDGET_RUN', 'id');
    fs.appendFileSync(path.join(project, `${S.parent}.jsonl`), FIXTURE.journals.child[1].replaceAll(S.child!, S.parent!) + '\n');
    const c = h.sb(['check', '--run', run, '--step', '1', '--next', '2']);
    expect(c.code).toBe(0);
    expect(h.field(c.out, 'BUDGET', 'used')).toBe('100');
    expect(h.sb(['check', '--run', run, '--step', '2', '--next', '3', '--reading', '5']).err).toContain('(BUDGET_READING_REJECTED)');
  });
});
