/**
 * test-impact/trace — strace output to one test file's read set (GST-167 PR 2).
 *
 * The recorder runs `bun test <file>` under `strace -f -y` with TRACE_SYSCALLS
 * and a private TMPDIR. parseStrace turns the log into repo-relative paths the
 * test or any child process opened, executed, stat'ed or probed (a failed open
 * counts: a file that appears later changes what the test sees), plus the
 * sorted names of every repo directory it listed. Paths outside the repo, in
 * /proc and /dev, under node_modules (bun.lock is in the key) and in the
 * private TMPDIR are dropped. What makes the result unsound marks the test
 * ineligible with a reason instead: an inet connect or send that is not to a
 * loopback port the trace itself bound, any access under the real HOME other
 * than a PATH tool lookup, shared /tmp state, and reads of the repo's own .git.
 * Repo paths a call reached (and the run did not create) are listed as `present`, and
 * executables outside the repo as `tools`, so key.ts can refuse untracked inputs and hash tools.
 * lib/test-impact/key.ts hashes the read set at a tree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TRACE_VERSION = 2;
/** `-e trace=` set; strace 6.8 on x86_64 Linux accepts every name (stat and open are the legacy calls static binaries still make). */
export const TRACE_SYSCALLS = [
  'openat', 'open', 'execve', 'execveat', 'getdents64', 'readlink', 'readlinkat', 'stat', 'lstat', 'newfstatat', 'statx',
  'access', 'faccessat', 'faccessat2', 'chdir', 'fchdir', 'clone', 'clone3', 'fork', 'vfork', 'connect', 'bind', 'sendto', 'getsockname',
] as const;
/** strace flags: follow children, decode fd paths (gives every *at call its directory and every pid its cwd), full dirents, long strings. */
export const STRACE_FLAGS = ['-f', '-y', '-qq', '-v', '-s', '65535', '-e', `trace=${TRACE_SYSCALLS.join(',')}`];

export interface TraceContext {
  /** Absolute repo root as the traced processes saw it. */
  repoRoot: string;
  /** The real HOME of the traced run. */
  home: string;
  /** The private TMPDIR the recorder gave the run; everything under it is the test's own. */
  tmpDir: string;
  /** PATH entries: a lookup or exec of a file directly in one is a tool resolution, not a HOME read. */
  pathDirs?: string[];
  /** Shared temp roots (default /tmp and /var/tmp). */
  sharedTmp?: string[];
  /** cwd of the first process (default repoRoot). */
  startCwd?: string;
}

export interface ReadSet {
  /** Repo-relative paths accessed (files, directories, probes of absent paths), sorted; `.` is the root. */
  paths: string[];
  /** Repo-relative directory → sorted entry names seen in its listing. */
  dirs: Record<string, string[]>;
  /** Reasons the trace cannot prove the test's inputs; empty when eligible. */
  ineligible: string[];
  /** Repo paths a call reached that the run did not create itself, sorted: key.ts refuses one the tree does not track. */
  present: string[];
  /** Executables outside the repo the run started, sorted; key.ts hashes each one's bytes. */
  tools: string[];
}

export interface TraceRecord extends ReadSet {
  version: typeof TRACE_VERSION;
  test: string;
  tracedAt: string;
  /** HEAD when traced; null outside a commit. */
  commit: string | null;
  exitCode: number | null;
  runtime: Record<string, string>;
}

interface Call { pid: number; name: string; args: string; ret: string; retPath: string | null }

const LINE = /^(\d+)\s+(.*)$/s;
const CALL = /^([a-z_0-9]+)\((.*)\)\s+=\s+(-?\d+|\?|0x[0-9a-f]+)(?:<([^>]*)>)?/s;
const STRING = /"((?:[^"\\]|\\.)*)"/;

/** Strace's C string escapes to text. */
export function unescapeStrace(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: '\n', t: '\t', r: '\r', v: '\v', f: '\f' } as Record<string, string>)[e] ?? e;
  });
}

/** Complete calls in order: `<unfinished ...>` halves joined with their `<... resumed>` tails; signals and exits skipped. */
export function straceCalls(text: string): Call[] {
  const pending = new Map<number, string>();
  const calls: Call[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trimEnd());
    if (!m) continue;
    const pid = Number(m[1]);
    let body = m[2]!;
    if (body.startsWith('---') || body.startsWith('+++')) continue;
    if (body.endsWith('<unfinished ...>')) { pending.set(pid, body.slice(0, -'<unfinished ...>'.length).trimEnd()); continue; }
    const resumed = /^<\.\.\. [a-z_0-9]+ resumed>\s?(.*)$/s.exec(body);
    if (resumed) { body = (pending.get(pid) ?? '') + resumed[1]; pending.delete(pid); }
    const c = CALL.exec(body);
    if (c) calls.push({ pid, name: c[1]!, args: c[2]!, ret: c[3]!, retPath: c[4] ?? null });
  }
  return calls;
}

/** The leading `AT_FDCWD</dir>` or `3</dir>` argument's directory, then the first quoted string after it. */
function dirfdAndPath(args: string): { dirfd: string | null; file: string | null } {
  const fd = /^(?:AT_FDCWD|-?\d+)<([^>]*)>/.exec(args);
  const str = STRING.exec(args);
  return { dirfd: fd ? fd[1]! : null, file: str ? unescapeStrace(str[1]!) : null };
}

const firstString = (args: string): string | null => { const s = /^"((?:[^"\\]|\\.)*)"/.exec(args); return s ? unescapeStrace(s[1]!) : null; };
const within = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

interface Peer { family: 'inet' | 'unix'; host: string; port: number; path?: string }
function sockaddr(args: string): Peer | null {
  if (/sa_family=AF_UNIX/.test(args)) { const p = /sun_path=@?"((?:[^"\\]|\\.)*)"/.exec(args); return p ? { family: 'unix', host: '', port: 0, path: unescapeStrace(p[1]!) } : null; }
  if (!/sa_family=AF_INET6?\b/.test(args)) return null;
  const port = /sin6?_port=htons\((\d+)\)/.exec(args);
  const host = /inet_addr\("([^"]+)"\)/.exec(args) ?? /inet_pton\(AF_INET6?,\s*"([^"]+)"/.exec(args);
  return { family: 'inet', host: host?.[1] ?? '?', port: port ? Number(port[1]) : 0 };
}
const loopback = (host: string) => /^127\./.test(host) || host === '::1' || host === '::ffff:127.0.0.1';

/** A per-test read set from one strace log. */
export function parseStrace(text: string, ctx: TraceContext): ReadSet {
  const repo = path.posix.normalize(ctx.repoRoot);
  const home = path.posix.normalize(ctx.home);
  const tmp = path.posix.normalize(ctx.tmpDir);
  const shared = (ctx.sharedTmp ?? ['/tmp', '/var/tmp']).map(p => path.posix.normalize(p));
  const pathDirs = new Set((ctx.pathDirs ?? []).filter(Boolean).map(p => path.posix.normalize(p)));
  const ancestors = new Set<string>([home]);
  for (const p of [repo, tmp, home]) for (let d = path.posix.dirname(p); ; d = path.posix.dirname(d)) { ancestors.add(d); if (d === '/') break; }
  const cwd = new Map<number, string>();
  const paths = new Set<string>();
  const reached = new Set<string>();
  const created = new Set<string>();
  const dirs = new Map<string, Set<string>>();
  const reasons = new Set<string>();
  const tools = new Set<string>();
  const calls = straceCalls(text);
  const ownPorts = new Set<number>();
  for (const c of calls) {
    if ((c.name !== 'bind' && c.name !== 'getsockname') || c.ret !== '0') continue;
    const a = sockaddr(c.args);
    if (a?.family === 'inet' && a.port && loopback(a.host)) ownPorts.add(a.port);
  }
  const cwdOf = (pid: number) => cwd.get(pid) ?? ctx.startCwd ?? repo;
  const absolute = (pid: number, p: string, dir: string | null) => path.posix.normalize(path.posix.isAbsolute(p) ? p : path.posix.join(dir ?? cwdOf(pid), p));
  const record = (raw: string, kind: 'access' | 'exec' | 'content', ok = false, creates = false) => {
    const abs = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    if (within(abs, '/proc') || within(abs, '/dev') || within(abs, tmp) || ancestors.has(abs)) return;
    if (within(abs, repo)) {
      const rel = abs === repo ? '.' : abs.slice(repo.length + 1);
      if (/(?:^|\/)node_modules(?:\/|$)/.test(rel)) return;
      if (rel === '.git' && kind === 'access') return;
      if (rel === '.git' || rel.startsWith('.git/')) { reasons.add(`reads the repository's own git state (${rel})`); return; }
      paths.add(rel);
      if (ok) (creates ? created : reached).add(rel);
      return;
    }
    if (pathDirs.has(path.posix.dirname(abs))) { if (kind === 'exec') tools.add(abs); return; }
    if (within(abs, home)) { reasons.add(`reads the real HOME (${abs})`); return; }
    const sharedRoot = shared.find(s => within(abs, s));
    if (sharedRoot && abs !== sharedRoot) { reasons.add(`reads shared temp state (${abs})`); return; }
    if (kind === 'exec') tools.add(abs);
  };
  for (const c of calls) {
    const ok = !c.ret.startsWith('-');
    const { dirfd, file } = dirfdAndPath(c.args);
    if (dirfd && c.args.startsWith('AT_FDCWD<')) cwd.set(c.pid, path.posix.normalize(dirfd));
    switch (c.name) {
      case 'clone': case 'clone3': case 'fork': case 'vfork':
        if (ok && Number(c.ret) > 0) cwd.set(Number(c.ret), cwdOf(c.pid));
        break;
      case 'chdir': {
        const p = firstString(c.args);
        if (p === null || !ok) break;
        const abs = absolute(c.pid, p, null);
        cwd.set(c.pid, abs);
        record(abs, 'access', true);
        break;
      }
      case 'fchdir': if (ok && dirfd) cwd.set(c.pid, path.posix.normalize(dirfd)); break;
      case 'getdents64': {
        if (!dirfd) break;
        const abs = path.posix.normalize(dirfd);
        record(abs, 'content', true);
        if (!within(abs, repo)) break;
        const rel = abs === repo ? '.' : abs.slice(repo.length + 1);
        if (/(?:^|\/)(?:node_modules|\.git)(?:\/|$)/.test(rel)) break;
        const names = dirs.get(rel) ?? new Set<string>();
        for (const n of c.args.matchAll(/d_name="((?:[^"\\]|\\.)*)"/g)) { const name = unescapeStrace(n[1]!); if (name !== '.' && name !== '..') names.add(name); }
        dirs.set(rel, names);
        break;
      }
      case 'connect': case 'sendto': {
        const peer = sockaddr(c.args);
        if (peer?.family === 'unix' && peer.path) record(absolute(c.pid, peer.path, null), 'access');
        if (peer?.family === 'inet' && !(loopback(peer.host) && ownPorts.has(peer.port))) reasons.add(`network: ${c.name} ${peer.host}:${peer.port}`);
        break;
      }
      case 'bind': case 'getsockname': break;
      case 'execve': case 'open': case 'stat': case 'lstat': case 'access': case 'readlink': {
        const p = firstString(c.args);
        if (p === null) break;
        record(absolute(c.pid, p, null), c.name === 'execve' ? (ok ? 'exec' : 'access') : c.name === 'open' ? 'content' : 'access', ok, c.name === 'open' && /O_CREAT/.test(c.args));
        break;
      }
      default: {
        if (file === null) break;
        const target = file === '' && dirfd ? path.posix.normalize(dirfd) : absolute(c.pid, file, dirfd);
        const creates = c.name === 'openat' && /O_CREAT/.test(c.args);
        record(target, c.name === 'execveat' ? (ok ? 'exec' : 'access') : c.name === 'openat' ? 'content' : 'access', ok, creates);
        if (ok && c.retPath && c.name === 'openat' && path.posix.isAbsolute(c.retPath)) record(path.posix.normalize(c.retPath), 'content', true, creates);
      }
    }
  }
  return {
    paths: [...paths].sort(),
    dirs: Object.fromEntries([...dirs].sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => [d, [...n].sort()])),
    ineligible: [...reasons].sort(),
    present: [...reached].filter(p => !created.has(p)).sort(),
    tools: [...tools].sort(),
  };
}

/** Where a test file's trace lives under a trace directory. */
export function tracePath(dir: string, test: string): string {
  return path.join(dir, `${test.replace(/\//g, '__')}.json`);
}

/** A trace record from disk, or null when missing, unreadable, another version or for another test. */
export function readTrace(dir: string, test: string): TraceRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(tracePath(dir, test), 'utf8')) as TraceRecord;
    return rec && rec.version === TRACE_VERSION && rec.test === test && Array.isArray(rec.paths) ? rec : null;
  } catch { return null; }
}
