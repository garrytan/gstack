import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-analytics');

// Verifies the per-skill avg-duration calculation in the bash dashboard
// (bin/gstack-analytics) parses both unquoted and quoted "duration_s"
// values from skill-usage.jsonl. The completion-status preamble (and
// gstack-codex-probe) emit quoted strings; gstack-telemetry-log emits
// unquoted numbers. The previous awk regex stripped from the leading
// quote, silently yielding avg=0 for quoted-only skills.
describe('gstack-analytics avg duration parsing', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-analytics-test-'));
    fs.mkdirSync(path.join(stateDir, 'analytics'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function run(jsonl: string[]): string {
    fs.writeFileSync(
      path.join(stateDir, 'analytics', 'skill-usage.jsonl'),
      jsonl.join('\n') + '\n',
    );
    const r = spawnSync('bash', [BIN, 'all'], {
      env: { ...process.env, GSTACK_STATE_DIR: stateDir },
      encoding: 'utf-8',
    });
    if (r.status !== 0) {
      throw new Error(`gstack-analytics failed (status ${r.status}): ${r.stderr}`);
    }
    return r.stdout;
  }

  // Pull "(avg <value>)" out of a /skill row.
  function avgFor(report: string, skill: string): string {
    const re = new RegExp(`/${skill}\\b[^\\n]*\\(avg ([^)]+)\\)`);
    const m = report.match(re);
    if (!m) throw new Error(`no avg row for /${skill} in:\n${report}`);
    return m[1];
  }

  test('quoted "duration_s" values are averaged (regression: previously read as 0)', () => {
    const output = run([
      '{"skill":"review","duration_s":"120","outcome":"success","ts":"2026-05-25T10:00:00Z"}',
      '{"skill":"review","duration_s":"180","outcome":"success","ts":"2026-05-25T11:00:00Z"}',
      '{"skill":"review","duration_s":"60","outcome":"success","ts":"2026-05-25T12:00:00Z"}',
    ]);
    // (120+180+60)/3 = 120s = 2m
    expect(avgFor(output, 'review')).toBe('2m');
  });

  test('unquoted numeric "duration_s" values are averaged', () => {
    const output = run([
      '{"skill":"qa","duration_s":300,"outcome":"success","ts":"2026-05-25T13:00:00Z"}',
      '{"skill":"qa","duration_s":420,"outcome":"success","ts":"2026-05-25T14:00:00Z"}',
    ]);
    // (300+420)/2 = 360s = 6m
    expect(avgFor(output, 'qa')).toBe('6m');
  });

  test('mixed quoted and unquoted values average together', () => {
    const output = run([
      '{"skill":"ship","duration_s":"30","outcome":"success","ts":"2026-05-25T10:00:00Z"}',
      '{"skill":"ship","duration_s":50,"outcome":"success","ts":"2026-05-25T11:00:00Z"}',
    ]);
    // (30+50)/2 = 40s — under 60 so shown in seconds, exercising both paths.
    expect(avgFor(output, 'ship')).toBe('40s');
  });

  test('total time sums quoted and unquoted across all skills', () => {
    const output = run([
      '{"skill":"review","duration_s":"120","outcome":"success","ts":"2026-05-25T10:00:00Z"}',
      '{"skill":"qa","duration_s":300,"outcome":"success","ts":"2026-05-25T13:00:00Z"}',
    ]);
    // 120+300 = 420s = 7m
    expect(output).toContain('Total time: 7m');
  });
});
