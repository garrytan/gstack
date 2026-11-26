/**
 * GST-4003: review_exclude_paths selection and the named-by-code scan cost the same however many patterns and paths a PR
 * has. select reads one diff for every pattern and splits it by git's own pathspec match; fixedIndex hands git one token
 * per string and finds exactly the strings a body holds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fixedIndex, select } from '../lib/review-exclude-match';

/** An empty global git config (os.devNull is not a file git can read on Windows). */
const EMPTY_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gitcfg-')), 'config');
fs.writeFileSync(EMPTY_CONFIG, '');
afterAll(() => fs.rmSync(path.dirname(EMPTY_CONFIG), { recursive: true, force: true }));

describe('fixedIndex', () => {
  const strings = ['docs/a.json', 'a.json', 'results/run-1/a.json', 'results/', 'LICENSE', 'vendor/x/LICENSE', 'data/b.jsonl', 'c.', 'é/ü.json'];
  const naive = (body: string) => new Set(strings.filter(s => body.includes(s)));
  test('finds exactly the strings body.includes finds, overlaps and prefixes included', () => {
    const bodies = ['see docs/a.json and data/b.jsonl', "load('results/run-1/a.json')", 'LICENSE vendor/x/LICENSE', 'a.jsonl only', 'results/ results/run-2', 'c.d c.', 'path é/ü.json', '', 'docs/a.jsonx', 'xdocs/a.json'];
    const ix = fixedIndex(strings);
    for (const b of bodies) expect([...ix.holds(b)].sort()).toEqual([...naive(b)].sort());
  });
  test('git gets one token per distinct suffix, and every string ends with its token', () => {
    const ix = fixedIndex(strings);
    expect(ix.tokens.sort()).toEqual(['.', '.json', '.jsonl', 'LICENSE', 'results/'].sort());
    for (const s of strings) expect(ix.tokens.some(t => s.endsWith(t))).toBe(true);
    const many = Array.from({ length: 16_000 }, (_, i) => `docs/benchmarks/run-${i % 40}/results/case-${i}.json`);
    expect(fixedIndex(many).tokens).toEqual(['.json']);
    expect([...fixedIndex(many).holds("x = 'docs/benchmarks/run-3/results/case-43.json'")]).toEqual(['docs/benchmarks/run-3/results/case-43.json']);
  });
});

describe('select', () => {
  let root = '';
  let base = '';
  const env = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.test' };
  const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, timeout: 30_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exclude-select-')));
    git('init', '-q', '-b', 'main');
    put('results/old.json', '1\n');
    put('src/a.ts', 'a\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    base = git('rev-parse', 'HEAD').trim();
    for (let i = 0; i < 30; i++) put(`results/run-${i % 3}/raw/c${i}.json`, `${i}\n`);
    put('results/run-0/logs/x.log', 'log\n');
    put('docs/r.md', '# r\n');
    put('a.b/x.json', '1\n');
    fs.rmSync(path.join(root, 'results/old.json'));
    git('add', '-A'); git('commit', '-qm', 'branch');
  });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('each pattern gets what its own git diff --raw lists, in the same order, deletions included', () => {
    const patterns = ['results/**/raw/**', 'results/**', '**/*.json', '**/*.log', 'nothing/**', 'docs/*.md', 'a.b/**'];
    const head = git('rev-parse', 'HEAD').trim();
    const one = (p: string) => git('diff', '--raw', '-z', '--no-abbrev', '--no-renames', base, head, '--', `:(top,glob)${p}`).split('\0').filter((_, k) => k % 2 === 1).filter(Boolean);
    const s = select({ root, mergeBase: base, head }, patterns);
    if ('error' in s) throw new Error(s.error);
    for (const p of patterns) expect(s.byPattern.get(p)).toEqual(one(p));
    expect(s.byPattern.get('results/**')).toContain('results/old.json');
    expect(s.files.get('results/old.json')!.newMode).toBe('000000');
    const single = select({ root, mergeBase: base, head }, ['results/**']);
    expect('error' in single ? single : single.byPattern.get('results/**')).toEqual(one('results/**'));
    const none = select({ root, mergeBase: base, head }, []);
    expect('error' in none ? none : none.files.size).toBe(0);
  });

  test('a file that replaces a directory of the same name stays matched (one index cannot hold both)', () => {
    const head = git('rev-parse', 'HEAD').trim();
    put('data/x/a.json', '{}\n');
    git('add', '-A'); git('commit', '-qm', 'dir');
    const before = git('rev-parse', 'HEAD').trim();
    fs.rmSync(path.join(root, 'data/x'), { recursive: true });
    put('data/x', '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(root, 'data/x'), 0o755);
    git('add', '-A'); git('commit', '-qm', 'swap');
    const after = git('rev-parse', 'HEAD').trim();
    const patterns = ['data/**', '**/*.json'];
    const one = (p: string) => git('diff', '--raw', '-z', '--no-abbrev', '--no-renames', before, after, '--', `:(top,glob)${p}`).split('\0').filter((_, k) => k % 2 === 1).filter(Boolean);
    const s = select({ root, mergeBase: before, head: after }, patterns);
    if ('error' in s) throw new Error(s.error);
    expect(s.byPattern.get('data/**')).toEqual(['data/x', 'data/x/a.json']);
    for (const p of patterns) expect(s.byPattern.get(p)).toEqual(one(p));
    git('reset', '-q', '--hard', head);
  });
});
