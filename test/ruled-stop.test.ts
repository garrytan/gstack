/**
 * GST-2273 and GST-3005: an owner ruling could not close a finding on a round-2 full pass (docs/review-policy.md said it could),
 * and a read-only final review had no way to record an owner-accepted deferral. A stop ruling now names one open finding of one
 * recorded stop (its ledger id, the stop's head, the PR and the run that stopped), gstack-ship-receipt ruled-stop says whether the
 * owner ruled every open finding of that stop, and receipt write takes the ruled stop as a second_pass or read_only exception after
 * rerunning that check. Review-read, the loop summary and the dispatch judge still never read rulings. Row ids are the case matrix's
 * (captain drive handoffs/GSTA-608/case-matrix.md).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApprovalRow } from '../lib/approval-record';
import { placeRunEntry, runStub } from '../lib/pr-review-history';
import { ruledNotes, stopRulingRow, stopRulings, type StopRuling } from '../lib/ruled-notes';
import { ruledStop, ruledStopLines, type LedgerTrait } from '../lib/ruled-stop';
import { extractReceipt } from '../lib/ship-receipt';
import { reviewLoopExceptionLine } from '../lib/ship-receipt-depth';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fxs: ShipFx[] = [];
afterEach(() => { while (fxs.length) fxs.pop()!.cleanup(); });

const S = 'a'.repeat(40), S2 = 'b'.repeat(40), T = 'd'.repeat(40), T2 = 'e'.repeat(40);
const ID = 'p2/outside-voice#1', ID2 = 'p2/specialist#2', ID3 = 'p2/red-team#1';
const BY = 'Captain GStack Minder (GSTA-36)';
const blocker = (id: string, o: Record<string, unknown> = {}) => ({ fingerprint: 'src/x.ts:1:' + id, severity: 'CRITICAL', blocking: true, action: 'open', ledger_id: id, raised_by: 'outside-voice', ...o });
const row = (findings: Record<string, unknown>[], o: Record<string, unknown> = {}) =>
  ({ skill: 'review', via: 'ship', pass: 2, timestamp: '2026-11-18T01:00:00Z', completed: true, converged: false, dirty: false, commit_full: S, tree: T, wtree: T, review_binding: { state: 'incomplete', start_wtree: T, end_wtree: T }, findings, ...o });
const ruling = (finding: string, o: Partial<StopRuling> = {}): StopRuling => ({ finding, head: S, pr: 7, stop_run: 'r2', by: BY, reason: 'below the floor', at: '2026-11-18T02:00:00Z', approval: 'a-' + finding.replace(/\W/g, '').slice(-12).padStart(12, '0'), ...o });
const check = (o: { rows?: Record<string, unknown>[]; blockers?: string[]; traits?: LedgerTrait[]; rulings?: StopRuling[]; stop?: { head: string; tree?: string; run: string } } = {}) =>
  ruledStop({ pr: 7, run: 'r2', stop: o.stop ?? { head: S, tree: T, run: 'r2' }, rows: o.rows ?? [row([blocker(ID)])], blockers: o.blockers ?? [ID], traits: o.traits ?? [], rulings: o.rulings ?? [] });
const approval = (id: string, o: Partial<ApprovalRow> & { scope: string; ask: string }): ApprovalRow =>
  ({ id, date: '2026-11-18', recorded_at: '2026-11-18T00:00:00Z', words: 'w', by: BY, pending: 'none', outcome: 'approved', source: 'manual', branch: 'b', ...o } as ApprovalRow);

describe('which findings of the stop a ruling closes (lib/ruled-stop.ts)', () => {
  // Value: protects=GST-2273's shape: a round-2 full pass blocked on one finding, ruled by its id at the stop head, closes;
  //   fails_when=the check ignores stop rulings or matches by fingerprint; seam=ruledStop
  test('R1: the one open finding, ruled by id at the stop head for this PR and run, closes the stop', () => {
    const r = check({ rulings: [ruling(ID)] });
    expect(r).toMatchObject({ state: 'closed', findings: [{ id: ID, why: 'ruled' }], unmatched: [] });
    expect(ruledStopLines(r, 7).at(-1)).toBe('RULED_STOP: closed run=r2 head=' + S + ' tree=' + T + ' ids=' + ID);
  });
  test('R2/R3/X6: a ruling naming another id, another head, another stop run or another PR closes nothing', () => {
    for (const r of [ruling(ID2), ruling(ID, { head: S2 }), ruling(ID, { stop_run: 'r1' })]) {
      expect(check({ rulings: [r] })).toMatchObject({ state: 'open', findings: [{ id: ID, why: 'open' }], unmatched: [r] });
    }
    expect(check({ rulings: [ruling(ID, { pr: 8 })] })).toMatchObject({ state: 'open', unmatched: [] });
  });
  test('R4/H1: a gate finding never closes by ruling, whether the gate is on its row or only in its ledger line', () => {
    expect(check({ rows: [row([blocker(ID, { gate: 'test-weakening', gate_id: 'g1' })])], rulings: [ruling(ID)] }).findings).toEqual([{ id: ID, why: 'gated' }]);
    expect(check({ traits: [{ key: ID, reader: 'outside-voice', gate: 'RH-1' }], rulings: [ruling(ID)] })).toMatchObject({ state: 'open', findings: [{ id: ID, why: 'gated' }] });
  });
  test('R5: a security-class blocker never closes by ruling (decision B)', () => {
    expect(check({ rows: [row([blocker(ID, { raised_by: 'security' })])], rulings: [ruling(ID)] }).findings).toEqual([{ id: ID, why: 'security' }]);
    expect(check({ traits: [{ key: ID, reader: 'specialist-batched', category: 'security' }], rulings: [ruling(ID)] }).state).toBe('open');
  });
  test('R9: two of three open findings ruled leaves the stop open on the third', () => {
    const r = check({ rows: [row([blocker(ID), blocker(ID2), blocker(ID3)])], blockers: [], rulings: [ruling(ID), ruling(ID3)] });
    expect(r.state).toBe('open');
    expect(r.findings.map(f => [f.id, f.why])).toEqual([[ID3, 'ruled'], [ID, 'ruled'], [ID2, 'open']].sort());
    expect(ruledStopLines(r, 7).at(-1)).toStartWith('RULED_STOP: open 1 of 3');
  });
  test('R10/H4: re-logged at a later head, the stop there is new; a ruling at the old head closes nothing', () => {
    const later = check({ stop: { head: S2, tree: T2, run: 'r2' }, rows: [row([blocker(ID)]), row([blocker(ID)], { commit_full: S2, tree: T2, wtree: T2, review_binding: { state: 'incomplete', start_wtree: T2, end_wtree: T2 } })], rulings: [ruling(ID)] });
    expect(later).toMatchObject({ state: 'open', findings: [{ id: ID, why: 'open' }] });
  });
  test('R11/H5: a fingerprint closes nothing; a second finding whose fingerprint aliases the ruled id stays open', () => {
    expect(check({ rulings: [ruling('src/x.ts:1:' + ID)] }).state).toBe('open');
    const alias = check({ rows: [row([blocker(ID), blocker(ID2, { fingerprint: 'id=' + ID })])], blockers: [], rulings: [ruling(ID)] });
    expect(alias.findings.find(f => f.id === ID2)?.why).toBe('open');
  });
  test('H2/H3/S1: a read whose tree changed, on a dirty worktree or unfinished binds no ruled stop', () => {
    for (const o of [{ review_binding: { state: 'changed', start_wtree: T, end_wtree: T2 } }, { dirty: true }, { completed: false }, { wtree: T2 }]) {
      expect(check({ rows: [row([blocker(ID)], o)], rulings: [ruling(ID)] }).state).toBe('unbound');
    }
    expect(check({ rows: [row([blocker(ID)]), { ...row([]), skill: 'adversarial-review', review_binding: { state: 'changed', start_wtree: T, end_wtree: T2 } }], rulings: [ruling(ID)] }).state).toBe('unbound');
  });
  test('X6: another run\'s stop, or no stop record, binds nothing in this run', () => {
    expect(check({ stop: { head: S, tree: T, run: 'r1' }, rulings: [ruling(ID, { stop_run: 'r1' })] }).state).toBe('unbound');
    expect(ruledStop({ pr: 7, run: 'r2', rows: [row([blocker(ID)])], blockers: [], traits: [], rulings: [] }).state).toBe('unbound');
  });
  test('X12: a blocker only the ledgers hold is open, and closes only by its own id; a row that fixed it settles it', () => {
    expect(check({ rows: [row([])], blockers: [ID] })).toMatchObject({ state: 'open', findings: [{ id: ID, why: 'open' }] });
    expect(check({ rows: [row([])], blockers: [ID], rulings: [ruling(ID)] }).state).toBe('closed');
    expect(check({ rows: [row([{ ...blocker('p1/outside-voice#1'), action: 'fixed' }], { pass: 1 }), row([])], blockers: ['p1/outside-voice#1'] }).state).toBe('none');
  });
  test('X17: a stop with no open finding has nothing to rule, and a finding with no ledger id cannot be named', () => {
    expect(check({ rows: [row([{ ...blocker(ID), blocking: false, action: 'noted' }])], blockers: [] }).state).toBe('none');
    const { ledger_id: _, ...bare } = blocker(ID);
    expect(check({ rows: [row([bare])], blockers: [] }).findings[0]!.why).toBe('unnamed');
  });
});

describe('the stop ruling row (lib/ruled-notes.ts)', () => {
  test('R6/R8: gstack rulings and unapproved rows are no rulings; the newest of two for the same finding wins', () => {
    const one = approval('a-000000000001', { ...stopRulingRow(ID, S, 7, 'r2', 'first') });
    const two = approval('a-000000000002', { ...stopRulingRow(ID, S, 7, 'r2', 'second') });
    expect(stopRulings([one, two]).map(r => r.reason)).toEqual(['second']);
    expect(stopRulings([approval('a-000000000003', { ...stopRulingRow(ID, S, 7, 'r2', 'x'), by: 'gstack no-stop default (K1)' })])).toEqual([]);
    expect(stopRulings([approval('a-000000000004', { ...stopRulingRow(ID, S, 7, 'r2', 'x'), outcome: 'pending' })])).toEqual([]);
  });
  test('X23: a stop ruling is not a fix-check ruling, and a fix-check ruling is not a stop ruling', () => {
    const stopRow = approval('a-000000000005', { ...stopRulingRow(ID, S, 7, 'r2', 'x') });
    const legacy = approval('a-000000000006', { scope: 'ruled_note ' + ID + ' ' + S, ask: 'ruled_note ' + ID + ' at ' + S + ': x' });
    expect(ruledNotes([stopRow])).toEqual([]);
    expect(stopRulings([legacy])).toEqual([]);
  });
});

/** A fixture at the stop head S: run r2's round-2 review row with one open blocker, its ledger, and a body with the stop record. */
function ruledRepo(o: { priorFull?: number; passes?: number } = {}) {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
  fxs.push(f);
  const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
  const s = f.git('rev-parse', 'HEAD').stdout.trim();
  const since = new Date(Date.now() - 1000).toISOString();
  const start = run('gstack-review-log', ['--start', 'review']);
  expect(start.status, start.stderr).toBe(0);
  const logged = run('gstack-review-log', [JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), via: 'ship', pass: o.passes ?? 2, review_scope: 'frozen', completed: true, converged: false, status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [blocker(ID)] }), '--finish', start.stdout.trim()]);
  expect(logged.status, logged.stderr).toBe(0);
  const dir = path.join(f.root, 'run');
  fs.mkdirSync(path.join(dir, 'p2'), { recursive: true });
  const merged = path.join(dir, 'p2', 'merged.jsonl');
  fs.writeFileSync(merged, JSON.stringify({ id: 'outside-voice#1', reader: 'outside-voice', label: 'CRITICAL', raw: 'src/x.ts:1 the export changes a published value. Severity: Critical Blocks: yes', output_sha256: 'x' }) + '\n');
  fs.writeFileSync(path.join(dir, 'p2', 'review-ledger.jsonl'), JSON.stringify({ event: 'output', at: new Date().toISOString(), reader: 'outside-voice', ids: ['outside-voice#1'], merged }) + '\n');
  const body = path.join(f.root, 'body.md');
  const prior = o.priorFull ?? 0;
  fs.writeFileSync(body, prior ? placeRunEntry('Fixes a thing.\n', runStub({ head: 'c'.repeat(40), run: 'r1', status: 'started', loop: { passes: prior, blocking_found: 1, deferred: 0, rounds: prior } })) : 'Fixes a thing.\n');
  const stop = run('gstack-ship-receipt', ['stop', '--body', body, '--pr', '7', '--run', 'r2', '--since', since]);
  expect(stop.status, stop.stderr).toBe(0);
  const rule = (finding: string, extra: string[] = []) => run('gstack-approvals', ['rule', '--pr', '7', '--stop-run', 'r2', '--head', s, '--finding', finding, '--reason', 'the value change is intended', '--words', 'ship it as a note', '--by', BY, ...extra]);
  const ruled = () => run('gstack-ship-receipt', ['ruled-stop', '--body', body, '--pr', '7', '--run', 'r2', '--since', since, '--dir', dir]);
  const exception = (kind: 'second_pass' | 'read_only', deferred = [ID]) => ({ accepted_by: BY, date: '2026-11-18', via: 'GSTA-608', reason: 'ruled below the floor', [kind]: { head: s, deferred } });
  const write = (e: Record<string, unknown>, loop: Record<string, unknown>, extra: string[] = ['--ruled-stop']) =>
    run('gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body, '--run', 'r2', '--since', since, '--dir', dir, '--review-loop', JSON.stringify(loop), '--review-loop-exception', JSON.stringify(e), ...extra]);
  return { f, run, s, body, dir, rule, ruled, exception, write };
}
const notesOf = (stdout: string) => [...stdout.matchAll(/^RULED_NOTE: (.+)$/gm)].map(m => 'Ruled note: ' + m[1]);
const withLines = (body: string, lines: string[]) => fs.writeFileSync(body, fs.readFileSync(body, 'utf8').replace('Fixes a thing.\n', 'Fixes a thing.\n\n' + lines.join('\n') + '\n'));

describe('the ruled-stop check and the receipt that takes it (gstack-ship-receipt ruled-stop, write --ruled-stop)', () => {
  // Value: protects=GST-2273 end to end: a ruling recorded with the stop's printed command closes the stop in the run that stopped,
  //   and the receipt records the deferral only after rerunning the check; fails_when=rule writes no stop ruling, ruled-stop reads
  //   another identity, or write accepts a deferral broader than the rulings; seam=gstack-approvals rule, gstack-ship-receipt
  test('R1/D4/D3: rule the open finding, ruled-stop reads closed, and write takes exactly that deferral as second_pass', () => {
    const r = ruledRepo();
    const before = r.ruled();
    expect(before.status, before.stderr + before.stdout).toBe(3);
    expect(before.stderr).toContain('(RULED_STOP_OPEN');
    expect(before.stdout).toContain('RULED_STOP_FINDING: ' + ID + ' open');
    const rule = r.rule(ID);
    expect(rule.status, rule.stderr).toBe(0);
    const after = r.ruled();
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toContain('RULED_STOP: closed run=r2 head=' + r.s);
    const e = r.exception('second_pass');
    const loop = { passes: 2, blocking_found: 1, deferred: 0, scope: 'frozen' };
    const wide = r.write(r.exception('second_pass', [ID, 'p2/red-team#1']), loop);
    expect(wide.status).toBe(1);
    expect(wide.stderr).toContain('deferred must name exactly');
    const unlisted = r.write(e, loop);
    expect(unlisted.status).toBe(1);
    expect(unlisted.stderr).toContain('does not list "Ruled note: ' + ID);
    withLines(r.body, [notesOf(after.stdout)[0]!, reviewLoopExceptionLine(e as never)]);
    const ok = r.write(e, loop);
    expect(ok.status, ok.stderr).toBe(0);
    const rec = extractReceipt(fs.readFileSync(r.body, 'utf8')).receipt!;
    expect(rec.review_loop_exception).toMatchObject({ second_pass: { head: r.s, deferred: [ID] }, ruled: [expect.stringMatching(/^a-[0-9a-f]{12}$/)] });
    const forged = r.write({ ...e, ruled: ['a-000000000000'] }, loop);
    expect(forged.stderr).toContain('ruled is written by --ruled-stop');
  });

  // Value: protects=GST-3005: a read-only final review of a PR past its two rounds records the owner's ruled deferral, and the
  //   negative control with fewer earlier rounds is refused; fails_when=write counts this run's own pass, or takes read_only
  //   without the ruled-stop check; seam=gstack-ship-receipt write
  test('D1/D2/R12: read_only takes a ruled read-only review after two earlier full rounds, and refuses with fewer', () => {
    for (const [prior, want] of [[2, 0], [1, 1]] as const) {
      const r = ruledRepo({ priorFull: prior, passes: 1 });
      expect(r.rule(ID).status).toBe(0);
      const closed = r.ruled();
      expect(closed.status, closed.stderr).toBe(0);
      const e = r.exception('read_only');
      withLines(r.body, [notesOf(closed.stdout)[0]!, reviewLoopExceptionLine(e as never)]);
      const loop = { passes: 1, blocking_found: 1, deferred: 0, scope: 'frozen' };
      const out = r.write(e, loop);
      if (out.status !== want) throw new Error(`prior=${prior} status=${out.status}: ${out.stderr}`);
      if (want) expect(out.stderr).toContain('two full review rounds before this run');
      else expect(r.write(e, loop, []).stderr).toContain('read_only needs --ruled-stop');
    }
  });

  test('R10/R6: a head move voids the ruled stop; a ruling from inside the open run is refused', () => {
    const r = ruledRepo();
    expect(r.rule(ID).status).toBe(0);
    r.f.write({ 'src/x.ts': 'export const x = 3;\n' }); r.f.commit('a later change');
    const moved = r.ruled();
    expect(moved.status).toBe(3);
    expect(moved.stderr).toContain('a head move voids the rulings');
    fs.writeFileSync(path.join(r.f.work, '.git', 'gstack-ship-run'), 'r2\n');
    const inside = r.rule(ID2);
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain('is open on this checkout');
  });
});
