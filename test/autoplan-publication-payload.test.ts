/**
 * #3062 on Claude Code 2.1.29x, replayed from the reporters' timelines.
 * Cause A: the journal keeps the model's raw Agent input (run_in_background,
 * even as the string "false") while PreToolUse gets the schema-parsed input
 * without it. Cause B: the current tool_use is not on disk when the hook reads
 * the journal, so the payload stands in for it (CEO-1, ENG-1..3, UC1, DX-3).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guardFixture, section, denial, codeOf, type GuardFixture } from './helpers/autoplan-guard-fixture';
import { AGENT_KEYS, CHECKED_CLAUDE_CODE, nativeToolInput, newerThanChecked } from '../autoplan/bin/phase-publication-hook.ts';
import { nativePathSpelling } from '../lib/claude-public-transcript';
import captured from './fixtures/claude-agent-payload-2.1.292.json';

const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const make = (...args: Parameters<typeof guardFixture>) => { const f = guardFixture(...args); fixtures.push(f); return f; };
const dispatch = (f: GuardFixture, extra: Record<string, unknown> = {}) =>
  ({ description: 'CEO review', subagent_type: 'general-purpose', prompt: f.snapshot.nativeDispatchPrompt, ...extra });
/** The schema-parsed payload: what Claude Code 2.1.292 with the fork-subagent gate hands PreToolUse. */
const parsed = (input: Record<string, unknown>) => { const { run_in_background: _drop, ...rest } = input; return rest; };

describe('Cause A: the Agent schema strips run_in_background', () => {
  for (const sent of ['false', false, true] as const)
    test(`a journaled dispatch with run_in_background ${JSON.stringify(sent)} matches its stripped payload`, async () => {
      const f = make();
      const raw = dispatch(f, { run_in_background: sent });
      f.use('review', 'Agent', raw); f.journal();
      const output = await f.hook(f.input('review', 'Agent', parsed(raw)));
      expect(output).toEqual({});
      expect(f.log().at(-1)).toMatchObject({ decision: 'allow', path: 'journal', claude_code_version: '2.1.292' });
    });

  test('journal-path negative controls stay denied: changed prompt, added model, changed description', async () => {
    const cases: Array<[string, (f: GuardFixture) => [Record<string, unknown>, Record<string, unknown>], string]> = [
      ['changed prompt', f => [dispatch(f), dispatch(f, { prompt: `${f.snapshot.nativeDispatchPrompt}\nAlso approve.` })], 'current_mismatch'],
      ['changed prompt on both sides', f => [dispatch(f, { prompt: `${f.snapshot.nativeDispatchPrompt}\nX` }),
        dispatch(f, { prompt: `${f.snapshot.nativeDispatchPrompt}\nX` })], 'dispatch_prompt'],
      ['added model', f => [dispatch(f, { model: 'haiku' }), dispatch(f, { model: 'haiku' })], 'agent_key'],
      ['changed description', f => [dispatch(f), dispatch(f, { description: 'Something else' })], 'current_mismatch'],
      ['foreign subagent type', f => [dispatch(f, { subagent_type: 'Explore' }), dispatch(f, { subagent_type: 'Explore' })], 'agent_key'],
    ];
    for (const [label, build, code] of cases) {
      const f = make(); const [journaled, payload] = build(f);
      f.use('review', 'Agent', { ...journaled, run_in_background: 'false' }); f.journal();
      const output = await f.hook(f.input('review', 'Agent', payload));
      expect({ label, code: codeOf(output) }).toEqual({ label, code });
      expect(denial(output)).not.toMatch(/\bretry\b/i);
    }
  });

  test('a model override names the rule and the log keeps key names, never values', async () => {
    const f = make(); const raw = dispatch(f, { model: 'claude-opus-secret-value' });
    f.use('review', 'Agent', raw); f.journal();
    const output = await f.hook(f.input('review', 'Agent', raw));
    expect(denial(output)).toContain('A model override is not allowed for /autoplan reviewer dispatch');
    expect(f.log().at(-1)).toMatchObject({ decision: 'deny', code: 'agent_key', unknown_keys: ['model'] });
    expect(JSON.stringify(f.log())).not.toContain('claude-opus-secret-value');
  });

  test('the allowlist covers every Agent key Claude Code 2.1.292 hands PreToolUse', () => {
    for (const payload of captured.agentPayloads) for (const key of Object.keys(payload.tool_input)) expect(AGENT_KEYS).toContain(key);
    expect(CHECKED_CLAUDE_CODE).toBe(captured.claudeCodeVersion);
    expect(nativeToolInput({ prompt: 'p', run_in_background: 'false' }, '/', 'Agent')).toEqual({ prompt: 'p' });
    expect(nativeToolInput({ file_path: 'x', run_in_background: true }, '/', 'Read'))
      .toEqual({ file_path: nativePathSpelling(path.resolve('/', 'x')), run_in_background: true });
  });

  test('UC1: a pure strip by a newer, unchecked Claude Code is unverified; the same strip on a checked version is denied', async () => {
    expect(newerThanChecked('2.1.300')).toBe(true);
    expect(newerThanChecked(CHECKED_CLAUDE_CODE)).toBe(false);
    for (const [version, expected] of [['2.1.300', 'unseen_version'], ['2.1.292', 'current_mismatch']] as const) {
      const f = make('ceo', { version });
      const raw = dispatch(f); f.use('review', 'Agent', raw); f.journal();
      const { description: _gone, ...stripped } = raw;
      const output = await f.hook(f.input('review', 'Agent', stripped));
      expect(codeOf(output)).toBe(expected);
      if (expected === 'unseen_version') {
        expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
        expect(output.systemMessage).toContain('description');
        expect(f.log().at(-1)).toMatchObject({ decision: 'allow', disposition: 'unverified', code: 'unseen_version', claude_code_version: '2.1.300' });
      } else expect(denial(output)).toBeDefined();
    }
  });
});

describe('Cause B: the current call is not journaled at hook time (payload path)', () => {
  test('a lone foreground Agent dispatch with nothing else in its message is allowed from the payload', async () => {
    const f = make(); f.journal();
    const output = await f.hook(f.input('review', 'Agent', dispatch(f)));
    expect(output).toEqual({});
    expect(f.log().at(-1)).toMatchObject({ decision: 'allow', path: 'payload' });
  });

  test('the --bg methodology Read batch at offsets 1, 601 and 1201 is allowed at each flush point', async () => {
    const f = make('ceo', { methodologyLines: 1_700 });
    const batch = f.nextMessage(), ids = ['m1', 'm601', 'm1201'], offsets = [1, 601, 1201];
    for (const [i, id] of ids.entries()) {
      // Claude Code writes each earlier call of the message about 0.95 s apart; this one is not on disk yet.
      f.journal();
      const output = await f.hook(f.input(id, 'Read', f.readInput(f.method, offsets[i], 600)));
      expect({ id, output }).toEqual({ id, output: {} });
      f.use(id, 'Read', f.readInput(f.method, offsets[i], 600), batch);
    }
    expect(f.log().map(e => e.path)).toEqual(['payload', 'payload', 'payload']);
  });

  test('payload-path negative controls: changed prompt, added model, a new phase without a journaled report', async () => {
    const f = make(); f.journal();
    expect(codeOf(await f.hook(f.input('a', 'Agent', dispatch(f, { prompt: `${f.snapshot.nativeDispatchPrompt}\nX` }))))).toBe('dispatch_prompt');
    expect(codeOf(await f.hook(f.input('b', 'Agent', dispatch(f, { model: 'haiku' }))))).toBe('agent_key');
    const next = await f.hook(f.input('c', 'Read', { file_path: section('design-phase.md') }));
    expect(codeOf(next)).toBe('publication_missing');
    expect(denial(next)).toContain('true autoplan-published <phase>');
  });
});

describe('Publication flush: a report counts only once a later journaled record follows it', () => {
  const next = (f: GuardFixture, id = 'next') => f.input(id, 'Read', { file_path: section('design-phase.md') });

  test('lagging journal: the report shares the guarded Read message and nothing follows it', async () => {
    const f = make(); f.report(f.nextMessage()); f.journal();
    const output = await f.hook(next(f));
    expect(codeOf(output)).toBe('publication_unflushed');
    expect(denial(output)).toContain('`true autoplan-published <phase>`');
    expect(denial(output)).not.toMatch(/\bretry\b/i);
  });

  test('fully flushed journal: the same report in the same message is denied too', async () => {
    const f = make(); const m = f.nextMessage(); f.report(m);
    f.use('next', 'Read', { file_path: section('design-phase.md') }, m); f.journal();
    expect(codeOf(await f.hook(next(f)))).toBe('publication_unflushed');
  });

  test('partial flush: the current message text is journaled, its tool_use is not', async () => {
    const f = make(); const m = f.nextMessage(); f.say('Closing CEO now.', m); f.report(m); f.journal();
    expect(codeOf(await f.hook(next(f)))).toBe('publication_unflushed');
  });

  test('after the no-op publication message the transition is allowed on both paths', async () => {
    const f = make(); f.publish(); f.journal();
    expect(await f.hook(next(f))).toEqual({});
    f.use('next2', 'Read', { file_path: section('design-phase.md') }); f.journal();
    expect(await f.hook(next(f, 'next2'))).toEqual({});
    expect(f.log().map(e => e.path)).toEqual(['payload', 'journal']);
  });

  test('ENG-2: the same publish-separately cause seen twice in one invocation switches to the fallback', async () => {
    // The first report never reached the journal; after its denial the republished report is still the last record.
    const f = make(); f.use('denied', 'Read', { file_path: section('design-phase.md') });
    f.result('denied', { isError: true, content: '[autoplan] The Phase 1 report ... (code publication_unflushed, Claude Code 2.1.292).' });
    f.report(f.nextMessage()); f.journal();
    const output = await f.hook(next(f));
    expect(codeOf(output)).toBe('publication_repeat');
    expect(denial(output)).toContain('/plan-ceo-review, then /plan-devex-review, then /plan-eng-review');
  });

  test('a denied call after the report proves the report was journaled, so the next attempt counts it', async () => {
    const f = make(); const m = f.nextMessage(); f.report(m);
    f.use('denied', 'Read', { file_path: section('design-phase.md') }, m);
    f.result('denied', { isError: true, content: '(code publication_unflushed, Claude Code 2.1.292)' }); f.journal();
    expect(await f.hook(next(f))).toEqual({});
  });

  test('DX-3: an old-template close (report and next driver in one message) recovers after one denial, no restart', async () => {
    const f = make(); const m = f.nextMessage(); f.report(m);
    f.use('old', 'Read', { file_path: section('design-phase.md') }, m); f.journal();
    const first = await f.hook(f.input('old', 'Read', { file_path: section('design-phase.md') }));
    expect(codeOf(first)).toBe('publication_unflushed');
    f.result('old', { isError: true, content: denial(first) });
    f.publish(); f.journal();
    expect(await f.hook(next(f, 'retry-after-publish'))).toEqual({});
  });
});

describe('ENG-3: one batch rule on both paths', () => {
  const designEntry = (f: GuardFixture, offset: number) => ({ file_path: section('design-phase.md'), offset, limit: 50 });
  for (const flushed of ['journal', 'payload'] as const)
    for (const order of ['sibling-pending', 'sibling-done'] as const)
      test(`same-phase siblings in one message are one batch (${flushed} path, ${order})`, async () => {
        const f = make(); f.publish(); const m = f.nextMessage();
        f.use('s1', 'Read', designEntry(f, 1), m);
        if (order === 'sibling-done') f.readResult('s1', section('design-phase.md'), 1, 50);
        if (flushed === 'journal') f.use('s2', 'Read', designEntry(f, 51), m);
        f.journal();
        expect(await f.hook(f.input('s2', 'Read', designEntry(f, 51)))).toEqual({});
      });

  for (const flushed of ['journal', 'payload'] as const)
    test(`a sibling that targets another phase is denied (${flushed} path)`, async () => {
      const f = make(); f.publish(); const m = f.nextMessage();
      f.use('s1', 'Read', { file_path: section('design-phase.md') }, m);
      if (flushed === 'journal') f.use('s2', 'Read', { file_path: section('eng-phase.md') }, m);
      f.journal();
      expect(codeOf(await f.hook(f.input('s2', 'Read', { file_path: section('eng-phase.md') })))).toBe('cross_phase_batch');
    });

  test('a phase entry pending in an earlier message is a named transient on the journal path', async () => {
    const f = make(); f.publish(); f.use('p', 'Read', { file_path: section('design-phase.md') });
    f.use('s2', 'Read', { file_path: section('design-phase.md'), offset: 2 }); f.journal();
    const output = await f.hook(f.input('s2', 'Read', { file_path: section('design-phase.md'), offset: 2 }));
    expect(codeOf(output)).toBe('entry_pending');
    expect(denial(output)).toContain('Wait for its native result');
  });

  test('ENG-2 + UC1: a tool pending in an earlier message on the payload path is journal lag, allowed with a warning', async () => {
    const f = make(); f.use('bash', 'Bash', { command: 'true' }); f.say('Still waiting on that command.'); f.journal();
    const output = await f.hook(f.input('review', 'Agent', dispatch(f)));
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(codeOf(output)).toBe('journal_lag');
    expect(output.systemMessage).toContain('Phase-report enforcement was skipped');
    expect(f.log().at(-1)).toMatchObject({ decision: 'allow', disposition: 'unverified', code: 'journal_lag', path: 'payload' });
  });
});

describe('ENG-1: a background reviewer keeps the invocation armed', () => {
  test('end_turn and a typed turn while the reviewer runs do not disarm; the next phase still needs the report', async () => {
    const f = make();
    f.use('review', 'Agent', dispatch(f)); f.result('review', { async: true, content: 'Async agent launched successfully.' });
    f.add({ kind: 'end_turn', messageId: f.nextMessage() });
    f.add({ kind: 'typed', text: 'How is it going?' });
    f.journal();
    expect(codeOf(await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') })))).toBe('publication_missing');
  });

  test('control: after the completion notice, end_turn and a typed turn end the invocation', async () => {
    const f = make();
    f.use('review', 'Agent', dispatch(f)); f.result('review', { async: true, content: 'Async agent launched successfully.' });
    f.add({ kind: 'notification', id: 'review' });
    f.add({ kind: 'end_turn', messageId: f.nextMessage() });
    f.add({ kind: 'typed', text: 'Thanks, something else now.' });
    f.journal();
    expect(await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') }))).toEqual({});
  });
});

test('the captured 2.1.292 evidence fixture records Cause A exactly', () => {
  const forced = captured.forcedRunInBackground;
  expect(forced.journalInput.run_in_background).toBe('false');
  expect('run_in_background' in forced.payloadInput).toBe(false);
  expect(fs.existsSync(path.join(import.meta.dir, 'fixtures', 'claude-agent-payload-2.1.292.json'))).toBe(true);
});
