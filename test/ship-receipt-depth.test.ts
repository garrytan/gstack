/**
 * The /ship receipt's review depth and review-loop exception (GSTA-147 PR 2,
 * docs/review-policy.md#review-depth, #3559): write records the depth gstack
 * computes at the checked-out head, the queue recomputes the depth the head
 * needs and refuses a receipt below it, a carry rebinds the gate scan or
 * refuses when the head needs more, and the review-loop exception is checked
 * like the documentation exception.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, renderReceiptBlock } from '../lib/ship-receipt';
import { bindShippedReceipt, receiptDepthAtHead, receiptDepthVerdict } from '../lib/ship-receipt-depth';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { runScriptSync } from '../lib/script-invocation';
import { BUMP_NEVER_KEY_VERSION, HISTORY_NO_REWRITE_KEY_VERSION, LAND_MERGE_COMMIT_PATHS_KEY_VERSION, POLICY_KEY_INTRODUCED, TRAIN_GATES_KEY_VERSION } from '../lib/ship-policy';
import { cmpVersion, parseVersion } from '../lib/version-source';
import { cleanup, commit, makeFixtureRepo, ROOT, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const receiptIn = (body: string) => extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
const writeReceipt = (repo: FixtureRepo, body: string, extra: string[] = []) =>
  runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body, ...extra]);
/** A done targeted record read at HEAD on every class: since GST-986, write refuses a money, gate, auth or secret head without one. */
const targetedAtHead = (repo: FixtureRepo) => ['--review-targeted', JSON.stringify({ classes: ['money', 'gate', 'auth', 'secret'], rules: 'r', brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted', head: repo.git('rev-parse', 'HEAD') })];
const lines = (n: number) => Array.from({ length: n }, (_, i) => `exports.f${i} = () => ${i};`).join('\n') + '\n';
const rewrite = (body: string, edit: (r: Record<string, any>) => void) => {
  const text = fs.readFileSync(body, 'utf8');
  const r = extractReceipt(text).receipt as Record<string, any>;
  edit(r);
  fs.writeFileSync(body, text.replace(/```gstack-ship-receipt[\s\S]*?\n```\n/, renderReceiptBlock(r as any)));
  return fs.readFileSync(body, 'utf8');
};

describe('write records the review depth at the checked-out head', () => {
  // Value: protects=the receipt names the depth and a gate scan bound to the head it is written for, and never binds a
  // tree it did not review; fails_when=write records no depth, or --head accepts a commit other than HEAD; seam=none
  test('a light code diff records depth, runtime lines, the base and the gate scan at HEAD; --head of another commit writes nothing', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const older = commit(repo, { 'lib/util.js': lines(3) });
    const head = commit(repo, { 'lib/more.js': lines(2) });
    const body = path.join(repo.root, 'body.md');
    const ok = writeReceipt(repo, body);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.err).toContain('depth=light');
    const r = receiptIn(body);
    expect(r.gstack_version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const base = repo.git('rev-parse', 'origin/main');
    expect(r.review_depth).toMatchObject({ depth: 'light', class: 'code', base, registry: base, gate_scan: { tagged: 0, head } });
    expect(r.review_depth!.runtime_lines).toBeGreaterThanOrEqual(5);
    expect(r.review_depth!.runtime_lines).toBeLessThanOrEqual(50);
    expect(r.design).toBeUndefined();
    const other = path.join(repo.root, 'other.md');
    const bad = writeReceipt(repo, other, ['--head', older]);
    expect(bad.status).toBe(EXIT.fail);
    expect(bad.err).toContain(`--head ${older.slice(0, 12)} is not the checked-out HEAD ${head.slice(0, 12)}`);
    expect(bad.err).toContain('(RECEIPT_INVALID)');
    expect(fs.existsSync(other)).toBe(false);
  }, 60_000);

  // Value: protects=a rendered-UI diff's receipt says only the static design check ran and why (GST-1718), from the same
  //   diff-scope the depth reads; fails_when=write records no design field on a frontend range, or records one on a
  //   backend-only range (test above); seam=none
  test('a template-UI diff records design: static (no preview declared)', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'src/ui/row.ts': "import { html } from 'lit';\nexport const row = (n: string) => html`<div class=\"row\">${n}</div>`;\n" });
    const body = path.join(repo.root, 'body.md');
    const ok = writeReceipt(repo, body);
    expect(ok.status).toBe(EXIT.ok);
    expect(receiptIn(body).design).toEqual({ mode: 'static', reason: 'no preview declared' });
  }, 60_000);

  // Value: protects=a receipt names the gstack release that wrote it, never a newer policy key its tree carries, so a
  // version check against a receipt cannot be passed by an older build (GST-1366); fails_when=write records the
  // key-inflated version policy reading uses, or policy reading stops seeing the newest key; seam=none
  test('a gstack whose VERSION is older than its newest policy key records that VERSION; policy reading still reads at the key', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'lib/util.js': lines(3) });
    const installed = path.join(repo.root, 'installed-gstack');
    const sourceOnly = { recursive: true, filter: (file: string) => path.basename(file) !== 'node_modules' };
    for (const dir of ['bin', 'lib', 'scripts', 'crew']) fs.cpSync(path.join(ROOT, dir), path.join(installed, dir), sourceOnly);
    fs.writeFileSync(path.join(installed, 'VERSION'), '1.0.0.0\n');
    const body = path.join(repo.root, 'body.md');
    const write = runScriptSync(path.join(installed, 'bin', 'gstack-ship-receipt'), ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body],
      { cwd: repo.work, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...repo.env } });
    expect(write.status, write.stderr).toBe(EXIT.ok);
    expect(receiptIn(body).gstack_version).toBe('1.0.0.0');
    const newestKey = [...Object.values(POLICY_KEY_INTRODUCED), BUMP_NEVER_KEY_VERSION, TRAIN_GATES_KEY_VERSION, HISTORY_NO_REWRITE_KEY_VERSION, LAND_MERGE_COMMIT_PATHS_KEY_VERSION].reduce((a, b) => (cmpVersion(parseVersion(b)!, parseVersion(a)!) > 0 ? b : a));
    const reader = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', `console.log((await import(${JSON.stringify(path.join(installed, 'lib', 'ship-policy.ts'))})).runningGstackVersion())`],
      { cwd: repo.work, encoding: 'utf8', timeout: 60_000 });
    expect(reader.stdout.trim(), reader.stderr).toBe(newestKey);
  }, 120_000);
});

describe('the queue refuses a receipt below the depth its head needs', () => {
  // Value: protects=a receipt reviewed lighter than its head needs never READYs or seats, and the refusal says what to do;
  // fails_when=the queue trusts the recorded depth, or prints no required depth, reasons and inputs; seam=bindShippedReceipt
  // R51: size never raises the depth, so the head that needs more than light is a risk-class one (a money path needs full).
  test('standard on a full (money) head, a missing depth from a current writer and an unbound gate scan refuse; a legacy receipt is accepted', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const head = commit(repo, { 'lib/billing.js': lines(80) });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body, targetedAtHead(repo)).status).toBe(EXIT.ok);
    expect(receiptIn(body).review_depth).toMatchObject({ depth: 'full', runtime_lines: 80, risk: ['money'] });
    const base = repo.git('rev-parse', 'origin/main').slice(0, 12);
    const bind = (text: string) => bindShippedReceipt(repo.work, 'origin/main', text, '7', [head]);
    const untargeted = bind(rewrite(body, r => { delete r.review_targeted; }));
    expect(!untargeted.ok && untargeted.code).toBe('QUEUE_RECEIPT_TARGETED_MISSING');
    expect(!untargeted.ok && untargeted.depthLine).toContain('REVIEW_DEPTH: receipt=full required=full');
    const good = bind(rewrite(body, r => { r.review_targeted = { classes: ['money'], rules: 'r', brief_sha: 'a'.repeat(64), product_patch_id: r.product_patch_id, status: 'done', findings: 0, raised_by: 'targeted' }; }));
    expect(good.ok, !good.ok ? good.message : '').toBe(true);
    expect(good.ok && good.depthLine).toContain('REVIEW_DEPTH: receipt=full required=full runtime_lines=80 class=code');

    const low = bind(rewrite(body, r => { r.review_depth.depth = 'standard'; }));
    expect(low.ok).toBe(false);
    if (low.ok) return;
    expect(low.code).toBe('QUEUE_RECEIPT_DEPTH_RAISED');
    expect(low.depthLine).toContain('receipt=standard required=full runtime_lines=80');
    expect(low.depthLine).toContain(`inputs=base@${base},registry@${base},gate_scan@${head.slice(0, 12)}`);
    expect(low.message).toContain('risk:money');
    expect(low.message).toContain(`the receipt is unchanged; run /gstack-ship on ${head.slice(0, 12)}`);

    const unbound = bind(rewrite(body, r => { r.review_depth.depth = 'standard'; r.review_depth.gate_scan.head = 'a'.repeat(40); }));
    expect(unbound.ok).toBe(false);
    expect(!unbound.ok && unbound.depthLine).toContain('required=full');
    expect(!unbound.ok && unbound.message).toContain('gate_scan_unavailable');

    const none = bind(rewrite(body, r => { delete r.review_depth; }));
    expect(!none.ok && none.code).toBe('QUEUE_RECEIPT_DEPTH_RAISED');
    expect(!none.ok && none.message).toContain('records no review_depth though its writer records one');

    const legacy = rewrite(body, r => { delete r.gstack_version; });
    const verdict = receiptDepthVerdict(repo.work, 'origin/main', extractReceipt(legacy).receipt!, head);
    expect(verdict).toEqual({ ok: true, line: 'REVIEW_DEPTH: legacy receipt (written before receipts recorded review_depth); accepted' });
  }, 60_000);

  // Value: protects=the queue's required depth keeps the scope signals the writer used, and a gate scan binds only the full
  // bound commit; fails_when=the queue recomputes without diff-scope (auth reads light) or binds an empty or short scan head
  // by prefix; seam=bindShippedReceipt
  test('an auth path needs full at the queue though the receipt says light; an empty or short gate scan head binds nothing', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const head = commit(repo, { 'lib/auth.js': lines(3) });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body, targetedAtHead(repo)).status).toBe(EXIT.ok);
    expect(receiptIn(body).review_depth).toMatchObject({ depth: 'full', class: 'gate' });
    const bind = (text: string) => bindShippedReceipt(repo.work, 'origin/main', text, '7', [head]);
    const light = bind(rewrite(body, r => { r.review_depth.depth = 'light'; }));
    expect(!light.ok && light.code).toBe('QUEUE_RECEIPT_DEPTH_RAISED');
    expect(!light.ok && light.depthLine).toContain('receipt=light required=full');
    expect(!light.ok && light.depthLine).toContain('class=gate');

    const plain = makeFixtureRepo(); repos.push(plain);
    const plainHead = commit(plain, { 'lib/util.js': lines(3) });
    const plainBody = path.join(plain.root, 'body.md');
    expect(writeReceipt(plain, plainBody).status).toBe(EXIT.ok);
    for (const scanHead of ['', plainHead.slice(0, 12)]) {
      const r = bindShippedReceipt(plain.work, 'origin/main', rewrite(plainBody, x => { x.review_depth.gate_scan.head = scanHead; }), '7', [plainHead]);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.depthLine).toContain('required=full');
      expect(!r.ok && r.depthLine).toContain('gate_scan@missing');
    }
  }, 90_000);
});

describe('carry and the review depth', () => {
  // Value: protects=a carried receipt keeps a gate scan bound to the head it now names, and a carry whose new head needs a
  // deeper review (a skipped test) is refused; fails_when=carry keeps the old scan, or carries a gate-tagged test change; seam=none
  test('a plain test change carries and rebinds the gate scan; a skipped test raises the depth and refuses the carry', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'lib/util.js': lines(3), 'test/util.test.js': "test('adds', () => { expect(1).toBe(1); });\n" });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body).status).toBe(EXIT.ok);
    expect(receiptIn(body).review_depth!.depth).toBe('light');
    const plain = commit(repo, { 'test/util.test.js': "test('adds', () => { expect(1).toBe(1); });\ntest('more', () => { expect(2).toBe(2); });\n" });
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(carried.status).toBe(EXIT.ok);
    expect(receiptIn(body).review_depth).toMatchObject({ depth: 'light', gate_scan: { tagged: 0, head: plain } });
    const skipped = commit(repo, { 'test/util.test.js': "test.skip('adds', () => { expect(1).toBe(1); });\ntest('more', () => { expect(2).toBe(2); });\n" });
    const refused = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.out).toContain('CARRY: refused (RECEIPT_CARRY_REFUSED)');
    expect(refused.err).toContain(`HEAD ${skipped.slice(0, 12)} needs full review depth`);
    expect(refused.err).toContain("above the receipt's light");
    expect(receiptIn(body).head).toBe(plain);
  }, 90_000);

  // Value: protects=a carry never binds a scan of one checkout to another commit, and never rebinds a receipt the queue would
  // refuse; fails_when=carry --head from another checkout carries a skipped test at light, or a current receipt without
  // review_depth carries; seam=none
  test('carry --head from another checkout refuses; a receipt with gstack_version but no review_depth refuses', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const reviewed = commit(repo, { 'lib/util.js': lines(3), 'test/util.test.js': "test('a', () => {});\n" });
    const body = path.join(repo.root, 'body.md');
    expect(writeReceipt(repo, body).status).toBe(EXIT.ok);
    const skipped = commit(repo, { 'test/util.test.js': "test.skip('a', () => {});\n" });
    repo.git('checkout', '-q', reviewed);
    const r = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', '--head', skipped]);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain(`--head ${skipped.slice(0, 12)} is not the checked-out HEAD ${reviewed.slice(0, 12)}`);
    expect(receiptIn(body).head).toBe(reviewed);
    repo.git('checkout', '-q', skipped);
    rewrite(body, x => { delete x.review_depth; });
    const noDepth = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main']);
    expect(noDepth.status).toBe(EXIT.refused);
    expect(noDepth.err).toContain('records gstack_version but no review_depth');
  }, 90_000);
});

describe('the review-loop exception is gone (GST-3562 part 4)', () => {
  // Value: protects=an open finding at the round cap reaches a receipt only as a Ruled note, never through the retired
  //   review_loop_exception; fails_when=write records an exception in either form; seam=gstack-ship-receipt write; no_claim=ruled notes
  test('write refuses --review-loop-exception in both forms and writes no receipt', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const head = commit(repo, { 'lib/util.js': lines(3) });
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## What changed\n');
    const base = { accepted_by: 'Garry', date: '2026-10-28', via: 'GSTA-147 relay', reason: 'ships as a note' };
    for (const e of [{ ...base, fix_check: { head, findings: 1 } }, { ...base, second_pass: { head, deferred: ['specialist#3'] } }]) {
      const out = writeReceipt(repo, body, ['--review-loop-exception', JSON.stringify(e), '--review-loop', JSON.stringify({ passes: 2, blocking_found: 1, deferred: 1, scope: 'frozen' })]);
      expect([out.status, out.err.includes('(REVIEW_LOOP_EXCEPTION_INVALID'), out.err.includes('Ruled')]).toEqual([EXIT.usage, true, true]);
    }
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).found).toBe(false);
  }, 90_000);
});

describe('the queue and a scoped second pass (GSTA-152 D6)', () => {
  // Value: protects=a receipt whose pass 2 was scoped (fix-check, Red Team, native adversarial; no specialists) READYs at the depth
  // its head needs, with no schema change; fails_when=the queue reads review_loop.dispatches or passes as a depth signal; seam=bindShippedReceipt
  test('a scoped pass 2 receipt at the required depth binds, its dispatch roles recorded as written', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const head = commit(repo, { 'lib/big.js': lines(80) });
    const body = path.join(repo.root, 'body.md');
    const loop = { passes: 2, blocking_found: 1, deferred: 0, fixed: 1, scope: 'frozen', dispatches: { specialist: 4, 'adversarial-native': 2, 'outside-voice': 1, 'fix-check': 1, 'red-team': 1 } };
    expect(writeReceipt(repo, body, ['--review-loop', JSON.stringify(loop)]).status).toBe(EXIT.ok);
    expect(receiptIn(body).review_loop).toMatchObject({ passes: 2, dispatches: loop.dispatches });
    const bound = bindShippedReceipt(repo.work, 'origin/main', fs.readFileSync(body, 'utf8'), '7', [head]);
    expect(bound.ok).toBe(true);
    expect(bound.ok && bound.depthLine).toContain('REVIEW_DEPTH: receipt=light required=light');
    expect(bound.ok && bound.depthLine).toMatch(/ rounds=2$/);
  }, 60_000);
});

describe('GSTA-167 part 4a: the data rule never skips the receipt gate scan', () => {
  // Value: protects=F1, receiptDepthAtHead decides the gate scan path-only, so a range whose only change is a data file is
  //   scanned and a failed scan records null, never an unscanned 0; fails_when=the scan is skipped through the data rule;
  //   seam=stub gstack-gate-diff that fails
  test('a data-only range no code names is scanned (a failing scan records null); a markdown-only range is not', () => {
    const run = (files: Record<string, string>) => {
      const repo = makeFixtureRepo(); repos.push(repo);
      const bin = path.join(repo.root, 'stub-bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'gstack-diff-scope'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'gstack-gate-diff'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      return receiptDepthAtHead(repo.work, 'main', bin, commit(repo, files));
    };
    const data = run({ 'wiki/post/data.json': '{"a": 1}\n' });
    expect([data.class, data.runtime_lines, data.gate_scan.tagged]).toEqual(['docs', 0, null]);
    const prose = run({ 'notes/a.md': '# a\n' });
    expect([prose.class, prose.gate_scan.tagged]).toEqual(['docs', 0]);
  }, 60_000);
});
