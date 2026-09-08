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

export interface PlanCountTranscript {
  status: 'missing' | 'ready' | 'error';
  calls: NativePlanQuestionCall[];
  assistantMessages: Array<{ sessionId: string; text: string; timestamp: string }>;
  /** Actual native plan-mode approval requests; pending is the UI gate, never an AUQ. */
  planReadyRequests?: Array<{ sessionId: string; toolUseId: string; timestamp: string; failed: boolean; source?: 'pre_tool_use' }>;
  error?: string;
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
export function readPlanCountTranscript(configDir: string, cwd: string): PlanCountTranscript {
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
        bytes += fs.statSync(file).size;
        if (bytes > MAX_BYTES) throw new Error('transcript exceeds 32 MiB read limit');
        const text = fs.readFileSync(file, 'utf8');
        // Claude appends JSONL during rendering; an unfinished record is not
        // evidence of a call or an answer until its newline has been written.
        for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (!object(record) || record.cwd !== cwd || record.isSidechain !== false ||
              typeof record.sessionId !== 'string' || entry.name !== `${record.sessionId}.jsonl` ||
              !object(record.message) || !Array.isArray(record.message.content)) continue;
          matched = true;
          for (const block of record.message.content) {
            if (!object(block)) continue;
            if (record.message.role === 'assistant' && block.type === 'text' &&
                typeof block.text === 'string' && block.text.trim() && validTimestamp(record.timestamp)) {
              assistantMessages.push({ sessionId: record.sessionId, text: block.text, timestamp: record.timestamp });
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
                questions: block.input.questions, answered: false });
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
    return { status: 'error', calls: [], assistantMessages: [], error: `Claude question transcript: ${String(error)}` };
  }
}
