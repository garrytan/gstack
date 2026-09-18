/**
 * Planner/executor/report contract for the re-platformed paid CI lane.
 *
 * The classes these pin (each was a live CI failure mode of the old
 * hand-enumerated matrix, or a review-identified risk of the migration):
 *  - per-slice selector divergence → ONE planner manifest, executors consume
 *  - hollow lanes → a slice with no artifact is a FAILURE, not an absence
 *  - hollow shards → EVALS_ALL + exit 0 + zero executed tests ≠ pass
 *  - retry parity → the old matrix rows' earned `retries: 2` survive as a
 *    literals map, not folklore
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import {
  applyHollowShardGuard,
  buildPaidShardArgs,
  buildRunManifest,
  parseRunManifest,
  retriesForFiles,
  RETRY_OVERRIDES,
  summarize,
  summaryExitCode,
  verifySliceResults,
  type PaidRunManifest,
  type ShardOutcome,
  type SliceResult,
} from '../scripts/test-paid-shards';

const ROOT = path.resolve(__dirname, '..');

const outcome = (over: Partial<ShardOutcome>): ShardOutcome => ({
  shard: 1,
  files: ['test/skill-e2e-x.test.ts'],
  status: 'passed',
  exitCode: 0,
  elapsedMs: 1000,
  groupPid: null,
  executedTests: 3,
  ...over,
});

describe('run manifest (planner)', () => {
  test('live build: every paid file appears exactly once; planned slices partition 1..K', () => {
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 5, evalsAll: true, env: { EVALS_ALL: '1' } });
    const files = manifest.entries.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
    const planned = manifest.entries.filter((e) => e.status === 'planned');
    expect(planned.length).toBeGreaterThan(20); // census sanity
    for (const entry of planned) {
      expect(entry.slice).toBeGreaterThanOrEqual(1);
      expect(entry.slice).toBeLessThanOrEqual(5);
    }
    // Live registered files balance supervised time, so file counts can differ.
    expect([...new Set(planned.map(entry => entry.slice))].sort()).toEqual([1, 2, 3, 4, 5]);
    // Uniform, unregistered work retains the original round-robin contract.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-manifest-balance-'));
    try {
      fs.mkdirSync(path.join(dir, 'test'));
      const discovered = Array.from({ length: 12 }, (_, i) => `test/skill-e2e-ordinary-${i}.test.ts`);
      for (const file of discovered) fs.writeFileSync(path.join(dir, file), '// ordinary unregistered fixture');
      const ordinary = buildRunManifest({ tier: 'gate', sliceCount: 5, evalsAll: true,
        env: { EVALS_ALL: '1' }, rootDir: dir, discovered }).entries;
      expect(ordinary).toHaveLength(discovered.length);
      expect(ordinary.every(entry => entry.status === 'planned' && !entry.budget)).toBe(true);
      const sizes = [1, 2, 3, 4, 5].map(i => ordinary.filter(entry => entry.slice === i).length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    // Non-runnable entries carry slice 0 and a reason.
    for (const entry of manifest.entries.filter((e) => e.status !== 'planned')) {
      expect(entry.slice).toBe(0);
      expect(entry.reason ?? '').not.toBe('');
    }
  });

  test('deterministic for identical inputs', () => {
    const opts = { tier: 'periodic' as const, sliceCount: 4, evalsAll: true, env: { EVALS_ALL: '1' } };
    expect(buildRunManifest(opts)).toEqual(buildRunManifest(opts));
  });

  test('parse round-trips and rejects malformed manifests', () => {
    // EVALS_ALL short-circuits diff selection BEFORE any git walk: selection
    // is deliberately fail-closed on git errors, and CI's shallow free-tests
    // checkout has no base ref (first CI run failed here with
    // "ambiguous argument 'main...HEAD'").
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 2, evalsAll: false, env: { EVALS_ALL: '1' } });
    expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => parseRunManifest('{}')).toThrow(/version/);
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, tier: 'e2e' }))).toThrow(/tier/);
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, sliceCount: 0 }))).toThrow(/sliceCount/);
    const outOfRange = {
      ...manifest,
      entries: [{ file: 'test/skill-e2e-x.test.ts', slice: 9, status: 'planned' }],
    };
    expect(() => parseRunManifest(JSON.stringify(outOfRange))).toThrow(/out-of-range/);
  });
});

describe('manifest executor scope', () => {
  test('a conflicting inherited carve scope cannot suppress a planned case; direct Bun stays scoped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-manifest-scope-'));
    const fixtureRoot = path.join(dir, 'fixture');
    const receipt = path.join(dir, 'captures.jsonl');
    fs.mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
    const discovered = ['review', 'browse'].map(skill => `test/carve-section-loading-${skill}.test.ts`);
    try {
      for (const skill of ['review', 'browse']) {
        // Exercise the real registration filter and assertions, with only the
        // model-capture boundary replaced in this isolated child process.
        fs.writeFileSync(path.join(fixtureRoot, `test/carve-section-loading-${skill}.test.ts`), `
          import { mock, expect } from 'bun:test';
          import { appendFileSync } from 'node:fs';
          import { CARVE_GUARDS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/carve-guards.ts'))};
          mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/auq-sdk-capture.ts'))}, () => ({
            skillFromWorktree: () => ({ skillMd: 'free fixture', sectionsFrom: '' }),
            setupSkillDir: () => ${JSON.stringify(fixtureRoot)},
            captureSectionReads: async ({ skillName }) => {
              expect(skillName).toBe(${JSON.stringify(skill)});
              appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ skill: skillName, scope: process.env.GSTACK_CARVE_SKILL }) + '\\n');
              return { readSections: new Set(CARVE_GUARDS[skillName].requiredReads), reportProduced: true, output: 'Local fake review report. '.repeat(12) };
            },
          }));
          const { registerCarveSectionCase } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/carve-section-case.ts'))});
          registerCarveSectionCase(${JSON.stringify(skill)});
        `);
      }
      const manifest = buildRunManifest({
        tier: 'periodic', sliceCount: 1, evalsAll: true, discovered, rootDir: fixtureRoot,
        env: { EVALS_ALL: '1', GSTACK_CARVE_SKILL: 'review' },
      });
      expect(manifest.entries.filter(e => e.status === 'planned').map(e => e.file)).toEqual([discovered[0]]);
      expect(manifest.entries.filter(e => e.status === 'excluded').map(e => e.file)).toEqual([discovered[1]]);
      // Absolute fixture selectors let the real executor use its ordinary root
      // while every selected test and receipt remains owned by this test.
      manifest.entries = manifest.entries.map(e => ({ ...e, file: path.join(fixtureRoot, e.file) }));
      const manifestPath = path.join(dir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const env = {
        PATH: path.dirname(process.execPath),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: dir, TMPDIR: dir, TEMP: dir, TMP: dir,
        EVALS_PREFLIGHT_OK: '1', GSTACK_CLAUDE_CLI_VERSION: 'free-fixture',
        GSTACK_EVAL_DIR: path.join(dir, 'evals'), GSTACK_CARVE_SKILL: 'browse',
      };
      const run = (args: string[]) => {
        const result = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 20_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      };
      const captures = () => fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));

      // No API credentials are inherited, preflight/version probes are skipped,
      // and both files replace the model module before importing the real helper.
      run(['test', ...discovered.map(file => path.join(fixtureRoot, file))]);
      expect(captures()).toEqual([{ skill: 'browse', scope: 'browse' }]);
      fs.writeFileSync(receipt, '');

      run([path.join(ROOT, 'scripts/test-paid-shards.ts'), '--tier', 'periodic', '--plan', manifestPath, '--slice', '1', '--jobs', '1', '--timeout', '10']);
      expect(captures()).toEqual([{ skill: 'review', scope: '' }]);
      const slice = JSON.parse(fs.readFileSync(path.join(env.GSTACK_EVAL_DIR, 'slice-1.json'), 'utf8'));
      expect(slice.outcomes).toHaveLength(1);
      expect(slice.outcomes[0]).toMatchObject({
        files: [path.join(fixtureRoot, discovered[0])], status: 'passed', exitCode: 0, executedTests: 1,
      });
      expect(env.GSTACK_CARVE_SKILL).toBe('browse');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('slice-result reconciliation (report)', () => {
  const manifest: PaidRunManifest = {
    version: 1,
    tier: 'gate',
    evalsAll: false,
    sliceCount: 2,
    selectionReason: 'test fixture',
    entries: [
      { file: 'test/skill-e2e-a.test.ts', slice: 1, status: 'planned' },
      { file: 'test/skill-e2e-b.test.ts', slice: 2, status: 'planned' },
      { file: 'test/skill-e2e-c.test.ts', slice: 0, status: 'skipped-by-diff', reason: 'unselected' },
    ],
  };
  const slice = (index: number, files: string[], status: ShardOutcome['status'] = 'passed'): SliceResult => ({
    version: 1,
    tier: 'gate',
    sliceIndex: index,
    sliceCount: 2,
    outcomes: files.map((f) => ({ files: [f], status, exitCode: 0, elapsedMs: 5, executedTests: 2 })),
  });

  test('all slices present and passing → ok', () => {
    const verdict = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-a.test.ts']),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  test('a missing slice artifact is a FAILURE, not an absence', () => {
    const verdict = verifySliceResults(manifest, [slice(1, ['test/skill-e2e-a.test.ts'])]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('slice 2/2 reported NO result');
  });

  test('a planned shard nobody reported fails even when its slice reported', () => {
    const verdict = verifySliceResults(manifest, [
      slice(1, []),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('never reported');
  });

  test('wrong-slice, duplicate, cross-tier, and failing outcomes all surface', () => {
    const wrongSlice = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-b.test.ts']),
      slice(2, ['test/skill-e2e-a.test.ts']),
    ]);
    expect(wrongSlice.ok).toBe(false);
    const failing = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-a.test.ts'], 'failed'),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(failing.problems.join('\n')).toContain('test/skill-e2e-a.test.ts: failed');
    const crossTier = verifySliceResults(manifest, [
      { ...slice(1, ['test/skill-e2e-a.test.ts']), tier: 'periodic' },
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(crossTier.problems.join('\n')).toContain('ran tier periodic');
  });
});

describe('hollow-shard guard', () => {
  test('EVALS_ALL: passed with 0 executed tests becomes passed-empty and fails the run', () => {
    const guarded = applyHollowShardGuard([outcome({ executedTests: 0 })], { evalsAll: true, warn: () => {} });
    expect(guarded[0].status).toBe('passed-empty');
    const summary = summarize(guarded);
    expect(summary.failed).toBe(1);
    expect(summaryExitCode(summary)).toBe(1);
  });

  test('selective run: same shape stays passed, warns once', () => {
    const warnings: string[] = [];
    const guarded = applyHollowShardGuard([outcome({ executedTests: 0 })], {
      evalsAll: false, warn: (line) => warnings.push(line),
    });
    expect(guarded[0].status).toBe('passed');
    expect(warnings).toHaveLength(1);
  });

  test('unknown executedTests (null) is never guessed hollow', () => {
    const guarded = applyHollowShardGuard([outcome({ executedTests: null })], { evalsAll: true });
    expect(guarded[0].status).toBe('passed');
  });
});

describe('retry parity', () => {
  test('registered native workflows preserve main retry policy while overlay attempts stay isolated', () => {
    const native = 'test/skill-e2e-autoplan-chain.test.ts';
    expect(retriesForFiles([native])).toBe(1);
    expect(retriesForFiles([native.replaceAll('/', '\\')])).toBe(1);
    expect(buildPaidShardArgs([native], 1_800_000, 2, retriesForFiles([native])).join(' ')).toContain('--retry 1');
    const overlay = 'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash.test.ts';
    expect(retriesForFiles([overlay])).toBe(0);
  });
  test('overrides exist only for the files whose matrix rows earned them, and each names a real file', () => {
    expect(Object.keys(RETRY_OVERRIDES).sort()).toEqual([
      'test/skill-e2e-office-hours-auto-mode.test.ts',
      'test/skill-e2e-plan-mode-no-op.test.ts',
      'test/skill-e2e-workflow.test.ts',
    ]);
    for (const file of Object.keys(RETRY_OVERRIDES)) {
      expect(fs.existsSync(path.join(ROOT, file)), `stale RETRY_OVERRIDES entry: ${file}`).toBe(true);
    }
    expect(retriesForFiles(['test/skill-e2e-workflow.test.ts'])).toBe(2);
    expect(retriesForFiles(['test/skill-e2e-retro.test.ts'])).toBe(1);
    expect(buildPaidShardArgs(['x'], 1000, 4, 2)).toContain('2');
    expect(buildPaidShardArgs(['x'], 1000, 4).join(' ')).toContain('--retry 1');
  });
});
