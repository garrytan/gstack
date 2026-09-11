import { describe, expect, test } from 'bun:test';
import { findCeoModeOption, nativeCeoModeAnswer, nextCeoModeNavigation } from './helpers/ceo-mode-option';
import type { PlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import { selectTests } from './helpers/touchfiles';
import captured from './fixtures/ceo-mode-colon-at.json';

function transcript(): PlanCountTranscript {
  return { status: 'ready', calls: [structuredClone(captured)], assistantMessages: [] };
}

describe('CEO colon-prefixed native mode choices', () => {
  test('the exact public menu resolves each named mode by display position', () => {
    const options = captured.questions[0]!.options.map((option, i) => ({ index: i + 1, label: option.label }));
    expect(findCeoModeOption(options, 'SELECTIVE EXPANSION')).toBe(1);
    expect(findCeoModeOption(options, 'SCOPE EXPANSION')).toBe(2);
    expect(findCeoModeOption(options, 'HOLD SCOPE')).toBe(3);
    expect(findCeoModeOption(options, 'SCOPE REDUCTION')).toBe(4);
  });

  test('navigation selects expansion in either display order without changing native input', () => {
    for (const reverse of [false, true]) {
      const call = transcript().calls[0]!;
      call.answered = false;
      delete call.answers;
      delete call.unansweredQuestionIndices;
      const question = call.questions[0]!;
      if (reverse) question.options.reverse();
      const original = structuredClone(call);
      const visible = `☐ ${question.header}\n${question.question}\n` + question.options.map((option, i) =>
        `${i ? ' ' : '❯'} ${i + 1}. ${option.label}`).join('\n') +
        '\nEnter to select · ↑/↓ to navigate · Esc to cancel';
      const action = nextCeoModeNavigation(visible, 'SCOPE EXPANSION', new Set(), call);
      expect(action.kind).toBe('mode');
      expect(action.kind === 'mode' && action.index).toBe(reverse ? 3 : 2);
      expect(call).toEqual(original);
    }
  });

  test('the recorded wrong selection remains selective expansion, never expansion coverage', () => {
    const actual = transcript();
    expect(nativeCeoModeAnswer(actual, 'SELECTIVE EXPANSION', 0)?.toolUseId)
      .toBe('toolu_01XY3qPeSuJZa3H2uCfatJ8b');
    expect(nativeCeoModeAnswer(actual, 'SCOPE EXPANSION', 0)).toBeNull();
    expect(actual.calls[0]).toEqual(captured);
  });

  test('pending, failed, stale and ambiguous native answers cannot prove selection', () => {
    for (const change of [
      (value: PlanCountTranscript) => { value.calls[0]!.answered = false; },
      (value: PlanCountTranscript) => { value.calls[0]!.failed = true; },
      (value: PlanCountTranscript) => { delete value.calls[0]!.answers; },
      (value: PlanCountTranscript) => { value.calls[0]!.answeredAt = 'invalid'; },
      (value: PlanCountTranscript) => {
        value.calls[0]!.questions[0]!.options.push({ label: 'E: SELECTIVE EXPANSION' });
      },
    ]) {
      const value = transcript();
      change(value);
      expect(nativeCeoModeAnswer(value, 'SELECTIVE EXPANSION', 0)).toBeNull();
    }
    expect(nativeCeoModeAnswer(transcript(), 'SELECTIVE EXPANSION', Date.parse(captured.answeredAt) + 1)).toBeNull();
    const laterAmbiguous = transcript();
    const later = structuredClone(laterAmbiguous.calls[0]!);
    later.toolUseId = 'later-ambiguous-mode';
    later.answeredAt = new Date(Date.parse(captured.answeredAt) + 1000).toISOString();
    later.questions[0]!.options.push({ label: 'E: SELECTIVE EXPANSION' });
    laterAmbiguous.calls.push(later);
    expect(nativeCeoModeAnswer(laterAmbiguous, 'SELECTIVE EXPANSION', 0)).toBeNull();
  });

  test('action titles, lookalikes and preview descriptions do not become modes', () => {
    for (const label of [
      'A: Use HOLD SCOPE for the next review',
      'B: Explain SCOPE EXPANSION',
      'AA: HOLD SCOPE',
      '1: HOLD SCOPE',
      'A:: HOLD SCOPE',
      'A: HOLD SCOPES',
      'A: Fix contrast │ HOLD SCOPE',
      'A: Fix contrast ┌ SCOPE EXPANSION',
      'A: "HOLD SCOPE"',
      'Prior: HOLD SCOPE',
    ]) expect(findCeoModeOption([{ index: 1, label }], 'HOLD SCOPE')).toBeNull();
    expect(() => findCeoModeOption([
      { index: 1, label: 'A: SELECTIVE EXPANSION │ SCOPE EXPANSION' },
      { index: 2, label: 'B: HOLD SCOPE' },
    ], 'SCOPE EXPANSION')).toThrow('not in option labels');
  });

  test('duplicate and missing mode titles fail before selection; legacy prefixes still work', () => {
    expect(() => findCeoModeOption([
      { index: 1, label: 'A: HOLD SCOPE' },
      { index: 2, label: 'HOLD SCOPE (recommended)' },
    ], 'HOLD SCOPE')).toThrow('duplicate');
    expect(() => findCeoModeOption([{ index: 1, label: 'A: SCOPE REDUCTION' }], 'HOLD SCOPE'))
      .toThrow('not in option labels');
    for (const label of ['A) HOLD SCOPE', 'A. HOLD SCOPE', 'a: hold scope', 'A:  HOLD SCOPE']) {
      expect(findCeoModeOption([{ index: 3, label }], 'HOLD SCOPE')).toBe(3);
    }
  });

  test('the exact public fixture and regression select the mode-routing workflow', () => {
    for (const file of ['test/ceo-mode-colon-at.test.ts', 'test/fixtures/ceo-mode-colon-at.json']) {
      expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-ceo-mode-routing']);
    }
  });
});
