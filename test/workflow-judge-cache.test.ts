import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Messages } from '@anthropic-ai/sdk/resources/messages';
import { callJudge, JudgeRefusalError, DEFAULT_JUDGE_MAX_TOKENS, judgePanel, judgePanelMajority, judgePanelMean, judgePanelMedian, judgePanelReasoning, JUDGE_SCORE_DIMENSIONS, JUDGE_PANEL_SAMPLES } from './helpers/llm-judge';
import { EVAL_POLICY } from './helpers/periodic-exclude-data';
import { getCookieWorkflowManualReview } from './helpers/cookie-workflow-manual-review';
import { resolveEvalModel } from '../lib/eval-model';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { browseJudgeFloorsMet, prepareWorkflowJudgeCache, validWorkflowJudgePanel, validWorkflowJudgeScore, workflowJudgeDependencies, type WorkflowCacheOptions } from './helpers/workflow-judge-cache';
import { readWorkflowJudgeInput, buildWorkflowJudgePrompt, QA_DISCOVERY_REFERENCES, WORKFLOW_JUDGE_RESPONSE_SCHEMA } from './helpers/workflow-judge-input';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const scores = { clarity: 4, completeness: 5, actionability: 4, reasoning: 'Concrete steps' };
const SAMPLES = JUDGE_PANEL_SAMPLES;
const panelOf = (sample: typeof scores) => Array.from({ length: SAMPLES }, () => sample);
const panel = panelOf(scores);
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
  const f = fixture(); const first = f.cache(); expect(first.lookup()).toBeNull(); first.publish(panel);
  expect(f.entries()).toHaveLength(1);
  const reused = f.cache().lookup(); expect(reused?.samples).toEqual(panel);
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
  const f = fixture(); f.cache().publish(panel);
  const file = path.join(f.root, 'package.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...original, version: '2.0.0' }, null, 2));
  expect(f.cache().lookup()?.samples).toEqual(panel);
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
    const f = fixture(); f.cache().publish(panel); const target = path.join(f.root, file);
    fs.appendFileSync(target, file.endsWith('.json') ? ' ' : '\n// changed');
    f.refreshPrompt(); expect(f.cache().lookup()).toBeNull();
  });
}

test('changed sources during an attempt and mismatched actual prompt cannot publish', () => {
  const f = fixture(); const before = f.cache();
  fs.appendFileSync(path.join(f.root, 'example/sections/review.md'), 'new finding');
  before.publish(panel); expect(f.entries()).toHaveLength(0);
  f.refreshPrompt(); f.opts.prompt += ' hidden new request'; f.cache().publish(panel);
  expect(f.entries()).toHaveLength(0);
});

for (const [key, value] of Object.entries({ EVALS_FRESH: '1', EVALS_TIER: 'periodic',
  EVALS_CACHE_PURPOSE: 'release', EVALS_CACHE_RUNTIME_ID: 'mutable:latest', EVALS_CACHE_PR: '',
  EVALS_CACHE_REPOSITORY: '', NODE_OPTIONS: '--require=unknown', BUN_OPTIONS: '--preload=unknown',
  ANTHROPIC_BASE_URL: 'https://custom-provider.example.test' })) {
  test(`${key}=${value} is fresh or ineligible`, () => {
    const f = fixture(); f.cache().publish(panel);
    f.opts.env = { ...f.env, [key]: value }; const cache = f.cache();
    expect(cache.lookup()).toBeNull(); cache.publish(panel); expect(f.entries()).toHaveLength(1);
  });
}

test('runtime/model/threshold changes miss, and retries never reuse or publish', () => {
  const f = fixture(); f.cache().publish(panel);
  for (const overrides of [{ GSTACK_EVAL_MODEL_JUDGE: 'different-model' }, { EVALS_CACHE_RUNTIME_ID: 'c'.repeat(64) }]) {
    f.opts.env = { ...f.env, ...overrides }; expect(f.cache().lookup()).toBeNull();
  }
  f.opts.env = f.env; f.opts.thresholds.clarity = 5; expect(f.cache().lookup()).toBeNull();
  f.opts.thresholds.clarity = 4; f.opts.attempt = 2; const retry = f.cache();
  expect(retry.lookup()).toBeNull(); retry.publish(panel); expect(f.entries()).toHaveLength(1);
});

test('frontier reader calibration cannot reuse a score from the unspecified-reader rubric', () => {
  const f = fixture(); f.cache().publish(panel);
  const original = f.opts.prompt;
  f.opts.agentCapability = 'frontier'; f.refreshPrompt();
  expect(f.opts.prompt).not.toBe(original);
  expect(f.cache().lookup()).toBeNull();
  f.cache().publish(panel);
  expect(f.entries()).toHaveLength(2);
  expect(f.cache().lookup()?.samples).toEqual(panel);
  delete f.opts.agentCapability; f.refreshPrompt();
  expect(f.opts.prompt).toBe(original);
  expect(f.cache().lookup()?.samples).toEqual(panel);
});

test('a pinned workflow judge model overrides the global model and changes the cache identity', () => {
  const f = fixture();
  f.opts.model = 'claude-sonnet-4-6';
  f.cache().publish(panel);
  expect(f.entries()).toHaveLength(1);
  f.opts.env = { ...f.env, GSTACK_EVAL_MODEL_JUDGE: 'different-global-model' };
  expect(f.cache().lookup()?.samples).toEqual(panel);
  f.opts.model = 'claude-opus-4-7';
  expect(f.cache().lookup()).toBeNull();
});

test('failed assertions, missing provenance, and missing imported dependencies cannot supply a receipt', () => {
  const f = fixture(); f.cache().publish(panelOf({ ...scores, clarity: 3 })); expect(f.entries()).toHaveLength(0);
  f.opts.env = { ...f.env, EVALS_RUN_ID: '' }; f.cache().publish(panel); expect(f.entries()).toHaveLength(0);
  f.opts.env = f.env; fs.unlinkSync(path.join(f.root, 'test/helpers/nested.ts'));
  f.cache().publish(panel); expect(f.entries()).toHaveLength(0);
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
    'judgePanel(() => callJudge<JudgeScore>(prompt, opts.model, { signal: controller.signal, max_tokens: maxTokens,',
    'scores = judgePanelMedian(samples, JUDGE_SCORE_DIMENSIONS);',
    'expect(scores.clarity)', 'expect(scores.completeness)', 'expect(scores.actionability)', 'cache.publish(samples, active)']
    .map(stage => body.indexOf(stage));
  expect(stages.every(position => position >= 0)).toBe(true);
  expect(stages).toEqual([...stages].sort((a, b) => a - b));
  const calls = [...source.matchAll(/await runWorkflowJudge\(/g)].map(match => match.index!);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const timeout = /\n\s*\}, (\w+)\);/.exec(source.slice(call))?.[1];
    expect(timeout, `runWorkflowJudge registration at offset ${call} must use WORKFLOW_JUDGE_TEST_MS`).toBe('WORKFLOW_JUDGE_TEST_MS');
  }
});

function actualCallback(f: ReturnType<typeof fixture>, overrides: {
  judge?: (prompt: string, model: string | undefined, options: { signal: AbortSignal }) => Promise<typeof scores>;
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
    'setTimeout', 'clearTimeout', 'JudgeRefusalError', 'getCookieWorkflowManualReview', 'DEFAULT_JUDGE_MAX_TOKENS', 'resolveEvalModel',
    'WORKFLOW_JUDGE_RESPONSE_SCHEMA', 'validWorkflowJudgeScore',
    'judgePanel', 'judgePanelMean', 'judgePanelMedian', 'judgePanelReasoning', 'JUDGE_SCORE_DIMENSIONS',
    `${javascript}\nreturn runWorkflowJudge;`)(
    f.root, overrides.read ?? readWorkflowJudgeInput, buildWorkflowJudgePrompt,
    (options: WorkflowCacheOptions) => (overrides.prepare ?? prepareWorkflowJudgeCache)({ ...options, env: f.env }),
    attempts, async (prompt: string, model: string | undefined, options: { signal: AbortSignal }) => {
      prompts.push(prompt); signals.push(options.signal);
      return overrides.judge ? overrides.judge(prompt, model, options) : scores;
    }, { addTest: (entry: any) => records.push(entry) }, expect, { log() {} },
    overrides.clock ? { now: overrides.clock } : performance, overrides.budget ?? 120_000, overrides.allowance ?? 5_000,
    overrides.setTimer ?? setTimeout, overrides.clearTimer ?? clearTimeout,
    JudgeRefusalError, getCookieWorkflowManualReview, DEFAULT_JUDGE_MAX_TOKENS, resolveEvalModel,
    WORKFLOW_JUDGE_RESPONSE_SCHEMA, validWorkflowJudgeScore,
    judgePanel, judgePanelMean, judgePanelMedian, judgePanelReasoning, JUDGE_SCORE_DIMENSIONS);
  return { run, records, signals, prompts, attempts, options: { ...f.opts, suite: 'Cache regression' } };
}

test('the actual workflow callback preserves the pinned model and frontier rubric for custom inputs', async () => {
  const f = fixture();
  const models: Array<string | undefined> = [];
  const actual = actualCallback(f, { judge: async (_prompt, model) => { models.push(model); return scores; } });
  await actual.run({ ...actual.options, model: 'claude-sonnet-4-6', agentCapability: 'frontier',
    readInput: () => readWorkflowJudgeInput(f.opts) });
  expect(models).toEqual(Array(SAMPLES).fill('claude-sonnet-4-6'));
  expect(actual.prompts[0]).toContain('GPT-5.6 Sol-level capability or stronger');
  expect(actual.records[0]).toMatchObject({ passed: true, model: 'claude-sonnet-4-6', prompt: actual.prompts[0] });
});

test.each(['ship', 'review'])('the registered %s callback sends the frontier rubric and still rejects subthreshold clarity', async skill => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-llm-eval.test.ts'), 'utf8');
  const registration = source.match(new RegExp(`testIfSelected\\('${skill}/SKILL\\.md workflow',[\\s\\S]*?await runWorkflowJudge\\(\\{([\\s\\S]*?)\\n    \\}\\);`));
  expect(registration).not.toBeNull();
  const registered = new Function('QA_DISCOVERY_REFERENCES', `return ({${registration![1]}});`)(QA_DISCOVERY_REFERENCES);
  const f = fixture();
  Object.assign(f.env, { EVALS_FRESH: '1' });
  const options = { ...registered, skillPath: f.opts.skillPath, startMarker: f.opts.startMarker,
    endMarker: f.opts.endMarker, references: [] };
  const passing = actualCallback(f, { judge: async () => ({ ...scores, clarity: 3 }) });
  await passing.run(options);
  expect(passing.prompts).toHaveLength(SAMPLES);
  expect(passing.prompts[0]).toContain('GPT-5.6 Sol-level capability or stronger');
  expect(passing.records[0]).toMatchObject({ passed: true, execution: 'executed', judge_scores: { clarity: 3 } });
  const failing = actualCallback(f, { judge: async () => ({ ...scores, clarity: 2 }) });
  await expect(failing.run(options)).rejects.toThrow();
  expect(failing.prompts).toEqual(passing.prompts);
  expect(failing.records[0]).toMatchObject({ passed: false, execution: 'executed',
    exit_reason: 'validation_failed', judge_scores: { clarity: 2 } });
  expect(f.entries()).toHaveLength(0);
});

test('the actual workflow callback executes once, reuses with provenance, and preserves assertion failures', async () => {
  const f = fixture(); const first = actualCallback(f);
  const options = { ...f.opts, suite: 'Cache regression' };
  await first.run(options);
  expect(first.prompts).toEqual(Array(SAMPLES).fill(f.opts.prompt)); expect(f.entries()).toHaveLength(1);
  expect(first.records[0]).toMatchObject({ passed: true, execution: 'executed', cost_usd: 0.02 * SAMPLES });
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
  const f = fixture(); f.cache().publish(panel); const receipt = fs.readFileSync(path.join(f.env.EVALS_CACHE_DIR, f.entries()[0]), 'utf8');
  let reads = 0;
  const h = actualCallback(f, { read: options => { if (++reads === 1) throw new Error('Missing workflow fixture'); return readWorkflowJudgeInput(options); } });
  await expect(h.run(h.options)).rejects.toThrow('Missing workflow fixture');
  expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'harness_error' });
  await h.run(h.options);
  expect(h.prompts).toHaveLength(SAMPLES);
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
    expect(h.prompts).toHaveLength(phase === 'preparation' ? 0 : SAMPLES);
    expect(f.entries()).toHaveLength(0);
  }
});

test('publication rechecks after input scanning and withdraws a receipt if recording expires', async () => {
  const f = fixture(); let checks = 0;
  f.cache().publish(panel, () => ++checks < 2);
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
    expect(create).toHaveBeenCalledTimes(SAMPLES);
    expect(create.mock.calls[0]).toEqual([{
      model: resolveEvalModel('judge'), max_tokens: 8192,
      messages: [{ role: 'user', content: f.opts.prompt }],
    }, { signal: h.signals[0] }]);
    expect(h.records).toHaveLength(1);
    expect(h.records[0].passed).toBe(true);
  } finally { create.mockRestore(); }
});

test('Ship sends its authorized 64k cap and compact response contract through the streaming SDK boundary', async () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'skill-llm-eval.test.ts'), 'utf8');
  const registration = source.match(/testIfSelected\('ship\/SKILL\.md workflow',[\s\S]*?await runWorkflowJudge\(\{([\s\S]*?)\n    \}\);/);
  expect(registration).not.toBeNull();
  const options = new Function('QA_DISCOVERY_REFERENCES', `return ({${registration![1]}});`)(QA_DISCOVERY_REFERENCES);
  expect(options.schemaTransport).toBe(true);
  expect(options.compactReasoning).toBe(true);
  expect(options.maxTokens).toBe(65_536);
  expect(options.stream).toBe(true);
  expect(options.effort).toBe('medium');
  expect(source.match(/^\s+effort: '/gm)).toHaveLength(1);
  // The ~64k-token review bundle gets only ship's output cap and streaming; its effort and response format stay default.
  const review = source.match(/testIfSelected\('review\/SKILL\.md workflow',[\s\S]*?await runWorkflowJudge\(\{([\s\S]*?)\n    \}\);/);
  expect(review).not.toBeNull();
  const reviewOptions = new Function('QA_DISCOVERY_REFERENCES', `return ({${review![1]}});`)(QA_DISCOVERY_REFERENCES);
  expect([reviewOptions.maxTokens, reviewOptions.stream, reviewOptions.effort, reviewOptions.schemaTransport, reviewOptions.compactReasoning])
    .toEqual([65_536, true, undefined, undefined, undefined]);
  expect(WORKFLOW_JUDGE_RESPONSE_SCHEMA.properties.reasoning).not.toHaveProperty('pattern');
  expect(WORKFLOW_JUDGE_RESPONSE_SCHEMA.properties.reasoning).not.toHaveProperty('maxLength');
  expect(source.match(/compactReasoning: true/g)).toHaveLength(1);
  const f = fixture();
  const stream = spyOn(Messages.prototype, 'stream').mockReturnValue({ finalMessage: async () => ({
    stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(scores) }],
  }) } as any);
  try {
    const h = actualCallback(f, { judge: (prompt, model, request) => callJudge<typeof scores>(prompt, model, request) });
    await h.run({ ...h.options, schemaTransport: options.schemaTransport, compactReasoning: options.compactReasoning, maxTokens: options.maxTokens, stream: options.stream, effort: options.effort });
    expect(stream.mock.calls[0]).toEqual([{
      model: resolveEvalModel('judge'), max_tokens: 65_536,
      output_config: { format: { type: 'json_schema', schema: WORKFLOW_JUDGE_RESPONSE_SCHEMA }, effort: 'medium' },
      messages: [{ role: 'user', content: f.opts.prompt }],
    }, { signal: h.signals[0] }]);
    expect(h.records[0]).toMatchObject({ passed: true, judge_scores: { clarity: 4, completeness: 5, actionability: 4 } });
    expect(f.entries()).toHaveLength(1);
    expect(f.cache().lookup()).toBeNull();
    f.opts.schemaTransport = true;
    f.opts.compactReasoning = true;
    f.opts.maxTokens = 65_536;
    f.opts.stream = true;
    expect(f.cache().lookup()).toBeNull();
    f.opts.effort = 'medium';
    expect(f.cache().lookup()?.samples).toEqual(panel);
  } finally { stream.mockRestore(); }
});

test('changing response serialization misses the cache even when prompt and model match', () => {
  const f = fixture(); f.cache().publish(panel);
  f.opts.schemaTransport = true;
  expect(f.cache().lookup()).toBeNull();
  f.cache().publish(panel);
  expect(f.entries()).toHaveLength(2);
  expect(f.cache().lookup()?.samples).toEqual(panel);
  const description = WORKFLOW_JUDGE_RESPONSE_SCHEMA.properties.reasoning.description;
  try {
    WORKFLOW_JUDGE_RESPONSE_SCHEMA.properties.reasoning.description += ' Changed response contract.';
    expect(f.cache().lookup()).toBeNull();
  } finally { WORKFLOW_JUDGE_RESPONSE_SCHEMA.properties.reasoning.description = description; }
  expect(f.cache().lookup()?.samples).toEqual(panel);
  f.opts.schemaTransport = false;
  expect(f.cache().lookup()?.samples).toEqual(panel);
});

test('schema transport and the compact-reasoning validator independently affect workflow cache identity', () => {
  const f = fixture(); f.cache().publish(panel);
  f.opts.schemaTransport = true;
  expect(f.cache().lookup()).toBeNull();
  f.cache().publish(panel);
  f.opts.compactReasoning = true;
  expect(f.cache().lookup()).toBeNull();
  f.cache().publish(panel);
  expect(f.entries()).toHaveLength(3);
  f.opts.compactReasoning = false;
  expect(f.cache().lookup()?.samples).toEqual(panel);
  const long = { ...scores, reasoning: Array(150).fill('word').join(' ') };
  expect(validWorkflowJudgeScore(long, { clarity: 1, completeness: 1, actionability: 1 })).toBe(true);
  expect(validWorkflowJudgeScore(long, { clarity: 1, completeness: 1, actionability: 1 }, true)).toBe(false);
});

test('schema transport alone sends the schema without applying the compact-reasoning validator', async () => {
  const f = fixture();
  const long = { ...scores, reasoning: Array(150).fill('word').join(' ') };
  const create = spyOn(Messages.prototype, 'create').mockResolvedValue({
    stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(long) }],
  } as any);
  try {
    const h = actualCallback(f, { judge: (prompt, model, request) => callJudge<typeof scores>(prompt, model, request) });
    await h.run({ ...h.options, schemaTransport: true });
    expect(create.mock.calls[0]).toEqual([{
      model: resolveEvalModel('judge'), max_tokens: 8192,
      output_config: { format: { type: 'json_schema', schema: WORKFLOW_JUDGE_RESPONSE_SCHEMA } },
      messages: [{ role: 'user', content: f.opts.prompt }],
    }, { signal: h.signals[0] }]);
    expect(h.records[0]).toMatchObject({ passed: true });
    const validated = actualCallback(f, { judge: (prompt, model, request) => callJudge<typeof scores>(prompt, model, request) });
    await expect(validated.run({ ...validated.options, testName: 'validated', schemaTransport: true, compactReasoning: true })).rejects.toThrow('compact response contract');
  } finally { create.mockRestore(); }
});

test('the actual cap and streaming transport independently affect workflow cache identity', () => {
  const f = fixture(); f.cache().publish(panel);
  f.opts.maxTokens = 65_536;
  expect(f.cache().lookup()).toBeNull();
  f.cache().publish(panel);
  f.opts.stream = true;
  expect(f.cache().lookup()).toBeNull();
  f.cache().publish(panel);
  expect(f.entries()).toHaveLength(3);
  expect(f.cache().lookup()?.samples).toEqual(panel);
  delete f.opts.maxTokens;
  delete f.opts.stream;
  expect(f.cache().lookup()?.samples).toEqual(panel);
});

test('the structured callback rejects incomplete, schema-invalid and below-threshold answers without cache credit', async () => {
  const invalid = [null, {}, { ...scores, extra: 'not a score field' }, { ...scores, clarity: '4' },
    { ...scores, clarity: 4.5 }, { ...scores, clarity: 6 }, { ...scores, reasoning: '' },
    { ...scores, reasoning: Array(150).fill('word').join(' ') }, { ...scores, clarity: 2 },
    { ...scores, completeness: 2 }, { ...scores, actionability: 3 }];
  const responses: Array<{ stop_reason: string; value: unknown }> = [
    ...['max_tokens', 'refusal', 'stop_sequence'].map(stop_reason => ({ stop_reason, value: scores })),
    ...invalid.map(value => ({ stop_reason: 'end_turn', value })),
  ];
  const stream = spyOn(Messages.prototype, 'stream');
  const diagnostics = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const response of responses) {
      const f = fixture();
      stream.mockReturnValue({ finalMessage: async () => ({ stop_reason: response.stop_reason,
        content: [{ type: 'text', text: JSON.stringify(response.value) }] }) } as any);
      const h = actualCallback(f, { judge: (prompt, model, request) => callJudge<typeof scores>(prompt, model, request) });
      await expect(h.run({ ...h.options, schemaTransport: true, compactReasoning: true, maxTokens: 65_536, stream: true })).rejects.toThrow();
      expect(h.records).toHaveLength(1);
      expect(h.records[0].passed).toBe(false);
      expect(f.entries()).toHaveLength(0);
    }
    expect(validWorkflowJudgeScore({ ...scores, reasoning: Array(149).fill('word').join(' ') }, { clarity: 1, completeness: 1, actionability: 1 }, true)).toBe(true);
  } finally { stream.mockRestore(); diagnostics.mockRestore(); }
});

// --- Judge panel policy (EVAL_POLICY.judge): fixed concurrent samples, per-dimension
// mean and boolean majority against unchanged thresholds, an erroring sample fails
// the whole panel and is never resampled. The provider is always a stub.
const panelScore = (clarity: number, completeness = 4, actionability = 4) => ({ clarity, completeness, actionability, reasoning: `c${clarity}` });
const panelThresholds = { clarity: 3, completeness: 3, actionability: 4 };
const panelRefusal = () => new JudgeRefusalError({ id: 'msg_1', _request_id: 'req_1', model: 'm', usage: { input_tokens: 1, output_tokens: 0 }, content: [] });

describe('judge panel', () => {
  test('the pre-registered panel is three samples, and the helper restates EVAL_POLICY exactly', () => {
    expect(EVAL_POLICY.judge.samples).toBe(3);
    expect(JUDGE_PANEL_SAMPLES).toBe(EVAL_POLICY.judge.samples);
  });

  test('draws every sample concurrently before any resolves', async () => {
    let started = 0;
    const releases: Array<() => void> = [];
    const panel = judgePanel(() => new Promise<number>(resolve => { started += 1; releases.push(() => resolve(started)); }));
    await Promise.resolve();
    expect(started).toBe(SAMPLES);
    releases.forEach(release => release());
    expect(await panel).toHaveLength(SAMPLES);
  });

  test('an erroring sample fails the panel and is never resampled', async () => {
    let calls = 0;
    const panel = judgePanel(async () => {
      calls += 1;
      if (calls === 2) throw new Error('Judge returned non-JSON: nope');
      return panelScore(5);
    });
    await expect(panel).rejects.toThrow('non-JSON');
    expect(calls).toBe(SAMPLES);
  });

  test('a refusal on every sample stays a provider refusal; a partial refusal is an ordinary failure', async () => {
    await expect(judgePanel(async () => { throw panelRefusal(); })).rejects.toBeInstanceOf(JudgeRefusalError);
    let calls = 0;
    const partial = judgePanel(async () => { if (++calls === 1) throw panelRefusal(); return panelScore(4); });
    const error = await partial.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(JudgeRefusalError);
    expect(String(error)).toContain(`sample 1 of ${SAMPLES} failed beside scored samples`);
  });

  test('numeric dimensions gate on the per-dimension median: 2 of 3 samples decide, the mean is only reported', () => {
    const outvoted = judgePanelMedian([panelScore(2), panelScore(4), panelScore(4)], JUDGE_SCORE_DIMENSIONS);
    expect(outvoted.clarity).toBe(4);
    expect(judgePanelMean([panelScore(2), panelScore(4), panelScore(4)], JUDGE_SCORE_DIMENSIONS).clarity).toBeCloseTo(10 / 3);
    const low = judgePanelMedian([panelScore(2), panelScore(2), panelScore(4)], JUDGE_SCORE_DIMENSIONS);
    expect(low.clarity).toBeLessThan(panelThresholds.clarity);
    // No compensation across dimensions: each is gated on its own.
    expect(judgePanelMedian([panelScore(5, 1), panelScore(5, 1), panelScore(5, 1)], JUDGE_SCORE_DIMENSIONS).completeness).toBe(1);
  });

  test('malformed sample fields fail the panel instead of averaging to NaN', () => {
    expect(() => judgePanelMean([panelScore(4), { ...panelScore(4), clarity: '4' as unknown as number }, panelScore(4)], JUDGE_SCORE_DIMENSIONS)).toThrow('sample 2 has non-numeric clarity');
    expect(() => judgePanelMean([panelScore(4), null as unknown as ReturnType<typeof panelScore>], JUDGE_SCORE_DIMENSIONS)).toThrow('sample 2');
    expect(() => judgePanelMean([], JUDGE_SCORE_DIMENSIONS)).toThrow('no samples');
  });

  test('boolean fields gate on a strict majority', () => {
    const vote = (...values: boolean[]) => judgePanelMajority(values.map(value => ({ ok: value })), 'ok');
    expect(vote(true, true, false)).toBe(true);
    expect(vote(true, false, false)).toBe(false);
    expect(vote(true, false)).toBe(false);
    expect(() => judgePanelMajority([{ ok: true }, { ok: 'yes' }], 'ok')).toThrow('sample 2 has non-boolean ok');
  });

  test('reasoning keeps every sample, numbered, even for malformed samples', () => {
    expect(judgePanelReasoning([panelScore(4), null, { reasoning: 7 }])).toBe('[sample 1] c4\n[sample 2] \n[sample 3] ');
  });

  test('the cache stores and validates only a complete panel against the mean', () => {
    expect(validWorkflowJudgePanel({ samples: [panelScore(2), panelScore(4), panelScore(4)] }, panelThresholds)).toBe(true);
    expect(validWorkflowJudgePanel({ samples: [panelScore(2), panelScore(2), panelScore(4)] }, panelThresholds)).toBe(false);
    expect(validWorkflowJudgePanel({ samples: [panelScore(4), panelScore(4)] }, panelThresholds)).toBe(false);
    expect(validWorkflowJudgePanel({ samples: [panelScore(4), panelScore(4), panelScore(4), panelScore(4)] }, panelThresholds)).toBe(false);
    expect(validWorkflowJudgePanel({ samples: [panelScore(4), panelScore(4), { ...panelScore(4), clarity: 6 }] }, panelThresholds)).toBe(false);
    expect(validWorkflowJudgePanel({ samples: [panelScore(4), panelScore(4), panelScore(4)], prompt: 'x' }, panelThresholds)).toBe(false);
    expect(validWorkflowJudgePanel(panelScore(4), panelThresholds)).toBe(false);
  });

  test('every judge in the quality file samples through the panel, never a lone call', () => {
    const source = fs.readFileSync(path.join(import.meta.dir, 'skill-llm-eval.test.ts'), 'utf8');
    const calls = [...source.matchAll(/\b(?:callJudge<[^>(]*(?:<[^>]*>[^>(]*)*>|judge)\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) {
      expect(source.slice(Math.max(0, call.index! - 25), call.index), `unpaneled judge call at offset ${call.index}`).toMatch(/judgePanel\(\(\) => $/);
    }
    expect(source).not.toMatch(/\bscores\.reasoning\b|\bresult\.reasoning\b/);
  });
});

// Stored browse reference panel means (recorded before EVAL_POLICY v3) against the judge floors.
{
  type Scores = { clarity: number; completeness: number; actionability: number };
  const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/browse-judge/panel-means.json'), 'utf8')) as
    { known_good: Record<string, Scores>; known_bad: Record<string, Scores> };

  describe('browse judge floors', () => {
    test.each(Object.entries(stored.known_good))('passes %s', (_name, scores) => expect(browseJudgeFloorsMet(scores)).toBe(true));
    test.each(Object.entries(stored.known_bad))('fails %s', (_name, scores) => expect(browseJudgeFloorsMet(scores)).toBe(false));
  });
}
