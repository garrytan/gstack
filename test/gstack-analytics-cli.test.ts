import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProjectIdentity } from '../lib/project-identity';

const ROOT = path.resolve(import.meta.dir, '..');
const CLI = path.join(ROOT, 'bin', 'gstack-analytics');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { state: string; before: string[] } {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-analytics-cli-'));
  roots.push(state);
  const identity = resolveProjectIdentity(ROOT);
  const project = path.join(state, 'projects', identity.write_slug);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'timeline.jsonl'), JSON.stringify({
    skill: 'review', event: 'observation', ecpe: {
      schema_version: 1, run_id: 'run-cli', timestamp: '2026-08-31T00:00:00.000Z',
      wtree: 'repo-one', kind: 'decision', work_kind: 'review', finish_line: 'review_receipt',
      capability_ids: ['review.complete'],
    },
  }) + '\n');
  fs.writeFileSync(path.join(state, 'ignored.jsonl'), JSON.stringify({ ecpe: { run_id: 'ignored' } }) + '\n');
  return { state, before: fs.readdirSync(state, { recursive: true }).map(String).sort() };
}

describe('gstack-analytics ECPE CLI', () => {
  test('routes --ecpe --json to the shared aggregator and performs no writes', () => {
    const { state, before } = fixture();
    const result = spawnSync(CLI, ['--ecpe', '--json', '--period', 'all'], { timeout: 30_000,
      cwd: ROOT,
      env: { ...process.env, GSTACK_STATE_DIR: state },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.runs.map((run: any) => run.run_id)).toEqual(['run-cli']);
    expect(fs.readdirSync(state, { recursive: true }).map(String).sort()).toEqual(before);
  });

  test('accepts exact ISO bounds and rejects malformed periods', () => {
    const { state } = fixture();
    const bounded = spawnSync(CLI, ['--ecpe', '--json', '--from', '2026-08-30T00:00:00.000Z', '--to', '2026-09-01T00:00:00.000Z'], { timeout: 30_000,
      cwd: ROOT, env: { ...process.env, GSTACK_STATE_DIR: state }, encoding: 'utf8',
    });
    expect(bounded.status).toBe(0);
    expect(JSON.parse(bounded.stdout).runs).toHaveLength(1);

    const malformed = spawnSync(CLI, ['--ecpe', '--json', '--period', 'yesterday'], { timeout: 30_000,
      cwd: ROOT, env: { ...process.env, GSTACK_STATE_DIR: state }, encoding: 'utf8',
    });
    expect(malformed.status).not.toBe(0);
  });
});
