/**
 * review-scope — the finding scope of /ship's pre-landing review loop
 * (ship/sections/review-army.md, Step 9.4; docs/ship-policy.md#review-scope).
 *
 * Five Captains hit the same loop: every pass re-read the whole diff, found
 * new neighbours in pre-existing code, fixed them, and the fixes drew another
 * pass until the cycle cap. Under `review_scope: frozen` (the default) the
 * scope is fixed after pass 1: findings in the diff are fixed, findings in
 * code the PR did not change are deferred and stay on the PR, never filed as
 * issues, and later passes read only the range since the previous pass and fix
 * only blocking findings.
 * Everything below the blocking floor is a named note in the PR body and never
 * triggers a pass. `review_scope: all` keeps the old behaviour.
 *
 * Pure functions here; bin/gstack-review-scope runs git.
 */
import * as path from 'node:path';
import { SPECIALISTS } from './review-depth';
import { quarantinedIds, rank, readLedger, type LedgerBlocker } from './review-ledger';
import { parseSpecialistOutput } from './state-matrix';

export type Locus = 'diff' | 'fix-range' | 'outside';
export type Kind = 'defect' | 'test-gap' | 'advisory';
export type ReviewScopePolicy = 'frozen' | 'diff-plus-blocking' | 'all';
export const REVIEW_SCOPE_POLICIES: readonly ReviewScopePolicy[] = ['frozen', 'diff-plus-blocking', 'all'];
export type ScopeAction = 'fix' | 'defer' | 'note';

/** Lines around a changed hunk that still count as the diff (a missing check right after an added line is the diff's fault). */
export const HUNK_CONTEXT_LINES = 3;

export interface ScopeFinding {
  fingerprint?: string; path?: string; line?: number; severity?: string; category?: string; summary?: string;
  problem?: string; fix?: string; specialist?: string; advisory?: boolean; test_stub?: string;
  /** The severity and Blocks the reviewer's own text stated, from its merged.jsonl line (GST-766); `Blocks: no` keeps a CRITICAL below the floor (GST-1031). */
  stated?: { severity?: string; blocks?: string };
  /** The changed line that causes a defect reported elsewhere (a broken caller, a consumer of a removed export); the locus follows it. */
  cause?: { path?: string; line?: number };
  [key: string]: unknown;
}
export interface ScopedFinding extends ScopeFinding { locus: Locus; kind: Kind; blocking: boolean; scope: ScopeAction; raised_by?: string }

/** Who can raise a finding: the core checklist, QA probes, a specialist by name and the review-depth roles; anything else is `unknown`. */
const RAISERS: readonly string[] = ['core', 'qa', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check', 'targeted', ...SPECIALISTS];
const RAISER_ALIASES: Record<string, string> = { adversarial: 'adversarial-native' };
/** Reviewers that read after pass 1 finished (Step 11's voices and the targeted reader, a fix-check): only a blocking finding of theirs is ever `fix`. */
const AFTER_PASS_RAISERS: readonly string[] = ['adversarial-native', 'outside-voice', 'fix-check', 'targeted'];

/** The reviewer that raised a finding, for attributing passes later (GSTA-152 D6): its `raised_by` when known, else its `specialist` tag, else `unknown`. */
export function raisedBy(finding: ScopeFinding): string {
  for (const v of [finding.raised_by, finding.specialist]) {
    if (typeof v !== 'string') continue;
    const k = v.trim().toLowerCase().replace(/[\s_]+/g, '-');
    const name = RAISER_ALIASES[k] ?? k;
    if (RAISERS.includes(name)) return name;
  }
  return 'unknown';
}

/** Per path, the new-side line ranges a diff touched; `'whole'` for an added or untracked file. */
export type HunkMap = Record<string, Array<[number, number]> | 'whole'>;

/**
 * Parse `git diff -U0` output (plus untracked paths as whole files) into a hunk
 * map. The diff must be produced with `--src-prefix=a/ --dst-prefix=b/` (the
 * `diff.mnemonicPrefix` setting prints `c/` and `w/` otherwise, and no path
 * would match a finding). A deleted file is a whole changed location too: a
 * finding whose `cause` is a removed export anchors there.
 */
export function parseHunks(diff: string, untracked: readonly string[] = []): HunkMap {
  const map: HunkMap = {};
  let current: string | null = null;
  let added = false;
  let removed: string | null = null;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) { current = null; added = false; removed = null; continue; }
    if (line.startsWith('--- ')) {
      added = line === '--- /dev/null';
      removed = added ? null : line.replace(/^--- (?:a\/)?/, '').replace(/\t.*$/, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') { if (removed) map[removed] = 'whole'; current = null; continue; }
      current = line.replace(/^\+\+\+ (?:b\/)?/, '').replace(/\t.*$/, '');
      if (added) map[current] = 'whole';
      else if (!(current in map)) map[current] = [];
      continue;
    }
    if (!current || map[current] === 'whole') continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion (+N,0) still marks the line where the code used to be.
    (map[current] as Array<[number, number]>).push([start, count === 0 ? start : start + count - 1]);
  }
  for (const p of untracked) if (p) map[normalizePath(p)] = 'whole';
  return map;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function inHunks(hunks: HunkMap, path: string, line: number | undefined, context: number): boolean {
  const ranges = hunks[normalizePath(path)];
  if (ranges === undefined) return false;
  if (ranges === 'whole' || line === undefined || !Number.isFinite(line)) return true;
  return ranges.some(([a, b]) => line >= a - context && line <= b + context);
}

/**
 * Where a finding sits: in the range since the previous pass, in the branch
 * diff, or in code the PR did not change. A `cause` anchor wins over the
 * reported path, so a defect the diff causes in an unchanged caller is the
 * diff's.
 */
export function locusOf(finding: ScopeFinding, diffHunks: HunkMap, rangeHunks: HunkMap | null, context = HUNK_CONTEXT_LINES): Locus {
  const anchor = finding.cause && typeof finding.cause === 'object' && typeof finding.cause.path === 'string' ? finding.cause : finding;
  const path = typeof anchor.path === 'string' ? anchor.path : fingerprintPath(finding.fingerprint);
  if (!path) return 'outside';
  const line = typeof anchor.line === 'number' ? anchor.line : anchor === finding ? fingerprintLine(finding.fingerprint) : undefined;
  if (rangeHunks && inHunks(rangeHunks, path, line, context)) return 'fix-range';
  if (inHunks(diffHunks, path, line, context)) return 'diff';
  return 'outside';
}

export function fingerprintPath(fp: unknown): string | undefined {
  if (typeof fp !== 'string' || fp.startsWith('shared-libs:')) return undefined;
  const [path] = fp.split(':');
  return path || undefined;
}
function fingerprintLine(fp: unknown): number | undefined {
  if (typeof fp !== 'string') return undefined;
  const n = Number(fp.split(':')[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The blocking floor in Garry's words (docs/review-policy.md, CREW rule 23); every reviewer prompt carries it verbatim. */
export const BLOCKING_FLOOR = 'would fail a test, break production, or lose data or secrets';

/** The categories a reviewer uses for a test finding; `testing` is what the Testing specialist's schema emits. */
export const TEST_GAP_CATEGORIES: readonly string[] = ['testing', 'tests', 'test-gap', 'test-coverage', 'coverage', 'missing-test', 'untested'];

/** What mapStateMatrixOutput stamps on an untested state-matrix cell: a test gap, below the floor (docs/review-policy.md). */
export const UNTESTED_CELL = 'untested-cell';

const cellKey = (f: Record<string, any>): string | null => (f.cell && typeof f.cell === 'object' ? `${String(f.cell.kind ?? '').trim().toLowerCase()}\u0000${String(f.cell.action ?? '').trim().toLowerCase()}` : null);

/**
 * A reviewer output (JSON lines) with each untested state-matrix cell mapped below the floor, per matrix cell and before
 * Step 9.3's fingerprint merge: a `state-matrix` finding the checklist's schema writes as "untested cell: …", whose `cell` is a
 * cell with `"test": null` in a matrix record of the same output, and the only finding on that cell, becomes INFORMATIONAL with `state_matrix: "untested-cell"` and its
 * `raw_severity`. A second finding on the cell (a wrong row, collapsed kinds) keeps both as they are, so a merge can never
 * fold a defect into a demoted record; a cell no matrix lists as untested changes nothing. Every other line, matrix records
 * included, is returned byte for byte; `gstack-state-matrix check` reads the raw output, never this one.
 */
export function mapStateMatrixOutput(text: string): { text: string; mapped: number } {
  const { matrices, findings } = parseSpecialistOutput(text);
  const untested = new Set(matrices.flatMap(m => m.cells.filter(c => c.test === null).map(c => cellKey({ cell: c })!)));
  const perCell = new Map<string, number>();
  for (const f of findings) { const k = cellKey(f); if (k) perCell.set(k, (perCell.get(k) ?? 0) + 1); }
  let mapped = 0;
  const lines = text.split('\n').map(line => {
    let f: Record<string, any>;
    try { f = JSON.parse(line.trim()); } catch { return line; }
    const k = f && typeof f === 'object' && !f.matrix && f.category === 'state-matrix' && /^untested cell\b/i.test(String(f.summary ?? '')) ? cellKey(f) : null;
    if (!k || !untested.has(k) || perCell.get(k) !== 1 || f.state_matrix === UNTESTED_CELL) return line;
    mapped += 1;
    return JSON.stringify({ ...f, severity: 'INFORMATIONAL', raw_severity: f.severity ?? null, state_matrix: UNTESTED_CELL });
  });
  return { text: lines.join('\n'), mapped };
}

/** A finding's kind: optional advice, a test finding (a gap, a weak or flaky test, an untested state-matrix cell still below CRITICAL), or a product defect. */
export function kindOf(finding: ScopeFinding): Kind {
  if (finding.advisory === true) return 'advisory';
  if (TEST_GAP_CATEGORIES.includes(String(finding.category ?? '').toLowerCase())) return 'test-gap';
  if (finding.state_matrix === UNTESTED_CELL && String(finding.severity ?? '').toUpperCase() !== 'CRITICAL') return 'test-gap';
  return 'defect';
}

/**
 * The blocking floor: a CRITICAL defect (a test that would fail, a production
 * break, a security or data-loss defect) its reviewer did not mark `Blocks: no`
 * (GST-1031). Advisories, test gaps, wording and INFORMATIONAL items are below
 * it and never trigger another pass.
 */
export const statesNoBlock = (f: Record<string, any>) => String(f.stated?.blocks ?? '').toLowerCase() === 'no';
export function isBlocking(finding: ScopeFinding, kind = kindOf(finding)): boolean {
  return kind === 'defect' && String(finding.severity ?? '').toUpperCase() === 'CRITICAL' && !statesNoBlock(finding);
}

export interface ScopeInput { policy: ReviewScopePolicy; pass: number; diffHunks: HunkMap; rangeHunks: HunkMap | null; context?: number }

/**
 * The scope decision per finding. `all`: fix everything (today's loop).
 * An untested state-matrix cell mapped below the floor is a note from pass 1 on
 * (docs/review-policy.md, the test-gap ruling) under the other policies.
 * `frozen` pass 1: fix the diff, defer blocking findings in unchanged code,
 * note the rest. `frozen` pass 2+: fix blocking findings in the range since
 * the previous pass or in the diff; defer blocking findings outside; note
 * everything else. Step 11's voices and a fix-check read after pass 1 has
 * finished, so even at `--pass 1` their below-floor findings are notes and
 * never send the loop back for another pass (CREW rules 23 and 30a).
 */
export function scopeFindings(findings: readonly ScopeFinding[], input: ScopeInput): ScopedFinding[] {
  return findings.map(finding => {
    const kind = kindOf(finding);
    const blocking = isBlocking(finding, kind);
    const raised = raisedBy(finding);
    const locus = locusOf(finding, input.diffHunks, input.pass > 1 ? input.rangeHunks : null, input.context);
    // A blocking finding nobody could place cannot be filed against a path; the diff's author resolves it now.
    const placed = typeof finding.path === 'string' || fingerprintPath(finding.fingerprint) !== undefined;
    let scope: ScopeAction;
    if (input.policy === 'all') scope = 'fix';
    else if (kind === 'test-gap' && finding.state_matrix === UNTESTED_CELL) scope = 'note';
    else if (locus === 'outside') scope = !blocking ? 'note' : input.policy === 'diff-plus-blocking' || !placed ? 'fix' : 'defer';
    else if (input.pass <= 1 && !AFTER_PASS_RAISERS.includes(raised)) scope = 'fix';
    else scope = blocking ? 'fix' : 'note';
    return { ...finding, locus, kind, blocking, scope, raised_by: raised };
  });
}

export function scopeCounts(scoped: readonly ScopedFinding[]): { fix: number; defer: number; note: number; blocking: number } {
  return {
    fix: scoped.filter(f => f.scope === 'fix').length, defer: scoped.filter(f => f.scope === 'defer').length,
    note: scoped.filter(f => f.scope === 'note').length, blocking: scoped.filter(f => f.blocking).length,
  };
}

export function scopeLine(policy: ReviewScopePolicy, pass: number, scoped: readonly ScopedFinding[]): string {
  const c = scopeCounts(scoped);
  return `REVIEW_SCOPE: policy=${policy} pass=${pass} findings=${scoped.length} fix=${c.fix} defer=${c.defer} note=${c.note} blocking=${c.blocking}`;
}

// ---------------------------------------------------------------------------
// deferral: a blocking finding in code the PR did not change stays on the PR
// ---------------------------------------------------------------------------
const oneLine = (s: unknown) => String(s ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim();

export function findingIdentity(f: ScopeFinding): string {
  if (typeof f.fingerprint === 'string' && f.fingerprint) return f.fingerprint;
  return [f.path ?? '?', f.line ?? '', f.category ?? ''].join(':');
}
export function findingWhere(f: ScopeFinding): string {
  return f.path ? `${f.path}${typeof f.line === 'number' ? `:${f.line}` : ''}` : fingerprintPath(f.fingerprint) ?? '(no path)';
}
function findingText(f: ScopeFinding): string {
  return oneLine(f.summary ?? f.problem ?? f.category ?? 'review finding');
}

export interface DeferredRecord { fingerprint: string; path: string; severity: string; stated?: string; summary: string }

/** The PR's record of a deferred finding: `severity` stays the collected label, `stated` carries what the reviewer wrote beside it. */
export function deferredRecord(f: ScopedFinding): DeferredRecord {
  const said = [typeof f.stated?.severity === 'string' ? `Severity: ${oneLine(f.stated.severity)}` : '', typeof f.stated?.blocks === 'string' ? `Blocks: ${oneLine(f.stated.blocks)}` : ''].filter(Boolean);
  return { fingerprint: findingIdentity(f), path: findingWhere(f), severity: String(f.severity ?? 'unrated'), ...(said.length ? { stated: said.join(', ') } : {}), summary: String(f.summary ?? f.problem ?? f.category ?? '') };
}

/** The PR-body section for deferred findings, which stay on the PR: no issue is filed and no closing keyword is written. Only `frozen` defers. */
export function renderDeferredSection(deferred: readonly DeferredRecord[], noted: readonly ScopeFinding[] = []): string {
  const out: string[] = [];
  if (deferred.length) {
    out.push('## Deferred findings', '', 'Blocking findings in code this PR did not change (review scope: frozen). They stay on this PR and are not filed as issues.', '');
    for (const d of deferred) out.push(`- Deferred: ${oneLine(d.severity)}${d.stated ? ` (the reviewer wrote ${oneLine(d.stated)})` : ''} \`${oneLine(d.path)}\` ${oneLine(d.summary)}`);
    out.push('');
  }
  if (noted.length) {
    out.push('## Review notes', '', 'Below the blocking floor (advisory, informational, test-gap or wording items); recorded here and not fixed in this PR.', '');
    for (const n of noted) out.push(`- ${oneLine(n.severity ?? 'INFORMATIONAL')}${n.advisory ? ' [ADVISORY]' : ''} \`${findingWhere(n)}\` ${findingText(n)}`);
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// loop summary: what the ship receipt carries for the factory scorecard
// ---------------------------------------------------------------------------
export interface ReviewLoopSummary {
  passes: number; blocking_found: number; deferred: number; noted: number; fixed: number; scope: ReviewScopePolicy | 'unknown';
  /** One-reviewer re-checks of a fix (docs/review-policy.md#transitions); never passes. */
  fix_checks?: number;
  /** Review rounds (R51): passes plus fix-checks; the loop caps them at 2. */
  rounds?: number;
  /** Reviewer dispatches of this invocation by role (specialist, red-team, adversarial-native, outside-voice, fix-check, targeted). */
  dispatches?: Record<string, number>;
  /** Prompt plus diff bytes the dispatches read, / 4: a relative estimate, never a bill. */
  est_input_tokens?: number;
  /** Blocking findings no row gives a disposition (fixed, deferred, noted, skipped or a gate answer): found, outcome unrecorded. */
  unrecorded?: number;
  /** Dispatch ledgers whose collected and judged findings were counted (gstack-review-dispatch). */
  ledgers_read?: number;
  /** What could not bind (GST-1168), each named with its reason: a row with no start token or readable time, a row finding's ledger_id no ledger holds, a Review-Finding trailer naming no finding. Never counted as zero silently. */
  unbound?: string[];
  /** Abandoned passes left out of every count, each named (GBEV-3). */
  voided?: string[];
}

/** Review-log rows of one /ship invocation (skill review, via ship, at or after `since`) → the loop summary. */
/**
 * When a review-log row's pass started: the logger's own `review_binding.started_at`
 * first, and the writer-typed `timestamp` only when the logger stamped nothing. The
 * writer fills `timestamp` by hand, so a date-only or guessed value could otherwise
 * sort a real pass before `--since` and leave the receipt without a loop to record.
 */
function rowTime(row: Record<string, any>): number {
  for (const value of [row.review_binding?.started_at, row.timestamp]) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

/**
 * A Step 11 late defer (a queued adversarial finding scoped `defer` after the
 * last Step 9 pass) is logged under this skill, not as a `review` row: its
 * deferred findings count here, it is not a pass, and the dashboards and
 * readiness gates that pick the newest `review` row never see it (a `review`
 * row without a start token would read as UNVERIFIED and displace the pass).
 */
export const LATE_DEFER_SKILL = 'review-late-defer';
/** A fix-check (one reviewer reading the touched hunks and the fix list) logs under its own skill, so it is never a pass. */
export const FIX_CHECK_SKILL = 'review-fix-check';
const DISPATCH_SKILLS = ['review', LATE_DEFER_SKILL, FIX_CHECK_SKILL, 'adversarial-review'];

/** Dispatch records of one row: its `dispatches` array, else the specialists and Red Team its stats say ran (older rows). */
function rowDispatches(row: Record<string, any>): Array<{ role: string; bytes: number | null }> {
  if (Array.isArray(row.dispatches)) {
    return row.dispatches.filter((d: any) => d && typeof d.role === 'string').map((d: any) => {
      const b = [d.prompt_bytes, d.diff_bytes].filter((x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0) as number[];
      return { role: String(d.role).slice(0, 40), bytes: b.length ? b.reduce((a, c) => a + c, 0) : null };
    });
  }
  if (row.skill !== 'review' || !row.specialists || typeof row.specialists !== 'object') return [];
  return Object.entries(row.specialists as Record<string, any>).filter(([, s]) => s && s.dispatched === true)
    .map(([name]) => ({ role: name === 'red-team' ? 'red-team' : 'specialist', bytes: null }));
}

/** Row actions that record what happened to a finding. */
const DISPOSITIONS = ['fixed', 'auto-fixed', 'deferred', 'noted', 'skipped', 'kept', 'restored', 'open'];
/** A row finding that blocks: classified blocking, or an unclassified CRITICAL defect its reviewer did not mark Blocks: no (logged before Step 9.4's classify). */
const rowBlocks = (f: Record<string, any>) => f.blocking === true || (f.blocking === undefined && f.advisory !== true && rank(f.severity) === 4 && !statesNoBlock(f));
/** The reviewer behind a row's raised_by or a ledger id: every specialist is one; the lead's additions and unknowns name none. */
function raiserOf(raiser: unknown): string | null {
  const role = typeof raiser === 'string' ? raiser.split(/[/#]/)[0]!.trim() : '';
  if (!role || role === 'unknown' || role === 'lead' || role === 'core') return null;
  return ['qa', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check', 'targeted'].includes(role) ? role : 'specialist';
}
/** A row finding's path:line, from its path and line or its fingerprint (`path:line:category`). */
function rowLocus(f: Record<string, any>): string | null {
  if (typeof f.path === 'string' && Number.isInteger(f.line)) return `${f.path.replace(/^\.\//, '')}:${f.line}`;
  const m = /^(.+?):(\d+):/.exec(typeof f.fingerprint === 'string' ? f.fingerprint : '');
  return m ? `${m[1]!.replace(/^\.\//, '')}:${m[2]}` : null;
}

/**
 * When a dispatch ledger started (its first event) and whether it holds a fix-check reader's review: a fix-check run through
 * gstack-review-dispatch (the pass program's `fix-check` step) leaves this ledger even when no review-fix-check row was logged.
 */
export interface LedgerPass {
  started: number; fixCheck: boolean; ids?: string[]; /** The ledger's pass directory (p1, p2, fc): a pN with no review row of pass N is named unbound. */ name?: string;
  /** Whether judge ran on it at all (a rejected judgment counts): a pN pass never judged that no row names, replaced by a later judged or named pass, was abandoned (voided) and counts nothing (GBEV-3); a fix-check ledger and the last pass are never voided. */ judged?: boolean;
}
export function ledgerPass(ledger: string, key = (id: string) => id): LedgerPass {
  const events = readLedger(ledger);
  const started = Date.parse(String(events[0]?.at ?? ''));
  const fixCheck = events.some(e => e.event === 'output' && e.reader === 'fix-check' && e.tree_ok !== false && ((Array.isArray(e.ids) && e.ids.length > 0) || e.review === true));
  const gone = quarantinedIds(events);
  const ids = events.flatMap(e => (e.event === 'output' && Array.isArray(e.ids) ? (e.ids as string[]).filter(id => !gone.has(id)) : e.event === 'judgment' && e.kind === 'added' && typeof e.id === 'string' ? [e.id] : [])).map(key);
  return { started: Number.isFinite(started) ? started : NaN, fixCheck, ids, name: path.basename(path.dirname(path.resolve(ledger))), judged: events.some(e => e.event === 'judge') };
}

/** A fix commit's `Review-Finding: <ledger_id or fingerprint> reader=<role>` trailer (receipt attribution): the finding that commit fixed. */
export interface FixTrailer { finding: string; reader: string; commit: string }
export function parseFixTrailers(commit: string, values: readonly string[]): FixTrailer[] {
  return values.flatMap(v => {
    const m = /^\s*(\S+)\s+reader=([a-z][a-z0-9-]*)\s*$/.exec(v);
    return m ? [{ finding: m[1]!, reader: m[2]!, commit }] : [];
  });
}

/**
 * The loop summary. blocking_found counts every blocker found (GST-951). Each CRITICAL the dispatch ledgers hold
 * (`ledgerBlockers`, one list per ledger) is paired with at most one row finding per ledger at the same path:line, raised
 * by the same reviewer (or naming none; a fix-check re-reads every reviewer's fixes), that may be it (no severity yet, CRITICAL as logged or before a mapper lowered
 * it, or blocking), so one finding re-raised by a later pass's ledger pairs again. A paired finding blocks unless its newest
 * classification put it below the floor (blocking: false), and its row's action is its disposition. An unpaired ledger
 * CRITICAL blocks and is unrecorded. A row finding blocks by its newest classification, else as an unclassified CRITICAL.
 * A ledger CRITICAL with no locus, or a second one at a paired line, counts on its own. A different defect the same reviewer
 * raises at the exact line of a finding a row classified below the floor pairs with that finding: path:line is the only
 * identity rows and ledgers share until rows carry the ledger id.
 * Fix-checks (GST-986, #3862; `ledgerPasses`, one per ledger): fix_checks is the larger of the review-fix-check rows and the
 * fix-check ledgers, so one logged both ways counts once. When fix-checks ran without their review-fix-check rows (more fix-check
 * ledgers than rows), a blocker no row disposes counts as fixed if a fix-check ledger started after the last ledger that raised it:
 * decision 3.5 runs a fix-check only after the loop applied that pass's fixes, and a blocker the loop does not fix is deferred
 * or noted by a row. A blocker the last pass found stays unrecorded, and with every fix-check logged the rows decide.
 */
export function summarizeReviewLoop(rows: readonly Record<string, any>[], since: string, allLedgers: readonly (readonly LedgerBlocker[])[] = [], allPasses: readonly LedgerPass[] = [], trailers: readonly FixTrailer[] = []): ReviewLoopSummary {
  const sinceMs = Date.parse(since);
  const loopSkill = (r: Record<string, any>) => r.skill === 'review' || r.skill === LATE_DEFER_SKILL || r.skill === FIX_CHECK_SKILL;
  const inRun = (r: Record<string, any>) => r && r.via === 'ship' && Number.isFinite(rowTime(r)) && (!Number.isFinite(sinceMs) || rowTime(r) >= sinceMs);
  const unbound: string[] = rows.filter(r => r && r.via === 'ship' && loopSkill(r) && !Number.isFinite(rowTime(r)))
    .map(r => `row ${String(r.skill)} pass=${String(r.pass ?? '?')}: no start token and no readable timestamp, so it cannot be placed in this run`);
  // A repeated logger command writes the same row twice (#3911: one fix-check counted as two): rows that record their head dedupe by kind, pass, head and finding ids.
  const rowKey = (r: Record<string, any>) => JSON.stringify([r.skill, r.pass ?? null, r.commit_full ?? r.commit ?? '', (Array.isArray(r.findings) ? r.findings : []).map((f: any) => (f && typeof f === 'object' ? (typeof f.ledger_id === 'string' ? f.ledger_id : findingIdentity(f)) : '')).sort()]);
  const loopRows = [...new Map(rows.filter(r => inRun(r) && loopSkill(r)).map((r, i) => [r.commit_full || r.commit ? rowKey(r) : `#${i}`, r] as const)).values()];
  const passes = loopRows.filter(r => r.skill === 'review');
  const named = (dir: string) => { const n = /^p(\d+)$/.exec(dir)?.[1]; return loopRows.some(r => (n !== undefined && r.skill === 'review' && String(r.pass) === n) || (Array.isArray(r.findings) && r.findings.some((f: any) => typeof f?.ledger_id === 'string' && f.ledger_id.startsWith(`${dir}/`)))); };
  const passNo = (p: LedgerPass) => (p.fixCheck ? undefined : Number(/^p(\d+)$/.exec(p.name ?? '')?.[1] ?? NaN));
  const replaced = (n: number) => allPasses.some(q => (passNo(q) ?? NaN) > n && (q.judged !== false || named(q.name!)));
  const voidedAt = new Set(allPasses.flatMap((p, i) => { const n = passNo(p); return n !== undefined && Number.isFinite(n) && p.judged === false && p.ids?.length && !named(p.name!) && replaced(n) ? [i] : []; }));
  const voided = [...voidedAt].map(i => `pass ${allPasses[i]!.name}: its ledger was never judged and no review-log row names it (an abandoned pass), so its ${allPasses[i]!.ids!.length} collected findings are left out`);
  const ledgers = allLedgers.filter((_, i) => !voidedAt.has(i));
  const ledgerPasses = allPasses.filter((_, i) => !voidedAt.has(i));
  type Seen = { locus: string | null; raiser: string | null; classified: boolean; blocks: boolean; candidate: boolean; disposed: boolean; ledgerId?: string; fingerprint?: string };
  const seen = new Map<string, Seen>();
  const deferred = new Set<string>();
  const noted = new Set<string>();
  const fixed = new Set<string>();
  let scope: ReviewLoopSummary['scope'] = 'unknown';
  for (const row of loopRows) {
    if (REVIEW_SCOPE_POLICIES.includes(row.review_scope)) scope = row.review_scope;
    for (const f of Array.isArray(row.findings) ? row.findings : []) {
      if (!f || typeof f !== 'object') continue;
      const ledgerId = typeof f.ledger_id === 'string' && f.ledger_id ? f.ledger_id : undefined;
      // A late defer re-logs a finding an earlier row holds; without a ledger_id it is that finding when the locus and reviewer agree (GBEV-3).
      const same = !ledgerId && row.skill === LATE_DEFER_SKILL ? [...seen].find(([, s]) => s.locus !== null && s.locus === rowLocus(f) && s.raiser === raiserOf(f.raised_by))?.[0] : undefined;
      const id = ledgerId ?? same ?? findingIdentity(f);
      const prior = seen.get(id);
      const classified = typeof f.blocking === 'boolean';
      seen.set(id, {
        locus: rowLocus(f) ?? prior?.locus ?? null,
        raiser: prior?.raiser ?? raiserOf(f.raised_by),
        classified: classified || !!prior?.classified,
        blocks: classified ? f.blocking : prior?.classified ? prior.blocks : !!prior?.blocks || rowBlocks(f),
        candidate: !!prior?.candidate || f.severity === undefined || rank(f.severity) === 4 || rank(f.raw_severity) === 4 || f.blocking === true,
        disposed: !!prior?.disposed || DISPOSITIONS.includes(f.action),
        ...(ledgerId ?? prior?.ledgerId ? { ledgerId: ledgerId ?? prior?.ledgerId } : {}),
        ...(prior?.fingerprint ?? findingIdentity(f) ? { fingerprint: prior?.fingerprint ?? findingIdentity(f) } : {}),
      });
      if (f.action === 'deferred') deferred.add(id);
      if (f.action === 'noted') noted.add(id);
      if (f.action === 'fixed' || f.action === 'auto-fixed') fixed.add(id);
    }
  }
  for (const p of ledgerPasses) {
    const n = passNo(p);
    if (n !== undefined && Number.isFinite(n) && !passes.some(r => String(r.pass) === String(n))) unbound.push(`pass ${n} (ledger ${p.name}): no review-log row, so its fixes and dispositions cannot be counted`);
  }
  const known = ledgerPasses.some(p => p.ids) ? new Set(ledgerPasses.flatMap(p => p.ids ?? [])) : null;
  if (known) for (const [, s] of seen) if (s.ledgerId && !known.has(s.ledgerId)) unbound.push(`ledger_id ${s.ledgerId}: no dispatch ledger of this run collected it`);
  const paired = new Set<string>();
  const ledgerOnlyKeys: Array<{ key: string; id: string; fixed: boolean }> = [];
  const pairedIds = new Set<string>();
  const followedIds = new Set<string>();
  const lastPaired = new Map<string, number>();
  const fixCheckStarts = ledgerPasses.filter(p => p.fixCheck && Number.isFinite(p.started)).map(p => p.started);
  const rowFixChecks = loopRows.filter(r => r.skill === FIX_CHECK_SKILL).length;
  const followed = (n: number) => fixCheckStarts.length > rowFixChecks && fixCheckStarts.some(t => t > (ledgerPasses[n]?.started ?? Infinity));
  for (const [n, list] of ledgers.entries()) {
    for (const b of list) {
      const by = b.id.startsWith('fix-check') ? null : raiserOf(b.id);
      const key = b.key ?? b.id;
      const open = ([k]: [string, Seen]) => !paired.has(`${n}\0${k}`);
      const id = [...seen].find(e => open(e) && (e[1].ledgerId === key || e[1].ledgerId === b.id))?.[0]
        ?? (b.locus ? [...seen].find(e => open(e) && !e[1].ledgerId && e[1].candidate && e[1].locus === b.locus && (!e[1].raiser || !by || e[1].raiser === by))?.[0] : undefined);
      if (id) { paired.add(`${n}\0${id}`); pairedIds.add(id); if (!((ledgerPasses[lastPaired.get(id) ?? -1]?.started ?? -Infinity) > (ledgerPasses[n]?.started ?? -Infinity))) lastPaired.set(id, n); } else ledgerOnlyKeys.push({ key, id: b.id, fixed: followed(n) });
    }
  }
  for (const [id, n] of lastPaired) if (followed(n)) followedIds.add(id);
  for (const t of trailers) {
    const hit = [...seen].find(([k, s]) => k === t.finding || s.ledgerId === t.finding || s.fingerprint === t.finding);
    if (hit) { hit[1].disposed = true; fixed.add(hit[0]); continue; }
    const only = ledgerOnlyKeys.find(l => l.key === t.finding || l.id === t.finding);
    if (only) { only.fixed = true; continue; }
    unbound.push(`trailer ${t.commit.slice(0, 12)} Review-Finding: ${t.finding} reader=${t.reader}: names no finding this run's rows or ledgers hold`);
  }
  const blockers = [...seen].filter(([k, s]) => s.blocks || (pairedIds.has(k) && !s.classified));
  for (const [k, s] of blockers) if (!s.disposed && followedIds.has(k)) { s.disposed = true; fixed.add(k); }
  const ledgerOnlyFixed = ledgerOnlyKeys.filter(l => l.fixed).length;
  const unrecorded = ledgerOnlyKeys.length - ledgerOnlyFixed + blockers.filter(([, s]) => !s.disposed).length;
  const out: ReviewLoopSummary = { passes: passes.length, blocking_found: blockers.length + ledgerOnlyKeys.length, deferred: deferred.size, noted: noted.size, fixed: fixed.size + ledgerOnlyFixed, scope };
  if (unrecorded) out.unrecorded = unrecorded;
  if (ledgers.length) out.ledgers_read = ledgers.length;
  if (unbound.length) out.unbound = unbound;
  if (voided.length) out.voided = voided;
  const fixChecks = Math.max(rowFixChecks, fixCheckStarts.length);
  if (fixChecks) out.fix_checks = fixChecks;
  out.rounds = passes.length + fixChecks;
  const byRole: Record<string, number> = {};
  let bytes = 0; let measured = false;
  for (const row of rows.filter(r => inRun(r) && DISPATCH_SKILLS.includes(r.skill))) {
    for (const d of rowDispatches(row)) { byRole[d.role] = (byRole[d.role] ?? 0) + 1; if (d.bytes !== null) { bytes += d.bytes; measured = true; } }
  }
  if (Object.keys(byRole).length) out.dispatches = byRole;
  if (measured) out.est_input_tokens = Math.round(bytes / 4);
  return out;
}

export function dispatchTotal(d: Record<string, number> | undefined): number | undefined {
  return d ? Object.values(d).reduce((a, c) => a + c, 0) : undefined;
}

export function reviewLoopLine(s: ReviewLoopSummary): string {
  const total = dispatchTotal(s.dispatches);
  return `REVIEW_LOOP: passes=${s.passes} blocking_found=${s.blocking_found} deferred=${s.deferred} noted=${s.noted} fixed=${s.fixed} scope=${s.scope}`
    + (s.unrecorded ? ` unrecorded=${s.unrecorded}` : '') + (s.unbound?.length ? ` unbound=${s.unbound.length}` : '') + (s.ledgers_read ? ` ledgers_read=${s.ledgers_read}` : '')
    + (s.fix_checks ? ` fix_checks=${s.fix_checks}` : '') + (total !== undefined ? ` dispatches=${total}` : '') + (s.est_input_tokens !== undefined ? ` est_input_tokens=${s.est_input_tokens}` : '');
}
