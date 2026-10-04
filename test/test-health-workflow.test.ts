/**
 * Weekly test-health workflow wiring (CEO-18, DX-9): Monday after the
 * periodic census, a free hosted runner, exactly contents:read + actions:read
 * + issues:write, the enforce flag, and a tracking issue that only main runs
 * touch and that follows test:health's issueAction.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/test-health.yml'), 'utf8');
const workflow = Bun.YAML.parse(source) as any;
const steps: any[] = workflow.jobs.health.steps;
const step = (name: string) => steps.find(entry => entry.name === name);

describe('test-health.yml', () => {
  test('runs Monday after the 06:00 UTC census, plus dispatch, on a free runner', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '0 10 * * 1' }]);
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const census = fs.readFileSync(path.join(ROOT, '.github/workflows/evals-periodic.yml'), 'utf8').match(/cron: '(\d+) (\d+) \* \* 1'/);
    expect(Number(census?.[2])).toBeLessThan(10);
    expect(workflow.jobs.health['runs-on']).toBe('ubuntu-24.04');
  });

  test('holds exactly contents:read, actions:read and issues:write', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' });
    expect(workflow.jobs.health.permissions).toBeUndefined();
  });

  test('runs test:health over 7 days with --enforce and fails only on the recorded exit', () => {
    const run = step('Measure test health').run as string;
    expect(run).toContain('bun run test:health --since-days 7 --enforce --json');
    expect(run).toContain('issue_action=');
    expect(step('Fail when an enforced check failed').if).toBe("always() && steps.health.outputs.exit != '0'");
  });

  test('the tracking issue follows issueAction and only on main', () => {
    const issue = step('Update the tracking issue');
    expect(issue.if).toBe("always() && github.ref == 'refs/heads/main'");
    expect(issue.env.ISSUE_ACTION).toContain('steps.health.outputs.issue_action');
    for (const action of ['upsert)', 'close)', '*)']) expect(issue.run).toContain(action);
    expect(issue.run).toContain('gh issue close');
    expect(issue.run).toContain('gh issue create');
  });
});
