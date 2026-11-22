/**
 * GST-3546: one grant path to a receipt after a Captain rules at the round cap. Before, three crews had no route that ended in a
 * receipt (gbrain #10068, gskills #23-#25, gstack #4712): an owner's review_loop_grant row was planned but claim refused it
 * (GRANT_UNKNOWN) and write refused RECEIPT_BLOCKER_OPEN until per-finding rule rows were written; a stop the tools could not bind
 * (STOP_UNBOUND) or a post-review docs edit had no grant at all; a malformed fix-check row (converged:false, a hand-built partial
 * packet) spent the grant; a verbatim owner reason overflowed round-grant's 300-character ask; and an ended /ship run held gstack
 * upgrades on its machine for an hour. Fixtures are synthetic; each case follows its report's shape.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApprovalRow } from '../lib/approval-record';
import { bindFixCheckRow, grantSpent } from '../lib/fix-check-clearing';
import { readReviewRoundGrants, reviewRoundGrantRow, reviewRoundGrants } from '../lib/review-round-grant';
import { liveRun } from '../lib/ship-run-live';
import { abandonRefusal, readRunRecord, thisRunOwner, type RunOwner } from '../lib/ship-run-record';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fxs: ShipFx[] = [];
const kids: ChildProcess[] = [];
const tmps: string[] = [];
afterEach(() => {
  while (fxs.length) fxs.pop()!.cleanup();
  for (const k of kids.splice(0)) k.kill('SIGKILL');
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ID = 'p1/outside-voice#1', FP = 'src/x.ts:1:outside-voice';
const ID2 = 'p1/red-team#2', FP2 = 'src/x.ts:1:red-team';
const CAPTAIN = 'Captain GStack Minder (GSTA-36)';
const TEST = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); });\n";
const open = (ledger_id: string, fingerprint: string) => ({ fingerprint, severity: 'CRITICAL', action: 'open', blocking: true, ledger_id, raised_by: 'outside-voice' });
const CLEAN = { completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] };
const ok = (r: { status: number | null; stderr: string; stdout: string }) => { expect(r.status, r.stderr + r.stdout).toBe(0); return r.stdout; };
const headOf = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const marker = (f: ShipFx, run: string) => fs.writeFileSync(path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim()), run + '\n');
const grantId = (out: string) => /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(out)?.[1] ?? '';

interface Cap { f: ShipFx; run: (bin: string, args: string[]) => ReturnType<ShipFx['run']>; S: string; body: string; since: string }

/** Round 2 stops at S with the given blockers open, and the run records no stop (gskills#23's STOP_UNBOUND, #4712's flow). */
function atCap(blockers: Record<string, unknown>[]): Cap {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST });
  fxs.push(f);
  const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, 'Fixes a thing.\n');
  const since = new Date(Date.now() - 1000).toISOString();
  marker(f, 'r2');
  const start = ok(run('gstack-review-log', ['--start', 'review'])).trim();
  ok(run('gstack-review-log', [JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', pass: 2, ...(blockers.length ? { completed: true, converged: false, status: 'issues_found', issues_found: blockers.length, critical: blockers.length, informational: 0, findings: blockers } : CLEAN) }), '--finish', start]));
  return { f, run, S: headOf(f), body, since };
}

/** The fix commit, the claim, and one fix-check reader through the logger with the fix list given; gstack builds the hunks. */
function fixCheck(c: Cap, o: { grant: string; run: string; fixList: string; row?: Record<string, unknown>; files?: Record<string, string>; claim?: boolean }) {
  if (o.files) { c.f.write(o.files); c.f.commit('fix'); }
  if (o.claim !== false) ok(c.run('gstack-ship-receipt', ['claim', '--body', c.body, '--pr', '7', '--run', o.run, '--grant', o.grant]));
  const start = ok(c.run('gstack-review-log', ['--start', 'review-fix-check'])).trim();
  const files = Object.entries({ fixes: o.fixList, tests: '3 pass\n' }).map(([k, v]) => { const p = path.join(c.f.root, k + '.txt'); fs.writeFileSync(p, v); return p; });
  const prompt = c.run('gstack-review-plan', ['--fix-check-prompt', '--fix-list', files[0]!, '--tests', files[1]!]);
  ok(prompt);
  ok(c.run('gstack-review-log', [JSON.stringify({ skill: 'review-fix-check', timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', ...CLEAN, ...o.row }), '--finish', start]));
  return prompt;
}

/** A fix-check read logged with no claim (the gstack-review-plan --grant path): no claim stamps it, so it names no grant. */
function unclaimedFixCheck(c: Cap, row: Record<string, unknown> = {}) {
  c.f.write({ 'src/x.ts': 'export const x = 3;\n' }); c.f.commit('fix');
  const start = ok(c.run('gstack-review-log', ['--start', 'review-fix-check'])).trim();
  ok(c.run('gstack-review-log', [JSON.stringify({ skill: 'review-fix-check', timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', ...CLEAN, ...row }), '--finish', start]));
}

function write(c: Cap, run: string) {
  const loop = path.join(c.f.root, 'loop.json');
  ok(c.run('gstack-review-scope', ['summary', '--since', c.since, '--no-ledger', '--out', loop]));
  return c.run('gstack-ship-receipt', ['write', '--pr', '7', '--run', run, '--base', 'main', '--session-kind', 'unattended', '--review-loop', '@' + loop, '--body', c.body]);
}
const rows = (c: Cap) => c.run('gstack-review-read', []).stdout.split('\n---CONFIG---')[0]!.split('\n').flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v] : []; } catch { return []; } });
const grantsOf = (c: Cap) => readReviewRoundGrants(c.f.work, { ...process.env, GSTACK_STATE_ROOT: c.f.state, GSTACK_HOME: c.f.state });

describe('one grant kind: planner, claim and receipt accept either row (GST-3546, #4712)', () => {
  const row = (o: Partial<ApprovalRow>): ApprovalRow => ({ schema_version: 1, id: 'a-000000000009', date: '2026-11-22', recorded_at: '2026-11-22T00:00:00Z', words: 'do it', by: CAPTAIN, pending: 'none', outcome: 'approved', source: 'manual', branch: 'b', ask: '', scope: '', ...o });
  // Value: protects=an owner's review_loop_grant row is the same fix-check grant claim and write read; fails_when=it parses as
  //   nothing (GRANT_UNKNOWN), or a ruling row that only mentions one becomes a grant; seam=reviewRoundGrants
  test('a review_loop_grant row reads as a fix-check grant naming its head and no PR; other rows that mention one do not', () => {
    const S = 'a'.repeat(40);
    expect(reviewRoundGrants([row({ ask: `Owner grant: one scoped fix-check (review_loop_grant ${S})`, scope: 'this /ship invocation' })]))
      .toEqual([expect.objectContaining({ kind: 'fix-check', head: S, pr: 0, legacy: true, findings: [] })]);
    expect(reviewRoundGrants([row({ ask: 'grant (review_loop_grant abcdef1)', scope: 'x' })], s => (s === 'abcdef1' ? S : undefined))[0]?.head).toBe(S);
    expect(reviewRoundGrants([row({ ask: 'grant (review_loop_grant abcdef1)', scope: 'x' })])).toEqual([]);
    expect(reviewRoundGrants([row({ ask: `ruled_note x at ${S}: fixed after review_loop_grant ${S}`, scope: `ruled_note x ${S}` })])).toEqual([]);
  });

  // Value: protects=#4712: the planner-accepted review_loop_grant also claims, stamps the fix-check and closes the blocker its
  //   reader was given, with no per-finding rule rows; fails_when=claim prints GRANT_UNKNOWN or write RECEIPT_BLOCKER_OPEN;
  //   seam=gstack-ship-receipt claim and write
  test('#4712: a review_loop_grant row claims, and its clean fix-check closes the blocker at write', () => {
    const c = atCap([open(ID, FP)]);
    const args = ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${c.S})`, '--words', 'do it', '--by', CAPTAIN, '--scope', 'this /ship invocation', '--json'];
    const self = c.run('gstack-approvals', args);
    expect([self.status, self.stderr]).toEqual([2, expect.stringContaining('never the run\'s own')]);
    for (const spelling of [['--ask', `grant (review_loop_grant: ${c.S})`], ['--scope', 'review_loop_exception x', '--ask', `grant (review_loop_grant ${c.S})`]]) {
      const r = c.run('gstack-approvals', ['add', ...spelling, '--words', 'do it', '--by', CAPTAIN, '--json']);
      expect([r.status, r.stderr]).toEqual([2, expect.stringContaining('never the run\'s own')]);
    }
    const id = JSON.parse(ok(c.run('gstack-approvals', [...args, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z']))).added[0] as string;
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', files: { 'src/x.ts': 'export const x = 3;\n' } });
    const row = rows(c).filter(r => r.skill === 'review-fix-check').at(-1)!;
    expect(row).toMatchObject({ fix_check_base: c.S, grant: id, pr: 7 });
    expect(bindFixCheckRow(c.f.work, row, grantsOf(c))).toMatchObject({ ok: true });
    const w = write(c, 'r2');
    expect(w.status, w.stderr).toBe(0);
    expect(w.stderr).toContain(`FIX_CHECK_CLEAR: grant=${id} run=r2 closed=${ID}`);
  });

  // Value: protects=GST-3546: gstack-review-plan --grant takes a round-grant fix-check row too, at the head it names;
  //   fails_when=--grant refuses it ("no approved row ... naming review_loop_grant"); seam=gstack-review-plan --grant
  test('the planner plans the fix-check for a round-grant fix-check row', () => {
    const c = atCap([open(ID, FP)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'Captain ruled: fix it', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix it'])));
    const plan = c.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--pass', '2', '--last', 'full', '--fixed-blocking', '--range-base', c.S, '--grant', id]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toContain(`NEXT: fix-check (the owner's grant ${id}`);
  });
});

describe('a ruling at the cap ends in a receipt (gskills#23, GST-3546)', () => {
  // Value: protects=gskills#23: after STOP_UNBOUND the Captain's grant with no stop, a claim and one clean scoped fix-check close
  //   the blockers its reader was given, with no hand-written per-finding rows; fails_when=write refuses RECEIPT_BLOCKER_OPEN;
  //   seam=gstack-approvals round-grant, gstack-ship-receipt claim and write
  test('a no-stop fix-check grant closes the blockers the clean fix-check read', () => {
    const c = atCap([open(ID, FP), open(ID2, FP2)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'Captain ruled both blockers fixable', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix both'])));
    fixCheck(c, { grant: id, run: 'r2', fixList: `fix ${ID}\nfix ${ID2}\n`, files: { 'src/x.ts': 'export const x = 3;\n' } });
    const w = write(c, 'r2');
    expect(w.status, w.stderr).toBe(0);
    expect(w.stderr).toContain(`FIX_CHECK_CLEAR: grant=${id} run=r2 closed=${ID},${ID2}`);
  });

  // Value: protects=the floor: a blocker neither a ruling nor the clean fix-check covers still refuses; fails_when=write closes a
  //   blocker the reader was never given; seam=gstack-ship-receipt write
  test('a blocker the fix list left out still refuses RECEIPT_BLOCKER_OPEN', () => {
    const c = atCap([open(ID, FP), open(ID2, FP2)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'fix one', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix one'])));
    fixCheck(c, { grant: id, run: 'r2', fixList: `fix ${ID}\n`, files: { 'src/x.ts': 'export const x = 3;\n' } });
    const w = write(c, 'r2');
    expect(w.status).toBe(3);
    expect(w.stderr).toContain('RECEIPT_BLOCKER_OPEN');
    expect(w.stderr).toContain(ID2);
  });
});

describe('a grant spends only on a counted fix-check (gskills#24, gskills#25)', () => {
  // Value: protects=gskills#25: a converged:false row leaves the grant unspent, the run logs a correct row and write closes;
  //   fails_when=grantSpent counts the malformed row, or write refuses on two stamped rows; seam=grantSpent, clearByGrant
  test('a malformed row spends nothing, and a correct row on the same grant closes the blocker', () => {
    const c = atCap([open(ID, FP)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'fix it', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix it'])));
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', files: { 'src/x.ts': 'export const x = 3;\n' }, row: { converged: false } });
    const bind = (r: Record<string, any>) => bindFixCheckRow(c.f.work, r, grantsOf(c)).ok;
    const g = grantsOf(c).find(x => x.approval === id)!;
    expect(grantSpent(rows(c), g, bind)).toBe(false);
    expect(write(c, 'r2').status).toBe(3);
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', claim: false });
    expect(grantSpent(rows(c), g, bind)).toBe(true);
    const w = write(c, 'r2');
    expect(w.status, w.stderr).toBe(0);
    expect(w.stderr).toContain(`closed=${ID}`);
  });

  // Value: protects=R51's one fix round: a counted read that found issues spends the grant, so a later clean row on it closes
  //   nothing; fails_when=a second fix-check under one grant clears the blockers; seam=grantSpent, clearByGrant
  test('a counted read that found issues spends the grant; a later clean row closes nothing', () => {
    const c = atCap([open(ID, FP)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'fix it', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix it'])));
    const found = { status: 'issues_found', issues_found: 1, critical: 0, informational: 1, findings: [{ fingerprint: 'src/x.ts:1:style', severity: 'INFORMATIONAL', action: 'open' }] };
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', files: { 'src/x.ts': 'export const x = 3;\n' }, row: found });
    const g = grantsOf(c).find(x => x.approval === id)!;
    expect(grantSpent(rows(c), g, r => bindFixCheckRow(c.f.work, r, grantsOf(c), { open: true }).ok)).toBe(true);
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', claim: false });
    const w = write(c, 'r2');
    expect(w.status).toBe(3);
    expect(w.stderr).toContain('the one counted read the grant bought');
  });

  // Value: protects=a later clean row recording the same findings as fixed never replaces the first read in the receipt's dedup,
  //   and a read that leaves a collected dispatch-ledger id open still counts as the grant's read; fails_when=dedup keeps the last
  //   copy, or open:true still demands every ledger id disposed; seam=clearByGrant, bindFixCheckRow
  test('the first copy of a repeated row stays the grant\'s read, and an open ledger id still counts it', () => {
    const c = atCap([open(ID, FP)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'fix it', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix it'])));
    const finding = (action: string) => ({ fingerprint: 'src/x.ts:1:style', severity: 'INFORMATIONAL', action, ledger_id: 'fc/fix-check#1' });
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', files: { 'src/x.ts': 'export const x = 3;\n' }, row: { status: 'issues_found', issues_found: 1, informational: 1, findings: [finding('open')] } });
    const first = rows(c).filter(r => r.skill === 'review-fix-check').at(-1)!;
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', claim: false, row: { findings: [finding('fixed')] } });
    const w = write(c, 'r2');
    expect(w.status).toBe(3);
    expect(w.stderr).toContain('the one counted read the grant bought');
    const ledger = path.join(c.f.root, 'fc', 'review-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, JSON.stringify({ event: 'output', reader: 'fix-check', ids: ['fix-check#1'], tree_ok: true, at: new Date().toISOString() }) + '\n');
    const withLedger = { ...first, hunks: { ...first.hunks, ledger } };
    expect(bindFixCheckRow(c.f.work, withLedger, grantsOf(c), { open: true })).toMatchObject({ ok: true });
    expect(bindFixCheckRow(c.f.work, withLedger, grantsOf(c))).toMatchObject({ ok: false });
    expect(bindFixCheckRow(c.f.work, { ...withLedger, findings: [] }, grantsOf(c), { open: true })).toMatchObject({ ok: false, why: expect.stringContaining('does not dispose') });
  });

  // Value: protects=gskills#25: the claimed reader's packet is git diff <claimed head> HEAD, built by gstack, so a hand-built
  //   partial --hunks file cannot reach it; fails_when=the row records the partial paths; seam=gstack-review-plan --fix-check-prompt
  test('a partial --hunks file is replaced by the full diff since the claimed head', () => {
    const c = atCap([open(ID, FP)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'fix it', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix it'])));
    c.f.write({ 'src/x.ts': 'export const x = 3;\n', 'src/y.ts': 'export const y = 1;\n' }); c.f.commit('fix');
    ok(c.run('gstack-ship-receipt', ['claim', '--body', c.body, '--pr', '7', '--run', 'r2', '--grant', id]));
    const partial = path.join(c.f.root, 'partial.diff');
    fs.writeFileSync(partial, c.f.git('diff', c.S, 'HEAD', '--', 'src/x.ts').stdout);
    const fixes = path.join(c.f.root, 'fixes.txt'), tests = path.join(c.f.root, 'tests.txt');
    fs.writeFileSync(fixes, 'fix ' + ID + '\n'); fs.writeFileSync(tests, '3 pass\n');
    const p = c.run('gstack-review-plan', ['--fix-check-prompt', '--fix-list', fixes, '--hunks', partial, '--tests', tests]);
    expect(p.status, p.stderr).toBe(0);
    expect(p.stderr).toContain(`FIX_CHECK_HUNKS: built from git diff ${c.S.slice(0, 12)} HEAD`);
    expect(p.stdout).toContain('src/y.ts');
  });

  // Value: protects=a grant buys one round: a fix-check grant an unclaimed fix-check already spent (an owner's review_loop_grant
  //   or a round-grant planned through gstack-review-plan --grant, neither of which leaves a claim in the PR body) cannot be
  //   claimed for a second read; fails_when=claim prints GRANT_CLAIMED; seam=gstack-ship-receipt claim
  test('claim refuses GRANT_SPENT for a grant an unclaimed counted fix-check already spent', () => {
    for (const legacy of [true, false]) {
      const c = atCap([open(ID, FP)]);
      const id = legacy
        ? JSON.parse(ok(c.run('gstack-approvals', ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${c.S})`, '--words', 'do it', '--by', CAPTAIN, '--scope', 'this /ship invocation', '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--json']))).added[0] as string
        : grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'fix it', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix it'])));
      unclaimedFixCheck(c);
      expect(rows(c).filter(x => x.skill === 'review-fix-check').at(-1)?.grant).toBeUndefined();
      const r = c.run('gstack-ship-receipt', ['claim', '--body', c.body, '--pr', '7', '--run', 'r2', '--grant', id]);
      expect([legacy, r.status, r.stdout]).toEqual([legacy, 3, '']);
      expect(r.stderr).toContain('GRANT_SPENT');
      expect(fs.readFileSync(c.body, 'utf8')).not.toContain(id);
    }
  });

  // Value: protects=the negative controls: an unspent grant still claims, a malformed row spends nothing, and the run that holds
  //   the claim may claim again after its own read; fails_when=claim refuses any of them; seam=gstack-ship-receipt claim
  test('claim still takes an unspent grant, one only a malformed row read, and this run\'s own claim again', () => {
    const c = atCap([open(ID, FP)]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'fix it', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'fix it'])));
    unclaimedFixCheck(c, { converged: false });
    ok(c.run('gstack-ship-receipt', ['claim', '--body', c.body, '--pr', '7', '--run', 'r2', '--grant', id]));
    fixCheck(c, { grant: id, run: 'r2', fixList: 'fix ' + ID + '\n', claim: false });
    expect(ok(c.run('gstack-ship-receipt', ['claim', '--body', c.body, '--pr', '7', '--run', 'r2', '--grant', id]))).toContain(`GRANT_CLAIMED: grant=${id}`);
  });
});

describe('a post-review edit with no stop gets a grant (GST-3546, gbrain#10068)', () => {
  // Value: protects=a docs-audit edit after the cap, with no stop record, buys one scoped fix-check that finish counts;
  //   fails_when=round-grant refuses a fix-check with no --stop-run, or finish prints FIX_CHECK: not counted; seam=round-grant, finish
  test('a grant at the reviewed head covers the edit, and finish counts its fix-check', () => {
    const c = atCap([]);
    const id = grantId(ok(c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', 'docs audit edited code comments after review', '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', 'one fix-check'])));
    fixCheck(c, { grant: id, run: 'r2', fixList: 'review the docs-audit edit\n', files: { 'src/x.ts': '// the x value\nexport const x = 2;\n' } });
    const post = path.join(c.f.root, 'post.json');
    ok(c.run('gstack-docs-candidate', ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']));
    const F = headOf(c.f);
    const fin = c.f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', c.f.git('rev-parse', c.S + '^{tree}').stdout.trim(), '--docs-post', post, '--reviewed-base', c.f.git('merge-base', 'origin/main', 'HEAD').stdout.trim(), '--lane', 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"'], { GSTACK_APPROVALS_MIRROR: '0' });
    expect(fin.stdout).not.toContain('FIX_CHECK: not counted');
    expect(fin.stdout).toContain(`(fix-check at ${F.slice(0, 12)}, range from ${c.S.slice(0, 12)}, grant ${id})`);
  });
});

describe('round-grant fits a verbatim owner reason (GST-3546 gap 2)', () => {
  // Value: protects=a reason past the 300-character ask records, with the ask cut and the full words kept; fails_when=
  //   APPROVAL_RECORD_INVALID on the ask cap; seam=reviewRoundGrantRow, gstack-approvals round-grant
  test('the ask is cut at 300 characters with an ellipsis, it still parses, and --words keeps every word', () => {
    const reason = 'Ruled: ' + 'the docs audit rewrote three paragraphs of the security section after round two, and I want one scoped read of exactly that change before this ships. '.repeat(3).trim();
    const built = reviewRoundGrantRow('b'.repeat(40), 7, 'fix-check', reason);
    expect(built.ask.length).toBeLessThanOrEqual(300);
    expect(built.ask.endsWith('…')).toBe(true);
    const c = atCap([]);
    const r = c.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', c.S, '--kind', 'fix-check', '--reason', reason, '--by', CAPTAIN, '--owner-ref', 'GSTA-36:2026-11-22T12:00:00Z', '--words', reason]);
    const id = grantId(ok(r));
    const listed = JSON.parse(ok(c.run('gstack-approvals', ['list', '--json']))) as { rows?: ApprovalRow[] } | ApprovalRow[];
    const row = (Array.isArray(listed) ? listed : listed.rows ?? []).find(x => x.id === id)!;
    expect(row.words).toBe(reason);
    expect(grantsOf(c).find(g => g.approval === id)).toMatchObject({ kind: 'fix-check', head: c.S });
  });
});

describe('an ended or dead /ship run stops holding gstack upgrades (gskills#25)', () => {
  const stateRoot = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-live-'))); tmps.push(d); return d; };
  const ledger = (sr: string, run: string, extra: Record<string, unknown>) => {
    fs.mkdirSync(path.join(sr, 'ship-runs', run), { recursive: true });
    fs.writeFileSync(path.join(sr, 'ship-runs', run, 'budget.json'), JSON.stringify({ kind: 'gstack-ship-budget', run, created_at: new Date(Date.now() - 60_000).toISOString(), ...extra }));
  };
  const sleeper = () => { const k = spawn('sleep', ['300'], { stdio: 'ignore' }); kids.push(k); return k.pid!; };
  const ownerOf = (pid: number): RunOwner => { const o = thisRunOwner(pid)!; expect(o).not.toBeNull(); return o; };
  const deadOwner = (): RunOwner => { const k = spawnSync('sleep', ['0'], { timeout: 10_000 }); const { shared: _shared, ...here } = ownerOf(process.pid); return { ...here, pid: k.pid!, comm: 'claude' }; };

  // Value: protects=an ended run (its harness gone, or its own checkout run record finished or abandoned) no longer holds upgrades,
  //   while a live, stopped (it may still claim its grant) or unprovable one still does; fails_when=a dead run holds, a stopped run or
  //   an earlier run's finished record releases, or a run on a shared harness is released; seam=liveRun
  test('dead owner and this run\'s finished record release; a live owner, a stopped run, an older record and a shared harness hold', () => {
    if (process.platform !== 'linux') return;
    const sr = stateRoot();
    ledger(sr, 'dead', { owner: deadOwner() });
    expect(liveRun(sr)).toMatchObject({ ended: [expect.stringContaining('/ship run dead: its owner process')] });
    expect(liveRun(sr).live).toBeUndefined();
    const c = atCap([]);
    const recordFile = path.resolve(c.f.work, c.f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    const record = (state: string, started: number) => fs.writeFileSync(recordFile, JSON.stringify({ v: 1, run: 'r2', state, head: c.S, started_at: new Date(started).toISOString(), beat_at: new Date().toISOString() }) + '\n');
    const shared = { ...ownerOf(process.pid), shared: true };
    record('stopped', Date.now());
    ledger(sr, 'mine', { checkout: c.f.work, owner: shared });
    expect(liveRun(sr).live).toContain('/ship run mine');
    record('finished', Date.now() - 3_600_000);
    expect(liveRun(sr).live).toContain('/ship run mine');
    ledger(sr, 'other', { checkout: c.f.work, owner: shared, created_at: new Date(Date.now() - 30_000).toISOString() });
    record('finished', Date.now());
    expect(liveRun(sr).live).toContain('/ship run mine');
    fs.rmSync(path.join(sr, 'ship-runs', 'other'), { recursive: true });
    expect(liveRun(sr).live).toBeUndefined();
    ledger(sr, 'alive', { owner: ownerOf(sleeper()) });
    expect(liveRun(sr).live).toContain('/ship run alive');
    fs.rmSync(path.join(sr, 'ship-runs', 'alive'), { recursive: true });
    ledger(sr, 'legacy', {});
    expect(liveRun(sr).live).toContain('/ship run legacy');
    const out = spawnSync(path.join(BIN, 'gstack-ship-run'), ['live', '--state-root', sr], { encoding: 'utf8', timeout: 60_000 });
    expect(out.stdout).toContain('RUN_LIVE: /ship run legacy');
    expect(out.stdout).toContain('RUN_HOLD_RELEASED: /ship run dead');
  });

  // Value: protects=abandon takes a run whose owner is provably gone at once, instead of after 60 minutes; fails_when=
  //   SHIP_RUN_ABANDON_REFUSED for a run whose harness exited; seam=abandonRefusal
  test('abandon refuses a fresh run under a live or shared owner and takes one whose owner is gone', () => {
    if (process.platform !== 'linux') return;
    const c = atCap([]);
    const now = new Date().toISOString();
    const file = path.resolve(c.f.work, c.f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    const put = (owner: RunOwner) => { fs.writeFileSync(file, JSON.stringify({ v: 1, run: 'r2', state: 'open', head: c.S, started_at: now, beat_at: now, owner }) + '\n'); return readRunRecord(c.f.work); };
    expect(abandonRefusal(put(ownerOf(sleeper())), 'r2', undefined)).toContain('still working');
    expect(abandonRefusal(put({ ...ownerOf(process.pid), shared: true }), 'r2', undefined)).toContain('still working');
    expect(abandonRefusal(put(deadOwner()), 'r2', undefined)).toBeNull();
  });
});
