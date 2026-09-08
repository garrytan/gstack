/** Existing review storage must preserve legacy and per-phase outside provenance. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

describe('outside-review provenance through actual log and dashboard reader', () => {
  test('mixed history preserves native/external Claude identities, phase failures, and multiple model usage', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gstack-outside-provenance-'));
    const repo = join(scratch, 'repo');
    mkdirSync(repo);
    const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_HOME: join(scratch, 'state'), GSTACK_PROJECT_SLUG: 'outside-provenance-fixture' };
    const run = (args: string[]) => {
      const result = Bun.spawnSync(args, { cwd: repo, env, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
      if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`);
      return result.stdout.toString();
    };
    try {
      run(['git', 'init', '-b', 'main']);
      run(['git', 'config', 'user.email', 'fixture@example.com']);
      run(['git', 'config', 'user.name', 'Provenance Fixture']);
      writeFileSync(join(repo, 'invoice.ts'), 'export const protectedInvoice = true;\n');
      run(['git', 'add', 'invoice.ts']);
      run(['git', 'commit', '-m', 'fixture']);
      const records = [
        { skill: 'adversarial-review', source: 'claude', status: 'clean', timestamp: '2026-08-01T00:00:00Z' },
        { skill: 'codex-review', source: 'codex', status: 'issues_found', timestamp: '2026-08-02T00:00:00Z' },
        { skill: 'autoplan-voices', source: 'claude-code', host: 'codex', outside_provider: 'claude-code', outside_status: 'completed', phase: 'ceo', status: 'clean', modelUsage: { 'model-a': { inputTokens: 10 }, 'model-b': { inputTokens: 15 } } },
        { skill: 'autoplan-voices', source: 'in-host', host: 'codex', outside_provider: 'claude-code', outside_status: 'unavailable', phase: 'design', status: 'issues_found' },
        { skill: 'autoplan-voices', source: 'in-host', host: 'codex', outside_provider: 'claude-code', outside_status: 'disabled', phase: 'dx', status: 'clean' },
        { skill: 'autoplan-voices', source: 'in-host', host: 'codex', outside_provider: 'claude-code', outside_status: 'skipped', phase: 'eng', status: 'clean' },
        { skill: 'codex-plan-review', source: 'codex', host: 'cursor', outside_provider: 'codex', outside_status: 'completed', phase: 'eng', status: 'issues_found' },
      ];
      for (const record of records) run([join(ROOT, 'bin/gstack-review-log'), JSON.stringify(record)]);
      // Change the reading harness: readers must not reinterpret old provenance.
      env.GSTACK_ACTIVE_HOST = 'claude';
      const text = run([join(ROOT, 'bin/gstack-review-read')]);
      const restored = text.split('---CONFIG---')[0].trim().split('\n').map(line => JSON.parse(line));
      expect(restored).toHaveLength(records.length);
      records.forEach((record, index) => {
        expect(restored[index]).toMatchObject(record);
        expect(restored[index].model).toBeUndefined();
      });
      expect(restored[0].outside_provider).toBeUndefined();
      expect(restored[0].host).toBeUndefined();
      expect(restored.filter(record => record.source === 'claude')).toHaveLength(1);
      expect(restored.filter(record => record.source === 'claude-code')).toHaveLength(1);
      const phases = restored.filter(record => record.skill === 'autoplan-voices');
      expect(phases.map(record => [record.phase, record.outside_status])).toEqual([
        ['ceo', 'completed'], ['design', 'unavailable'], ['dx', 'disabled'], ['eng', 'skipped'],
      ]);
      expect(phases.filter(record => record.outside_status === 'completed')).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
