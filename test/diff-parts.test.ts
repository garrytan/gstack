/**
 * GST-4003: whole-diff readers no longer stop at a pipe's maxBuffer. gitDiffInParts has git write to a private file and hands
 * the output back in whole-file parts; the secrets check (lib/pregate/checks/secrets.ts) and gstack-banned-terms parse each
 * part, and must get exactly what parsing the whole text gave them, past any single-read limit.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitDiffInParts, mergeParts } from '../lib/diff-parts';
import { addedLines as bannedAdded } from '../lib/banned-terms';
import { addedLines, parseAddedLineNumbers, parseAddedLines, parsePostimages } from '../lib/pregate/checks/secrets';
import type { PregateContext } from '../lib/pregate/types';

let root = '';
let base = '';
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.test' };
const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const DIFF = ['diff', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--diff-filter=ACMR'];

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-parts-')));
  git('init', '-q', '-b', 'main');
  put('keep.py', 'a = 1\nb = 2\n');
  put('old.txt', 'old\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD').trim();
  for (let i = 0; i < 120; i++) put(`results/run-${i % 7}/case-${i}.jsonl`, Array.from({ length: 40 }, (_, j) => JSON.stringify({ i, j, note: 'x'.repeat(j * 3) })).join('\n') + '\n');
  put('results/big.log', Array.from({ length: 30_000 }, (_, j) => `step ${j} ok`).join('\n') + '\n');
  put('notes/fake-header.md', 'diff --git a/x b/x\n+++ b/fake\n@@ -1 +1 @@\n');
  put('docs/é tudes.md', '# études\n');
  put('keep.py', 'a = 1\nsecret = "x"\nb = 2\n');
  put('old.txt', 'old\nnew\n');
  git('add', '-A');
  git('commit', '-qm', 'branch');
});
afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

const parts = (args: string[], partBytes: number) => {
  const out: string[] = [];
  const r = gitDiffInParts(args, { cwd: root, timeout: 60_000, env }, p => out.push(p), partBytes);
  return { r, out };
};

describe('gitDiffInParts', () => {
  test('the parts are git\'s output byte for byte, each after the first starting at a file header', () => {
    const whole = git(...DIFF, base, '--');
    for (const size of [7, 64, 257, 4096, 1 << 20]) {
      const { r, out } = parts([...DIFF, base, '--'], size);
      expect(r).toEqual({ ok: true });
      expect(out.join('')).toBe(whole);
      for (const p of out.slice(1)) expect(p.startsWith('diff --')).toBe(true);
    }
    expect(parts([...DIFF, base, '--'], 257).out.length).toBeGreaterThan(100);
  }, 60_000);

  test('every per-file parser folded over the parts gives what it gave on the whole text', () => {
    const whole = git(...DIFF, base, '--');
    const fold = <T>(parse: (s: string) => Map<string, T[]>) => { const m = new Map<string, T[]>(); parts([...DIFF, base, '--'], 300).out.forEach(p => mergeParts(m, parse(p))); return [...m]; };
    expect(fold(parseAddedLines)).toEqual([...parseAddedLines(whole)]);
    expect(fold(parseAddedLineNumbers)).toEqual([...parseAddedLineNumbers(whole)]);
    expect(fold(bannedAdded)).toEqual([...bannedAdded(whole)]);
    const full = ['-c', 'diff.suppressBlankEmpty=false', 'diff', '--no-color', '--unified=100000000', base, '--'];
    const posts = new Map<string, string[]>();
    parts(full, 200).out.forEach(p => mergeParts(posts, parsePostimages(p)));
    expect([...posts]).toEqual([...parsePostimages(git(...full))]);
  });

  test('an output over a pipe read\'s limit still arrives whole, and the secrets check reads it through the parts', () => {
    const args = [...DIFF, base, '--'];
    const bytes = Buffer.byteLength(git(...args));
    const piped = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, timeout: 60_000, maxBuffer: Math.floor(bytes / 4) });
    expect((piped.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
    const { r, out } = parts(args, Math.floor(bytes / 8));
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(out.join(''))).toBe(bytes);
    const ctx = { repoRoot: root, mergeBase: base, env, touched: [] } as unknown as PregateContext;
    const files = addedLines(ctx).map(p => p.file).sort();
    expect(files).toContain('results/big.log');
    expect(files).toContain('notes/fake-header.md');
    expect(files.filter(f => f.startsWith('results/run-')).length).toBe(120);
  });

  test('a git that fails is not ok, and leaves no file behind', () => {
    const before = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('gstack-diff-')).length;
    const r = gitDiffInParts(['diff', 'f'.repeat(40), '--'], { cwd: root, timeout: 60_000, env }, () => { throw new Error('no part expected'); });
    expect(r.ok).toBe(false);
    expect(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('gstack-diff-')).length).toBe(before);
  });
});
