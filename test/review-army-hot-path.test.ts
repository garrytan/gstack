import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');

describe('Codex bounded in-host specialist hot path', () => {
  test('uses T1 semantic roles and never performs history-wide personalization or recursive model dispatch', () => {
    for (const skill of ['review', 'ship']) {
      const section = fs.readFileSync(path.join(root, `.agents/skills/gstack-${skill}/sections/review-army.md`), 'utf8');
      expect(section).toContain('SEMANTIC_ROLES_JSON');
      expect(section).toContain('gstack-execution-plan resolve');
      expect(section).toContain('current Codex agent');
      expect(section).toContain('conservative hard-section set');
      expect(section).not.toContain('gstack-specialist-stats');
      expect(section).not.toContain('gstack-learnings-search');
      expect(section).not.toContain('gstack-semantic-manifest');
      expect(section).not.toContain('gstack-diff-scope');
      expect(section).not.toContain('codex exec');
      expect(section).not.toContain('Agent tool');
    }
  });

  test('keeps every specialist asset available beneath the installed Codex runtime', () => {
    const setup = fs.readFileSync(path.join(root, 'setup'), 'utf8');
    const start = setup.indexOf('create_codex_runtime_root()');
    const end = setup.indexOf('\n}', start);
    const body = setup.slice(start, end);
    expect(body).toContain('review/specialists');
    expect(body).toContain('_link_or_copy');
  });
});
