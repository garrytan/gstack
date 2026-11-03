/**
 * gstack-ship-receipt carry with a base-policy carry_mechanical allowlist (GST-1210 item 2): a declared version
 * constant retaken after a base merge, plus goldens the pregate's regen check proved at HEAD, keeps the receipt when the
 * rest of the branch is what the review read (docs/ship-policy.md#receipt-carry).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { carryMechanicalErrors, maskConstant } from '../lib/ship-carry-mechanical';
import { extractReceipt } from '../lib/ship-receipt';
import { CARRY_MECHANICAL_KEY_VERSION, DEFAULT_POLICY, POLICY_KEY_INTRODUCED, validatePolicy, type PolicyError } from '../lib/ship-policy';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const TEMPLATE = 'const SAVE_VERSION = {n};';
const POLICY = JSON.stringify({ min_gstack_version: CARRY_MECHANICAL_KEY_VERSION, carry_mechanical: { version_constants: [{ path: 'src/game.js', template: TEMPLATE }], goldens: ['tests/goldens/**'] } }, null, 2) + '\n';
const REGISTRY = { $schema: 'https://github.com/garrytan/gstack/docs/pregate.md#generated-v1', entries: [{ id: 'digest', command: 'node gen.js', outputs: ['tests/goldens/**'], inputs: ['src/**', 'gen.js'] }] };
const GEN = "const fs=require('fs');const {SAVE_VERSION}=require('./src/game.js');fs.writeFileSync('tests/goldens/digest.txt','# digest v'+SAVE_VERSION+'\\n');\n";
const game = (n: number, o: { score?: string; bonus?: string; after?: string } = {}) =>
  `const SAVE_VERSION = ${n};\n${o.after ?? ''}exports.SAVE_VERSION = SAVE_VERSION;\nexports.score = (a) => ${o.score ?? 'a * 2'};\n// one\n// two\n// three\n// four\n// five\nexports.bonus = (a) => ${o.bonus ?? 'a + 1'};\n`;
const digest = (n: number) => `# digest v${n}\n`;
const pregateOut = (repo: FixtureRepo) => path.join(repo.work, '.gstack/tmp/pregate.json');
const pregate = (repo: FixtureRepo) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands']);

/**
 * main holds 41; the branch reviews a score change that took 42; main then takes 42 itself and edits bonus (an
 * unrelated function); the branch merges main and retakes 43 with `head` (the default also regenerates the digest).
 */
function retaken(o: { policyOnBranch?: boolean; reviewedGame?: string; head?: Record<string, string> } = {}): { repo: FixtureRepo; reviewed: string; body: string } {
  const repo = makeFixtureRepo({ registry: REGISTRY, pregate: { ...BASE_PREGATE, dependencies: { ...BASE_PREGATE.dependencies, 'tests/goldens/**': [] } }, baseFiles: { 'src/game.js': game(41), 'gen.js': GEN, 'tests/goldens/digest.txt': digest(41), ...(o.policyOnBranch ? {} : { '.gstack/ship-policy.json': POLICY }) } });
  repos.push(repo);
  const reviewed = commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n', 'src/game.js': o.reviewedGame ?? game(42, { score: 'a * 3' }), 'tests/goldens/digest.txt': digest(42), ...(o.policyOnBranch ? { '.gstack/ship-policy.json': POLICY } : {}) }, 'triple the score, take 42');
  const body = path.join(repo.root, 'body.md');
  const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '9', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body]);
  expect(w.status).toBe(EXIT.ok);
  repo.git('checkout', '-q', 'main');
  commit(repo, { 'src/game.js': game(42, { bonus: 'a + 2' }), 'tests/goldens/digest.txt': digest(42) }, 'main: take 42, raise the bonus');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'feature');
  repo.git('merge', '-q', '--no-edit', 'origin/main');
  commit(repo, o.head ?? { 'src/game.js': game(43, { score: 'a * 3', bonus: 'a + 2' }), 'tests/goldens/digest.txt': digest(43) }, 'retake 43');
  return { repo, reviewed, body };
}

const carry = (repo: FixtureRepo, body: string, withPregate = true) =>
  runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--base', 'main', ...(withPregate ? ['--pregate', pregateOut(repo)] : [])]);
const headOf = (body: string) => extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.head;

describe('carry_mechanical: a retaken version constant and proven goldens (GST-1210)', () => {
  // Value: protects=founderstar's rules-number retake keeps its receipt when the base also edited the file;
  // fails_when=carry compares the constant line as product; seam=none; no_claim=gh pr edit (--body stands in)
  test('the retaken constant plus regenerated goldens carries, naming the constant and its values', () => {
    const { repo, reviewed, body } = retaken();
    const head = repo.git('rev-parse', 'HEAD');
    expect(pregate(repo).status).toBe(EXIT.ok);
    const out = carry(repo, body);
    expect(out.err).not.toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.status).toBe(EXIT.ok);
    expect(out.out).toContain(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)}`);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.carry!.reason).toContain('mechanical version constant (src/game.js 42 → 43)');
  }, 120_000);

  // Value: protects=fail closed: logic on the line next to the masked constant is unreviewed product;
  // fails_when=the mask hides more than the constant's digits; seam=none; no_claim=-
  test('a logic edit next to the constant refuses with RECEIPT_CARRY_PRODUCT_CHANGED naming the file', () => {
    const { repo, reviewed, body } = retaken({ head: { 'src/game.js': game(43, { score: 'a * 3', bonus: 'a + 2', after: 'exports.cheat = true;\n' }), 'tests/goldens/digest.txt': digest(43) } });
    expect(pregate(repo).status).toBe(EXIT.ok);
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.out).toContain('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    expect(out.err).toContain('src/game.js');
    expect(headOf(body)).toBe(reviewed);
  }, 120_000);

  // Value: protects=only one whole constant line with a higher value is mechanical; fails_when=the template matches a
  // prefix of the line, a second constant line is masked, or the value goes down; seam=none; no_claim=-
  test('trailing code on the constant line, a second constant line, or a lower value refuses', () => {
    const rest = game(43, { score: 'a * 3', bonus: 'a + 2' }).split('\n').slice(1).join('\n');
    for (const text of [`const SAVE_VERSION = 43; exports.cheat = true;\n${rest}`, game(43, { score: 'a * 3', bonus: 'a + 2', after: 'const SAVE_VERSION = 44;\n' }), game(40, { score: 'a * 3', bonus: 'a + 2' })]) {
      const { repo, reviewed, body } = retaken({ head: { 'src/game.js': text, 'tests/goldens/digest.txt': digest(43) } });
      pregate(repo);
      const out = carry(repo, body);
      expect(out.status).toBe(EXIT.refused);
      expect(out.err).toContain('src/game.js');
      expect(headOf(body)).toBe(reviewed);
    }
  }, 360_000);

  // Value: protects=the goldens' regeneration check gates the carry; fails_when=a missing or red regen check still
  // carries; seam=none; no_claim=-
  test('a missing regen check or stale goldens refuse', () => {
    const missing = retaken();
    const m = carry(missing.repo, missing.body, false);
    expect(m.status).toBe(EXIT.refused);
    expect(m.err).toContain('regen');
    expect(headOf(missing.body)).toBe(missing.reviewed);
    const stale = retaken({ head: { 'src/game.js': game(43, { score: 'a * 3', bonus: 'a + 2' }) } });
    pregate(stale.repo);
    const s = carry(stale.repo, stale.body);
    expect(s.status).toBe(EXIT.refused);
    expect(headOf(stale.body)).toBe(stale.reviewed);
  }, 240_000);

  // Value: protects=the common shape, where the PR's only edit to the declared file is the constant; fails_when=masked
  // sides with no branch edit read as changed; seam=none; no_claim=-
  test('a branch whose only edit to the declared file is the constant carries', () => {
    const { repo, reviewed, body } = retaken({ reviewedGame: game(42), head: { 'src/game.js': game(43, { bonus: 'a + 2' }), 'tests/goldens/digest.txt': digest(43) } });
    expect(pregate(repo).status).toBe(EXIT.ok);
    const out = carry(repo, body);
    expect(out.err).not.toContain('RECEIPT_CARRY_PRODUCT_CHANGED');
    expect(out.status).toBe(EXIT.ok);
    expect(headOf(body)).not.toBe(reviewed);
  }, 120_000);

  // Value: protects=every changed golden must be proven; fails_when=a golden outside the regen check's proven list rides
  // the carry; seam=none; no_claim=-
  test('a changed golden the regen check did not prove refuses', () => {
    const { repo, reviewed, body } = retaken({ head: { 'src/game.js': game(43, { score: 'a * 3', bonus: 'a + 2' }), 'tests/goldens/digest.txt': digest(43), 'tests/goldens/extra.txt': 'unowned\n' } });
    pregate(repo);
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.err).toContain('tests/goldens/extra.txt');
    expect(headOf(body)).toBe(reviewed);
  }, 120_000);

  // Value: protects=a PR cannot widen its own carry; fails_when=carry reads carry_mechanical from the PR's policy;
  // seam=none; no_claim=-
  test('a carry_mechanical policy that only the PR declares is ignored', () => {
    const { repo, reviewed, body } = retaken({ policyOnBranch: true });
    pregate(repo);
    const out = carry(repo, body);
    expect(out.status).toBe(EXIT.refused);
    expect(out.out).toContain('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    expect(headOf(body)).toBe(reviewed);
  }, 120_000);
});

describe('carry_mechanical policy and mask', () => {
  // Value: protects=the mask touches exactly one whole line's digits; fails_when=a prefix, a second line or a
  // non-digit slot matches; seam=maskConstant
  test('maskConstant masks one whole matching line and refuses anything else', () => {
    expect(maskConstant('a\nconst SAVE_VERSION = 43;\nb\n', TEMPLATE)).toEqual({ masked: `a\n${TEMPLATE}\nb\n`, value: 43 });
    expect(maskConstant('const SAVE_VERSION = 43; x();\n', TEMPLATE)).toBeNull();
    expect(maskConstant('const SAVE_VERSION = 4x;\n', TEMPLATE)).toBeNull();
    expect(maskConstant('const SAVE_VERSION = ;\n', TEMPLATE)).toBeNull();
    expect(maskConstant('const SAVE_VERSION = 1;\nconst SAVE_VERSION = 2;\n', TEMPLATE)).toBeNull();
    expect(maskConstant('nothing here\n', TEMPLATE)).toBeNull();
  });

  // Value: protects=carry_mechanical defaults to none, needs its reader floor and admits only literal one-slot
  // templates on literal paths; fails_when=a glob path, a two-slot or multi-line template validates; seam=validatePolicy
  test('validation: defaults, floor, literal paths and one-slot templates', () => {
    const codes = (v: unknown) => { const out: PolicyError[] = []; carryMechanicalErrors(v, out); return out.map(e => `${e.code}:${e.path}`); };
    const one = (p: string, template = TEMPLATE) => ({ version_constants: [{ path: p, template }], goldens: [] });
    expect(DEFAULT_POLICY.carry_mechanical).toEqual({ version_constants: [], goldens: [] });
    expect(POLICY_KEY_INTRODUCED.carry_mechanical).toBe(CARRY_MECHANICAL_KEY_VERSION);
    expect(validatePolicy({ min_gstack_version: CARRY_MECHANICAL_KEY_VERSION, carry_mechanical: { ...one('src/game.js'), goldens: ['tests/goldens/**'] } })).toEqual([]);
    expect(validatePolicy({ carry_mechanical: one('src/game.js') }).map(e => e.path)).toContain('carry_mechanical');
    expect(codes(one('src/*.js'))).toEqual(['POLICY_CONTAINMENT:carry_mechanical.version_constants[0].path']);
    expect(codes(one('../x.js'))).toEqual(['POLICY_CONTAINMENT:carry_mechanical.version_constants[0].path']);
    expect(codes(one('a.js', 'x = {n}; y = {n};'))).toEqual(['POLICY_INVALID:carry_mechanical.version_constants[0].template']);
    expect(codes(one('a.js', '{n}'))).toEqual(['POLICY_INVALID:carry_mechanical.version_constants[0].template']);
    expect(codes(one('a.js', 'x = {n};\ny();'))).toEqual(['POLICY_CONTAINMENT:carry_mechanical.version_constants[0].template']);
    expect(codes({ version_constants: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.js`, template: TEMPLATE })), goldens: [] })).toEqual(['POLICY_CONTAINMENT:carry_mechanical.version_constants']);
    expect(codes({ version_constants: [], goldens: ['../out/**'] })).toEqual(['POLICY_CONTAINMENT:carry_mechanical.goldens[0]']);
    expect(codes({ version_constants: [] })).toEqual(['POLICY_INVALID:carry_mechanical.goldens']);
  });
});
