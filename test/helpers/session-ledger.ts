/**
 * Session ledger: one line per armed model session, appended best-effort to
 * `$GSTACK_EVAL_DIR/session-ledger.jsonl` (the same sidecar pattern as
 * contract-violations.jsonl). Runners record facts here; the record builders
 * (classifyTrialShard, junitCensus) attach them to trial records and
 * failureCauseOf() in eval-store.ts classifies. A failed append never fails
 * a trial: the record then shows its sessions as unknown.
 *
 * Each row holds a stable session key, the exact timeout the session armed,
 * monotonic elapsed time, the end reason, one sanitized evidence line and,
 * for stream-JSON runners, a compact liveness summary (never message text).
 */
import * as fs from 'fs';
import * as path from 'path';

export const SESSION_LEDGER_FILE = 'session-ledger.jsonl';
export const SESSION_EVIDENCE_MAX = 200;
export type SessionRunner = 'claude-p' | 'agent-sdk' | 'pty' | 'codex';
export type SessionEnd = 'completed' | 'session_timeout' | 'observer_timeout' | 'api_error' | 'refusal' | 'aborted' | 'error';
export const SESSION_ENDS: readonly SessionEnd[] = ['completed', 'session_timeout', 'observer_timeout', 'api_error', 'refusal', 'aborted', 'error'];

export interface LivenessSummary {
  /** The session streamed partial messages. Without them no stall is ever inferred. */
  partial: boolean;
  events: number;
  turns: number;
  /** Longest gap between events (or before the end) while a model request was in
   *  flight and no tool call, hook or permission prompt was outstanding. */
  max_request_silence_ms: number;
  /** Elapsed ms when that silence began, and the kind of event before it. */
  silence_started_ms?: number;
  silence_after?: string;
  last_event?: string;
  open_tool_at_end?: string;
}

export interface SessionLedgerRow {
  key: string;
  case?: string;
  test_name?: string;
  runner: SessionRunner;
  started_at: string;
  /** The timeout this session armed; absent when the runner armed none. */
  budget_ms?: number;
  elapsed_ms: number;
  end: SessionEnd;
  evidence?: string;
  liveness?: LivenessSummary;
  /** Whether the runner captured this session's billing (a terminal result with total_cost_usd). */
  billed?: boolean;
}

/** One line, control characters stripped, mentions neutralized, capped. */
export function sessionEvidence(text: string | undefined): string | undefined {
  const first = text?.split('\n').map(line => line.trim()).find(Boolean);
  if (!first) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = first.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
  return clean.length > SESSION_EVIDENCE_MAX ? `${clean.slice(0, SESSION_EVIDENCE_MAX - 1)}…` : clean;
}

const ordinals = new Map<string, number>();

/** Stable within a case: `<runner>:<label>#<n>`, n counting this label's sessions in this process. */
export function sessionKey(runner: SessionRunner, label: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const base = `${runner}:${label || env.GSTACK_EVAL_CASE_ID || 'session'}`;
  const n = (ordinals.get(base) ?? 0) + 1;
  ordinals.set(base, n);
  return `${base}#${n}`;
}

/** Best-effort append; a missing GSTACK_EVAL_DIR or a write error records nothing. */
export function appendSessionLedger(row: Omit<SessionLedgerRow, 'case'> & { case?: string }, env: NodeJS.ProcessEnv = process.env): void {
  const dir = env.GSTACK_EVAL_DIR;
  if (!dir) return;
  const caseId = env.GSTACK_EVAL_CASE_ID || row.case;
  const out: SessionLedgerRow = { ...row, ...(caseId ? { case: caseId } : {}), elapsed_ms: Math.max(0, Math.round(row.elapsed_ms)),
    ...(row.evidence ? { evidence: sessionEvidence(row.evidence) } : {}) };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, SESSION_LEDGER_FILE), JSON.stringify(out) + '\n');
  } catch { /* diagnostics never fail a trial */ }
}

/** Rows of one eval dir; malformed lines are skipped. */
export function readSessionLedger(evalDir: string | undefined): SessionLedgerRow[] {
  if (!evalDir) return [];
  let text = '';
  try { text = fs.readFileSync(path.join(evalDir, SESSION_LEDGER_FILE), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line);
      return row && typeof row.key === 'string' && SESSION_ENDS.includes(row.end) && Number.isFinite(row.elapsed_ms) ? [row as SessionLedgerRow] : [];
    } catch { return []; }
  });
}

const REFUSAL_PHRASE = /safeguards flagged this message|can't respond to this message/i;

/**
 * Facts from a stream-JSON session (claude -p NDJSON or Agent SDK messages),
 * fed one event at a time with its arrival time. Structured refusal and API
 * error signals win; a refusal phrase is read only from the final result or a
 * synthetic CLI message, never from tool results. Liveness counts every event,
 * thinking deltas included.
 */
export class SessionObserver {
  private partial = false;
  private events = 0;
  private turnIds = new Set<string>();
  private requesting = true;
  private openTools = new Map<string, string>();
  private hooks = 0;
  private permissions = 0;
  private lastAt: number;
  private lastKind = 'start';
  private maxSilence = 0;
  private silenceStart?: number;
  private silenceAfter?: string;
  private refusal?: string;
  private apiError?: string;
  private phraseRefusal?: string;
  /** A terminal result carried total_cost_usd. */
  billed = false;

  constructor(private readonly startedAt: number) { this.lastAt = startedAt; }

  /** A permission prompt opened (+1) or settled (-1); SDK canUseTool callbacks. */
  permission(delta: 1 | -1): void { this.permissions = Math.max(0, this.permissions + delta); }

  private gap(at: number): void {
    const silence = at - this.lastAt;
    if (this.requesting && this.openTools.size === 0 && this.hooks === 0 && this.permissions === 0 && silence > this.maxSilence) {
      this.maxSilence = silence;
      this.silenceStart = this.lastAt - this.startedAt;
      this.silenceAfter = this.lastKind;
    }
  }

  observe(event: any, at: number): void {
    if (!event || typeof event !== 'object') return;
    this.gap(at);
    this.events++;
    let kind = String(event.type ?? 'unknown');
    if (event.type === 'stream_event') {
      this.partial = true;
      const inner = event.event ?? {};
      kind = inner.type === 'content_block_delta' && inner.delta?.type ? String(inner.delta.type) : String(inner.type ?? 'stream_event');
      if (inner.type === 'message_start') this.requesting = true;
      if (inner.type === 'message_stop') this.requesting = false;
    } else if (event.type === 'assistant') {
      const message = event.message ?? {};
      if (!event.parent_tool_use_id && typeof message.id === 'string') this.turnIds.add(message.id);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') this.openTools.set(block.id, String(block.name ?? 'tool'));
      }
      if (!this.partial && this.openTools.size > 0) this.requesting = false;
      if (message.stop_reason === 'refusal') this.refusal ??= this.refusalLine('stop_reason refusal', message.stop_details?.category);
      const text = (Array.isArray(message.content) ? message.content : []).filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n');
      if (message.model === '<synthetic>') this.noteResultText(text);
    } else if (event.type === 'user') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type === 'tool_result') this.openTools.delete(block.tool_use_id);
      }
      if (this.openTools.size === 0) this.requesting = true;
    } else if (event.type === 'system') {
      const subtype = String(event.subtype ?? '');
      kind = `system:${subtype}`;
      if (subtype === 'hook_started') this.hooks++;
      if (subtype === 'hook_response') this.hooks = Math.max(0, this.hooks - 1);
      if (subtype === 'model_refusal_no_fallback') this.refusal ??= this.refusalLine(subtype, event.api_refusal_category);
    } else if (event.type === 'result') {
      this.requesting = false;
      if (typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd)) this.billed = true;
      if (event.stop_reason === 'refusal') this.refusal ??= this.refusalLine('result stop_reason refusal', undefined);
      if (event.is_error === true && typeof event.result === 'string') this.noteResultText(event.result);
    }
    this.lastAt = at;
    this.lastKind = kind;
  }

  private refusalLine(source: string, category: unknown): string {
    return `refusal at turn ${Math.max(1, this.turnIds.size)} (${source})${typeof category === 'string' && category ? ` — ${category}` : ''}`;
  }

  private noteResultText(text: string): void {
    const line = text.split('\n').map(l => l.trim()).find(l => /^API Error:/i.test(l));
    if (!line) return;
    if (REFUSAL_PHRASE.test(text)) this.phraseRefusal ??= `refusal at turn ${Math.max(1, this.turnIds.size)} (phrase) — ${line}`;
    else this.apiError ??= line;
  }

  /** Structured end evidence seen so far: refusal first, then API error, then a refusal phrase. */
  verdict(): { end: 'refusal' | 'api_error'; evidence: string } | null {
    if (this.refusal) return { end: 'refusal', evidence: this.refusal };
    if (this.apiError) return { end: 'api_error', evidence: this.apiError };
    if (this.phraseRefusal) return { end: 'refusal', evidence: this.phraseRefusal };
    return null;
  }

  /** Close the observation at `at` (the final silence counts) and summarize. */
  summary(at: number): LivenessSummary {
    this.gap(at);
    const open = [...this.openTools.values()].at(-1);
    return {
      partial: this.partial, events: this.events, turns: this.turnIds.size,
      max_request_silence_ms: this.partial ? Math.round(this.maxSilence) : 0,
      ...(this.partial && this.silenceStart !== undefined ? { silence_started_ms: Math.round(this.silenceStart), silence_after: this.silenceAfter } : {}),
      last_event: this.lastKind,
      ...(open ? { open_tool_at_end: open } : {}),
    };
  }
}
