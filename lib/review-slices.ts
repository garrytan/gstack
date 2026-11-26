/**
 * review-slices — a reader whose kept diff is over the review ceiling, reviewed in full by up to SLICE_CAP slice readers
 * that share no file (GST-4019, docs/review-policy.md#review-ceiling).
 *
 * gstack-review-dispatch pass plans the slices once, from the sections readSelection already read: planSlices packs whole
 * top-level directories while they fit, and splits a directory that does not fit by its subdirectories and files in sorted
 * path order. A section is atomic (both sides of a rename stay together), and so is a path changed beside paths under it
 * (a file that replaces a folder of the same name). One section over the ceiling, or a plan that needs more than
 * SLICE_CAP slices, still stops with REVIEW_DIFF_TOO_LARGE.
 *
 * Each slice is a manifest reader R#i/k whose main diff command names its paths as `:(top,literal)` items (a directory
 * whose every main-command path is in the slice is named once) beside the reader's own exclude items, and whose keep and
 * excerpt lists are the reader's, cut to the slice. sliceSelection checks the plan with git before anything is written:
 * the slices' file lists are pairwise disjoint, their union is the reader's kept-file list, and each slice's diff is at or
 * under the ceiling. The manifest and every slice's ledger render record the sha256 of the kept-file list and of the
 * slice's own list; verifySlices recomputes all of it at the reviewed tree and refuses a missing, uncollected, overlapping,
 * dropping or oversized slice. A sliced reader stays one reviewer: one plan entry, one review-log row, one R51 round.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from './spawn-sync';
import { KEEP_ARG_MAX_BYTES, REVIEW_DIFF_MAX_BYTES, REVIEW_DIFF_TIMEOUT_MS, argChunks, parseTail, readSelection, type DiffUnit, type SliceNote } from './review-exclude';
import type { LedgerEvent, VerifyRow } from './review-ledger';

/** The most slices one reader is split into. */
export const SLICE_CAP = 8;

export type SlicePlan =
  | { ok: true; slices: Array<{ paths: string[]; bytes: number }> }
  | { ok: false; reason: 'file'; file: string; bytes: number }
  | { ok: false; reason: 'cap'; needed: number; cap: number };

interface Atom { key: string; paths: string[]; bytes: number }
interface Node { key: string; bytes: number; kids: Map<string, Node>; atoms: Atom[] }

/**
 * Bin-pack an over-ceiling selection's sections into at most `cap` slices of at most `max` bytes. Deterministic: the same
 * sections give the same slices, whatever their order.
 */
export function planSlices(units: readonly DiffUnit[], max = REVIEW_DIFF_MAX_BYTES, cap = SLICE_CAP): SlicePlan {
  const parent = units.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (i: number, j: number) => { parent[find(i)] = find(j); };
  const owner = new Map<string, number>();
  units.forEach((u, i) => { for (const p of u.paths) { const j = owner.get(p); if (j === undefined) owner.set(p, i); else join(i, j); } });
  for (const [p, i] of owner) {
    const segs = p.split('/');
    for (let n = 1; n < segs.length; n++) { const j = owner.get(segs.slice(0, n).join('/')); if (j !== undefined) join(i, j); }
  }
  const groups = new Map<number, { paths: Set<string>; bytes: number; largest: [string, number] }>();
  units.forEach((u, i) => {
    const g = groups.get(find(i)) ?? { paths: new Set<string>(), bytes: 0, largest: ['', -1] as [string, number] };
    for (const p of u.paths) g.paths.add(p);
    g.bytes += u.bytes;
    if (u.bytes > g.largest[1]) g.largest = [u.paths.at(-1)!, u.bytes];
    groups.set(find(i), g);
  });
  const atoms = [...groups.values()].map(g => ({ paths: [...g.paths].sort(), bytes: g.bytes, largest: g.largest }));
  const over = atoms.filter(a => a.bytes > max).sort((a, b) => b.bytes - a.bytes || (a.paths[0]! < b.paths[0]! ? -1 : 1))[0];
  if (over) return { ok: false, reason: 'file', file: over.largest[0], bytes: over.bytes };
  const root: Node = { key: '', bytes: 0, kids: new Map(), atoms: [] };
  for (const a of atoms) {
    const dirs = a.paths.map(p => p.split('/').slice(0, -1));
    let common = dirs[0]!;
    for (const d of dirs) { let n = 0; while (n < common.length && n < d.length && common[n] === d[n]) n++; common = common.slice(0, n); }
    let node = root;
    for (let n = 0; n < common.length; n++) {
      const key = common.slice(0, n + 1).join('/');
      if (!node.kids.has(key)) node.kids.set(key, { key, bytes: 0, kids: new Map(), atoms: [] });
      node = node.kids.get(key)!;
    }
    node.atoms.push({ key: a.paths[0]!, paths: a.paths, bytes: a.bytes });
  }
  const total = (n: Node): number => (n.bytes = n.atoms.reduce((s, a) => s + a.bytes, 0) + [...n.kids.values()].reduce((s, k) => s + total(k), 0));
  total(root);
  const slices: Array<{ paths: string[]; bytes: number }> = [];
  let cur: { paths: string[]; bytes: number } = { paths: [], bytes: 0 };
  const flush = () => { if (cur.paths.length) slices.push(cur); cur = { paths: [], bytes: 0 }; };
  const items = (n: Node): Array<Node | Atom> => [...n.kids.values(), ...n.atoms].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const pathsOf = (x: Node | Atom): string[] => ('paths' in x ? x.paths : items(x).flatMap(pathsOf));
  const place = (x: Node | Atom) => {
    if (cur.bytes + x.bytes <= max) { cur.paths.push(...pathsOf(x)); cur.bytes += x.bytes; return; }
    if (x.bytes <= max) { flush(); cur.paths.push(...pathsOf(x)); cur.bytes = x.bytes; return; }
    for (const y of items(x as Node)) place(y);
  };
  for (const x of items(root)) place(x);
  flush();
  return slices.length > cap ? { ok: false, reason: 'cap', needed: slices.length, cap } : { ok: true, slices };
}

/** A slice reader's manifest entry: its command tail, keep and excerpt lists, and the hashes verify recomputes. */
export interface Slice {
  index: number; total: number; of: string; diff_base: string;
  exclude: string; keep: string[]; excerpt: string[]; items: string; tests: string;
  files: number; files_sha256: string; kept: number; kept_sha256: string; bytes: number;
  /** The reader's whole selection the slices partition. */
  base: { exclude?: string; keep?: string[]; excerpt?: string[] };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const LITERAL = ':(top,literal)';
const literal = (p: string) => `${LITERAL}${p}`;
const SUMMARY = ['test', 'fixture', '.spec.'];
/** The native summary's '*test*' '*fixture*' '*.spec.*' inside one slice: an item whose path already matches, else the patterns under it. */
const summaryItems = (positives: readonly string[]) => positives.flatMap(p => {
  const q = p.slice(LITERAL.length);
  return SUMMARY.some(w => q.includes(w)) ? [p] : SUMMARY.map(w => ':(top)' + q.replace(/[*?[\\]/g, '\\$&') + '/*' + w + '*');
});
const isExclude = (s: string) => /^:(?:\([^)]*\bexclude\b[^)]*\)|[!^])/.test(s);
export const listSha = (names: readonly string[]) => createHash('sha256').update(names.join('\0')).digest('hex');

/**
 * The paths one selection shows, with renames split (`--no-renames`), so both sides of a rename count wherever they are
 * read: its main command, then its keep and excerpt lists in argument chunks, as readSelection reads them.
 */
export function selectionNames(root: string, base: string, head: string | undefined, sel: { exclude?: string; keep?: readonly string[]; excerpt?: readonly string[] }): { ok: true; names: string[] } | { ok: false; err: string } {
  const size = (s: string) => Buffer.byteLength(shellQuote(s)) + 1;
  const main = parseTail(sel.exclude);
  const reads: string[][] = [main.length ? (main[0] === '--' ? main : ['--', ...main]) : [], ...[...argChunks(sel.keep ?? [], size), ...argChunks(sel.excerpt ?? [], size)].map(c => ['--', ...c])];
  const names = new Set<string>();
  for (const tail of reads) {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, ...(head ? [head] : []), ...tail], { cwd: root, encoding: 'utf8', timeout: REVIEW_DIFF_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return { ok: false, err: (r.stderr || String(r.error ?? r.signal ?? 'git failed')).trim().slice(0, 300) };
    for (const n of (r.stdout ?? '').split('\0')) if (n) names.add(n);
  }
  return { ok: true, names: [...names].sort() };
}

type Reader = { reader: string; exclude?: string; keep?: string[]; excerpt?: string[] };
const fail = (field: string, lead: string) => ({ ok: false as const, note: { field, lead } });
const sample = (paths: readonly string[]) => paths.slice(0, 5).map(p => JSON.stringify(p)).join(',') + (paths.length > 5 ? `,+${paths.length - 5}` : '');

/**
 * The slice readers for one planned reader: each slice's command tail (a directory whose every main-command path is in the
 * slice is named once), its keep and excerpt lists, and the coverage git confirms before anything is written.
 */
export function sliceSelection(root: string, at: string, r: Reader, plan: Array<{ paths: string[] }>, max = REVIEW_DIFF_MAX_BYTES): { ok: true; slices: Slice[] } | { ok: false; note: SliceNote } {
  const tail = parseTail(r.exclude);
  const strip = (list: readonly string[] | undefined) => (list ?? []).map(s => (s.startsWith(LITERAL) ? s.slice(LITERAL.length) : null));
  const keepPaths = strip(r.keep), excerptPaths = strip(r.excerpt);
  if ((tail.length && !(tail[0] === '--' && tail[1] === '.' && tail.slice(2).every(isExclude))) || keepPaths.includes(null) || excerptPaths.includes(null)) {
    return fail('shape', `this reader's pathspecs are not one \`.\` with exclude items and literal keep files, so gstack cannot cut them into slices`);
  }
  const excl = tail.slice(2);
  const K = new Set(keepPaths as string[]), X = new Set(excerptPaths as string[]);
  const main = plan.map(s => s.paths.filter(p => !K.has(p) && !X.has(p)));
  const owner = new Map<string, Set<number>>();
  main.forEach((ps, i) => { for (const p of ps) { const segs = p.split('/'); for (let n = 1; n <= segs.length; n++) { const q = segs.slice(0, n).join('/'); (owner.get(q) ?? owner.set(q, new Set()).get(q)!).add(i); } } });
  const full = selectionNames(root, at, undefined, r);
  if (!full.ok) return fail('unreadable', `git could not list this reader's files (${JSON.stringify(full.err)})`);
  const slices: Slice[] = [];
  const seen = new Map<string, number>();
  for (const [i, s] of plan.entries()) {
    const items = new Set<string>();
    for (const p of main[i]!) { const segs = p.split('/'); for (let n = 1; n <= segs.length; n++) { const q = segs.slice(0, n).join('/'); if (owner.get(q)!.size === 1) { items.add(q); break; } } }
    const keep = (r.keep ?? []).filter(k => s.paths.includes(k.slice(LITERAL.length)));
    const excerpt = (r.excerpt ?? []).filter(k => s.paths.includes(k.slice(LITERAL.length)));
    const positives = items.size ? [...items].sort().map(literal) : [...keep, ...excerpt];
    if (!positives.length || (!items.size && !excl.length)) return fail('shape', `slice ${i + 1} has no path its main command can name`);
    const tests = summaryItems(positives);
    const args = Math.max(...[positives, tests].map(l => l.reduce((n, p) => n + Buffer.byteLength(shellQuote(p)) + 1, 0)));
    if (args > KEEP_ARG_MAX_BYTES) return fail(`args=${i + 1}:${args}`, `slice ${i + 1}'s paths take ${args} argument bytes, more than the ${KEEP_ARG_MAX_BYTES} one reader command may carry`);
    const exclude = `-- ${[...positives, ...excl].map(shellQuote).join(' ')}`;
    const names = selectionNames(root, at, undefined, { exclude, keep, excerpt });
    if (!names.ok) return fail('unreadable', `git could not list slice ${i + 1}'s files (${JSON.stringify(names.err)})`);
    const twice = names.names.filter(n => seen.has(n));
    if (twice.length) return fail(`overlap=${i + 1}`, `slice ${i + 1} would read files slice ${seen.get(twice[0]!)! + 1} reads (${sample(twice)})`);
    for (const n of names.names) seen.set(n, i);
    const d = readSelection(root, at, parseTail(exclude), keep, excerpt);
    if (!d.ok) return fail('unreadable', `git could not read slice ${i + 1}'s diff`);
    if (d.bytes > max) return fail(`over=${i + 1}:${d.bytes}`, `slice ${i + 1} reads ${d.bytes} bytes, over the ceiling`);
    slices.push({ index: i + 1, total: plan.length, of: r.reader, diff_base: at, exclude, keep, excerpt, items: positives.map(shellQuote).join(' '), tests: tests.map(shellQuote).join(' '),
      files: names.names.length, files_sha256: listSha(names.names), kept: full.names.length, kept_sha256: listSha(full.names), bytes: d.bytes,
      base: { ...(r.exclude ? { exclude: r.exclude } : {}), ...(r.keep?.length ? { keep: [...r.keep] } : {}), ...(r.excerpt?.length ? { excerpt: [...r.excerpt] } : {}) } });
  }
  const dropped = full.names.filter(n => !seen.has(n));
  if (dropped.length) return fail(`dropped=${dropped.length}`, `the slices would leave out ${dropped.length} of this reader's files (${sample(dropped)})`);
  return { ok: true, slices };
}

/** The slices= field and fix for a reader that is over the ceiling and was not sliced. */
export function planNote(p: Extract<SlicePlan, { ok: false }>, max = REVIEW_DIFF_MAX_BYTES): SliceNote {
  return p.reason === 'file'
    ? { field: `refused(file=${JSON.stringify(p.file)}:${p.bytes})`, lead: `${JSON.stringify(p.file)} alone is ${p.bytes} bytes of diff, over the ${max}-byte ceiling, so no slice can hold it` }
    : { field: `refused(needs=${p.needed} cap=${p.cap})`, lead: `the diff needs ${p.needed} slices of at most ${max} bytes and a reader is split into at most ${p.cap}` };
}

export const sliceOf = (e: LedgerEvent): Slice | undefined => (e.slice && typeof e.slice === 'object' ? e.slice as Slice : undefined);

/** For a sliced reader's newest render, the newest render of each of its slices 1..k (undefined for one never rendered). */
export function sliceMembers(events: readonly LedgerEvent[], render: LedgerEvent): Array<LedgerEvent | undefined> {
  const s = sliceOf(render)!;
  return Array.from({ length: s.total }, (_, n) => events.filter(e => e.event === 'rendered' && e.reader === `${s.of}#${n + 1}/${s.total}`).at(-1));
}

/**
 * One SLICE row per reader whose newest render was a slice: MATCH only when every slice 1..k was rendered from one plan on
 * one tree and collected, and git at that tree gives each slice the file list its render recorded, the lists share no file,
 * their union is the reader's whole kept-file list and no slice's diff is over the ceiling.
 */
export function verifySlices(events: readonly LedgerEvent[], rows: readonly VerifyRow[], max = REVIEW_DIFF_MAX_BYTES): VerifyRow[] {
  const renders = events.filter(e => e.event === 'rendered');
  const out: VerifyRow[] = [];
  for (const of of new Set(renders.flatMap(e => (sliceOf(e) ? [sliceOf(e)!.of] : [])))) {
    const newest = renders.filter(e => e.reader === of || sliceOf(e)?.of === of).at(-1)!;
    const s = sliceOf(newest);
    if (!s) continue;
    const row = (status: string, detail: string) => out.push({ kind: 'SLICE', reader: of, status, detail: `slices=${s.total} ${detail}` });
    const members = sliceMembers(renders, newest);
    const missing = members.flatMap((e, n) => (e ? [] : [`${n + 1}/${s.total}`]));
    if (missing.length) { row('MISSING', `missing=${missing.join(',')}`); continue; }
    const plans = new Set(members.map(e => JSON.stringify([sliceOf(e!)!.kept_sha256, sliceOf(e!)!.diff_base, e!.tree, e!.workdir])));
    if (plans.size > 1) { row('MIXED', 'the slices were rendered from different plans or trees'); continue; }
    const label = (e: LedgerEvent) => { const nth = renders.filter(x => x.reader === e.reader && renders.indexOf(x) <= renders.indexOf(e)).length; return nth > 1 ? `${e.reader}@${nth}` : String(e.reader); };
    const open = members.filter(e => rows.find(r => r.kind === 'BRIEF' && r.reader === label(e!))?.status !== 'MATCH').map(e => String(e!.reader));
    if (open.length) { row('NOT_COLLECTED', `open=${open.join(',')}`); continue; }
    const root = String(newest.workdir), tree = String(newest.tree ?? '').split(' ')[0] || undefined;
    const full = selectionNames(root, s.diff_base, tree, s.base);
    if (!full.ok) { row('UNREADABLE', `err=${JSON.stringify(full.err)}`); continue; }
    const notes: string[] = [];
    let status = 'MATCH';
    const flag = (st: string, note: string) => { if (status === 'MATCH') status = st; notes.push(note); };
    if (listSha(full.names) !== s.kept_sha256) flag('CHANGED', `kept_list_changed=${full.names.length}/${s.kept}`);
    const seen = new Map<string, number>();
    for (const e of members) {
      const m = sliceOf(e!)!;
      const names = selectionNames(root, m.diff_base, tree, m);
      if (!names.ok) { flag('UNREADABLE', `slice=${m.index} err=${JSON.stringify(names.err)}`); continue; }
      if (listSha(names.names) !== m.files_sha256) flag('CHANGED', `slice=${m.index} files_changed=${names.names.length}/${m.files}`);
      const twice = names.names.filter(n => seen.has(n));
      if (twice.length) flag('OVERLAP', `slice=${m.index} overlaps=${seen.get(twice[0]!)} paths=${sample(twice)}`);
      for (const n of names.names) seen.set(n, m.index);
      const d = readSelection(root, m.diff_base, parseTail(m.exclude), m.keep, m.excerpt, REVIEW_DIFF_TIMEOUT_MS, tree);
      if (!d.ok) flag('UNREADABLE', `slice=${m.index} diff_unreadable`);
      else if (d.bytes > max) flag('OVER', `slice=${m.index} bytes=${d.bytes} max=${max}`);
    }
    const dropped = full.names.filter(n => !seen.has(n));
    if (dropped.length) flag('DROPPED', `dropped=${dropped.length} paths=${sample(dropped)}`);
    row(status, `files=${full.names.length} kept=${s.kept_sha256.slice(0, 12)}${notes.length ? ' ' + notes.join(' ') : ''}`);
  }
  return out;
}
