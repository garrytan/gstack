import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OVERLAY_CASE_FILES, OVERLAY_MIN_FILE_WALL_MS } from './helpers/overlay-case-policy';
import { AUTOPLAN_CHAIN_BUDGET } from './helpers/eval-budgets';
import {
  applyHollowShardGuard, buildPaidShardArgs, buildRunManifest,
  DEFAULT_SHARD_TIMEOUT_MS, isOverlayTestFile, OVERLAY_MAX_ACTIVE_SHARDS,
  parseCliOptions, parseRunManifest, planPaidShards, resolvePaidShardBudget, resolvePaidShardTimeoutMs,
  retriesForFiles, runPaidShards, summarize, summaryExitCode,
} from '../scripts/test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const overlayFiles = Object.values(OVERLAY_CASE_FILES).map(id => `test/skill-e2e-overlay-harness-${id}.test.ts`);
const normalFile = 'test/skill-e2e-normal-fixture.test.ts';
const fakeEnv = {
  PATH: path.dirname(process.execPath),
  GSTACK_CLAUDE_CLI_VERSION: 'free-fixture',
  GSTACK_SDK_MAX_CONCURRENCY: '7',
};

describe('overlay file policy', () => {
  test('grouped planning isolates every overlay and preserves ordinary retries', () => {
    const workflow = 'test/skill-e2e-workflow.test.ts';
    const files = [...overlayFiles, normalFile, workflow];
    for (const maxFilesPerShard of [2, 3, 10]) {
      const shards = planPaidShards(files, { maxFilesPerShard });
      expect(shards.flat().sort()).toEqual([...files].sort());
      for (const file of overlayFiles) expect(shards).toContainEqual([file]);
      const workflowShard = shards.find(shard => shard.includes(workflow))!;
      expect(workflowShard.some(isOverlayTestFile)).toBe(false);
      expect(retriesForFiles(workflowShard)).toBe(2);
      const args = buildPaidShardArgs(workflowShard, resolvePaidShardTimeoutMs(workflowShard), 2, retriesForFiles(workflowShard));
      expect(args[args.indexOf('--retry') + 1]).toBe('2');
      expect(planPaidShards(files.map(file => file.replaceAll('/', '\\')), { maxFilesPerShard })).toEqual(shards);
    }
  });

  test('mixed or grouped overlay jobs reject before any child starts', async () => {
    const invalidGroups = [[overlayFiles[0], normalFile], [overlayFiles[0], overlayFiles[1]]];
    for (const files of invalidGroups) {
      expect(() => resolvePaidShardBudget(files)).toThrow('own shard');
      expect(() => resolvePaidShardBudget(files, 1_900_000)).toThrow('own shard');
      let launched = 0;
      await expect(runPaidShards([[normalFile], files], {
        commandFor: () => { launched++; throw new Error('must never launch'); },
      })).rejects.toThrow('own shard');
      expect(launched).toBe(0);
    }
  });

  test('only the exact wrapper family gets one attempt and the extra process grace', () => {
    expect(overlayFiles).toHaveLength(6);
    expect(OVERLAY_MAX_ACTIVE_SHARDS).toBe(1);
    expect(OVERLAY_MIN_FILE_WALL_MS).toBe(1_830_000);
    for (const file of overlayFiles) {
      expect(isOverlayTestFile(file)).toBe(true);
      expect(isOverlayTestFile(file.replaceAll('/', '\\'))).toBe(true);
      expect(resolvePaidShardTimeoutMs([file])).toBe(1_830_000);
      expect(retriesForFiles([file])).toBe(0);
      expect(buildPaidShardArgs([file], resolvePaidShardTimeoutMs([file]), 2, retriesForFiles([file])))
        .toContain('--timeout=1830000');
    }
    for (const file of [normalFile, 'test/skill-e2e-overlay-harness.test.ts', 'test/model-overlay-opus-4-7.test.ts']) {
      expect(isOverlayTestFile(file)).toBe(false);
      expect(resolvePaidShardTimeoutMs([file])).toBe(DEFAULT_SHARD_TIMEOUT_MS);
      expect(retriesForFiles([file])).toBe(1);
    }
    expect(resolvePaidShardTimeoutMs([normalFile], 1234)).toBe(1234);
    expect(resolvePaidShardTimeoutMs([overlayFiles[0]], 1_900_000)).toBe(1_900_000);
    expect(() => resolvePaidShardTimeoutMs([overlayFiles[0]], 1_800_000)).toThrow('explicit wall');
  });

  test('default, env and CLI walls retain their distinct meanings and CLI precedence', () => {
    expect(parseCliOptions([], {}).timeoutExplicit).toBe(false);
    const env = { EVALS_SHARD_TIMEOUT_MS: '1800000' };
    const configured = parseCliOptions([], env);
    expect(configured.timeoutExplicit).toBe(true);
    expect(() => resolvePaidShardTimeoutMs([overlayFiles[0]], configured.timeoutMs)).toThrow('explicit wall');
    const overridden = parseCliOptions(['--timeout', '1900'], env);
    expect(overridden.timeoutExplicit).toBe(true);
    expect(resolvePaidShardTimeoutMs([overlayFiles[0]], overridden.timeoutMs)).toBe(1_900_000);
    expect(env.EVALS_SHARD_TIMEOUT_MS).toBe('1800000');
  });

  test('an invalid explicit wall rejects the whole batch before starting any normal or overlay child', async () => {
    let launched = 0;
    await expect(runPaidShards([[normalFile], [overlayFiles[0]]], {
      timeoutMs: 1_800_000,
      commandFor: () => { launched++; throw new Error('must never launch'); },
    })).rejects.toThrow('explicit wall');
    expect(launched).toBe(0);
  });

  test('CLI rejects insufficient overlay walls before API preflight', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-wall-preflight-'));
    try {
      const manifest = {
        version: 1, tier: 'periodic', evalsAll: true, sliceCount: 1, selectionReason: 'free fixture',
        entries: [{ file: overlayFiles[0], slice: 1, status: 'planned' }],
      };
      const planPath = path.join(dir, 'manifest.json');
      fs.writeFileSync(planPath, JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-paid-shards.ts'),
        '--tier', 'periodic', '--plan', planPath, '--slice', '1', '--timeout', '1800'], {
        cwd: ROOT, encoding: 'utf8', timeout: 10_000,
        // No credentials or preflight bypass. A nonempty missing PATH avoids
        // runtime fallback to a default shell search path during negative probes.
        env: { PATH: path.join(dir, 'no-executables'), HOME: dir, GSTACK_EVAL_DIR: dir, GSTACK_CLAUDE_CLI_VERSION: 'free-fixture',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Overlay shard requires at least 1830000ms; explicit wall 1800000ms');
      expect(result.stderr).not.toContain('preflight');
      expect(fs.existsSync(path.join(dir, 'slice-1.json'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('overlay manifest affinity and CI capacity', () => {
  test('actual lifecycle wrapper guards include all six in periodic and exclude all six from gate', () => {
    for (const tier of ['periodic', 'gate'] as const) {
      const manifest = buildRunManifest({ tier, sliceCount: 6, evalsAll: true, env: { EVALS_ALL: '1' } });
      const entries = manifest.entries.filter(entry => isOverlayTestFile(entry.file));
      expect(entries).toHaveLength(6);
      expect(entries.every(entry => entry.status === (tier === 'periodic' ? 'planned' : 'excluded'))).toBe(true);
    }
  });

  test('95 files retain every case, reserve slice six, and fit 330 minutes with actual family walls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-affinity-'));
    const normalFiles = Array.from({ length: 89 }, (_, i) => `test/skill-e2e-normal-${i.toString().padStart(2, '0')}.test.ts`);
    const discovered = [...normalFiles, ...overlayFiles];
    try {
      fs.mkdirSync(path.join(dir, 'test'));
      for (const file of discovered) {
        fs.writeFileSync(path.join(dir, file), isOverlayTestFile(file)
          ? "const shouldRun = process.env.EVALS_TIER === 'periodic';\n" : '// Free census fixture only.\n');
      }
      const opts = { tier: 'periodic' as const, sliceCount: 6, evalsAll: true, discovered, rootDir: dir, env: { EVALS_ALL: '1' } };
      const manifest = buildRunManifest(opts);
      expect(manifest.entries).toHaveLength(95);
      expect(new Set(manifest.entries.map(e => e.file)).size).toBe(95);
      expect(manifest.entries.every(e => e.status === 'planned')).toBe(true);
      const counts = [1, 2, 3, 4, 5, 6].map(slice => manifest.entries.filter(e => e.slice === slice).length);
      expect(counts).toEqual([18, 18, 18, 18, 17, 6]);
      expect(manifest.entries.filter(e => e.slice === 6).map(e => e.file).sort()).toEqual([...overlayFiles].sort());
      expect(buildRunManifest({ ...opts, discovered: [...discovered].reverse() })).toEqual(manifest);
      expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
      const stale = { ...manifest, entries: manifest.entries.map(e => isOverlayTestFile(e.file) ? { ...e, slice: 1 } : e) };
      expect(() => parseRunManifest(JSON.stringify(stale))).toThrow('final ordinary slice');

      const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/evals-periodic.yml'), 'utf8')) as {
        jobs: Record<string, {
          steps: Array<{ run?: string; env?: NodeJS.ProcessEnv }>;
          strategy: { matrix: { slice: number[] } };
          'timeout-minutes': number;
        }>;
      };
      const job = workflow.jobs['eval-slices'];
      const step = job.steps.find(step => step.run?.includes('--plan '))!;
      const jobs = parseCliOptions([], step.env).jobs;
      expect(jobs).toBe(2);
      expect(parseCliOptions([], step.env).withinShardConcurrency).toBe(2);
      expect(job.strategy.matrix.slice).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const normalMinutes = Math.ceil(18 / jobs) * resolvePaidShardTimeoutMs([normalFiles[0]]) / 60_000;
      const overlayMinutes = Math.ceil(overlayFiles.length / OVERLAY_MAX_ACTIVE_SHARDS)
        * Math.max(...overlayFiles.map(file => resolvePaidShardTimeoutMs([file]))) / 60_000;
      expect(normalMinutes).toBe(270);
      expect(overlayMinutes).toBe(183);
      expect(job['timeout-minutes']).toBeGreaterThanOrEqual(Math.max(normalMinutes, overlayMinutes) + 20);
      expect(job['timeout-minutes'] * 60_000).toBeGreaterThanOrEqual(AUTOPLAN_CHAIN_BUDGET.ciJobMs);

      // Gate selection keeps its original periodic exclusion and all six
      // ordinary slices; reservation does not spend an empty slot in gate.
      const gate = buildRunManifest({ ...opts, tier: 'gate' });
      expect(gate.entries.filter(e => e.status === 'excluded').map(e => e.file).sort()).toEqual([...overlayFiles].sort());
      expect(gate.entries.filter(e => e.status === 'planned' && e.slice === 6)).toHaveLength(14);
      const single = buildRunManifest({ ...opts, sliceCount: 1 });
      expect(single.entries.every(e => e.slice === 1)).toBe(true);
      expect(parseRunManifest(JSON.stringify(single))).toEqual(single);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('overlay admission uses real child processes', () => {
  test('one overlay holds its slot while ordinary work proceeds; failure releases admission', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-admission-'));
    const receipts = path.join(dir, 'events.jsonl');
    const lines: string[] = [];
    try {
      const summary = await runPaidShards([[overlayFiles[0]], [overlayFiles[1]], [normalFile]], {
        jobs: 2, env: fakeEnv, logDir: dir, log: line => lines.push(line),
        commandFor: files => {
          const role = files[0] === overlayFiles[0] ? 'first' : files[0] === overlayFiles[1] ? 'second' : 'normal';
          return {
            command: process.execPath,
            args: [path.join(ROOT, 'test/fixtures/overlay-admission-child.ts'), dir, role, receipts],
          };
        },
      });
      expect(summary.outcomes.map(o => o.status)).toEqual(['failed', 'passed', 'passed']);
      expect(summary.outcomes[0].exitCode).toBe(3);
      const events = fs.readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.map(e => `${e.role}:${e.event}`)).toEqual([
        'first:start', 'normal:ran-during-overlay', 'first:end', 'second:start', 'second:end',
      ]);
      expect(events.every(e => e.sdk === '7')).toBe(true);
      expect(lines.filter(line => line.includes('START') && line.includes('timeout 1830s'))).toHaveLength(2);
      expect(lines.filter(line => line.includes('START') && line.includes('timeout 1800s'))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a thrown overlay launch releases admission and hollow output remains a failing verdict', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-admission-throw-'));
    try {
      const summary = await runPaidShards([[overlayFiles[0]], [overlayFiles[1]], [normalFile]], {
        jobs: 8, env: fakeEnv, logDir: dir, log: () => {},
        commandFor: files => {
          if (files[0] === overlayFiles[0]) throw new Error('fake overlay launch failure');
          const count = files[0] === overlayFiles[1] ? 0 : 1;
          return { command: process.execPath, args: ['-e', `console.log('Ran ${count} tests across 1 file. [1ms]')`] };
        },
      });
      const guarded = applyHollowShardGuard(summary.outcomes, { evalsAll: true });
      expect(guarded.map(o => o.status)).toEqual(['failed', 'passed-empty', 'passed']);
      expect(summaryExitCode(summarize(guarded))).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
