import { describe, expect, test } from 'bun:test';
import { DASHBOARD_PLAN } from './helpers/plan-eng-artifact-fixture';
import { engResumeProblems, engResumeReport, type EngResumeCall } from './helpers/plan-eng-resume';
import resume from './fixtures/plan-eng-artifact-resume-37174266054.json';

const calls = resume.calls as EngResumeCall[];
const plan = DASHBOARD_PLAN.slice(DASHBOARD_PLAN.indexOf('# Plan: Add Dashboard'));
const report = engResumeReport(plan, calls);

describe('plan-eng-review-artifact resume point (census 37174266054)', () => {
  test('the real Scope Challenge calls rebuild a valid resume point at Section 3', () => {
    expect(calls.map(call => call.question.split(' ')[0])).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
    expect(calls.every(call => call.options.some(option => option.label === call.answer))).toBe(true);
    expect(engResumeProblems(report, calls)).toEqual([]);
    expect(report.startsWith(plan)).toBe(true);
    expect(report).toContain('Next: Section 3, Test review.');
    for (const call of calls) expect(report).toContain(`### ${call.ledgerId}: ${call.header}`);
  });

  test.each([
    ['a missing record', (r: string) => r.replace(/### R7: [\s\S]*?History: —\n/, '')],
    ['a changed actual answer', (r: string) => r.replace('Actual answer: A) Vitest + TypeScript (recommended)', 'Actual answer: B) node:test with native type stripping')],
    ['an edited option', (r: string) => r.replace('A) Make Dashboard async and await fetchStats (recommended)\n', 'A) Make Dashboard synchronous\n')],
    ['a pending record', (r: string) => r.replace('State: approved', 'State: pending')],
    ['a duplicate ledger', (r: string) => r + '\n## Decision ledger\n'],
    ['no Scope Challenge result', (r: string) => r.replace(/^Scope Challenge result: .*$/m, '')],
    ['Section 2 still open', (r: string) => r.replace('Section 2, Code quality review: complete', 'Section 2, Code quality review: in progress')],
  ])('rejects %s', (_name, mutate) => {
    expect(engResumeProblems(mutate(report), calls).length).toBeGreaterThan(0);
  });
});
