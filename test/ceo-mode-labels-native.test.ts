import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findCeoModeOption, nativeCeoModeAnswer, nextCeoModeNavigation } from './helpers/ceo-mode-option';
import { readPlanCountTranscript } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-mode-labels-l.json';

function transcript() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-native-mode-'));
  const first = captured.records[0]!;
  const project = path.join(root, 'projects', 'fixture');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${first.sessionId}.jsonl`),
    captured.records.map(record => JSON.stringify(record)).join('\n') + '\n');
  try {
    return readPlanCountTranscript(root, first.cwd);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('Native CEO letter-prefixed mode choices', () => {
  test('the captured menu selects the requested mode in either order without changing labels', () => {
    for (const reverse of [false, true]) {
      const call = transcript().calls[0]!;
      call.answered = false;
      delete call.answers;
      delete call.unansweredQuestionIndices;
      const q = call.questions[0]!;
      if (reverse) q.options.reverse();
      const original = structuredClone(q.options);
      const visible = `☐ ${q.header}\n${q.question}\n` + q.options.map((option, i) =>
        `${i ? ' ' : '❯'} ${i + 1}. ${option.label}`).join('\n') +
        '\nEnter to select · ↑/↓ to navigate · Esc to cancel';
      const action = nextCeoModeNavigation(visible, 'HOLD SCOPE', new Set(), call);
      expect(action.kind).toBe('mode');
      expect(action.kind === 'mode' && action.index).toBe(reverse ? 2 : 3);
      const numbered = q.options.map((option, i) => ({ index: i + 1, label: option.label }));
      expect(findCeoModeOption(numbered, 'SCOPE EXPANSION')).toBe(reverse ? 3 : 2);
      expect(q.options).toEqual(original);
    }
  });

  test('the historical wrong selection remains SELECTIVE EXPANSION, never evidence of HOLD', () => {
    const actual = transcript();
    expect(actual.status).toBe('ready');
    expect(nativeCeoModeAnswer(actual, 'SELECTIVE EXPANSION', 0)?.toolUseId)
      .toBe('toolu_01JCKZEDVZ5DXqRazc6Y7L2Z');
    expect(nativeCeoModeAnswer(actual, 'HOLD SCOPE', 0)).toBeNull();
  });

  test('ordinary action text, lookalikes and preview text do not become mode titles', () => {
    for (const label of [
      'A) Use HOLD SCOPE for the next review',
      'B) Explain SCOPE EXPANSION',
      'AA) HOLD SCOPE',
      '1) HOLD SCOPE',
      'A) HOLD SCOPES',
      'A) Fix contrast │ HOLD SCOPE',
      'A) Fix contrast ┌ SCOPE EXPANSION',
    ]) expect(findCeoModeOption([{ index: 1, label }], 'HOLD SCOPE')).toBeNull();
  });

  test('duplicate or absent target modes fail before an input can be selected', () => {
    const duplicate = [
      { index: 1, label: 'A) HOLD SCOPE' },
      { index: 2, label: 'B) HOLD SCOPE (recommended)' },
      { index: 3, label: 'C) SCOPE EXPANSION' },
    ];
    expect(() => findCeoModeOption(duplicate, 'HOLD SCOPE')).toThrow('duplicate');
    expect(() => findCeoModeOption([{ index: 1, label: 'A) SCOPE REDUCTION' }], 'HOLD SCOPE'))
      .toThrow('not in option labels');
    const ambiguous = transcript();
    ambiguous.calls[0]!.questions[0]!.options.push({ label: 'E) SELECTIVE EXPANSION' });
    expect(nativeCeoModeAnswer(ambiguous, 'SELECTIVE EXPANSION', 0)).toBeNull();
    const previous = transcript();
    const later = structuredClone(ambiguous.calls[0]!);
    later.toolUseId = 'later-ambiguous-mode';
    later.answeredAt = new Date(Date.parse(later.answeredAt!) + 1000).toISOString();
    previous.calls.push(later);
    expect(nativeCeoModeAnswer(previous, 'SELECTIVE EXPANSION', 0)).toBeNull();
  });
});
