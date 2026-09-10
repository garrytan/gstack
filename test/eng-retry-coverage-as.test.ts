import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fixture from './fixtures/eng-retry-coverage-as.json';
import { evaluateEngSeedCoverage } from './helpers/eng-seeded-coverage';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const report = readFileSync(new URL('./fixtures/eng-retry-baseline-as.md', import.meta.url), 'utf8');
const transcript = (): PlanCountTranscript => ({ status: 'ready', calls: structuredClone(fixture.calls) as NativePlanQuestionCall[], assistantMessages: [] });
const check = (t = transcript(), plan = report) => evaluateEngSeedCoverage(t, plan, 0, Date.parse('2026-09-11T00:00:00Z'));
const targets = [[0, 'complexity'], [1, 'shared-cache'], [3, 'swallowed-errors']] as const;
function change(t: PlanCountTranscript, i: number, fn: (q: NativePlanQuestionCall['questions'][number]) => void) {
  const c = t.calls[i]!, q = c.questions[0]!, selected = q.options.findIndex(o => o.label === c.answers![q.question]);
  fn(q); c.answers = { [q.question]: q.options[selected]!.label };
}
const declaration = report.match(/^## Tests \(revised[^\n]+\n[\s\S]*?(?=\nCoverage target:)/m)![0];
const strategy = report.match(/^## Worktree parallelization strategy\n[\s\S]*?(?=\n## Implementation Tasks)/m)![0];
const task = report.match(/^- \[ \] \*\*T1 .*\n(?:  .*(?:\n|$))*/m)![0];
const compact = '# Current reviewed plan\n\n' + declaration + '\n' + strategy + '\n## Implementation Tasks\n' + task;
const baseline = (plan: string) => check({ status: 'ready', calls: [], assistantMessages: [] }, plan).regression;

describe('Eng retry decisions with owned explanations and concrete repairs', () => {
  test('the exact nine completed native calls and report supply all required coverage', () => {
    const t = transcript(), unchanged = JSON.stringify(t), result = check(t);
    expect(t.calls).toHaveLength(9); expect(result.ok).toBe(true); expect(result.missing).toEqual([]); expect(result.regression).toBe('plan');
    for (const [i, seed] of targets) expect(result.decisions[seed]).toBe(`${t.calls[i]!.sessionId}:${t.calls[i]!.toolUseId}`);
    expect(JSON.stringify(t)).toBe(unchanged); expect(fixture.provenance.paidOutcomeReclassified).toBe(false);
    expect(createHash('sha256').update(report).digest('hex')).toBe('2e4c618d441c463f866aa4bcb10706d59c14236352c1c5c07afc4a0e01874a0d');
  });
  test('separate completed decisions count for every offered answer and equivalent ordinals', () => {
    for (const [i, seed] of targets) for (let answer = 0; answer < 3; answer++) {
      const t = transcript(), c = t.calls[i]!, q = c.questions[0]!; c.answers = { [q.question]: q.options[answer]!.label };
      expect(check(t).decisions[seed]).toBeDefined();
    }
    for (const [i, seed] of targets) {
      const t = transcript(); change(t, i, q => { q.question = q.question.replace(/^D\d+/, 'D31'); });
      expect(check(t).decisions[seed]).toBeDefined();
      t.calls.splice(i, 1); expect(check(t).decisions[seed]).toBeUndefined();
    }
  });
  test('the current subject and its own explanation must assert the gap', () => {
    for (const [i, seed] of targets) for (const transform of [
      (s: string) => 'Source:\n' + s, (s: string) => '> ' + s, (s: string) => '```\n' + s + '\n```',
      (s: string) => s.replace('ELI10: ', 'ELI10: Source excerpt: '),
      (s: string) => s.replace('ELI10: ', 'ELI10: If approved, '),
      (s: string) => s.replace('Project/branch/task: ', 'Project/branch/task: Historical assessment: '),
      (s: string) => s.replace(/^ELI10:.*$/m, 'ELI10: This behavior already works; there is no current defect.'),
      (s: string) => s.replace(/\nELI10:/, '\nSource:\nELI10:'),
    ]) { const t = transcript(); change(t, i, q => { q.question = transform(q.question); }); expect(check(t).decisions[seed]).toBeUndefined(); }
    const t = transcript(); change(t, 3, q => { q.question = q.question.replace('each catch swallows a different error class', 'each catch propagates its error class'); });
    expect(check(t).decisions['swallowed-errors']).toBeUndefined();
  });
  test('same-decision withdrawal wins, while quoted history and another ordinal do not', () => {
    for (const [i, seed] of targets) for (const status of ['withdrawn', 'superseded', 'hypothetical', 'unproven', 'not current', 'no longer current']) {
      for (const scalar of [status, `"${status}"`, `'${status}'`, '`' + status + '`']) {
        const t = transcript(); change(t, i, q => { q.question += `\nCorrection: This finding is ${scalar}.`; }); expect(check(t).decisions[seed]).toBeUndefined();
      }
      const t = transcript(); change(t, i, q => { q.question += `\nD${i + 1} is ${status}.`; }); expect(check(t).decisions[seed]).toBeUndefined();
    }
    for (const [i, seed] of targets) for (const tail of ['\nD39 is withdrawn.', '\n> This finding is withdrawn.', '\nArchived note: "This finding is withdrawn."', '\nAn archived review recorded this finding is "withdrawn".']) {
      const t = transcript(); change(t, i, q => { q.question += tail; }); expect(check(t).decisions[seed]).toBeDefined();
    }
  });
  test('repairs belong to current native options, not quoted or narrated recommendations', () => {
    for (const [i, seed] of targets) for (const mode of ['source', 'conditional', 'quoted', 'withdrawn', 'hypothetical', 'unproven', 'not current', 'no longer current', 'navigation']) {
      const t = transcript(); change(t, i, q => { q.options.forEach((o, n) => {
        if (mode === 'source') o.description = 'Source: ' + o.description;
        else if (mode === 'conditional') o.description = 'If approved, ' + o.description;
        else if (mode === 'quoted') { o.label = '"' + o.label + '"'; o.description = '"' + o.description + '"'; }
        else if (mode === 'navigation') { o.label = `Continue ${n}`; o.description = 'Move to the next section.'; }
        else o.description += `\nThis option is "${mode}".`;
      }); }); expect(check(t).decisions[seed]).toBeUndefined();
    }
    const t = transcript(); change(t, 1, q => { q.options[0]!.description = q.options[0]!.description!.replace('SessionMint writes', 'BillingService writes'); q.options[1]!.description = q.options[1]!.description!.replace('SessionMint writes', 'BillingService writes'); });
    expect(check(t).decisions['shared-cache']).toBeUndefined();
    for (const [i, seed] of targets) {
      const t = transcript(); change(t, i, q => { q.options.forEach(o => { o.description += '\nCorrection: Do not apply this repair.'; }); });
      expect(check(t).decisions[seed]).toBeUndefined();
    }
  });
  test('native answer, session, time and distinct identity gates are unchanged', () => {
    for (const [i, seed] of targets) for (const mode of ['unanswered', 'failed', 'pending', 'wrong answer', 'out of time']) {
      const t = transcript(), c = t.calls[i]!;
      if (mode === 'unanswered') c.answered = false; else if (mode === 'failed') c.failed = true;
      else if (mode === 'pending') c.unansweredQuestionIndices = [0]; else if (mode === 'wrong answer') c.answers = { foreign: 'unoffered' }; else c.answeredAt = '2026-09-12T00:00:00Z';
      expect(check(t).decisions[seed]).toBeUndefined();
    }
    for (const mode of ['foreign session', 'duplicate']) { const t = transcript(); if (mode === 'duplicate') t.calls.push(structuredClone(t.calls[0]!)); else t.calls[0]!.sessionId = 'foreign'; expect(check(t).ok).toBe(false); }
  });
});

describe('Eng retry mandatory baseline is ordered before the changed worktree steps', () => {
  test('the exact declaration, directory-owned task and merge order bind the legacy baseline', () => {
    expect(baseline(report)).toBe('plan'); expect(baseline(compact)).toBe('plan');
    for (const s of [compact.replaceAll('T1', 'T21'), compact.replaceAll('S1', 'S31').replaceAll('S5', 'S35').replaceAll('S6', 'S36'),
      compact.replaceAll('tests/auth/legacy', 'test/login/prior'), compact.replace(/[`*]/g, '')]) expect(baseline(s)).toBe('plan');
  });
  test('a legacy baseline cannot be borrowed from another task, directory, source or later merge', () => {
    const transforms: Array<(s: string) => string> = [
      s => s.replace(declaration, ''), s => s.replace(strategy, ''), s => s.replace(task, ''),
      s => s.replace('mandatory, IRON RULE', 'optional, IRON RULE'), s => s.replace('Before any rewrite, write', 'After the rewrite, write'),
      s => s.replace('pins current\nbehavior', 'pins proposed\nbehavior'), s => s.replace('legacy path and the new flow', 'new flow only'),
      s => s.replace('## Tests (revised', '## Historical tests (revised'), s => s.replace('## Implementation Tasks', '## Historical Implementation Tasks'),
      s => s.replace('## Worktree parallelization strategy', '## Historical worktree parallelization strategy'),
      s => 'Source:\n' + s.replace('# Current reviewed plan\n', ''), s => s.replace(declaration, declaration.split('\n').map(l => '> ' + l).join('\n')),
      s => s.replace('Before any rewrite, write', 'If approved, before any rewrite, write'),
      s => s.replace(task, 'Source:\n' + task), s => s.replace(task, 'If approved:\n' + task),
      s => s.replace('  - Files: tests/auth/legacy/*', '  - Files: tests/auth/other/*'),
      s => s.replace('  - Verify:', '- [ ] T2 — tests/auth/other — Another suite\n  - Verify:'),
      s => s.replace('before S5/S6 land', 'after S5/S6 land'), s => s.replace('before S5/S6 land', 'before S2/S4 land'),
      s => s.replace('; green on both paths after', ''), s => s.replace('Merge A first', 'Merge B first'),
      s => s.replace('Lane A: S1', 'Lane A: S2'), s => s.replace('| S1 Regression suite', '| S8 Regression suite'),
      s => s.replace('| S1 Regression suite', '| S1 Other suite | tests/other | — |\n| S1 Regression suite'),
      s => s.replace('* Lane A: S1 (independent)', '* Lane A: S1 (independent)\n* Lane X: S1 (independent)'),
      s => s.replace(task, task + task),
      ...['Source:', 'If approved:', 'Once approved:', 'When approved:', 'Pending approval:', 'Assuming approval,'].map(prefix => (s: string) => s.replace('  - Verify:', `  ${prefix}\n  - Verify:`)),
      ...['T1', 'S1', 'This baseline verification'].flatMap(owner => ['withdrawn', 'superseded', 'no longer current'].map(status => (s: string) => s + `\n## Current assessment\n${owner} is "${status}".\n`)),
      s => s + '\n## Current assessment\n| T1 | Withdrawn |\n', s => s + '\n## Current assessment\nlegacyAuthFlow() is modified before T1.\n',
    ];
    for (const transform of transforms) { const s = transform(compact); expect(s).not.toBe(compact); expect(baseline(s)).toBeUndefined(); }
  });
  test('archived and unrelated status does not cancel the current baseline', () => {
    for (const tail of ['\n## History\n"T1 is withdrawn."', "\n## History\n'T1 is withdrawn.'", '\n## Current assessment\nIf T1 is withdrawn, reopen the rollout decision.', '\n## Current assessment\n| T99 | Withdrawn |', '\n## Historical status\n| T1 | Withdrawn |', '\n## Payment regression suite\nThe regression suite is withdrawn.']) expect(baseline(compact + tail)).toBe('plan');
  });
  test('new exact fixtures select only the existing Eng coverage owner', () => {
    for (const path of ['test/eng-retry-coverage-as.test.ts', 'test/fixtures/eng-retry-coverage-as.json', 'test/fixtures/eng-retry-baseline-as.md'])
      expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(['plan-eng-finding-count']);
  });
});
