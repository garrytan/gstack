import { describe, expect, test } from 'bun:test';
import {
  PI_GSTACK_SKILL_ALIASES,
  aliasToPiSkillCommand,
  formatAskUserQuestionResult,
  normalizeAskUserQuestionRequest,
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
