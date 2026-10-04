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

describe('evals.yml receipt recovery (CEO-14/34, ENG-7)', () => {
  const recover = workflow.jobs['recover-receipts']!;
  const planner = workflow.jobs['plan-slices']!;

  test('recovery runs base-ref code with actions: read; plan-slices keeps contents: read only', () => {
    expect(recover.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(planner.permissions).toEqual({ contents: 'read' });
    const checkout = recover.steps.find(s => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with).toMatchObject({ ref: '${{ github.event.pull_request.base.sha }}', 'persist-credentials': false });
    const collect = step('recover-receipts', 'Recover receipts of cancelled runs (base-ref code)')!;
    expect(collect.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(collect.run).toContain('scripts/recover-receipts.ts collect');
    expect(collect.run).toContain('--budget-seconds 60');
    // Never fails the run: a missing base script or a crash only turns reuse off.
    expect(collect.run).toContain('exit 0');
    expect(collect.run).toContain('|| echo');
    expect(recover.if).toContain("!contains(github.event.pull_request.labels.*.name, 'evals-fresh')");
    expect(JSON.stringify(planner.steps)).not.toContain('actions/cache/restore');
    expect(JSON.stringify(planner.steps)).not.toContain('GH_TOKEN');
  });

  test('plan-slices takes the store as an artifact, decides reuse, and carries the store to the report', () => {
    expect(planner.needs).toContain('recover-receipts');
    expect(planner.if).toContain('!cancelled()');
    expect(step('plan-slices', "Download this PR's receipt store")).toMatchObject({ 'continue-on-error': true, with: { name: 'receipt-store' } });
    expect(step('plan-slices', 'Decide receipt reuse')?.run).toContain('recover-receipts.ts decide /tmp/gstack-eval-input-cache --github-output "$GITHUB_OUTPUT"');
    expect(step('plan-slices', 'Emit run manifest')?.env?.EVALS_CACHE_DIR).toBe("${{ steps.reuse.outputs.reuse == 'on' && '/tmp/gstack-eval-input-cache' || '' }}");
    const upload = planner.steps.find(s => s.with?.name === 'paid-plan')!;
    expect(String(upload.with!.path)).toContain('/tmp/paid-plan/store');
    expect(step('slices-report', "Merge this run's receipts")?.run).toContain('merge /tmp/gstack-eval-input-cache /tmp/paid-report/store');
  });

  test('every slice uploads its receipts even when cancelled; the report verdict carries report receipts', () => {
    const upload = step('eval-slices', 'Upload slice results')!;
    expect(upload.if).toBe('always()');
    expect(upload.with).toMatchObject({ name: 'paid-slice-${{ matrix.slice }}-a${{ github.run_attempt }}', path: '/tmp/paid-slice-results' });
    const verdict = workflow.jobs['slices-report']!.steps.find(s => String(s.with?.name ?? '').startsWith('report-verdict'))!;
    expect(String(verdict.with!.path)).toContain('/tmp/paid-report/report-receipts');
  });
});

