/**
 * auq-matrix recommendation substance (C4, approved 2026-10-04): one native
 * capture per skill, scored by a JUDGE_PANEL_SAMPLES panel of the same grader
 * on that capture. The panel median (2 of 3 samples) gates against the unchanged
 * minimum and the mean is reported; a sample error fails the panel and is never
 * resampled (judgePanel).
 */
import { gradeAuqRecommendation } from './auq-sdk-capture';
import { judgePanel, judgePanelSummary } from './llm-judge';

export const AUQ_SUBSTANCE_MIN = 4;

type Grade = Awaited<ReturnType<typeof gradeAuqRecommendation>>;

export async function auqSubstancePanel(text: string, grade: (text: string) => Promise<Grade> = gradeAuqRecommendation) {
  const samples = await judgePanel(() => grade(text));
  const { median, mean } = judgePanelSummary(samples, ['substance']);
  return { samples, median: median.substance, mean: mean.substance, passed: median.substance >= AUQ_SUBSTANCE_MIN };
}
