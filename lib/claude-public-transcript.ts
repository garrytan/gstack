/** Lossless, read-only question metadata from one isolated Claude fixture. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { object, validTimestamp, nativeUuid, recordEvents, recordMeta, ownedCausalOrder, sameNativePath,
  type NativePublicToolEvent, type OwnedTranscriptReason } from './claude-journal-records';

export { nativePathSpelling, ownedNativePath, sameNativePath, type NativePublicToolEvent, type ClaudeParentPublicEvent,
  type OwnedTranscriptReason } from './claude-journal-records';
export { readOwnedClaudePublicTranscript, OWNED_RECORD_MAX_BYTES, OWNED_RETAINED_MAX_BYTES, ownedRecordLimit, ownedRetainedLimit,
  type OwnedTranscriptDiagnostic, type OwnedRead } from './claude-owned-journal';

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

/** A rejected/refused call needs an actual later answer, not unrelated progress. */
export function unresolvedPlanQuestionCalls(calls: NativePlanQuestionCall[]): NativePlanQuestionCall[] {
  return calls.filter((call, index) => call.failed && !call.questions.every(q =>
    calls.slice(index + 1).some(later => later.answered && later.answers?.[q.question])));
}

/** The most journal bytes a batch read takes (the guard's own reader bounds each record instead, CEO-2); over it is `too_large` (#3050). */
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

function validQuestions(value: unknown): value is NativePlanQuestion[] {
  return Array.isArray(value) && value.length > 0 && value.every(q =>
    object(q) && typeof q.header === 'string' && typeof q.question === 'string' && q.question.trim() &&
    Array.isArray(q.options) && q.options.length >= 2 && q.options.every((o: unknown) =>
      object(o) && typeof o.label === 'string' && o.label.trim()));
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
    const dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory());
    if (dirs.length > MAX_FILES) throw new Error('too many project directories');
    for (const dir of dirs) {
      const project = path.join(projects, dir.name);
      for (const entry of fs.readdirSync(project, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (++files > MAX_FILES) throw new Error('too many transcript files');
        const file = path.join(project, entry.name);
        if (ownedParentTranscript !== undefined && file !== ownedParentTranscript) continue;
        bytes += fs.statSync(file).size;
        if (bytes > transcriptReadLimit()) throw new TranscriptTooLarge(bytes);
        const text = fs.readFileSync(file, 'utf8');
        // Native sessions retain their original journal after Bash changes cwd.
        // Admit that continuation only through UUID ancestry rooted in this
        // fixture's first parent user message; legacy records keep exact-cwd scoping.
        let originSeen = false;
        const ancestry = new Set<string>();
        let causalMembership: Set<string> | undefined;
        // Claude appends JSONL during rendering; an unfinished record is not
        // evidence of a call or an answer until its newline has been written.
        const completeLines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
        const recoveredMember = (id: string) => {
          if (causalMembership === undefined) {
            // Invalid strict ancestry adds no recovery; legacy traversal continues.
            try {
              const records = completeLines.flatMap(line => {
                if (!line.trim()) return [];
                const record = JSON.parse(line);
                return object(record) && entry.name === `${record.sessionId}.jsonl` ? [record] : [];
              });
              const causal = ownedCausalOrder(records.map(recordMeta), cwd);
              causalMembership = new Set('order' in causal ? causal.order.map(i => records[i]!.uuid) : []);
            } catch { causalMembership = new Set(); }
          }
          return causalMembership.has(id);
        };
        for (const line of completeLines) {
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
              (!sameNativePath(record.cwd, cwd) && ancestry.size > 0 && recoveredMember(record.uuid)));
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
          if ((!sameNativePath(record.cwd, cwd) && !continuation) || record.isSidechain !== false || !object(record.message)) continue;
          if (!Array.isArray(record.message.content)) continue;
          matched = true;
          for (const event of recordEvents(record, false).events) {
            if (event.kind === 'message') assistantMessages.push({ sessionId: record.sessionId, text: event.text, timestamp: record.timestamp });
            else if (event.kind === 'use' || event.kind === 'result') onPublicToolEvent?.(event);
          }
          for (const block of record.message.content) {
            if (!object(block)) continue;
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

