/**
 * G1 (#973): `gstack-plan-reality check` opens every file:line receipt. A
 * receipt naming a missing file, or a line past the end of a real file, is
 * unresolved and keeps the phase open; a receipt this checkout cannot judge
 * (outside every root, a sha a shallow clone lacks) is reported, never
 * blocking. The pure `checkRealityRows` is unchanged; only the bin resolves.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRealityLines } from '../lib/plan-reality';
import { receiptTokens, resolveReceipts } from '../lib/plan-reality-receipts';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-plan-reality');

function fixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reality-receipts-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'a.ts'), 'one\ntwo\nthree\n');
  spawnSync('git', ['init', '-q'], { cwd: dir, timeout: 10_000 });
  return dir;
}

const rows = (receipts: Record<string, string>) => ['premise-table', 'already-done', 'surface-check', 'binding-decisions', 'numbers', 'deferred-asks', 'pr-count']
  .map(id => `REALITY: ${id} pass checked ${receipts[id] ?? 'lib/a.ts:1'}`).join('\n') + '\n';

function check(cwd: string, review: string, extra: string[] = []) {
  const r = spawnSync('bun', [BIN, 'check', '--phase', 'eng', '--session-kind', 'unattended', ...extra, '-'], { cwd, input: review, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('gstack-plan-reality check resolves receipts', () => {
  test('a missing file and a line past EOF are unresolved and keep the phase open', () => {
    const dir = fixtureRepo();
    const r = check(dir, rows({ 'premise-table': 'lib/does-not-exist.ts:12', 'already-done': 'lib/a.ts:99' }));
    expect(r.out).toContain('unresolved=premise-table,already-done');
    expect(r.out).toContain('verdict=incomplete');
    expect(r.out).toContain('RECEIPT_UNRESOLVED: premise-table lib/does-not-exist.ts:12 no such file');
    expect(r.out).toContain('RECEIPT_UNRESOLVED: already-done lib/a.ts:99 line 99 is past the end (3 lines)');
    expect(r.err).toContain('(REALITY_RECEIPT_UNRESOLVED)');
    expect(r.code).toBe(1);
  });

  test('real receipts and ranges pass', () => {
    const dir = fixtureRepo();
    const r = check(dir, rows({ 'premise-table': 'lib/a.ts:1-3', 'already-done': 'lib/a.ts:2' }));
    expect(r.out).toContain('verdict=complete');
    expect(r.out).not.toContain('unresolved=');
    expect(r.code).toBe(0);
  });

  test('receipts this checkout cannot judge are reported, never blocking', () => {
    const dir = fixtureRepo();
    const r = check(dir, rows({ 'premise-table': '~/notes/plan.md:1', 'already-done': 'gate.r1.json:1', 'surface-check': 'deadbeefcafe' }));
    expect(r.out).toContain('verdict=complete');
    expect(r.err.match(/^RECEIPT_UNVERIFIABLE: /gm)?.length).toBe(3);
    expect(r.code).toBe(0);
  });

  test('--root adds a root and the default is the git top level', () => {
    const dir = fixtureRepo();
    const other = fixtureRepo();
    fs.writeFileSync(path.join(other, 'lib', 'b.ts'), 'x\n');
    const review = rows({ 'premise-table': 'lib/b.ts:1' });
    expect(check(dir, review).out).toContain('unresolved=premise-table');
    expect(check(dir, review, ['--root', dir, '--root', other]).out).toContain('verdict=complete');
    expect(check(path.join(dir, 'lib'), rows({})).out).toContain('verdict=complete');
  });
});

describe('resolveReceipts', () => {
  test('every receipt token on a row is checked; host:port is not a receipt', () => {
    expect(receiptTokens('see lib/a.ts:1 and lib/b.ts:2, served on localhost:3000')).toEqual(['lib/a.ts:1', 'lib/b.ts:2']);
    const dir = fixtureRepo();
    const out = resolveReceipts(parseRealityLines('REALITY: numbers pass ok lib/a.ts:1 lib/gone.ts:4'), { roots: [dir] });
    expect(out.map(r => [r.receipt, r.outcome])).toEqual([['lib/a.ts:1', 'resolved'], ['lib/gone.ts:4', 'unresolved']]);
  });

  test('a symlink out of the root, a directory and an oversized file are never read', () => {
    const dir = fixtureRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reality-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOKEN=abc\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'lib', 'link.txt'));
    fs.writeFileSync(path.join(dir, 'lib', 'big.txt'), 'x'.repeat(64));
    const out = resolveReceipts(parseRealityLines('REALITY: numbers pass ok lib/link.txt:1 lib/:1 lib/big.txt:1'), { roots: [dir], maxBytes: 32 });
    expect(out.map(r => r.outcome)).toEqual(['unverifiable', 'unresolved', 'unverifiable']);
    expect(JSON.stringify(out)).not.toContain('TOKEN');
  });

  test('line 0, a reversed range, a dangling link and a path through a file are unresolved, never a crash', () => {
    const dir = fixtureRepo();
    fs.symlinkSync(path.join(dir, 'lib', 'gone.ts'), path.join(dir, 'lib', 'dangling.ts'));
    const out = resolveReceipts(parseRealityLines('REALITY: numbers pass ok lib/a.ts:0 lib/a.ts:3-1 lib/dangling.ts:1 lib/a.ts/x.ts:1 lib/a.ts:1-3'), { roots: [dir] });
    expect(out.map(r => r.outcome)).toEqual(['unresolved', 'unresolved', 'unresolved', 'unresolved', 'resolved']);
  });

  test('a commit sha in the repository resolves; an absent one is unverifiable', () => {
    const dir = fixtureRepo();
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    const out = resolveReceipts(parseRealityLines(`REALITY: numbers pass ok ${sha.slice(0, 10)} abcdef1234`), { roots: [dir] });
    expect(out.map(r => r.outcome)).toEqual(['resolved', 'unverifiable']);
  });
});
