/**
 * GST-3260 PR 2: a granted fix-check that read the fix clean closes exactly the findings its grant names, with no owner ruling.
 * Before, a clean fix-check under a fix-check grant left RECEIPT_BLOCKER_OPEN (gstack #4537, harness-evals #508, #4585, #4567),
 * a Review-Finding trailer whose fix a later full round read clean stayed open (#4597), and finish anchored a granted fix-check on
 * the newest reviewed tree instead of the stop the grant names (#4612). The closed #4546 tried this and its second-model trail
 * reads found the gaps each negative case below pins (captain drive reports/GSTA-665.md). Fixtures are synthetic; the replays
 * follow each case's shape, not its bytes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bindFixCheckRow, clearByGrant, clearByTrailer, grantSpent } from '../lib/fix-check-clearing';
import { hunksDigest } from '../lib/review-evidence';
import { grantMarker, placeRunEntry, stopMarker } from '../lib/pr-review-history';
import { readReviewRoundGrants, type ReviewRoundGrant } from '../lib/review-round-grant';
import { extractReceipt, receiptRuns } from '../lib/ship-receipt';
import { renderFixCheckPrompt } from '../scripts/resolvers/fix-check';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fxs: ShipFx[] = [];
afterEach(() => { while (fxs.length) fxs.pop()!.cleanup(); });

const ID = 'p1/outside-voice#1', FP = 'src/x.ts:1:outside-voice';
const TEST = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); });\n";
const blocker = { fingerprint: FP, severity: 'CRITICAL', action: 'open', blocking: true, ledger_id: ID, raised_by: 'outside-voice' };
const CLEAN = { completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] };

type Granted = { f: ShipFx; run: (bin: string, args: string[]) => ReturnType<ShipFx['run']>; S: string; F: string; grant: string; body: string; since: string; fixRun: string };
const headOf = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const marker = (f: ShipFx, run: string) => fs.writeFileSync(path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim()), run + '\n');
const ok = (r: { status: number | null; stderr: string; stdout: string }) => { expect(r.status, r.stderr + r.stdout).toBe(0); return r.stdout; };

/** A full review row through the logger: --start, then the row with --finish, bound to the committed HEAD. */
function logRow(g: Pick<Granted, 'run'>, skill: string, row: Record<string, unknown>) {
  const start = ok(g.run('gstack-review-log', ['--start', skill])).trim();
  ok(g.run('gstack-review-log', [JSON.stringify({ skill, timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', ...row }), '--finish', start]));
}

/**
 * The stopped run stops on a review that left ID open at S and records the stop; the lane grants one fix-check naming it; the fix
 * run (the stop's own run for harness-evals #508, a new run for gstack #4537) claims the grant, commits the fix at F and runs the
 * fix-check from the stop head through the logger and gstack-review-plan --fix-check-prompt, which records its hunks.
 */
function grantedRun(o: { sameRun: boolean; fixRow?: Record<string, unknown>; extra?: Record<string, string>; hunkPaths?: string[] }): Granted {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST });
  fxs.push(f);
  const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, 'Fixes a thing.\n');
  const since = new Date(Date.now() - 1000).toISOString();
  const S = headOf(f);
  marker(f, 'ro');
  logRow({ run }, 'review', { pass: 1, completed: true, converged: false, status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [blocker] });
  ok(run('gstack-ship-receipt', ['stop', '--body', body, '--pr', '7', '--run', 'ro', '--since', since]));
  const grant = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(ok(run('gstack-approvals', ['round-grant', '--pr', '7', '--head', S, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', ID, '--reason', 'fixable blocker', '--by', 'Captain GStack Minder (GSTA-36)'])))![1]!;
  const fixRun = o.sameRun ? 'ro' : 'fc1';
  if (!o.sameRun) marker(f, fixRun);
  f.write({ 'src/x.ts': 'export const x = 3;\n', ...o.extra }); f.commit('fix the blocker');
  const F = headOf(f);
  expect(ok(run('gstack-ship-receipt', ['claim', '--body', body, '--run', fixRun, '--grant', grant]))).not.toContain('RUN_RECORD');
  const start = ok(run('gstack-review-log', ['--start', 'review-fix-check'])).trim();
  const files = Object.entries({ fixes: 'fix ' + ID + '\n', hunks: f.git('diff', S, F, ...(o.hunkPaths ? ['--', ...o.hunkPaths] : [])).stdout, tests: '3 pass\n' }).map(([k, v]) => { const p = path.join(f.root, k + '.txt'); fs.writeFileSync(p, v); return p; });
  ok(run('gstack-review-plan', ['--fix-check-prompt', '--fix-list', files[0]!, '--hunks', files[1]!, '--tests', files[2]!]));
  ok(run('gstack-review-log', [JSON.stringify({ skill: 'review-fix-check', timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', range_base: S, ...CLEAN, ...o.fixRow }), '--finish', start]));
  return { f, run, S, F, grant, body, since, fixRun };
}

const rowsOf = (g: Granted) => g.run('gstack-review-read', []).stdout.split('\n---CONFIG---')[0]!.split('\n').flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v] : []; } catch { return []; } });
const grantsOf = (g: Granted) => readReviewRoundGrants(g.f.work, { ...process.env, GSTACK_STATE_ROOT: g.f.state, GSTACK_HOME: g.f.state });

/** /ship Step 19: the summary since the stopped run began, then write for the fix run. */
function summaryThenWrite(g: Granted, extra: string[] = []) {
  const loop = path.join(g.f.root, 'loop.json');
  ok(g.run('gstack-review-scope', ['summary', '--since', g.since, '--no-ledger', '--out', loop]));
  return { loop: JSON.parse(fs.readFileSync(loop, 'utf8')), w: g.run('gstack-ship-receipt', ['write', '--pr', '7', '--run', g.fixRun, '--base', 'main', '--session-kind', 'unattended', '--review-loop', '@' + loop, '--body', g.body, ...extra]) };
}

describe('the logger stamps a granted fix-check row from the run record\'s claim (amendment A)', () => {
  // Value: protects=the range a granted fix-check read comes from the claim, never from an agent-typed range; fails_when=the row
  //   carries no fix_check_base, or the agent's own fix_check_base or grant survives, or the row turns into a fix-range pass;
  //   seam=gstack-review-log --start/--finish, gstack-review-plan --fix-check-prompt
  test('fix_check_base, run, grant, pr and the hunks digest are stamped, and scope stays a normal verified row', () => {
    const g = grantedRun({ sameRun: false, fixRow: { fix_check_base: 'f'.repeat(40), grant: 'a-000000000000', run: 'forged' } });
    const row = rowsOf(g).filter(r => r.skill === 'review-fix-check').at(-1)!;
    expect(row).toMatchObject({ fix_check_base: g.S, run: 'fc1', grant: g.grant, pr: 7, hunks: hunksDigest(g.f.git('diff', g.S, g.F).stdout), review_binding: { state: 'verified' } });
    expect(row.scope).toBeUndefined();
    expect(bindFixCheckRow(g.f.work, row, grantsOf(g))).toMatchObject({ ok: true, base: g.S, commit: g.F });
  });
});

describe('a granted, clean fix-check closes exactly its grant\'s findings at write (positive replays)', () => {
  // Value: protects=gstack #4537, a new run answers another run's stop and its clean fix-check closes the blocker with no ruling;
  //   fails_when=write refuses RECEIPT_BLOCKER_OPEN; seam=gstack-ship-receipt write
  test('gstack #4537: a new run spends the grant on the read-only run\'s stop', () => {
    const g = grantedRun({ sameRun: false });
    const { loop, w } = summaryThenWrite(g);
    expect(loop.open).toEqual([{ id: ID, fingerprint: FP }]);
    expect(w.status, w.stderr).toBe(0);
    expect(w.stderr).toContain('FIX_CHECK_CLEAR: grant=' + g.grant + ' run=fc1 closed=' + ID);
    expect(extractReceipt(fs.readFileSync(g.body, 'utf8')).receipt).toMatchObject({ cleared_by_grant: { approval: g.grant, run: 'fc1', ids: [ID] } });
    expect(fs.readFileSync(g.body, 'utf8')).toContain('Closed by grant ' + g.grant + ': ' + ID + ' (the granted fix-check of run fc1 read the fix clean)');
  });

  // Value: protects=harness-evals #508, the run that stopped claims its own stop's grant and closes it; fails_when=write refuses
  //   RECEIPT_BLOCKER_OPEN; seam=gstack-ship-receipt write
  test('harness-evals #508: the stopped run spends the grant on its own stop', () => {
    const g = grantedRun({ sameRun: true });
    const { w } = summaryThenWrite(g);
    expect(w.status, w.stderr).toBe(0);
    expect(JSON.parse(g.run('gstack-ship-receipt', ['read', '--body', g.body, '--json']).stdout)).toMatchObject({ cleared_by_grant: { run: 'ro', ids: [ID] } });
  });

  // Value: protects=#4612, finish anchors a granted fix-check on the stop the grant names, not the newest reviewed tree;
  //   fails_when=FIX_CHECK: not counted (range_base ... does not hold the reviewed tree); seam=gstack-ship-release finish
  test('#4612: finish counts the stamped fix-check when the reviewed tree it was given is the fix commit\'s', () => {
    const g = grantedRun({ sameRun: false });
    const post = path.join(g.f.root, 'post.json');
    ok(g.run('gstack-docs-candidate', ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']));
    const tree = g.f.git('rev-parse', g.F + '^{tree}').stdout.trim();
    const fin = g.f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', tree, '--docs-post', post, '--reviewed-base', g.f.git('merge-base', 'origin/main', 'HEAD').stdout.trim(), '--lane', 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"'], { GSTACK_APPROVALS_MIRROR: '0' });
    expect(fin.stdout).toContain('FIX_CHECK: reviewed none (fix-check at ' + g.F.slice(0, 12) + ', range from ' + g.S.slice(0, 12) + ', grant ' + g.grant + ')');
    const { w } = summaryThenWrite(g);
    expect(w.status, w.stderr).toBe(0);
  });

  // Value: protects=#4597, a fix whose Review-Finding trailer a later full round read clean closes; fails_when=write refuses
  //   RECEIPT_BLOCKER_OPEN because the round-2 row left the finding out; seam=gstack-ship-receipt write
  test('#4597: a trailer plus a later clean full round closes the voice finding', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    fxs.push(f);
    const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
    const g = { f, run, body: path.join(f.root, 'body.md'), since: new Date(Date.now() - 1000).toISOString(), fixRun: 'r1' } as Granted;
    fs.writeFileSync(g.body, 'Fixes a thing.\n');
    logRow(g, 'review', { pass: 1, ...CLEAN });
    logRow(g, 'adversarial-review', { status: 'issues_found', source: 'outside-voice', phase: 'adversarial', gate: 'informational', completed: true, findings: [blocker] });
    f.write({ 'src/x.ts': 'export const x = 3;\n' });
    f.git('add', '-A'); f.git('commit', '-qm', 'fix the outside voice blocker', '--trailer', 'Review-Finding: ' + ID + ' reader=outside-voice');
    const before = summaryThenWrite(g);
    expect(before.w.status).toBe(3);
    logRow(g, 'review', { pass: 2, ...CLEAN });
    const { loop, w } = summaryThenWrite(g);
    expect(loop.open).toEqual([{ id: ID, fingerprint: FP }]);
    expect(w.status, w.stderr).toBe(0);
    expect(w.stderr).toContain('TRAILER_CLEAR: ' + ID + ' (fixed by ' + headOf(f).slice(0, 12));
    expect(extractReceipt(fs.readFileSync(g.body, 'utf8')).receipt?.cleared_by_trailer).toEqual([{ id: ID, commit: headOf(f), review: headOf(f) }]);
    // Value: protects=a later round that left anything open never clears by trailer, even with its findings in a findings file;
    //   fails_when=a round-2 row whose status says issues remain closes the trailer's finding; seam=clearByTrailer
    const rows = rowsOf(g), pass2 = rows.filter(r => r.skill === 'review').at(-1)!;
    const byTrailer = (r2: Record<string, unknown>) => clearByTrailer(f.work, { head: headOf(f), baseRef: 'origin/main', rows: [...rows.filter(r => r !== pass2), r2], open: loop.open });
    expect(byTrailer(pass2)).toHaveLength(1);
    expect(byTrailer({ ...pass2, status: 'issues_found', findings_open: 1, findings_file: '/tmp/f.jsonl', status_source: 'derived' })).toEqual([]);
    expect(byTrailer({ ...pass2, findings: [{ fingerprint: 'src/x.ts:9:style', severity: 'INFORMATIONAL', action: 'open' }] })).toEqual([]);
    // Value: protects=only a finished, converged full round that read the fix closes by trailer (#4664 trail read, flag 2);
    //   fails_when=a completed round that made its own fixes (converged false, bound incomplete), or whose range starts at or after
    //   the fix commit, closes the trailer's finding; seam=clearByTrailer
    expect(byTrailer({ ...pass2, converged: false, review_binding: { ...pass2.review_binding, state: 'incomplete' } })).toEqual([]);
    expect(byTrailer({ ...pass2, range_base: headOf(f) })).toEqual([]);
    // Value: protects=a pass 1, which logs range_base null, reads the whole PR and still closes a committed fix by trailer (#4696
    //   ship-4696c, p1/outside-voice#4); fails_when=null reads as a range that leaves the fix out; seam=clearByTrailer
    expect(byTrailer({ ...pass2, range_base: null })).toHaveLength(1);
  });
  // Value: protects=a security-class fingerprint never closes by trailer, so no closure line puts its location in the public body
  //   (#4664 trail read, flag 3); fails_when=a blocker with no ledger id closes by its raw path:line:security fingerprint;
  //   why_new=the #4597 replay uses a ledger id; seam=clearByTrailer; no_claim=closure by ledger id, which carries no location
  test('a trailer naming a security fingerprint closes nothing, while the same trailer on a plain fingerprint closes', () => {
    const byFingerprint = (fp: string) => {
      const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
      fxs.push(f);
      const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
      const g = { run } as Granted;
      logRow(g, 'review', { pass: 1, ...CLEAN });
      logRow(g, 'adversarial-review', { status: 'issues_found', source: 'outside-voice', phase: 'adversarial', gate: 'informational', completed: true, findings: [{ fingerprint: fp, severity: 'CRITICAL', action: 'open', blocking: true, raised_by: 'outside-voice' }] });
      f.write({ 'src/x.ts': 'export const x = 3;\n' });
      f.git('add', '-A'); f.git('commit', '-qm', 'fix the blocker', '--trailer', 'Review-Finding: ' + fp + ' reader=outside-voice');
      logRow(g, 'review', { pass: 2, ...CLEAN });
      return clearByTrailer(f.work, { head: headOf(f), baseRef: 'origin/main', rows: rowsOf(g as Granted), open: [fp] });
    };
    expect(byFingerprint('src/x.ts:1:style').map(t => t.id)).toEqual(['src/x.ts:1:style']);
    expect(byFingerprint('src/x.ts:1:security')).toEqual([]);
    expect(byFingerprint('src/x.ts::security')).toEqual([]);
  });
});

describe('a fix-check reader given only part of the fix closes nothing', () => {
  // Value: protects=the hunks a granted fix-check read cover the whole stop-to-fix diff; fails_when=hunks over one of two changed
  //   files bind and close the grant, or a hand-built partial packet reaches the claimed reader (GST-3546, gskills#25: gstack
  //   now builds the packet from git diff <claimed head> HEAD); seam=gstack-review-plan --fix-check-prompt, bindFixCheckRow
  test('a hand-built partial packet is replaced by git diff <stop> HEAD, and a row recording partial hunks still closes nothing', () => {
    const g = grantedRun({ sameRun: false, extra: { 'src/y.ts': 'export const y = 1;\n' }, hunkPaths: ['src/x.ts'] });
    const row = rowsOf(g).filter(r => r.skill === 'review-fix-check').at(-1)!;
    expect(row.hunks).toMatchObject(hunksDigest(g.f.git('diff', g.S, g.F).stdout));
    expect(bindFixCheckRow(g.f.work, row, grantsOf(g))).toMatchObject({ ok: true });
    const partial = { ...row, hunks: { ...row.hunks, ...hunksDigest(g.f.git('diff', g.S, g.F, '--', 'src/x.ts').stdout) } };
    expect(bindFixCheckRow(g.f.work, partial, grantsOf(g))).toMatchObject({ ok: false, why: expect.stringContaining('leave out src/y.ts') });
  });
});

describe('harness-evals#504: a fix-check grant answering a stop after a gate-class edit plans its fix-check on the plain route', () => {
  // Value: protects=a grant stays unspent until a fix-check carries it or starts after it, so it buys exactly one fix-check;
  //   fails_when=a fix-check that ran before the grant spends it, or one that carries it leaves it unspent; seam=grantSpent
  test('a grant is spent by the fix-check that carries it or starts after it, never by an earlier one', () => {
    const g = { approval: 'a-2', at: '2026-11-21T01:00:00.000Z' };
    const read = (started_at: string) => ({ skill: 'review-fix-check', completed: true, converged: true, status: 'clean', review_binding: { state: 'verified', started_at } });
    expect(grantSpent([{ ...read('2026-11-21T01:01:00.000Z'), converged: false }], g)).toBe(false);
    expect(grantSpent([read('2026-11-21T00:59:00.000Z')], g)).toBe(false);
    expect(grantSpent([read('2026-11-21T01:01:00.000Z')], g)).toBe(true);
    expect(grantSpent([{ ...read('2026-11-21T00:00:00.000Z'), grant: 'a-2' }], g)).toBe(true);
  });

  // Value: protects=two recorded grants each buy one read: a counted fix-check a claim stamped with grant a-3 was a-3's read, so
  //   it leaves a-2 unspent however late it ran; fails_when=claim refuses a-2 with GRANT_SPENT after a-3's read; seam=grantSpent
  test('a later read stamped with another grant leaves this grant unspent', () => {
    const g = { approval: 'a-2', at: '2026-11-21T01:00:00.000Z' };
    const read = { skill: 'review-fix-check', completed: true, converged: true, status: 'clean', review_binding: { state: 'verified', started_at: '2026-11-21T01:01:00.000Z' } };
    expect(grantSpent([{ ...read, grant: 'a-3' }], g)).toBe(false);
    expect(grantSpent([{ ...read, grant: 'a-3' }, read], g)).toBe(true);
  });

  // Value: protects=the same through the CLI: --round-grant and --stop after --last fix-check with a gate-class fix plan next=fix-check
  //   with the fix-check reader only; fails_when=the plan prints next=stop; seam=gstack-review-plan
  test('gstack-review-plan plans the granted fix-check after a fix-check that edited a gate-class path', () => {
    const g = grantedRun({ sameRun: true });
    const s2 = g.F;
    expect(ok(g.run('gstack-ship-receipt', ['stop', '--body', g.body, '--pr', '7', '--run', 'ro', '--since', g.since]))).toContain('STOP_RECORD: run=ro head=' + s2);
    const g2 = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(ok(g.run('gstack-approvals', ['round-grant', '--pr', '7', '--head', s2, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'p2/fix-check#1', '--reason', 'gate edit', '--by', 'Captain GStack Minder (GSTA-36)', '--owner-ref', 'GSTA-36:2026-11-21T02:00:00Z', '--words', 'grant one fix-check'])))![1]!;
    g.f.write({ 'src/x.ts': 'export const x = 4;\n' }); g.f.commit('fix the fix-check finding');
    const plan = g.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '3', '--prior-full', '2', '--pr', '7', '--round-grant', g2, '--stop', s2, '--range-base', s2, '--last', 'fix-check', '--fix-checks', '1', '--touched-gate']);
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('next=fix-check');
  });
});

describe('the fix-check reader\'s packet is byte-identical with and without a claim (rule 15)', () => {
  // Value: protects=no reviewer packet changes: the stamp and the hunks record ride beside the prompt; fails_when=a claimed run's
  //   prompt bytes differ from renderFixCheckPrompt's; seam=gstack-review-plan --fix-check-prompt
  test('--fix-check-prompt prints renderFixCheckPrompt\'s bytes, claimed or not, and records the hunks digest', () => {
    const f = shipFixture();
    fxs.push(f);
    const files = { fixList: 'fix p1/outside-voice#1\n', touchedHunks: 'diff --git a/src/b.ts b/src/b.ts\n+x\n', testResults: '3 pass\n', callers: '' };
    const args = Object.entries({ '--fix-list': files.fixList, '--hunks': files.touchedHunks, '--tests': files.testResults }).flatMap(([k, v]) => { const p = path.join(f.root, k.slice(2)); fs.writeFileSync(p, v); return [k, p]; });
    const prompt = () => f.run(path.join(BIN, 'gstack-review-plan'), ['--fix-check-prompt', ...args]).stdout;
    const plain = prompt();
    fs.writeFileSync(path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim()), JSON.stringify({ v: 1, run: 'fc1', state: 'open', head: 'a'.repeat(40), started_at: new Date().toISOString(), beat_at: new Date().toISOString(), claim: { grant: 'a-000000000001', stop_head: 'a'.repeat(40), findings: [], pr: 7 } }));
    expect(Buffer.from(prompt())).toEqual(Buffer.from(plain));
    expect(Buffer.from(plain)).toEqual(Buffer.from(renderFixCheckPrompt(files)));
    const rec = JSON.parse(fs.readFileSync(path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-fix-check-hunks').stdout.trim()), 'utf8'));
    expect(rec).toMatchObject(hunksDigest(files.touchedHunks));
  });
});

describe('clearing refuses every gap GSTA-665\'s trail reads found in #4546 (lib/fix-check-clearing.ts)', () => {
  let g: Granted;
  let base: { pr: number; run: string; head: string; baseRef: string; body: string; grants: ReviewRoundGrant[]; rows: Record<string, any>[]; open: Array<string | { id: string; fingerprint: string }> };
  const fixRow = () => base.rows.filter(r => r.skill === 'review-fix-check').at(-1)!;
  const withRow = (row: Record<string, any>) => [...base.rows.filter(r => r.skill !== 'review-fix-check'), row];
  const clear = (o: Partial<typeof base> = {}) => clearByGrant(g.f.work, { ...base, ...o });
  beforeAll(() => {
    g = grantedRun({ sameRun: false });
    fxs.length = 0;
    base = { pr: 7, run: 'fc1', head: g.F, baseRef: 'origin/main', body: fs.readFileSync(g.body, 'utf8'), grants: grantsOf(g), rows: rowsOf(g), open: [{ id: ID, fingerprint: FP }] };
  });
  afterAll(() => g.f.cleanup());

  test('the baseline closes the granted id', () => {
    expect(clear()).toEqual({ ids: [ID], approval: g.grant, run: 'fc1' });
  });
  test('another PR\'s grant closes nothing', () => {
    expect(clear({ grants: base.grants.map(x => ({ ...x, pr: 8 })) })).toMatchObject({ ids: [], why: 'no fix-check grant for PR #7' });
  });
  test('with no stop record the grant closes nothing', () => {
    expect(clear({ body: base.body.split('\n').filter(l => !l.includes('"mark":"stop"')).join('\n') })).toMatchObject({ ids: [], why: expect.stringContaining('no stop record') });
  });
  test('another run\'s first claim closes nothing for this run', () => {
    const body = base.body.replace('"run":"fc1","mark":"grant"', '"run":"fc9","mark":"grant"');
    expect(receiptRuns(body).find(r => r.mark === 'grant')?.run).toBe('fc9');
    expect(clear({ body }).ids).toEqual([]);
    expect(clear({ run: 'fc9' }).ids).toEqual([]);
  });
  test('a spent grant (a second stamped row) closes nothing', () => {
    expect(clear({ rows: [...base.rows, { ...fixRow(), run: 'fc2', commit_full: g.S, findings: [{ fingerprint: 'x' }] }] })).toMatchObject({ ids: [], why: expect.stringContaining("holds run fc2's") });
  });
  test('a row with another fix_check_base, or an agent range_base that disagrees, closes nothing', () => {
    const fork = g.f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
    expect(clear({ rows: withRow({ ...fixRow(), fix_check_base: fork }) }).why).toContain('is not the stop');
    expect(clear({ rows: withRow({ ...fixRow(), range_base: fork }) }).why).toContain('disagrees with the logger');
  });
  test('two ledger ids sharing a fingerprint: the fingerprint closes neither, the ledger id closes only its own', () => {
    const open = [{ id: ID, fingerprint: FP }, { id: 'p1/red-team#2', fingerprint: FP }];
    expect(clear({ open, grants: base.grants.map(x => ({ ...x, findings: [FP] })) }).ids).toEqual([]);
    expect(clear({ open }).ids).toEqual([ID]);
  });
  test('an open critical in a findings file closes nothing', () => {
    expect(clear({ rows: withRow({ ...fixRow(), status: 'issues_found', findings_open: 1, findings_file: '/tmp/f.jsonl', status_source: 'derived' }) }).why).toContain('left a finding open');
  });
  test('an inline open finding at low severity closes nothing', () => {
    expect(clear({ rows: withRow({ ...fixRow(), findings: [{ fingerprint: 'src/x.ts:2:style', severity: 'INFORMATIONAL', action: 'open', blocking: false }] }) }).why).toContain('left a finding open');
  });
  test('a newer review on a dirty tree after the stop does not displace the stop head', () => {
    const dirty = { skill: 'review', via: 'ship', completed: true, converged: true, commit_full: g.F, tree: 'e'.repeat(40), wtree: 'd'.repeat(40), review_binding: { state: 'changed', start_wtree: 'd'.repeat(40), end_wtree: 'e'.repeat(40), started_at: new Date().toISOString() }, timestamp: new Date().toISOString(), findings: [] };
    expect(clear({ rows: [...base.rows, dirty] })).toEqual({ ids: [ID], approval: g.grant, run: 'fc1' });
  });
  test('a grant id that names nothing open closes nothing, and the rest still close', () => {
    const grants = base.grants.map(x => ({ ...x, findings: [ID, 'p9/nope#1'] }));
    expect(clear({ grants })).toMatchObject({ ids: [ID], why: expect.stringContaining('p9/nope#1') });
    expect(clear({ grants: base.grants.map(x => ({ ...x, findings: ['p9/nope#1'] })) }).ids).toEqual([]);
  });
  test('hunks that are not git diff <stop> <commit>, out-of-order records, or a gate finding close nothing', () => {
    expect(clear({ rows: withRow({ ...fixRow(), hunks: { ...fixRow().hunks, sha256: '0'.repeat(64) } }) }).why).toContain('hunks');
    const stop = receiptRuns(base.body).find(r => r.mark === 'stop')!;
    const late = placeRunEntry(base.body.replace(/\{"head":"[0-9a-f]{40}","run":"ro","mark":"stop"[^\n]*\n/, ''), stopMarker({ head: stop.head, tree: stop.tree!, run: 'ro', at: '2099-01-01T00:00:00.000Z' }));
    expect(clear({ body: late }).why).toContain('not recorded in that order');
    expect(clear({ rows: [...base.rows, { skill: 'review', via: 'ship', findings: [{ ledger_id: ID, gate: 'RH1', action: 'open' }] }] }).ids).toEqual([]);
  });
  // Value: protects=a grant naming a security-class fingerprint closes nothing by grant either, line or no line (#4664 trail read,
  //   flag 3; #4696 ship-4696c p1/specialist-batched#1); fails_when=a raw security fingerprint the fix list names closes; seam=clearByGrant
  test('a grant naming a security fingerprint closes nothing, while the same grant on a plain fingerprint closes', () => {
    const named = (fp: string) => clear({ grants: base.grants.map(x => ({ ...x, findings: [fp] })), open: [fp], rows: withRow({ ...fixRow(), hunks: { ...fixRow().hunks, fix_list: [fp] } }) }).ids;
    expect(named('src/x.ts:1:style')).toEqual(['src/x.ts:1:style']);
    expect(named('src/x.ts:1:security')).toEqual([]);
    expect(named('src/x.ts::security')).toEqual([]);
  });
  // Value: protects=a fix-check row whose dispatch ledger can't be read closes nothing (#4664 trail read, flag 1); fails_when=a
  //   missing ledger reads as empty, so the check that the row disposes every id the reader raised passes; seam=bindFixCheckRow
  test('a fix-check row naming a dispatch ledger that is missing closes nothing', () => {
    expect(clear({ rows: withRow({ ...fixRow(), hunks: { ...fixRow().hunks, ledger: path.join(g.f.root, 'gone', 'fc', 'ledger.jsonl') } }) })).toMatchObject({ ids: [], why: expect.stringContaining('unreadable') });
  });
  // Value: protects=a clean fix-check closes only the grant ids its fix list named; fails_when=a grant id the reader was never
  //   asked about closes; seam=gstack-review-plan --fix-check-prompt, clearByGrant
  test('the fix list\'s names are recorded, and a grant id the fix list left out closes nothing', () => {
    expect(fixRow().hunks.fix_list).toEqual([ID]);
    expect(clear({ rows: withRow({ ...fixRow(), hunks: { ...fixRow().hunks, fix_list: [] } }) })).toMatchObject({ ids: [], why: expect.stringContaining('does not name ' + ID) });
  });
  test('no trailer, or a trailer with no later full round, closes nothing by trailer', () => {
    expect(clearByTrailer(g.f.work, { head: g.F, baseRef: 'origin/main', rows: base.rows, open: base.open })).toEqual([]);
    expect(grantMarker({ head: g.S, run: 'x', grant: 'a' }).at).toMatch(/^\d{4}-/);
  });
});
