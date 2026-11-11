/**
 * Owner gate dispositions (GST-2491, founderstar#906 at 3a273935b): an unattended /ship logs every gate finding `open`
 * (gstack-review-log), and only the owner's `gstack-approvals gate` row, at that fingerprint and a head inside the review
 * row's range, closes it. Rulings, the lane's own review-log claims and rows recorded inside the open /ship run close nothing,
 * and every disposition is printed by finish and carried by the receipt, the PR body and READY.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, readyTailLines } from '../lib/ship-receipt';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const GATE = 'tests/balance.test.ts:3:gate-integrity';
const OTHER = 'tests/balance.test.ts:9:gate-integrity';
const WORDS = 'Do it';
const REASON = 'fed-careless gate allows 6 of 48 seeds';
const BY = 'Founderstar Captain (FOUN-1)';
const TEST_V1 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(4).toBeLessThanOrEqual(4); });\n";
const TEST_V2 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(4).toBeLessThanOrEqual(6); });\n";
/** The founderstar#906 review row: one RH-15 gate finding an unattended session logs open, and a below-floor note. */
const gateRow = (extra: Record<string, unknown> = {}) => ({
  completed: true, converged: true, status: 'issues_found', issues_found: 1, critical: 1, informational: 0,
  findings: [
    { fingerprint: GATE, severity: 'CRITICAL', locus: 'diff', kind: 'defect', blocking: true, raised_by: 'core', gate: 'RH-15', gate_id: '69c7c3432501', action: 'kept', reason: 'owner approved', ...extra },
    { fingerprint: 'src/x.ts:1:naming', severity: 'INFORMATIONAL', action: 'noted', blocking: false, raised_by: 'red-team' },
  ],
});
const NOT_CLEAN = 'FIX_CHECK: not counted (review has unresolved findings or did not finish clean)';

const run = (f: ShipFx, bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
const gate = (f: ShipFx, finding: string, head: string, o: { words?: string; by?: string; reason?: string } = {}) =>
  run(f, 'gstack-approvals', ['gate', '--finding', finding, '--head', head, '--reason', o.reason ?? REASON, '--words', o.words ?? WORDS, '--by', o.by ?? BY]);
const log = (f: ShipFx, skill: string, row: Record<string, unknown>) => {
  const env = { GSTACK_APPROVALS_MIRROR: '0', GSTACK_SESSION_KIND: 'unattended' };
  const start = f.run(path.join(BIN, 'gstack-review-log'), ['--start', skill], env);
  expect(start.status, start.stderr).toBe(0);
  const logged = f.run(path.join(BIN, 'gstack-review-log'), [JSON.stringify({ skill, timestamp: '2026-11-11T20:30:13Z', via: 'ship', review_scope: 'frozen', ...row }), '--finish', start.stdout.trim()], env);
  expect(logged.status, logged.stderr).toBe(0);
};
/** The newest row of a skill as gstack-review-read prints it. */
const read = (f: ShipFx, skill = 'review') => run(f, 'gstack-review-read', []).stdout.split('\n---CONFIG---')[0]!.split('\n')
  .flatMap(l => { try { const v = JSON.parse(l); return v?.skill === skill ? [v] : []; } catch { return []; } }).at(-1);

/** Pass 1 read the gate change at its commit and logged the gate finding open (unattended). */
function firstPass(extra: Record<string, unknown> = {}, rowExtra: Record<string, unknown> = {}) {
  const f = shipFixture({ 'tests/balance.test.ts': TEST_V1 }, { 'tests/balance.test.ts': TEST_V2 });
  ships.push(f);
  log(f, 'review', { pass: 1, range_base: null, ...gateRow(extra), ...rowExtra });
  return { f, head: f.git('rev-parse', 'HEAD').stdout.trim(), mergeBase: f.git('merge-base', 'main', 'HEAD').stdout.trim() };
}

// Value: protects=founderstar#906: an owner-approved gate change finishes unattended once the owner's disposition is recorded,
//   and only then; fails_when=the row still reads UNVERIFIED with a matching gate_disposition row, or reads CURRENT without one;
//   seam=gstack-approvals gate, gstack-review-read and lib/gate-dispositions.ts on the stored review row; no_claim=the review
//   plan's flags, which /ship derives from this row
describe('a recorded owner disposition closes an unattended gate finding (GST-2491)', () => {
  test('the logger keeps it open, and a matching gate row closes it on the review row', () => {
    const { f, head } = firstPass();
    const before = read(f);
    expect(before.findings[0]).toMatchObject({ action: 'open', actor: 'unattended' });
    expect([before.review_freshness.status, before.gate_dispositions]).toEqual(['UNVERIFIED', undefined]);
    const rec = gate(f, GATE, head);
    expect([rec.status, rec.stdout]).toEqual([0, expect.stringMatching(/^APPROVAL_RECORDED: a-[0-9a-f]{12} /)]);
    const after = read(f);
    expect([after.review_freshness.status, after.gate_dispositions]).toEqual(['CURRENT', [GATE]]);
    expect(run(f, 'gstack-approvals', ['dispositions']).stdout).toMatch(new RegExp(`^Gate disposition: ${GATE} at ${head.slice(0, 12)} by Founderstar Captain \\(FOUN-1\\) at \\d{4}-\\d\\d-\\d\\dT[^ ]+Z: ${REASON} — "Do it" \\(approval a-[0-9a-f]{12}\\)\\n$`));
  });

  test('negative controls stay open: no row, another fingerprint, a head outside the range, a ruling, a gstack row', () => {
    const { f, head, mergeBase } = firstPass();
    const open = () => [read(f).review_freshness.status, read(f).gate_dispositions];
    expect(open()).toEqual(['UNVERIFIED', undefined]);
    expect(gate(f, OTHER, head).status).toBe(0);
    expect(open()).toEqual(['UNVERIFIED', undefined]);
    expect(gate(f, GATE, mergeBase).status).toBe(0);
    expect(open()).toEqual(['UNVERIFIED', undefined]);
    const ruling = run(f, 'gstack-approvals', ['rule', '--finding', GATE, '--head', head, '--reason', REASON, '--words', WORDS, '--by', BY]);
    expect(ruling.status).toBe(0);
    expect(open()).toEqual(['UNVERIFIED', undefined]);
    const self = gate(f, GATE, head, { by: 'gstack no-stop default (K1)' });
    expect([self.status, self.stderr]).toEqual([EXIT.usage, expect.stringContaining('--by names gstack')]);
    expect(open()).toEqual(['UNVERIFIED', undefined]);
  });

  test('a later head is outside a first pass too: the owner answers at the commit the review read', () => {
    const { f } = firstPass();
    f.write({ 'README.md': '# Fx later\n' }); f.commit('later');
    expect(gate(f, GATE, f.git('rev-parse', 'HEAD').stdout.trim()).status).toBe(0);
    expect(read(f).review_freshness.status).not.toBe('CURRENT');
    expect(read(f).gate_dispositions).toBeUndefined();
  });

  test('gate refuses a call inside the open /ship run, empty or multi-line words, and add with the scope', () => {
    const { f, head } = firstPass();
    const marker = path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    fs.writeFileSync(marker, 'ship-906-3a27393\n');
    const inRun = gate(f, GATE, head);
    expect([inRun.status, inRun.stderr]).toEqual([EXIT.usage, expect.stringContaining('/ship run ship-906-3a27393 is open on this checkout')]);
    fs.rmSync(marker);
    for (const words of ['', '   ']) {
      const empty = gate(f, GATE, head, { words });
      expect([empty.status, empty.stderr]).toEqual([EXIT.usage, expect.stringContaining('--words')]);
    }
    const lines = gate(f, GATE, head, { words: 'Do it\nand more' });
    expect([lines.status, lines.stderr]).toEqual([EXIT.usage, expect.stringContaining('one line')]);
    const add = run(f, 'gstack-approvals', ['add', '--ask', `gate_disposition ${GATE} at ${head}: ${REASON}`, '--words', WORDS, '--by', BY, '--scope', `gate_disposition ${GATE} ${head}`]);
    expect([add.status, add.stderr]).toEqual([EXIT.usage, expect.stringContaining('gstack-approvals gate')]);
    expect(run(f, 'gstack-approvals', ['dispositions']).stdout).toBe('GATE_DISPOSITIONS: none\n');
    expect(read(f).review_freshness.status).toBe('UNVERIFIED');
  });

  test('the lane\'s own review-log claim closes nothing', () => {
    const { f, head } = firstPass({ gate_disposition: 'a-6dcd9c1d8fad', approval: 'a-6dcd9c1d8fad', disposition_by: BY }, { gate_dispositions: [GATE] });
    const row = read(f);
    expect([row.findings[0].action, row.review_freshness.status, row.gate_dispositions]).toEqual(['open', 'UNVERIFIED', undefined]);
    expect(run(f, 'gstack-approvals', ['add', '--ask', `Owner approved the gate change at ${head}`, '--words', WORDS, '--by', BY, '--scope', 'this gate edit']).status).toBe(0);
    expect(read(f).review_freshness.status).toBe('UNVERIFIED');
  });
});

/** Round 2 stopped at passHead, the owner granted one scoped fix-check, and the fix-check logged the gate finding open. */
function grantedFixCheck() {
  const f = shipFixture({ 'tests/balance.test.ts': TEST_V1 }, { 'src/x.ts': 'export const x = 2;\n', 'tests/balance.test.ts': TEST_V1 });
  ships.push(f);
  const passHead = f.git('rev-parse', 'HEAD').stdout.trim();
  const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
  f.write({ 'src/x.ts': 'export const x = 3;\n', 'tests/balance.test.ts': TEST_V2 }); f.commit('raise the fed-careless gate');
  const post = path.join(f.root, 'post.json');
  expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
  expect(run(f, 'gstack-approvals', ['add', '--ask', `Owner grant: one scoped fix-check after round 2 (review_loop_grant ${passHead.slice(0, 12)})`, '--words', 'one scoped fix-check', '--by', BY, '--scope', 'this /ship invocation']).status).toBe(0);
  log(f, 'review-fix-check', { range_base: passHead, ...gateRow() });
  const fin = () => f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
  return { f, passHead, fixHead: f.git('rev-parse', 'HEAD').stdout.trim(), fin };
}
const dispositionLines = (out: string) => out.split('\n').filter(l => l.startsWith('GATE_DISPOSITION: '));

// Value: protects=finish counts a fix-check whose only blocker is an owner-dispositioned gate finding and prints the disposition
//   word for word; a ruling or an out-of-range disposition leaves it uncounted and says not applied; fails_when=finish ignores
//   gate dispositions, honours a ruling for a gate finding, or hides a disposition; seam=finish's fixChecked route
describe('finish with a gate disposition (GST-2491)', () => {
  test('a disposition at the stop head closes the fix-check\'s gate finding, and finish prints it', () => {
    const { f, passHead, fixHead, fin } = grantedFixCheck();
    expect(lineOf(fin().stdout, 'FIX_CHECK')).toBe(NOT_CLEAN);
    expect(run(f, 'gstack-approvals', ['rule', '--finding', GATE, '--head', passHead, '--reason', REASON, '--words', WORDS, '--by', BY]).status).toBe(0);
    expect(lineOf(fin().stdout, 'FIX_CHECK')).toBe(NOT_CLEAN);
    expect(gate(f, GATE, f.git('merge-base', 'main', 'HEAD').stdout.trim()).status).toBe(0);
    const early = fin();
    expect(lineOf(early.stdout, 'FIX_CHECK')).toBe(NOT_CLEAN);
    expect(dispositionLines(early.stdout)).toEqual([expect.stringMatching(/; not applied\)$/)]);
    expect(gate(f, GATE, passHead).status).toBe(0);
    const r = fin();
    expect(lineOf(r.stdout, 'FIX_CHECK')).toStartWith(`FIX_CHECK: reviewed src/x.ts,tests/balance.test.ts (fix-check at ${fixHead.slice(0, 12)}, range from ${passHead.slice(0, 12)}`);
    expect(dispositionLines(r.stdout)).toEqual([
      expect.stringMatching(/; not applied\)$/),
      expect.stringMatching(new RegExp(`^GATE_DISPOSITION: ${GATE} at ${passHead.slice(0, 12)} by Founderstar Captain \\(FOUN-1\\) at [^ ]+Z: ${REASON} — "Do it" \\(approval a-[0-9a-f]{12}\\)$`)),
    ]);
  });

  // Value: protects=nothing dispositioned is hidden (R73): the receipt records every gate disposition, write refuses a PR body
  //   without each line word for word, and READY prints it; fails_when=write drops it or accepts a body without it;
  //   seam=gstack-ship-receipt write and readyTailLines
  test('the receipt records every disposition, write refuses a body without its line, and READY prints it', () => {
    const { f, head } = firstPass();
    expect(gate(f, GATE, head).status).toBe(0);
    const line = run(f, 'gstack-approvals', ['dispositions']).stdout.trim();
    const body = path.join(f.root, 'body.md');
    const write = () => f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '906', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], { GSTACK_APPROVALS_MIRROR: '0' });
    fs.writeFileSync(body, '## Pre-Landing Review\n\nGate edits: 1 listed, 1 read, 1 findings — 1 kept, 0 restored, 0 open\n');
    const short = write();
    expect([short.status, short.stderr]).toEqual([EXIT.fail, expect.stringContaining(`does not list gate disposition ${JSON.stringify(line)}`)]);
    fs.writeFileSync(body, `## Pre-Landing Review\n\n${line}\n`);
    const ok = write();
    expect(ok.status, ok.stderr).toBe(EXIT.ok);
    const receipt = extractReceipt(ok.stdout);
    expect(receipt.errors).toEqual([]);
    expect(receipt.receipt?.gate_dispositions).toEqual([{ finding: GATE, head, by: BY, reason: REASON, words: WORDS, at: expect.stringMatching(/Z$/), approval: expect.stringMatching(/^a-[0-9a-f]{12}$/) }]);
    expect(readyTailLines(receipt.receipt).filter(l => l.startsWith('GATE_DISPOSITION: '))).toEqual([`GATE_DISPOSITION: ${line.slice('Gate disposition: '.length)}`]);
  });
});
