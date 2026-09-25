import { afterEach, expect, spyOn, test } from 'bun:test';
import { Messages } from '@anthropic-ai/sdk/resources/messages';
import { callJudge, JudgeRefusalError, DEFAULT_JUDGE_MAX_TOKENS } from './helpers/llm-judge';
import { getCookieWorkflowManualReview } from './helpers/cookie-workflow-manual-review';
import { resolveEvalModel } from '../lib/eval-model';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareWorkflowJudgeCache, validWorkflowJudgeScore, workflowJudgeDependencies, type WorkflowCacheOptions } from './helpers/workflow-judge-cache';
import { readWorkflowJudgeInput, buildWorkflowJudgePrompt } from './helpers/workflow-judge-input';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const scores = { clarity: 4, completeness: 5, actionability: 4, reasoning: 'Concrete steps' };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-judge-cache-')); roots.push(root);
  const files = {
    'package.json': '{"name":"cache-fixture","type":"module"}', 'bun.lock': 'fixed dependencies',
    '.github/docker/Dockerfile.ci': 'FROM pinned-image',
    '.github/workflows/evals.yml': 'name: Paid evaluation',
    'scripts/test-paid-shards.ts': '#!/usr/bin/env bun\nexport const runner = 1;',
    'scripts/test-strict-output.ts': 'export const output = 1;',
    'scripts/eval-select.ts': 'export const selection = 1;',
    'scripts/test-pr-profile.ts': 'export const profile = 1;',
    'test/skill-llm-eval.test.ts': 'import "./helpers/llm-judge";',
    'test/helpers/workflow-judge-cache.ts': 'export const adapter = 1;',
    'test/helpers/llm-judge.ts': 'import SDK from "@anthropic-ai/sdk"; import "./nested";',
    'test/helpers/nested.ts': 'export const actualRunnerDependency = 1;',
    'lib/eval-model.ts': 'export const model = "model-v1";',
    'test/helpers/eval-budgets.ts': 'export const JUDGE_MS = 120000;',
    'node_modules/@anthropic-ai/sdk/package.json': '{"name":"@anthropic-ai/sdk","main":"index.js"}',
    'node_modules/@anthropic-ai/sdk/index.js': 'module.exports = class SDK {};',
    'example/SKILL.md': '# Start\nRead sections/review.md\n# End\n',
    'example/sections/review.md': 'Complete review and preserve exact answers.\n',
  };
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Cache Test'],
    ['config', 'user.email', 'cache@example.test'], ['add', '.'], ['commit', '-qm', 'seed']])
    execFileSync('git', args, { cwd: root, stdio: 'pipe', timeout: 5000 });
  const env = { EVALS_CACHE_DIR: path.join(root, 'cache'), EVALS_CACHE_REPOSITORY: 'owner/repo',
    EVALS_CACHE_PR: '42', EVALS_CACHE_RUNTIME_ID: 'b'.repeat(64), EVALS_TIER: 'gate', EVALS_RUN_ID: 'free-cache-test' };
  const opts: WorkflowCacheOptions = { root, env, testName: 'example workflow', skillPath: 'example/SKILL.md',
    startMarker: '# Start', endMarker: '# End', judgeContext: 'a workflow', judgeGoal: 'how to finish',
    thresholds: { clarity: 4, completeness: 3, actionability: 4 }, prompt: '', attempt: 1 };
  const refreshPrompt = () => { opts.prompt = buildWorkflowJudgePrompt(opts, readWorkflowJudgeInput(opts)); };
  refreshPrompt();
  return { root, opts, env, refreshPrompt, cache: () => prepareWorkflowJudgeCache(opts),
    entries: () => fs.existsSync(env.EVALS_CACHE_DIR) ? fs.readdirSync(env.EVALS_CACHE_DIR) : [] };
}

test('the audited adapter reuses only the exact completed score and original provenance', () => {
  const f = fixture(); const first = f.cache(); expect(first.lookup()).toBeNull(); first.publish(scores);
  expect(f.entries()).toHaveLength(1);
  const reused = f.cache().lookup(); expect(reused?.scores).toEqual(scores);
  expect(reused?.reuse.source.runId).toBe('free-cache-test');
  expect(reused?.reuse.source.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(reused?.reuse.source.completedAt).toBeLessThanOrEqual(Date.now());
});

test('the dependency closure includes actual installed SDK bytes and local transitive imports', () => {
  const f = fixture(); const files = workflowJudgeDependencies(f.root, ['example/SKILL.md']);
  expect(files).toContain('node_modules/@anthropic-ai/sdk/index.js');
  expect(files).toContain('node_modules/@anthropic-ai/sdk/package.json');
  expect(files).toContain('test/helpers/nested.ts');
  expect(files).toContain('bun.lock');
  for (const file of ['scripts/test-paid-shards.ts', 'scripts/test-strict-output.ts',
    'scripts/eval-select.ts', 'scripts/test-pr-profile.ts', '.github/workflows/evals.yml']) expect(files).toContain(file);
  expect(files).not.toContain('package.json');
});

test('release-label changes preserve reuse; other package semantics invalidate it', () => {
  const f = fixture(); f.cache().publish(scores);
  const file = path.join(f.root, 'package.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...original, version: '2.0.0' }, null, 2));
  expect(f.cache().lookup()?.scores).toEqual(scores);
  for (const change of [{ scripts: { 'test:gate': 'changed command' } }, { dependencies: { 'some-sdk': '2.0.0' } }]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, ...change, version: '2.0.0' }));
    expect(f.cache().lookup()).toBeNull();
  }
});

for (const file of ['test/helpers/nested.ts', 'node_modules/@anthropic-ai/sdk/index.js',
  'node_modules/@anthropic-ai/sdk/package.json', 'bun.lock', 'example/sections/review.md',
  'scripts/test-paid-shards.ts', 'scripts/test-strict-output.ts', 'scripts/eval-select.ts',
  'scripts/test-pr-profile.ts', '.github/workflows/evals.yml']) {
  test(`changes in ${file} require new evaluation`, () => {
    const f = fixture(); f.cache().publish(scores); const target = path.join(f.root, file);
    fs.appendFileSync(target, file.endsWith('.json') ? ' ' : '\n// changed');
    f.refreshPrompt(); expect(f.cache().lookup()).toBeNull();
  });
}

test('changed sources during an attempt and mismatched actual prompt cannot publish', () => {
  const f = fixture(); const before = f.cache();
  fs.appendFileSync(path.join(f.root, 'example/sections/review.md'), 'new finding');
  before.publish(scores); expect(f.entries()).toHaveLength(0);
  f.refreshPrompt(); f.opts.prompt += ' hidden new request'; f.cache().publish(scores);
  expect(f.entries()).toHaveLength(0);
});

for (const [key, value] of Object.entries({ EVALS_FRESH: '1', EVALS_TIER: 'periodic',
  EVALS_CACHE_PURPOSE: 'release', EVALS_CACHE_RUNTIME_ID: 'mutable:latest', EVALS_CACHE_PR: '',
  EVALS_CACHE_REPOSITORY: '', NODE_OPTIONS: '--require=unknown', BUN_OPTIONS: '--preload=unknown',
  ANTHROPIC_BASE_URL: 'https://custom-provider.example.test' })) {
  test(`${key}=${value} is fresh or ineligible`, () => {
    const f = fixture(); f.cache().publish(scores);
    f.opts.env = { ...f.env, [key]: value }; const cache = f.cache();
    expect(cache.lookup()).toBeNull(); cache.publish(scores); expect(f.entries()).toHaveLength(1);
  });
}

test('runtime/model/threshold changes miss, and retries never reuse or publish', () => {
  const f = fixture(); f.cache().publish(scores);
  for (const overrides of [{ GSTACK_EVAL_MODEL_JUDGE: 'different-model' }, { EVALS_CACHE_RUNTIME_ID: 'c'.repeat(64) }]) {
    f.opts.env = { ...f.env, ...overrides }; expect(f.cache().lookup()).toBeNull();
  }
  f.opts.env = f.env; f.opts.thresholds.clarity = 5; expect(f.cache().lookup()).toBeNull();
  f.opts.thresholds.clarity = 4; f.opts.attempt = 2; const retry = f.cache();
  expect(retry.lookup()).toBeNull(); retry.publish(scores); expect(f.entries()).toHaveLength(1);
});

test('failed assertions, missing provenance, and missing imported dependencies cannot supply a receipt', () => {
  const f = fixture(); f.cache().publish({ ...scores, clarity: 3 }); expect(f.entries()).toHaveLength(0);
  f.opts.env = { ...f.env, EVALS_RUN_ID: '' }; f.cache().publish(scores); expect(f.entries()).toHaveLength(0);
  f.opts.env = f.env; fs.unlinkSync(path.join(f.root, 'test/helpers/nested.ts'));
  f.cache().publish(scores); expect(f.entries()).toHaveLength(0);
});

test('cached payload schema remains small and cannot carry operational fields', () => {
  expect(validWorkflowJudgeScore(scores, { clarity: 4, completeness: 3, actionability: 4 })).toBe(true);
  for (const changed of [{ ...scores, prompt: 'private request' }, { ...scores, clarity: '4' },
    { ...scores, reasoning: null }, { ...scores, clarity: 6 }])
    expect(validWorkflowJudgeScore(changed as any, { clarity: 4, completeness: 3, actionability: 4 })).toBe(false);
});

test('workflow registration preserves model work and reserves only terminal-recording grace', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-llm-eval.test.ts'), 'utf8');
  const body = source.split('async function runWorkflowJudge')[1]!.split('// Block 1:')[0]!;
  const stages = ['workflowJudgeAttempts.set', 'readWorkflowJudgeInput(', 'cache.lookup()',
    'callJudge<JudgeScore>(prompt, undefined, { signal: controller.signal, max_tokens: maxTokens })',
    'expect(scores.clarity)', 'expect(scores.completeness)', 'expect(scores.actionability)', 'cache.publish(scores, active)']
    .map(stage => body.indexOf(stage));
  expect(stages.every(position => position >= 0)).toBe(true);
  expect(stages).toEqual([...stages].sort((a, b) => a - b));
  expect(body).toContain("execution: reused ? 'reused' : 'executed'");
  expect(body).toContain('const workDeadline = started + JUDGE_MS;');
  expect(source).toContain('const WORKFLOW_JUDGE_RECORD_MS = 5_000;');
  expect(source).toContain('const WORKFLOW_JUDGE_TEST_MS = JUDGE_MS + 10_000;');
  expect(source.match(/\}, WORKFLOW_JUDGE_TEST_MS\);/g)).toHaveLength(15);
  expect(source.match(/\}, JUDGE_MS\);/g)).toHaveLength(11);
});

function actualCallback(f: ReturnType<typeof fixture>, overrides: {
  judge?: (prompt: string, model: undefined, options: { signal: AbortSignal }) => Promise<typeof scores>;
  read?: typeof readWorkflowJudgeInput;
  prepare?: typeof prepareWorkflowJudgeCache;
  clock?: () => number;
  budget?: number;
  allowance?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
} = {}) {
  // Execute the production callback with only its provider and collector replaced.
  // Keep all prompt construction, cache decisions and Bun assertions intact.
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-llm-eval.test.ts'), 'utf8');
  const callback = source.slice(source.indexOf('async function runWorkflowJudge'), source.indexOf('// Block 1:'));
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(callback);
  const records: any[] = [], signals: AbortSignal[] = [], prompts: string[] = [];
  const attempts = new Map();
  const run = new Function('ROOT', 'readWorkflowJudgeInput',
    'buildWorkflowJudgePrompt', 'prepareWorkflowJudgeCache', 'workflowJudgeAttempts', 'callJudge',
    'evalCollector', 'expect', 'console', 'performance', 'JUDGE_MS', 'WORKFLOW_JUDGE_RECORD_MS',
    'setTimeout', 'clearTimeout', 'JudgeRefusalError', 'getCookieWorkflowManualReview', 'DEFAULT_JUDGE_MAX_TOKENS',
    `${javascript}\nreturn runWorkflowJudge;`)(
    f.root, overrides.read ?? readWorkflowJudgeInput, buildWorkflowJudgePrompt,
    (options: WorkflowCacheOptions) => (overrides.prepare ?? prepareWorkflowJudgeCache)({ ...options, env: f.env }),
    attempts, async (prompt: string, model: undefined, options: { signal: AbortSignal }) => {
      prompts.push(prompt); signals.push(options.signal);
      return overrides.judge ? overrides.judge(prompt, model, options) : scores;
    }, { addTest: (entry: any) => records.push(entry) }, expect, { log() {} },
    overrides.clock ? { now: overrides.clock } : performance, overrides.budget ?? 120_000, overrides.allowance ?? 5_000,
    overrides.setTimer ?? setTimeout, overrides.clearTimer ?? clearTimeout,
    JudgeRefusalError, getCookieWorkflowManualReview, DEFAULT_JUDGE_MAX_TOKENS);
  return { run, records, signals, prompts, attempts, options: { ...f.opts, suite: 'Cache regression' } };
}

test('the actual workflow callback executes once, reuses with provenance, and preserves assertion failures', async () => {
  const f = fixture(); const first = actualCallback(f);
  const options = { ...f.opts, suite: 'Cache regression' };
  await first.run(options);
  expect(first.prompts).toEqual([f.opts.prompt]); expect(f.entries()).toHaveLength(1);
  expect(first.records[0]).toMatchObject({ passed: true, execution: 'executed', cost_usd: 0.02 });
  expect(first.records[0]).not.toHaveProperty('prompt');
  expect(first.records[0]).not.toHaveProperty('model');
  const reused = actualCallback(f, { judge: async () => ({ ...scores, clarity: 1 }) });
  await reused.run(options);
  expect(reused.prompts).toHaveLength(0);
  expect(reused.records[0]).toMatchObject({ passed: true, execution: 'reused', cost_usd: 0,
    reused_from: { run_id: 'free-cache-test' } });
  // Each original assertion still rejects failed model output before publication.
  for (const field of ['clarity', 'completeness', 'actionability']) {
    const changed = { ...options, testName: `failed ${field}` };
    const failed = actualCallback(f, { judge: async () => ({ ...scores, [field]: 1 }) });
    await expect(failed.run(changed)).rejects.toThrow();
    expect(failed.records).toHaveLength(1);
    expect(failed.records[0]).toMatchObject({ passed: false, execution: 'executed', exit_reason: 'validation_failed' });
    expect(f.entries()).toHaveLength(1);
  }
});

test('a timed-out provider records once, aborts, and cannot overwrite its successful fresh retry', async () => {
  const f = fixture(); let completeLate!: (value: typeof scores) => void; let calls = 0, now = 0;
  const timers = new Map<number, () => void>(); let timerId = 0;
  const h = actualCallback(f, { budget: 20, clock: () => now,
    setTimer: ((callback: () => void) => { timers.set(++timerId, callback); return timerId; }) as any,
    clearTimer: ((id: number) => { timers.delete(id); }) as any,
    judge: async () => ++calls === 1
    ? new Promise(resolve => { completeLate = resolve; }) : scores });
  const expired = h.run(h.options).catch((error: Error) => error);
  now = 20;
  for (const callback of [...timers.values()]) callback();
  expect((await expired).message).toContain('deadline');
  expect(h.records).toHaveLength(1);
  expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
  expect(h.signals[0].aborted).toBe(true);
  expect(f.entries()).toHaveLength(0);
  await h.run(h.options);
  expect(h.records.map(record => record.passed)).toEqual([false, true]);
  expect(h.attempts.get(f.opts.testName).attempt).toBe(2);
  completeLate(scores); await new Promise(resolve => setImmediate(resolve));
  expect(h.records).toHaveLength(2);
  expect(f.entries()).toHaveLength(0); // Retry passes never become receipts.
});

test('a superseding attempt cancels its predecessor before either can record a stale pass', async () => {
  const f = fixture(); let completeLate!: (value: typeof scores) => void; let calls = 0;
  const h = actualCallback(f, { judge: async () => ++calls === 1
    ? new Promise(resolve => { completeLate = resolve; }) : scores });
  const old = h.run(h.options).catch((error: Error) => error);
  await h.run(h.options);
  expect((await old).name).toBe('WorkflowJudgeSuperseded');
  expect(h.signals[0].aborted).toBe(true);
  completeLate(scores); await new Promise(resolve => setImmediate(resolve));
  expect(h.records.map(record => [record.passed, record.exit_reason])).toEqual([[false, 'cancelled'], [true, undefined]]);
  expect(f.entries()).toHaveLength(0);
});

test('a failed input read consumes attempt one and prevents a retry from borrowing or publishing a receipt', async () => {
  const f = fixture(); f.cache().publish(scores); const receipt = fs.readFileSync(path.join(f.env.EVALS_CACHE_DIR, f.entries()[0]), 'utf8');
  let reads = 0;
  const h = actualCallback(f, { read: options => { if (++reads === 1) throw new Error('Missing workflow fixture'); return readWorkflowJudgeInput(options); } });
  await expect(h.run(h.options)).rejects.toThrow('Missing workflow fixture');
  expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'harness_error' });
  await h.run(h.options);
  expect(h.prompts).toHaveLength(1);
  expect(h.records.map(record => record.execution)).toEqual(['executed', 'executed']);
  expect(h.attempts.get(f.opts.testName).attempt).toBe(2);
  expect(fs.readFileSync(path.join(f.env.EVALS_CACHE_DIR, f.entries()[0]), 'utf8')).toBe(receipt);
});

test('monotonic expiry after a synchronous preparation or late model response refuses success', async () => {
  for (const phase of ['preparation', 'response']) {
    const f = fixture(); let now = 0;
    const h = actualCallback(f, { budget: 20, clock: () => now,
      prepare: options => { const cache = prepareWorkflowJudgeCache(options); if (phase === 'preparation') now = 21; return cache; },
      judge: async () => { now = 21; return scores; } });
    await expect(h.run(h.options)).rejects.toThrow('deadline');
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'timeout', duration_ms: 21 });
    expect(h.prompts).toHaveLength(phase === 'preparation' ? 0 : 1);
    expect(f.entries()).toHaveLength(0);
  }
});

test('publication rechecks after input scanning and withdraws a receipt if recording expires', async () => {
  const f = fixture(); let checks = 0;
  f.cache().publish(scores, () => ++checks < 2);
  expect(checks).toBe(2); expect(f.entries()).toHaveLength(0);
  let now = 0;
  const h = actualCallback(f, { budget: 20, allowance: 5, clock: () => now,
    prepare: options => {
      const cache = prepareWorkflowJudgeCache(options);
      return { ...cache, publish: (result, active) => { const discard = cache.publish(result, active); now = 26; return discard; } };
    } });
  await expect(h.run(h.options)).rejects.toThrow('recording deadline');
  expect(h.records).toHaveLength(1);
  expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
  expect(f.entries()).toHaveLength(0);
});

test('provider exceptions retain their diagnostic and produce one failed record without cache output', async () => {
  const f = fixture(); const error = new Error('Provider connection failed');
  const h = actualCallback(f, { judge: async () => { throw error; } });
  await expect(h.run(h.options)).rejects.toBe(error);
  expect(h.records).toHaveLength(1);
  expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'harness_error' });
  expect(h.records[0].error).toContain(error.message);
  expect(f.entries()).toHaveLength(0);
});

test('the actual workflow callback preserves the complete public API body; cancellation is only a request option', async () => {
  const f = fixture();
  // Replace the SDK method before invoking the real helper: no network requests.
  const create = spyOn(Messages.prototype, 'create').mockResolvedValue({
    stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(scores) }],
  } as any);
  try {
    const h = actualCallback(f, { judge: (prompt, model, options) => callJudge<typeof scores>(prompt, model, options) });
    await h.run(h.options);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toEqual([{
      model: resolveEvalModel('judge'), max_tokens: 8192,
      messages: [{ role: 'user', content: f.opts.prompt }],
    }, { signal: h.signals[0] }]);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].passed).toBe(true);
  } finally { create.mockRestore(); }
});
