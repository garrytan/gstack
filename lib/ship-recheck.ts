/**
 * J1 (GSTA-258 plan H, relabeled J1): a scoped re-check after a refused receipt carry. When `gstack-ship-receipt carry` refuses
 * because the product patch changed since the reviewed head, and the change is bounded, one reader reads `git range-diff` of
 * the reviewed range against the current one instead of a full second /ship (gbrain-evals #246/#247: about 100k credits per
 * full rerun; #300's scoped reader: about 300). A clean verdict bound to that exact range-diff rebinds the receipt; the carry's
 * later checks still refuse a deeper review depth or a changed risk class, which need the full /ship.
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
 * join the range-diff in the one packet, the caps count both, the verdict binds both, and the record also names range_base, the
 * commit the reviewed range starts from.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

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

/** What range_diff_sha256 binds: the range-diff, then any moved base context's scoped-review sections. */
const packetMaterial = (rangeDiff: string, context?: string) => (context ? `${rangeDiff.trim()}\n\n${context.trim()}` : rangeDiff.trim());

/** The clean record a reader writes; range_base only when base context composes into the packet. */
export const recheckRecordTemplate = (o: { from: string; head: string; sha256: string; rangeBase?: string }) =>
  JSON.stringify({ from: o.from, head: o.head, ...(o.rangeBase ? { range_base: o.rangeBase } : {}), range_diff_sha256: o.sha256, reader: '<model>', verdict: 'clean' });

/** The packet the one reader reads: what to judge, the record to write, then the range-diff verbatim and any moved base context. */
export function recheckPacket(o: { from: string; head: string; plan: Extract<RecheckPlan, { ok: true }>; rangeDiff: string; context?: string; rangeBase?: string }): string {
  return [
    `# Scoped re-check: the product patch changed since the reviewed head\n`,
    `reviewed ${o.from}${o.context ? ` (range_base ${o.rangeBase})` : ''}; current ${o.head}. Below is \`git range-diff\` of the reviewed range against the current one, then the diff of the changed product paths between the two heads${o.context ? ', then the hunks where base context moved next to the reviewed ones' : ''} (${o.plan.lines} lines).`,
    'Review only what changed between the two ranges, against the blocking floor: would fail a test, break production, or lose data or secrets.',
    `Reply NO FINDINGS, or one finding per line with path:line, Severity and Blocks. A clean reply is recorded as ${recheckRecordTemplate({ ...o, sha256: o.plan.sha256 })}.`,
    'A blocking finding means the full /ship on the current head.\n',
    '```diff', o.rangeDiff.trim(), '```', '', ...(o.context ? [o.context.trim(), ''] : []),
  ].join('\n');
}

export interface RecheckRecord { from: string; head: string; range_base?: string; range_diff_sha256: string; reader: string; verdict: 'clean' }

/** A clean re-check record bound to this carry's from, head and range-diff, or why it does not stand. */
export function readRecheck(file: string, bind: { from: string; head: string; sha256: string; rangeBase?: string }): { ok: true; record: RecheckRecord } | { ok: false; message: string } {
  let v: Record<string, unknown>;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, message: `${file} is not readable JSON (${(e as Error).message.split('\n')[0]})` }; }
  if (!v || typeof v !== 'object') return { ok: false, message: `${file} is not a JSON object` };
  if (v.verdict !== 'clean') return { ok: false, message: `the re-check is ${JSON.stringify(v.verdict)}, not clean: run /ship on ${bind.head.slice(0, 12)}` };
  if (typeof v.reader !== 'string' || !v.reader.trim()) return { ok: false, message: 'the re-check names no reader' };
  for (const [k, want] of [['from', bind.from], ['head', bind.head], ['range_diff_sha256', bind.sha256], ...(bind.rangeBase ? [['range_base', bind.rangeBase] as const] : [])] as const) {
    if (v[k] !== want) return { ok: false, message: `the re-check is for ${k} ${String(v[k] ?? 'none').slice(0, 12)}, not ${want.slice(0, 12)}` };
  }
  return { ok: true, record: v as unknown as RecheckRecord };
}
