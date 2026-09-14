#!/usr/bin/env bun
/**
 * analytics — CLI for viewing gstack skill usage statistics.
 *
 * Reads ~/.gstack/analytics/skill-usage.jsonl and displays:
 *   - Top skills by invocation count
 *   - Per-repo skill breakdown
 *   - Safety hook fire events
 *
 * Usage:
 *   bun run scripts/analytics.ts [--period 7d|30d|all]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AnalyticsEvent {
  skill: string;
  ts: string;
  repo: string;
  event?: string;
  pattern?: string;
}

const ANALYTICS_FILE = path.join(os.homedir(), '.gstack', 'analytics', 'skill-usage.jsonl');

/**
 * Parse JSONL content into AnalyticsEvent[], skipping malformed lines.
 */
export function parseJSONL(content: string): AnalyticsEvent[] {
  const events: AnalyticsEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj === 'object' && obj !== null && typeof obj.ts === 'string') {
        events.push(obj as AnalyticsEvent);
      }
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

/**
 * Filter events by period. Supports "7d", "30d", and "all".
 */
export function filterByPeriod(events: AnalyticsEvent[], period: string): AnalyticsEvent[] {
  if (period === 'all') return events;

  const match = period.match(/^(\d+)d$/);
  if (!match) return events;

  const days = parseInt(match[1], 10);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return events.filter(e => {
    const d = new Date(e.ts);
    return !isNaN(d.getTime()) && d >= cutoff;
  });
}

/**
 * Format a report string from a list of events.
 */
export function formatReport(events: AnalyticsEvent[], period: string = 'all'): string {
  const skillEvents = events.filter(e => e.event !== 'hook_fire');
  const hookEvents = events.filter(e => e.event === 'hook_fire');

  const lines: string[] = [];
  lines.push('gstack skill usage analytics');
  lines.push('\u2550'.repeat(39));
  lines.push('');

  const periodLabel = period === 'all' ? 'all time' : `last ${period.replace('d', ' days')}`;
  lines.push(`Period: ${periodLabel}`);

  // Top Skills
  const skillCounts = new Map<string, number>();
  for (const e of skillEvents) {
    skillCounts.set(e.skill, (skillCounts.get(e.skill) || 0) + 1);
  }

  if (skillCounts.size > 0) {
    lines.push('');
    lines.push('Top Skills');

    const sorted = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]);
    const maxName = Math.max(...sorted.map(([name]) => name.length + 1)); // +1 for /
    const maxCount = Math.max(...sorted.map(([, count]) => String(count).length));

    for (const [name, count] of sorted) {
      const label = `/${name}`;
      const suffix = `${count} invocation${count === 1 ? '' : 's'}`;
      const dotLen = Math.max(2, 25 - label.length - suffix.length);
      const dots = ' ' + '.'.repeat(dotLen) + ' ';
      lines.push(`  ${label}${dots}${suffix}`);
    }
  }

  // By Repo
  const repoSkills = new Map<string, Map<string, number>>();
  for (const e of skillEvents) {
    if (!repoSkills.has(e.repo)) repoSkills.set(e.repo, new Map());
    const m = repoSkills.get(e.repo)!;
    m.set(e.skill, (m.get(e.skill) || 0) + 1);
  }

  if (repoSkills.size > 0) {
    lines.push('');
    lines.push('By Repo');

    const sortedRepos = [...repoSkills.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [repo, skills] of sortedRepos) {
      const parts = [...skills.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([s, c]) => `${s}(${c})`);
      lines.push(`  ${repo}: ${parts.join(' ')}`);
    }
  }

  // Safety Hook Events
  const hookCounts = new Map<string, number>();
  for (const e of hookEvents) {
    if (e.pattern) {
      hookCounts.set(e.pattern, (hookCounts.get(e.pattern) || 0) + 1);
    }
  }

  if (hookCounts.size > 0) {
    lines.push('');
    lines.push('Safety Hook Events');

    const sortedHooks = [...hookCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [pattern, count] of sortedHooks) {
      const suffix = `${count} fire${count === 1 ? '' : 's'}`;
      const dotLen = Math.max(2, 25 - pattern.length - suffix.length);
      const dots = ' ' + '.'.repeat(dotLen) + ' ';
      lines.push(`  ${pattern}${dots}${suffix}`);
    }
  }

  // Total
  const totalSkills = skillEvents.length;
  const totalHooks = hookEvents.length;
  lines.push('');
  lines.push(`Total: ${totalSkills} skill invocation${totalSkills === 1 ? '' : 's'}, ${totalHooks} hook fire${totalHooks === 1 ? '' : 's'}`);

  return lines.join('\n');
}

function main() {
  // Parse --period flag
  let period = 'all';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--period' && i + 1 < args.length) {
      period = args[i + 1];
      i++;
    }
  }

  // Read file
  if (!fs.existsSync(ANALYTICS_FILE)) {
    console.log('No analytics data found.');
    process.exit(0);
  }

  const content = fs.readFileSync(ANALYTICS_FILE, 'utf-8').trim();
  if (!content) {
    console.log('No analytics data found.');
    process.exit(0);
  }

  const events = parseJSONL(content);
  if (events.length === 0) {
    console.log('No analytics data found.');
    process.exit(0);
  }

  const filtered = filterByPeriod(events, period);
  console.log(formatReport(filtered, period));
}

if (import.meta.main) {
  main();
}
