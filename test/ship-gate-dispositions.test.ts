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
import { spawnSync } from 'node:child_process';
import { buildRow, locate, type ApprovalRow, type StoreLocation } from '../lib/approval-record';
import { GATE_SOURCE, gateDispositionDigest, gateDispositionRow } from '../lib/gate-dispositions';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const GATE = 'tests/balance.test.ts:3:gate-integrity';
const OTHER = 'tests/balance.test.ts:9:gate-integrity';
const GATE_ID = '69c7c3432501';
const WORDS = 'Do it';
const REASON = 'fed-careless gate allows 6 of 48 seeds';
const BY = 'Founderstar Captain (FOUN-1)';
const TEST_V1 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(4).toBeLessThanOrEqual(4); });\n";
const TEST_V2 = "import { expect, test } from 'bun:test';\ntest('a', () => { expect(4).toBeLessThanOrEqual(6); });\n";
/** The founderstar#906 review row: one RH-15 gate finding an unattended session logs open, and a below-floor note. */
const gateRow = (extra: Record<string, unknown> = {}) => ({
  completed: true, converged: true, status: 'issues_found', issues_found: 1, critical: 1, informational: 0,
  findings: [
    { fingerprint: GATE, severity: 'CRITICAL', locus: 'diff', kind: 'defect', blocking: true, raised_by: 'core', gate: 'RH-15', gate_id: GATE_ID, action: 'kept', reason: 'owner approved', ...extra },
    { fingerprint: 'src/x.ts:1:naming', severity: 'INFORMATIONAL', action: 'noted', blocking: false, raised_by: 'red-team' },
  ],
});
const NOT_CLEAN = 'FIX_CHECK: not counted (review has unresolved findings or did not finish clean)';

const run = (f: ShipFx, bin: string, args: string[]) => f.run(path.join(BIN, bin), args, { GSTACK_APPROVALS_MIRROR: '0' });
const gate = (f: ShipFx, finding: string, head: string, o: { words?: string; by?: string; reason?: string; gateId?: string } = {}) =>
  run(f, 'gstack-approvals', ['gate', '--finding', finding, '--gate-id', o.gateId ?? GATE_ID, '--head', head, '--reason', o.reason ?? REASON, '--words', o.words ?? WORDS, '--by', o.by ?? BY]);
const log = (f: ShipFx, skill: string, row: Record<string, unknown>) => {
  const env = { GSTACK_APPROVALS_MIRROR: '0', GSTACK_SESSION_KIND: 'unattended' };
  const start = f.run(path.join(BIN, 'gstack-review-log'), ['--start', skill], env);
  expect(start.status, start.stderr).toBe(0);
  const logged = f.run(path.join(BIN, 'gstack-review-log'), [JSON.stringify({ skill, timestamp: '2026-11-11T20:30:13Z', via: 'ship', review_scope: 'frozen', ...row }), '--finish', start.stdout.trim()], env);
  expect(logged.status, logged.stderr).toBe(0);
};
/** A /ship run open on `dir` as preflight leaves it: the run marker plus an open lease held by this live test process. */
const openRun = (f: ShipFx, dir = f.work) => {
  const marker = path.resolve(dir, spawnSync('git', ['rev-parse', '--git-path', 'gstack-ship-run'], { cwd: dir, encoding: 'utf8', timeout: 60_000 }).stdout.trim());
  fs.writeFileSync(marker, 'ship-906-3a27393\n');
  const lease = spawnSync(path.join(BIN, 'gstack-lease'), ['touch', '--root', dir, '--pid', String(process.pid), '--run', 'ship-906-3a27393'], { encoding: 'utf8', timeout: 60_000 });
  expect(lease.status, lease.stderr).toBe(0);
  return marker;
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
    const approval = rec.stdout.split(' ')[1]!;
    const after = read(f);
    expect([after.review_freshness.status, after.gate_dispositions]).toEqual(['CURRENT', [approval]]);
    expect(after.findings[0]).toMatchObject({ action: 'kept', actor: 'unattended', disposition: approval, reason: `owner disposition ${approval}: ${REASON}` });
    expect(run(f, 'gstack-approvals', ['dispositions']).stdout).toMatch(new RegExp(`^Gate disposition: ${GATE} \\[gate ${GATE_ID}\\] at ${head.slice(0, 12)} by Founderstar Captain \\(FOUN-1\\) at \\d{4}-\\d\\d-\\d\\dT[^ ]+Z: ${REASON} — "Do it" \\(approval a-[0-9a-f]{12}\\)\\n$`));
  });

  test('negative controls stay open: no row, another fingerprint or gate_id, a head outside the range, a ruling, a gstack row', () => {
    const { f, head, mergeBase } = firstPass();
    const open = () => [read(f).review_freshness.status, read(f).gate_dispositions, read(f).findings[0].action];
    expect(open()).toEqual(['UNVERIFIED', undefined, 'open']);
    expect(gate(f, OTHER, head).status).toBe(0);
    expect(open()).toEqual(['UNVERIFIED', undefined, 'open']);
    expect(gate(f, GATE, head, { gateId: '0123456789ab' }).status).toBe(0);
    expect(open()).toEqual(['UNVERIFIED', undefined, 'open']);
    expect(gate(f, GATE, mergeBase).status).toBe(0);
    expect(open()).toEqual(['UNVERIFIED', undefined, 'open']);
    const ruling = run(f, 'gstack-approvals', ['rule', '--finding', GATE, '--head', head, '--reason', REASON, '--words', WORDS, '--by', BY]);
    expect(ruling.status).toBe(0);
    expect(open()).toEqual(['UNVERIFIED', undefined, 'open']);
    const self = gate(f, GATE, head, { by: 'gstack no-stop default (K1)' });
    expect([self.status, self.stderr]).toEqual([EXIT.usage, expect.stringContaining('--by names gstack')]);
    expect(open()).toEqual(['UNVERIFIED', undefined, 'open']);
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
    const marker = openRun(f);
    const inRun = gate(f, GATE, head);
    expect([inRun.status, inRun.stderr]).toEqual([EXIT.usage, expect.stringContaining('/ship run ship-906-3a27393 is open on this checkout')]);
    fs.rmSync(marker);
    for (const words of ['', '   ']) {
      const empty = gate(f, GATE, head, { words });
      expect([empty.status, empty.stderr]).toEqual([EXIT.usage, expect.stringContaining('--words')]);
    }
    const noId = gate(f, GATE, head, { gateId: '' });
    expect([noId.status, noId.stderr]).toEqual([EXIT.usage, expect.stringContaining('--gate-id')]);
    const lines = gate(f, GATE, head, { words: 'Do it\nand more' });
    expect([lines.status, lines.stderr]).toEqual([EXIT.usage, expect.stringContaining('one line')]);
    const add = run(f, 'gstack-approvals', ['add', '--ask', `gate_disposition ${GATE} ${GATE_ID} at ${head}: ${REASON}`, '--words', WORDS, '--by', BY, '--scope', `gate_disposition ${GATE} ${GATE_ID} ${head}`]);
    expect([add.status, add.stderr]).toEqual([EXIT.usage, expect.stringContaining('gstack-approvals gate')]);
    expect(run(f, 'gstack-approvals', ['dispositions']).stdout).toBe('GATE_DISPOSITIONS: none\n');
    expect(read(f).review_freshness.status).toBe('UNVERIFIED');
  });

  test('the lane\'s own review-log claim closes nothing', () => {
    const { f, head } = firstPass({ disposition: 'a-6dcd9c1d8fad', approval: 'a-6dcd9c1d8fad', disposition_by: BY }, { gate_dispositions: ['a-6dcd9c1d8fad'] });
    const row = read(f);
    expect([row.findings[0].action, row.findings[0].disposition, row.review_freshness.status, row.gate_dispositions]).toEqual(['open', undefined, 'UNVERIFIED', undefined]);
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
      expect.stringMatching(new RegExp(`^GATE_DISPOSITION: ${GATE} \\[gate ${GATE_ID}\\] at ${passHead.slice(0, 12)} by Founderstar Captain \\(FOUN-1\\) at [^ ]+Z: ${REASON} — "Do it" \\(approval a-[0-9a-f]{12}\\)$`)),
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
    expect(receipt.receipt?.gate_dispositions).toEqual([{ finding: GATE, gate_id: GATE_ID, head, by: BY, reason: REASON, words: WORDS, at: expect.stringMatching(/Z$/), approval: expect.stringMatching(/^a-[0-9a-f]{12}$/) }]);
    expect(readyTailLines(receipt.receipt).filter(l => l.startsWith('GATE_DISPOSITION: '))).toEqual([`GATE_DISPOSITION: ${line.slice('Gate disposition: '.length)}`]);
  });
});

// Value: protects=the GSTA-518 audit's lane-side paths (B1 sibling writer, N1 lock, N2 undefined gate id, N4 malformed rows, N5
//   skipped --body) are refused or ignored; fails_when=a sibling worktree records while the branch's /ship run is open, a row
//   missing a writer field or edited after writing closes the finding, --gate-id undefined records, or write skips the body check;
//   seam=gstack-approvals gate, gstack-review-read and gstack-ship-receipt write; no_claim=a well-formed row a same-user lane
//   forges (the lander's --accept-gate-disposition is that boundary, test/ship-queue-land-direct.test.ts)
describe('a disposition the lane makes for itself is refused or ignored (GST-2491)', () => {
  const store = (f: ShipFx) => locate({ cwd: f.work, env: { ...process.env, GSTACK_STATE_ROOT: f.state, GSTACK_HOME: f.state, GSTACK_APPROVALS_MIRROR: '0' }, branch: 'feat' }) as StoreLocation;

  test('a recorder name is trimmed and one line, and a parked run whose lease ended no longer refuses', () => {
    const { f, head } = firstPass();
    const lines = gate(f, GATE, head, { by: 'Founderstar\nCaptain' });
    expect([lines.status, lines.stderr]).toEqual([EXIT.usage, expect.stringContaining('one line')]);
    const marker = path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    fs.writeFileSync(marker, 'ship-906-parked\n');
    const spaced = gate(f, GATE, head, { by: ` ${BY} ` });
    expect(spaced.status, spaced.stderr).toBe(0);
    expect(run(f, 'gstack-approvals', ['dispositions']).stdout).toContain(`by ${BY} at`);
    expect(read(f).review_freshness.status).toBe('CURRENT');
  });

  test('a sibling worktree cannot record while the branch has an open /ship run, and records once it closes', () => {
    const { f, head } = firstPass();
    const marker = openRun(f);
    const sib = path.join(f.root, 'sib');
    expect(f.git('worktree', 'add', '-q', '-b', 'owner-side', sib, 'HEAD').status).toBe(0);
    const fromSib = () => spawnSync(path.join(BIN, 'gstack-approvals'), ['gate', '--branch', 'feat', '--finding', GATE, '--gate-id', GATE_ID, '--head', head, '--reason', REASON, '--words', WORDS, '--by', BY],
      { cwd: sib, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: f.state, GSTACK_HOME: f.state, GSTACK_APPROVALS_MIRROR: '0', GIT_CONFIG_GLOBAL: path.join(f.root, 'gitconfig') } });
    const refused = fromSib();
    expect([refused.status, refused.stderr]).toEqual([EXIT.usage, expect.stringContaining(`/ship run ship-906-3a27393 is open in the worktree ${f.work} (branch feat)`)]);
    expect(read(f).review_freshness.status).toBe('UNVERIFIED');
    fs.rmSync(marker);
    const recorded = fromSib();
    expect(recorded.status, recorded.stderr).toBe(0);
    expect(read(f).review_freshness.status).toBe('CURRENT');
  });

  test('a raw row missing a writer field, edited after writing, or for another branch closes nothing; the written row does', () => {
    const { f, head } = firstPass();
    expect(gate(f, GATE, head).status).toBe(0);
    const file = store(f).file;
    const good = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)!);
    expect([good.source, good.digest]).toEqual(['gate', expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]);
    const { digest: _d, ...noDigest } = good, { by: _b, ...noBy } = good, { recorded_at: _r, ...noTime } = good;
    for (const bad of [noDigest, noBy, noTime, { ...good, source: 'manual' }, { ...good, words: 'Do it all' }, { ...good, branch: 'other' }, { ...good, id: 'gate-1' }, { ...good, ask: good.ask.replace(REASON, 'any gate change') }]) {
      fs.writeFileSync(file, JSON.stringify(bad) + '\n');
      expect([read(f).review_freshness.status, run(f, 'gstack-approvals', ['dispositions']).stdout]).toEqual(['UNVERIFIED', 'GATE_DISPOSITIONS: none\n']);
    }
    fs.writeFileSync(file, JSON.stringify(good) + '\n');
    expect(read(f).review_freshness.status).toBe('CURRENT');
  });

  test('a literal undefined gate id is refused, and an id-less gate finding stays open even under a digest-correct row', () => {
    const { f, head } = firstPass({ gate_id: undefined });
    for (const gateId of ['undefined', 'null']) {
      const lit = gate(f, GATE, head, { gateId });
      expect([lit.status, lit.stderr]).toEqual([EXIT.usage, expect.stringContaining('--gate-id')]);
    }
    const row = buildRow({ ...gateDispositionRow(GATE, 'undefined', head, REASON), words: WORDS, by: BY, source: GATE_SOURCE }, 'feat') as ApprovalRow;
    fs.mkdirSync(path.dirname(store(f).file), { recursive: true });
    fs.appendFileSync(store(f).file, JSON.stringify({ ...row, digest: gateDispositionDigest(row as unknown as Record<string, unknown>) }) + '\n');
    expect([read(f).review_freshness.status, read(f).findings[0].action]).toEqual(['UNVERIFIED', 'open']);
  });

  test('write refuses a receipt without --body while a disposition applies at HEAD', () => {
    const { f, head } = firstPass();
    expect(gate(f, GATE, head).status).toBe(0);
    const w = f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '906', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended'], { GSTACK_APPROVALS_MIRROR: '0' });
    expect([w.status, w.stderr]).toEqual([EXIT.fail, expect.stringContaining('so write needs --body <the PR body>')]);
  });

  // Value: protects=a branch whose disposition row names a commit a rewrite and gc removed still ships (the 0a9a0c4 review's
  //   blocker): in a full clone that row is not applied; fails_when=git's exit 128 on the missing head strands write for good
  test('write records an explicit empty gate_dispositions, and a row whose head a rewrite and gc removed is not applied', () => {
    const { f, head } = firstPass();
    expect(gate(f, GATE, head).status).toBe(0);
    for (const args of [['commit', '-q', '--amend', '-m', 'feat rewritten'], ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/feat'], ['reflog', 'expire', '--expire=now', '--all'], ['gc', '-q', '--prune=now']]) expect(f.git(...args).status).toBe(0);
    for (const args of [['reflog', 'expire', '--expire=now', '--all'], ['gc', '-q', '--prune=now']]) expect(f.git('--git-dir', f.origin, ...args).status).toBe(0);
    expect([f.git('cat-file', '-e', `${head}^{commit}`).status, f.git('--git-dir', f.origin, 'cat-file', '-e', `${head}^{commit}`).status]).not.toContain(0);
    const body = path.join(f.root, 'body.md');
    fs.writeFileSync(body, '## Pre-Landing Review\n\nNo issues found.\n');
    const ok = f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '906', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], { GSTACK_APPROVALS_MIRROR: '0' });
    expect(ok.status, ok.stderr).toBe(EXIT.ok);
    expect(extractReceipt(ok.stdout).receipt?.gate_dispositions).toEqual([]);
  });
});
