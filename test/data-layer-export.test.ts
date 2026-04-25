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
  });
});
