/**
 * R81 wiring (docs/pregate.md#docs-only): a docs-only pull request skips the suites, every required check still
 * concludes, a broken classifier never skips anything, and a push to main always runs the full suite.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const load = (f: string) => (Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')) as any).jobs as Record<string, any>;
const GATE = "!(needs.docs-scope.result == 'success' && needs.docs-scope.outputs.docs_only == 'true')";
const free = load('free-tests.yml');
const smoke = load('windows-smoke.yml');
const needs = (j: any) => [j.needs ?? []].flat();

describe('docs-scope', () => {
  test('runs only on pull requests, with a two-commit checkout and the shared action', () => {
    for (const jobs of [free, smoke]) {
      const s = jobs['docs-scope'];
      expect(s.if).toBe("github.event_name == 'pull_request'");
      expect(s.permissions).toBeUndefined();
      expect(s.steps[0].with['fetch-depth']).toBe(2);
      expect(s.steps.at(-1).uses).toBe('./.github/actions/docs-scope');
    }
  });
  test('the action runs the base branch classifier and treats a missing classifier or an error as not docs-only', () => {
    const a = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/actions/docs-scope/action.yml'), 'utf8')) as any;
    expect(a.runs.steps[0].with.ref).toBe('${{ github.event.pull_request.base.sha }}');
    const run: string = a.runs.steps[1].run;
    expect(run).toContain('.docs-scope-base/bin/gstack-docs-only');
    expect(run).toContain('--base HEAD^1 --head HEAD');
    expect(run).toContain("echo 'docs_only=false'");
    expect(run).toContain('exit 0');
  });
});

describe('free-tests', () => {
  const suites = ['free-plan', 'typecheck', 'quick-bun-default', 'cso-macos-launcher', 'macos-named-regressions', 'cso-windows-launcher', 'cso-docker-integration'];
  test('every suite job skips only when docs-scope succeeded and said docs-only', () => {
    for (const name of suites) {
      expect([name, needs(free[name])]).toEqual([name, expect.arrayContaining(['reuse', 'docs-scope'])]);
      expect([name, free[name].if]).toEqual([name, expect.stringContaining(GATE)]);
      expect([name, free[name].if]).toEqual([name, expect.stringContaining('!cancelled()')]);
    }
    expect(free['free-suite'].if).toContain("needs.free-plan.result == 'success'");
  });
  test('docs-lane runs the link check and the registered docs tests', () => {
    const lane = free['docs-lane'];
    expect(lane.if).toBe("needs.docs-scope.result == 'success' && needs.docs-scope.outputs.docs_only == 'true'");
    const runs = lane.steps.map((s: any) => s.run ?? '').join('\n');
    expect(runs).toContain('scripts/check-doc-links.ts --base HEAD^1');
    expect(runs).toContain('$DOCS_TESTS');
  });
  test('the required free-tests aggregator always runs and passes a docs-only pull request only after docs-lane passed', () => {
    const agg = free['free-tests'];
    expect(agg.if).toBe('always()');
    expect(needs(agg)).toEqual(expect.arrayContaining(['docs-scope', 'docs-lane']));
    const route = agg.steps[0];
    expect(route.id).toBe('route');
    expect(route.run).toContain('test "$GITHUB_EVENT_NAME" = pull_request');
    expect(route.run).toContain('test "$DOCS_LANE_RESULT" = success');
    expect(route.run.indexOf('DOCS_ONLY')).toBeLessThan(route.run.indexOf('REUSE_RESULT'));
  });
  test('a docs-only run never records or uploads a tested tree, so a push to main cannot reuse it', () => {
    const steps = free['free-tests'].steps.slice(1);
    for (const s of steps) expect([s.name ?? s.uses, s.if]).toEqual([s.name ?? s.uses, "steps.route.outputs.skip != 'true'"]);
    expect(steps.some((s: any) => String(s.run ?? '').includes('ci-tree-reuse.ts record'))).toBe(true);
  });
});

test('windows-smoke always runs, so its required check concludes success, and skips its steps only when docs-scope succeeded and said docs-only', () => {
  const job = smoke['windows-smoke'];
  expect(needs(job)).toEqual(['docs-scope']);
  expect(job.if).toBe(`${'$'}{{ !cancelled() }}`);
  expect(job.env.DOCS_ONLY).toBe("${{ needs.docs-scope.result == 'success' && needs.docs-scope.outputs.docs_only == 'true' }}");
  expect(job.steps[0].if).toBe("env.DOCS_ONLY == 'true'");
  for (const s of job.steps.slice(1)) expect([s.name ?? s.uses, s.if]).toEqual([s.name ?? s.uses, expect.stringMatching(/(^|&& )env\.DOCS_ONLY != 'true'$/)]);
});

test('every job that reads docs_only uses the fail-open-to-tests gate', () => {
  for (const [file, jobs] of [['free-tests.yml', free], ['windows-smoke.yml', smoke]] as const) {
    for (const [name, job] of Object.entries(jobs)) {
      if (name === 'docs-lane' || !String(job.if ?? '').includes('docs_only')) continue;
      expect([file, name, job.if]).toEqual([file, name, expect.stringContaining(GATE)]);
    }
  }
});
