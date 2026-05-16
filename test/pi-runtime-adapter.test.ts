import { describe, expect, test } from 'bun:test';
import {
  PI_GSTACK_SKILL_ALIASES,
  aliasToPiSkillCommand,
  formatAskUserQuestionResult,
  normalizeAskUserQuestionRequest,
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
