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
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attemptsOf, autoplan, journal, readRun, resultOf, review, ROOT, runPhase, SMALL_PLAN, startSmallRun } from './helpers/autoplan-run-fixture';

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
  expect(autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'claude-opus-4-7', '--attempt', ids.native]).status).toBe(0);
  const close = autoplan(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--result', resultOf(out, 'ceo', 'outside'), '--model', 'gpt-5.5', '--attempt', ids.outside]);
  expect(close.stdout).toMatch(/PHASE_CLOSED: ceo confirmed=0 unverified=1 disagree=1 new=1/);
  const eng = runPhase(out, 'eng');
  expect(eng.outside.stdout).toContain('status=gate_pending');
  return out;
}
const decisions = (out: string) => fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

/**
 * An accepted plan change is a pending amendment (B-core interlock): `next` refuses with PLAN_AMEND_PENDING and writes
 * nothing until the plan is edited and `revise --incorporates` names the decision. Returns the revise output.
 */
function incorporate(out: string, ids: string[], edit: string) {
  const before = fs.readFileSync(path.join(out, 'run.json'), 'utf8');
  const blocked = autoplan(['next', '--out', out]);
  expect(blocked.status).toBe(3);
  expect(blocked.stderr).toMatch(new RegExp(`${ids.join(',')}.*\\(PLAN_AMEND_PENDING\\)$`, 'm'));
  expect(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).toBe(before);
  const plan = path.join(path.dirname(out), 'plan.md');
  fs.writeFileSync(plan, SMALL_PLAN.replace('Tests cover', `${edit} Tests cover`));
  const revised = autoplan(['revise', '--out', out, '--plan', plan, '--incorporates', ids.join(',')]);
  expect(revised.status, revised.stderr).toBe(0);
  expect(revised.stdout).toMatch(/^AMENDMENTS: pending=none$/m);
  expect(journal(out).filter(j => j.event === 'amendment_incorporated').map(j => j.decision)).toEqual(expect.arrayContaining(ids));
  return revised;
}

describe('answer', () => {
  test('the gate lists the disagreement as an auto item and the user challenges as approval items', () => {
    const out = gatedRun('shape');
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'gate.json'), 'utf8'));
    expect(gate.gate_rev).toBe(1);
    expect(gate.items.map((i: any) => [i.id, i.kind, i.phase ?? null])).toEqual([['d1', 'auto', 'ceo'], ['uc1', 'approval', 'ceo'], ['uc2', 'approval', 'eng'], ['p1', 'approval', null]]);
    expect(gate.items[0].why).toMatch(/voices disagree: severity: native High, outside Low/);
  }, 30_000);

  test('stale, unparsed and conflicting replies write nothing; a reply that leaves approval items pending keeps the gate', () => {
    const out = gatedRun('stale');
    const before = { run: fs.readFileSync(path.join(out, 'run.json'), 'utf8'), decisions: fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8'), journal: journal(out).length };
    const stale = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '7', '--reply', 'all']);
    expect(stale.status).toBe(3);
    expect(stale.stderr).toMatch(/\(GATE_REV_STALE\)$/m);
    expect(stale.stdout).toContain('GSTACK_RESULT: skill=autoplan status=refused');
    const unparsed = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', 'd1b approve it']);
    expect(unparsed.status).toBe(1);
    expect(unparsed.stderr).toMatch(/unparsed: approve, it.*\(GATE_REPLY_UNPARSED\)$/m);
    const conflicting = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', 'd1a d1b p1a']);
    expect(conflicting.status).toBe(1);
    expect(conflicting.stderr).toMatch(/conflicts with d1a.*\(GATE_REPLY_UNPARSED\)$/m);
    const missingRev = autoplan(['answer', '--by', 'human', '--out', out, '--reply', 'all']);
    expect(missingRev.status).toBe(3);
    expect(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).toBe(before.run);
    expect(fs.readFileSync(path.join(out, 'decisions.jsonl'), 'utf8')).toBe(before.decisions);
    expect(journal(out).length).toBe(before.journal);
    // partial: only the auto item answered; approval items stay pending; nothing reviewed changes
    const partial = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', 'd1a', '--json']);
    expect(partial.status, partial.stderr).toBe(0);
    expect(JSON.parse(partial.stdout)).toMatchObject({ status: 'gate_pending', outcome: 'gate_pending', pending: ['uc1', 'uc2', 'p1'] });
    const rows = decisions(out);
    expect(rows.find((r: any) => r.label === 'D1')).toMatchObject({ status: 'approved', chosen: 'a' });
    expect(rows.filter((r: any) => r.status === 'pending').map((r: any) => r.label)).toEqual(['UC1', 'UC2', 'P1']);
  }, 30_000);

  test('`all` finalizes without another paid phase: status complete, decisions approved, no phase reopened', () => {
    const out = gatedRun('approve');
    const counter = readRun(out).attempt_counter;
    const r = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', 'all']);
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
  }, 30_000);

  test('a non-recommended choice on a ceo item is recorded without reopening; revise reopens the changed phases, archives their bound files, and the next gate is gate_rev 2', () => {
    const out = gatedRun('reopen');
    const r = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', 'all except d1b', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const runId = readRun(out).run;
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'amend_pending', outcome: 'amend_pending', reopened: [], amendments: [`${runId}-d1`] });
    expect(readRun(out).phases.ceo.closed_at).toBeTruthy();
    expect(journal(out).filter(j => j.event === 'reopened')).toEqual([]);
    // the accepted change is applied to the plan and named; revise reopens the phases that reviewed the old plan, once
    const revised = incorporate(out, [`${runId}-d1`], 'Gate reuse also checks the lockfile hash.');
    expect(revised.stdout).toMatch(/^REVISED: plan=\S+ reopened=ceo,eng$/m);
    const run = readRun(out);
    expect(run.phases.ceo).toEqual({});
    expect(run.phases.eng).toEqual({});
    expect(run.phases.design.skipped).toBeTruthy();
    expect(run.history.map((h: any) => [h.phase, h.gate_rev])).toEqual([['ceo', 1], ['eng', 1]]);
    expect(run.status).toBe('running');
    for (const f of ['ceo-native-prompt.r1.md', 'ceo-outside-prompt.r1.md', 'ceo-consensus.r1.json', 'eng-native-prompt.r1.md', 'gate.r1.json']) expect(fs.existsSync(path.join(out, f))).toBe(true);
    for (const f of ['ceo-native-prompt.md', 'eng-consensus.md', 'gate.json']) expect(fs.existsSync(path.join(out, f))).toBe(false);
    // sealed copies are attempt-owned: they stay in place and bound across the reopen
    const sealed = run.history.flatMap((h: any) => ['native', 'outside'].map(v => h.previous[v].output));
    expect(sealed.every((o: string) => /\.a\d+\.bound\.md$/.test(o) && fs.existsSync(path.join(out, o)) && run.artifacts[o])).toBe(true);
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
    const staleAgain = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', 'all']);
    expect(staleAgain.status).toBe(3);
    // closing gate_rev 2 exports a run that validates: rev-2 rows get their own ids beside rev 1's
    const approve = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '2', '--reply', 'all']);
    expect(approve.stdout).toContain('GSTACK_RESULT: skill=autoplan status=complete run=' + out);
    expect(autoplan(['export', '--out', out]).status).toBe(0);
    const ids = decisions(out).map((x: any) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(decisions(out).filter((x: any) => x.gate_rev === 2).every((x: any) => x.id.startsWith(`${readRun(out).run}-r2-`))).toBe(true);
    expect(decisions(out).find((x: any) => x.gate_rev === 1 && x.label === 'D1')!.id).toBe(`${readRun(out).run}-d1`);
    const tasks = fs.readFileSync(path.join(out, 'tasks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.blocked_by).toEqual([`${readRun(out).run}-r2-p1`]);
    const valid = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-artifact'), 'validate', path.join(out, 'run.json')], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(valid.stdout + valid.stderr).toContain('ARTIFACT_VALID: run=');
    expect(valid.status).toBe(0);
  }, 30_000);

  test('an eng-only override reopens nothing at answer; revise reruns every phase that reviewed the old plan; p1d reopens every phase; p1c keeps the gate; p1e ends incomplete', () => {
    const out = gatedRun('eng-only');
    const engOnly = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '1', '--reply', 'all except uc2b', '--json']);
    const runId = readRun(out).run;
    expect(JSON.parse(engOnly.stdout)).toMatchObject({ outcome: 'amend_pending', reopened: [], amendments: [`${runId}-uc2`] });
    expect(readRun(out).phases.ceo.closed_at).toBeTruthy();
    // the revised plan changes the hash both phases reviewed, so revise (not the answer) reruns ceo, then eng, on v2
    const revised = incorporate(out, [`${runId}-uc2`], 'Retries stop at the dead-letter queue.');
    expect(revised.stdout).toMatch(/^REVISED: plan=\S+ reopened=ceo,eng$/m);
    expect(journal(out).filter(j => j.event === 'reopened').map(j => [j.phase, j.reason ?? null])).toEqual([['ceo', expect.stringContaining('revise')], ['eng', expect.stringContaining('revise')]]);
    expect(runPhase(out, 'ceo').outside.stdout).toMatch(/PHASE_CLOSED: ceo/);
    const eng = runPhase(out, 'eng');
    expect(eng.outside.stdout).toContain('status=gate_pending');
    const interrogate = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '2', '--reply', 'all except p1c', '--json']);
    expect(JSON.parse(interrogate.stdout)).toMatchObject({ status: 'gate_pending', outcome: 'gate_pending' });
    const revise = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '2', '--reply', 'all except p1d', '--json']);
    expect(JSON.parse(revise.stdout)).toMatchObject({ outcome: 'reopened', reopened: ['ceo', 'eng'] });
    runPhase(out, 'ceo');
    runPhase(out, 'eng');
    const reject = autoplan(['answer', '--by', 'human', '--out', out, '--gate-rev', '3', '--reply', 'all except p1e']);
    expect(reject.status).toBe(0);
    expect(reject.stdout).toContain('GSTACK_RESULT: skill=autoplan status=incomplete run=' + out);
    expect(readRun(out).deviations).toContain('plan rejected by the owner at gate_rev 3');
  }, 30_000);
});
