import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { auqSubstancePanel, AUQ_SUBSTANCE_MIN } from './helpers/auq-substance-panel';
import { JUDGE_PANEL_SAMPLES } from './helpers/llm-judge';

const grader = (scores: number[]) => {
  const seen: string[] = [];
  let index = 0;
  const grade = async (text: string) => {
    seen.push(text);
    const substance = scores[index++];
    if (substance === undefined) throw new Error('grader called more than the panel size');
    return { substance, present: true, hadLiteralBecause: true, reason: 'r' };
  };
  return { grade, seen };
};

describe('auq-matrix substance panel (C4)', () => {
  test('one capture is graded by a full panel and gates on the median at the unchanged minimum', async () => {
    expect(AUQ_SUBSTANCE_MIN).toBe(4);
    const { grade, seen } = grader([5, 3, 4]);
    const panel = await auqSubstancePanel('Recommendation: A because B', grade);
    expect(seen).toEqual(Array(JUDGE_PANEL_SAMPLES).fill('Recommendation: A because B'));
    expect(panel).toMatchObject({ median: 4, mean: 4, passed: true });
  });
  test('two of three samples at the minimum pass; two below it fail; the mean is only reported', async () => {
    expect((await auqSubstancePanel('q', grader([4, 3, 4]).grade))).toMatchObject({ median: 4, passed: true });
    expect((await auqSubstancePanel('q', grader([5, 3, 3]).grade))).toMatchObject({ median: 3, passed: false });
    expect((await auqSubstancePanel('q', grader([3, 3, 3]).grade)).mean).toBe(3);
  });
  test('a failed sample fails the panel without resampling', async () => {
    let calls = 0;
    const grade = async () => {
      calls++;
      if (calls === 2) throw new Error('judge returned non-JSON');
      return { substance: 5, present: true, hadLiteralBecause: true, reason: 'r' };
    };
    await expect(auqSubstancePanel('q', grade)).rejects.toThrow('non-JSON');
    expect(calls).toBe(JUDGE_PANEL_SAMPLES);
  });
  test('the matrix scores its single capture through the panel', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-auq-matrix.test.ts'), 'utf8');
    expect(source.match(/captureNativeFirstAuq\(/g)).toHaveLength(1);
    expect(source).toContain('auqSubstancePanel(text)');
    expect(source).not.toMatch(/gradeAuqRecommendation\(/);
    expect(source).toContain('substance < AUQ_SUBSTANCE_MIN');
  });
});
