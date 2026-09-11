import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
describe('browse effect boundary', () => {
  test('land cannot bootstrap browse', () => {
    expect(fs.readFileSync('land-and-deploy/SKILL.md.tmpl', 'utf8')).not.toContain('{{BROWSE_SETUP}}');
  });
});
