import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

describe('setup-deploy config boundary', () => {
  test('writes only the operations contract and leaves governance/profile read-only', () => {
    const body = fs.readFileSync('setup-deploy/SKILL.md.tmpl', 'utf8');
    expect(body).toContain('write only `docs/OPERATIONS.md`');
    expect(body).toContain('Never create or edit an instruction/governance file or `.gstack/work-profile.yaml`.');
    expect(body).not.toContain('{{THIRD_PARTY_ACTIONS}}');
  });
});
