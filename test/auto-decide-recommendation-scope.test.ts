import { expect, test } from 'bun:test';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import capture from './fixtures/auto-decide-recommendation-361c.json';

const clone = () => structuredClone(capture) as any;
const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);
const message = (f: any) => f.transcript.assistantMessages.find((m: any) =>
  m.timestamp === '2026-09-17T02:23:11.495Z');

test('actual completed mode and recommendation commentary match the retained owned audit', () => {
  const f = clone(), result = decide(f);
  expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.annotation).toBe(message(f).text);
  expect(result?.stateRecord).toEqual(f.options.stateEvidence.records[0]);
  expect(result?.preambleToolUseId).toBe('toolu_01Ni4b9NZeiexmcAz1jRTUa4');
});

const modes = ['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'];
for (const mode of modes) for (const commentary of [
  'recommendation would have been the same',
  'my recommendation might differ without the saved preference',
  `the recommendation would still be ${mode}`,
  'our recommendation will remain unchanged',
  'recommendation stays the same unless the product context changes',
]) test(`completed ${mode} is separate from ${commentary}`, () => {
  const f = clone();
  Object.assign(f.options.stateEvidence.records[0], { user_choice: mode, recommended: mode });
  message(f).text = `Decision: review mode is ${mode} (${commentary}).`;
  expect(decide(f)?.option).toBe(mode);
});

for (const separator of ['; ', ', ', '. ', ' — ', ' – ', ' - ', ' (']) {
  test(`recommendation assertion has an explicit boundary: ${JSON.stringify(separator)}`, () => {
    const f = clone();
    message(f).text = `Mode: HOLD SCOPE${separator}recommendation would have been unchanged${separator === ' (' ? ')' : ''}.`;
    expect(decide(f)?.option).toBe('HOLD SCOPE');
  });
}

const uncertain = [
  'Mode: would choose HOLD SCOPE.',
  'Mode: HOLD SCOPE if approved.',
  'Mode: HOLD SCOPE unless you object.',
  'Mode: HOLD SCOPE (I will make this selection).',
  'Mode: HOLD SCOPE (this choice might change).',
  'Mode: HOLD SCOPE (recommendation would be the same; if approved).',
  'Mode: HOLD SCOPE (recommendation would be the same, unless you object).',
  'Mode: HOLD SCOPE (recommendation would be the same and I will select it later).',
  'Mode: HOLD SCOPE (recommendation would be the same but the choice might change).',
  'Mode: HOLD SCOPE (recommendation would be the same while we would still need approval).',
  'Mode: HOLD SCOPE (recommendation would be the same; selection is pending).',
  'Mode: HOLD SCOPE (recommendation says the decision would be conditional).',
  'Mode: HOLD SCOPE (recommendation would still be SCOPE EXPANSION).',
  'Mode: HOLD SCOPE (recommendation would be unchanged). Not yet selected.',
  'Mode: HOLD SCOPE (recommendation would be unchanged). This decision is withdrawn.',
  'Mode pending: HOLD SCOPE (recommendation would be unchanged).',
  'Mode: not HOLD SCOPE (recommendation would be unchanged).',
  'Mode: HOLD SCOPE for a future review (recommendation would be unchanged).',
  'Mode: HOLD SCOPE for another draft (recommendation would be unchanged).',
  'Mode: HOLD SCOPELESS (recommendation would be unchanged).',
  'Mode: HOLD SCOPE (recommendation would be unchanged.',
];
for (const text of uncertain) {
  test(`commentary does not authenticate an uncertain choice: ${text}`, () => {
    const f = clone(); message(f).text = text;
    expect(decide(f)).toBeNull();
  });
  test(`later uncertain choice retracts the original completed decision: ${text}`, () => {
    const f = clone(); message(f).text += `\n\nCorrection: ${text}`;
    expect(decide(f)).toBeNull();
  });
}

for (const [name, wrap] of [
  ['quoted', (s: string) => `> ${s}`],
  ['indented', (s: string) => `    ${s}`],
  ['fenced', (s: string) => `\`\`\`text\n${s}\n\`\`\``],
  ['historical', (s: string) => `Previous decision:\n${s}`],
  ['example', (s: string) => `Example:\n${s}`],
] as const) test(`recommendation commentary cannot authenticate ${name} declarations`, () => {
  const f = clone(); message(f).text = wrap('Mode: HOLD SCOPE (recommendation would be unchanged).');
  expect(decide(f)).toBeNull();
});

for (const [name, mutate] of Object.entries({
  'missing owned log': (f: any) => { f.options.stateEvidence.records = []; },
  'duplicate owned log': (f: any) => { f.options.stateEvidence.records.push({ ...f.options.stateEvidence.records[0] }); },
  'foreign audit session': (f: any) => { f.options.stateEvidence.records[0].session_id = 'foreign'; },
  'different selected choice': (f: any) => { f.options.stateEvidence.records[0].user_choice = 'SCOPE EXPANSION'; },
  'different recommendation': (f: any) => { f.options.stateEvidence.records[0].recommended = 'SCOPE EXPANSION'; },
  'nonautomatic record': (f: any) => { f.options.stateEvidence.records[0].auto_decided = false; },
  'foreign native session': (f: any) => { f.options.sessionId = 'foreign'; },
  'missing successful preamble': (f: any) => { f.tools = f.tools.filter((e: any) => e.toolUseId !== 'toolu_01Ni4b9NZeiexmcAz1jRTUa4'); },
  'future audit': (f: any) => { f.options.stateEvidence.records[0].ts = new Date(f.options.now + 1).toISOString(); },
  'decision before completed log': (f: any) => { message(f).timestamp = new Date(Date.parse(f.options.stateEvidence.records[0].ts) - 1).toISOString(); },
  'surfaced native question': (f: any) => { f.transcript.calls.push({ sessionId: f.options.sessionId }); },
  'surfaced prose question': (f: any) => { f.options.proseQuestionObserved = true; },
})) test(`actual recommendation commentary retains ${name} rejection`, () => {
  const f = clone(); mutate(f); expect(decide(f)).toBeNull();
});
