import { describe, expect, test } from 'bun:test';
import {
  PI_GSTACK_SKILL_ALIASES,
  aliasToPiSkillCommand,
  factoryRunsRoot,
  formatAskUserQuestionResult,
  normalizeAskUserQuestionRequest,
  normalizeFactoryCompleteQaArgs,
  normalizeFactoryCompleteReviewArgs,
  normalizeFactoryGateDecisionArgs,
  normalizeFactoryQaGoal,
  normalizeFactoryReviewGoal,
  normalizePiBrowserCommandRequest,
  piBrowserExecutableCandidates,
  toPiSkillCommand,
} from '../lib/pi-runtime-adapter';

describe('pi-runtime-adapter pure calculations', () => {
  test('maps gstack skill aliases to Pi skill commands', () => {
    expect(PI_GSTACK_SKILL_ALIASES.map(alias => alias.command)).toEqual([
      'office-hours',
      'autoplan',
      'review',
      'qa',
      'ship',
    ]);

    const review = PI_GSTACK_SKILL_ALIASES.find(alias => alias.command === 'review');
    expect(review).toBeDefined();
    expect(aliasToPiSkillCommand(review!, 'check this diff')).toBe('/skill:gstack-review check this diff');
  });

  test('builds Pi skill commands without trailing whitespace', () => {
    expect(toPiSkillCommand('gstack-ship')).toBe('/skill:gstack-ship');
    expect(toPiSkillCommand(' gstack-qa ', '  http://localhost:8200  ')).toBe('/skill:gstack-qa http://localhost:8200');
    expect(() => toPiSkillCommand('   ')).toThrow('skillName is required');
  });

  test('normalizes Pi browser command requests', () => {
    expect(normalizePiBrowserCommandRequest({
      command: ' snapshot ',
      args: ['-i', '-a'],
      timeoutMs: 2500.9,
    })).toEqual({
      ok: true,
      value: {
        command: 'snapshot',
        args: ['-i', '-a'],
        timeoutMs: 2500,
      },
    });

    expect(normalizePiBrowserCommandRequest({ command: 'snapshot; rm -rf /' })).toEqual({
      ok: false,
      error: 'command must be a browse command name such as goto, snapshot, screenshot, or console',
    });

    expect(normalizePiBrowserCommandRequest({ command: 'goto', args: ['https://example.com', 42] })).toEqual({
      ok: false,
      error: 'args must be an array of strings',
    });

    expect(normalizePiBrowserCommandRequest({ command: 'snapshot', cwd: '/tmp' })).toEqual({
      ok: false,
      error: 'cwd is not supported; gstack_browser runs in the current Pi project',
    });
  });

  test('builds Pi browser executable candidates in runtime-preference order', () => {
    expect(piBrowserExecutableCandidates({
      repoRoot: '/repo/gstack',
      home: '/home/user',
      env: { GSTACK_BROWSE: '/custom/browse/dist' },
    })).toEqual([
      '/custom/browse/dist/browse',
      '/home/user/.pi/agent/skills/gstack/browse/dist/browse',
      '/repo/gstack/.pi/skills/gstack/browse/dist/browse',
      '/repo/gstack/browse/dist/browse',
    ]);
  });

  test('normalizes factory gate decision args', () => {
    expect(normalizeFactoryGateDecisionArgs('run-1 approve-review 12 approve looks safe')).toEqual({
      ok: true,
      runId: 'run-1',
      gateId: 'approve-review',
      requestSequence: 12,
      decision: 'approve',
      reason: 'looks safe',
    });
    expect(normalizeFactoryGateDecisionArgs('run-1 gate 0 approve')).toEqual({ ok: false, error: 'factory-decide request sequence must be a positive integer' });
    expect(normalizeFactoryGateDecisionArgs('run-1 gate 1 maybe')).toEqual({ ok: false, error: 'factory-decide decision must be approve, reject, waive, or cancel' });
  });

  test('normalizes factory review goals and run paths', () => {
    expect(normalizeFactoryReviewGoal('  review this branch  ')).toEqual({ ok: true, goal: 'review this branch' });
    expect(normalizeFactoryReviewGoal('   ')).toEqual({ ok: false, error: 'factory-review requires a review goal or scope' });
    expect(normalizeFactoryQaGoal('  http://localhost:8200  ')).toEqual({ ok: true, goal: 'http://localhost:8200' });
    expect(normalizeFactoryQaGoal('   ')).toEqual({ ok: false, error: 'factory-qa requires a QA goal, target, or URL' });
    expect(normalizeFactoryCompleteReviewArgs('run-1 no blocking findings')).toEqual({ ok: true, runId: 'run-1', summary: 'no blocking findings' });
    expect(normalizeFactoryCompleteReviewArgs('run-1')).toEqual({ ok: false, error: 'factory-complete-review requires a run id followed by a review summary' });
    expect(normalizeFactoryCompleteQaArgs('run-qa no regressions')).toEqual({ ok: true, runId: 'run-qa', summary: 'no regressions' });
    expect(normalizeFactoryCompleteQaArgs('run-qa')).toEqual({ ok: false, error: 'factory-complete-qa requires a run id followed by a QA summary' });
    expect(factoryRunsRoot('/repo/project')).toBe('/repo/project/.gstack/factory/runs');
  });

  test('normalizes structured user questions', () => {
    const result = normalizeAskUserQuestionRequest({
      question: '  Which deploy target?  ',
      options: [
        'Staging',
        { label: 'Production', description: 'Real users' },
        'staging',
        '',
        { label: '  Preview  ' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      question: 'Which deploy target?',
      options: [
        { label: 'Staging' },
        { label: 'Production', description: 'Real users' },
        { label: 'Preview' },
      ],
      allowCustom: false,
      placeholder: undefined,
    });
  });

  test('defaults freeform questions to custom answers and rejects empty questions', () => {
    expect(normalizeAskUserQuestionRequest({ question: 'Anything else?' })).toEqual({
      ok: true,
      value: {
        question: 'Anything else?',
        options: [],
        allowCustom: true,
        placeholder: undefined,
      },
    });

    expect(normalizeAskUserQuestionRequest({ question: '   ' })).toEqual({
      ok: false,
      error: 'question must be a non-empty string',
    });
  });

  test('formats question results without inventing answers on cancellation', () => {
    expect(formatAskUserQuestionResult({
      question: 'Ship?',
      answer: null,
      cancelled: true,
      wasCustom: false,
    })).toContain('Do not assume an answer');

    expect(formatAskUserQuestionResult({
      question: 'Ship?',
      answer: 'Yes',
      cancelled: false,
      wasCustom: false,
    })).toBe('User selected: Yes');

    expect(formatAskUserQuestionResult({
      question: 'Notes?',
      answer: 'After tests pass',
      cancelled: false,
      wasCustom: true,
    })).toBe('User wrote: After tests pass');
  });
});
