import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('skill:check', () => {
  test('accepts template outputs intentionally skipped for the primary host', () => {
    const result = spawnSync('bun', ['run', 'scripts/skill-check.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude/SKILL.md');
    expect(result.stdout).toContain('intentionally skipped for Claude Code');
  });
});
