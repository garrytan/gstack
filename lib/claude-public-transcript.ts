/** Lossless, read-only question metadata from one isolated Claude fixture. */
import * as fs from 'node:fs';
import * as path from 'node:path';

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
}

export interface PlanCountTranscript {
  status: 'missing' | 'ready' | 'error';
  calls: NativePlanQuestionCall[];
  assistantMessages: Array<{ sessionId: string; text: string; timestamp: string }>;
  /** Actual native plan-mode approval requests; pending is the UI gate, never an AUQ. */
  planReadyRequests?: Array<{ sessionId: string; toolUseId: string; timestamp: string; failed: boolean; source?: 'pre_tool_use' }>;
  error?: string;
}

/** Hook-only verified causal order (physical order for independent ready records). The existing fixture projection remains unchanged. */
export type ClaudeParentPublicEvent = (NativePublicToolEvent | {
  kind: 'message'; sessionId: string; timestamp: string; text: string;
} | {
  kind: 'end_turn' | 'user_turn'; sessionId: string; timestamp: string; autoplan?: boolean;
}) & { order: number; messageId?: string; requestId?: string };

interface OwnedSnapshot {
  file: string;
  text: string;
  events: ClaudeParentPublicEvent[];
}

/** A rejected/refused call needs an actual later answer, not unrelated progress. */
export function unresolvedPlanQuestionCalls(calls: NativePlanQuestionCall[]): NativePlanQuestionCall[] {
  return calls.filter((call, index) => call.failed && !call.questions.every(q =>
    calls.slice(index + 1).some(later => later.answered && later.answers?.[q.question])));
}

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 64;
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

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

/** Native journal writes can flush children before parents. Owned snapshots
 * use causal order; ordinary readers only recover membership, keeping physical order. */
function ownedCausalLines(lines: string[], cwd: string, filename: string): string[] {
  const uuid = (value: unknown): value is string => typeof value === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const scoped = lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    const record = JSON.parse(line);
    return object(record) && filename === `${record.sessionId}.jsonl` && record.agentId == null
      ? [{ line, index, record }] : [];
  });
  const first = scoped.find(x => object(x.record.message) && ['user', 'assistant'].includes(x.record.message.role));
  if (!first) return [];
  const nodes = scoped.filter(({ record: r }) => r.isSidechain === false &&
    typeof r.cwd === 'string' && path.isAbsolute(r.cwd) && uuid(r.uuid) && validTimestamp(r.timestamp));
  const byId = new Map<string, typeof nodes[number]>();
  for (const node of nodes) {
    if (byId.has(node.record.uuid)) throw Error('ambiguous owned native UUID');
    byId.set(node.record.uuid, node);
  }
  if (byId.get(first.record.uuid) !== first) return [];
  const parent = (r: Record<string, any>): string | undefined => uuid(r.parentUuid) ? r.parentUuid :
    r.parentUuid === null && r.type === 'system' && r.subtype === 'compact_boundary' &&
    r.message == null && uuid(r.logicalParentUuid) ? r.logicalParentUuid : undefined;
  // Anchor through the first observed conversation node, never an unrelated
  // later root. An unflushed/malformed ancestor supplies no ownership.
  let root = first;
  const ancestry = new Set<string>();
  while (true) {
    if (ancestry.has(root.record.uuid)) throw Error('cyclic owned native ancestry');
    ancestry.add(root.record.uuid);
    const id = parent(root.record);
    if (!id) break;
    const next = byId.get(id);
    if (!next) return [];
    root = next;
  }
  if (root.record.parentUuid !== null || root.record.cwd !== cwd ||
      !object(root.record.message) || root.record.message.role !== 'user') return [];
  if (nodes.some(x => x !== root && x.record.parentUuid === null &&
      object(x.record.message) && x.record.message.role === 'user')) throw Error('competing owned native roots');
  // Stable topological traversal preserves physical order whenever two ready
  // records have no parent dependency. No timestamp provides ordering credit.
  const children = new Map<string, number[]>();
  const indexed = new Map(nodes.map(x => [x.index, x]));
  for (const node of nodes) {
    const id = parent(node.record);
    if (id) { const list = children.get(id) ?? []; list.push(node.index); children.set(id, list); }
  }
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
  const ordered: string[] = [];
  offer(root.index);
  while (ready.length) {
    const node = indexed.get(take())!;
    ordered.push(node.line);
    for (const child of children.get(node.record.uuid) ?? []) offer(child);
  }
  return ordered;
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
        if (bytes > MAX_BYTES) throw new Error('transcript exceeds 32 MiB read limit');
        const text = ownedSnapshot?.text ?? fs.readFileSync(file, 'utf8');
        let publicOrder = 0;
        // Native sessions retain their original journal after Bash changes cwd.
        // Admit that continuation only through UUID ancestry rooted in this
        // fixture's first parent user message; legacy records keep exact-cwd scoping.
        let originSeen = false;
        const ancestry = new Set<string>();
        let causalMembership: Set<string> | undefined;
        const nativeUuid = (value: unknown): value is string =>
          typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
        // Claude appends JSONL during rendering; an unfinished record is not
        // evidence of a call or an answer until its newline has been written.
        const completeLines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
        const recoveredMember = (id: string) => {
          if (causalMembership === undefined) {
            causalMembership = new Set<string>();
            try {
              causalMembership = new Set(ownedCausalLines(completeLines, cwd, entry.name)
                .map(line => JSON.parse(line).uuid));
            } catch { /* Invalid strict ancestry adds no recovery; legacy traversal continues. */ }
          }
          return causalMembership.has(id);
        };
        for (const line of ownedSnapshot ? ownedCausalLines(completeLines, cwd, entry.name) : completeLines) {
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
              (!ownedSnapshot && record.cwd !== cwd && ancestry.size > 0 &&
                recoveredMember(record.uuid)));
          if (!originSeen && object(record.message) && ['user', 'assistant'].includes(record.message.role)) {
            originSeen = true;
            if (parentMetadata && record.cwd === cwd && record.message.role === 'user' &&
                record.parentUuid === null) ancestry.add(record.uuid);
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
          if ((record.cwd !== cwd && !continuation) || record.isSidechain !== false || !object(record.message)) continue;
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
                  file: record.toolUseResult?.file, isError: block.is_error === true };
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
    return { status: 'error', calls: [], assistantMessages: [], error: `Claude question transcript: ${String(error)}` };
  }
}

/** Read exactly the native hook's parent file; never scan another session. */
export function readOwnedClaudePublicTranscript(file: string, cwd: string, sessionId: string): {
  transcript: PlanCountTranscript; events: ClaudeParentPublicEvent[];
} {
  let fd: number | undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !path.isAbsolute(cwd) ||
        !path.isAbsolute(file) || path.normalize(file) !== file ||
        path.basename(file) !== `${sessionId}.jsonl`) throw Error('invalid native parent identity');
    const project = path.dirname(file), projects = path.dirname(project), config = path.dirname(projects);
    if (path.basename(projects) !== 'projects' ||
        [config, projects, project].some(dir => !fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir))
      throw Error('invalid native parent directory');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw Error('invalid native parent file');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.size !== current.size || before.mtimeNs !== current.mtimeNs ||
        before.size !== BigInt(bytes.length)) throw Error('native parent changed during read');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw Error('invalid native parent encoding');
    const events: ClaudeParentPublicEvent[] = [];
    const transcript = readPlanCountTranscript(config, cwd, () => {}, file, { file, text, events });
    if (events.some(event => event.sessionId !== sessionId)) throw Error('foreign native parent event');
    return { transcript, events };
  } catch {
    return { transcript: { status: 'error', calls: [], assistantMessages: [],
      error: 'Owned native public transcript is unavailable or changing' }, events: [] };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
