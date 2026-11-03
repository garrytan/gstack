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
function targetedRead(repo: FixtureRepo, base: string, dir: string, reply: string | null, sent = true, classes = 'money'): string {
  const out = path.join(repo.root, dir);
  const ledger = path.join(out, 'review-ledger.jsonl');
  const render = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', classes, '--diff-base', base, '--out', out]);
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

  // Value: protects=a run whose ledger holds no targeted render leaves no record for Step 19 to pass, so an earlier run's
  //   .gstack/tmp/targeted.json never reaches write (pass 1 Red Team note on this PR); fails_when=verify leaves the stale file;
  //   seam=gstack-ship-receipt write's input via gstack-review-dispatch verify --targeted-out
  test('verify with no targeted render removes a stale --targeted-out file', () => {
    const { repo, base } = moneyBranch();
    const out = path.join(repo.root, 'plain');
    const render = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'specialist', '--name', 'testing', '--diff-base', base, '--out', out]);
    expect(render.status, render.err).toBe(0);
    const record = path.join(repo.root, 'targeted.json');
    fs.writeFileSync(record, '{"stale":true}\n');
    const v = verify(repo, path.join(out, 'review-ledger.jsonl'), record);
    expect(recordLine(v.out)).toBe('');
    expect(fs.existsSync(record)).toBe(false);
  });

  // Value: protects=a verify that stops early (an empty ledger: no brief records) still removes the stale record (round 2 Red
  //   Team and adversarial on this PR); fails_when=the early return leaves it; seam=gstack-review-dispatch verify --targeted-out
  test('verify on a ledger with no brief records removes a stale --targeted-out file too', () => {
    const { repo } = moneyBranch();
    const ledger = path.join(repo.root, 'empty-ledger.jsonl');
    fs.writeFileSync(ledger, '');
    const record = path.join(repo.root, 'targeted.json');
    fs.writeFileSync(record, '{"stale":true}\n');
    expect(verify(repo, ledger, record).status).toBe(EXIT.refused);
    expect(fs.existsSync(record)).toBe(false);
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

  // Value: protects=a record binds only to the product patch the reader read, so a docs or TODOS.md commit after the read (which
  //   changes the product patch) is refused like a money edit; binding docs-only commits is planned under GST-1031 with a full
  //   review; fails_when=write binds a record whose read product patch is not the receipt's; seam=gstack-ship-receipt write --review-targeted
  test('a docs and TODOS.md commit after the read is refused; a money edit after it is refused', () => {
    const { repo, base, head } = moneyBranch();
    const record = path.join(repo.root, 'targeted.json');
    expect(verify(repo, targetedRead(repo, base, 'h1', 'NO FINDINGS'), record).status).toBe(0);

    commit(repo, 'docs/charges.md', '# Charges\n\nThe cap is enforced per run.\n', 'Step 14.5 docs');
    commit(repo, 'TODOS.md', '# TODOS\n\n- [x] enforce the cap\n', 'Step 14 TODOS');
    const docs = write(repo, ['--review-targeted', `@${record}`]);
    expect(docs.status).toBe(EXIT.fail);
    expect(docs.err).toContain(`the targeted reader read ${head.slice(0, 12)}`);

    commit(repo, 'src/charge.ts', 'export const spend_cap_usd = 50;\n', 'money edit after verify');
    const stale = write(repo, ['--review-targeted', `@${record}`]);
    expect(stale.status).toBe(EXIT.fail);
    expect(stale.err).toContain(`the targeted reader read ${head.slice(0, 12)}`);
  });

  // Value: protects=a code edit after the read that drops a cap's enforcing line carries no money token, so the classifier tags
  //   nothing, but the product patch the reader read is gone and the record must not bind (targeted gate reader on this PR at
  //   071532752, CRITICAL lib/ship-receipt-depth.ts:153); fails_when=write binds a record whose read product patch is not the
  //   receipt's; seam=gstack-ship-receipt write --review-targeted
  test('a code edit after the read that removes an enforcing line with no money token is refused', () => {
    const { repo, base } = moneyBranch();
    commit(repo, 'src/runner.ts', 'export function run(spent: number, limit: number) {\n  if (spent > limit) throw new Error("over");\n}\n', 'enforce the limit');
    const head = repo.git('rev-parse', 'HEAD');
    const record = path.join(repo.root, 'targeted.json');
    expect(verify(repo, targetedRead(repo, base, 'h1', 'NO FINDINGS'), record).status).toBe(0);
    expect(write(repo, ['--review-targeted', `@${record}`]).status).toBe(EXIT.ok);
    commit(repo, 'src/runner.ts', 'export function run(spent: number, limit: number) {\n}\n', 'drop the enforcing line');
    const dropped = write(repo, ['--review-targeted', `@${record}`]);
    expect(dropped.status).toBe(EXIT.fail);
    expect(dropped.err).toContain(`the targeted reader read ${head.slice(0, 12)}`);
  });

  // Value: protects=a test edit after the read that skips a case is gate-class work the reader never saw, so the record does not
  //   bind though the product patch (which leaves tests out) is unchanged (round 2 outside voice and adversarial on this PR);
  //   a record whose read commit is not an ancestor of the head is refused; fails_when=write binds either;
  //   seam=gstack-ship-receipt write --review-targeted
  test('a test skipped after the read is refused though the product patch is unchanged; a rewritten read is refused', () => {
    const { repo, base } = moneyBranch();
    const cases = (cap: string) => `import { test, expect } from "bun:test";\ntest.skip("unit", () => { expect(1).toBe(1); });\n${cap}("cap", () => { expect(5).toBe(5); });\n`;
    commit(repo, 'test/charge.test.ts', cases('test'), 'cap test, unit case skipped');
    const head = repo.git('rev-parse', 'HEAD');
    const record = path.join(repo.root, 'targeted.json');
    expect(verify(repo, targetedRead(repo, base, 'h1', 'NO FINDINGS', true, 'money,gate'), record).status).toBe(0);
    expect(write(repo, ['--review-targeted', `@${record}`]).status).toBe(EXIT.ok);
    commit(repo, 'test/charge.test.ts', cases('test.skip'), 'skip the cap test');
    const skipped = write(repo, ['--review-targeted', `@${record}`]);
    expect(skipped.status).toBe(EXIT.fail);
    expect(skipped.err).toContain(`the targeted reader read ${head.slice(0, 12)}`);

    repo.git('reset', '-q', '--hard', base);
    commit(repo, 'src/charge.ts', 'export const spend_cap_usd = 75;\n', 'rewritten money change');
    const rewritten = write(repo, ['--review-targeted', `@${record}`]);
    expect(rewritten.status).toBe(EXIT.fail);
    expect(rewritten.err).toContain(`the targeted reader read ${head.slice(0, 12)}`);
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
    const saved = { HOME: process.env.HOME, GSTACK_HOME: process.env.GSTACK_HOME, GSTACK_STATE_DIR: process.env.GSTACK_STATE_DIR };
    Object.assign(process.env, { HOME: repo.home, GSTACK_HOME: repo.home, GSTACK_STATE_DIR: repo.home });
    let depth: ReturnType<typeof receiptDepthAtHead>;
    try { depth = receiptDepthAtHead(repo.work, 'main', path.join(ROOT, 'bin'), head); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
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
    expect(uncovered.status).toBe(EXIT.refused);
    expect(uncovered.err).toMatch(/requires the targeted reader on money, but the receipt records no targeted pass.*\(RECEIPT_CARRY_REFUSED/);
    expect(uncovered.err).toContain('the queue refuses it too (#3859)');
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
    expect(fs.readFileSync(path.join(ROOT, 'ship', 'DRIVER.md'), 'utf8')).toContain('[--review-targeted @<f>] --body <body>');

    const { repo } = moneyBranch();
    const expand = () => spawnSync('bash', ['-c', `printf '%s\\n' ${optional![0]}`], { cwd: repo.work, encoding: 'utf8', timeout: 10_000 }).stdout.split('\n').filter(Boolean);
    expect(expand()).toEqual([]);
    fs.mkdirSync(path.join(repo.work, '.gstack', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, recordPath!), '{}\n');
    expect(expand()).toEqual(['--review-targeted', `@${recordPath}`]);
  });
});
