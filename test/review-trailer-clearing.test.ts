/**
 * #4597: an open blocker closes at write, with no owner ruling, when a fix commit carries its Review-Finding trailer and a later
 * complete full review read the branch clean (lib/review-trailer-clearing.ts). Moved from the fix-check clearing tests when
 * GST-3562 part 4 removed the granted fix-check route; the fixtures are synthetic and follow #4597's shape, not its bytes.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearByTrailer } from '../lib/review-trailer-clearing';
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
