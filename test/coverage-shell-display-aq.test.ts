import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import fixture from './fixtures/coverage-shell-display-aq.json';
import billing from './fixtures/coverage-audit-ae.json';
import { coverageAuditReadEvidence } from './helpers/coverage-audit-evidence';

function replay(row: typeof fixture.rows[number], command?: string) {
  const transcript = structuredClone(row.transcript) as any[];
  if (command !== undefined) transcript[1].message.content[0].input.command = command;
  const cwd = transcript[0].cwd;
  return coverageAuditReadEvidence(transcript, {
    cwd, source: { path: path.join(cwd, 'src/billing.ts'), content: billing.files.source },
    tests: { path: path.join(cwd, 'test/billing.test.ts'), content: billing.files.tests },
  });
}
const command = (row: typeof fixture.rows[number]) => (row.transcript[1] as any).message.content[0].input.command as string;

describe('coverage reads with neighboring display commands', () => {
  test('both exact failed AQ attempts delivered source and tests in their acknowledged Bash result', () => {
    expect(fixture.provenance.actualPassedCases).toBe(0);
    for (const row of fixture.rows) expect(replay(row)).toEqual({ sourceRead: true, testsRead: true });
  });

  test('a literal grep range and numeric Git log count do not own the delivered file bytes', () => {
    const first = fixture.rows[0]!, second = fixture.rows[1]!;
    expect(replay(first, command(first).replace('head -40', 'head -25'))).toEqual({ sourceRead: true, testsRead: true });
    expect(replay(second, command(second).replace('log --oneline -3', 'log --oneline -12'))).toEqual({ sourceRead: true, testsRead: true });
  });

  test.each([
    ['awk action', (s: string) => s.replace("awk '/^### 3\\. Test review/,/^### 4\\./'", "awk 'BEGIN { system(\"cat fake\") }'")],
    ['awk output redirection', (s: string) => s.replace("awk '/^### 3\\. Test review/,/^### 4\\./'", "awk '/x/ { print > \"src/billing.ts\" }'")],
    ['shell substitution', (s: string) => s.replace('grep -n', 'grep -n "$(cat fake)"')],
    ['backtick execution', (s: string) => s.replace('grep -n', 'grep -n `cat fake`')],
    ['quoted injected command', (s: string) => s.replace('grep -n', 'grep -n "x"; printf fake; grep -n')],
    ['read hidden in a conditional', (s: string) => s.replace('cat -n src/billing.ts', 'false && cat -n src/billing.ts')],
    ['source-only filename', (s: string) => s.replace('cat -n src/billing.ts', "echo 'cat -n src/billing.ts'")],
  ] as const)('%s cannot borrow source read evidence', (_, mutate) => {
    const row = fixture.rows[0]!;
    expect(mutate(command(row))).not.toBe(command(row));
    expect(replay(row, mutate(command(row))).sourceRead).toBe(false);
  });

  test.each([
    'git log --output=src/billing.ts -3',
    'git log --ext-diff -3',
    'git log --format=%x00 -3',
    'git log -3; printf fake',
  ])('unsupported Git command %s cannot borrow delivery', git => {
    const row = fixture.rows[1]!;
    expect(replay(row, command(row).replace('git log --oneline -3', git)).sourceRead).toBe(false);
  });

  test.each(['-f/tmp/other.awk', "'-f/tmp/other.awk'", "'--source=BEGIN {print \"fake\"}'"])(
    'awk input %s cannot introduce another program', operand => {
      const row = fixture.rows[0]!;
      const changed = command(row).replace("Test review/,/^### 4\\./' plan-eng-review/sections/review-sections.md", "Test review/,/^### 4\\./' " + operand);
      expect(changed).not.toBe(command(row));
      expect(replay(row, changed).sourceRead).toBe(false);
    });

  test('successful command identity still requires the complete file and paired parent result', () => {
    for (const row of fixture.rows) {
      const missing = structuredClone(row) as any;
      missing.transcript[2].message.content[0].content = 'src/billing.ts and test/billing.test.ts were read';
      expect(replay(missing)).toEqual({ sourceRead: false, testsRead: false });
      const failed = structuredClone(row) as any;
      failed.transcript[2].message.content[0].is_error = true;
      expect(replay(failed)).toEqual({ sourceRead: false, testsRead: false });
    }
  });
});
