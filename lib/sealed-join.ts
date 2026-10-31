/**
 * sealed-join — the `sealed.label_join` rule of the sealed-output guard
 * (lib/sealed-guard.ts), on only when the policy names `sealed.label_keys`.
 *
 * A record that puts a label field (a decoy stratum, a flaw tag) next to an
 * identifier the model under test can compute from its own copy of the work
 * (a head sha, a tree hash, a byte count) tells that model which label it
 * carries. For every .json, .jsonl, .ndjson, .csv, .tsv or .md (pipe table)
 * file a published commit adds, modifies, renames or copies, each joined
 * record is fingerprinted (sha256 over its label and identifier key/value
 * pairs, in memory only) at the commit and at every parent's version (the
 * rename or copy source); a fingerprint no parent has is a finding. A file
 * over 4 MiB, one that does not parse, nests deeper than 64 or cannot be read
 * is `sealed.label_join_unchecked`. Findings carry field names, never values.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { SealedFinding } from './sealed-guard';

export const DEFAULT_IDENTIFIER_KEYS = ['head', 'head_sha', 'sha', 'commit', 'tree', 'tree_sha*', '*_sha', '*_sha256', 'sha256', 'digest', '*_digest', 'hash', '*_hash', '*_bytes', 'bytes', 'size', 'files', 'lines'];
export const JOIN_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_KEY = 128;
const SUPPORTED = /\.(json|jsonl|ndjson|csv|tsv|md)$/i;
const HEX_ID = /^(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}$/i;
const ZERO = /^0+$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export interface JoinPolicy { label_keys: string[]; identifier_keys: string[] }
type Field = { name: string; key: string; value: unknown };
type Joins = Map<string, { labels: string[]; ids: string[] }>;

/** The rule's own key normalization: trimmed, lowercased, spaces and hyphens as underscores. */
export const normalizeKey = (k: string) => k.trim().toLowerCase().replace(/[ -]/g, '_');

export function labelKeyError(s: string): string | null {
  return s.trim() && s.length <= MAX_KEY && !/[*?[\]{}.]/.test(s) ? null : `must be a bare field name of 1-${MAX_KEY} characters with no wildcard or dot (meta.stratum matches as stratum)`;
}
export function identifierKeyError(s: string): string | null {
  return s.trim() && s.length <= MAX_KEY && !/[?[\]{}.]/.test(s) ? null : `must be a bare field name of 1-${MAX_KEY} characters with no dot; * is the only wildcard`;
}

const present = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') || (Array.isArray(v) && v.length > 0);
const hexValue = (v: unknown): boolean => typeof v === 'string' ? HEX_ID.test(v.trim()) : Array.isArray(v) && v.some(e => typeof e === 'string' && HEX_ID.test(e.trim()));
const shown = (name: string) => name.split('.').map(s => HEX_ID.test(s) ? '(hex)' : s).join('.').slice(0, 64);

function classifier(p: JoinPolicy): (fields: Field[]) => { fp: string; labels: string[]; ids: string[] } | null {
  const labels = new Set(p.label_keys.map(normalizeKey));
  const ids = p.identifier_keys.map(g => new RegExp(`^${normalizeKey(g).replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return fields => {
    const l = fields.filter(f => labels.has(f.key));
    const i = fields.filter(f => (present(f.value) && ids.some(re => re.test(f.key))) || hexValue(f.value));
    if (!l.some(a => i.some(b => b !== a))) return null;
    const fp = createHash('sha256').update([...new Set([...l, ...i])].map(f => `${f.name}=${JSON.stringify(f.value)}`).sort().join('\0')).digest('hex');
    return { fp, labels: l.map(f => shown(f.name)), ids: i.map(f => shown(f.name)) };
  };
}

/** Every JSON object at any depth as one record: its own fields plus one level of nested object fields (`meta.head`), and the hex key that holds it as `(key)`; false past the depth cap. */
function jsonRecords(root: unknown, out: Field[][]): boolean {
  const field = (name: string, value: unknown, key: string): Field => ({ name, key: normalizeKey(key), value });
  const stack: Array<[unknown, number, string?]> = [[root, 0]];
  while (stack.length) {
    const [v, depth, heldBy] = stack.pop()!;
    if (!v || typeof v !== 'object') continue;
    if (depth > MAX_DEPTH) return false;
    if (Array.isArray(v)) { for (const e of v) stack.push([e, depth + 1]); continue; }
    const fields: Field[] = heldBy && HEX_ID.test(heldBy) ? [field('(key)', heldBy, '(key)')] : [];
    for (const [k, val] of Object.entries(v)) {
      const name = normalizeKey(k);
      fields.push(field(name, val, k));
      if (val && typeof val === 'object' && !Array.isArray(val)) for (const [k2, v2] of Object.entries(val)) fields.push(field(`${name}.${normalizeKey(k2)}`, v2, k2));
      stack.push([val, depth + 1, k]);
    }
    out.push(fields);
  }
  return true;
}

function delimitedRows(text: string, sep: string): string[][] | null {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) return null;
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function markdownTables(text: string): string[][][] {
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/^[`*]+|[`*]+$/g, ''));
  const lines = text.split(/\r?\n/);
  const tables: string[][][] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.includes('|') || !lines[i + 1]!.includes('|') || !TABLE_DELIMITER.test(lines[i + 1]!)) continue;
    const table = [cells(lines[i]!)];
    let j = i + 2;
    for (; j < lines.length && lines[j]!.includes('|'); j++) table.push(cells(lines[j]!));
    tables.push(table);
    i = j - 1;
  }
  return tables;
}

function tableRecords(rows: string[][], out: Field[][]): void {
  const header = (rows[0] ?? []).map(normalizeKey);
  for (const row of rows.slice(1)) if (row.some(c => c.trim())) out.push(header.map((h, i) => ({ name: h, key: h, value: (row[i] ?? '').trim() })));
}

/** The records of one supported file's text, or null when it cannot be checked (parse failure or depth cap). */
export function fileRecords(file: string, text: string): Field[][] | null {
  const body = text.replace(/^\uFEFF/, '');
  const ext = (/\.([a-z]+)$/i.exec(file)?.[1] ?? '').toLowerCase();
  const out: Field[][] = [];
  try {
    if (ext === 'json') return !body.trim() || jsonRecords(JSON.parse(body), out) ? out : null;
    if (ext === 'jsonl' || ext === 'ndjson') {
      for (const line of body.split(/\r?\n/)) if (line.trim() && !jsonRecords(JSON.parse(line), out)) return null;
      return out;
    }
  } catch { return null; }
  if (ext === 'md') { for (const t of markdownTables(body)) tableRecords(t, out); return out; }
  const rows = delimitedRows(body, ext === 'tsv' ? '\t' : ',');
  if (!rows) return null;
  tableRecords(rows.filter(r => r.some(c => c.trim())), out);
  return out;
}

/** Joined-record fingerprints of one file's text; null when it cannot be checked. */
export function fileJoins(file: string, text: string, p: JoinPolicy): Joins | null {
  const folded = normalizeKey(text);
  if (!text.includes('\\u') && !p.label_keys.some(k => folded.includes(normalizeKey(k)))) return new Map();
  const records = fileRecords(file, text);
  if (!records) return null;
  const classify = classifier(p);
  const joins: Joins = new Map();
  for (const r of records) { const j = classify(r); if (j) joins.set(j.fp, { labels: j.labels, ids: j.ids }); }
  return joins;
}

function gitBuffer(repoRoot: string, args: string[], input: string, label: string): Buffer {
  const r = spawnSync('git', args, { cwd: repoRoot, input, timeout: 120_000, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${label} failed: ${(r.stderr ?? '').toString().trim().slice(0, 200)}`);
  return r.stdout;
}

interface Change { commit: string; file: string; blob: string; parents: string[] }

/** Supported regular files a commit adds, modifies, renames or copies against every parent (`-m`: a merge's file must differ from each parent). */
function changedFiles(repoRoot: string, commits: string[]): Change[] {
  const parentCount = new Map(gitBuffer(repoRoot, ['rev-list', '--no-walk', '--parents', '--stdin'], commits.join('\n') + '\n', 'rev-list --parents').toString('utf8').split('\n').filter(Boolean).map(l => { const s = l.split(' '); return [s[0]!, Math.max(1, s.length - 1)] as const; }));
  const tokens = gitBuffer(repoRoot, ['-c', 'core.quotePath=false', 'diff-tree', '--stdin', '-r', '--root', '-m', '-M', '-C', '--raw', '-z', '--no-abbrev'], commits.join('\n') + '\n', 'diff-tree -m').toString('utf8').split('\0');
  const sections = new Map<string, Array<Map<string, { src: string; dst: string }>>>();
  let current: Map<string, { src: string; dst: string }> | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t) continue;
    if (!t.startsWith(':')) { current = new Map(); sections.set(t, [...(sections.get(t) ?? []), current]); continue; }
    const [, dstMode, src, dst, status] = t.slice(1).split(' ') as [string, string, string, string, string];
    const file = /^[RC]/.test(status) ? tokens[i += 2]! : tokens[++i]!;
    if (status.startsWith('D') || !/^100(644|755)$/.test(dstMode) || !SUPPORTED.test(file)) continue;
    current?.set(file, { src, dst });
  }
  const out: Change[] = [];
  for (const [commit, parts] of sections) {
    if (parts.length < (parentCount.get(commit) ?? 1)) continue;
    for (const [file, { dst }] of parts[0]!) {
      if (parts.every(p => p.has(file))) out.push({ commit, file, blob: dst, parents: parts.map(p => p.get(file)!.src).filter(s => !ZERO.test(s)) });
    }
  }
  return out;
}

/** Each blob's text by sha, handed to `use` as it is read (one `cat-file --batch-check`, then chunked `--batch` reads); null over the cap or when unreadable. */
function readBlobs(repoRoot: string, shas: string[], use: (sha: string, text: string | null) => void): void {
  if (!shas.length) return;
  const small: Array<[string, number]> = [];
  for (const line of gitBuffer(repoRoot, ['cat-file', '--batch-check'], shas.join('\n') + '\n', 'cat-file --batch-check').toString('utf8').split('\n').filter(Boolean)) {
    const [sha, type, size] = line.split(' ');
    if (type !== 'blob' || Number(size) > JOIN_MAX_BYTES) use(sha!, null);
    else small.push([sha!, Number(size)]);
  }
  const decoder = new TextDecoder();
  for (let start = 0; start < small.length;) {
    let end = start; let bytes = 0;
    while (end < small.length && (end === start || bytes + small[end]![1] <= 64 * 1024 * 1024)) bytes += small[end++]![1];
    const buf = gitBuffer(repoRoot, ['cat-file', '--batch'], small.slice(start, end).map(s => s[0]).join('\n') + '\n', 'cat-file --batch');
    let pos = 0;
    for (let k = start; k < end; k++) {
      const nl = buf.indexOf(0x0a, pos);
      const size = Number(buf.subarray(pos, nl).toString('utf8').split(' ')[2]);
      use(small[k]![0], decoder.decode(buf.subarray(nl + 1, nl + 1 + size)));
      pos = nl + 1 + size + 1;
    }
    start = end;
  }
}

/** `sealed.label_join` and `sealed.label_join_unchecked` findings for the published commits; [] without label_keys (no git reads). */
export function joinFindings(repoRoot: string, commits: string[], p: JoinPolicy): SealedFinding[] {
  if (!p.label_keys.length || !commits.length) return [];
  const changes = changedFiles(repoRoot, commits);
  const ext = (file: string) => (/\.[a-z]+$/i.exec(file)?.[0] ?? '').toLowerCase();
  const wanted = new Map<string, Set<string>>();
  for (const c of changes) for (const sha of [c.blob, ...c.parents]) wanted.set(sha, (wanted.get(sha) ?? new Set()).add(ext(c.file)));
  const cache = new Map<string, Joins | null>();
  readBlobs(repoRoot, [...wanted.keys()], (sha, text) => { for (const e of wanted.get(sha)!) cache.set(`${sha}\0${e}`, text === null ? null : fileJoins(`f${e}`, text, p)); });
  const joinsOf = (sha: string, file: string) => cache.get(`${sha}\0${ext(file)}`) ?? null;
  const out: SealedFinding[] = [];
  for (const c of changes) {
    const now = joinsOf(c.blob, c.file);
    if (!now) { out.push({ rule: 'sealed.label_join_unchecked', file: c.file, commit: c.commit }); continue; }
    const before = new Set(c.parents.flatMap(s => [...(joinsOf(s, c.file)?.keys() ?? [])]));
    const labels = new Set<string>(); const ids = new Set<string>();
    for (const [fp, j] of now) if (!before.has(fp)) { j.labels.forEach(k => labels.add(k)); j.ids.forEach(k => ids.add(k)); }
    if (labels.size) out.push({ rule: 'sealed.label_join', file: c.file, commit: c.commit, keys: [...[...labels].sort(), ...[...ids].sort()] });
  }
  return out;
}
