import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('profile-mode deploy workflow', () => {
  test('uses one fused plan and compiled adapter state without mutable-ref guesses', () => {
    const body = readFileSync('land-and-deploy/sections/merge-and-deploy.md.tmpl', 'utf8');
    expect(body).toContain('gstack-execution-plan resolve');
    expect(body).toContain('dispatch count must remain zero');
    expect(body).toContain('observed_merge_sha');
    expect(body).not.toContain('gh run list');
    expect(body).not.toContain('git switch -c');
    expect(body).not.toContain('branch cleanup');
  });
});
