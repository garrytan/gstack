import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const source = (name: string) => readFileSync(join(root, 'land-and-deploy', name), 'utf8');

describe('land-and-deploy handles a recorded command deploy trigger', () => {
  test('Step 5 routes a recorded command trigger before URL polling', () => {
    const merge = source('sections/merge-and-deploy.md.tmpl');
    const route = merge.indexOf('2. Recorded command trigger');
    expect(route).toBeGreaterThanOrEqual(0);
    expect(route).toBeLessThan(merge.indexOf('Otherwise use configured production URL/status checks'));
    expect(merge).toContain('production has not moved yet');
    expect(merge).toContain('a zero exit is not');
  });

  test('Strategy D runs the recorded command before claiming revision proof', () => {
    const main = source('SKILL.md.tmpl');
    const start = main.indexOf('### Strategy D: Custom deploy hooks');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = main.slice(start, main.indexOf('### Common: Timing and failure handling'));
    expect(body).toContain('records a command as the deploy trigger');
    expect(body).toContain('not live until the recorded command runs');
    expect(body).toContain('explicit approval');
    expect(body).toContain('not revision proof on its own');
  });
});
