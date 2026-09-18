import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasNativePostAnswerCeoPosture, hasPostAnswerCeoPosture } from './helpers/ceo-mode-option';
import { readPlanCountTranscript } from './helpers/plan-count-transcript';
import captured from './fixtures/ceo-hold-posture-l.json';

const posture = /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i;

function nativeTranscript() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-native-posture-'));
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

describe('Native CEO posture with explanatory parentheses', () => {
  test('the actual HOLD answer and subsequent scope analysis establish posture', () => {
    const transcript = nativeTranscript();
    expect(transcript.status).toBe('ready');
    expect(transcript.calls).toHaveLength(1);
    expect(transcript.assistantMessages).toHaveLength(1);
    expect(transcript.calls[0]!.answers).toEqual({ 'Which review mode should I run for this plan?': 'HOLD SCOPE' });
    expect(hasNativePostAnswerCeoPosture(transcript, 'HOLD SCOPE', posture,
      Date.parse('2026-09-08T23:23:47.560Z'))).toBe(true);
  });

  test('tool headings, quoted source and a bare mode echo remain insufficient', () => {
    for (const visible of [
      '● Bash(command)\nHOLD SCOPE confirmed. Approach B (personal DB views) is the baseline.',
      '● Read (/skill.md)\nReview with maximum rigor.',
      "● User answered Claude's questions:\nHOLD SCOPE",
      '● HOLD SCOPE.',
    ]) expect(hasPostAnswerCeoPosture(visible, posture)).toBe(false);
    for (const text of [
      '> HOLD SCOPE confirmed. Approach B (personal DB views) is the baseline.',
      '```text\nHOLD SCOPE confirmed. Approach B (personal DB views) is the baseline.\n```',
      'HOLD SCOPE confirmed.',
    ]) {
      const transcript = nativeTranscript();
      transcript.assistantMessages[0]!.text = text;
      expect(hasNativePostAnswerCeoPosture(transcript, 'HOLD SCOPE', posture, 0)).toBe(false);
    }
  });

  test('an announced mode before selection, a wrong answer or missing native answer cannot pass', () => {
    const earlier = nativeTranscript();
    earlier.assistantMessages[0]!.timestamp = '2026-09-08T23:23:41.665Z';
    expect(hasNativePostAnswerCeoPosture(earlier, 'HOLD SCOPE', posture, 0)).toBe(false);
    const wrong = nativeTranscript();
    wrong.calls[0]!.answers = { 'Which review mode should I run for this plan?': 'SCOPE EXPANSION' };
    expect(hasNativePostAnswerCeoPosture(wrong, 'HOLD SCOPE', posture, 0)).toBe(false);
    const pending = nativeTranscript();
    pending.calls[0]!.answered = false;
    expect(hasNativePostAnswerCeoPosture(pending, 'HOLD SCOPE', posture, 0)).toBe(false);
  });
});
