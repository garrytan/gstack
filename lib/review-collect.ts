/**
 * review-collect — the git reads behind a review depth (docs/review-policy.md#review-depth),
 * kept out of lib/review-depth.ts so the policy stays pure. collectCommit reads git
 * objects only (a range between two commits, from any checkout, dirty or not);
 * collectLive reads the working tree as /ship reviews it (committed, tracked
 * uncommitted edits and untracked files). Both return a ClassInput with per-path
 * line counts, the base commit's generated-output registry and collector errors;
 * the caller adds the gate-scan result.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GENERATED_PATH, parseRegistry } from './regen';
import { RESULT_CODES } from './result-codes';
import { classifyPath, dataCandidate, type ClassInput, type DepthError, type PathLines, type RegistryInfo } from './review-depth';

export interface Collected extends ClassInput {
  perPath: PathLines[];
  registry: RegistryInfo;
  errors: DepthError[];
  deleted: string[];
  stampOnly: string[];
  /** Added lines per path, for scanNumbers. */
  added: Record<string, string[]>;
  /** Deleted lines per path, for the targeted classes (lib/review-targeted.ts). */
  removed: Record<string, string[]>;
  diffLines: number;
  mergeBase: string | null;
  untracked: string[];
  consumed: string[] | 'all';
}

function git(root: string, args: string[]): { ok: boolean; status: number | null; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}
/** git with what is left of an overall deadline (epoch ms) as its timeout, for a read that may take minutes. */
function gitUntil(root: string, args: string[], deadline: number): { status: number | null; out: string; err: string; timedOut: boolean } {
  const left = deadline - Date.now();
  if (left <= 0) return { status: null, out: '', err: '', timedOut: true };
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', timeout: left, maxBuffer: 256 * 1024 * 1024 });
  const status = r.status ?? null;
  return { status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || ((r.error as NodeJS.ErrnoException | undefined)?.code ?? ''), timedOut: status === null && Date.now() >= deadline };
}
const scratch = (p: string) => p.startsWith('.gstack/tmp/');
const oneLine = (s: string) => s.replace(/[\0-\x1f]+/g, ' ').trim().slice(0, 200);
const unavailable = (input: string, detail: string): RegistryInfo => ({ sha: null, outputs: [], error: { code: 'registry_unavailable', detail: oneLine(detail), input, repair: 'fetch the base branch (git fetch origin <base>) so its commit and registry resolve' } });

/** The registry as committed at `sha`: outputs of entries with a command (a `command: null` entry never excludes); a missing file is an empty registry. */
export function loadRegistryAt(root: string, sha: string): RegistryInfo {
  const commit = git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (!commit.ok) return unavailable(`${sha}:${GENERATED_PATH}`, `${sha} is not a commit in this repository`);
  const resolved = commit.out.trim();
  const input = `${resolved.slice(0, 12)}:${GENERATED_PATH}`;
  if (!git(root, ['cat-file', '-e', `${resolved}:${GENERATED_PATH}`]).ok) return { sha: resolved, outputs: [] };
  const show = git(root, ['show', `${resolved}:${GENERATED_PATH}`]);
  if (!show.ok) return unavailable(input, show.err || 'git show failed');
  const { registry, errors } = parseRegistry(show.out);
  const e = errors[0];
  if (e) return { sha: resolved, outputs: [], error: { code: 'registry_invalid', detail: oneLine(`${e.path || GENERATED_PATH}: ${e.message}`), input, repair: RESULT_CODES[e.code].fix, result: e.code } };
  return { sha: resolved, outputs: registry.entries.filter(x => x.command !== null).flatMap(x => x.outputs) };
}

/** Numstat, deletions and the -U0 patch for `range` (`[mergeBase, head]` or `[mergeBase]` for the working tree). */
function readDiff(root: string, range: string[], errors: DepthError[]): Pick<Collected, 'perPath' | 'deleted' | 'stampOnly' | 'added' | 'removed'> {
  const numstat = git(root, ['diff', '--numstat', '-z', '--no-renames', ...range]);
  const status = git(root, ['diff', '--name-status', '-z', '--no-renames', '--diff-filter=D', ...range]);
  const patch = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', ...range]);
  const empty = { perPath: [], deleted: [], stampOnly: [], added: {}, removed: {} };
  for (const [r, what] of [[numstat, '--numstat'], [status, '--name-status'], [patch, '-U0']] as const) {
    if (!r.ok) { errors.push({ code: 'numstat_failed', detail: oneLine(r.err || 'git diff failed'), input: `git diff ${what} ${range.join(' ')}`, repair: 'check that both commits exist locally (git fetch origin <base>) and rerun' }); return empty; }
  }
  const perPath: PathLines[] = [];
  for (const rec of numstat.out.split('\0').filter(Boolean)) {
    const [a, d, ...rest] = rec.split('\t');
    const p = rest.join('\t');
    if (!scratch(p)) perPath.push({ path: p, lines: (Number(a) || 0) + (Number(d) || 0), binary: a === '-' && d === '-' });
  }
  const statusParts = status.out.split('\0');
  const deleted = statusParts.flatMap((s, k) => (s === 'D' && statusParts[k + 1] ? [statusParts[k + 1]!] : [])).filter(p => !scratch(p));
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  const changed: Record<string, string[]> = {};
  let cur = '';
  let minus = '';
  let inHunk = false;
  for (const line of patch.out.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; cur = ''; minus = ''; continue; }
    if (!inHunk) {
      if (line.startsWith('--- ')) minus = line === '--- /dev/null' ? '' : line.slice(6).replace(/\t$/, '');
      else if (line.startsWith('+++ ')) cur = line === '+++ /dev/null' ? minus : line.slice(6).replace(/\t$/, '');
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    if (!cur || scratch(cur) || line.startsWith('@@')) continue;
    if (line[0] === '+') (added[cur] ??= []).push(line.slice(1));
    if (line[0] === '-') (removed[cur] ??= []).push(line.slice(1));
    if (line[0] === '+' || line[0] === '-') (changed[cur] ??= []).push(line);
  }
  const stampOnly = perPath.map(e => e.path).filter(p => p.endsWith('package.json') && !!changed[p]?.length && changed[p]!.every(l => /^[+-]\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/.test(l)));
  return { perPath, deleted, stampOnly, added, removed };
}

/** More data candidates than this keep every data file code: the consumer scan is not run. */
export const CONSUMER_SCAN_CAP = 2000;
/** How many data files deep a chain of data naming data is followed (a manifest naming a data file) before the rest count as consumed. */
export const CONSUMER_SCAN_DEPTH = 4;
/**
 * One consumer scan's whole budget, every git grep in it (GSTACK_CONSUMER_SCAN_TIMEOUT_MS overrides it); past it the scan fails
 * closed. One scan stays a minute under the 180 s gstack-review-dispatch and gstack-ship-preflight give all of gstack-review-plan;
 * a plan that also scans a fix range (--range-base) runs a second scan and can still reach that limit, which fails the plan.
 */
export const CONSUMER_SCAN_TIMEOUT_MS = 120_000;
/** Pathspec bytes per git grep call: a long list of files to search splits across calls instead of growing one command line. */
export const CONSUMER_SCAN_PATHSPEC_BYTES = 16_000;
/** Output bytes one consumer grep may return across all its calls, the buffer the single whole-tree call had; past it the scan fails closed. */
export const CONSUMER_SCAN_OUTPUT_BYTES = 256 * 1024 * 1024;

export function consumerScanTimeoutMs(): number {
  const v = Number(process.env.GSTACK_CONSUMER_SCAN_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : CONSUMER_SCAN_TIMEOUT_MS;
}

export type GrepFailure = { timedOut: boolean; status: number | null; err: string };

/**
 * The lines `git grep -I -F -o --null` prints for `patterns` at `rev` ('' is the working tree with untracked files), for
 * the files `keep` accepts, in some order. Every pattern holds its own extension, so a `-l` pass for the extensions alone
 * lists every file that can match; the full pattern list then reads only those files, CONSUMER_SCAN_PATHSPEC_BYTES of
 * paths per call under --literal-pathspecs, CONSUMER_SCAN_OUTPUT_BYTES of output in all (an inherited GIT_GLOB_PATHSPECS makes git refuse, which fails closed). A listed name
 * that is not valid UTF-8 cannot be passed back as a path, so then one grep reads the whole tree, as the scan did before GST-544. Each call gets what is left of `deadline` (epoch ms).
 */
export function grepConsumers(root: string, patterns: readonly string[], rev: string, keep: (file: string) => boolean, deadline: number, chunkBytes = CONSUMER_SCAN_PATHSPEC_BYTES, outputBytes = CONSUMER_SCAN_OUTPUT_BYTES): string[] | GrepFailure {
  const where = rev ? [rev, '--'] : ['--untracked', '--'];
  const exts = [...new Set(patterns.map(b => b.slice(b.lastIndexOf('.'))))].flatMap(e => ['-e', e]);
  const listed = gitUntil(root, ['grep', '-I', '-F', '-l', '-z', '--no-color', ...exts, ...where], deadline);
  if (listed.status !== 0 && listed.status !== 1) return listed;
  const names = listed.out.split('\0').filter(Boolean).map(f => (rev ? f.slice(rev.length + 1) : f));
  const flags = ['--literal-pathspecs', 'grep', '-I', '-F', '-o', '--null', '--no-line-number', '--no-column', '--no-color', ...patterns.flatMap(b => ['-e', b]), ...where];
  if (names.some(f => f.includes('\uFFFD'))) {
    const whole = gitUntil(root, flags, deadline);
    return whole.status !== 0 && whole.status !== 1 ? whole : whole.out.split('\n');
  }
  const files = names.filter(keep);
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < files.length;) {
    const chunk: string[] = [];
    for (let bytes = 0; i < files.length; i++) {
      const spec = files[i]!;
      if (chunk.length && bytes + spec.length > chunkBytes) break;
      chunk.push(spec);
      bytes += spec.length;
    }
    const r = gitUntil(root, [...flags, ...chunk], deadline);
    if (r.status !== 0 && r.status !== 1) return r;
    total += Buffer.byteLength(r.out);
    if (total > outputBytes) return { status: null, err: 'ENOBUFS', timedOut: false };
    for (const line of r.out.split('\n')) lines.push(line);
  }
  return lines;
}

/**
 * The data candidates (lib/review-depth.ts dataCandidate) among the changed and deleted paths that a non-docs file names
 * by basename, at each rev and, with `live`, in the working tree with untracked files. The merge base is one of the revs,
 * so a consumer the change removes still counts. A data file named only by another data file is consumed when that one
 * is, followed CONSUMER_SCAN_DEPTH files deep; anything still open after that counts as consumed. A git grep failure, or
 * a scan that outlives `timeoutMs`, is a collector error, which fails the depth closed.
 */
export function scanConsumers(root: string, paths: readonly string[], revs: readonly string[], live: boolean, classRoot: string | readonly string[], errors: DepthError[], timeoutMs = consumerScanTimeoutMs()): string[] | 'all' {
  const candidates = [...new Set(paths)].filter(p => dataCandidate(p, classRoot)).sort();
  if (candidates.length > CONSUMER_SCAN_CAP) return 'all';
  const deadline = Date.now() + timeoutMs;
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const read = (file: string) => !scratch(file) && classifyPath(file, classRoot) !== 'docs';
  const named = new Map<string, Set<string>>();
  const direct = new Set<string>();
  const probed = new Set<string>();
  let probe = candidates;
  for (let depth = 0; probe.length && depth < CONSUMER_SCAN_DEPTH; depth++) {
    const patterns = [...new Set(probe.map(base))];
    const next = new Set<string>();
    for (const at of [...revs, ...(live ? [''] : [])]) {
      const r = grepConsumers(root, patterns, at, read, deadline);
      if (!Array.isArray(r)) {
        const detail = r.timedOut ? `timed out: the scan's ${timeoutMs / 1000} s deadline passed (GSTACK_CONSUMER_SCAN_TIMEOUT_MS)` : `git grep exited ${r.status}${r.err ? `: ${r.err}` : ''} (deadline ${timeoutMs / 1000} s)`;
        errors.push({ code: 'consumer_scan_failed', detail: oneLine(detail), input: `git grep -F <data basenames> ${at || '--untracked'}`, repair: r.timedOut ? 'raise GSTACK_CONSUMER_SCAN_TIMEOUT_MS (milliseconds) or run the git grep by hand to see why it is slow' : 'run the git grep by hand and fix what git reports' });
        return 'all';
      }
      for (const line of r) {
        const parts = line.split('\0');
        const where = parts[0];
        const match = parts.length > 1 ? parts[parts.length - 1] : undefined;
        if (!where || !match) continue;
        const file = at ? where.slice(at.length + 1) : where;
        if (!read(file)) continue;
        for (const p of probe) {
          if (file === p || !match.includes(base(p))) continue;
          if (!dataCandidate(file, classRoot)) { direct.add(p); continue; }
          (named.get(file) ?? named.set(file, new Set()).get(file)!).add(p);
          if (!probed.has(file) && !probe.includes(file)) next.add(file);
        }
      }
    }
    for (const p of probe) probed.add(p);
    probe = [...next];
  }
  const consumed = new Set([...direct, ...probe]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [file, targets] of named) if (consumed.has(file)) for (const p of targets) if (!consumed.has(p)) { consumed.add(p); grew = true; }
  }
  return candidates.filter(p => consumed.has(p));
}

function result(diff: ReturnType<typeof readDiff>, extra: Pick<Collected, 'root' | 'registry' | 'errors' | 'mergeBase' | 'untracked' | 'consumed'>): Collected {
  const paths = diff.perPath.map(e => e.path).sort();
  return { ...diff, ...extra, paths, gateTagged: null, diffLines: diff.perPath.reduce((n, e) => n + e.lines, 0) };
}

/** The range `baseSha`...`headSha` from git objects alone; the registry is the base commit's, never the head's. */
export function collectCommit(root: string, baseSha: string, headSha: string): Collected {
  const errors: DepthError[] = [];
  const registry = loadRegistryAt(root, baseSha);
  const mb = git(root, ['merge-base', baseSha, headSha]);
  if (!mb.ok) {
    errors.push({ code: 'numstat_failed', detail: oneLine(mb.err || 'no merge base'), input: `git merge-base ${baseSha} ${headSha}`, repair: 'check that both commits exist locally (git fetch origin <base>) and rerun' });
    return result({ perPath: [], deleted: [], stampOnly: [], added: {}, removed: {} }, { root: [], registry, errors, mergeBase: null, untracked: [], consumed: 'all' });
  }
  const mergeBase = mb.out.trim();
  const diff = readDiff(root, [mergeBase, headSha], errors);
  const tree = git(root, ['ls-tree', '-r', '--name-only', '-z', headSha]);
  const skillDirs = [...new Set(tree.out.split('\0').flatMap(p => /^([^/]+)\/SKILL\.md(\.tmpl)?$/.exec(p)?.[1] ?? []))].sort();
  const consumed = scanConsumers(root, [...diff.perPath.map(e => e.path), ...diff.deleted], [headSha, mergeBase], false, skillDirs, errors);
  return result(diff, { root: skillDirs, registry, errors, mergeBase, untracked: [], consumed });
}

/** The working tree against the merge base with origin/<base> (or <base>), untracked files counted per path; the registry is the base ref's commit. */
export function collectLive(root: string, base: string): Collected {
  const errors: DepthError[] = [];
  const ref = git(root, ['rev-parse', '--verify', '-q', `origin/${base}^{commit}`]).ok ? `origin/${base}` : base;
  const registry = loadRegistryAt(root, ref);
  const mb = git(root, ['merge-base', ref, 'HEAD']);
  if (!mb.ok) {
    errors.push({ code: 'numstat_failed', detail: oneLine(mb.err || `no merge base with ${ref}`), input: `git merge-base ${ref} HEAD`, repair: `fetch the base first (git fetch origin ${base})` });
    return result({ perPath: [], deleted: [], stampOnly: [], added: {}, removed: {} }, { root, registry, errors, mergeBase: null, untracked: [], consumed: 'all' });
  }
  const mergeBase = mb.out.trim();
  const diff = readDiff(root, [mergeBase], errors);
  const others = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!others.ok) errors.push({ code: 'numstat_failed', detail: oneLine(others.err || 'git ls-files failed'), input: 'git ls-files --others --exclude-standard', repair: 'run the command by hand and fix what git reports' });
  const untracked = others.out.split('\0').filter(p => p && !scratch(p)).sort();
  for (const p of untracked) {
    let buf: Buffer;
    try { buf = fs.readFileSync(path.join(root, p)); } catch { diff.perPath.push({ path: p, lines: 0, binary: true }); continue; }
    const binary = buf.subarray(0, 8000).includes(0);
    const text = binary ? '' : buf.toString('utf8');
    const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    diff.perPath.push({ path: p, lines, binary });
    if (!binary) diff.added[p] = text.split('\n');
  }
  const consumed = scanConsumers(root, [...diff.perPath.map(e => e.path), ...diff.deleted], [mergeBase], true, root, errors);
  return result(diff, { root, registry, errors, mergeBase, untracked, consumed });
}
