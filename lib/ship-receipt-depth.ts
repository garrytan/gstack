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
 * (lib/review-targeted.ts), which the queue reports beside the depth and does
 * not refuse on yet (GST-257 PR 1). Kept beside
 * lib/ship-receipt.ts so that module stays under the size ratchet.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { ShipReceipt } from './headless-artifacts';
import { collectCommit } from './review-collect';
import { depthOfCommitInput, gateScanNeeded, type Depth } from './review-depth';
import { TARGETED_CLASSES, classList, targetedClasses, type TargetedClass } from './review-targeted';
import { runScriptSync } from './script-invocation';
import { bindReceipt, type ReceiptBindingCode } from './ship-receipt';
import { docsExceptionLine, parseReceiptDocs } from './ship-receipt-docs';

export type ReceiptDepth = NonNullable<ShipReceipt['review_depth']>;
export type ReviewLoopException = NonNullable<ShipReceipt['review_loop_exception']>;
const RANK: Record<Depth, number> = { light: 0, standard: 1, full: 2 };
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const BIN_DIR = path.join(import.meta.dir, '..', 'bin');
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : 'none');

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** gstack-diff-scope on the committed range `base`...`head` (`--head`): the same signals at write, carry and the queue. */
function scopeOfRange(root: string, binDir: string, base: string, head: string): Record<string, string> {
  const sr = runScriptSync(path.join(binDir, 'gstack-diff-scope'), [base, '--head', head], { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const scope: Record<string, string> = {};
  for (const l of (sr.stdout ?? '').split('\n')) { const m = /^(SCOPE_[A-Z_]+)=(.*)$/.exec(l); if (m) scope[m[1]!] = m[2]!; }
  if (sr.status !== 0 && !scope.SCOPE_ERROR) scope.SCOPE_ERROR = `exit ${sr.status}`;
  return scope;
}

/**
 * The depth record for `head`: the range from git objects (collectCommit) and
 * its diff-scope, as the queue recomputes them, plus, for a tests or code diff,
 * the gate scan of this checkout. The scan reads the working tree, so it counts
 * only when the checkout is `head` with no tracked edits; otherwise it is
 * unavailable and the depth fails closed to full.
 */
export function receiptDepthAtHead(repoRoot: string, base: string, binDir: string, head: string): ReceiptDepth {
  const branch = base.replace(/^origin\//, '');
  const baseSha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`]);
  const baseRev = baseSha.ok ? baseSha.out : branch;
  const c = collectCommit(repoRoot, baseRev, head);
  const scope = scopeOfRange(repoRoot, binDir, baseRev, head);
  let tagged: number | null = 0;
  if (gateScanNeeded(c.paths, c.root)) {
    const atHead = git(repoRoot, ['rev-parse', 'HEAD']).out === head && git(repoRoot, ['diff', '--quiet', 'HEAD', '--']).ok;
    const g = atHead ? runScriptSync(path.join(binDir, 'gstack-gate-diff'), [baseRev], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }) : null;
    const m = /GATE_SUMMARY: .*?tagged=\{([^}]*)\}/.exec(g?.stdout ?? '');
    tagged = g?.status === 0 && m ? m[1]!.split(',').reduce((n, kv) => n + (Number(kv.split(':')[1]) || 0), 0) : null;
  }
  const d = depthOfCommitInput({ ...c, scope, gateTagged: tagged });
  return { depth: d.depth, class: d.class, runtime_lines: d.runtimeLines, rules: d.rules, base: baseRev, registry: c.registry.sha, gate_scan: { tagged, head }, reasons: d.reasons.slice(0, 12) };
}

export const depthBelow = (have: Depth, need: Depth) => RANK[have] < RANK[need];
export const deeper = (a: Depth, b: Depth): Depth => (RANK[a] >= RANK[b] ? a : b);

/** `write --review-loop-exception` input and the queue's check: who accepted the stop, when, where, why, and the fix-check it followed. */
export function parseReviewLoopException(value: unknown): { ok: true; exception: ReviewLoopException } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('review_loop_exception must be { accepted_by, date, via, reason, fix_check: { head, findings[, files] } }');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!['accepted_by', 'date', 'via', 'reason', 'fix_check'].includes(key)) return bad(`review_loop_exception: unknown key ${JSON.stringify(key)}`);
  for (const key of ['accepted_by', 'date', 'via', 'reason']) if (!text(v[key])) return bad(`review_loop_exception.${key} must be a non-empty one-line string`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date as string)) return bad('review_loop_exception.date must be YYYY-MM-DD');
  const f = v.fix_check as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return bad('review_loop_exception.fix_check must be { head, findings[, files] }');
  for (const key of Object.keys(f)) if (!['head', 'findings', 'files'].includes(key)) return bad(`review_loop_exception.fix_check: unknown key ${JSON.stringify(key)}`);
  if (!sha(f.head)) return bad('review_loop_exception.fix_check.head must be the full commit the fix-check reviewed');
  if (typeof f.findings !== 'number' || !Number.isInteger(f.findings) || f.findings < 0) return bad('review_loop_exception.fix_check.findings must be an integer >= 0 (what the fix-check reported)');
  if (f.files !== undefined && (!Array.isArray(f.files) || !f.files.every(text))) return bad('review_loop_exception.fix_check.files must be a list of paths');
  const files = (f.files as string[] | undefined)?.slice(0, 50);
  return { ok: true, exception: { accepted_by: (v.accepted_by as string).trim(), date: v.date as string, via: (v.via as string).trim(), reason: (v.reason as string).trim(), fix_check: { head: f.head, findings: f.findings, ...(files?.length ? { files } : {}) } } };
}

/** The line the PR body must carry, word for word, while the exception stands. */
export function reviewLoopExceptionLine(e: ReviewLoopException): string {
  return `Review-loop exception: accepted by ${e.accepted_by} ${e.date} via ${e.via}: ${e.reason} (fix-check at ${e.fix_check.head.slice(0, 12)}, ${e.fix_check.findings} finding${e.fix_check.findings === 1 ? '' : 's'})`;
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
      if (!r.review_loop?.fix_checks) out.push('review_loop_exception needs review_loop.fix_checks >= 1 (the stop it accepts follows a fix-check)');
      if (isAncestor && !isAncestor(e.exception.fix_check.head)) out.push(`review_loop_exception.fix_check.head ${e.exception.fix_check.head.slice(0, 12)} is not the receipt head or an ancestor of it`);
      const line = reviewLoopExceptionLine(e.exception);
      if (!carries(body, line)) out.push(`the body does not carry the review-loop exception line verbatim: ${JSON.stringify(line)}`);
    }
  }
  return out;
}

export type ReviewTargeted = NonNullable<ShipReceipt['review_targeted']>;

/** `write --review-targeted` input (gstack-review-dispatch verify --targeted-out), bound to the receipt's product patch-id here. */
export function parseReviewTargeted(value: unknown, productPatchId: string): { ok: true; targeted: ReviewTargeted } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('review_targeted must be { classes, rules, brief_sha, status, findings, raised_by }');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!['classes', 'rules', 'brief_sha', 'status', 'findings', 'raised_by'].includes(key)) return bad(`review_targeted: unknown key ${JSON.stringify(key)}${key === 'product_patch_id' ? ' (write binds the pass to the receipt\'s product_patch_id)' : ''}`);
  if (!Array.isArray(v.classes) || !v.classes.every(c => (TARGETED_CLASSES as readonly unknown[]).includes(c))) return bad(`review_targeted.classes must list ${TARGETED_CLASSES.join(', ')}`);
  if (!text(v.rules) || !text(v.raised_by)) return bad('review_targeted.rules and raised_by must be non-empty one-line strings');
  if (typeof v.brief_sha !== 'string' || !/^[0-9a-f]{64}$/.test(v.brief_sha)) return bad('review_targeted.brief_sha must be the sha256 of review/specialists/targeted.md');
  if (!['done', 'failed', 'not-run'].includes(v.status as string)) return bad('review_targeted.status must be done, failed or not-run');
  if (typeof v.findings !== 'number' || !Number.isInteger(v.findings) || v.findings < 0) return bad('review_targeted.findings must be an integer >= 0');
  const classes = TARGETED_CLASSES.filter(c => (v.classes as string[]).includes(c));
  return { ok: true, targeted: { classes, rules: v.rules as string, brief_sha: v.brief_sha, product_patch_id: productPatchId, status: v.status as ReviewTargeted['status'], findings: v.findings, raised_by: (v.raised_by as string).trim() } };
}

/** The queue's report-only line: the classes the head needs against the classes a done targeted pass covered; never a refusal (GST-257 PR 1). */
export function receiptTargetedLine(required: readonly TargetedClass[], r: ShipReceipt): string {
  const rt = r.review_targeted;
  const covered: readonly string[] = rt?.status === 'done' ? rt.classes : [];
  const ok = required.every(c => covered.includes(c));
  return `REVIEW_TARGETED: required=${classList(required)} receipt=${rt ? classList(covered) : 'legacy'} verdict=${ok ? 'ok' : 'missing'}`;
}

export interface DepthVerdict { ok: boolean; line: string; message?: string }

/** The head's committed range against the base, read once for the depth verdict and the targeted line. */
interface HeadInputs { baseSha: { ok: boolean; out: string }; c: ReturnType<typeof collectCommit>; scope: Record<string, string> }
function headInputs(root: string, baseRef: string, head: string): HeadInputs {
  const baseSha = git(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  const baseRev = baseSha.ok ? baseSha.out : baseRef;
  return { baseSha, c: collectCommit(root, baseRev, head), scope: scopeOfRange(root, BIN_DIR, baseRev, head) };
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
  const { baseSha, c, scope } = at ?? headInputs(root, baseRef, head);
  const tagged = boundScan(r, head);
  const scanBound = tagged !== null;
  const need = depthOfCommitInput({ ...c, scope, gateTagged: tagged });
  const have = rd?.depth;
  const inputs = `base@${short(baseSha.ok ? baseSha.out : null)},registry@${short(c.registry.sha)},gate_scan@${scanBound ? short(rd!.gate_scan.head) : 'missing'}`;
  const line = `REVIEW_DEPTH: receipt=${have ?? 'none'} required=${need.depth} runtime_lines=${need.runtimeLines} class=${need.class} reasons=${need.reasons.join(',')} inputs=${inputs}`;
  if (have && !depthBelow(have, need.depth)) return { ok: true, line };
  const why = have ? `was reviewed at ${have} depth` : 'records no review_depth though its writer records one';
  const errs = need.errors.map(e => `${e.code} (${e.input})`).join('; ');
  return { ok: false, line, message: `the receipt ${why}, but head ${head.slice(0, 12)} needs ${need.depth} (${need.reasons.join(', ')}${errs ? `; ${errs}` : ''}); the receipt is unchanged; run /ship on ${head.slice(0, 12)}` };
}

/** bindReceipt plus the owner exceptions and the review depth: what READY and train build accept; the targeted line is reported, never refused on. */
export function bindShippedReceipt(root: string, baseRef: string, body: string, pr: string | undefined, accepted: readonly string[]):
  | { ok: true; receipt: ShipReceipt; head: string; line: string; depthLine: string; targetedLine: string }
  | { ok: false; code: ReceiptBindingCode | 'QUEUE_RECEIPT_DEPTH_RAISED' | 'QUEUE_RECEIPT_EXCEPTION_INVALID'; message: string; line: string; depthLine?: string; targetedLine?: string } {
  const b = bindReceipt(body, pr, accepted);
  if (!b.ok) return b;
  const ancestor = (commit: string) => b.receipt.carry?.ancestry === 'rewritten' || git(root, ['merge-base', '--is-ancestor', commit, b.head]).ok;
  const problems = exceptionProblems(body, b.receipt, ancestor);
  if (problems.length) return { ok: false, code: 'QUEUE_RECEIPT_EXCEPTION_INVALID', message: `the receipt's owner exception does not stand: ${problems.join('; ')}`, line: b.line };
  const at = headInputs(root, baseRef, b.head);
  const d = receiptDepthVerdict(root, baseRef, b.receipt, b.head, at);
  const gateTagged = boundScan(b.receipt, b.head) ?? (gateScanNeeded(at.c.paths, at.c.root) ? null : 0);
  const targetedLine = receiptTargetedLine(targetedClasses({ ...at.c, scope: at.scope, gateTagged }).classes, b.receipt);
  if (!d.ok) return { ok: false, code: 'QUEUE_RECEIPT_DEPTH_RAISED', message: d.message!, line: b.line, depthLine: d.line, targetedLine };
  return { ...b, depthLine: d.line, targetedLine };
}

