/**
 * The receipt-versus-prose number check (/ship Step 19, docs/ship-policy.md#ship-receipt):
 * a PR body that quotes a counter the receipt also records (review passes,
 * deferred findings, gate case counts) must quote the receipt's number.
 * `gstack-ship-receipt read --check-prose` runs it; a disagreement is
 * RECEIPT_PROSE_MISMATCH. Prose that quotes no receipt counter is not a claim.
 */
import { APPROVALS_FOOTER_END, APPROVALS_TABLE_HEADER } from './approval-record';
import { RECEIPT_FENCE } from './ship-receipt';
import { parseReviewLoopException, reviewLoopExceptionLine } from './ship-receipt-depth';
import { docsExceptionLine, parseReceiptDocs } from './ship-receipt-docs';
import { ruledNoteText, type RuledNote } from './ruled-notes';
import { laneExceptionBodyLines } from './test-lane-exception';

export interface ProseClaim { field: string; prose: number; receipt: number }
export interface ProseCheck { checked: number; mismatches: ProseClaim[] }

/** Integer leaves of the receipt under the counter-bearing keys, as `parent.key` → value. */
export function receiptCounters(receipt: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (value: unknown, prefix: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, leaf] of Object.entries(value as Record<string, unknown>)) {
      if (Number.isInteger(leaf)) out.set(prefix ? `${prefix}.${key}` : key, leaf as number);
      else walk(leaf, prefix ? `${prefix}.${key}` : key);
    }
  };
  for (const key of ['review_loop', 'gate', 'ci']) walk(receipt[key], key);
  return out;
}

const BLOCK_RE = new RegExp('```' + RECEIPT_FENCE + '[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n```', 'g');
const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const fenceClose = (fence: string) => new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);

/**
 * The body without its closed code fences (GST-984): pasted test output (`113 pass, 0 fail`) and quoted code
 * (`the first 35 failing`) are evidence, not this PR's counters. The fence rules are withoutApprovalsBlocks' (a fence
 * closes only on a run of its own character at least as long as the opener with nothing after it). A backtick run with
 * another backtick later on its line (```npm test``` inline code) opens no fence, as in CommonMark. A fence that never
 * closes stays prose, and so does the rest of the body, so an unclosed opener cannot hide the claims after it or let a
 * shorter fence inside it hide them. A marker line takes each fence's place so the text on either side never joins
 * into a claim.
 */
function withoutFences(body: string): string {
  const lines = body.split(/(?<=\n)/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r?\n$/, '');
    const open = FENCE_OPEN.exec(line);
    if (!open || (open[1]![0] === '`' && line.slice(open[0].length).includes('`'))) { out.push(lines[i]!); continue; }
    const close = fenceClose(open[1]!);
    const end = lines.findIndex((l, j) => j > i && close.test(l.replace(/\r?\n$/, '')));
    if (end < 0) return out.join('') + lines.slice(i).join('');
    out.push('(code fence)\n');
    i = end;
  }
  return out.join('');
}

/**
 * The body without the `## Approvals` blocks gstack-approvals renders (lib/approval-record.ts renderRecord): the
 * heading, the Date | Asked | Exact words table and its `Source: gstack-approvals record for …` footer. Those rows
 * quote the owner's words (`one Step 11 pass`), not this PR's counters (GST-412). A heading inside a code fence is
 * not a heading, with the fence rules of splitSections in lib/gstack-post.ts (a fence closes only on a run of its own
 * character at least as long as the opener with nothing after it), and CRLF reads as LF. A heading not followed by
 * exactly that table and footer, a row the renderer would not write (six cells, a date first), and any text after
 * the footer stay prose. A marker line takes the block's place so the text on either side never joins into a claim.
 */
function withoutApprovalsBlocks(body: string): string {
  const lines = body.split(/(?<=\n)/);
  const bare = (i: number) => (lines[i] ?? '').replace(/\r?\n$/, '');
  const skipBlank = (i: number) => { while (i < lines.length && bare(i).trim() === '') i++; return i; };
  const blockEnd = (heading: number): number | undefined => {
    let i = skipBlank(heading + 1);
    if (bare(i) !== APPROVALS_TABLE_HEADER || !/^\|(?:---\|)+$/.test(bare(i + 1))) return undefined;
    for (i += 2; bare(i).startsWith('|'); i++) if (!/^\| \d{4}-\d{2}-\d{2} \|/.test(bare(i)) || bare(i).split(/(?<!\\)\|/).length !== 8) return undefined;
    i = skipBlank(i);
    return bare(i).startsWith('Source: gstack-approvals record for ') && bare(i).endsWith(APPROVALS_FOOTER_END) ? i : undefined;
  };
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = bare(i);
    if (fence !== null) {
      if (fenceClose(fence).test(line)) fence = null;
    } else if (FENCE_OPEN.test(line)) fence = FENCE_OPEN.exec(line)![1]!;
    else if (/^ {0,3}## Approvals\s*$/.test(line)) {
      const end = blockEnd(i);
      if (end !== undefined) { out.push('(gstack-approvals block)\n'); i = end; continue; }
    }
    out.push(lines[i]!);
  }
  return out.join('');
}

/**
 * The body without the exception lines the receipt's own exceptions require: the `Review-loop exception: …` line
 * (GST-977), the `Documentation exception: …` line (GST-983) and each `Ruled note: …`, `Mechanical retake: …` and `Test-lane exception: …` line (GST-1537, GST-1560, GST-1595). write and the receipt check want each word for word,
 * and each quotes the owner's reason (`outside 1 and 2 skip detector`), not this PR's counters. Only a line whose
 * trimmed text is a rendered line, the test write applies, is left out; the same words inside a longer line stay
 * prose. A marker line takes its place so the text on either side never joins into a claim.
 */
function withoutExceptionLines(body: string, receipt: Record<string, unknown>): string {
  const lines = new Set<string>();
  const loop = receipt.review_loop_exception === undefined ? undefined : parseReviewLoopException(receipt.review_loop_exception);
  if (loop?.ok) lines.add(reviewLoopExceptionLine(loop.exception));
  const docs = receipt.docs === undefined ? undefined : parseReceiptDocs(receipt.docs);
  const docsLine = docs?.ok ? docsExceptionLine(docs.docs) : null;
  if (docsLine) lines.add(docsLine);
  if (Array.isArray(receipt.ruled_notes)) for (const n of receipt.ruled_notes) lines.add(`Ruled note: ${ruledNoteText(n as RuledNote)}`);
  if (Array.isArray(receipt.mechanical)) for (const l of receipt.mechanical) if (typeof l === 'string') lines.add(l);
  for (const l of laneExceptionBodyLines(receipt.ci_carried)) lines.add(l);
  if (!lines.size) return body;
  return body.split(/(?<=\n)/).map(l => (lines.has(l.trim()) ? '(exception line)\n' : l)).join('');
}

/**
 * Every `<name>=<n>`, `<name>: <n>` and `<n> <name>` in the prose (the body
 * without its receipt block, its code fences, its rendered Approvals block and its exception lines), where `<name>` is a counter's leaf key with `_`
 * matched as `_`, space or `-` and not part of a longer word (`3 pass-through`
 * is not a `pass` claim), compared with the receipt. A leaf key shared by
 * several counters (`pass` under every gate lane, `passed` under gate and ci)
 * names any of them: the claim matches when its number equals one of those
 * counters, and a mismatch names the first of them. A number that is the value
 * of a `key=` or `key:` pair is that key's claim alone, never the start of a
 * `<n> <name>` claim about the next key (#3513).
 */
export function checkReceiptProse(receipt: Record<string, unknown>, body: string): ProseCheck {
  const prose = withoutExceptionLines(withoutApprovalsBlocks(withoutFences(body.replace(BLOCK_RE, ''))), receipt);
  const byLeaf = new Map<string, Array<{ field: string; value: number }>>();
  for (const [field, value] of receiptCounters(receipt)) {
    const leaf = field.split('.').at(-1)!;
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), { field, value }]);
  }
  const pattern = (leaf: string) => leaf.replace(ESCAPE, '\\$&').replaceAll('_', '[ _-]');
  // The number-then-name branch must not start on a `key=value` or `key: value` pair's value: in `passes=2 blocking_found=1`
  // and `passes: 2 blocking_found: 1` the 2 is passes' claim, not a "2 blocking_found" one. The offsets of every counter
  // key's value are collected first, whatever the whitespace around the separator, and a claim starting there is skipped.
  const values = new Set<number>();
  for (const leaf of byLeaf.keys()) for (const m of prose.matchAll(new RegExp(`(?<![\\w-])${pattern(leaf)}\\s*[=:]\\s*(?=\\d)`, 'gi'))) values.add(m.index + m[0].length);
  const mismatches: ProseClaim[] = [];
  let checked = 0;
  for (const [leaf, counters] of byLeaf) {
    const name = pattern(leaf);
    const re = new RegExp(`(?:(?<![\\w-])${name}\\s*[=:]\\s*(\\d+)\\b|(?<![=:\\w.-])(\\d+)\\s+${name}(?![\\w-]))`, 'gi');
    for (let m = re.exec(prose); m; m = re.exec(prose)) {
      // A skipped value hands the scan back right after its digits, so the key that follows still makes its own pair claim.
      if (m[2] !== undefined && values.has(m.index)) { re.lastIndex = m.index + m[2].length; continue; }
      checked++;
      const n = Number(m[1] ?? m[2]);
      if (!counters.some(c => c.value === n)) mismatches.push({ field: counters[0]!.field, prose: n, receipt: counters[0]!.value });
    }
  }
  return { checked, mismatches };
}

export function proseLine(check: ProseCheck): string {
  if (!check.checked) return 'PROSE: no receipt counter claims in the body';
  if (!check.mismatches.length) return `PROSE: ${check.checked} receipt counter claim${check.checked === 1 ? '' : 's'} in the body, all match`;
  return 'PROSE: mismatch ' + check.mismatches.map(m => `${m.field} body=${m.prose} receipt=${m.receipt}`).join('; ');
}
