/**
 * OSV suppression expiry (F11). Every [[IgnoredVulns]] entry carries an
 * ignoreUntil, and the weekly scan turns red the first Monday after one
 * passes. This free test fails 14 days before any expiry, so the
 * re-justification lands in a PR instead of surprising the cron. It also pins
 * the workflow's tracking-issue job, so a scheduled red notifies someone.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const CONFIG = '.osv-scanner.toml';
const EXPIRY_WARNING_DAYS = 14;

interface Suppression { id: string; ignoreUntil: string }

function suppressions(toml: string): Suppression[] {
  return toml.split('[[IgnoredVulns]]').slice(1).map(entry => ({
    id: entry.match(/^id = "([^"]+)"/m)?.[1] ?? '(missing id)',
    ignoreUntil: entry.match(/^ignoreUntil = (\S+)/m)?.[1] ?? '',
  }));
}

/** Entries whose ignoreUntil is within `days` of `now` (or already past, or unparseable). */
function expiringSoon(entries: Suppression[], now: number, days = EXPIRY_WARNING_DAYS): string[] {
  return entries.filter(entry => {
    const until = Date.parse(entry.ignoreUntil);
    return !Number.isFinite(until) || until - now <= days * 86_400_000;
  }).map(entry => `${entry.id} (ignoreUntil ${entry.ignoreUntil || 'missing'})`);
}

const FIX = `Fix: for each entry, re-run the OSV scan (gh workflow run osv-scanner.yml) and check for an upstream fix; upgrade via package.json overrides and delete the entry, or re-justify its reason and move ignoreUntil forward in ${CONFIG}.`;

describe('OSV suppression expiry', () => {
  test(`no suppression in ${CONFIG} expires within ${EXPIRY_WARNING_DAYS} days`, () => {
    const entries = suppressions(fs.readFileSync(path.join(ROOT, CONFIG), 'utf8'));
    expect(entries.length).toBeGreaterThan(0);
    const soon = expiringSoon(entries, Date.now());
    if (soon.length) throw new Error(`${soon.length} OSV suppression(s) expire within ${EXPIRY_WARNING_DAYS} days: ${soon.join(', ')}.\n${FIX}`);
  });

  test('the window is 14 days, inclusive, and a missing or bad date counts as expiring', () => {
    const entries = [{ id: 'GHSA-a', ignoreUntil: '2026-11-30T00:00:00Z' }, { id: 'GHSA-b', ignoreUntil: 'soon' }];
    expect(expiringSoon(entries, Date.parse('2026-11-15T23:59:59Z'))).toEqual(['GHSA-b (ignoreUntil soon)']);
    expect(expiringSoon(entries, Date.parse('2026-11-16T00:00:00Z'))).toEqual(['GHSA-a (ignoreUntil 2026-11-30T00:00:00Z)', 'GHSA-b (ignoreUntil soon)']);
    expect(FIX).toContain('move ignoreUntil forward');
  });

  test('a failed main scan upserts a tracking issue and a clean one closes it', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/osv-scanner.yml'), 'utf8')) as any;
    const report = workflow.jobs.report;
    expect(report.needs).toBe('scan');
    expect(report.if).toBe("always() && github.ref == 'refs/heads/main'");
    expect(report.permissions).toEqual({ issues: 'write' });
    const run = report.steps[0].run as string;
    expect(report.steps[0].env.SCAN_RESULT).toBe('${{ needs.scan.result }}');
    for (const text of ['"$SCAN_RESULT" = "failure"', 'gh issue create', 'gh issue comment', 'gh issue close']) expect(run).toContain(text);
  });
});
