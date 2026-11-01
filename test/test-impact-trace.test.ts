/**
 * GST-167 PR 2: lib/test-impact/trace.ts turns a captured strace log into a per-test read set.
 * test/fixtures/test-impact/capture.strace is a real strace 6.8 capture of a bun test (its header says what the test did).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseStrace, straceCalls, unescapeStrace } from '../lib/test-impact/trace';

const CAPTURE = fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'test-impact', 'capture.strace'), 'utf8');
const CTX = { repoRoot: '/tmp/ti-capture/repo', home: '/tmp/ti-capture/home', tmpDir: '/tmp/ti-capture/run', pathDirs: ['/usr/local/bin', '/usr/bin', '/bin'] };

describe('parseStrace on a captured bun test', () => {
  const set = parseStrace(CAPTURE, CTX);

  test('records repo paths read, probed and executed, including a sourced sibling found through the child cwd', () => {
    for (const p of ['test/cap.test.ts', 'lib/data.txt', 'lib/missing.txt', 'bin/tool2', 'bin/tool2-lib.sh', 'package.json', 'test/data']) expect(set.paths).toContain(p);
    expect(set.paths.some(p => p.startsWith('.git') || p.startsWith('/') || p.includes('node_modules'))).toBe(false);
    expect(set.tools).toContain('/usr/local/bin/bun');
  });

  test('a directory listing records its sorted names', () => {
    expect(set.dirs['test/data']).toEqual(['a.txt', 'b.txt']);
    expect(Object.keys(set.dirs).every(d => !d.startsWith('/'))).toBe(true);
  });

  test('HOME, shared /tmp, .git and an outside connect make it ineligible; its own loopback server does not', () => {
    expect(set.ineligible).toEqual([
      'network: connect 192.0.2.1:443',
      'reads shared temp state (/tmp/ti-shared-state)',
      "reads the real HOME (/tmp/ti-capture/home/.gitconfig)",
      "reads the repository's own git state (.git/HEAD)",
    ]);
  });

  test('negative control: the same capture without those four accesses is eligible', () => {
    const clean = CAPTURE.split('\n').filter(l => !/192\.0\.2\.1|ti-shared-state|\.gitconfig|\.git\/HEAD/.test(l)).join('\n');
    const control = parseStrace(clean, CTX);
    expect(control.ineligible).toEqual([]);
    expect(control.paths).toEqual(set.paths);
  });

  test('joins unfinished calls, resolves dirfd-relative paths and decodes escapes', () => {
    const text = [
      '7 openat(5</r/lib>,  <unfinished ...>',
      '8 clone3({flags=CLONE_VM}, 88) = 9',
      '7 <... openat resumed>"a\\x20b.txt", O_RDONLY) = 3</r/lib/a b.txt>',
      '9 chdir("sub") = 0',
      '9 stat("x.json", {...}) = -1 ENOENT (No such file or directory)',
      '9 openat(AT_FDCWD</proc>, "/dev/null", O_RDONLY) = 3</dev/null>',
    ].join('\n');
    expect(straceCalls(text).map(c => c.name)).toEqual(['clone3', 'openat', 'chdir', 'stat', 'openat']);
    expect(unescapeStrace('a\\x20b\\"\\\\')).toBe('a b"\\');
    const r = parseStrace(text, { repoRoot: '/r', home: '/h', tmpDir: '/t' });
    expect(r.paths).toEqual(['lib/a b.txt', 'sub', 'sub/x.json']);
  });
});
