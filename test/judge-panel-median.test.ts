import { describe, expect, test } from 'bun:test';
import replay from './fixtures/judge-panel-replay-2026-10-05.json';
import { judgePanelMajority, judgePanelMean, judgePanelMedian, JUDGE_PANEL_SAMPLES } from './helpers/llm-judge';
import { BROWSE_JUDGE_FLOORS } from './helpers/workflow-judge-cache';
import { EVAL_POLICY } from './helpers/periodic-exclude-data';

const gate = (scores: number[], threshold = 4) => judgePanelMedian(scores.map(score => ({ score })), ['score']).score >= threshold;

describe('judge gate: per-dimension median of exactly three samples (EVAL_POLICY v3)', () => {
  test('a dimension passes when at least 2 of 3 samples meet the unchanged threshold', () => {
    expect(EVAL_POLICY.judge.samples).toBe(JUDGE_PANEL_SAMPLES);
    expect(gate([4, 4, 3])).toBe(true);
    expect(gate([4, 3, 3])).toBe(false);
    expect(gate([5, 5, 3])).toBe(true);
    expect(gate([5, 3, 3])).toBe(false);
    expect(gate([3, 4, 4])).toBe(true);
  });

  test('anything but exactly three valid samples fails closed', () => {
    expect(() => gate([4, 4])).toThrow('exactly 3 samples');
    expect(() => gate([4, 4, 4, 4])).toThrow('exactly 3 samples');
    expect(() => judgePanelMedian([{ score: 4 }, { score: '4' }, { score: 4 }] as any, ['score'])).toThrow('sample 2 has non-numeric score');
    expect(() => judgePanelMedian([{ score: 4 }, null, { score: 4 }] as any, ['score'])).toThrow('sample 2');
    expect(() => judgePanelMedian([{ score: 4 }, { score: Number.NaN }, { score: 4 }], ['score'])).toThrow('non-numeric');
  });

  test('each dimension is gated on its own: one failing dimension fails the panel', () => {
    const samples = [{ clarity: 5, actionability: 3 }, { clarity: 5, actionability: 3 }, { clarity: 5, actionability: 4 }];
    const median = judgePanelMedian(samples, ['clarity', 'actionability']);
    expect(median).toEqual({ clarity: 5, actionability: 3 });
    expect(median.clarity >= 4 && median.actionability >= 4).toBe(false);
  });
});

type Sample = Record<string, number | boolean>;
const SCORE = ['clarity', 'completeness', 'actionability'] as const;
function verdict(name: string, samples: Sample[], aggregate: typeof judgePanelMean): boolean {
  const meets = (keys: readonly string[], floors: Record<string, number>) => {
    const scores = aggregate(samples as Record<string, unknown>[], keys);
    return keys.every(key => scores[key]! >= floors[key]!);
  };
  if (name === 'Setup block') return meets(['clarity', 'actionability'], { clarity: 3, actionability: 3 });
  if (name === 'Browse SKILL.md') return meets(SCORE, BROWSE_JUDGE_FLOORS);
  if (name === 'QA anti-refusal') return judgePanelMajority(samples as Record<string, unknown>[], 'would_browse') && meets(['confidence'], { confidence: 4 });
  if (name === 'Cross-skill consistency') return judgePanelMajority(samples as Record<string, unknown>[], 'consistent') && meets(['score'], { score: 4 });
  if (name === 'Voice directive') {
    const keys = ['directness', 'concreteness', 'avoids_corporate', 'avoids_ai_vocabulary', 'connects_user_outcomes'];
    return meets(keys, Object.fromEntries(keys.map(key => [key, 4])));
  }
  return meets(SCORE, { clarity: 3, completeness: 3, actionability: 4 });
}

test('replayed panels from jobs 112032744416 and 112049856586 (replayed evidence, not a CI pass)', () => {
  const rows = replay.panels.map(panel => ({ job: panel.job, case: panel.case,
    mean: verdict(panel.case, panel.samples as Sample[], judgePanelMean), median: verdict(panel.case, panel.samples as Sample[], judgePanelMedian) }));
  expect(rows).toHaveLength(42);
  expect(rows.filter(row => !row.mean).map(row => `${row.job} ${row.case}`)).toEqual([
    '112032744416 QA workflow', '112032744416 plan-eng-review/SKILL.md sections', '112049856586 design-consultation/SKILL.md research']);
  expect(rows.filter(row => !row.median).map(row => `${row.job} ${row.case}`)).toEqual(['112032744416 plan-eng-review/SKILL.md sections']);
  // Exactly these two panels change verdict: each had 2 of 3 samples at every threshold.
  expect(rows.filter(row => row.median && !row.mean).map(row => row.case)).toEqual(['QA workflow', 'design-consultation/SKILL.md research']);
});
