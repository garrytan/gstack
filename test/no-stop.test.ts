/**
 * The five no-stop defaults (GSTA-258 K1, lib/no-stop.ts, bin/gstack-no-stop): each routine stop that qualifies is
 * recorded as {class, reason, evidence} and the run goes on; anything that does not qualify, and any stop outside
 * the five, still stops for the owner. The autoplan re-gate is covered in test/autoplan-carry.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { validateReceipt } from '../lib/ship-receipt';
import { checkNoStop, notStampOnly, parseDiff, regateTouches, type NoStopRecord } from '../lib/no-stop';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-no-stop');
const ID = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-stop-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const diff = (file: string, was: string[], now: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,3 +1,3 @@', ' context', ...was.map(l => '-' + l), ...now.map(l => '+' + l), ' context', ''].join('\n');
const TIMEOUT = diff('test/worker.test.ts', ["  test('drains', async () => { await drain(); }, 5_000);"], ["  test('drains', async () => { await drain(); }, 30_000);"]);
const check = (cls: string, d?: string, prior: NoStopRecord[] = []) => checkNoStop({ cls, reason: 'r', evidence: 'run 41715705702', prior, diff: d, root: ROOT });

describe('lib/no-stop: what qualifies', () => {
  test('scoped-fix-check: a docs-only or timeout-only round-2 fix qualifies once; code, skill prose or a second one stops', () => {
    expect(check('scoped-fix-check', diff('docs/review-policy-notes.md', ['old wording'], ['new wording']))).toMatchObject({ ok: true, detail: expect.stringContaining('docs-only') });
    expect(check('scoped-fix-check', TIMEOUT)).toMatchObject({ ok: true, detail: expect.stringContaining('timeout-only') });
    expect(check('scoped-fix-check', diff('lib/worker.ts', ['return a;'], ['return b;']))).toMatchObject({ ok: false, reason: expect.stringContaining('neither docs-only') });
    expect(check('scoped-fix-check', diff('ship/SKILL.md.tmpl', ['old'], ['new']))).toMatchObject({ ok: false });
    expect(check('scoped-fix-check', TIMEOUT, [{ class: 'scoped-fix-check', reason: 'x', evidence: 'y' }])).toMatchObject({ ok: false, reason: expect.stringContaining('a second goes to the owner') });
  });

  test('test-timeout-fix: only a raised timeout in a test file qualifies', () => {
    expect(check('test-timeout-fix', TIMEOUT)).toMatchObject({ ok: true });
    expect(check('test-timeout-fix', diff('test/worker.test.ts', ['}, 30_000);'], ['}, 5_000);']))).toMatchObject({ ok: false, reason: expect.stringContaining('does not raise') });
    expect(check('test-timeout-fix', diff('test/worker.test.ts', ['expect(n).toBe(3);'], ['expect(n).toBe(4);']))).toMatchObject({ ok: false, reason: expect.stringContaining('more than a timeout') });
    expect(check('test-timeout-fix', diff('lib/worker.ts', ['const timeoutMs = 5000;'], ['const timeoutMs = 9000;']))).toMatchObject({ ok: false, reason: expect.stringContaining('not a test file') });
    expect(check('test-timeout-fix', diff('test/worker.test.ts', [], ['  // a new line, timeout 30_000']))).toMatchObject({ ok: false });
  });

  test('pregate-flake-rerun: one rerun per run; a second stops', () => {
    expect(check('pregate-flake-rerun')).toMatchObject({ ok: true });
    expect(check('pregate-flake-rerun', undefined, [{ class: 'pregate-flake-rerun', reason: 'x', evidence: 'y' }])).toMatchObject({ ok: false });
  });

  test('stamp-only-carry: a version-only VERSION or package.json move qualifies; a dependency or a product file stops', () => {
    const stamp = diff('package.json', ['  "version": "1.94.41.0",'], ['  "version": "1.94.42.0",']) + diff('VERSION', ['1.94.41.0'], ['1.94.42.0']);
    expect(check('stamp-only-carry', stamp)).toMatchObject({ ok: true, detail: 'version stamp only in package.json, VERSION' });
    expect(notStampOnly(parseDiff(diff('package.json', ['  "zod": "3.0.0",'], ['  "zod": "4.0.0",'])))).toContain('changes more than the version');
    expect(check('stamp-only-carry', diff('package.json', ['  "dev": "bun run a",'], ['  "dev": "bun run b",']))).toMatchObject({ ok: false, reason: expect.stringContaining('more than the version') });
    expect(check('stamp-only-carry', stamp + diff('lib/worker.ts', ['a'], ['b']))).toMatchObject({ ok: false, reason: 'lib/worker.ts is not a stamp file' });
  });

  test('anything outside the five, a missing reason or evidence, or a hand-recorded re-gate still stops', () => {
    expect(check('merge-anyway')).toMatchObject({ ok: false, reason: expect.stringContaining('not one of the five') });
    expect(checkNoStop({ cls: 'pregate-flake-rerun', reason: ' ', evidence: 'run 1', prior: [] })).toMatchObject({ ok: false });
    expect(check('autoplan-regate')).toMatchObject({ ok: false, reason: expect.stringContaining('gstack-autoplan decides') });
  });

  test('regateTouches: a changed number next to a cap, a new arm or a dollar figure counts; kept words and other edits do not', () => {
    expect(regateTouches('- base 500 ms, cap 30 s\n+ base 500 ms, cap 30 s, behind RETRY_BACKOFF=1')).toEqual([]);
    expect(regateTouches('+ An ELI5 sentence added after the revise.')).toEqual([]);
    expect(regateTouches('- cap 30 s\n+ cap 90 s')).toHaveLength(2);
    expect(regateTouches('+ Add a no-gstack arm to the panel.')).toHaveLength(1);
    expect(regateTouches('+ Budget up to $40 for the pilot.')).toHaveLength(1);
    expect(regateTouches('+ Runs on capy-host machines.')).toEqual([]);
  });
});

describe('gstack-no-stop record: the ledger, the grant and the receipt', () => {
  const work = path.join(tmp, 'repo');
  const state = path.join(tmp, 'state');
  const env = { ...process.env, ...ID, GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_DIR: path.join(tmp, 'approvals') };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', timeout: 30_000, env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const run = (...args: string[]) => spawnSync('bun', [...bunIsolationArgs(), BIN, ...args], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  git('init', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(work, 'docs', 'guide.md'), 'old wording\n');
  fs.writeFileSync(path.join(work, 'lib.ts'), 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  test('a docs-only round-2 fix records the class, prints the grant, and the ledger is a valid receipt no_stop', () => {
    fs.writeFileSync(path.join(work, 'docs', 'guide.md'), 'new wording\n');
    git('commit', '-qam', 'docs fix');
    const r = run('record', '--class', 'scoped-fix-check', '--range-base', base, '--reason', 'round-2 fix reworded docs/guide.md', '--evidence', `commit ${git('rev-parse', 'HEAD').slice(0, 12)}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^NO_STOP: scoped-fix-check recorded \(docs-only fix in docs\/guide\.md\)$/m);
    expect(r.stdout).toMatch(/^GRANT: \S+$/m);
    expect(r.stdout).toContain(`--range-base ${base}`);
    const file = r.stdout.match(/^NO_STOP_FILE: (.+)$/m)![1]!;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rows).toEqual([{ class: 'scoped-fix-check', reason: 'round-2 fix reworded docs/guide.md', evidence: expect.stringMatching(/^commit /) }]);
    const approvals = spawnSync('bun', [...bunIsolationArgs(), path.join(ROOT, 'bin', 'gstack-approvals'), 'list', '--json'], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
    const grant = r.stdout.match(/^GRANT: (\S+)$/m)![1];
    expect(JSON.parse(approvals.stdout).rows ?? JSON.parse(approvals.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id: grant, outcome: 'approved', by: 'gstack no-stop default (K1)', scope: `review_loop_grant ${git('rev-parse', 'HEAD')}` })]));
    const receipt = { schema_version: 1, pr: 1, head: 'e'.repeat(40), version: '1.0.0.0', base: 'main', gate: {}, no_stop: rows };
    expect(validateReceipt(receipt as any).filter(e => /no_stop/.test(String(e)))).toEqual([]);
  });

  test('a second scoped fix-check and a code fix both stop for the owner (exit 3) and leave the ledger alone', () => {
    const before = run('list', '--json');
    const second = run('record', '--class', 'scoped-fix-check', '--range-base', base, '--reason', 'again', '--evidence', 'commit x');
    expect(second.status).toBe(3);
    expect(second.stderr).toMatch(/^NO_STOP: refused scoped-fix-check \(one scoped-fix-check per run is recorded already; a second goes to the owner\); stop for the owner$/m);
    fs.writeFileSync(path.join(work, 'lib.ts'), 'export const a = 2;\n');
    git('commit', '-qam', 'code fix');
    const code = run('record', '--class', 'test-timeout-fix', '--range-base', 'HEAD~1', '--reason', 'r', '--evidence', 'e');
    expect(code.status).toBe(3);
    expect(code.stderr).toContain('NO_STOP: refused test-timeout-fix (not a test file: lib.ts)');
    expect(run('list', '--json').stdout).toBe(before.stdout);
  });

  test('a class outside the five stops, and the range-based classes need --range-base', () => {
    expect(run('record', '--class', 'merge-anyway', '--reason', 'r', '--evidence', 'e').status).toBe(3);
    expect(run('record', '--class', 'stamp-only-carry', '--reason', 'r', '--evidence', 'e').status).toBe(2);
  });
});

describe('gstack-no-stop record --class stamp-only-carry --base, and import', () => {
  const work = path.join(tmp, 'stamp');
  const env = { ...process.env, ...ID, GSTACK_STATE_ROOT: path.join(tmp, 'state2'), GSTACK_APPROVALS_DIR: path.join(tmp, 'approvals2') };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', timeout: 30_000, env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(work, rel), text);
  const run = (...args: string[]) => spawnSync('bun', [...bunIsolationArgs(), BIN, ...args], { cwd: work, encoding: 'utf8', timeout: 60_000, env });
  fs.mkdirSync(work, { recursive: true });
  git('init', '-q', '-b', 'main');
  write('VERSION', '1.0.0.0\n'); write('app.ts', 'export const a = 1;\n'); write('other.ts', 'export const b = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'feat');
  write('app.ts', 'export const a = 2;\n'); write('VERSION', '1.0.1.0\n'); git('commit', '-qam', 'feature');
  const receiptHead = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  write('other.ts', 'export const b = 2;\n'); write('VERSION', '1.0.2.0\n'); git('commit', '-qam', 'main moves');
  git('checkout', '-q', 'feat');
  spawnSync('git', ['merge', '-q', 'main', '-m', 'merge main'], { cwd: work, encoding: 'utf8', timeout: 30_000, env });
  write('VERSION', '1.0.3.0\n'); git('add', '-A'); git('commit', '-qm', 'merge main + stamp');

  test('a base merge plus a version stamp qualifies against the receipt head merged into the base', () => {
    const r = run('record', '--class', 'stamp-only-carry', '--range-base', receiptHead, '--base', 'main', '--reason', 'restamp after the base moved', '--evidence', `commit ${git('rev-parse', 'HEAD').slice(0, 12)}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^NO_STOP: stamp-only-carry recorded \(version stamp only in VERSION\)$/m);
    const plain = run('record', '--class', 'stamp-only-carry', '--range-base', receiptHead, '--reason', 'r', '--evidence', 'e');
    expect(plain.status).toBe(3);
    expect(plain.stderr).toContain('other.ts is not a stamp file');
  });

  test('a product edit inside the stamp commit still stops', () => {
    write('app.ts', 'export const a = 3;\n'); write('VERSION', '1.0.4.0\n'); git('commit', '-qam', 'stamp plus a sneaky edit');
    const r = run('record', '--class', 'stamp-only-carry', '--range-base', receiptHead, '--base', 'main', '--reason', 'r', '--evidence', 'e');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('app.ts is not a stamp file');
  });

  test('import adds an autoplan run\'s records once and skips anything outside the five', () => {
    const src = path.join(tmp, 'run-no-stop.json');
    fs.writeFileSync(src, JSON.stringify([{ class: 'autoplan-regate', reason: 'plan edit, no spend', evidence: 'autoplan:run-1@gate_rev=2' }, { class: 'merge-anyway', reason: 'x', evidence: 'y' }]));
    expect(run('import', '--from', src).stdout).toMatch(/^NO_STOP: imported 1 record\(s\)/m);
    expect(run('import', '--from', src).stdout).toMatch(/^NO_STOP: imported 0 record\(s\)/m);
    expect(JSON.parse(run('list', '--json').stdout).records.map((r: NoStopRecord) => r.class)).toEqual(['stamp-only-carry', 'autoplan-regate']);
  });
});

describe('the no-stop defaults in the /ship and /autoplan sources', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const ship = read('ship/sections/tests.md.tmpl');
  const help = spawnSync('bun', [...bunIsolationArgs(), BIN, '--help'], { encoding: 'utf8', timeout: 60_000 }).stdout;
  test.each(['scoped-fix-check', 'test-timeout-fix', 'pregate-flake-rerun', 'stamp-only-carry', 'autoplan-regate'])('the bin help and the policy say what to do on %s', cls => {
    expect(help).toMatch(new RegExp('^      ' + cls + ' +\\S', 'm'));
    expect(read('docs/review-policy.md')).toContain('| `' + cls + '` |');
  });
  test('a refused case and any other stop still stop; the receipt write carries the ledger', () => {
    expect(ship).toContain('three other routine stops go through `gstack-no-stop record` (`--help`); `recorded` goes on,\n`refused` stops.');
    expect(help).toContain('NO_STOP: refused (exit 3): the stop stands. Anything else still stops.');
    expect(read('ship/sections/pr-body.md.tmpl')).toContain('echo --no-stop @"$NS"');
    expect(read('ship/DRIVER.md.tmpl')).toContain('end the run, except `gstack-no-stop`');
    expect(read('autoplan/DRIVER.md.tmpl')).toContain("K1's `autoplan-regate` no-stop");
  });
});
