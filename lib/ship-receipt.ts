/**
 * ship-receipt — the handoff record, identifiers first (plan C5). Renders the
 * ```gstack-ship-receipt``` block from the `ship-receipt` schema in
 * lib/headless-artifacts.ts, puts it in the PR body's Agent notes section (lib/agent-notes.ts) so
 * the body opens with plain sentences, reads it back from a PR through `gh`, and
 * computes the P7 adoption census over merged PRs (deduplicated by run and
 * thread id against an owner-maintained thread cohort).
 */
import { spawnSync } from 'node:child_process';
import { ARTIFACT_SCHEMAS, checkSchema, type ShipReceipt, type ValidationError } from './headless-artifacts';
import { agentNotesOrBody, splitAgentNotes, withAgentNotes } from './agent-notes';
import { approvalSummary } from './approval-citations';
import { FRAGMENT_README } from './changelog-fragments';
import { renderIssueLines } from './issue-links';
import { matchesAny } from './ship-policy';
import { ruledNoteText } from './ruled-notes';
import { laneExceptionBodyLines } from './test-lane-exception';
import { stampFileKind, versionStampOnly } from './pregate/stamp-only';
import { stampOnlyLine, type BranchSide } from './stamp-only';

export const RECEIPT_FENCE = 'gstack-ship-receipt';
const KEY_ORDER: Array<keyof ShipReceipt | 'docs'> = [
  'schema_version', 'pr', 'head', 'version', 'base', 'gated_tree', 'predecessor', 'tree', 'gate_reuse', 'gate', 'ci', 'ci_carried', 'spend_usd',
  'session_kind', 'artifacts_consumed', 'run', 'thread', 'policy', 'queue_mode', 'preregistration', 'history',
  'head_tree', 'product_patch_id', 'gstack_version', 'review_depth', 'pregate', 'requires_remote', 'issues', 'approval', 'docs', 'review_loop',
  'review_loop_exception', 'ruled_notes', 'mechanical', 'review_targeted', 'design', 'review_exclude', 'carry', 'base_red', 'flaky_exception', 'no_stop',
];

/** Keys in the fixed order so identifiers lead; undefined values are dropped. */
export function orderReceipt(input: Partial<ShipReceipt> & { docs?: unknown }): ShipReceipt {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if ((input as Record<string, unknown>)[key] !== undefined) out[key] = (input as Record<string, unknown>)[key];
  for (const key of Object.keys(input)) if (!(key in out) && (input as any)[key] !== undefined) out[key] = (input as any)[key];
  return { schema_version: 1, ...out } as ShipReceipt;
}

export function validateReceipt(receipt: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  checkSchema(receipt, ARTIFACT_SCHEMAS['ship-receipt'], '', errors, 'ship-receipt');
  return errors;
}

export function renderReceiptBlock(receipt: ShipReceipt): string {
  return '```' + RECEIPT_FENCE + '\n' + JSON.stringify(receipt, null, 2) + '\n```\n';
}

const BLOCK_RE = /```gstack-ship-receipt[ \t]*\r?\n([\s\S]*?)\r?\n```/;
/** A legacy receipt that opens the body, with the runs block right after it, as /ship posted before the Agent notes section. */
const LEGACY_TOP_RE = /^\s*```gstack-ship-receipt[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*(?:\r?\n|$)(?:\s*```gstack-receipt-runs[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*(?:\r?\n|$))?/;

/**
 * Where the receipt and its runs are read: the Agent notes section when it holds a receipt, else a legacy receipt that
 * opens the body (a section added later without one never hides it), else the section; a body without a section
 * gives the whole body. A receipt fence quoted in the readable part never binds.
 */
function receiptSource(body: string): string {
  const notes = splitAgentNotes(body).notes;
  if (notes === null || BLOCK_RE.test(notes)) return agentNotesOrBody(body);
  return LEGACY_TOP_RE.exec(body)?.[0] ?? notes;
}

/** The receipt block a PR body carries (receiptSource), parsed; `found: false` when absent. */
export function extractReceipt(body: string): { found: boolean; receipt?: ShipReceipt; raw?: string; errors: ValidationError[] } {
  const m = BLOCK_RE.exec(receiptSource(body));
  if (!m) return { found: false, errors: [] };
  try {
    const parsed = JSON.parse(m[1]!);
    return { found: true, receipt: parsed, raw: m[1], errors: validateReceipt(parsed) };
  } catch (e: any) {
    return { found: true, raw: m[1], errors: [{ code: 'RECEIPT_INVALID', path: 'ship-receipt', message: `block is not JSON: ${e.message}` }] };
  }
}

export type ReceiptBindingCode = 'QUEUE_RECEIPT_MISSING' | 'QUEUE_RECEIPT_STALE' | 'QUEUE_RECEIPT_CONDITIONAL' | 'QUEUE_RECEIPT_BASE_MISMATCH';
export type ReceiptBinding =
  | { ok: true; receipt: ShipReceipt; head: string; line: string }
  | { ok: false; code: ReceiptBindingCode; message: string; line: string };

/**
 * The /ship receipt a PR body must carry before READY, train build or a train
 * merge (CREW rule 22; docs/ship-policy.md#ship-before-ready): a valid block
 * whose `head` is one of the accepted heads. `accepted` is the head being
 * READY'd, or the slot's pinned head beside the current head when the current
 * head is the pin's stamp commit (the stamp changes only stamp files, so the
 * receipt written for the pin stays the binding one). `line` is the
 * informational `SHIP_RECEIPT:` line the READY block prints either way.
 * A receipt with a `base_red` block (lib/base-red.ts) is conditional: its
 * Step 5 did not pass, so it binds only for a caller that asks for it
 * (`/ship`'s terminal line, which reports the pause) and is refused
 * everywhere else. With `base` (the queue's base), a receipt reviewed against
 * another branch is refused: a #3570 child retargeted before its parent
 * landed reviewed only its own change, and the carry rewrites `base` once the
 * parent has landed (GST-2153).
 */
export function bindReceipt(body: string, pr: string | undefined, accepted: readonly string[], opts: { conditional?: boolean; base?: string } = {}): ReceiptBinding {
  const subject = pr === undefined ? "the receipt's" : `PR #${pr}'s`;
  const ex = extractReceipt(body);
  if (!ex.found) return { ok: false, code: 'QUEUE_RECEIPT_MISSING', message: `${subject} body carries no ship receipt`, line: 'SHIP_RECEIPT: none in the PR body' };
  if (!ex.receipt || ex.errors.length) {
    const why = ex.errors[0] ? oneLine(`${ex.errors[0].message} at ${ex.errors[0].path}`).slice(0, 200) : 'invalid';
    return { ok: false, code: 'QUEUE_RECEIPT_MISSING', message: `${subject} ship receipt is invalid (${why})`, line: 'SHIP_RECEIPT: invalid in the PR body' };
  }
  const r = ex.receipt;
  const line = receiptSummaryLine(r);
  const head = accepted.find(h => h === r.head || (r.head.length >= 12 && h.startsWith(r.head)));
  if (!head) {
    const want = accepted.map(h => h.slice(0, 12)).join(' or ');
    return { ok: false, code: 'QUEUE_RECEIPT_STALE', message: `${subject} ship receipt is for ${oneLine(r.head.slice(0, 12))}, not the head ${want} being merged`, line };
  }
  if (pr !== undefined && r.pr !== undefined && String(r.pr) !== pr) return { ok: false, code: 'QUEUE_RECEIPT_STALE', message: `${subject} ship receipt names pr=${r.pr}, not this PR`, line };
  const branch = (ref: string) => ref.replace(/^refs\/remotes\/[^/]+\//, '').replace(/^origin\//, '');
  if (opts.base !== undefined && branch(r.base) !== branch(opts.base)) {
    const [was, want] = [oneLine(r.base).slice(0, 120), branch(opts.base)];
    return { ok: false, code: 'QUEUE_RECEIPT_BASE_MISMATCH', message: `${subject} ship receipt was reviewed against ${was}, not ${want}, so it covers only the change since ${was}; land the parent (${was}) first, merge ${want} into this branch and push, then gstack-ship-receipt carry --pr ${pr ?? '<n>'} --base ${want} moves the receipt to ${want}`, line };
  }
  if (r.base_red && !opts.conditional) return { ok: false, code: 'QUEUE_RECEIPT_CONDITIONAL', message: `${subject} ship receipt is paused on a red base (${oneLine(r.base_red.cases.join(', ')).slice(0, 160)} fail at ${oneLine(r.base_red.base.slice(0, 12))}); /ship --resume rewrites it once the base passes them`, line };
  return { ok: true, receipt: r, head, line };
}

/**
 * Every /ship run's receipt (GSTA-258 L4, receipt attribution): when a write or carry replaces a different receipt, the old one's
 * identifiers and counters move to an append-only `gstack-receipt-runs` block (one JSON line per run, oldest first, the
 * newest RECEIPT_RUNS_KEPT kept) right after the current block, so a later replay sees each run's review loop, not only the last.
 */
export const RUNS_FENCE = 'gstack-receipt-runs';
export const RECEIPT_RUNS_KEPT = 30;
const RUNS_RE = /```gstack-receipt-runs[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/;
export type ReceiptRun = Pick<ShipReceipt, 'head' | 'version' | 'gstack_version' | 'run' | 'review_loop' | 'review_loop_exception'> & { depth?: string; carried_from?: string };
export function receiptRuns(body: string): ReceiptRun[] {
  const m = RUNS_RE.exec(receiptSource(body));
  return m ? m[1]!.split('\n').flatMap(l => { try { const o = JSON.parse(l); return o && typeof o.head === 'string' ? [o as ReceiptRun] : []; } catch { return []; } }) : [];
}
export function receiptRun(r: ShipReceipt): ReceiptRun {
  const { head, version, gstack_version, run, review_loop, review_loop_exception } = r;
  return JSON.parse(JSON.stringify({ head, version, gstack_version, run, review_loop, review_loop_exception, depth: r.review_depth?.depth, carried_from: r.carry?.from }));
}

/** Every receipt and runs block with the blank lines after it. */
const STRIP_RE = /```gstack-(?:ship-receipt|receipt-runs)[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/g;

/**
 * The receipt and its runs block go at the end of the body's Agent notes section, which is created when the body has
 * none; the section's other content stays above them. The section's old receipt and runs blocks and a legacy block
 * that opens the body are removed, so one receipt remains; a fence quoted in the readable part stays, since it never
 * binds. A replaced receipt joins the runs block.
 * A legacy body (a receipt and no section, as /ship posted before the section existed) keeps its layout: the block is
 * replaced in place at the top, because its Plan and issue lines sit in the readable part and a new section holding
 * only the receipt would hide them from the readers that prefer the section (a carry on an open PR, GST-1825).
 */
export function placeReceipt(body: string, receipt: ShipReceipt): string {
  const ex = extractReceipt(body);
  const prior = ex.receipt;
  const runs = receiptRuns(body);
  if (prior && typeof prior.head === 'string' && JSON.stringify(prior) !== JSON.stringify(receipt)) runs.push(receiptRun(prior));
  const kept = runs.slice(-RECEIPT_RUNS_KEPT);
  const block = renderReceiptBlock(receipt) + (kept.length ? '\n```' + RUNS_FENCE + '\n' + kept.map(r => JSON.stringify(r)).join('\n') + '\n```\n' : '');
  if (ex.found && splitAgentNotes(body).notes === null) {
    const rest = body.replace(BLOCK_RE, '').replace(RUNS_RE, '').replace(/^\s+/, '');
    return block + (rest ? '\n' + rest : '');
  }
  const rest = body.replace(LEGACY_TOP_RE, '');
  const notes = (splitAgentNotes(rest).notes ?? '').replace(STRIP_RE, '').trim();
  return withAgentNotes(rest.replace(/^\s+/, ''), (notes ? notes + '\n\n' : '') + block);
}

/** The receipt's `issues` object from a gstack-issue-links --out or --json file (its other keys are preview-only). */
export function receiptIssuesFrom(file: Record<string, unknown>): ShipReceipt['issues'] {
  const issues: Record<string, unknown> = {};
  for (const key of ['fixes', 'refs', 'flakes', 'related']) if (file[key] !== undefined) issues[key] = file[key];
  return issues as ShipReceipt['issues'];
}

/** Lines the receipt's issues imply that the body does not carry (a line may continue, e.g. `Refs #N (unreadable …)`). */
export function missingIssueLines(body: string, issues: NonNullable<ShipReceipt['issues']>): string[] {
  const have = body.split(/\r?\n/).map(l => l.trim());
  const expected = renderIssueLines({ fixes: issues.fixes ?? [], refs: issues.refs ?? [], flakes: issues.flakes ?? [], cross: [], unreadable: [], ...(issues.related ? { related: issues.related } : {}) });
  return expected.filter(e => !have.some(l => l === e || l.startsWith(`${e} `)));
}

/** Receipt fields come from the PR body, so anything printed from one stays on its own line, control characters included. */
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]+/g, ' ');

/** The first lines of the completion message to the coordinator: identifiers only. */
export function receiptSummaryLine(r: ShipReceipt): string {
  const parts = [`pr=${r.pr ?? '-'}`, `head=${r.head.slice(0, 12)}`, `version=${r.version ?? '-'}`, `base=${r.base}`];
  if (r.gated_tree) parts.push(`gated_tree=${r.gated_tree.slice(0, 12)}`);
  if (r.tree) parts.push(`tree=${r.tree}`);
  if (r.gate_reuse) parts.push(`gate-reuse=${r.gate_reuse}`);
  if (r.predecessor) parts.push(`predecessor=${r.predecessor.slice(0, 12)}`);
  if (r.session_kind) parts.push(`session_kind=${r.session_kind}`);
  if (r.artifacts_consumed) parts.push(`artifacts_consumed=${r.artifacts_consumed}`);
  if (r.review_depth && typeof r.review_depth.depth === 'string') parts.push(`depth=${r.review_depth.depth}`);
  if (r.approval) parts.push(`approval=${approvalSummary(r.approval)}`);
  const loop = parseReviewLoop(r.review_loop);
  if (loop) parts.push(`passes=${loop.passes} blocking_found=${loop.blocking_found} deferred=${loop.deferred}`
    + (loop.fix_checks ? ` fix_checks=${loop.fix_checks}` : '') + (loop.rounds !== undefined ? ` rounds=${loop.rounds}` : '') + (loop.dispatches ? ` dispatches=${Object.values(loop.dispatches).reduce((a, c) => a + c, 0)}` : ''));
  if (r.carry && typeof r.carry.from === 'string') parts.push(`carried_from=${r.carry.from.slice(0, 12)}`);
  if (Array.isArray(r.ci_carried) && r.ci_carried.length) parts.push(`ci_carried=${r.ci_carried.map(c => `${c.lane}:${c.run}/${c.attempt}`).join(',')}`);
  if (r.base_red && typeof r.base_red.base === 'string') parts.push(`base_red=${r.base_red.base.slice(0, 12)}`);
  return `SHIP_RECEIPT: ${oneLine(parts.join(' '))}`;
}

/** A risk-class PR (R51): the receipt's review depth has class gate or a risk class. Only these get the cross-family trail read. */
export const riskClassReceipt = (r: ShipReceipt | undefined) => r?.review_depth?.class === 'gate' || !!r?.review_depth?.risk?.length;

/**
 * The rest of the READY block (GSTA-258 E1: the ready output is the whole READY): the receipt's review loop, the trial-merge
 * line the lane fills, and the Attention stub, whose opening line follows the receipt's risk class (docs/unattended.md).
 */
export function readyTailLines(r: ShipReceipt | undefined): string[] {
  const loop = parseReviewLoop(r?.review_loop);
  const opt = (k: keyof ReviewLoopReceipt) => (loop?.[k] ? ` ${k}=${loop[k]}` : '');
  const risk = riskClassReceipt(r);
  const legacy = !!r && !r.review_depth;
  return [
    loop ? `REVIEW_LOOP: passes=${loop.passes} blocking_found=${loop.blocking_found} deferred=${loop.deferred} noted=${loop.noted ?? 0} fixed=${loop.fixed ?? 0}${opt('unrecorded')}${opt('unbound')}${opt('fix_checks')}` : 'REVIEW_LOOP: none in the receipt',
    ...(r?.ruled_notes ?? []).map(n => `RULED_NOTE: ${oneLine(ruledNoteText(n))}`),
    ...laneExceptionBodyLines(r?.ci_carried).map(l => `TEST_LANE_EXCEPTION: ${oneLine(l.slice('Test-lane exception: '.length))}`),
    'TRIAL_MERGES: <one line per open sibling pin that shares a file: its git merge-tree result and the resolution, or "none share a file">',
    'Attention:',
    legacy ? 'reviewed by <model on another family> (risk class unknown: the receipt records no review_depth; rule 27 cross-family trail read)'
      : risk ? `reviewed by <model on another family> (risk class: ${oneLine([r?.review_depth?.class === 'gate' ? 'gate' : '', ...(r?.review_depth?.risk ?? [])].filter(Boolean).join(', '))}; rule 27 cross-family trail read)` : 'self-audited (not a risk class: no cross-family trail read)',
    '<flags against decision-trail row numbers, or No flags>',
  ];
}

// ---------------------------------------------------------------------------
// carry: the receipt follows a head whose product diff is unchanged
// ---------------------------------------------------------------------------
/**
 * Paths whose change never invalidates a /ship verdict on its own: tests (the
 * reviewed product code is what the verdict covers; CI at the new head reruns
 * them, unreviewed) and release metadata (the version stamp, the changelog, the
 * agents digest, and under `changelog_fragments` each `<dir>/<slug>.md` fragment). A repo
 * extends the lists through its ship policy (`stamp_files`, `stamp_paths`, `release_outputs`,
 * `changelog`, `changelog_fragments.dir`); lockfiles are
 * product unless the policy names them, because a dependency change is a
 * product change. The test globs name code extensions only: an API contract
 * such as `openapi.spec.yaml` is product.
 */
const TEST_CODE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'rb', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'dart', 'php', 'cs'];
export const CARRY_TEST_CODE_GLOBS: readonly string[] = [
  ...TEST_CODE_EXTENSIONS.flatMap(ext => [`**/*.test.${ext}`, `**/*.spec.${ext}`]),
  '**/*_test.go', '**/test_*.py', '**/*_test.py', '**/*_spec.rb', '**/*Test.java', '**/*Tests.swift',
];
export const CARRY_TEST_GLOBS: readonly string[] = ['test/**', 'tests/**', 'spec/**', '__tests__/**', 'e2e/**', 'cypress/**', '**/__tests__/**', ...CARRY_TEST_CODE_GLOBS];
export const CARRY_METADATA_GLOBS: readonly string[] = ['VERSION', 'CHANGELOG.md', 'package.json', 'agents-digest/**'];
/** How many differing product paths a RECEIPT_CARRY_PRODUCT_CHANGED refusal names, and how far the per-path patch-id walk goes. */
export const CARRY_NAMED_PATHS = 20;

/** `generated`: an output of a base-registry entry with a command, which the pregate for HEAD proved its command recreates (its inputs are product). */
export type CarryClass = 'product' | 'test' | 'metadata' | 'generated';
export interface CarryPlanInput {
  /** The reviewed head the receipt names. */
  from: string; head: string;
  /** Paths changed between from and head, classified. */
  changed: Array<{ path: string; class: CarryClass }>;
  /** Product patch-ids at both heads (empty string for no product diff). */
  productPatchId: { from: string; head: string };
  testPatchId: { from: string; head: string };
  /** Product paths whose patch against the base differs between the two heads. */
  changedProduct: string[];
  mergeCommits: number;
  rangeDiff: string;
  /** The base the receipt was reviewed against when it differs from the carry's (a stack parent that landed, #3570): productPatchId.from is then the recorded diff against it. */
  retargetedFrom?: string;
  /** A commit inside the reviewed range whose product change the base already holds (a stack parent that squash-merged under a receipt written against the base, GST-1199): productPatchId.from is then the range from it. */
  stackParent?: string;
  /** A clean scoped review of product paths whose only difference is base context next to unchanged hunks (lib/ship-patch.ts, GST-384): the carry reason it adds. */
  scopedReview?: string;
  /** Stamp files the branch changed as product whose only change since the reviewed head is a stamp on the branch's own rows, the base untouched, and without which the two product patches match (GST-980). */
  stampedRows?: string[];
  /** A clean scoped re-check of the range-diff since the reviewed head (crew/lib/ship-recheck.ts, J1): the carry reason it adds. */
  recheck?: string;
}
export interface CarryRecord { from: string; reason: string; product_patch_id: string; changed_paths: string[]; merge_commits: number; range_diff: string; covers: string[]; reruns: string[]; trees?: string[]; ancestry?: 'linear' | 'rewritten' }
export type CarryPlan = { ok: true; carry: CarryRecord } | { ok: false; code: 'RECEIPT_CARRY_PRODUCT_CHANGED' | 'RECEIPT_CARRY_REFUSED' | 'RECEIPT_CARRY_TREE_MISMATCH'; message: string };
const CARRY_COVERS = ['pre-landing review', 'adversarial review', 'gate integrity', 'documentation audit'];
const CARRY_RERUNS = ['CI at head (gstack-ship-queue ready requires it); test and helper code changed since the reviewed head runs there unreviewed'];

/**
 * The file's text at the reviewed head and at HEAD, with the release version each head carries (from `VERSION`, else
 * `package.json`) and the base policy's `stamp_patterns` templates and `stamp_placeholders`.
 */
export interface CarryChange { before: string | null; after: string | null; oldVersion?: string | null; newVersion?: string | null; templates?: readonly string[]; side?: BranchSide; placeholders?: readonly string[] }

/**
 * A policy-named stamp path's change is a stamp when the new text reads as the
 * old text once every new version in it is the old one, or when every changed
 * line is a stamp-form rewrite to the new version (`stampOnlyLine`: the old
 * version or a newer tentative `*_KEY_VERSION` the slot stamp moved, #3512, and
 * on a line the branch added itself, `side`, the fork version or newer, GST-963; with a kept VERSION only such a line,
 * GST-980): the rule
 * the tree receipt applies to the same `stamp_paths`, `stamp_files` and
 * `release_outputs` before the train accepts a stamp commit. No version
 * change outside the branch's own lines, or a file missing on either side, is not a stamp.
 */
export function stampOnlyText(change: CarryChange): boolean {
  const { before, after, oldVersion, newVersion } = change;
  if (before === null || after === null || !oldVersion || !newVersion || (oldVersion === newVersion && !change.side)) return false;
  // Digit-bounded: replacing 1.2.3 inside 11.2.3 or 1.2.34 would read a different version's stamp as this one's.
  const escaped = newVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (oldVersion !== newVersion && after.replace(new RegExp(`(?<![0-9])${escaped}(?![0-9])`, 'g'), oldVersion) === before) return true;
  const was = before.split('\n');
  const now = after.split('\n');
  if (was.length !== now.length) return false;
  const changed = was.map((line, i) => i).filter(i => was[i] !== now[i]);
  return changed.length > 0 && changed.every(i => stampOnlyLine(was[i]!, now[i]!, oldVersion, newVersion, change.templates ?? [], change.side, i + 1, change.placeholders ?? []));
}

/**
 * One changed path's carry class. The changelog, the agents digest and, when the
 * base policy names `changelog_fragments.dir` (`extra.fragments`), each fragment
 * directly under it except its README are metadata. A manifest (`package.json`, `VERSION`) is metadata only while its
 * from..head change is a version stamp and nothing else (`versionStampOnly`): a
 * dependency, a script or a new key is product. A path the policy names under
 * `stamp_files`, `stamp_paths` or `release_outputs` is metadata only while its
 * change is a stamp (`versionStampOnly` for a manifest kind, `stampOnlyText`
 * otherwise): a logic change in a stamped source file is product, as it is for
 * the tree receipt. `change` carries the texts; a caller without them gets the
 * list-only answer.
 */
export function classifyCarryPath(rel: string, extra: { metadata?: readonly string[]; outputs?: readonly string[]; fragments?: string } = {}, change?: CarryChange): CarryClass {
  const stamp = () => !change || (stampFileKind(rel) ? versionStampOnly(rel, change.before, change.after).stampOnly : stampOnlyText(change));
  if (matchesAny(CARRY_METADATA_GLOBS, rel)) return !change || !stampFileKind(rel) || versionStampOnly(rel, change.before, change.after).stampOnly ? 'metadata' : 'product';
  if (extra.fragments && rel !== `${extra.fragments}/${FRAGMENT_README}` && matchesAny([`${extra.fragments}/*.md`], rel)) return 'metadata';
  if (matchesAny(extra.outputs ?? [], rel)) return 'generated';
  if (matchesAny(extra.metadata ?? [], rel)) return stamp() ? 'metadata' : 'product';
  if (matchesAny(CARRY_TEST_GLOBS, rel)) return 'test';
  return 'product';
}

/**
 * The carry decision: the receipt follows `head` when the product diff
 * against the base has the same patch-id at both heads, which is what a
 * conflict-only base merge, a test-only fix or a release-metadata change
 * leaves behind. A product patch that differs is RECEIPT_CARRY_PRODUCT_CHANGED,
 * whatever else changed, unless every difference is base context next to unchanged hunks
 * and a scoped review of those hunks came back clean (`scopedReview`), or a stamp on the
 * branch's own rows in a stamp file the branch also changed as product (`stampedRows`, GST-980).
 */
export function planCarry(input: CarryPlanInput): CarryPlan {
  if (input.productPatchId.from !== input.productPatchId.head && !input.recheck && (input.changedProduct.length || (!input.scopedReview && !input.stampedRows?.length))) {
    const named = input.changedProduct.slice(0, CARRY_NAMED_PATHS);
    return { ok: false, code: 'RECEIPT_CARRY_PRODUCT_CHANGED', message: `product diff changed between ${input.from.slice(0, 12)} and ${input.head.slice(0, 12)}: ${named.join(', ') || 'patch-id differs'}${input.changedProduct.length > named.length ? ` (+${input.changedProduct.length - named.length} more)` : ''}` };
  }
  const parent = input.retargetedFrom ?? input.stackParent?.slice(0, 12);
  const reasons: string[] = parent ? [`stack parent ${parent} landed`] : [];
  if (input.mergeCommits > 0) reasons.push(input.mergeCommits === 1 ? 'base merge' : `${input.mergeCommits} base merges`);
  if (input.recheck && input.productPatchId.from !== input.productPatchId.head) reasons.push(input.recheck);
  if (input.scopedReview && input.productPatchId.from !== input.productPatchId.head) reasons.push(input.scopedReview);
  if (input.stampedRows?.length && input.productPatchId.from !== input.productPatchId.head) reasons.push(`a stamp on the branch's own rows (${input.stampedRows.join(', ')})`);
  if (input.testPatchId.from !== input.testPatchId.head) reasons.push('test-only change');
  if (input.changed.some(c => c.class === 'metadata')) reasons.push('release metadata');
  if (input.changed.some(c => c.class === 'generated')) reasons.push('regenerated outputs');
  if (!reasons.length) reasons.push(input.changed.length ? 'no product change' : 'no content change');
  return {
    ok: true,
    carry: {
      from: input.from, reason: reasons.join(' + '), product_patch_id: input.productPatchId.head || 'none',
      changed_paths: input.changed.slice(0, 50).map(c => `${c.class}:${c.path}`), merge_commits: input.mergeCommits, range_diff: input.rangeDiff,
      covers: CARRY_COVERS, reruns: CARRY_RERUNS, ancestry: 'linear',
    },
  };
}

/** How many base commits since the fork heldBy tries after a conflicted base tip, newest first. */
export const HELD_WALK = 200;

/**
 * The base commit that holds `commit`'s own change (GST-1199, GST-1399; finish's landed stack parent and landedStackParent): merging `commit` into it changes no path in
 * `pathspec`. The current base is tried first. When that merge conflicts (the base edited the landed lines afterwards),
 * the commits on its first-parent history since the fork that touched every path of the change are tried newest first,
 * so a squash the base later edited is still found. A change with no path of its own is held by no commit (any base
 * trivially holds it), and a conflict inside `pathspec` is never held (one only in excluded release metadata, like a
 * train's VERSION restamp, is). Null when none within HELD_WALK holds it or git cannot tell.
 */
export function heldBy(repoRoot: string, commit: string, currentBase: string, pathspec: readonly string[]): string | null {
  const run = (args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const fork = run(['merge-base', currentBase, commit]).stdout.trim();
  const own = fork ? run(['diff', '-z', '--name-only', '--no-renames', fork, commit, '--', ...pathspec]) : null;
  const paths = own?.status === 0 ? own.stdout.split('\0').filter(Boolean) : [];
  if (!paths.length) return null;
  const holds = (at: string): 'held' | 'conflict' | 'no' => {
    const merged = run(['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', at, commit]);
    const [tree, ...conflicted] = merged.status === 0 || merged.status === 1 ? merged.stdout.split('\0').filter(Boolean) : [];
    const mb = conflicted.length ? run(['merge-base', at, commit]).stdout.trim() : '';
    const theirs = mb ? run(['diff', '-z', '--name-only', '--no-renames', mb, commit, '--', ...pathspec]) : null;
    const clean = !conflicted.length || (theirs?.status === 0 && !theirs.stdout.split('\0').some(p => conflicted.includes(p)));
    if (tree && clean && run(['diff', '--quiet', at, tree, '--', ...pathspec]).status === 0) return 'held';
    return merged.status === 1 ? 'conflict' : 'no';
  };
  const tip = holds(currentBase);
  if (tip !== 'conflict') return tip === 'held' ? currentBase : null;
  const log = run(['log', '--first-parent', '-z', '--format=%x01%H', '--name-only', '--no-renames', `--max-count=${HELD_WALK}`, `${fork}..${currentBase}`, '--', ...paths.map(p => `:(top,literal)${p}`)]);
  if (log.status !== 0) return null;
  for (const entry of log.stdout.split('\x01').filter(Boolean)) {
    const [at, ...names] = entry.split(/[\n\0]/).filter(Boolean);
    if (at && at !== currentBase && paths.every(p => names.includes(p)) && holds(at) === 'held') return at;
  }
  return null;
}

/** How many commits of the reviewed range landedStackParent tries, newest first. */
export const STACK_PARENT_WALK = 100;

/**
 * The newest commit inside the reviewed range (rangeBase..reviewed, the reviewed head itself excluded) whose product
 * change the current base already holds: merging it into currentBase, or into the base commit that landed it when the
 * base edited those lines since (heldBy, GST-1399), changes no product path. That is a stack parent
 * that squash-merged (or merged) into the base after the receipt was written against the base (GST-1199). A commit with no
 * product change of its own (a test-first commit) is no parent, since any base trivially holds it. Null when no
 * commit within STACK_PARENT_WALK qualifies or git cannot tell; a conflicted product path is never held.
 */
export function landedStackParent(repoRoot: string, s: { rangeBase: string; reviewed: string; currentBase: string }, product: readonly string[]): string | null {
  const run = (args: string[]) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const commits = run(['rev-list', '--topo-order', `--max-count=${STACK_PARENT_WALK + 1}`, `${s.rangeBase}..${s.reviewed}`]);
  if (commits.status !== 0) return null;
  for (const commit of commits.stdout.split('\n').filter(c => c && c !== s.reviewed)) {
    if (run(['diff', '--quiet', s.rangeBase, commit, '--', ...product]).status !== 1) continue;
    if (heldBy(repoRoot, commit, s.currentBase, product)) return commit;
  }
  return null;
}

export interface TreeCarryInput {
  from: string; head: string;
  /** HEAD^{tree}, and every tree the receipt already covers (its head_tree plus earlier carries' trees). */
  headTree: string; coveredTrees: readonly string[];
  /** The product patch-id against the base the receipt recorded, and the one HEAD has against the current base. */
  productPatchId: { recorded: string; head: string };
}

/**
 * The carry across rewritten history (a rebase or force-push): the receipt
 * follows HEAD only when HEAD's tree is one the receipt already covers and the
 * product diff against the current base has the patch-id the receipt recorded.
 * The tree alone is not enough: a stacked branch rebased onto main after its
 * base closed unmerged keeps its tree while its diff grows by the base's code.
 */
export function planTreeCarry(input: TreeCarryInput): CarryPlan {
  if (!input.coveredTrees.includes(input.headTree)) {
    return { ok: false, code: 'RECEIPT_CARRY_TREE_MISMATCH', message: `the receipt's head ${input.from.slice(0, 12)} is not an ancestor of HEAD ${input.head.slice(0, 12)} (rebased or force-pushed), and HEAD's tree ${input.headTree.slice(0, 12)} is not a tree the receipt covers (${input.coveredTrees.map(t => t.slice(0, 12)).join(', ') || 'none recorded'}); the receipt is unchanged: run /ship on ${input.head.slice(0, 12)}` };
  }
  if (input.productPatchId.recorded !== input.productPatchId.head) {
    return { ok: false, code: 'RECEIPT_CARRY_PRODUCT_CHANGED', message: `HEAD ${input.head.slice(0, 12)} has the reviewed tree, but its product diff against the current base differs from the one reviewed at ${input.from.slice(0, 12)} (the base itself moved under it); the receipt is unchanged: run /ship on ${input.head.slice(0, 12)}` };
  }
  return {
    ok: true,
    carry: {
      from: input.from, reason: 'rebase onto a reviewed tree', product_patch_id: input.productPatchId.head || 'none',
      changed_paths: [], merge_commits: 0, range_diff: 'tree-equal', covers: CARRY_COVERS, reruns: CARRY_RERUNS, ancestry: 'rewritten',
    },
  };
}

/**
 * The carried receipt: the same evidence, bound to the new head, with the carry
 * recorded. A receipt carried before keeps the reviewed head as `from` and adds
 * this hop's merges and paths, so the record always names the head a review saw.
 */
export function carryReceipt(receipt: ShipReceipt, head: string, carry: CarryRecord, at: { tree: string; fromTree?: string; productPatchId: string }): ShipReceipt {
  const prior = receipt.carry;
  const merged: CarryRecord = !prior ? carry : {
    ...carry, from: prior.from, reason: prior.reason === carry.reason ? carry.reason : `${prior.reason} + ${carry.reason}`,
    merge_commits: prior.merge_commits + carry.merge_commits,
    changed_paths: [...prior.changed_paths, ...carry.changed_paths.filter(p => !prior.changed_paths.includes(p))].slice(0, 50),
    ancestry: prior.ancestry === 'rewritten' ? 'rewritten' : carry.ancestry,
  };
  const fromTree = receipt.head_tree ?? at.fromTree;
  const trees = [...new Set([...(prior?.trees ?? []), ...(fromTree ? [fromTree] : [])])].filter(t => t !== at.tree).slice(-20);
  return orderReceipt({ ...receipt, head, head_tree: at.tree, product_patch_id: at.productPatchId || 'none', carry: { ...merged, ...(trees.length ? { trees } : {}) } });
}

/** The loop counters the factory scorecard reads (passes, blocking_found, deferred), as `write --review-loop` records them. */
export type ReviewLoopReceipt = NonNullable<ShipReceipt['review_loop']>;
export function parseReviewLoop(value: unknown): ReviewLoopReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const n = (k: string) => (typeof v[k] === 'number' && Number.isInteger(v[k]) && (v[k] as number) >= 0 ? (v[k] as number) : undefined);
  const passes = n('passes'); const blocking = n('blocking_found'); const deferred = n('deferred');
  if (passes === undefined || blocking === undefined || deferred === undefined) return undefined;
  const out: ReviewLoopReceipt = { passes, blocking_found: blocking, deferred };
  if (n('noted') !== undefined) out.noted = n('noted');
  if (n('fixed') !== undefined) out.fixed = n('fixed');
  if (typeof v.scope === 'string') out.scope = v.scope.slice(0, 20);
  if (n('fix_checks') !== undefined) out.fix_checks = n('fix_checks');
  if (n('rounds') !== undefined) out.rounds = n('rounds');
  if (n('est_input_tokens') !== undefined) out.est_input_tokens = n('est_input_tokens');
  if (n('unrecorded')) out.unrecorded = n('unrecorded');
  if (n('ledgers_read')) out.ledgers_read = n('ledgers_read');
  const unbound = Array.isArray(v.unbound) ? v.unbound.length : n('unbound');
  if (unbound) out.unbound = unbound;
  if (v.dispatches && typeof v.dispatches === 'object' && !Array.isArray(v.dispatches)) {
    const d = Object.fromEntries(Object.entries(v.dispatches as Record<string, unknown>)
      .filter(([k, c]) => /^[a-z][a-z0-9-]{0,39}$/.test(k) && typeof c === 'number' && Number.isInteger(c) && c >= 0).slice(0, 12)) as Record<string, number>;
    if (Object.keys(d).length) out.dispatches = d;
  }
  return out;
}

// ---------------------------------------------------------------------------
// census (P7)
// ---------------------------------------------------------------------------
export interface CensusPr { number: number; mergedAt: string; body: string; title?: string }
export interface Census {
  repo: string; since: string; merged_prs: number; with_receipt: number; invalid_receipts: number;
  unattended_prs: number; consumed_prs: number; runs: string[]; threads: string[]; consumed_threads: string[];
  cohort: string[] | null; cohort_consumed: number; adoption: string; durable: 'yes'; by_session_kind: Record<string, number>;
  prs: Array<{ number: number; session_kind: string | null; artifacts_consumed: string | null; run: string | null; thread: string | null; valid: boolean }>;
}

function consumedCount(value: string | undefined): number {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(value ?? '');
  return m ? Number(m[1]) : 0;
}

/** Merged PRs → the adoption number: receipts deduplicated by run id and thread id, against the cohort when given. */
export function computeCensus(repo: string, since: string, prs: CensusPr[], cohort: string[] | null): Census {
  const runs = new Set<string>();
  const threads = new Set<string>();
  const consumedThreads = new Set<string>();
  const byKind: Record<string, number> = {};
  const rows: Census['prs'] = [];
  let withReceipt = 0;
  let invalid = 0;
  let unattended = 0;
  let consumed = 0;
  const seenRuns = new Set<string>();
  for (const pr of prs) {
    const ex = extractReceipt(pr.body ?? '');
    if (!ex.found) continue;
    withReceipt += 1;
    if (ex.errors.length || !ex.receipt) { invalid += 1; rows.push({ number: pr.number, session_kind: null, artifacts_consumed: null, run: null, thread: null, valid: false }); continue; }
    const r = ex.receipt;
    rows.push({ number: pr.number, session_kind: r.session_kind ?? null, artifacts_consumed: r.artifacts_consumed ?? null, run: r.run ?? null, thread: r.thread ?? null, valid: true });
    const kind = r.session_kind ?? 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (r.run && seenRuns.has(r.run)) continue;
    if (r.run) { seenRuns.add(r.run); runs.add(r.run); }
    if (r.thread) threads.add(r.thread);
    if (kind === 'unattended') unattended += 1;
    if (consumedCount(r.artifacts_consumed) > 0) { consumed += 1; if (r.thread) consumedThreads.add(r.thread); }
  }
  const cohortConsumed = cohort ? cohort.filter(t => consumedThreads.has(t)).length : consumedThreads.size;
  const denominator = cohort ? cohort.length : threads.size;
  return {
    repo, since, merged_prs: prs.length, with_receipt: withReceipt, invalid_receipts: invalid, unattended_prs: unattended, consumed_prs: consumed,
    runs: [...runs], threads: [...threads], consumed_threads: [...consumedThreads], cohort, cohort_consumed: cohortConsumed,
    adoption: `${cohortConsumed}/${denominator}${cohort ? ' (cohort)' : ' (threads seen; no cohort file)'}`, durable: 'yes', by_session_kind: byKind, prs: rows,
  };
}

export function renderCensus(c: Census): string {
  return [
    `CENSUS: repo=${c.repo} since=${c.since} merged_prs=${c.merged_prs} with_receipt=${c.with_receipt} invalid=${c.invalid_receipts} unattended=${c.unattended_prs} consumed=${c.consumed_prs} runs=${c.runs.length} threads=${c.threads.length} adoption=${c.adoption} durable=${c.durable}`,
    ...Object.entries(c.by_session_kind).map(([k, n]) => `  session_kind ${k}: ${n}`),
    ...c.prs.map(p => `  #${p.number} ${p.valid ? `session_kind=${p.session_kind ?? '-'} artifacts_consumed=${p.artifacts_consumed ?? '-'} run=${p.run ?? '-'} thread=${p.thread ?? '-'}` : 'receipt invalid'}`),
  ].join('\n') + '\n';
}
