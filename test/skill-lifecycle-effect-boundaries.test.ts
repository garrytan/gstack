import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
describe('governed lifecycle hot path', () => {
  test('short-circuits before onboarding and artifact writers', () => {
    const start = fs.readFileSync(path.join(root, 'bin/gstack-skill-start'), 'utf8');
    expect(start.indexOf('review|ship|land-and-deploy|setup-deploy')).toBeLessThan(start.indexOf('gstack-update-check'));
    const end = fs.readFileSync(path.join(root, 'bin/gstack-skill-end'), 'utf8');
    expect(end.indexOf('review|ship|land-and-deploy|setup-deploy')).toBeLessThan(end.indexOf('gstack-config'));
  });
});
