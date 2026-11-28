/**
 * #4597: an open blocker closes at write, with no owner ruling, when a fix commit carries its Review-Finding trailer and a later
 * complete full review read the branch clean (lib/review-trailer-clearing.ts). Moved from the fix-check clearing tests when
 * GST-3562 part 4 removed the granted fix-check route; the fixtures are synthetic and follow #4597's shape, not its bytes.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearByReview, clearByTrailer } from '../lib/review-trailer-clearing';
import { shiftedFinding } from '../lib/ruled-notes';
import { extractReceipt } from '../lib/ship-receipt';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fxs: ShipFx[] = [];
afterEach(() => { while (fxs.length) fxs.pop()!.cleanup(); });

const ID = 'p1/outside-voice#1', FP = 'src/x.ts:1:outside-voice';
const blocker = { fingerprint: FP, severity: 'CRITICAL', action: 'open', blocking: true, ledger_id: ID, raised_by: 'outside-voice' };
const CLEAN = { completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] };

type LoggedRun = { f: ShipFx; run: (bin: string, args: string[]) => ReturnType<ShipFx['run']>; body: string; since: string; fixRun: string };
const headOf = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const ok = (r: { status: number | null; stderr: string; stdout: string }) => { expect(r.status, r.stderr + r.stdout).toBe(0); return r.stdout; };

/** A full review row through the logger: --start, then the row with --finish, bound to the committed HEAD. */
function logRow(g: Pick<LoggedRun, 'run'>, skill: string, row: Record<string, unknown>) {
  const start = ok(g.run('gstack-review-log', ['--start', skill])).trim();
  ok(g.run('gstack-review-log', [JSON.stringify({ skill, timestamp: new Date().toISOString(), via: 'ship', review_scope: 'frozen', ...row }), '--finish', start]));
}

const rowsOf = (g: LoggedRun) => g.run('gstack-review-read', []).stdout.split('\n---CONFIG---')[0]!.split('\n').flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v] : []; } catch { return []; } });

/** /ship Step 19: the summary since the stopped run began, then write for the fix run. */
function summaryThenWrite(g: LoggedRun, extra: string[] = []) {
  const loop = path.join(g.f.root, 'loop.json');
  ok(g.run('gstack-review-scope', ['summary', '--since', g.since, '--no-ledger', '--out', loop]));
  return { loop: JSON.parse(fs.readFileSync(loop, 'utf8')), w: g.run('gstack-ship-receipt', ['write', '--pr', '7', '--run', g.fixRun, '--base', 'main', '--session-kind', 'unattended', '--review-loop', '@' + loop, '--body', g.body, ...extra]) };
}

describe('a Review-Finding trailer plus a later clean full round closes the finding (#4597)', () => {
  // Value: protects=#4597, a fix whose Review-Finding trailer a later full round read clean closes; fails_when=write refuses
  //   RECEIPT_BLOCKER_OPEN because the round-2 row left the finding out; seam=gstack-ship-receipt write
  test('#4597: a trailer plus a later clean full round closes the voice finding', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    fxs.push(f);
    const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
    const g = { f, run, body: path.join(f.root, 'body.md'), since: new Date(Date.now() - 1000).toISOString(), fixRun: 'r1' } as LoggedRun;
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
      const g = { run } as LoggedRun;
      logRow(g, 'review', { pass: 1, ...CLEAN });
      logRow(g, 'adversarial-review', { status: 'issues_found', source: 'outside-voice', phase: 'adversarial', gate: 'informational', completed: true, findings: [{ fingerprint: fp, severity: 'CRITICAL', action: 'open', blocking: true, raised_by: 'outside-voice' }] });
      f.write({ 'src/x.ts': 'export const x = 3;\n' });
      f.git('add', '-A'); f.git('commit', '-qm', 'fix the blocker', '--trailer', 'Review-Finding: ' + fp + ' reader=outside-voice');
      logRow(g, 'review', { pass: 2, ...CLEAN });
      return clearByTrailer(f.work, { head: headOf(f), baseRef: 'origin/main', rows: rowsOf(g as LoggedRun), open: [fp] });
    };
    expect(byFingerprint('src/x.ts:1:style').map(t => t.id)).toEqual(['src/x.ts:1:style']);
    expect(byFingerprint('src/x.ts:1:security')).toEqual([]);
    expect(byFingerprint('src/x.ts::security')).toEqual([]);
  });
});

const lines = (n: number, tag = 'v') => Array.from({ length: n }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`).join('\n') + '\n';

/** One run of /ship up to a stop: pass 1 clean, then Step 11 raises `finding` at the current HEAD. */
function raised(files: Record<string, string>, finding: Record<string, unknown>) {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n', 'src/y.ts': 'export const y = 1;\n' }, files);
  fxs.push(f);
  const run = (bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
  const g = { f, run, body: path.join(f.root, 'body.md'), since: new Date(Date.now() - 1000).toISOString(), fixRun: 'r1' } as LoggedRun;
  fs.writeFileSync(g.body, 'Fixes a thing.\n');
  logRow(g, 'review', { pass: 1, ...CLEAN });
  logRow(g, 'adversarial-review', { status: 'issues_found', source: 'outside-voice', phase: 'adversarial', gate: 'informational', completed: true, findings: [finding] });
  return g;
}

describe('GSKI-1 #4: a fix with no Review-Finding trailer closes once a later clean full review read it', () => {
  // Value: protects=a blocker fixed in a commit with no trailer closes when a later complete full review of a head holding that
  //   commit read the branch clean and the commit changed the finding's file after it was raised (GSKI-1 #4, 8426619);
  //   fails_when=write refuses RECEIPT_BLOCKER_OPEN after the clean read-only final review; seam=gstack-ship-receipt write
  test('a fix commit that changed the finding\'s file, with no trailer, plus a later clean full round closes the blocker', () => {
    const g = raised({ 'src/x.ts': 'export const x = 2;\n' }, blocker);
    g.f.write({ 'src/x.ts': 'export const x = 3;\n' });
    g.f.git('add', '-A'); g.f.git('commit', '-qm', 'fix the outside voice blocker');
    expect(summaryThenWrite(g).w.status).toBe(3);
    logRow(g, 'review', { pass: 2, ...CLEAN });
    const { loop, w } = summaryThenWrite(g);
    expect(loop.open).toEqual([{ id: ID, fingerprint: FP }]);
    expect(w.status, w.stderr).toBe(0);
    expect(w.stderr).toContain('REVIEW_CLEAR: ' + ID + ' (fixed by ' + headOf(g.f).slice(0, 12));
    const receipt = extractReceipt(fs.readFileSync(g.body, 'utf8')).receipt;
    expect(receipt?.cleared_by_review).toEqual([{ id: ID, commit: headOf(g.f), review: headOf(g.f) }]);
    expect(receipt?.cleared_by_trailer).toBeUndefined();
  });
  // Value: protects=a clean full round never closes a blocker no commit after the raise touched (the fix went elsewhere, or the
  //   only change to its file came before it was raised); fails_when=a later clean round alone closes an unaddressed blocker;
  //   seam=gstack-ship-receipt write and clearByReview
  test('negative controls: no change to the finding\'s file after the raise, a dirty later round, a security or pathless finding', () => {
    const g = raised({ 'src/x.ts': 'export const x = 2;\n' }, blocker);
    g.f.write({ 'src/y.ts': 'export const y = 2;\n' });
    g.f.git('add', '-A'); g.f.git('commit', '-qm', 'an unrelated change');
    logRow(g, 'review', { pass: 2, ...CLEAN });
    const { loop, w } = summaryThenWrite(g);
    expect(w.status).toBe(3);
    expect(w.stderr).toContain('RECEIPT_BLOCKER_OPEN');
    const rows = rowsOf(g), pass2 = rows.filter(r => r.skill === 'review').at(-1)!;
    expect(clearByReview(g.f.work, { head: headOf(g.f), baseRef: 'origin/main', rows, open: loop.open })).toEqual([]);
    const fixed = raised({ 'src/x.ts': 'export const x = 2;\n' }, blocker);
    fixed.f.write({ 'src/x.ts': 'export const x = 3;\n' });
    fixed.f.git('add', '-A'); fixed.f.git('commit', '-qm', 'fix');
    logRow(fixed, 'review', { pass: 2, ...CLEAN });
    const fixedRows = rowsOf(fixed), fixedPass2 = fixedRows.filter(r => r.skill === 'review').at(-1)!;
    const by = (r2: Record<string, unknown>, open: unknown[] = [{ id: ID, fingerprint: FP }], rows = fixedRows.filter(r => r !== fixedPass2)) =>
      clearByReview(fixed.f.work, { head: headOf(fixed.f), baseRef: 'origin/main', rows: [...rows, r2], open: open as any });
    expect(by(fixedPass2)).toHaveLength(1);
    expect(by({ ...fixedPass2, status: 'issues_found', findings: [{ fingerprint: 'src/y.ts:1:style', severity: 'INFORMATIONAL', action: 'open' }] })).toEqual([]);
    expect(by({ ...fixedPass2, converged: false, review_binding: { ...fixedPass2.review_binding, state: 'incomplete' } })).toEqual([]);
    expect(by({ ...fixedPass2, range_base: headOf(fixed.f) })).toEqual([]);
    expect(by({ ...fixedPass2, scope: 'scoped' })).toEqual([]);
    const sec = fixedRows.filter(r => r !== fixedPass2).map(r => r.skill === 'adversarial-review' ? { ...r, findings: [{ ...blocker, fingerprint: 'src/x.ts:1:security', ledger_id: undefined }] } : r);
    expect(by(fixedPass2, ['src/x.ts:1:security'], sec)).toEqual([]);
    const pathless = fixedRows.filter(r => r !== fixedPass2).map(r => r.skill === 'adversarial-review' ? { ...r, findings: [{ ...blocker, fingerprint: 'p1/outside-voice#1' }] } : r);
    expect(by(fixedPass2, [ID], pathless)).toEqual([]);
    void pass2;
  });
});

describe('GSKI-1 #5: a ruled finding stays ruled when edits above it move its line', () => {
  const rule = (g: LoggedRun, finding: string) => {
    ok(g.run('gstack-approvals', ['rule', '--finding', finding, '--head', headOf(g.f), '--reason', 'ships as a note', '--words', 'ship it as a note', '--by', 'Captain Fixture (FX-1)']));
    fs.writeFileSync(g.body, 'Fixes a thing.\n\n' + ok(g.run('gstack-approvals', ['rulings'])));
  };
  const reraise = (g: LoggedRun, finding: Record<string, unknown>) => {
    logRow(g, 'review', { pass: 2, ...CLEAN });
    logRow(g, 'adversarial-review', { status: 'issues_found', source: 'outside-voice', phase: 'adversarial', gate: 'informational', completed: true, findings: [finding] });
  };
  const AT43 = 'src/x.ts:43:outside-voice', AT54 = 'src/x.ts:54:outside-voice';
  const ruledAt43 = () => {
    const g = raised({ 'src/x.ts': lines(60) }, { ...blocker, fingerprint: AT43, ledger_id: 'p1/outside-voice#1' });
    rule(g, AT43);
    g.f.write({ 'src/x.ts': lines(11, 'added') + lines(60) });
    g.f.git('add', '-A'); g.f.git('commit', '-qm', 'add eleven lines at the top');
    return g;
  };
  // Value: protects=a ruling on path:43:voice covers the same unchanged line re-raised at :54 after 11 lines were added above it
  //   (GSKI-1 #5); fails_when=write refuses RECEIPT_BLOCKER_OPEN on the shifted fingerprint; seam=gstack-ship-receipt write
  test('the same finding re-raised at its shifted line stays ruled', () => {
    const g = ruledAt43();
    reraise(g, { ...blocker, fingerprint: AT54, ledger_id: 'p2/outside-voice#1' });
    const { loop, w } = summaryThenWrite(g);
    expect(loop.open).toEqual([{ id: 'p1/outside-voice#1', fingerprint: AT43 }, { id: 'p2/outside-voice#1', fingerprint: AT54 }]);
    expect(w.status, w.stderr).toBe(0);
    expect(w.stderr).toContain('RULED_SHIFT: p2/outside-voice#1 is ' + AT43);
    expect(shiftedFinding(g.f.work, AT43, g.f.git('rev-parse', 'HEAD~1').stdout.trim(), headOf(g.f))).toBe(AT54);
  });
  // Value: protects=a different finding in the same file, the same line after its text changed, another voice or a security
  //   finding never inherits a ruling (fail closed); fails_when=any of them writes a receipt; seam=gstack-ship-receipt write and shiftedFinding
  test('adversarial controls: another line, an edited ruled line, another voice and a security finding still block', () => {
    const other = ruledAt43();
    reraise(other, { ...blocker, fingerprint: 'src/x.ts:20:outside-voice', ledger_id: 'p2/outside-voice#1' });
    const w1 = summaryThenWrite(other).w;
    expect(w1.status).toBe(3);
    expect(w1.stderr).toContain('RECEIPT_BLOCKER_OPEN');
    const voice = ruledAt43();
    reraise(voice, { ...blocker, fingerprint: 'src/x.ts:54:red-team', raised_by: 'red-team', ledger_id: 'p2/red-team#1' });
    expect(summaryThenWrite(voice).w.status).toBe(3);
    const edited = ruledAt43();
    const was = headOf(edited.f);
    edited.f.write({ 'src/x.ts': (lines(11, 'added') + lines(60)).replace('export const v43 = 43;', 'export const v43 = 4300;') });
    edited.f.git('add', '-A'); edited.f.git('commit', '-qm', 'edit the ruled line');
    reraise(edited, { ...blocker, fingerprint: AT54, ledger_id: 'p2/outside-voice#1' });
    expect(summaryThenWrite(edited).w.status).toBe(3);
    const ruledHead = edited.f.git('rev-parse', 'HEAD~2').stdout.trim();
    expect(shiftedFinding(edited.f.work, AT43, ruledHead, was)).toBe(AT54);
    expect(shiftedFinding(edited.f.work, AT43, ruledHead, headOf(edited.f))).toBeNull();
    expect(shiftedFinding(edited.f.work, 'src/x.ts:43:security', ruledHead, was)).toBeNull();
    expect(shiftedFinding(edited.f.work, AT43, was, ruledHead)).toBeNull();
    expect(shiftedFinding(edited.f.work, 'src/x.ts::outside-voice', ruledHead, was)).toBeNull();
    expect(shiftedFinding(edited.f.work, 'src/x.ts:5:outside-voice', ruledHead, was)).toBe('src/x.ts:16:outside-voice');
  });
});
