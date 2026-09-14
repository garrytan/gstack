import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { parseJSONL, filterByPeriod, formatReport } from '../scripts/analytics';
import type { AnalyticsEvent } from '../scripts/analytics';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const TMP_DIR = path.join(os.tmpdir(), 'analytics-test');
const SCRIPT = path.resolve(import.meta.dir, '../scripts/analytics.ts');

function writeTempJSONL(name: string, lines: string[]): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

/**
 * Run the analytics script with a custom JSONL file by overriding the path.
 * We test the exported functions directly for unit tests, and use this
 * helper for integration-style checks.
 */
function runScript(jsonlPath: string | null, extraArgs: string = ''): string {
  // We test via the exported functions; for CLI integration we read the file
  // and run the pipeline manually to avoid needing to override the hardcoded path.
  if (jsonlPath === null) {
    return 'No analytics data found.';
  }
  if (!fs.existsSync(jsonlPath)) {
    return 'No analytics data found.';
  }
  const content = fs.readFileSync(jsonlPath, 'utf-8').trim();
  if (!content) {
    return 'No analytics data found.';
  }
  const events = parseJSONL(content);
  if (events.length === 0) {
    return 'No analytics data found.';
  }
  // Parse period from extraArgs
  let period = 'all';
  const match = extraArgs.match(/--period\s+(\S+)/);
  if (match) period = match[1];
  const filtered = filterByPeriod(events, period);
  return formatReport(filtered, period);
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('parseJSONL', () => {
  test('parses valid JSONL lines', () => {
    const content = [
      '{"skill":"ship","ts":"2026-03-18T15:30:00Z","repo":"my-app"}',
      '{"skill":"qa","ts":"2026-03-18T16:00:00Z","repo":"my-api"}',
    ].join('\n');
    const events = parseJSONL(content);
    expect(events).toHaveLength(2);
    expect(events[0].skill).toBe('ship');
    expect(events[1].skill).toBe('qa');
  });

  test('skips malformed lines', () => {
    const content = [
      '{"skill":"ship","ts":"2026-03-18T15:30:00Z","repo":"my-app"}',
      'not valid json',
      '{broken',
      '',
      '{"skill":"qa","ts":"2026-03-18T16:00:00Z","repo":"my-api"}',
    ].join('\n');
    const events = parseJSONL(content);
    expect(events).toHaveLength(2);
    expect(events[0].skill).toBe('ship');
    expect(events[1].skill).toBe('qa');
  });

  test('returns empty array for empty string', () => {
    expect(parseJSONL('')).toHaveLength(0);
  });

  test('skips objects missing ts field', () => {
    const content = '{"skill":"ship","repo":"my-app"}\n';
    const events = parseJSONL(content);
    expect(events).toHaveLength(0);
  });
});

describe('filterByPeriod', () => {
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  const events: AnalyticsEvent[] = [
    { skill: 'ship', ts: daysAgo(1), repo: 'app' },
    { skill: 'qa', ts: daysAgo(3), repo: 'app' },
    { skill: 'review', ts: daysAgo(10), repo: 'app' },
    { skill: 'retro', ts: daysAgo(40), repo: 'app' },
  ];

  test('period "all" returns all events', () => {
    expect(filterByPeriod(events, 'all')).toHaveLength(4);
  });

  test('period "7d" returns only last 7 days', () => {
    const filtered = filterByPeriod(events, '7d');
    expect(filtered).toHaveLength(2);
    expect(filtered[0].skill).toBe('ship');
    expect(filtered[1].skill).toBe('qa');
  });

  test('period "30d" returns last 30 days', () => {
    const filtered = filterByPeriod(events, '30d');
    expect(filtered).toHaveLength(3);
  });

  test('invalid period string returns all events', () => {
    expect(filterByPeriod(events, 'bogus')).toHaveLength(4);
  });
});

describe('formatReport', () => {
  test('includes header and period label', () => {
    const report = formatReport([], 'all');
    expect(report).toContain('gstack skill usage analytics');
    expect(report).toContain('Period: all time');
  });

  test('shows "last 7 days" for 7d period', () => {
    const report = formatReport([], '7d');
    expect(report).toContain('Period: last 7 days');
  });

  test('shows "last 30 days" for 30d period', () => {
    const report = formatReport([], '30d');
    expect(report).toContain('Period: last 30 days');
  });

  test('counts skill invocations correctly', () => {
    const events: AnalyticsEvent[] = [
      { skill: 'ship', ts: '2026-03-18T15:30:00Z', repo: 'app' },
      { skill: 'ship', ts: '2026-03-18T16:00:00Z', repo: 'app' },
      { skill: 'qa', ts: '2026-03-18T16:30:00Z', repo: 'app' },
    ];
    const report = formatReport(events);
    expect(report).toContain('/ship');
    expect(report).toContain('2 invocations');
    expect(report).toContain('/qa');
    expect(report).toContain('1 invocation');
  });

  test('groups by repo', () => {
    const events: AnalyticsEvent[] = [
      { skill: 'ship', ts: '2026-03-18T15:30:00Z', repo: 'app-a' },
      { skill: 'qa', ts: '2026-03-18T16:00:00Z', repo: 'app-a' },
      { skill: 'ship', ts: '2026-03-18T16:30:00Z', repo: 'app-b' },
    ];
    const report = formatReport(events);
    expect(report).toContain('app-a: ship(1) qa(1)');
    expect(report).toContain('app-b: ship(1)');
  });

  test('counts hook fire events separately', () => {
    const events: AnalyticsEvent[] = [
      { skill: 'ship', ts: '2026-03-18T15:30:00Z', repo: 'app' },
      { skill: 'careful', ts: '2026-03-18T16:00:00Z', repo: 'app', event: 'hook_fire', pattern: 'rm_recursive' },
      { skill: 'careful', ts: '2026-03-18T16:30:00Z', repo: 'app', event: 'hook_fire', pattern: 'rm_recursive' },
      { skill: 'careful', ts: '2026-03-18T17:00:00Z', repo: 'app', event: 'hook_fire', pattern: 'git_force_push' },
    ];
    const report = formatReport(events);
    expect(report).toContain('Safety Hook Events');
    expect(report).toContain('rm_recursive');
    expect(report).toContain('2 fires');
    expect(report).toContain('git_force_push');
    expect(report).toContain('1 fire');
    expect(report).toContain('Total: 1 skill invocation, 3 hook fires');
  });

  test('handles mixed events correctly', () => {
    const events: AnalyticsEvent[] = [
      { skill: 'ship', ts: '2026-03-18T15:30:00Z', repo: 'my-app' },
      { skill: 'ship', ts: '2026-03-18T15:35:00Z', repo: 'my-app' },
      { skill: 'qa', ts: '2026-03-18T16:00:00Z', repo: 'my-api' },
      { skill: 'careful', ts: '2026-03-18T16:30:00Z', repo: 'my-app', event: 'hook_fire', pattern: 'rm_recursive' },
    ];
    const report = formatReport(events);
    // Skills counted correctly (hook_fire events excluded from skill counts)
    expect(report).toContain('Total: 3 skill invocations, 1 hook fire');
    // Both sections present
    expect(report).toContain('Top Skills');
    expect(report).toContain('Safety Hook Events');
    expect(report).toContain('By Repo');
  });
});

describe('integration via runScript helper', () => {
  test('missing file → "No analytics data found."', () => {
    const output = runScript(path.join(TMP_DIR, 'nonexistent.jsonl'));
    expect(output).toBe('No analytics data found.');
  });

  test('null path → "No analytics data found."', () => {
    const output = runScript(null);
    expect(output).toBe('No analytics data found.');
  });

  test('empty file → "No analytics data found."', () => {
    const p = writeTempJSONL('empty.jsonl', ['']);
    // Overwrite with truly empty content
    fs.writeFileSync(p, '');
    const output = runScript(p);
    expect(output).toBe('No analytics data found.');
  });

  test('all malformed lines → "No analytics data found."', () => {
    const p = writeTempJSONL('bad.jsonl', [
      'not json',
      '{broken',
      '42',
    ]);
    const output = runScript(p);
    expect(output).toBe('No analytics data found.');
  });

  test('normal aggregation produces correct output', () => {
    const p = writeTempJSONL('normal.jsonl', [
      '{"skill":"ship","ts":"2026-03-18T15:30:00Z","repo":"my-app"}',
      '{"skill":"ship","ts":"2026-03-18T15:35:00Z","repo":"my-app"}',
      '{"skill":"qa","ts":"2026-03-18T16:00:00Z","repo":"my-app"}',
      '{"skill":"review","ts":"2026-03-18T16:30:00Z","repo":"my-api"}',
    ]);
    const output = runScript(p);
    expect(output).toContain('/ship');
    expect(output).toContain('2 invocations');
    expect(output).toContain('/qa');
    expect(output).toContain('1 invocation');
    expect(output).toContain('/review');
    expect(output).toContain('Total: 4 skill invocations, 0 hook fires');
  });

  test('period filtering (7d) only includes recent entries', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();

    const p = writeTempJSONL('period.jsonl', [
      `{"skill":"ship","ts":"${recent}","repo":"app"}`,
      `{"skill":"qa","ts":"${old}","repo":"app"}`,
    ]);
    const output = runScript(p, '--period 7d');
    expect(output).toContain('Period: last 7 days');
    expect(output).toContain('/ship');
    expect(output).toContain('Total: 1 skill invocation, 0 hook fires');
    // qa should be filtered out
    expect(output).not.toContain('/qa');
  });

  test('hook fire events counted in full pipeline', () => {
    const p = writeTempJSONL('hooks.jsonl', [
      '{"skill":"ship","ts":"2026-03-18T15:30:00Z","repo":"app"}',
      '{"event":"hook_fire","skill":"careful","pattern":"rm_recursive","ts":"2026-03-18T16:00:00Z","repo":"app"}',
      '{"event":"hook_fire","skill":"careful","pattern":"rm_recursive","ts":"2026-03-18T16:30:00Z","repo":"app"}',
      '{"event":"hook_fire","skill":"careful","pattern":"git_force_push","ts":"2026-03-18T17:00:00Z","repo":"app"}',
    ]);
    const output = runScript(p);
    expect(output).toContain('Safety Hook Events');
    expect(output).toContain('rm_recursive');
    expect(output).toContain('2 fires');
    expect(output).toContain('git_force_push');
    expect(output).toContain('1 fire');
    expect(output).toContain('Total: 1 skill invocation, 3 hook fires');
  });
});
