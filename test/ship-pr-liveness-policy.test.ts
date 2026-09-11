import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const template = fs.readFileSync(
  path.join(import.meta.dir, '..', '.github', 'PULL_REQUEST_TEMPLATE.md'),
  'utf8',
);

describe('gstack PR liveness policy', () => {
  test('remembers the authenticated repository-owner exemption', () => {
    expect(template).toContain('Repository owner @garrytan is explicitly exempt');
    expect(template).toContain('gh api user --jq .login');
    expect(template).toMatch(/Git author metadata\s+alone is not sufficient/);
    expect(template).toContain('PR author is @garrytan (owner exemption)');
  });

  test('retains live GSTACK PR proof for every other contributor', () => {
    expect(template).toContain('required for external contributors');
    expect(template).toContain('All other contributors');
    expect(template).toContain('`GSTACK PR` typed LIVE');
    expect(template).toContain('not drawn,\noverlaid, or edited onto the image');
  });
});
