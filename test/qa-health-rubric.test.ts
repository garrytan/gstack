import { describe, expect, test } from 'bun:test';
import { generateQAMethodology } from '../scripts/resolvers/utility';
import { HOST_PATHS } from '../scripts/resolvers/types';

const methodology = generateQAMethodology({
  skillName: 'qa', tmplPath: '', host: 'claude', paths: HOST_PATHS.claude,
});
const rubric = methodology.split('## Health Score Rubric')[1].split('## Framework-Specific Guidance')[0];

describe('QA health rubric scoring contract', () => {
  test('console bands have no overlapping boundary at ten errors', () => {
    expect(rubric).toContain('4-10 errors');
    expect(rubric).toContain('11+ errors');
    expect(rubric).not.toContain('10+ errors');
    expect(rubric).toContain('Exclude warnings');
  });

  test('defines severity, categories, and duplicate handling', () => {
    for (const severity of ['Critical', 'High', 'Medium', 'Low']) {
      expect(rubric).toContain(`**${severity}:**`);
    }
    expect(rubric).toContain('one primary category');
    expect(rubric).toContain('same root cause');
    expect(rubric).toContain('client-side routes');
  });

  test('defines partial coverage and weighted rounding', () => {
    expect(rubric).toContain('untested');
    expect(rubric).toContain('provisional');
    expect(rubric).toContain('15% = 0.15');
    expect(rubric).toContain('Round only the final score');
  });
});
