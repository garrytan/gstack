import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('setup-deploy profile boundary', () => {
  test('is report-only for machine policy and writes only the operations document', () => {
    const body = readFileSync('setup-deploy/SKILL.md.tmpl', 'utf8');
    expect(body).toContain('gstack-work-profile preview-deploy-targets --json');
    expect(body).toContain('profile_write_count=0');
    expect(body).toContain('docs/OPERATIONS.md');
    expect(body).not.toContain('update-deploy-targets');
    expect(body).not.toContain('echo $RENDER_API_KEY');
  });
});
