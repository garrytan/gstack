/**
 * weekly-release.yml ("Stable release", free): the daily check's wiring (docs/releases.md#the-daily-check). The
 * cut job runs only off main, for the schedule and a dispatch, with the token
 * scoped to the tag, the stable branch and the release; a pull request that
 * touches the release tooling runs the dry run against main read-only; a
 * dispatched hotfix ref is a full SHA and the dry_run input, true by default,
 * never reaches the scheduled run; the security and regression inputs reach the
 * script only through env vars, beside a ref. The release-cut CLI the jobs call is
 * covered by crew/test/release-cut.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FLOOR_HOURS, SCHEDULED_GRACE_HOURS } from '../crew/scripts/release-cut';
import { FORCED_AFTER_HOURS, IMPORTANT_FLOOR_HOURS, REGULAR_DAYS } from '../crew/scripts/release-cadence';

type Step = { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { name?: string; if?: string; permissions?: Record<string, string>; 'timeout-minutes'?: number; steps: Step[] };
type Workflow = { on: Record<string, any>; concurrency: { group: string; 'cancel-in-progress': boolean }; permissions?: unknown; jobs: Record<string, Job> };
const ROOT = path.resolve(import.meta.dir, '..');
const wf = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/weekly-release.yml'), 'utf8')) as Workflow;
const BUN_RUN = 'bun --no-env-file --config=/dev/null --no-install run crew/scripts/release-cut.ts';

describe('weekly-release.yml', () => {
  // Value: protects=Garry's "twice a week" (2026-10-27) inside R74's daily check (2026-11-06: "as frequently as once a day and as infrequently as once a
  // week"): one daily 14:00 UTC run, whose Monday and Thursday runs are the regular cuts 72 h then 96 h apart; fails_when=the cron drifts off a daily 14:00, the
  // regular days or the gap and floor stop matching, or the important and forced floors leave once a day / once a week; why_new=the schedule was Mon/Thu only;
  // seam=none; no_claim=GitHub's cron start times
  test('a daily 14:00 schedule, a dispatch with dry_run (default true), a full-SHA ref, a security or regression reason or daily, and a pull request only for the release tooling', () => {
    expect((wf as { name?: string }).name).toBe('Stable release');
    expect(Object.keys(wf.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    expect(wf.on.schedule).toEqual([{ cron: '0 14 * * *' }]);
    expect(REGULAR_DAYS).toEqual([1, 4]);
    expect((REGULAR_DAYS[1]! - REGULAR_DAYS[0]!) * 24).toBe(FLOOR_HOURS);
    expect(IMPORTANT_FLOOR_HOURS).toBe(24);
    expect(FORCED_AFTER_HOURS).toBe(7 * 24);
    expect(wf.on.workflow_dispatch.inputs.daily).toMatchObject({ type: 'boolean', default: false });
    expect(SCHEDULED_GRACE_HOURS).toBeLessThan(FLOOR_HOURS / 12);
    expect(wf.on.workflow_dispatch.inputs.security).toMatchObject({ type: 'string', default: '' });
    expect(wf.on.workflow_dispatch.inputs.regression).toMatchObject({ type: 'string', default: '' });
    expect(wf.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
    expect(wf.on.workflow_dispatch.inputs.ref).toMatchObject({ type: 'string', default: '' });
    expect(wf.on.pull_request).toEqual({ paths: ['.github/workflows/weekly-release.yml', 'crew/scripts/release-cut.ts', 'crew/scripts/release-cadence.ts', 'lib/changelog-fragments.ts'] });
    expect(wf.concurrency).toEqual({ group: "weekly-release-${{ github.event.pull_request.number || 'cut' }}", 'cancel-in-progress': false });
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(['cut', 'dry-run']);
  });

  test('the cut job runs only off main for a schedule or dispatch, writes contents, reads checks, and rejects a ref that is not a 40-hex SHA', () => {
    const cut = wf.jobs.cut!;
    expect(cut.if).toBe("github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
    expect(cut.permissions).toEqual({ contents: 'write', checks: 'read', actions: 'read', issues: 'read', 'pull-requests': 'read' });
    expect(cut.steps.find(s => s.uses?.startsWith('actions/checkout@'))!.with).toEqual({ 'fetch-depth': 0 });
    const plan = cut.steps.find(s => s.name === 'Plan and cut')!;
    expect(plan.env!.GH_TOKEN).toBe('${{ github.token }}');
    expect(plan.env!.DRY_RUN).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'true' || 'false' }}");
    expect(plan.env!.RELEASE_REF).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.ref || '' }}");
    expect(plan.run).toContain('set -euo pipefail');
    expect(plan.run).toContain('[[ "$RELEASE_REF" =~ ^[0-9a-f]{40}$ ]]');
    expect(plan.run).toContain('[ "$DRY_RUN" = true ] && args+=(--dry-run)');
    expect(plan.run).toContain('[ -n "$RELEASE_REF" ] && args+=(--ref "$RELEASE_REF")');
    expect(plan.env!.SECURITY_REASON).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.security || '' }}");
    expect(plan.run).toContain('if [ -n "$SECURITY_REASON" ] && [ -z "$RELEASE_REF" ]; then');
    expect(plan.run).toContain('[ -n "$SECURITY_REASON" ] && args+=(--security "$SECURITY_REASON")');
    expect(plan.run).not.toContain('inputs.security');
    expect(plan.env!.REGRESSION_REASON).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.regression || '' }}");
    expect(plan.run).toContain('if [ -n "$REGRESSION_REASON" ] && [ -z "$RELEASE_REF" ]; then');
    expect(plan.run).toContain('[ -n "$REGRESSION_REASON" ] && args+=(--regression "$REGRESSION_REASON")');
    expect(plan.run).not.toContain('inputs.regression');
    expect(plan.run).toContain(BUN_RUN + ' "${args[@]}"');
    expect(plan.env!.DAILY).toBe("${{ (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.daily)) && 'true' || 'false' }}");
    expect(plan.run).toContain('[ "$DAILY" = true ] && args+=(--daily)');
    expect(plan.run).toContain('if [ "$DAILY" = true ] && [ -n "$RELEASE_REF$SECURITY_REASON$REGRESSION_REASON" ]; then');
    expect(plan.run).not.toContain('inputs.daily');
    expect(cut.steps.find(s => s.name === 'Fetch stable and the tags')!.run).toContain("git fetch --quiet origin '+refs/heads/stable:refs/remotes/origin/stable'");
  });

  test('the pull-request dry run is read-only, keeps no credentials, and always passes --dry-run', () => {
    const dry = wf.jobs['dry-run']!;
    expect(dry.if).toBe("github.event_name == 'pull_request'");
    expect(dry.permissions).toEqual({ contents: 'read', checks: 'read', actions: 'read' });
    expect(dry.steps.find(s => s.uses?.startsWith('actions/checkout@'))!.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    const plan = dry.steps.find(s => s.name === 'Plan only')!;
    expect(plan.run).toContain(BUN_RUN + ' --repo "$GITHUB_REPOSITORY" --summary "$GITHUB_STEP_SUMMARY" --dry-run\n');
    expect(plan.run).toContain(BUN_RUN + ' --repo "$GITHUB_REPOSITORY" --summary "$GITHUB_STEP_SUMMARY" --dry-run --daily\n');
    expect(plan.run).not.toContain('--ref');
    for (const job of Object.values(wf.jobs)) {
      expect(job['timeout-minutes']).toBe(20);
      for (const step of job.steps) if (step.run) expect(step.run).not.toMatch(/\b(bun install|bun test|EVALS=)/);
    }
  });
});
