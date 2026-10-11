/**
 * ship-receipt — the handoff record, identifiers first (plan C5). Renders the
 * ```gstack-ship-receipt``` block from the `ship-receipt` schema in
 * lib/headless-artifacts.ts, puts it first in a PR body so truncation loses
 * prose rather than identifiers, reads it back from a PR through `gh`, and
 * computes the P7 adoption census over merged PRs (deduplicated by run and
 * thread id against an owner-maintained thread cohort).
 */
import { ARTIFACT_SCHEMAS, checkSchema, type ShipReceipt, type ValidationError } from './headless-artifacts';

export const RECEIPT_FENCE = 'gstack-ship-receipt';
const KEY_ORDER: Array<keyof ShipReceipt> = [
  'schema_version', 'pr', 'head', 'version', 'base', 'gated_tree', 'predecessor', 'tree', 'gate_reuse', 'gate', 'ci', 'spend_usd',
  'session_kind', 'artifacts_consumed', 'run', 'thread', 'policy', 'queue_mode', 'preregistration', 'history',
  'pregate', 'requires_remote', 'issues',
];

/** Keys in the fixed order so identifiers lead; undefined values are dropped. */
export function orderReceipt(input: Partial<ShipReceipt>): ShipReceipt {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (input[key] !== undefined) out[key] = input[key];
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

/** The first receipt block in a PR body, parsed; `found: false` when absent. */
export function extractReceipt(body: string): { found: boolean; receipt?: ShipReceipt; raw?: string; errors: ValidationError[] } {
  const m = BLOCK_RE.exec(body);
  if (!m) return { found: false, errors: [] };
  try {
    const parsed = JSON.parse(m[1]!);
    return { found: true, receipt: parsed, raw: m[1], errors: validateReceipt(parsed) };
  } catch (e: any) {
    return { found: true, raw: m[1], errors: [{ code: 'RECEIPT_INVALID', path: 'ship-receipt', message: `block is not JSON: ${e.message}` }] };
  }
}

/** The block becomes the first section of the body: an existing block is replaced in place at the top, prose follows. */
export function placeReceiptFirst(body: string, receipt: ShipReceipt): string {
  const block = renderReceiptBlock(receipt);
  const stripped = body.replace(BLOCK_RE, '').replace(/^\s+/, '');
  return block + (stripped ? '\n' + stripped : '');
}

/** The first lines of the completion message to the coordinator: identifiers only. */
export function receiptSummaryLine(r: ShipReceipt): string {
  const parts = [`pr=${r.pr ?? '-'}`, `head=${r.head.slice(0, 12)}`, `version=${r.version ?? '-'}`, `base=${r.base}`];
  if (r.gated_tree) parts.push(`gated_tree=${r.gated_tree.slice(0, 12)}`);
  if (r.tree) parts.push(`tree=${r.tree}`);
  if (r.gate_reuse) parts.push(`gate-reuse=${r.gate_reuse}`);
  if (r.predecessor) parts.push(`predecessor=${r.predecessor.slice(0, 12)}`);
  if (r.session_kind) parts.push(`session_kind=${r.session_kind}`);
  if (r.artifacts_consumed) parts.push(`artifacts_consumed=${r.artifacts_consumed}`);
  return `SHIP_RECEIPT: ${parts.join(' ')}`;
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
