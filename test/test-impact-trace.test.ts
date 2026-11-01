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
    expect(set.present).toContain('bin/tool2-lib.sh');
    expect(set.present).not.toContain('lib/missing.txt');
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

describe('parseStrace soundness edges (ship review, #3801)', () => {
  const ctx = { repoRoot: '/r', home: '/h', tmpDir: '/t', pathDirs: ['/h/bin', '/usr/bin'] };
  const parse = (...lines: string[]) => parseStrace(lines.join('\n'), ctx);

  test('only an open that creates or truncates a file makes it the run\'s own; reading an existing file first, or plain O_CREAT, keeps it an input', () => {
    expect(parse('1 openat(AT_FDCWD</r>, "/r/dist/x", O_RDONLY) = 3</r/dist/x>', '1 openat(AT_FDCWD</r>, "/r/dist/x", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3</r/dist/x>').present).toEqual(['dist/x']);
    expect(parse('1 openat(AT_FDCWD</r>, "/r/dist/s.json", O_RDWR|O_CREAT, 0666) = 3</r/dist/s.json>').present).toEqual(['dist/s.json']);
    expect(parse('1 openat(AT_FDCWD</r>, "/r/out.json", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3</r/out.json>', '1 openat(AT_FDCWD</r>, "/r/out.json", O_RDONLY) = 3</r/out.json>').present).toEqual([]);
  });

  test('a PATH directory under HOME exempts tool lookups and the tool itself, not other reads there; HOME itself may be stat\'ed but not listed', () => {
    expect(parse('1 stat("/h/bin/git", 0x1) = -1 ENOENT (No such file or directory)', '1 execve("/h/bin/tool", ["tool"], []) = 0', '1 openat(AT_FDCWD</r>, "/h/bin/tool", O_RDONLY) = 3</h/bin/tool>', '1 newfstatat(AT_FDCWD</r>, "/h", {...}, 0) = 0').ineligible).toEqual([]);
    expect(parse('1 openat(AT_FDCWD</r>, "/h/bin/settings.json", O_RDONLY) = 3</h/bin/settings.json>').ineligible).toEqual(['reads the real HOME (/h/bin/settings.json)']);
    expect(parse('1 getdents64(3</h>, [{d_ino=1, d_off=1, d_reclen=24, d_type=DT_REG, d_name="x"}], 32768) = 24').ineligible).toEqual(['reads the real HOME (/h)']);
  });

  test('loopback counts as the run\'s own only for an endpoint a socket it bound reports; an outside service on a shared port number does not', () => {
    const external = parse('1 connect(5<socket:[10]>, {sa_family=AF_INET, sin_port=htons(9000), sin_addr=inet_addr("127.0.0.1")}, 16) = 0', '1 getsockname(5<socket:[10]>, {sa_family=AF_INET, sin_port=htons(9000), sin_addr=inet_addr("127.0.0.2")}, [16]) = 0');
    expect(external.ineligible).toEqual(['network: connect 127.0.0.1:9000']);
    const own = parse('1 bind(4<socket:[11]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("0.0.0.0")}, 16) = 0', '1 getsockname(4<socket:[11]>, {sa_family=AF_INET, sin_port=htons(4100), sin_addr=inet_addr("0.0.0.0")}, [16]) = 0', '1 connect(6<socket:[12]>, {sa_family=AF_INET, sin_port=htons(4100), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 EINPROGRESS (Operation now in progress)');
    expect(own.ineligible).toEqual([]);
    expect(parse('1 sendmsg(7<socket:[13]>, {msg_name={sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("8.8.8.8")}, msg_namelen=16}, 0) = 40').ineligible).toEqual(['network: sendmsg 8.8.8.8:53']);
  });

  test('a unix socket outside the repo and private TMPDIR, or an abstract one, is an external dependency; a failed lookup is not', () => {
    expect(parse('1 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path="/var/run/docker.sock"}, 110) = 0').ineligible).toEqual(['external socket: connect /var/run/docker.sock']);
    expect(parse('1 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=@"dbus-x"}, 110) = 0').ineligible).toEqual(['external socket: connect @dbus-x']);
    expect(parse('1 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path="/var/run/nscd/socket"}, 110) = -1 ENOENT (No such file or directory)', '1 connect(3<socket:[2]>, {sa_family=AF_UNIX, sun_path="/t/browse.sock"}, 110) = 0').ineligible).toEqual([]);
  });
});
