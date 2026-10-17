/**
 * W2-A3 (fix wave 3): test-free-shards.ts --files-from <path> plans exactly
 * the listed files from the free planned set and rejects, before planning, an
 * unknown path, an empty list or a malformed line. The remote gate
 * (scripts/ubicloud/pregate-remote.sh) compares the printed digest with its
 * upload; the full run's FILES-FROM RESULT line is covered there.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectFreeTestFiles, filesDigest, parseCliOptions, readFilesFrom } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'free-files-from-'));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
let n = 0;
const list = (text: string) => {
  const file = path.join(DIR, `list-${++n}.txt`);
  fs.writeFileSync(file, text);
  return file;
};
const PLANNED = ['browse/test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'test/e.test.ts', 'test/f.test.ts', 'test/g.test.ts'];

describe('--files-from parsing', () => {
  test('one path per line; blank lines and CRLF endings are accepted; order is kept', () => {
    expect(readFilesFrom(list('test/c.test.ts\r\n\r\nbrowse/test/a.test.ts\n\n'), PLANNED)).toEqual(['test/c.test.ts', 'browse/test/a.test.ts']);
  });

  test('paths outside the free planned set are rejected with the first five, a count and the --list fix', () => {
    const file = list(['test/b.test.ts', ...['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'].map(name => `test/${name}.test.ts`)].join('\n'));
    expect(() => readFilesFrom(file, PLANNED)).toThrow(
      `--files-from ${file}: 7 path(s) not in the free planned set: test/x1.test.ts, test/x2.test.ts, test/x3.test.ts, test/x4.test.ts, test/x5.test.ts (+2 more); fix: use paths from \`bun run scripts/test-free-shards.ts --list\``);
  });

  test('an empty list, an unreadable file and every malformed line shape are rejected', () => {
    const empty = list('\n\r\n\n');
    expect(() => readFilesFrom(empty, PLANNED)).toThrow(`--files-from ${empty}: the list is empty (blank lines are ignored); nothing to run`);
    expect(() => readFilesFrom(path.join(DIR, 'absent.txt'), PLANNED)).toThrow('cannot read it (ENOENT)');
    const bad = [' test/b.test.ts', 'test/c.test.ts ', './test/d.test.ts', 'test/../test/e.test.ts', '/abs/test/f.test.ts', 'test\\g.test.ts', 'C:/x.test.ts', 'test//b.test.ts'];
    for (const line of bad) {
      expect(() => readFilesFrom(list(`test/b.test.ts\n${line}\n`), PLANNED), line).toThrow(`1 malformed line(s): line 2 ${JSON.stringify(line)}; fix: one repo-relative path per line`);
    }
    expect(() => readFilesFrom(list('test/b.test.ts\ntest/c.test.ts\ntest/b.test.ts\n'), PLANNED)).toThrow('line 3 repeats test/b.test.ts');
  });

  test('the digest is the sorted list, so a reordered upload still matches', () => {
    expect(filesDigest(['test/c.test.ts', 'browse/test/a.test.ts'])).toBe(filesDigest(['browse/test/a.test.ts', 'test/c.test.ts']));
    expect(filesDigest(['test/c.test.ts'])).not.toBe(filesDigest(['test/c.test.ts', 'test/b.test.ts']));
  });

  test('it conflicts with --quick, --windows-only, --list, --record-durations, --attribute-home and every --ci-* mode', () => {
    expect(parseCliOptions(['--files-from', 'x.txt', '--dry-run']).filesFrom).toBe('x.txt');
    expect(() => parseCliOptions(['--files-from'])).toThrow('Missing path for --files-from');
    for (const extra of [['--quick'], ['--windows-only'], ['--list'], ['--record-durations'], ['--attribute-home'], ['--ci-plan', 'p.json'], ['--ci-run', 'p.json', '--shard', '1', '--result', 'r.json'], ['--ci-verify', 'p.json', '--results', 'r']]) {
      expect(() => parseCliOptions(['--files-from', 'x.txt', ...extra]), extra[0]).toThrow('--files-from cannot be combined with --quick, --windows-only, --list, --record-durations, --attribute-home or the --ci-* modes');
    }
  });
});

describe('--files-from planning through the CLI', () => {
  const cli = (...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, path.join(ROOT, 'scripts/test-free-shards.ts'), ...args], { cwd: ROOT, timeout: 60_000 });
    return { exit: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test('a dry run plans exactly the listed files and prints their digest', () => {
    const planned = collectFreeTestFiles(ROOT);
    const chosen = [planned[3]!, planned[0]!];
    const file = list(chosen.join('\n') + '\n');
    const r = cli('--files-from', file, '--dry-run');
    expect(r.exit, r.out).toBe(0);
    expect(r.out).toContain(`[test:free] files-from ${file}: 2 files, sha256=${filesDigest(chosen)}`);
    expect(r.out).toContain('Would run 2 files across');
    const listed = r.out.split('\n').filter(line => line.startsWith('Shard ') && line.includes('->')).flatMap(line => line.split('-> ')[1]!.split(', '));
    expect(listed.sort()).toEqual([...chosen].sort());
  }, 60_000);

  test('a rejected list exits 1 before planning', () => {
    const r = cli('--files-from', list('test/not-a-real-file.test.ts\n'), '--dry-run');
    expect(r.exit).toBe(1);
    expect(r.out).toContain('1 path(s) not in the free planned set: test/not-a-real-file.test.ts');
    expect(r.out).not.toContain('Would run');
  }, 60_000);
});
