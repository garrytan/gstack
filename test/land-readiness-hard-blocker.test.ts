import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('land readiness hard-blocker contract', () => {
  test('hard blockers have one terminal stop and never render merge-anyway', () => {
    const template = fs.readFileSync(path.join(ROOT, 'land-and-deploy/sections/readiness-gate.md.tmpl'), 'utf8');
    const blocker = template.match(/<!-- ECPE_BLOCKER_BRANCH_START -->([\s\S]*?)<!-- ECPE_BLOCKER_BRANCH_END -->/)?.[1] ?? '';
    expect(blocker).toContain('BLOCKER_COUNT > 0');
    expect(blocker).toContain('STOP');
    expect(blocker).not.toMatch(/merge anyway|override/i);
  });

  test('warning-only branch retains an explicit warning override', () => {
    const template = fs.readFileSync(path.join(ROOT, 'land-and-deploy/sections/readiness-gate.md.tmpl'), 'utf8');
    const warning = template.match(/<!-- ECPE_WARNING_BRANCH_START -->([\s\S]*?)<!-- ECPE_WARNING_BRANCH_END -->/)?.[1] ?? '';
    expect(warning).toContain('BLOCKER_COUNT == 0');
    expect(warning).toContain('WARNING_COUNT > 0');
    expect(warning).toContain('Proceed despite warnings');
  });

  test('generated first-run validation names one exact PR adapter and no unsupported gh fields', () => {
    const template = fs.readFileSync(path.join(ROOT, 'land-and-deploy/sections/first-run-validation.md.tmpl'), 'utf8');
    expect(template).toContain('gstack-pr-checks snapshot --pr "$PR_NUMBER"');
    expect(template).not.toMatch(/gh pr checks[^\n]*(status|conclusion|targetUrl)/);
  });
});
