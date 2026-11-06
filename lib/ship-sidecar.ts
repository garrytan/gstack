/**
 * Godot 4 UID sidecars after review (GST-1604, founderstar#611). Godot 4.4+ writes `<file>.uid` beside each script or shader
 * it gives a UID: one line, `ResourceUID::id_to_text` of a random non-negative 63-bit id (base 34 over a-y and 0-8, since
 * Godot's alphabet constants are off by one, GH-83843), written with `FileAccess::store_line`, so a trailing "\n"
 * (core/io/resource_uid.cpp, editor/editor_file_system.cpp). Lint then wants the sidecar committed. When it lands after
 * review, nothing in it can be reviewed: the id is random, so no regeneration reproduces it either. /ship finish routes such
 * a path as a sidecar, with no reader, only when every proof holds:
 *   - the branch adds it after review: no such path at the reviewed tree or the current base (a changed UID re-identifies
 *     the script for every uid:// reference to it);
 *   - its sibling (the path without `.uid`) is a regular file now, and one the reviewed range added or modified, or one
 *     the review-loop exception accepted;
 *   - it is a regular, non-executable file whose whole content is exactly what Godot writes for one id, and no other file
 *     in the current tree declares that uid:// as its own (a copied sidecar gives two resources one UID; a scene that
 *     references the script by it is fine);
 *   - neither it nor its sibling matches the base policy's review_exclude_paths or readers.forbid_paths (a sibling no reader
 *     saw is not reviewed).
 * Any other `.uid` is refused with the reason and stays behavior; a `.import` file is never a candidate.
 */
import { spawnSync } from 'node:child_process';
import { touchedPaths, type PatchSides } from './ship-patch';

export interface SidecarInput {
  sides?: PatchSides;
  /** Paths finish still routes as behavior; only those ending in `.uid` are candidates. */
  candidates: readonly string[];
  /** Paths the review-loop exception accepted. */
  accepted: readonly string[];
  /** The git glob pathspecs no reader saw: the base policy's review_exclude_paths and readers.forbid_paths. */
  excluded: readonly string[];
}
export interface SidecarRefusal { path: string; reason: string }

const ALPHABET = 'abcdefghijklmnopqrstuvwxy012345678';
const MAX_ID = (1n << 63n) - 1n;

/** Whether `text` is byte for byte a file Godot 4 writes for one UID: `uid://`, the canonical base-34 id, an optional "\n". */
export function isGodotUidText(text: string): boolean {
  const digits = /^uid:\/\/([a-y0-8]{1,13})\n?$/.exec(text)?.[1];
  if (!digits || (digits.length > 1 && digits[0] === 'a')) return false;
  let id = 0n;
  for (const c of digits) id = id * 34n + BigInt(ALPHABET.indexOf(c));
  return id <= MAX_ID;
}

/** The PR body and receipt line for one sidecar. */
export const sidecarLine = (p: string, sibling: string) => `Godot UID sidecar: ${p} (beside ${sibling})`;

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * The other files in `tree` that declare `uid` as their own: another sidecar holding it as its line, a scene or resource
 * header (`[gd_scene … uid="…"]`) or an import file's `uid="…"` line. A reference (`[ext_resource … uid="…"]`) is not one.
 * Null when git cannot search the tree.
 */
function holders(cwd: string, tree: string, uid: string, self: string): string[] | null {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'grep', '-z', '-l', '-E', '-e', `^${uid}$`, '-e', `^\\[gd_(scene|resource)[^]]* uid="${uid}"`, '-e', `^uid="${uid}"$`, tree], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) return null;
  return r.stdout.split('\0').filter(Boolean).map(l => l.slice(tree.length + 1)).filter(p => p !== self);
}

/** The mode and blob of `rel` in `tree`; null when absent or unreadable. */
function entry(cwd: string, tree: string, rel: string): { mode: string; blob: string } | null {
  const m = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t/.exec(git(cwd, ['--literal-pathspecs', 'ls-tree', '-z', tree, '--', rel]) ?? '');
  return m ? { mode: m[1]!, blob: m[2]! } : null;
}
const regular = (e: { mode: string } | null) => e?.mode === '100644' || e?.mode === '100755';

/** The `.uid` candidates proven sidecars (path -> sibling), and each one refused with the reason. */
export function uidSidecars(cwd: string, i: SidecarInput): { proven: Record<string, string>; refused: SidecarRefusal[] } {
  const proven: Record<string, string> = {};
  const refused: SidecarRefusal[] = [];
  const candidates = i.candidates.filter(p => p.endsWith('.uid'));
  if (!candidates.length) return { proven, refused };
  const s = i.sides;
  if (!s) return { proven, refused: candidates.map(p => ({ path: p, reason: 'needs --reviewed-base' })) };
  const range = touchedPaths(cwd, s.reviewedBase, s.reviewed);
  const specs = i.excluded.map(g => `:(top,glob)${g}`);
  const listed = specs.length ? [[s.reviewedBase, s.reviewed], [s.currentBase, s.current]].map(([a, b]) => git(cwd, ['diff', '-z', '--name-only', '--no-renames', a!, b!, '--', ...specs])) : [];
  if (!range || listed.some(l => l === null)) return { proven, refused: candidates.map(p => ({ path: p, reason: 'could not be compared with the reviewed range' })) };
  const excluded = new Set(listed.flatMap(l => l!.split('\0').filter(Boolean)));
  for (const p of candidates) {
    const refuse = (reason: string) => refused.push({ path: p, reason });
    const sibling = p.slice(0, -'.uid'.length);
    const reviewed = range.has(sibling) && regular(entry(cwd, s.reviewed, sibling));
    if (!sibling || sibling.endsWith('/') || (!reviewed && !i.accepted.includes(sibling))) { refuse(`has no sibling ${sibling || '(none)'} that the reviewed range added or modified or the review-loop exception accepted`); continue; }
    if (!regular(entry(cwd, s.current, sibling))) { refuse(`has no sibling ${sibling} at the current tree`); continue; }
    if (entry(cwd, s.reviewed, p) || entry(cwd, s.currentBase, p)) { refuse('existed at the reviewed tree or the current base (a changed UID re-identifies the script)'); continue; }
    const e = entry(cwd, s.current, p);
    if (e?.mode !== '100644') { refuse(`is not a regular non-executable file (mode ${e?.mode ?? 'unreadable'})`); continue; }
    const text = git(cwd, ['cat-file', 'blob', e.blob]);
    if (text === null || !isGodotUidText(text)) { refuse('is not exactly one Godot uid://<id> line'); continue; }
    const shared = holders(cwd, s.current, text.trim(), p);
    if (shared === null) { refuse('could not be searched for its UID in the current tree'); continue; }
    if (shared.length) { refuse(`shares its UID with ${shared.sort().join(', ')}`); continue; }
    if (excluded.has(p) || excluded.has(sibling)) { refuse('or its sibling matches the base policy\'s review_exclude_paths or readers.forbid_paths, so no reader saw the script'); continue; }
    proven[p] = sibling;
  }
  return { proven, refused };
}
