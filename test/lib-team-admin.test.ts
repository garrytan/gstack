/**
 * Tests for lib/cli-team.ts — team admin pure functions.
 */

import { describe, test, expect } from 'bun:test';
import { formatMembersTable } from '../lib/cli-team';

describe('formatMembersTable', () => {
  test('formats members as table', () => {
    const members = [
      { user_id: 'u1', email: 'alice@test.com', role: 'owner' },
      { user_id: 'u2', email: 'bob@test.com', role: 'member' },
      { user_id: 'u3', email: 'carol@test.com', role: 'admin' },
    ];
    const output = formatMembersTable(members);

    expect(output).toContain('Team Members');
    expect(output).toContain('alice@test.com');
    expect(output).toContain('bob@test.com');
    expect(output).toContain('carol@test.com');
    expect(output).toContain('owner');
    expect(output).toContain('member');
    expect(output).toContain('admin');
    expect(output).toContain('3 members');
  });

  test('returns message for empty array', () => {
    const output = formatMembersTable([]);
    expect(output).toContain('No team members');
  });

  test('singular member count', () => {
    const members = [{ user_id: 'u1', role: 'owner' }];
    const output = formatMembersTable(members);
    expect(output).toContain('1 member');
    expect(output).not.toContain('1 members');
  });

  test('handles missing email gracefully', () => {
    const members = [{ user_id: 'uuid-1234-abcd', role: 'member' }];
    const output = formatMembersTable(members);
    expect(output).toContain('uuid-1234-abcd');
    expect(output).not.toContain('undefined');
  });

  test('truncates long emails', () => {
    const members = [{ user_id: 'u1', email: 'very-long-email-address-that-exceeds-the-column-width@extremely-long-domain-name.com', role: 'member' }];
    const output = formatMembersTable(members);
    // Should not break the table layout
    expect(output).toContain('Team Members');
    expect(output).toContain('member');
  });
});

describe('gstack team CLI', () => {
  test('help shows usage', () => {
    const proc = Bun.spawnSync(['bun', 'run', 'lib/cli-team.ts', '--help']);
    const stdout = proc.stdout?.toString() || '';
    expect(stdout).toContain('gstack team');
    expect(stdout).toContain('create');
    expect(stdout).toContain('members');
    expect(stdout).toContain('set');
  });

  test('unknown command exits with error', () => {
    const proc = Bun.spawnSync(['bun', 'run', 'lib/cli-team.ts', 'nonsense']);
    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr?.toString() || '';
    expect(stderr).toContain('Unknown command');
  });

  test('create without args shows usage', () => {
    const proc = Bun.spawnSync(['bun', 'run', 'lib/cli-team.ts', 'create']);
    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr?.toString() || '';
    expect(stderr).toContain('Usage');
  });

  test('set without args shows usage', () => {
    const proc = Bun.spawnSync(['bun', 'run', 'lib/cli-team.ts', 'set']);
    expect(proc.exitCode).toBe(1);
    const stderr = proc.stderr?.toString() || '';
    expect(stderr).toContain('Usage');
  });
});
