/**
 * GST-2968 and GHOM-1 (ghome#40): a round grant recorded at PR_ROUND_CAP could not buy the round the stop names. The read-only
 * final review already counted as a full round, so a grant raising the cap from 2 to 3 still equalled the count; and a grant
 * recorded between /ship runs was honored only when the current run had used two passes, so the next run fell back to another
 * read-only full review ($8.78 against about $3). A stop now leaves a stop record in the PR body (gstack-ship-receipt stop), and a
 * fix-check round grant that names that stop's run, head and findings buys its fix round: one scoped fix-check of the PR's own
 * change since the stop's head, in the same run or a new one, claimed once (gstack-ship-receipt claim). Row ids are the case
 * matrix's (captain drive handoffs/GSTA-608/case-matrix.md).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApprovalRow } from '../lib/approval-record';
import { grantedStop, grantMarker, placeRunEntry, prReviewHistory, runStub, stopFrom, stopMarker } from '../lib/pr-review-history';
import { nextStep } from '../lib/review-depth';
import { reviewRoundGrantRow, reviewRoundGrants } from '../lib/review-round-grant';
import { receiptRuns } from '../lib/ship-receipt';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const fxs: ShipFx[] = [];
afterEach(() => { while (fxs.length) fxs.pop()!.cleanup(); });

const S = 'a'.repeat(40), S2 = 'b'.repeat(40), H = 'c'.repeat(40), T = 'd'.repeat(40);
const loop = (passes: number, o: Record<string, number> = {}) => ({ passes, blocking_found: 1, deferred: 0, rounds: passes + (o.fix_checks ?? 0), ...o });
const row = (id: string, o: Partial<ApprovalRow> & { scope: string; ask: string }): ApprovalRow =>
  ({ id, date: '2026-11-18', recorded_at: '2026-11-18T00:00:00Z', words: 'w', by: 'Captain GStack Minder (GSTA-36)', pending: 'none', outcome: 'approved', source: 'manual', branch: 'b', ...o } as ApprovalRow);
const fixGrant = (id: string, o: { head?: string; pr?: number; run?: string; findings?: string[] } = {}) =>
  row(id, reviewRoundGrantRow(o.head ?? S, o.pr ?? 7, 'fix-check', 'the read-only review found a fixable blocker', { run: o.run ?? 'ro', findings: o.findings ?? ['p1/outside-voice#1'] }));
/** Two full rounds by run r1, then run ro's read-only review that stopped at S (its stub and its stop record). */
const stopped = () => [runStub({ head: H, run: 'r1', status: 'started', loop: loop(2) }), runStub({ head: S, run: 'ro', status: 'started', loop: loop(1) }), stopMarker({ head: S, tree: T, run: 'ro' })]
  .reduce((b, e) => placeRunEntry(b, e), '');
const anc = (pairs: Array<[string, string]>) => (a: string, d: string) => a === d || pairs.some(([x, y]) => x === a && y === d);
const ON = anc([[S, H], [H, S2], [S, S2]]);
const answer = (body: string, grants: ApprovalRow[], o: { head?: string; run?: string; pr?: number; isAncestor?: (a: string, d: string) => boolean } = {}) =>
  grantedStop(body, reviewRoundGrants(grants), { pr: o.pr ?? 7, head: o.head ?? S2, run: o.run, isAncestor: o.isAncestor ?? ON });

describe('the plan: a fix-check grant answering a stop buys its fix round (GST-2968, GHOM-1)', () => {
  // Value: protects=GHOM-1, a new run after a cross-run grant plans the fix-check, not another read-only full review; fails_when=prCapped
  //   plans read-only full because priorFull >= cap; seam=nextStep
  test('G2/G5: a new run with priorFull 3 plans one scoped fix-check, not a read-only full review', () => {
    const n = nextStep({ fullPasses: 0, last: 'none', priorFull: 3, priorRounds: 3, grantedStop: 'a-1', rangeRuntimeLines: 4 } as any);
    expect(n.step).toBe('fix-check');
    expect(n.reason).toContain('a-1');
  });
  test('G1: the run that stopped plans the fix-check once the grant is recorded', () => {
    expect(nextStep({ fullPasses: 1, last: 'full', priorFull: 2, blockingOpen: true, grantedStop: 'a-1', rangeRuntimeLines: 4 } as any).step).toBe('fix-check');
  });
  test('X15: no fix since the stop head (empty, reverted or base-only range) plans no fix-check', () => {
    const n = nextStep({ fullPasses: 0, last: 'none', priorFull: 3, grantedStop: 'a-1', rangeRuntimeLines: null } as any);
    expect(n.step).toBe('stop');
    expect(n.reason).toContain('commit the fix');
  });
  test('G19: the granted fix-check never earns another; a blocker stops with PR_ROUND_CAP, a clean read is done', () => {
    const after = { fullPasses: 0, last: 'fix-check', fixChecks: 1, priorFull: 3, grantedStop: 'a-1' } as const;
    expect(nextStep({ ...after, blockingOpen: true } as any).step).toBe('stop');
    expect(nextStep({ ...after, blockingOpen: true } as any).reason).toStartWith('PR_ROUND_CAP');
    expect(nextStep({ ...after } as any).step).toBe('done');
  });
  test('G3: an extra-round grant recorded before review keeps its fix round when the fix needs a pass on the range', () => {
    const n = nextStep({ fullPasses: 1, last: 'full', priorFull: 2, roundGrant: 'a-2', fixedBlocking: true, rangeRuntimeLines: 500 } as any, 'full');
    expect(['full', 'scoped', 'fix-check']).toContain(n.step);
  });
  test('G4 (guard): the owner\'s in-run loop grant after a round-2 full pass still plans its one fix-check', () => {
    expect(nextStep({ fullPasses: 2, last: 'full', fixedBlocking: true, granted: 'a-3' } as any).step).toBe('fix-check');
  });
});

describe('which grant answers which stop (lib/pr-review-history.ts grantedStop)', () => {
  test('G1/G2: a fix-check grant naming the newest stop\'s run, head and PR answers it', () => {
    expect(answer(stopped(), [fixGrant('a-000000000001')])).toMatchObject({ ok: true, grant: { approval: 'a-000000000001', findings: ['p1/outside-voice#1'] }, stop: { head: S, run: 'ro' } });
  });
  test('G11/X3: a grant another run claimed is spent; the claiming run itself may resume', () => {
    const body = placeRunEntry(stopped(), grantMarker({ head: S, run: 'fc1', grant: 'a-000000000001' }));
    expect((answer(body, [fixGrant('a-000000000001')]) as any).why).toContain('claimed by run fc1');
    expect(answer(body, [fixGrant('a-000000000001')], { run: 'fc1' })).toMatchObject({ ok: true });
  });
  test('G12/X5: a run voided after claiming still spent the grant', () => {
    const body = [grantMarker({ head: S, run: 'fc1', grant: 'a-000000000001' }), runStub({ head: S2, run: 'fc1', status: 'voided', loop: loop(0, { fix_checks: 1 }) })].reduce((b, e) => placeRunEntry(b, e), stopped());
    expect(answer(body, [fixGrant('a-000000000001')])).toMatchObject({ ok: false });
  });
  test('G13: a stop is stale once another run reviewed after it', () => {
    const body = placeRunEntry(stopped(), runStub({ head: S2, run: 'r3', status: 'started', loop: loop(1) }));
    expect((answer(body, [fixGrant('a-000000000001')]) as any).why).toContain('stale');
  });
  test('X6/G7: a grant naming another stop run or another head answers nothing', () => {
    expect(answer(stopped(), [fixGrant('a-000000000001', { run: 'other' })])).toMatchObject({ ok: false });
    expect(answer(stopped(), [fixGrant('a-000000000001', { head: H })])).toMatchObject({ ok: false });
  });
  test('G13b: a newer stop record makes an older stop\'s grant answer nothing', () => {
    expect(answer(placeRunEntry(stopped(), stopMarker({ head: S2, tree: T, run: 'fc1' })), [fixGrant('a-000000000001')])).toMatchObject({ ok: false });
  });
  test('G8: a head move off the stop head voids the grant', () => {
    expect((answer(stopped(), [fixGrant('a-000000000001')], { isAncestor: anc([]) }) as any).why).toContain('head move');
  });
  test('G17: a grant for another PR is not this PR\'s', () => {
    expect(answer(stopped(), [fixGrant('a-000000000001', { pr: 8 })])).toBeNull();
  });
  test('X1/G18: with no stop record a fix-check grant answers nothing, and an extra-round grant never answers a stop', () => {
    const noStop = placeRunEntry('', runStub({ head: H, run: 'r1', status: 'started', loop: loop(2) }));
    expect(answer(noStop, [fixGrant('a-000000000001')])).toMatchObject({ ok: false });
    expect(answer(stopped(), [row('a-000000000002', reviewRoundGrantRow(S, 7, 'extra-round', 'x'))])).toBeNull();
  });
  test('X2: trimming the runs block keeps stop and grant records; neither counts as a round', () => {
    let body = placeRunEntry(stopped(), grantMarker({ head: S, run: 'fc1', grant: 'a-000000000001' }));
    for (let i = 0; i < 40; i++) body = placeRunEntry(body, runStub({ head: S2, run: 'x' + i, status: 'voided', loop: loop(0) }));
    expect(receiptRuns(body).filter(r => r.mark).map(r => r.mark)).toEqual(['stop', 'grant']);
    expect(answer(body, [fixGrant('a-000000000001')])).toMatchObject({ ok: false });
    expect(prReviewHistory(stopped())).toMatchObject({ full: 3, rounds: 3, stubs: 2, heads: 2 });
  });
  test('a fix-check row that lacks its stop, or an extra-round row naming one, is no grant', () => {
    const bare = row('a-000000000004', { scope: 'review_round_grant ' + S + ' pr=7 kind=fix-check', ask: 'review_round_grant fix-check at ' + S + ' for pr 7: x' });
    const extra = row('a-000000000005', { scope: 'review_round_grant ' + S + ' pr=7 kind=extra-round stop=ro findings=f#1', ask: 'review_round_grant extra-round at ' + S + ' for pr 7: x' });
    expect(reviewRoundGrants([bare, extra])).toEqual([]);
  });
});

describe('the stop record binds only a review gstack can tie to one commit (stopFrom)', () => {
  const tree = (c: string) => (c === S ? T : undefined);
  const bound = { skill: 'review', via: 'ship', timestamp: '2026-11-18T01:00:00Z', completed: true, converged: false, commit_full: S, tree: T, wtree: T, review_binding: { state: 'incomplete', start_wtree: T, end_wtree: T } };
  const from = (rows: Record<string, unknown>[]) => stopFrom(rows, '2026-11-18T00:00:00Z', { treeOf: tree, onHead: c => c === S });
  test('X11: a completed stopped pass (incomplete because it did not converge) on a clean committed tree binds', () => {
    expect(from([bound])).toEqual({ ok: true, head: S, tree: T });
  });
  test('S1/S7/X11: a moved, dirty, unfinished or uncommitted read binds nothing', () => {
    expect(from([{ ...bound, review_binding: { state: 'changed', start_wtree: T, end_wtree: S2 } }]).ok).toBe(false);
    expect(from([{ ...bound, wtree: S2, review_binding: { state: 'incomplete', start_wtree: S2, end_wtree: S2 } }]).ok).toBe(false);
    expect(from([{ ...bound, completed: false }]).ok).toBe(false);
    expect(from([{ ...bound, commit_full: H }]).ok).toBe(false);
  });
  test('S5: a non-ship row is not the stopping review; a later fix-check row is, and must bind (#4591); an earlier run\'s row is out of range', () => {
    expect(from([bound, { ...bound, via: 'manual', commit_full: H }])).toMatchObject({ ok: true, head: S });
    expect(from([bound, { ...bound, skill: 'review-fix-check', commit_full: H }]).ok).toBe(false);
    expect(from([{ ...bound, commit_full: H }, { ...bound, skill: 'review-fix-check' }])).toMatchObject({ ok: true, head: S });
    expect(from([{ ...bound, timestamp: '2026-11-17T00:00:00Z' }]).ok).toBe(false);
  });
});

/** A fixture repository at the stop head with a PR body file, and the bins run against it. */
function stopRepo(base: Record<string, string> = {}, branch: Record<string, string> = {}) {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n', ...base }, { 'src/x.ts': 'export const x = 2;\n', ...branch });
  fxs.push(f);
  const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
  const head = () => f.git('rev-parse', 'HEAD').stdout.trim();
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, 'Fixes a thing.\n');
  return { f, run, head, body };
}
const grantId = (out: string) => /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(out)?.[1];

describe('the CLI seams', () => {
  test('G15-G18/X24: round-grant --kind fix-check records the stop run and findings at the full head; misuse is refused', () => {
    const r = stopRepo();
    const s = r.head();
    const ok = r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s.slice(0, 10), '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'p1/outside-voice#1,p1/red-team#2', '--reason', 'fixable blocker', '--by', 'Captain GStack Minder (GSTA-36)']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(r.run('gstack-approvals', ['list', '--json']).stdout).toContain('review_round_grant ' + s + ' pr=7 kind=fix-check stop=ro findings=p1/outside-voice#1,p1/red-team#2');
    expect(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--reason', 'x', '--by', 'Captain GStack Minder']).status).toBe(2);
    expect(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'extra-round', '--stop-run', 'ro', '--findings', 'f#1', '--reason', 'x', '--by', 'Captain GStack Minder']).status).toBe(2);
    expect(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'f#1', '--reason', 'x', '--by', 'gstack']).status).toBe(2);
  });

  // Value: protects=a Captain's fix-check grant can be recorded on the /ship machine while the stopped run's marker is still there,
  //   as a relay naming the Captain's message, and never as an unrelayed row inside the run; fails_when=round-grant refuses the relay
  //   (APPROVAL_RECORD_INVALID, #4531) or accepts an unrelayed grant inside an open run; why_new=#4531's fix-check grant could not be
  //   recorded; seam=gstack-approvals round-grant; no_claim=-
  test('#4531: inside an open /ship run a grant records only as a relay with --owner-ref and --words', () => {
    const r = stopRepo();
    const s = r.head();
    fs.writeFileSync(path.resolve(r.f.work, r.f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim()), 'ro\n');
    const grant = (extra: string[]) => r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'p1/red-team#2', '--reason', 'fixable blocker', '--by', 'Captain GStack Minder (GSTA-36)', ...extra]);
    const bare = grant([]);
    expect([bare.status, bare.stderr]).toEqual([2, expect.stringContaining('/ship run ro is open on this checkout')]);
    expect(grant(['--owner-ref', 'GSTA-36:2026-11-19T12:29:59Z']).status).toBe(2);
    expect(grant(['--owner-ref', 'not a ref', '--words', 'one fix-check']).status).toBe(2);
    const relayed = grant(['--owner-ref', 'GSTA-36:2026-11-19T12:29:59Z', '--words', 'one fix-check for red-team#2']);
    expect(relayed.status, relayed.stderr).toBe(0);
    expect(r.run('gstack-approvals', ['list', '--json']).stdout).toContain('relayed:GSTA-36:2026-11-19T12:29:59Z');
  });

  // Value: protects=GST-2968's own shape end to end: the read-only run stops, the stop is recorded, a fix-check grant is recorded after
  //   it, history (as preflight runs it) routes the fix-check and the plan plans it; fails_when=history prints read-only and the plan
  //   prints next=full; seam=gstack-ship-receipt stop/history/claim, gstack-review-plan
  test('G1/G2: stop, grant, history and plan route one fix-check; a second run cannot claim the same grant', () => {
    const r = stopRepo();
    const s = r.head();
    const start = r.run('gstack-review-log', ['--start', 'review']);
    expect(start.status, start.stderr).toBe(0);
    const logged = r.run('gstack-review-log', [JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), via: 'ship', pass: 1, review_scope: 'frozen', completed: true, converged: false, status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [{ fingerprint: 'src/x.ts:1:outside-voice', severity: 'CRITICAL', action: 'open', blocking: true, ledger_id: 'p1/outside-voice#1', raised_by: 'outside-voice' }] }), '--finish', start.stdout.trim()]);
    expect(logged.status, logged.stderr).toBe(0);
    fs.writeFileSync(r.body, placeRunEntry('Fixes a thing.\n', runStub({ head: H, run: 'r1', status: 'started', loop: loop(2) })));
    expect(r.run('gstack-ship-receipt', ['stub', '--body', r.body, '--run', 'ro', '--review-loop', JSON.stringify(loop(1))]).status).toBe(0);
    const stop = r.run('gstack-ship-receipt', ['stop', '--body', r.body, '--pr', '7', '--run', 'ro', '--since', '2000-01-01T00:00:00Z']);
    expect(stop.status, stop.stderr).toBe(0);
    expect(stop.stdout).toContain('STOP_RECORD: run=ro head=' + s);
    expect(stop.stdout).toContain('--kind fix-check --stop-run ro');
    const g = grantId(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'p1/outside-voice#1', '--reason', 'fixable blocker', '--by', 'Captain GStack Minder (GSTA-36)']).stdout);
    expect(g).toBeDefined();
    r.f.write({ 'src/x.ts': 'export const x = 3;\n' }); r.f.commit('fix the blocker');
    const hist = r.run('gstack-ship-receipt', ['history', '--body', r.body, '--pr', '7', '--base', 'main', '--run', 'fc1']);
    expect(hist.status, hist.stderr).toBe(0);
    expect(hist.stdout).toContain('--round-grant ' + g + ' --stop ' + s);
    expect(hist.stdout).toMatch(/^PR_REVIEW_ROUTE: fix-check /m);
    const plan = r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '3', '--prior-full', '3', '--pr', '7', '--round-grant', g!, '--stop', s]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('next=fix-check');
    expect(r.run('gstack-ship-receipt', ['claim', '--body', r.body, '--run', 'fc1', '--grant', g!]).stdout).toContain('GRANT_CLAIMED: grant=' + g);
    const twice = r.run('gstack-ship-receipt', ['claim', '--body', r.body, '--run', 'fc2', '--grant', g!]);
    expect(twice.status).toBe(3);
    expect(twice.stderr).toContain('(GRANT_SPENT)');
    expect(r.run('gstack-ship-receipt', ['history', '--body', r.body, '--pr', '7', '--base', 'main', '--run', 'fc2']).stdout).toContain('PR_REVIEW_GRANT: not applied (grant ' + g + ' was claimed by run fc1');
  });

  // Value: protects=FOUN-505, a granted stop whose fix is one string in a data .json (named by code or not) reads its fix range and plans
  //   the fix-check; fails_when=gstack-diff-scope calls the range unmatched, FIX_RANGE prints unread and the plan stops with no fix to
  //   read; seam=gstack-diff-scope, gstack-review-plan's fix range, classifyDiff's data rows
  test('a data-only fix after a granted stop is read (runtime 0) and plans the fix-check (FOUN-505)', () => {
    for (const named of [false, true]) {
      const labels = '{"label": "pass"}\n';
      const r = stopRepo({ 'data/labels.json': labels }, named ? { 'src/x.ts': "export const x = 2; // reads labels.json\n" } : {});
      const s = r.head();
      const g = grantId(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'f#1', '--reason', 'x', '--by', 'Captain GStack Minder']).stdout)!;
      r.f.write({ 'data/labels.json': '{"label": "fail"}\n' }); r.f.commit('fix the label');
      const plan = r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '3', '--prior-full', '3', '--pr', '7', '--round-grant', g, '--stop', s]);
      expect(plan.status, plan.stderr).toBe(0);
      expect(plan.stdout).not.toContain('unread');
      expect(plan.stdout).toContain('next=fix-check');
    }
  });

  test('X15/G7: the plan refuses a fix-check grant for another stop head and an extra-round grant with --stop, and plans no fix-check without a fix', () => {
    const r = stopRepo();
    const s = r.head();
    const g = grantId(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'f#1', '--reason', 'x', '--by', 'Captain GStack Minder']).stdout)!;
    const plan = (extra: string[]) => r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '3', '--prior-full', '3', '--pr', '7', '--round-grant', g, ...extra]);
    expect(plan(['--stop', s]).stdout).toContain('next=stop');
    expect(plan([]).status).toBe(3);
    r.f.write({ 'src/x.ts': 'export const x = 3;\n' }); r.f.commit('fix');
    expect(plan(['--stop', r.head()]).status).toBe(3);
    const x = grantId(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', r.head(), '--kind', 'extra-round', '--reason', 'x', '--by', 'Captain GStack Minder']).stdout)!;
    expect(r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-full', '3', '--pr', '7', '--round-grant', x, '--stop', s]).status).toBe(3);
  });

  test('S1: stop records nothing for an unbound read (STOP_UNBOUND)', () => {
    const r = stopRepo();
    const out = r.run('gstack-ship-receipt', ['stop', '--body', r.body, '--pr', '7', '--run', 'ro', '--since', '2000-01-01T00:00:00Z']);
    expect(out.status).toBe(3);
    expect(out.stderr).toContain('(STOP_UNBOUND)');
    expect(fs.readFileSync(r.body, 'utf8')).not.toContain('"mark":"stop"');
  });

  // Value: protects=a claim names a real grant, an extra-round grant is claimed once, and a fresh run at the same head plans without a
  //   grant another run spent instead of stopping on GRANT_SPENT; fails_when=claim marks an unknown id or history keeps the claimed
  //   grant in PR_REVIEW_FLAGS; seam=gstack-ship-receipt claim/history
  test('claim refuses an unknown grant; history leaves out an extra-round grant another run claimed', () => {
    const r = stopRepo();
    const unknown = r.run('gstack-ship-receipt', ['claim', '--body', r.body, '--run', 'fc1', '--grant', 'a-000000000000']);
    expect(unknown.status).toBe(3);
    expect(unknown.stderr).toContain('(GRANT_UNKNOWN)');
    const x = grantId(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', r.head(), '--kind', 'extra-round', '--reason', 'x', '--by', 'Captain GStack Minder']).stdout)!;
    const history = (run: string) => r.run('gstack-ship-receipt', ['history', '--body', r.body, '--pr', '7', '--base', 'main', '--run', run]).stdout;
    expect(history('r1')).toContain('--round-grant ' + x);
    expect(r.run('gstack-ship-receipt', ['claim', '--body', r.body, '--run', 'r1', '--grant', x]).stdout).toContain('GRANT_CLAIMED: grant=' + x + ' kind=extra-round');
    expect(history('r1')).toContain('--round-grant ' + x);
    expect(history('r2')).not.toContain('--round-grant');
    expect(history('r2')).toContain('PR_REVIEW_GRANT: not applied (grant ' + x + ' was claimed by run r1');
  });

  // Value: protects=the re-plans after a granted fix-check (post-review, targeted) keep PR_REVIEW_FLAGS' --stop with their own
  //   --range-base after the stop's head; fails_when=any --range-base other than --stop exits 2; seam=gstack-review-plan
  test('the plan takes a --range-base at or after the --stop head and refuses one before it', () => {
    const r = stopRepo();
    const s = r.head();
    const g = grantId(r.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'f#1', '--reason', 'x', '--by', 'Captain GStack Minder']).stdout)!;
    r.f.write({ 'src/x.ts': 'export const x = 3;\n' }); r.f.commit('fix');
    const fixed = r.head();
    const plan = (rangeBase: string) => r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '3', '--prior-full', '3', '--pr', '7', '--round-grant', g, '--stop', s, '--post-review', '--last', 'fix-check', '--range-base', rangeBase]);
    const after = plan(fixed);
    expect(after.status, after.stderr).toBe(0);
    expect(plan(s + '~1').status).toBe(2);
  });
});

describe('finish and the summary count a run whose only round is the granted fix-check (X14)', () => {
  // Value: protects=GHOM-1's new run reaches its receipt: finish chains the fix-check to the stop's tree under a fix-check round grant,
  //   and the summary takes a run with no full pass of its own; fails_when=finish reads only review_loop_grant rows or the summary
  //   refuses passes=0; seam=gstack-ship-release finish, gstack-review-scope summary
  test('a fresh run: fix-check from the stop head, granted by a fix-check round grant', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); });\n" });
    fxs.push(f);
    const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
    const s = f.git('rev-parse', 'HEAD').stdout.trim();
    const reviewed = run('gstack-wtree', []).stdout.trim();
    const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
    const g = run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'p1/outside-voice#1', '--reason', 'fixable blocker', '--by', 'Captain GStack Minder (GSTA-36)']);
    expect(g.status, g.stderr).toBe(0);
    f.write({ 'src/x.ts': 'export const x = 3;\n' }); f.commit('fix the read-only review blocker');
    const since = new Date(Date.now() - 1000).toISOString();
    const start = run('gstack-review-log', ['--start', 'review-fix-check']);
    expect(start.status, start.stderr).toBe(0);
    const logged = run('gstack-review-log', [JSON.stringify({ skill: 'review-fix-check', timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', range_base: s, completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] }), '--finish', start.stdout.trim()]);
    expect(logged.status, logged.stderr).toBe(0);
    const summary = run('gstack-review-scope', ['summary', '--since', since, '--no-ledger', '--json']);
    expect(summary.status, summary.stderr).toBe(0);
    expect(JSON.parse(summary.stdout)).toMatchObject({ passes: 0, fix_checks: 1 });
    const post = path.join(f.root, 'post.json');
    expect(run('gstack-docs-candidate', ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    const fin = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--reviewed-base', reviewedBase, '--lane', 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"'], { GSTACK_APPROVALS_MIRROR: '0' });
    expect(fin.stdout).toMatch(/^FIX_CHECK: reviewed .*src\/x\.ts.*grant a-[0-9a-f]{12}\)$/m);
  });
});
