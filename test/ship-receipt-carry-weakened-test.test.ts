/**
 * GST-2204 (GSTA-461 item 6): a receipt carry treated every edit under test/ as harmless, so a lane whose test went red
 * after /ship could loosen the assertion (`expect(a).toBe(1)` became `expect(typeof a).toBe('number')`), carry the
 * receipt as a "test-only change" and land with no reviewer reading the edit. The same route emptied
 * test/land-merged-checks.txt, the list land runs on a moved base. Here: a carry whose test diff removes or changes
 * assertion lines refuses with RECEIPT_CARRY_TEST_WEAKENED naming the hunks and carries only after one scoped fix-check
 * bound to the packet; the land list and the touchfile maps are gate paths a test-only carry cannot hold; a pure test
 * addition, a base-side assertion change and a skipped test (still refused by the depth check) are the controls.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { removedAssertions } from '../lib/ship-carry-tests';
import { classifyCarryPath, extractReceipt } from '../lib/ship-receipt';
import { RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const RECEIPT = path.join(path.dirname(RELEASE), 'gstack-ship-receipt');
const UNATTENDED = { GSTACK_SESSION_KIND: 'unattended' };
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const APP_TEST = 'test/app.test.ts';
const LAND_LIST = 'test/land-merged-checks.txt';
const suite = (...bodies: string[]) => ["import { expect, test } from 'bun:test';", "import { a } from '../src/a';", ...bodies].join('\n') + '\n';
const STRICT = "test('a is 1', () => { expect(a).toBe(1); });";
const LOOSE = "test('a is 1', () => { expect(typeof a).toBe('number'); });";

/** The audit's repro: a branch reviewed at its first commit, with a receipt gstack-ship-receipt write recorded there. */
function reviewed(base: Record<string, string> = {}, feat: Record<string, string> = {}) {
  const f = shipFixture({ [APP_TEST]: suite(STRICT), [LAND_LIST]: `${APP_TEST}\n`, ...base }, { 'src/b.ts': 'export const b = 2;\n', ...feat }); ships.push(f);
  const from = f.git('rev-parse', 'HEAD').stdout.trim();
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, '## Summary\n');
  const w = f.run(RECEIPT, ['write', '--pr', '9', '--base', 'main', '--body', body], UNATTENDED);
  expect([w.status, w.stderr.slice(0, 400)]).toEqual([EXIT.ok, expect.any(String)]);
  expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.review_depth).toBeDefined();
  const carry = (extra: string[] = []) => f.run(RECEIPT, ['carry', '--body', body, '--base', 'main', ...extra], UNATTENDED);
  const edit = (files: Record<string, string>, msg = 'test: edit after review') => { f.write(files); f.commit(msg); return f.git('rev-parse', 'HEAD').stdout.trim(); };
  const receipt = () => extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
  return { f, from, body, carry, edit, receipt };
}

const firstLine = (s: string) => s.trim().split('\n')[0];
const packetOf = (err: string) => /one fix-check reviewer reads (\S+) \(packet_sha256 ([0-9a-f]{64})\)/.exec(err);

describe('a carry whose test diff removes or changes assertion lines (GST-2204)', () => {
  // Value: protects=a weakened assertion after review needs a reader before the receipt carries; fails_when=carry prints
  // "test-only change" for the audit's repro again, or names no hunk; seam=none
  test('the audit repro refuses with RECEIPT_CARRY_TEST_WEAKENED naming the hunk, and carries after a bound clean fix-check', () => {
    const x = reviewed();
    const head = x.edit({ [APP_TEST]: suite(LOOSE) });
    const ask = x.carry();
    expect([ask.status, firstLine(ask.stdout)], ask.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_TEST_WEAKENED)']);
    expect(ask.stderr).toContain(`${APP_TEST}:3`);
    expect(x.receipt().head).toBe(x.from);
    const found = packetOf(ask.stderr);
    expect(found, ask.stderr).not.toBeNull();
    const packet = fs.readFileSync(found![1]!, 'utf8');
    expect(packet).toContain(`-${STRICT}`);
    expect(packet).toContain(`+${LOOSE}`);

    const record = (v: object) => { const file = path.join(x.f.root, 'test-review.json'); fs.writeFileSync(file, JSON.stringify(v)); return file; };
    const unbound = x.carry(['--test-review', record({ head, paths: [APP_TEST], reviewer: 'anthropic/claude-opus-5-5', verdict: 'clean' })]);
    expect([unbound.status, firstLine(unbound.stdout)], unbound.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_REFUSED)']);
    expect(unbound.stderr).toContain('packet_sha256');
    const blocking = x.carry(['--test-review', record({ head, paths: [APP_TEST], reviewer: 'anthropic/claude-opus-5-5', verdict: 'blocking', packet_sha256: found![2] })]);
    expect(blocking.status).toBe(EXIT.refused);
    const clean = x.carry(['--test-review', record({ head, paths: [APP_TEST], reviewer: 'anthropic/claude-opus-5-5', verdict: 'clean', packet_sha256: found![2] })]);
    expect([clean.status, clean.stderr.slice(0, 600)]).toEqual([EXIT.ok, expect.any(String)]);
    expect(clean.stdout).toContain('test assertions changed (scoped review by anthropic/claude-opus-5-5');
    expect(x.receipt().head).toBe(head);
  });

  // Value: protects=removing every assertion or a whole test block is the same hole; fails_when=only a changed line
  // counts, or a removed block carries; seam=none
  test('emptied assertions refuse the same way and --dry-run writes nothing; a removed test block refuses too', () => {
    const x = reviewed({ [APP_TEST]: suite(STRICT, "test('a is truthy', () => { expect(a).toBeTruthy(); });") });
    x.edit({ [APP_TEST]: suite(STRICT, "test('a is truthy', () => { void a; });") });
    const dry = x.carry(['--dry-run']);
    expect([dry.status, firstLine(dry.stdout)], dry.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_TEST_WEAKENED)']);
    expect(dry.stderr).toContain(`${APP_TEST}:4`);
    expect(dry.stderr).toContain('nothing written');
    expect(packetOf(dry.stderr)).toBeNull();
    x.edit({ [APP_TEST]: suite(STRICT) });
    const removed = x.carry();
    expect(removed.status, removed.stderr).toBe(EXIT.refused);
    expect(x.receipt().head).toBe(x.from);
  });

  // Value: protects=the negative controls the brief names; fails_when=a pure addition or a base-side change starts refusing,
  // or test.skip stops refusing; seam=none
  test('a pure test addition still carries as a test-only change', () => {
    const x = reviewed();
    const head = x.edit({ [APP_TEST]: suite(STRICT, "test('a is small', () => { expect(a).toBeLessThan(5); });") });
    const r = x.carry();
    expect([r.status, r.stderr.slice(0, 600)]).toEqual([EXIT.ok, expect.any(String)]);
    expect(r.stdout).toContain('(test-only change)');
    expect(x.receipt().head).toBe(head);
  });

  test('an assertion the base changed, merged in, still carries as a base merge', () => {
    const x = reviewed();
    x.f.advanceBase({ [APP_TEST]: suite("test('a is 1', () => { expect(a).toEqual(1); });") });
    x.f.git('fetch', '-q', 'origin');
    expect(x.f.git('merge', '-q', '--no-edit', 'origin/main').status).toBe(0);
    const r = x.carry();
    expect([r.status, r.stderr.slice(0, 600)]).toEqual([EXIT.ok, expect.any(String)]);
    expect(r.stdout).toContain('base merge');
  });

  // Value: protects=the base dropping an assertion in one test cannot cover the branch dropping the same text in another;
  // fails_when=base removals cancel branch removals by text alone again; seam=none
  test('a removal the base made in another test does not cancel the branch removing the same assertion', () => {
    const block = (name: string, kept: boolean) => [`test('${name}', () => {`, ...(kept ? ['  expect(a).toBe(1);'] : []), '});'].join('\n');
    const three = (a: boolean, b: boolean, c: boolean) => suite(block('A', a), block('B', b), block('C', c));
    const x = reviewed({ [APP_TEST]: three(true, true, true) }, { [APP_TEST]: three(false, true, true) });
    x.f.advanceBase({ [APP_TEST]: three(true, true, false) });
    x.f.git('fetch', '-q', 'origin');
    expect(x.f.git('merge', '-q', '--no-edit', 'origin/main').status).toBe(0);
    x.edit({ [APP_TEST]: three(true, false, true) });
    const r = x.carry(['--dry-run']);
    expect([r.status, firstLine(r.stdout)], r.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_TEST_WEAKENED)']);
    expect(r.stderr).toContain(`${APP_TEST}:6`);
  });

  test('test.skip still refuses through the review depth, ahead of the scoped fix-check', () => {
    const x = reviewed();
    const head = x.edit({ [APP_TEST]: suite(STRICT.replace("test('", "test.skip('")) });
    const r = x.carry();
    expect([r.status, firstLine(r.stdout)], r.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_REFUSED)']);
    expect(r.stderr).toContain(`HEAD ${head.slice(0, 12)} needs full review depth`);
  });
});

describe('the land list and the touchfile maps are gate paths (GST-2204)', () => {
  // Value: protects=the list land runs on a moved base cannot be emptied under a test-only carry; fails_when=the land list or
  // a touchfile map classifies as test again; seam=none
  test('an emptied test/land-merged-checks.txt refuses as a product change', () => {
    const x = reviewed();
    x.edit({ [LAND_LIST]: '' });
    const r = x.carry();
    expect([r.status, firstLine(r.stdout)], r.stderr).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)']);
    expect(r.stderr).toContain(LAND_LIST);
    expect(x.receipt().head).toBe(x.from);
  });

  test('classifyCarryPath puts the land list and the touchfile maps in product, other test files in test', () => {
    for (const p of [LAND_LIST, 'test/helpers/touchfiles-data.ts', 'test/helpers/touchfiles.ts', 'test/helpers/test-selection.ts', 'test/helpers/touchfile-closure.ts']) expect([p, classifyCarryPath(p)]).toEqual([p, 'product']);
    for (const p of [APP_TEST, 'test/helpers/ship-bin-fixture.ts', 'test/fixtures/land-merged-checks.txt']) expect([p, classifyCarryPath(p)]).toEqual([p, 'test']);
  });

  // Value: protects=paid-eval quarantine, budgets and ratchet allowlists cannot be loosened under a test-only carry;
  // fails_when=any of them classifies as test again; seam=none
  test('the eval policy and budget data and the ratchet allowlists are product too', () => {
    for (const p of ['test/helpers/periodic-exclude-data.ts', 'test/helpers/eval-budgets.ts', 'test/fixtures/module-size-ratchet.json', 'test/fixtures/skill-md-size-allowlist.json', 'test/state-root-ratchet.allowlist.json']) {
      expect([p, classifyCarryPath(p)]).toEqual([p, 'product']);
    }
  });
});

describe('removedAssertions reads the removed lines of a zero-context diff', () => {
  const diff = (...hunks: string[]) => ['diff --git a/t.test.ts b/t.test.ts', '--- a/t.test.ts', '+++ b/t.test.ts', ...hunks].join('\n') + '\n';
  test('a changed or removed assertion, matcher or test block counts; an added one and a plain removed line do not', () => {
    expect(removedAssertions(diff('@@ -3 +3 @@', `-${STRICT}`, `+${LOOSE}`))).toEqual([{ line: 3, text: STRICT }]);
    expect(removedAssertions(diff('@@ -7,2 +6,0 @@', "-  it('works', () => {", '-    assert.equal(x, 1);'))).toEqual([{ line: 6, text: "it('works', () => {" }, { line: 6, text: 'assert.equal(x, 1);' }]);
    expect(removedAssertions(diff('@@ -4 +4 @@', '-  .toEqual({ a: 1 })', '+  .toMatchObject({})'))).toEqual([{ line: 4, text: '.toEqual({ a: 1 })' }]);
    expect(removedAssertions(diff('@@ -2,0 +3 @@', `+${STRICT}`))).toEqual([]);
    expect(removedAssertions(diff('@@ -2 +2 @@', '-const fixture = load();', '+const fixture = loadAll();'))).toEqual([]);
  });
  test('Python, Go and Ruby assertion forms count', () => {
    for (const line of ['assert result == 1', 'self.assertEqual(a, 1)', 't.Fatalf("got %d", a)', 'require.Equal(t, 1, a)', 'expect(a).to eq 1', 'def test_parses(self):', 'func TestParse(t *testing.T) {']) {
      expect([line, removedAssertions(diff('@@ -1 +0,0 @@', `-${line}`)).length]).toEqual([line, 1]);
    }
  });
});
