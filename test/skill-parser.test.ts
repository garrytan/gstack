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
  test('valid commands pass validation', () => {
    const p = writeFixture('valid.md', [
      '```bash',
      '$B goto https://example.com',
      '$B text',
      '$B click @e3',
      '$B snapshot -i -a',
      '```',
    ].join('\n'));
    const result = validateSkill(p);
    expect(result.valid).toHaveLength(4);
    expect(result.invalid).toHaveLength(0);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });

  test('invalid commands flagged in result', () => {
    const p = writeFixture('invalid.md', [
      '```bash',
      '$B goto https://example.com',
      '$B explode',
      '$B halp',
      '```',
    ].join('\n'));
    const result = validateSkill(p);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(2);
    expect(result.invalid[0].command).toBe('explode');
    expect(result.invalid[1].command).toBe('halp');
  });

  test('snapshot flags validated via parseSnapshotArgs', () => {
    const p = writeFixture('bad-snapshot.md', [
      '```bash',
      '$B snapshot --bogus',
      '```',
    ].join('\n'));
    const result = validateSkill(p);
    expect(result.snapshotFlagErrors).toHaveLength(1);
    expect(result.snapshotFlagErrors[0].error).toContain('Unknown snapshot flag');
  });

  test('returns warning when no $B commands found', () => {
    const p = writeFixture('empty.md', '# Nothing here\n');
    const result = validateSkill(p);
    expect(result.warnings).toContain('no $B commands found');
  });

  test('valid snapshot flags pass', () => {
    const p = writeFixture('snap-valid.md', [
      '```bash',
      '$B snapshot -i -a -C -o /tmp/out.png',
      '$B snapshot -D',
      '$B snapshot -d 3',
      '$B snapshot -s "main"',
      '```',
    ].join('\n'));
    const result = validateSkill(p);
    expect(result.valid).toHaveLength(4);
    expect(result.snapshotFlagErrors).toHaveLength(0);
  });
});
