import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
describe('generated governed workflow boundaries', () => {
  for (const skill of ['review', 'ship', 'land-and-deploy', 'setup-deploy']) {
    test(`${skill} carries the shared closed effect boundary`, () => {
      const body = read(`${skill}/SKILL.md`);
      expect(body).toContain('## ECPE workflow effect boundary');
      expect(body).toContain('Missing, stale, mismatched, or consumed scope means zero effect children.');
    });
  }
  test('governed hot paths do not compile broad helper setup', () => {
    expect(read('ship/SKILL.md.tmpl')).not.toContain('{{GBRAIN_CONTEXT_LOAD}}');
    expect(read('ship/SKILL.md.tmpl')).not.toContain('{{THIRD_PARTY_ACTIONS}}');
    expect(read('land-and-deploy/SKILL.md.tmpl')).not.toContain('{{BROWSE_SETUP}}');
    expect(read('land-and-deploy/SKILL.md.tmpl')).not.toContain('{{THIRD_PARTY_ACTIONS}}');
  });
});
