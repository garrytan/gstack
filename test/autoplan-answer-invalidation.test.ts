/**
 * `gstack-autoplan answer` (plan B2, B9): a stale, unparsed or conflicting
 * reply writes nothing; a reply that leaves approval items pending records
 * only the auto items and keeps the gate; `all` or `p1a` with no
 * content-changing override finalizes run.json.status=complete without a new
 * paid phase; a non-recommended choice on a reviewed item reopens only the
 * affected phase plus Eng (Eng last), archives that phase's bound files and
 * bumps the gate revision at the next gate; `p1d` reopens every phase; `p1e`
 * ends incomplete. Pins decisions rows, journal events and status tokens.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attemptsOf, autoplan, journal, readRun, review, runPhase, startSmallRun } from './helpers/autoplan-run-fixture';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-answer-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A gated run with a disagreement in ceo (taste item d1) and the fixture's user challenges (uc1 ceo, uc2 eng). */
function gatedRun(name: string): string {
  const out = startSmallRun(path.join(TMP, name));
  const disagree = JSON.stringify([
    { id: 'O1', severity: 'Low', title: 'The install check lies by omission', file: 'bin/gstack-doctor', line: 12, fix: 'minor' },
    { id: 'O2', severity: 'High', title: 'Gate reuse on tree equality alone is unsound', file: 'lib/tree-receipt.ts', line: 3 },
    { id: 'O3', severity: 'Low', title: 'Docs link the quickstart page', user_challenge: true },
  ]);
  const ceoNext = autoplan(['next', '--out', out]);
  expect(ceoNext.status).toBe(0);
  review(path.join(out, 'ceo-native-prompt.md'));
  review(path.join(out, 'ceo-outside-prompt.md'), { FIXTURE_FINDINGS: disagree });
  const ids = attemptsOf(out, 'ceo');
  expect(autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', path.join(out, 'ceo-native.md'), '--model', 'claude-opus-4-7', '--attempt', ids.native]).status).toBe(0);
  const close = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--result', path.join(out, 'ceo-outside.md'), '--model', 'gpt-5.5', '--attempt', ids.outside]);
  expect(close.stdout).toMatch(/PHASE_CLOSED: ceo confirmed=1 disagree=1 new=1/);
  const eng = runPhase(out, 'eng');
  expect(eng.outside.stdout).toContain('status=gate_pending');
  return out;
}
const decisions = (out: string) => fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

describe('answer', () => {
  test('the gate lists the disagreement as an auto item and the user challenges as approval items', () => {
    const out = gatedRun('shape');
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
    expect(gate.gate_rev).toBe(1);
    expect(gate.items.map((i: any) => [i.id, i.kind, i.phase ?? null])).toEqual([['d1', 'auto', 'ceo'], ['uc1', 'approval', 'ceo'], ['uc2', 'approval', 'eng'], ['p1', 'approval', null]]);
    expect(gate.items[0].why).toMatch(/voices disagree: severity: native High, outside Low/);
  });

  test('stale, unparsed and conflicting replies write nothing; a reply that leaves approval items pending keeps the gate', () => {
    const out = gatedRun('stale');
    const before = { run: fs.readFileSync(path.join(out, 'run.json'), 'utf8'), decisions: fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8'), journal: journal(out).length };
    const stale = autoplan(['answer', '--out', out, '--gate-rev', '7', '--reply', 'all']);
    expect(stale.status).toBe(3);
    expect(stale.stderr).toMatch(/\(GATE_REV_STALE\)$/m);
    expect(stale.stdout).toContain('GSTACK_RESULT: skill=autoplan status=refused');
    const unparsed = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'd1b approve it']);
    expect(unparsed.status).toBe(1);
    expect(unparsed.stderr).toMatch(/unparsed: approve, it.*\(GATE_REPLY_UNPARSED\)$/m);
    const conflicting = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'd1a d1b p1a']);
    expect(conflicting.status).toBe(1);
    expect(conflicting.stderr).toMatch(/conflicts with d1a.*\(GATE_REPLY_UNPARSED\)$/m);
    const missingRev = autoplan(['answer', '--out', out, '--reply', 'all']);
    expect(missingRev.status).toBe(3);
    expect(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).toBe(before.run);
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before.decisions);
    expect(journal(out).length).toBe(before.journal);
    // partial: only the auto item answered; approval items stay pending; nothing reviewed changes
    const partial = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'd1a', '--json']);
    expect(partial.status, partial.stderr).toBe(0);
    expect(JSON.parse(partial.stdout)).toMatchObject({ status: 'gate_pending', outcome: 'gate_pending', pending: ['uc1', 'uc2', 'p1'] });
    const rows = decisions(out);
    expect(rows.find((r: any) => r.label === 'D1')).toMatchObject({ status: 'approved', chosen: 'a' });
    expect(rows.filter((r: any) => r.status === 'pending').map((r: any) => r.label)).toEqual(['UC1', 'UC2', 'P1']);
  });

  test('`all` finalizes without another paid phase: status complete, decisions approved, no phase reopened', () => {
    const out = gatedRun('approve');
    const counter = readRun(out).attempt_counter;
    const r = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^APPROVED: gate_rev=1 as-is$/m);
    expect(r.stdout).toContain('GSTACK_RESULT: skill=autoplan status=complete run=' + out);
    const run = readRun(out);
    expect(run.status).toBe('complete');
    expect(run.attempt_counter).toBe(counter);
    expect(decisions(out).every((d: any) => d.status === 'approved' && d.reply === 'all')).toBe(true);
    expect(journal(out).filter(j => j.event === 'reopened')).toEqual([]);
    const again = autoplan(['next', '--out', out]);
    expect(again.stdout).toContain('status=complete');
    expect(readRun(out).attempt_counter).toBe(counter);
  });

  test('a non-recommended choice on a ceo item reopens ceo and eng only, archives their bound files, and the next gate is gate_rev 2', () => {
    const out = gatedRun('reopen');
    const r = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all except d1b', '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'running', outcome: 'reopened', reopened: ['ceo', 'eng'] });
    const run = readRun(out);
    expect(run.phases.ceo).toEqual({});
    expect(run.phases.eng).toEqual({});
    expect(run.phases.design.skipped).toBeTruthy();
    expect(run.history.map((h: any) => [h.phase, h.gate_rev])).toEqual([['ceo', 1], ['eng', 1]]);
    for (const f of ['ceo-native.r1.md', 'ceo-outside.r1.md', 'ceo-consensus.r1.json', 'eng-native.r1.md', 'gate.r1.json']) expect(fs.existsSync(path.join(out, f))).toBe(true);
    for (const f of ['ceo-native.md', 'eng-consensus.md', 'gate.json']) expect(fs.existsSync(path.join(out, f))).toBe(false);
    expect(Object.keys(run.artifacts)).not.toContain('ceo-native.md');
    const d1 = decisions(out).find((d: any) => d.label === 'D1');
    expect(d1).toMatchObject({ status: 'overridden', chosen: 'b', gate_rev: 1 });
    expect(journal(out).filter(j => j.event === 'reopened').map(j => j.phase)).toEqual(['ceo', 'eng']);
    // the loop continues: ceo first, then eng, then a new gate at gate_rev 2 whose rows join the old ones
    const ceo = runPhase(out, 'ceo');
    expect(ceo.next.stdout).toMatch(/^PHASE: ceo /m);
    expect(ceo.outside.stdout).toMatch(/PHASE_CLOSED: ceo/);
    const eng = runPhase(out, 'eng');
    expect(eng.outside.stdout).toContain('status=gate_pending');
    expect(readRun(out).gate_rev).toBe(2);
    const rows = decisions(out);
    expect(rows.filter((x: any) => x.gate_rev === 1)).toHaveLength(4);
    expect(rows.filter((x: any) => x.gate_rev === 2 && x.status === 'pending').length).toBeGreaterThan(0);
    const staleAgain = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all']);
    expect(staleAgain.status).toBe(3);
  });

  test('an eng-only override reopens eng alone; p1d reopens every phase; p1c keeps the gate; p1e ends incomplete', () => {
    const out = gatedRun('eng-only');
    const engOnly = autoplan(['answer', '--out', out, '--gate-rev', '1', '--reply', 'all except uc2b', '--json']);
    expect(JSON.parse(engOnly.stdout)).toMatchObject({ outcome: 'reopened', reopened: ['eng'] });
    expect(readRun(out).phases.ceo.closed_at).toBeTruthy();
    const eng = runPhase(out, 'eng');
    expect(eng.outside.stdout).toContain('status=gate_pending');
    const interrogate = autoplan(['answer', '--out', out, '--gate-rev', '2', '--reply', 'all except p1c', '--json']);
    expect(JSON.parse(interrogate.stdout)).toMatchObject({ status: 'gate_pending', outcome: 'gate_pending' });
    const revise = autoplan(['answer', '--out', out, '--gate-rev', '2', '--reply', 'all except p1d', '--json']);
    expect(JSON.parse(revise.stdout)).toMatchObject({ outcome: 'reopened', reopened: ['ceo', 'eng'] });
    runPhase(out, 'ceo');
    runPhase(out, 'eng');
    const reject = autoplan(['answer', '--out', out, '--gate-rev', '3', '--reply', 'all except p1e']);
    expect(reject.status).toBe(0);
    expect(reject.stdout).toContain('GSTACK_RESULT: skill=autoplan status=incomplete run=' + out);
    expect(readRun(out).deviations).toContain('plan rejected by the owner at gate_rev 3');
  });
});
