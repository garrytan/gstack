import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanSkillQuestions, matchesNativeQuestion, nativeQuestionSelection, isNativeQuestionSubmitVisible, currentFilePermissionTarget, matchesClippedBashPermission, nativePermissionKey, reserveNativePermissionGrant, type NativeQuestion, type NativePermissionGrant } from './helpers/plan-skill-questions';
import { isPermissionDialogVisible, parseNumberedOptions, stripAnsi } from './helpers/claude-pty-runner';
import { setupQuestionEventSource, readPermissionRequestEvents } from './helpers/plan-skill-question-events';
import retainedQuestionValidation from './fixtures/eng-auq-validation-error.json';
import retainedBashDirectory from './fixtures/bash-directory-permission.json';
import retainedDesignTasksPermission from './fixtures/design-tasks-bash-permission.json';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const sessionId = '00000000-0000-4000-8000-000000000001';
const question: NativeQuestion = { question: 'D1 — Which approach?\nMake it reliable. Enforce the delivery policy.', header: 'Approach', multiSelect: false,
  options: ['Extend dispatcher', 'Queue fanout', 'Minimal patch', 'Hold scope'].map(label => ({ label, description: label })) };
let config: string;
let file: string;
const call = (id: string, questions = [question]) => ({ type: 'assistant', sessionId, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } });
const write = (...rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
beforeEach(() => { config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-question-'))); file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true }); });
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

function earlyQuestions() {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  return { source, emit(id: string, input: unknown = { questions: [question] }, toolName = 'AskUserQuestion') {
    const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: file, cwd: config,
      tool_name: toolName, tool_use_id: id, tool_input: input,
    })), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.length).toBe(0);
  } };
}

function completedQuestionHook() {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Review' } });
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const input = { questions: [structuredClone(question)] };
  const response = { questions: input.questions, answers: { [question.question]: question.options[0]!.label } };
  const emit = (event: string, id: string, toolInput: unknown, extra: Record<string, unknown> = {}) => {
    const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
      hook_event_name: event, session_id: sessionId, transcript_path: file, cwd: config,
      tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: toolInput, ...extra,
    })), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0);
  };
  const pre = () => emit('PreToolUse', 'question-1', input);
  const post = (output: unknown = response, extra: Record<string, unknown> = {}) =>
    emit('PostToolUse', 'question-1', { ...input, answers: response.answers }, { tool_response: output, ...extra });
  const read = () => readPlanSkillQuestions(config, sessionId, source);
  return { source, input, response, emit, pre, post, read };
}

test('AUQ completion retires only the exact answered call during transcript persistence lag', () => {
  const s = completedQuestionHook(); s.pre(); s.post();
  const second = { ...question, question: 'D2 — Preserve the independent delivery policy?' };
  s.emit('PreToolUse', 'question-2', { questions: [second] });
  const result = s.read();
  expect(result.calls.find(c => c.id === 'question-1')).toMatchObject({ result: 'answered', answerLabels: [question.options[0]!.label] });
  expect(result.calls.filter(c => c.result === 'pending').map(c => c.id)).toEqual(['question-2']);
  expect(result.permissionTools).toEqual([]); expect(result.permissionRequests).toEqual([]); expect(result.ready).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('question-1');
  write(call('question-1'), { type: 'user', sessionId, toolUseResult: s.response,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'question-1',
      content: `Your questions have been answered: "${question.question}"="${question.options[0]!.label}". You can now continue with these answers in mind.` }] } });
  expect(s.read().calls.filter(c => c.id === 'question-1')).toHaveLength(1);
  expect(s.read().calls.find(c => c.id === 'question-1')?.result).toBe('answered');
});

test.each(['question', 'header', 'option-label', 'option-description', 'metadata'] as const)
('AUQ completion rejects changed execution input (%s)', field => {
  const s = completedQuestionHook(); s.pre();
  const changed: any = structuredClone(s.input);
  if (field === 'metadata') changed.metadata = { source: 'different' };
  else if (field === 'question' || field === 'header') changed.questions[0][field] += ' changed';
  else changed.questions[0].options[0][field === 'option-label' ? 'label' : 'description'] += ' changed';
  const answers = { [changed.questions[0].question]: changed.questions[0].options[0].label };
  s.emit('PostToolUse', 'question-1', { ...changed, answers }, { tool_response: { questions: changed.questions, answers } });
  expect(() => s.read()).toThrow('Native AskUserQuestion completion changed input');
});

test.each(['missing-answer', 'unoffered-answer', 'notes', 'freeform', 'follow-up', 'idle', 'wrong-result-question', 'failed'] as const)
('AUQ completion cannot turn an incomplete, amended or cancelled response into an ACK (%s)', variant => {
  const s = completedQuestionHook(); s.pre();
  const output: any = structuredClone(s.response);
  if (variant === 'missing-answer') output.answers = {};
  if (variant === 'unoffered-answer') output.answers[question.question] = 'A different action';
  if (variant === 'notes') output.annotations = { [question.question]: { notes: 'Do not proceed' } };
  if (variant === 'freeform') output.response = 'Cancel this review';
  if (variant === 'follow-up') output.followUp = true;
  if (variant === 'idle') output.afkTimeoutMs = 1;
  if (variant === 'wrong-result-question') output.questions[0].header = 'Different';
  s.post(output, variant === 'failed' ? { hook_event_name: 'PostToolUseFailure', error: 'cancelled' } : {});
  expect(() => s.read()).toThrow('Native question event capture failed');
});

test.each(['foreign', 'sidechain', 'orphan'] as const)('AUQ completion needs its owned invocation (%s)', variant => {
  const s = completedQuestionHook();
  if (variant !== 'orphan') s.pre();
  s.post(s.response, variant === 'foreign' ? { session_id: '00000000-0000-4000-8000-000000000099' }
    : variant === 'sidechain' ? { agent_id: 'other-agent' } : {});
  expect(s.read().calls.some(c => c.result === 'answered')).toBe(false);
});

test.each(['error', 'answer', 'cancelled-text', 'cancelled-text-no-raw'] as const)('AUQ completion rejects contradictory later native results (%s)', variant => {
  const s = completedQuestionHook(); s.pre(); s.post();
  expect(s.read().calls[0]?.result).toBe('answered');
  const raw = variant === 'answer' ? { ...s.response, answers: { [question.question]: question.options[1]!.label } } : s.response;
  write(call('question-1'), { type: 'user', sessionId, ...(variant !== 'cancelled-text-no-raw' ? { toolUseResult: raw } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'question-1', is_error: variant === 'error',
      content: variant.startsWith('cancelled') ? 'The user did not answer the questions.'
        : `Your questions have been answered: "${question.question}"="${question.options[0]!.label}". You can now continue with these answers in mind.` }] } });
  expect(() => s.read()).toThrow('Native AskUserQuestion completion conflicts with its later result');
});

test('AUQ completion repeats retain one immutable event and coalesce exact text without raw metadata', () => {
  const s = completedQuestionHook(); s.pre(); s.post();
  const first = s.read();
  s.post();
  expect(s.read()).toEqual(first);
  expect(fs.readdirSync(path.join(s.source.directory, 'events'))).toHaveLength(2);
  write(call('question-1'), { type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result',
    tool_use_id: 'question-1', content: `Your questions have been answered: "${question.question}"="${question.options[0]!.label}". You can now continue with these answers in mind.` }] } });
  expect(s.read().calls).toEqual(first.calls);
});

test.each(['duplicate-label', 'duplicate-question', 'multi-select', 'array-answer', 'wrong-cwd', 'input-annotation', 'reserved-notes-sentinel'] as const)
('AUQ completion refuses ambiguous or mismatched acknowledgment (%s)', variant => {
  const s = completedQuestionHook();
  const input: any = structuredClone(s.input);
  if (variant === 'duplicate-label') input.questions[0].options[1].label = input.questions[0].options[0].label;
  if (variant === 'duplicate-question') input.questions.push(structuredClone(input.questions[0]));
  if (variant === 'multi-select') input.questions[0].multiSelect = true;
  if (variant === 'reserved-notes-sentinel') input.questions[0].options[0].label = '(notes only)';
  const answers = { [question.question]: variant === 'array-answer' ? [question.options[0]!.label] : input.questions[0].options[0].label };
  s.emit('PreToolUse', 'question-1', input);
  s.emit('PostToolUse', 'question-1', { ...input, answers,
    ...(variant === 'input-annotation' ? { annotations: { [question.question]: { notes: 'Cancel' } } } : {}) },
    { tool_response: { questions: input.questions, answers }, ...(variant === 'wrong-cwd' ? { cwd: path.dirname(config) } : {}) });
  expect(() => s.read()).toThrow('Native question event capture failed');
});

function filePermissionRequest(input = { file_path: path.join(config, 'plan.md'), content: 'Final report' }) {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
    hook_event_name: 'PermissionRequest', session_id: sessionId, transcript_path: file, cwd: config,
    tool_name: 'Write', tool_input: input,
  })), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.length).toBe(0);
  const [event] = readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file });
  return { source, event: event!, input };
}
const nativeWrite = (id: string, input: unknown, cwd = config, name = 'Write', stop_reason: string | null = 'tool_use') => ({
  type: 'assistant', sessionId, cwd, message: { role: 'assistant', stop_reason, content: [{ type: 'tool_use', id, name, input }] },
});
const nativeWriteResult = (id: string, timestamp?: string, is_error = false) => ({
  type: 'user', sessionId, timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'Done' }] },
});

// Normalized execution input: preserve injected plan fields and every extra key.
const exitInput = () => ({ plan: '# Plan\n## GSTACK REVIEW REPORT\n日本語', planFilePath: path.join(config, 'plan.md'),
  allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }], custom: { exact: true } });

test.each([null, 'tool_use'])('early ExitPlanMode coalesces exact %s native input without AUQ or file authority', stopReason => {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Review' } });
  const early = earlyQuestions(), input = exitInput();
  early.emit('early-exit', input, 'ExitPlanMode');
  const initial = readPlanSkillQuestions(config, sessionId, early.source);
  expect(initial.ready).toBe(true);
  expect(initial.pendingExitPlanModeIds).toEqual(['early-exit']);
  expect(initial.calls).toEqual([]); expect(initial.permissionTools).toEqual([]);
  expect(initial.permissionRequests).toEqual([]); expect(initial.permissionResults).toEqual([]);
  write(nativeWrite('early-exit', input, config, 'ExitPlanMode', stopReason));
  expect(readPlanSkillQuestions(config, sessionId, early.source)).toEqual(initial);
  if (stopReason === null) expect(readPlanSkillQuestions(config, sessionId).ready).toBe(false);
});

test.each([false, true])('early ExitPlanMode retires on an owned result including preexisting/error=%s', isError => {
  const early = earlyQuestions(), input = exitInput();
  write(nativeWriteResult('early-exit', undefined, isError));
  early.emit('early-exit', input, 'ExitPlanMode');
  for (let repeat = 0; repeat < 2; repeat++) {
    early.emit('early-exit', input, 'ExitPlanMode');
    const state = readPlanSkillQuestions(config, sessionId, early.source);
    expect(state.ready).toBe(false); expect(state.pendingExitPlanModeIds).toEqual([]);
    expect(state.calls).toEqual([]); expect(state.permissionResults).toEqual([]);
  }
});

test.each(['foreign', 'sidechain', 'child', 'wrong-id'])('early ExitPlanMode ignores a %s native result', variant => {
  const early = earlyQuestions(), input = exitInput();
  const result: any = nativeWriteResult(variant === 'wrong-id' ? 'other-exit' : 'early-exit');
  if (variant === 'foreign') result.sessionId = '00000000-0000-4000-8000-000000000002';
  if (variant === 'sidechain') result.isSidechain = true;
  if (variant === 'child') result.parent_tool_use_id = 'parent';
  write(result); early.emit('early-exit', input, 'ExitPlanMode');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(true);
  fs.appendFileSync(file, JSON.stringify(nativeWriteResult('early-exit')) + '\n');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(false);
});

test.each(['plan', 'path', 'extra', 'nested-schema-extra', 'cwd', 'AskUserQuestion', 'Write', 'Edit', 'Bash'])('early ExitPlanMode rejects unfinished same-ID %s conflicts', variant => {
  write(); const early = earlyQuestions(), input = exitInput();
  early.emit('early-exit', input, 'ExitPlanMode');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(true);
  const changed = structuredClone(input);
  if (variant === 'plan') changed.plan += '\nChanged';
  if (variant === 'path') changed.planFilePath += '.other';
  if (variant === 'extra') changed.custom.exact = false;
  // Deprecated nested keys stripped by CLI schema are conservatively rejected.
  if (variant === 'nested-schema-extra') (changed.allowedPrompts[0] as any).extra = 'not in execution input';
  const name = ['AskUserQuestion', 'Write', 'Edit', 'Bash'].includes(variant) ? variant : 'ExitPlanMode';
  write(nativeWrite('early-exit', changed, variant === 'cwd' ? path.dirname(config) : config, name, null));
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

test('early ExitPlanMode keeps missing transcript, partial bytes and owner changes observable', () => {
  const early = earlyQuestions(), input = exitInput();
  early.emit('exit-one', input, 'ExitPlanMode');
  expect(readPlanSkillQuestions(config, sessionId, early.source).ready).toBe(false);
  write(); const first = readPlanSkillQuestions(config, sessionId, early.source);
  expect(first.ready).toBe(true);
  fs.appendFileSync(file, '{"type":');
  expect(readPlanSkillQuestions(config, sessionId, early.source).pendingBytes).toBeGreaterThan(0);
  write(nativeWriteResult('exit-one'));
  early.emit('exit-two', input, 'ExitPlanMode');
  const second = readPlanSkillQuestions(config, sessionId, early.source);
  expect(second.ready).toBe(true); expect(second.pendingExitPlanModeIds).toEqual(['exit-two']);
  expect(second).not.toEqual(first);
});

test('permission request identity remains separate until an exact later native result completes it', () => {
  write();
  const { source, event, input } = filePermissionRequest();
  const pending = readPlanSkillQuestions(config, sessionId, source);
  expect(pending.permissionTools).toEqual([]);
  expect(pending.permissionRequests).toEqual([{ requestId: event.requestId, capturedAtMs: event.capturedAtMs,
    name: 'Write', cwd: config, input, result: 'pending' }]);
  write(nativeWrite('real-write', input));
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0]).toMatchObject({ result: 'pending', nativeToolId: 'real-write' });
  write(nativeWrite('real-write', input), nativeWriteResult('real-write', new Date(event.capturedAtMs + 1).toISOString()));
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0]).toMatchObject({ requestId: event.requestId, result: 'completed', nativeToolId: 'real-write' });
});

test.each(['old', 'equal', 'invalid', 'missing', 'foreign'])('a %s native result cannot acknowledge a newly captured file request', variant => {
  write();
  const { source, event, input } = filePermissionRequest();
  const time = variant === 'missing' ? undefined : variant === 'invalid' ? 'not-a-date'
    : new Date(event.capturedAtMs + (variant === 'old' ? -1 : variant === 'equal' ? 0 : 1)).toISOString();
  const result = nativeWriteResult('old-write', time);
  if (variant === 'foreign') result.sessionId = '00000000-0000-4000-8000-000000000002';
  write(nativeWrite('old-write', input), result);
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0].result).toBe('pending');
  if (variant !== 'foreign') expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0].nativeToolId).toBeUndefined();
});

test('file request errors and ambiguous full-input matches never become successful completion', () => {
  write();
  const { source, event, input } = filePermissionRequest();
  const timestamp = new Date(event.capturedAtMs + 1).toISOString();
  write(nativeWrite('failed', input), nativeWriteResult('failed', timestamp, true));
  expect(readPlanSkillQuestions(config, sessionId, source).permissionRequests[0]).toMatchObject({ result: 'error', nativeToolId: 'failed' });
  write(nativeWrite('first', input), nativeWriteResult('first', timestamp), nativeWrite('second', input));
  expect(() => readPlanSkillQuestions(config, sessionId, source)).toThrow('Indistinguishable');
});

test.each(['content', 'cwd', 'name', 'unfinished'])('late native file %s disagreement refuses the permission request', variant => {
  write();
  const { source, input } = filePermissionRequest();
  write(nativeWrite('changed', variant === 'content' || variant === 'unfinished' ? { ...input, content: 'Changed after permission' } : input,
    variant === 'cwd' ? path.dirname(config) : config, variant === 'name' ? 'Edit' : 'Write', variant === 'unfinished' ? null : 'tool_use'));
  expect(() => readPlanSkillQuestions(config, sessionId, source)).toThrow('changed input');
});

test('a reused real native tool ID cannot change file input or become an AskUserQuestion', () => {
  const input = { file_path: path.join(config, 'plan.md'), content: 'Initial' };
  write(nativeWrite('same', input), nativeWrite('same', { ...input, content: 'Changed' }));
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('changed input');
  write(nativeWrite('same', input), call('same'));
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('changed input');
});

test('a pre-transcript native question is pending until its exact owned result arrives', () => {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Begin the review' } });
  const early = earlyQuestions();
  early.emit('early');
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([]);
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls.map(c => [c.id, c.result])).toEqual([['early', 'pending']]);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: '00000000-0000-4000-8000-000000000002',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'early' }] } }) + '\n');
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls[0].result).toBe('pending');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId, message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'early', content: 'Answer accepted' }] } }) + '\n');
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls[0].result).toBe('answered');
});

test('early and persisted invocations coalesce, and any changed input fails', () => {
  write(call('same'));
  const early = earlyQuestions();
  early.emit('same');
  expect(readPlanSkillQuestions(config, sessionId, early.source).calls).toHaveLength(1);
  write(call('same', [{ ...question, question: 'A different question?' }]));
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

for (const stopReason of [null, 'tool_use']) {
  test(`the hook's false multiSelect default matches an omitted transcript field (${stopReason})`, () => {
    const { multiSelect, ...omittedDefault } = question;
    const native = call('defaulted');
    native.message.stop_reason = stopReason as any;
    native.message.content[0].input.questions = [omittedDefault as NativeQuestion];
    write(native);
    const early = earlyQuestions();
    early.emit('defaulted');
    const pending = readPlanSkillQuestions(config, sessionId, early.source);
    expect(pending.calls).toEqual([{ id: 'defaulted', questions: [question], result: 'pending' }]);
    fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'defaulted', content: 'Answer accepted' }] } }) + '\n');
    expect(readPlanSkillQuestions(config, sessionId, early.source).calls[0].result).toBe('answered');
  });
}

test('a completed native invocation without an event uses the same false default', () => {
  const { multiSelect, ...omittedDefault } = question;
  write(call('native-default', [omittedDefault as NativeQuestion]));
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([
    { id: 'native-default', questions: [question], result: 'pending' },
  ]);
});

for (const multiSelect of [true, null, 'false']) {
  test(`default equivalence still rejects changed multiSelect ${JSON.stringify(multiSelect)}`, () => {
    write(call('changed-default', [{ ...question, multiSelect } as NativeQuestion]));
    const early = earlyQuestions();
    early.emit('changed-default');
    expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
  });
}

test('default equivalence preserves comparison of other input fields', () => {
  const { multiSelect, ...omittedDefault } = question;
  const native = call('other-input', [omittedDefault as NativeQuestion]);
  (native.message.content[0].input as any).metadata = { changed: true };
  write(native);
  const early = earlyQuestions();
  early.emit('other-input');
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

test('early native input uses the existing validator and never supplies a successful result', () => {
  write(call('valid'));
  const early = earlyQuestions();
  early.emit('invalid', { questions: [] });
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('Unsupported native');
});

test('an error result for an early question stays failed and partial transcript records stay visible', () => {
  write({ type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'early', is_error: true }] } });
  const early = earlyQuestions();
  early.emit('early');
  fs.appendFileSync(file, '{"type":"user"');
  const state = readPlanSkillQuestions(config, sessionId, early.source);
  expect(state.calls[0].result).toBe('error');
  expect(state.pendingBytes).toBeGreaterThan(0);
});

test('owned calls retain distinct IDs, all question tabs, and exact matching results', () => {
  write(call('first', [question, { ...question, question: 'D2 — Which next step?' }]), call('second'),
    { type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'first', content: 'Answer accepted' }] } });
  const state = readPlanSkillQuestions(config, sessionId);
  expect(state.calls.map(c => [c.id, c.result, c.questions.length])).toEqual([['first', 'answered', 2], ['second', 'pending', 1]]);
});
test('foreign, sidechain, previews and unfinished calls are not native prompts', () => {
  write({ ...call('foreign'), sessionId: '00000000-0000-4000-8000-000000000002' }, { ...call('side'), isSidechain: true },
    { ...call('unfinished'), message: { ...call('unfinished').message, stop_reason: null } },
    { type: 'assistant', sessionId, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { content: JSON.stringify(call('preview')) } }] } });
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([]);
  fs.appendFileSync(file, '{"type":"assistant"');
  expect(readPlanSkillQuestions(config, sessionId).pendingBytes).toBeGreaterThan(0);
});
test('errors and malformed native input never become successful acknowledgements', () => {
  write(call('failed'), { type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'failed', is_error: true }] } });
  expect(readPlanSkillQuestions(config, sessionId).calls[0].result).toBe('error');
  write(call('bad', []));
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('Unsupported native');
  expect(() => readPlanSkillQuestions(null, sessionId)).toThrow('owned hermetic');
});
test('overflow rejection identifies the native call and option count without disclosing content', () => {
  const privateText = 'private-question-label-description';
  const overflow = { ...question, question: privateText, header: privateText,
    options: Array.from({ length: 5 }, () => ({ label: privateText, description: privateText })) };
  write(call('overflow-call', [overflow]));
  let message = '';
  try { readPlanSkillQuestions(config, sessionId); } catch (error) { message = (error as Error).message; }
  expect(message).toStartWith('Unsupported native AskUserQuestion input shape: toolId="overflow-call"');
  const shape = JSON.parse(message.split(' shape=')[1]);
  expect(shape).toMatchObject({ questionsType: 'array', questionCount: 1, questionsTruncated: false });
  expect(shape.questions[0]).toMatchObject({ optionCount: 5, optionsTruncated: true,
    questionType: 'string', questionNonempty: true, headerType: 'string', headerNonempty: true });
  expect(shape.questions[0].options).toHaveLength(4);
  expect(message).not.toContain(privateText);

  write(call('long-id-'.repeat(100), Array.from({ length: 50 }, () => ({ ...overflow,
    options: Array.from({ length: 50 }, () => overflow.options[0]) }))));
  try { readPlanSkillQuestions(config, sessionId); } catch (error) { message = (error as Error).message; }
  const bounded = JSON.parse(message.split(' shape=')[1]);
  expect(bounded).toMatchObject({ questionCount: 50, questionsTruncated: true });
  expect(bounded.questions).toHaveLength(4);
  expect(bounded.questions.every((q: any) => q.optionCount === 50 && q.options.length === 4)).toBe(true);
  expect(message).toContain(' (truncated) shape=');
  expect(message.length).toBeLessThan(4_000);
  expect(message).not.toContain(privateText);
});
test('missing required option fields remain rejected with types after native defaults apply', () => {
  const { multiSelect, ...defaulted } = question;
  const { description, ...missingDescription } = question.options[0];
  write(call('missing-description', [{ ...defaulted,
    options: [missingDescription, question.options[1]] } as NativeQuestion]));
  let message = '';
  try { readPlanSkillQuestions(config, sessionId); } catch (error) { message = (error as Error).message; }
  expect(message).toStartWith('Unsupported native AskUserQuestion input shape: toolId="missing-description"');
  const shape = JSON.parse(message.split(' shape=')[1]);
  expect(shape.questions[0]).toMatchObject({ multiSelectType: 'boolean', optionCount: 2 });
  expect(shape.questions[0].options[0]).toEqual({ type: 'object', labelType: 'string',
    labelNonempty: true, descriptionType: 'undefined' });
  expect(message).not.toContain(question.question);
  expect(message).not.toContain(missingDescription.label);
});
test('a native box heading tolerates wrapped/repainted body and below-viewport choices', () => {
  const visible = stripAnsi('☐ Approach\nD1 — Which\x1b[2Capproach?\nMak it reliable. Enforce the delivery policy.\n❯1.Extend dispatcher\n2.Queue fanout\n');
  expect(matchesNativeQuestion(question, visible, parseNumberedOptions(visible))).toBe(true);
  expect(readPlanSkillQuestions(config, sessionId).calls).toEqual([]);
});
test('a stale menu with identical options cannot match a new question or nearby report preview', () => {
  const wrong = 'D1 — Which approach?\n☐ Approach\nD2 — Which next step?\n❯1.Extend dispatcher\n2.Queue fanout\n';
  expect(matchesNativeQuestion(question, wrong, parseNumberedOptions(wrong))).toBe(false);
  const differentOptions = '☐ Approach\nD1 — Which approach?\n❯1.Delete data\n2.Keep data\n';
  expect(matchesNativeQuestion(question, differentOptions, parseNumberedOptions(differentOptions))).toBe(false);
  const sibling = { ...question, question: 'D1 — Which approach?\nA different delivery policy.' };
  const sameHeading = '☐ Approach\n' + sibling.question + '\n❯1.Extend dispatcher\n2.Queue fanout\n';
  expect(matchesNativeQuestion(question, sameHeading, parseNumberedOptions(sameHeading), [sibling])).toBe(false);
});
test('a final submit needs the native confirmation text, not an ordinary option or report', () => {
  expect(isNativeQuestionSubmitVisible('Review your answers\nReady to submit your answers?\nSubmit answers')).toBe(true);
  expect(isNativeQuestionSubmitVisible('Submit answers in the report')).toBe(false);
  expect(isNativeQuestionSubmitVisible('Ready to submit your answers?\nYou have not answered all questions\nSubmit answers')).toBe(false);
});
test('permission binding rejects command prefixes and matching paths in another tool kind', () => {
  const bash = { id: 'new', name: 'Bash', input: { command: 'git status' } };
  expect(() => nativePermissionKey(bash, 'Bash command git status --porcelain requires permission')).toThrow('cannot be bound');
  expect(nativePermissionKey(bash, 'Bash command git status requires permission')).toBe('Bash:git status');
  expect(nativePermissionKey(bash, 'Bash command `git status` requires permission to run.')).toBe('Bash:git status');
  expect(nativePermissionKey({ id: 'edit', name: 'Edit', input: { file_path: '~/.gstack/config.yaml' } }, 'Edit to ~/.gstack/config.yaml\nDo you want to proceed?\n❯1.Yes\n2.Yes, allow all edits')).toBe('Edit:~/.gstack/config.yaml');
  expect(() => nativePermissionKey({ id: 'read', name: 'Read', input: { file_path: '/project/README.md' } }, 'Bash command cat /project/README.md requires permission')).toThrow('cannot be bound');
});

// Pinned CLI 2.1.263 $At/gs/jAt: the command and description are separate
// rows, followed by the one-time Yes and optional standing permission rows.
// Unlike the old fixture, the native card has no "requires permission" text.
const nativeBashDialog = (command: string, description: string) =>
  '─'.repeat(120) + '\n Bash command\n\n   ' + command + '\n   ' + description
  + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';

test('native Bash reason can contain a literal numeric-range token without supplying authority', () => {
  const input = { command: 'printf ready', description: 'Print the owned marker' };
  const tool = { id: 'numeric-reason', name: 'Bash', input };
  // Exact native reason retained from CLI 2.1.263. Its embedded > is text,
  // distinct from a new terminal prompt, quoted card or numbered option.
  const reason = ' Contains zsh <N-M> numeric-range glob';
  const frame = nativeBashDialog(input.command, input.description)
    .replace('\n Do you want to proceed?', '\n' + reason + '\n\n Do you want to proceed?');
  expect(isPermissionDialogVisible(frame)).toBe(true);
  expect(nativePermissionKey(tool, frame)).toBe('Bash:' + input.command);
  expect(() => nativePermissionKey(tool, frame.replace('   printf ready', '   printf other'))).toThrow('cannot be bound');
  for (const changed of [' > Quoted permission', ' ❯ New prompt', '   1. Yes']) {
    expect(isPermissionDialogVisible(frame.replace(reason, changed))).toBe(false);
  }
});

test('native Bash card accepts a wrapped standing-permission label without granting it', () => {
  // CLI 2.1.263 places a long prefix wholly below this label. The selected
  // first option is still the one-time Yes, bound to the command above.
  const input = { command: 'printf %s ready > probe.txt', description: 'Write the owned marker' };
  write({ type: 'assistant', sessionId, cwd: config, message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'bash-wrapped', name: 'Bash', input }] } });
  const visible = nativeBashDialog(input.command, input.description).replace('   2. No',
    '   2. Yes, and don’t ask again for:\n      printf %s ready > probe.txt\n   3. No');
  const native = readPlanSkillQuestions(config, sessionId);
  expect(isPermissionDialogVisible(visible)).toBe(true);
  expect(nativePermissionKey(native.permissionTools[0]!, visible)).toBe('Bash:' + input.command);
  const granted = new Set<string>();
  const requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, visible, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, visible, granted, requests)).toBe(false);
  expect([...granted]).toEqual(['bash-wrapped']);
  // An empty standing permission, missing cancellation, incorrect focus, and
  // a command present only in the alternate option remain insufficient.
  for (const changed of [
    visible.replace('\n      printf %s ready > probe.txt', ''),
    visible.replace('\n      printf %s ready > probe.txt', '\n     printf %s ready > probe.txt'),
    visible.replace('   3. No\n', ''),
    visible.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes', ' ❯ 2. Yes'),
  ]) expect(isPermissionDialogVisible(changed)).toBe(false);
  expect(() => nativePermissionKey(native.permissionTools[0]!,
    visible.replace('   ' + input.command, '   false'))).toThrow('cannot be bound');
});

test('native Bash card binds the complete command and grants only its owned invocation', () => {
  const input = { command: 'printf %s ready > probe.txt', description: 'Write the owned marker' };
  write({ type: 'assistant', sessionId, cwd: config, message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'bash-current', name: 'Bash', input }] } });
  const visible = nativeBashDialog(input.command, input.description);
  const native = readPlanSkillQuestions(config, sessionId);
  expect(isPermissionDialogVisible(visible)).toBe(true);
  expect(nativePermissionKey(native.permissionTools[0]!, visible)).toBe('Bash:' + input.command);
  const granted = new Set<string>();
  const requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, visible, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, visible, granted, requests)).toBe(false);
  expect([...granted]).toEqual(['bash-current']);
});

// Exact ordinary 120x40 frame and owned Bash input from the parent-owned
// no-grant CLI2.1.263 probe. Default-mode rendering proves geometry only.
const retainedNativeBashFrame = "\n\n● Writing four lines of synthetic fixture text to synthetic-output.txt\n  ⎿  $ printf '%s\\n' '0-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-fr\n     ame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-s\n     ynthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthet…\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n Bash command\n Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below\n\n   │ printf '%s\\n' '0-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-f\n   │ rame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-da\n   │ ta-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synt\n   │ hetic-frame-data-synthetic-frame-data-synthetic-frame-data-' >\n   │ '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'\n   │ printf '%s\\n' '1-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-f\n   │ rame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-da\n   │ ta-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synt\n   │ hetic-frame-data-synthetic-frame-data-synthetic-frame-data-' >>\n   │ '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'\n   │ printf '%s\\n' '2-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-f\n   │ rame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-da\n   │ ta-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synt\n   │ hetic-frame-data-synthetic-frame-data-synthetic-frame-data-' >>\n   │ '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'\n   │ printf '%s\\n' '3-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-f\n   │ rame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-da\n   │ ta-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synt\n   │ hetic-frame-data-synthetic-frame-data-synthetic-frame-data-' >>\n   │ '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'\n   Write four lines of synthetic fixture text to synthetic-output.txt\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don’t ask again for: printf *                                                          \n   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No\n\n Esc to cancel · Tab to amend";
const retainedNativeBashTool = {"id": "toolu_01Gh2jM599F7fYNNV7TKf82Q", "name": "Bash", "input": {"command": "printf '%s\\n' '0-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-' > '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'\nprintf '%s\\n' '1-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-' >> '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'\nprintf '%s\\n' '2-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-' >> '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'\nprintf '%s\\n' '3-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-synthetic-frame-data-' >> '/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace/synthetic-output.txt'", "description": "Write four lines of synthetic fixture text to synthetic-output.txt"}, "cwd": "/tmp/gstack-bash-render-probe-v3-11jt8g7b/workspace"};

test('retained native Bash soft-wrap projection binds all four logical command lines', () => {
  expect(isPermissionDialogVisible(retainedNativeBashFrame)).toBe(true);
  expect(nativePermissionKey(retainedNativeBashTool, retainedNativeBashFrame)).toBe('Bash:' + retainedNativeBashTool.input.command);
  const different = { ...retainedNativeBashTool, input: { ...retainedNativeBashTool.input,
    command: retainedNativeBashTool.input.command.replace('\n', ' ') } };
  expect(() => nativePermissionKey(different, retainedNativeBashFrame)).toThrow('cannot be bound');
  expect(() => nativePermissionKey(retainedNativeBashTool,
    retainedNativeBashFrame.replace('   │ printf', '   │ rm -rf'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(retainedNativeBashTool,
    retainedNativeBashFrame.replace('   │ rame-data-', '   │ rame-…data-'))).toThrow('cannot be bound');
});

test('native Bash command bytes and description remain separate authority', () => {
  const tool = { id: 'bash', name: 'Bash', input: { command: 'printf "a  b"', description: 'Write two spaces' } };
  const frame = nativeBashDialog(tool.input.command, tool.input.description);
  expect(nativePermissionKey(tool, frame)).toBe('Bash:printf "a  b"');
  expect(() => nativePermissionKey({ ...tool, input: { ...tool.input, command: 'printf "a b"' } }, frame)).toThrow('cannot be bound');
  expect(() => nativePermissionKey(tool, nativeBashDialog('false', tool.input.command))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(tool, nativeBashDialog('false', 'Bash command printf "a  b" requires permission'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...tool, input: { command: 'printf\t"a  b"', description: tool.input.description } }, frame)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...tool, input: { command: 'printf cafe\u0301', description: 'Print text' } }, nativeBashDialog('printf cafe\u0301', 'Print text'))).toThrow('cannot be bound');
  expect(nativePermissionKey({ id: 'bash', name: 'Bash', input: { command: 'true' } }, nativeBashDialog('true', 'Run shell command'))).toBe('Bash:true');
});

test('native Bash command and description have independent gutters at the actual card width', () => {
  const command = 'printf "' + 'x'.repeat(110) + '"';
  const description = 'd'.repeat(81);
  const frame = nativeBashDialog(command, description).replace('─'.repeat(120), '─'.repeat(240))
    .replace('   ' + command, '   │ ' + command).replace('   ' + description, '   │ ' + description);
  const tool = { id: 'wide', name: 'Bash', input: { command, description } };
  expect(isPermissionDialogVisible(frame)).toBe(true);
  expect(nativePermissionKey(tool, frame)).toBe('Bash:' + command);
  expect(() => nativePermissionKey(tool, frame.replace('─'.repeat(240), '─'.repeat(120)))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(tool, frame.replace('   │ ' + description, '   ' + description))).toThrow('cannot be bound');
  const multiline = { id: 'description-lines', name: 'Bash', input: { command: 'true', description: 'First line\nSecond line' } };
  const multilineFrame = nativeBashDialog('true', 'First line').replace('   First line', '   │ First line\n   │ Second line');
  expect(nativePermissionKey(multiline, multilineFrame)).toBe('Bash:true');
});

test.each([
  ['quoted', (frame: string) => '```\n' + frame],
  ['history', (frame: string) => frame + '\n❯ current typed draft'],
  ['missing top rule', (frame: string) => frame.slice(frame.indexOf('\n') + 1)],
  ['repeated title', (frame: string) => frame.replace(' Bash command\n', ' Bash command\n Bash command\n')],
  ['wrong focus', (frame: string) => frame.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No')],
  ['persistent first choice', (frame: string) => frame.replace(' ❯ 1. Yes', ' ❯ 1. Yes, and allow all commands')],
  ['missing footer', (frame: string) => frame.slice(0, frame.lastIndexOf(' Esc to cancel'))],
] as const)('native Bash card refuses %s without legacy fallback', (_name, change) => {
  const frame = change(nativeBashDialog('true', 'Run shell command'));
  expect(isPermissionDialogVisible(frame)).toBe(false);
  expect(() => nativePermissionKey({ id: 'bash', name: 'Bash', input: { command: 'true' } }, frame)).toThrow('cannot be bound');
});

const createDialog = (target: string) => `Do you want to create ${target}?\n❯1.Yes\n2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)\n3.No\nEsc to cancel · Tab to amend`;

// Pinned Claude 2.1.263: Mo uses basename in its question, Se uses the
// cwd-relative subtitle, and gs/Gz render title then subtitle above the diff.
const nestedFileDialog = (operation: 'create' | 'edit' | 'overwrite', subtitle: string, basename = path.basename(subtitle)) =>
  '─'.repeat(120) + '\n ' + ({ create: 'Create', edit: 'Edit', overwrite: 'Overwrite' }[operation]) + ' file\n ' + subtitle +
  '\n' + '╌'.repeat(120) + '\n  1 Plan content\n' + '╌'.repeat(120) + '\n ' +
  createDialog(basename).replace('create', operation === 'edit' ? 'make this edit to' : operation);

// Pinned MEt/Z0o use this exact standing row for every non-read operation.
const settingsFileDialog = (operation: 'create' | 'edit' | 'overwrite' = 'edit') => nestedFileDialog(operation, '.claude/plans/plan.md').replace(
  'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
  'Yes, and allow Claude to edit its own settings for this session');

test.each(['create', 'edit', 'overwrite'] as const)('settings file controls bind only their exact owned path and reserve once (%s)', operation => {
  const frame = settingsFileDialog(operation);
  const name = operation === 'edit' ? 'Edit' : 'Write';
  const owner = { id: 'settings-file', name, cwd: config,
    input: { file_path: path.join(config, '.claude/plans/plan.md'), ...(name === 'Edit'
      ? { old_string: 'Draft', new_string: 'Reviewed' } : { content: 'Reviewed' }) } };
  expect(isPermissionDialogVisible(frame)).toBe(true);
  expect(currentFilePermissionTarget(frame)).toEqual({ operation, filePath: '.claude/plans/plan.md' });
  expect(nativePermissionKey(owner, frame)).toBe(name + ':' + owner.input.file_path);
  const request = { requestId: 'settings-request', nativeToolId: owner.id, name,
    cwd: config, input: owner.input, capturedAtMs: 1, result: 'pending' as const };
  const native = { permissionTools: [owner], permissionResults: [], permissionRequests: [request], permissionRequestCapture: true };
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, frame, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, frame, granted, requests)).toBe(false);
  expect([...requests.values()]).toEqual([{ requestId: request.requestId, operation }]);
  expect(() => nativePermissionKey({ ...owner, input: { ...owner.input, file_path: owner.input.file_path + '.other' } }, frame)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, name: name === 'Edit' ? 'Write' : 'Edit' }, frame)).toThrow('cannot be bound');
});

test.each(['different-label', 'persistent-focus', 'clipped-path', 'wrong-title'])('settings file controls refuse %s', variant => {
  let frame = settingsFileDialog();
  if (variant === 'different-label') frame = frame.replace('for this session', 'forever');
  if (variant === 'persistent-focus') frame = frame.replace('❯1.Yes', '1.Yes').replace('2. Yes', '❯2. Yes');
  if (variant === 'clipped-path') frame = frame.replace('.claude/plans/plan.md', '.claude/…/plan.md');
  if (variant === 'wrong-title') frame = frame.replace('Edit file', 'Create file');
  expect(currentFilePermissionTarget(frame)).toBeNull();
  expect(isPermissionDialogVisible(frame)).toBe(false);
});

test('captured settings overwrite is recognizable but its clipped basename cannot grant the owned nested Write', () => {
  const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'autoplan-settings-overwrite.json'), 'utf8'));
  const frame = captured.frame.text;
  expect(isPermissionDialogVisible(frame)).toBe(true);
  expect(currentFilePermissionTarget(frame)).toEqual({ operation: 'overwrite', filePath: 'autoplan-password-visibility.md' });
  expect(() => nativePermissionKey(captured.pendingRequest, frame)).toThrow('cannot be bound');
  // Paths mentioned in the diff cannot supply the missing current header.
  expect(() => nativePermissionKey(captured.pendingRequest, captured.pendingRequest.input.file_path + '\n' + frame)).toThrow('cannot be bound');
});

test('old Bash history cannot block an independently bound current file card', () => {
  const filePath = path.join(config, 'plan.md');
  const frame = retainedNativeBashFrame + '\n' + nestedFileDialog('create', 'plan.md');
  const owner = { id: 'file-after-bash', name: 'Write', cwd: config, input: { file_path: filePath } };
  expect(isPermissionDialogVisible(frame)).toBe(true);
  expect(currentFilePermissionTarget(frame)).toEqual({ operation: 'create', filePath: 'plan.md' });
  expect(nativePermissionKey(owner, frame)).toBe('Write:' + filePath);
  expect(() => nativePermissionKey(retainedNativeBashTool, frame)).toThrow('cannot be bound');
});

test('old file controls cannot authorize a malformed or differently focused current Bash card', () => {
  const filePath = path.join(config, 'plan.md');
  const fileOwner = { id: 'old-file', name: 'Write', cwd: config, input: { file_path: filePath } };
  for (const bash of [nativeBashDialog('true', 'Run shell command').replace(' ❯ 1. Yes', '   1. Yes').replace('   2. No', ' ❯ 2. No'),
    nativeBashDialog('true', 'Run shell command').replace('   2. No', '   2. N')]) {
    const frame = nestedFileDialog('create', 'plan.md') + '\n' + bash;
    expect(isPermissionDialogVisible(frame)).toBe(false);
    expect(() => nativePermissionKey(fileOwner, frame)).toThrow('cannot be bound');
    expect(() => nativePermissionKey({ id: 'current-bash', name: 'Bash', input: { command: 'true' } }, frame)).toThrow('cannot be bound');
  }
});

// Exact option-2 wrapping from the owned Claude 2.1.263 fake-Write capture.
// It advertises a directory grant; the driver still reserves only option 1.
const directoryFileDialog = (operation: 'create' | 'edit' | 'overwrite', subtitle: string, directory: string) =>
  nestedFileDialog(operation, subtitle).replace('for this session (shift+tab)',
    `for this session; Yes, and\n      always allow access to\n      ${directory}\n      for this session (shift+tab)`);

test.each(['create', 'edit', 'overwrite'] as const)('extended %s menu binds the complete header and exact owned parent directory', operation => {
  const filePath = path.join(path.dirname(config), 'private state', 'ceo-plans', 'plan.md');
  const owner = { id: 'file', name: operation === 'edit' ? 'Edit' : 'Write', cwd: config, input: { file_path: filePath } };
  for (const subtitle of [path.relative(config, filePath), filePath]) {
    const dialog = directoryFileDialog(operation, subtitle, path.dirname(filePath));
    expect(currentFilePermissionTarget(dialog)).toEqual({ operation, filePath: subtitle });
    expect(nativePermissionKey(owner, dialog)).toBe(`${owner.name}:${filePath}`);
    expect(nativePermissionKey(owner, dialog.replace(/\n      /g, ' '))).toBe(`${owner.name}:${filePath}`);
    expect(nativePermissionKey(owner, dialog.slice(dialog.indexOf('╌')))).toBe(`${owner.name}:${filePath}`);
  }
});

// Full current-screen capture from the one-Write 120-column CLI diagnostic.
// The selected option is 1; the compound option 2 is never granted here.
test('retained complete outside-directory menu binds its exact native Write', () => {
  const frame = "\n ▐▛███▛█   Claude Code v2.1.263\n▝▜██████▀  Fable 5.1 · API Usage Billing\n  ▝▝ ▝▝    /tmp/gstack-hermetic-3734902-j94Svq/gstack-e2e-plan-ceo-paired-KdquY1\n\n\n❯ Use the Write tool exactly once to create \"/tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstac\n  k-e2e-plan-ceo-paired-KdquY1/ceo-plans/2026-09-09-payment-test-coverage.md\" with exactly this content: \"# Fake CEO\n  plan\\nDiagnostic marker: 6ef6a97d-8eb6-4cae-87df-357ca47565ad\\nNo real project data.\\n\". This is a private\n  permission-dialog diagnostic. Do not use Bash, run a review, or create any other file.\n\n● Creating the diagnostic file now.\n\n● Write(/tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstac…/2026-09-09-payment-test-coverage.md)\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n Create file\n ../permission-state-ZmakWx/projects/gstack-e2e-plan-ceo-paired-KdquY1/ceo-plans/2026-09-09-payment-test-coverage.md\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n  1 # Fake CEO plan\n  2 Diagnostic marker: 6ef6a97d-8eb6-4cae-87df-357ca47565ad\n  3 No real project data.\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to create 2026-09-09-payment-test-coverage.md?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session; Yes, and\n      always allow access to\n      /tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstack-e2e-plan-ceo-paired-KdquY1/ceo-plans\n      for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend\n                                                                                                     \n\n\n                                                                                                      \n\n\n\n";
  const tool = {
  "id": "toolu_015EevmuskBCGKqz88djcKnM",
  "name": "Write",
  "input": {
    "file_path": "/tmp/gstack-hermetic-3734902-j94Svq/permission-state-ZmakWx/projects/gstack-e2e-plan-ceo-paired-KdquY1/ceo-plans/2026-09-09-payment-test-coverage.md",
    "content": "# Fake CEO plan\nDiagnostic marker: 6ef6a97d-8eb6-4cae-87df-357ca47565ad\nNo real project data.\n"
  },
  "cwd": "/tmp/gstack-hermetic-3734902-j94Svq/gstack-e2e-plan-ceo-paired-KdquY1"
};
  expect(currentFilePermissionTarget(frame)).toEqual({ operation: 'create',
    filePath: path.relative(tool.cwd, tool.input.file_path) });
  expect(nativePermissionKey(tool, frame)).toBe('Write:' + tool.input.file_path);
  expect(() => nativePermissionKey({ ...tool, input: { ...tool.input, file_path: tool.input.file_path + '.other' } }, frame)).toThrow();
  expect(() => nativePermissionKey(tool, frame.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes,', ' ❯ 2. Yes,'))).toThrow();
});

test('extended menu refuses mismatched, clipped, wrapped, relative or malformed directory identity', () => {
  const filePath = path.join(path.dirname(config), 'private state', 'ceo-plans', 'plan.md');
  const directory = path.dirname(filePath);
  const owner = { id: 'file', name: 'Write', cwd: config, input: { file_path: filePath } };
  const dialog = directoryFileDialog('create', path.relative(config, filePath), directory);
  for (const invalid of [
    directoryFileDialog('create', path.relative(config, filePath), path.dirname(directory)),
    directoryFileDialog('create', path.relative(config, filePath), directory + '-other'),
    directoryFileDialog('create', path.relative(config, filePath), path.relative(config, directory)),
    directoryFileDialog('create', path.relative(config, filePath), directory.replace('private state', 'privatestate')),
    dialog.replace(directory, directory.replace('ceo-plans', 'ceo-\n      plans')),
    dialog.replace(directory, directory.replace('ceo-plans', '…/ceo-plans')),
    dialog.replace(directory, directory + '\t'),
    dialog.replace('always allow access to', 'always allow access everywhere including'),
    dialog.replace('3.No', '3.Yes\n4.No'),
    dialog.replace(' Do you want to create plan.md?', ' Do you want to create other.md?'),
    dialog.slice(dialog.indexOf('╌')).replace(directory, ''),
  ]) expect(() => nativePermissionKey(owner, invalid)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, name: 'Edit' }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: undefined }, dialog)).toThrow('cannot be bound');
});

test('extended menu reserves the hook-owned Write once and keeps multiple writable owners ambiguous', () => {
  const input = { file_path: path.join(path.dirname(config), 'private-state', 'ceo-plans', 'plan.md'), content: 'Fake plan' };
  write(nativeWrite('owned-write', input));
  const { source, event } = filePermissionRequest(input);
  const native = readPlanSkillQuestions(config, sessionId, source);
  const dialog = directoryFileDialog('create', path.relative(config, input.file_path), path.dirname(input.file_path));
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, dialog, granted, requests)).toBe(false);
  expect([...granted]).toEqual([`request:${event.requestId}`]);
  expect([...requests.keys()]).toEqual([`Write:${input.file_path}`]);
  native.permissionTools.push({ id: 'other-read', name: 'Read', cwd: config, input: { file_path: path.join(config, 'README.md') } });
  expect(reserveNativePermissionGrant(native, dialog, new Set(), new Map())).toBe(true);
  native.permissionRequests.push({ ...native.permissionRequests[0]!, requestId: 'other-write', nativeToolId: undefined });
  const refused = new Set<string>();
  expect(() => reserveNativePermissionGrant(native, dialog, refused, new Map())).toThrow('Ambiguous');
  expect(refused.size).toBe(0);
});

// Autoplan can queue the restore Write, plan Edit, a Read and Bash before
// the first permission finishes. The current file card owns only its exact path.
test.each(['Edit', 'Write'] as const)('current file grant distinguishes a pending %s to another file', name => {
  const relative = '.gstack/projects/fixture/restore.md';
  const input = { file_path: path.join(config, relative), content: 'Restore point' };
  const other = name === 'Edit'
    ? { file_path: path.join(config, '.claude/plans/plan.md'), old_string: '# Plan', new_string: '# Updated plan' }
    : { file_path: path.join(config, 'other/restore.md'), content: 'Other restore point' };
  write(nativeWrite('restore', input), nativeWrite('plan', other, config, name),
    nativeWrite('read', { file_path: path.join(config, 'review-sections.md') }, config, 'Read'),
    nativeWrite('bash', { command: 'true' }, config, 'Bash'));
  const { source, event } = filePermissionRequest(input);
  const native = readPlanSkillQuestions(config, sessionId, source);
  expect(native.permissionRequests).toHaveLength(1);
  expect(native.permissionTools).toHaveLength(4);
  const dialog = nestedFileDialog('create', relative);
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, dialog, granted, requests)).toBe(false);
  expect([...granted]).toEqual([`request:${event.requestId}`]);
  expect([...requests.keys()]).toEqual([`Write:${input.file_path}`]);

  // A second captured permission remains pending, regardless of request order.
  const next = { ...native.permissionRequests[0]!, requestId: 'other-request',
    nativeToolId: 'plan', name, input: other };
  native.permissionRequests.unshift(next);
  expect(reserveNativePermissionGrant(native, dialog, new Set(), new Map())).toBe(true);
  expect(native.permissionRequests[0]).toEqual(next);
});

test.each(['relative-path', 'missing-path'] as const)('parallel writable owner refuses %s without recording a grant', variant => {
  const input = { file_path: path.join(config, 'restore.md'), content: 'Restore point' };
  write(nativeWrite('restore', input));
  const { source } = filePermissionRequest(input);
  const native = readPlanSkillQuestions(config, sessionId, source);
  native.permissionTools.push({ id: 'other', name: 'Edit', cwd: config,
    input: variant === 'relative-path' ? { file_path: 'other.md' } : {} });
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(() => reserveNativePermissionGrant(native, nestedFileDialog('create', 'restore.md'), granted, requests)).toThrow();
  expect(granted.size).toBe(0); expect(requests.size).toBe(0);
});

test.each(['create', 'edit', 'overwrite'] as const)('current %s title and subtitle bind a nested basename to its owned file', operation => {
  const relative = path.join('.gstack', 'projects', 'fixture', 'restore.md');
  const filePath = path.join(config, relative);
  const owner = { id: 'file', name: operation === 'edit' ? 'Edit' : 'Write', cwd: config, input: { file_path: filePath } };
  const dialog = nestedFileDialog(operation, relative);
  expect(currentFilePermissionTarget(dialog)).toEqual({ operation, filePath: relative });
  expect(nativePermissionKey(owner, dialog)).toBe(`${owner.name}:${filePath}`);
  expect(nativePermissionKey(owner, dialog.replace('Plan content', 'Example ❯ 1. text'))).toBe(`${owner.name}:${filePath}`);
  expect(() => nativePermissionKey({ ...owner, input: { file_path: path.join(config, 'other', 'restore.md') } }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: undefined }, dialog)).toThrow('cannot be bound');
});

test('nested file binding refuses clipped, conflicting, quoted or ambiguous header evidence', () => {
  const relative = '.gstack/projects/fixture/restore.md';
  const owner = { id: 'file', name: 'Write', cwd: config, input: { file_path: path.join(config, relative) } };
  const dialog = nestedFileDialog('create', relative);
  for (const invalid of [
    createDialog('restore.md'), // basename alone still resolves only at cwd
    dialog.slice(dialog.indexOf('╌')),
    dialog.replace(relative, '…/fixture/restore.md'),
    dialog.replace(relative, '.gstack/projects/other/restore.md'),
    dialog.replace(relative, '.gstack/projects/fixture/other.md'),
    dialog.replace('Create file', 'Edit file'),
    dialog.replace(' Create file', '  1 Create file'),
    dialog.replace(' Create file', '> Create file'),
    dialog.replace('─'.repeat(120), 'quoted header'),
    nestedFileDialog('create', relative) + '\n' + createDialog('restore.md'),
    dialog.replace('\n ' + relative, '\n ' + relative + '\n Create file\n ' + relative),
  ]) expect(() => nativePermissionKey(owner, invalid)).toThrow('cannot be bound');
});

// A current terminal viewport can start at the title, with its leading rule
// scrolled away; the full rule below its subtitle still bounds the same card.
// Native display padding is not part of the owned filesystem path.
function renderedPermissionCard(variant: string, subtitle = 'plan.md') {
  let frame = nestedFileDialog('edit', subtitle);
  if (variant !== 'padding') frame = frame.slice(frame.indexOf('\n') + 1);
  if (variant !== 'clipped-rule') frame = frame.replace('\n ' + subtitle + '\n', '\n ' + subtitle + '   \n');
  return frame;
}

test.each(['clipped-rule', 'padding', 'both'])('current permission card supports native %s with one exact owned grant', variant => {
  const s = earlyFileCompletion(); s.complete(); s.emit('PermissionRequest', s.nextInput);
  const frame = renderedPermissionCard(variant), native = s.read();
  expect(currentFilePermissionTarget(frame)).toEqual({ operation: 'edit', filePath: 'plan.md' });
  expect(reserveNativePermissionGrant(native, frame, s.granted, s.requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, frame, s.granted, s.requests)).toBe(false);
  expect(s.granted.size).toBe(2);
});

test.each(['clipped-rule', 'padding', 'both'])('native %s rendering keeps exact path spaces and rejects another owned filename', variant => {
  const relative = 'notes/approved  plan.md', filePath = path.join(config, relative);
  const frame = renderedPermissionCard(variant, relative);
  const owner = { id: 'edit', name: 'Edit', cwd: config, input: { file_path: filePath } };
  expect(nativePermissionKey(owner, frame)).toBe('Edit:' + filePath);
  for (const wrong of ['notes/approved plan.md', relative + ' ', 'other/approved  plan.md']) {
    expect(() => nativePermissionKey({ ...owner, input: { file_path: path.join(config, wrong) } }, frame)).toThrow('cannot be bound');
  }
});

test.each(['quoted-prelude', 'blank-prelude', 'missing-bottom-rule', 'broken-bottom-rule', 'wrapped-subtitle', 'tab-padding',
  'unicode-padding', 'leading-padding', 'duplicate-header', 'intervening-menu', 'wider-than-rule', 'wrong-operation'])
('current permission card still refuses %s', variant => {
  let frame = renderedPermissionCard('both', 'notes/plan.md');
  if (variant === 'quoted-prelude') frame = 'Example:\n' + frame;
  if (variant === 'blank-prelude') frame = '\n' + frame;
  if (variant === 'missing-bottom-rule') frame = frame.replace('╌'.repeat(120), '');
  if (variant === 'broken-bottom-rule') frame = frame.replace('╌'.repeat(120), '╌'.repeat(119) + 'x');
  if (variant === 'wrapped-subtitle') frame = frame.replace('notes/plan.md', 'notes/\nplan.md');
  if (variant === 'tab-padding') frame = frame.replace('plan.md   \n', 'plan.md\t\n');
  if (variant === 'unicode-padding') frame = frame.replace('plan.md   \n', 'plan.md\u00a0\n');
  if (variant === 'leading-padding') frame = frame.replace('\n notes/plan.md', '\n  notes/plan.md');
  if (variant === 'duplicate-header') frame = frame.replace('  1 Plan content', ' Edit file\n notes/plan.md\n  1 Plan content');
  if (variant === 'intervening-menu') frame = frame.replace('  1 Plan content', ' ❯ 1. Prior choice\n  1 Plan content');
  if (variant === 'wider-than-rule') frame = frame.replace('╌'.repeat(120), '╌'.repeat(10));
  if (variant === 'wrong-operation') frame = frame.replace(' Edit file', ' Create file');
  expect(currentFilePermissionTarget(frame)).toBeNull();
});

test('modern native Edit wording binds its exact owned relative or absolute path', () => {
  // Claude 2.1.257 Io(Edit) + Cwo: "Do you want to make this edit to <fileName>?"
  const filePath = path.join(config, 'plan.md');
  write(nativeWrite('edit', { file_path: filePath, old_string: 'Draft', new_string: 'Final report' }, config, 'Edit'));
  const owner = readPlanSkillQuestions(config, sessionId).permissionTools[0]!;
  for (const displayed of ['plan.md', filePath]) {
    const dialog = createDialog(displayed).replace('create', 'make this edit to');
    expect(currentFilePermissionTarget(dialog)).toEqual({ operation: 'edit', filePath: displayed });
    expect(isPermissionDialogVisible(dialog)).toBe(true);
    expect(nativePermissionKey(owner, dialog)).toBe(`Edit:${filePath}`);
  }
});

test('modern native Edit wording keeps malformed and restricted menus unsupported', () => {
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  for (const malformed of [
    dialog.replace('make this edit to', 'make these edits to'),
    dialog.replace('make this edit to', 'make this edit for'),
    dialog.replace('make this edit to', 'make this edit'),
    dialog.replace('make this edit to', 'write to'),
    dialog.replace('auto-approve file edits and common file commands', 'review this plan'),
    'Do you want to make this edit to plan.md?\n❯1.Yes\n2.No',
  ]) {
    expect(currentFilePermissionTarget(malformed)).toBeNull();
    expect(isPermissionDialogVisible(malformed)).toBe(false);
  }
});

test('modern native Edit wording cannot bind a different path, cwd, tool or later menu', () => {
  const filePath = path.join(config, 'plan.md');
  const owner = { id: 'edit', name: 'Edit', cwd: config, input: { file_path: filePath, old_string: 'Draft', new_string: 'Final' } };
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  expect(() => nativePermissionKey({ ...owner, name: 'Write' }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: path.dirname(config) }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, dialog.replace('plan.md', 'other.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, `${dialog}\n${createDialog('other.md')}`)).toThrow('cannot be bound');
});

test('modern native Edit wording preserves ordinary Write create and overwrite ownership', () => {
  const filePath = path.join(config, 'plan.md');
  const owner = { id: 'write', name: 'Write', cwd: config, input: { file_path: filePath, content: 'Final report' } };
  for (const operation of ['create', 'overwrite'] as const) {
    const dialog = createDialog('plan.md').replace('create', operation);
    expect(currentFilePermissionTarget(dialog)).toEqual({ operation, filePath: 'plan.md' });
    expect(nativePermissionKey(owner, dialog)).toBe(`Write:${filePath}`);
    expect(() => nativePermissionKey({ ...owner, name: 'Edit' }, dialog)).toThrow('cannot be bound');
  }
});

test('modern native Edit wording does not regrant an indistinguishable completed Edit', () => {
  const input = { file_path: path.join(config, 'plan.md'), old_string: 'Draft', new_string: 'Final' };
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  const granted = new Set<string>();
  const requests = new Map<string, NativePermissionGrant>();
  write(nativeWrite('edit-first', input, config, 'Edit'));
  const first = readPlanSkillQuestions(config, sessionId);
  expect(reserveNativePermissionGrant(first, dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(first, dialog, granted, requests)).toBe(false);
  write(nativeWrite('edit-first', input, config, 'Edit'), nativeWriteResult('edit-first'), nativeWrite('edit-again', input, config, 'Edit'));
  expect(() => reserveNativePermissionGrant(readPlanSkillQuestions(config, sessionId), dialog, granted, requests)).toThrow('cannot be distinguished');
});

// The retained cfa50758 PermissionRequest appended GSTACK REVIEW REPORT by
// replacing an existing final paragraph with that paragraph plus the report.
// Reproduce that Edit shape with synthetic content and a launcher-owned hook.
async function scopedEditSequence(variant = 'native', unfinishedPrior = false) {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const emit = (input: unknown) => {
    const previous = new Set(readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file }).map(event => event.requestId));
    const child = Bun.spawnSync(['bash', '-c', command], { timeout: 5000,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: sessionId,
        transcript_path: file, cwd: config, tool_name: 'Edit', tool_input: input })), stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file })
      .find(event => !previous.has(event.requestId))!;
  };
  const old_string = '### Unresolved Decisions\n\nNone. The review choices were answered.';
  const firstInput = { file_path: path.join(config, 'plan.md'), old_string: 'Draft', new_string: old_string, replace_all: false };
  const nextInput = variant === 'same-input' ? firstInput : {
    file_path: path.join(config, variant === 'wrong-path' ? 'other.md' : 'plan.md'), old_string,
    new_string: old_string + '\n\n## GSTACK REVIEW REPORT\n\n| Review | Runs | Status | Findings |\n| CEO | 1 | CLEAR | Review complete |\n\n**VERDICT:** CEO CLEARED\n\nNO UNRESOLVED DECISIONS',
    replace_all: false,
  };
  const first = nativeWrite('scoped-edit-1', firstInput, config, 'Edit');
  write(first);
  const firstEvent = emit(firstInput);
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  const read = () => readPlanSkillQuestions(config, sessionId, variant === 'no-observer' ? undefined : source);
  expect(reserveNativePermissionGrant(read(), dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(read(), dialog, granted, requests)).toBe(false);
  const resultAtMs = firstEvent.capturedAtMs + (variant === 'before-result' ? 60_000
    : variant === 'prior-before-request' ? -1 : variant === 'prior-equal-request' ? 0 : 1);
  const rows: unknown[] = [unfinishedPrior || variant === 'unfinished-prior' ? nativeWrite('scoped-edit-1', firstInput, config, 'Edit', null) : first];
  if (variant !== 'no-ack') rows.push(nativeWriteResult('scoped-edit-1', new Date(resultAtMs).toISOString(), variant === 'error'));
  if (variant !== 'early') rows.push(nativeWrite(variant === 'changed-id' ? 'scoped-edit-1' : 'scoped-edit-2', nextInput,
    variant === 'wrong-cwd' ? path.dirname(config) : config, 'Edit'));
  if (variant === 'multiple-owner') rows.push(nativeWrite('other-pending', { command: 'true' }, config, 'Bash'));
  if (variant === 'parallel-read') rows.push(nativeWrite('other-pending', { file_path: path.join(config, 'README.md') }, config, 'Read'));
  if (variant === 'parallel-tool-search') rows.push(nativeWrite('other-pending', { query: 'select:AskUserQuestion' }, config, 'ToolSearch'));
  if (variant === 'same-path-owner') rows.push(nativeWrite('other-pending', { ...nextInput, new_string: 'Different pending edit' }, config, 'Edit'));
  write(...rows);
  await Bun.sleep(5);
  const nextEvent = emit(nextInput);
  if (variant === 'equal-result') {
    rows[1] = nativeWriteResult('scoped-edit-1', new Date(nextEvent.capturedAtMs).toISOString());
    write(...rows);
  }
  return { read, dialog, granted, requests, firstEvent, nextEvent, resultAtMs, nextInput };
}

test.each(['native', 'early', 'multiple-owner', 'parallel-read', 'parallel-tool-search', 'unfinished-prior'])('fresh scoped Edit can append the terminal report after a completed Edit (%s)', async variant => {
  const sequence = await scopedEditSequence(variant);
  const native = sequence.read();
  const prior = native.permissionRequests.find(item => item.requestId === sequence.firstEvent.requestId)!;
  expect(prior).toMatchObject({ result: 'completed', nativeToolId: 'scoped-edit-1', nativeResultAtMs: sequence.resultAtMs });
  expect(sequence.nextEvent.requestId).not.toBe(sequence.firstEvent.requestId);
  expect(sequence.nextEvent.capturedAtMs).toBeGreaterThan(sequence.resultAtMs);
  expect(native.permissionRequests.find(item => item.requestId === sequence.nextEvent.requestId)).toMatchObject({ result: 'pending', input: sequence.nextInput });
  expect(reserveNativePermissionGrant(native, sequence.dialog, sequence.granted, sequence.requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, sequence.dialog, sequence.granted, sequence.requests)).toBe(false);
  expect(sequence.granted.size).toBe(2);
  expect(sequence.requests.get(`Edit:${path.join(config, 'plan.md')}`)?.requestId).toBe(sequence.nextEvent.requestId);
  if (variant === 'multiple-owner' || variant === 'parallel-read' || variant === 'parallel-tool-search') {
    expect(native.permissionTools.some(tool => tool.id === 'other-pending')).toBe(true);
    expect(sequence.granted.has('other-pending')).toBe(false);
  }
});

test.each(['no-file-owner', 'wrong-file', 'two-file-owners', 'no-observer'])
('parallel ToolSearch cannot authorize a file grant with %s', async variant => {
  const sequence = await scopedEditSequence('parallel-tool-search');
  const native = sequence.read();
  if (variant === 'no-file-owner') {
    native.permissionRequests = [];
    native.permissionTools = native.permissionTools.filter(tool => tool.name === 'ToolSearch');
  }
  if (variant === 'two-file-owners') native.permissionRequests.push({
    ...native.permissionRequests.find(request => request.result === 'pending')!,
    requestId: 'second-edit', nativeToolId: undefined,
  });
  if (variant === 'no-observer') native.permissionRequestCapture = false;
  const dialog = variant === 'wrong-file' ? sequence.dialog.replace('plan.md', 'other.md') : sequence.dialog;
  const grantedBefore = [...sequence.granted], requestsBefore = [...sequence.requests];
  expect(() => reserveNativePermissionGrant(native, dialog, sequence.granted, sequence.requests)).toThrow();
  expect([...sequence.granted]).toEqual(grantedBefore);
  expect([...sequence.requests]).toEqual(requestsBefore);
});

test.each(['no-ack', 'error', 'before-result', 'equal-result', 'same-input', 'changed-id', 'wrong-path', 'wrong-cwd', 'same-path-owner', 'no-observer'])
('fresh scoped Edit preserves refusal for %s', async variant => {
  const sequence = await scopedEditSequence(variant);
  expect(() => reserveNativePermissionGrant(sequence.read(), sequence.dialog, sequence.granted, sequence.requests))
    .toThrow(/Repeated native permission|Indistinguishable|changed input|cannot be bound|Ambiguous native permission/);
  expect(sequence.granted.size).toBe(1);
});

test.each(['no-ack', 'error', 'prior-before-request', 'prior-equal-request', 'before-result', 'equal-result',
  'same-input', 'changed-id', 'wrong-cwd', 'same-path-owner'])
('unfinished Edit retirement preserves refusal for %s', async variant => {
  const sequence = await scopedEditSequence(variant, true);
  const granted = [...sequence.granted], requests = [...sequence.requests];
  expect(() => reserveNativePermissionGrant(sequence.read(), sequence.dialog, sequence.granted, sequence.requests)).toThrow();
  expect([...sequence.granted]).toEqual(granted);
  expect([...sequence.requests]).toEqual(requests);
});

test('unfinished pending Edit has no native grant authority without an owned request', () => {
  const input = { file_path: path.join(config, 'plan.md'), old_string: 'Draft', new_string: 'Approved' };
  write(nativeWrite('unfinished-pending', input, config, 'Edit', null));
  const native = readPlanSkillQuestions(config, sessionId);
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(native.permissionTools).toEqual([]);
  expect(reserveNativePermissionGrant(native, createDialog('plan.md').replace('create', 'make this edit to'), granted, requests)).toBe(false);
  expect(granted.size).toBe(0); expect(requests.size).toBe(0);
});

test.each(['same-path', 'mixed-operation', 'granted-shadow', 'no-observer', 'legacy-file', 'legacy-bash', 'malformed', 'unsupported', 'no-match'])
('a current file dialog with parallel work preserves refusal for %s', async variant => {
  const sequence = await scopedEditSequence('multiple-owner');
  const native = variant === 'no-observer' ? readPlanSkillQuestions(config, sessionId) : sequence.read();
  const owner = native.permissionRequests.find(request => request.requestId === sequence.nextEvent.requestId)!;
  let dialog = sequence.dialog;
  if (variant === 'same-path' || variant === 'granted-shadow') {
    native.permissionRequests.push({ ...owner, requestId: 'distinct-pending-request', nativeToolId: undefined });
    if (variant === 'granted-shadow') sequence.granted.add(`request:${owner.requestId}`);
  }
  if (variant === 'mixed-operation') native.permissionTools.push({
    id: 'same-path-write', name: 'Write', cwd: config,
    input: { file_path: sequence.nextInput.file_path, content: 'Other pending write' },
  });
  if (variant === 'legacy-file') dialog = `Edit to ${sequence.nextInput.file_path}`;
  if (variant === 'legacy-bash') dialog = 'Bash command true requires permission';
  if (variant === 'malformed') native.permissionTools.find(tool => tool.id === 'other-pending')!.input = { command: 42 };
  if (variant === 'unsupported') native.permissionTools.find(tool => tool.id === 'other-pending')!.name = 'Grep';
  if (variant === 'no-match') dialog = dialog.replace('plan.md', 'different.md');
  const grantedBefore = [...sequence.granted], requestsBefore = [...sequence.requests];
  expect(() => reserveNativePermissionGrant(native, dialog, sequence.granted, sequence.requests))
    .toThrow(variant === 'malformed' || variant === 'unsupported' ? 'Unsupported native permission' : 'Ambiguous native permission');
  expect([...sequence.granted]).toEqual(grantedBefore);
  expect([...sequence.requests]).toEqual(requestsBefore);
});

test('modern overwrite permission uses the exact current Write path and controls', () => {
  const filePath = path.join(config, 'plan.md');
  const dialog = createDialog('plan.md').replace('create', 'overwrite');
  const owner = { id: 'overwrite', name: 'Write', cwd: config, input: { file_path: filePath, content: 'Final report' } };
  expect(isPermissionDialogVisible(dialog)).toBe(true);
  expect(nativePermissionKey(owner, dialog)).toBe(`Write:${filePath}`);
  expect(() => nativePermissionKey({ ...owner, name: 'Edit' }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: path.dirname(config) }, dialog)).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, dialog.replace('plan.md', 'other.md'))).toThrow('cannot be bound');
  expect(isPermissionDialogVisible(dialog.replace('auto-approve file edits and common file commands', 'review this plan'))).toBe(false);
  expect(isPermissionDialogVisible('Do you want to overwrite plan.md?\n❯1.Yes\n2.No')).toBe(false);
});

test('current create-file permission controls are recognized without treating an ordinary decision as permission', () => {
  // Exact controls retained from the CEO finding-count timeout. Its clipped
  // basename is evidence for classification only, never path authorization.
  expect(isPermissionDialogVisible(createDialog('gstck-test-plan-co.md').replace('Do you', 'Doyou'))).toBe(true);
  expect(isPermissionDialogVisible('Do you want to create plan.md?\n❯1.Yes\n2.No')).toBe(false);
  expect(isPermissionDialogVisible(createDialog('plan.md').replace('auto-approve file edits and common file commands', 'review the recommendation'))).toBe(false);
});

test('current file permissions resolve the exact displayed relative path against the owned native cwd', () => {
  const cwd = path.join(config, 'project');
  const filePath = path.join(cwd, 'plan.md');
  write({ type: 'assistant', sessionId, cwd, message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: filePath, content: 'Plan' } }] } });
  const owner = readPlanSkillQuestions(config, sessionId).permissionTools[0]!;
  expect(nativePermissionKey(owner, createDialog('plan.md'))).toBe(`Write:${filePath}`);
  expect(nativePermissionKey(owner, createDialog(filePath))).toBe(`Write:${filePath}`);
  expect(() => nativePermissionKey({ ...owner, cwd: path.join(config, 'different') }, createDialog('plan.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, cwd: undefined }, createDialog('plan.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...owner, name: 'Read' }, createDialog(filePath))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, createDialog('pln.md'))).toThrow('cannot be bound');
  expect(() => nativePermissionKey(owner, `${createDialog(filePath)}\n${createDialog('other.md')}`)).toThrow('cannot be bound');
});

// Sanitized retained native frame: preceding assistant prose omitted; modal rows unchanged.
const wrappedPreviewFixture = {
  "questions": [
    {
      "header": "Approach",
      "multiSelect": false,
      "options": [
        {
          "description": "PreToolUse hook captures AUQ before transcript write; transcript confirms result status. Race-proof, injection-hardened, tests the real rendering path. Completeness: 9/10.",
          "label": "B: Hook + transcript (current approach) (recommended)",
          "preview": "APPROACH B: Hook + transcript cross-reference\n  Captures: early events (hook) + result status (transcript)\n  Race-proof: yes — hook fires synchronously before tool result\n  Injection-safe: nonce + scope + FIFO rejection + path validation\n  Tests real rendering path: yes\n  Completeness: 9/10"
        },
        {
          "description": "Poll readOwnedClaudeTranscript until question appears. Simpler but flaky under CI load. Completeness: 5/10.",
          "label": "A: Transcript-only with retry",
          "preview": "APPROACH A: Transcript-only with retry\n  Captures: result status only (not pre-transcript events)\n  Race-proof: no — timing depends on CI load\n  Flaky risk: high\n  Completeness: 5/10"
        },
        {
          "description": "Replace AUQ at the harness level with canned answers. Avoids timing entirely but misses rendering bugs. Completeness: 6/10.",
          "label": "C: Question injection/mock",
          "preview": "APPROACH C: Question injection\n  Captures: nothing real — bypasses AUQ entirely\n  Race-proof: yes (trivially)\n  Tests real rendering: no\n  Completeness: 6/10"
        }
      ],
      "question": "D1 — Which implementation approach does this branch use, and do you want to proceed with it?"
    },
    {
      "header": "Review mode",
      "multiSelect": false,
      "options": [
        {
          "description": "This is test infrastructure — make it bulletproof. Catch failure modes, edge cases, security assumptions. No expansions surfaced. Right for infra/fix work.",
          "label": "HOLD SCOPE (recommended)",
          "preview": "HOLD SCOPE\n  Focus: correctness, security, edge cases\n  Expansions: none surfaced\n  Right for: bug fixes, infra improvements"
        },
        {
          "description": "Hold the current scope as baseline, but surface cherry-pick opportunities: extend to other skills, auto-answer hints, better error messages when unanswered.",
          "label": "SELECTIVE EXPANSION",
          "preview": "SELECTIVE EXPANSION\n  Focus: correctness + cherry-pick opportunities\n  Expansions: each presented individually\n  Right for: solid work that might have natural adjacent wins"
        },
        {
          "description": "Dream big — what would a 10x eval system look like? Rethink the whole approach. Right if you want to question premises, not just validate them.",
          "label": "SCOPE EXPANSION",
          "preview": "SCOPE EXPANSION\n  Focus: ambitious re-imagining\n  Expansions: enthusiastically recommended\n  Right for: early-stage or uncertain direction"
        }
      ],
      "question": "D2 — Which review mode?"
    }
  ],
  "visible": [
    "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "←  ☐ Approach  ☐ Review mode  ✔ Submit  →",
    "",
    "│ D1 — Which implementation approach does this branch use, and do you want to proceed with it?",
    "",
    "❯ 1. B: Hook + transcript         ┌────────────────────────────────────────────────────────────────────┐",
    "    (current approach)            │ APPROACH B: Hook + transcript cross-reference                      │",
    "    (recommended)                 │   Captures: early events (hook) + result status (transcript)       │",
    "  2. A: Transcript-only with      │   Race-proof: yes — hook fires synchronously before tool result    │",
    "    retry                         │   Injection-safe: nonce + scope + FIFO rejection + path validation │",
    "  3. C: Question                  │   Tests real rendering path: yes                                   │",
    "    injection/mock                │   Completeness: 9/10                                               │",
    "                                  └────────────────────────────────────────────────────────────────────┘",
    "",
    "                                  Notes: press n to add notes",
    "                                                                                ",
    "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel",
  ].join("\n")
};
const wrappedQuestion = wrappedPreviewFixture.questions[0]!;
const wrappedModeQuestion = wrappedPreviewFixture.questions[1]!;
const matchesWrapped = (visible: string, offered: NativeQuestion = wrappedQuestion) =>
  matchesNativeQuestion(offered, visible, parseNumberedOptions(visible), wrappedPreviewFixture.questions);

test('the retained preview menu corroborates physical label continuations', () => {
  expect(matchesWrapped(wrappedPreviewFixture.visible)).toBe(true);
  expect(matchesWrapped(wrappedPreviewFixture.visible, wrappedModeQuestion)).toBe(false);
});


const recommendedWrapQuestion: NativeQuestion = {
  header: 'Accessibility', multiSelect: false,
  question: 'D12 — Issue 9: Add the accessibility spec (keyboard, screen reader, contrast, motion) to the plan?',
  options: [
    { label: '9A) Full a11y spec: landmarks, focus order, live regions, contrast targets, reduced motion, test checklist (recommended)', description: 'Rail as nav landmark; visible labels and a manual test checklist.' },
    { label: '9B) Contrast fix only, as the seed plan proposed', description: 'Resolve only the contrast defect.' },
  ],
};
const recommendedWrapFrame = '☐ Accessibility\n' + recommendedWrapQuestion.question
  + '\n❯ 1. ' + recommendedWrapQuestion.options[0]!.label.replace(' (recommended)', '')
  + '\n    (recommended)\n    Rail as nav landmark; visible labels and a manual test checklist.\n  2. '
  + recommendedWrapQuestion.options[1]!.label + '\n    Resolve only the contrast defect.\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel';
const matchRecommendedWrap = (frame: string, owned = recommendedWrapQuestion) =>
  nativeQuestionSelection(owned, frame, parseNumberedOptions(frame));

test('plain owned label accepts its immediately wrapped recommendation suffix', () => {
  expect(parseNumberedOptions(recommendedWrapFrame)[0]!.label).not.toContain('(recommended)');
  expect(matchRecommendedWrap(recommendedWrapFrame)).toEqual({ kind: 'digit' });
  expect(matchRecommendedWrap(recommendedWrapFrame.replaceAll('    ', '').replaceAll('❯ 1. ', '❯1. '))).toEqual({ kind: 'digit' });
  expect(matchRecommendedWrap(recommendedWrapFrame, { ...recommendedWrapQuestion,
    options: recommendedWrapQuestion.options.map(option => ({ ...option, preview: 'Owned preview requires its own frame.' })) })).toBeNull();
});

test.each([
  (frame: string) => frame.replace('\n    (recommended)', ''),
  (frame: string) => frame.replace('(recommended)', '(not recommended)'),
  (frame: string) => frame.replace('(recommended)', '(recommended by the example)'),
  (frame: string) => frame.replace('\n    (recommended)', '\n\n    (recommended)'),
  (frame: string) => frame.replace('\n    (recommended)', '\n    Description first\n    (recommended)'),
  (frame: string) => frame.replace('❯ 1.', '(recommended)\n❯ 1.').replace('\n    (recommended)', ''),
  (frame: string) => frame.replace('test checklist', 'different checklist'),
  (frame: string) => frame.replace('2. 9B)', '2. Other action'),
  (frame: string) => frame.replace('\n    (recommended)', '\n  2. Another menu\n    (recommended)'),
  (frame: string) => frame.replace('D12 — Issue 9:', 'D13 — Different issue:'),
  (frame: string) => frame + '\n☐ Different\nD13 — Another question?\n❯ 1. Other action\n  2. Keep current state',
])('wrapped recommendation cannot bridge missing, changed, stale or interrupted labels %#', change => {
  expect(matchRecommendedWrap(change(recommendedWrapFrame))).toBeNull();
});

test('plain wrapped menus retain the existing parser behavior', () => {
  const visible = '☐ Approach\n' + wrappedQuestion.question + '\n❯ 1. B: Hook + transcript\n    (current approach)\n    (recommended)\n  2. A: Transcript-only with\n    retry\n';
  expect(matchesWrapped(visible)).toBe(false);
});

test('two complete native labels still corroborate when the last visible choice is clipped', () => {
  const visible = '☐ Approach\n' + wrappedQuestion.question + '\n❯ 1. B: Hook + transcript (current approach) (recommended)\n  2. A: Transcript-only with retry\n  3. C: Question';
  expect(matchesWrapped(visible)).toBe(true);
  expect(matchesWrapped(visible + '\n\n')).toBe(true);
});

test('a complete preview frame permits a valid clipped final label but rejects a changed prefix', () => {
  const visible = wrappedPreviewFixture.visible.replace('    injection/mock', ' '.repeat('    injection/mock'.length));
  expect(matchesWrapped(visible)).toBe(true);
  expect(matchesWrapped(visible.replace('C: Question', 'C: Changed!'))).toBe(false);
});

test('preview text cannot supply missing or changed left-column labels', () => {
  const preview = wrappedPreviewFixture.visible.replace(/│ APPROACH B:[^\n]*│/, `│ ${wrappedQuestion.options[0]!.label.padEnd(66)} │`);
  const missing = preview.replace('    (current approach)', ' '.repeat('    (current approach)'.length));
  expect(matchesWrapped(missing)).toBe(false);
  const changed = preview.replace('B: Hook + transcript', 'B: Different choice'.padEnd('B: Hook + transcript'.length));
  expect(matchesWrapped(changed)).toBe(false);
});

test('preview text containing a cursor cannot become the active option list', () => {
  const decoy = '❯ 1. ' + wrappedQuestion.options[0]!.label;
  const visible = wrappedPreviewFixture.visible.replace(/│ APPROACH B:[^\n]*│/, `│ ${decoy.padEnd(66)} │`);
  expect(matchesWrapped(visible)).toBe(true);
  expect(matchesWrapped(visible.replace('A: Transcript-only with', 'A: Unrelated choice'.padEnd('A: Transcript-only with'.length)))).toBe(false);
});

test('physical label continuation cannot jump a blank row or a menu boundary', () => {
  const visible = wrappedPreviewFixture.visible.replace('    (current approach)', ' '.repeat('    (current approach)'.length));
  expect(matchesWrapped(visible)).toBe(false);
  const decoy = wrappedPreviewFixture.visible.replace('    (current approach)', '    ──────────────────');
  expect(matchesWrapped(decoy)).toBe(false);
});

test('malformed preview borders and duplicate numbered rows remain refused', () => {
  expect(matchesWrapped(wrappedPreviewFixture.visible.replace('└', ' '))).toBe(false);
  expect(matchesWrapped(wrappedPreviewFixture.visible.replace('┐', ' '))).toBe(false);
  expect(matchesWrapped(wrappedPreviewFixture.visible.replace('  2. A:', '  1. A:'))).toBe(false);
});

test('a stale wrapped menu cannot corroborate the following current question', () => {
  const stale = wrappedPreviewFixture.visible + '\n☐ Another question\nD3 — Pick a different action?\n❯ 1. B: Hook + transcript (current approach) (recommended)\n  2. A: Transcript-only with retry\n';
  expect(matchesWrapped(stale)).toBe(false);
});

test('a later inline menu supersedes an older physical preview menu', () => {
  const current: NativeQuestion = { question: 'D3 — Pick a different action?', header: 'Another question', multiSelect: false,
    options: ['Keep current files', 'Inspect evidence'].map(label => ({ label, description: label })) };
  const visible = wrappedPreviewFixture.visible + '\n☐ Another question\nD3 — Pick a different action? ❯1. Keep current files 2. Inspect evidence\n';
  expect(matchesWrapped(visible)).toBe(false);
  expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible), [wrappedQuestion])).toBe(true);
});

test('an inline list beginning at the physical line start retains stream parsing', () => {
  const current: NativeQuestion = { question: 'Which?', header: 'Mode', multiSelect: false,
    options: ['Hold', 'Expand'].map(label => ({ label, description: label })) };
  for (const menu of ['❯1. Hold 2. Expand', '❯1.Hold2.Expand']) {
    const visible = '☐ Mode\nWhich?\n' + menu;
    expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible))).toBe(true);
  }
});

test('plain option glyphs do not create a side-preview frame', () => {
  for (const label of ['Keep │ pipes', 'Render ┌ corners', 'Render ┐ corners', 'Draw ┌──┐', 'Draw  ┌──┐']) {
    const current: NativeQuestion = { question: 'Which?', header: 'Mode', multiSelect: false,
      options: [label, 'Another choice'].map(label => ({ label, description: label })) };
    const visible = '☐ Mode\nWhich?\n❯1. ' + label + '\n  2. Another choice\n';
    expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible))).toBe(true);
  }
});

test('missing preview corners cannot promote right-column decoy labels', () => {
  const current: NativeQuestion = { question: 'Which?', header: 'Mode', multiSelect: false,
    options: ['Hold', 'Expand'].map(label => ({ label, description: label })) };
  const border = '┌' + '─'.repeat(28) + '┐';
  for (const top of [border, border.replace('┌', ' '), border.replace('┐', ' '), border.replace(/[┌┐]/g, ' ')]) {
    const visible = '☐ Mode\nWhich?\n' + '❯1. Wrong'.padEnd(24) + top + '\n'
      + '  2. Also wrong'.padEnd(24) + '│ ' + '❯1. Hold 2. Expand'.padEnd(26) + ' │\n'
      + ' '.repeat(24) + '└' + '─'.repeat(28) + '┘';
    expect(matchesNativeQuestion(current, visible, parseNumberedOptions(visible))).toBe(false);
  }
});


// Exact current modal and native input retained from expansion first-attempt
// diagnostic 13288fb0. Preview prose is display content, never choice authority.
const previewInputFrame = {
  "question": {
    "question": "Which implementation approach should anchor the review?",
    "header": "Approach",
    "multiSelect": false,
    "options": [
      {
        "label": "A — Client-side CSV (recommended)",
        "description": "Smallest diff. Reuses settings API response directly in the browser. One formatter util + tests. Completeness: 9/10 — covers the full happy path and edge-case escaping; misses server-auth-gate on export (not needed for settings).",
        "preview": "button onClick → fetch existing API → csvFormatter(data) → Blob URL download\n\nFiles touched: settings page (+button), csvFormatter.ts (new), csvFormatter.test.ts (new)"
      },
      {
        "label": "B — Server-side endpoint",
        "description": "Cleaner for large datasets; adds new route + handler + auth wiring. Completeness: 10/10 — fresh data, proper headers, server auth gate. Over-engineering for a settings page.",
        "preview": "GET /settings/export.csv\n  → auth middleware\n  → settingsService.getAll()\n  → csvSerializer()\n  → stream response\n\nFiles touched: route, handler, serializer, serializer.test, settings page (+button)"
      },
      {
        "label": "C — Client-side CSV + JSON bonus",
        "description": "Near-zero extra cost after A; adds a format dropdown. Completeness: 9/10 — same as A plus programmatic-use JSON format. Minor scope expansion.",
        "preview": "button [Export ▾]\n  ├ CSV → csvFormatter(data) → download\n  └ JSON → JSON.stringify(data, null, 2) → download\n\nSame files as A + dropdown component"
      }
    ]
  },
  "visible": [
    " ☐ Approach  ",
    "    ",
    "Which implementation approach should anchor the review?",
    "             ",
    "❯ 1. A — Client-side CSV          ┌────────────────────────────────────────────────────────────────────────────────────┐",
    "    (recommended)                 │ button onClick → fetch existing API → csvFormatter(data) → Blob URL download       │",
    "  2. B — Server-side endpoint     │                                                                                    │",
    "  3. C — Client-side CSV +        │ Files touched: settings page (+button), csvFormatter.ts (new),                     │",
    "    JSON bonus                    │ csvFormatter.test.ts (new)                                                         │",
    "                                  └────────────────────────────────────────────────────────────────────────────────────┘",
    "",
    "                                  Notes: press n to add notes",
    "                                                                                ",
    "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"
  ]
};
const currentPreview = previewInputFrame.visible.join('\n');
const previewInput = previewInputFrame.question;
const selectPreview = (visible = currentPreview, input: NativeQuestion = previewInput) =>
  nativeQuestionSelection(input, visible, parseNumberedOptions(visible));
const focusPreview = (index: number) => currentPreview.replace('❯ 1.', '  1.').replace(`  ${index}.`, `❯ ${index}.`);

test('retained preview selection follows its own left-column focus for each native choice', () => {
  expect(selectPreview()).toEqual({ kind: 'preview', focusedIndex: 1 });
  expect(selectPreview(focusPreview(2))).toEqual({ kind: 'preview', focusedIndex: 2 });
  expect(selectPreview(focusPreview(3))).toEqual({ kind: 'preview', focusedIndex: 3 });
});

// Exact clipping row and columns from the retained expansion-mode preview.
const retainedClippingRuler = '                                  ├─── ✂ ─── 1 lines hidden ───────────────────────────────────────────────────────────┤';
const clippedPreview = focusPreview(2).replace(/^( +└)/m, `${retainedClippingRuler}\n$1`);

test.each([1, 12])('preview clipping-ruler preserves owned left-column focus (%i hidden lines)', count => {
  const ruler = `├─── ✂ ─── ${count} lines hidden `.padEnd(85, '─') + '┤';
  const visible = clippedPreview.replace(retainedClippingRuler, ' '.repeat(34) + ruler);
  expect(selectPreview(visible)).toEqual({ kind: 'preview', focusedIndex: 2 });
});

test('preview clipping-ruler supports zero trailing dashes and a left-column label continuation', () => {
  const ruler = '├─── ✂ ─── 1 lines hidden ┤';
  const innerWidth = ruler.length - 2;
  const narrow = clippedPreview.split('\n').map(line => {
    const left = line.slice(0, 34);
    const pane = line.slice(34);
    if (pane.startsWith('├')) return left + ruler;
    if (pane.startsWith('┌')) return left + '┌' + '─'.repeat(innerWidth) + '┐';
    if (pane.startsWith('└')) return left + '└' + '─'.repeat(innerWidth) + '┘';
    if (pane.startsWith('│')) return left + '│' + pane.slice(1, innerWidth + 1).padEnd(innerWidth) + '│';
    return line;
  }).join('\n');
  expect(selectPreview(narrow)).toEqual({ kind: 'preview', focusedIndex: 2 });
  const sharedRow = focusPreview(3).replace(/^    JSON bonus +│[^\n]*│$/m,
    '    JSON bonus'.padEnd(34) + retainedClippingRuler.slice(34));
  expect(selectPreview(sharedRow)).toEqual({ kind: 'preview', focusedIndex: 3 });
});

test.each([
  ['shifted left edge', retainedClippingRuler.slice(1)],
  ['shifted right edge', retainedClippingRuler.replace('─┤', '──┤')],
  ['shortened right edge', retainedClippingRuler.replace('─┤', '┤')],
  ['missing left junction', retainedClippingRuler.replace('├', '│')],
  ['missing right junction', retainedClippingRuler.replace('┤', '│')],
  ['wrong scissors', retainedClippingRuler.replace('✂', 'x')],
  ['wrong delimiter', retainedClippingRuler.replace('✂ ───', '✂ ─ ─')],
  ['tab separator', retainedClippingRuler.replace('✂ ', '✂\t')],
  ['zero count', retainedClippingRuler.replace('1 lines', '0 lines')],
  ['negative count', retainedClippingRuler.replace('1 lines', '-1 lines').replace('──┤', '─┤')],
  ['leading zero', retainedClippingRuler.replace('1 lines', '01 lines').replace('──┤', '─┤')],
  ['wrong wording', retainedClippingRuler.replace('lines hidden', 'lines folded')],
  ['trailing content', retainedClippingRuler + ' x'],
  ['wrapped ruler', retainedClippingRuler.replace('lines hidden', 'lines\nhidden')],
] as const)('preview clipping-ruler rejects malformed frames: %s', (_name, ruler) => {
  expect(selectPreview(clippedPreview.replace(retainedClippingRuler, ruler))).toBeNull();
});

test('preview clipping-ruler must occur once immediately before the bottom border', () => {
  expect(selectPreview(clippedPreview.replace(retainedClippingRuler, `${retainedClippingRuler}\n${retainedClippingRuler}`))).toBeNull();
  expect(selectPreview(clippedPreview.replace(retainedClippingRuler, `${retainedClippingRuler}\n`))).toBeNull();
  const interior = focusPreview(2).replace(/^(    JSON bonus)/m, `${retainedClippingRuler}\n$1`);
  expect(selectPreview(interior)).toBeNull();
});

test('preview clipping-ruler cannot replace label, focus, rectangle, inventory or footer evidence', () => {
  expect(selectPreview(clippedPreview.replace('B — Server-side endpoint', 'B — Foreign-side endpoint'))).toBeNull();
  expect(selectPreview(clippedPreview.replace('  1.', '❯ 1.'))).toBeNull();
  expect(selectPreview(clippedPreview.replace('❯ 2.', '  2.'))).toBeNull();
  expect(selectPreview(clippedPreview.replace('└', ' '))).toBeNull();
  expect(selectPreview(clippedPreview, { ...previewInput, options: previewInput.options.map(({ preview, ...option }) => option) })).toBeNull();
  expect(selectPreview(clippedPreview.replace('Enter to select', 'Enter to confirm'))).toBeNull();
});

test('mixed native preview options retain the preview protocol for an option without preview', () => {
  const mixed = { ...previewInput, options: previewInput.options.map((option, index) => {
    const { preview, ...plain } = option; return index === 0 ? option : plain;
  }) };
  expect(selectPreview(focusPreview(2), mixed)).toEqual({ kind: 'preview', focusedIndex: 2 });
});

test('preview cursor content cannot substitute for missing, duplicate or wrong left-column focus', () => {
  const decoy = currentPreview.replace(/│ button onClick[^\n]*│/, '│ ' + '❯ 2. B — Server-side endpoint'.padEnd(82) + ' │');
  expect(selectPreview(decoy)).toEqual({ kind: 'preview', focusedIndex: 1 });
  expect(selectPreview(decoy.replace('❯ 1.', '  1.'))).toBeNull();
  expect(selectPreview(currentPreview.replace('  2.', '❯ 2.'))).toBeNull();
  expect(selectPreview(focusPreview(2).replace('B — Server-side endpoint', 'B — Foreign-side endpoint'))).toBeNull();
});

test('preview commit requires native inventory, current prompt, rectangle and actual footer', () => {
  const noPreview = { ...previewInput, options: previewInput.options.map(({ preview, ...option }) => option) };
  expect(selectPreview(currentPreview, noPreview)).toBeNull();
  expect(selectPreview(currentPreview.replace('Which implementation approach should anchor the review?', 'An unrelated later question'))).toBeNull();
  expect(selectPreview(currentPreview.replace('└', ' '))).toBeNull();
  expect(selectPreview(currentPreview.replace('Enter to select', 'Enter to confirm'))).toBeNull();
  expect(selectPreview(currentPreview + '\n☐ Different question\nOther prompt\n❯1.First\n2.Second')).toBeNull();
});

test('normal native input retains digit-only selection and preview input in a plain frame waits', () => {
  const noPreview = { ...previewInput, options: previewInput.options.map(({ preview, ...option }) => option) };
  const plain = `☐ ${noPreview.header}\n${noPreview.question}\n`
    + noPreview.options.map((option, i) => `${i === 0 ? '❯' : ' '}${i + 1}. ${option.label}`).join('\n');
  expect(selectPreview(plain, noPreview)).toEqual({ kind: 'digit' });
  expect(selectPreview(plain)).toBeNull();
});

// Exact complete retained 40-row frames and native input from HOLD diagnostic 9a5717f1.
const shortPreviewFrame = {
  "question": {
    "header": "Review mode",
    "multiSelect": false,
    "options": [
      {
        "description": "The plan is good but could be great. Dream big — propose the ambitious version (e.g., CSV + JSON + import/restore + scheduled backups). Every expansion proposed individually for your approval. You opt in to each one.",
        "label": "SCOPE EXPANSION"
      },
      {
        "description": "The CSV export scope is the baseline. Separately surface cherry-pick opportunities (e.g., JSON format option, copy-to-clipboard, column filtering) for you to individually accept or defer. Neutral recommendations — you decide what's worth adding.",
        "label": "SELECTIVE EXPANSION (recommended)",
        "preview": "Baseline: CSV export button + client-side formatting\nCherry-picks surfaced individually:\n  [ ] JSON export option?\n  [ ] Copy-to-clipboard fallback?\n  [ ] Column selection UI?\n  [ ] Download filename with timestamp?"
      },
      {
        "description": "The scope is right. Maximum rigor review only: architecture, security, edge cases (empty settings, special chars, large payloads), observability, deployment. No expansions surfaced.",
        "label": "HOLD SCOPE"
      },
      {
        "description": "Propose the minimum viable version: just the download trigger wired to the existing API, skip the formatter abstraction. Ruthlessly cut everything that isn't strictly necessary to ship the button.",
        "label": "SCOPE REDUCTION"
      }
    ],
    "question": "D2 — Which review mode do you want for this plan?"
  },
  "before": "\n  Read 1 file, ran 1 shell command\n\n● Now let me run the pre-review system audit and check for design docs.\n\n  Ran 4 shell commands\n\n● No design doc, no handoff note, fresh repo. Let me run the premise analysis inline and present the implementation\n  alternatives per the skill workflow.\n\n  Ran 1 shell command\n\n● Updated plan\n  ⎿  /plan to preview\n\n● Pre-review analysis done. Plan is well-framed — no premise issues. The question is how the formatter module connects\n  to the download trigger. Per the skill workflow, I need your call on implementation approach before selecting review\n  mode.\n\n● User answered Claude's questions:\n  ⎿  · D1 — How should the CSV formatter connect to the settings export? (0C-bis: Implementation Approach) → A)\n     Client-side only\n\n● Got it — client-side only, no formatter module. Now the mode selection you asked for.\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n ☐ Review mode\n\nD2 — Which review mode do you want for this plan?\n\n❯ 1. SCOPE EXPANSION              ┌──────────────────────────────────────────────────────┐\n  2. SELECTIVE EXPANSION          │ No preview available                                 │\n    (recommended)                 └──────────────────────────────────────────────────────┘\n  3. HOLD SCOPE \n  4. SCOPE REDUCTION              Notes: press n to add notes\n                                                                                \n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  Chat about this\n\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
  "focused": "\n  Read 1 file, ran 1 shell command\n\n● Now let me run the pre-review system audit and check for design docs.\n\n  Ran 4 shell commands\n\n● No design doc, no handoff note, fresh repo. Let me run the premise analysis inline and present the implementation\n  alternatives per the skill workflow.\n\n  Ran 1 shell command\n\n● Updated plan\n  ⎿  /plan to preview\n\n● Pre-review analysis done. Plan is well-framed — no premise issues. The question is how the formatter module connects\n  to the download trigger. Per the skill workflow, I need your call on implementation approach before selecting review\n  mode.\n\n● User answered Claude's questions:\n  ⎿  · D1 — How should the CSV formatter connect to the settings export? (0C-bis: Implementation Approach) → A)\n     Client-side only\n\n● Got it — client-side only, no formatter module. Now the mode selection you asked for.\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n ☐ Review mode\n\nD2 — Which review mode do you want for this plan?\n\n  1. SCOPE EXPANSION              ┌──────────────────────────────────────────────────────┐\n  2. SELECTIVE EXPANSION          │ No preview available                                 │\n    (recommended)                 └──────────────────────────────────────────────────────┘\n❯ 3. HOLD SCOPE \n  4. SCOPE REDUCTION              Notes: press n to add notes\n                                                                                \n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  Chat about this\n\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"
};
const selectShortPreview = (visible = shortPreviewFrame.focused, input: NativeQuestion = shortPreviewFrame.question) =>
  nativeQuestionSelection(input, visible, parseNumberedOptions(visible));

test('short preview panes retain the complete owned option column below their bottom', () => {
  expect(selectShortPreview(shortPreviewFrame.before)).toEqual({ kind: 'preview', focusedIndex: 1 });
  expect(selectShortPreview()).toEqual({ kind: 'preview', focusedIndex: 3 });
  expect(selectShortPreview(shortPreviewFrame.focused.replace('❯ 3.', '  3.').replace('  4.', '❯ 4.')))
    .toEqual({ kind: 'preview', focusedIndex: 4 });
});

test.each([
  ['changed label below pane', shortPreviewFrame.focused.replace('HOLD SCOPE', 'HOLD OTHER')],
  ['duplicate focus', shortPreviewFrame.focused.replace('  4.', '❯ 4.')],
  ['missing focus', shortPreviewFrame.focused.replace('❯ 3.', '  3.')],
  ['gapped index below pane', shortPreviewFrame.focused.replace('❯ 3.', '❯ 4.')],
  ['clipped final label', shortPreviewFrame.focused.replace('SCOPE REDUCTION', 'SCOPE RED')],
  ['missing label continuation', shortPreviewFrame.focused.replace('    (recommended)', ' '.repeat(17))],
  ['right-column decoy', shortPreviewFrame.focused.replace('Notes: press n to add notes', '❯ 4. SCOPE REDUCTION')],
  ['unknown right-column text', shortPreviewFrame.focused.replace('Notes: press n to add notes', 'HOLD SCOPE confirmed')],
  ['broken bottom corner', shortPreviewFrame.focused.replace('└', ' ')],
  ['changed footer', shortPreviewFrame.focused.replace('Enter to select', 'Enter to confirm')],
] as const)('short preview panes refuse incomplete or ambiguous frames: %s', (_name, visible) => {
  expect(selectShortPreview(visible)).toBeNull();
});

test('a short preview pane cannot own a later menu or substitute for native preview inventory', () => {
  const later = shortPreviewFrame.focused + '\n☐ Other question\nD3 — Choose another action?\n❯ 1. First\n  2. Second';
  expect(selectShortPreview(later)).toBeNull();
  const noPreview = { ...shortPreviewFrame.question, options: shortPreviewFrame.question.options.map(({ preview, ...option }) => option) };
  expect(selectShortPreview(shortPreviewFrame.focused, noPreview)).toBeNull();
  expect(() => nativeQuestionSelection(shortPreviewFrame.question, shortPreviewFrame.focused,
    parseNumberedOptions(shortPreviewFrame.focused), [structuredClone(shortPreviewFrame.question)]))
    .toThrow('Indistinguishable repeated native question');
});


function earlyFileCompletion(toolName: 'Write' | 'Edit' = 'Edit') {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Review' } });
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const firstInput = toolName === 'Edit'
    ? { file_path: path.join(config, 'plan.md'), old_string: 'Draft', new_string: 'Decision D9 approved', replace_all: false }
    : { file_path: path.join(config, 'plan.md'), content: 'Decision D9 approved' };
  const response = toolName === 'Edit'
    ? { filePath: firstInput.file_path, oldString: 'Draft', newString: 'Decision D9 approved', originalFile: 'Draft', structuredPatch: [], userModified: false, replaceAll: false }
    : { type: 'create', filePath: firstInput.file_path, content: 'Decision D9 approved', structuredPatch: [], originalFile: null, userModified: false };
  const emit = (hookEvent: string, input: unknown, extra: Record<string, unknown> = {}) => {
    const child = Bun.spawnSync(['bash', '-c', command], { timeout: 5000,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: hookEvent, session_id: sessionId,
        transcript_path: file, cwd: config, tool_name: toolName, tool_input: input, ...extra })), stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.length).toBe(0); expect(child.stderr.length).toBe(0);
  };
  const read = () => readPlanSkillQuestions(config, sessionId, source);
  emit('PermissionRequest', firstInput);
  const first = read().permissionRequests[0]!;
  const dialog = toolName === 'Edit' ? createDialog('plan.md').replace('create', 'make this edit to') : createDialog('plan.md');
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(read(), dialog, granted, requests)).toBe(true);
  const complete = (extra: Record<string, unknown> = {}) => emit('PostToolUse', firstInput,
    { tool_use_id: 'unflushed-file-1', tool_response: response, ...extra });
  const nextInput = toolName === 'Edit' ? { ...firstInput, old_string: 'Decision D9 approved', new_string: 'Decision D9 approved\nSecurity review' }
    : { ...firstInput, content: 'Decision D9 approved\nSecurity review' };
  const nextDialog = toolName === 'Edit' ? dialog : dialog.replace('create', 'overwrite');
  return { source, read, emit, first, firstInput, response, complete, nextInput, nextDialog, granted, requests };
}

test.each(['Write', 'Edit'] as const)('owned PostToolUse completes %s before transcript publication and permits one fresh next grant', toolName => {
  const s = earlyFileCompletion(toolName);
  s.complete();
  expect(fs.readFileSync(file, 'utf8')).not.toContain('unflushed-file-1');
  expect(s.read().permissionRequests[0]).toMatchObject({ requestId: s.first.requestId, result: 'completed', nativeToolId: 'unflushed-file-1', completionEvidence: 'PostToolUse' });
  expect(s.read().calls).toEqual([]); expect(s.read().ready).toBe(false);
  s.emit('PermissionRequest', s.nextInput);
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(true);
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(false);
  expect(s.granted.size).toBe(2);
  // Matching later JSONL is corroboration, not a second completion/grant.
  write(nativeWrite('unflushed-file-1', s.firstInput, config, toolName), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: s.response,
  });
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(false);
});


// A report may be created, overwritten after findings, then overwritten again
// after a later section. These are real owned hook events, not inferred grants.
async function repeatedWriteSequence(variant = 'fresh') {
  const s = earlyFileCompletion('Write'); s.complete();
  s.emit('PermissionRequest', s.nextInput);
  expect(reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toBe(true);
  const second = s.read().permissionRequests.find(item => item.result === 'pending')!;
  const response = { ...s.response, type: 'update', content: s.nextInput.content,
    originalFile: s.firstInput.content };
  if (variant === 'failed-ack') s.emit('PostToolUseFailure', s.nextInput, { tool_use_id: 'unflushed-file-2', error: 'write failed' });
  else if (variant !== 'no-ack') s.emit('PostToolUse', s.nextInput, { tool_use_id: 'unflushed-file-2', tool_response: response });
  await Bun.sleep(5);
  const thirdInput = variant === 'identical-input' ? s.nextInput
    : variant === 'extra-field-only' ? { ...s.nextInput, incidental: true }
    : { ...s.nextInput, content: s.nextInput.content + '\n\n## GSTACK REVIEW REPORT\nCEO review complete.' };
  s.emit('PermissionRequest', thirdInput);
  return { ...s, second, thirdInput };
}

test('owned repeated Write overwrite follows only its prior successful ACK and grants once', async () => {
  const s = await repeatedWriteSequence();
  const native = s.read(), prior = native.permissionRequests.find(item => item.requestId === s.second.requestId)!;
  const current = native.permissionRequests.find(item => item.result === 'pending')!;
  expect(prior).toMatchObject({ result: 'completed', nativeToolId: 'unflushed-file-2', completionEvidence: 'PostToolUse' });
  expect(current.requestId).not.toBe(prior.requestId);
  expect(current.capturedAtMs).toBeGreaterThan(prior.nativeResultAtMs!);
  expect(current.input).toEqual(s.thirdInput);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('unflushed-file-2');
  expect(reserveNativePermissionGrant(native, s.nextDialog, s.granted, s.requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, s.nextDialog, s.granted, s.requests)).toBe(false);
  expect(s.granted.size).toBe(3);
  expect(s.requests.get(`Write:${path.join(config, 'plan.md')}`)?.requestId).toBe(current.requestId);
});

test.each(['no-ack', 'failed-ack', 'identical-input', 'extra-field-only', 'before-ack', 'equal-ack', 'missing-native-id',
  'wrong-cwd', 'wrong-path', 'wrong-tool', 'wrong-frame', 'replayed-request', 'multiple-writers'])
('owned repeated Write overwrite preserves refusal for %s', async variant => {
  const s = await repeatedWriteSequence(variant);
  const before = [...s.granted], requestsBefore = [...s.requests];
  const attempt = () => {
    const native = s.read(), current = native.permissionRequests.find(item => item.result === 'pending' && item.requestId !== s.second.requestId)!;
    const prior = native.permissionRequests.find(item => item.requestId === s.second.requestId)!;
    if (variant === 'before-ack') current.capturedAtMs = prior.nativeResultAtMs! - 1;
    if (variant === 'equal-ack') current.capturedAtMs = prior.nativeResultAtMs!;
    if (variant === 'missing-native-id') delete prior.nativeToolId;
    if (variant === 'wrong-cwd') current.cwd = path.dirname(config);
    if (variant === 'wrong-path') current.input.file_path = path.join(config, 'sibling.md');
    if (variant === 'wrong-tool') current.name = 'Edit';
    if (variant === 'replayed-request') current.requestId = s.second.requestId;
    if (variant === 'multiple-writers') native.permissionRequests.push({ ...current, requestId: 'other-writer' });
    const dialog = variant === 'wrong-frame' ? s.nextDialog.replace('overwrite', 'create') : s.nextDialog;
    if (variant === 'replayed-request') expect(reserveNativePermissionGrant(native, dialog, s.granted, s.requests)).toBe(false);
    else expect(() => reserveNativePermissionGrant(native, dialog, s.granted, s.requests)).toThrow();
  };
  // Duplicate input or a failed native hook is rejected before reservation.
  if (variant === 'identical-input' || variant === 'failed-ack') expect(attempt).toThrow();
  else attempt();
  expect([...s.granted]).toEqual(before); expect([...s.requests]).toEqual(requestsBefore);
});

test.each(['missing', 'foreign-session', 'subagent', 'failure', 'malformed-response', 'wrong-response-path', 'changed-input', 'duplicate-request', 'duplicate-completion-id', 'late-completion'])
('owned PostToolUse cannot retire an unproven request (%s)', variant => {
  const s = earlyFileCompletion();
  if (variant === 'duplicate-request') s.emit('PermissionRequest', s.firstInput);
  if (variant === 'late-completion') s.emit('PermissionRequest', s.nextInput);
  if (variant === 'failure') s.emit('PostToolUseFailure', s.firstInput, { tool_use_id: 'unflushed-file-1', error: 'Failed to write' });
  else if (variant !== 'missing') s.complete(
    variant === 'foreign-session' ? { session_id: '00000000-0000-4000-8000-000000000002' }
      : variant === 'subagent' ? { agent_id: 'other-worker' }
      : variant === 'malformed-response' ? { tool_response: { success: true } }
      : variant === 'wrong-response-path' ? { tool_response: { ...s.response, filePath: '/wrong/plan.md' } }
      : variant === 'changed-input' ? { tool_input: { ...s.firstInput, new_string: 'Not the requested edit' } } : {});
  if (variant === 'duplicate-completion-id') s.complete({ tool_use_id: 'second-completion-for-one-request' });
  if (variant !== 'late-completion') s.emit('PermissionRequest', s.nextInput);
  expect(() => reserveNativePermissionGrant(s.read(), s.nextDialog, s.granted, s.requests)).toThrow();
  expect(s.granted.size).toBe(1);
});

test.each(['name', 'input', 'cwd', 'unfinished-input', 'error', 'raw-response'])
('owned PostToolUse refuses later native contradiction (%s)', variant => {
  const s = earlyFileCompletion(); s.complete();
  expect(s.read().permissionRequests[0].result).toBe('completed');
  const input = variant.includes('input') ? { ...s.firstInput, new_string: 'Conflicting native edit' } : s.firstInput;
  write(nativeWrite('unflushed-file-1', input, variant === 'cwd' ? path.dirname(config) : config,
    variant === 'name' ? 'Write' : 'Edit', variant === 'unfinished-input' ? null : 'tool_use'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString(), variant === 'error'),
    toolUseResult: variant === 'raw-response' ? { ...s.response, newString: 'Different completed edit' } : s.response,
  });
  expect(s.read).toThrow(/changed input|conflicts with/);
  expect(s.granted.size).toBe(1);
});

test('a duplicate success callback cannot replace its first immutable completion', () => {
  const s = earlyFileCompletion(); s.complete();
  expect(s.read().permissionRequests[0].result).toBe('completed');
  s.complete({ tool_response: { ...s.response, newString: 'A different response' } });
  expect(s.read).toThrow('capture failed');
});

test('unrequested successful file work carries no permission, AUQ or completion-modal authority', () => {
  const s = earlyFileCompletion();
  const other = { ...s.firstInput, file_path: path.join(config, 'auto-allowed.md') };
  s.emit('PostToolUse', other, { tool_use_id: 'auto-allowed', tool_response: { ...s.response, filePath: other.file_path } });
  const native = s.read();
  expect(native.permissionRequests[0].result).toBe('pending');
  expect(native.permissionTools).toEqual([]); expect(native.permissionResults).toEqual([]);
  expect(native.calls).toEqual([]); expect(native.ready).toBe(false);
});

test('native storage may clear large Edit originalFile bytes but no other completion fields', () => {
  const s = earlyFileCompletion(); s.complete();
  write(nativeWrite('unflushed-file-1', s.firstInput, config, 'Edit'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: { ...s.response, originalFile: '' },
  });
  expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
});


test.each(['preserved', 'clearable', 'cleared-mismatch'])('Write update storage preserves the exact native clearing condition (%s)', variant => {
  const s = earlyFileCompletion('Write');
  const response = { ...s.response, type: 'update', originalFile: variant === 'clearable' ? 'Previous plan' : null, structuredPatch: [] };
  s.complete({ tool_response: response });
  const stored = variant === 'preserved' ? response : { ...response, content: '', originalFile: null };
  write(nativeWrite('unflushed-file-1', s.firstInput), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: stored,
  });
  if (variant === 'cleared-mismatch') expect(s.read).toThrow('conflicts with its later result');
  else expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
});

test.each([
  ['small', 'Draft', false],
  ['10000 units', 'a'.repeat(10_000), false],
  ['10001 units', 'a'.repeat(10_001), true],
  ['10000 UTF16 units despite more UTF8 bytes', '😀'.repeat(5_000), false],
  ['10001 UTF16 units', '😀'.repeat(5_000) + 'x', true],
  ['already cleared', '', false],
] as const)('native append storage nulls Edit originalFile only above its exact bound (%s)', (_name, originalFile, accepted) => {
  const s = earlyFileCompletion();
  const response = { ...s.response, originalFile };
  s.complete({ tool_response: response });
  expect(s.read().permissionRequests[0].result).toBe('completed');
  write(nativeWrite('unflushed-file-1', s.firstInput, config, 'Edit'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()),
    toolUseResult: { ...response, originalFile: null },
  });
  if (accepted) expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
  else expect(s.read).toThrow('conflicts with its later result');
  expect(s.granted.size).toBe(1);
});

test.each(['raw', 'tool-specific-stored', 'append-raw', 'append-stored'] as const)
('native append storage composes with exact Write storage (%s)', variant => {
  const s = earlyFileCompletion('Write');
  const response = { ...s.response, type: 'update', originalFile: 'a'.repeat(10_001) };
  s.complete({ tool_response: response });
  const stored = variant === 'tool-specific-stored' || variant === 'append-stored'
    ? { ...response, content: '', originalFile: null }
    : variant === 'append-raw' ? { ...response, originalFile: null } : response;
  write(nativeWrite('unflushed-file-1', s.firstInput), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString()), toolUseResult: stored,
  });
  expect(s.read().permissionRequests[0]).toMatchObject({ result: 'completed', completionEvidence: 'PostToolUse' });
});

test.each(['changed-field', 'missing-field', 'extra-field', 'error'] as const)
('native append storage preserves every other result conflict (%s)', variant => {
  const s = earlyFileCompletion();
  const response = { ...s.response, originalFile: 'a'.repeat(10_001) };
  s.complete({ tool_response: response });
  const stored: Record<string, unknown> = { ...response, originalFile: null };
  if (variant === 'changed-field') stored.newString = 'Different completed edit';
  if (variant === 'missing-field') delete stored.originalFile;
  if (variant === 'extra-field') stored.unexplained = true;
  write(nativeWrite('unflushed-file-1', s.firstInput, config, 'Edit'), {
    ...nativeWriteResult('unflushed-file-1', new Date().toISOString(), variant === 'error'), toolUseResult: stored,
  });
  expect(s.read).toThrow('conflicts with its later result');
  expect(s.granted.size).toBe(1);
});

// Native Design counting failure, Claude 2.1.263: a 105-line wireframe scrolls
// its title/subtitle off screen. The current basename and complete directory
// in option 2 still identify the one-time option 1 permission exactly.
const clippedDesignFrame = "   76       <div class=\"field invalid\">\n   77         <label for=\"email\">Email</label>                                                                                                         1 file changed                                                                         ✕\n   78         <input id=\"email\" value=\"margarethe@acme\" aria-invalid=\"true\" aria-describedby=\"email-err\">\n   79         <div class=\"error\" id=\"email-err\" role=\"alert\"><span aria-hidden=\"true\">!</span><span>Enter a full email address, like name@company.c    gstack-test-plan-design.md\n      om.</span></div>\n   80       </div>                                                                                                                                     ────────────────────────────────────────────────────────────────────────────────────────\n   81     </section>                                                                                                                                   gstack-test-plan-design.md (untracked)\n   82    C       t   u                                                                                                                                 ────────────────────────────────────────────────────────────────────────────────────────\n   83    P<section id=\"notifications\" aria-labelledby=\"h-notif\">                                                                                       New file not yet staged.\n   84    L  <h2 id=\"h-notif\">Notifications</h2>                                                                                                        Run `git add :/gstack-test-plan-design.md` to see line counts.\n   85       <div class=\"field\">\n   86    F    <label for=\"digest\">Weekly digest email</label>\n   87    C    <input id=\"digest\" value=\"Every Monday, 9:00\"> \n   88    C    <div class=\"help\">Sent in your account timezone.</div>\n   89       </div>\n   90    T</secsion>\n   91  \n   92     <section id=\"api-keys\" aria-labelledby=\"h-keys\">\n   93    P  <h2 id=\"h-keys\">API keys</h2> \n   94       <div class=\"empty\">\n   95         <p>No keys yet. Keys let scripts and integrations act on your behalf.</p>\n   96         <button class=\"btn\">Create your first key</button>\n   97       </div>\n   98     </section>\n   99\n  100     <div class=\"note\">Wireframe only. Designer mockup generation was unavailable (no OpenAI key). Toast below shows the post-save success sta\n      te.</div>\n  101   </main>\n  102 </div>\n  103 <div class=\"toast\" role=\"status\">Saved. Changes are live.</div>\n  104 </body>\n  105 </html>\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to create wireframe-desktop.html?\n ❯ 1. Yes \n   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session; Yes, and always allow access to\n      /home/vercel-sandbox/.gstack/projects/gstack-e2e-plan-design-16ewXN/designs/settings-page-20260910 for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend";
const clippedDesignOwner = {"id": "toolu_01VQSgtivSuKpKci3w9RXzbn", "name": "Write", "cwd": "/tmp/gstack-paid-shard-klXxAu/tmp/gstack-e2e-plan-design-16ewXN", "input": {"file_path": "/home/vercel-sandbox/.gstack/projects/gstack-e2e-plan-design-16ewXN/designs/settings-page-20260910/wireframe-desktop.html"}};
test('clipped native create header binds its fully displayed parent and grants only once', () => {
  const filePath = clippedDesignOwner.input.file_path;
  expect(currentFilePermissionTarget(clippedDesignFrame)).toEqual({ operation: 'create', filePath });
  expect(nativePermissionKey(clippedDesignOwner, clippedDesignFrame)).toBe('Write:' + filePath);
  const native = { permissionTools: [clippedDesignOwner], permissionResults: [], permissionRequestCapture: true,
    permissionRequests: [{ requestId: 'owned-clipped-request', capturedAtMs: 1, name: 'Write' as const,
      input: clippedDesignOwner.input, cwd: clippedDesignOwner.cwd, result: 'pending' as const, nativeToolId: clippedDesignOwner.id }] };
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(reserveNativePermissionGrant(native, clippedDesignFrame, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(native, clippedDesignFrame, granted, requests)).toBe(false);
  expect([...granted]).toEqual(['request:owned-clipped-request']);
  expect([...requests.keys()]).toEqual(['Write:' + filePath]);
});
test('clipped create permission refuses another basename, parent, malformed directory, or conflicting header', () => {
  const filePath = clippedDesignOwner.input.file_path, directory = path.dirname(filePath);
  for (const invalid of [
    clippedDesignFrame.replace('Do you want to create wireframe-desktop.html?', 'Do you want to create other.html?'),
    clippedDesignFrame.replace(directory, directory + '-sibling'),
    clippedDesignFrame.replace(directory, path.dirname(directory)),
    clippedDesignFrame.replace(directory, directory.replace('/designs/', '/desi…/')),
    clippedDesignFrame.replace(directory, directory.replace('/designs/', '/desi\n      gns/')),
    clippedDesignFrame.replace(directory, 'relative/designs'),
    clippedDesignFrame.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes,', ' ❯ 2. Yes,'),
    ' Create file\n another/wireframe-desktop.html\n' + clippedDesignFrame,
    '─'.repeat(240) + '\n Create file\n another/wireframe-desktop.html\n' + clippedDesignFrame,
    '─'.repeat(240) + '\n Create file\n ' + filePath + '\n Create file\n ' + filePath + '\n' + clippedDesignFrame,
  ]) expect(() => nativePermissionKey(clippedDesignOwner, invalid)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...clippedDesignOwner, input: { file_path: filePath + '.other' } }, clippedDesignFrame)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...clippedDesignOwner, name: 'Edit' }, clippedDesignFrame)).toThrow('cannot be bound');
});


// The execution hook contains CLI-validated nested objects; the raw transcript
// can retain undeclared model keys that never reach the permission component.
for (const stopReason of [null, 'tool_use']) {
  test(`owned question execution strips only corroborated nested schema extras (${stopReason})`, () => {
    const native = call('schema-extra', [JSON.parse(JSON.stringify(question))]);
    native.message.stop_reason = stopReason as any;
    (native.message.content[0].input.questions[0] as any).multiSelar = false;
    (native.message.content[0].input.questions[0].options[0] as any).undeclaredPreview = 'not displayed';
    write(native);
    const early = earlyQuestions(); early.emit('schema-extra');
    const pending = readPlanSkillQuestions(config, sessionId, early.source);
    expect(pending.calls).toEqual([{ id: 'schema-extra', questions: [question], result: 'pending' }]);
    fs.appendFileSync(file, JSON.stringify(nativeWriteResult('schema-extra')) + '\n');
    expect(readPlanSkillQuestions(config, sessionId, early.source).calls).toEqual([
      { id: 'schema-extra', questions: [question], result: 'answered' },
    ]);
    expect(pending.permissionRequests).toEqual([]); expect(pending.permissionTools).toEqual([]);
  });
}

test('a raw duplicate question cannot erase nested changes without an owned execution hook', () => {
  const modified = call('raw-extra', [JSON.parse(JSON.stringify(question))]);
  (modified.message.content[0].input.questions[0] as any).multiSelar = false;
  write(call('raw-extra', [JSON.parse(JSON.stringify(question))]), modified);
  expect(() => readPlanSkillQuestions(config, sessionId)).toThrow('changed input');
});

test.each(['question', 'header', 'multiSelect', 'label', 'description', 'preview', 'kind', 'metadata', 'top-extra'])
('owned nested schema equivalence preserves changed %s refusal', field => {
  const native = call('schema-conflict', [JSON.parse(JSON.stringify(question))]);
  const input: any = native.message.content[0].input;
  input.questions[0].multiSelar = false;
  if (field === 'question' || field === 'header') input.questions[0][field] = 'different';
  else if (field === 'multiSelect') input.questions[0].multiSelect = 'false';
  else if (field === 'label' || field === 'description') input.questions[0].options[0][field] = 'different';
  else if (field === 'preview') input.questions[0].options[0].preview = null;
  else if (field === 'kind') input.questions[0].kind = 'text';
  else input[field] = { changed: true };
  write(native); const early = earlyQuestions(); early.emit('schema-conflict');
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('changed input');
});

test('changed execution hooks cannot use the transcript-only schema projection', () => {
  write(); const early = earlyQuestions(); early.emit('hook-conflict');
  early.emit('hook-conflict', { questions: [{ ...question, multiSelar: false }] });
  expect(() => readPlanSkillQuestions(config, sessionId, early.source)).toThrow('Native question event capture failed');
});

function bashHooks() {
  write({ type: 'user', sessionId, message: { role: 'user', content: 'Review' } });
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const input = { command: 'printf %s ready > probe.txt', description: 'Write the owned marker' };
  const response = { stdout: 'ready', stderr: '', interrupted: false };
  const emit = (event: string, id = 'bash-1', toolInput: unknown = input, extra: Record<string, unknown> = {}) => {
    const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
      hook_event_name: event, session_id: sessionId, transcript_path: file, cwd: config,
      tool_name: 'Bash', tool_use_id: id, tool_input: toolInput, ...extra,
    })), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0);
  };
  const read = () => readPlanSkillQuestions(config, sessionId, source);
  const post = (output: unknown = response, extra: Record<string, unknown> = {}) => emit('PostToolUse', 'bash-1', input, { tool_response: output, ...extra });
  return { source, input, response, emit, post, read };
}

test('captured directory Bash permission fixture selects every existing permission-helper consumer', () => {
  const selected = selectTests(['test/fixtures/bash-directory-permission.json'], E2E_TOUCHFILES);
  expect(selected.reason).toBe('diff');
  expect(selected.selected.sort()).toEqual(selectTests(['test/helpers/plan-skill-questions.ts'], E2E_TOUCHFILES).selected.sort());
});

test('captured directory Bash card requires its exact owned request and permits only one grant', () => {
  const { input, card, nativeId } = retainedBashDirectory;
  const s = bashHooks(); s.emit('PreToolUse', nativeId, input);
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  // Legacy callers have no native binding. Only the bound driver opts in.
  expect(isPermissionDialogVisible(card)).toBe(false);
  expect(isPermissionDialogVisible(card, true)).toBe(true);
  expect(nativePermissionKey({ id: nativeId, name: 'Bash', input }, card)).toBe('Bash:' + input.command);
  expect(reserveNativePermissionGrant(s.read(), card, granted, requests)).toBe(false);
  s.emit('PermissionRequest', nativeId, input);
  expect(reserveNativePermissionGrant(s.read(), card, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(s.read(), card, granted, requests)).toBe(false);
  expect([...granted]).toEqual([nativeId]);
  s.emit('PostToolUse', nativeId, input, { tool_response: s.response });
  expect(s.read().permissionResults).toEqual([{ id: nativeId, result: 'completed' }]);
  expect(s.read().permissionTools).toEqual([]);
  s.emit('PreToolUse', 'next', input); s.emit('PermissionRequest', 'next', input);
  expect(() => reserveNativePermissionGrant(s.read(), card, granted, requests)).toThrow('stale rendering');
});

const damagedDirectoryBashCards = {
  missingPath: retainedBashDirectory.card.replace(' and /home/vercel-sandbox/.gstack from this project', ' and from this project'),
  relativePath: retainedBashDirectory.card.replace(' and /home/vercel-sandbox/.gstack', ' and ../.gstack'),
  ellipsis: retainedBashDirectory.card.replace(' and /home/vercel-sandbox/.gstack', ' and /home/…/.gstack'),
  trailingPermission: retainedBashDirectory.card.replace(' from this project', ' from this project and allow all commands'),
  wrappedPath: retainedBashDirectory.card.replace(' and /home/vercel-sandbox/.gstack', '\n      and /home/vercel-sandbox/.gstack'),
  appendedContinuation: retainedBashDirectory.card.replace(' from this project', ' from this project\n      Always allow all commands'),
  wrongFocus: retainedBashDirectory.card.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes', ' ❯ 2. Yes'),
  missingNo: retainedBashDirectory.card.replace('   3. No\n', ''),
  history: retainedBashDirectory.card + '\n❯ New unrelated draft',
};
test.each(Object.entries(damagedDirectoryBashCards))('captured directory Bash card refuses %s controls', (_name, card) => {
  expect(isPermissionDialogVisible(card, true)).toBe(false);
  expect(() => nativePermissionKey({ id: 'captured', name: 'Bash', input: retainedBashDirectory.input }, card)).toThrow('cannot be bound');
});

test.each(['command', 'cwd'])('captured directory Bash request cannot change native %s authority', variant => {
  const s = bashHooks(); const { input, card, nativeId } = retainedBashDirectory;
  s.emit('PreToolUse', nativeId, input);
  s.emit('PermissionRequest', nativeId, variant === 'command' ? { ...input, command: input.command + '\nprintf changed' } : input,
    variant === 'cwd' ? { cwd: '/different-owner' } : {});
  const granted = new Set<string>();
  if (variant === 'cwd') expect(() => s.read()).toThrow();
  else expect(reserveNativePermissionGrant(s.read(), card, granted, new Map())).toBe(false);
  expect([...granted]).toEqual([]);
});

test('owned Bash hooks authorize one exact current command and retire it before transcript persistence', () => {
  const s = bashHooks(); s.emit('PreToolUse');
  const frame = nativeBashDialog(s.input.command, s.input.description);
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  expect(s.read().permissionTools).toEqual([{ id: 'bash-1', name: 'Bash', input: s.input, cwd: config, bashPermissionRequestId: null }]);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(false);
  s.emit('PermissionRequest');
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(false);
  s.post();
  expect(s.read().permissionTools).toEqual([]);
  expect(s.read().permissionResults).toEqual([{ id: 'bash-1', result: 'completed' }]);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('bash-1');
  const next = { ...s.input, command: 'printf %s next > next.txt' };
  s.emit('PreToolUse', 'bash-2', next); s.emit('PermissionRequest', 'ignored-native-id', next);
  expect(reserveNativePermissionGrant(s.read(), nativeBashDialog(next.command, next.description), granted, requests)).toBe(true);
  expect([...granted]).toEqual(['bash-1', 'bash-2']);
  expect(s.read().calls).toEqual([]); expect(s.read().ready).toBe(false); expect(s.read().permissionRequests).toEqual([]);
});

test.each(['foreign', 'sidechain', 'orphan', 'screen-only'] as const)('owned Bash hooks do not invent invocation authority (%s)', variant => {
  const s = bashHooks();
  if (variant !== 'orphan' && variant !== 'screen-only') s.emit('PreToolUse', 'bash-1', s.input,
    variant === 'foreign' ? { session_id: '00000000-0000-4000-8000-000000000099' } : { agent_id: 'sidechain' });
  if (variant === 'orphan') s.post();
  expect(s.read().permissionTools).toEqual([]); expect(s.read().permissionResults).toEqual([]);
  expect(reserveNativePermissionGrant(s.read(), nativeBashDialog(s.input.command, s.input.description), new Set(), new Map())).toBe(false);
});

test.each(['command', 'description', 'cwd', 'name', 'unfinished'] as const)('owned Bash hooks reject later invocation conflict (%s)', variant => {
  const s = bashHooks(); s.emit('PreToolUse');
  write(nativeWrite('bash-1', variant === 'command' || variant === 'description' ? { ...s.input, [variant]: 'changed' } : s.input,
    variant === 'cwd' ? path.dirname(config) : config, variant === 'name' ? 'Write' : 'Bash', variant === 'unfinished' ? null : 'tool_use'));
  if (variant === 'unfinished') {
    expect(s.read().permissionTools[0]?.id).toBe('bash-1');
    write(nativeWrite('bash-1', { ...s.input, command: 'changed' }, config, 'Bash', null));
  }
  expect(() => s.read()).toThrow('Native tool changed');
});

test.each(['changed-input', 'wrong-cwd', 'malformed', 'error-envelope', 'two-completions'] as const)
('owned Bash hooks refuse invalid or conflicting completion (%s)', variant => {
  const s = bashHooks(); s.emit('PreToolUse');
  if (variant === 'changed-input') s.emit('PostToolUse', 'bash-1', { ...s.input, command: 'changed' }, { tool_response: s.response });
  else if (variant === 'two-completions') {
    s.post(); s.emit('PostToolUseFailure', 'bash-1', s.input, { error: 'Command failed', is_interrupt: false });
  } else s.post(variant === 'malformed' ? { ...s.response, interrupted: 'false' } : s.response,
    variant === 'wrong-cwd' ? { cwd: path.dirname(config) } : variant === 'error-envelope' ? { error: 'Failed' } : {});
  expect(() => s.read()).toThrow(variant === 'changed-input' ? 'Native Bash completion changed'
    : variant === 'two-completions' ? 'Conflicting native Bash completion' : 'Native question event capture failed');
});

test.each(['native-failure', 'interrupt-post', 'interrupt-failure'] as const)('owned Bash hooks preserve failed invocation status (%s)', variant => {
  const s = bashHooks(); s.emit('PreToolUse');
  const grants = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  const frame = nativeBashDialog(s.input.command, s.input.description);
  s.emit('PermissionRequest');
  expect(reserveNativePermissionGrant(s.read(), frame, grants, requests)).toBe(true);
  if (variant === 'interrupt-post') s.post({ ...s.response, interrupted: true });
  else s.emit('PostToolUseFailure', 'bash-1', s.input, { error: 'Command failed with exit code 1', is_interrupt: variant === 'interrupt-failure' });
  expect(s.read().permissionResults).toEqual([{ id: 'bash-1', result: 'error' }]);
  expect(s.read().permissionTools).toEqual([]);
  s.emit('PreToolUse', 'bash-2'); s.emit('PermissionRequest');
  expect(() => reserveNativePermissionGrant(s.read(), frame, grants, requests)).toThrow();
});

test.each(['background', 'semantic-nonzero', 'stored-output', 'identical-repeat'] as const)
('owned Bash hooks retain native invocation semantics (%s)', variant => {
  const s = bashHooks(); s.emit('PreToolUse');
  const response = variant === 'background' ? { ...s.response, stdout: '', backgroundTaskId: 'task-1',
    backgroundedByUser: true, timedOutAfterMs: 3000 } : variant === 'semantic-nonzero'
      ? { ...s.response, stdout: '', returnCodeInterpretation: 'No matches found' } : s.response;
  s.post(response); const first = s.read();
  expect(first.permissionResults).toEqual([{ id: 'bash-1', result: 'completed' }]);
  if (variant === 'identical-repeat') { s.emit('PreToolUse'); s.post(response); expect(s.read()).toEqual(first); }
  write(nativeWrite('bash-1', s.input, config, 'Bash'), { type: 'user', sessionId,
    toolUseResult: variant === 'stored-output' ? { ...response, stdout: '', stderr: '' } : response,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'native formatted output', is_error: false }] } });
  expect(s.read().permissionResults).toEqual(first.permissionResults);
});

test.each(['error', 'raw-output', 'success-after-failure', 'failure-text'] as const)
('owned Bash hooks refuse contradictory persisted results (%s)', variant => {
  const s = bashHooks(); s.emit('PreToolUse');
  const failure = variant === 'success-after-failure' || variant === 'failure-text';
  if (failure) s.emit('PostToolUseFailure', 'bash-1', s.input, { error: 'Native failure', is_interrupt: false }); else s.post();
  write(nativeWrite('bash-1', s.input, config, 'Bash'), { type: 'user', sessionId,
    ...(!failure ? { toolUseResult: variant === 'raw-output' ? { ...s.response, interrupted: true } : s.response } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1',
      content: variant === 'failure-text' ? 'Different error' : failure ? 'Native failure' : 'ready',
      is_error: variant === 'error' || variant === 'failure-text' }] } });
  expect(() => s.read()).toThrow('Native Bash completion conflicts');
});



test.each(['changed-command', 'changed-description', 'changed-option', 'orphan', 'duplicate-request', 'ambiguous-invocations'] as const)
('owned Bash hooks require one effective post-Pre permission input (%s)', variant => {
  const s = bashHooks();
  if (variant !== 'orphan') s.emit('PreToolUse');
  if (variant === 'ambiguous-invocations') s.emit('PreToolUse', 'bash-2');
  const effective = variant === 'changed-command' ? { ...s.input, command: 'changed' }
    : variant === 'changed-description' ? { ...s.input, description: 'Changed' }
    : variant === 'changed-option' ? { ...s.input, dangerouslyDisableSandbox: true } : s.input;
  s.emit('PermissionRequest', 'not-a-native-owner', effective);
  if (variant === 'duplicate-request') s.emit('PermissionRequest', 'also-not-a-native-owner', effective);
  if (variant === 'duplicate-request' || variant === 'ambiguous-invocations') expect(() => s.read()).toThrow('native Bash permission request');
  else expect(reserveNativePermissionGrant(s.read(), nativeBashDialog(s.input.command, s.input.description), new Set(), new Map())).toBe(false);
});

test('owned Bash hooks retain harmless Pre safety settings and require final permission pairing', () => {
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] },
  ] } }));
  const s = bashHooks(); s.emit('PreToolUse'); s.emit('PermissionRequest');
  expect(reserveNativePermissionGrant(s.read(), nativeBashDialog(s.input.command, s.input.description), new Set(), new Map())).toBe(true);
});


test('native Bash projection preserves literal U+2026 without widening to complex Unicode', () => {
  const command = 'printf "Saving…"';
  const tool = { id: 'ellipsis', name: 'Bash', input: { command, description: 'Print Saving…' } };
  expect(nativePermissionKey(tool, nativeBashDialog(command, tool.input.description))).toBe('Bash:' + command);
  for (const foreign of ['\u200b', '\u202e', '好', '👩‍💻']) {
    const input = { command: command.replace('…', foreign), description: tool.input.description };
    expect(() => nativePermissionKey({ ...tool, input }, nativeBashDialog(input.command, input.description))).toThrow('cannot be bound');
  }
});


test('clipped Bash suffix only requests repaint and never supplies grant authority', () => {
  const input = { command: 'printf first\nprintf "Saving…"\nprintf third', description: 'Write owned status' };
  const tool = { id: 'clipped', name: 'Bash', cwd: '/owned', input };
  const visible = '   │ printf "Saving…"\n   │ printf third\n   Write owned status'
    + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
  expect(matchesClippedBashPermission(tool, visible, 240)).toBe(true);
  expect(() => nativePermissionKey(tool, visible)).toThrow('cannot be bound');
  for (const changed of [visible.replace('printf third', 'printf other'), visible.replace('owned status', 'foreign status'),
    visible.replace(' ❯ 1. Yes', '   1. Yes'), ' Bash command\n' + visible, ' Create file\n' + visible,
    visible + '\n❯ A new prompt', '```\n' + visible]) expect(matchesClippedBashPermission(tool, changed, 240)).toBe(false);
  expect(matchesClippedBashPermission({ ...tool, bashPermissionRequestId: null }, visible, 240)).toBe(false);
  expect(matchesClippedBashPermission({ ...tool, name: 'Read' }, visible, 240)).toBe(false);
});

test('pinned Bash soft continuations elide one separator but preserve hard-line indentation', () => {
  // Eg wraps each original physical line separately and elides exactly one
  // leading ASCII space on a nonempty soft continuation. These expected rows
  // are literal renderer output, not generated by the matcher under test.
  const head = 'x'.repeat(112);
  const detail = 'd'.repeat(112);
  const input = { command: head + '  tail\n  hard-indent', description: detail + '  description-tail' };
  const tool = { id: 'soft-boundary', name: 'Bash', input };
  const frame = '─'.repeat(120) + '\n Bash command\n\n'
    + '   │ ' + head + '\n   │  tail\n   │   hard-indent\n'
    + '   │ ' + detail + '\n   │  description-tail'
    + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
  expect(nativePermissionKey(tool, frame)).toBe('Bash:' + input.command);
  for (const changed of [frame.replace('   │  tail', '   │ tail'),
    frame.replace('   │   hard-indent', '   │  hard-indent'),
    frame.replace('   │  description-tail', '   │ description-tail')]) {
    expect(() => nativePermissionKey(tool, changed)).toThrow('cannot be bound');
  }
  expect(() => nativePermissionKey({ ...tool, input: { ...input, command: input.command.replace('\n  hard', '\n hard') } }, frame)).toThrow('cannot be bound');
});

test('pinned Bash header-only clipping requests a repaint while the full payload cannot grant', () => {
  const input = { command: 'printf first\nprintf second', description: 'Write owned status' };
  const tool = { id: 'header-clipped', name: 'Bash', cwd: '/owned', input };
  const visible = '   │ printf first\n   │ printf second\n   Write owned status'
    + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
  expect(matchesClippedBashPermission(tool, visible, 240)).toBe(true);
  expect(() => nativePermissionKey(tool, visible)).toThrow('cannot be bound');
  for (const changed of ['   │ printf foreign\n' + visible, visible.replace('printf first', 'printf other'),
    visible.replace(' Esc to cancel · Tab to amend', ' Esc to cancel'), visible + '\n❯ New prompt']) {
    expect(matchesClippedBashPermission(tool, changed, 240)).toBe(false);
  }
  expect(matchesClippedBashPermission({ ...tool, bashPermissionRequestId: null }, visible, 240)).toBe(false);
});


// The native CLI can persist several queued Edits with stop_reason:null while
// its PermissionRequest hook names exactly one of their complete inputs.
function queuedEditRequests() {
  write();
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const emit = (input: unknown) => {
    const prior = new Set(readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file }).map(event => event.requestId));
    const child = Bun.spawnSync(['bash', '-c', command], { timeout: 5000,
      stdin: Buffer.from(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: sessionId,
        transcript_path: file, cwd: config, tool_name: 'Edit', tool_input: input })), stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return readPermissionRequestEvents(source, { configDir: config, sessionId, transcriptFile: file }).find(event => !prior.has(event.requestId))!;
  };
  const first = { file_path: path.join(config, 'plan.md'), old_string: 'Task 1', new_string: 'Task 1 approved', replace_all: false };
  const second = { ...first, old_string: 'Task 2', new_string: 'Task 2 approved' };
  const read = () => readPlanSkillQuestions(config, sessionId, source);
  const dialog = createDialog('plan.md').replace('create', 'make this edit to');
  return { source, emit, first, second, read, dialog };
}

test('queued unfinished Edits keep distinct IDs and only the exact owned request can receive a grant', async () => {
  const s = queuedEditRequests();
  const firstRow = nativeWrite('queued-first', s.first, config, 'Edit', null);
  const secondRow = nativeWrite('queued-second', s.second, config, 'Edit', null);
  write(firstRow, secondRow);
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  const unobserved = readPlanSkillQuestions(config, sessionId);
  expect(unobserved.permissionTools).toEqual([]);
  expect(reserveNativePermissionGrant(unobserved, s.dialog, granted, requests)).toBe(false);
  const firstEvent = s.emit(s.first);
  const first = s.read();
  expect(first.permissionTools).toEqual([]);
  expect(first.permissionRequests).toEqual([expect.objectContaining({ requestId: firstEvent.requestId, input: s.first, result: 'pending' })]);
  expect(first.permissionRequests[0].nativeToolId).toBeUndefined();
  expect(reserveNativePermissionGrant(first, s.dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(first, s.dialog, granted, requests)).toBe(false);
  expect(granted).toEqual(new Set([`request:${firstEvent.requestId}`]));
  const resultAt = firstEvent.capturedAtMs + 1;
  write(firstRow, secondRow, nativeWriteResult('queued-first', new Date(resultAt).toISOString()));
  await Bun.sleep(5);
  const secondEvent = s.emit(s.second);
  const second = s.read();
  expect(second.permissionRequests.find(event => event.requestId === firstEvent.requestId)).toMatchObject({ result: 'completed', nativeToolId: 'queued-first', nativeResultAtMs: resultAt });
  expect(second.permissionTools).toEqual([]);
  expect(secondEvent.capturedAtMs).toBeGreaterThan(resultAt);
  expect(reserveNativePermissionGrant(second, s.dialog, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(second, s.dialog, granted, requests)).toBe(false);
  expect(granted).toEqual(new Set([`request:${firstEvent.requestId}`, `request:${secondEvent.requestId}`]));
});

test.each(['no-exact-input', 'same-id-input', 'same-id-path', 'same-id-cwd', 'same-id-name', 'same-id-bash', 'duplicate-exact-ids', 'finalized-owner', 'second-request'])
('queued unfinished Edit preserves refusal for %s', variant => {
  const s = queuedEditRequests();
  const first = nativeWrite('queued-first', s.first, config, 'Edit', null);
  let second = nativeWrite('queued-second', s.second, config, 'Edit', null);
  if (variant.startsWith('same-id-')) {
    second = nativeWrite('queued-first', variant === 'same-id-path' ? { ...s.first, file_path: path.join(config, 'other.md') }
      : variant === 'same-id-input' ? s.second : s.first, variant === 'same-id-cwd' ? path.dirname(config) : config,
      variant === 'same-id-name' ? 'Write' : variant === 'same-id-bash' ? 'Bash' : 'Edit', null);
  }
  if (variant === 'duplicate-exact-ids') second = nativeWrite('queued-second', s.first, config, 'Edit', null);
  if (variant === 'finalized-owner') second = nativeWrite('queued-second', s.second, config, 'Edit');
  write(...(variant === 'no-exact-input' ? [second] : [first, second]));
  s.emit(s.first);
  if (variant === 'second-request') s.emit(s.second);
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  expect(() => reserveNativePermissionGrant(s.read(), s.dialog, granted, requests)).toThrow();
  expect(granted.size).toBe(0); expect(requests.size).toBe(0);
});


// Qualified V6 Design hook input (command da782e62), used ONLY as data. This
// source-derived renderer control is not a captured V6 terminal frame, and no
// tool command is executed. Existing Bash ownership/completion controls remain.
const retainedDesignEmDashInput = {"command": "cd /tmp/gstack-paid-shard-eIwOQS/tmp/gstack-e2e-plan-design-qQyLqj\neval \"$(/tmp/gstack-paid-shard-eIwOQS/tmp/gstack-hermetic-1019314-1e844d/with-skills/runtime/bin/gstack-slug 2>/dev/null)\"\nTASKS_DIR=\"${HOME}/.gstack/projects/${SLUG:-unknown}\"\nmkdir -p \"$TASKS_DIR\"\nTASKS_FILE=\"$TASKS_DIR/tasks-design-review-$(date +%Y%m%d-%H%M%S).jsonl\"\nCOMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)\nBRANCH=$(git branch --show-current 2>/dev/null || echo unknown)\nRUN_ID=\"$(date -u +%Y%m%dT%H%M%SZ)-$$\"\ncommand -v jq >/dev/null || { echo \"NO_JQ\"; exit 0; }\nemit() { jq -nc --arg phase 'design-review' --arg run_id \"$RUN_ID\" --arg branch \"$BRANCH\" --arg commit \"$COMMIT\" \\\n  --arg id \"$1\" --arg priority \"$2\" --arg component \"$3\" --arg effort_human \"$4\" --arg effort_cc \"$5\" \\\n  --arg title \"$6\" --arg source_finding \"$7\" --argjson files \"$8\" \\\n  '{phase:$phase, run_id:$run_id, branch:$branch, commit:$commit, id:$id, priority:$priority, component:$component, files:$files, effort_human:$effort_human, effort_cc:$effort_cc, title:$title, source_finding:$source_finding}' >> \"$TASKS_FILE\"; }\nemit T1 P1 \"Settings header actions\" \"~1h\" \"~10min\" \"Apply filled primary variant to Save and quiet secondary to Reset, Cancel, Export\" \"Pass 1 IA — D3/1A: nothing tells the user which is the primary action\" '[\"<app>/settings-page\"]'\nemit T2 P1 \"Save in-flight state\" \"~3h\" \"~20min\" \"Spinner in Save, label Saving…, held min-width, status line text, reduced-motion static glyph\" \"Pass 2 States — D4/2A: spinner or skeleton left undecided\" '[\"<app>/settings-page\",\"<app>/Button\",\"<app>/save-status-line\"]'\nemit T3 P1 \"Settings error color roles\" \"~30min\" \"~5min\" \"Set error foreground #991B1B and message background #FEF2F2\" \"Pass 5 Design System — D7/5A: contrast approximately 3:1\" '[\"<app>/settings-tokens.css\"]'\nemit T4 P2 \"Settings section-gap role\" \"~30min\" \"~5min\" \"Set every inter-section gap and header-to-Profile gap to 32px\" \"Pass 5 Design System — D5/3A: 24/32/16px inconsistent gaps\" '[\"<app>/settings-tokens.css\",\"<app>/settings-page\"]'\nemit T5 P2 \"Settings label and helper type roles\" \"~1h\" \"~10min\" \"Labels 16px/600, helper and validation 14px/400, remove 18px\" \"Pass 5 Design System — D6/4A: 14/16/18px label sizes\" '[\"<app>/settings-tokens.css\"]'\nemit T6 P2 \"Acceptance run\" \"~1h\" \"~10min\" \"Execute responsive and accessibility acceptance table at 375px and 768px+\" \"Pass 6 Responsive & A11y — new treatments must not regress DESIGN.md\" '[]'\nemit T7 P3 \"TODOS.md\" \"~15min\" \"~2min\" \"Create TODOS.md with the three approved follow-ups\" \"TODOS.md updates — D8, D9, D10\" '[\"TODOS.md\"]'\necho \"TASKS_FILE: $TASKS_FILE ($(wc -l < \"$TASKS_FILE\") lines)\"\n/tmp/gstack-paid-shard-eIwOQS/tmp/gstack-hermetic-1019314-1e844d/with-skills/runtime/bin/gstack-review-log '{\"skill\":\"plan-design-review\",\"timestamp\":\"'\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"'\",\"status\":\"clean\",\"initial_score\":4,\"overall_score\":9,\"unresolved\":0,\"decisions_made\":5,\"commit\":\"'\"$(git rev-parse --short HEAD)\"'\"}' && echo REVIEW_LOGGED\necho \"---REVIEW_READ---\"\n/tmp/gstack-paid-shard-eIwOQS/tmp/gstack-hermetic-1019314-1e844d/with-skills/runtime/bin/gstack-review-read", "description": "Write tasks JSONL, log review, read review dashboard data"};
const emDashCard = (input: { command: string; description: string }) => {
  const render = (value: string) => {
    const gutter = value.includes('\n') || value.length > 80;
    return value.split('\n').flatMap(line => Bun.wrapAnsi(line, 240 - (gutter ? 8 : 6), { hard: true, trim: false })
      .split('\n').map((row, index) => index > 0 && row.startsWith(' ') && row.length > 1 ? row.slice(1) : row))
      .map(row => ((gutter ? '   │ ' : '   ') + row).replace(/ +$/, '')).join('\n');
  };
  return '─'.repeat(240) + '\n Bash command\n\n' + render(input.command) + '\n' + render(input.description)
    + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
};

test('native Bash em dash uses literal positive-width projection without widening Unicode', () => {
  const input = { command: 'printf "A—B…"', description: 'Print A—B…' };
  const tool = { id: 'em-dash', name: 'Bash', input };
  expect(nativePermissionKey(tool, nativeBashDialog(input.command, input.description))).toBe('Bash:' + input.command);
  for (const foreign of ['\u2029', '\u00a0', '\u200b', '\u202e', '\u2066', '\u0301', '好', '👩‍💻', '\t', '\r', '\x1b', '\u0085']) {
    const changed = { ...input, command: input.command.replace('—', foreign) };
    expect(() => nativePermissionKey({ ...tool, input: changed }, nativeBashDialog(changed.command, changed.description))).toThrow('cannot be bound');
  }
});

test('native Bash em dash preserves exact soft boundaries and hard indentation', () => {
  const head = 'x'.repeat(111) + '—';
  const input = { command: head + '  —tail\n  —hard', description: 'Print —…' };
  const tool = { id: 'em-dash-wrap', name: 'Bash', input };
  const frame = '─'.repeat(120) + '\n Bash command\n\n   │ ' + head
    + '\n   │  —tail\n   │   —hard\n   Print —…'
    + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
  expect(nativePermissionKey(tool, frame)).toBe('Bash:' + input.command);
  for (const changed of [frame.replace('   │  —tail', '   │ —tail'), frame.replace('   │   —hard', '   │  —hard'),
    frame.replace('—hard', '-hard'), frame.replace('Print —…', 'Print -…')]) {
    expect(() => nativePermissionKey(tool, changed)).toThrow('cannot be bound');
  }
});

test('retained Design em dash input requires the complete exact card before granting', () => {
  const input = retainedDesignEmDashInput;
  const tool = { id: 'retained-em-dash', name: 'Bash', input, cwd: '/owned', bashPermissionRequestId: 'owned-request' };
  const frame = emDashCard(input);
  expect(nativePermissionKey(tool, frame)).toBe('Bash:' + input.command);
  const clipped = frame.split('\n').slice(5).join('\n');
  expect(matchesClippedBashPermission(tool, clipped, 240)).toBe(true);
  expect(() => nativePermissionKey(tool, clipped)).toThrow('cannot be bound');
  for (const changed of [frame.replace('TODOS.md updates —', 'TODOS.md updates -'),
    frame.replace(input.description, 'Read a different dashboard'), frame.replace(' ❯ 1. Yes', '   1. Yes'),
    frame.replace(' Esc to cancel · Tab to amend', ' Esc to cancel'), frame + '\n❯ Another prompt']) {
    expect(() => nativePermissionKey(tool, changed)).toThrow('cannot be bound');
  }
  for (const changed of [clipped.replace('TODOS.md updates —', 'TODOS.md updates -'),
    clipped.replace(input.description, 'Different description'), clipped.replace(' ❯ 1. Yes', '   1. Yes'),
    ' Bash command\n' + clipped, clipped + '\n❯ Another prompt']) {
    expect(matchesClippedBashPermission(tool, changed, 240)).toBe(false);
  }
  expect(() => nativePermissionKey({ ...tool, input: { ...input, command: input.command.replace('T7 P3', 'T7 P2') } }, frame)).toThrow('cannot be bound');
  expect(() => nativePermissionKey({ ...tool, input: { ...input, description: 'Different description' } }, frame)).toThrow('cannot be bound');
  expect(matchesClippedBashPermission({ ...tool, bashPermissionRequestId: null }, clipped, 240)).toBe(false);
});

test('retained Design em dash hook input still requires a paired request and one native completion', () => {
  const s = bashHooks(); const input = retainedDesignEmDashInput; const frame = emDashCard(input);
  const granted = new Set<string>(); const requests = new Map<string, NativePermissionGrant>();
  s.emit('PreToolUse', 'em-dash-owned', input);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(false);
  s.emit('PermissionRequest', 'not-a-native-id', input);
  expect(() => reserveNativePermissionGrant(s.read(), frame.split('\n').slice(5).join('\n'), granted, requests)).toThrow('cannot be bound');
  expect(granted.size).toBe(0);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(false);
  expect(s.read().permissionTools.map(tool => tool.id)).toEqual(['em-dash-owned']);
  s.emit('PostToolUse', 'em-dash-owned', input, { tool_response: { stdout: '', stderr: '', interrupted: false } });
  expect(s.read().permissionTools).toEqual([]);
  expect(s.read().permissionResults).toEqual([{ id: 'em-dash-owned', result: 'completed' }]);
  expect([...granted]).toEqual(['em-dash-owned']);
});

test.each(['command', 'description'] as const)('retained Design em dash refuses changed post-Pre %s', field => {
  const s = bashHooks(); const input = retainedDesignEmDashInput;
  s.emit('PreToolUse', 'em-dash-owned', input);
  s.emit('PermissionRequest', 'not-a-native-id', { ...input, [field]: input[field] + ' changed' });
  const granted = new Set<string>();
  expect(reserveNativePermissionGrant(s.read(), emDashCard(input), granted, new Map())).toBe(false);
  expect(granted.size).toBe(0);
});


test('pinned Bash clipped top rule requires the entire exact payload and only permits repaint', () => {
  const input = retainedDesignEmDashInput;
  const tool = { id: 'clipped-rule', name: 'Bash', input, cwd: '/owned', bashPermissionRequestId: 'owned-request' };
  const frame = emDashCard(input).split('\n').slice(1).join('\n');
  const native = { permissionTools: [tool], permissionResults: [], permissionRequests: [], permissionRequestCapture: true };
  expect(frame).toStartWith(' Bash command\n\n');
  expect(matchesClippedBashPermission(tool, frame, 240)).toBe(true);
  expect(() => nativePermissionKey(tool, frame)).toThrow('cannot be bound');
  const granted = new Set<string>();
  expect(() => reserveNativePermissionGrant(native, frame, granted, new Map())).toThrow('cannot be bound');
  expect(granted.size).toBe(0);
  for (const changed of [frame.replace(' Bash command', ' Bash command (unproven)'),
    frame.replace(' Bash command\n\n', ' Bash command\n'), 'Prior context\n' + frame,
    frame.split('\n').filter((_, i) => i !== 2).join('\n'),
    frame.replace('TODOS.md updates —', 'TODOS.md updates -'), frame.replace(input.description, 'Other description'),
    frame.replace(' ❯ 1. Yes', '   1. Yes'), frame + '\n❯ Another prompt']) {
    expect(matchesClippedBashPermission(tool, changed, 240)).toBe(false);
  }
  expect(matchesClippedBashPermission(tool, frame, 120)).toBe(false);
  expect(matchesClippedBashPermission({ ...tool, bashPermissionRequestId: null }, frame, 240)).toBe(false);
  expect(matchesClippedBashPermission({ ...tool, input: { ...input, command: input.command + ' changed' } }, frame, 240)).toBe(false);
});


test('captured Design tasks permission binds its exact single-cell Unicode payload', () => {
  const { tool, frame } = retainedDesignTasksPermission;
  expect(nativePermissionKey(tool, frame)).toBe('Bash:' + tool.input.command);
});


test.each(['≤', '–', 'é', '©', '™'])('native Bash preserves unsanitized one-cell BMP text: %s', glyph => {
  const input = { command: `printf "${glyph}"`, description: `Print ${glyph}` };
  expect(nativePermissionKey({ id: 'one-cell', name: 'Bash', input }, nativeBashDialog(input.command, input.description))).toBe('Bash:' + input.command);
});

test.each(['\u0000', '\u007f', '\u0085', '\t', '\r', '\x1b', '\u00a0', '\u2028', '\u2029',
  '\u200b', '\u2060', '\u202e', '\u2066', '\u0301', 'e\u0301', '\u034f', '\ufe0f', '\u2800',
  '\ud800', '好', '😀', '👩‍💻', '𝔸'])
('native Bash refuses sanitized or non-single-cell payload %j', glyph => {
  for (const field of ['command', 'description'] as const) {
    const input = { command: 'printf ready', description: 'Print ready', [field]: `Print ${glyph}` };
    expect(() => nativePermissionKey({ id: 'unsafe-glyph', name: 'Bash', input }, nativeBashDialog(input.command, input.description))).toThrow('cannot be bound');
  }
});

test('one-cell Unicode keeps exact hard indentation and soft continuation at both viewports', () => {
  for (const columns of [120, 240]) {
    const head = 'x'.repeat(columns - 9) + '≤';
    const input = { command: head + '  étail\n  ™hard', description: 'Print ≤–é©™' };
    const tool = { id: 'unicode-wrap', name: 'Bash', input };
    const frame = '─'.repeat(columns) + '\n Bash command\n\n   │ ' + head
      + '\n   │  étail\n   │   ™hard\n   Print ≤–é©™'
      + '\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend';
    expect(nativePermissionKey(tool, frame)).toBe('Bash:' + input.command);
    for (const changed of [frame.replace('   │  étail', '   │ étail'), frame.replace('   │   ™hard', '   │  ™hard'),
      frame.replace('Print ≤–é©™', 'Print <–é©™')]) expect(() => nativePermissionKey(tool, changed)).toThrow('cannot be bound');
  }
});

test('captured Design tasks card still requires exact command, description, width and controls', () => {
  const { tool, frame } = retainedDesignTasksPermission;
  const lines = frame.split('\n');
  const heading = lines.indexOf(' Bash command');
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(lines[heading + 1]).toMatch(/^ *$/);
  const clipped = lines.slice(heading + 3).join('\n');
  expect(matchesClippedBashPermission(tool, clipped, 240)).toBe(true);
  expect(() => nativePermissionKey(tool, clipped)).toThrow('cannot be bound');
  for (const changed of [frame.replace('≤16px', '<16px'), frame.replace(tool.input.description, 'Different task'),
    frame.replace('─'.repeat(240), '─'.repeat(120)), frame.replace('─'.repeat(240), '─'.repeat(239)),
    frame.replace(' ❯ 1. Yes', '   1. Yes'), frame.replace(' Esc to cancel · Tab to amend', ' Esc to cancel'),
    frame + '\n❯ Another prompt', '```\n' + frame]) expect(() => nativePermissionKey(tool, changed)).toThrow('cannot be bound');
  for (const field of ['command', 'description'] as const) {
    expect(() => nativePermissionKey({ ...tool, input: { ...tool.input, [field]: tool.input[field] + ' changed' } }, frame)).toThrow('cannot be bound');
  }
  expect(matchesClippedBashPermission({ ...tool, bashPermissionRequestId: null }, clipped, 240)).toBe(false);
});

test('captured Design tasks permission needs an owned request and retires on its actual completion', () => {
  const s = bashHooks(); const { tool, frame } = retainedDesignTasksPermission; const input = tool.input;
  const granted = new Set<string>(), requests = new Map<string, NativePermissionGrant>();
  s.emit('PreToolUse', 'tasks-owned', input);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(false);
  s.emit('PermissionRequest', 'hook-not-native-id', input);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(s.read(), frame, granted, requests)).toBe(false);
  expect(s.read().permissionTools.map(tool => tool.id)).toEqual(['tasks-owned']);
  s.emit('PostToolUse', 'tasks-owned', input, { tool_response: { stdout: '', stderr: '', interrupted: false } });
  expect(s.read().permissionTools).toEqual([]);
  expect(s.read().permissionResults).toEqual([{ id: 'tasks-owned', result: 'completed' }]);
  expect([...granted]).toEqual(['tasks-owned']);
});

test.each(['command', 'description'] as const)('captured Design tasks refuses changed post-Pre %s', field => {
  const s = bashHooks(); const { tool, frame } = retainedDesignTasksPermission;
  s.emit('PreToolUse', 'tasks-owned', tool.input);
  s.emit('PermissionRequest', 'hook-not-native-id', { ...tool.input, [field]: tool.input[field] + ' changed' });
  const granted = new Set<string>();
  expect(reserveNativePermissionGrant(s.read(), frame, granted, new Map())).toBe(false);
  expect(granted.size).toBe(0);
});


function capturedQuestionValidation() {
  const block = JSON.parse(retainedQuestionValidation.toolUseJson);
  const invoked = { type: 'assistant', sessionId, cwd: config, timestamp: retainedQuestionValidation.invokedAt,
    message: { role: 'assistant', stop_reason: 'tool_use', content: [block] } };
  const rejected = { type: 'user', sessionId, cwd: config, timestamp: retainedQuestionValidation.rejectedAt,
    toolUseResult: JSON.parse(retainedQuestionValidation.toolUseResultJson),
    message: { role: 'user', content: [JSON.parse(retainedQuestionValidation.toolResultJson)] } };
  return { block, invoked, rejected };
}

test.each(['same-snapshot', 'split-snapshots'])('captured native schema rejection stays unoffered and permits a new corrected invocation (%s)', variant => {
  const { block, invoked, rejected } = capturedQuestionValidation();
  write(invoked, ...(variant === 'same-snapshot' ? [rejected] : []));
  const early = earlyQuestions();
  const initial = readPlanSkillQuestions(config, sessionId, early.source);
  expect(initial.pendingBytes).toBe(0);
  expect(initial.calls).toEqual([{ id: block.id, questions: [], result: variant === 'same-snapshot' ? 'error' : 'pending',
    validation: { input: block.input, ...(variant === 'same-snapshot' ? { rejection: {
      content: rejected.message.content[0].content, toolUseResult: rejected.toolUseResult,
    } } : {}) } }]);
  expect(initial.calls[0].answerLabels).toBeUndefined();
  // No defaulted copy is mislabeled as the original rejected input.
  expect(Object.hasOwn((initial.calls[0].validation!.input as typeof block.input).questions[0], 'multiSelect')).toBe(false);
  if (variant === 'split-snapshots') fs.appendFileSync(file, JSON.stringify(rejected) + '\n');
  const terminal = readPlanSkillQuestions(config, sessionId, early.source);
  expect(terminal.calls[0]).toMatchObject({ result: 'error', questions: [], validation: { input: block.input } });
  const corrected = { questions: [structuredClone(block.input.questions[1])] };
  early.emit('corrected-new-id', corrected);
  const pending = readPlanSkillQuestions(config, sessionId, early.source);
  expect(pending.calls.find(c => c.id === block.id)).toEqual(terminal.calls[0]);
  expect(pending.calls.filter(c => c.result === 'pending')).toEqual([{ id: 'corrected-new-id', questions: corrected.questions, result: 'pending' }]);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'corrected-new-id', content: 'Answer accepted' },
  ] } }) + '\n');
  const answered = readPlanSkillQuestions(config, sessionId, early.source);
  expect(answered.calls.find(c => c.id === 'corrected-new-id')?.result).toBe('answered');
  expect(answered.calls.find(c => c.id === block.id)).toEqual(terminal.calls[0]);
});

test.each(['no-result', 'wrong-result-id', 'foreign-result', 'sidechain-result'])('native schema validation stays pending without its own result (%s)', variant => {
  const { block, invoked, rejected } = capturedQuestionValidation();
  if (variant === 'wrong-result-id') rejected.message.content[0].tool_use_id = 'another-id';
  if (variant === 'foreign-result') rejected.sessionId = '00000000-0000-4000-8000-000000000099';
  if (variant === 'sidechain-result') (rejected as any).isSidechain = true;
  write(invoked, ...(variant === 'no-result' ? [] : [rejected]));
  const early = earlyQuestions();
  const native = readPlanSkillQuestions(config, sessionId, early.source);
  expect(native.calls).toEqual([{ id: block.id, questions: [], result: 'pending', validation: { input: block.input } }]);
  expect(native.ready).toBe(false);
  expect(native.pendingBytes).toBe(0);
});

test.each(['before-invocation', 'earlier-time', 'wrong-cwd', 'success', 'generic-error', 'changed-content',
  'changed-structured', 'duplicate-result', 'changed-input', 'changed-tool', 'executed-hook', 'no-hook-capture'])
('native schema rejection refuses incompatible ownership or resolution (%s)', variant => {
  const { block, invoked, rejected } = capturedQuestionValidation();
  if (variant === 'earlier-time') rejected.timestamp = '2026-09-12T09:44:53.655Z';
  if (variant === 'wrong-cwd') rejected.cwd += '/foreign';
  if (variant === 'success') rejected.message.content[0].is_error = false;
  if (variant === 'generic-error') { rejected.toolUseResult = 'Request cancelled'; rejected.message.content[0].content = 'Request cancelled'; }
  if (variant === 'changed-content') rejected.message.content[0].content += ' amended';
  if (variant === 'changed-structured') rejected.toolUseResult = rejected.toolUseResult.replace('header', 'otherField');
  const extra = structuredClone(invoked);
  if (variant === 'changed-input') extra.message.content[0].input.questions[0].question += ' changed';
  if (variant === 'changed-tool') extra.message.content[0].name = 'Write';
  write(...(variant === 'before-invocation' ? [rejected, invoked] : [invoked, rejected]),
    ...(['changed-input', 'changed-tool'].includes(variant) ? [extra] : []),
    ...(variant === 'duplicate-result' ? [rejected] : []));
  const early = earlyQuestions();
  if (variant === 'executed-hook') early.emit(block.id, block.input);
  expect(() => readPlanSkillQuestions(config, sessionId, variant === 'no-hook-capture' ? undefined : early.source))
    .toThrow(/Unsupported native AskUserQuestion|Native question validation/);
});


test('native schema rejection refuses an owned orphan completion hook', () => {
  const s = completedQuestionHook();
  const { block, invoked, rejected } = capturedQuestionValidation();
  write(invoked, rejected);
  s.emit('PostToolUse', block.id, { ...s.input, answers: s.response.answers }, { tool_response: s.response });
  expect(() => s.read()).toThrow('Unsupported native AskUserQuestion reached execution or lacks hook capture');
});
