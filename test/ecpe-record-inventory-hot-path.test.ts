import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function subject(): Promise<any> {
  return import('../lib/ecpe-metrics').catch(() => null);
}

function setup(reportCount: number): { repo: string; state: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-inventory-repo-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-inventory-state-'));
  roots.push(repo, state);
  fs.chmodSync(state, 0o700);
  fs.mkdirSync(path.join(repo, 'docs', 'reports'), { recursive: true });
  for (let i = 0; i < reportCount; i++) fs.writeFileSync(path.join(repo, 'docs', 'reports', `report-${i}.md`), 'x');
  return { repo, state };
}

describe('bounded record inventory', () => {
  test('ordinary unchanged start/end cost is constant after the one baseline reconciliation', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    const { repo, state } = setup(1200);
    const inventory = new api.RecordInventory({ repositoryRoot: repo, stateRoot: state, projectId: 'repo-one' });

    const baseline = inventory.start('run-baseline');
    inventory.end(baseline);
    const unchanged = inventory.start('run-unchanged');
    const result = inventory.end(unchanged);

    expect(result.report_entries_opened).toBe(0);
    expect(result.open_plus_stat_calls).toBeLessThanOrEqual(16);
    expect(result.record_coverage).toBe('complete');
    expect(result.observations).toEqual([]);
  });

  test('detects external create/delete after a changed sentinel and marks over-budget coverage unknown', async () => {
    const api = await subject();
    expect(api).not.toBeNull();
    const { repo, state } = setup(2);
    const inventory = new api.RecordInventory({ repositoryRoot: repo, stateRoot: state, projectId: 'repo-two', reconciliationEntryBudget: 4 });
    inventory.end(inventory.start('run-baseline'));

    const started = inventory.start('run-change');
    fs.rmSync(path.join(repo, 'docs', 'reports', 'report-0.md'));
    fs.writeFileSync(path.join(repo, 'docs', 'reports', 'report-new.md'), 'x');
    const changed = inventory.end(started);
    expect(changed.record_coverage).toBe('complete');
    expect(changed.observations).toEqual([]);

    const overBudgetStart = inventory.start('run-budget');
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(repo, 'docs', 'reports', `extra-${i}.md`), 'x');
    const overBudget = inventory.end(overBudgetStart);
    expect(overBudget.record_coverage).toBe('unknown');
    expect(overBudget.health_reconciliation_queued).toBe(true);
  });
});
