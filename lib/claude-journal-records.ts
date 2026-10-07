/**
 * One reading of a Claude Code journal record, shared by the batch reader
 * (`readPlanCountTranscript`) and the guard's bounded owned reader
 * (`lib/claude-owned-journal.ts`), so the two cannot drift: the public events a
 * record yields, the metadata its ownership is judged on, and the ownership,
 * ancestry and causal-order checks over that metadata.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Optional public tool projection for the Autoplan delivery audit; never thinking. */
export interface NativePublicToolEvent {
  sessionId: string;
  timestamp: string;
  toolUseId: string;
  kind: 'use' | 'result';
  name?: string;
  /** Exact native message/request identity, used only for owned queued tools. */
  messageId?: string;
  requestId?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  file?: unknown;
  isError?: boolean;
  /** Owned reads only: Claude Code launched this Agent in the background (its result is a launch receipt). */
  async?: boolean;
}

/** Hook-only verified causal order (physical order for independent ready records). The existing fixture projection remains unchanged. */
export type ClaudeParentPublicEvent = (NativePublicToolEvent | {
  kind: 'message'; sessionId: string; timestamp: string; text: string;
} | {
  kind: 'end_turn' | 'user_turn'; sessionId: string; timestamp: string; autoplan?: boolean;
} | {
  /** Claude Code's completion notice for a background Agent (origin kind task-notification). */
  kind: 'task_notification'; sessionId: string; timestamp: string; notifiedToolUseId: string;
}) & { order: number; messageId?: string; requestId?: string };

/**
 * Why an owned journal supplied no owned lines (docs/autoplan-guard-troubleshooting.md).
 * Positive identity conflicts are hard; only `unrecognized_shape:*` may degrade to an advisory.
 */
export type OwnedTranscriptReason = 'competing_root' | 'foreign_cwd' | 'sidechain' | 'agent' | 'cycle' | 'too_large' |
  'rewritten' | 'oversized_invocation' | 'identity' | 'malformed' | `unrecognized_shape:${string}`;

export const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
/** A record's own Claude Code version string, shape-checked; never other content. */
export const claudeVersionOf = (record: Record<string, any>): string | undefined =>
  typeof record.version === 'string' && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,24}$/.test(record.version) ? record.version : undefined;
const versions = new Map<string, string | undefined>();
/** claudeVersionOf for a record's index entry: one check per distinct version string. */
const indexedVersion = (record: Record<string, any>): string | undefined => {
  if (typeof record.version !== 'string') return;
  if (!versions.has(record.version) && versions.size < 64) versions.set(record.version, claudeVersionOf(record));
  return versions.has(record.version) ? versions.get(record.version) : claudeVersionOf(record);
};
/** A native record uuid: 8-4-4-4-12 hex digits (checked per character; every record has two). */
export const nativeUuid = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const c = value.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) { if (c !== 45) return false; }
    else if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
  }
  return true;
};

/**
 * Windows spells one native path C:\, c:\, C:/ or Git Bash /c/ (hook env,
 * journal and tool input disagree). Fold separators, the MSYS drive prefix and
 * drive-letter case only. No resolve: `.`, `..` and doubled separators stay
 * distinct, so a normalize check after the fold still rejects them. The path
 * module is a parameter so win32 call sites are unit-testable on any host.
 */
export function nativePathSpelling(value: string, p: typeof path = path): string {
  if (p.sep !== '\\') return value;
  return value.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:').replaceAll('/', '\\')
    .replace(/^[a-z](?=:)/, drive => drive.toUpperCase());
}
/** Validation-then-compare: absolute, and its folded spelling is already normal. */
export function ownedNativePath(value: unknown, p: typeof path = path): value is string {
  if (typeof value !== 'string') return false;
  const folded = nativePathSpelling(value, p);
  return p.isAbsolute(folded) && p.normalize(folded) === folded;
}
export function sameNativePath(a: unknown, b: unknown, p: typeof path = path): boolean {
  return typeof a === 'string' && typeof b === 'string' && nativePathSpelling(a, p) === nativePathSpelling(b, p);
}
function sameRealPath(a: unknown, b: unknown): boolean {
  try { return typeof a === 'string' && typeof b === 'string' && sameNativePath(fs.realpathSync(a), fs.realpathSync(b)); }
  catch { return false; }
}

/** Read one length-delimited protobuf field, rejecting malformed/ambiguous input. */
function signatureField(bytes: Uint8Array | undefined, wanted: number): Uint8Array | undefined {
  if (!bytes) return;
  let cursor = 0;
  let result: Uint8Array | undefined;
  let seen = false;
  const integer = () => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (cursor >= bytes.length) throw new Error('truncated signature');
      const byte = bytes[cursor++]!;
      value += (byte & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) throw new Error('signature integer overflow');
      if (!(byte & 128)) return value;
    }
    throw new Error('overlong signature integer');
  };
  while (cursor < bytes.length) {
    const key = integer();
    const field = Math.floor(key / 8);
    if (field < 1 || field > 0x1fffffff) throw new Error('invalid signature field');
    if (field === wanted) {
      if (seen) throw new Error('duplicate signature field');
      seen = true;
    }
    switch (key % 8) {
      case 0: integer(); break;
      case 1: cursor += 8; break;
      case 2: {
        const length = integer();
        if (length > bytes.length - cursor) throw new Error('truncated signature field');
        if (field === wanted) result = bytes.subarray(cursor, cursor + length);
        cursor += length;
        break;
      }
      case 5: cursor += 4; break;
      default: throw new Error('unsupported signature wire type');
    }
    if (cursor > bytes.length) throw new Error('truncated signature field');
  }
  return result;
}

/**
 * Claude's public narration renderer classifies signature fields 2→1→8 as
 * block_kind="narration": summaries of inter-tool prose, not private reasoning.
 * Match that metadata only in this already-owned native transcript. This is
 * classification, not cryptographic signature verification. Never read the
 * thinking text of an untagged, unknown, malformed or legacy block.
 */
function publicNarrationText(block: Record<string, any>): string | undefined {
  if (block.type !== 'thinking' || typeof block.signature !== 'string' ||
      block.signature.length > 64 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.signature)) return;
  try {
    const bytes = Buffer.from(block.signature, 'base64');
    const canonical = bytes.toString('base64');
    if (block.signature !== canonical && block.signature !== canonical.replace(/=+$/, '')) return;
    const tag = signatureField(signatureField(signatureField(bytes, 2), 1), 8);
    if (!tag || Buffer.from(tag).toString('utf8') !== 'narration') return;
    return typeof block.thinking === 'string' && block.thinking.trim() ? block.thinking : undefined;
  } catch { return; }
}

const AUTOPLAN_SLASH = /^<command-message>autoplan<\/command-message>\n<command-name>\/autoplan<\/command-name>(?:\n<command-args>[\s\S]*<\/command-args>)?$/;

/**
 * The public events one record yields, for a record its reader already
 * accepted (it carries a message object). `owned` adds the hook-only events
 * (user turns, end_turn, background completions) and each event's position
 * inside the record as `order`; the caller adds the record's base. The batch
 * projection (`owned` false) keeps its validated batch identity and no order.
 */
export function recordEvents(record: Record<string, any>, owned: boolean,
  timestampValid = validTimestamp(record.timestamp)): { events: ClaudeParentPublicEvent[]; slots: number } {
  const events: ClaudeParentPublicEvent[] = [], message = record.message, sessionId = record.sessionId, timestamp = record.timestamp;
  let slot = 0;
  if (owned && message.role === 'user') {
    const notified = record.origin?.kind === 'task-notification' && typeof message.content === 'string'
      ? /<tool-use-id>([A-Za-z0-9_-]{1,160})<\/tool-use-id>/.exec(message.content)?.[1] : undefined;
    if (notified) events.push({ kind: 'task_notification', sessionId, timestamp, order: slot++, notifiedToolUseId: notified });
    if (record.origin?.kind === 'human' && record.isMeta !== true && nativeUuid(record.promptId) && typeof message.content === 'string') {
      const autoplan = AUTOPLAN_SLASH.test(message.content);
      if (record.promptSource === 'typed' || autoplan) events.push({ kind: 'user_turn', sessionId, timestamp, order: slot++, autoplan });
    }
  }
  if (!Array.isArray(message.content)) return { events, slots: slot };
  if (!timestampValid) slot += message.content.length;
  else for (const block of message.content) {
    const order = slot++;
    if (!object(block)) continue;
    let event: Record<string, unknown> | undefined;
    if (message.role === 'assistant' && block.type === 'tool_use' &&
        typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
      event = { sessionId, timestamp, toolUseId: block.id, kind: 'use', name: block.name, input: block.input };
      if (!owned && typeof message.id === 'string' && /^msg_[A-Za-z0-9_-]{1,160}$/.test(message.id) &&
          typeof record.requestId === 'string' && /^req_[A-Za-z0-9_-]{1,160}$/.test(record.requestId)) {
        event.messageId = message.id; event.requestId = record.requestId;
      }
    } else if (message.role === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      event = { sessionId, timestamp, toolUseId: block.tool_use_id, kind: 'result', content: block.content,
        file: record.toolUseResult?.file, isError: block.is_error === true };
      if (owned && record.toolUseResult?.isAsync === true) event.async = true;
    } else if (message.role === 'assistant') {
      const text = block.type === 'text' && typeof block.text === 'string' && block.text.trim() ? block.text : publicNarrationText(block);
      if (text) event = { kind: 'message', sessionId, text, timestamp };
    }
    if (!event) continue;
    if (owned) {
      event.order = order;
      if (typeof message.id === 'string') event.messageId = message.id;
      if (typeof record.requestId === 'string') event.requestId = record.requestId;
    }
    events.push(event as unknown as ClaudeParentPublicEvent);
  }
  if (owned && message.role === 'assistant' && message.stop_reason === 'end_turn')
    events.push({ kind: 'end_turn', sessionId, timestamp, order: slot++, ...(typeof message.id === 'string' ? { messageId: message.id } : {}) });
  return { events, slots: slot };
}

/** What the ownership checks read from one record: metadata, never content. */
export interface RecordMeta {
  /** Position in the metas array (physical order among the journal's records); breaks causal-order ties. */
  index: number;
  uuid?: string;
  /** parentUuid, or a compact boundary's logicalParentUuid. */
  parent?: string;
  parentNull: boolean;
  /** Parent-session metadata: no agentId, isSidechain false, absolute cwd, native uuid, valid timestamp. */
  node: boolean;
  agent: boolean;
  sidechain: boolean;
  /** The record opens a user or assistant turn outside any subagent. */
  conversation: boolean;
  message: boolean;
  role?: string;
  sessionStart: boolean;
  timestampValid: boolean;
  cwd?: string;
  type?: string;
  subtype?: string;
  attachmentType?: string;
  version?: string;
}

/** Claude writes each SessionStart hook result as a message-less attachment chained above the first user turn. */
const sessionStartRecord = (r: Record<string, any>): boolean => r.type === 'attachment' && r.message == null &&
  object(r.attachment) && r.attachment.hookEvent === 'SessionStart' &&
  typeof r.attachment.type === 'string' && /^hook_[a-z_]{1,48}$/.test(r.attachment.type);

/** Record type names only, never content: `attachment:hook_success`, `system:compact_boundary`. */
export const shapeOf = (m: RecordMeta): string => [m.type, m.subtype, m.attachmentType]
  .filter(x => typeof x === 'string' && x).map(x => x!.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)).join(':') || 'untyped';
/** Why a record that is not a parent-session node cannot carry ownership. */
const excludedOf = (m: RecordMeta): OwnedTranscriptReason =>
  m.agent ? 'agent' : m.sidechain ? 'sidechain' : 'unrecognized_shape:record_metadata';
const cwds = new Map<string, string>();

export function recordMeta(r: Record<string, any>, index: number): RecordMeta {
  const message = object(r.message);
  // One shared string per distinct cwd keeps a long journal's index small.
  let cwd: string | undefined = typeof r.cwd === 'string' ? cwds.get(r.cwd) : undefined;
  if (cwd === undefined && typeof r.cwd === 'string') { cwd = r.cwd; if (cwds.size < 256) cwds.set(r.cwd, r.cwd); }
  const uuid = nativeUuid(r.uuid) ? r.uuid : undefined, timestampValid = validTimestamp(r.timestamp);
  return {
    index, uuid,
    parent: nativeUuid(r.parentUuid) ? r.parentUuid : r.parentUuid === null && r.type === 'system' && r.subtype === 'compact_boundary' &&
      r.message == null && nativeUuid(r.logicalParentUuid) ? r.logicalParentUuid : undefined,
    parentNull: r.parentUuid === null,
    node: r.agentId == null && r.isSidechain === false && cwd !== undefined && path.isAbsolute(cwd) && uuid !== undefined && timestampValid,
    agent: r.agentId != null, sidechain: r.isSidechain !== false,
    conversation: r.agentId == null && message && (r.message.role === 'user' || r.message.role === 'assistant'),
    message, role: message && typeof r.message.role === 'string' ? r.message.role : undefined,
    sessionStart: sessionStartRecord(r), timestampValid, cwd,
    type: typeof r.type === 'string' ? r.type : undefined, subtype: typeof r.subtype === 'string' ? r.subtype : undefined,
    attachmentType: object(r.attachment) && typeof r.attachment.type === 'string' ? r.attachment.type : undefined,
    version: indexedVersion(r),
  };
}

export type OwnedOrder = { order: number[]; root?: string } | { reason: OwnedTranscriptReason; shape: string[] };

/**
 * Native journal writes can flush children before parents. Owned readers use
 * causal order (the physical indices of the owned records); ordinary readers
 * only recover membership, keeping physical order. `metas` are the records of
 * this session's own file, in physical order.
 */
export function ownedCausalOrder(metas: readonly RecordMeta[], cwd: string): OwnedOrder {
  const first = metas.find(m => m.conversation);
  if (!first) return { order: [] };
  const nodes = metas.filter(m => m.node);
  // One map: each uuid's parent-session node, else the first record carrying it.
  const byUuid = new Map<string, RecordMeta>();
  for (const m of metas) if (m.uuid) {
    const prior = byUuid.get(m.uuid);
    if (prior?.node && m.node) return { reason: 'competing_root', shape: ['duplicate_uuid'] };
    if (!prior || (m.node && !prior.node)) byUuid.set(m.uuid, m);
  }
  const byId = { get: (id: string) => { const m = byUuid.get(id); return m?.node ? m : undefined; } };
  if (byId.get(first.uuid ?? '') !== first) return { reason: excludedOf(first), shape: [shapeOf(first)] };
  // Anchor through the first observed conversation node, never an unrelated
  // later root. An unflushed ancestor supplies no ownership yet.
  const chain: RecordMeta[] = [first], seen = new Set<RecordMeta>(chain);
  const shape = () => chain.map(shapeOf).reverse().slice(0, 32);
  let genesis = false;
  for (let at = first; ;) {
    const id = at.parent;
    if (!id) break;
    const next = byId.get(id);
    if (!next) {
      const other = byUuid.get(id);
      if (other) return { reason: excludedOf(other), shape: [shapeOf(other), ...shape()] };
      // A resumed fork begins with a boundary whose logical parent stayed in the
      // source session. It is a root only as this file's first record; mid-file
      // it may be an unflushed ancestor, so it supplies no ownership yet.
      if (!at.parentNull || at !== metas.find(m => m.uuid)) return { order: [] };
      genesis = true;
      break;
    }
    if (seen.has(next)) return { reason: 'cycle', shape: shape() };
    chain.push(next); seen.add(next);
    at = next;
  }
  const top = chain.toReversed(), root = top[0]!;
  const turn = top.findIndex(n => n.message);
  const children = new Map<string, RecordMeta[]>();
  for (const node of nodes) if (node.parent) {
    const list = children.get(node.parent) ?? []; list.push(node); children.set(node.parent, list);
  }
  // Uniqueness over every root candidate: a null-parent user, a SessionStart
  // chain head carrying a conversation, and the resumed-genesis boundary.
  const carriesTurn = (head: RecordMeta): boolean => {
    for (const pending = [head]; pending.length;) for (const child of children.get(pending.pop()!.uuid!) ?? []) {
      if (child.message) return true;
      if (child.sessionStart) pending.push(child);
    }
    return false;
  };
  const candidates = new Set<RecordMeta>([root, ...nodes.filter(m => m.parentNull &&
    (m.message ? m.role === 'user' : m.sessionStart)).filter(n => n.message || carriesTurn(n))]);
  if (candidates.size > 1) return { reason: 'competing_root', shape: shape() };
  for (const node of genesis ? [root] : top.slice(0, turn + 1)) if (!sameNativePath(node.cwd, cwd))
    return { reason: sameRealPath(node.cwd, cwd) ? 'unrecognized_shape:cwd_spelling' : 'foreign_cwd', shape: shape() };
  if (!genesis) {
    const preamble = top.slice(0, turn).find(n => !n.sessionStart);
    const odd = !root.parentNull ? `root_parent:${shapeOf(root)}`
      : preamble ? `preamble:${shapeOf(preamble)}`
      : top[turn]!.role !== 'user' ? `first_turn:${shapeOf(top[turn]!)}` : undefined;
    if (odd) return { reason: `unrecognized_shape:${odd}`, shape: shape() };
  }
  // Stable topological traversal preserves physical order whenever two ready
  // records have no parent dependency. No timestamp provides ordering credit.
  const ready: number[] = [];
  const offer = (value: number) => {
    let i = ready.length; ready.push(value);
    while (i > 0) { const p = (i - 1) >> 1; if (ready[p]! <= value) break;
      ready[i] = ready[p]!; i = p; }
    ready[i] = value;
  };
  const take = () => {
    const result = ready[0]!, value = ready.pop()!;
    if (ready.length) { let i = 0;
      while (i * 2 + 1 < ready.length) { let c = i * 2 + 1;
        if (c + 1 < ready.length && ready[c + 1]! < ready[c]!) c++;
        if (ready[c]! >= value) break; ready[i] = ready[c]!; i = c; }
      ready[i] = value;
    }
    return result;
  };
  const order: number[] = [];
  offer(root.index);
  while (ready.length) {
    const node = metas[take()]!;
    order.push(node.index);
    for (const child of children.get(node.uuid!) ?? []) offer(child.index);
  }
  return { order, root: root.uuid };
}
