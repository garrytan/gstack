import { describe, expect, test } from 'bun:test';
import retained from './fixtures/ceo-split-e5-numbered-description-491.json';
import {
  capturePlanCountQuestion,
  matchesNativePlanQuestion,
  nativePlanCallFingerprint,
  parseNumberedOptions,
} from './helpers/claude-pty-runner';
import { pickCeoSplitCountQuestion } from './helpers/ceo-split-question-policy';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const pending = () => structuredClone(retained.actualPending) as NativePlanQuestionCall;
const labels = retained.actualPending.questions[0]!.options.map(option => option.label);
const nativeOptions = labels.map((label, index) => ({ index: index + 1, label }));
const footer = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

describe('native menu rows and wrapped numbered descriptions', () => {
  test('the exact original E5 screen binds the complete retained native call', () => {
    const call = pending();
    const before = structuredClone(call);
    expect(parseNumberedOptions(retained.visible)).toEqual([
      ...nativeOptions,
      { index: 5, label: 'Type something.' },
      { index: 6, label: 'Chat about this' },
    ]);
    expect(matchesNativePlanQuestion(retained.visible, call)).toBe(true);
    const active = capturePlanCountQuestion(retained.visible, new Set(), retained.elapsedMs, false, call)!;
    expect(active.nativeCall).toEqual(call);
    expect(active.options).toEqual(nativeOptions);
    expect(pickCeoSplitCountQuestion(nativePlanCallFingerprint(call, retained.elapsedMs, false), active)).toBe(1);
    expect(call).toEqual(before);
    expect(retained.originalOutcome).toBe('failed');
    expect(call.answered).toBe(false);
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('description number %i cannot replace a menu row', number => {
    const screen = retained.visible.replace('     4. ✅ Every ask', `     ${number}. ✅ Every ask`);
    expect(parseNumberedOptions(screen).slice(0, 4)).toEqual(nativeOptions);
    expect(matchesNativePlanQuestion(screen, pending())).toBe(true);
  });

  test.each([0, 2, 6])('row geometry follows the menu at indentation %i', spaces => {
    const screen = retained.visible.split('\n').map(line => ' '.repeat(spaces) + line).join('\n');
    expect(parseNumberedOptions(screen).slice(0, 4)).toEqual(nativeOptions);
    expect(matchesNativePlanQuestion(screen, pending())).toBe(true);
  });

  test('a selected later row does not make a description number the first option', () => {
    const screen = '  1. First\n     1. Numbered detail\n❯ 2. Second\n     3. Another detail\n  3. Third\n';
    expect(parseNumberedOptions(screen)).toEqual([
      { index: 1, label: 'First' }, { index: 2, label: 'Second' }, { index: 3, label: 'Third' },
    ]);
  });

  test.each(['❯1. First\n     2. Description\n  2. Second\n', '  1. First\n     1. Description\n❯2. Second\n'])(
    'a compact cursor slot retains normally indented peer options: %s', screen => {
      expect(parseNumberedOptions(screen)).toEqual([
        { index: 1, label: 'First' }, { index: 2, label: 'Second' },
      ]);
    },
  );

  test('indented decimal prose is not an option', () => {
    expect(parseNumberedOptions('❯ 1. First\n     2.5 weeks is the estimate.\n  2. Second\n')).toEqual([
      { index: 1, label: 'First' }, { index: 2, label: 'Second' },
    ]);
  });

  test.each(['Hold', 'A different fourth option'])('duplicate peer row %s stays ambiguous', label => {
    const screen = retained.visible.replace('  4. Hold\n', `  4. Hold\n  4. ${label}\n`);
    expect(matchesNativePlanQuestion(screen, pending())).toBe(false);
    expect(parseNumberedOptions(screen)).toEqual([]);
  });

  test('a nested duplicate label cannot supply a missing actual menu row', () => {
    const screen = retained.visible.replace('     4. ✅ Every ask', '     4. Hold\n     ✅ Every ask')
      .replace('\n  4. Hold\n', '\n  Missing fourth row\n');
    expect(matchesNativePlanQuestion(screen, pending())).toBe(false);
  });

  test.each(['question', 'label', 'missing_choice', 'missing_footer', 'foreign_prefix', 'extra_choice'])(
    'matching still rejects %s', kind => {
      const call = pending();
      let screen = retained.visible;
      if (kind === 'question') call.questions[0]!.question += ' An unrelated final sentence.';
      if (kind === 'label') call.questions[0]!.options[3]!.label = 'Authorize unrelated work';
      if (kind === 'missing_choice') screen = screen.replace('  4. Hold\n', '  Missing fourth row\n');
      if (kind === 'missing_footer') screen = screen.replace(footer, '');
      if (kind === 'foreign_prefix') screen = 'Foreign pending question\n' + screen;
      if (kind === 'extra_choice') screen = screen.replace('  5. Type something.', '  5. Authorize another feature');
      expect(matchesNativePlanQuestion(screen, call)).toBe(false);
      const active = capturePlanCountQuestion(screen, new Set(), retained.elapsedMs, false, call)!;
      expect(() => pickCeoSplitCountQuestion(nativePlanCallFingerprint(call, retained.elapsedMs, false), active))
        .toThrow('complete matched native question');
    },
  );

  test.each(['answered', 'failed', 'foreign_fingerprint'])(
    'the strict picker still rejects %s', kind => {
      const call = pending();
      const active = capturePlanCountQuestion(retained.visible, new Set(), retained.elapsedMs, false, call)!;
      if (kind === 'answered') call.answered = true;
      if (kind === 'failed') call.failed = true;
      if (kind === 'foreign_fingerprint') active.signature = 'foreign-session:foreign-call';
      expect(() => pickCeoSplitCountQuestion(nativePlanCallFingerprint(call, retained.elapsedMs, false), active))
        .toThrow('complete matched native question');
    },
  );
});
