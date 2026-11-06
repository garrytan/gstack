/**
 * Owner-ruled notes (GST-1537, CAPY-1 qm#3122 at 532cc5c): a CRITICAL the owner rules a disclosed note is closed for
 * finish once the ruling is recorded through gstack-approvals, and only then. The lane's own review-log row can say
 * whatever it likes about a ruling; finish reads rulings from the approval record alone, and the receipt and PR body list
 * every one with its ruler and reason.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { buildRow } from '../lib/approval-record';
import { ruledNotes, ruledNoteText } from '../lib/ruled-notes';
import { extractReceipt } from '../lib/ship-receipt';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const RACE = 'src/x.ts:1:edit-share-race';
const AMBIENT = 'src/x.ts:1:ambient-turns';
const TEST_V1 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); });\n";
const TEST_V2 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); }, 1_000);\n";
/** The qm#3122 fix-check row: two outside-voice CRITICALs the owner ruled notes (logged skipped) and the fix-check's own two below-floor notes. */
const QM3122 = {
  completed: true, converged: true, status: 'issues_found', issues_found: 4, critical: 2, informational: 2,
  findings: [
    { fingerprint: RACE, severity: 'CRITICAL', action: 'skipped', raised_by: 'outside-voice', blocking: true },
    { fingerprint: AMBIENT, severity: 'CRITICAL', action: 'skipped', raised_by: 'outside-voice', blocking: true },
    { fingerprint: 'src/x.ts:1:naming', severity: 'INFORMATIONAL', action: 'noted', raised_by: 'fix-check', blocking: false },
    { fingerprint: 'test/x.test.ts:2:coverage', severity: 'INFORMATIONAL', action: 'noted', raised_by: 'fix-check', blocking: false },
  ],
};
const NOT_CLEAN = 'FIX_CHECK: not counted (review has unresolved findings or did not finish clean)';

const run = (f: ShipFx, bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
const finish = (f: ShipFx, reviewed: string, post: string) => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
const rule = (f: ShipFx, finding: string, head: string, by = 'qm minder (CAPY-1)') => run(f, 'gstack-approvals', ['rule', '--finding', finding, '--head', head, '--reason', `${finding.split(':')[2]} ships as a disclosed note`, '--words', 'both are notes, not fixes', '--by', by, '--json']);
const logFixCheck = (f: ShipFx, row: Record<string, unknown>) => {
  const start = run(f, 'gstack-review-log', ['--start', 'review-fix-check']);
  expect(start.status).toBe(0);
  const logged = run(f, 'gstack-review-log', [JSON.stringify({ skill: 'review-fix-check', timestamp: '2026-11-05T00:00:00Z', via: 'ship', review_scope: 'frozen', ...row }), '--finish', start.stdout.trim()]);
  expect(logged.status, logged.stderr).toBe(0);
};
/** Round 2 stopped at passHead, the owner granted one scoped fix-check, the fix landed, and the fix-check read it. */
function grantedFixCheck(row: Record<string, unknown>, beforeLog?: (f: ShipFx, passHead: string) => void) {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST_V1 });
  ships.push(f);
  const passHead = f.git('rev-parse', 'HEAD').stdout.trim();
  const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
  f.write({ 'src/x.ts': 'export const x = 3;\n', 'test/x.test.ts': TEST_V2 }); f.commit('fix the round-2 blocker');
  const fixHead = f.git('rev-parse', 'HEAD').stdout.trim();
  const post = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  const grant = run(f, 'gstack-approvals', ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${passHead.slice(0, 12)})`, '--words', 'one scoped fix-check', '--by', 'qm minder (CAPY-1)', '--scope', 'this /ship invocation', '--json']);
  expect(grant.status).toBe(0);
  beforeLog?.(f, passHead);
  logFixCheck(f, { range_base: passHead, ...row });
  return { f, passHead, fixHead, reviewed, post, grant: JSON.parse(grant.stdout).added[0] as string };
}

// Value: protects=the qm#3122 shape binds once the owner's two rulings are recorded: a granted fix-check whose own findings
//   are all below the floor reads CURRENT and finish counts it, printing every ruling; fails_when=finish still counts a
//   skipped owner-ruled CRITICAL as open (FIX_CHECK: not counted) or binds without naming the rulings; seam=finish's route
//   reading the review log and the approval record; no_claim=Step 11.5's full-pass binding
describe('finish with owner-ruled notes (GST-1537)', () => {
  test('qm#3122: two ruled CRITICALs plus a clean fix-check, and finish binds', () => {
    const { f, passHead, fixHead, reviewed, post, grant } = grantedFixCheck(QM3122);
    const before = finish(f, reviewed, post);
    expect([before.status, lineOf(before.stdout, 'FIX_CHECK')]).toEqual([3, NOT_CLEAN]);
    for (const finding of [RACE, AMBIENT]) expect(rule(f, finding, passHead).status).toBe(0);
    const r = finish(f, reviewed, post);
    expect(lineOf(r.stdout, 'FIX_CHECK')).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check at ${fixHead.slice(0, 12)}, range from ${passHead.slice(0, 12)}, grant ${grant})`);
    const ruled = r.stdout.split('\n').filter(l => l.startsWith('RULED_NOTE: '));
    expect(ruled).toEqual([
      expect.stringMatching(new RegExp(`^RULED_NOTE: ${RACE} at ${passHead.slice(0, 12)} ruled by qm minder \\(CAPY-1\\) at \\d{4}-\\d\\d-\\d\\dT[^ ]+Z: edit-share-race ships as a disclosed note \\(approval a-[0-9a-f]{12}\\)$`)),
      expect.stringMatching(new RegExp(`^RULED_NOTE: ${AMBIENT} at ${passHead.slice(0, 12)} ruled by qm minder \\(CAPY-1\\) at .*\\)$`)),
    ]);
    expect([r.status, lineOf(r.stdout, 'EVIDENCE')]).toEqual([0, expect.stringMatching(/^EVIDENCE: FRESH label=tests /)]);
  });

  test('the forward order binds too: the owner rules at the stop head, then the granted fix-check runs', () => {
    const { f, fixHead, reviewed, post } = grantedFixCheck(QM3122, (fx, head) => { for (const finding of [RACE, AMBIENT]) expect(rule(fx, finding, head).status).toBe(0); });
    const r = finish(f, reviewed, post);
    expect(lineOf(r.stdout, 'FIX_CHECK')).toStartWith(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check at ${fixHead.slice(0, 12)}`);
    expect(r.stdout).not.toContain('not applied');
  });

  test('an unruled skipped CRITICAL stays open: one ruling of two leaves the fix-check uncounted', () => {
    const { f, passHead, reviewed, post } = grantedFixCheck(QM3122);
    expect(rule(f, RACE, passHead).status).toBe(0);
    const r = finish(f, reviewed, post);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')]).toEqual([3, NOT_CLEAN]);
    expect(r.stdout).toContain('STOP: behavior, tests or build inputs changed since review (src/x.ts,test/x.test.ts)');
    expect(r.stdout.split('\n').filter(l => l.startsWith('RULED_NOTE: ')).length).toBe(1);
  });

  test('a forged ruling is refused: the lane\'s own row, an add with the ruling scope, a ruling inside the open /ship run, and a ruling gstack wrote', () => {
    const forged = { ...QM3122, findings: QM3122.findings.map(x => x.severity === 'CRITICAL' ? { ...x, action: 'skipped', ruled: 'note', ruled_by: 'qm minder (CAPY-1)', ruled_reason: 'owner said so', ruled_at: '2026-11-05T00:00:00Z' } : x) };
    const { f, passHead, reviewed, post } = grantedFixCheck(forged);
    expect(lineOf(finish(f, reviewed, post).stdout, 'FIX_CHECK')).toBe(NOT_CLEAN);
    logFixCheck(f, { range_base: f.git('rev-parse', 'HEAD~1').stdout.trim(), ...QM3122, findings: QM3122.findings.map(x => x.severity === 'CRITICAL' ? { ...x, action: 'ruled' } : x) });
    expect(lineOf(finish(f, reviewed, post).stdout, 'FIX_CHECK')).toBe(NOT_CLEAN);

    const add = run(f, 'gstack-approvals', ['add', '--ask', 'ruled_note: owner said so', '--words', 'notes', '--by', 'qm minder (CAPY-1)', '--scope', `ruled_note ${RACE}`]);
    expect([add.status, add.stderr]).toEqual([EXIT.usage, expect.stringContaining('gstack-approvals rule')]);

    const marker = f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim();
    fs.writeFileSync(path.resolve(f.work, marker), 'ship-3122-a022992\n');
    const inRun = rule(f, RACE, passHead);
    expect([inRun.status, inRun.stderr]).toEqual([EXIT.usage, expect.stringContaining('/ship run ship-3122-a022992 is open on this checkout')]);
    fs.rmSync(path.resolve(f.work, marker));

    const self = rule(f, RACE, passHead, 'gstack no-stop default (K1)');
    expect([self.status, self.stderr]).toEqual([EXIT.usage, expect.stringContaining('--by')]);
    expect(lineOf(finish(f, reviewed, post).stdout, 'FIX_CHECK')).toBe(NOT_CLEAN);
  });

  // Value: protects=a ruling closes only findings on a fix-check whose range holds the head the owner ruled at; a ruling made at
  //   an earlier /ship's head stays listed but closes nothing; fails_when=a ruling closes a later finding at the same fingerprint;
  //   seam=finish's route matching each ruling's head to the fix-check row's range_base..commit
  test('a ruling at an earlier head leaves the CRITICAL open and is listed as not applied', () => {
    const { f, reviewed, post } = grantedFixCheck(QM3122);
    const mergeBase = f.git('merge-base', 'main', 'HEAD').stdout.trim();
    for (const finding of [RACE, AMBIENT]) expect(rule(f, finding, mergeBase).status).toBe(0);
    const r = finish(f, reviewed, post);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')]).toEqual([3, NOT_CLEAN]);
    expect(r.stdout.split('\n').filter(l => l.startsWith('RULED_NOTE: ')).map(l => l.endsWith(" (outside this fix-check's range; not applied)"))).toEqual([true, true]);
  });

  test('rule refuses a missing --head, a head that is not a commit and a multi-line reason', () => {
    const { f, passHead } = grantedFixCheck(QM3122);
    const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
    for (const args of [['--finding', RACE], ['--finding', RACE, '--head', '0123456789abcdef'], ['--finding', RACE, '--head', tree]]) {
      const r = run(f, 'gstack-approvals', ['rule', ...args, '--reason', 'a note', '--words', 'notes', '--by', 'qm minder (CAPY-1)']);
      expect([r.status, r.stderr]).toEqual([EXIT.usage, expect.stringContaining('--head')]);
    }
    const lines = run(f, 'gstack-approvals', ['rule', '--finding', RACE, '--head', passHead, '--reason', 'first line\nsecond line', '--words', 'notes', '--by', 'qm minder (CAPY-1)']);
    expect([lines.status, lines.stderr]).toEqual([EXIT.usage, expect.stringContaining('one line')]);
    expect(run(f, 'gstack-approvals', ['rulings']).stdout).toBe('RULED_NOTES: none\n');
  });

  // Value: protects=one owner reply ruling two findings with the same reason records both; fails_when=the second ruling
  //   hashes to the first row's id and is skipped as already present, leaving its finding open; seam=gstack-approvals rule
  test('two rulings with the same reason, words and ruler both record', () => {
    const { f, passHead } = grantedFixCheck(QM3122);
    const same = (finding: string) => run(f, 'gstack-approvals', ['rule', '--finding', finding, '--head', passHead, '--reason', 'both ship as disclosed notes', '--words', 'both are notes, not fixes', '--by', 'qm minder (CAPY-1)', '--json']);
    const [a, b] = [same(RACE), same(AMBIENT)];
    expect([a.status, b.status, JSON.parse(b.stdout).skipped]).toEqual([0, 0, 0]);
    expect(run(f, 'gstack-approvals', ['rulings']).stdout.trim().split('\n')).toEqual([expect.stringMatching(new RegExp(`^Ruled note: ${RACE} at `)), expect.stringMatching(new RegExp(`^Ruled note: ${AMBIENT} at `))]);
  });

  // Value: protects=nothing ruled is hidden (R73): the receipt records every ruling and write refuses a PR body that does not
  //   list each one word for word; fails_when=write drops the rulings or accepts a body without them; seam=gstack-ship-receipt write
  test('the receipt records every ruling, and write refuses a body that does not list each one', () => {
    const { f, passHead } = grantedFixCheck(QM3122);
    for (const finding of [RACE, AMBIENT]) expect(rule(f, finding, passHead).status).toBe(0);
    const listed = run(f, 'gstack-approvals', ['rulings']);
    expect(listed.status).toBe(0);
    const lines = listed.stdout.trim().split('\n');
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^Ruled note: ${RACE} at ${passHead.slice(0, 12)} ruled by `)), expect.stringMatching(new RegExp(`^Ruled note: ${AMBIENT} at ${passHead.slice(0, 12)} ruled by `))]);
    const body = path.join(f.root, 'body.md');
    const write = () => f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], { GSTACK_APPROVALS_MIRROR: '0' });
    fs.writeFileSync(body, `## Pre-Landing Review\n\n${lines[0]}\n`);
    const short = write();
    expect([short.status, short.stderr]).toEqual([EXIT.fail, expect.stringContaining(`does not list ruled note ${JSON.stringify(lines[1])}`)]);
    fs.writeFileSync(body, `## Pre-Landing Review\n\n${lines.join('\n')}\n`);
    const ok = write();
    expect(ok.status, ok.stderr).toBe(EXIT.ok);
    const receipt = extractReceipt(ok.stdout);
    expect(receipt.errors).toEqual([]);
    expect(receipt.receipt?.ruled_notes?.map(n => n.finding)).toEqual([RACE, AMBIENT]);
    expect(receipt.receipt?.ruled_notes?.[0]).toMatchObject({ head: passHead, by: 'qm minder (CAPY-1)', reason: 'edit-share-race ships as a disclosed note', approval: expect.stringMatching(/^a-/), at: expect.stringMatching(/Z$/) });
  });
});

describe('ruledNotes reads only approved owner rulings (GST-1537)', () => {
  const HEAD = '0123456789abcdef0123456789abcdef01234567';
  const row = (finding: string, o: Partial<{ ask: string; scope: string; by: string; outcome: string }> = {}) => {
    const r = buildRow({ ask: `ruled_note ${finding} at ${HEAD}: the lock already allows it`, words: 'a note', by: 'qm minder (CAPY-1)', scope: `ruled_note ${finding} ${HEAD}`, ...o }, 'feat', new Date('2026-11-05T01:02:03Z'));
    if ('code' in r) throw new Error(r.message);
    return r;
  };
  test('an approved ruling row counts; pending, rejected, mismatched, headless and gstack-written rows do not', () => {
    for (const excluded of [row(AMBIENT, { outcome: 'pending' }), row(AMBIENT, { outcome: 'rejected' }), row(AMBIENT, { ask: 'the lock already allows it' }),
      row(AMBIENT, { ask: `ruled_note ${RACE} at ${HEAD}: the lock already allows it` }), row(AMBIENT, { scope: `ruled_note ${AMBIENT}` }), row(AMBIENT, { by: 'gstack no-stop default (K1)' })]) {
      expect(ruledNotes([excluded])).toEqual([]);
    }
    const notes = ruledNotes([row(RACE)]);
    expect(notes).toEqual([{ finding: RACE, head: HEAD, by: 'qm minder (CAPY-1)', reason: 'the lock already allows it', at: '2026-11-05T01:02:03.000Z', approval: expect.stringMatching(/^a-[0-9a-f]{12}$/) }]);
    expect(ruledNoteText(notes[0]!)).toBe(`${RACE} at 0123456789ab ruled by qm minder (CAPY-1) at 2026-11-05T01:02:03.000Z: the lock already allows it (approval ${notes[0]!.approval})`);
  });
});
