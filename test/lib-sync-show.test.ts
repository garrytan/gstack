/**
 * Tests for sync show formatting functions (pure, no network).
 */

import { describe, test, expect } from 'bun:test';
import { formatTeamSummary, formatEvalTable, formatShipTable, formatSessionTable, formatRelativeTime } from '../lib/cli-sync';

describe('formatRelativeTime', () => {
  test('returns "just now" for recent timestamps', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now');
  });

  test('returns minutes for recent past', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });

  test('returns hours for older past', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });

  test('returns days for old past', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
  });
});

describe('formatTeamSummary', () => {
  test('formats summary with data', () => {
    const output = formatTeamSummary({
      teamSlug: 'test-team',
      evalRuns: [
        { timestamp: new Date().toISOString(), user_id: 'u1', tests: [{ detection_rate: 4 }] },
        { timestamp: new Date().toISOString(), user_id: 'u2', tests: [{ detection_rate: 5 }] },
      ],
      shipLogs: [
        { created_at: new Date().toISOString() },
      ],
      retroSnapshots: [
        { date: '2026-03-15', streak_days: 47 },
      ],
      queueSize: 0,
      cacheLastPull: new Date().toISOString(),
    });

    expect(output).toContain('test-team');
    expect(output).toContain('2 runs');
    expect(output).toContain('2 contributors');
    expect(output).toContain('1 PRs');
    expect(output).toContain('4.5');  // avg detection
    expect(output).toContain('streak: 47d');
    expect(output).toContain('0 items');
  });

  test('handles empty data gracefully', () => {
    const output = formatTeamSummary({
      teamSlug: 'empty-team',
      evalRuns: [],
      shipLogs: [],
      retroSnapshots: [],
      queueSize: 3,
      cacheLastPull: null,
    });

    expect(output).toContain('empty-team');
    expect(output).toContain('0 runs');
    expect(output).toContain('0 PRs');
    expect(output).toContain('3 items');
    expect(output).toContain('never');
  });
});

describe('formatEvalTable', () => {
  test('formats eval runs as table', () => {
    const output = formatEvalTable([
      { timestamp: '2026-03-15T12:00:00Z', branch: 'main', passed: 10, total_tests: 10, total_cost_usd: 2.50, tier: 'e2e' },
    ]);

    expect(output).toContain('Recent Eval Runs');
    expect(output).toContain('2026-03-15');
    expect(output).toContain('main');
    expect(output).toContain('10/10');
    expect(output).toContain('$2.50');
    expect(output).toContain('e2e');
  });

  test('returns message for empty data', () => {
    expect(formatEvalTable([])).toContain('No eval runs yet');
  });
});

describe('formatShipTable', () => {
  test('formats ship logs as table', () => {
    const output = formatShipTable([
      { created_at: '2026-03-15T12:00:00Z', version: '0.3.10', branch: 'feature/sync', pr_url: 'https://github.com/org/repo/pull/1' },
    ]);

    expect(output).toContain('Recent Ship Logs');
    expect(output).toContain('0.3.10');
    expect(output).toContain('feature/sync');
    expect(output).toContain('github.com');
  });

  test('returns message for empty data', () => {
    expect(formatShipTable([])).toContain('No ship logs yet');
  });
});

describe('formatSessionTable', () => {
  test('formats sessions with enriched data', () => {
    const output = formatSessionTable([
      {
        started_at: '2026-03-15T10:00:00Z',
        ended_at: '2026-03-15T10:15:00Z',
        repo_slug: 'garrytan/gstack',
        summary: 'Fixed login page CSS and added tests',
        total_turns: 8,
        tools_used: ['Edit', 'Bash', 'Read'],
      },
    ]);

    expect(output).toContain('Recent Sessions');
    expect(output).toContain('2026-03-15');
    expect(output).toContain('garrytan/gstack');
    expect(output).toContain('Fixed login');
    expect(output).toContain('8');
    expect(output).toContain('15m');
    expect(output).toContain('Edit');
  });

  test('handles sessions without enrichment', () => {
    const output = formatSessionTable([
      {
        started_at: '2026-03-15T10:00:00Z',
        ended_at: '2026-03-15T10:00:30Z',
        repo_slug: 'myproject',
        summary: null,
        total_turns: 2,
        tools_used: null,
      },
    ]);

    expect(output).toContain('Recent Sessions');
    expect(output).toContain('myproject');
    // null summary shows as '—'
    expect(output).toContain('—');
  });

  test('returns message for empty data', () => {
    expect(formatSessionTable([])).toContain('No sessions yet');
  });

  test('formats duration correctly', () => {
    const output = formatSessionTable([
      {
        started_at: '2026-03-15T10:00:00Z',
        ended_at: '2026-03-15T11:30:00Z',
        repo_slug: 'repo',
        summary: 'Long session',
        total_turns: 50,
        tools_used: ['Bash'],
      },
    ]);

    expect(output).toContain('1h30m');
  });
});
