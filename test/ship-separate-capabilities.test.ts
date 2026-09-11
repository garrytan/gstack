import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

describe('ship capability separation', () => {
  test('has narrow triggers and no implicit third-party/gbrain setup', () => {
    const body = fs.readFileSync('ship/SKILL.md.tmpl', 'utf8');
    expect(body).not.toContain('  - deploy\n');
    expect(body).not.toContain('merge and push');
    expect(body).not.toContain('get it deployed');
    expect(body).not.toContain('{{THIRD_PARTY_ACTIONS}}');
    expect(body).not.toContain('{{GBRAIN_CONTEXT_LOAD}}');
  });
});
