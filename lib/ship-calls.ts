/**
 * ship-calls — a driven /ship's parent calls, counted from the host's transcript events
 * (Capy: tools.thread.get transcript items), so acceptance never rests on the agent's own
 * count (GSTA-167 calls plan, C9). Every tool item is one parent call. A keep-alive is a
 * wait, or a program that only reads status (subagent, operation or thread reads) plus at
 * most one bash for its budget note; everything else is a decision call. A gap over 300 s
 * between calls outlives the prompt cache, so the next call is billed fresh.
 */
export interface TranscriptItem { source?: string; tool?: string; calls?: Array<{ tool?: string }>; createdAt?: string }
export interface CallCount { total: number; decision: number; keepalive: number; idleGaps: number; maxGapS: number; first: string | null; last: string | null }

const STATUS_READS = new Set(['subagent_get', 'subagent_list', 'operation_get', 'operation_list', 'thread_get']);
export const CACHE_TTL_S = 300;

function isKeepalive(item: TranscriptItem): boolean {
  if (item.tool === 'wait') return true;
  if (item.tool !== 'execute') return false;
  const calls = (item.calls ?? []).map(c => c.tool ?? '');
  const reads = calls.filter(t => STATUS_READS.has(t)).length;
  const bash = calls.filter(t => t === 'bash').length;
  return reads > 0 && reads + bash === calls.length && bash <= 1;
}

export function countCalls(items: readonly TranscriptItem[], window: { since?: string; until?: string } = {}): CallCount {
  const calls = items.filter(i => i.source === 'tool' && i.createdAt
    && (!window.since || i.createdAt >= window.since) && (!window.until || i.createdAt <= window.until))
    .sort((a, b) => a.createdAt!.localeCompare(b.createdAt!));
  let idleGaps = 0, maxGapS = 0;
  for (let k = 1; k < calls.length; k++) {
    const gap = Math.round((Date.parse(calls[k]!.createdAt!) - Date.parse(calls[k - 1]!.createdAt!)) / 1000);
    if (gap > CACHE_TTL_S) idleGaps++;
    maxGapS = Math.max(maxGapS, gap);
  }
  const keepalive = calls.filter(isKeepalive).length;
  return { total: calls.length, decision: calls.length - keepalive, keepalive, idleGaps, maxGapS,
    first: calls[0]?.createdAt ?? null, last: calls[calls.length - 1]?.createdAt ?? null };
}

export const callsLine = (c: CallCount, source: string) =>
  `CALLS: total=${c.total} decision=${c.decision} keepalive=${c.keepalive} idle_gaps_over_300s=${c.idleGaps} max_gap_s=${c.maxGapS} first=${c.first ?? 'none'} last=${c.last ?? 'none'} source=${source}`;
