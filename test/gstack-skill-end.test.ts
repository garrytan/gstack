import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const START = path.join(ROOT, 'bin', 'gstack-skill-start');
const END = path.join(ROOT, 'bin', 'gstack-skill-end');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ECPE lifecycle completion', () => {
  test('skill start and end preserve one authoritative run id in the same timeline', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-lifecycle-state-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-lifecycle-repo-'));
    roots.push(state, repo);
    fs.chmodSync(state, 0o700);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\ntelemetry: off\n');
    const env = {
      ...process.env,
      HOME: repo,
      GSTACK_HOME: state,
      GSTACK_PROJECT_SLUG: 'ecpe-lifecycle',
      ECPE_TESTING: '1',
      ECPE_TEST_STATE_ROOT: state,
    };
    const started = execFileSync(START, ['--skill', 'review', '--parent-pid', '12345'], { timeout: 30_000, cwd: repo, env, encoding: 'utf8' });
    const runId = started.match(/^RUN_ID: (\S+)$/m)?.[1];
    const telStart = started.match(/^TEL_START: (\S+)$/m)?.[1];
    expect(runId).toBeTruthy();

    execFileSync(END, ['--skill', 'review', '--outcome', 'success', '--session-id', runId!, '--tel-start', telStart!], { timeout: 30_000, cwd: repo, env, encoding: 'utf8' });
    const timeline = path.join(state, 'projects', 'ecpe-lifecycle', 'timeline.jsonl');
    const entries = fs.readFileSync(timeline, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const lifecycle = entries.filter(entry => entry.run_id === runId);
    expect(lifecycle.map(entry => entry.event)).toEqual(['started', 'completed']);
    expect(lifecycle.filter(entry => entry.ecpe?.kind === 'context')).toHaveLength(1);
  });

  test('flushes one bounded content-free host batch during the existing skill-end process', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-lifecycle-batch-state-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-lifecycle-batch-repo-'));
    roots.push(state, repo);
    fs.chmodSync(state, 0o700);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\ntelemetry: off\n');
    const env = {
      ...process.env, HOME: repo, GSTACK_HOME: state, GSTACK_PROJECT_SLUG: 'ecpe-batch',
      ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: state,
    };
    const started = execFileSync(START, ['--skill', 'review', '--parent-pid', '23456'], { timeout: 30_000, cwd: repo, env, encoding: 'utf8' });
    const runId = started.match(/^RUN_ID: (\S+)$/m)![1];
    const telStart = started.match(/^TEL_START: (\S+)$/m)![1];
    const batch = JSON.stringify([{ kind: 'decision', semantic_roles: ['code'], capability_ids: ['review.complete'] }]);

    execFileSync(END, [
      '--skill', 'review', '--outcome', 'success', '--session-id', runId, '--tel-start', telStart,
      '--ecpe-batch-json', batch,
    ], { timeout: 30_000, cwd: repo, env, encoding: 'utf8' });

    const timeline = path.join(state, 'projects', 'ecpe-batch', 'timeline.jsonl');
    const entries = fs.readFileSync(timeline, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const decisions = entries.filter(entry => entry.ecpe?.kind === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].ecpe).toMatchObject({ run_id: runId, semantic_roles: ['code'], capability_ids: ['review.complete'] });
  });
});
