/**
 * Weekly off-ship sweep workflow wiring (docs/TESTING_INTERNALS.md#ship-measure-sweep):
 * weekly after the periodic census plus dispatch, read-only permissions (it
 * never pushes or opens a pull request), one sweep at a time repository-wide
 * so two runs never spend the same weekly cap, the CI image by digest with the
 * census's paid-eval setup, earlier reports downloaded before any spend,
 * dispatch inputs reaching the shell only through env, and the report uploaded
 * even when the sweep fails.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/eval-sweep.yml'), 'utf8');
const workflow = Bun.YAML.parse(source) as any;
const sweep = workflow.jobs.sweep;
const step = (name: string) => sweep.steps.find((s: any) => s.name === name);

describe('eval-sweep.yml', () => {
  test('runs weekly after the 06:00 UTC periodic census, plus dispatch with k, cap and dry-run inputs', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const [hour] = /cron: '0 (\d+) \* \* 1'/.exec(source)!.slice(1).map(Number);
    const census = Number(/cron: '0 (\d+) \* \* 1'/.exec(fs.readFileSync(path.join(ROOT, '.github/workflows/evals-periodic.yml'), 'utf8'))![1]);
    expect(hour!).toBeGreaterThan(census);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(['cap_usd', 'dry_run', 'k']);
  });

  test('never pushes, commits or opens a pull request: read-only grants, no write commands', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values<any>(workflow.jobs)) {
      for (const value of Object.values<string>(job.permissions ?? {})) expect(value).toBe('read');
    }
    expect(source).not.toMatch(/git push|git commit|gh pr |gh issue|pull-requests:|contents: write/);
    for (const s of sweep.steps) if (s.uses?.startsWith('actions/checkout')) expect(s.with['persist-credentials']).toBe(false);
  });

  test('one sweep at a time across every ref, never cancelled mid-spend', () => {
    expect(workflow.concurrency).toEqual({ group: 'eval-sweep', 'cancel-in-progress': false });
  });

  test('runs in the published CI image by digest with the census paid-eval setup', () => {
    expect(sweep.container.image).toBe('${{ needs.image.outputs.image-ref }}');
    expect(sweep.container.options).toBe('--user runner');
    expect(workflow.jobs.image.steps.map((s: any) => s.name ?? s.uses)).toContain('Resolve the published CI image digest');
    for (const name of ['Seed claude interactive config', 'Register gstack skills for PTY tests', 'Authenticate the Codex CLI']) expect(step(name)).toBeDefined();
    const run = step('Run the sweep');
    expect(run.env.ANTHROPIC_API_KEY).toBe('${{ secrets.ANTHROPIC_API_KEY }}');
    expect(run.env.GSTACK_CI_IMAGE).toBe('${{ needs.image.outputs.image-ref }}');
  });

  test('downloads the last 7 days of sweep reports before the sweep and passes them as --prior', () => {
    const names = sweep.steps.map((s: any) => s.name);
    expect(names.indexOf("Download this week's earlier sweep reports")).toBeLessThan(names.indexOf('Run the sweep'));
    const download = step("Download this week's earlier sweep reports");
    expect(download.run).toContain("date -u -d '7 days ago'");
    expect(download.run).toContain('--name ship-measure-sweep-report');
    expect(download.run).toContain('set -euo pipefail');
    expect(step('Run the sweep').run).toContain('--prior "$SWEEP_PRIOR"');
  });

  test('dispatch inputs reach the shell only through env', () => {
    const run = step('Run the sweep');
    expect(run.run).not.toContain('${{');
    expect(run.env).toMatchObject({ SWEEP_K: '${{ inputs.k }}', SWEEP_CAP_USD: '${{ inputs.cap_usd }}', SWEEP_DRY_RUN: '${{ inputs.dry_run }}' });
    expect(run.run).toContain('bun run scripts/ship-measure.ts sweep "${args[@]}"');
  });

  test('uploads the report and captures even when the sweep fails', () => {
    const report = step('Upload the sweep report');
    expect(report.if).toBe('always()');
    expect(report.with.name).toBe('ship-measure-sweep-report');
    expect(report.with.path).toContain('sweep-report.md');
    expect(step('Upload the sweep captures').if).toBe('always()');
  });
});
