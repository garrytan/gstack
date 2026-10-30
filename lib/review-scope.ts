/**
 * review-scope — the finding scope of /ship's pre-landing review loop
 * (ship/sections/review-army.md, Step 9.4; docs/ship-policy.md#review-scope).
 *
 * Five Captains hit the same loop: every pass re-read the whole diff, found
 * new neighbours in pre-existing code, fixed them, and the fixes drew another
 * pass until the cycle cap. Under `review_scope: frozen` (the default) the
 * scope is fixed after pass 1: findings in the diff are fixed, findings in
 * code the PR did not change are filed as issues (deferred), and later passes
 * read only the range since the previous pass and fix only blocking findings.
 * Everything below the blocking floor is a named note in the PR body and never
 * triggers a pass. `review_scope: all` keeps the old behaviour.
 *
 * Pure functions here; bin/gstack-review-scope runs git and gh.
 */
import { SPECIALISTS } from './review-depth';

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
  /** The changed line that causes a defect reported elsewhere (a broken caller, a consumer of a removed export); the locus follows it. */
  cause?: { path?: string; line?: number };
  [key: string]: unknown;
}
export interface ScopedFinding extends ScopeFinding { locus: Locus; kind: Kind; blocking: boolean; scope: ScopeAction; raised_by?: string }

/** Who can raise a finding: the core checklist, QA probes, a specialist by name and the review-depth roles; anything else is `unknown`. */
const RAISERS: readonly string[] = ['core', 'qa', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check', ...SPECIALISTS];
const RAISER_ALIASES: Record<string, string> = { adversarial: 'adversarial-native' };

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

function normalizePath(p: string): string {
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

function fingerprintPath(fp: unknown): string | undefined {
  if (typeof fp !== 'string' || fp.startsWith('shared-libs:')) return undefined;
  const [path] = fp.split(':');
  return path || undefined;
}
function fingerprintLine(fp: unknown): number | undefined {
  if (typeof fp !== 'string') return undefined;
  const n = Number(fp.split(':')[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The categories a reviewer uses for a test finding; `testing` is what the Testing specialist's schema emits. */
export const TEST_GAP_CATEGORIES: readonly string[] = ['testing', 'tests', 'test-gap', 'test-coverage', 'coverage', 'missing-test', 'untested'];

/** A finding's kind: optional advice, a test finding (a gap, a weak or flaky test), or a product defect. */
export function kindOf(finding: ScopeFinding): Kind {
  if (finding.advisory === true) return 'advisory';
  if (TEST_GAP_CATEGORIES.includes(String(finding.category ?? '').toLowerCase())) return 'test-gap';
  return 'defect';
}

/**
 * The blocking floor: a CRITICAL defect (a test that would fail, a production
 * break, a security or data-loss defect). Advisories, test gaps, wording and
 * INFORMATIONAL items are below it and never trigger another pass.
 */
export function isBlocking(finding: ScopeFinding, kind = kindOf(finding)): boolean {
  return kind === 'defect' && String(finding.severity ?? '').toUpperCase() === 'CRITICAL';
}

export interface ScopeInput { policy: ReviewScopePolicy; pass: number; diffHunks: HunkMap; rangeHunks: HunkMap | null; context?: number }

/**
 * The scope decision per finding. `all`: fix everything (today's loop).
 * `frozen` pass 1: fix the diff, defer blocking findings in unchanged code,
 * note the rest. `frozen` pass 2+: fix blocking findings in the range since
 * the previous pass or in the diff; defer blocking findings outside; note
 * everything else.
 */
export function scopeFindings(findings: readonly ScopeFinding[], input: ScopeInput): ScopedFinding[] {
  return findings.map(finding => {
    const kind = kindOf(finding);
    const blocking = isBlocking(finding, kind);
    const locus = locusOf(finding, input.diffHunks, input.pass > 1 ? input.rangeHunks : null, input.context);
    // A blocking finding nobody could place cannot be filed against a path; the diff's author resolves it now.
    const placed = typeof finding.path === 'string' || fingerprintPath(finding.fingerprint) !== undefined;
    let scope: ScopeAction;
    if (input.policy === 'all') scope = 'fix';
    else if (locus === 'outside') scope = !blocking ? 'note' : input.policy === 'diff-plus-blocking' || !placed ? 'fix' : 'defer';
    else if (input.pass <= 1) scope = 'fix';
    else scope = blocking ? 'fix' : 'note';
    return { ...finding, locus, kind, blocking, scope, raised_by: raisedBy(finding) };
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
// deferral: one issue per blocking finding in code the PR did not change
// ---------------------------------------------------------------------------
export const DEFERRED_MARKER = 'gstack-deferred-finding';
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

export interface DeferContext { repo?: string; pr?: number; branch?: string; head?: string }

/** Issue title and body for a deferred finding; the marker keeps a rerun from filing it twice. */
export function renderDeferredIssue(f: ScopedFinding, ctx: DeferContext): { title: string; body: string; marker: string } {
  const text = findingText(f);
  const title = `Deferred review finding: ${findingWhere(f)} — ${text}`.slice(0, 120);
  const origin = ctx.pr ? `${ctx.repo ? `${ctx.repo}#${ctx.pr}` : `PR #${ctx.pr}`}` : ctx.branch ? `branch \`${ctx.branch}\`` : 'a /ship run';
  const marker = `<!-- ${DEFERRED_MARKER}: ${oneLine(findingIdentity(f))} -->`;
  const body = [
    `Filed by /ship's pre-landing review of ${origin}${ctx.head ? ` (head ${ctx.head.slice(0, 12)})` : ''}. The finding is in code that PR did not change, so it was deferred here instead of being fixed there (review scope frozen after pass 1).`,
    '',
    `- **Severity:** ${oneLine(f.severity ?? 'unrated')}`,
    `- **Where:** \`${findingWhere(f)}\``,
    `- **Finding:** ${text}`,
    ...(f.fix ? [`- **Suggested fix:** ${oneLine(f.fix)}`] : []),
    ...(f.specialist ? [`- **Found by:** ${oneLine(f.specialist)}`] : []),
    '',
    marker,
    '',
  ].join('\n');
  return { title, body, marker };
}

export interface DeferredRecord { fingerprint: string; path: string; severity: string; summary: string; issue: number | null; url?: string; reason?: string }
/** `defer`'s reason when the marker search found the finding's issue already open; the section renders such a record as a plain `#N`. */
export const ALREADY_FILED_REASON = 'already filed';

/** The PR-body section for deferred findings: references, never closing keywords, so a merge closes nothing. Only `frozen` defers. */
export function renderDeferredSection(deferred: readonly DeferredRecord[], noted: readonly ScopeFinding[] = []): string {
  const out: string[] = [];
  if (deferred.length) {
    out.push('## Deferred findings', '', 'Blocking findings in code this PR did not change (review scope: frozen); filed as issues and not closed by this PR.', '');
    for (const d of deferred) {
      const ref = d.issue ? `#${d.issue}${d.reason && d.reason !== ALREADY_FILED_REASON ? ` (${oneLine(d.reason)})` : ''}` : `unfiled${d.reason ? ` (${oneLine(d.reason)})` : ''}`;
      out.push(`- Deferred: ${ref} — ${oneLine(d.severity)} \`${oneLine(d.path)}\` ${oneLine(d.summary)}`);
    }
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
  /** Reviewer dispatches of this invocation by role (specialist, red-team, adversarial-native, outside-voice, fix-check). */
  dispatches?: Record<string, number>;
  /** Prompt plus diff bytes the dispatches read, / 4: a relative estimate, never a bill. */
  est_input_tokens?: number;
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

export function summarizeReviewLoop(rows: readonly Record<string, any>[], since: string): ReviewLoopSummary {
  const sinceMs = Date.parse(since);
  const inRun = (r: Record<string, any>) => r && r.via === 'ship' && Number.isFinite(rowTime(r)) && (!Number.isFinite(sinceMs) || rowTime(r) >= sinceMs);
  const loopRows = rows.filter(r => inRun(r) && (r.skill === 'review' || r.skill === LATE_DEFER_SKILL || r.skill === FIX_CHECK_SKILL));
  const passes = loopRows.filter(r => r.skill === 'review');
  const blocking = new Set<string>();
  const deferred = new Set<string>();
  const noted = new Set<string>();
  const fixed = new Set<string>();
  let scope: ReviewLoopSummary['scope'] = 'unknown';
  for (const row of loopRows) {
    if (REVIEW_SCOPE_POLICIES.includes(row.review_scope)) scope = row.review_scope;
    for (const f of Array.isArray(row.findings) ? row.findings : []) {
      if (!f || typeof f !== 'object') continue;
      const id = findingIdentity(f);
      if (f.blocking === true) blocking.add(id);
      if (f.action === 'deferred') deferred.add(id);
      if (f.action === 'noted') noted.add(id);
      if (f.action === 'fixed' || f.action === 'auto-fixed') fixed.add(id);
    }
  }
  const out: ReviewLoopSummary = { passes: passes.length, blocking_found: blocking.size, deferred: deferred.size, noted: noted.size, fixed: fixed.size, scope };
  const fixChecks = loopRows.filter(r => r.skill === FIX_CHECK_SKILL).length;
  if (fixChecks) out.fix_checks = fixChecks;
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
    + (s.fix_checks ? ` fix_checks=${s.fix_checks}` : '') + (total !== undefined ? ` dispatches=${total}` : '') + (s.est_input_tokens !== undefined ? ` est_input_tokens=${s.est_input_tokens}` : '');
}
