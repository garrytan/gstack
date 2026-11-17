/**
 * GST-2494: the sealed guard streams its two large git reads. textFindings
 * (`diff-tree --cc -p --unified=0`) and landedOnBase (`diff-tree -p | patch-id`)
 * used to buffer git's whole stdout under spawnSync's 256 MiB maxBuffer; a PR
 * with ~4M lines of generated fixtures overflowed it and the guard refused with
 * an empty-stderr "git diff-tree -p failed:". Now git's stdout goes to a
 * private temp file and is read one line at a time after git exits 0.
 *
 * Parity: the pre-fix buffered functions (copied verbatim below, maxBuffer
 * injectable) and the streamed ones give equal findings and landed maps on
 * small fixtures, at every read size. Negative controls: a non-zero exit, a
 * signal, a timeout, a missing binary and an unreadable object all throw (and
 * refuse at evaluateSealed), naming the exit code or signal.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateSealed, gitLines, landedOnBase, renderSealed, textFindings, type SealedFinding, type SealedPolicy } from '../lib/sealed-guard';

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const POLICY: SealedPolicy = { paths: [], transcripts: [], answer_markers: ['SEALED ANSWER:'], seed_patterns: ['seed=\\d+', '\uFFFD', 'é'], local_paths: false, allow_paths: [], case_insensitive: false, label_keys: [], identifier_keys: [] };

function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(d);
  return d;
}

function repo() {
  const root = tmp('sealed-stream-');
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir);
  const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const run = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, env });
  const git = (...args: string[]) => {
    const r = run(args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  const write = (files: Record<string, string | Buffer | null>, msg: string) => {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      if (body === null) { fs.rmSync(abs, { force: true }); continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  return { dir, git, run, write };
}

// ---- The pre-fix buffered path (lib/sealed-guard.ts at 0ead11c), verbatim but for the injectable maxBuffer. ----
const HEX = /^[0-9a-f]{40,64}$/;
function oldGit(repoRoot: string, args: string[], maxBuffer: number, input?: string, encoding: BufferEncoding = 'utf8') {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding, input, timeout: 120_000, maxBuffer });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}
function oldTextFindings(repoRoot: string, commits: string[], p: SealedPolicy, maxBuffer: number): SealedFinding[] {
  const rules: Array<[SealedFinding['rule'], RegExp]> = [
    ...p.answer_markers.map(r => ['sealed.answer', new RegExp(r)] as [SealedFinding['rule'], RegExp]),
    ...p.seed_patterns.map(r => ['sealed.seed', new RegExp(r)] as [SealedFinding['rule'], RegExp]),
  ];
  const r = oldGit(repoRoot, ['-c', 'core.quotePath=false', 'diff-tree', '--stdin', '-r', '--root', '-M', '-C', '--cc', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv'], maxBuffer, commits.join('\n') + '\n');
  if (!r.ok) throw new Error(`git diff-tree -p failed: ${r.err.slice(0, 200)}`);
  const out: SealedFinding[] = [];
  let commit = ''; let file = ''; let inHunk = false; let parents = 1; let next = 0;
  for (const line of r.out.split('\n')) {
    if (HEX.test(line)) { commit = line; inHunk = false; continue; }
    if (line.startsWith('diff --')) { inHunk = false; file = ''; continue; }
    if (line.startsWith('@@')) { inHunk = true; parents = (/^@+/.exec(line)?.[0].length ?? 2) - 1; next = Number(/ \+(\d+)(?:,\d+)? @+/.exec(line)?.[1] ?? 0); continue; }
    if (!inHunk) { if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    const prefix = line.slice(0, parents);
    if (line.startsWith('\\') || prefix.includes('-')) continue;
    const n = next++;
    if (!prefix.includes('+')) continue;
    const text = line.slice(parents);
    for (const [rule, re] of rules) if (re.test(text)) out.push({ rule, file, line: n, commit });
  }
  return out;
}
const patchBody = (diff: string) => diff.split('\n').filter(l => !HEX.test(l) && !l.startsWith('index ')).map(l => l.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, '@@')).join('\n');
function oldLanded(repoRoot: string, baseCommits: string[], rest: string[], maxBuffer: number): Map<string, string> {
  const out = new Map<string, string>();
  const diffArgs = ['diff-tree', '-r', '--root', '-p', '--no-color', '--no-ext-diff', '--no-textconv'];
  const ids = (list: string[]): string[][] => {
    const d = oldGit(repoRoot, [...diffArgs, '--stdin'], maxBuffer, list.join('\n') + '\n', 'latin1');
    if (!d.ok) throw new Error(`git diff-tree -p failed: ${d.err.slice(0, 200)}`);
    const p = oldGit(repoRoot, ['patch-id', '--verbatim'], maxBuffer, d.out, 'latin1');
    if (!p.ok) throw new Error(`git patch-id failed: ${p.err.slice(0, 200)}`);
    return p.out.split('\n').map(l => l.split(' ')).filter(f => f.length === 2);
  };
  const byId = new Map<string, string>();
  for (const [id, c] of ids(baseCommits)) if (!byId.has(id!)) byId.set(id!, c!);
  const body = (c: string) => { const r = oldGit(repoRoot, [...diffArgs, c], maxBuffer, undefined, 'latin1'); return r.ok && r.out.trim() ? patchBody(r.out) : null; };
  for (const [id, c] of ids(rest)) {
    const b = byId.get(id!);
    if (!b) continue;
    const mine = body(c!);
    if (mine !== null && mine === body(b)) out.set(c!, b);
  }
  return out;
}
// ---- end of the pre-fix path ----

const BIG = Array.from({ length: 3000 }, (_, i) => `generated fixture row ${i} ${i % 97 === 0 ? 'SEALED ANSWER: x' : 'plain'} é ünïcode`).join('\n') + '\n';
const lines20 = (edit = (i: number) => '') => Array.from({ length: 20 }, (_, i) => `line ${i}${edit(i)}`).join('\n') + '\n';

/** Roots, renames, copies, a binary, CRLF, a missing final newline, invalid UTF-8, a quoted file name, a --cc merge resolution and a ~200 KB file. */
function textFixture() {
  const r = repo();
  r.write({ 'a.txt': 'one\nSEALED ANSWER: 42\nseed=1234\n', 'keep.txt': 'k1\nk2\nk3\nk4\nk5\nk6\n' }, 'root');
  r.write({ 'b.txt': 'crlf line\r\nSEALED ANSWER: crlf\r\nno final newline SEALED ANSWER: nl', 'dir/ü file.txt': 'héllo SEALED ANSWER: é\n' }, 'unicode');
  r.write({ 'bad.txt': Buffer.concat([Buffer.from('before\n'), Buffer.from([0xff, 0xfe, 0x20, 0xe2, 0x82]), Buffer.from('\nSEALED ANSWER: \xe9 latin\n', 'latin1'), Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from(' seed=7\n')]) }, 'invalid utf8');
  r.write({ 'bin.dat': Buffer.concat([Buffer.from('SEALED ANSWER: 1\n'), Buffer.from([0, 1, 2, 0])]) }, 'binary');
  r.write({ 'a.txt': null, 'a-renamed.txt': 'one\nSEALED ANSWER: 42\nseed=1234\nadded SEALED ANSWER: 43\n', 'keep-copy.txt': 'k1\nk2\nk3\nk4\nk5\nk6\nSEALED ANSWER: copy\n' }, 'rename and copy');
  r.write({ 'big.txt': BIG }, 'big');
  r.git('checkout', '-q', '-b', 'side', 'HEAD~1');
  r.write({ 'keep.txt': 'k1\nside SEALED ANSWER: s\nk3\nk4\nk5\nk6\n' }, 'side');
  r.git('checkout', '-q', 'main');
  r.write({ 'keep.txt': 'k1\nmain SEALED ANSWER: m\nk3\nk4\nk5\nk6\n' }, 'main edit');
  r.run(['merge', '-q', 'side', '-m', 'merge']);
  fs.writeFileSync(path.join(r.dir, 'keep.txt'), 'k1\nresolved SEALED ANSWER: r seed=99\nk3\nk4\nk5\nk6\n');
  r.git('add', '-A'); r.git('commit', '-q', '--no-edit');
  return { ...r, commits: r.git('rev-list', 'HEAD').split('\n') };
}

/** Feature commits, some cherry-picked onto main (one at an offset, one with latin1 bytes, one large), a whitespace near-miss and one never landed. */
function landedFixture() {
  const r = repo();
  r.write({ 'f.txt': lines20(), 'big.txt': BIG }, 'root');
  const mb = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', '-b', 'feature');
  const picked = r.write({ 'f.txt': lines20(i => (i === 10 ? ' changed' : '')) }, 'change line 10');
  const latin = r.write({ 'l.txt': Buffer.from('caf\xe9 \xff\xfe bytes\n', 'latin1') }, 'latin1 bytes');
  const nearMiss = r.write({ 'n.txt': 'path /home/alice/x\n' }, 'near miss');
  const bigEdit = r.write({ 'big.txt': BIG.replace('row 1500 ', 'row 1500 edited '), 'big2.txt': BIG }, 'big edit');
  const never = r.write({ 'z.txt': 'never landed\n' }, 'never');
  r.git('checkout', '-q', 'main');
  r.write({ 'f.txt': 'top\n' + lines20() }, 'offset');
  r.git('cherry-pick', picked); r.git('cherry-pick', latin); r.git('cherry-pick', bigEdit);
  r.write({ 'n.txt': 'path /home/ alice/x\n' }, 'near miss differs');
  const baseCommits = r.git('rev-list', '--no-merges', 'main', `^${mb}`).split('\n');
  return { ...r, mb, baseCommits, rest: [picked, latin, nearMiss, bigEdit, never], landed: [picked, latin, bigEdit] };
}

const OLD_LIMIT = 256 * 1024 * 1024;
const opts = (dir: string) => ({ repoRoot: dir, targets: [], baseRef: 'main', remoteUrl: null, target: 't' });

describe('streamed reads match the pre-fix buffered path', () => {
  test('textFindings: equal findings at every read size', () => {
    const f = textFixture();
    const old = oldTextFindings(f.dir, f.commits, POLICY, OLD_LIMIT);
    expect(old.length).toBeGreaterThan(40);
    expect(new Set(old.map(o => o.file))).toEqual(new Set(['a.txt', 'b.txt', 'dir/ü file.txt\t', 'bad.txt', 'a-renamed.txt', 'keep-copy.txt', 'big.txt', 'keep.txt']));
    expect(old.some(o => o.rule === 'sealed.seed' && o.file === 'bad.txt')).toBe(true);
    for (const chunkBytes of [1, 2, 3, 7, 64, 4096, undefined]) expect(JSON.stringify(textFindings(f.dir, f.commits, POLICY, { chunkBytes }))).toBe(JSON.stringify(old));
  });

  test('landedOnBase: equal skips at every read size', () => {
    const f = landedFixture();
    const old = oldLanded(f.dir, f.baseCommits, f.rest, OLD_LIMIT);
    expect([...old.keys()].sort()).toEqual([...f.landed].sort());
    for (const chunkBytes of [1, 3, 7, 64, undefined]) {
      const notes: string[] = [];
      expect([...landedOnBase(opts(f.dir), f.rest, [f.mb], notes, { chunkBytes })]).toEqual([...old]);
      expect(notes).toEqual([]);
    }
  });

  test('the old buffer limit no longer applies (a 4 KiB maxBuffer reproduces the empty-stderr refusal)', () => {
    const t = textFixture();
    expect(() => oldTextFindings(t.dir, t.commits, POLICY, 4096)).toThrow(/^git diff-tree -p failed: $/);
    expect(JSON.stringify(textFindings(t.dir, t.commits, POLICY, { chunkBytes: 64 }))).toBe(JSON.stringify(oldTextFindings(t.dir, t.commits, POLICY, OLD_LIMIT)));
    const l = landedFixture();
    expect(() => oldLanded(l.dir, l.baseCommits, l.rest, 4096)).toThrow(/^git diff-tree -p failed: $/);
    expect([...landedOnBase(opts(l.dir), l.rest, [l.mb], [], { chunkBytes: 64 })]).toEqual([...oldLanded(l.dir, l.baseCommits, l.rest, OLD_LIMIT)]);
  });
});

describe('streamed reads still fail closed, and say why', () => {
  const fake = (body: string) => {
    const bin = path.join(tmp('sealed-fake-git-'), 'git');
    fs.writeFileSync(bin, '#!/bin/sh\n' + body + '\n');
    fs.chmodSync(bin, 0o755);
    return bin;
  };
  const PARTIAL = "printf '%s\\n' 0123456789abcdef0123456789abcdef01234567 'diff --git a/x b/x' '+++ b/x' '@@ -0,0 +1 @@' '+SEALED ANSWER: 1'";
  const run = (o: { bin?: string; timeoutMs?: number }) => {
    const lines: string[] = [];
    let error = '';
    try { gitLines(os.tmpdir(), 'diff-tree -p', ['diff-tree'], { text: 'x\n' }, 'utf8', l => lines.push(l), o); } catch (e: any) { error = e.message; }
    return { lines, error };
  };

  test('real git outside a repository: exit 128 with git\'s own stderr', () => {
    expect(() => textFindings(tmp('sealed-norepo-'), ['0'.repeat(40)], POLICY)).toThrow(/^git diff-tree -p failed \(exit 128\): fatal: not a git repository/);
  });

  test.skipIf(process.platform === 'win32')('a non-zero exit after partial output: nothing parsed, exit code named even with empty stderr', () => {
    expect(run({ bin: fake(PARTIAL + '\nexit 3') })).toEqual({ lines: [], error: 'git diff-tree -p failed (exit 3)' });
    expect(run({ bin: fake("echo 'fatal: boom' >&2; exit 128") })).toEqual({ lines: [], error: 'git diff-tree -p failed (exit 128): fatal: boom' });
  });

  test.skipIf(process.platform === 'win32')('a process killed mid-stream (truncated output): nothing parsed, signal named', () => {
    expect(run({ bin: fake(PARTIAL + '\nkill -9 $$') })).toEqual({ lines: [], error: 'git diff-tree -p failed (killed by SIGKILL)' });
  });

  test.skipIf(process.platform === 'win32')('a timeout: nothing parsed, timeout and signal named', () => {
    expect(run({ bin: fake(PARTIAL + '\nexec sleep 5'), timeoutMs: 300 })).toEqual({ lines: [], error: 'git diff-tree -p failed (timed out after 0.3 s, SIGTERM)' });
  });

  test('a missing git binary: the spawn error is named', () => {
    expect(run({ bin: path.join(tmp('sealed-nobin-'), 'no-such-git') }).error).toMatch(/^git diff-tree -p failed \(could not run git: .+\)$/);
  });

  test('temp files are removed on success and on failure', () => {
    const scratch = tmp('sealed-tmpdir-');
    const before = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const f = textFixture();
      expect(textFindings(f.dir, f.commits, POLICY).length).toBeGreaterThan(0);
      expect(run({ bin: path.join(scratch, 'no-such-git') }).error).not.toBe('');
      expect(fs.readdirSync(scratch).filter(n => n.startsWith('gstack-sealed-'))).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    }
  });

  test('an unreadable object in a published commit refuses the push, and the skip lookup scans everything', () => {
    const r = repo();
    r.write({ '.gstack/pregate.json': JSON.stringify({ sealed: { answer_markers: ['SEALED ANSWER:'] } }) + '\n', 'README.md': '# x\n' }, 'base');
    const mb = r.git('rev-parse', 'HEAD');
    r.write({ 'base.txt': 'base moves on\n' }, 'base moves');
    r.git('checkout', '-q', '-b', 'feature', mb);
    const pushed = r.write({ 'payload.txt': 'harmless payload\n' }, 'payload');
    const blob = r.git('rev-parse', 'HEAD:payload.txt');
    fs.rmSync(path.join(r.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    fs.rmSync(path.join(r.dir, 'payload.txt'));
    const report = evaluateSealed({ repoRoot: r.dir, targets: [{ commits: [pushed], pushedSha: pushed }], baseRef: 'main', remoteUrl: null, target: 'origin' });
    expect(report.status).toBe('error');
    expect(report.error).toMatch(/^could not read the published commits: git diff-tree -p failed \(exit 128\): (fatal|error): /);
    expect(report.notes.some(n => /^skipping failed \(git diff-tree -p failed \(exit 128\)/.test(n))).toBe(true);
    expect(report.skipped).toEqual([]);
    expect(renderSealed(report, 'gstack-pregate sealed')).toContain('SEALED_OUTPUT_REFUSED');
  });
});
