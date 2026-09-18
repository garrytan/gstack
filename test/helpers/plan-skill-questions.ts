import { readOwnedClaudeTranscript } from './owned-claude-transcript';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readQuestionEvents, readQuestionCompletionEvents, readBashEvents, readBashCompletionEvents, readBashPermissionRequestEvents, readWebFetchPermissionRequestEvents, webFetchInput, readExitPlanModeEvents, readPermissionRequestEvents, readFileCompletionEvents,
  type FileCompletionEventCall, type QuestionCompletionEventCall, type BashEventCall, type BashCompletionEventCall, type QuestionEventSource } from './plan-skill-question-events';

export interface NativeQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}
export interface NativeQuestionCall {
  id: string;
  questions: NativeQuestion[];
  result: 'pending' | 'answered' | 'error';
  /** Exact offered labels from a validated native PostToolUse response. */
  answerLabels?: string[];
  /** Not an offered card: preserve a pre-execution request until native schema
   * validation rejects it. No defaults, choices or answers are inferred here. */
  validation?: { input: unknown; rejection?: { content: string; toolUseResult: string } };
}
export interface NativePermissionTool {
  id: string; name: string; input: Record<string, unknown>; cwd?: string;
  /** Early Bash input cannot grant until its post-PreToolUse request matches. */
  bashPermissionRequestId?: string | null;
  /** Complete native Fetch input still needs its exact effective permission request. */
  webFetchPermissionRequestId?: string | null;
}
export interface NativeFilePermissionRequest {
  requestId: string;
  capturedAtMs: number;
  name: 'Write' | 'Edit';
  input: Record<string, unknown>;
  cwd: string;
  result: 'pending' | 'completed' | 'error';
  nativeToolId?: string;
  nativeResultAtMs?: number;
  /** For early success, nativeResultAtMs is the owned hook observation time. */
  completionEvidence?: 'PostToolUse';
}
export interface NativePermissionGrant { nativeId?: string; requestId?: string; operation?: 'create' | 'edit' | 'overwrite' }

function questionInputWithDefaults(input: any): any {
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions)) return input;
  // The CLI hook supplies this default while its transcript can omit it.
  // Preserve every other field so actual input changes still fail comparison.
  return { ...input, questions: input.questions.map((question: any) =>
    question && typeof question === 'object' && !Array.isArray(question) && !Object.hasOwn(question, 'multiSelect')
      ? { ...question, multiSelect: false } : question) };
}

function questionBeforeAnswer(input: any): any {
  // CLI permission handling injects these response fields before tool.call.
  // All request fields, including metadata and every question/option, stay exact.
  const { answers, annotations, response, afkTimeoutMs, followUp, ...request } = input;
  return questionInputWithDefaults(request);
}

function questionCompletionText(response: Record<string, any>): string {
  // Pinned native formatter for the admitted complete offered-choice subset.
  const answers = response.questions.map((q: any) => {
    const preview = response.annotations?.[q.question]?.preview;
    return `"${q.question}"="${response.answers[q.question]}"${preview ? ` selected preview:\n${preview}` : ''}`;
  }).join(', ');
  return `Your questions have been answered: ${answers}. You can now continue with these answers in mind.`;
}

/** CLI 2.1.263 strips undeclared keys from nested AUQ objects before PreToolUse.
 * Keep the top level exact, including metadata/answers/annotations. Preserve
 * declared form-question fields too: a form cannot masquerade as a choice.
 * This projection is usable only when an owned execution hook corroborates it.
 */
function questionSchemaProjection(input: any): any {
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions)) return input;
  const pick = (value: any, keys: readonly string[]) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key))) : value;
  return { ...input, questions: input.questions.map((value: any) => {
    const question = pick(value, ['question', 'header', 'options', 'multiSelect',
      'kind', 'description', 'placeholder', 'min', 'max', 'step', 'defaultValue', 'unit']);
    return question && typeof question === 'object' && Array.isArray(question.options)
      ? { ...question, options: question.options.map((option: any) => pick(option, ['label', 'description', 'preview'])) }
      : question;
  }) };
}

/** Bounded schema diagnostics only; never include question or option content. */
function questionInputShape(input: any): string {
  const type = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim();
  const questions = input?.questions;
  return JSON.stringify({
    inputType: type(input), questionsType: type(questions),
    questionCount: Array.isArray(questions) ? questions.length : null,
    questionsTruncated: Array.isArray(questions) && questions.length > 4,
    questions: Array.isArray(questions) ? questions.slice(0, 4).map(q => ({
      type: type(q), questionType: type(q?.question), questionNonempty: nonempty(q?.question),
      headerType: type(q?.header), headerNonempty: nonempty(q?.header),
      multiSelectType: type(q?.multiSelect), optionsType: type(q?.options),
      optionCount: Array.isArray(q?.options) ? q.options.length : null,
      optionsTruncated: Array.isArray(q?.options) && q.options.length > 4,
      options: Array.isArray(q?.options) ? q.options.slice(0, 4).map((o: any) => ({
        type: type(o), labelType: type(o?.label), labelNonempty: nonempty(o?.label),
        descriptionType: type(o?.description),
      })) : [],
    })) : [],
  });
}

/** Pinned Claude 2.1.263 Nue/hSn formatter over the native Zod issue list.
 * Require both native error representations; a failure-looking prefix alone
 * cannot retire an invocation or supply an answer. */
function nativeQuestionSchemaRejection(row: any, block: any): { content: string; toolUseResult: string } | null {
  const prefix = 'InputValidationError: ';
  if (block.is_error !== true || typeof block.content !== 'string'
    || typeof row.toolUseResult !== 'string' || !row.toolUseResult.startsWith(prefix)) return null;
  const serialized = row.toolUseResult.slice(prefix.length);
  let issues: any[];
  try { issues = JSON.parse(serialized); } catch { return null; }
  if (!Array.isArray(issues) || issues.length === 0 || JSON.stringify(issues, null, 2) !== serialized
    || issues.some(issue => !issue || typeof issue !== 'object' || Array.isArray(issue)
      || typeof issue.code !== 'string' || !issue.code || typeof issue.message !== 'string'
      || !Array.isArray(issue.path) || issue.path.some((part: unknown) => typeof part !== 'string'
        && !(typeof part === 'number' && Number.isSafeInteger(part) && part >= 0))
      || issue.code === 'invalid_type' && typeof issue.expected !== 'string'
      || issue.code === 'unrecognized_keys' && (!Array.isArray(issue.keys)
        || issue.keys.some((key: unknown) => typeof key !== 'string')))) return null;
  const field = (parts: Array<string | number>) => parts.reduce<string>((text, part, index) =>
    typeof part === 'number' ? `${text}[${part}]` : index === 0 ? part : `${text}.${part}`, '');
  const messages = [
    ...issues.filter(issue => issue.code === 'invalid_type' && issue.message.includes('received undefined'))
      .map(issue => `The required parameter \`${field(issue.path)}\` is missing`),
    ...issues.filter(issue => issue.code === 'unrecognized_keys').flatMap(issue => issue.keys)
      .map(key => `An unexpected parameter \`${key}\` was provided`),
    ...issues.filter(issue => issue.code === 'invalid_type' && !issue.message.includes('received undefined'))
      .map(issue => `The parameter \`${field(issue.path)}\` type is expected as \`${issue.expected}\` but provided as \`${issue.message.match(/received (\w+)/)?.[1] ?? 'unknown'}\``),
  ];
  const detail = messages.length ? `AskUserQuestion failed due to the following ${messages.length > 1 ? 'issues' : 'issue'}:\n${messages.join('\n')}` : serialized;
  return block.content === `<tool_use_error>${prefix}${detail}</tool_use_error>`
    ? { content: block.content, toolUseResult: row.toolUseResult } : null;
}

/** The launch's native PreToolUse event can precede transcript persistence.
 * Both sources must agree. Exact owned successful PostToolUse data can retire
 * an answered AUQ or file request, or resolve a Bash invocation, before transcript persistence.
 * PTY scrollback and tool previews supply neither invocation nor acknowledgement.
 */
export function readPlanSkillQuestions(configDir: string | null, sessionId: string, events?: QuestionEventSource): {
  calls: NativeQuestionCall[];
  ready: boolean;
  /** Keeps pending exit identity in the native/frame stability comparison. */
  pendingExitPlanModeIds: string[];
  permissionTools: NativePermissionTool[];
  permissionResults: Array<{ id: string; result: 'completed' | 'error' }>;
  permissionRequests: NativeFilePermissionRequest[];
  permissionRequestCapture: boolean;
  pendingBytes: number;
} {
  const transcript = readOwnedClaudeTranscript(configDir, sessionId);
  const calls = new Map<string, NativeQuestionCall>();
  const results = new Map<string, boolean>();
  const resultTimes = new Map<string, number>();
  const ready = new Set<string>();
  const earlyExits = new Map<string, { input: Record<string, unknown>; cwd: string }>();
  const permissionTools = new Map<string, NativePermissionTool>();
  const inputs = new Map<string, unknown>();
  const executionQuestionInputs = new Map<string, unknown>();
  const comparisonQuestionInput = (id: string, input: any) => {
    const defaulted = questionInputWithDefaults(input);
    const executed = executionQuestionInputs.get(id);
    // A transcript alone never licenses dropping unknown fields. The complete
    // declared projection must match this launch's exact owned hook input.
    return executed !== undefined && isDeepStrictEqual(questionSchemaProjection(defaulted), executed)
      ? executed : defaulted;
  };
  const permissionInputs = new Map<string, NativePermissionTool>();
  const unfinishedFileInputs: NativePermissionTool[] = [];
  const observedToolInputs = new Map<string, NativePermissionTool>();
  const requestEvents = events ? readPermissionRequestEvents(events, { configDir, sessionId, transcriptFile: transcript.file }) : [];
  const bashRequestEvents = events ? readBashPermissionRequestEvents(events, { configDir, sessionId, transcriptFile: transcript.file }) : [];
  const fetchRequestEvents = events ? readWebFetchPermissionRequestEvents(events, { configDir, sessionId, transcriptFile: transcript.file }) : [];
  const fetchInvocationTimes = new Map<string, number>();
  const earlyCompletions = new Map<string, FileCompletionEventCall>();
  const questionCompletions = new Map<string, QuestionCompletionEventCall>();
  const ownedQuestionCompletionIds = new Set<string>();
  const bashInvocations = new Map<string, BashEventCall>();
  const bashCompletions = new Map<string, BashCompletionEventCall>();
  const validationAttempt = (id: string, rawInput: unknown): NativeQuestionCall => {
    // Only a launch with complete hook capture can prove this request has not
    // reached execution. Active forms/choices retain the existing strict parser.
    if (!events || executionQuestionInputs.has(id) || ownedQuestionCompletionIds.has(id)) {
      throw new Error('Unsupported native AskUserQuestion reached execution or lacks hook capture');
    }
    const invocations: Array<{ row: any; index: number; block: any }> = [];
    const completions: Array<{ row: any; index: number; block: any }> = [];
    transcript.rows.forEach((row, index) => {
      if (!Array.isArray(row.message?.content)) return;
      for (const block of row.message.content) {
        if (row.type === 'assistant' && row.message.role === 'assistant' && block?.type === 'tool_use' && block.id === id) {
          invocations.push({ row, index, block });
        }
        if (row.type === 'user' && row.message.role === 'user' && block?.type === 'tool_result' && block.tool_use_id === id) {
          completions.push({ row, index, block });
        }
      }
    });
    const invoked = invocations[0];
    if (invocations.length !== 1 || !invoked || invoked.block.name !== 'AskUserQuestion'
      || invoked.row.message.stop_reason !== 'tool_use' || invoked.row.cwd !== events.cwd
      || !isDeepStrictEqual(invoked.block.input, rawInput)) throw new Error('Native question validation changed input or owner');
    const validation: NonNullable<NativeQuestionCall['validation']> = { input: rawInput };
    if (completions.length) {
      const completed = completions[0]!;
      const invocationTime = Date.parse(invoked.row.timestamp);
      const completionTime = Date.parse(completed.row.timestamp);
      const rejection = nativeQuestionSchemaRejection(completed.row, completed.block);
      if (completions.length !== 1 || completed.index <= invoked.index || completed.row.cwd !== invoked.row.cwd
        || !Number.isFinite(invocationTime) || !Number.isFinite(completionTime) || completionTime < invocationTime
        || !rejection) throw new Error('Native question validation has an incompatible result');
      validation.rejection = rejection;
    }
    return { id, questions: [], result: validation.rejection ? 'error' : 'pending', validation };
  };
  const addQuestion = (id: unknown, input: any, fromExecution = false) => {
    if (typeof id !== 'string' || !id) throw new Error('Native AskUserQuestion is missing its tool ID');
    if (permissionInputs.has(id)) throw new Error('Native tool changed input or name for an existing tool ID');
    const rawInput = input;
    input = fromExecution ? questionInputWithDefaults(input) : comparisonQuestionInput(id, input);
    const questions = input?.questions;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4 || questions.some(q =>
      typeof q?.question !== 'string' || !q.question.trim() || typeof q.header !== 'string' || !q.header.trim()
      || typeof q.multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
      || q.options.some((o: any) => typeof o?.label !== 'string' || !o.label.trim() || typeof o.description !== 'string')
    )) {
      if (!fromExecution && events) {
        const attempt = validationAttempt(id, rawInput);
        if (inputs.has(id) && !isDeepStrictEqual(inputs.get(id), input)) throw new Error('Native AskUserQuestion changed input for an existing tool ID');
        inputs.set(id, input);
        calls.set(id, attempt);
        return;
      }
      throw new Error(`Unsupported native AskUserQuestion input shape: toolId=${JSON.stringify(id.slice(0, 128))}${id.length > 128 ? ' (truncated)' : ''} shape=${questionInputShape(input)}`);
    }
    if (inputs.has(id) && !isDeepStrictEqual(inputs.get(id), input)) {
      throw new Error('Native AskUserQuestion changed input for an existing tool ID');
    }
    inputs.set(id, input);
    calls.set(id, { id, questions, result: 'pending' });
  };
  const addPermission = (tool: NativePermissionTool) => {
    const previous = permissionInputs.get(tool.id);
    if (inputs.has(tool.id) || previous && (previous.name !== tool.name || !isDeepStrictEqual(previous.input, tool.input)
      || previous.cwd !== undefined && tool.cwd !== undefined && previous.cwd !== tool.cwd)) {
      throw new Error('Native tool changed input, name or cwd for an existing tool ID');
    }
    const bound = { ...(tool.name === 'WebFetch' ? { webFetchPermissionRequestId: null } : {}), ...previous, ...tool, ...(previous?.cwd !== undefined ? { cwd: previous.cwd } : {}) };
    if (['Read', 'Write', 'Edit', 'Bash', 'WebFetch'].includes(tool.name)) permissionInputs.set(tool.id, bound);
    permissionTools.set(tool.id, bound);
  };
  if (events) {
    for (const event of readBashEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      addPermission({ id: event.id, name: 'Bash', input: event.input, cwd: event.cwd, bashPermissionRequestId: null });
      bashInvocations.set(event.id, event);
    }
    for (const event of readBashCompletionEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      const invoked = bashInvocations.get(event.id);
      // Resolution alone cannot introduce an owner or authorize any input.
      if (!invoked) continue;
      if (event.cwd !== invoked.cwd || !isDeepStrictEqual(event.input, invoked.input)
        || event.capturedAtMs <= invoked.capturedAtMs) throw new Error('Native Bash completion changed input or preceded invocation');
      if (bashCompletions.has(event.id)) throw new Error('Conflicting native Bash completion for an existing tool ID');
      bashCompletions.set(event.id, event);
    }
    for (const event of readQuestionEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      addQuestion(event.id, event.input, true);
      executionQuestionInputs.set(event.id, questionInputWithDefaults(event.input));
    }
    for (const event of readQuestionCompletionEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      ownedQuestionCompletionIds.add(event.id);
      const invoked = executionQuestionInputs.get(event.id);
      // A post-hook alone cannot introduce a question or authorize its answer.
      if (invoked === undefined) continue;
      if (!isDeepStrictEqual(questionBeforeAnswer(event.input), questionBeforeAnswer(invoked))) {
        throw new Error('Native AskUserQuestion completion changed input');
      }
      questionCompletions.set(event.id, event);
    }
    for (const event of readExitPlanModeEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      if (inputs.has(event.id) || permissionInputs.has(event.id)) throw new Error('Native ExitPlanMode changed input or name for an existing tool ID');
      earlyExits.set(event.id, { input: event.input, cwd: event.cwd });
      ready.add(event.id);
    }
    for (const event of readFileCompletionEvents(events, { configDir, sessionId, transcriptFile: transcript.file })) {
      const matches = requestEvents.filter(request => request.toolName === event.toolName
        && request.cwd === event.cwd && isDeepStrictEqual(request.input, event.input));
      if (matches.length > 1) throw new Error('Indistinguishable repeated native file permission request');
      // Auto-allowed writes have no permission request to retire.
      if (!matches.length) continue;
      if (event.capturedAtMs <= matches[0]!.capturedAtMs) throw new Error('Native file completion does not follow its permission request');
      if (inputs.has(event.id) || earlyExits.has(event.id) || earlyCompletions.has(event.id)) {
        throw new Error('Native file completion changed input or name for an existing tool ID');
      }
      earlyCompletions.set(event.id, event);
      addPermission({ id: event.id, name: event.toolName, input: event.input, cwd: event.cwd });
    }
  }
  for (const row of transcript.rows) {
    const message = row.message;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      // Persistence can queue unfinished file calls, but one native ID still
      // denotes one immutable operation, including before stop_reason arrives.
      if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
        const previous = observedToolInputs.get(block.id);
        if (previous && (['Read', 'Write', 'Edit', 'WebFetch'].includes(previous.name) || ['Read', 'Write', 'Edit', 'WebFetch'].includes(block.name))
          && (previous.name !== block.name || !isDeepStrictEqual(previous.input, block.input ?? {})
            || previous.cwd !== undefined && typeof row.cwd === 'string' && previous.cwd !== row.cwd)) {
          throw new Error('Native file permission changed input, name or cwd for an existing tool ID');
        }
        observedToolInputs.set(block.id, { id: block.id, name: block.name, input: block.input ?? {},
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : previous?.cwd !== undefined ? { cwd: previous.cwd } : {}) });
      }
      if (row.type === 'user' && message.role === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const bashCompletion = bashCompletions.get(block.tool_use_id);
        if (bashCompletion) {
          const failed = bashCompletion.hookEventName === 'PostToolUseFailure' || bashCompletion.response.interrupted === true;
          const raw = bashCompletion.response;
          // The native storage adapter can clear stdout/stderr after persisting
          // the large output. Every other field, including background flags, stays exact.
          const stored = { ...raw, stdout: '', stderr: '' };
          if ((block.is_error === true) !== failed
            || bashCompletion.hookEventName === 'PostToolUse' && row.toolUseResult !== undefined
              && !isDeepStrictEqual(row.toolUseResult, raw) && !isDeepStrictEqual(row.toolUseResult, stored)
            || bashCompletion.hookEventName === 'PostToolUseFailure' && raw.is_interrupt === false
              && block.content !== raw.error) throw new Error('Native Bash completion conflicts with its later result');
        }
        const questionCompletion = questionCompletions.get(block.tool_use_id);
        if (questionCompletion && (block.is_error === true
          || row.toolUseResult !== undefined && !isDeepStrictEqual(row.toolUseResult, questionCompletion.response)
          || block.content !== questionCompletionText(questionCompletion.response))) {
          throw new Error('Native AskUserQuestion completion conflicts with its later result');
        }
        const completion = earlyCompletions.get(block.tool_use_id);
        if (completion) {
          // tool_response is raw native data, not rendered tool_result text.
          // CLI storage may clear only these large fields (Edit/Write schemas).
          const raw = completion.response;
          const stored = completion.toolName === 'Edit' && raw.originalFile
            ? { ...raw, originalFile: '' }
            : completion.toolName === 'Write' && raw.type === 'update'
              && !(raw.content === '' && (raw.originalFile ?? '') === '')
              && !(Array.isArray(raw.structuredPatch) && raw.structuredPatch.length === 0 && raw.originalFile === null)
              ? { ...raw, content: '', originalFile: null } : raw;
          // CLI 2.1.263's transcript append writer also clears originalFile
          // above 10,000 JavaScript UTF-16 units, after any tool storage form.
          const appended = (value: Record<string, unknown>) => typeof value.originalFile === 'string'
            && value.originalFile.length > 10_000 ? { ...value, originalFile: null } : value;
          if (block.is_error === true || row.toolUseResult !== undefined
            && !isDeepStrictEqual(row.toolUseResult, raw) && !isDeepStrictEqual(row.toolUseResult, stored)
            && !isDeepStrictEqual(row.toolUseResult, appended(raw)) && !isDeepStrictEqual(row.toolUseResult, appended(stored))) {
            throw new Error('Native file completion conflicts with its later result');
          }
        }
        results.set(block.tool_use_id, block.is_error === true);
        resultTimes.set(block.tool_use_id, typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN);
      }
      // Exit's PreToolUse input is already normalized by the CLI. Preserve
      // injected plan fields; even unfinished persisted conflicts fail closed.
      const earlyExit = earlyExits.get(block?.id);
      if (earlyExit && row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use'
        && (block.name !== 'ExitPlanMode' || !isDeepStrictEqual(earlyExit.input, block.input)
          || typeof row.cwd === 'string' && row.cwd !== earlyExit.cwd)) {
        throw new Error('Native ExitPlanMode changed input, name or cwd for an existing tool ID');
      }
      // An unfinished assistant record cannot introduce a call, but it can
      // invalidate conflicting early evidence before any input is sent.
      if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use' && inputs.has(block.id)
        && (block.name !== 'AskUserQuestion' || !isDeepStrictEqual(inputs.get(block.id), comparisonQuestionInput(block.id, block.input)))) {
        throw new Error('Native AskUserQuestion changed input for an existing tool ID');
      }
      if (row.type === 'assistant' && message.role === 'assistant' && block?.type === 'tool_use' && permissionInputs.has(block.id)) {
        addPermission({ id: block.id, name: block.name, input: block.input ?? {},
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) });
      }
      if (row.type === 'assistant' && message.role === 'assistant' && message.stop_reason !== 'tool_use'
        && block?.type === 'tool_use' && ['Write', 'Edit'].includes(block.name)) {
        unfinishedFileInputs.push({ id: block.id, name: block.name, input: block.input ?? {},
          ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) });
      }
      if (row.type !== 'assistant' || message.role !== 'assistant' || message.stop_reason !== 'tool_use' || block?.type !== 'tool_use') continue;
      if (block.name === 'WebFetch' && !fetchInvocationTimes.has(block.id)) {
        fetchInvocationTimes.set(block.id, typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN);
      }
      if (block.name === 'ExitPlanMode' && typeof block.id === 'string') ready.add(block.id);
      else if (block.name !== 'AskUserQuestion' && typeof block.id === 'string') addPermission({
        id: block.id, name: block.name, input: block.input ?? {},
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
      });
      if (block.name !== 'AskUserQuestion') continue;
      addQuestion(block.id, block.input);
    }
  }
  // A native result resolves its invocation even before stop_reason is flushed.
  // Validate completed file inputs for request retirement only; unfinished
  // pending inputs still cannot introduce a native grant owner.
  for (const tool of unfinishedFileInputs) {
    if (results.has(tool.id)) addPermission(tool);
  }
  for (const call of calls.values()) {
    const completion = questionCompletions.get(call.id);
    if (completion) {
      call.result = 'answered';
      call.answerLabels = call.questions.map(q => (completion.response.answers as Record<string, string>)[q.question]!);
    } else if (results.has(call.id)) call.result = results.get(call.id) ? 'error' : 'answered';
  }
  for (const completion of bashCompletions.values()) {
    // Background launch means this invocation resolved, not that its command
    // or process finished. Failed/interrupted invocations retain error status.
    results.set(completion.id, completion.hookEventName === 'PostToolUseFailure' || completion.response.interrupted === true);
    resultTimes.set(completion.id, completion.capturedAtMs);
  }
  for (const completion of earlyCompletions.values()) {
    results.set(completion.id, false);
    resultTimes.set(completion.id, completion.capturedAtMs);
  }
  for (const request of bashRequestEvents) {
    const matches = [...bashInvocations.values()].filter(invoked => invoked.cwd === request.cwd
      && isDeepStrictEqual(invoked.input, request.input) && invoked.capturedAtMs < request.capturedAtMs
      && (!resultTimes.has(invoked.id) || resultTimes.get(invoked.id)! > request.capturedAtMs));
    if (matches.length > 1) throw new Error('Ambiguous native Bash permission request');
    if (!matches.length) continue; // Orphan or changed post-Pre input cannot authorize a grant.
    const owner = permissionTools.get(matches[0]!.id)!;
    if (owner.bashPermissionRequestId !== null) throw new Error('Duplicate native Bash permission request');
    owner.bashPermissionRequestId = request.requestId;
  }
  for (const request of fetchRequestEvents) {
    const matches = [...permissionTools.values()].filter(tool => tool.name === 'WebFetch' && tool.cwd === request.cwd
      && isDeepStrictEqual(tool.input, request.input) && fetchInvocationTimes.get(tool.id)! < request.capturedAtMs
      && (!resultTimes.has(tool.id) || resultTimes.get(tool.id)! > request.capturedAtMs));
    if (matches.length > 1) throw new Error('Ambiguous native WebFetch permission request');
    if (!matches.length) continue; // Orphan, changed, unfinished or already resolved input cannot grant.
    const owner = matches[0]!;
    if (owner.webFetchPermissionRequestId !== null) throw new Error('Duplicate native WebFetch permission request');
    owner.webFetchPermissionRequestId = request.requestId;
  }
  const permissionRequests: NativeFilePermissionRequest[] = [];
  if (events) {
    for (const event of requestEvents) {
      // PermissionRequest has no native tool ID. Its observer requestId is
      // separate; only a unique, exact native invocation/result can finish it.
      const candidates = [...permissionInputs.values()].filter(tool => tool.name === event.toolName
        && tool.cwd === event.cwd && isDeepStrictEqual(tool.input, event.input));
      if (candidates.length > 1 || permissionRequests.some(request => request.name === event.toolName
        && request.cwd === event.cwd && isDeepStrictEqual(request.input, event.input))) {
        throw new Error('Indistinguishable repeated native file permission request');
      }
      const native = candidates[0];
      const resultAfterRequest = native && results.has(native.id) && Number.isFinite(resultTimes.get(native.id))
        && resultTimes.get(native.id)! > event.capturedAtMs;
      const pendingInputs = resultAfterRequest ? []
        : [...permissionInputs.values(), ...unfinishedFileInputs].filter(tool => !results.has(tool.id));
      const exactPendingIds = new Set(pendingInputs.filter(tool => tool.name === event.toolName
        && tool.cwd === event.cwd && isDeepStrictEqual(tool.input, event.input)).map(tool => tool.id));
      if (exactPendingIds.size > 1) throw new Error('Indistinguishable repeated native file permission request');
      for (const tool of pendingInputs) {
        // Distinct unfinished edits can be queued for this same path. An exact
        // current request identifies its input; queued siblings gain no grant
        // authority, and finalized competing owners still fail closed.
        const queuedSibling = exactPendingIds.size === 1 && !exactPendingIds.has(tool.id) && !permissionInputs.has(tool.id);
        if (!queuedSibling && tool.input.file_path === event.input.file_path && (tool.name !== event.toolName
          || tool.cwd !== event.cwd || !isDeepStrictEqual(tool.input, event.input))) {
          throw new Error('Native file permission changed input, name or cwd');
        }
      }
      permissionRequests.push({ requestId: event.requestId, capturedAtMs: event.capturedAtMs, name: event.toolName, input: event.input, cwd: event.cwd,
        result: resultAfterRequest ? results.get(native!.id) ? 'error' : 'completed' : 'pending',
        ...(resultAfterRequest ? { nativeResultAtMs: resultTimes.get(native!.id)! } : {}),
        ...(resultAfterRequest && earlyCompletions.has(native!.id) ? { completionEvidence: 'PostToolUse' as const } : {}),
        ...(native && (!results.has(native.id) || resultAfterRequest) ? { nativeToolId: native.id } : {}) });
    }
  }
  const pendingExitPlanModeIds = [...ready].filter(id => !results.has(id));
  return { calls: [...calls.values()], ready: pendingExitPlanModeIds.length > 0, pendingExitPlanModeIds,
    permissionTools: [...permissionTools.values()].filter(tool => !results.has(tool.id)),
    permissionResults: [...permissionTools.keys()].filter(id => results.has(id)).map(id => ({ id, result: results.get(id) ? 'error' : 'completed' })),
    permissionRequests,
    permissionRequestCapture: events !== undefined,
    pendingBytes: transcript.pendingBytes };
}

// Terminal markdown/positioning can remove whitespace and decoration; semantic
// question text and option labels must still match the owned tool input.
const compact = (value: string) => value.replace(/<gstack-qid:[^>]+>/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** Read only a physical side-preview frame. Other layouts retain the existing
 * parser; preview text never supplies label characters. */
function previewQuestionOptions(question: NativeQuestion, menu: string): { options: Array<{ index: number; label: string }>; focusedIndex: number } | null {
  const invalid = { options: [], focusedIndex: 0 };
  let lines = menu.split(/\r?\n/);
  // A glyph in an offered label is not a preview. Require a separated border
  // band corroborated by an aligned right-column body or bottom row.
  const apparentPreview = lines.slice(1).some(line => {
    const body = / {2,}(│.*│|└─+┘)[ \t]*$/.exec(line);
    if (!body) return false;
    const column = body.index + body[0].indexOf(body[1]!);
    const band = lines[0]!.slice(column);
    return column >= 6 && / {2}$/.test(lines[0]!.slice(0, column))
      && /^[┌┐─ \t]+$/.test(band) && /[┌┐─]/.test(band);
  });
  if (!apparentPreview) return null;
  const top = /┌─+┐[ \t]*$/.exec(lines[0]!);
  if (!top) return invalid;
  const column = top.index;
  const edge = column + top[0].trimEnd().length - 1;
  if (column < 6 || !/ {2}$/.test(lines[0]!.slice(0, column))) return invalid;
  let bottom = -1;
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i]!;
    if (row[column] === '└') {
      if (row[edge] !== '┘' || !/^─+$/.test(row.slice(column + 1, edge)) || row.slice(edge + 1).trim()) return invalid;
      bottom = i;
      break;
    }
    // Native clipping adds one ruler immediately before the bottom. The
    // independent left column may still contain an option or continuation.
    if (row[column] === '├') {
      if (row[edge] !== '┤' || !/^├─── ✂ ─── [1-9]\d* lines hidden ─*┤$/.test(row.slice(column, edge + 1))
        || row.slice(edge + 1).trim() || lines[i + 1]?.[column] !== '└') return invalid;
      continue;
    }
    if (row[column] !== '│' || row[edge] !== '│' || row.slice(edge + 1).trim()) return invalid;
  }
  if (bottom < 0) return invalid;
  // The option column can be taller than the preview (including its empty
  // state). Continue only inside that same column; the native Notes hint is
  // the sole supported right-column content below the verified rectangle.
  let optionEnd = bottom + 1;
  let notes = false;
  for (; optionEnd < lines.length; optionEnd++) {
    const row = lines[optionEnd]!;
    const left = row.slice(0, column).trimEnd();
    if (!/^[ \t]*(?:❯[ \t]*)?[1-9]\.[ \t]*\S/.test(left) && !/^ {4,}\S/.test(left)) break;
    const right = row.slice(column).trimEnd();
    if (right.trim()) {
      if (notes || right !== 'Notes: press n to add notes' || !/ {2}$/.test(row.slice(0, column))) return invalid;
      notes = true;
    }
  }
  // Only cursor tokens inside a verified preview are decorative. A later
  // menu after this frame restores the existing latest-menu selection.
  let focusedIndex = 0;
  for (const match of menu.matchAll(/❯\s*([1-9])\./g)) {
    const before = menu.slice(0, match.index);
    const row = before.split('\n').length - 1;
    const cursorColumn = match.index - (before.lastIndexOf('\n') + 1);
    if (row >= optionEnd) return null;
    if (cursorColumn < column && /^[ \t]*❯[ \t]*[1-9]\./.test(lines[row]!)) {
      if (focusedIndex || /[\r\n]/.test(match[0])) return invalid;
      focusedIndex = Number(match[1]);
      continue;
    }
    if (row < 1 || row >= bottom || cursorColumn <= column
      || cursorColumn + match[0].length > edge || /[\r\n]/.test(match[0])) return invalid;
  }
  lines = lines.slice(0, optionEnd).map(line => line.slice(0, column).trimEnd());
  const found: Array<{ index: number; label: string }> = [];
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    const numbered = /^[ \t]*(?:❯[ \t]*)?([1-9])\.[ \t]*(\S.*)$/.exec(line);
    if (numbered) {
      const index = Number(numbered[1]);
      if (index > question.options.length) break; // Native Other/Chat controls.
      if (index !== found.length + 1) return invalid;
      const previous = found.at(-1);
      if (previous && !compact(previous.label).startsWith(compact(question.options[previous.index - 1]!.label))) return invalid;
      found.push({ index, label: numbered[2]! });
    } else {
      const previous = found.at(-1);
      if (!previous) return invalid;
      const complete = compact(previous.label).startsWith(compact(question.options[previous.index - 1]!.label));
      if (!/^ {4,}\S/.test(line)) {
        if (!complete && lines.slice(row).some(tail => tail.trim())) return invalid;
        break;
      }
      if (complete) continue; // A description is not another offered label.
      previous.label += ' ' + line.trim();
    }
    const current = found.at(-1)!;
    const offered = compact(question.options[current.index - 1]!.label);
    const rendered = compact(current.label);
    if (!rendered || (!offered.startsWith(rendered) && !rendered.startsWith(offered))) return invalid;
  }
  // Extending below the pane requires the complete owned option inventory,
  // not an unbounded continuation or a second menu joined to this frame.
  if (optionEnd > bottom + 1 && (found.length !== question.options.length || found.some(option =>
    !compact(option.label).startsWith(compact(question.options[option.index - 1]!.label))))) return invalid;
  // The final choice may extend below the viewport. Its prefix is validated
  // above; the caller still requires two other complete offered labels.
  return { options: found, focusedIndex };
}

/** A plain menu may wrap only its recommendation annotation to the next
 * physical line. Both fragments must render; descriptions/previews cannot
 * complete a missing label and native input never supplies display text. */
function plainRecommendedOptions(question: NativeQuestion, menu: string, options: Array<{ index: number; label: string }>): Array<{ index: number; label: string }> {
  if (question.options.some(option => option.preview !== undefined)) return options;
  const lines = menu.split(/\r?\n/);
  return options.map(option => {
    const offered = question.options[option.index - 1];
    if (!offered?.label.endsWith(' (recommended)')) return option;
    const matches = lines.flatMap((line, index) => {
      const row = /^[ \t]*(?:❯[ \t]*)?([1-9])\.[ \t]*(\S.*)$/.exec(line);
      return row && Number(row[1]) === option.index && compact(row[2]!) === compact(option.label) ? [index] : [];
    });
    if (matches.length !== 1) return option;
    const continuation = lines[matches[0]! + 1];
    if (!continuation || !/^[ \t]*\(recommended\)[ \t]*$/.test(continuation)) return option;
    const label = option.label + ' ' + continuation.trim();
    return compact(label) === compact(offered.label) ? { ...option, label } : option;
  });
}

export function matchesNativeQuestion(question: NativeQuestion, visible: string, options: Array<{ index: number; label: string }>, others: NativeQuestion[] = []): boolean {
  if (others.some(other => other !== question && compact(other.question) === compact(question.question)
    && compact(other.header) === compact(question.header) && JSON.stringify(other.options.map(o => o.label)) === JSON.stringify(question.options.map(o => o.label)))) {
    throw new Error('Indistinguishable repeated native question: current rendering cannot identify a new invocation');
  }
  const physicalCursor = [...visible.matchAll(/^[ \t]*(?:❯[ \t]*)?1\./gm)].at(-1);
  const physicalOptions = physicalCursor ? previewQuestionOptions(question, visible.slice(physicalCursor.index)) : null;
  const cursor = physicalOptions === null ? [...visible.matchAll(/❯\s*1\./g)].at(-1) : physicalCursor;
  if (!cursor) return false;
  const prefix = visible.slice(0, cursor.index);
  const box = Math.max(prefix.lastIndexOf('☐'), prefix.lastIndexOf('☑'), prefix.lastIndexOf('✔'));
  // The native box identifies the current prompt region. Match its heading
  // rather than requiring the whole lengthy decision brief to survive a
  // viewport repaint. Classic unboxed fixtures require the entire question.
  const heading = question.question.split(/\r?\n/).find(line => line.trim())!;
  const ambiguousHeading = others.some(other => compact(other.question) !== compact(question.question)
    && compact(other.question.split(/\r?\n/).find(line => line.trim()) ?? '') === compact(heading));
  const promptMatches = box >= 0
    ? compact(prefix).includes(compact(question.header)) && (ambiguousHeading
      ? compact(prefix.slice(box)).endsWith(compact(question.question))
      : compact(prefix.slice(box)).includes(compact(heading)))
    : compact(prefix).endsWith(compact(question.question));
  if (!promptMatches) return false;
  // Rendered choices corroborate the prompt; the complete offered inventory
  // and numeric selection come from native input, even below the viewport.
  const renderedOptions = physicalOptions?.options ?? plainRecommendedOptions(question, visible.slice(cursor.index), options);
  return renderedOptions.filter(rendered => {
    const offered = question.options[rendered.index - 1];
    return offered && compact(rendered.label).startsWith(compact(offered.label));
  }).length >= 2;
}

/** Normal single-select digits commit immediately. The CLI's preview menu
 * instead focuses with a digit and commits the rendered focus with Enter.
 * Require both native preview inventory and its current physical controls;
 * accessible/plain rendering of preview input is deliberately unsupported.
 */
export function nativeQuestionSelection(question: NativeQuestion, visible: string,
  options: Array<{ index: number; label: string }>, others: NativeQuestion[] = []):
  { kind: 'digit' } | { kind: 'preview'; focusedIndex: number } | null {
  if (question.multiSelect || !matchesNativeQuestion(question, visible, options, others)) return null;
  const first = [...visible.matchAll(/^[ \t]*(?:❯[ \t]*)?1\./gm)].at(-1);
  const frame = first ? previewQuestionOptions(question, visible.slice(first.index)) : null;
  const preview = question.options.some(option => option.preview !== undefined);
  if (!preview && frame === null) return { kind: 'digit' };
  if (!preview || !frame || !frame.focusedIndex) return null;
  const focused = frame.options.find(option => option.index === frame.focusedIndex);
  const offered = question.options[frame.focusedIndex - 1];
  if (!focused || !offered || !compact(focused.label).startsWith(compact(offered.label))) return null;
  if (!/^Enter to select · ↑\/↓ to navigate · n to add notes(?: · Tab to switch questions)? · Esc to cancel$/.test(visible.trim().split('\n').at(-1)!.trim())) return null;
  return { kind: 'preview', focusedIndex: frame.focusedIndex };
}

/** A lone pending tool is insufficient: its command/path must also identify
 * the displayed permission. Unsupported or repeated ambiguous grants fail.
 */
function currentFilePermissionDetails(visible: string): { operation: 'create' | 'edit' | 'overwrite'; filePath: string; accessDirectory?: string } | null {
  const cursor = [...visible.matchAll(/❯\s*1\./g)].at(-1);
  if (!cursor) return null;
  // Bind the current menu's distinctive CLI controls, not a prose question
  // containing "create" or a stale permission earlier in scrollback.
  let menu = visible.slice(cursor.index);
  // The CLI combines edit-mode and outside-directory access in option 2.
  // Keep its complete directory as text: whitespace compaction would make
  // distinct paths equal or hide a clipped/wrapped path. We still grant only 1.
  const extension = /;\s*Yes,\s*and\s+always\s+allow\s+access\s+to[ \n]+([^\s][^\r\n\t\u0000-\u001f]*?)[ \n]+for\s+this\s+session(?=[ \n]*(?:\(shift\+tab\))?[ \n]*3\.)/.exec(menu);
  const accessDirectory = extension?.[1];
  if (extension) {
    if (!accessDirectory || !path.isAbsolute(accessDirectory) || accessDirectory !== accessDirectory.trim()
      || accessDirectory.includes('…') || accessDirectory.includes('...')) return null;
    menu = menu.slice(0, extension.index) + menu.slice(extension.index + extension[0].length);
  }
  const controls = menu.replace(/\s+/g, '');
  // Pinned MEt/Z0o use this standing row for all non-read settings-file
  // operations, including Write's create/overwrite. Only option 1 is granted.
  const settingsFile = /^❯1\.Yes2\.Yes,andallowClaudetoedititsownsettingsforthissession3\.No(?:\b|Esc)/.test(controls);
  if (!settingsFile && !/^❯1\.Yes2\.Yes,andswitchtoacceptedits\(auto-approvefileeditsandcommonfilecommands\)forthissession(?:\(shift\+tab\))?3\.No(?:\b|Esc)/.test(controls)) return null;
  const prompt = /Do\s*you\s*want\s*to\s*(create|edit|overwrite|make\s+this\s+edit\s+to)\s+([^\r\n?]+)\?\s*$/.exec(visible.slice(0, cursor.index));
  if (!prompt) return null;
  const operation = prompt[1]!.startsWith('make') ? 'edit' : prompt[1] as 'create' | 'edit' | 'overwrite';
  let filePath = prompt[2]!.trim();
  // Claude's file dialog asks about a basename, but its own title/subtitle
  // identifies the complete path. Bind only that current, untruncated header;
  // a path mentioned in the preview or a previous dialog has no authority.
  const before = visible.slice(0, prompt.index).split('\n');
  const headers = before.flatMap((line, index) => /^ (Create|Edit|Overwrite) file$/.test(line) ? [index] : []);
  if (headers.length) {
    if (headers.length !== 1) return null;
    const index = headers[0]!;
    const title = { create: 'Create', edit: 'Edit', overwrite: 'Overwrite' }[operation];
    // At the viewport's first line, only the preceding rule can be clipped.
    // The complete rule directly below the subtitle still bounds its width.
    const clippedTopRule = index === 0 && /^╌{10,}$/.test(before[index + 2] ?? '');
    const rule = clippedTopRule ? before[index + 2]! : before[index - 1] ?? '';
    // Strip ASCII display padding only. Preserve leading/interior path bytes;
    // nativePermissionKey still compares the exact owned filesystem path.
    const subtitle = before[index + 1]?.slice(1).replace(/ +$/, '');
    if (before[index] !== ` ${title} file` || !clippedTopRule && !/^─{10,}$/.test(rule)
      || !before[index + 1]?.startsWith(' ') || !subtitle || subtitle !== subtitle.trim()
      || /[\r\t\u0000-\u001f…]/.test(subtitle) || subtitle.startsWith('...')
      || path.basename(subtitle) !== filePath || before.slice(index + 2).some(line => /^\s*❯\s*\d+\./.test(line))
      || before.slice(index, index + 2).some(line => line.length > rule.length)) return null;
    filePath = subtitle;
  } else if (accessDirectory && path.basename(filePath) === filePath && !['.', '..'].includes(filePath)) {
    // A long preview can scroll the title away. The current option-2 label
    // still supplies its complete directory; combine it with this basename
    // for identity only. The caller continues to grant one-time option 1.
    filePath = path.join(accessDirectory, filePath);
  }
  return { operation, filePath, ...(accessDirectory ? { accessDirectory } : {}) };
}

export function currentFilePermissionTarget(visible: string): { operation: 'create' | 'edit' | 'overwrite'; filePath: string } | null {
  const current = currentFilePermissionDetails(visible);
  return current ? { operation: current.operation, filePath: current.filePath } : null;
}

/** The last native card rule selects the active header; prior tool cards
 * cannot authorize or veto the current one. A clipped top rule at row zero
 * can identify Bash for refusal, but cannot make its card complete. */
export function hasCurrentBashPermissionHeading(visible: string): boolean {
  const lines = visible.split('\n');
  const top = lines.findLastIndex(line => /^─{10,} *$/.test(line));
  return /^ Bash command(?:[ (]|$)/.test(lines[top + 1] ?? '');
}

export function hasCurrentWebFetchPermissionHeading(visible: string): boolean {
  const lines = visible.split('\n');
  const top = lines.findLastIndex(line => /^─{10,} *$/.test(line));
  return /^ Fetch(?: |$)/.test(lines[top + 1] ?? '');
}

export function hasCurrentReadPermissionHeading(visible: string): boolean {
  const lines = visible.split('\n');
  const top = lines.findLastIndex(line => /^─{10,} *$/.test(line));
  return /^ Read file(?: |$)/.test(lines[top + 1] ?? '');
}

/** Pinned Read card: the directory label corroborates the full file path but
 * never grants directory access. Only its focused one-time Yes is supported. */
export function currentReadPermissionCard(visible: string): { filePath: string } | null {
  const lines = visible.split('\n').map(line => line.replace(/ +$/, ''));
  while (lines.at(-1) === '') lines.pop();
  const top = lines.findLastIndex(line => /^─{10,}$/.test(line));
  if (top < 0 || lines.length !== top + 11 || lines[top + 1] !== ' Read file') return null;
  const columns = lines[top]!.length;
  if (columns < 40 || lines.slice(top + 1).some(line => line.length > columns || /[\r\t\x00-\x1f]/.test(line))) return null;
  let fence = '';
  for (const line of lines.slice(0, top)) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1]!;
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = '';
  }
  if (fence) return null;
  const filePath = /^  Read\((.+)\)$/.exec(lines[top + 3] ?? '')?.[1];
  if (!filePath || !path.isAbsolute(filePath) || filePath !== filePath.trim() || /…|\.\.\./.test(filePath)
    || lines[top + 2] !== '' || lines[top + 4] !== '' || lines[top + 5] !== ' Do you want to proceed?'
    || lines[top + 6] !== ' ❯ 1. Yes'
    || lines[top + 7] !== `   2. Yes, allow reading from ${path.dirname(filePath)} during this session`
    || lines[top + 8] !== '   3. No' || lines[top + 9] !== '' || lines[top + 10] !== ' Esc to cancel · Tab to amend') return null;
  return { filePath };
}

/** Complete native Fetch card: one-time Yes, exact domain and unmodified payload. */
export function currentWebFetchPermissionCard(visible: string): { columns: number; domain: string; payload: string[] } | null {
  const lines = visible.split('\n').map(line => line.replace(/ +$/, ''));
  while (lines.at(-1) === '') lines.pop();
  const top = lines.findLastIndex(line => /^─{10,}$/.test(line));
  if (top < 0 || lines[top + 1] !== ' Fetch' || lines[top + 2] !== '') return null;
  const columns = lines[top]!.length;
  if (columns < 40 || lines.slice(top + 1).some(line => line.length > columns || /[\r\t\x00-\x1f]/.test(line))) return null;
  let fence = '';
  for (const line of lines.slice(0, top)) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1]!;
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = '';
  }
  if (fence) return null;
  const detail = lines.length - 6;
  const domain = /^   Claude wants to fetch content from ([a-z0-9.-]+)$/.exec(lines[detail] ?? '')?.[1];
  if (!domain || detail < top + 5 || lines[detail + 1] !== ''
    || lines[detail + 2] !== ' Do you want to allow Claude to fetch this content?'
    || lines[detail + 3] !== ' ❯ 1. Yes'
    || lines[detail + 4] !== `   2. Yes, and don't ask again for ${domain}`
    || lines[detail + 5] !== '   3. No, and tell Claude what to do differently (esc)') return null;
  const payload = lines.slice(top + 3, detail);
  if (!payload.every(line => line.startsWith('   │ '))) return null;
  return { columns, domain, payload };
}

/** Pinned CLI 2.1.263 gs/$At/jAt controls. The current card must be complete:
 * the first choice is a one-time Yes, and neither a history example nor a
 * clipped command can supply authority. Payload identity is checked below. */
export function currentBashPermissionCard(visible: string, includeReadDirectories = true): { columns: number; payload: string[] } | null {
  const lines = visible.split('\n').map(line => line.replace(/ +$/, ''));
  while (lines.at(-1) === '') lines.pop();
  const footer = lines.length - 1;
  if (lines[footer] !== ' Esc to cancel · Tab to amend' || lines[footer - 1] !== '') return null;
  const top = lines.findLastIndex(line => /^─{10,}$/.test(line));
  if (top < 0 || !/^ Bash command(?: \(unsandboxed\))?$/.test(lines[top + 1] ?? '')) return null;
  const columns = lines[top]!.length;
  if (columns < 40 || lines.slice(top + 1).some(line => line.length > columns || /[\r\t\x00-\x1f]/.test(line))) return null;
  let fence = '';
  for (const line of lines.slice(0, top)) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1]!;
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = '';
  }
  if (fence) return null;
  let start = top + 2;
  if (lines[start] === ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below') start++;
  if (lines[start++] !== '') return null;
  const end = lines.findIndex((line, index) => index >= start && line === '');
  if (end < start + 2 || lines.slice(start, end).some(line => !line.startsWith('   '))) return null;
  const prompt = lines.findLastIndex(line => line === ' Do you want to proceed?');
  // Optional native reasons can contain literal shell tokens such as <N-M>.
  // Reject prompt/quotation prefixes and option rows, not embedded punctuation.
  if (prompt <= end || lines.slice(end + 1, prompt).some(line => /❯|^\s*(?:>|\d+\.)/.test(line))) return null;
  if (lines[prompt + 1] !== ' ❯ 1. Yes') return null;
  let number = 2;
  for (let index = prompt + 2; index < footer - 1; index++, number++) {
    const option = /^   ([2-4])\. (.+)$/.exec(lines[index]!);
    if (!option || Number(option[1]) !== number) return null;
    if (option[2] === 'No') {
      return index === footer - 2 ? { columns, payload: lines.slice(start, end) } : null;
    }
    // Jxt/Nae also render a Read-only standing rule for one or two directories.
    // Admit only complete, single-line absolute paths followed by No. This is
    // an unselected label; authority still comes from the exact native command.
    const readDirectories = /^Yes, allow reading from (\/[A-Za-z0-9_./-]+(?: and \/[A-Za-z0-9_./-]+)?) from this project$/.exec(option[2]!);
    if (readDirectories) {
      if (!includeReadDirectories || number !== 2 || readDirectories[1]!.split(' and ').some(dir => dir.includes('..') || path.posix.normalize(dir) !== dir)
        || lines[index + 1] !== '   3. No' || index + 1 !== footer - 2) return null;
      return { columns, payload: lines.slice(start, end) };
    }
    // The CLI puts a long standing-permission prefix entirely on continuation
    // rows. Its label alone is incomplete; the selected Yes stays one-time.
    const wrappedPrefix = option[2] === 'Yes, and don’t ask again for:'
      && /^      \S/.test(lines[index + 1] ?? '');
    if (!wrappedPrefix && !/^Yes, and don’t ask again for: \S/.test(option[2]!)
      && !/^Yes, and switch to auto mode(?: · .+)?$/.test(option[2]!)) return null;
    while (/^      \S/.test(lines[index + 1] ?? '')) index++;
  }
  return null;
}

let nativePayloadSegmenter: Intl.Segmenter | undefined;

/** Match the renderer's projection, never whitespace-normalize the command.
 * The pinned CLI passes unsanitized single-codepoint graphemes to Bun.wrapAnsi.
 * Keep the proven one-cell BMP subset; complex/zero-width/wide text is refused. */
function nativeBashPayload(value: string, columns: number): string[] | null {
  if (value.length > 200_000 || typeof Bun.wrapAnsi !== 'function') return null;
  if (/[^\x20-\x7e\n]/.test(value)) {
    if (typeof Intl.Segmenter !== 'function' || typeof Bun.stringWidth !== 'function') return null;
    nativePayloadSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of nativePayloadSegmenter.segment(value)) {
      if (segment === ' ' || segment === '\n') continue;
      // U+2800 is also treated as invisible by the pinned sanitizer. Do not
      // admit separators, controls, combining marks or surrogate pairs.
      if (segment.length !== 1 || /[\p{Cc}\p{Cf}\p{Cs}\p{M}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/u.test(segment)
        || Bun.stringWidth(segment, { ambiguousIsNarrow: true }) !== 1) return null;
    }
  }
  const gutter = value.includes('\n') || value.length > 80;
  const prefix = gutter ? '   │ ' : '   ';
  // Pinned Eg preserves hard-line indentation, but elides one separator on
  // soft continuations. Each admitted row character has positive display width.
  return value.split('\n').flatMap(line => Bun.wrapAnsi(line, columns - (gutter ? 8 : 6), { hard: true, trim: false })
    .split('\n').map((row, index) => index > 0 && row.startsWith(' ') && row.length > 1 ? row.slice(1) : row))
    .map(line => (prefix + line).replace(/ +$/, ''));
}

/** A clipped payload suffix can request one repaint, never grant permission.
 * Reconstruct only to validate the pinned controls; nativePermissionKey must
 * later match the complete real frame. No header or history supplies authority. */
export function matchesClippedBashPermission(tool: NativePermissionTool, visible: string, columns: number): boolean {
  if (tool.name !== 'Bash' || tool.bashPermissionRequestId === null || ![120, 240].includes(columns)
    || typeof tool.input.command !== 'string') return false;
  const description = tool.input.description === undefined || tool.input.description === '' ? 'Run shell command' : tool.input.description;
  if (typeof description !== 'string' || description.length > 2_000) return false;
  const command = nativeBashPayload(tool.input.command, columns);
  const detail = nativeBashPayload(description, columns);
  if (!command || !detail) return false;
  const lines = visible.split('\n').map(line => line.replace(/ +$/, ''));
  while (lines.at(-1) === '') lines.pop();
  // The top rule can scroll off while the heading and entire payload remain.
  // Recognize that shape only for repaint; a grant still needs the real rule.
  const clippedRule = lines[0] === ' Bash command' && lines[1] === '';
  if (clippedRule) lines.splice(0, 2);
  const end = lines.indexOf('');
  const payload = [...command, ...detail];
  if (!lines[0]?.startsWith('   │ ') || end < 1 || end > payload.length || clippedRule && end !== payload.length
    || !isDeepStrictEqual(lines.slice(0, end), payload.slice(-end))) return false;
  return currentBashPermissionCard(['─'.repeat(columns), ' Bash command', '', ...payload, ...lines.slice(end)].join('\n')) !== null;
}

export function nativePermissionKey(tool: NativePermissionTool | NativeFilePermissionRequest, visible: string): string {
  if (hasCurrentReadPermissionHeading(visible)) {
    const card = currentReadPermissionCard(visible);
    if (!card || tool.name !== 'Read' || Object.keys(tool.input).length !== 1
      || tool.input.file_path !== card.filePath) {
      throw new Error('Visible permission cannot be bound to its pending native command or file path');
    }
    return 'Read:' + card.filePath;
  }
  if (tool.name === 'WebFetch' || hasCurrentWebFetchPermissionHeading(visible)) {
    const card = currentWebFetchPermissionCard(visible);
    const input = tool.input;
    const payload = card && tool.name === 'WebFetch' && webFetchInput(input)
      ? nativeBashPayload(`url: ${input.url}\nprompt: ${input.prompt}`, card.columns) : null;
    if (!card || !payload || !isDeepStrictEqual(payload, card.payload) || new URL(input.url as string).hostname !== card.domain) {
      throw new Error('Visible permission cannot be bound to its pending native command or file path');
    }
    return 'WebFetch:' + JSON.stringify([input.url, input.prompt]);
  }
  const value = tool.name === 'Bash' ? tool.input.command
    : ['Read', 'Write', 'Edit'].includes(tool.name) ? tool.input.file_path : null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('Unsupported native permission command or file path');
  const bash = currentBashPermissionCard(visible);
  // A damaged modern card must not fall through to the legacy sentence regex.
  if (hasCurrentBashPermissionHeading(visible)) {
    const description = tool.input.description === undefined || tool.input.description === '' ? 'Run shell command' : tool.input.description;
    const commandRows = bash && tool.name === 'Bash' ? nativeBashPayload(value, bash.columns) : null;
    const descriptionRows = bash && typeof description === 'string' && description.length <= 2_000 ? nativeBashPayload(description, bash.columns) : null;
    if (!bash || !commandRows || !descriptionRows || !isDeepStrictEqual(bash.payload, [...commandRows, ...descriptionRows])) {
      throw new Error('Visible permission cannot be bound to its pending native command or file path');
    }
    return 'Bash:' + value;
  }
  const current = currentFilePermissionDetails(visible);
  if (current) {
    const expectedTool = current.operation === 'edit' ? 'Edit' : 'Write';
    const displayed = current.filePath;
    const resolved = path.isAbsolute(displayed) ? path.normalize(displayed)
      : tool.cwd && path.isAbsolute(tool.cwd) ? path.resolve(tool.cwd, displayed) : null;
    // A basename alone has no authority. Its exact path must resolve through
    // the cwd on this owned tool record; missing/corrupted names stay errors.
    if (tool.name !== expectedTool || !path.isAbsolute(value) || resolved !== path.normalize(value)
      || (current.accessDirectory && path.normalize(current.accessDirectory) !== path.dirname(path.normalize(value)))) {
      throw new Error('Visible permission cannot be bound to its pending native command or file path');
    }
    return tool.name + ':' + path.normalize(value);
  }
  // Match the request's own labelled field, not a command/path substring
  // elsewhere in a previous dialog (or another tool's command).
  const displayed = tool.name === 'Bash'
    ? [...visible.matchAll(/\bBash\s+command\s+(.+?)\s+requires\s+permission/gis)].at(-1)?.[1]
    : [...visible.matchAll(new RegExp('(?:^|\\n)\\s*' + tool.name + '\\s+to\\s+([^\\n]+)', 'g'))].at(-1)?.[1];
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const unquoted = displayed?.trim().replace(/^`([^`]+)`$/, '$1');
  if (!displayed || (normalize(displayed) !== normalize(value) && normalize(unquoted!) !== normalize(value))) {
    throw new Error('Visible permission cannot be bound to its pending native command or file path');
  }
  return tool.name + ':' + normalize(value);
}

/** Reserve one current grant. Observer request IDs never stand in for native
 * tool IDs; only an exact later native result can retire the prior request. */
export function reserveNativePermissionGrant(
  native: Pick<ReturnType<typeof readPlanSkillQuestions>, 'permissionTools' | 'permissionResults' | 'permissionRequests' | 'permissionRequestCapture'>,
  visible: string, granted: Set<string>, requests: Map<string, NativePermissionGrant>,
): boolean {
  const pending = native.permissionRequests.filter(request => request.result === 'pending');
  const owners = [...pending, ...native.permissionTools.filter(tool => !pending.some(request => request.nativeToolId === tool.id))];
  if (!owners.length) return false;
  let owner = owners[0]!;
  if (owners.length > 1) {
    const ambiguous = () => new Error('Ambiguous native permission owner: multiple tools are pending');
    // Only current native file controls can disambiguate parallel work.
    // The exact operation/path must identify one owner; same-path writes
    // (including different operations) and legacy/Bash dialogs fail closed.
    if (!native.permissionRequestCapture || !currentFilePermissionTarget(visible)) throw ambiguous();
    const matches = owners.filter(item => {
      // Native tool discovery cannot own a file-edit dialog. Keep it pending
      // for lifecycle accounting; this path never grants its execution.
      if (item.name === 'ToolSearch') return false;
      try { nativePermissionKey(item, visible); return true; }
      catch (error) {
        if (error instanceof Error && error.message === 'Visible permission cannot be bound to its pending native command or file path') return false;
        throw error; // Unsupported or malformed owners are not harmless mismatches.
      }
    });
    if (matches.length !== 1) throw ambiguous();
    const writablePaths = owners.filter(item => ['Write', 'Edit'].includes(item.name)).map(item => {
      const filePath = item.input.file_path;
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw ambiguous();
      return path.normalize(filePath);
    });
    if (new Set(writablePaths).size !== writablePaths.length) throw ambiguous();
    owner = matches[0]!;
  }
  if (native.permissionRequestCapture && !('requestId' in owner) && ['Write', 'Edit'].includes(owner.name)) return false;
  if (!('requestId' in owner) && (owner.bashPermissionRequestId === null
    || owner.name === 'WebFetch' && !owner.webFetchPermissionRequestId)) return false;
  const key = 'requestId' in owner ? `request:${owner.requestId}` : owner.id;
  if (granted.has(key)) return false;
  const request = nativePermissionKey(owner, visible);
  const operation = currentFilePermissionTarget(visible)?.operation;
  const prior = requests.get(request);
  if (prior) {
    const completedRequest = prior.requestId
      ? native.permissionRequests.find(item => item.requestId === prior.requestId && item.result === 'completed' && item.nativeToolId)
      : undefined;
    const completed = prior.requestId
      ? completedRequest !== undefined
      : native.permissionResults.some(item => item.id === prior.nativeId && item.result === 'completed');
    // The new source event can arrive after the screen barrier. Wait while
    // its same-path CREATE predecessor is still visible; never regrant it.
    if (completed && prior.operation === 'create' && operation === 'create') return false;
    // A distinct observer after an exact successful ACK can own the next
    // same-path Edit or changed-content overwrite before native persistence.
    // The caller still brackets the current one-time menu with source reads.
    const sameFileOperation = completedRequest?.name === 'Edit' && prior.operation === 'edit' && operation === 'edit'
      || completedRequest?.name === 'Write' && prior.operation === 'overwrite' && operation === 'overwrite'
        && typeof completedRequest.input.content === 'string' && typeof owner.input.content === 'string'
        && owner.input.content !== completedRequest.input.content;
    const nextFileChange = completedRequest && sameFileOperation && owner.name === completedRequest.name
      && 'requestId' in owner && owner.requestId !== completedRequest.requestId
      && Number.isFinite(completedRequest.nativeResultAtMs) && owner.capturedAtMs > completedRequest.nativeResultAtMs!
      && owner.cwd === completedRequest.cwd && owner.input.file_path === completedRequest.input.file_path
      && !isDeepStrictEqual(owner.input, completedRequest.input);
    if (!completed || !(prior.operation === 'create' && operation === 'overwrite') && !nextFileChange) {
      throw new Error('Repeated native permission request cannot be distinguished from stale rendering');
    }
  }
  granted.add(key);
  requests.set(request, { ...('requestId' in owner ? { requestId: owner.requestId } : { nativeId: owner.id }), operation });
  return true;
}

export function isNativeQuestionSubmitVisible(visible: string): boolean {
  const text = compact(visible);
  return text.includes('readytosubmityouranswers') && text.includes('submitanswers')
    && !text.includes('youhavenotansweredallquestions');
}
