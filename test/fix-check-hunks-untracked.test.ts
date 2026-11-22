/**
 * GST-3260 PR 3 Part B (#4664 note p2/red-team#1): decision 3.5's touched hunks were `git diff $PASS_HEAD`, which leaves out a
 * file the fix created and has not committed. The clearing code then refused the closure (it fails closed), but the fix-check
 * reader never saw the new file. The documented command now runs `git add -N` on each file the fix created first. Rule 15's
 * packet replay (docs/evals/r51-final-review-after-grant-prereg.md): with no untracked file the hunks are byte-identical to
 * plain `git diff $PASS_HEAD`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** The hunks instruction decision 3.5 documents, read from the generated section a /ship run loads. */
const documented = () => /touched hunks \(([^)]*)\)/.exec(fs.readFileSync(path.join(ROOT, 'ship/sections/review-army.md'), 'utf8'))?.[1] ?? '';

function fixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-hunks-'));
  dirs.push(dir);
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', ...a], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  const write = (f: Record<string, string>) => { for (const [p, t] of Object.entries(f)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); } };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  write(files); git('add', '-A'); git('commit', '-qm', 'pass head');
  return { dir, git, write, passHead: git('rev-parse', 'HEAD').trim() };
}

/** Run the documented command: `git add -N` on each untracked file the fix created (the fixture's only untracked files), then git diff. */
function hunks(fx: ReturnType<typeof fixture>): string {
  if (documented().includes('git add -N')) {
    const created = fx.git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean);
    if (created.length) fx.git('add', '-N', '--', ...created);
  }
  return fx.git('diff', fx.passHead);
}

describe('decision 3.5\'s touched hunks include a file the fix created (Part B)', () => {
  // Value: protects=a fix-check reader sees every file the fix created, committed or not; fails_when=the documented hunks
  //   command is plain git diff $PASS_HEAD, so an untracked new file is missing from the reader's hunks; seam=ship/sections/review-army.md
  //   decision 3.5; no_claim=what the reader concludes from the hunks
  test('a new, uncommitted file\'s diff is in the hunks, and matches the diff once the fix is committed', () => {
    expect(documented()).toContain('git add -N');
    expect(documented()).toContain('git diff $PASS_HEAD');
    const fx = fixture({ 'src/a.ts': 'export const a = 1;\n' });
    fx.write({ 'src/a.ts': 'export const a = 2;\n', 'src/guard.ts': 'export const guard = true;\n' });
    const text = hunks(fx);
    expect(text).toContain('diff --git a/src/guard.ts b/src/guard.ts');
    expect(text).toContain('+export const guard = true;');
    expect(text).toContain('+export const a = 2;');
    fx.git('add', '-A'); fx.git('commit', '-qm', 'fix');
    expect(text).toBe(fx.git('diff', fx.passHead, 'HEAD'));
  });

  // Value: protects=rule 15's packet replay: with no untracked file the hunks are byte-identical to plain git diff $PASS_HEAD;
  //   fails_when=the new instruction changes the bytes a fix-check reader gets on a fix that created no file; seam=the documented
  //   command; no_claim=fixtures are synthetic edits, not recorded fix rounds
  test('with no untracked file the hunks are byte-identical to plain git diff $PASS_HEAD', () => {
    const cases: Array<[string, Record<string, string>, (fx: ReturnType<typeof fixture>) => void]> = [
      ['tracked edits only', { 'src/a.ts': 'export const a = 1;\n', 'README.md': '# a\n' }, fx => fx.write({ 'src/a.ts': 'export const a = 2;\n', 'README.md': '# a\nmore\n' })],
      ['a committed fix plus an uncommitted edit', { 'src/a.ts': 'export const a = 1;\n' }, fx => { fx.write({ 'src/a.ts': 'export const a = 2;\n' }); fx.git('commit', '-qam', 'fix'); fx.write({ 'src/a.ts': 'export const a = 3;\n' }); }],
      ['a committed new file', { 'src/a.ts': 'export const a = 1;\n' }, fx => { fx.write({ 'src/b.ts': 'export const b = 1;\n' }); fx.git('add', '-A'); fx.git('commit', '-qm', 'fix'); }],
      ['a deleted file', { 'src/a.ts': 'export const a = 1;\n', 'src/old.ts': 'export const old = 1;\n' }, fx => fs.rmSync(path.join(fx.dir, 'src/old.ts'))],
      ['an ignored file beside the fix', { '.gitignore': '*.log\n', 'src/a.ts': 'export const a = 1;\n' }, fx => fx.write({ 'src/a.ts': 'export const a = 2;\n', 'run.log': 'noise\n' })],
    ];
    for (const [name, files, fix] of cases) {
      const fx = fixture(files);
      fix(fx);
      expect(fx.git('ls-files', '--others', '--exclude-standard'), name).toBe('');
      const plain = fx.git('diff', fx.passHead);
      expect(Buffer.from(hunks(fx)), name).toEqual(Buffer.from(plain));
    }
  });
});
