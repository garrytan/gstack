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
 * bytes: a pattern whose kept files would pass KEEP_ARG_MAX_BYTES on it is not applied.
 *
 * A file kept only for a secret line (a line that names a credential and carries a value, secretValueLine;
 * no other reason, under an applied pattern, gate scan and consumer scan both read) is also listed in `excerpt`: pass readers
 * get its matched lines in context (lib/review-secret-excerpt.ts, GST-1447) instead of the whole file, readSelection counts
 * only that excerpt, and no reader's command names it, so it does not count toward the bound (GST-1967).
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
import { scan } from './redact-engine';
import { shannonEntropy } from './redact-patterns';
import { KEY_NAME, SECRET_LINE, secretPath } from './review-risk';
import { secretExcerpt } from './review-secret-excerpt';
import { cmpVersion, parseVersion } from './version-source';
import { REVIEW_EXCLUDE_KEY_VERSION, SHIP_POLICY_PATH, isUnavailable, policyUnavailableLine } from './ship-policy';
import { loadPolicyAt } from './ship-policy-at';

/** The most diff bytes one reader is handed (about 500K tokens); above it the pass stops instead of truncating. */
export const REVIEW_DIFF_MAX_BYTES = 2_000_000;
/** The most argument bytes one git command, or the kept-file command a reader runs, may carry (under Windows' 32,767-character command line). */
export const KEEP_ARG_MAX_BYTES = 24_000;
/** How long one reader's `git diff` may run. */
export const REVIEW_DIFF_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 256 * 1024 * 1024;
const BLOB_BATCH_MAX_BYTES = 1024 * 1024;
const BLOB_BATCH_BYTES = 64 * 1024 * 1024;
export const KEPT_REASONS = ['policy-dir', 'gate-path', 'executable', 'agent-prose', 'config', 'gate-tagged', 'code', 'secret-line', 'named-by-code', 'consumer-scan-unavailable', 'gate-scan-unavailable', 'link'] as const;
export type KeptReason = (typeof KEPT_REASONS)[number];

/** What the receipt records and the queue and carry compare (by `digest`, never by `source`). */
export interface ExcludeRecord {
  source: string; patterns: string[]; applied: string[]; skipped: Array<{ pattern: string; kept: number; bytes: number }>; unmatched: string[];
  excluded: number; excluded_bytes: number; kept: number; gate_tagged: string[]; patterns_sha256: string; list_sha256: string; digest: string;
}
export interface ActiveExclusion {
  state: 'active'; record: ExcludeRecord; excluded: Set<string>; specs: string[]; keep: string[];
  /** The kept files (a subset of keep, as `:(top,literal)` items) whose only reason is a secret line: pass readers get an excerpt. */
  excerpt: string[];
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

/** Every credential name on a line: SECRET_LINE, and a key name given a value (`OPENAI_API_KEY=`, `"GH_TOKEN": `). */
const SECRET_NAMES = [...SECRET_LINE, new RegExp(String.raw`\b${KEY_NAME}['"]?\s*[=:]`)].map(r => new RegExp(r.source, `${r.flags}g`));
/** A variable reference (`$X`, `${X}`): a name, never a value. */
const VARIABLE_REFERENCE = /\$\{?[A-Za-z_]\w*\}?/g;
/** An unprefixed credential-shaped run (base64, base64url, a random token): 20+ characters mixing upper case, lower case and digits. */
const VALUE_TOKEN = /[A-Za-z0-9+/_=-]{20,}/g;
const valueToken = (text: string) => [...text.replace(VARIABLE_REFERENCE, ' ').matchAll(VALUE_TOKEN)].some(([t]) => /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t) && shannonEntropy(t) >= 3.5);
/**
 * Whether one changed line of excludable content holds a credential value, so its file is kept (GST-1967): it names a
 * credential, and the credential scan (the secrets check, with #4157's env-read rule) finds a secret anywhere on the line,
 * or a credential-shaped run follows a name within 200 characters. A line that only names one (`${OPENAI_API_KEY}`,
 * `process.env.X`, `os.environ["X"]`, a keychain) holds no value.
 */
export function secretValueLine(p: string, line: string): boolean {
  const ends = SECRET_NAMES.flatMap(r => [...line.matchAll(r)].map(m => m.index + m[0].length));
  return ends.length > 0 && (ends.some(e => valueToken(line.slice(e, e + 200))) || scan(line, { processEnv: {}, sourcePath: p }).findings.some(f => f.category === 'secret' && f.severity !== 'LOW'));
}
/** The list_sha256 of a selection that holds no file: no pattern matched the range, so applied, excluded and kept are all empty. */
export const EMPTY_LIST_SHA256 = sha256(JSON.stringify({ applied: [], excluded: [], kept: [] }));
/** A recorded selection's list hash (applied patterns, excluded files, kept files with their reasons) when its digest is built from it; null otherwise. */
export const recordedList = (r: Partial<Pick<ExcludeRecord, 'patterns_sha256' | 'list_sha256' | 'digest'>>) => (r.list_sha256 && r.digest === sha256(`${r.patterns_sha256}\n${r.list_sha256}`) ? r.list_sha256 : null);
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const literal = (p: string) => `:(top,literal)${p}`;
const argBytes = (paths: Iterable<string>) => { let n = 0; for (const p of paths) n += Buffer.byteLength(shellQuote(literal(p))) + 1; return n; };
/** `paths` in order, split so each chunk's literal pathspecs (`size` bytes each) stay within KEEP_ARG_MAX_BYTES (one path past it is its own chunk). */
function argChunks(paths: readonly string[], size = (p: string) => argBytes([p])): string[][] {
  const chunks: string[][] = [];
  let bytes = Infinity;
  for (const p of paths) {
    const n = size(p);
    if (bytes + n > KEEP_ARG_MAX_BYTES) { chunks.push([]); bytes = 0; }
    chunks[chunks.length - 1]!.push(p);
    bytes += n;
  }
  return chunks;
}

function git(root: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): { ok: boolean; status: number | null; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, input, env, encoding: 'utf8', timeout: 120_000, maxBuffer: MAX_BUFFER });
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

/** Executable image magic: ELF, Mach-O (thin, universal and 64-bit universal; 0xcafebabe is also a Java class), PE, WebAssembly and a script's #!. */
const NATIVE_MAGIC = [[0x7f, 0x45, 0x4c, 0x46], [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0xca, 0xfe, 0xba, 0xbf], [0x4d, 0x5a], [0x00, 0x61, 0x73, 0x6d], [0x23, 0x21]];

/**
 * The matched paths git calls binary by their bytes alone: `git diff --numstat` with attributes read from the empty tree, so
 * a branch's .gitattributes (`diff`, `-binary`, `text`) cannot make an executable image read as text and skip the
 * magic check. null when git cannot run it (a git without --attr-source); the caller then reads every matched file's bytes.
 */
function bytesBinary(i: ExcludeInput, patterns: readonly string[]): string[] | null {
  const empty = git(i.root, ['hash-object', '-t', 'tree', '--stdin'], '');
  if (!empty.ok) return null;
  const range = i.head ? [i.mergeBase, i.head] : [i.mergeBase];
  const r = git(i.root, [`--attr-source=${empty.out.trim()}`, 'diff', '--numstat', '-z', '--no-renames', ...range, '--', ...patterns.map(p => `:(top,glob)${p}`)]);
  return r.ok ? r.out.split('\0').filter(l => l.startsWith('-\t-\t')).map(l => l.slice(4)) : null;
}
const nativeImage = (b: Buffer) => NATIVE_MAGIC.some(m => m.every((x, k) => b[k] === x));

/**
 * The claimed paths (git calls them binary under the branch's attributes or under none: bytesBinary) whose bytes hold a NUL
 * in their first 8,000 (git's own test), read from the head blob, the file on a live tree, or the old blob for a deletion.
 * A branch's .gitattributes can make git call a text file binary; only real bytes make it binary content here. A binary file that starts with executable image magic also goes in `native`.
 * Blobs up to BLOB_BATCH_MAX_BYTES come through `git cat-file --batch` in groups of up to BLOB_BATCH_BYTES, so the git calls
 * follow the bytes and not the file count; a larger blob, or one a batch did not return, is read alone (its first 8,000 bytes).
 */
function binaryContent(i: ExcludeInput, files: ReadonlyMap<string, Matched>, claimed: ReadonlySet<string>, unread: Set<string>, native: Set<string>): Set<string> {
  const out = new Set<string>();
  const sniff = (p: string, b: Buffer) => { if (!b.includes(0)) return; out.add(p); if (nativeImage(b)) native.add(p); };
  const real = (sha: string) => /^[0-9a-f]{40,64}$/.test(sha) && !/^0+$/.test(sha);
  const bySha = new Map<string, string[]>();
  for (const p of claimed) {
    const m = files.get(p);
    if (!m) continue;
    if (!i.head && m.newMode !== '000000') {
      try { const fd = fs.openSync(path.join(i.root, p), 'r'); const buf = Buffer.alloc(8000); const n = fs.readSync(fd, buf, 0, 8000, 0); fs.closeSync(fd); sniff(p, buf.subarray(0, n)); } catch { unread.add(p); }
      continue;
    }
    const sha = real(m.newSha) ? m.newSha : real(m.oldSha) ? m.oldSha : '';
    if (sha) bySha.set(sha, [...(bySha.get(sha) ?? []), p]);
  }
  const heads = new Map<string, Buffer>();
  const sizes = bySha.size ? git(i.root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], [...bySha.keys()].join('\n') + '\n') : null;
  const small = (sizes?.ok ? sizes.out.split('\n') : []).map(l => l.split(' ')).filter(([s, n]) => bySha.has(s ?? '') && Number(n) <= BLOB_BATCH_MAX_BYTES).map(([s, n]) => [s!, Number(n)] as const);
  for (let k = 0; k < small.length;) {
    const group: string[] = [];
    let bytes = 0;
    while (k < small.length && (!group.length || bytes + small[k]![1] <= BLOB_BATCH_BYTES)) { group.push(small[k]![0]); bytes += small[k]![1]; k++; }
    const r = spawnSync('git', ['cat-file', '--batch'], { cwd: i.root, input: group.join('\n') + '\n', timeout: 120_000, maxBuffer: bytes + group.length * 200 });
    if (r.status !== 0) continue;
    let at = 0;
    for (const sha of group) {
      const nl = r.stdout.indexOf(10, at);
      const [name, type, size] = nl < 0 ? [] : r.stdout.subarray(at, nl).toString().split(' ');
      if (name !== sha || type !== 'blob' || size === undefined) break;
      heads.set(sha, Buffer.from(r.stdout.subarray(nl + 1, nl + 1 + Math.min(Number(size), 8000))));
      at = nl + 1 + Number(size) + 1;
    }
  }
  for (const [sha, paths] of bySha) {
    const batched = heads.get(sha);
    const r = batched ? null : spawnSync('git', ['cat-file', 'blob', sha], { cwd: i.root, timeout: 30_000, maxBuffer: 8000 });
    const read = !r || r.status === 0 || (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
    const head = batched ?? (r?.stdout ?? Buffer.alloc(0)).subarray(0, 8000);
    for (const p of paths) if (!read) unread.add(p); else sniff(p, head);
  }
  return out;
}

/**
 * The added lines of matched files git calls binary only because of their attributes (the bytes hold no NUL): the
 * collector's added lines are empty for them, so the secret-line rule reads `git diff --text` instead, which no
 * .gitattributes, textconv or external diff driver changes. One git diff per KEEP_ARG_MAX_BYTES of literal pathspecs;
 * git prints one section per path in byte order, so a chunk whose sections do not line up with its sorted paths, or a
 * git failure, puts every path of that chunk in `unread`.
 */
function attributeBinaryLines(i: ExcludeInput, paths: readonly string[], unread: Set<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const range = i.head ? [i.mergeBase, i.head] : [i.mergeBase];
  for (const chunk of argChunks([...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))) {
    const r = git(i.root, ['diff', '--text', '--no-textconv', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U0', ...range, '--', ...chunk.map(literal)]);
    const sections = r.ok ? r.out.split(/^(?=diff --git )/m).filter(s => s.startsWith('diff --git ')) : [];
    const aligned = sections.length === chunk.length && chunk.every((p, k) => /["\\\x00-\x1f\x7f]/.test(p) || sections[k]!.startsWith(`diff --git a/${p} b/${p}\n`));
    if (!aligned) { for (const p of chunk) unread.add(p); continue; }
    chunk.forEach((p, k) => { let hunk = false; out[p] = sections[k]!.split('\n').filter(l => (hunk ||= l.startsWith('@@')) && l.startsWith('+')).map(l => l.slice(1)); });
  }
  return out;
}

/** The kind of content a path holds when the policy may exclude it, or null for code (tests included). */
export type ContentKind = 'binary' | 'data' | 'docs' | 'log';
/** One range's input with the matched files a pattern names by their file name (its last segment, with no glob character): a config name there is data. */
type Scope = ExcludeInput & { named?: ReadonlySet<string> };
const config = (i: Scope, p: string) => isDataConfig(p) && !i.named?.has(p);
function contentKind(i: Scope, p: string, binary: ReadonlySet<string>): ContentKind | null {
  if (binary.has(p)) return 'binary';
  if (DATA_PATH.test(p) && !config(i, p)) return 'data';
  if (/\.log$/i.test(p)) return 'log';
  return classifyPath(p, i.classRoot) === 'docs' ? 'docs' : null;
}

/**
 * The only extensions a binary file may be excludable content under: images, fonts, media, documents, compressed archives
 * and data blobs. Any other binary (source with a NUL, a native library or executable, a key store, a pickle, no
 * extension) is code; so is one that starts with executable image magic whatever its extension.
 */
const BINARY_CONTENT_EXT = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic|heif|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|oga|ogv|webm|mov|avi|mkv|flac|aac|opus|pdf|docx|xlsx|pptx|odt|ods|odp|gz|tgz|zip|tar|bz2|xz|zst|7z|bin|dat|parquet|arrow|feather|avro|orc|npy|npz|h5|hdf5|sqlite3?|db|safetensors)$/i;

/** Why a matched file is kept by its path, mode and lines alone; null for content the policy may exclude. A binary file readers would only see as "Binary files differ" is content unless its directory, mode, gate tags, extension or magic keep it. */
function pathReason(i: Scope, p: string, m: Matched, binary: ReadonlySet<string>, native: ReadonlySet<string>): KeptReason | null {
  if (/^\.(gstack|github)\//.test(p)) return 'policy-dir';
  if (isGatePath(p) || secretPath(p, i.added[p] ?? [])) return 'gate-path';
  if (m.oldMode === '100755' || m.newMode === '100755') return 'executable';
  if ([m.oldMode, m.newMode].some(x => x === '120000' || x === '160000')) return 'link';
  if (i.gateTagged?.has(p)) return 'gate-tagged';
  if (binary.has(p)) return BINARY_CONTENT_EXT.test(p) && !native.has(p) ? null : 'code';
  if (isAgentProse(p)) return 'agent-prose';
  if (config(i, p)) return 'config';
  if (contentKind(i, p, binary) === null) return 'code';
  if ((i.added[p] ?? []).some(l => secretValueLine(p, l))) return 'secret-line';
  return null;
}

/** A file whose full-path reference keeps excluded content: a code or test file (not docs, data, a .log or binary) outside the would-be-excluded set. */
const consumer = (i: Scope, f: string, candidates: ReadonlySet<string>) =>
  !candidates.has(f) && !f.startsWith('.gstack/tmp/') && contentKind(i, f, new Set()) === null;

/**
 * An uncapped `git grep -F -o -f` of fixed strings at the head (or the working tree) and `revs`: string -> the consumer files
 * holding it; null when git could not list a tree, a consumer's name did not survive UTF-8 decoding, or git could not build
 * the scratch index or grep it (a timeout included). Each tree's file list is filtered to consumers first, so the data under
 * the patterns is never read (GST-1435: a whole-tree grep for 4,354 candidate paths through 30 MB of receipts ran 278 s), and
 * the consumers go into a scratch index that one git grep reads, so the git calls stay fixed however many files there are
 * (GST-1442: 363 chunked greps over a 192k-file tree ran 132 s). On a live tree, an entry git reads from its blob
 * (skip-worktree or assume-unchanged) goes into a second index grepped with --cached, as git grep itself would read it.
 */
function grepFixed(i: Scope, strings: readonly string[], candidates: ReadonlySet<string>, revs: readonly string[]): Map<string, Set<string>> | null {
  const found = new Map<string, Set<string>>();
  if (!strings.length) return found;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-exclude-'));
  try {
    const list = path.join(dir, 'patterns');
    fs.writeFileSync(list, strings.join('\n') + '\n');
    let n = 0;
    for (const at of [i.head ?? '', ...revs]) {
      const ls = git(i.root, at ? ['ls-tree', '-r', '-z', at] : ['ls-files', '-s', '-v', '-z']);
      if (!ls.ok) return null;
      const worktree: string[] = [];
      const cached: string[] = [];
      for (const entry of ls.out.split('\0')) {
        const tab = entry.indexOf('\t');
        const f = entry.slice(tab + 1);
        if (tab < 0 || !consumer(i, f, candidates)) continue;
        if (f.includes('\uFFFD')) return null;
        const meta = entry.slice(0, tab).split(' ');
        if (at) { if (meta[1] === 'blob') cached.push(`${meta[0]} ${meta[2]}\t${f}`); continue; }
        const [tag = '', mode, sha, stage] = meta;
        (tag === 'S' || tag !== tag.toUpperCase() ? cached : worktree).push(`${mode} ${sha} ${stage}\t${f}`);
      }
      for (const [entries, flags] of [[worktree, []], [cached, ['--cached']]] as const) {
        if (!entries.length) continue;
        const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, `index-${n++}`) };
        if (!git(i.root, ['update-index', '-z', '--index-info'], entries.join('\0') + '\0', env).ok) return null;
        const r = git(i.root, ['grep', ...flags, '-I', '-F', '-o', '--null', '--no-line-number', '--no-column', '--no-color', '-f', list], undefined, env);
        if (r.status !== 0 && r.status !== 1) return null;
        for (const line of r.out.split('\n')) {
          const parts = line.split('\0');
          const file = parts[0];
          const match = parts.length > 1 ? parts[parts.length - 1] : undefined;
          if (!file || !match) continue;
          (found.get(match) ?? found.set(match, new Set()).get(match)!).add(file);
        }
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
 * failure keeps every candidate (consumer-scan-unavailable), and so does an unknown gate scan (gate-scan-unavailable) or a
 * matched text file with changed lines the collector holds no added lines for (GST-1451: it is unread, so it fails closed).
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
  const unread = new Set<string>();
  const native = new Set<string>();
  const claimed = i.perPath.filter(e => e.binary && sel.files.has(e.path)).map(e => e.path);
  const binary = binaryContent(i, sel.files, new Set([...claimed, ...(bytesBinary(i, patterns) ?? sel.files.keys())]), unread, native);
  const fileName = (s: string) => s.slice(s.lastIndexOf('/') + 1);
  const x: Scope = { ...i, named: new Set(patterns.flatMap(q => /[*?[\\]/.test(fileName(q)) ? [] : (sel.byPattern.get(q) ?? []).filter(f => fileName(f) === fileName(q)))) };
  const text = { ...x, added: { ...i.added, ...attributeBinaryLines(i, claimed.filter(p => !binary.has(p) && !unread.has(p)), unread) } };
  const collected = new Map(i.perPath.map(e => [e.path, e]));
  const unseen = (p: string) => { const e = collected.get(p); return !e || (!e.binary && e.lines > 0 && !(p in text.added)); };
  const reasons = new Map<string, KeptReason | null>();
  for (const [p, m] of sel.files) reasons.set(p, unread.has(p) ? 'consumer-scan-unavailable' : pathReason(text, p, m, binary, native) ?? (unseen(p) ? 'consumer-scan-unavailable' : null));
  const candidates = new Set([...reasons].filter(([, r]) => r === null).map(([p]) => p));
  const secretOnly = [...reasons].filter(([p, r]) => r === 'secret-line' && !p.includes('\n')).map(([p]) => p);
  const named = grepFixed(x, [...candidates, ...secretOnly].filter(p => !p.includes('\n')), new Set([...candidates, ...secretOnly]), [i.mergeBase]);
  for (const p of candidates) {
    if (i.gateTagged === null) reasons.set(p, 'gate-scan-unavailable');
    else if (named === null || p.includes('\n')) reasons.set(p, 'consumer-scan-unavailable');
    else if (named.has(p)) reasons.set(p, 'named-by-code');
  }
  const excerptable = new Set(i.gateTagged === null || named === null ? [] : secretOnly.filter(p => !named.has(p)));
  const applied: string[] = [];
  const skipped: ExcludeRecord['skipped'] = [];
  const keep = new Set<string>();
  for (const p of patterns) {
    const hit = sel.byPattern.get(p) ?? [];
    if (!hit.some(f => reasons.get(f) === null)) continue;
    const kept = hit.filter(f => reasons.get(f) !== null);
    const bytes = argBytes([...new Set([...keep, ...kept])].filter(f => !excerptable.has(f)));
    if (bytes > KEEP_ARG_MAX_BYTES) { skipped.push({ pattern: p, kept: kept.length, bytes }); continue; }
    applied.push(p);
    for (const f of kept) keep.add(f);
  }
  const excluded = new Set(applied.flatMap(p => (sel.byPattern.get(p) ?? []).filter(f => reasons.get(f) === null)));
  const excerpt = [...excerptable].filter(p => keep.has(p)).sort();
  const keptList = [...reasons].filter(([, r]) => r !== null).map(([p, r]) => ({ path: p, reason: r! })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sortedExcluded = [...excluded].sort();
  const content: Record<ContentKind, number> = { binary: 0, data: 0, docs: 0, log: 0 };
  for (const p of sortedExcluded) content[contentKind(x, p, binary)!]++;
  const prefixes = [...new Set(applied.map(literalPrefix).filter(Boolean))];
  const refs = grepFixed(x, prefixes, excluded, []) ?? new Map<string, Set<string>>();
  const patterns_sha256 = sha256(JSON.stringify(patterns));
  const list_sha256 = sha256(JSON.stringify({ applied, excluded: sortedExcluded, kept: keptList.map(k => [k.path, k.reason]) }));
  const record: ExcludeRecord = {
    source, patterns: [...patterns], applied, skipped, unmatched: patterns.filter(p => !(sel.byPattern.get(p) ?? []).length),
    excluded: excluded.size, excluded_bytes: excludedBytes(i, sortedExcluded, sel.files), kept: keptList.length,
    gate_tagged: keptList.filter(k => k.reason === 'gate-tagged').map(k => k.path), patterns_sha256, list_sha256, digest: sha256(`${patterns_sha256}\n${list_sha256}`),
  };
  return {
    state: 'active', record, excluded, specs: applied.map(p => `:(top,exclude,glob)${p}`), keep: [...keep].sort().map(literal), excerpt: excerpt.map(literal), kept: keptList, content,
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
  if (x.excerpt.length) out.push(`REVIEW_EXCLUDE_EXCERPT: ${x.excerpt.length} kept files hold no keep reason but a secret line; gstack-review-dispatch pass gives readers their matched lines in context, not the whole files, and DIFF_KEEP leaves them out`);
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
  | { ok: true; text: string; bytes: number; byDir: Array<[string, number]>; excerpt?: string; whole?: string[] }
  | { ok: false; reason: 'timeout' | 'git-exit'; exit: number | null; stderr: string; timeoutMs: number };

/** The excerpt of one `git diff --text` over the excerpt files; any throw sends every file whole (fail closed). */
function excerptOf(out: string, specs: readonly string[]): { text: string; whole: string[]; wholeText: string; files: Array<{ path: string; text: string }> } {
  const paths = specs.map(s => s.replace(/^:\(top,literal\)/, ''));
  try {
    if (specs.some(s => !s.startsWith(':(top,literal)'))) throw new Error('an excerpt item is not a literal pathspec');
    const x = secretExcerpt(out, paths);
    return { text: x.text, files: x.files, whole: x.whole.map(literal), wholeText: x.wholeText };
  } catch { return { text: '', files: [], whole: [...specs], wholeText: out }; }
}

/**
 * One reader's selection read once: `git diff <base> [-- pathspecs]`, then the kept-file command, with its bytes per top
 * directory. The kept and excerpt files are read in git calls of at most KEEP_ARG_MAX_BYTES of pathspecs each, so however many
 * there are no command passes Windows' limit. `excerpt` files (ActiveExclusion.excerpt) are read with `git diff --text` and count as their secret-line
 * excerpt, appended to `text` and returned as `excerpt`; a file the excerpt could not be built for counts whole, its
 * section joins `text` and its item is listed in `whole` for the caller's keep command.
 */
export function readSelection(root: string, diffBase: string, pathspecs: readonly string[], keep: readonly string[] = [], excerpt: readonly string[] = [], timeoutMs = REVIEW_DIFF_TIMEOUT_MS): ReaderDiff {
  let text = '';
  let raw = '';
  let full = false;
  const size = (s: string) => Buffer.byteLength(shellQuote(s)) + 1;
  const textFlags = ['--text', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
  const reads: Array<[readonly string[], string[]]> = [[pathspecs, []], ...argChunks(keep, size).map(c => [c, []] as [readonly string[], string[]]),
    ...argChunks(excerpt, size).map(c => [c, textFlags] as [readonly string[], string[]])];
  for (const [specs, flags] of reads) {
    const tail = specs.length ? (specs[0] === '--' ? specs : ['--', ...specs]) : [];
    const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', ...flags, diffBase, ...tail], { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOBUFS') { text += raw + (r.stdout ?? ''); full = true; break; }
    if (code === 'ETIMEDOUT' || (r.signal && r.status === null)) return { ok: false, reason: 'timeout', exit: null, stderr: r.stderr ?? '', timeoutMs };
    if (r.status !== 0) return { ok: false, reason: 'git-exit', exit: r.status, stderr: r.stderr ?? '', timeoutMs };
    if (flags.length) raw += r.stdout; else text += r.stdout;
  }
  const ex = excerpt.length && !full ? excerptOf(raw, excerpt) : undefined;
  if (ex) text += ex.wholeText;
  const byDir = new Map<string, number>();
  const add = (file: string, bytes: number) => { const dir = file.includes('/') ? file.split('/')[0]! : '(root)'; byDir.set(dir, (byDir.get(dir) ?? 0) + bytes); };
  const starts = [...text.matchAll(/^diff --git a\/(\S+)/gm)];
  starts.forEach((m, k) => add(m[1]!, Buffer.byteLength(text.slice(m.index!, k + 1 < starts.length ? starts[k + 1]!.index! : text.length))));
  for (const f of ex?.files ?? []) add(f.path, Buffer.byteLength(f.text));
  const all = ex?.text ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}${ex.text}` : text;
  return { ok: true, text: all, bytes: Buffer.byteLength(all), byDir: [...byDir].sort((a, b) => b[1] - a[1]), ...(ex ? { excerpt: ex.text, whole: ex.whole } : {}) };
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
