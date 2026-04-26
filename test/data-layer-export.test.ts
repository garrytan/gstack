import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const EXPORT_BIN = join(ROOT, 'bin', 'gstack-data-layer-export');

let tmpRoot: string;
let stateDir: string;
let workDir: string;

function runExport(args: string[] = []) {
  return spawnSync('bun', [EXPORT_BIN, ...args], {
    cwd: workDir,
    env: {
      ...process.env,
      GSTACK_STATE_DIR: stateDir,
    },
    encoding: 'utf8',
  });
}

function readJsonl(file: string) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gstack-data-layer-test-'));
  stateDir = join(tmpRoot, 'state');
  workDir = join(tmpRoot, 'work');
  mkdirSync(join(stateDir, 'analytics'), { recursive: true });
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('gstack-data-layer-export', () => {
  test('normalizes local skill analytics into dashboard-ready files', () => {
    writeFileSync(join(stateDir, 'analytics', 'skill-usage.jsonl'), [
      JSON.stringify({
        v: 1,
        ts: '2026-04-25T18:00:00Z',
        event_type: 'skill_run',
        skill: 'qa',
        session_id: 's1',
        duration_s: 12,
        outcome: 'success',
        _repo_slug: 'private/secret-repo',
      }),
      JSON.stringify({
        v: 1,
        ts: '2026-04-25T18:05:00Z',
        event_type: 'skill_run',
        skill: 'review',
        session_id: 's2',
        duration_s: 30,
        outcome: 'error',
        _repo_slug: 'private/secret-repo',
      }),
      JSON.stringify({ ts: '2026-04-25T18:06:00Z', event: 'hook_fire', skill: 'qa' }),
      'not json',
    ].join('\n'));

    const result = runExport(['--date', '2026-04-25', '--project', 'demo', '--domain', 'real_estate']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent_events=2');

    const outDir = join(workDir, '.gstack', 'data-layer', 'exports', '2026-04-25');
    expect(existsSync(join(outDir, 'agent-events.jsonl'))).toBe(true);
    expect(existsSync(join(outDir, 'agent-events.csv'))).toBe(true);
    expect(existsSync(join(outDir, 'workflow-outcomes.json'))).toBe(true);
    expect(existsSync(join(outDir, 'dashboard-summary.json'))).toBe(true);

    const agentEvents = readJsonl(join(outDir, 'agent-events.jsonl'));
    expect(agentEvents).toHaveLength(2);
    expect(agentEvents[0].skill).toBe('/qa');
    expect(agentEvents[0].duration_ms).toBe(12000);
    expect(agentEvents[0].privacy_level).toBe('local_only');
    expect(agentEvents[0].repo_slug_hash).toStartWith('sha256:');

    const allOutput = readFileSync(join(outDir, 'agent-events.jsonl'), 'utf8') +
      readFileSync(join(outDir, 'dashboard-summary.json'), 'utf8');
    expect(allOutput).not.toContain('private/secret-repo');

    const summary = JSON.parse(readFileSync(join(outDir, 'dashboard-summary.json'), 'utf8'));
    expect(summary.counts.agent_events).toBe(2);
    expect(summary.data_quality.malformed_analytics_lines).toBe(1);
  });

  test('includes optional redacted business events', () => {
    writeFileSync(join(stateDir, 'analytics', 'skill-usage.jsonl'), '');
    mkdirSync(join(workDir, '.gstack', 'data-layer'), { recursive: true });
    writeFileSync(join(workDir, '.gstack', 'data-layer', 'business-events.jsonl'), [
      JSON.stringify({
        created_at: '2026-04-25T18:05:00Z',
        domain: 'real_estate',
        entity_type: 'lead',
        entity_id: 'raw-local-id-that-should-be-hashed',
        workflow: 'lead_intake',
        event_type: 'lead_created',
        value: 1,
        source: 'manual',
        metadata_redacted: { lead_source: 'website' },
        pii_level: 'none',
      }),
      '{broken',
    ].join('\n'));

    const result = runExport(['--date', '2026-04-25', '--domain', 'real_estate']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('business_events=1');

    const outDir = join(workDir, '.gstack', 'data-layer', 'exports', '2026-04-25');
    const businessEvents = readJsonl(join(outDir, 'business-events.jsonl'));
    expect(businessEvents).toHaveLength(1);
    expect(businessEvents[0].entity_id_hash).toStartWith('sha256:');
    expect(businessEvents[0].metadata_redacted.lead_source).toBe('website');

    const summary = JSON.parse(readFileSync(join(outDir, 'dashboard-summary.json'), 'utf8'));
    expect(summary.data_quality.malformed_business_event_lines).toBe(1);
  });

  test('exports cron timelines, time buckets, categories, and local dashboard artifacts', () => {
    writeFileSync(join(stateDir, 'analytics', 'skill-usage.jsonl'), [
      JSON.stringify({
        v: 1,
        ts: '2026-04-25T18:15:00Z',
        event_type: 'skill_run',
        skill: 'review',
        session_id: 'agent-a',
        duration_s: 60,
        outcome: 'success',
        tokens_in_estimate: 1000,
        tokens_out_estimate: 250,
      }),
    ].join('\n'));
    mkdirSync(join(workDir, '.gstack', 'data-layer'), { recursive: true });
    writeFileSync(join(workDir, '.gstack', 'data-layer', 'category-rules.json'), JSON.stringify({
      default_category: 'personal',
      rules: [
        { category: 'coding', skills: ['/review'], workflows: ['listing_copy_qa'] },
        { category: 'admin', run_types: ['cron'] },
      ],
    }));
    writeFileSync(join(workDir, '.gstack', 'data-layer', 'cron-runs.jsonl'), [
      JSON.stringify({
        id: 'cron_daily_followup',
        started_at: '2026-04-25T09:00:00Z',
        finished_at: '2026-04-25T09:12:00Z',
        name: 'daily follow-up sweep',
        workflow: 'crm_followup',
        schedule: '0 9 * * *',
        status: 'success',
        agent_id: 'private-agent-id',
        tokens_in_estimate: 2000,
        tokens_out_estimate: 600,
        cost_estimate_usd: 0.12,
      }),
      'bad json',
    ].join('\n'));

    const result = runExport(['--date', '2026-04-25', '--bucket', 'hour']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cron_runs=1');
    expect(result.stdout).toContain('dashboard_html=');

    const outDir = join(workDir, '.gstack', 'data-layer', 'exports', '2026-04-25');
    expect(existsSync(join(outDir, 'dashboard.html'))).toBe(true);
    expect(existsSync(join(outDir, 'daily-report.md'))).toBe(true);

    const cronRuns = readJsonl(join(outDir, 'cron-runs.jsonl'));
    expect(cronRuns).toHaveLength(1);
    expect(cronRuns[0].started_at).toBe('2026-04-25T09:00:00.000Z');
    expect(cronRuns[0].finished_at).toBe('2026-04-25T09:12:00.000Z');
    expect(cronRuns[0].duration_ms).toBe(720000);
    expect(cronRuns[0].agent_id_hash).toStartWith('sha256:');
    expect(JSON.stringify(cronRuns)).not.toContain('private-agent-id');

    const activitySeries = JSON.parse(readFileSync(join(outDir, 'activity-series.json'), 'utf8'));
    expect(activitySeries.some((row: any) => row.bucket_start === '2026-04-25T09:00:00.000Z' && row.cron_runs === 1)).toBe(true);
    expect(activitySeries.some((row: any) => row.bucket_start === '2026-04-25T18:00:00.000Z' && row.agent_runs === 1)).toBe(true);

    const categorySummary = JSON.parse(readFileSync(join(outDir, 'category-summary.json'), 'utf8'));
    expect(categorySummary.some((row: any) => row.category === 'coding' && row.agent_runs === 1)).toBe(true);
    expect(categorySummary.some((row: any) => row.category === 'admin' && row.cron_runs === 1)).toBe(true);

    const summary = JSON.parse(readFileSync(join(outDir, 'dashboard-summary.json'), 'utf8'));
    expect(summary.counts.cron_runs).toBe(1);
    expect(summary.counts.active_agents).toBeGreaterThanOrEqual(1);
    expect(summary.resources.tokens_total_estimate).toBe(3850);
    expect(summary.data_quality.malformed_cron_run_lines).toBe(1);
  });

  test('succeeds with missing inputs and writes empty local-only export', () => {
    const result = runExport(['--date', '2026-04-25']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent_events=0');
    expect(result.stdout).toContain('business_events=0');

    const outDir = join(workDir, '.gstack', 'data-layer', 'exports', '2026-04-25');
    const summary = JSON.parse(readFileSync(join(outDir, 'dashboard-summary.json'), 'utf8'));
    expect(summary.privacy_model).toBe('local_only');
    expect(summary.data_quality.analytics_file_missing).toBe(true);
    expect(summary.data_quality.business_events_file_missing).toBe(true);
    expect(summary.data_quality.cron_runs_file_missing).toBe(true);
  });
});
