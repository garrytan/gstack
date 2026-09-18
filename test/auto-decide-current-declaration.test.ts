import { expect, test } from 'bun:test';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import capture from './fixtures/auto-decide-current-declaration-6aef.json';

const clone = () => structuredClone(capture.retry) as any;
const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);
const message = (f: any) => f.transcript.assistantMessages.find((m: any) =>
  m.timestamp === '2026-09-16T23:23:28.931Z');
const use = (f: any) => f.tools.find((e: any) => e.kind === 'use' &&
  e.input?.command?.includes('gstack-skill-start'));
const ack = (f: any) => f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === use(f).toolUseId);

test('actual current Decision declaration completes the retained owned retry', () => {
  const f = clone();
  const result = decide(f);
  expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.annotation).toBe(message(f).text);
  expect(result?.stateRecord).toEqual(f.options.stateEvidence.records[0]);
  expect(result?.preambleToolUseId).toBe(use(f).toolUseId);
  expect(result?.skillToolUseId).toBeUndefined();
  expect(result?.questionLogToolUseId).toBeUndefined();
});

test('literal first declaration form is supported by the authenticated retry context', () => {
  const f = clone();
  // This checks representation only. The first attempt's state was deleted;
  // transplanting its text grants no first-attempt ownership or verdict credit.
  message(f).text = capture.firstDeclaration.text;
  expect(decide(f)?.option).toBe('HOLD SCOPE');
  delete f.options.stateEvidence;
  f.tools = [];
  expect(decide(f)).toBeNull();
});

const modes = ['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'];
for (const mode of modes) {
  for (const label of ['Decision', 'Decision: review mode is', 'Mode']) {
    for (const target of ['for this draft.', 'for the current review (saved preference).']) {
      const text = `${label}${label.includes(':') ? '' : ':'} ${mode} ${target}`;
      test(`one current full mode owns its target clause: ${text}`, () => {
        const f = clone();
        Object.assign(f.options.stateEvidence.records[0], { user_choice: mode, recommended: mode });
        message(f).text = text;
        expect(decide(f)?.option).toBe(mode);
      });
    }
  }
}

const invalidDeclarations = [
  'Decision: HOLD SCOPELESS for this draft.',
  'Decision: HOLD for this draft.',
  'Decision: SCOPE for this draft.',
  'Decision: SELECTIVE for this draft.',
  'Decision: review mode is CUSTOM MODE for this draft.',
  'Decision: HOLD SCOPE?',
  'Decision: HOLD SCOPE for',
  'Decision: HOLD SCOPE for (',
  'Decision: HOLD SCOPE for this draft (unfinished.',
  'Decision: HOLD SCOPE for this draft (unbalanced)).',
  'Decision: HOLD SCOPE for this draft or SCOPE EXPANSION.',
  'Decision: HOLD SCOPE for this draft. Instead choose SCOPE REDUCTION.',
  'Decision: HOLD SCOPE for this draft; SELECTIVE_EXPANSION.',
  'Decision: HOLD SCOPE for this draft, if approved.',
  'Decision: HOLD SCOPE for this draft, pending approval.',
  'Decision: HOLD SCOPE for this draft, not yet selected.',
  'Decision: HOLD SCOPE for this draft, withdrawn.',
  'Decision: HOLD SCOPE for this draft; the selected mode is not HOLD SCOPE.',
  'Decision: HOLD SCOPE for plan-eng-review.',
  'Decision: HOLD SCOPE for another draft.',
  'Decision: HOLD SCOPE for a future review.',
  'Decision: HOLD SCOPE for this future review.',
  'Decision pending: HOLD SCOPE for this draft.',
  'Decision: review mode is not selected.',
  'Decision: not HOLD SCOPE for this draft.',
];
for (const text of invalidDeclarations) {
  test(`unsupported current declaration cannot complete a decision: ${text}`, () => {
    const f = clone(); message(f).text = text;
    expect(decide(f)).toBeNull();
  });
  test(`unsupported current declaration retracts the earlier decision: ${text}`, () => {
    const f = clone(); message(f).text += `\n\nCorrection: ${text}`;
    expect(decide(f)).toBeNull();
  });
}

for (const prefix of ['> ', '    ', '"', '`']) {
  test(`quoted current-mode syntax does not declare or retract: ${JSON.stringify(prefix)}`, () => {
    const f = clone();
    const quote = (value: string) => prefix + value + (['"', '`'].includes(prefix) ? prefix : '');
    message(f).text = quote('Decision: HOLD SCOPE for this draft.');
    expect(decide(f)).toBeNull();
    message(f).text = clone().transcript.assistantMessages.at(-1).text + '\n\n' +
      quote('Decision: SCOPE EXPANSION for this draft.');
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
}
for (const text of [
  'Example:\nDecision: HOLD SCOPE for this draft.',
  'Historical transcript:\nDecision: HOLD SCOPE for this draft.',
  'Previous decision:\nDecision: HOLD SCOPE for this draft.',
  '```text\nDecision: HOLD SCOPE for this draft.\n```',
  'If approved, Decision: HOLD SCOPE for this draft.',
  'Not a decision: HOLD SCOPE for this draft.',
]) test(`unasserted declaration provides no mode: ${JSON.stringify(text)}`, () => {
  const f = clone(); message(f).text = text;
  expect(decide(f)).toBeNull();
});

for (const label of ['Decision', 'Decision: review mode is', 'Mode']) {
  test(`later matching current declaration retains the owned mode: ${label}`, () => {
    const f = clone(); message(f).text += `\n\nUpdate: ${label}${label.includes(':') ? '' : ':'} HOLD SCOPE for this draft.`;
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
  test(`later conflicting current declaration retracts the owned mode: ${label}`, () => {
    const f = clone(); message(f).text += `\n\nUpdate: ${label}${label.includes(':') ? '' : ':'} SCOPE EXPANSION for this draft.`;
    expect(decide(f)).toBeNull();
  });
}

test('a separately scoped non-mode decision does not retract the review mode', () => {
  const f = clone(); message(f).text += '\n\nDecision: publish the audit log.';
  expect(decide(f)?.option).toBe('HOLD SCOPE');
});

test('the completed native preference and log ACK retain their independent authority', () => {
  const f = clone(); delete f.options.stateEvidence;
  const result = decide(f);
  expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.stateRecord).toBeUndefined();
  expect(result?.preferenceToolUseId).toBeDefined();
  expect(result?.questionLogToolUseId).toBeDefined();
});

test('target-clause capitalization and a negative non-mode explanation remain valid', () => {
  const f = clone(); message(f).text = 'Decision: HOLD SCOPE For this draft, not for implementation.';
  expect(decide(f)?.option).toBe('HOLD SCOPE');
});

test('a named target must match the complete audit target, including dotted identifiers', () => {
  const f = clone();
  f.options.stateEvidence.records[0].question_summary = 'Select review mode for PLAN.md';
  message(f).text = 'Decision: HOLD SCOPE for PLAN.md.';
  expect(decide(f)?.option).toBe('HOLD SCOPE');
  message(f).text = 'Decision: HOLD SCOPE for PLAN.other.';
  expect(decide(f)).toBeNull();
});

for (const target of ['a future review', 'the previous review', 'another draft', 'the next invocation', 'an example plan']) {
  test(`even a matching audit cannot make an explicitly noncurrent target current: ${target}`, () => {
    const f = clone();
    f.options.stateEvidence.records[0].question_summary = `Select review mode for ${target}`;
    message(f).text = `Decision: HOLD SCOPE for ${target}.`;
    expect(decide(f)).toBeNull();
  });
}
for (const target of ['future.md', 'previous-review.md', 'another.plan.md']) {
  test(`owned literal filename remains a current target: ${target}`, () => {
    const f = clone();
    f.options.stateEvidence.records[0].question_summary = `Select review mode for ${target}`;
    message(f).text = `Decision: HOLD SCOPE for ${target}.`;
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
}

for (const [name, mutate] of Object.entries({
  'missing state and native log ACK': (f: any) => {
    delete f.options.stateEvidence;
    const log = f.tools.find((e: any) => e.kind === 'use' && e.input?.command?.includes('gstack-question-log'));
    f.tools = f.tools.filter((e: any) => e.kind !== 'result' || e.toolUseId !== log.toolUseId);
  },
  'empty owned log': (f: any) => { f.options.stateEvidence.records = []; },
  'duplicate owned log': (f: any) => { f.options.stateEvidence.records.push({ ...f.options.stateEvidence.records[0] }); },
  'wrong preference and native check': (f: any) => {
    f.options.stateEvidence.preference = 'always-ask';
    const check = f.tools.find((e: any) => e.kind === 'use' && e.input?.command?.includes('gstack-question-preference'));
    f.tools.find((e: any) => e.kind === 'result' && e.toolUseId === check.toolUseId).content = 'ASK\nEXIT: 0';
  },
  'foreign log session': (f: any) => { f.options.stateEvidence.records[0].session_id = 'foreign'; },
  'foreign log skill': (f: any) => { f.options.stateEvidence.records[0].skill = 'plan-eng-review'; },
  'different logged choice': (f: any) => { f.options.stateEvidence.records[0].user_choice = 'SCOPE EXPANSION'; },
  'different recommendation': (f: any) => { f.options.stateEvidence.records[0].recommended = 'SCOPE EXPANSION'; },
  'nonautomatic log': (f: any) => { f.options.stateEvidence.records[0].auto_decided = false; },
  'foreign native session': (f: any) => { f.options.sessionId = 'foreign'; },
  'failed preamble': (f: any) => { ack(f).isError = true; },
  'missing preamble ACK': (f: any) => { f.tools = f.tools.filter((e: any) => e !== ack(f)); },
  'duplicate preamble ACK': (f: any) => { f.tools.push({ ...ack(f) }); },
  'disabled tuning': (f: any) => { ack(f).content = ack(f).content.replace('QUESTION_TUNING: true', 'QUESTION_TUNING: false'); },
  'old log': (f: any) => { f.options.stateEvidence.records[0].ts = new Date(f.options.commandStartedAt - 1).toISOString(); },
  'future log': (f: any) => { f.options.stateEvidence.records[0].ts = new Date(f.options.now + 1).toISOString(); },
  'public decision before log': (f: any) => { message(f).timestamp = new Date(Date.parse(f.options.stateEvidence.records[0].ts) - 1).toISOString(); },
  'native question': (f: any) => { f.transcript.calls.push({ sessionId: f.options.sessionId }); },
  'prose question': (f: any) => { f.options.proseQuestionObserved = true; },
  'current withdrawal': (f: any) => { message(f).text += '\n\nI withdraw this decision.'; },
})) test(`current Decision syntax retains ${name} rejection`, () => {
  const f = clone(); mutate(f); expect(decide(f)).toBeNull();
});
