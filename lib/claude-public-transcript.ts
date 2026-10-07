/** Lossless, read-only question metadata from one isolated Claude fixture. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface NativePlanQuestion {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface NativePlanQuestionCall {
  sessionId: string;
  toolUseId: string;
  questions: NativePlanQuestion[];
  answered: boolean;
  failed?: boolean;
  failure?: string;
  answers?: Record<string, string>;
  unansweredQuestionIndices?: number[];
  answeredAt?: string;
}

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

export interface PlanCountTranscript {
  status: 'missing' | 'ready' | 'error';
  calls: NativePlanQuestionCall[];
  assistantMessages: Array<{ sessionId: string; text: string; timestamp: string }>;
  /** Actual native plan-mode approval requests; pending is the UI gate, never an AUQ. */
  planReadyRequests?: Array<{ sessionId: string; toolUseId: string; timestamp: string; failed: boolean; source?: 'pre_tool_use' }>;
  error?: string;
  /** Owned reads only: why the exact parent journal supplied no owned lines. */
  reason?: OwnedTranscriptReason;
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

interface OwnedSnapshot {
  file: string;
  text: string;
  events: ClaudeParentPublicEvent[];
  /** Record types (never content) from the journal head to the first turn, set on refusal. */
  rootShape?: string[];
  /** The newest owned record's Claude Code version (the CLI writing now), when present. */
  claudeVersion?: string;
}

/** A rejected/refused call needs an actual later answer, not unrelated progress. */
export function unresolvedPlanQuestionCalls(calls: NativePlanQuestionCall[]): NativePlanQuestionCall[] {
  return calls.filter((call, index) => call.failed && !call.questions.every(q =>
    calls.slice(index + 1).some(later => later.answered && later.answers?.[q.question])));
}

/** The most journal bytes the guard reads; a longer session reports `too_large`, never `identity` (#3050). */
export const OWNED_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
/** Test seam: GSTACK_TRANSCRIPT_TEST_MAX_BYTES can only LOWER the cap, never raise it. */
export function transcriptReadLimit(): number {
  const lowered = Number(process.env.GSTACK_TRANSCRIPT_TEST_MAX_BYTES);
  return Number.isInteger(lowered) && lowered > 0 && lowered < OWNED_TRANSCRIPT_MAX_BYTES ? lowered : OWNED_TRANSCRIPT_MAX_BYTES;
}
const mib = (bytes: number) => { const m = bytes / (1024 * 1024); return `${m >= 10 ? Number(m.toFixed(1)) : Number(m.toPrecision(2))} MiB`; };
/** A journal over the read limit; it only grows, so retrying never helps (#3050). */
class TranscriptTooLarge extends Error {
  constructor(readonly bytes: number) { super(`transcript is ${mib(bytes)}, over the ${mib(transcriptReadLimit())} read limit`); }
}
const MAX_FILES = 64;
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
/** A record's own Claude Code version string, shape-checked; never other content. */
const claudeVersionOf = (record: Record<string, any>): string | undefined =>
  typeof record.version === 'string' && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,24}$/.test(record.version) ? record.version : undefined;

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

function validQuestions(value: unknown): value is NativePlanQuestion[] {
  return Array.isArray(value) && value.length > 0 && value.every(q =>
    object(q) && typeof q.header === 'string' && typeof q.question === 'string' && q.question.trim() &&
    Array.isArray(q.options) && q.options.length >= 2 && q.options.every((o: unknown) =>
      object(o) && typeof o.label === 'string' && o.label.trim()));
}

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

/**
 * Why an owned journal supplied no owned lines (docs/autoplan-guard-troubleshooting.md).
 * Positive identity conflicts are hard; `changing`, `identity` and `malformed`
 * retry; only `unrecognized_shape:*` may degrade to an advisory.
 */
export type OwnedTranscriptReason = 'competing_root' | 'foreign_cwd' | 'sidechain' | 'agent' | 'cycle' | 'too_large' |
  'changing' | 'identity' | 'malformed' | `unrecognized_shape:${string}`;

type OwnedLines = { lines: string[]; root?: string } | { reason: OwnedTranscriptReason; shape: string[] };

const nativeUuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
/** Record type names only, never content: `attachment:hook_success`, `system:compact_boundary`. */
const recordShape = (r: Record<string, any>): string => [r.type, r.subtype, object(r.attachment) ? r.attachment.type : undefined]
  .filter(x => typeof x === 'string' && x).map(x => x.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)).join(':') || 'untyped';
/** Claude writes each SessionStart hook result as a message-less attachment chained above the first user turn. */
const sessionStartRecord = (r: Record<string, any>): boolean => r.type === 'attachment' && r.message == null &&
  object(r.attachment) && r.attachment.hookEvent === 'SessionStart' &&
  typeof r.attachment.type === 'string' && /^hook_[a-z_]{1,48}$/.test(r.attachment.type);

/** Native journal writes can flush children before parents. Owned snapshots
 * use causal order; ordinary readers only recover membership, keeping physical order. */
function ownedCausalLines(lines: string[], cwd: string, filename: string): OwnedLines {
  const parsed = lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    const record = JSON.parse(line);
    return object(record) && filename === `${record.sessionId}.jsonl` ? [{ line, index, record }] : [];
  });
  type Node = typeof parsed[number];
  const first = parsed.find(x => x.record.agentId == null && object(x.record.message) &&
    ['user', 'assistant'].includes(x.record.message.role));
  if (!first) return { lines: [] };
  const nodes = parsed.filter(({ record: r }) => r.agentId == null && r.isSidechain === false &&
    typeof r.cwd === 'string' && path.isAbsolute(r.cwd) && nativeUuid(r.uuid) && validTimestamp(r.timestamp));
  const byId = new Map<string, Node>();
  for (const node of nodes) {
    if (byId.has(node.record.uuid)) return { reason: 'competing_root', shape: ['duplicate_uuid'] };
    byId.set(node.record.uuid, node);
  }
  const anyById = new Map<string, Record<string, any>>();
  for (const { record } of parsed) if (nativeUuid(record.uuid) && !anyById.has(record.uuid)) anyById.set(record.uuid, record);
  const excluded = (r: Record<string, any>): OwnedTranscriptReason => r.agentId != null ? 'agent' :
    r.isSidechain !== false ? 'sidechain' : 'unrecognized_shape:record_metadata';
  const parent = (r: Record<string, any>): string | undefined => nativeUuid(r.parentUuid) ? r.parentUuid :
    r.parentUuid === null && r.type === 'system' && r.subtype === 'compact_boundary' &&
    r.message == null && nativeUuid(r.logicalParentUuid) ? r.logicalParentUuid : undefined;
  if (byId.get(first.record.uuid) !== first) return { reason: excluded(first.record), shape: [recordShape(first.record)] };
  // Anchor through the first observed conversation node, never an unrelated
  // later root. An unflushed ancestor supplies no ownership yet.
  const chain: Node[] = [first], seen = new Set<Node>(chain);
  const shape = () => chain.map(n => recordShape(n.record)).reverse().slice(0, 32);
  let genesis = false;
  for (let at = first; ;) {
    const id = parent(at.record);
    if (!id) break;
    const next = byId.get(id);
    if (!next) {
      const other = anyById.get(id);
      if (other) return { reason: excluded(other), shape: [recordShape(other), ...shape()] };
      // A resumed fork begins with a boundary whose logical parent stayed in the
      // source session. It is a root only as this file's first record; mid-file
      // it may be an unflushed ancestor, so it supplies no ownership yet.
      if (at.record.parentUuid !== null || at !== parsed.find(x => nativeUuid(x.record.uuid))) return { lines: [] };
      genesis = true;
      break;
    }
    if (seen.has(next)) return { reason: 'cycle', shape: shape() };
    chain.push(next); seen.add(next);
    at = next;
  }
  const top = chain.toReversed(), root = top[0]!;
  const turn = top.findIndex(n => object(n.record.message));
  const children = new Map<string, Node[]>();
  for (const node of nodes) {
    const id = parent(node.record);
    if (id) { const list = children.get(id) ?? []; list.push(node); children.set(id, list); }
  }
  // Uniqueness over every root candidate: a null-parent user, a SessionStart
  // chain head carrying a conversation, and the resumed-genesis boundary.
  const carriesTurn = (head: Node): boolean => {
    for (const pending = [head]; pending.length;) for (const child of children.get(pending.pop()!.record.uuid) ?? []) {
      if (object(child.record.message)) return true;
      if (sessionStartRecord(child.record)) pending.push(child);
    }
    return false;
  };
  const candidates = new Set<Node>([root, ...nodes.filter(({ record: r }) => r.parentUuid === null &&
    (object(r.message) ? r.message.role === 'user' : sessionStartRecord(r))).filter(n =>
    object(n.record.message) || carriesTurn(n))]);
  if (candidates.size > 1) return { reason: 'competing_root', shape: shape() };
  for (const node of genesis ? [root] : top.slice(0, turn + 1)) if (!sameNativePath(node.record.cwd, cwd))
    return { reason: sameRealPath(node.record.cwd, cwd) ? 'unrecognized_shape:cwd_spelling' : 'foreign_cwd', shape: shape() };
  if (!genesis) {
    const preamble = top.slice(0, turn).find(n => !sessionStartRecord(n.record));
    const odd = root.record.parentUuid !== null ? `root_parent:${recordShape(root.record)}`
      : preamble ? `preamble:${recordShape(preamble.record)}`
      : top[turn]!.record.message.role !== 'user' ? `first_turn:${recordShape(top[turn]!.record)}` : undefined;
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
  const indexed = new Map(nodes.map(x => [x.index, x]));
  const ordered: string[] = [];
  offer(root.index);
  while (ready.length) {
    const node = indexed.get(take())!;
    ordered.push(node.line);
    for (const child of children.get(node.record.uuid) ?? []) offer(child.index);
  }
  return { lines: ordered, root: root.record.uuid };
}

/**
 * Count callers consume each answered (sessionId, toolUseId) once, regardless
 * of questions[].length. A batched tool call must never become N findings.
 * Partial final lines remain pending; missing/foreign/sidechain records add
 * no coverage. Traversal stays inside the owned config's projects directory.
 */
export function readPlanCountTranscript(configDir: string, cwd: string,
  onPublicToolEvent?: (event: NativePublicToolEvent) => void,
  /** Optional exact parent journal, already validated by the owning native hook. */
  ownedParentTranscript?: string,
  ownedSnapshot?: OwnedSnapshot,
): PlanCountTranscript {
  const calls = new Map<string, NativePlanQuestionCall>();
  const assistantMessages: PlanCountTranscript['assistantMessages'] = [];
  const planReadyRequests = new Map<string, NonNullable<PlanCountTranscript['planReadyRequests']>[number]>();
  let matched = false;
  let bytes = 0;
  let files = 0;
  const projects = path.join(configDir, 'projects');
  try {
    if (!fs.existsSync(projects)) return { status: 'missing', calls: [], assistantMessages: [] };
    const dirs = ownedSnapshot ? [{ name: path.basename(path.dirname(ownedSnapshot.file)) }]
      : fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory());
    if (dirs.length > MAX_FILES) throw new Error('too many project directories');
    for (const dir of dirs) {
      const project = path.join(projects, dir.name);
      const entries = ownedSnapshot ? [{ name: path.basename(ownedSnapshot.file), isFile: () => true }]
        : fs.readdirSync(project, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (++files > MAX_FILES) throw new Error('too many transcript files');
        const file = path.join(project, entry.name);
        if (ownedParentTranscript !== undefined && file !== ownedParentTranscript) continue;
        bytes += ownedSnapshot ? Buffer.byteLength(ownedSnapshot.text) : fs.statSync(file).size;
        if (bytes > transcriptReadLimit()) throw new TranscriptTooLarge(bytes);
        const text = ownedSnapshot?.text ?? fs.readFileSync(file, 'utf8');
        let publicOrder = 0;
        // Native sessions retain their original journal after Bash changes cwd.
        // Admit that continuation only through UUID ancestry rooted in this
        // fixture's first parent user message; legacy records keep exact-cwd scoping.
        let originSeen = false;
        const ancestry = new Set<string>();
        let causal: OwnedLines | undefined, causalMembership: Set<string> | undefined, ownedLines: string[] | undefined;
        // Claude appends JSONL during rendering; an unfinished record is not
        // evidence of a call or an answer until its newline has been written.
        const completeLines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
        const recoveredMember = (id: string) => {
          if (causalMembership === undefined) {
            // Invalid strict ancestry adds no recovery; legacy traversal continues.
            try { causal ??= ownedCausalLines(completeLines, cwd, entry.name); } catch { causal = { lines: [] }; }
            causalMembership = new Set('lines' in causal ? causal.lines.map(line => JSON.parse(line).uuid) : []);
          }
          return causalMembership.has(id);
        };
        if (ownedSnapshot) {
          causal = ownedCausalLines(completeLines, cwd, entry.name);
          if ('reason' in causal) {
            ownedSnapshot.rootShape = causal.shape;
            return { status: causal.reason === 'competing_root' || causal.reason === 'cycle' ? 'error' : 'missing',
              calls: [], assistantMessages: [], reason: causal.reason };
          }
          // The verified root seeds ownership; message-less preamble and
          // boundary roots supply no events of their own.
          ownedLines = causal.lines;
          if (causal.root) ancestry.add(causal.root);
        }
        for (const line of ownedLines ?? completeLines) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (!object(record) || typeof record.sessionId !== 'string' ||
              entry.name !== `${record.sessionId}.jsonl` ||
              (ownedParentTranscript !== undefined && record.agentId != null)) continue;
          const parentMetadata = record.isSidechain === false && record.agentId == null &&
            typeof record.cwd === 'string' && path.isAbsolute(record.cwd) &&
            nativeUuid(record.uuid) && validTimestamp(record.timestamp);
          const continuation = parentMetadata && nativeUuid(record.parentUuid) &&
            !ancestry.has(record.uuid) && (ancestry.has(record.parentUuid) ||
              // A delayed metadata parent must not cut an already-rooted native
              // session at its first cwd change. Recover membership lazily; do
              // not discover a later root or reorder public uses and results.
              (!ownedSnapshot && !sameNativePath(record.cwd, cwd) && ancestry.size > 0 &&
                recoveredMember(record.uuid)));
          if (!originSeen && object(record.message) && ['user', 'assistant'].includes(record.message.role)) {
            originSeen = true;
            // The first user prompt roots ownership itself, or through the
            // verified causal root above it (SessionStart preamble, resumed
            // boundary). Children can flush before parents, so physical order
            // never decides that ancestry.
            if (parentMetadata && sameNativePath(record.cwd, cwd) && record.message.role === 'user' &&
                (record.parentUuid === null || recoveredMember(record.uuid))) ancestry.add(record.uuid);
          }
          if (continuation) ancestry.add(record.uuid);
          // Native compaction resets parentUuid but links its prior owned
          // UUID ancestry through logicalParentUuid. Summary text does
          // not establish ownership, and an arbitrary reset cannot seed a root.
          const compactContinuation = parentMetadata && record.type === 'system' &&
            record.subtype === 'compact_boundary' && record.parentUuid === null &&
            record.message == null && nativeUuid(record.logicalParentUuid) &&
            ancestry.has(record.logicalParentUuid) && !ancestry.has(record.uuid);
          if (compactContinuation) ancestry.add(record.uuid);
          if (ownedSnapshot && !ancestry.has(record.uuid)) continue;
          if ((!sameNativePath(record.cwd, cwd) && !continuation) || record.isSidechain !== false || !object(record.message)) continue;
          if (ownedSnapshot) ownedSnapshot.claudeVersion = claudeVersionOf(record) ?? ownedSnapshot.claudeVersion;
          const notified = ownedSnapshot && record.message.role === 'user' && record.origin?.kind === 'task-notification' &&
            typeof record.message.content === 'string' ? /<tool-use-id>([A-Za-z0-9_-]{1,160})<\/tool-use-id>/.exec(record.message.content)?.[1] : undefined;
          if (notified) ownedSnapshot!.events.push({ kind: 'task_notification', sessionId: record.sessionId, timestamp: record.timestamp,
            order: publicOrder++, notifiedToolUseId: notified });
          if (ownedSnapshot && record.message.role === 'user' && record.origin?.kind === 'human' &&
              record.isMeta !== true && nativeUuid(record.promptId) && typeof record.message.content === 'string') {
            const autoplan = /^<command-message>autoplan<\/command-message>\n<command-name>\/autoplan<\/command-name>(?:\n<command-args>[\s\S]*<\/command-args>)?$/.test(record.message.content);
            if (record.promptSource === 'typed' || autoplan) ownedSnapshot.events.push({ kind: 'user_turn',
              sessionId: record.sessionId, timestamp: record.timestamp, order: publicOrder++, autoplan });
          }
          if (!Array.isArray(record.message.content)) continue;
          matched = true;
          for (const block of record.message.content) {
            const order = publicOrder++;
            if (!object(block)) continue;
            const ordered = (event: NativePublicToolEvent | { kind: 'message'; sessionId: string; timestamp: string; text: string }) => {
              if (ownedSnapshot) ownedSnapshot.events.push({ ...event, order,
                ...(typeof record.message.id === 'string' ? { messageId: record.message.id } : {}),
                ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}) });
            };
            if (onPublicToolEvent && validTimestamp(record.timestamp)) {
              if (record.message.role === 'assistant' && block.type === 'tool_use' &&
                  typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
                const batch = typeof record.message.id === 'string' && /^msg_[A-Za-z0-9_-]{1,160}$/.test(record.message.id) &&
                  typeof record.requestId === 'string' && /^req_[A-Za-z0-9_-]{1,160}$/.test(record.requestId)
                  ? { messageId: record.message.id, requestId: record.requestId } : {};
                const event: NativePublicToolEvent = { sessionId: record.sessionId, timestamp: record.timestamp,
                  toolUseId: block.id, kind: 'use', name: block.name, input: block.input, ...batch };
                onPublicToolEvent(event);
                ordered(event);
              } else if (record.message.role === 'user' && block.type === 'tool_result' &&
                         typeof block.tool_use_id === 'string') {
                const event: NativePublicToolEvent = { sessionId: record.sessionId, timestamp: record.timestamp,
                  toolUseId: block.tool_use_id, kind: 'result', content: block.content,
                  file: record.toolUseResult?.file, isError: block.is_error === true,
                  ...(ownedSnapshot && record.toolUseResult?.isAsync === true ? { async: true } : {}) };
                onPublicToolEvent(event);
                ordered(event);
              }
            }

            if (record.message.role === 'assistant' && validTimestamp(record.timestamp)) {
              const text = block.type === 'text' && typeof block.text === 'string' && block.text.trim()
                ? block.text : publicNarrationText(block);
              if (text) {
                assistantMessages.push({ sessionId: record.sessionId, text, timestamp: record.timestamp });
                ordered({ kind: 'message', sessionId: record.sessionId, text, timestamp: record.timestamp });
              }
            }
            if (record.message.role === 'assistant' && block.type === 'tool_use' && block.name === 'ExitPlanMode' &&
                typeof block.id === 'string' && validTimestamp(record.timestamp)) {
              const key = `${record.sessionId}:${block.id}`;
              if (!planReadyRequests.has(key)) planReadyRequests.set(key, { sessionId: record.sessionId,
                toolUseId: block.id, timestamp: record.timestamp, failed: false });
            }
            if (record.message.role === 'assistant' && block.type === 'tool_use' && block.name === 'AskUserQuestion' &&
                typeof block.id === 'string' && object(block.input) && validQuestions(block.input.questions)) {
              const key = `${record.sessionId}:${block.id}`;
              const prior = calls.get(key);
              if (prior && JSON.stringify(prior.questions) !== JSON.stringify(block.input.questions)) {
                throw new Error('conflicting question metadata for one tool call');
              }
              if (!prior) calls.set(key, { sessionId: record.sessionId, toolUseId: block.id,
                questions: block.input.questions, answered: false, failed: false });
            } else if (record.message.role === 'user' && block.type === 'tool_result' &&
                       typeof block.tool_use_id === 'string') {
              const ready = planReadyRequests.get(`${record.sessionId}:${block.tool_use_id}`);
              if (ready && block.is_error === true) ready.failed = true;
              const call = calls.get(`${record.sessionId}:${block.tool_use_id}`);
              const answers = record.toolUseResult?.answers;
              const validAnswers = call && object(answers) ? Object.fromEntries(call.questions
                .filter(q => typeof answers[q.question] === 'string' && answers[q.question].trim())
                .map(q => [q.question, answers[q.question]])) : {};
              if (call && block.is_error !== true && Object.keys(validAnswers).length > 0) {
                // The CLI allows submitting a multi-question packet with
                // unanswered tabs. This completes ONE call, not N questions.
                call.answered = true;
                call.failed = false;
                delete call.failure;
                call.answers = validAnswers;
                call.unansweredQuestionIndices = call.questions.flatMap((q, i) => q.question in validAnswers ? [] : [i]);
                call.answeredAt = validTimestamp(record.timestamp) ? record.timestamp : undefined;
              } else if (call) {
                if (call.answered) throw new Error('conflicting successful and failed results for one question call');
                call.failed = true;
                call.failure = block.is_error === true ? 'Native question tool returned is_error' : 'Native question returned no matching nonempty answers';
              }
            }
          }
          if (ownedSnapshot && record.message.role === 'assistant' && record.message.stop_reason === 'end_turn')
            ownedSnapshot.events.push({ kind: 'end_turn', sessionId: record.sessionId, timestamp: record.timestamp,
              order: publicOrder++, ...(typeof record.message.id === 'string' ? { messageId: record.message.id } : {}) });
        }
      }
    }
    return { status: matched ? 'ready' : 'missing', calls: [...calls.values()], assistantMessages,
      ...(planReadyRequests.size ? { planReadyRequests: [...planReadyRequests.values()] } : {}) };
  } catch (error) {
    // A failed read cannot silently turn an incomplete transcript into a
    // complete review. Keep the diagnostic explicit and return no coverage.
    return { status: 'error', calls: [], assistantMessages: [], ...(error instanceof TranscriptTooLarge ? { reason: 'too_large' as const } : {}),
      error: `Claude question transcript: ${String(error)}` };
  }
}

/** What a refused owned read can report without content: inputs to the hook's guidance and advisory. */
export interface OwnedTranscriptDiagnostic {
  /** Claude Code version recorded in the journal's own records, when present. */
  claudeVersion?: string;
  /** Record types from the journal head down to its first turn; never content. */
  rootShape: string[];
  /** Parent assistant tool_use ids present in complete records. */
  toolUseIds: string[];
  /** sha256 of the exact bytes read, so two reads can prove a stable snapshot. */
  sha256: string;
  /** The journal ends at a record boundary (no partially written record). */
  complete: boolean;
}

class OwnedReadError extends Error {
  constructor(readonly reason: OwnedTranscriptReason) { super(reason); }
}

function diagnose(bytes: Buffer, sessionId: string, rootShape: string[] = []): OwnedTranscriptDiagnostic {
  const text = bytes.toString('utf8'), toolUseIds: string[] = [];
  let claudeVersion: string | undefined;
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!object(record) || record.sessionId !== sessionId || record.agentId != null || record.isSidechain !== false) continue;
    claudeVersion ??= claudeVersionOf(record);
    if (object(record.message) && record.message.role === 'assistant' && Array.isArray(record.message.content))
      for (const block of record.message.content)
        if (object(block) && block.type === 'tool_use' && typeof block.id === 'string') toolUseIds.push(block.id);
  }
  return { ...(claudeVersion ? { claudeVersion } : {}), rootShape, toolUseIds,
    sha256: createHash('sha256').update(bytes).digest('hex'), complete: text.endsWith('\n') };
}

/** Read exactly the native hook's parent file; never scan another session. */
export function readOwnedClaudePublicTranscript(file: string, cwd: string, sessionId: string): {
  transcript: PlanCountTranscript; events: ClaudeParentPublicEvent[]; diagnostic?: OwnedTranscriptDiagnostic; claudeVersion?: string;
} {
  let fd: number | undefined, bytes: Buffer | undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !path.isAbsolute(cwd) || !ownedNativePath(file) ||
        path.basename(nativePathSpelling(file)) !== `${sessionId}.jsonl`) throw new OwnedReadError('identity');
    file = nativePathSpelling(file);
    const project = path.dirname(file), projects = path.dirname(project), config = path.dirname(projects);
    if (path.basename(projects) !== 'projects' ||
        [config, projects, project].some(dir => !fs.lstatSync(dir).isDirectory() || !sameNativePath(fs.realpathSync(dir), dir)))
      throw new OwnedReadError('identity');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new OwnedReadError('identity');
    // A journal only grows, so an oversize one can never pass on retry (#3050).
    if (before.size > BigInt(transcriptReadLimit())) throw new OwnedReadError('too_large');
    bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino) throw new OwnedReadError('identity');
    // Racing Claude's own append is transient: the hook retries within its deadline.
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.size !== current.size || before.mtimeNs !== current.mtimeNs ||
        before.size !== BigInt(bytes.length)) throw new OwnedReadError('changing');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new OwnedReadError('malformed');
    const snapshot: OwnedSnapshot = { file, text, events: [] };
    const transcript = readPlanCountTranscript(config, cwd, () => {}, file, snapshot);
    if (snapshot.events.some(event => event.sessionId !== sessionId)) throw new OwnedReadError('identity');
    if (transcript.status === 'error') transcript.reason ??= 'malformed';
    if (transcript.status === 'ready') return { transcript, events: snapshot.events,
      ...(snapshot.claudeVersion ? { claudeVersion: snapshot.claudeVersion } : {}) };
    return { transcript, events: [], diagnostic: diagnose(bytes, sessionId, snapshot.rootShape) };
  } catch (error) {
    // A journal Claude has not created yet is unflushed, not an identity failure.
    const reason = error instanceof OwnedReadError ? error.reason :
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? undefined : 'identity';
    return { transcript: { status: 'error', calls: [], assistantMessages: [], ...(reason ? { reason } : {}),
      error: `Owned native public transcript is unavailable (${reason ?? 'not created yet'})` }, events: [],
      ...(bytes ? { diagnostic: diagnose(bytes, sessionId) } : {}) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
