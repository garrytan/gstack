import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import budget from './fixtures/ecpe-overhead-budget.v1.json';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ECPE tiny-task overhead budget', () => {
  test('uses a committed golden and never recalibrates during the test', async () => {
    const api = await import('../lib/ecpe-metrics').catch(() => null) as any;
    expect(api).not.toBeNull();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-overhead-'));
    roots.push(root);
    const observation = {
      schema_version: 1, run_id: 'run-overhead', timestamp: '2026-08-31T00:00:00.000Z',
      wtree: 'repo-one', kind: 'decision', work_kind: 'change', finish_line: 'local_change',
      capability_ids: ['change.complete'],
    };
    const measured = api.appendEcpeBatch(path.join(root, 'timeline.jsonl'), [observation]);

    expect(measured.telemetry_extra_processes).toBe(budget.ceilings.telemetry_extra_processes);
    expect(measured.append_lock_fsync_transactions).toBeLessThanOrEqual(budget.ceilings.append_lock_fsync_transactions);
    expect(measured.fsync_calls).toBeLessThanOrEqual(budget.ceilings.fsync_calls);
    expect(measured.open_plus_stat_calls).toBeLessThanOrEqual(budget.ceilings.open_plus_stat_calls);
    expect(measured.bytes_written).toBeLessThanOrEqual(budget.ceilings.bytes_written);
  });

  test('fault-disabled writer returns the same validation/effect decision', async () => {
    const api = await import('../lib/ecpe-metrics').catch(() => null) as any;
    expect(api).not.toBeNull();
    const observation = {
      schema_version: 1, run_id: 'run-fault', timestamp: '2026-08-31T00:00:00.000Z',
      wtree: 'repo-one', kind: 'effect', work_kind: 'change', finish_line: 'local_change',
      effect: { effect: 'tracked_write', phase: 'observed', source: 'adapter_observed', scope: {
        repo_id: 'repo-one', ref_or_pr: null, target_id: null, paths_or_surface: ['src/a.ts'],
        environment: null, index_preimage_hash: null, binding_id: null, projection_id: null,
      } },
    };
    expect(api.decideEcpeAppend([observation], { disabled: false })).toEqual(api.decideEcpeAppend([observation], { disabled: true }));
  });
});
