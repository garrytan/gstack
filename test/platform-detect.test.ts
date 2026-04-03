import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DETECT = path.join(ROOT, 'bin', 'gstack-platform-detect');

describe('gstack-platform-detect', () => {
  test('syntax check passes', () => {
    const result = spawnSync('bash', ['-n', DETECT], { stdio: 'pipe' });
    expect(result.status).toBe(0);
  });

  test('lists OpenCode install path in script', () => {
    const result = Bun.file(DETECT).text();
    return result.then(content => {
      expect(content).toContain('opencode:opencode');
      expect(content).toContain('$HOME/.config/opencode/skills/gstack');
    });
  });
});
