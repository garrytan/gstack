/**
 * PR paid-lane workflow pins (W1, CEO-13/14/34, ENG-7/11/12, DX-7, W8f):
 * coverage summaries, cancellation recovery off PR code, the push-burst
 * debounce, dispatch inputs, and the absence of the old inline subset program.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/evals.yml'), 'utf8');

interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; 'continue-on-error'?: boolean }
interface Job { if?: string; needs?: string | string[]; permissions?: Record<string, string>; steps: Step[]; outputs?: Record<string, string>; 'runs-on'?: string; 'timeout-minutes'?: number | string }
const workflow = Bun.YAML.parse(source) as { on: Record<string, any>; 'run-name'?: string; env: Record<string, string>; jobs: Record<string, Job> };
const step = (job: string, name: string) => workflow.jobs[job]!.steps.find(s => s.name === name);

describe('evals.yml PR coverage summary (CEO-13)', () => {
  test('the planner and the report write the coverage summary to the job summary', () => {
    expect(step('plan-slices', 'Summarize PR coverage')?.run).toContain('scripts/test-pr-profile.ts summary /tmp/paid-plan/manifest.json >> "$GITHUB_STEP_SUMMARY"');
    const report = step('slices-report', 'Summarize PR coverage and reuse')!;
    expect(report.if).toBe('always()');
    expect(report.run).toContain('summary /tmp/paid-report/manifest.json /tmp/paid-report/collector-outcomes.json');
  });

  test('the PR comment names the mode and every fallback file with its label and fix', () => {
    const comment = step('slices-comment', 'Post PR comment')!.run!;
    expect(comment).toContain('mode `\\(.prCoverage.mode // "broad")`');
    expect(comment).toContain('select(.prCoverage.mode == "full-fallback")');
    expect(comment).toContain('$c.unknownFileLabels');
    expect(comment).toContain('Full gate restored by:');
    expect(comment).toContain('**${EXECUTED} executed, ${REUSED} reused**');
  });
});
