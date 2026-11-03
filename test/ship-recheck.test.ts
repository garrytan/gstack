/**
 * J1 (GSTA-258 L4): a scoped re-check after a refused receipt carry. Each refusal reason that does or does not qualify,
 * the record binding, and the carry end to end: a bounded product change prints RECHECK: eligible and writes the packet,
 * and a clean record bound to that range-diff carries the receipt with the reader named.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, placeReceiptFirst } from '../lib/ship-receipt';
import { planRecheck, readRecheck, RECHECK_RANGE_DIFF_CAP } from '../lib/ship-recheck';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const RANGE = '1:  aaaaaaa ! 1:  bbbbbbb feat: a=2\n    @@ src/app.ts\n    -export const a = 2;\n    +export const a = 3;';

describe('planRecheck: which refusals qualify', () => {
  test('a bounded product change on linear history against the same base qualifies', () => {
    const p = planRecheck({ code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: true, retarget: false, rangeDiff: RANGE });
    expect(p).toMatchObject({ ok: true, lines: 4 });
  });
  test.each([
    ['tree mismatch', { code: 'RECEIPT_CARRY_TREE_MISMATCH', ancestor: false, retarget: false, rangeDiff: RANGE }, 'is not a product change'],
    ['refused inputs', { code: 'RECEIPT_CARRY_REFUSED', ancestor: true, retarget: false, rangeDiff: RANGE }, 'is not a product change'],
    ['stale pregate', { code: 'RECEIPT_CARRY_PREGATE_STALE', ancestor: true, retarget: false, rangeDiff: RANGE }, 'is not a product change'],
    ['rewritten history', { code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: false, retarget: false, rangeDiff: RANGE }, 'rewritten history'],
    ['retargeted stack', { code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: true, retarget: true, rangeDiff: RANGE }, 'another base'],
    ['unnamed product path', { code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: true, retarget: false, rangeDiff: RANGE, unnamedPaths: true }, 'could not be named'],
    ['range-diff failed', { code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: true, retarget: false, rangeDiff: null }, 'failed or timed out'],
    ['empty range-diff', { code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: true, retarget: false, rangeDiff: '\n' }, 'empty'],
    ['over the cap', { code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: true, retarget: false, rangeDiff: Array.from({ length: RECHECK_RANGE_DIFF_CAP + 1 }, (_, i) => `l${i}`).join('\n') }, 'over the scoped re-check cap'],
  ])('%s does not qualify', (_name, input, why) => {
    const p = planRecheck(input);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.reason).toContain(why);
  });
});

describe('readRecheck binds to from, head and the range-diff', () => {
  test('only a clean record for this exact range-diff stands', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'recheck-'));
    const bind = { from: 'a'.repeat(40), head: 'b'.repeat(40), sha256: 'c'.repeat(64) };
    const write = (o: object) => { const f = path.join(dir, `${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f; };
    const good = { from: bind.from, head: bind.head, range_diff_sha256: bind.sha256, reader: 'anthropic/claude-opus-5-5', verdict: 'clean' };
    expect(readRecheck(write(good), bind).ok).toBe(true);
    expect(readRecheck(write({ ...good, verdict: 'blocking' }), bind)).toMatchObject({ ok: false, message: expect.stringContaining('not clean') });
    expect(readRecheck(write({ ...good, range_diff_sha256: 'd'.repeat(64) }), bind)).toMatchObject({ ok: false, message: expect.stringContaining('range_diff_sha256') });
    expect(readRecheck(write({ ...good, reader: '' }), bind)).toMatchObject({ ok: false, message: 'the re-check names no reader' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('carry with a scoped re-check (CLI)', () => {
  test('a bounded product change prints RECHECK: eligible, keeps the refusal, and a clean record carries with the reader named', () => {
    const repo = makeFixtureRepo({ prefix: 'ship-recheck-' }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed app'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 2;\n');
    repo.git('commit', '-qam', 'feat: a=2');
    const reviewed = repo.git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 3;\n');
    repo.git('commit', '-qam', 'fix: a=3');
    const head = repo.git('rev-parse', 'HEAD');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, placeReceiptFirst('## Summary\n', { schema_version: 1, pr: 5, head: reviewed, base: 'main', review_loop: { passes: 1, blocking_found: 0, deferred: 0 } } as any));
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' };
    const refused = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.out.trim().split('\n')[0]).toBe('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    const m = /^RECHECK: eligible range_diff_lines=(\d+) range_diff_sha256=([0-9a-f]{64}) packet=(\S+);/m.exec(refused.err);
    expect(m).not.toBeNull();
    expect(fs.readFileSync(m![3]!, 'utf8')).toContain('export const a = 3;');
    const record = path.join(repo.root, 'recheck.json');
    fs.writeFileSync(record, JSON.stringify({ from: reviewed, head, range_diff_sha256: m![2], reader: 'anthropic/claude-opus-5-5', verdict: 'clean' }));
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--recheck', record, '--out', path.join(repo.root, 'run')], env);
    expect(carried.status).toBe(EXIT.ok);
    expect(carried.out.trim().split('\n')[0]).toBe(`CARRY: carried from ${reviewed.slice(0, 12)} to ${head.slice(0, 12)} (scoped re-check by anthropic/claude-opus-5-5 (range-diff ${m![1]} lines))`);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt).toMatchObject({ head, carry: { from: reviewed } });
    const stale = path.join(repo.root, 'stale.json');
    fs.writeFileSync(stale, JSON.stringify({ from: reviewed, head, range_diff_sha256: 'f'.repeat(64), reader: 'x', verdict: 'clean' }));
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 4;\n');
    repo.git('commit', '-qam', 'fix: a=4');
    expect(runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--recheck', stale], env).status).toBe(EXIT.refused);
  });
});
