import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SKILL = fs.readFileSync(path.resolve(import.meta.dir, '..', 'setup-deploy', 'SKILL.md'), 'utf-8');

function section(heading: string, next: string): string {
  const start = SKILL.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  return SKILL.slice(start, SKILL.indexOf(next, start + heading.length));
}

describe('setup-deploy handles a project with nothing live yet', () => {
  test('the nothing-detected path stops before asking for values that do not exist', () => {
    const manual = section('#### Custom / Manual', '1. **How are deploys triggered?**');
    expect(manual).toContain('there is no production URL and no deploy trigger to record');
    expect(manual).toContain('Bring the project up first, and re-run `/setup-deploy` after the first production deploy exists');
    expect(manual).toContain('A library or CLI that never deploys still gets the `none` configuration');
  });

  test('the deploy-trigger question can be answered with the nothing-live state', () => {
    const question = section('1. **How are deploys triggered?**', "2. **What's the production URL?**");
    expect(question).toContain('E) Nothing is deployed yet, or this project never deploys (library, CLI, tool)');
  });
});
