/**
 * Opt-in tests that self-skip in the free suite must have a lane that opts
 * in. .github/workflows/platform-qualification.yml is that lane for the ML
 * classifier, real-gitleaks and Swift build checks; this pins that each gate
 * variable the files read is set by a job that runs exactly those files.
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const WORKFLOW = '.github/workflows/platform-qualification.yml';
const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8')) as any;

const GATES: Array<{ job: string; variable: string; files: string[] }> = [
  { job: 'security-ml', variable: 'SECURITY_BENCH', files: ['browse/test/security-bench.test.ts', 'browse/test/security-live-playwright.test.ts'] },
  { job: 'gitleaks', variable: 'GSTACK_TEST_GITLEAKS', files: ['test/gstack-memory-ingest.test.ts', 'test/gstack-memory-helpers.test.ts'] },
  { job: 'ios-swift-build', variable: 'GSTACK_TEST_SWIFT', files: ['test/ios-qa-swift-build.test.ts'] },
];

test('runs on dispatch and on a quarterly schedule with read-only permissions', () => {
  expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  expect(workflow.on.schedule).toEqual([{ cron: '0 8 1 1,4,7,10 *' }]);
  expect(workflow.permissions).toEqual({ contents: 'read' });
});

for (const { job, variable, files } of GATES) {
  test(`${job} sets ${variable} and runs its gated files`, () => {
    const steps: any[] = workflow.jobs?.[job]?.steps ?? [];
    const run = steps.find(step => files.every(file => String(step.run ?? '').includes(file)));
    expect(run, `${WORKFLOW} job "${job}" has no step running ${files.join(' ')}; fix: add "bun test ${files.join(' ')}" to that job`).toBeDefined();
    const setsVariable = `${variable}` in (run.env ?? {}) || String(run.run).includes(`${variable}=`);
    expect(setsVariable, `${WORKFLOW} job "${job}" runs its files without ${variable}, so they self-skip; fix: set ${variable} on that step`).toBe(true);
    for (const file of files) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), `${file} no longer reads ${variable}; fix: update GATES here and the workflow together`).toContain(variable);
    }
  });
}
