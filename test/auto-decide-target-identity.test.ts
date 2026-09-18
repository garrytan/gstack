import { expect, test } from 'bun:test';
import { findNativeAutoDecision } from './helpers/native-auto-decide';
import capture from './fixtures/auto-decide-target-361c.json';
const clone = () => structuredClone(capture) as any;
const message = (f: any) => f.transcript.assistantMessages.at(-1);
const decide = (f: any) => findNativeAutoDecision(f.transcript, f.tools, f.options);

test('actual quoted current title and completed owned audit produce the original mode decision', () => {
  const f = clone(), result = decide(f);
  expect(result?.option).toBe('HOLD SCOPE');
  expect(result?.annotation).toBe(message(f).text);
  expect(result?.stateRecord).toEqual(f.options.stateEvidence.records[0]);
  expect(result?.preambleToolUseId).toBe('toolu_01KbsH6ybJxbNozwbSXywVbb');
});

const title = 'deterministic skill-list ordering';
const modes = ['HOLD SCOPE', 'SCOPE EXPANSION', 'SELECTIVE EXPANSION', 'SCOPE REDUCTION'];
for (const mode of modes) for (const quote of [(s: string) => `"${s}"`, (s: string) => `“${s}”`, (s: string) => `\`${s}\``]) {
  for (const wrapper of ['', ' draft', ' plan']) test(`${mode} quoted title agrees with one audit wrapper: ${quote(title)}${wrapper}`, () => {
    const f = clone();
    Object.assign(f.options.stateEvidence.records[0], { user_choice: mode, recommended: mode, question_summary: `Select review mode for ${title}${wrapper}` });
    message(f).text = `Decision: ${mode} for ${quote(title)}.\n\nMode: ${mode}, auto-selected using the saved preference.`;
    expect(decide(f)?.option).toBe(mode);
    expect(decide(f)?.annotation).toBe(message(f).text);
  });
}
for (const [declared, recorded] of [
  [`"${title}" draft`, `"${title}"`],
  [`"${title}" plan`, `${title} draft`],
  [title, `${title} draft`],
  [`${title} draft`, title],
  ['"release plan"', 'release plan draft'],
  ['"what if ordering"', 'what if ordering draft'],
  ['"ordering v2. current"', '"ordering v2. current" draft'],
]) test(`exact title identity with syntactic wrapper: ${declared} / ${recorded}`, () => {
  const f = clone(); f.options.stateEvidence.records[0].question_summary = `Select mode for ${recorded}`;
  message(f).text = `Decision: HOLD SCOPE for ${declared}.`;
  expect(decide(f)?.option).toBe('HOLD SCOPE');
});

test('quoted target and mode labels remain case insensitive', () => {
  const f = clone(); message(f).text = `decision: hold scope FOR "${title}".`;
  expect(decide(f)?.option).toBe('HOLD SCOPE');
});

const negatives: Array<[string, string]> = [
  ['"deterministic skill-list sorting"', `${title} draft`],
  ['"skill-list ordering"', `${title} draft`],
  [`"${title}-v2"`, `${title} draft`],
  [`"${title} extra"`, `${title} draft`],
  ['"release"', '"release draft"'],
  ['"release draft"', '"release"'],
  ['"release plan"', 'release draft'],
  ['release plan', 'release draft'],
  ['"release draft plan"', 'release plan'],
  ['"release plan draft"', '"release plan"'],
  ['"draft release"', 'release'],
  ['""', 'draft'],
  ['"   "', 'plan'],
  [`"${title}" or "foreign"`, `${title} draft`],
  [`"${title}" and another plan`, `${title} draft`],
  [`"${title}`, `${title} draft`],
  [`${title}"`, `${title} draft`],
  ['"future plan"', 'future plan'],
  ['future', 'future plan'],
  ['previous', 'previous draft'],
  ['"previous draft"', 'previous draft'],
  ['"another draft"', 'another draft'],
  ['"next plan"', 'next plan'],
];
for (const [declared, recorded] of negatives) {
  test(`target cannot borrow a named or historical match: ${declared} / ${recorded}`, () => {
    const f = clone(); f.options.stateEvidence.records[0].question_summary = `Select mode for ${recorded}`;
    message(f).text = `Decision: HOLD SCOPE for ${declared}.`;
    expect(decide(f)).toBeNull();
  });
  test(`later agreeing Mode does not erase invalid target: ${declared} / ${recorded}`, () => {
    const f = clone(); f.options.stateEvidence.records[0].question_summary = `Select mode for ${recorded}`;
    message(f).text = `Decision: HOLD SCOPE for ${declared}.\n\nMode: HOLD SCOPE, auto-selected.`;
    expect(decide(f)).toBeNull();
  });
}

for (const wrap of [
  (s: string) => `"${s}"`, (s: string) => `“${s}”`, (s: string) => `\`${s}\``,
  (s: string) => `> ${s}`, (s: string) => `    ${s}`, (s: string) => `\`\`\`text\n${s}\n\`\`\``,
  (s: string) => `Example:\n${s}`, (s: string) => `Previous review:\n${s}`,
]) test(`only an asserted field can own a quoted target: ${wrap('Decision')}`, () => {
  const f = clone(); message(f).text = wrap(`Decision: HOLD SCOPE for "${title}".`);
  expect(decide(f)).toBeNull();
});

for (const value of [
  `HOLD SCOPE for "${title}" if approved`, `HOLD SCOPE for "${title}", pending approval`,
  `not HOLD SCOPE for "${title}"`, `HOLD SCOPE for "${title}"; SCOPE EXPANSION`,
  `HOLD SCOPE for "${title}" (withdrawn)`, `HOLD SCOPE for "${title}" (I will select it)`,
]) test(`quoted name cannot hide a lifecycle veto: ${value}`, () => {
  const f = clone(); message(f).text = `Decision: ${value}.\n\nMode: HOLD SCOPE.`;
  expect(decide(f)).toBeNull();
});
for (const suffix of [
  '\n\nCorrection: Mode: SCOPE EXPANSION.',
  '\n\nCorrection: I withdraw this decision.',
  `\n\nDecision: HOLD SCOPE for "foreign target".`,
  '\n\nMode pending: HOLD SCOPE.',
]) test(`a later contradiction remains effective: ${suffix}`, () => {
  const f = clone(); message(f).text += suffix; expect(decide(f)).toBeNull();
});
for (const [name, mutate] of Object.entries({
  'missing owned log': (f: any) => { f.options.stateEvidence.records = []; },
  'duplicate owned log': (f: any) => { f.options.stateEvidence.records.push({ ...f.options.stateEvidence.records[0] }); },
  'foreign audit session': (f: any) => { f.options.stateEvidence.records[0].session_id = 'foreign'; },
  'different audit choice': (f: any) => { f.options.stateEvidence.records[0].user_choice = 'SCOPE EXPANSION'; },
  'wrong preference': (f: any) => { f.options.stateEvidence.preference = 'ask'; },
  'missing preamble ACK': (f: any) => { f.tools = f.tools.filter((e: any) => !(e.kind === 'result' && e.toolUseId === 'toolu_01KbsH6ybJxbNozwbSXywVbb')); },
  'native question': (f: any) => { f.transcript.calls.push({sessionId:f.options.sessionId}); },
  'prose question': (f: any) => { f.options.proseQuestionObserved = true; },
  'decision before log': (f: any) => { message(f).timestamp = new Date(Date.parse(f.options.stateEvidence.records[0].ts) - 1).toISOString(); },
  'wrong native session': (f: any) => { f.options.sessionId = 'foreign'; },
  'future log': (f: any) => { f.options.stateEvidence.records[0].ts = new Date(f.options.now + 1).toISOString(); },
})) test(`actual quoted target retains ${name} boundary`, () => {
  const f = clone(); mutate(f); expect(decide(f)).toBeNull();
});
for (const preposition of ['for', 'FOR']) test(`a quoted lifecycle word belongs to its title with ${preposition}`, () => {
  const f = clone(); f.options.stateEvidence.records[0].question_summary = 'Select mode for Pending notifications draft';
  message(f).text = `Decision: HOLD SCOPE ${preposition} "Pending notifications".`;
  expect(decide(f)?.option).toBe('HOLD SCOPE');
});
