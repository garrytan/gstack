import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  e2eReuseEnvironment, e2eReuseLaneProblem, e2eShardIdentity, e2eShardInputFiles, prepareE2EShardReuse,
  mergeReceiptDirs, readPanelReceipt, selectPlanReceipts, writeNegativeReceipt, writePanelReceipt,
  type E2EShardReuseRequest, type PanelReceipt,
} from '../scripts/e2e-shard-reuse';
import { buildRunManifest, fileCaseRegistration, runPaidShard, verifySliceResults, type SliceResult } from '../scripts/test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const FILE = 'test/skill-e2e-deploy.test.ts';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-reuse-'));
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });

const laneEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: scratch,
  EVALS_TIER: 'gate', EVALS_PROFILE: 'pr', EVALS: '1',
  EVALS_CACHE_DIR: path.join(scratch, 'cache'), EVALS_CACHE_REPOSITORY: 'garrytan/gstack', EVALS_CACHE_PR: '42',
  EVALS_CACHE_RUNTIME_ID: 'a'.repeat(64), GITHUB_RUN_ID: '1001', GITHUB_RUN_ATTEMPT: '1', ANTHROPIC_API_KEY: 'sk-fixture',
  GSTACK_CLAUDE_CLI_VERSION: '9.9.9 (Claude Code)',
  ...over,
});

function request(over: Partial<E2EShardReuseRequest> = {}): E2EShardReuseRequest {
  const { registered, known } = fileCaseRegistration(FILE, fs.readFileSync(path.join(ROOT, FILE), 'utf8'));
  return { root: ROOT, key: FILE, file: FILE, caseIds: ['setup-deploy-workflow'], registeredIds: registered, registrationKnown: known,
    casePattern: '(?:^|\\s)(?:setup-deploy-workflow)$', expectedCases: 1, retries: 0, timeoutMs: 1_800_000,
    withinShardConcurrency: 2, tier: 'gate', profile: 'pr', env: laneEnv(), ...over };
}

describe('E2E shard reuse eligibility', () => {
  test('only the same-PR fast profile with an immutable runtime and default endpoint may reuse', () => {
    expect(e2eReuseLaneProblem(laneEnv(), 'pr')).toBeNull();
    for (const [env, mode, problem] of [
      [laneEnv(), 'full-fallback', 'Only the fast PR profile'],
      [laneEnv(), undefined, 'Only the fast PR profile'],
      [laneEnv({ EVALS_CACHE_PR: '' }), 'pr', 'same-PR cache scope'],
      [laneEnv({ EVALS_CACHE_RUNTIME_ID: 'latest' }), 'pr', 'immutable runtime'],
      [laneEnv({ EVALS_FRESH: '1' }), 'pr', 'Fresh validation'],
      [laneEnv({ EVALS_TIER: 'periodic' }), 'pr', 'Fresh validation'],
      [laneEnv({ EVALS_CACHE_PURPOSE: 'periodic' }), 'pr', 'execute fresh'],
      [laneEnv({ EVALS_CACHE_PURPOSE: 'marathon' }), 'pr', 'execute fresh'],
      [laneEnv({ EVALS_CACHE_PURPOSE: 'release' }), 'pr', 'execute fresh'],
      [laneEnv({ NODE_OPTIONS: '--require x' }), 'pr', 'Preload'],
      [laneEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example' }), 'pr', 'Custom model endpoint'],
    ] as const) expect(e2eReuseLaneProblem(env, mode)).toContain(problem);
  });

  test('the identity binds the child environment except run-scoped transport, and never secret values', () => {
    const env = e2eReuseEnvironment(laneEnv({ EVALS_RUN_ID: 'run-1', GSTACK_EVAL_DIR: '/tmp/x', EVALS_SELECTION_JSON: '{}', EVALS_MODEL: 'm', UNRELATED: 'x' }));
    expect(env.ANTHROPIC_API_KEY).toBe('set');
    expect(env.EVALS_MODEL).toBe('m');
    for (const name of ['EVALS_RUN_ID', 'GSTACK_EVAL_DIR', 'EVALS_SELECTION_JSON', 'EVALS_CACHE_DIR', 'EVALS_CACHE_PR', 'UNRELATED', 'GITHUB_RUN_ID']) {
      expect(env[name], name).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain('sk-fixture');
  });

  test('consumed files cover the test closure, every registered touchfile, the globals and the harness', () => {
    const files = e2eShardInputFiles(request());
    for (const file of [FILE, 'test/helpers/e2e-helpers.ts', 'scripts/test-paid-shards.ts', 'scripts/e2e-shard-reuse.ts',
      'bun.lock', '.github/workflows/evals.yml', '.github/actions/register-gstack-skills/action.yml', '.github/docker/Dockerfile.ci',
      'setup-deploy/SKILL.md.tmpl', 'test/helpers/touchfiles-data.ts']) expect(files, file).toContain(file);
    expect(files).not.toContain('package.json');
    expect(files.some(file => file.startsWith('node_modules/'))).toBe(true);
    expect(() => e2eShardInputFiles({ ...request(), registeredIds: ['no-such-case'] })).not.toThrow();
  });

  test('unknown or unprovable inputs fail closed', () => {
    expect(e2eShardIdentity(request()).status).toBe('eligible');
    for (const [over, reason] of [
      [{ retries: 1 }, 'first attempt'],
      [{ registrationKnown: false }, 'statically complete'],
      [{ caseIds: [] }, 'exactly known'],
      [{ expectedCases: 2 }, 'exactly known'],
      [{ caseIds: ['not-registered'] }, 'exactly known'],
      [{ file: 'test/skill-llm-eval.test.ts', key: 'test/skill-llm-eval.test.ts' }, 'audited E2E file'],
      [{ env: laneEnv({ PATH: path.join(scratch, 'empty') }) }, 'Claude CLI version is unknown'],
    ] as const) {
      const result = e2eShardIdentity(request(over as Partial<E2EShardReuseRequest>));
      expect(result.status, reason).toBe('ineligible');
      expect(result.status === 'ineligible' ? result.reason : '').toContain(reason);
    }
  });

  test('any consumed parameter, pin or runtime change is a different identity', () => {
    const key = (over: Partial<E2EShardReuseRequest>) => {
      const result = e2eShardIdentity(request(over));
      if (result.status !== 'eligible') throw new Error(result.reason);
      return result.identity.key;
    };
    const base = key({});
    expect(key({})).toBe(base);
    expect(key({ env: laneEnv({ EVALS_RUN_ID: 'another-run', GITHUB_RUN_ID: '9' }) })).toBe(base);
    for (const over of [{ timeoutMs: 1_000 }, { withinShardConcurrency: 1 }, { casePattern: 'x' },
      { env: laneEnv({ EVALS_MODEL: 'other' }) }, { env: laneEnv({ EVALS_CACHE_RUNTIME_ID: 'b'.repeat(64) }) },
      { env: laneEnv({ EVALS_CACHE_PR: '43' }) }] as Array<Partial<E2EShardReuseRequest>>) expect(key(over)).not.toBe(base);
  });
});

describe('E2E shard reuse through the runner', () => {
  test('a fresh first-attempt pass publishes; identical inputs then reuse without launching; changed inputs run', async () => {
    const env = laneEnv({ EVALS_CACHE_DIR: path.join(scratch, 'roundtrip') });
    const first = prepareE2EShardReuse(request({ env }))!;
    expect(first.lookup()).toBeNull();
    first.publish();
    const hit = prepareE2EShardReuse(request({ env }))!.lookup();
    expect(hit?.source.runId).toBe('1001/1');
    expect(prepareE2EShardReuse(request({ env: { ...env, EVALS_MODEL: 'changed' } }))!.lookup()).toBeNull();
    expect(prepareE2EShardReuse(request({ env: { ...env, EVALS_FRESH: '1' } }))).toBeNull();

    const evalDir = path.join(scratch, 'evals');
    let launched = 0;
    const outcome = await runPaidShard([FILE], 1, 1, { rootDir: ROOT, logDir: scratch, evalDirBase: evalDir, env, log: () => {},
      expectedCaseIds: { [FILE]: ['setup-deploy-workflow'] },
      reuseFor: (files, childEnv) => prepareE2EShardReuse(request({ env: { ...childEnv } })),
      commandFor: () => { launched++; return { command: process.execPath, args: ['-e', 'process.exit(1)'] }; } });
    expect(launched).toBe(0);
    expect(outcome).toMatchObject({ status: 'passed', exitCode: 0, executedTests: 1, skippedTests: 0, reused: { runId: '1001/1' } });
    const recorded = JSON.parse(fs.readFileSync(path.join(evalDir, 'shards', 'skill-e2e-deploy', 'e2e-reused-skill-e2e-deploy.json'), 'utf8'));
    expect(recorded.tests).toEqual([expect.objectContaining({ name: 'setup-deploy-workflow', passed: true, execution: 'reused' })]);
  });

  test('a failed shard never publishes a receipt', async () => {
    let published = 0;
    const outcome = await runPaidShard([FILE], 1, 1, { rootDir: ROOT, logDir: scratch, env: laneEnv(), log: () => {},
      reuseFor: () => ({ inputKey: 'e'.repeat(64), unchanged: () => true, lookupPanelTrial: () => null,
        lookup: () => null, publish: () => { published++; } }),
      commandFor: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }) });
    expect(outcome.status).toBe('failed');
    expect(published).toBe(0);
    // The identity rides on the outcome so the report can store the FAIL as a negative receipt.
    expect(outcome.inputKey).toBe('e'.repeat(64));
  });

  test('the report accepts reused results only in the fast PR profile', () => {
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } });
    const planned = manifest.entries.filter(entry => entry.status === 'planned');
    const reused = { inputKey: 'c'.repeat(64), runId: '1001/1', revision: 'd'.repeat(40), completedAt: 1 };
    const key = `${FILE}#setup-deploy-workflow`;
    const results: SliceResult[] = [{ version: 1, tier: 'gate', sliceIndex: 1, sliceCount: 1, outcomes: planned.map(entry => ({
      files: [entry.file], status: 'passed' as const, exitCode: 0, elapsedMs: 0, executedTests: 1, skippedTests: 0,
      ...(entry.budget ? { budget: entry.budget } : {}), ...(entry.file === key ? { reused } : {}) })) }];
    expect(verifySliceResults(manifest, results).problems).toContain(`${key}: only the fast PR profile may reuse results; this lane executes fresh`);
  });
});

describe('planner-side panel reuse and negative receipts', () => {
  const panelPlan = { kind: 'behavior' as const, panel: { n: 3, k: 2 }, quarantined: false };
  const trialRequest = (trial: number, over: Partial<E2EShardReuseRequest> = {}) => request({
    key: `${FILE}#setup-deploy-workflow~t${trial}`, panel: panelPlan, ...over });
  const source = (completedAt: number, runId = '1001/1') => ({ runId, revision: 'd'.repeat(40), completedAt });
  const panel = (key: string, outcomes: Array<'passed' | 'failed'>, completedAt = Date.now() - 1_000): PanelReceipt => ({
    schema: 1, key, case: 'setup-deploy-workflow', kind: 'behavior', panel: { n: 3, k: 2 }, source: source(completedAt),
    trials: outcomes.map((outcome, i) => ({ trial: i + 1, outcome, ...(outcome === 'failed' ? { failure_class: 'timeout' as const } : {}) })),
  });

  test('every trial of a panel shares one identity; the panel policy is part of it', () => {
    const key = (r: E2EShardReuseRequest) => { const x = e2eShardIdentity(r); if (x.status !== 'eligible') throw new Error(x.reason); return x.identity.key; };
    const t1 = key(trialRequest(1));
    expect(key(trialRequest(2, { env: laneEnv({ GSTACK_EVAL_TRIAL: '2' }) }))).toBe(t1);
    expect(key(trialRequest(1, { panel: { ...panelPlan, quarantined: true } }))).not.toBe(t1);
    expect(key(request())).not.toBe(t1);
  });

  test('a whole PASS panel receipt is reused per trial, a split PASS keeps its failed trial', () => {
    const dir = path.join(scratch, 'panel-hit');
    const env = laneEnv({ EVALS_CACHE_DIR: dir });
    const reuse = prepareE2EShardReuse(trialRequest(2, { env }))!;
    expect(reuse.lookupPanelTrial(2)).toBeNull();
    writePanelReceipt(dir, panel(reuse.inputKey, ['passed', 'failed', 'passed']));
    expect(reuse.lookupPanelTrial(2)).toMatchObject({ trial: { trial: 2, outcome: 'failed', failure_class: 'timeout' }, hit: { source: { runId: '1001/1' } } });
    expect(reuse.lookupPanelTrial(1)!.trial.outcome).toBe('passed');
  });

  test('FAIL, partial, expired or negatively receipted panels are never reused', () => {
    const dir = path.join(scratch, 'panel-miss');
    const key = 'a'.repeat(64);
    for (const receipt of [panel(key, ['passed', 'failed', 'failed']), panel(key, ['passed', 'passed']),
      panel(key, ['passed', 'passed', 'passed'], Date.now() - 2 * 24 * 60 * 60 * 1000)]) {
      writePanelReceipt(dir, receipt);
      expect(readPanelReceipt(dir, key)).toBeNull();
    }
    writePanelReceipt(dir, panel(key, ['passed', 'passed', 'passed'], Date.now() - 5_000));
    expect(readPanelReceipt(dir, key)).not.toBeNull();
    writeNegativeReceipt(dir, { schema: 1, key, source: source(Date.now() - 1_000, '1002/1') });
    expect(readPanelReceipt(dir, key)).toBeNull();
  });

  test('the planner ships one filtered set: a newer FAIL blocks an older PASS, an older FAIL does not', () => {
    const from = path.join(scratch, 'select-from');
    const to = path.join(scratch, 'select-to');
    fs.mkdirSync(from, { recursive: true });
    const [blockedKey, keptKey, panelKey] = ['1', '2', '3'].map(c => c.repeat(64));
    const passReceipt = (key: string, completedAt: number) => fs.writeFileSync(path.join(from, `${key}.json`),
      JSON.stringify({ schema: 1, proof: { source: source(completedAt) } }));
    passReceipt(blockedKey, 1_000);
    writeNegativeReceipt(from, { schema: 1, key: blockedKey, source: source(2_000, '1002/1') });
    passReceipt(keptKey, 3_000);
    writeNegativeReceipt(from, { schema: 1, key: keptKey, source: source(2_000, '1002/1') });
    writePanelReceipt(from, panel(panelKey, ['passed', 'passed']));
    const result = selectPlanReceipts(from, to);
    expect(result.blocked.sort()).toEqual([`${blockedKey}.json`, `${panelKey}.panel.json`].sort());
    expect(fs.readdirSync(to).sort()).toEqual([`${blockedKey}.fail.json`, `${keptKey}.fail.json`, `${keptKey}.json`].sort());
  });

  test('merging receipt stores keeps the newest file per name', () => {
    const [a, b, out] = ['merge-a', 'merge-b', 'merge-out'].map(name => path.join(scratch, name));
    const key = '4'.repeat(64);
    writeNegativeReceipt(a, { schema: 1, key, source: source(5_000, '1/1') });
    writeNegativeReceipt(b, { schema: 1, key, source: source(9_000, '2/1') });
    expect(mergeReceiptDirs(out, [a, b, path.join(scratch, 'missing')])).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(out, `${key}.fail.json`), 'utf8')).source.runId).toBe('2/1');
    expect(mergeReceiptDirs(out, [a])).toBe(0);
  });
});
