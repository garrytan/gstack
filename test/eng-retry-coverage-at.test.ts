import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
const calls = JSON.parse(readFileSync(new URL('./fixtures/eng-retry-coverage-at.json', import.meta.url), 'utf8')).calls as NativePlanQuestionCall[];
const report = readFileSync(new URL('./fixtures/eng-retry-baseline-at.md', import.meta.url), 'utf8');
const evaluate = (items: NativePlanQuestionCall[], text = '') => evaluateEngSeedCoverage({ status: 'ready', calls: items, assistantMessages: [] }, text, Date.parse('2026-09-10T19:00:00Z'), Date.parse('2026-09-10T20:00:00Z'));
const regression = (text: string) => evaluate([], text).regression;
const cache = calls[4]!;
function changeCache(change: (q: NativePlanQuestionCall['questions'][number]) => void) {
  const copy = structuredClone(cache), original = copy.questions[0]!.question;
  change(copy.questions[0]!);
  copy.answers = { [copy.questions[0]!.question]: copy.answers[original]! };
  return copy;
}
const declaration = report.match(/^### CRITICAL: regression test[^\n]+\n[\s\S]*?(?=\n### )/m)![0];
const strategy = report.match(/^## Worktree parallelization strategy\n[\s\S]*?(?=\n## )/m)![0];
const task = report.match(/^- \[ \] \*\*T5 .*\n(?:  .*(?:\n|$))*/m)![0];
const compact = '# Current reviewed plan\n\n## Tests\n\n' + declaration + '\n' + strategy + '\n## Implementation Tasks\n' + task;

test('exact acknowledged retry report and separate native decisions meet the existing gate', () => {
  expect(createHash('sha256').update(report).digest('hex')).toBe('1e3fb51fc9581f69ab61e544bc4da9c51d633fe76207f82b04a43601130126d2');
  expect(calls).toHaveLength(11);
  expect(evaluate(calls, report)).toMatchObject({ ok: true, missing: [], regression: 'plan', problems: [] });
  expect(evaluate([cache]).decisions).toEqual({ 'shared-cache': `${cache.sessionId}:${cache.toolUseId}` });
  expect(regression(compact)).toBe('plan');
});

test('cache subject and its same-option concrete repair stay bound', () => {
  for (const change of [
    (q: typeof cache.questions[number]) => { q.question = q.question.replace('Architecture issue 1:', 'Architecture issue 11:').replace('D5 —', 'D15 —'); },
    (q: typeof cache.questions[number]) => { q.question = q.question.replace(/^\[P1\].*\n/m, ''); },
    (q: typeof cache.questions[number]) => { q.question += '\n"Historical note: This finding is withdrawn."'; },
    (q: typeof cache.questions[number]) => { q.options[0]!.description = q.options[0]!.description!.replace('AuthBroker is the only', 'SessionMint is the only').replace('SessionMint reads', 'AuthBroker reads'); },
  ]) expect(evaluate([changeCache(change)]).decisions['shared-cache'], change.toString()).toBeDefined();
  for (const change of [
    (q: typeof cache.questions[number]) => { q.question = q.question.replace('two services write', 'two services might write'); },
    (q: typeof cache.questions[number]) => { q.question = q.question.replace('Two services writing the same cache entry at the same time is a race.', 'The cache has no current defect.'); },
    (q: typeof cache.questions[number]) => { q.question = q.question.replace('Project/branch/task:', 'Source:'); },
    (q: typeof cache.questions[number]) => { q.question = q.question.replace('ELI10:', 'ELI10: If approved,'); },
    (q: typeof cache.questions[number]) => { q.question += '\nCorrection: the cache is now serialized.'; },
    (q: typeof cache.questions[number]) => { q.options[0]!.description = q.options[0]!.description!.replace('SessionMint reads', 'AuthBroker reads'); },
    (q: typeof cache.questions[number]) => { q.options[0]!.description = q.options[0]!.description!.replace('is the only service that writes validated entries', 'continues writing alongside SessionMint'); },
    (q: typeof cache.questions[number]) => { q.options[0]!.description = q.options[0]!.description!.replace('the adapter rejects a write whose generation is stale', 'the adapter accepts stale writes'); },
    (q: typeof cache.questions[number]) => { q.options[1]!.description += '\n' + q.options[0]!.description; q.options[0]!.description = 'Choose a writer later.'; },
  ]) expect(evaluate([changeCache(change)]).decisions['shared-cache']).toBeUndefined();
});

test('current finding or offered-action withdrawals cannot supply cache coverage', () => {
  for (const status of ['withdrawn', 'no longer current', 'hypothetical', 'unproven']) for (const [open, close] of [['',''], ['"','"'], ["'","'"], ['“','”'], ['‘','’'], ['`','`']]) {
    for (const owner of ['This finding', 'D5']) expect(evaluate([changeCache(q => { q.question += `\nCorrection: ${owner} is ${open}${status}${close}.`; })]).decisions['shared-cache']).toBeUndefined();
    expect(evaluate([changeCache(q => { q.options[0]!.description += `\nThis action is ${open}${status}${close}.`; })]).decisions['shared-cache']).toBeUndefined();
  }
  for (const prefix of ['Source:', 'Once approved:', 'When approved:', 'Pending approval:']) expect(evaluate([changeCache(q => { q.options[0]!.description = prefix + '\n' + q.options[0]!.description; })]).decisions['shared-cache']).toBeUndefined();
});

test('native completion and one-decision identity gates stay mandatory', () => {
  for (const mutate of [
    (c: NativePlanQuestionCall) => { c.answered = false; }, (c: NativePlanQuestionCall) => { c.failed = true; },
    (c: NativePlanQuestionCall) => { c.answers = {}; }, (c: NativePlanQuestionCall) => { c.answers[c.questions[0]!.question] = 'unoffered'; },
    (c: NativePlanQuestionCall) => { c.answeredAt = '2026-09-09T19:44:30Z'; }, (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
    (c: NativePlanQuestionCall) => { c.sessionId = ''; }, (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
  ]) { const copy = structuredClone(cache); mutate(copy); expect(evaluate([copy]).decisions['shared-cache']).toBeUndefined(); }
  expect(evaluate([cache, cache]).decisions).toEqual({});
});

test('baseline task and module paths may be consistently renamed', () => {
  for (const value of [compact.replaceAll('T5', 'T15'), compact.replaceAll('auth/legacy-flow', 'auth/prior-flow'), compact.replaceAll('tests/auth', 'test/login'), compact.replace(/[`*]/g, ''), compact.replaceAll('legacy-flow.regression.test', 'prior-behavior.test.ts')]) expect(regression(value), value).toBe('plan');
});
const negatives: Array<[string, (text: string) => string]> = [
  ['missing declaration', text => text.replace(declaration, '')],
  ['optional heading', text => text.replace('regression rule, mandatory', 'regression rule, optional')],
  ['quoted declaration', text => text.replace(declaration, declaration.split('\n').map(line => '> ' + line).join('\n'))],
  ['fenced declaration', text => text.replace(declaration, '```\n' + declaration + '\n```')],
  ['historical owner', text => text.replace('## Tests', '## Historical Tests')],
  ['source ancestor', text => '# Source excerpt\n' + text.replace('# Current reviewed plan\n', '')],
  ['bare source owner', text => 'Source:\n\n' + text.replace('# Current reviewed plan\n', '')],
  ['conditional declaration', text => text.replace('What broke:', 'If approved, What broke:')],
  ['after rewrite capture', text => text.replace('Before any rewrite:', 'After the rewrite:')],
  ['missing returned claims', text => text.replace('the exact claims returned and ', '')],
  ['missing error oracle', text => text.replace('the exact error for each\n  failure case', 'an unspecified response for each\n  failure case')],
  ['missing malformed token case', text => text.replace(', malformed token', '')],
  ['different shadow fixtures', text => text.replace('The same fixture set', 'A different fixture set')],
  ['missing strategy', text => text.replace(strategy, '')],
  ['historical strategy', text => text.replace('## Worktree parallelization strategy', '## Historical worktree parallelization strategy')],
  ...['If approved:', 'Assuming approval,', 'Source:'].map(prefix => [`strategy ${prefix}`, (text: string) => text.replace('| Step |', prefix + '\n| Step |')] as [string, (text: string) => string]),
  ['missing read-only baseline', text => text.replace('auth/legacy-flow (read)', 'auth/legacy-flow')],
  ['rewrite not gated', text => text.replace('| T1, T5 |', '| T1 |')],
  ['baseline follows rewrite', text => text.replace('| T5 legacy regression test | auth/legacy-flow (read), tests/auth | — |', '| T5 legacy regression test | auth/legacy-flow (read), tests/auth | T3 |')],
  ['unrelated baseline module', text => text.replace('auth/legacy-flow (read)', 'auth/unrelated (read)')],
  ['wrong strategy task', text => text.replace('| T5 legacy regression test', '| T99 legacy regression test')],
  ['missing task', text => text.replace(task, '')],
  ['wrong task file', text => text.replace('  - Files: tests/auth/legacy-flow.regression.test', '  - Files: tests/auth/other.test')],
  ['duplicate task', text => text.replace(task, task + task)],
  ['duplicate file', text => text.replace('  - Files:', '  - Files: tests/auth/other.test\n  - Files:')],
  ['wrong baseline task', text => text.replace('**T5 (', '**T99 (')],
  ['missing verification', text => text.replace(/^  - Verify:.*$/m, '')],
  ['changed code only', text => text.replace('against unmodified legacy', 'against rewritten legacy')],
  ['new path only', text => text.replace('against unmodified legacy', 'against AuthBroker only')],
  ['neighbor verification', text => text.replace('  - Verify:', '- [ ] T99 — tests — Another suite\n  - Verify:')],
  ...['Source:', 'If approved:', 'Assuming approval,', 'Provided approval,', 'Once approved:', 'When approved:', 'Pending approval:'].flatMap(prefix => [
    [`task ${prefix}`, (text: string) => text.replace(task, prefix + '\n' + task)],
    [`verification ${prefix}`, (text: string) => text.replace('  - Verify:', '  ' + prefix + '\n  - Verify:')],
  ] as Array<[string, (text: string) => string]>),
  ...['withdrawn', 'declined', 'optional', 'superseded', 'not current', 'no longer current'].flatMap(status => [
    [`current task ${status}`, (text: string) => text + `\n## Current assessment\nT5 baseline requirement is ${status}.\n`],
    [`scalar task ${status}`, (text: string) => text + `\n## Current assessment\nT5 baseline requirement is "${status}".\n`],
  ] as Array<[string, (text: string) => string]>),
  ['current status row', text => text + '\n## Current assessment\n| T5 | Withdrawn |\n'],
  ['explicit changed-before-baseline correction', text => text + '\n## Current assessment\nlegacyAuthFlow() is rewritten before T5.\n'],
];
test.each(negatives)('%s supplies no mandatory legacy baseline', (_, change) => {
  const altered = change(compact); expect(altered).not.toBe(compact); expect(regression(altered)).toBeUndefined();
});
test('historical quotations and other tasks cannot withdraw this baseline', () => {
  for (const tail of ['\n## History\n"T5 baseline requirement is withdrawn."', "\n## History\n'T5 baseline requirement is withdrawn.'", '\n## History\n> T5 baseline requirement is withdrawn.', '\n## Historical task status\n| T5 | Withdrawn |', '\n## Current assessment\n| T9 | Withdrawn |', '\n## Payment regression suite\nThe regression suite is withdrawn.', '\n## Current assessment\nIf T5 is withdrawn, reopen the decision.']) expect(regression(compact + tail)).toBe('plan');
});
test('new fixtures and controls select only the Eng finding-count workflow', () => {
  for (const file of ['test/eng-retry-coverage-at.test.ts', 'test/fixtures/eng-retry-coverage-at.json', 'test/fixtures/eng-retry-baseline-at.md']) expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(file)).map(([name]) => name)).toEqual(['plan-eng-finding-count']);
});

// An ordinary semicolon keeps the same current status owner.
test('semicolon-boundary scalar withdrawals remain current for cache and baseline', () => {
  for (const [open, close] of [['"','"'], ["'","'"], ['“','”'], ['‘','’'], ['`','`']]) for (const status of ['withdrawn', 'no longer current']) {
    expect(evaluate([changeCache(q => { q.question += `; This finding is ${open}${status}${close}.`; })]).decisions['shared-cache']).toBeUndefined();
    expect(evaluate([changeCache(q => { q.options[0]!.description += `; This option is ${open}${status}${close}.`; })]).decisions['shared-cache']).toBeUndefined();
    expect(regression(compact + `\n## Current assessment\nAssessment complete; T5 is ${open}${status}${close}.\n`)).toBeUndefined();
  }
});
