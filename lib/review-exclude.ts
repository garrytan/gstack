/**
 * review-exclude — the base policy's review_exclude_paths applied to one range, and the
 * bounded read of each reviewer's diff (docs/ship-policy.md#review-exclude-paths, GST-508).
 *
 * The policy is read at the base commit the caller already resolved (loadPolicyAt), never
 * from the head: a branch cannot exclude its own files. Git owns the glob dialect: every
 * matched path comes from `git diff --raw -z` under one `:(top,glob)<pattern>` pathspec
 * per pattern (untracked files never count), so the receipt, the plan line and what
 * readers see are one set. A matched file is excluded only when it is
 * content (data, docs, binary or a .log) that no rule keeps; every kept file carries one
 * stable reason. Applied patterns become `:(top,exclude,glob)` pathspecs on every reader,
 * and kept files under them come back through a second `:(top,literal)` command, because a
 * git exclude beats any positive pathspec. That second command is bounded by its argument
 * bytes: a pattern whose kept files would pass KEEP_ARG_MAX_BYTES is not applied.
 *
 * readSelection reads one reader's diff once, with a timeout, and counts its bytes;
 * gstack-review-dispatch stops with REVIEW_DIFF_TOO_LARGE above REVIEW_DIFF_MAX_BYTES and
 * with REVIEW_DIFF_UNREADABLE when git fails, before it writes a manifest or a brief.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectLive } from './review-collect';
import { DATA_PATH, classifyPath, isAgentProse, isDataConfig, isGatePath, type PathLines } from './review-depth';
import { secretLine } from './review-targeted';
import { cmpVersion, parseVersion } from './version-source';
import { REVIEW_EXCLUDE_KEY_VERSION, SHIP_POLICY_PATH, isUnavailable, loadPolicyAt, policyUnavailableLine } from './ship-policy';

/** The most diff bytes one reader is handed (about 500K tokens); above it the pass stops instead of truncating. */
export const REVIEW_DIFF_MAX_BYTES = 2_000_000;
/** The most argument bytes the kept-file command may carry across all applied patterns (under Windows' 32,767-character command line). */
export const KEEP_ARG_MAX_BYTES = 24_000;
/** How long one reader's `git diff` may run. */
export const REVIEW_DIFF_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 256 * 1024 * 1024;
export const KEPT_REASONS = ['policy-dir', 'gate-path', 'executable', 'agent-prose', 'config', 'gate-tagged', 'code', 'secret-line', 'named-by-code', 'consumer-scan-unavailable', 'link'] as const;
export type KeptReason = (typeof KEPT_REASONS)[number];

/** What the receipt records and the queue and carry compare (by `digest`, never by `source`). */
export interface ExcludeRecord {
  source: string; patterns: string[]; applied: string[]; skipped: Array<{ pattern: string; kept: number; bytes: number }>; unmatched: string[];
  excluded: number; excluded_bytes: number; kept: number; gate_tagged: string[]; patterns_sha256: string; list_sha256: string; digest: string;
}
export interface ActiveExclusion {
  state: 'active'; record: ExcludeRecord; excluded: Set<string>; specs: string[]; keep: string[];
  kept: Array<{ path: string; reason: KeptReason }>; content: Record<ContentKind, number>; references: Array<{ prefix: string; files: string[] }>;
}
export type Exclusion =
  | { state: 'none' }
  | { state: 'head-only'; patterns: string[]; source: string }
  | { state: 'refused'; code: 'POLICY_SOURCE_UNAVAILABLE' | 'POLICY_INVALID' | 'REVIEW_DIFF_UNREADABLE'; lines: string[] }
  | ActiveExclusion;

export interface ExcludeInput {
  root: string;
  /** The base commit whose policy applies, and the ref it was resolved from (origin/<base> or <base>). */
  baseSha: string; ref: string;
  /** The merge base, and the head commit; no head reads the working tree with untracked files. */
  mergeBase: string; head?: string;
  /** The collector's per-path lines (binary flags) and added lines (lib/review-collect.ts). */
  perPath: readonly PathLines[]; added: Record<string, readonly string[]>;
  /** Skill directory names (commit mode) or the repository root (live): markdown in a skill directory is code. */
  classRoot: string | readonly string[];
  /** Paths whose hunks the gate scan tagged; null when unknown. */
  gateTagged?: ReadonlySet<string> | null;
  /** The command name the refusal lines start with. */
  context: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const literal = (p: string) => `:(top,literal)${p}`;
const argBytes = (paths: Iterable<string>) => { let n = 0; for (const p of paths) n += Buffer.byteLength(shellQuote(literal(p))) + 1; return n; };

function git(root: string, args: string[], input?: string): { ok: boolean; status: number | null; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, encoding: 'utf8', timeout: 120_000, maxBuffer: MAX_BUFFER });
  return { ok: r.status === 0, status: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

/** The patterns a policy text declares, or [] for anything unreadable: only a notice reads the head's copy. */
function declared(text: string | null): string[] {
  try { const v = JSON.parse(text ?? 'null')?.review_exclude_paths; return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []; } catch { return []; }
}
function headPatterns(i: ExcludeInput): string[] {
  if (!i.head) { try { return declared(fs.readFileSync(path.join(i.root, SHIP_POLICY_PATH), 'utf8')); } catch { return []; } }
  const r = git(i.root, ['show', `${i.head}:${SHIP_POLICY_PATH}`]);
  return r.ok ? declared(r.out) : [];
}

/** A pattern's literal directory prefix (`receipts/` for `receipts/**`), or '' when it starts with a glob. */
export function literalPrefix(pattern: string): string {
  const at = pattern.search(/[*?[]/);
  const head = at < 0 ? pattern : pattern.slice(0, at);
  return head.slice(0, head.lastIndexOf('/') + 1);
}

interface Matched { oldMode: string; newMode: string; oldSha: string; newSha: string }

/** Every changed path each pattern matches, with its modes, from git's raw diff; untracked files are never part of it, since no reader's git diff shows them and the receipt reads the committed head. */
function select(i: ExcludeInput, patterns: readonly string[]): { byPattern: Map<string, string[]>; files: Map<string, Matched> } | { error: string } {
  const byPattern = new Map<string, string[]>();
  const files = new Map<string, Matched>();
  const range = i.head ? [i.mergeBase, i.head] : [i.mergeBase];
  for (const p of patterns) {
    const spec = `:(top,glob)${p}`;
    const raw = git(i.root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', ...range, '--', spec]);
    if (!raw.ok) return { error: `git diff --raw ${range.join(' ')} -- ${spec}: ${raw.err.split('\n')[0] || `exit ${raw.status}`}` };
    const parts = raw.out.split('\0');
    const hit: string[] = [];
    for (let k = 0; k + 1 < parts.length; k += 2) {
      const [oldMode, newMode, oldSha, newSha] = parts[k]!.slice(1).split(' ');
      const f = parts[k + 1]!;
      if (!f) continue;
      hit.push(f);
      if (!files.has(f)) files.set(f, { oldMode: oldMode ?? '', newMode: newMode ?? '', oldSha: oldSha ?? '', newSha: newSha ?? '' });
    }
    byPattern.set(p, hit);
  }
  return { byPattern, files };
}

/**
 * The matched paths git calls binary whose bytes hold a NUL in their first 8,000 (git's own test), read from the head blob,
 * the file on a live tree, or the old blob for a deletion. A branch's .gitattributes can make git call a text file binary;
 * only real bytes make it binary content here.
 */
function binaryContent(i: ExcludeInput, files: ReadonlyMap<string, Matched>, claimed: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const real = (sha: string) => /^[0-9a-f]{40,64}$/.test(sha) && !/^0+$/.test(sha);
  const bySha = new Map<string, string[]>();
  for (const p of claimed) {
    const m = files.get(p);
    if (!m) continue;
    if (!i.head && m.newMode !== '000000') {
      try { const fd = fs.openSync(path.join(i.root, p), 'r'); const buf = Buffer.alloc(8000); const n = fs.readSync(fd, buf, 0, 8000, 0); fs.closeSync(fd); if (buf.subarray(0, n).includes(0)) out.add(p); } catch {}
      continue;
    }
    const sha = real(m.newSha) ? m.newSha : real(m.oldSha) ? m.oldSha : '';
    if (sha) bySha.set(sha, [...(bySha.get(sha) ?? []), p]);
  }
  if (!bySha.size) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: i.root, input: [...bySha.keys()].join('\n') + '\n', timeout: 120_000, maxBuffer: MAX_BUFFER });
  const buf = r.stdout ?? Buffer.alloc(0);
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const [sha, , size] = buf.subarray(at, nl).toString('utf8').split(' ');
    const n = Number(size);
    if (!Number.isFinite(n)) { at = nl + 1; continue; }
    if (buf.subarray(nl + 1, nl + 1 + Math.min(n, 8000)).includes(0)) for (const p of bySha.get(sha!) ?? []) out.add(p);
    at = nl + 1 + n + 1;
  }
  return out;
}

/** The kind of content a path holds when the policy may exclude it, or null for code (tests included). */
export type ContentKind = 'binary' | 'data' | 'docs' | 'log';
function contentKind(i: ExcludeInput, p: string, binary: ReadonlySet<string>): ContentKind | null {
  if (binary.has(p)) return 'binary';
  if (DATA_PATH.test(p) && !isDataConfig(p)) return 'data';
  if (/\.log$/i.test(p)) return 'log';
  return classifyPath(p, i.classRoot) === 'docs' ? 'docs' : null;
}

/** Why a matched file is kept by its path, mode and lines alone; null for content the policy may exclude. A binary file readers would only see as "Binary files differ" is content unless its directory, mode or gate tags keep it. */
function pathReason(i: ExcludeInput, p: string, m: Matched, binary: ReadonlySet<string>): KeptReason | null {
  if (/^\.(gstack|github)\//.test(p)) return 'policy-dir';
  if (isGatePath(p)) return 'gate-path';
  if (m.oldMode === '100755' || m.newMode === '100755') return 'executable';
  if ([m.oldMode, m.newMode].some(x => x === '120000' || x === '160000')) return 'link';
  if (i.gateTagged?.has(p)) return 'gate-tagged';
  if (binary.has(p)) return null;
  if (isAgentProse(p)) return 'agent-prose';
  if (isDataConfig(p)) return 'config';
  if (contentKind(i, p, binary) === null) return 'code';
  if ((i.added[p] ?? []).some(secretLine)) return 'secret-line';
  return null;
}

/** A file whose full-path reference keeps excluded content: a code or test file (not docs, data, a .log or binary) outside the would-be-excluded set. */
const consumer = (i: ExcludeInput, f: string, candidates: ReadonlySet<string>) =>
  !candidates.has(f) && !f.startsWith('.gstack/tmp/') && contentKind(i, f, new Set()) === null;

/** An uncapped `git grep -F -o -f` of fixed strings at the head (or the working tree) and `revs`: string -> the consumer files holding it; null when git grep failed. */
function grepFixed(i: ExcludeInput, strings: readonly string[], candidates: ReadonlySet<string>, revs: readonly string[]): Map<string, Set<string>> | null {
  const found = new Map<string, Set<string>>();
  if (!strings.length) return found;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-exclude-'));
  try {
    const list = path.join(dir, 'patterns');
    fs.writeFileSync(list, strings.join('\n') + '\n');
    const runs = [i.head ? { at: i.head, args: [i.head, '--'] } : { at: '', args: ['--'] }, ...revs.map(rev => ({ at: rev, args: [rev, '--'] }))];
    for (const run of runs) {
      const r = git(i.root, ['grep', '-I', '-F', '-o', '--null', '--no-line-number', '--no-column', '--no-color', '-f', list, ...run.args]);
      if (r.status !== 0 && r.status !== 1) return null;
      for (const line of r.out.split('\n')) {
        const parts = line.split('\0');
        const where = parts[0];
        const match = parts.length > 1 ? parts[parts.length - 1] : undefined;
        if (!where || !match) continue;
        const file = run.at ? where.slice(run.at.length + 1) : where;
        if (!consumer(i, file, candidates)) continue;
        (found.get(match) ?? found.set(match, new Set()).get(match)!).add(file);
      }
    }
    return found;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * The base policy's exclusion for one range. `none` when neither side declares a pattern (callers then print and change
 * nothing); `head-only` when only the head does (a notice, never applied); `refused` when the base policy cannot be read or
 * does not validate, or git cannot list the matches; `active` otherwise. Named-by-code keeps a file only when a kept code
 * file names its full repository path (never its basename: receipt trees reuse result.json thousands of times); a git grep
 * failure keeps every candidate (consumer-scan-unavailable).
 */
export function reviewExclude(i: ExcludeInput): Exclusion {
  const load = loadPolicyAt(i.root, i.baseSha, i.ref);
  if (isUnavailable(load)) return { state: 'refused', code: 'POLICY_SOURCE_UNAVAILABLE', lines: [policyUnavailableLine(i.context, load.base, load.detail)] };
  const source = `${i.ref}@${i.baseSha.slice(0, 12)}`;
  const base = i.ref.replace(/^origin\//, '');
  if (load.errors.length) {
    return { state: 'refused', code: 'POLICY_INVALID', lines: load.errors.map(e => `${i.context}: the base policy ${source}:${SHIP_POLICY_PATH} does not validate, so its review_exclude_paths cannot be read (${e.path || SHIP_POLICY_PATH}: ${e.message}); fix: run ` + '`' + `gstack-ship-policy validate --policy-from base --base ${base}` + '`' + ` and fix the file on ${base} with its own PR; nothing was planned (${e.code})`) };
  }
  const patterns = load.policy.review_exclude_paths;
  if (!patterns.length) { const head = headPatterns(i); return head.length ? { state: 'head-only', patterns: head, source } : { state: 'none' }; }
  const sel = select(i, patterns);
  if ('error' in sel) return { state: 'refused', code: 'REVIEW_DIFF_UNREADABLE', lines: [`${i.context}: git could not list the files review_exclude_paths matches (${sel.error}); fix: git fetch origin ${base}, then rerun once; nothing was planned (REVIEW_DIFF_UNREADABLE)`] };
  const binary = binaryContent(i, sel.files, new Set(i.perPath.filter(e => e.binary && sel.files.has(e.path)).map(e => e.path)));
  const reasons = new Map<string, KeptReason | null>();
  for (const [p, m] of sel.files) reasons.set(p, pathReason(i, p, m, binary));
  const candidates = new Set([...reasons].filter(([, r]) => r === null).map(([p]) => p));
  const named = grepFixed(i, [...candidates].filter(p => !p.includes('\n')), candidates, [i.mergeBase]);
  for (const p of candidates) {
    if (named === null || p.includes('\n')) reasons.set(p, 'consumer-scan-unavailable');
    else if (named.has(p)) reasons.set(p, 'named-by-code');
  }
  const applied: string[] = [];
  const skipped: ExcludeRecord['skipped'] = [];
  const keep = new Set<string>();
  for (const p of patterns) {
    const hit = sel.byPattern.get(p) ?? [];
    if (!hit.some(f => reasons.get(f) === null)) continue;
    const kept = hit.filter(f => reasons.get(f) !== null);
    const bytes = argBytes(new Set([...keep, ...kept]));
    if (bytes > KEEP_ARG_MAX_BYTES) { skipped.push({ pattern: p, kept: kept.length, bytes }); continue; }
    applied.push(p);
    for (const f of kept) keep.add(f);
  }
  const excluded = new Set(applied.flatMap(p => (sel.byPattern.get(p) ?? []).filter(f => reasons.get(f) === null)));
  const keptList = [...reasons].filter(([, r]) => r !== null).map(([p, r]) => ({ path: p, reason: r! })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sortedExcluded = [...excluded].sort();
  const content: Record<ContentKind, number> = { binary: 0, data: 0, docs: 0, log: 0 };
  for (const p of sortedExcluded) content[contentKind(i, p, binary)!]++;
  const prefixes = [...new Set(applied.map(literalPrefix).filter(Boolean))];
  const refs = grepFixed(i, prefixes, excluded, []) ?? new Map<string, Set<string>>();
  const patterns_sha256 = sha256(JSON.stringify(patterns));
  const list_sha256 = sha256(JSON.stringify({ applied, excluded: sortedExcluded, kept: keptList.map(k => [k.path, k.reason]) }));
  const record: ExcludeRecord = {
    source, patterns: [...patterns], applied, skipped, unmatched: patterns.filter(p => !(sel.byPattern.get(p) ?? []).length),
    excluded: excluded.size, excluded_bytes: excludedBytes(i, sortedExcluded, sel.files), kept: keptList.length,
    gate_tagged: keptList.filter(k => k.reason === 'gate-tagged').map(k => k.path), patterns_sha256, list_sha256, digest: sha256(`${patterns_sha256}\n${list_sha256}`),
  };
  return {
    state: 'active', record, excluded, specs: applied.map(p => `:(top,exclude,glob)${p}`), keep: [...keep].sort().map(literal), kept: keptList, content,
    references: prefixes.filter(p => refs.has(p)).map(p => ({ prefix: p, files: [...refs.get(p)!].sort() })),
  };
}

/** The head-side size of the excluded files: blob sizes at the head commit, file sizes on a live tree; a deletion counts 0. */
function excludedBytes(i: ExcludeInput, excluded: readonly string[], files: ReadonlyMap<string, Matched>): number {
  if (!i.head) return excluded.reduce((n, p) => { try { return n + fs.statSync(path.join(i.root, p)).size; } catch { return n; } }, 0);
  const shas = excluded.map(p => files.get(p)?.newSha ?? '').filter(s => /^[0-9a-f]{40,64}$/.test(s) && !/^0+$/.test(s));
  if (!shas.length) return 0;
  const r = git(i.root, ['cat-file', '--batch-check=%(objectsize)'], shas.join('\n') + '\n');
  return r.out.split('\n').reduce((n, l) => n + (Number(l) || 0), 0);
}

/** The plan's lines for an exclusion: none prints nothing, so a repository without the key plans byte for byte as before. */
export function excludeLines(x: Exclusion, base: string): string[] {
  if (x.state === 'none' || x.state === 'refused') return [];
  if (x.state === 'head-only') return [`REVIEW_EXCLUDE: none (head sets review_exclude_paths; it applies after it lands on ${base}) patterns=${x.patterns.length} source=${x.source}`];
  const r = x.record;
  const skipped = r.skipped.length ? ` skipped=${r.skipped.map(s => `${s.pattern}:kept=${s.kept}:bytes=${s.bytes}`).join(',')} (kept files over ${KEEP_ARG_MAX_BYTES} argument bytes: pattern not applied)` : '';
  const out = [`REVIEW_EXCLUDE: patterns=${r.applied.length}/${r.patterns.length} excluded=${r.excluded} bytes=${r.excluded_bytes} kept=${r.kept} content=${Object.entries(x.content).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(',') || 'none'} source=${r.source} digest=${r.digest}${skipped}${r.unmatched.length ? ` unmatched=${r.unmatched.join(',')}` : ''}`];
  for (const k of x.kept.slice(0, 20)) out.push(`REVIEW_EXCLUDE_KEPT: ${k.reason} ${k.path}`);
  if (x.kept.length > 20) out.push(`REVIEW_EXCLUDE_KEPT: +${x.kept.length - 20} more (gstack-review-plan --json lists every kept file)`);
  for (const ref of x.references) out.push(`REVIEW_EXCLUDE_REFERENCE: ${ref.prefix} is named by ${ref.files.slice(0, 3).join(', ')}${ref.files.length > 3 ? ` (+${ref.files.length - 3} more)` : ''}; the files stay excluded, so readers see that code without the files it reads (REVIEW_EXCLUDE_REFERENCE)`);
  return out;
}

/** The one line every brief gets under an active exclusion; it names the selection digest the receipt binds (verify's REVIEW_EXCLUDE_RECORD). */
export function disclosureLine(r: Pick<ExcludeRecord, 'source' | 'excluded' | 'excluded_bytes' | 'applied' | 'kept' | 'digest'>): string {
  return `Excluded by base policy ${r.source} (selection ${r.digest}): ${r.excluded} files, ${r.excluded_bytes} bytes on this branch matching ${r.applied.join(' ') || 'no applied pattern'}. They are not in your diff; do not report on their absence. Kept despite a match: ${r.kept} files (listed in the plan).`;
}
/** The selection digest a disclosure line names, or undefined. */
export const disclosureDigest = (line: string | undefined) => line?.match(/^Excluded by base policy \S+ \(selection ([0-9a-f]{64})\)/)?.[1];

export function parseTail(tail: string | undefined): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  for (let m = re.exec(tail ?? ''); m; m = re.exec(tail ?? '')) out.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!);
  return out;
}

export type ReaderDiff =
  | { ok: true; text: string; bytes: number; byDir: Array<[string, number]> }
  | { ok: false; reason: 'timeout' | 'git-exit'; exit: number | null; stderr: string; timeoutMs: number };

/** One reader's selection read once: `git diff <base> [-- pathspecs]`, then the kept-file command, with its bytes per top directory. */
export function readSelection(root: string, diffBase: string, pathspecs: readonly string[], keep: readonly string[] = [], timeoutMs = REVIEW_DIFF_TIMEOUT_MS): ReaderDiff {
  let text = '';
  for (const specs of [pathspecs, ...(keep.length ? [keep] : [])]) {
    const tail = specs.length ? (specs[0] === '--' ? specs : ['--', ...specs]) : [];
    const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', diffBase, ...tail], { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOBUFS') { text += r.stdout ?? ''; break; }
    if (code === 'ETIMEDOUT' || (r.signal && r.status === null)) return { ok: false, reason: 'timeout', exit: null, stderr: r.stderr ?? '', timeoutMs };
    if (r.status !== 0) return { ok: false, reason: 'git-exit', exit: r.status, stderr: r.stderr ?? '', timeoutMs };
    text += r.stdout;
  }
  const byDir = new Map<string, number>();
  const starts = [...text.matchAll(/^diff --git a\/(\S+)/gm)];
  starts.forEach((m, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]!.index! : text.length;
    const dir = m[1]!.includes('/') ? m[1]!.split('/')[0]! : '(root)';
    byDir.set(dir, (byDir.get(dir) ?? 0) + Buffer.byteLength(text.slice(m.index!, end)));
  });
  return { ok: true, text, bytes: Buffer.byteLength(text), byDir: [...byDir].sort((a, b) => b[1] - a[1]) };
}

/** Credential-bearing remote URLs and scp-style remotes out of git's stderr. */
export const redact = (s: string) => s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>').replace(/\b[\w.-]+@[\w.-]+:[^\s'"]+/g, '<url>');

/** Where the over-ceiling selection's policy stands: decides the fix the line prints. */
export interface CeilingContext { state: 'none' | 'head-only' | 'active'; base: string; source: string; floor?: string | null; headPatterns?: string[]; record?: Pick<ExcludeRecord, 'patterns' | 'skipped' | 'excluded'> }

/** The policy hunk to land, as JSON a person can paste: the patterns, and a floor at least this key's version. */
function policyJson(patterns: readonly string[], floor?: string | null): string {
  const min = floor && parseVersion(floor) && cmpVersion(parseVersion(floor)!, parseVersion(REVIEW_EXCLUDE_KEY_VERSION)!) > 0 ? floor : REVIEW_EXCLUDE_KEY_VERSION;
  return JSON.stringify({ review_exclude_paths: patterns, min_gstack_version: min });
}

/** Folders to suggest: the largest top directories, until what is left would fit. */
function suggest(byDir: ReadonlyArray<[string, number]>, bytes: number): string[] {
  const out: string[] = [];
  let left = bytes;
  for (const [dir, n] of byDir) {
    if (left <= REVIEW_DIFF_MAX_BYTES || out.length >= 3) break;
    if (dir === '(root)') continue;
    out.push(`${dir}/**`);
    left -= n;
  }
  return out;
}

/** The REVIEW_DIFF_TOO_LARGE line and object: the reader's bytes, the largest folders and a fix chosen by where the policy stands. */
export function tooLargeLine(context: string, reader: string, d: { bytes: number; byDir: ReadonlyArray<[string, number]> }, c: CeilingContext): { line: string; json: Record<string, unknown> } {
  const top = d.byDir.slice(0, 5).map(([dir, n]) => `${dir}:${n}`).join(',') || 'none';
  const land = (patterns: readonly string[]) => `ask the repo owner to land ${policyJson(patterns, c.floor)} in ${SHIP_POLICY_PATH} on ${c.base} as its own PR (docs/ship-policy.md#review-exclude-paths), then bring ${c.base} into this branch and rerun once; if it is still over, split the PR`;
  const dirs = suggest(d.byDir, d.bytes);
  const s = c.record?.skipped[0];
  const fix = c.state === 'head-only' ? `this branch declares review_exclude_paths, but only the copy on ${c.base} applies: ${land(c.headPatterns ?? [])}`
    : s ? `pattern ${s.pattern} was not applied: its ${s.kept} kept files need ${s.bytes} argument bytes (more than ${KEEP_ARG_MAX_BYTES}); narrow the pattern on ${c.base} or move the kept files out of it, or split the PR`
    : c.state === 'active' ? `still over after excluding ${c.record?.excluded ?? 0} files; ${dirs.length ? land([...(c.record?.patterns ?? []), ...dirs.filter(p => !c.record?.patterns.includes(p))]) : 'split the PR'}`
    : dirs.length ? land(dirs) : 'split the PR';
  const line = `${context}: the reader's diff is over the review ceiling (reader=${reader} bytes=${d.bytes} max=${REVIEW_DIFF_MAX_BYTES} top=${top} policy=${c.source}); fix: ${fix}; nothing was written (REVIEW_DIFF_TOO_LARGE)`;
  return { line, json: { code: 'REVIEW_DIFF_TOO_LARGE', reader, bytes: d.bytes, max: REVIEW_DIFF_MAX_BYTES, top: d.byDir.slice(0, 5).map(([dir, bytes]) => ({ dir, bytes })), policy: c.source, state: c.state, fix, side_effects: 'none' } };
}

/** The REVIEW_DIFF_UNREADABLE line: timeout or git exit, the timeout, the base, a redacted first stderr line, and the whole (redacted) stderr written under `logDir`. */
export function unreadableLine(context: string, reader: string, d: Extract<ReaderDiff, { ok: false }>, diffBase: string, base: string, logDir: string): string {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = path.join(logDir, `diff-${reader.replace(/[^a-zA-Z0-9._-]/g, '_')}.stderr`);
  fs.writeFileSync(log, redact(d.stderr), { mode: 0o600 });
  const first = redact(d.stderr.split('\n').find(l => l.trim()) ?? '').trim().slice(0, 200);
  const fix = d.reason === 'timeout' ? `rerun once unchanged; if it times out again, split the PR or exclude its largest data folders on ${base}`
    : d.exit === 128 ? `git fetch origin ${base}, then rerun once` : 'stop and ask a person: git failed in a way a rerun does not repair';
  return `${context}: git could not read the reader's diff (reader=${reader} reason=${d.reason} exit=${d.exit ?? 'none'} timeout_ms=${d.timeoutMs} base=${diffBase.slice(0, 12)} stderr=${JSON.stringify(first)} log=${log}); fix: ${fix}; nothing else was written (REVIEW_DIFF_UNREADABLE)`;
}

/** The plan's review_exclude object (gstack-review-plan --json), or null for a repository without the key. */
export type PlanExclude = { state: string; patterns?: string[]; skipped?: ExcludeRecord['skipped']; excluded?: number } | null;

/**
 * Where <base>'s policy stands for a REVIEW_DIFF_TOO_LARGE fix: the source commit, its min_gstack_version, and the exclusion
 * state, from `known` (the plan's review_exclude, null when it had none) or, when the caller has no plan, a fresh live run.
 */
export function ceilingContext(root: string, base: string, known?: PlanExclude): CeilingContext {
  const b = base.replace(/^origin\//, '');
  const ref = git(root, ['rev-parse', '--verify', '-q', `origin/${b}^{commit}`]).ok ? `origin/${b}` : b;
  const sha = git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).out.trim();
  const load = sha ? loadPolicyAt(root, sha, ref) : null;
  const read = load && !isUnavailable(load) ? load : null;
  const source = sha ? `${ref}@${sha.slice(0, 12)}${read && !read.present ? ` (no ${SHIP_POLICY_PATH})` : ''}` : ref;
  let x = known;
  if (x === undefined) {
    const c = sha ? collectLive(root, b) : null;
    const live = c?.mergeBase ? reviewExclude({ root, baseSha: sha, ref, mergeBase: c.mergeBase, perPath: c.perPath, added: c.added, classRoot: root, context: 'ceiling' }) : { state: 'none' as const };
    x = live.state === 'active' ? { state: 'active', ...live.record } : live.state === 'head-only' ? live : null;
  }
  const floor = read?.policy.min_gstack_version ?? null;
  if (!x) return { state: 'none', base: b, source, floor };
  if (x.state === 'head-only') return { state: 'head-only', base: b, source, floor, headPatterns: x.patterns ?? [] };
  return { state: 'active', base: b, source, floor, record: { patterns: x.patterns ?? [], skipped: x.skipped ?? [], excluded: x.excluded ?? 0 } };
}
