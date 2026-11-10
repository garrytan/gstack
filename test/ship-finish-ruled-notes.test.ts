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

// Value: protects=the trail names the owner approval that actually covered the fix-check (gstack-evals#244: finish named the
//   earlier fix-check's grant a-ab110530e792 for fc4, whose grant was a-eaa651ef9ed3); fails_when=finish takes the first approved
//   review_loop_grant naming any commit in range_base..commit; seam=finish's route picking the grant for the FIX_CHECK line
describe('finish names the grant that covers the counted fix-check (GST-1610)', () => {
  test('two grants at different stop heads: the line names the later fix-check\'s own grant', () => {
    const CLEAN = { completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] };
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST_V1 });
    ships.push(f);
    const passHead = f.git('rev-parse', 'HEAD').stdout.trim();
    const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    const post = path.join(f.root, 'post.json');
    expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    const grantAt = (head: string, n: string) => {
      const g = run(f, 'gstack-approvals', ['add', '--ask', `Owner grant: scoped fix-check ${n} (review_loop_grant ${head.slice(0, 12)})`, '--words', `fix-check ${n}`, '--by', 'evals minder (GEVA-2)', '--scope', 'this /ship invocation', '--json']);
      expect(g.status, g.stderr).toBe(0);
      return JSON.parse(g.stdout).added[0] as string;
    };
    const first = grantAt(passHead, 'fc3');
    f.write({ 'src/x.ts': 'export const x = 3;\n' }); f.commit('fix the fc3 blocker');
    const fc3Head = f.git('rev-parse', 'HEAD').stdout.trim();
    logFixCheck(f, { range_base: passHead, ...CLEAN });
    const second = grantAt(fc3Head, 'fc4');
    f.write({ 'test/x.test.ts': TEST_V2 }); f.commit('fix the fc4 blocker');
    const fc4Head = f.git('rev-parse', 'HEAD').stdout.trim();
    logFixCheck(f, { range_base: passHead, ...CLEAN });
    expect(first).not.toBe(second);
    const r = finish(f, reviewed, post);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check at ${fc4Head.slice(0, 12)}, range from ${passHead.slice(0, 12)}, grant ${second})`);
  });
});

// GST-1627: finish chains contiguous review-fix-check rows back to the reviewed tree. #4063 (GSTA-343): fc3 read the fix
// after round 2 (range from the stop head to 265d868), then the owner granted fc4 on the base-merge resolution (range from
// 265d868 to the merge). finish read only the newest row and required its range to start at the reviewed tree, so fc4
// unbound fc3 and the lane logged a synthetic combined row.
const TEST_V3 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(2).toBe(2); }, 2_000);\n";
const CLEAN_ROW = { completed: true, converged: true, status: 'clean', issues_found: 0, critical: 0, informational: 0, findings: [] };
const headOf = (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim();
const logLink = (f: ShipFx, rangeBase: string) => logFixCheck(f, { range_base: rangeBase, ...CLEAN_ROW });
const grantLink = (f: ShipFx, stop: string, n: string) => {
  const g = run(f, 'gstack-approvals', ['add', '--ask', `Owner grant: scoped fix-check ${n} (review_loop_grant ${stop.slice(0, 12)})`, '--words', `fix-check ${n}`, '--by', 'gstack minder (GSTA-36)', '--scope', 'this /ship invocation', '--json']);
  expect(g.status, g.stderr).toBe(0);
  return JSON.parse(g.stdout).added[0] as string;
};

/**
 * Round 2 stopped at passHead (the reviewed tree), the owner granted fc3, and fc3 read the fix to src/x.ts and its test.
 * Then the base moved src/x.ts, the merge conflicted, and the resolution is the merge commit fc4 reads.
 */
function mergeShape(o: { grantFc3?: boolean } = {}) {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST_V1 });
  ships.push(f);
  const passHead = headOf(f);
  const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
  const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  const g3 = o.grantFc3 === false ? null : grantLink(f, passHead, 'fc3');
  f.write({ 'src/x.ts': 'export const x = 3;\n', 'test/x.test.ts': TEST_V2 }); f.commit('fix the round-2 blocker');
  const fc3 = headOf(f);
  logLink(f, passHead);
  f.advanceBase({ 'src/x.ts': 'export const x = 10;\n' });
  expect(f.git('fetch', '-q', 'origin').status).toBe(0);
  expect(f.git('merge', '-q', '--no-edit', 'origin/main').status).not.toBe(0);
  f.write({ 'src/x.ts': 'export const x = 13;\n' }); f.commit('merge origin/main: resolve src/x.ts');
  const fc4 = headOf(f);
  return { f, passHead, reviewed, reviewedBase, g3, fc3, fc4 };
}
/** Step 14.5's docs audit runs on the final head, then finish. */
function finishAfterAudit(f: ShipFx, reviewed: string, reviewedBase: string) {
  const post = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  return f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--reviewed-base', reviewedBase, '--lane', LANE]);
}

describe('finish chains contiguous fix-check rows (GST-1627)', () => {
  // Value: protects=the #4063 shape binds without a synthetic row: fc3 (range from the reviewed tree) and fc4 (range from fc3's
  //   commit over the merge resolution) both count, each under its own grant; fails_when=finish reads only the newest row and refuses
  //   fc4's range_base as not the reviewed tree, so src/x.ts and the test route as behavior; seam=finish's route reading the review log
  test('#4063: fc3 at its fix, then fc4 over the merge resolution, and finish counts both', () => {
    const { f, passHead, reviewed, reviewedBase, g3, fc3, fc4 } = mergeShape();
    const g4 = grantLink(f, fc3, 'fc4');
    logLink(f, fc3);
    const r = finishAfterAudit(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check chain of 2 from ${passHead.slice(0, 12)}: at ${fc3.slice(0, 12)} grant ${g3}; at ${fc4.slice(0, 12)} grant ${g4})`);
    expect([r.status, lineOf(r.stdout, 'ROUTE')], r.stdout).toEqual([0, expect.stringMatching(/ behavior=0 .* fix_checked=2$/)]);
  });

  // Value: protects=a chain links only through each earlier fix-check's own commit: a commit between fc3 and fc4 that no fix-check
  //   read breaks it and finish refuses; fails_when=finish links rows by order alone or counts fc4 from any earlier branch commit;
  //   seam=finish's chain walk
  test('a gap in the chain refuses: fc4\'s range starts at a commit no fix-check ends at', () => {
    const { f, reviewed, reviewedBase, fc4 } = mergeShape();
    f.write({ 'src/x.ts': 'export const x = 14;\n' }); f.commit('an unread edit');
    const gap = headOf(f);
    f.write({ 'test/x.test.ts': TEST_V3 }); f.commit('the fc4 fix');
    grantLink(f, gap, 'fc4');
    logLink(f, gap);
    const r = finishAfterAudit(f, reviewed, reviewedBase);
    expect(fc4).not.toBe(gap);
    expect(lineOf(r.stdout, 'FIX_CHECK')).toBe(`FIX_CHECK: not counted (range_base ${gap.slice(0, 12)} does not hold the reviewed tree)`);
    expect([r.status, r.stdout.includes('STOP: behavior, tests or build inputs changed since review (src/x.ts,test/x.test.ts)')], r.stdout).toEqual([3, true]);
  });

  // Value: protects=every link is a granted fix-check: an earlier row the owner never granted does not ride on the later grant whose
  //   stop head is its commit; fails_when=a grant at fc3's commit counts for both fc3 and fc4; seam=finish's per-row grant match
  test('a link without its own grant refuses the chain', () => {
    const { f, reviewed, reviewedBase, fc3 } = mergeShape({ grantFc3: false });
    grantLink(f, fc3, 'fc4');
    logLink(f, fc3);
    const r = finishAfterAudit(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK')).toBe(`FIX_CHECK: not counted (no approved review_loop_grant names a stop head inside its range_base..commit; fix-check at ${fc3.slice(0, 12)}, link 1 of 2)`);
    expect(r.status).toBe(3);
  });

  // Value: protects=one owner grant covers one fix-check: a grant whose text names a stop head in each link's range counts for the
  //   newest link only; fails_when=finish matches every sha in a grant row against every link and counts one grant twice;
  //   seam=finish's per-row grant match
  test('one grant naming both links\' stop heads counts for one link, and the chain refuses', () => {
    const { f, passHead, reviewed, reviewedBase, fc3 } = mergeShape({ grantFc3: false });
    const g = run(f, 'gstack-approvals', ['add', '--ask', `Owner grant: one scoped fix-check (review_loop_grant ${passHead.slice(0, 12)}, review_loop_grant ${fc3.slice(0, 12)})`, '--words', 'one scoped fix-check', '--by', 'gstack minder (GSTA-36)', '--scope', 'this /ship invocation', '--json']);
    expect(g.status, g.stderr).toBe(0);
    logLink(f, fc3);
    const r = finishAfterAudit(f, reviewed, reviewedBase);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, `FIX_CHECK: not counted (no approved review_loop_grant names a stop head inside its range_base..commit; fix-check at ${fc3.slice(0, 12)}, link 1 of 2)`]);
  });
});

/**
 * GST-1676 (founderstar#634, FOUN-117): the post-review flow grants each fix-check at its own stop head, which is the
 * commit that fix-check reads. Link 1's grant names link 1's commit (05a0db1c) and link 2's names link 2's (9ab970db),
 * so the boundary is both link 1's stop head and link 2's range_base.
 */
function postReviewShape() {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST_V1 });
  ships.push(f);
  const passHead = headOf(f);
  const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
  const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
  f.write({ 'src/x.ts': 'export const x = 3;\n' }); f.commit('edit after the review bound');
  const link1 = headOf(f);
  return { f, passHead, reviewed, reviewedBase, link1 };
}

describe('finish counts a post-review fix-check chain whose grants name each link\'s own commit (GST-1676)', () => {
  // Value: protects=the #634 shape binds: link 1's grant names its own commit, which is also link 2's range_base, and link 2's
  //   grant names link 2's commit, so each link has its own grant and the chain counts; fails_when=finish refuses an earlier
  //   link's grant at its own commit (FIX_CHECK: not counted ... link 1 of 2) and src/x.ts routes as behavior;
  //   seam=finish's per-link grant assignment
  test('#634: two post-review links, each granted at its own commit, and finish counts the chain', () => {
    const { f, passHead, reviewed, reviewedBase, link1 } = postReviewShape();
    const g1 = grantLink(f, link1, 'fc1');
    logLink(f, passHead);
    f.write({ 'test/x.test.ts': TEST_V2 }); f.commit('a second edit after the review bound');
    const link2 = headOf(f);
    const g2 = grantLink(f, link2, 'fc2');
    logLink(f, link1);
    const r = finishAfterAudit(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check chain of 2 from ${passHead.slice(0, 12)}: at ${link1.slice(0, 12)} grant ${g1}; at ${link2.slice(0, 12)} grant ${g2})`);
    expect([r.status, lineOf(r.stdout, 'ROUTE')], r.stdout).toEqual([0, expect.stringMatching(/ behavior=0 .* fix_checked=2$/)]);
  });

  // Value: protects=a grant at the boundary still counts once: with only link 1's grant (at link 1's commit) recorded, the newer
  //   link takes it and link 1 stays ungranted; fails_when=one grant row counts for both links once an earlier link may use its
  //   own commit; seam=finish's newest-first, one-grant-per-link assignment
  test('only link 1\'s grant: it goes to the newer link, and link 1 is ungranted', () => {
    const { f, passHead, reviewed, reviewedBase, link1 } = postReviewShape();
    grantLink(f, link1, 'fc1');
    logLink(f, passHead);
    f.write({ 'test/x.test.ts': TEST_V2 }); f.commit('a second edit after the review bound');
    logLink(f, link1);
    const r = finishAfterAudit(f, reviewed, reviewedBase);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK')], r.stdout).toEqual([3, `FIX_CHECK: not counted (no approved review_loop_grant names a stop head inside its range_base..commit; fix-check at ${link1.slice(0, 12)}, link 1 of 2)`]);
  });
});

/**
 * GST-1681 (GEVA-363, gstack-evals#254): pass 1, then fc1 (round 2) at the stop the voices read, then the owner's grant at that
 * stop head buys fc2, and a second grant at fc2's commit (its stop head) buys a third round, fc3. Each in-loop grant names the
 * stop it answers, the link's own range_base.
 */
describe('finish counts a Captain-granted third fix round as a chained fix-check (GST-1681)', () => {
  // Value: protects=the GEVA-363 shape counts once fc3 is a planned fix-check: fc2 and fc3 each carry their own grant, the chain stops
  //   at fc1's tree (the reviewed tree), and the ungranted in-cap fc1 row is not a link; fails_when=finish refuses fc3 (GEVA-363
  //   printed FIX_CHECK: not counted) or asks fc1 for a grant; seam=finish's chain walk and per-link grant assignment
  test('GEVA-363: fc1 in the cap, then fc2 and fc3 under their own grants, and finish counts fc2..fc3', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n', 'test/x.test.ts': TEST_V1 });
    ships.push(f);
    const p1 = headOf(f);
    f.write({ 'src/x.ts': 'export const x = 3;\n' }); f.commit('round 1 fixes');
    const fc1 = headOf(f);
    logLink(f, p1);
    const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    const reviewedBase = f.git('merge-base', 'origin/main', 'HEAD').stdout.trim();
    const g2 = grantLink(f, fc1, 'fc2');
    f.write({ 'src/x.ts': 'export const x = 4;\n' }); f.commit('fix the voices\' CRITICAL');
    const fc2 = headOf(f);
    logLink(f, fc1);
    const g3 = grantLink(f, fc2, 'fc3');
    f.write({ 'test/x.test.ts': TEST_V2 }); f.commit('fix fc2\'s CRITICAL');
    const fc3 = headOf(f);
    logLink(f, fc2);
    const r = finishAfterAudit(f, reviewed, reviewedBase);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check chain of 2 from ${fc1.slice(0, 12)}: at ${fc2.slice(0, 12)} grant ${g2}; at ${fc3.slice(0, 12)} grant ${g3})`);
    expect([r.status, lineOf(r.stdout, 'ROUTE')], r.stdout).toEqual([0, expect.stringMatching(/ behavior=0 .* fix_checked=2$/)]);
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

// harness-evals#361 (GST-2251): round 2 stopped, the owner granted one scoped fix-check, it read the fix and found two new
// CRITICALs, so it logged converged:false (review-army decision 3.5 sends a CRITICAL to decision 2). The owner accepted both
// as disclosed notes. finish refused the row as nonconverged before reading any ruling, and the lane's review-loop exception,
// which accepts edits after a fix-check, accepted nothing, so nothing pointed at the ruling the docs name.
const NEW_A = 'src/x.ts:1:unbounded-retry';
const NEW_B = 'src/x.ts:1:lost-ack';
const HE361 = {
  completed: true, converged: false, status: 'issues_found', issues_found: 2, critical: 2, informational: 0,
  findings: [
    { fingerprint: NEW_A, severity: 'CRITICAL', action: 'open', locus: 'fix-range', blocking: true, raised_by: 'fix-check' },
    { fingerprint: NEW_B, severity: 'CRITICAL', action: 'open', locus: 'diff', blocking: true, raised_by: 'targeted' },
  ],
};
const NONCONVERGED = 'FIX_CHECK: not counted (missing start capture or incomplete/nonconverged pass)';
const openLine = (findings: string[], head: string) => `FIX_CHECK_OPEN: ${findings.join(',')} on the fix-check at ${head.slice(0, 12)}: the owner rules each one a disclosed note with gstack-approvals rule --finding <fingerprint> --head ${head.slice(0, 12)} --reason '<why>' --words '<owner\'s exact words>' --by '<owner>'; a review-loop exception accepts edits after a fix-check, never its findings (docs/troubleshooting.md#fix-check-open)`;
const exception = (head: string) => ['--review-loop-exception', JSON.stringify({ accepted_by: 'harness minder (HARN-1)', date: '2026-11-09', via: 'a-9628d51bef2d', reason: 'both ship as open notes', fix_check: { head, findings: 2 } })];
const finishLoop = (f: ShipFx, reviewed: string, post: string, head: string) => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE, ...exception(head)]);

// Value: protects=an owner's rulings close a granted fix-check's own new CRITICALs, so finish counts it at its head and lists
//   every ruling (harness-evals#361); fails_when=finish refuses the fix-check as nonconverged after both rulings, or binds with
//   one finding unruled, or never names the ruling the owner needs; seam=finish's route reading the review log and the approval
//   record; no_claim=Step 11.5's full-pass binding
describe('a granted fix-check that found new CRITICALs the owner accepted (harness-evals#361, GST-2251)', () => {
  test('#361: finish names the open findings, then binds at the fix-check head once the owner rules both', () => {
    const { f, passHead, fixHead, reviewed, post, grant } = grantedFixCheck(HE361);
    const before = finishLoop(f, reviewed, post, fixHead);
    expect([before.status, lineOf(before.stdout, 'FIX_CHECK'), lineOf(before.stdout, 'FIX_CHECK_OPEN')]).toEqual([3, NONCONVERGED, openLine([NEW_A, NEW_B], fixHead)]);
    expect(lineOf(before.stdout, 'REVIEW_LOOP_EXCEPTION')).toStartWith(`REVIEW_LOOP_EXCEPTION: accepted none (changed since fix-check ${fixHead.slice(0, 12)}`);
    for (const finding of [NEW_A, NEW_B]) expect(rule(f, finding, fixHead, 'harness minder (HARN-1)').status).toBe(0);
    const r = finishLoop(f, reviewed, post, fixHead);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toBe(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check at ${fixHead.slice(0, 12)}, range from ${passHead.slice(0, 12)}, grant ${grant})`);
    expect(lineOf(r.stdout, 'FIX_CHECK_OPEN')).toBe('');
    expect(r.stdout.split('\n').filter(l => l.startsWith('RULED_NOTE: '))).toEqual([NEW_A, NEW_B].map(x => expect.stringMatching(new RegExp(`^RULED_NOTE: ${x} at ${fixHead.slice(0, 12)} ruled by harness minder \\(HARN-1\\) at .*\\(approval a-[0-9a-f]{12}\\)$`))));
    expect(r.status, r.stdout).toBe(0);
    const listed = run(f, 'gstack-approvals', ['rulings']).stdout.trim().split('\n');
    expect(listed).toEqual([NEW_A, NEW_B].map(x => expect.stringMatching(new RegExp(`^Ruled note: ${x} at ${fixHead.slice(0, 12)} ruled by harness minder`))));
  });

  test('one ruling of two leaves the fix-check uncounted and names the finding still open', () => {
    const { f, fixHead, reviewed, post } = grantedFixCheck(HE361);
    expect(rule(f, NEW_A, fixHead).status).toBe(0);
    const r = finishLoop(f, reviewed, post, fixHead);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK'), lineOf(r.stdout, 'FIX_CHECK_OPEN')]).toEqual([3, NONCONVERGED, openLine([NEW_B], fixHead)]);
  });

  test('the lane\'s own claim rules nothing, and a ruling at a head outside the fix-check\'s range closes nothing', () => {
    const claimed = { ...HE361, findings: HE361.findings.map(x => ({ ...x, ruled: 'note', ruled_by: 'harness minder (HARN-1)', approval: 'a-9628d51bef2d' })) };
    const { f, fixHead, reviewed, post } = grantedFixCheck(claimed);
    expect(lineOf(finishLoop(f, reviewed, post, fixHead).stdout, 'FIX_CHECK')).toBe(NONCONVERGED);
    const mergeBase = f.git('merge-base', 'main', 'HEAD').stdout.trim();
    for (const finding of [NEW_A, NEW_B]) expect(rule(f, finding, mergeBase).status).toBe(0);
    const r = finishLoop(f, reviewed, post, fixHead);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK'), lineOf(r.stdout, 'FIX_CHECK_OPEN')]).toEqual([3, NONCONVERGED, openLine([NEW_A, NEW_B], fixHead)]);
    expect(r.stdout.split('\n').filter(l => l.startsWith('RULED_NOTE: ')).every(l => l.endsWith(" (outside this fix-check's range; not applied)"))).toBe(true);
  });

  test('an open INFORMATIONAL beside the two ruled CRITICALs keeps the fix-check uncounted and is named, then binds once ruled', () => {
    const NEW_C = 'src/x.ts:1:retry-log';
    const row = { ...HE361, issues_found: 3, critical: 2, informational: 1, findings: [...HE361.findings, { fingerprint: NEW_C, severity: 'INFORMATIONAL', action: 'open', locus: 'diff', blocking: false, raised_by: 'fix-check' }] };
    const { f, fixHead, reviewed, post } = grantedFixCheck(row);
    for (const finding of [NEW_A, NEW_B]) expect(rule(f, finding, fixHead).status).toBe(0);
    const before = finishLoop(f, reviewed, post, fixHead);
    expect([before.status, lineOf(before.stdout, 'FIX_CHECK'), lineOf(before.stdout, 'FIX_CHECK_OPEN')]).toEqual([3, NONCONVERGED, openLine([NEW_C], fixHead)]);
    expect(rule(f, NEW_C, fixHead).status).toBe(0);
    const r = finishLoop(f, reviewed, post, fixHead);
    expect(lineOf(r.stdout, 'FIX_CHECK'), r.stdout).toStartWith(`FIX_CHECK: reviewed src/x.ts,test/x.test.ts (fix-check at ${fixHead.slice(0, 12)}`);
    expect(lineOf(r.stdout, 'FIX_CHECK_OPEN')).toBe('');
    expect(r.status, r.stdout).toBe(0);
  });

  // Value: protects=nothing binds without an owner row: a skipped non-CRITICAL finding the reader marked blocking stays open
  //   beside a ruled open CRITICAL; fails_when=the ruled CRITICAL clears the row while the skipped blocker has no ruling;
  //   seam=withoutRuledNotes and FIX_CHECK_OPEN
  test('a skipped blocking finding with no ruling keeps the row unbound beside a ruled open CRITICAL, and is named', () => {
    const SKIPPED = 'src/x.ts:1:skipped-blocker';
    const row = { ...HE361, issues_found: 2, critical: 1, informational: 1, findings: [HE361.findings[0], { fingerprint: SKIPPED, severity: 'INFORMATIONAL', action: 'skipped', locus: 'fix-range', blocking: true, raised_by: 'fix-check' }] };
    const { f, fixHead, reviewed, post } = grantedFixCheck(row);
    expect(rule(f, NEW_A, fixHead).status).toBe(0);
    const r = finishLoop(f, reviewed, post, fixHead);
    expect([r.status, lineOf(r.stdout, 'FIX_CHECK'), lineOf(r.stdout, 'FIX_CHECK_OPEN')]).toEqual([3, NONCONVERGED, openLine([SKIPPED], fixHead)]);
  });

  test('an edit after the fix-check head still routes as behavior without an exception that accepts it', () => {
    const { f, fixHead, reviewed, post } = grantedFixCheck(HE361);
    for (const finding of [NEW_A, NEW_B]) expect(rule(f, finding, fixHead).status).toBe(0);
    f.write({ 'src/x.ts': 'export const x = 4;\n' }); f.commit('edit after the fix-check');
    const r = finish(f, reviewed, post);
    expect(r.status).toBe(3);
    expect(lineOf(r.stdout, 'FIX_CHECK')).toStartWith('FIX_CHECK: reviewed test/x.test.ts (fix-check at');
    expect(r.stdout).toContain('STOP: behavior, tests or build inputs changed since review (src/x.ts)');
  });
});
