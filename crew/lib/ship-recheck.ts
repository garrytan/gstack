/**
 * J1 (GSTA-258 plan H, relabeled J1): a scoped re-check after a refused receipt carry. When `gstack-ship-receipt carry` refuses
 * because the product patch changed since the reviewed head, and the change is bounded, carry writes a packet of `git
 * range-diff` of the reviewed range against the current one, which one reader may read for advice. Since GST-2673 the read
 * never rebinds the receipt: a packet-only reader caught 0 of 8 real faults that full rounds had caught (22 of 24 seeded ones;
 * docs/evals/pr-round-count-prereg.md), so the head that merges gets /ship's full review.
 *
 * Qualifies: RECEIPT_CARRY_PRODUCT_CHANGED on linear history (the receipt's head is an ancestor of HEAD) against the same base.
 * Does not qualify: RECEIPT_CARRY_TREE_MISMATCH (rewritten history: the reviewed commits are gone, so there is no range to
 * diff), a retargeted stack (the reviewed range was against another base), a legacy receipt with no review_depth, more
 * changed product paths than the carry walk names, a path it cannot name, a binary path, base context moved next to reviewed hunks
 * without its scoped-review sections (or with one over PACKET_SECTION_CAP), an unreadable or empty range-diff, a packet over
 * RECHECK_RANGE_DIFF_CAP lines or RECHECK_PACKET_BYTES bytes, and every RECEIPT_CARRY_REFUSED / RECEIPT_CARRY_PREGATE_STALE (those need
 * their inputs repaired, not a review).
 *
 * Moved base context composes (GST-1561, founderstar#563): the context paths' scoped-review sections (lib/ship-patch.ts contextPacket)
 * join the range-diff in the one packet, and the caps count both.
 */
import { createHash } from 'node:crypto';

export const RECHECK_RANGE_DIFF_CAP = 400;
/** The packet's byte cap: 400 lines of unbounded width (a minified bundle) would not bound the one reader's input. */
export const RECHECK_PACKET_BYTES = 64 * 1024;
/** rangeDiff: \`git range-diff\` of the two ranges followed by the diff of the changed product paths between the heads (a range-diff names added commits without their content). */
export type RecheckInput = {
  code: string; ancestor: boolean; retarget: boolean; rangeDiff: string | null; unnamedPaths?: boolean;
  /** The receipt records no review_depth (a legacy receipt), so carry cannot compare HEAD's risk class with the reviewed one. */
  legacy?: boolean;
  /** A changed product path is binary, so the packet would show only "Binary files … differ" for it. */
  binary?: boolean;
  /** The changed-path walk stopped at CARRY_NAMED_PATHS, so later changed product paths would be missing from the packet. */
  walkCut?: boolean;
  /** Paths whose only difference is base context next to reviewed hunks: the packet needs their scoped-review sections (`context`). */
  contextPaths?: number;
  /** contextPacket's sections for those paths, and every path with a section over PACKET_SECTION_CAP. */
  context?: { text: string; over: readonly string[] };
};
export type RecheckPlan = { ok: true; lines: number; sha256: string } | { ok: false; reason: string };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Whether a carry refusal may take the scoped re-check, and the range-diff a verdict must bind to. */
export function planRecheck(i: RecheckInput): RecheckPlan {
  if (i.code !== 'RECEIPT_CARRY_PRODUCT_CHANGED') return { ok: false, reason: `${i.code} is not a product change a review can clear` };
  if (!i.ancestor) return { ok: false, reason: 'rewritten history: the reviewed head is not an ancestor of HEAD, so there is no range to diff' };
  if (i.retarget) return { ok: false, reason: 'the receipt was reviewed against another base (a retargeted stack)' };
  if (i.legacy) return { ok: false, reason: 'the receipt records no review_depth, so a changed risk class could not be caught' };
  if (i.walkCut) return { ok: false, reason: 'more changed product paths than the walk names, so the packet would miss some' };
  if (i.unnamedPaths) return { ok: false, reason: 'a changed product path could not be named, so the packet would miss it' };
  if (i.binary) return { ok: false, reason: 'a changed product path is binary, so the packet cannot show its contents' };
  if (i.contextPaths && !i.context) return { ok: false, reason: 'base context also moved next to reviewed hunks, which needs the scoped review of those hunks' };
  if (i.context?.over.length) return { ok: false, reason: `base context next to reviewed hunks in ${i.context.over.join(', ')} is over the scoped review's section cap` };
  if (i.rangeDiff === null) return { ok: false, reason: 'git range-diff failed or timed out' };
  if (!i.rangeDiff.trim()) return { ok: false, reason: 'git range-diff is empty, so it shows nothing for a reader to check' };
  const text = packetMaterial(i.rangeDiff, i.context?.text);
  const lines = text.split('\n').length;
  if (lines > RECHECK_RANGE_DIFF_CAP) return { ok: false, reason: `${i.context ? 'the packet' : 'git range-diff'} is ${lines} lines, over the scoped re-check cap of ${RECHECK_RANGE_DIFF_CAP}` };
  const bytes = Buffer.byteLength(text);
  if (bytes > RECHECK_PACKET_BYTES) return { ok: false, reason: `the packet is ${bytes} bytes, over the scoped re-check cap of ${RECHECK_PACKET_BYTES}` };
  return { ok: true, lines, sha256: sha(text) };
}

/** What the RECHECK line's range_diff_sha256 names: the range-diff, then any moved base context's scoped-review sections. */
const packetMaterial = (rangeDiff: string, context?: string) => (context ? `${rangeDiff.trim()}\n\n${context.trim()}` : rangeDiff.trim());

/** The packet an advisory reader reads: what to judge, that it carries nothing, then the range-diff verbatim and any moved base context. */
export function recheckPacket(o: { from: string; head: string; plan: Extract<RecheckPlan, { ok: true }>; rangeDiff: string; context?: string; rangeBase?: string }): string {
  return [
    `# Scoped re-check (advice only): the product patch changed since the reviewed head\n`,
    `reviewed ${o.from}${o.context ? ` (range_base ${o.rangeBase})` : ''}; current ${o.head}. Below is \`git range-diff\` of the reviewed range against the current one, then the diff of the changed product paths between the two heads${o.context ? ', then the hunks where base context moved next to the reviewed ones' : ''} (${o.plan.lines} lines).`,
    'Review only what changed between the two ranges, against the blocking floor: would fail a test, break production, or lose data or secrets.',
    'Reply NO FINDINGS, or one finding per line with path:line, Severity and Blocks.',
    'This read is advice for the lane only. It never carries the receipt: the head that merges still gets a full review from /ship (GST-2673; docs/review-policy.md#rounds-per-pull-request).\n',
    '```diff', o.rangeDiff.trim(), '```', '', ...(o.context ? [o.context.trim(), ''] : []),
  ].join('\n');
}
