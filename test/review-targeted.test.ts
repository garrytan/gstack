/**
 * GST-257 PR 1: the targeted review pass on money, gate, auth and secret code
 * (lib/review-targeted.ts, docs/review-policy.md#targeted-pass-on-money-gate-auth-and-secret-code).
 * The classifier, the plan's TARGETED and DISPATCH lines, the dispatch-superset no-loss check
 * against main's reviewers, the production path from render to the receipt and the review-loop
 * summary, and the queue's report-only REVIEW_TARGETED line.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyDiff, planReview, scanNumbers, type PlanInput } from '../lib/review-depth';
import { raisedBy, summarizeReviewLoop } from '../lib/review-scope';
import { TARGETED_RULES, targetedBrief, targetedBriefSha, targetedClasses, type TargetedClass, type TargetedInput } from '../lib/review-targeted';
import { carryReceipt, extractReceipt, renderReceiptBlock } from '../lib/ship-receipt';
import { bindShippedReceipt, parseReviewTargeted, receiptTargetedLine } from '../lib/ship-receipt-depth';
import type { ShipReceipt } from '../lib/headless-artifacts';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { checkoutTree } from '../lib/review-brief';

const ROOT = path.resolve(import.meta.dir, '..');
const PLAN = path.join(ROOT, 'bin', 'gstack-review-plan');
const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); while (repos.length) cleanup(repos.pop()!); });

const input = (paths: string[], o: Partial<TargetedInput> = {}): TargetedInput => ({ paths, added: {}, removed: {}, scope: { SCOPE_AUTH: 'false' }, gateTagged: 0, ...o });
const classesOf = (i: TargetedInput) => targetedClasses(i).classes;

describe('targetedClasses: the four classes from added and deleted lines', () => {
  // Value: protects=a diff that adds or removes money, auth or secret handling gets the targeted reader; fails_when=a class reads only
  //   added lines, so a removed cap or redaction slips through, or a class fires on an unrelated diff; seam=lib/review-targeted.ts
  test('each class has a positive and a negative case, and deleted lines count', () => {
    expect(classesOf(input(['src/run.ts'], { added: { 'src/run.ts': ['const spend_cap_usd = 5;'] } }))).toEqual(['money']);
    expect(classesOf(input(['src/run.ts'], { removed: { 'src/run.ts': ['  if (spent > capUsd) throw new Error("over cap");'] } }))).toEqual(['money']);
    expect(classesOf(input(['src/run.ts'], { added: { 'src/run.ts': ['const MAX_SPEND_USD = 10;'] } }))).toEqual(['money']);
    expect(classesOf(input(['src/evals.ts'], { added: { 'src/evals.ts': ['const client = new Anthropic();'] } }))).toEqual(['money']);
    expect(classesOf(input(['src/billing/invoice.ts']))).toEqual(['money']);
    expect(classesOf(input(['src/run.ts'], { added: { 'src/run.ts': ['const total = a + b;'] } }))).toEqual([]);
    expect(classesOf(input(['src/a.ts'], { gateTagged: 2 }))).toEqual(['gate']);
    expect(classesOf(input(['lib/pregate-check.ts']))).toEqual([]);
    expect(classesOf(input(['src/auth/session.ts'], { scope: { SCOPE_AUTH: 'true' } }))).toEqual(['auth']);
    expect(classesOf(input(['src/auth/session.ts']))).toEqual([]);
    expect(classesOf(input(['lib/authentication.ts', 'src/authorizer/index.ts'], { scope: { SCOPE_AUTH: 'true' } }))).toEqual(['auth']);
    expect(classesOf(input(['src/client.ts'], { added: { 'src/client.ts': ['const key = process.env.OPENAI_API_KEY;'] } }))).toEqual(['secret']);
    expect(classesOf(input(['src/log.ts'], { removed: { 'src/log.ts': ['  console.log(s.replaceAll(process.env.ANTHROPIC_API_KEY ?? "", "***"));'] } }))).toEqual(['secret']);
    expect(classesOf(input(['bin/run.sh'], { added: { 'bin/run.sh': ['curl -H "Authorization: $GH_TOKEN" "$URL"'] } }))).toEqual(['secret']);
    expect(classesOf(input(['lib/credentials.ts']))).toEqual(['secret']);
    expect(classesOf(input(['src/limits.ts'], { added: { 'src/limits.ts': ['const n = process.env.MAX_TOKENS;'] } }))).toEqual([]);
  });

  test('matching is token-bounded: costume, feeder, pricey and author name no class', () => {
    expect(classesOf(input(['src/costume.ts'], { added: { 'src/costume.ts': ['export const costume = 1;', 'export const feeder = 2;', 'export const pricey = 3;', 'const usdRate = 4;'] } }))).toEqual([]);
    expect(classesOf(input(['src/author.ts', 'src/feeder/list.ts'], { scope: { SCOPE_AUTH: 'true' } }))).toEqual([]);
    expect(classesOf(input(['src/spend_usd_total.ts'], { added: { 'src/spend_usd_total.ts': ['const spend_usd_total = 1;'] } }))).toEqual(['money']);
  });

  test('docs and tests paths never trigger, whatever their lines say', () => {
    const lines = ['const spend_cap_usd = 5;', 'const k = process.env.OPENAI_API_KEY;', 'new Anthropic()'];
    const paths = ['docs/billing.md', 'test/billing.test.ts', 'test/fixtures/secrets/key.ts', 'CHANGELOG.md'];
    expect(classesOf(input(paths, { scope: { SCOPE_AUTH: 'true' }, added: Object.fromEntries(paths.map(p => [p, lines])), removed: Object.fromEntries(paths.map(p => [p, lines])) }))).toEqual([]);
  });

  // Value: protects=the classifier fails closed like the depth does; fails_when=an unreadable diff, a scope error or a missing gate
  //   scan returns no class, so the targeted reader silently skips; seam=targetedClasses errors
  test('an input the classifier cannot read fails closed to all four classes with the reason', () => {
    const all: TargetedClass[] = ['money', 'gate', 'auth', 'secret'];
    expect(targetedClasses(input(['src/a.ts'], { scope: undefined }))).toMatchObject({ classes: all, errors: ['scope unavailable (gstack-diff-scope did not run)'] });
    expect(targetedClasses(input(['src/a.ts'], { scope: { SCOPE_ERROR: 'unmatched' } })).classes).toEqual(all);
    expect(targetedClasses(input(['src/a.ts'], { gateTagged: null })).errors).toEqual(['gate scan unavailable']);
    expect(targetedClasses(input(['src/a.ts'], { errors: [{ code: 'numstat_failed', input: 'git diff --numstat' }] })).classes).toEqual(all);
    expect(classesOf(input(['docs/a.md'], { gateTagged: null }))).toEqual([]);
    expect(TARGETED_RULES).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the classifier and the brief are gate class, so an edit that weakens them gets full review', () => {
    for (const p of ['lib/review-targeted.ts', 'review/specialists/targeted.md']) expect(classifyDiff({ paths: [p], scope: {}, gateTagged: 0 }).class).toBe('gate');
  });
});

describe('the targeted brief', () => {
  const text = fs.readFileSync(path.join(ROOT, 'review/specialists/targeted.md'), 'utf8');
  // Value: protects=the brief carries Garry's floor and the checklist's uncapped-spend rule word for word; fails_when=the floor is
  //   paraphrased or the money block cites a line the checklist no longer has; seam=review/specialists/targeted.md
  test('states the floor verbatim, cites the Forced-CRITICAL spend line the checklist still has, and keeps the specialist schema', () => {
    expect(text).toContain('CRITICAL is the blocking floor: a finding that would fail a test, break production, lose data or secrets, or open a security hole (injection, auth bypass, secret exposure). Everything else is INFORMATIONAL.');
    const checklist = fs.readFileSync(path.join(ROOT, 'review/checklist.md'), 'utf8');
    for (const quote of ['a paid call, retry or loop with no cap', 'CRITICAL on sight']) { expect(text).toContain(quote); expect(checklist).toContain(quote); }
    expect(text).toContain('Read-only');
    expect(text).toContain('If no findings: output `NO FINDINGS` and nothing else.');
    expect(text).toContain('"specialist":"targeted"');
  });
  test('targetedBrief keeps the preamble and only the blocks of the classes that hit', () => {
    const brief = targetedBrief(text, ['money', 'secret']);
    expect(brief).toContain('CRITICAL is the blocking floor');
    expect(brief).toContain('## money');
    expect(brief).toContain('## secret');
    expect(brief).not.toContain('## gate');
    expect(brief).not.toContain('## auth');
    expect(() => targetedBrief(text, [])).toThrow(/no class/);
    expect(targetedBriefSha()).toBe(createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'review/specialists/targeted.md'))).digest('hex'));
  });
});

describe('planReview dispatches the targeted reader', () => {
  const plan = (o: Partial<PlanInput>) => planReview({ paths: ['src/a.ts'], scope: {}, gateTagged: 0, diffLines: 5, numbers: scanNumbers({}), history: { fullPasses: 0, last: 'none' }, ...o } as PlanInput);
  const roles = (p: ReturnType<typeof plan>) => p.dispatches.map(d => `${d.role} ${d.effort}`);
  test('at light, standard and full depth when a class hit, never when none did', () => {
    expect(plan({ targeted: { classes: ['money'] } })).toMatchObject({ depth: 'light' });
    expect(roles(plan({ targeted: { classes: ['money'] } }))).toContain('targeted full');
    expect(plan({ diffLines: 80, perPath: [{ path: 'src/a.ts', lines: 80, binary: false }], targeted: { classes: ['secret'] } }).depth).toBe('standard');
    expect(roles(plan({ diffLines: 80, perPath: [{ path: 'src/a.ts', lines: 80, binary: false }], targeted: { classes: ['secret'] } }))).toContain('targeted full');
    expect(plan({ gateTagged: 1, targeted: { classes: ['gate'] } }).depth).toBe('full');
    expect(roles(plan({ gateTagged: 1, targeted: { classes: ['gate'] } }))).toContain('targeted full');
    expect(roles(plan({ targeted: { classes: [] } }))).not.toContain('targeted full');
    expect(roles(plan({ targeted: { classes: ['money'] }, history: { fullPasses: 1, last: 'full', fixedBelow: true } }))).toEqual(['fix-check full', 'targeted full']);
    expect(plan({ targeted: { classes: ['money'] }, history: { fullPasses: 1, last: 'full' } }).dispatches).toEqual([]);
    const ran = plan({ targeted: { classes: ['money'], ran: true } });
    expect(roles(ran)).not.toContain('targeted full');
    expect(ran.skipped).toContain('targeted (already read this product patch)');
  });
});

// --- gstack-review-plan on fixture repositories outside the checkout ---------------------------------------------------
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n';
type Fixture = { base?: Record<string, string>; head: Record<string, string>; args?: string[] };
const FIXTURES: Record<string, Fixture> = {
  'none-light': { head: { 'src/util.ts': lines(5, i => `export const v${i} = ${i};`) } },
  'none-standard': { head: { 'src/util.ts': lines(80, i => `export const v${i} = ${i};`) } },
  'none-docs': { head: { 'docs/billing.md': 'Set spend_cap_usd to 5 and read process.env.OPENAI_API_KEY.\n' } },
  'none-tests': { head: { 'test/billing.test.ts': 'const spend_cap_usd = 5;\nconst k = process.env.OPENAI_API_KEY;\n' } },
  'none-costume': { head: { 'src/costume.ts': 'export const costume = 1;\nexport const feeder = 2;\nexport const pricey = 3;\n' } },
  'none-gate-path': { head: { 'lib/pregate-check.ts': 'export const strict = true;\n' } },
  'secret-light': { head: { 'src/client.ts': 'export const key = process.env.OPENAI_API_KEY;\n' } },
  'secret-path': { head: { 'lib/credentials.ts': 'export const store = new Map<string, string>();\n' } },
  'secret-removed': { base: { 'src/log.ts': 'export function log(s: string) {\n  console.log(s.replaceAll(process.env.ANTHROPIC_API_KEY ?? "", "***"));\n}\n' }, head: { 'src/log.ts': 'export function log(s: string) {\n  console.log(s);\n}\n' } },
  'gate-tagged': { head: { 'src/a.ts': 'export const a = 1;\n' }, args: ['--gate-tagged', '2'] },
  'money-light': { head: { 'src/charge.ts': 'export const spend_cap_usd = 5;\n' } },
  'money-path': { head: { 'src/billing/invoice.ts': 'export const n = 1;\n' } },
  'money-removed': { base: { 'src/run.ts': 'export function run(spent: number, capUsd: number) {\n  if (spent > capUsd) throw new Error("over cap");\n  return spent;\n}\n' }, head: { 'src/run.ts': 'export function run(spent: number, capUsd: number) {\n  return spent;\n}\n' } },
  'money-standard': { head: { 'src/evals.ts': 'import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic();\n' + lines(78, i => `export const v${i} = ${i};`) } },
  'auth-path': { head: { 'src/auth/session.ts': 'export const ttl = 60;\n' } },
  'money-fix-check': { head: { 'src/charge.ts': 'export const spend_cap_usd = 5;\n' }, args: ['--pass', '1', '--last', 'full', '--fixed-below'] },
  'money-pass2': { head: { 'src/charge.ts': 'export const spend_cap_usd = 5;\n' }, args: ['--pass', '1', '--last', 'full', '--fixed-blocking'] },
  'gate-repeat': { head: { 'lib/pregate-check.ts': 'export const strict = true;\n' }, args: ['--gate-tagged', '1', '--pass', '1', '--last', 'full', '--fixed-blocking', '--adversarial-ran'] },
};
/**
 * main's reviewers on each fixture: gstack-review-plan at 8be7f21 (v1.91.351.0, before this change), DISPATCH lines verbatim.
 * The branch must dispatch every one of them unchanged, and add only the targeted reader (the no-loss check: a superset).
 */
const MAIN: Record<string, { depth: string; classes: string; main: string[] }> = {
  'none-light': { depth: 'light', classes: 'none', main: ['specialist batched effort=full checklists=testing,security,state-machines,red-team', 'adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)'] },
  'none-standard': { depth: 'standard', classes: 'none', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'adversarial-native adversarial effort=full', 'outside-voice outside-voice effort=host'] },
  'none-docs': { depth: 'light', classes: 'none', main: [] },
  'none-tests': { depth: 'light', classes: 'none', main: [] },
  'none-costume': { depth: 'light', classes: 'none', main: ['specialist batched effort=full checklists=testing,security,state-machines,red-team', 'adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)'] },
  'none-gate-path': { depth: 'full', classes: 'none', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'red-team red-team effort=full', 'adversarial-native adversarial effort=full', 'outside-voice outside-voice effort=host'] },
  'secret-light': { depth: 'light', classes: 'secret', main: ['specialist batched effort=full checklists=testing,security,state-machines,red-team', 'adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)'] },
  'secret-path': { depth: 'full', classes: 'secret', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'red-team red-team effort=full', 'adversarial-native adversarial effort=full', 'outside-voice outside-voice effort=host'] },
  'secret-removed': { depth: 'light', classes: 'secret', main: ['specialist batched effort=full checklists=testing,security,state-machines,red-team', 'adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)'] },
  'gate-tagged': { depth: 'full', classes: 'gate', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'red-team red-team effort=full', 'adversarial-native adversarial effort=full', 'outside-voice outside-voice effort=host'] },
  'money-light': { depth: 'light', classes: 'money', main: ['specialist batched effort=full checklists=testing,security,state-machines,red-team', 'adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)'] },
  'money-path': { depth: 'light', classes: 'money', main: ['specialist batched effort=full checklists=testing,security,state-machines,red-team', 'adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)'] },
  'money-removed': { depth: 'light', classes: 'money', main: ['specialist batched effort=full checklists=testing,security,state-machines,red-team', 'adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)'] },
  'money-standard': { depth: 'standard', classes: 'money', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'adversarial-native adversarial effort=full', 'outside-voice outside-voice effort=host'] },
  'auth-path': { depth: 'full', classes: 'auth', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'red-team red-team effort=full', 'adversarial-native adversarial effort=full', 'outside-voice outside-voice effort=host'] },
  'money-fix-check': { depth: 'light', classes: 'money', main: ['fix-check fix-check effort=full'] },
  'money-pass2': { depth: 'light', classes: 'money', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'red-team red-team effort=full', 'adversarial-native adversarial effort=full', 'outside-voice outside-voice effort=host'] },
  'gate-repeat': { depth: 'full', classes: 'gate', main: ['specialist batched effort=medium checklists=testing,security,state-machines', 'red-team red-team effort=full'] },
};

function planRepo(f: Fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-plan-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'targeted-plan-state-'));
  dirs.push(dir, state);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  const write = (files: Record<string, string>) => { for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); } };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  write({ 'README.md': '# x\n', ...(f.base ?? {}) }); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat'); write(f.head); git('add', '.'); git('commit', '-qm', 'feat');
  const run = (args: string[]) => spawnSync(PLAN, ['--base', 'main', ...(args.includes('--gate-tagged') ? [] : ['--gate-tagged', '0']), ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: state } });
  return { dir, run, write };
}
const field = (out: string, prefix: string, key: string) => new RegExp(`^${prefix}.* ${key}=(\\S+)`, 'm').exec(out)?.[1];

describe('gstack-review-plan prints TARGETED and dispatches the targeted reader', () => {
  // Value: protects=the no-loss rule for review changes (CREW, 2026-10-30): every reviewer main dispatches on these diffs, at light,
  //   standard and full depth and on fix-check, scoped and repeat steps, is still dispatched unchanged, and the only addition is the
  //   targeted reader on a class diff; fails_when=the change drops, renames or re-efforts any reviewer, or adds the reader on a diff
  //   with no class; seam=bin/gstack-review-plan end to end; no_claim=that the reader finds the defect (the paid replay's question)
  test('the dispatch-superset no-loss check: on every fixture the branch dispatches main\'s reviewers plus only the targeted reader', () => {
    expect(Object.keys(MAIN).sort()).toEqual(Object.keys(FIXTURES).sort());
    expect(new Set(Object.values(MAIN).map(m => m.depth))).toEqual(new Set(['light', 'standard', 'full']));
    for (const [name, f] of Object.entries(FIXTURES)) {
      const r = planRepo(f).run(f.args ?? []);
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
      const got = r.stdout.split('\n').filter(l => l.startsWith('DISPATCH: ')).map(l => l.slice('DISPATCH: '.length));
      const want = MAIN[name]!;
      expect(r.stdout, name).toContain(`REVIEW_DEPTH: ${want.depth} `);
      expect(got.filter(d => !want.main.includes(d)), name).toEqual(want.classes === 'none' ? [] : ['targeted targeted effort=full']);
      expect(want.main.filter(d => !got.includes(d)), name).toEqual([]);
      expect(field(r.stdout, 'TARGETED:', 'classes'), name).toBe(want.classes);
    }
  }, 180_000);

  test('the TARGETED line carries the rules hash and the brief\'s sha256; --targeted-ran skips the reader only for the same product patch', () => {
    const repo = planRepo(FIXTURES['money-light']!);
    const first = repo.run([]);
    expect(field(first.stdout, 'TARGETED:', 'rules')).toBe(TARGETED_RULES);
    expect(field(first.stdout, 'TARGETED:', 'brief')).toBe(targetedBriefSha());
    const patch = field(first.stdout, 'TARGETED:', 'targeted_patch_id')!;
    expect(patch).toMatch(/^[0-9a-f]{40}$/);
    const same = repo.run(['--pass', '1', '--last', 'full', '--fixed-below', '--targeted-ran', patch]);
    expect(same.stdout).not.toContain('DISPATCH: targeted');
    expect(same.stdout).toContain('SKIP: targeted (already read this product patch)');
    const other = repo.run(['--pass', '1', '--last', 'full', '--fixed-below', '--targeted-ran', 'f'.repeat(40)]);
    expect(other.stdout).toContain('DISPATCH: targeted targeted effort=full');
    expect(other.stdout).toContain('DIFF_EXCLUDE: targeted none');
    repo.write({ 'src/charge.ts': 'export const spend_cap_usd = 6;\n' });
    const dirty = repo.run(['--pass', '1', '--last', 'full', '--fixed-below', '--targeted-ran', patch]);
    expect(field(dirty.stdout, 'TARGETED:', 'targeted_patch_id')).toBe('uncommitted');
    expect(dirty.stdout).toContain('DISPATCH: targeted targeted effort=full');
    expect(JSON.parse(repo.run(['--json']).stdout).targeted).toMatchObject({ classes: ['money'], rules: TARGETED_RULES, targeted_patch_id: 'uncommitted' });
    const read = planRepo(FIXTURES['money-light']!);
    const readId = field(read.run([]).stdout, 'TARGETED:', 'targeted_patch_id')!;
    read.write({ 'test/charge.test.ts': 'test("cap", () => {});\n' });
    for (const args of [['add', '.'], ['commit', '-qm', 'test-only fix']]) expect(spawnSync('git', args, { cwd: read.dir, encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    const testFix = read.run(['--gate-tagged', '1', '--pass', '1', '--last', 'full', '--fixed-below', '--targeted-ran', readId]);
    expect(field(testFix.stdout, 'TARGETED:', 'classes')).toBe('money,gate');
    expect(field(testFix.stdout, 'TARGETED:', 'targeted_patch_id')).not.toBe(readId);
    expect(testFix.stdout).toContain('DISPATCH: targeted targeted effort=full');
  }, 90_000);
});

// --- production path: render, sent, collect, judge, verify, receipt write, summary and the queue ------------------------
describe('the targeted role end to end on a fixture repository', () => {
  // Value: protects=the targeted reader's record reaches the receipt only through the verbatim-dispatch ledger, bound to the
  //   receipt's product patch, and the review loop and the queue see it; fails_when=render, sent, collect, judge or verify drop the
  //   role, the record claims done without a collected output, write binds another product patch, summary loses the role, or the
  //   queue refuses on it; seam=bin/gstack-review-dispatch, bin/gstack-ship-receipt write, bin/gstack-review-scope summary and
  //   bindShippedReceipt; no_claim=PR 2's enforcement
  test('render → sent → collect → judge → verify --targeted-out → write --review-targeted → summary → REVIEW_TARGETED', () => {
    const repo = makeFixtureRepo({ prefix: 'targeted-e2e-' });
    repos.push(repo);
    repo.git('checkout', '-q', '-b', 'feat');
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'charge.ts'), 'export const spend_cap_usd = 5;\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'charge');
    const head = repo.git('rev-parse', 'HEAD');
    const base = repo.git('merge-base', 'origin/main', 'HEAD');
    const plan = runBin(repo, 'gstack-review-plan', ['--base', 'main']);
    expect(plan.out).toContain('TARGETED: classes=money ');
    expect(plan.out).toContain('DISPATCH: targeted targeted effort=full');
    const out = path.join(repo.root, 'briefs');
    const ledger = path.join(out, 'review-ledger.jsonl');
    const render = runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'money', '--diff-base', base, '--out', out]);
    expect(render.status, render.err).toBe(0);
    const file = /file=(\S+)/.exec(render.out)![1]!;
    const brief = fs.readFileSync(file, 'utf8');
    expect(brief).toContain('## money');
    expect(brief).not.toContain('## gate');
    expect(brief).toContain(`DIFF_BASE=${base} && git diff "$DIFF_BASE"`);
    expect(brief).toContain('Read the targeted brief above (');
    expect(runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'cost', '--diff-base', base, '--out', path.join(repo.root, 'bad')]).err).toContain('BRIEF_RENDER_FAILED: slot classes must list');
    expect(runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'money', '--base', 'main', '--diff-base', base.slice(0, 12), '--out', path.join(repo.root, 'short')]).status).toBe(0);
    expect(runBin(repo, 'gstack-review-dispatch', ['render', '--role', 'targeted', '--classes', 'money', '--diff-base', head, '--out', path.join(repo.root, 'range')]).err).toContain(`the targeted reader reads the whole diff on every pass: --diff-base must be the merge base with main (${base})`);
    expect(runBin(repo, 'gstack-review-dispatch', ['sent', '--ledger', ledger, '--role', 'targeted', '--sent', file]).out).toContain('BRIEF_SENT: reader=targeted');
    const output = path.join(repo.root, 'targeted.out');
    const finding = { severity: 'CRITICAL', confidence: 8, path: 'src/charge.ts', line: 1, category: 'money', summary: 'cap is never enforced', fingerprint: 'src/charge.ts:1:money', specialist: 'targeted' };
    fs.writeFileSync(output, `REVIEWED_TREE: ${checkoutTree(repo.work)}\n` + JSON.stringify(finding) + '\n');
    const merged = path.join(repo.root, 'merged.jsonl');
    expect(runBin(repo, 'gstack-review-dispatch', ['collect', '--ledger', ledger, '--role', 'targeted', '--output', output, '--merged', merged]).out).toContain('COLLECT: reader=targeted findings=1');
    const judged = path.join(repo.root, 'judged.jsonl');
    fs.writeFileSync(judged, JSON.stringify({ id: 'targeted#1', severity: 'CRITICAL' }) + '\n');
    expect(runBin(repo, 'gstack-review-dispatch', ['judge', '--ledger', ledger, '--merged', merged, '--judged', judged]).out).toContain('JUDGMENT: ok');
    const record = path.join(repo.root, 'targeted.json');
    const verify = runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', ledger, '--targeted-out', record]);
    expect(verify.status, verify.out).toBe(0);
    expect(verify.out).toContain(`TARGETED_RECORD: classes=money status=done findings=1 brief=${targetedBriefSha().slice(0, 12)} rules=${TARGETED_RULES}`);
    expect(verify.out).toContain('VERIFY: clean');
    fs.writeFileSync(path.join(repo.work, 'src', 'charge.ts'), 'export const spend_cap_usd = 50;\n');
    repo.git('commit', '-qam', 'later product change the reader never read');
    expect(runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', ledger]).out).toContain('TARGETED_RECORD: classes=money status=failed findings=0');
    repo.git('reset', '-q', '--hard', head);
    fs.writeFileSync(path.join(repo.work, 'src', 'charge.ts'), 'export const spend_cap_usd = 7;\n');
    expect(runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', ledger]).out).toContain('TARGETED_RECORD: classes=money status=failed findings=0');
    repo.git('checkout', '--', 'src/charge.ts');
    expect(runBin(repo, 'gstack-review-dispatch', ['verify', '--ledger', ledger]).out).toContain('TARGETED_RECORD: classes=money status=done findings=1');

    const body = path.join(repo.root, 'body.md');
    const write = runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'unattended', '--review-targeted', `@${record}`, '--body', body, '--json']);
    expect(write.status, write.err).toBe(0);
    const receipt = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!;
    expect(receipt.review_targeted).toEqual({ classes: ['money'], rules: TARGETED_RULES, brief_sha: targetedBriefSha(), product_patch_id: receipt.product_patch_id!, status: 'done', findings: 1, raised_by: 'targeted' });
    const rebound = runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'unattended', '--review-targeted', JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), product_patch_id: 'x' }), '--json']);
    expect(rebound.status).not.toBe(0);
    expect(rebound.err).toContain("write binds the pass to the receipt's product_patch_id");
    const plain = runBin(repo, 'gstack-ship-receipt', ['write', '--base', 'main', '--session-kind', 'unattended', '--json']);
    expect(plain.status, plain.err).toBe(0);
    expect(JSON.parse(plain.out)).not.toHaveProperty('review_targeted');

    const slug = runBin(repo, 'gstack-slug', ['--get', 'SLUG']).out.trim();
    const logDir = path.join(repo.home, 'projects', slug);
    fs.mkdirSync(logDir, { recursive: true });
    const row = { skill: 'review', via: 'ship', timestamp: '2026-10-30T10:00:00Z', status: 'clean', review_scope: 'frozen', findings: [], dispatches: [{ role: 'specialist' }, { role: 'adversarial-native' }, { role: 'targeted' }] };
    fs.writeFileSync(path.join(logDir, 'feat-reviews.jsonl'), JSON.stringify(row) + '\n');
    const summary = runBin(repo, 'gstack-review-scope', ['summary', '--since', '2026-10-30T09:00:00Z', '--json']);
    expect(summary.status, summary.err).toBe(0);
    expect(JSON.parse(summary.out).dispatches).toEqual({ specialist: 1, 'adversarial-native': 1, targeted: 1 });

    const bodyText = fs.readFileSync(body, 'utf8');
    const ok = bindShippedReceipt(repo.work, 'origin/main', bodyText, undefined, [head]);
    expect(ok).toMatchObject({ ok: true, targetedLine: 'REVIEW_TARGETED: required=money receipt=money verdict=ok' });
    const { review_targeted: _drop, ...legacy } = receipt;
    const missing = bindShippedReceipt(repo.work, 'origin/main', renderReceiptBlock(legacy as ShipReceipt), undefined, [head]);
    expect(missing).toMatchObject({ ok: true, targetedLine: 'REVIEW_TARGETED: required=money receipt=legacy verdict=missing' });
    const failed = bindShippedReceipt(repo.work, 'origin/main', renderReceiptBlock({ ...receipt, review_targeted: { ...receipt.review_targeted!, status: 'failed' } }), undefined, [head]);
    expect(failed).toMatchObject({ ok: true, targetedLine: 'REVIEW_TARGETED: required=money receipt=none verdict=missing' });
  }, 180_000);
});

describe('the receipt record and the queue line', () => {
  const record = { classes: ['gate', 'money'], rules: TARGETED_RULES, brief_sha: 'a'.repeat(64), status: 'done', findings: 0, raised_by: 'targeted' };
  test('parseReviewTargeted binds the receipt\'s product patch, orders the classes and refuses a malformed record', () => {
    expect(parseReviewTargeted(record, 'p1')).toEqual({ ok: true, targeted: { ...record, classes: ['money', 'gate'], product_patch_id: 'p1' } as any });
    for (const bad of [{ ...record, classes: ['cost'] }, { ...record, status: 'skipped' }, { ...record, findings: -1 }, { ...record, brief_sha: 'abc' }, { ...record, extra: 1 }, null]) expect(parseReviewTargeted(bad, 'p1').ok).toBe(false);
  });
  // Value: protects=PR 1's queue only reports; fails_when=the line misreads a legacy, failed or partial receipt as covered, or a
  //   receipt without classes as required; seam=receiptTargetedLine (the line ready and train build print)
  test('REVIEW_TARGETED reports ok, missing and legacy', () => {
    const r = (rt?: object) => ({ schema_version: 1, head: 'h', base: 'main', ...(rt ? { review_targeted: { ...record, product_patch_id: 'p', ...rt } } : {}) }) as ShipReceipt;
    expect(receiptTargetedLine([], r())).toBe('REVIEW_TARGETED: required=none receipt=legacy verdict=ok');
    expect(receiptTargetedLine(['money'], r())).toBe('REVIEW_TARGETED: required=money receipt=legacy verdict=missing');
    expect(receiptTargetedLine(['money'], r({}))).toBe('REVIEW_TARGETED: required=money receipt=gate,money verdict=ok');
    expect(receiptTargetedLine(['money', 'secret'], r({}))).toBe('REVIEW_TARGETED: required=money,secret receipt=gate,money verdict=missing');
    expect(receiptTargetedLine(['gate'], r({ status: 'failed' }))).toBe('REVIEW_TARGETED: required=gate receipt=none verdict=missing');
    expect(receiptTargetedLine([], r({ classes: [], status: 'not-run' }))).toBe('REVIEW_TARGETED: required=none receipt=none verdict=ok');
  });
  test('a carry keeps review_targeted with the unchanged product patch', () => {
    const receipt = { schema_version: 1, head: 'a'.repeat(40), base: 'main', product_patch_id: 'p', review_targeted: { ...record, product_patch_id: 'p' } } as ShipReceipt;
    const carried = carryReceipt(receipt, 'b'.repeat(40), { from: 'a'.repeat(40), reason: 'base merge', product_patch_id: 'p', changed_paths: [], merge_commits: 1, range_diff: 'same', covers: [], reruns: [] }, { tree: 't', productPatchId: 'p' });
    expect(carried.review_targeted).toEqual(receipt.review_targeted);
    expect(carried.product_patch_id).toBe(carried.review_targeted!.product_patch_id);
  });
  test('the targeted reader\'s findings are attributed to it and read as a Step 11 voice', () => {
    expect(raisedBy({ specialist: 'targeted' })).toBe('targeted');
    expect(summarizeReviewLoop([{ skill: 'review', via: 'ship', timestamp: '2026-10-30T10:00:00Z', dispatches: [{ role: 'targeted', prompt_bytes: 40 }] }], '2026-10-30T09:00:00Z')).toMatchObject({ dispatches: { targeted: 1 }, est_input_tokens: 10 });
  });
});
