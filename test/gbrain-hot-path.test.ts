import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
describe('gbrain governed hot path', () => {
  test('ship cannot load or sync gbrain implicitly', () => {
    expect(fs.readFileSync('ship/SKILL.md.tmpl', 'utf8')).not.toContain('{{GBRAIN_CONTEXT_LOAD}}');
    expect(fs.readFileSync('bin/gstack-skill-end', 'utf8')).toContain('review|ship|land-and-deploy|setup-deploy');
  });
});
