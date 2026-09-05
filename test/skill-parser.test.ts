import { describe, test, expect } from 'bun:test';
import { extractBrowseCommands, validateSkill } from './helpers/skill-parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const FIXTURES_DIR = path.join(os.tmpdir(), 'skill-parser-test');

function writeFixture(name: string, content: string): string {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const p = path.join(FIXTURES_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('extractBrowseCommands', () => {
  test('extracts $B commands from bash code blocks', () => {
    const p = writeFixture('basic.md', [
      '# Test',
      '```bash',
      '$B goto https://example.com',
      '$B snapshot -i',
      '```',
    ].join('\n'));
    const cmds = extractBrowseCommands(p);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toBe('goto');
    expect(cmds[0].args).toEqual(['https://example.com']);
    expect(cmds[1].command).toBe('snapshot');
    expect(cmds[1].args).toEqual(['-i']);
  });

  test('skips non-bash code blocks', () => {
    const p = writeFixture('skip.md', [
      '```json',
      '{"key": "$B goto bad"}',
      '```',
      '```bash',
      '$B text',
      '```',
    ].join('\n'));
    const cmds = extractBrowseCommands(p);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toBe('text');
  });

  test('returns empty array for file with no code blocks', () => {
    const p = writeFixture('no-blocks.md', '# Just text\nSome content\n');
    const cmds = extractBrowseCommands(p);
    expect(cmds).toHaveLength(0);
  });

  test('returns empty array for code blocks with no $B invocations', () => {
    const p = writeFixture('no-b.md', [
      '```bash',
      'echo "hello"',
      'ls -la',
      '```',
    ].join('\n'));
    const cmds = extractBrowseCommands(p);
    expect(cmds).toHaveLength(0);
  });

  test('handles multiple $B commands on one line', () => {
    const p = writeFixture('multi.md', [
      '```bash',
      '$B click @e3       $B fill @e4 "value"     $B hover @e1',
      '```',
    ].join('\n'));
    const cmds = extractBrowseCommands(p);
    expect(cmds).toHaveLength(3);
    expect(cmds[0].command).toBe('click');
    expect(cmds[1].command).toBe('fill');
    expect(cmds[1].args).toEqual(['@e4', 'value']);
    expect(cmds[2].command).toBe('hover');
  });

  test('handles quoted arguments correctly', () => {
    const p = writeFixture('quoted.md', [
      '```bash',
      '$B fill @e3 "test@example.com"',
      '$B js "document.title"',
      '```',
    ].join('\n'));
    const cmds = extractBrowseCommands(p);
    expect(cmds[0].args).toEqual(['@e3', 'test@example.com']);
    expect(cmds[1].args).toEqual(['document.title']);
  });

  test('tracks correct line numbers', () => {
    const p = writeFixture('lines.md', [
      '# Header',     // line 1
      '',              // line 2
      '```bash',       // line 3
      '$B goto x',     // line 4
      '```',           // line 5
      '',              // line 6
      '```bash',       // line 7
      '$B text',       // line 8
      '```',           // line 9
    ].join('\n'));
    const cmds = extractBrowseCommands(p);
    expect(cmds[0].line).toBe(4);
    expect(cmds[1].line).toBe(8);
  });

  test('skips unlabeled code blocks', () => {
    const p = writeFixture('unlabeled.md', [
      '```',
      '$B snapshot -i',
      '```',
    ].join('\n'));
    const cmds = extractBrowseCommands(p);
    expect(cmds).toHaveLength(0);
  });
});

describe('validateSkill', () => {
  test('every $B invocation is a retired browse command: invalid, reported with file:line', () => {
    const p = writeFixture('retired.md', [
      '# Skill',
      '```bash',
      '$B goto https://example.com',
      'echo ok',
      '$B snapshot -i',
      '```',
    ].join('\n'));
    const result = validateSkill(p);
    expect(result.valid).toHaveLength(0);
    expect(result.snapshotFlagErrors).toHaveLength(0);
    expect(result.invalid.map(c => [c.command, c.line])).toEqual([['goto', 3], ['snapshot', 5]]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain(`${p}:3`);
    expect(result.warnings[0]).toContain('retired browse command');
    expect(result.warnings[0]).toContain('Aside');
  });

  test('a skill with no $B is clean: nothing invalid, no warnings', () => {
    const p = writeFixture('clean.md', [
      '# Nothing here',
      '```bash',
      'aside repl \'console.log("ASIDE_READY " + pwd)\'',
      '```',
    ].join('\n'));
    expect(validateSkill(p)).toEqual({ valid: [], invalid: [], snapshotFlagErrors: [], warnings: [] });
  });

  test('$BASE_BRANCH and other $B-prefixed variables are not $B commands', () => {
    const p = writeFixture('vars.md', [
      '```bash',
      'git diff $BASE_BRANCH...HEAD',
      'echo "$BRANCH"',
      '```',
    ].join('\n'));
    expect(validateSkill(p).invalid).toHaveLength(0);
  });
});
