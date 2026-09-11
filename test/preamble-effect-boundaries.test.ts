import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
describe('governed preamble effect boundaries', () => {
  for (const skill of ['review', 'ship', 'land-and-deploy', 'setup-deploy']) {
    test(`${skill} omits inherited checkpoint and question writers`, () => {
      const body = fs.readFileSync(path.join(root, skill, 'SKILL.md'), 'utf8');
      expect(body).toContain('never inherits commit or push authority');
      expect(body).not.toContain('bin/gstack-question-log');
    });
  }
});
