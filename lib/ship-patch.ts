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
 *   change (reviewedBase -> currentBase) puts it, so only context lines the base edited differ;
 *   or a hunk's added lines match byte for byte and its removed lines are the base's own edit of
 *   the lines the reviewed hunk replaced (founderstar#563: the base took SAVE_VERSION 83 under the
 *   branch's 84, GST-1561), which the scoped review reads too.
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
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EMPTY_PROJECT_CONFIG, scanCandidate } from './gate-diff/index';
import { parseUnifiedDiff } from './gate-diff/git';
import { CARRY_TEST_CODE_GLOBS } from './ship-receipt';
import { matchesAny } from './ship-policy';
import { isGatePath } from './review-depth';
import { TARGETED_BRIEF_FILE, TARGETED_CLASSES, targetedBrief } from './review-targeted';
import { parseConfig, PREGATE_CONFIG_PATH } from './pregate/config';
import { headPolicyDiff } from './pregate/head-policy';
import { CHECK_IDS } from './pregate/index';

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
  if (!r0?.length || !c0 || !b0 || r0.length !== c0.length) return 'changed';
  const map = mapper(b0);
  if (!r0.every((h, i) => h.body === c0[i]!.body ? sameSpot(h, c0[i]!, map) : baseEditOnly(h, c0[i]!, map, b0))) return 'changed';
  return ids[0] === ids[1] && r0.every((h, i) => h.body === c0[i]!.body) ? 'same' : 'context';
}

/**
 * Whether a hunk whose body changed since review differs only by the base's edit of the lines it replaces: the added
 * lines are the reviewed ones byte for byte, and the lines just outside the reviewed hunk's removed range are lines the
 * base kept, landing just outside the current hunk's range, so the current removed lines are the base's version of the
 * reviewed ones. A hunk that now removes another line, or adds anything else, is not, and neither is one whose range
 * holds a line the base added before, inside or after the reviewed lines (a base hunk there that adds more lines than
 * it removes): dropping it deletes base code rather than taking the base's edit.
 */
function baseEditOnly(r: ZeroHunk, c: ZeroHunk, map: (line: number) => number | null, base: ZeroHunk[]): boolean {
  const added = (h: ZeroHunk) => h.body.split('\n').filter((l, i, all) => l.startsWith('+') || (l.startsWith('\\') && all[i - 1]?.startsWith('+'))).join('\n');
  const start = (h: ZeroHunk) => (h.oldCount > 0 ? h.oldStart : h.oldStart + 1);
  const end = start(r) + r.oldCount;
  if (base.some(b => b.newCount > b.oldCount && b.oldStart >= start(r) - 1 && b.oldStart < end)) return false;
  return r.oldCount > 0 && added(r) === added(c) && map(start(r) - 1) === start(c) - 1 && map(end) === start(c) + c.oldCount;
}

/**
 * Whether the current base already holds the reviewed change to a path the branch no longer changes (GST-1399): a
 * three-way merge of reviewedBase -> reviewed into currentBase leaves currentBase's bytes, as when the base absorbed the
 * child's hunk. A post-review revert to the base's content leaves the reviewed change out of the base, so it is not held,
 * and a reviewed mode change (executable bit, symlink) is held only when the base has the reviewed mode. A path missing on
 * any side is not held.
 */
export function baseHolds(repoRoot: string, s: PatchSides, rel: string): boolean {
  const blobs = [s.currentBase, s.reviewedBase, s.reviewed].map(ref => {
    const r = spawnSync('git', ['cat-file', 'blob', `${ref}:${rel}`], { cwd: repoRoot, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  });
  if (blobs.some(b => b === null)) return false;
  const [mc, mb, mr] = [s.currentBase, s.reviewedBase, s.reviewed].map(ref => git(repoRoot, ['ls-tree', '--full-tree', ref, '--', rel])?.split(' ')[0]);
  if (!mc || !mr || (mr !== mb && mr !== mc)) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-patch-'));
  try {
    const files = blobs.map((b, i) => { const f = path.join(dir, String(i)); fs.writeFileSync(f, b!); return f; });
    const merged = spawnSync('git', ['merge-file', '-p', '-q', ...files], { cwd: repoRoot, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    return merged.status === 0 && merged.stdout.equals(blobs[0]!);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hunkTexts(diff: string): string[] {
  return diff.split(/^(?=@@ )/m).slice(1).map(h => h.replace(/^@@ [^@]*@@/, '@@'));
}

/** The most lines one packet section may hold; a path with a longer section takes the full loop instead. */
export const PACKET_SECTION_CAP = 200;
/** The most lines the base's change section may hold before its uncounted base lines count again (GST-1226). */
export const BASE_SECTION_CEILING = 2000;

/**
 * The scoped-review packet: per context path, the hunks that differ between the two branch patches and the base's own
 * change; per test path, its test hunks. `over` names every path with a section past PACKET_SECTION_CAP: one reviewer
 * cannot be shown all of it, so the caller sends it to the full loop. The base's +/- lines, already merged at base, are
 * shown but do not count toward the cap (GST-1226) until that section passes BASE_SECTION_CEILING lines.
 */
export function contextPacket(repoRoot: string, s: PatchSides, paths: readonly string[], tests: readonly string[] = [], bounded: Readonly<Record<string, BoundedKind>> = {}): { text: string; over: string[]; sha256: string } {
  const over = new Set<string>();
  let current = '';
  const fence = (label: string, body: string, counts: (line: string) => boolean = () => true) => {
    if (body.split('\n').filter(counts).length > PACKET_SECTION_CAP) over.add(current);
    return `${label}\n\`\`\`diff\n${body.trimEnd()}\n\`\`\`\n`;
  };
  const late = Object.keys(bounded).sort();
  const sides = `reviewed ${s.reviewed.slice(0, 12)} against ${s.reviewedBase.slice(0, 12)}; current ${s.current.slice(0, 12)} against ${s.currentBase.slice(0, 12)}.`;
  const parts = [paths.length || !late.length
    ? `# Scoped review: base context moved next to the reviewed hunks\n\n${sides} The branch's added lines are unchanged, and a removed line differs only where the base edited the line the branch replaces; read whether the merge kept their meaning next to the base's edit (a version or number the base also took). Report clean, or findings at the blocking floor.\n`
    : `# Scoped review: edits that landed after the review bound\n\n${sides}\n`];
  if (late.length) parts.push(`Bounded edits since review in ${late.map(p => `${p} (${bounded[p]})`).join(', ')}: each landed after the review bound, and its kind was proven from the diff; this one read replaces another review round (docs/review-policy.md#bounded-post-review-edits). Read every line under "Changed since review" as gate code. Audit prose is policy text agents follow: flag any change to what a gate, cap, reviewer, approval or exception does. A lanes edit maps files to tests: flag a glob that marks files covered by tests that do not exercise them. A bookkeeping row is an exemption or a limit: flag a row that moves an exemption onto code it should not cover, or raises a limit without a reason in the diff. Read them through the targeted brief at the end for money, gate, auth and secret wording. Report clean, or findings at the blocking floor.\n`);
  if (tests.length) parts.push(`Test code changed since review in ${tests.join(', ')}: read whether each test still checks what it did (no weakened or bypassed assertion, early return, new exemption, skip or mock). Report clean, or findings at the blocking floor.\n`);
  for (const rel of [...paths, ...tests, ...late]) {
    current = rel;
    const r = hunkTexts(pathDiff(repoRoot, s.reviewedBase, s.reviewed, rel, 3) ?? '');
    const c = hunkTexts(pathDiff(repoRoot, s.currentBase, s.current, rel, 3) ?? '');
    const b = hunkTexts(pathDiff(repoRoot, s.reviewedBase, s.currentBase, rel, 3) ?? '').join('');
    parts.push(`## ${rel}\n`, ...(rel in bounded ? [fence('Changed since review', pathDiff(repoRoot, s.reviewed, s.current, rel, 3) ?? '')] : []), fence('Reviewed hunks', r.filter(h => !c.includes(h)).join('')), fence('Current hunks', c.filter(h => !r.includes(h)).join('')),
      fence("The base's change", b, b.split('\n').length > BASE_SECTION_CEILING ? undefined : l => !/^[+-]/.test(l)));
  }
  if (late.length) parts.push(`## Targeted brief (${TARGETED_CLASSES.join(', ')})\n\n${packetBrief()}\n`);
  const text = parts.join('\n');
  return { text, over: [...over], sha256: createHash('sha256').update(text).digest('hex') };
}

/** The targeted brief with every class's block, as a bounded packet carries it; receipt write checks a packet holds it. */
export function packetBrief(): string {
  return targetedBrief(fs.readFileSync(TARGETED_BRIEF_FILE, 'utf8'), TARGETED_CLASSES);
}

/**
 * A test code file outside shared helpers and fixtures: `*.test.*`, `*.spec.*` and `*_test.go` anywhere, and the
 * name-only conventions (`test_*.py`, `*Test.java`, `*Tests.swift`, …) only under a test directory, since product
 * files can carry those names (`src/main/java/ABTest.java`). A path the base policy's `test_code` globs declare counts too
 * (GDScript's `tests/*_check.gd`, GST-1604), never one under `.gstack/` or `.github/`. A change to one gets the scoped review,
 * not the full loop.
 */
export function isTestCode(rel: string, declared: readonly string[] = []): boolean {
  if (/(^|\/)(helpers|fixtures|__fixtures__|__snapshots__)\//.test(rel)) return false;
  if (!/^\.(gstack|github)\//.test(rel) && matchesAny(declared, rel)) return true;
  if (!matchesAny(CARRY_TEST_CODE_GLOBS, rel)) return false;
  return /\.(test|spec)\.[^/]+$|_test\.go$/.test(rel) || /(^|\/)(test|tests|spec|__tests__|src\/test|[^/]+Tests)\//.test(rel);
}

/**
 * Test paths whose change from..to needs review: any removed or changed line (a weakened assertion or a changed
 * expected value carries no gate tag) except a literal-only rewrite, a gate edit lib/gate-diff tags (a skipped test, a
 * snapshot, a relaxed gate value), or a diff the scan cannot read. The rest still get the scoped reader of their test
 * hunks (lib/ship-release.ts route).
 */
export function gateEditedPaths(repoRoot: string, from: string, to: string, paths: readonly string[]): Set<string> | null {
  const tagged = gateTaggedPaths(repoRoot, from, to, paths);
  if (!tagged) return null;
  const removed = paths.filter(p => {
    const d = pathDiff(repoRoot, from, to, p, 0);
    if (d === null || /^(Binary files |GIT binary patch)/m.test(d)) return true;
    const at = d.search(/^@@ /m);
    return at >= 0 && d.slice(at).split('\n').some(l => l.startsWith('-')) && !literalOnly(d, git(repoRoot, ['show', `${to}:${p}`]));
  });
  return new Set([...tagged, ...removed]);
}

/** Paths with a hunk lib/gate-diff tags, or a diff its scan cannot read; null when git cannot diff them. */
function gateTaggedPaths(repoRoot: string, from: string, to: string, paths: readonly string[]): Set<string> | null {
  if (!paths.length) return new Set();
  const diff = git(repoRoot, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', from, to, '--', ...paths]);
  if (diff === null) return null;
  const scan = scanCandidate({ files: parseUnifiedDiff(diff), commits: [], project: EMPTY_PROJECT_CONFIG, specIsTestPath: true, candidate: 'route', artifact: '' });
  return new Set([...scan.hunks.filter(h => h.tags.length > 0).map(h => h.path), ...scan.unsupportedPaths.map(u => u.path)]);
}

const CHECK_CALL = /\b(expect|assert\w*|should|skip|only|todo|each|test|it|describe|bench)\b|\.to[A-Z]/;
const QUOTED = /(['"])(?:\\.|(?!\1)[^\\\n])*\1/g;
const CODE_IN_STRING = /#\{|\$\{|\b[fFrRbB]{1,2}['"]/;
const STATEMENT_END = /(;|\}|=>\s*\{|\)\s*\{)\s*$/;
/**
 * A zero-context diff whose every hunk swaps lines one for one, each pair the same once quoted strings are emptied, in
 * statements with no assertion or test call (the changed line and the lines above it back to the previous statement's end in
 * `after`, blank lines included, outside any template literal): a test literal changed (a fixture value the secrets scan flagged, GST-1276 instance 5), never a check or an
 * expected value. Template literals, interpolated strings and prefixed (f, r, b) strings do not count, since they can hold code.
 */
function literalOnly(diff: string, after: string | null): boolean {
  const hunks = zeroHunks(diff);
  if (!hunks?.length || after === null) return false;
  const text = after.split('\n');
  const statement = (n: number) => { const out = [text[n - 1] ?? '']; for (let k = n - 2; k >= 0 && !STATEMENT_END.test(text[k]!); k--) out.push(text[k]!); return out; };
  const inTemplate = (n: number) => (text.slice(0, n - 1).join('\n').match(/`/g)?.length ?? 0) % 2 === 1;
  return hunks.every(h => {
    const lines = h.body.split('\n');
    const minus = lines.filter(l => l.startsWith('-')).map(l => l.slice(1));
    const plus = lines.filter(l => l.startsWith('+')).map(l => l.slice(1));
    const bare = (l: string) => l.replace(QUOTED, '$1$1');
    return minus.length === plus.length && minus.every((m, i) => m !== plus[i] && !CODE_IN_STRING.test(m + plus[i]) && bare(m) === bare(plus[i]!)
      && !CHECK_CALL.test(bare(m)) && !inTemplate(h.newStart + i) && !statement(h.newStart + i).some(l => CHECK_CALL.test(l.replace(QUOTED, '$1$1'))));
  });
}

export type BoundedKind = 'audit prose' | 'lanes' | 'bookkeeping';
/** The most lines (added plus removed) one bounded path may change since review. */
export const BOUNDED_LINES = 20;
export interface BoundedInput {
  sides?: PatchSides; reviewed: string; now: string; base: string; candidates: readonly string[];
  /** The Step 14.5 post-audit snapshot's `hashes` (path -> blob), or null when finish could not read it. */
  audited: Readonly<Record<string, string | null>> | null;
  /** origin/<base>'s ship-policy `bookkeeping` globs. */
  bookkeeping: readonly string[];
}
export interface BoundedRefusal { path: string; reason: string; fix: string }

/** Policy prose an agent reads that a docs audit may correct: docs/*.md and the root AGENTS.md or CLAUDE.md, never a gate path. */
export const auditProse = (p: string) => (/^docs\/[^/]+\.md$/.test(p) || /^(AGENTS|CLAUDE)\.md$/.test(p)) && !isGatePath(p);

/**
 * The post-review edits finish may send to one scoped reader instead of Steps 5–11.5 (GST-1276, GST-1311), each kind proven
 * from the diff: audit prose whose bytes now are the ones the post-audit snapshot recorded; a .gstack/pregate.json change that
 * only adds lanes over the reviewed copy (pregate's own headPolicyDiff); a file the base policy declares bookkeeping. Every
 * kind needs both base sides, at most BOUNDED_LINES changed lines, readable text and no gate-scan tag. A candidate of a kind
 * that fails a proof is refused with the reason and the fix; any other path is not a candidate.
 */
export function boundedPaths(repoRoot: string, i: BoundedInput): { kinds: Record<string, BoundedKind>; refused: BoundedRefusal[] } {
  const kinds: Record<string, BoundedKind> = {};
  const refused: BoundedRefusal[] = [];
  const full = 'take Steps 5–11.5';
  const kindOf = (p: string): BoundedKind | null => auditProse(p) ? 'audit prose' : p === PREGATE_CONFIG_PATH ? 'lanes' : matchesAny([...i.bookkeeping], p) ? 'bookkeeping' : null;
  const candidates = i.candidates.filter(p => kindOf(p));
  const tagged = candidates.length ? gateTaggedPaths(repoRoot, i.reviewed, i.now, candidates) : new Set<string>();
  const blob = (tree: string, p: string) => git(repoRoot, ['rev-parse', '--verify', '--quiet', `${tree}:${p}`])?.trim() ?? null;
  for (const p of candidates) {
    const kind = kindOf(p)!;
    const refuse = (reason: string, fix: string) => refused.push({ path: p, reason, fix });
    if (!i.sides) { refuse('needs --reviewed-base', 'rerun finish with --reviewed-base <the merge base saved with the reviewed tree>'); continue; }
    const stat = git(repoRoot, ['--literal-pathspecs', 'diff', '--numstat', '--no-renames', i.reviewed, i.now, '--', p])?.trim().split(/\s+/) ?? [];
    const lines = Number(stat[0]) + Number(stat[1]);
    if (!Number.isFinite(lines)) { refuse('is binary or unreadable', full); continue; }
    if (lines > BOUNDED_LINES) { refuse(`changed ${lines} lines since review (at most ${BOUNDED_LINES})`, full); continue; }
    if (!tagged || tagged.has(p)) { refuse(tagged ? 'carries a hunk the gate scan tagged' : 'could not be gate-scanned', full); continue; }
    if (kind === 'bookkeeping' && (isGatePath(p) || /^\.(gstack|github)\//.test(p))) { refuse('is a gate path or under .gstack/ or .github/, never bookkeeping', full); continue; }
    if (kind === 'audit prose') {
      const recorded = i.audited?.[p];
      if (!recorded) { refuse('is not a doc the Step 14.5 audit snapshot recorded', 'include it in the audit (--docs), or ' + full); continue; }
      if (blob(i.now, p) !== recorded) { refuse('is not the bytes the post-audit snapshot recorded (edited after the audit)', 'restore the audited bytes, or ' + full); continue; }
    }
    if (kind === 'lanes') {
      const [refText, headText] = [i.reviewed, i.now].map(tree => git(repoRoot, ['show', `${tree}:${p}`]));
      const [ref, head] = [refText, headText].map(t => t === null ? null : parseConfig(t, CHECK_IDS));
      if (!ref || !head || ref.errors.length || head.errors.length) { refuse('does not parse at both the reviewed and the current tree', full); continue; }
      const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon)}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)}}` : JSON.stringify(v);
      const [was, now] = [refText!, headText!].map(t => JSON.parse(t) as Record<string, unknown>);
      const moved = [...new Set([...Object.keys(was), ...Object.keys(now)])].find(k => k !== 'dependencies' && canon(was[k]) !== canon(now[k]));
      if (moved) { refuse(`changes ${moved}; a lanes edit changes only dependencies`, full); continue; }
      const d = headPolicyDiff(ref.config, head.config, i.base);
      if (d.loosens.length) { refuse(`loosens the reviewed policy: ${d.loosens[0]}`, 'restore what it removed (a [] declaration lands on the base first), or ' + full); continue; }
      if (!Object.keys(d.adds).length) { refuse('adds no lane', full); continue; }
    }
    kinds[p] = kind;
  }
  return { kinds, refused };
}

export interface ScopedReview { paths: string[]; reviewer: string; verdict: 'clean'; head?: string; tree?: string; packet_sha256?: string }

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
  return { ok: true, review: { paths: covered, reviewer: v.reviewer.trim(), verdict: 'clean', ...(v.head ? { head: v.head } : {}), ...(v.tree ? { tree: v.tree } : {}), ...(typeof v.packet_sha256 === 'string' ? { packet_sha256: v.packet_sha256 } : {}) } };
}
