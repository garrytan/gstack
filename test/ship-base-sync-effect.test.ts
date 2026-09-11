import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';

describe('ship base-sync effect', () => {
  test('uses a closed fail-safe boundary and forbids conflict auto-resolution', () => {
    const body = fs.readFileSync('ship/SKILL.md.tmpl', 'utf8');
    const section = body.slice(body.indexOf('## Step 3:'), body.indexOf('{{SECTION:tests}}'));
    expect(section).toContain('ship.base_sync');
    expect(section).toContain('exact pre-sync HEAD');
    expect(section).not.toContain('git merge origin/');
    expect(section).not.toContain('Try to auto-resolve');
  });
});
