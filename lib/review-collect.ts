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
import type { ClassInput, DepthError, PathLines, RegistryInfo } from './review-depth';

export interface Collected extends ClassInput {
  perPath: PathLines[];
  registry: RegistryInfo;
  errors: DepthError[];
  deleted: string[];
  stampOnly: string[];
  /** Added lines per path, for scanNumbers. */
  added: Record<string, string[]>;
  diffLines: number;
  mergeBase: string | null;
  untracked: string[];
}

function git(root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
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
function readDiff(root: string, range: string[], errors: DepthError[]): Pick<Collected, 'perPath' | 'deleted' | 'stampOnly' | 'added'> {
  const numstat = git(root, ['diff', '--numstat', '-z', '--no-renames', ...range]);
  const status = git(root, ['diff', '--name-status', '-z', '--no-renames', '--diff-filter=D', ...range]);
  const patch = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', ...range]);
  const empty = { perPath: [], deleted: [], stampOnly: [], added: {} };
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
    if (line[0] === '+' || line[0] === '-') (changed[cur] ??= []).push(line);
  }
  const stampOnly = perPath.map(e => e.path).filter(p => p.endsWith('package.json') && !!changed[p]?.length && changed[p]!.every(l => /^[+-]\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/.test(l)));
  return { perPath, deleted, stampOnly, added };
}

function result(diff: ReturnType<typeof readDiff>, extra: Pick<Collected, 'root' | 'registry' | 'errors' | 'mergeBase' | 'untracked'>): Collected {
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
    return result({ perPath: [], deleted: [], stampOnly: [], added: {} }, { root: [], registry, errors, mergeBase: null, untracked: [] });
  }
  const mergeBase = mb.out.trim();
  const diff = readDiff(root, [mergeBase, headSha], errors);
  const tree = git(root, ['ls-tree', '-r', '--name-only', '-z', headSha]);
  const skillDirs = [...new Set(tree.out.split('\0').flatMap(p => /^([^/]+)\/SKILL\.md(\.tmpl)?$/.exec(p)?.[1] ?? []))].sort();
  return result(diff, { root: skillDirs, registry, errors, mergeBase, untracked: [] });
}

/** The ref a base names: origin/<base> when it resolves, else <base> as given (so origin/main stays origin/main). */
export function resolveBaseRef(root: string, base: string): string {
  return git(root, ['rev-parse', '--verify', '-q', `origin/${base}^{commit}`]).ok ? `origin/${base}` : base;
}

/** The working tree against the merge base with origin/<base> (or <base>), untracked files counted per path; the registry is the base ref's commit. */
export function collectLive(root: string, base: string): Collected {
  const errors: DepthError[] = [];
  const ref = resolveBaseRef(root, base);
  const registry = loadRegistryAt(root, ref);
  const mb = git(root, ['merge-base', ref, 'HEAD']);
  if (!mb.ok) {
    errors.push({ code: 'numstat_failed', detail: oneLine(mb.err || `no merge base with ${ref}`), input: `git merge-base ${ref} HEAD`, repair: `fetch the base first (git fetch origin ${base})` });
    return result({ perPath: [], deleted: [], stampOnly: [], added: {} }, { root, registry, errors, mergeBase: null, untracked: [] });
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
  return result(diff, { root, registry, errors, mergeBase, untracked });
}
