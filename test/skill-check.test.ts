import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('skill-check template coverage', () => {
  test('accepts skills intentionally skipped by the Claude host', () => {
    const result = spawnSync('bun', ['run', 'scripts/skill-check.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    const claudeTemplateLine = result.stdout
      .split('\n')
      .find((line) => line.includes('claude/SKILL.md'));

    expect(claudeTemplateLine).toContain('intentionally skipped for Claude Code');
    expect(claudeTemplateLine).not.toContain('generated file missing');
  });
});
