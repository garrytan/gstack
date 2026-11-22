/**
 * J1 (GSTA-258 L4), advice only since GST-2673: a scoped re-check packet after a refused receipt carry. Each refusal
 * reason that does or does not qualify, and the carry end to end: a bounded product change prints RECHECK: advisory and
 * writes the packet, and no re-check record carries the receipt, because a diff-only re-check caught 0 of 8 real faults
 * full rounds had caught; a legacy receipt and more paths than the walk names get no packet. Moved base context joins
 * the packet (GST-1561; test/ship-receipt-carry-mixed.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../../lib/headless-artifacts';
import { extractReceipt, placeReceipt } from '../../lib/ship-receipt';
import { planRecheck, RECHECK_PACKET_BYTES, RECHECK_RANGE_DIFF_CAP } from '../lib/ship-recheck';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from '../../test/helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const RANGE = '1:  aaaaaaa ! 1:  bbbbbbb feat: a=2\n    @@ src/app.ts\n    -export const a = 2;\n    +export const a = 3;';
const OK = { code: 'RECEIPT_CARRY_PRODUCT_CHANGED', ancestor: true, retarget: false, rangeDiff: RANGE };

describe('planRecheck: which refusals qualify', () => {
  test('a bounded product change on linear history against the same base qualifies', () => {
    expect(planRecheck(OK)).toMatchObject({ ok: true, lines: 4 });
  });
  test.each([
    ['tree mismatch', { ...OK, code: 'RECEIPT_CARRY_TREE_MISMATCH', ancestor: false }, 'is not a product change'],
    ['refused inputs', { ...OK, code: 'RECEIPT_CARRY_REFUSED' }, 'is not a product change'],
    ['stale pregate', { ...OK, code: 'RECEIPT_CARRY_PREGATE_STALE' }, 'is not a product change'],
    ['rewritten history', { ...OK, ancestor: false }, 'rewritten history'],
    ['retargeted stack', { ...OK, retarget: true }, 'another base'],
    ['legacy receipt', { ...OK, legacy: true }, 'no review_depth'],
    ['walk cut at the named-path limit', { ...OK, walkCut: true }, 'more changed product paths'],
    ['unnamed product path', { ...OK, unnamedPaths: true }, 'could not be named'],
    ['base context moved without its sections', { ...OK, contextPaths: 1 }, 'base context'],
    ['base context over its section cap', { ...OK, contextPaths: 1, context: { text: '## src/c.ts', over: ['src/c.ts'] } }, 'section cap'],
    ['binary product path', { ...OK, binary: true }, 'binary'],
    ['wide packet over the byte cap', { ...OK, rangeDiff: 'x'.repeat(RECHECK_PACKET_BYTES + 1) }, 'bytes'],
    ['range-diff failed', { ...OK, rangeDiff: null }, 'failed or timed out'],
    ['empty range-diff', { ...OK, rangeDiff: '\n' }, 'empty'],
    ['over the cap', { ...OK, rangeDiff: Array.from({ length: RECHECK_RANGE_DIFF_CAP + 1 }, (_, i) => `l${i}`).join('\n') }, 'over the scoped re-check cap'],
  ])('%s does not qualify', (_name, input, why) => {
    const p = planRecheck(input);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.reason).toContain(why);
  });
});

/** A branch reviewed at one commit, with a receipt written by gstack-ship-receipt write (so it records review_depth). */
function reviewed(files: Record<string, string> = { 'src/app.ts': 'export const a = 2;\n' }) {
  const repo = makeFixtureRepo({ prefix: 'ship-recheck-' }); repos.push(repo);
  fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
  repo.git('add', '.'); repo.git('commit', '-qm', 'seed app'); repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-qb', 'feat');
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo.work, f)), { recursive: true }); fs.writeFileSync(path.join(repo.work, f), text); }
  repo.git('add', '.'); repo.git('commit', '-qm', 'feat');
  const from = repo.git('rev-parse', 'HEAD');
  const body = path.join(repo.root, 'body.md');
  fs.writeFileSync(body, '## Summary\n');
  const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' };
  const w = runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '5', '--base', 'main', '--body', body], env);
  expect([w.status, w.err.slice(0, 300)]).toEqual([EXIT.ok, expect.any(String)]);
  expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.review_depth).toBeDefined();
  const commit = (changes: Record<string, string>, msg: string) => {
    for (const [f, text] of Object.entries(changes)) { fs.mkdirSync(path.dirname(path.join(repo.work, f)), { recursive: true }); fs.writeFileSync(path.join(repo.work, f), text); }
    repo.git('add', '.'); repo.git('commit', '-qm', msg);
    return repo.git('rev-parse', 'HEAD');
  };
  return { repo, from, body, env, commit };
}
const eligible = (err: string) => /^RECHECK: advisory range_diff_lines=(\d+) range_diff_sha256=([0-9a-f]{64}) packet=(\S+);/m.exec(err);

describe('carry with a scoped re-check (CLI)', () => {
  test('a bounded product change prints RECHECK: advisory and keeps the refusal; a clean record bound to the packet carries nothing', () => {
    const { repo, from, body, env, commit } = reviewed();
    const head = commit({ 'src/app.ts': 'export const a = 3;\n' }, 'fix: a=3');
    const refused = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.out.trim().split('\n')[0]).toBe('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    const m = eligible(refused.err);
    expect(m).not.toBeNull();
    expect(refused.err).toContain('it never carries the receipt (GST-2673)');
    expect(fs.readFileSync(m![3]!, 'utf8')).toContain('export const a = 3;');
    expect(fs.readFileSync(m![3]!, 'utf8')).toContain('advice only');
    const before = fs.readFileSync(body, 'utf8');
    const record = path.join(repo.root, 'recheck.json');
    fs.writeFileSync(record, JSON.stringify({ from, head, range_diff_sha256: m![2], reader: 'anthropic/claude-opus-5-5', verdict: 'clean' }));
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--recheck', record, '--out', path.join(repo.root, 'run')], env);
    expect(carried.status).toBe(EXIT.refused);
    expect(carried.err).toContain('--recheck is gone');
    expect(fs.readFileSync(body, 'utf8')).toBe(before);
  }, 60_000);

  test('a legacy receipt, more changed paths than the walk names, and moved base context print RECHECK: not eligible', () => {
    const legacy = reviewed();
    fs.writeFileSync(legacy.body, placeReceipt('## Summary\n', { schema_version: 1, pr: 5, head: legacy.from, base: 'main' } as any));
    legacy.commit({ 'src/app.ts': 'export const a = 3;\n' }, 'fix');
    expect(runBin(legacy.repo, 'gstack-ship-receipt', ['carry', '--body', legacy.body], legacy.env).err).toContain('RECHECK: not eligible (the receipt records no review_depth');

    const many = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`src/f${i}.ts`, `export const f${i} = 1;\n`]));
    const wide = reviewed(many);
    wide.commit(Object.fromEntries(Object.keys(many).map(f => [f, 'export const changed = 2;\n'])), 'fix: all');
    expect(runBin(wide.repo, 'gstack-ship-receipt', ['carry', '--body', wide.body], wide.env).err).toContain('RECHECK: not eligible (more changed product paths');

    const bin = reviewed({ 'src/app.wasm': '\0asm\x01\0\0\0' });
    bin.commit({ 'src/app.wasm': '\0asm\x01\0\0\0' + 'x'.repeat(4096) + '\0' }, 'fix: new wasm');
    expect(runBin(bin.repo, 'gstack-ship-receipt', ['carry', '--body', bin.body], bin.env).err).toContain('RECHECK: not eligible (a changed product path is binary');
  }, 90_000);

  test('base context moved next to a reviewed hunk plus a product edit elsewhere composes the context hunks into the packet (red-team p1 repro, GST-1561)', () => {
    const lines = (n: number, edits: Record<number, string> = {}) => Array.from({ length: 10 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
    const repo = makeFixtureRepo({ prefix: 'ship-recheck-ctx-' }); repos.push(repo);
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'c.ts'), lines(10));
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
    repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(repo.work, 'src', 'c.ts'), lines(10, { 6: 'branch line 6' }));
    repo.git('commit', '-qam', 'feat: c6');
    const body = path.join(repo.root, 'body.md');
    fs.writeFileSync(body, '## Summary\n');
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' };
    expect(runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '5', '--base', 'main', '--body', body], env).status).toBe(EXIT.ok);
    repo.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo.work, 'src', 'c.ts'), lines(10, { 4: 'main line 4' }));
    repo.git('commit', '-qam', 'main: c4'); repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feat');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 2;\n');
    repo.git('commit', '-qam', 'fix: app');
    const r = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    expect(r.status).toBe(EXIT.refused);
    const m = eligible(r.err);
    expect(m, r.err).not.toBeNull();
    const packet = fs.readFileSync(m![3]!, 'utf8');
    expect(packet).toContain('export const a = 2;');
    expect(packet).toContain('## src/c.ts');
    expect(packet).toContain('main line 4');
  }, 60_000);
});
