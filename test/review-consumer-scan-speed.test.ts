/**
 * The consumer scan on a results PR with large trial files (HARN-98, harness-evals#551): one `git grep -F -o` with ~80 data
 * basenames retried every pattern after each match, about 27 ms per matching line over a 16 MB trials.jsonl, and the review plan
 * timed out at 1,703 s with a 30-minute limit. The scan now lists the files that match with `git grep -l` and picks the matches
 * itself the way git's -o does, so its lines stay byte-identical to the whole-tree -o grep while the time follows file size.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { grepConsumers } from '../lib/review-collect';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const git = (dir: string, args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 512 * 1024 * 1024 });
  expect([0, 1], `git ${args.slice(0, 3).join(' ')}: ${r.stderr}`).toContain(r.status ?? -1);
  return r.stdout;
};
function repo(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-scan-'));
  dirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return { dir, head: git(dir, ['rev-parse', 'HEAD']).trim() };
}
const wholeTree = (dir: string, patterns: string[], at: string) => git(dir, ['-c', 'core.quotePath=false', 'grep', '-I', '-F', '-o', '--null', '--no-line-number', '--no-column', '--no-color', ...patterns.flatMap(b => ['-e', b]), ...(at ? [at, '--'] : ['--untracked', '--'])]).split('\n').filter(Boolean).sort();
const lines = (r: ReturnType<typeof grepConsumers>) => { expect(Array.isArray(r), JSON.stringify(r)).toBe(true); return (r as string[]).filter(Boolean).sort(); };

describe('the consumer scan picks the same matches as git grep -o (HARN-98)', () => {
  // Value: protects=the scan's lines stay byte-identical to one whole-tree git grep -o where patterns overlap, share a start,
  //   contain each other or repeat on a line, at a commit and in the working tree (an edited file, an assume-unchanged and a
  //   skip-worktree entry, an untracked file and an untracked symlink); fails_when=the match walk counts an overlapped name, drops
  //   a repeat, breaks a same-start tie differently from git, or reads a file from another source than git does; seam=git grep
  //   output on a seeded random fixture
  test('overlapping, nested and repeated basenames give the lines git grep -o gives', () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const patterns = ['a.json', 'ba.json', 'aba.json', 'a.json.json', 'json.json', 'b.csv', 'ab.csv', 'b.csv.csv', 'my run.json', 'run.json', 'a.jsonl', 'x.jsonl'];
    const bits = [...patterns, 'a', 'b', '.', 'json', 'csv', ' ', '"', '/', 'l', '\n'];
    const files: Record<string, string> = {};
    for (let f = 0; f < 30; f++) files[`src/f${f}.ts`] = Array.from({ length: 400 }, () => bits[rand(bits.length)]).join('');
    const r = repo(files);
    fs.writeFileSync(path.join(r.dir, 'src/untracked.ts'), 'aba.json.json ab.csv.csv a.jsonl\n');
    fs.writeFileSync(path.join(r.dir, 'src/f1.ts'), 'edited: run.json my run.json\n');
    fs.writeFileSync(path.join(r.dir, 'src/f2.ts'), 'unseen on disk: x.jsonl\n');
    git(r.dir, ['update-index', '--assume-unchanged', 'src/f2.ts']);
    fs.writeFileSync(path.join(r.dir, 'src/f3.ts'), 'skipped on disk: b.csv.csv\n');
    git(r.dir, ['update-index', '--skip-worktree', 'src/f3.ts']);
    fs.symlinkSync('f4.ts', path.join(r.dir, 'src/link.ts'));
    for (const at of [r.head, '']) {
      const want = wholeTree(r.dir, patterns, at);
      expect(want.length).toBeGreaterThan(500);
      expect(lines(grepConsumers(r.dir, patterns, at, () => true, Date.now() + 30_000))).toEqual(want);
      expect(lines(grepConsumers(r.dir, patterns, at, () => true, Date.now() + 30_000, 1))).toEqual(want);
    }
  }, 60_000);

  // Value: protects=hit files are read a bounded batch at a time and a file past the output cap goes to git's -o, with the
  //   same lines as the whole-tree grep at a commit and in the working tree; fails_when=a batch drops or misreads a blob, a
  //   large file is skipped instead of sent to git, or every hit body is held at once past the cap (ENOBUFS); seam=grepConsumers
  //   with a 4,000-byte output cap
  test('hit files past the read batch and past the output cap give the lines git grep -o gives', () => {
    const body = (n: number, fill: number) => Array.from({ length: n }, (_, i) => `${'x'.repeat(fill)} ${i % 2 ? 'a.json' : 'ba.json'}\n`).join('');
    const r = repo({ 'src/one.ts': body(8, 200), 'src/two.ts': body(8, 200), 'src/three.ts': body(8, 200), 'src/big.ts': body(4, 1_500) });
    fs.writeFileSync(path.join(r.dir, 'src/two.ts'), body(6, 300));
    for (const at of [r.head, '']) expect(lines(grepConsumers(r.dir, ['a.json', 'ba.json'], at, () => true, Date.now() + 30_000, 16_000, 4_000))).toEqual(wholeTree(r.dir, ['a.json', 'ba.json'], at));
  }, 60_000);

  // Value: protects=a file past the read cap whose git -o output holds 1.2 million matches still gives git's lines;
  //   fails_when=the fallback's lines are spread into one push call (RangeError: Maximum call stack size exceeded); seam=grepConsumers
  //   with a 21 MB output cap over a 21.5 MB file
  test('a file past the read cap with 1.2 million matches gives the lines git grep -o gives', () => {
    const r = repo({ 'b.ts': 'a.json\n'.repeat(1_200_000) + 'x'.repeat(13_100_000) + '\n' });
    for (const at of ['HEAD', '']) expect(lines(grepConsumers(r.dir, ['a.json'], at, () => true, Date.now() + 60_000, 16_000, 21_000_000))).toEqual(wholeTree(r.dir, ['a.json'], at));
  }, 120_000);

  // Value: protects=a results tree whose trial files name many data basenames on long lines finishes the scan in seconds;
  //   fails_when=the scan goes back to git's -o with every pattern (17.7 s on this 16 MB file on a 4-core machine, 220 s on
  //   harness-evals#551's); seam=grepConsumers with a 5-second deadline; no_claim=the scan's speed on other shapes
  test('80 basenames over a 16 MB trials file with 400 names per line finish inside a 5-second deadline, lines unchanged', () => {
    const names = [...Array.from({ length: 60 }, (_, i) => `name${i}.json`), ...Array.from({ length: 20 }, (_, i) => `trial${i}.jsonl`)];
    const rows: string[] = [];
    for (let n = 0, bytes = 0; bytes < 16_000_000; n++) { const row = JSON.stringify({ i: n, artifacts: Array.from({ length: 400 }, (_, j) => `runs/${n}/${j}/${names[(n * 7 + j) % names.length]}`) }); rows.push(row); bytes += row.length + 1; }
    const r = repo({ 'results/trials.jsonl': rows.join('\n') + '\n', 'src/load.ts': "read('name3.json')\n" });
    const t0 = Date.now();
    const got = grepConsumers(r.dir, names, r.head, () => true, Date.now() + 5_000);
    const ms = Date.now() - t0;
    const out = lines(got);
    expect(out.length).toBe(rows.length * 400 + 1);
    expect(ms).toBeLessThan(5_000);
    expect(out).toEqual(wholeTree(r.dir, names, r.head));
  }, 120_000);
});
