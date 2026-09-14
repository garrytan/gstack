import { expect, test } from 'bun:test';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES } from './helpers/touchfiles';
import type { NativePlanQuestion, NativePlanQuestionCall } from './helpers/plan-count-transcript';
import fixture from './fixtures/eng-owned-explanation.json';

const seeds = ['complexity', 'swallowed-errors', 'sequential-idp'] as const;
const evaluate = (calls: NativePlanQuestionCall[] = [], plan = '') =>
  evaluateEngSeedCoverage({ status: 'ready', calls, assistantMessages: [] }, plan, 0, 10);
function decision(i: number, change: (q: NativePlanQuestion) => void = () => {}) {
  const q = structuredClone(fixture.questions[i]!) as NativePlanQuestion;
  change(q);
  return { sessionId: 'one-session', toolUseId: `decision-${i}`, questions: [q],
    answered: true, failed: false, unansweredQuestionIndices: [], answeredAt: new Date(5).toISOString(),
    answers: { [q.question]: q.options[0]!.label } } satisfies NativePlanQuestionCall;
}

test.each([0, 1, 2])('a current explanation and one concrete offered repair own seed %i', i => {
  expect(evaluate([decision(i)]).decisions[seeds[i]!]).toBe(`one-session:decision-${i}`);
});

test.each([0, 1, 2])('equivalent title, ordinal, formatting and offered answer preserve seed %i', i => {
  const titles = ['Which auth components should we retain?', 'Which error boundary should validateAndDispatch() use?', 'How should we schedule the IDP calls?'];
  const c = decision(i, q => { q.question = q.question.replace(/^D\d+ — .*$/m, `D17 — ${titles[i]}`); });
  for (const option of c.questions[0]!.options) {
    c.answers[c.questions[0]!.question] = option.label;
    expect(evaluate([c]).decisions[seeds[i]!]).toBeDefined();
  }
  expect(evaluate([decision(i, q => { q.question = q.question.replaceAll('validateAndDispatch()', '`validateAndDispatch()`'); })]).decisions[seeds[i]!]).toBeDefined();
  expect(evaluate([decision(i, q => { q.question = q.question.replace('ELI10: ', '[P1] Current finding\nELI10: '); })]).decisions[seeds[i]!]).toBeDefined();
});

const questionControls: Array<[string, (s: string) => string]> = [
  ['missing metadata', s => s.replace(/^Project\/branch\/task:.*\n/m, '')],
  ['missing explanation', s => s.replace(/^ELI10:.*\n/m, '')],
  ['unrelated explanation', s => s.replace(/^ELI10:.*$/m, 'ELI10: This asks about naming conventions.')],
  ['duplicate explanation', s => s + '\nELI10: Another finding.'],
  ['duplicate metadata', s => s + '\nProject/branch/task: a different task.'],
  ['two severity lines', s => s.replace('ELI10: ', '[P1] First finding\n[P2] Second finding\nELI10: ')],
  ['source severity line', s => s.replace('ELI10: ', '[P1] Source: borrowed priority\nELI10: ')],
  ['quoted explanation', s => s.replace(/^ELI10: (.*)$/m, 'ELI10: "$1"')],
  ['literal explanation', s => s.replace(/^ELI10: (.*)$/m, 'ELI10: `$1`')],
  ['source explanation', s => s.replace('ELI10: ', 'ELI10: Source: ')],
  ['copied source explanation', s => s.replace('ELI10: ', 'ELI10: Copied source excerpt. ')],
  ['historical metadata', s => s.replace('Project/branch/task: ', 'Project/branch/task: Historical assessment. ')],
  ['quoted title', s => s.replace(/^(D\d+ — )(.*)$/m, '$1"$2"')],
  ['literal title', s => s.replace(/^(D\d+ — )(.*)$/m, '$1`$2`')],
  ['historical title', s => s.replace(/^(D\d+ — )/m, '$1Historical: ')],
  ['conditional explanation', s => s.replace('ELI10: ', 'ELI10: If approved, ')],
  ['withdrawn finding', s => s + '\nCorrection: This finding is withdrawn.'],
  ['quoted inactive status', s => s + '\nThis finding is "withdrawn".'],
  ['whole quotation', s => s.split('\n').map(l => '> ' + l).join('\n')],
  ['whole fence', s => '```\n' + s + '\n```'],
  ['defect only in stakes', s => s.replace(/^ELI10: (.*)$/m, 'ELI10: We are considering names.\nStakes: $1')],
];
test.each(questionControls)('%s cannot supply an explained decision', (_, change) => {
  for (let i = 0; i < seeds.length; i++) {
    const c = decision(i, q => { const before = q.question; q.question = change(before); expect(q.question).not.toBe(before); });
    expect(evaluate([c]).decisions[seeds[i]!]).toBeUndefined();
  }
});

test.each([0, 1, 2])('repair ownership and native completion remain required for seed %i', i => {
  for (const wrap of [(s: string) => `Source: ${s}`, (s: string) => `"${s}"`, (s: string) => `${s}\nThis option is withdrawn.`]) {
    const c = decision(i, q => { q.options = q.options.map(o => ({ label: wrap(o.label), description: wrap(o.description ?? '') })); });
    expect(evaluate([c]).decisions[seeds[i]!]).toBeUndefined();
  }
  const c = decision(i); c.answered = false;
  expect(evaluate([c]).decisions[seeds[i]!]).toBeUndefined();
  const splitRepairs = [
    [{ label: 'Reduce scope', description: 'Remove extra components.' }, { label: 'Keep shape', description: 'Keep AuthBroker, SessionMint and injected AuthCache over one backing store.' }],
    [{ label: 'Flatten into named helpers', description: 'Use a typed boundary.' }, { label: 'Keep nesting', description: 'One catch maps errors to 401 and rethrows unknowns.' }],
    [{ label: 'Promise.all', description: 'Discuss a name.' }, { label: 'Keep request schedule', description: 'Five calls with cancellation of siblings.' }],
  ];
  expect(evaluate([decision(i, q => { q.options = splitRepairs[i]!; })]).decisions[seeds[i]!]).toBeUndefined();
});

test('a combined native decision cannot supply three distinct seed decisions', () => {
  const c = decision(0);
  c.questions = [0, 1, 2].map(i => decision(i).questions[0]!);
  c.answers = Object.fromEntries(c.questions.map(q => [q.question, q.options[0]!.label]));
  expect(evaluate([c]).decisions).toEqual({});
});

// Minimal mandatory declaration and T1 task excerpt from the acknowledged final
// report. The complete retained report is used only for a private local replay.
const report = `# Current reviewed plan
### REGRESSION RULE (mandatory, no decision required)

**CRITICAL — T1:** write characterization (golden) tests for \`legacyAuthFlow()\`
BEFORE any rewrite. Corpus: valid token, expired token, revoked token, wrong
audience, wrong issuer, unknown tenant, suspended tenant, policy version
mismatch, malformed token, cache hit vs miss. Run the same corpus against the
\`AuthBroker\` path. Both must produce identical results before the flag opens to
any tenant. This test is authorized by the regression rule itself.

## Implementation Tasks
- [ ] **T1 (P1, human: ~1 day / CC: ~30 min)** — legacyAuthFlow — Write characterization (golden) tests for \`legacyAuthFlow()\` before touching it
  - Surfaced by: Test review — REGRESSION RULE, PLAN.md:27-28
  - Files: test/auth/legacy-auth-flow.characterization.test.ts
  - Verify: suite passes against legacy; later passes unchanged against AuthBroker
`;

test('mandatory declaration and unique task bind the old baseline to unchanged new-path parity', () => {
  expect(evaluate([], report).regression).toBe('plan');
  for (const change of [
    (s: string) => s.replaceAll('T1', 'T17'),
    (s: string) => s.replace('Corpus: ', 'T1 is mandatory. Corpus: '),
    (s: string) => s.replaceAll('test/auth/legacy-auth-flow.characterization.test.ts', 'spec/compatibility.test.js'),
    (s: string) => s.replaceAll('AuthBroker', 'ReplacementBroker'),
    (s: string) => s.replace('REGRESSION RULE (mandatory, no decision required)', 'Required characterization (mandatory)').replace('Implementation Tasks', 'Execution checklist'),
    (s: string) => s.replace('Run the same corpus against the', 'Replay the same corpus through the').replace('produce identical results', 'return matching outputs').replace('later passes unchanged against', 'then is green unchanged on'),
    (s: string) => s + '\n## History\nT1 is withdrawn.\n',
    (s: string) => s + '\n## Current assessment\n"T1 is withdrawn."\n',
    (s: string) => s + '\n## Payment regression suite\nThe regression suite is withdrawn.\n',
  ]) expect(evaluate([], change(report)).regression).toBe('plan');
});

const regressionControls: Array<[string, (s: string) => string]> = [
  ['missing declaration', s => s.replace(/### [\s\S]*?(?=## Implementation Tasks)/, '')],
  ['optional declaration', s => s.replace('mandatory', 'optional')],
  ['conditional declaration', s => s.replace('mandatory', 'mandatory if approved')],
  ['missing legacy subject', s => s.replaceAll('legacyAuthFlow', 'otherAuthFlow')],
  ['late declaration baseline', s => s.replace('BEFORE any rewrite', 'AFTER any rewrite')],
  ['late task baseline', s => s.replace('before touching it', 'after touching it')],
  ['missing task', s => s.replace(/- \[ \][\s\S]*/, '')],
  ['wrong task ID', s => s.replace('**T1 (P1', '**T9 (P1')],
  ['distinct declaration task IDs', s => s.replace('Corpus: ', 'T9 owns this corpus. Corpus: ')],
  ['duplicate task ID', s => s + s.slice(s.indexOf('- [ ]'))],
  ['duplicate declaration', s => s + s.slice(s.indexOf('### '), s.indexOf('## Implementation Tasks'))],
  ['missing file', s => s.replace(/^  - Files:.*\n/m, '')],
  ['two files', s => s.replace('.test.ts', '.test.ts, test/other.test.ts')],
  ['conflicting declared file', s => s.replace('Corpus: ', 'File: test/other.test.ts. Corpus: ')],
  ['missing verification', s => s.replace(/^  - Verify:.*\n/m, '')],
  ['foreign baseline', s => s.replace('passes against legacy;', 'passes against otherAuthFlow;')],
  ['foreign rewrite', s => s.replace('unchanged against AuthBroker', 'unchanged against OtherBroker')],
  ['ambiguous rewrite', s => s.replace('Both must', 'Run the same corpus against OtherBroker path. Both must')],
  ['new suite', s => s.replace('passes unchanged against', 'passes after updating expectations against')],
  ['missing parity', s => s.replace('Both must produce identical results', 'Both produce different results')],
  ['different corpus', s => s.replace('Run the same corpus', 'Run a new corpus')],
  ['quoted declaration', s => s.replace(/(### [^\n]+\n)([\s\S]*?)(?=\n## Implementation Tasks)/, '$1"$2"')],
  ['fenced report', s => '```\n' + s + '\n```'],
  ['historical report', s => s.replace('Current reviewed plan', 'Historical reviewed plan')],
  ['source declaration', s => s.replace('**CRITICAL', 'Source:\n**CRITICAL')],
  ['conditional task', s => s.replace('## Implementation Tasks\n', '## Implementation Tasks\nOnce approved,\n')],
  ['source task', s => s.replace('## Implementation Tasks\n', '## Implementation Tasks\nSource:\n')],
  ['withdrawn task', s => s + '\n## Current assessment\nT1 is withdrawn.\n'],
  ['cancelled verification', s => s + '\n## Current assessment\nT1 verification is optional.\n'],
  ['quoted status', s => s + '\n## Current assessment\nT1 is "withdrawn".\n'],
  ['changed before baseline', s => s + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T1.\n'],
  ['late baseline correction', s => s + '\n## Current assessment\nRun T1 only after rewriting legacyAuthFlow().\n'],
  ['changed expectations', s => s + '\n## Current assessment\nUpdate T1 expectations to match the new path.\n'],
  ['changed suite expectations', s => s + '\n## Current assessment\nThe legacy regression suite expectations will be updated to match the new path.\n'],
];
test.each(regressionControls)('%s cannot supply the linked baseline', (_, change) => {
  const changed = change(report);
  expect(changed).not.toBe(report);
  expect(evaluate([], changed).regression).toBeUndefined();
});

// The retry states the unchanged-code baseline in its file-bound task's Verify
// line. Retain only that task and its mandatory declaration, not the full report.
const retryReport = `# Current reviewed plan
### CRITICAL regression (mandatory, regression rule)
\`legacyAuthFlow()\` is existing behavior being rewritten with no test of its prior behavior (PLAN.md:27-28).
Add \`test/auth/legacyAuthFlow.characterization.test.ts\` pinning current outputs for: valid token, expired token,
revoked token, wrong audience, wrong issuer, suspended tenant, malformed token. It must pass before and after
this refactor, and the shadow compare asserts \`AuthBroker\` agrees with it.

## Implementation Tasks
- [ ] **T2 (P1, human: ~4h / CC: ~10 min)** — legacyAuthFlow — Characterization suite pinning prior behavior (CRITICAL regression)
  - Surfaced by: Test review, regression rule — PLAN.md:27-28
  - Files: test/auth/legacyAuthFlow.characterization.test.ts
  - Verify: suite passes on main before any refactor commit, and after
`;

test('a file-bound task can carry its own pre-commit baseline and retained-output parity', () => {
  for (const change of [
    (s: string) => s,
    (s: string) => s.replaceAll('T2', 'T19').replaceAll('AuthBroker', 'ReplacementBroker'),
    (s: string) => s.replaceAll('test/auth/legacyAuthFlow.characterization.test.ts', 'spec/compatibility.test.js'),
    (s: string) => s.replace('Implementation Tasks', 'Execution checklist'),
    (s: string) => s.replace('passes on main before any refactor commit', 'green against the untouched code before the rewrite commit').replace('asserts', 'verifies').replace('agrees with', 'matches'),
    (s: string) => s + '\n## Payment regression suite\nThe regression suite expectations will be updated.\n',
  ]) expect(evaluate([], change(retryReport)).regression).toBe('plan');
});

test.each([
  ['missing capture', (s: string) => s.replace('pinning current outputs', 'describing current outputs')],
  ['future outputs', (s: string) => s.replace('pinning current outputs', 'pinning new outputs')],
  ['missing required parity', (s: string) => s.replace('asserts `AuthBroker` agrees with it', 'describes AuthBroker')],
  ['foreign file', (s: string) => s.replace('  - Files: test/auth/legacyAuthFlow.characterization.test.ts', '  - Files: test/other.test.ts')],
  ['ambiguous file task', (s: string) => s + s.slice(s.indexOf('- [ ]')).replace('T2', 'T19')],
  ['ambiguous parity target', (s: string) => s.replace('agrees with it.', 'agrees with it. It also asserts OtherBroker matches it.')],
  ['unbound branch baseline', (s: string) => s.replace('on main', 'on the rewritten branch')],
  ['baseline after refactor commit', (s: string) => s.replace('main before any refactor commit', 'main after any refactor commit')],
  ['baseline before rollout only', (s: string) => s.replace('refactor commit', 'rollout commit')],
  ['missing after check', (s: string) => s.replace(', and after', '')],
  ['source task', (s: string) => s.replace('## Implementation Tasks\n', '## Implementation Tasks\nSource:\n')],
  ['conditional verification', (s: string) => s.replace('Verify: ', 'Verify: If approved, ')],
  ['withdrawn task', (s: string) => s + '\n## Current assessment\nT2 is withdrawn.\n'],
  ['rewritten before baseline', (s: string) => s + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T2.\n'],
  ['changed expectations', (s: string) => s + '\n## Current assessment\nUpdate T2 expectations to match the new path.\n'],
] as Array<[string, (s: string) => string]>)('%s cannot provide a pre-commit baseline', (_, change) => {
  const changed = change(retryReport);
  expect(changed).not.toBe(retryReport);
  expect(evaluate([], changed).regression).toBeUndefined();
});

test('the explanation regression selects the existing Eng finding-count workflow', () => {
  for (const path of ['test/eng-owned-explanation.test.ts', 'test/fixtures/eng-owned-explanation.json']) {
    expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(path)).map(([name]) => name))
      .toEqual(['plan-eng-finding-count']);
  }
});
