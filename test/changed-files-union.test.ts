/**
 * getChangedFiles union semantics: committed + staged + unstaged + untracked.
 * Free (no API calls), runs with `bun test`.
 *
 * Change-set 3 of the eval-selection work: an agent that edits files and
 * runs evals BEFORE committing used to get an empty committed-diff → run-all
 * → full paid suite. getChangedFiles now unions the committed diff with the
 * working-tree diff and untracked files, and FAILS CLOSED (throws, naming
 * EVALS_ALL=1) on any git error instead of silently returning [].
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getChangedFiles } from './helpers/touchfiles';

describe('getChangedFiles union', () => {
  let repo: string;

  const git = (args: string[]) => {
    const result = spawnSync(
      'git',
      ['-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, stdio: 'pipe', timeout: 10000 },
    );
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`);
    }
  };

  const write = (rel: string, content: string) => {
    const filePath = path.join(repo, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-files-union-'));
    git(['init', '-q']);
    write('a.txt', 'a\n');
    write('b.txt', 'b\n');
    git(['add', 'a.txt', 'b.txt']);
    git(['commit', '-q', '-m', 'base']);
    git(['tag', 'base']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('committed-only change', () => {
    write('a.txt', 'a2\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'change a']);
    expect(getChangedFiles('base', repo)).toEqual(['a.txt']);
  });

  test('staged-only change', () => {
    write('a.txt', 'a2\n');
    git(['add', 'a.txt']);
    expect(getChangedFiles('base', repo)).toEqual(['a.txt']);
  });

  test('unstaged-only change', () => {
    write('b.txt', 'b2\n');
    expect(getChangedFiles('base', repo)).toEqual(['b.txt']);
  });

  test('untracked-only file', () => {
    write('new-dir/new.txt', 'new\n');
    expect(getChangedFiles('base', repo)).toEqual(['new-dir/new.txt']);
  });

  test('mixed sources — each file exactly once', () => {
    // committed change to a.txt...
    write('a.txt', 'a2\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'change a']);
    // ...PLUS an unstaged edit to the same file (dedupe check),
    write('a.txt', 'a3\n');
    // a staged edit to b.txt,
    write('b.txt', 'b2\n');
    git(['add', 'b.txt']);
    // and an untracked file.
    write('c.txt', 'c\n');

    const result = getChangedFiles('base', repo);
    expect(result.sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(result.filter(f => f === 'a.txt').length).toBe(1); // deduped
  });

  test('clean tree → empty union (run-all semantics preserved by callers)', () => {
    expect(getChangedFiles('base', repo)).toEqual([]);
  });

  test('non-repo cwd → throws naming EVALS_ALL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changed-files-nonrepo-'));
    try {
      expect(() => getChangedFiles('main', dir)).toThrow(/EVALS_ALL=1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing base ref → throws naming EVALS_ALL and the failing command', () => {
    expect(() => getChangedFiles('no-such-ref', repo)).toThrow(/EVALS_ALL=1/);
    expect(() => getChangedFiles('no-such-ref', repo)).toThrow(/diff --name-only no-such-ref\.\.\.HEAD/);
  });

  test('non-ASCII filenames come back as raw UTF-8, not C-escaped (core.quotePath=false)', () => {
    const name = 'résumé-fixture.md';
    fs.writeFileSync(path.join(repo, name), 'x');
    try {
      const files = getChangedFiles('base', repo);
      expect(files).toContain(name);
      expect(files.every((f) => !f.includes('\\303'))).toBe(true);
    } finally {
      fs.rmSync(path.join(repo, name), { force: true });
    }
  });

  test('injected spawn failure → throws with stderr in the message', () => {
    const failingSpawn = ((_cmd: string, args: string[]) => ({
      status: 128,
      error: undefined,
      stdout: Buffer.from(''),
      stderr: Buffer.from(`fatal: injected failure for ${args[0]}`),
    })) as unknown as typeof spawnSync;

    let message = '';
    try {
      getChangedFiles('base', repo, failingSpawn);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('EVALS_ALL=1');
    expect(message).toContain('injected failure');
    expect(message).toContain('exit 128');
  });

  test('injected spawn error object (git binary missing) → throws', () => {
    const errorSpawn = (() => ({
      status: null,
      error: new Error('spawn git ENOENT'),
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    })) as unknown as typeof spawnSync;

    let message = '';
    try {
      getChangedFiles('base', repo, errorSpawn);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('EVALS_ALL=1');
    expect(message).toContain('spawn git ENOENT');
    expect(message).toContain('spawn-error');
  });

  test('untracked path with spaces (git quotes it) is unquoted', () => {
    write('has space.txt', 'x\n');
    expect(getChangedFiles('base', repo)).toEqual(['has space.txt']);
  });
});
