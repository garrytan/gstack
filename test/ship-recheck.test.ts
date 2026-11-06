/**
 * J1 (GSTA-258 L4): a scoped re-check after a refused receipt carry. Each refusal reason that does or does not qualify,
 * the record binding, and the carry end to end: a bounded product change prints RECHECK: eligible and writes the packet,
 * a clean record bound to that packet carries the receipt with the reader named, and a changed risk class, a legacy
 * receipt and more paths than the walk names never take the re-check (the /ship p1 red-team and security findings).
 * Moved base context joins the packet instead (GST-1561; test/ship-receipt-carry-mixed.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt, placeReceiptFirst } from '../lib/ship-receipt';
import { planRecheck, readRecheck, RECHECK_PACKET_BYTES, RECHECK_RANGE_DIFF_CAP } from '../lib/ship-recheck';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

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

describe('readRecheck binds to from, head and the range-diff', () => {
  test('only a clean record for this exact range-diff stands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-'));
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
const eligible = (err: string) => /^RECHECK: eligible range_diff_lines=(\d+) range_diff_sha256=([0-9a-f]{64}) packet=(\S+);/m.exec(err);

describe('carry with a scoped re-check (CLI)', () => {
  test('a bounded product change prints RECHECK: eligible, keeps the refusal, and a clean record carries with the reader named', () => {
    const { repo, from, body, env, commit } = reviewed();
    const head = commit({ 'src/app.ts': 'export const a = 3;\n' }, 'fix: a=3');
    const refused = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.out.trim().split('\n')[0]).toBe('CARRY: refused (RECEIPT_CARRY_PRODUCT_CHANGED)');
    const m = eligible(refused.err);
    expect(m).not.toBeNull();
    expect(fs.readFileSync(m![3]!, 'utf8')).toContain('export const a = 3;');
    const record = path.join(repo.root, 'recheck.json');
    fs.writeFileSync(record, JSON.stringify({ from, head, range_diff_sha256: m![2], reader: 'anthropic/claude-opus-5-5', verdict: 'clean' }));
    const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--recheck', record, '--out', path.join(repo.root, 'run')], env);
    expect([carried.status, carried.err.slice(0, 400)]).toEqual([EXIT.ok, expect.any(String)]);
    expect(carried.out.trim().split('\n')[0]).toBe(`CARRY: carried from ${from.slice(0, 12)} to ${head.slice(0, 12)} (scoped re-check by anthropic/claude-opus-5-5 (range-diff ${m![1]} lines))`);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt).toMatchObject({ head, carry: { from } });
    const stale = path.join(repo.root, 'stale.json');
    fs.writeFileSync(stale, JSON.stringify({ from: head, head, range_diff_sha256: 'f'.repeat(64), reader: 'x', verdict: 'clean' }));
    commit({ 'src/app.ts': 'export const a = 4;\n' }, 'fix: a=4');
    const bad = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--recheck', stale], env);
    expect([bad.status, bad.out.trim().split('\n')[0]]).toEqual([EXIT.refused, 'CARRY: refused (RECEIPT_CARRY_REFUSED)']);
  }, 60_000);

  test('a clean re-check cannot carry across a changed risk class', () => {
    const { repo, from, body, env, commit } = reviewed();
    const before = extractReceipt(fs.readFileSync(body, 'utf8')).receipt!.review_depth!;
    const head = commit({ 'src/app.ts': 'export const a = 3;\n', 'src/billing.ts': 'export function charge(cents: number) { return stripe.charges.create({ amount: cents }); }\n' }, 'feat: billing');
    const refused = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], env);
    const m = eligible(refused.err);
    expect(m).not.toBeNull();
    const record = path.join(repo.root, 'recheck.json');
    fs.writeFileSync(record, JSON.stringify({ from, head, range_diff_sha256: m![2], reader: 'x', verdict: 'clean' }));
    const r = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body, '--recheck', record], env);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/risk class|review depth/);
    expect(before.risk ?? []).not.toContain('money');
  }, 60_000);

  test('a legacy receipt, more changed paths than the walk names, and moved base context print RECHECK: not eligible', () => {
    const legacy = reviewed();
    fs.writeFileSync(legacy.body, placeReceiptFirst('## Summary\n', { schema_version: 1, pr: 5, head: legacy.from, base: 'main' } as any));
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
