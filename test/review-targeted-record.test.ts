/**
 * GST-986 (GST-966 part 2): the targeted reader's record from verify to the receipt.
 * verify records what the reader did and the commit it read; write binds that record only to a receipt whose product patch
 * is the one the reader read; write and carry refuse a receipt the queue's targeted verdict would refuse; /ship's receipt
 * writes pass the record. Cases come from gstack-evals#140, C5-36/C6-36 item 5 and GSTA-234's outside-voice fixture on #3859.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { checkoutTree } from '../lib/review-brief';
import { TARGETED_RULES, targetedBriefSha } from '../lib/review-targeted';
import { extractReceipt, placeReceiptFirst } from '../lib/ship-receipt';
import { receiptDepthAtHead } from '../lib/ship-receipt-depth';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

setDefaultTimeout(180_000);
const ROOT = path.resolve(import.meta.dir, '..');
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function moneyBranch(): { repo: FixtureRepo; base: string; head: string } {
  const repo = makeFixtureRepo({ prefix: 'gst986-' });
  repos.push(repo);
  repo.git('checkout', '-q', '-b', 'feat');
  fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, 'src', 'charge.ts'), 'export const spend_cap_usd = 5;\n');
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'charge');
  return { repo, base: repo.git('merge-base', 'origin/main', 'HEAD'), head: repo.git('rev-parse', 'HEAD') };
}
const commit = (repo: FixtureRepo, file: string, text: string, msg: string) => {
  fs.mkdirSync(path.dirname(path.join(repo.work, file)), { recursive: true });
  fs.writeFileSync(path.join(repo.work, file), text);
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', msg);
  return repo.git('rev-parse', 'HEAD');
};

/** One targeted read through the real dispatch steps; `reply` is the reader's raw output after its REVIEWED_TREE line. */
function targetedRead(repo: FixtureRepo, base: string, dir: string, reply: string | null, sent = true): string {
  const out = path.join(repo.root, dir);
  const ledger = path.join(out, 'review-ledger.jsonl');
  const render = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'money', '--diff-base', base, '--out', out]);
  expect(render.status, render.err).toBe(0);
  const file = /file=(\S+)/.exec(render.out)![1]!;
  if (sent) expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', ledger, '--role', 'targeted', '--sent', file]).status).toBe(0);
  if (reply === null) return ledger;
  const output = path.join(out, 'targeted.out');
  fs.writeFileSync(output, `REVIEWED_TREE: ${checkoutTree(repo.work)}\n${reply}\n`);
  const merged = path.join(out, 'merged.jsonl');
  expect(runBin(repo, 'gstack-review-dispatch', ['collect', '--ledger', ledger, '--role', 'targeted', '--output', output, '--merged', merged]).status).toBe(0);
  const judged = path.join(out, 'judged.jsonl');
  fs.writeFileSync(judged, fs.readFileSync(merged, 'utf8').split('\n').filter(Boolean).map(l => JSON.stringify({ id: JSON.parse(l).id, severity: JSON.parse(l).label }) + '\n').join(''));
  expect(runBin(repo, 'gstack-review-dispatch', ['judge', '--ledger', ledger, '--merged', merged, '--judged', judged]).status).toBe(0);
  return ledger;
}
const verify = (repo: FixtureRepo, ledger: string, record?: string) =>
  runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', ledger, ...(record ? ['--targeted-out', record] : [])]);
const recordLine = (out: string) => out.split('\n').find(l => l.startsWith('TARGETED_RECORD:')) ?? '';
const finding = (line: number, summary: string) => JSON.stringify({ severity: 'INFORMATIONAL', confidence: 7, path: 'src/charge.ts', line, category: 'money', summary, fingerprint: `src/charge.ts:${line}:money`, specialist: 'targeted' });
const write = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'unattended', ...args, '--json']);

describe('verify records the targeted reader\'s outcome and the commit it read (item 1)', () => {
  // Value: protects=a targeted reader that completed reads as done, with its findings counted, however the head moves after it
  //   (gstack-evals#140, C5-36 and C6-36 p2: Step 11 fixes moved the head and the clean or 2-finding read printed status=failed
  //   findings=0); a reader that did not complete stays failed; fails_when=verify fails a completed read because HEAD moved, zeroes
  //   its findings, or marks a read with no matching dispatch or output done; seam=gstack-review-dispatch verify --targeted-out;
  //   no_claim=binding the record to the receipt (write, below)
  test('a clean read and a 2-finding read stay done after a later fix commit; an unsent or uncollected read is failed', () => {
    const { repo, base, head } = moneyBranch();
    const clean = targetedRead(repo, base, 'clean', 'NO FINDINGS');
    const found = targetedRead(repo, base, 'found', `${finding(1, 'the cap is never enforced')}\n${finding(1, 'the cap has no unit test')}`);
    const unsent = targetedRead(repo, base, 'unsent', 'NO FINDINGS', false);
    const silent = targetedRead(repo, base, 'silent', null);
    commit(repo, 'src/charge.ts', 'export const spend_cap_usd = 5; // enforced in run()\n', 'Step 11 fix after the reader');

    const record = path.join(repo.root, 'targeted.json');
    const v = verify(repo, clean, record);
    expect(recordLine(v.out)).toStartWith(`TARGETED_RECORD: classes=money status=done findings=0 brief=${targetedBriefSha().slice(0, 12)} rules=${TARGETED_RULES}`);
    expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual({ classes: ['money'], rules: TARGETED_RULES, brief_sha: targetedBriefSha(), status: 'done', findings: 0, raised_by: 'targeted', head });
    expect(recordLine(verify(repo, found).out)).toStartWith('TARGETED_RECORD: classes=money status=done findings=2 ');
    expect(recordLine(verify(repo, unsent).out)).toStartWith('TARGETED_RECORD: classes=money status=failed ');
    expect(recordLine(verify(repo, silent).out)).toStartWith('TARGETED_RECORD: classes=money status=failed findings=0 ');
  });

  // Value: protects=a read rendered on uncommitted tracked edits never reads as done (nothing proves which patch it read);
  //   fails_when=the item 1 repair accepts it; seam=gstack-review-dispatch render + verify
  test('a read rendered on uncommitted tracked edits is failed', () => {
    const { repo, base } = moneyBranch();
    fs.writeFileSync(path.join(repo.work, 'src', 'charge.ts'), 'export const spend_cap_usd = 6;\n');
    const dirty = targetedRead(repo, base, 'dirty', 'NO FINDINGS');
    repo.git('checkout', '--', 'src/charge.ts');
    expect(recordLine(verify(repo, dirty).out)).toStartWith('TARGETED_RECORD: classes=money status=failed ');
  });
});

describe('write binds a targeted record only to the product patch the reader read (item 2)', () => {
  // Value: protects=a record verified at H1 never vouches for H2's new product code (GSTA-234's outside-voice CRITICAL on #3859:
  //   write rebound the H1 record to H2's product patch-id and ready printed verdict=ok); a later commit that leaves the product
  //   patch alone (a test, the version stamp) still binds; fails_when=write accepts the stale record, rejects the unchanged
  //   product, or accepts a record that names no commit; seam=gstack-ship-receipt write --review-targeted
  test('GSTA-234\'s fixture: an auth commit after verify is refused; a test-only commit binds', () => {
    const { repo, base, head } = moneyBranch();
    const record = path.join(repo.root, 'targeted.json');
    expect(verify(repo, targetedRead(repo, base, 'h1', 'NO FINDINGS'), record).status).toBe(0);

    commit(repo, 'test/charge.test.ts', 'test("cap", () => {});\n', 'test only');
    const testOnly = write(repo, ['--review-targeted', `@${record}`]);
    expect(testOnly.status, testOnly.err).toBe(EXIT.ok);
    expect(JSON.parse(testOnly.out).review_targeted).toMatchObject({ classes: ['money'], status: 'done' });

    commit(repo, 'src/session.ts', 'export function checkSession(token: string) { return token.length > 0; }\n', 'auth change after verify');
    const body = path.join(repo.root, 'body.md');
    const stale = write(repo, ['--review-targeted', `@${record}`, '--body', body]);
    expect(stale.status).toBe(EXIT.fail);
    expect(stale.err).toContain(`the targeted reader read ${head.slice(0, 12)}`);
    expect(stale.err).toContain('(RECEIPT_INVALID');
    expect(fs.existsSync(body)).toBe(false);

    const { head: _drop, ...headless } = JSON.parse(fs.readFileSync(record, 'utf8'));
    const old = write(repo, ['--review-targeted', JSON.stringify(headless)]);
    expect(old.status).toBe(EXIT.fail);
    expect(old.err).toContain('review_targeted.head');
  });
});

describe('write and carry refuse a receipt the queue\'s targeted verdict refuses (item 4, #3854)', () => {
  // Value: protects=/ship never publishes a receipt whose head needs a targeted class it did not cover (gstack-evals#140 wrote
  //   gstack_version with receipt=legacy); a head that needs none writes as before; fails_when=write records no or a failed pass
  //   on a money head, or refuses a head without classes; seam=gstack-ship-receipt write + receiptTargetedVerdict
  test('write: missing and failed records are refused on a money head; a covered or classless head writes', () => {
    const { repo, base } = moneyBranch();
    const missing = write(repo, []);
    expect(missing.status).toBe(EXIT.fail);
    expect(missing.err).toContain('REVIEW_TARGETED: required=money receipt=legacy verdict=missing');
    expect(missing.err).toMatch(/requires the targeted reader on money, but the receipt records no targeted pass.*\(RECEIPT_INVALID/);
    const record = path.join(repo.root, 'targeted.json');
    verify(repo, targetedRead(repo, base, 'h1', 'NO FINDINGS'), record);
    const failed = write(repo, ['--review-targeted', JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), status: 'failed' })]);
    expect(failed.status).toBe(EXIT.fail);
    expect(failed.err).toContain('targeted pass failed');
    expect(write(repo, ['--review-targeted', `@${record}`]).status).toBe(EXIT.ok);

    const plain = makeFixtureRepo({ prefix: 'gst986-plain-' });
    repos.push(plain);
    plain.git('checkout', '-q', '-b', 'feat');
    commit(plain, 'docs/notes.md', '# notes\n', 'docs');
    const none = write(plain, []);
    expect(none.status, none.err).toBe(EXIT.ok);
    expect(JSON.parse(none.out)).not.toHaveProperty('review_targeted');
  });

  // Value: protects=carry never rebinds a receipt the queue would refuse on targeted coverage (#3854: carry checked depth only);
  //   a legacy receipt and a covered one carry as before; fails_when=carry prints CARRY: carried for an uncovered money head, or
  //   refuses a covered or legacy one; seam=gstack-ship-receipt carry
  test('carry: an uncovered versioned receipt is refused; a covered or legacy one carries', () => {
    const { repo, head } = moneyBranch();
    const depth = receiptDepthAtHead(repo.work, 'main', path.join(ROOT, 'bin'), head);
    const versioned = { schema_version: 1, pr: 5, head, base: 'main', gstack_version: '1.92.75.0', review_depth: depth };
    const covered = { ...versioned, review_targeted: { classes: ['money'], rules: TARGETED_RULES, brief_sha: targetedBriefSha(), product_patch_id: 'p', status: 'done', findings: 0, raised_by: 'targeted' } };
    commit(repo, 'test/charge.test.ts', 'test("cap", () => {});\n', 'test only');
    let n = 0;
    const carry = (receipt: object) => {
      const body = path.join(repo.root, `body-${++n}.md`);
      fs.writeFileSync(body, placeReceiptFirst('## Summary\n\nProse.\n', receipt as any));
      return { ...runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], { GSTACK_STATE_ROOT: path.join(repo.root, 'state') }), body };
    };
    const uncovered = carry(versioned);
    expect(uncovered.status).toBe(EXIT.fail);
    expect(uncovered.err).toMatch(/requires the targeted reader on money, but the receipt records no targeted pass.*\(RECEIPT_CARRY_REFUSED/);
    expect(extractReceipt(fs.readFileSync(uncovered.body, 'utf8')).receipt!.head).toBe(head);
    const ok = carry(covered);
    expect(ok.status, ok.err).toBe(EXIT.ok);
    expect(ok.out).toContain('CARRY: carried from');
    const legacy = carry({ schema_version: 1, pr: 5, head, base: 'main' });
    expect(legacy.status, legacy.err).toBe(EXIT.ok);
  });
});

describe('/ship\'s receipt writes pass the targeted record (item 3, #3853)', () => {
  // Value: protects=the record Step 11's verify writes reaches every receipt write /ship runs (Step 19, the handoff, the driver);
  //   fails_when=a write command omits --review-targeted or reads another path than verify writes; seam=the generated sections'
  //   command text expanded by bash; no_claim=the agent following it (prose)
  test('verify writes .gstack/tmp/targeted.json and the Step 19, handoff and driver writes read it', () => {
    const section = (name: string) => fs.readFileSync(path.join(ROOT, 'ship', 'sections', `${name}.md`), 'utf8');
    const recordPath = /verify --targeted-out (\S+?)`/.exec(section('adversarial'))?.[1];
    expect(recordPath).toBe('.gstack/tmp/targeted.json');
    const writeLine = section('pr-body').split('\n').find(l => l.includes('gstack-ship-receipt write --pr'))!;
    const optional = /\$\(\[ -s (\S+) \] && echo (--review-targeted @\S+)\)/.exec(writeLine);
    expect(optional?.slice(1)).toEqual([recordPath!, `--review-targeted @${recordPath}`]);
    expect(section('handoff')).toContain(`When Step 11 saved \`${recordPath}\`, add \`--review-targeted @${recordPath}\` to that write.`);
    expect(fs.readFileSync(path.join(ROOT, 'ship', 'DRIVER.md'), 'utf8')).toContain(`[--review-targeted @${recordPath}]`);

    const { repo } = moneyBranch();
    const expand = () => spawnSync('bash', ['-c', `printf '%s\\n' ${optional![0]}`], { cwd: repo.work, encoding: 'utf8', timeout: 10_000 }).stdout.split('\n').filter(Boolean);
    expect(expand()).toEqual([]);
    fs.mkdirSync(path.join(repo.work, '.gstack', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, recordPath!), '{}\n');
    expect(expand()).toEqual(['--review-targeted', `@${recordPath}`]);
  });
});
