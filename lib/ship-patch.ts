/**
 * ship-patch: whether the branch's own change to a path is the one a review saw, when the base
 * moved under it (GST-407, GST-384). /ship's finish route and the receipt carry both ask it.
 *
 * Each side is a branch patch: reviewedBase -> reviewed (what the review read) and
 * currentBase -> current (what ships), where each base is that side's merge base with the
 * target branch. A path is
 * - same: the 3-line-context patch-ids match and every hunk sits where the base's change puts it (a
 *   base merge only shifted line numbers; patch-ids ignore positions, so a block moved to an identical
 *   context elsewhere is changed);
 * - context: the +/- lines match hunk for hunk, and each hunk sits where the base's own
 *   change (reviewedBase -> currentBase) puts it, so only context lines the base edited differ.
 *   The merge may still have spliced the two (a JSON entry where the branch changed one key and
 *   the base the next), so a context path needs a scoped review of its hunks, never a silent pass;
 * - changed: anything else, including the same lines moved to another place, a file-mode change, and any path whose
 *   patches cannot be read (an empty patch on both sides of a path the branch touches). A binary, empty or mode-only
 *   patch has no hunks to place, so it is same when its patch-id matches and changed otherwise.
 * Diffs skip external drivers and textconv, so a configured filter cannot hide a line.
 * Paths reach git as literal pathspecs from NUL-separated listings, so quoted names and glob
 * characters cannot widen or empty a comparison.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { EMPTY_PROJECT_CONFIG, scanCandidate } from './gate-diff/index';
import { parseUnifiedDiff } from './gate-diff/git';
import { CARRY_TEST_CODE_GLOBS } from './ship-receipt';
import { matchesAny } from './ship-policy';

export interface PatchSides { reviewedBase: string; reviewed: string; currentBase: string; current: string }
export type PathVerdict = 'same' | 'context' | 'changed';

function git(repoRoot: string, args: string[], input?: string): string | null {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repoRoot, encoding: 'utf8', input, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Every path the diff from..to touches (renames as a delete and an add); null when git cannot diff them. */
export function touchedPaths(repoRoot: string, from: string, to: string): Set<string> | null {
  const out = git(repoRoot, ['diff', '-z', '--name-only', '--no-renames', from, to]);
  return out === null ? null : new Set(out.split('\0').filter(Boolean));
}

function pathDiff(repoRoot: string, from: string, to: string, rel: string, context: number): string | null {
  return git(repoRoot, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', `-U${context}`, from, to, '--', rel]);
}

function patchId(repoRoot: string, diff: string): string | null {
  if (!diff.trim()) return '';
  const out = git(repoRoot, ['patch-id', '--verbatim'], diff);
  return out === null ? null : out.trim().split(/\s+/)[0] ?? '';
}

interface ZeroHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; body: string }

/** The hunks of a zero-context diff; null when it has none to read (binary, mode-only) but is not empty. */
function zeroHunks(diff: string): ZeroHunk[] | null {
  const hunks: ZeroHunk[] = [];
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (!m) continue;
    const h: ZeroHunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), body: '' };
    const body: string[] = [];
    let left = h.oldCount + h.newCount;
    while (left > 0 || lines[i + 1]?.startsWith('\\')) {
      const line = lines[++i];
      if (line === undefined) return null;
      if (!line.startsWith('\\')) left--;
      body.push(line);
    }
    h.body = body.join('\n');
    hunks.push(h);
  }
  return hunks.length || !diff.trim() ? hunks : null;
}

/** Where a line of the reviewed base sits in the current base, or null when the base changed it. */
function mapper(base: ZeroHunk[]): (line: number) => number | null {
  return line => {
    let shift = 0;
    for (const h of base) {
      if (h.oldCount > 0 && line >= h.oldStart && line < h.oldStart + h.oldCount) return null;
      const before = h.oldCount > 0 ? h.oldStart + h.oldCount - 1 < line : h.oldStart < line;
      if (before) shift += h.newCount - h.oldCount;
    }
    return line + shift;
  };
}

/** Whether a branch hunk at the reviewed base's position lands where the current branch hunk sits. */
function sameSpot(r: ZeroHunk, c: ZeroHunk, map: (line: number) => number | null): boolean {
  if (r.oldCount > 0) {
    for (let k = 0; k < r.oldCount; k++) if (map(r.oldStart + k) !== c.oldStart + k) return false;
    return true;
  }
  let below = r.oldStart;
  while (below > 0 && map(below) === null) below--;
  let above = r.oldStart + 1;
  for (let guard = 0; map(above) === null && guard < 100_000; guard++) above++;
  const low = below > 0 ? map(below)! : 0;
  return c.oldStart >= low && c.oldStart <= map(above)! - 1;
}

/** The verdict for one path the branch touches on either side (module header). */
export function comparePath(repoRoot: string, s: PatchSides, rel: string): PathVerdict {
  const r3 = pathDiff(repoRoot, s.reviewedBase, s.reviewed, rel, 3);
  const c3 = pathDiff(repoRoot, s.currentBase, s.current, rel, 3);
  if (r3 === null || c3 === null || (!r3.trim() && !c3.trim())) return 'changed';
  const modes = (d: string) => d.split('\n').filter(l => /^(old mode|new mode|new file mode|deleted file mode) /.test(l)).join('\n');
  if (modes(r3) !== modes(c3)) return 'changed';
  const ids = [patchId(repoRoot, r3), patchId(repoRoot, c3)];
  if (ids[0] === null || ids[1] === null) return 'changed';
  const r0 = zeroHunks(pathDiff(repoRoot, s.reviewedBase, s.reviewed, rel, 0) ?? '');
  const c0 = zeroHunks(pathDiff(repoRoot, s.currentBase, s.current, rel, 0) ?? '');
  if (ids[0] === ids[1] && r0 === null) return 'same';
  const b0 = zeroHunks(pathDiff(repoRoot, s.reviewedBase, s.currentBase, rel, 0) ?? '');
  if (!r0?.length || !c0 || !b0 || r0.length !== c0.length || r0.some((h, i) => h.body !== c0[i]!.body)) return 'changed';
  const map = mapper(b0);
  if (!r0.every((h, i) => sameSpot(h, c0[i]!, map))) return 'changed';
  return ids[0] === ids[1] ? 'same' : 'context';
}

function hunkTexts(diff: string): string[] {
  return diff.split(/^(?=@@ )/m).slice(1).map(h => h.replace(/^@@ [^@]*@@/, '@@'));
}

/** The most lines one packet section may hold; a path with a longer section takes the full loop instead. */
export const PACKET_SECTION_CAP = 200;

/**
 * The scoped-review packet: per context path, the hunks that differ between the two branch patches and the base's own
 * change; per test path, its test hunks. `over` names every path with a section past PACKET_SECTION_CAP: one reviewer
 * cannot be shown all of it, so the caller sends it to the full loop.
 */
export function contextPacket(repoRoot: string, s: PatchSides, paths: readonly string[], tests: readonly string[] = []): { text: string; over: string[] } {
  const over = new Set<string>();
  let current = '';
  const fence = (label: string, body: string) => {
    if (body.split('\n').length > PACKET_SECTION_CAP) over.add(current);
    return `${label}\n\`\`\`diff\n${body.trimEnd()}\n\`\`\`\n`;
  };
  const parts = [`# Scoped review: base context moved next to the reviewed hunks\n\nreviewed ${s.reviewed.slice(0, 12)} against ${s.reviewedBase.slice(0, 12)}; current ${s.current.slice(0, 12)} against ${s.currentBase.slice(0, 12)}. The branch's +/- lines are unchanged; read whether the merge kept their meaning next to the base's edit. Report clean, or findings at the blocking floor.\n`];
  if (tests.length) parts.push(`Test code changed since review in ${tests.join(', ')}: read whether each test still checks what it did (no weakened or bypassed assertion, early return, new exemption, skip or mock). Report clean, or findings at the blocking floor.\n`);
  for (const rel of [...paths, ...tests]) {
    current = rel;
    const r = hunkTexts(pathDiff(repoRoot, s.reviewedBase, s.reviewed, rel, 3) ?? '');
    const c = hunkTexts(pathDiff(repoRoot, s.currentBase, s.current, rel, 3) ?? '');
    parts.push(`## ${rel}\n`, fence('Reviewed hunks', r.filter(h => !c.includes(h)).join('')), fence('Current hunks', c.filter(h => !r.includes(h)).join('')),
      fence("The base's change", hunkTexts(pathDiff(repoRoot, s.reviewedBase, s.currentBase, rel, 3) ?? '').join('')));
  }
  return { text: parts.join('\n'), over: [...over] };
}

/**
 * A test code file outside shared helpers and fixtures: `*.test.*`, `*.spec.*` and `*_test.go` anywhere, and the
 * name-only conventions (`test_*.py`, `*Test.java`, `*Tests.swift`, …) only under a test directory, since product
 * files can carry those names (`src/main/java/ABTest.java`). A change to one gets the scoped review, not the full loop.
 */
export function isTestCode(rel: string): boolean {
  if (!matchesAny(CARRY_TEST_CODE_GLOBS, rel) || /(^|\/)(helpers|fixtures|__fixtures__|__snapshots__)\//.test(rel)) return false;
  return /\.(test|spec)\.[^/]+$|_test\.go$/.test(rel) || /(^|\/)(test|tests|spec|__tests__|src\/test|[^/]+Tests)\//.test(rel);
}

/**
 * Test paths whose change from..to needs review: any removed or changed line (a weakened assertion or a changed
 * expected value carries no gate tag), a gate edit lib/gate-diff tags (a skipped test, a snapshot, a relaxed gate
 * value), or a diff the scan cannot read. The rest still get the scoped fix-check of their test hunks (lib/ship-release.ts route).
 */
export function gateEditedPaths(repoRoot: string, from: string, to: string, paths: readonly string[]): Set<string> | null {
  if (!paths.length) return new Set();
  const diff = git(repoRoot, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', from, to, '--', ...paths]);
  if (diff === null) return null;
  const files = parseUnifiedDiff(diff);
  const scan = scanCandidate({ files, commits: [], project: EMPTY_PROJECT_CONFIG, specIsTestPath: true, candidate: 'route', artifact: '' });
  const removed = paths.filter(p => {
    const d = pathDiff(repoRoot, from, to, p, 0);
    if (d === null || /^(Binary files |GIT binary patch)/m.test(d)) return true;
    const at = d.search(/^@@ /m);
    return at >= 0 && d.slice(at).split('\n').some(l => l.startsWith('-'));
  });
  return new Set([...scan.hunks.filter(h => h.tags.length > 0).map(h => h.path), ...scan.unsupportedPaths.map(u => u.path), ...removed]);
}

export interface ScopedReview { paths: string[]; reviewer: string; verdict: 'clean'; head?: string; tree?: string }

/** A clean scoped review that covers every context path at this head or tree, or why it does not stand. */
export function readScopedReview(file: string, bind: { head?: string; tree?: string }, paths: readonly string[]): { ok: true; review: ScopedReview } | { ok: false; message: string } {
  let v: any;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, message: `${file} is not readable JSON (${(e as Error).message.split('\n')[0]})` }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, message: `${file} must be { paths, reviewer, verdict, head|tree }` };
  if (v.verdict !== 'clean') return { ok: false, message: `the scoped review is ${JSON.stringify(v.verdict)}, not clean: fix its findings and run the full loop` };
  if (typeof v.reviewer !== 'string' || !v.reviewer.trim()) return { ok: false, message: 'the scoped review names no reviewer' };
  for (const key of ['head', 'tree'] as const) {
    if (bind[key] && v[key] !== bind[key]) return { ok: false, message: `the scoped review is for ${key} ${String(v[key] ?? 'none').slice(0, 12)}, not ${bind[key]!.slice(0, 12)}` };
  }
  const covered = Array.isArray(v.paths) ? v.paths.filter((p: unknown) => typeof p === 'string') : [];
  const missing = paths.filter(p => !covered.includes(p));
  if (missing.length) return { ok: false, message: `the scoped review does not cover ${missing.slice(0, 5).join(', ')}` };
  return { ok: true, review: { paths: covered, reviewer: v.reviewer.trim(), verdict: 'clean', ...(v.head ? { head: v.head } : {}), ...(v.tree ? { tree: v.tree } : {}) } };
}
