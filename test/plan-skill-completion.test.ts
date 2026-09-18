import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanSkillCompletion } from './helpers/plan-skill-completion';
import { stripAnsi } from './helpers/claude-pty-runner';

describe('owned assistant plan review completion', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  let config: string;
  let file: string;
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
    type: 'assistant', sessionId, isSidechain: false,
    message: { id: 'message-1', role: 'assistant', content, stop_reason: 'end_turn', ...message }, ...extra,
  });
  const text = (value: string) => [{ type: 'text', text: value }];
  const write = (...rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  beforeEach(() => {
    config = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-completion-'));
    file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  });
  afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

  test.each(['## GSTACK REVIEW REPORT', '## Completion Summary', '**VERDICT: APPROVED**', 'Status: clean', '**DONE**', 'DONE_WITH_CONCERNS — remaining risks'])('completed assistant %s is a valid chat terminal', marker => {
    write(assistant(text(marker)), { type: 'cost-state', sessionId });
    const visible = stripAnsi('\x1b[2C' + marker.replace(/\*|#| /g, ''));
    expect(readPlanSkillCompletion(config, sessionId, visible)).not.toBeNull();
    expect(readPlanSkillCompletion(config, sessionId, 'Still working')).toBeNull();
  });

  test('Write previews and tool results cannot complete a review', () => {
    const marker = '## GSTACK REVIEW REPORT\nVERDICT: APPROVED';
    write(assistant([{ type: 'tool_use', name: 'Write', input: { content: marker } }], {}, { stop_reason: 'tool_use' }));
    expect(readPlanSkillCompletion(config, sessionId, marker)).toBeNull();
    write({ type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', content: marker }] } });
    expect(readPlanSkillCompletion(config, sessionId, marker)).toBeNull();
  });

  test('text preceding a tool call is not a completed assistant turn', () => {
    write(assistant(text('DONE'), {}, { stop_reason: 'tool_use' }));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(assistant(text('DONE')), assistant([{ type: 'tool_use', name: 'Write' }]));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test.each([
    { type: 'user', message: { role: 'user', content: 'Continue the review' } },
    { type: 'attachment', attachment: { prompt: 'Review this other plan' } },
    { type: 'assistant', message: { id: 'message-2', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read' }] } },
  ])('later conversation activity invalidates an earlier completion (%j)', later => {
    write(assistant(text('DONE')), { sessionId, ...later });
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test('actual queued input must be consumed before a new assistant completion can finish', () => {
    const enqueue = { type: 'queue-operation', sessionId, operation: 'enqueue', content: 'Review the supplied payment plan' };
    const remove = { ...enqueue, operation: 'remove', reason: 'absorbed_mid_turn' };
    const done = assistant(text('DONE'));
    write(done, enqueue);
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, done);
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, done, remove);
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, done, remove, assistant(text('DONE'), {}, { id: 'after-consumption' }));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });

  test('removing one duplicate queued input does not consume the other', () => {
    const enqueue = { type: 'queue-operation', sessionId, operation: 'enqueue', content: 'Continue' };
    const remove = { ...enqueue, operation: 'remove' };
    write(enqueue, enqueue, remove, assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, enqueue, remove, remove, assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });

  // Claude 2.1.263 / wdn: each real removal emits one event, including
  // dequeueAll/popAllEditable. Non-string command values omit content entirely.
  // Dequeue has no payload identity; remove/pop include only string values.
  const queue = (operation: string, content?: string) => ({ type: 'queue-operation', sessionId, operation,
    timestamp: '2026-09-09T19:00:00.000Z', ...(content !== undefined ? { content } : {}) });
  test.each(['dequeue', 'remove', 'popOne', 'popAll'])('native %s consumes one queued item, never the whole batch', operation => {
    const enqueue = queue('enqueue', 'Review the plan');
    const removal = queue(operation, operation === 'dequeue' ? undefined : 'Review the plan');
    write(enqueue, enqueue, removal, assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, enqueue, removal, assistant(text('DONE')), removal);
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(enqueue, enqueue, removal, removal, assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });
  test.each(['dequeue', 'remove', 'popOne', 'popAll'])('native %s supports an opaque command whose content was omitted', operation => {
    write(queue('enqueue'), assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(queue('enqueue'), queue(operation), assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });
  test('an anonymously drained queue permits a new enqueue only after its identities resolve', () => {
    const prefix = [queue('enqueue', 'later A'), queue('enqueue', 'next B'), queue('dequeue')];
    write(...prefix, queue('enqueue', 'new C'), assistant(text('DONE')));
    expect(() => readPlanSkillCompletion(config, sessionId, 'DONE')).toThrow('mixed queue history');
    write(...prefix, queue('remove', 'later A'), queue('enqueue', 'new C'), assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(...prefix, queue('remove', 'later A'), queue('enqueue', 'new C'), queue('popOne', 'new C'), assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });
  test('dequeue with one possible payload preserves duplicate counts and allows later input', () => {
    const prefix = [queue('enqueue', 'A'), queue('enqueue', 'A'), queue('dequeue'), queue('enqueue', 'B')];
    write(...prefix, queue('remove', 'A'), assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(...prefix, queue('remove', 'A'), queue('popOne', 'B'), assistant(text('DONE')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBe('DONE');
  });
  test('anonymous consumption cannot be reassigned to a later enqueue', () => {
    write(queue('enqueue', 'A'), queue('enqueue', 'B'), queue('dequeue'), queue('enqueue', 'C'),
      queue('remove', 'A'), queue('remove', 'B'), assistant(text('DONE')));
    expect(() => readPlanSkillCompletion(config, sessionId, 'DONE')).toThrow('mixed queue history');
  });
  test.each(['dequeue', 'remove', 'popOne', 'popAll'])('native %s without its enqueue fails closed on incomplete history', operation => {
    write(queue(operation), assistant(text('DONE')));
    expect(() => readPlanSkillCompletion(config, sessionId, 'DONE')).toThrow('lacks its enqueue');
  });
  test('distinguishable unmatched removal cannot consume another queued input', () => {
    write(queue('enqueue', 'Pending'), queue('remove', 'Different'), assistant(text('DONE')));
    expect(() => readPlanSkillCompletion(config, sessionId, 'DONE')).toThrow('does not match');
  });
  test.each([
    { operation: 'clear' }, { operation: null }, { operation: 'enqueue', content: {} },
    { operation: 'enqueue', content: null }, { operation: 'remove', content: [] },
    { operation: 'popAll', content: 1 }, { operation: 'dequeue', content: 'Not emitted by the producer' },
  ])('unknown or malformed queue schema stays rejected (%j)', invalid => {
    write({ ...queue('enqueue'), ...invalid }, assistant(text('DONE')));
    expect(() => readPlanSkillCompletion(config, sessionId, 'DONE')).toThrow('Unsupported queue operation');
  });

  test('quoted, fenced, indented, and future-example markers cannot complete a review', () => {
    write(assistant(text('I will print DONE later.\n> DONE\n    DONE\n\tDONE\n```md\n## GSTACK REVIEW REPORT\n```\n~~~\nVERDICT: APPROVED\n~~~')));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE GSTACK REVIEW REPORT VERDICT: APPROVED')).toBeNull();
  });

  test('foreign sessions, sidechains, thinking, and user text are not assistant completion', () => {
    write(
      assistant(text('DONE'), { sessionId: '00000000-0000-4000-8000-000000000002' }),
      assistant(text('DONE'), { isSidechain: true }),
      assistant(text('DONE'), { parent_tool_use_id: 'child' }),
      assistant(text('DONE'), { type: 'user' }),
      assistant([{ type: 'thinking', thinking: 'DONE' }]),
    );
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test('an unfinished record or missing end_turn stays pending', () => {
    write(assistant(text('DONE'), {}, { stop_reason: null }));
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
    write(assistant(text('DONE')));
    fs.appendFileSync(file, '{"type":"user"');
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });

  test('missing ownership fails honestly; missing transcript remains pending', () => {
    expect(() => readPlanSkillCompletion(null, sessionId, 'DONE')).toThrow('owned hermetic');
    expect(readPlanSkillCompletion(config, sessionId, 'DONE')).toBeNull();
  });
});
