/**
 * ship-receipt-depth — what the /ship receipt says about how deeply the
 * review read the head, and what the queue checks against it
 * (docs/review-policy.md#review-depth, docs/ship-policy.md#ship-receipt).
 *
 * `review_depth`: the depth the reviewed head needs, recomputed by
 * `gstack-ship-receipt write` (receiptDepthAtHead: the committed range from
 * git objects, gstack-diff-scope on that range and the gate scan of the clean
 * checkout at that head), with the runtime lines, the rules hash, the base and
 * registry commits and the gate scan bound to the head.
 * `review_loop_exception`: the owner's acceptance of a stop after a
 * fix-check edit under frozen scope (#3559), shaped like the docs exception.
 * The queue recomputes the depth the head needs from git objects
 * (lib/review-collect.ts) and refuses a receipt below it.
 * `review_targeted`: the targeted pass on money, gate, auth and secret code
 * (lib/review-targeted.ts); the queue reports it beside the depth and refuses
 * a head whose required classes the pass did not cover (GST-966). Kept beside
 * lib/ship-receipt.ts so that module stays under the size ratchet.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { baseContainsHead } from './default-base';
import type { ShipReceipt } from './headless-artifacts';
import { collectCommit } from './review-collect';
import { EMPTY_LIST_SHA256, recordedList, reviewExclude, type ActiveExclusion, type ExcludeRecord, type Exclusion } from './review-exclude';
import { SHIP_POLICY_PATH, isUnavailable } from './ship-policy';
import { loadPolicyAt } from './ship-policy-at';
import { classifyPath, depthOfCommitInput, gateScanNeeded, platformFits, scanNumbers, type Depth } from './review-depth';
import { AUTH_PATH_PREFIXES, AUTH_PATH_TOKENS, MONEY_PATH_TOKENS, matchRisk, type RiskClass } from './review-risk';
import { platformReviewAt } from './review-platform';
import { reviewPolicy, type ReviewPolicy } from './ship-policy-review';
import { TARGETED_CLASSES, classList, targetedClasses, type TargetedClass } from './review-targeted';
import { runScriptSync } from './script-invocation';
import { parseUnifiedDiff, versionAtRef } from './restamp';
import { branchSides } from './stamp-only';
import { classifyFiles } from './tree-receipt';
import { mergeChangelogs } from './changelog-check';
import { bindReceipt, type ReceiptBindingCode } from './ship-receipt';
import { carriedAudits, docsExceptionLine, parseReceiptDocs, type CarriedAudit } from './ship-receipt-docs';

export type ReceiptDepth = NonNullable<ShipReceipt['review_depth']>;
export type ReviewLoopException = NonNullable<ShipReceipt['review_loop_exception']>;
const RANK: Record<Depth | 'platform', number> = { platform: -1, light: 0, standard: 1, full: 2 };
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const BIN_DIR = path.join(import.meta.dir, '..', 'bin');
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : 'none');

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** A base as a commit; origin/<branch> reads refs/remotes/origin/<branch> by its full name, so a tag named origin/main cannot stand in for it (GST-884). */
const baseCommit = (root: string, ref: string) => git(root, ['rev-parse', '--verify', '--quiet', `${/^origin\//.test(ref) ? `refs/remotes/${ref}` : ref}^{commit}`]);
/** gstack-diff-scope on the committed range `base`...`head` (`--head`): the same signals at write, carry and the queue; `merged` (`--merged`) for a head GitHub already merged into the base. */
function scopeOfRange(root: string, binDir: string, base: string, head: string, merged = false): Record<string, string> {
  const sr = runScriptSync(path.join(binDir, 'gstack-diff-scope'), [base, '--head', head, ...(merged ? ['--merged'] : [])], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const scope: Record<string, string> = {};
  for (const l of (sr.stdout ?? '').split('\n')) { const m = /^(SCOPE_[A-Z_]+)=(.*)$/.exec(l); if (m) scope[m[1]!] = m[2]!; }
  if (sr.status !== 0 && !scope.SCOPE_ERROR) scope.SCOPE_ERROR = `exit ${sr.status}`;
  return scope;
}

export type ReceiptExclude = NonNullable<ShipReceipt['review_exclude']>;

/** The receipt's copy of an active exclusion: counts and hashes, plus the gate-tagged kept paths the queue cannot recompute. */
export function receiptExclude(x: Exclusion): ReceiptExclude | undefined {
  if (x.state !== 'active') return undefined;
  const { source, patterns, applied, excluded, excluded_bytes, kept, gate_tagged, patterns_sha256, list_sha256, digest } = x.record;
  return { source, patterns, applied, excluded, excluded_bytes, kept, gate_tagged, patterns_sha256, list_sha256, digest };
}

/** The exclusion for the committed range `baseSha`...`head` (collectCommit's), with the gate-tagged paths the caller knows. */
function exclusionAt(root: string, ref: string, baseSha: string | null, head: string, c: ReturnType<typeof collectCommit>, gateTagged: ReadonlySet<string> | null, context: string): Exclusion {
  if (!baseSha || !c.mergeBase) return { state: 'none' };
  return reviewExclude({ root, baseSha, ref, mergeBase: c.mergeBase, head, perPath: c.perPath, added: c.added, classRoot: c.root ?? [], gateTagged, context });
}

/** The base policy's review_exclude_paths and review key (lib/ship-policy-review.ts), defaults when it cannot be read. */
function basePolicy(root: string, ref: string, sha: string | null): { declares: boolean; review: ReviewPolicy } {
  const l = sha ? loadPolicyAt(root, sha, ref) : null;
  const p = l && !isUnavailable(l) ? l.policy : null;
  return { declares: !!p && p.review_exclude_paths.length > 0, review: reviewPolicy(p) };
}
const riskPathsOf = (r: ReviewPolicy) => (r.risk_paths.length ? { riskPaths: r.risk_paths } : {});
/** The mode the plan ran for this depth under the base policy's review.panel (lib/review-depth.ts planReview). */
const modeFor = (depth: Depth, r: ReviewPolicy): 'lean' | 'panel' => (r.panel === 'all' || (r.panel === 'risk' && depth !== 'light') ? 'panel' : 'lean');

/**
 * The depth record for `head`: the range from git objects (collectCommit) and
 * its diff-scope, as the queue recomputes them, plus, for a tests or code diff,
 * the gate scan of this checkout. The scan reads the working tree, so it counts
 * only when the checkout is `head` with no tracked edits; otherwise it is
 * unavailable and the depth fails closed to full.
 */
export function receiptDepthAtHead(repoRoot: string, base: string, binDir: string, head: string): ReceiptDepth {
  return receiptReviewAtHead(repoRoot, base, binDir, head).depth;
}

/**
 * receiptDepthAtHead plus the exclusion the head's review read under: the depth classifies excluded paths as docs (GST-508).
 * `declared` (write --declare-risk, GST-1129) joins the detected risk classes and only raises; the record then keeps both lists.
 */
export function receiptReviewAtHead(repoRoot: string, base: string, binDir: string, head: string, declared: readonly RiskClass[] = []): { depth: ReceiptDepth; exclude: Exclusion; tagged: ReadonlySet<string> | null; frontend: boolean } {
  const branch = base.replace(/^origin\//, '');
  const baseSha = baseCommit(repoRoot, `origin/${branch}`);
  const baseRev = baseSha.ok ? baseSha.out : branch;
  const ref = baseSha.ok ? `origin/${branch}` : branch;
  const sha = baseSha.ok ? baseSha.out : (git(repoRoot, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]).out || null);
  const c = collectCommit(repoRoot, baseRev, head);
  const scope = scopeOfRange(repoRoot, binDir, baseRev, head);
  const { declares, review } = basePolicy(repoRoot, ref, sha);
  let tagged: number | null = 0;
  let paths: Set<string> | null = declares ? new Set() : null;
  if (declares || gateScanNeeded(c.paths, c.root)) {
    const atHead = git(repoRoot, ['rev-parse', 'HEAD']).out === head && git(repoRoot, ['diff', '--quiet', 'HEAD', '--']).ok;
    const g = atHead ? runScriptSync(path.join(binDir, 'gstack-gate-diff'), [baseRev, ...(declares ? ['--format', 'jsonl'] : [])], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }) : null;
    const m = /GATE_SUMMARY: .*?tagged=\{([^}]*)\}/.exec(g?.stdout ?? '');
    tagged = g?.status === 0 && m ? m[1]!.split(',').reduce((n, kv) => n + (Number(kv.split(':')[1]) || 0), 0) : null;
    paths = declares && tagged !== null ? taggedPaths(g?.stdout ?? '') : null;
  }
  const exclude = exclusionAt(repoRoot, ref, sha, head, c, paths, 'gstack-ship-receipt');
  const d = depthOfCommitInput({ ...c, scope, gateTagged: tagged, ...riskPathsOf(review), declared, ...(exclude.state === 'active' ? { excluded: exclude.excluded } : {}) });
  return { depth: { depth: d.depth, class: d.class, runtime_lines: d.runtimeLines, rules: d.rules, base: baseRev, registry: c.registry.sha, gate_scan: { tagged, head }, reasons: d.reasons.slice(0, 12), risk: d.risk, mode: modeFor(d.depth, review), ...(d.declared.length ? { declared: d.declared, detected: d.detected } : {}) }, exclude, tagged: paths, frontend: scope.SCOPE_FRONTEND === 'true' };
}

/**
 * `write --platform-review <id>` (design C6, FOUN-63): the receipt says honestly that no /ship reader ran because the platform
 * review read this head. Allowed only under the base policy's review.platform on, on a light docs or tests diff with no numeric,
 * results or prereg claims, with capy-ai[bot]'s review <id> on the PR at this exact head.
 */
export function platformReceiptDepth(repoRoot: string, base: string, depth: ReceiptDepth, head: string, id: string, pr?: string): { ok: true; depth: ReceiptDepth } | { ok: false; message: string } {
  const branch = base.replace(/^origin\//, '');
  const baseSha = baseCommit(repoRoot, `origin/${branch}`);
  const { review } = basePolicy(repoRoot, baseSha.ok ? `origin/${branch}` : branch, baseSha.ok ? baseSha.out : null);
  if (review.platform !== 'on') return { ok: false, message: `--platform-review needs review.platform on in ${branch}'s .gstack/ship-policy.json; with platform review off at least one /ship reader runs` };
  const c = collectCommit(repoRoot, depth.base, head);
  if (depth.depth !== 'light' || !platformFits(depth.class, c.paths, depth.runtime_lines, scanNumbers(c.added))) return { ok: false, message: `head ${head.slice(0, 12)} needs ${depth.depth} review (${depth.class} class, ${depth.runtime_lines} runtime lines): the platform depth covers only docs or tests diffs with no numeric, results or prereg claims` };
  const found = platformReviewAt(repoRoot, head, { pr, id });
  if (!found.ok) return { ok: false, message: `--platform-review ${id}: ${found.reason}` };
  return { ok: true, depth: { ...depth, depth: 'platform', mode: 'platform', platform_review: found.review } };
}

/** The paths of the hunks a `gstack-gate-diff --format jsonl` run tagged. */
export function taggedPaths(jsonl: string): Set<string> {
  return new Set(jsonl.split('\n').slice(1).flatMap(l => { try { const h = JSON.parse(l) as { path?: string; tags?: unknown[] }; return h.path && h.tags?.length ? [h.path] : []; } catch { return []; } }));
}

export const depthBelow = (have: Depth | 'platform', need: Depth | 'platform') => RANK[have] < RANK[need];
export const deeper = <D extends Depth | 'platform'>(a: D, b: D): D => (RANK[a] >= RANK[b] ? a : b);

/**
 * `write --review-loop-exception` input and the queue's check: who accepted the stop, when, where, why, and the stop it accepts:
 * the fix-check it followed (`fix_check`), or the second full pass that left a finding open (`second_pass`, the deferred
 * finding ids; TRUT-7).
 */
export function parseReviewLoopException(value: unknown): { ok: true; exception: ReviewLoopException } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('review_loop_exception must be { accepted_by, date, via, reason, fix_check: { head, findings[, files] } | second_pass: { head, deferred: [<finding id>] } }');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!['accepted_by', 'date', 'via', 'reason', 'fix_check', 'second_pass'].includes(key)) return bad(`review_loop_exception: unknown key ${JSON.stringify(key)}`);
  for (const key of ['accepted_by', 'date', 'via', 'reason']) if (!text(v[key])) return bad(`review_loop_exception.${key} must be a non-empty one-line string`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date as string)) return bad('review_loop_exception.date must be YYYY-MM-DD');
  if ((v.fix_check === undefined) === (v.second_pass === undefined)) return bad('review_loop_exception names exactly one of fix_check or second_pass: the stop it accepts');
  const accepted = { accepted_by: (v.accepted_by as string).trim(), date: v.date as string, via: (v.via as string).trim(), reason: (v.reason as string).trim() };
  if (v.second_pass !== undefined) {
    const s = v.second_pass as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return bad('review_loop_exception.second_pass must be { head, deferred: [<finding id>] }');
    for (const key of Object.keys(s)) if (!['head', 'deferred'].includes(key)) return bad(`review_loop_exception.second_pass: unknown key ${JSON.stringify(key)}`);
    if (!sha(s.head)) return bad('review_loop_exception.second_pass.head must be the full commit the second full pass reviewed');
    if (!Array.isArray(s.deferred) || !s.deferred.length || !s.deferred.every(text)) return bad('review_loop_exception.second_pass.deferred must name the open finding the owner accepted by id');
    return { ok: true, exception: { ...accepted, second_pass: { head: s.head, deferred: (s.deferred as string[]).slice(0, 20).map(d => d.trim()) } } };
  }
  const f = v.fix_check as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return bad('review_loop_exception.fix_check must be { head, findings[, files] }');
  for (const key of Object.keys(f)) if (!['head', 'findings', 'files'].includes(key)) return bad(`review_loop_exception.fix_check: unknown key ${JSON.stringify(key)}`);
  if (!sha(f.head)) return bad('review_loop_exception.fix_check.head must be the full commit the fix-check reviewed');
  if (typeof f.findings !== 'number' || !Number.isInteger(f.findings) || f.findings < 0) return bad('review_loop_exception.fix_check.findings must be an integer >= 0 (what the fix-check reported)');
  if (f.files !== undefined && (!Array.isArray(f.files) || !f.files.every(text))) return bad('review_loop_exception.fix_check.files must be a list of paths');
  const files = (f.files as string[] | undefined)?.slice(0, 50);
  return { ok: true, exception: { ...accepted, fix_check: { head: f.head, findings: f.findings, ...(files?.length ? { files } : {}) } } };
}

/** The commit the accepted stop reviewed: the fix-check's head or the second full pass's. */
export const exceptionHead = (e: ReviewLoopException) => (e.fix_check ?? e.second_pass)!.head;

/** Whether the review loop shows the stop the exception accepts: a fix-check ran, or two full passes left a finding deferred. */
export function exceptionLoopProblem(e: ReviewLoopException, loop: ShipReceipt['review_loop']): string | null {
  if (e.fix_check) return loop?.fix_checks ? null : 'needs --review-loop with fix_checks >= 1: the stop it accepts follows a fix-check';
  return (loop?.passes ?? 0) >= 2 && (loop?.deferred ?? 0) >= 1 ? null : 'second_pass needs --review-loop with passes >= 2 and deferred >= 1: the stop it accepts follows the second full pass with a finding left open';
}

/** The line the PR body must carry, word for word, while the exception stands. */
export function reviewLoopExceptionLine(e: ReviewLoopException): string {
  const stop = e.fix_check ? `fix-check at ${e.fix_check.head.slice(0, 12)}, ${e.fix_check.findings} finding${e.fix_check.findings === 1 ? '' : 's'}` : `second full pass at ${e.second_pass!.head.slice(0, 12)}, deferred ${e.second_pass!.deferred.join(', ')}`;
  return `Review-loop exception: accepted by ${e.accepted_by} ${e.date} via ${e.via}: ${e.reason} (${stop})`;
}

const carries = (body: string, line: string) => body.split(/\r?\n/).some(l => l.trim() === line);

/**
 * The owner exceptions a receipt records, checked the same way: valid shape, and the body carries each line verbatim.
 * `isAncestor`, when given, also requires the review-loop exception's fix-check head to be the receipt head or its ancestor.
 */
export function exceptionProblems(body: string, r: ShipReceipt, isAncestor?: (commit: string) => boolean): string[] {
  const out: string[] = [];
  const raw = r as ShipReceipt & { docs?: unknown };
  if (raw.docs !== undefined) {
    const d = parseReceiptDocs(raw.docs);
    if (!d.ok) out.push(`docs: ${d.message}`);
    else { const line = docsExceptionLine(d.docs); if (line && !carries(body, line)) out.push(`the body does not carry the documentation exception line verbatim: ${JSON.stringify(line)}`); }
  }
  if (r.review_loop_exception !== undefined) {
    const e = parseReviewLoopException(r.review_loop_exception);
    if (!e.ok) out.push(e.message);
    else {
      const loopProblem = exceptionLoopProblem(e.exception, r.review_loop);
      if (loopProblem) out.push(`review_loop_exception ${loopProblem.replace('--review-loop', 'review_loop')}`);
      if (isAncestor && !isAncestor(exceptionHead(e.exception))) out.push(`review_loop_exception's head ${exceptionHead(e.exception).slice(0, 12)} is not the receipt head or an ancestor of it`);
      const line = reviewLoopExceptionLine(e.exception);
      if (!carries(body, line)) out.push(`the body does not carry the review-loop exception line verbatim: ${JSON.stringify(line)}`);
    }
  }
  return out;
}

export type ReviewTargeted = NonNullable<ShipReceipt['review_targeted']>;

/**
 * `write --review-targeted` input (gstack-review-dispatch verify --targeted-out), bound to the receipt's product patch-id here.
 * `head` is the commit the reader read; `productPatchOf` gives that commit's product patch-id by the receipt's own rules. The
 * record binds only on an equal product patch, or with `plainDocs` across a change after the read that is plain docs
 * (plainDocsSince, GST-1195), and with `classesSince` also only when nothing changed after the read carries a targeted class (a
 * test change the gate scan tags is gate class though the product patch leaves tests out), so a record never vouches for work it
 * did not read (GST-986). `ancestor` only words the refusal: a read commit that is not HEAD's ancestor is named as such (GST-1700).
 */
export function parseReviewTargeted(value: unknown, productPatchId: string, productPatchOf: (head: string) => string | undefined, classesSince?: (read: string) => readonly TargetedClass[] | null, plainDocs?: (read: string) => boolean, ancestor?: (read: string) => boolean): { ok: true; targeted: ReviewTargeted } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('review_targeted must be { classes, rules, brief_sha, status, findings, raised_by, head }');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!['classes', 'rules', 'brief_sha', 'status', 'findings', 'raised_by', 'head'].includes(key)) return bad(`review_targeted: unknown key ${JSON.stringify(key)}${key === 'product_patch_id' ? ' (write binds the pass to the receipt\'s product_patch_id)' : ''}`);
  if (!Array.isArray(v.classes) || !v.classes.every(c => (TARGETED_CLASSES as readonly unknown[]).includes(c))) return bad(`review_targeted.classes must list ${TARGETED_CLASSES.join(', ')}`);
  if (!text(v.rules) || !text(v.raised_by)) return bad('review_targeted.rules and raised_by must be non-empty one-line strings');
  if (typeof v.brief_sha !== 'string' || !/^[0-9a-f]{64}$/.test(v.brief_sha)) return bad('review_targeted.brief_sha must be the sha256 of review/specialists/targeted.md');
  if (!['done', 'failed', 'not-run'].includes(v.status as string)) return bad('review_targeted.status must be done, failed or not-run');
  if (typeof v.findings !== 'number' || !Number.isInteger(v.findings) || v.findings < 0) return bad('review_targeted.findings must be an integer >= 0');
  if (typeof v.head !== 'string' || !/^[0-9a-f]{40,64}$/.test(v.head)) return bad('review_targeted.head must be the commit the targeted reader read (rerun gstack-review-dispatch verify --targeted-out with this gstack)');
  const read = productPatchOf(v.head);
  if ((read !== productPatchId && !plainDocs?.(v.head)) || (classesSince && classesSince(v.head)?.length !== 0)) return bad(ancestor && !ancestor(v.head) ? `the targeted reader read ${v.head.slice(0, 12)}, which is not an ancestor of HEAD (usually after a rebase or a redone merge resolution, which rewrites the commit the reader read): a targeted record carries only from HEAD or an ancestor of it${read === productPatchId ? ', even when the product patch is unchanged' : ''}, so run the targeted reader on HEAD, rerun gstack-review-dispatch verify --targeted-out and write again` : `the targeted reader read ${v.head.slice(0, 12)}, whose product patch ${read?.slice(0, 12) ?? 'cannot be read'} is not this receipt's ${productPatchId.slice(0, 12)}: the product changed after the read (only release stamps and a docs change with no numeric, results, prereg, eval, money or security claim carry the record), so run the targeted reader on HEAD and verify again`);
  const classes = TARGETED_CLASSES.filter(c => (v.classes as string[]).includes(c));
  return { ok: true, targeted: { classes, rules: v.rules as string, brief_sha: v.brief_sha, product_patch_id: productPatchId, status: v.status as ReviewTargeted['status'], findings: v.findings, raised_by: (v.raised_by as string).trim() } };
}

export interface DepthVerdict { ok: boolean; line: string; message?: string }

/**
 * The classes the head needs against the classes a done targeted pass covered; a required class left uncovered (no pass,
 * a failed or unrun pass, or a pass on other classes) is refused (GST-966). A receipt with neither gstack_version nor
 * review_depth predates targeted receipts, as receiptDepthVerdict treats it, and is accepted as legacy.
 */
export function receiptTargetedVerdict(required: readonly TargetedClass[], r: ShipReceipt): DepthVerdict {
  const rt = r.review_targeted;
  const covered: readonly string[] = rt?.status === 'done' ? rt.classes : [];
  const missing = required.filter(c => !covered.includes(c));
  const verdict = !missing.length ? 'ok' : rt?.status === 'failed' ? 'failed' : 'missing';
  const line = `REVIEW_TARGETED: required=${classList(required)} receipt=${rt ? classList(covered) : 'legacy'} verdict=${verdict}`;
  if (!missing.length) return { ok: true, line };
  if (!rt && !r.review_depth && !r.gstack_version) return { ok: true, line: `${line} (legacy receipt, written before receipts recorded review_targeted; accepted)` };
  const why = !rt ? 'records no targeted pass' : rt.status === 'failed' ? 'records that its targeted pass failed' : rt.status === 'not-run' ? 'records that its targeted pass did not run' : `covers ${classList(covered)} only`;
  return { ok: false, line, message: `the head requires the targeted reader on ${missing.join(', ')}, but the receipt ${why}` };
}

/** The head's committed range against the base, read once for the depth verdict and the targeted line. */
interface HeadInputs { baseSha: { ok: boolean; out: string }; c: ReturnType<typeof collectCommit>; scope: Record<string, string>; x: Exclusion }
function headInputs(root: string, baseRef: string, head: string, r?: ShipReceipt, merged = false): HeadInputs {
  const baseSha = baseCommit(root, baseRef);
  const baseRev = baseSha.ok ? baseSha.out : baseRef;
  const c = collectCommit(root, baseRev, head);
  const tagged = r && boundScan(r, head) !== null ? new Set(r.review_exclude?.gate_tagged ?? []) : null;
  return { baseSha, c, scope: scopeOfRange(root, BIN_DIR, baseRev, head, merged), x: exclusionAt(root, baseRef, baseSha.ok ? baseSha.out : null, head, c, tagged, 'gstack-ship-queue') };
}

/** The targeted classes of the head's range under the exclusion its review read: excluded paths name no class, as gstack-review-plan reads them (GST-1900). */
const targetedAt = (at: HeadInputs, gateTagged: number | null) => targetedClasses({ ...at.c, scope: at.scope, gateTagged, ...(at.x.state === 'active' ? { excluded: at.x.excluded } : {}) });

/** The selection's list hash over the PR's files; the empty list's when the base declares no pattern or none matches (GST-1408). */
const listOf = (x: Exclusion) => (x.state === 'active' ? x.record.list_sha256 : EMPTY_LIST_SHA256);
type RecordedExclude = Partial<Pick<ExcludeRecord, 'patterns_sha256' | 'list_sha256' | 'digest'>>;
/**
 * Write's, carry's and the queue's exclusion check: the recorded digest against the one HEAD has under the current base policy,
 * except that a policy change alone does not void the receipt (GST-1408, GST-1415, GST-1434, GST-1446): when the recorded
 * selection (none recorded reads as the empty one) and HEAD's give the PR's files the same applied patterns, excluded files and
 * kept files with their reasons, each reviewer read the diff HEAD's policy gives. A policy that cannot be read, or a record
 * whose digest is not built from its list hash, never binds.
 */
export function carryExcludeBinds(x: Exclusion, r: { review_exclude?: RecordedExclude }): boolean {
  if (x.state === 'refused') return false;
  const e = r.review_exclude;
  return (x.state === 'active' ? x.record.digest : 'none') === (e?.digest ?? 'none') || listOf(x) === (e ? recordedList(e) : EMPTY_LIST_SHA256);
}
/** The base write reads its policy from: origin/<branch> when it resolves, else the local branch. */
function writeBase(root: string, base: string): { ref: string; sha: string | null } {
  const branch = base.replace(/^origin\//, '');
  const baseSha = baseCommit(root, `origin/${branch}`);
  return baseSha.ok ? { ref: `origin/${branch}`, sha: baseSha.out } : { ref: branch, sha: git(root, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]).out || null };
}
/**
 * The record a reviewed --review-exclude digest stands for, for carryExcludeBinds: none for `none`; with HEAD's list hash when
 * the review_exclude_paths the base held at a commit that changed the policy file builds the digest from it (the reviewers read
 * HEAD's selection under an earlier policy); otherwise the digest alone, which binds only an equal one.
 */
function reviewedRecord(root: string, base: string, x: Exclusion, given: string): RecordedExclude | undefined {
  if (given === 'none') return undefined;
  const { ref, sha } = writeBase(root, base);
  const log = sha ? git(root, ['log', '--full-history', '--format=%H', sha, '--', SHIP_POLICY_PATH]) : { ok: false, out: '' };
  for (const commit of log.ok ? log.out.split('\n').filter(Boolean) : []) {
    const load = loadPolicyAt(root, commit, ref);
    if (isUnavailable(load) || load.errors.length || !load.policy.review_exclude_paths.length) continue;
    const record = { patterns_sha256: createHash('sha256').update(JSON.stringify(load.policy.review_exclude_paths)).digest('hex'), list_sha256: listOf(x), digest: given };
    if (recordedList(record)) return record;
  }
  return { digest: given };
}
/** How an exclusion treats one path: excluded, the reason it is kept, or absent from the selection. */
const treatment = (x: ActiveExclusion, p: string) => (x.excluded.has(p) ? 'excluded' : x.kept.find(k => k.path === p)?.reason ?? 'absent');
/**
 * Write's exclusion check: the --review-exclude digest the reviewers read against HEAD's. /ship's Step 14.5 docs audit runs after
 * the review, so a docs file it adds, edits or removes under a pattern can change HEAD's selection (GST-1429). With `docsPost`
 * (the audit's post snapshot, gstack-docs-candidate) the reviewed digest still binds when every file under a pattern that changed
 * since the snapshot's HEAD was uncommitted in the snapshot with the content HEAD holds, the reviewed digest is HEAD's selection
 * with the audit's files reset to their content before the audit, each of them is excluded or kept only because code names it,
 * and every other file is selected alike on both sides. The audit's files are those whose content differs between `docsPre`
 * (the Prepare snapshot) and the post snapshot, reset to the Prepare content, so uncommitted docs the reviewers read stay; without
 * it every such file is an audit file, reset to the snapshot's HEAD. A post snapshot that carries this /ship run's earlier audits
 * (`earlier`, all of its run_id; GST-1616) also resets each file one of them edited that changed since its HEAD or that this audit edited again, to its content
 * before the first of them, when HEAD (or the latest audit's Prepare snapshot, for a file it edited again) holds what the last of
 * them left. When the whole carried list does not rebuild the reviewed selection, write retries without the oldest carried audits,
 * one at a time down to none (a review that ran between two audits already read the earlier one's edits); only that digest
 * mismatch retries, so an integrity refusal (an edit after an audit, a file changed between audits, a foreign HEAD) ends it, and
 * the refusal names the whole list's reason. Content compares as git stores it or as it checks out (autocrlf, filters). Anything else, an unreadable
 * snapshot included, refuses with `why`.
 */
export function writeExcludeBinds(root: string, base: string, head: string, review: { exclude: Exclusion; tagged: ReadonlySet<string> | null }, flagged: string | undefined, docsPost: string | undefined, docsPre?: string): { ok: true; line?: string } | { ok: false; why?: string } {
  const x = review.exclude;
  const given = flagged ?? 'none';
  const now = x.state === 'active' ? x.record.digest : 'none';
  if (now === given) return { ok: true };
  if (flagged !== undefined && carryExcludeBinds(x, { review_exclude: reviewedRecord(root, base, x, given) })) return { ok: true, line: `REVIEW_EXCLUDE_POLICY_MOVED: reviewed=${short(given)} head=${short(now)} (the base policy changed since the review and gives the PR's files the same selection; the receipt records HEAD's)` };
  if (docsPost === undefined || x.state !== 'active') return { ok: false };
  const no = (why: string) => ({ ok: false as const, why: `--docs-post ${docsPost}: ${why}` });
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.every(p => typeof p === 'string');
  const snapshot = (file: string): { head: string; audit_id?: unknown; run_id?: unknown; earlier?: unknown; staged: string[]; unstaged: string[]; untracked: string[]; hashes: Record<string, unknown> } | string => {
    let s: { head?: unknown; audit_id?: unknown; run_id?: unknown; earlier?: unknown; staged?: unknown; unstaged?: unknown; untracked?: unknown; hashes?: unknown };
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return `cannot be read (${(e as Error).message.split('\n')[0]})`; }
    const h = s?.hashes;
    if (typeof s?.head !== 'string' || !/^[0-9a-f]{40,64}$/.test(s.head) || !list(s.staged) || !list(s.unstaged) || !list(s.untracked) || !h || typeof h !== 'object' || Array.isArray(h)) return 'is not a gstack-docs-candidate snapshot (head, staged, unstaged, untracked, hashes)';
    return { head: s.head, audit_id: s.audit_id, run_id: s.run_id, earlier: s.earlier, staged: s.staged, unstaged: s.unstaged, untracked: s.untracked, hashes: h as Record<string, unknown> };
  };
  const post = snapshot(docsPost);
  if (typeof post === 'string') return no(post);
  const pre = docsPre === undefined ? null : snapshot(docsPre);
  if (typeof pre === 'string') return no(`--docs-pre ${docsPre} ${pre}`);
  if (pre && (pre.head !== post.head || pre.audit_id !== post.audit_id || pre.run_id !== post.run_id)) return no(`--docs-pre ${docsPre} is not this audit's Prepare snapshot (its HEAD, audit_id or run_id differs)`);
  const earlier = carriedAudits(post);
  if (typeof earlier === 'string') return no(earlier);
  if (earlier.length && !pre) return no(`it carries audit ${earlier.map(e => e.audit_id).join(',')}, so write needs --docs-pre <its Prepare snapshot>`);
  const at = post.head;
  if (!git(root, ['merge-base', '--is-ancestor', at, head]).ok) return no(`its HEAD ${short(at)} is not ${short(head)} or an ancestor of it`);
  const since = (rev: string) => { const d = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', rev, head, '--', ...x.record.patterns.map(p => `:(top,glob)${p}`)], { cwd: root, encoding: 'utf8', timeout: 60_000 }); return d.status === 0 ? d.stdout.split('\0').filter(Boolean).sort() : null; };
  const changed = since(at);
  if (!changed) return no(`git could not list the files under review_exclude_paths that changed since ${short(at)}`);
  if (!changed.length) return no(`no file under review_exclude_paths changed since its HEAD ${short(at)}, so the docs audit did not change the selection`);
  const blob = (rev: string, p: string) => { const b = git(root, ['rev-parse', '--verify', '--quiet', `${rev}:${p}`]); return b.ok ? b.out : null; };
  const holds = (rev: string, p: string, want: unknown) => {
    const id = blob(rev, p);
    if (id === want) return true;
    if (id === null || typeof want !== 'string') return false;
    const out = spawnSync('git', ['cat-file', '--filters', `${rev}:${p}`], { cwd: root, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    return out.status === 0 && createHash('sha1').update(`blob ${out.stdout.length}\0`).update(out.stdout).digest('hex') === want;
  };
  const named = new Set([...post.staged, ...post.unstaged, ...post.untracked]);
  for (const p of changed) {
    if (!named.has(p)) return no(`${p} changed after the snapshot's HEAD ${short(at)}, and the snapshot does not name it as an uncommitted audit file`);
    if (!holds(head, p, post.hashes[p] ?? null)) return no(`${p} at HEAD is not the content the snapshot recorded (an edit after the audit)`);
  }
  const auditFiles = pre ? changed.filter(p => !(p in pre.hashes) || pre.hashes[p] !== post.hashes[p]) : changed;
  const bindAudits = (carried: CarriedAudit[]): { ok: true; line: string } | { ok: false; why: string; retry?: true } => {
    const resets = new Map<string, { rev: string; want: unknown; from: string }>(auditFiles.map(p => [p, { rev: at, want: pre ? pre.hashes[p] : undefined, from: `--docs-pre ${docsPre}` }]));
    const left = new Map<string, { after: string | null; audit: string }>();
    for (const e of carried) {
      const moved = git(root, ['merge-base', '--is-ancestor', e.head, at]).ok ? since(e.head) : null;
      if (!moved) return no(`carried audit ${e.audit_id}'s HEAD ${short(e.head)} is not an ancestor of ${short(at)}, or git could not diff it`);
      for (const [p, { before, after }] of Object.entries(e.edited)) {
        if (!moved.includes(p) && !auditFiles.includes(p)) continue;
        const prior = left.get(p);
        if (prior && prior.after !== before) return no(`${p} changed between audit ${prior.audit} and audit ${e.audit_id}, outside both`);
        if (!prior) resets.set(p, { rev: e.head, want: before, from: `audit ${e.audit_id}'s post snapshot` });
        left.set(p, { after, audit: e.audit_id });
      }
    }
    for (const [p, { after, audit }] of left) {
      const kept = auditFiles.includes(p) ? (p in pre!.hashes ? pre!.hashes[p] === after : holds(at, p, after)) : holds(head, p, after);
      if (!kept) return no(`${p} at ${auditFiles.includes(p) ? `this audit's Prepare snapshot` : 'HEAD'} is not the content audit ${audit} recorded (an edit after that audit)`);
    }
    const files = [...resets.keys()].sort();
    if (!files.length) return no(`--docs-pre ${docsPre}: the audit changed none of ${changed.join(',')}, so it did not change the selection`);
    const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).out;
    const index = path.join(gitDir, `gstack-receipt-${process.pid}-${randomBytes(4).toString('hex')}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'gstack-ship-receipt', GIT_AUTHOR_EMAIL: 'ship-receipt@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-receipt', GIT_COMMITTER_EMAIL: 'ship-receipt@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
    const run = (args: string[], input?: string) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, input, timeout: 60_000 }); return { ok: r.status === 0, out: (r.stdout ?? '').trim() }; };
    const treeEntry = (rev: string, p: string) => run(['ls-tree', '-z', '--full-tree', rev, '--', p]).out.split('\0').find(l => l.endsWith(`\t${p}`));
    let reset: string;
    try {
      const entries: string[] = [];
      for (const [p, { rev, want, from }] of resets) {
        const atEntry = treeEntry(rev, p);
        if (want === undefined || (atEntry && holds(rev, p, want))) entries.push(atEntry ? `${atEntry}\0` : `0 ${'0'.repeat(rev.length)}\t${p}\0`);
        else if (want === null) entries.push(`0 ${'0'.repeat(rev.length)}\t${p}\0`);
        else if (typeof want === 'string' && run(['cat-file', '-e', `${want}^{blob}`]).ok) entries.push(`${(treeEntry(head, p) ?? atEntry ?? '100644').split(' ')[0]} blob ${want}\t${p}\0`);
        else return no(`${p}'s content before the audit (${short(String(want))} in ${from}) is not in git's object store, so the selection the reviewers read cannot be rebuilt`);
      }
      const tree = run(['read-tree', head]).ok && run(['update-index', '-z', '--index-info'], entries.join('')).ok ? run(['write-tree']) : { ok: false, out: '' };
      const c = tree.ok ? run(['commit-tree', '--no-gpg-sign', tree.out, '-p', head, '-m', 'gstack-ship-receipt: HEAD before the docs audit']) : tree;
      if (!c.ok) return no(`git could not build HEAD with ${files.join(',')} reset to before the audit`);
      reset = c.out;
    } finally { fs.rmSync(index, { force: true }); }
    const { ref, sha } = writeBase(root, base);
    const before = exclusionAt(root, ref, sha, reset, collectCommit(root, sha ?? ref, reset), review.tagged, 'gstack-ship-receipt');
    if (before.state !== 'active') return no(`the selection with ${files.join(',')} reset to before the audit cannot be read`);
    if (before.record.digest !== given) return { retry: true, ...no(`the reviewed digest ${short(given)} is not the selection HEAD has with the files under review_exclude_paths that changed since the snapshot reset to ${pre ? 'their --docs-pre content' : short(at)}${left.size ? ` and the files audit ${carried.map(e => e.audit_id).join(',')} edited reset to before that audit` : ''} (${short(before.record.digest)}), so more than the docs audit changed what the reviewers read`) };
    for (const p of files) for (const [side, s] of [['the review', before], ['HEAD', x]] as const) {
      const t = treatment(s, p);
      if (!['absent', 'excluded', 'named-by-code'].includes(t)) return no(`${p} is ${t} at ${side}: the docs audit binds only docs the exclusion hides or keeps because code names them`);
    }
    const audit = new Set(files);
    for (const p of new Set([...before.excluded, ...x.excluded, ...before.kept.map(k => k.path), ...x.kept.map(k => k.path)])) {
      if (!audit.has(p) && treatment(before, p) !== treatment(x, p)) return no(`${p} is ${treatment(before, p)} at the review and ${treatment(x, p)} at HEAD`);
    }
    return { ok: true, line: `REVIEW_EXCLUDE_DOCS_AUDIT: reviewed=${short(given)} head=${short(x.record.digest)} snapshot=${short(at)} files=${files.join(',')}${carried.length ? ` audits=${[...carried.map(e => e.audit_id), post.audit_id].join(',')}` : ''} (the selection changed only by this /ship run's Step 14.5 docs audits' files under review_exclude_paths; the receipt records HEAD's)` };
  };
  let first: { ok: false; why: string } | undefined;
  for (let k = 0; k <= earlier.length; k++) {
    const r = bindAudits(earlier.slice(k));
    if (r.ok) return r;
    first ??= r;
    if (!r.retry) return first;
  }
  return first!;
}
/** The queue's refusal when carryExcludeBinds does not bind the receipt at `head`; null when it does. */
export function excludeMismatch(x: Exclusion, r: ShipReceipt, head: string, base: string): string | null {
  if (carryExcludeBinds(x, r)) return null;
  const expected = x.state === 'active' ? x.record.digest : 'none';
  const recorded = r.review_exclude?.digest ?? 'none';
  const source = x.state === 'active' ? x.record.source : r.review_exclude?.source ?? base;
  const h = head.slice(0, 12);
  return `field=review_exclude expected=${expected} recorded=${recorded} source=${source}: the receipt records another selection than ${base}'s review_exclude_paths gives ${h}, and the two give the PR's files different selections; the receipt is unchanged; fix: rerun /ship's review on ${h} (gstack-review-dispatch pass --base ${base.replace(/^(refs\/remotes\/)?origin\//, '')}), then gstack-ship-receipt write --pr <n> --review-exclude <d> --body <body> with the digest gstack-review-dispatch verify --ledger <ledger> prints on REVIEW_EXCLUDE_RECORD: (write checks the digest against the base policy and does not read the review ledger, so only the rerun shows the reviewers read this selection)`;
}
/** The receipt's recorded gate scan when it names this head; otherwise null (unavailable). */
const boundScan = (r: ShipReceipt, head: string): number | null => {
  const g = r.review_depth?.gate_scan;
  return g && g.tagged !== null && /^[0-9a-f]{40,64}$/.test(g.head) && g.head === head.toLowerCase() ? g.tagged : null;
};

/**
 * The depth the bound head needs against `baseRef`, recomputed from git
 * objects; the recorded gate scan counts only when it names the receipt's
 * head, otherwise the scan is unavailable and the head needs full. A receipt
 * with no review_depth and no gstack_version predates depth receipts and is
 * accepted as legacy; one from a writer that records depth but lacks it is not.
 */
export function receiptDepthVerdict(root: string, baseRef: string, r: ShipReceipt, head: string, at?: HeadInputs): DepthVerdict {
  const rd = r.review_depth;
  if (!rd && !r.gstack_version) return { ok: true, line: 'REVIEW_DEPTH: legacy receipt (written before receipts recorded review_depth); accepted' };
  const { baseSha, c, scope, x } = at ?? headInputs(root, baseRef, head, r);
  const tagged = boundScan(r, head);
  const scanBound = tagged !== null;
  const { review } = basePolicy(root, baseRef, baseSha.ok ? baseSha.out : null);
  const need = depthOfCommitInput({ ...c, scope, gateTagged: tagged, ...riskPathsOf(review), ...(x.state === 'active' ? { excluded: x.excluded } : {}) });
  const have = rd?.depth;
  const inputs = `base@${short(baseSha.ok ? baseSha.out : null)},registry@${short(c.registry.sha)},gate_scan@${scanBound ? short(rd!.gate_scan.head) : 'missing'}`;
  const line = `REVIEW_DEPTH: receipt=${have ?? 'none'} required=${need.depth} runtime_lines=${need.runtimeLines} class=${need.class} reasons=${need.reasons.join(',')} inputs=${inputs} rounds=${r.review_loop?.rounds ?? (r.review_loop ? r.review_loop.passes + (r.review_loop.fix_checks ?? 0) : 'none')}`;
  if (have === 'platform') {
    const pr = rd!.platform_review;
    const fits = need.depth === 'light' && platformFits(need.class, c.paths, need.runtimeLines, scanNumbers(c.added));
    const ok = review.platform === 'on' && fits && !!pr && pr.head === head.toLowerCase();
    if (ok) return { ok: true, line: `${line} platform_review=${pr!.id}@${pr!.head.slice(0, 12)}` };
    return { ok: false, line, message: `the receipt records the platform depth, but ${review.platform !== 'on' ? `the base policy has review.platform ${review.platform}` : !fits ? `head ${head.slice(0, 12)} needs ${need.depth} review of a diff the platform depth does not cover` : `its platform review is not at head ${head.slice(0, 12)}`}; the receipt is unchanged; run /ship on ${head.slice(0, 12)}` };
  }
  if (have && !depthBelow(have, need.depth)) return { ok: true, line };
  const why = have ? `was reviewed at ${have} depth` : 'records no review_depth though its writer records one';
  const errs = need.errors.map(e => `${e.code} (${e.input})`).join('; ');
  return { ok: false, line, message: `the receipt ${why}, but head ${head.slice(0, 12)} needs ${need.depth} (${need.reasons.join(', ')}${errs ? `; ${errs}` : ''}); the receipt is unchanged; run /ship on ${head.slice(0, 12)}` };
}

/** bindReceipt plus the owner exceptions, the review depth and the targeted pass: what READY, train build and land accept. A base that already contains the head refuses (BASE_CONTAINS_HEAD, GST-774) before any depth is computed, except for a PR GitHub already merged (`merged`: land resuming after a merge-only true merge), whose depth then reads the range with diff-scope's `--merged` and whose exclusion digest is not recomputed over that emptied range. */
export function bindShippedReceipt(root: string, baseRef: string, body: string, pr: string | undefined, accepted: readonly string[], merged = false):
  | { ok: true; receipt: ShipReceipt; head: string; line: string; depthLine: string; targetedLine: string }
  | { ok: false; code: ReceiptBindingCode | 'BASE_CONTAINS_HEAD' | 'QUEUE_RECEIPT_DEPTH_RAISED' | 'QUEUE_RECEIPT_EXCEPTION_INVALID' | 'RECEIPT_INVALID' | 'QUEUE_RECEIPT_TARGETED_MISSING' | Extract<Exclusion, { state: 'refused' }>['code']; message: string; line: string; depthLine?: string; targetedLine?: string } {
  const b = bindReceipt(body, pr, accepted);
  if (!b.ok) return b;
  const self = merged ? null : baseContainsHead(root, baseRef, b.head);
  if (self) return { ok: false, code: 'BASE_CONTAINS_HEAD', message: self, line: b.line };
  const based = merged ? b : bindReceipt(body, pr, accepted, { base: baseRef });
  if (!based.ok) return based;
  const ancestor = (commit: string) => b.receipt.carry?.ancestry === 'rewritten' || git(root, ['merge-base', '--is-ancestor', commit, b.head]).ok;
  const problems = exceptionProblems(body, b.receipt, ancestor);
  if (problems.length) return { ok: false, code: 'QUEUE_RECEIPT_EXCEPTION_INVALID', message: `the receipt's owner exception does not stand: ${problems.join('; ')}`, line: b.line };
  const at = headInputs(root, baseRef, b.head, b.receipt, merged);
  if (at.x.state === 'refused') return { ok: false, code: at.x.code, message: at.x.lines.join('; '), line: b.line };
  const mismatch = merged ? null : excludeMismatch(at.x, b.receipt, b.head, baseRef);
  if (mismatch) return { ok: false, code: 'RECEIPT_INVALID', message: mismatch, line: b.line };
  const d = receiptDepthVerdict(root, baseRef, b.receipt, b.head, at);
  const gateTagged = boundScan(b.receipt, b.head) ?? (gateScanNeeded(at.c.paths, at.c.root) ? null : 0);
  const t = receiptTargetedVerdict(targetedAt(at, gateTagged).classes, b.receipt);
  if (!d.ok) return { ok: false, code: 'QUEUE_RECEIPT_DEPTH_RAISED', message: d.message!, line: b.line, depthLine: d.line, targetedLine: t.line };
  if (!t.ok) return { ok: false, code: 'QUEUE_RECEIPT_TARGETED_MISSING', message: `${t.message}; the receipt is unchanged; run /ship on ${b.head.slice(0, 12)}`, line: b.line, depthLine: d.line, targetedLine: t.line };
  return { ...b, depthLine: d.line, targetedLine: t.line };
}

/**
 * A commit on `from` that holds what the PR's own change did after `from`: every path whose part of the PR's diff against its
 * merge base with origin/<base> (the local <base> when origin's does not resolve, as write reads it; product_patch_id's
 * basis, with tests and metadata kept) differs between `from` and `head`, at
 * `head`'s content. A main merge moves the merge base with the files it brings, so a file only main changed keeps `from`'s
 * content (GST-1593); a branch edit, or a merge resolution that changes the PR's own hunks, moves the path: a path whose base
 * content main also changed moves unless replaying main's change onto `from`'s content (git merge-file) gives `head`'s exactly,
 * so a hunk relocated to an identical context counts. With no resolvable merge base every path that changed from `from` to
 * `head` moves, and so does a path whose mode at `head` is not the replayed one. The commit carries the messages of every
 * commit since `from` that origin/<base> does not hold, side-branch merges included (a CI skip marker is gate class). A path in
 * `keep` keeps `from`'s content. Null when git cannot build it.
 */
export function ownChangeSince(root: string, base: string, from: string, head: string, keep: readonly string[] = []): string | null {
  const run = (args: string[], env?: NodeJS.ProcessEnv, input?: string) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, input, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const raw = (a: string, b: string) => {
    const out = run(['diff', '--raw', '-z', '--no-renames', '--full-index', a, b]);
    if (out === null) return null;
    const t = out.split('\0');
    const entries = new Map<string, string>();
    for (let i = 0; i + 1 < t.length; i += 2) entries.set(t[i + 1]!, t[i]!);
    return entries;
  };
  const blob = (sha: string) => {
    const r = spawnSync('git', ['cat-file', 'blob', sha], { cwd: root, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok) return null;
  const tmp = path.join(gitDir.out, `gstack-since-${process.pid}-${randomBytes(4).toString('hex')}`);
  const index = `${tmp}.index`;
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'gstack-ship-receipt', GIT_AUTHOR_EMAIL: 'ship-receipt@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-receipt', GIT_COMMITTER_EMAIL: 'ship-receipt@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const baseAt = writeBase(root, base).sha;
  const baseSha = baseAt ? { ok: true, out: baseAt } : { ok: false, out: '' };
  const mbFrom = baseSha.ok ? git(root, ['merge-base', baseSha.out, from]) : baseSha;
  const mbHead = baseSha.ok ? git(root, ['merge-base', baseSha.out, head]) : baseSha;
  try {
    let moved: string[];
    if (mbFrom.ok && mbHead.ok) {
      const was = raw(mbFrom.out, from), now = raw(mbHead.out, head);
      if (!was || !now) return null;
      moved = [...new Set([...was.keys(), ...now.keys()])].filter(p => {
        const w = was.get(p), n = now.get(p);
        if (w === n) return false;
        const [wOld, wMode, wBase, wNew] = w?.split(' ') ?? [], [nOld, nMode, nBase, nNew] = n?.split(' ') ?? [];
        const shas = [wNew, wBase, nBase, nNew];
        if (wBase === nBase || nMode !== (wOld === `:${wMode}` ? nOld?.slice(1) : wMode) || shas.some(s => !s || /^0+$/.test(s))) return true;
        const blobs = shas.map(s => blob(s!));
        if (blobs.some(b => !b)) return true;
        const files = blobs.slice(0, 3).map((b, i) => { fs.writeFileSync(`${tmp}.${i}`, b!); return `${tmp}.${i}`; });
        const merged = spawnSync('git', ['merge-file', '-p', '-q', ...files], { cwd: root, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
        return merged.status !== 0 || !merged.stdout.equals(blobs[3]!);
      });
    } else {
      const all = raw(from, head);
      if (!all) return null;
      moved = [...all.keys()];
    }
    moved = moved.filter(p => !keep.includes(p));
    const listed = moved.length ? run(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', head, '--', ...moved]) : '';
    const messages = run(['log', '--format=%B', `${from}..${head}`, ...(baseSha.ok ? [`^${baseSha.out}`] : [])]);
    if (listed === null || messages === null) return null;
    const atHead = new Map(listed.split('\0').filter(Boolean).map(l => [l.slice(l.indexOf('\t') + 1), l] as const));
    const entries = moved.map(p => `${atHead.get(p) ?? `0 ${'0'.repeat(from.length)}\t${p}`}\0`).join('');
    if (run(['read-tree', from], env) === null || run(['update-index', '-z', '--index-info'], env, entries) === null) return null;
    const tree = run(['write-tree'], env)?.trim();
    return (tree && run(['commit-tree', '--no-gpg-sign', tree, '-p', from, '-m', 'gstack-ship-receipt: the PR\'s own change since the targeted read', '-m', messages.trim() || '(no messages)'], env)?.trim()) || null;
  } finally { for (const s of ['index', '0', '1', '2']) fs.rmSync(`${tmp}.${s}`, { force: true }); }
}

/**
 * The targeted classes of what the PR's own change did from `from` to `head` against origin/<base> (ownChangeSince), with
 * gstack-gate-diff run over that change whenever a non-docs path moved (a test edit that skips a case is gate class); null when
 * `from` is not an ancestor of `head`, the change cannot be built, the gate scan did not run, or a class input is unreadable.
 * `excluded` is the head's active review_exclude_paths selection (receiptReviewAtHead): those paths name no class (GST-1900).
 */
export function targetedClassesSince(root: string, from: string, head: string, base: string, excluded?: ReadonlySet<string>): readonly TargetedClass[] | null {
  if (!git(root, ['merge-base', '--is-ancestor', from, head]).ok) return null;
  const since = productChangeSince(root, base, from, head)?.since;
  if (!since) return null;
  const at = headInputs(root, from, since, undefined, true);
  let gateTagged: number | null = 0;
  if (gateScanNeeded(at.c.paths, at.c.root)) {
    const g = runScriptSync(path.join(BIN_DIR, 'gstack-gate-diff'), ['--commit', since], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const m = /GATE_SUMMARY: .*?tagged=\{([^}]*)\}/.exec(g.stdout ?? '');
    if (g.status !== 0 || !m) return null;
    gateTagged = m[1]!.split(',').reduce((n, kv) => n + (Number(kv.split(':')[1]) || 0), 0);
  }
  const t = targetedClasses({ ...at.c, scope: at.scope, gateTagged, ...(excluded ? { excluded } : {}) });
  return t.errors.length ? null : t.classes;
}

/**
 * What the PR's own change from `from` to `head` against origin/<base> (ownChangeSince) is to a targeted record: the one
 * classifier gstack-ship-receipt write (plainDocsSince) and gstack-review-plan's targeted-only read (lib/review-targeted-delta.ts)
 * share, so the receipt never refuses a change the plan calls done (GST-1689). `stamps` are the paths whose change is a release
 * stamp under the base policy's stamp rule (lib/tree-receipt.ts classifyFiles: stamp_files, stamp_paths and stamp_patterns, the
 * version file, manifests, lockfiles and the CHANGELOG re-heading or fragment fold), which always carry; `paths` are the rest.
 * The rest is `plain` when it is plain docs (GST-1195): every path docs class, R65's claim rule (platformFits: no numeric
 * claim, no results, prereg or eval path), and no money, security, secret or auth wording in the changed lines (the risk
 * matchers plus DOCS_CLAIM_WORDS, since the matchers spare prose); `claim` when it is docs that fail that rule; `code` when
 * any path is not docs class or is binary. Null when `from` is not an ancestor or the change is unreadable.
 */
export interface DocsChange { verdict: 'plain' | 'claim' | 'code'; stamps: readonly string[]; paths: readonly string[] }
export function docsChangeSince(root: string, from: string, head: string, base: string): DocsChange | null {
  if (!git(root, ['merge-base', '--is-ancestor', from, head]).ok) return null;
  const change = productChangeSince(root, base, from, head);
  if (!change) return null;
  const { since, stamps } = change;
  const c = collectCommit(root, from, since);
  if (c.errors.length || !(c.paths.length || stamps.length)) return null;
  const paths = c.paths;
  const verdict = (v: DocsChange['verdict']): DocsChange => ({ verdict: v, stamps, paths });
  if (!paths.length) return verdict('plain');
  if (!paths.every(p => classifyPath(p, c.root) === 'docs') || c.perPath.some(p => p.binary && paths.includes(p.path))) return verdict('code');
  const added = Object.fromEntries(paths.map(p => [p, c.added?.[p] ?? []]));
  const removed = Object.fromEntries(paths.map(p => [p, c.removed?.[p] ?? []]));
  const lines = paths.flatMap(p => [...added[p]!, ...removed[p]!]);
  if (lines.some(l => l.toLowerCase().split(/[^a-z0-9]+/).some(t => DOCS_CLAIM_WORDS.has(t) || AUTH_PATH_PREFIXES.some(a => t.startsWith(a))))) return verdict('claim');
  return verdict(platformFits('docs', paths, 0, scanNumbers(added)) && matchRisk({ codePaths: paths, added, removed, scopeAuth: true }).size === 0 ? 'plain' : 'claim');
}
/** Whether the PR's own change since `from` carries a targeted record: release stamps and plain docs only (docsChangeSince). */
export const plainDocsSince = (root: string, from: string, head: string, base: string): boolean => docsChangeSince(root, from, head, base)?.verdict === 'plain';

/**
 * ownChangeSince less its release stamps: `since` holds the PR's own change after `from` with every path whose change is a
 * release stamp under the base policy (`stamps`, stampPathsSince) kept at `from`, the change the targeted classes and the docs
 * rule read, since a stamp moves only versions and always carries a targeted record (GST-1689). Null when git cannot build it.
 */
function productChangeSince(root: string, base: string, from: string, head: string): { since: string; stamps: string[] } | null {
  const own = ownChangeSince(root, base, from, head);
  if (!own) return null;
  const stamps = stampPathsSince(root, base, from, own, head);
  if (!stamps.length) return { since: own, stamps };
  const since = ownChangeSince(root, base, from, head, stamps);
  return since ? { since, stamps } : null;
}

/**
 * The paths whose change from `from` to `since` is a release stamp under the base policy (classifyFiles); none when the policy,
 * either version or the diff cannot be read. When origin/<base> changed the CHANGELOG between `from`'s merge base and `head`'s,
 * the CHANGELOG is read against `from`'s merged with the base's (mergeChangelogs, as a base merge resolves it), so the released
 * sections a base merge brings are not counted as the PR's own change; an unmergeable pair keeps `from`'s and fails closed.
 */
function stampPathsSince(root: string, base: string, from: string, since: string, head: string): string[] {
  const { ref, sha } = writeBase(root, base);
  const load = sha ? loadPolicyAt(root, sha, ref) : null;
  if (!sha || !load || isUnavailable(load) || load.errors.length) return [];
  const was = versionAtRef(root, from), now = versionAtRef(root, since);
  if (!('version' in was) || !('version' in now)) return [];
  const gated = (load.policy.changelog && baseMergedChangelogCommit(root, load.policy.changelog, sha, from, head)) || from;
  const d = spawnSync('git', ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', gated, since], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  if (d.status !== 0) return [];
  return classifyFiles(root, parseUnifiedDiff(d.stdout.replace(/\n$/, '')), gated, since, load.policy, now.rel, was.version, now.version, branchSides(root, ref, from, was.version)).filter(f => f.verdict === 'stamp').map(f => f.path);
}

/** A commit on `from` whose CHANGELOG is `from`'s merged with the base's at `head`'s merge base; null when the base did not change it since `from`'s merge base or the pair does not merge. */
function baseMergedChangelogCommit(root: string, rel: string, baseSha: string, from: string, head: string): string | null {
  const run = (args: string[], env?: NodeJS.ProcessEnv, input?: string) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env, input, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const mbFrom = git(root, ['merge-base', baseSha, from]), mbHead = git(root, ['merge-base', baseSha, head]);
  if (!mbFrom.ok || !mbHead.ok || mbFrom.out === mbHead.out) return null;
  const ours = run(['show', `${from}:${rel}`]), theirs = run(['show', `${mbHead.out}:${rel}`]);
  if (ours === null || theirs === null || theirs === run(['show', `${mbFrom.out}:${rel}`])) return null;
  const merged = mergeChangelogs(ours, theirs);
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']);
  if (merged === null || !gitDir.ok) return null;
  const index = path.join(gitDir.out, `gstack-changelog-${process.pid}-${randomBytes(4).toString('hex')}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'gstack-ship-receipt', GIT_AUTHOR_EMAIL: 'ship-receipt@gstack.local', GIT_COMMITTER_NAME: 'gstack-ship-receipt', GIT_COMMITTER_EMAIL: 'ship-receipt@gstack.local', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  try {
    const mode = run(['--literal-pathspecs', 'ls-tree', from, '--', rel])?.split(' ')[0];
    const blob = run(['hash-object', '-w', '--stdin'], undefined, merged)?.trim();
    if (!mode || !blob || run(['read-tree', from], env) === null || run(['update-index', '--cacheinfo', `${mode},${blob},${rel}`], env) === null) return null;
    const tree = run(['write-tree'], env)?.trim();
    return (tree && run(['commit-tree', '--no-gpg-sign', tree, '-p', from, '-m', 'gstack-ship-receipt: the CHANGELOG with the base merged'], env)?.trim()) || null;
  } finally { fs.rmSync(index, { force: true }); }
}
/** Words that make a docs line a money, security, secret or auth claim for plainDocsSince: deliberately broad, since a false hit only reruns the reader. */
const DOCS_CLAIM_WORDS = new Set([...MONEY_PATH_TOKENS, ...AUTH_PATH_TOKENS, 'cap', 'caps', 'capped', 'usd', 'dollar', 'dollars', 'paid', 'pay', 'payment', 'payments', 'refund', 'refunds',
  'secret', 'secrets', 'key', 'keys', 'credential', 'credentials', 'password', 'passwords', 'token', 'tokens', 'security', 'sandbox', 'injection', 'trust', 'redact', 'redaction', 'redactor', 'sanitize', 'sanitizer', 'neutralize', 'neutralizer', 'consent', 'escape', 'csrf', 'xss', 'vulnerability', 'privilege']);

/**
 * receiptTargetedVerdict at the receipt's head, with the classes the queue computes: what write and carry check before they
 * publish (#3854). Classes that failed closed on an input this checkout cannot read (no origin base, no gate scan) are reported,
 * never refused on here: the queue reads its own inputs at ready and refuses there if the head needs the reader.
 */
export function receiptTargetedAtHead(root: string, baseRef: string, r: ShipReceipt, head: string): DepthVerdict {
  const at = headInputs(root, baseRef, head, r);
  const gateTagged = boundScan(r, head) ?? (gateScanNeeded(at.c.paths, at.c.root) ? null : 0);
  const t = targetedAt(at, gateTagged);
  const v = receiptTargetedVerdict(t.classes, r);
  return v.ok || !t.errors.length ? v : { ok: true, line: `${v.line} (unchecked: ${t.errors.join('; ')}; the queue decides at ready)` };
}
