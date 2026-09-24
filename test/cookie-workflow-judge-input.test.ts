import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCookieWorkflowJudgeInput, COOKIE_WORKFLOW_JUDGE } from './helpers/cookie-workflow-judge-input';
import { buildWorkflowJudgePrompt, readWorkflowJudgeInput } from './helpers/workflow-judge-input';
import { prepareWorkflowJudgeCache, type WorkflowCacheOptions } from './helpers/workflow-judge-cache';
import type { EvalTestEntry } from './helpers/eval-store';
import { selectTests } from './helpers/test-selection';
import { E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';
import { selectPrProfile } from '../scripts/test-pr-profile';
import { JUDGE_MS } from './helpers/eval-budgets';
import { JudgeRefusalError, DEFAULT_JUDGE_MAX_TOKENS } from './helpers/llm-judge';
import { COOKIE_MANUAL_REVIEW_FILE, getCookieWorkflowManualReview, isManualReviewEntry } from './helpers/cookie-workflow-manual-review';

const ROOT = resolve(import.meta.dir, '..');
const NAME = 'setup-browser-cookies/SKILL.md workflow';
const scratch: string[] = [];
const skill = 'excluded preamble\n# Setup Browser Cookies\nRead the gstack root\'s `BROWSER.md`, **Choosing a source and checking sign-in**.\nExact body.\n';
const browser = 'excluded browser introduction\n#### Choosing a source and checking sign-in\nExact reference.\n\n### Tabs + frames\nexcluded tab commands\n';

function fixture(entry: string | null = skill, reference: string | null = browser): string {
  const root = mkdtempSync(join(tmpdir(), 'gstack-cookie-judge-'));
  scratch.push(root);
  mkdirSync(join(root, 'setup-browser-cookies'));
  if (entry !== null) writeFileSync(join(root, 'setup-browser-cookies/SKILL.md'), entry);
  if (reference !== null) writeFileSync(join(root, 'BROWSER.md'), reference);
  return root;
}

function approveFixture(root: string) {
  const input = buildCookieWorkflowJudgeInput(root);
  const approval = { ...JSON.parse(readFileSync(join(ROOT, COOKIE_MANUAL_REVIEW_FILE), 'utf8')),
    prompt_sha256: input.sha256, prompt_bytes: Buffer.byteLength(input.prompt), model: 'fixture-model',
    reason: 'Synthetic approval fixture, not live review evidence' };
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, COOKIE_MANUAL_REVIEW_FILE), JSON.stringify(approval));
  return approval;
}

const refusal = () => new JudgeRefusalError({ id: 'msg_synthetic', _request_id: 'req_synthetic',
  model: 'fixture-model', usage: { input_tokens: 1, output_tokens: 0 }, content: [] });

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

type FixtureScore = { clarity: number; completeness: number; actionability: number; reasoning: string };
const passingScore: FixtureScore = { ...COOKIE_WORKFLOW_JUDGE.thresholds, reasoning: 'Synthetic fixture score' };

function actualCookieCallback(root: string, overrides: {
  judge?: () => Promise<FixtureScore>;
  clock?: () => number;
  budget?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
} = {}) {
  const source = readFileSync(join(ROOT, 'test/skill-llm-eval.test.ts'), 'utf8');
  const managedStart = source.indexOf('async function runWorkflowJudge');
  const managedEnd = source.indexOf('// Block 1:', managedStart);
  const start = source.indexOf("describeIfSelected('Cookie setup workflow quality'");
  const end = source.indexOf('// Module-level afterAll', start);
  expect(managedStart).toBeGreaterThan(-1);
  expect(managedEnd).toBeGreaterThan(managedStart);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const registration = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(managedStart, managedEnd) + source.slice(start, end));
  const requests: Array<{ prompt: string; model: undefined; signal: AbortSignal }> = [];
  const records: EvalTestEntry[] = [];
  const attempts = new Map<string, { attempt: number }>();
  let callback: () => Promise<void> = async () => { throw new Error('Judge callback was not registered'); };
  new Function('describeIfSelected', 'testIfSelected', 'ROOT', 'buildCookieWorkflowJudgeInput', 'resolveEvalModel', 'callJudge', 'COOKIE_WORKFLOW_JUDGE', 'JUDGE_MS', 'WORKFLOW_JUDGE_TEST_MS', 'WORKFLOW_JUDGE_RECORD_MS', 'evalCollector', 'expect', 'console', 'readWorkflowJudgeInput', 'buildWorkflowJudgePrompt', 'prepareWorkflowJudgeCache', 'workflowJudgeAttempts', 'performance', 'setTimeout', 'clearTimeout', 'JudgeRefusalError', 'getCookieWorkflowManualReview', 'DEFAULT_JUDGE_MAX_TOKENS', registration)(
    (_suite: string, names: string[], run: () => void) => { expect(names).toEqual([NAME]); run(); },
    (name: string, run: () => Promise<void>, budget: number) => { expect(name).toBe(NAME); expect(budget).toBe(JUDGE_MS + 10_000); callback = run; },
    root, buildCookieWorkflowJudgeInput, () => 'fixture-model',
    async (prompt: string, model: undefined, options: { signal: AbortSignal }) => { requests.push({ prompt, model, signal: options.signal }); return overrides.judge ? overrides.judge() : passingScore; },
    COOKIE_WORKFLOW_JUDGE, overrides.budget ?? JUDGE_MS, JUDGE_MS + 10_000, 5_000,
    { addTest: (record: EvalTestEntry) => records.push(record) }, expect, { log() {} },
    readWorkflowJudgeInput, buildWorkflowJudgePrompt,
    (options: WorkflowCacheOptions) => prepareWorkflowJudgeCache({ ...options, env: {
      EVALS_CACHE_DIR: join(root, 'cache'), EVALS_CACHE_REPOSITORY: 'fixture/cookie', EVALS_CACHE_PR: '1',
      EVALS_CACHE_RUNTIME_ID: 'a'.repeat(64), EVALS_TIER: 'gate', EVALS_RUN_ID: 'cookie-fixture',
    } }),
    attempts, overrides.clock ? { now: overrides.clock } : performance,
    overrides.setTimer ?? setTimeout, overrides.clearTimer ?? clearTimeout,
    JudgeRefusalError, getCookieWorkflowManualReview, DEFAULT_JUDGE_MAX_TOKENS,
  );
  return { run: () => callback(), requests, records, attempts };
}

describe('cookie workflow judge input', () => {
  test('the registered callback accepts only an approved empty provider refusal, with no score or cache credit', async () => {
    const root = fixture();
    approveFixture(root);
    const h = actualCookieCallback(root, { judge: async () => { throw refusal(); } });
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ passed: false, execution: 'executed', exit_reason: 'provider_refusal' });
    expect(isManualReviewEntry(h.records[0])).toBe(true);
    expect(h.records[0]).not.toHaveProperty('judge_scores');
    expect(h.records[0]).not.toHaveProperty('judge_reasoning');
    expect(h.records[0]).not.toHaveProperty('reused_from');
    expect(existsSync(join(root, 'cache'))).toBe(false);
  });

  test('an approval cannot turn low scores, malformed output, or a refusal-named ordinary error into acceptance', async () => {
    const root = fixture(); approveFixture(root);
    for (const result of [
      { ...passingScore, clarity: 1 },
      new SyntaxError('Malformed provider JSON'),
      Object.assign(new Error('Synthetic refusal text'), { name: 'JudgeRefusalError' }),
    ]) {
      const h = actualCookieCallback(root, { judge: async () => { if (result instanceof Error) throw result; return result; } });
      await expect(h.run()).rejects.toThrow();
      expect(h.records).toHaveLength(1);
      expect(h.records[0].passed).toBe(false);
      expect(h.records[0]).not.toHaveProperty('manual_review');
      expect(isManualReviewEntry(h.records[0])).toBe(false);
    }
    const scored = actualCookieCallback(root);
    await scored.run();
    expect(scored.records[0]).toMatchObject({ passed: true, judge_scores: COOKIE_WORKFLOW_JUDGE.thresholds });
    expect(scored.records[0]).not.toHaveProperty('manual_review');
  });

  test.each(['prompt', 'model', 'budget', 'thresholds', 'malformed', 'missing', 'evidence', 'response-evidence'])(
    'the actual callback rejects an unapproved refusal: %s', async mismatch => {
      const root = fixture(); const approval = approveFixture(root);
      const error = refusal();
      if (mismatch === 'prompt') writeFileSync(join(root, 'BROWSER.md'), browser.replace('Exact reference.', 'Changed reference.'));
      if (mismatch === 'model') approval.model = 'different-model';
      if (mismatch === 'budget') approval.max_tokens++;
      if (mismatch === 'thresholds') approval.thresholds.clarity++;
      if (mismatch === 'evidence') error.refusal.request_id = null;
      if (mismatch === 'response-evidence') error.refusal.response_id = null;
      writeFileSync(join(root, COOKIE_MANUAL_REVIEW_FILE), mismatch === 'malformed' ? '{}' : JSON.stringify(approval));
      if (mismatch === 'missing') rmSync(join(root, COOKIE_MANUAL_REVIEW_FILE));
      const h = actualCookieCallback(root, { judge: async () => { throw error; } });
      await expect(h.run()).rejects.toThrow();
      expect(h.records).toHaveLength(1);
      expect(h.records[0].passed).toBe(false);
      expect(h.records[0]).not.toHaveProperty('manual_review');
      expect(existsSync(join(root, 'cache'))).toBe(false);
    });

  test('a late refusal stays a timeout despite exact approval', async () => {
    const root = fixture(); approveFixture(root);
    let now = 0;
    const h = actualCookieCallback(root, { budget: 20, clock: () => now,
      judge: async () => { now = 20; throw refusal(); } });
    await expect(h.run()).rejects.toThrow('deadline');
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
    expect(h.records[0]).not.toHaveProperty('manual_review');
  });

  test('a retry refusal cannot erase an earlier scored failure with manual acceptance', async () => {
    const root = fixture(); approveFixture(root);
    let calls = 0;
    const h = actualCookieCallback(root, { judge: async () => {
      if (++calls === 1) return { ...passingScore, clarity: 1 };
      throw refusal();
    } });
    await expect(h.run()).rejects.toThrow();
    await expect(h.run()).rejects.toThrow('provider refused');
    expect(h.records.map(record => [record.attempt, record.passed, record.exit_reason]))
      .toEqual([[1, false, 'validation_failed'], [2, false, 'provider_refusal']]);
    for (const record of h.records) expect(record).not.toHaveProperty('manual_review');
  });

  test('preserves exact source bytes, line ranges, and the immutable rubric', () => {
    const input = buildCookieWorkflowJudgeInput(fixture());
    expect(input.files).toEqual([
      { path: 'setup-browser-cookies/SKILL.md', kind: 'entrypoint', startLine: 2, endLine: 4, content: skill.slice(skill.indexOf('# Setup')) },
      { path: 'BROWSER.md', kind: 'section', startLine: 2, endLine: 4, content: browser.slice(browser.indexOf('#### Choosing'), browser.indexOf('### Tabs')) },
    ]);
    for (const file of input.files) {
      expect(input.text).toContain(`--- BEGIN FILE ${JSON.stringify(file.path)} (lines ${file.startLine}-${file.endLine}; ${file.kind}) ---\n${file.content}\n--- END FILE ${JSON.stringify(file.path)} ---`);
      expect(input.text.split(file.content)).toHaveLength(2);
    }
    expect(input.prompt).toBe(buildWorkflowJudgePrompt(COOKIE_WORKFLOW_JUDGE, input));
    expect(input.sha256).toBe(createHash('sha256').update(input.prompt).digest('hex'));
    expect(input.prompt).not.toContain('excluded');
    expect(COOKIE_WORKFLOW_JUDGE.thresholds).toEqual({ clarity: 4, completeness: 3, actionability: 4 });
  });

  test('preserves CRLF instead of rewriting excerpts', () => {
    const input = buildCookieWorkflowJudgeInput(fixture(skill.replaceAll('\n', '\r\n'), browser.replaceAll('\n', '\r\n')));
    expect(input.files[0].content).toBe(skill.slice(skill.indexOf('# Setup')).replaceAll('\n', '\r\n'));
    expect(input.files[1].content).toBe(browser.slice(browser.indexOf('#### Choosing'), browser.indexOf('### Tabs')).replaceAll('\n', '\r\n'));
    expect(input.files.map(file => [file.startLine, file.endLine])).toEqual([[2, 4], [2, 4]]);
  });

  test('fingerprints consumed bytes, not excluded source text', () => {
    const original = buildCookieWorkflowJudgeInput(fixture());
    expect(buildCookieWorkflowJudgeInput(fixture(skill.replace('Exact body.', 'Changed body.'))).sha256).not.toBe(original.sha256);
    expect(buildCookieWorkflowJudgeInput(fixture(skill, browser.replace('Exact reference.', 'Changed reference.'))).sha256).not.toBe(original.sha256);
    expect(buildCookieWorkflowJudgeInput(fixture(skill.replace('excluded preamble', 'different preamble'), browser.replace('excluded tab commands', 'different tab commands'))).sha256).toBe(original.sha256);
  });

  test('reads the actual generated workflow and only its referenced cookie section', () => {
    const input = buildCookieWorkflowJudgeInput(ROOT);
    const entry = readFileSync(join(ROOT, 'setup-browser-cookies/SKILL.md'), 'utf8');
    const reference = readFileSync(join(ROOT, 'BROWSER.md'), 'utf8');
    expect(input.files[0].content).toBe(entry.slice(entry.indexOf('# Setup Browser Cookies')));
    expect(input.files[1].content).toBe(reference.slice(reference.indexOf('#### Choosing a source and checking sign-in'), reference.indexOf('### Tabs + frames')));
    expect(input.files[0].content.length).toBeGreaterThan(500);
    expect(input.files[1].content.length).toBeGreaterThan(500);
    expect(input.prompt).toContain('GSTACK_COOKIE_AUTH_EXPECTED_IDENTITY');
    expect(input.prompt).toContain('isolated world');
    expect(input.prompt).not.toContain('### Tabs + frames');
  });

  test('fails closed when either source file is absent', () => {
    expect(() => buildCookieWorkflowJudgeInput(fixture(null))).toThrow();
    expect(() => buildCookieWorkflowJudgeInput(fixture(skill, null))).toThrow();
  });

  test('rejects missing, duplicate, or non-heading markers', () => {
    for (const broken of [skill.replace('# Setup Browser Cookies', '# Missing'), skill + '# Setup Browser Cookies\nDuplicate\n', skill.replace('# Setup Browser Cookies', 'Quoted # Setup Browser Cookies')]) {
      expect(() => buildCookieWorkflowJudgeInput(fixture(broken))).toThrow('expected exactly one marker');
    }
    for (const marker of ['#### Choosing a source and checking sign-in', '### Tabs + frames']) {
      expect(() => buildCookieWorkflowJudgeInput(fixture(skill, browser.replace(marker, 'missing')))).toThrow('expected exactly one marker');
      expect(() => buildCookieWorkflowJudgeInput(fixture(skill, browser + marker + '\n'))).toThrow('expected exactly one marker');
    }
  });

  test('rejects empty, reversed, or unreferenced excerpts', () => {
    expect(() => buildCookieWorkflowJudgeInput(fixture('# Setup Browser Cookies\n'))).toThrow('empty or reversed');
    expect(() => buildCookieWorkflowJudgeInput(fixture(skill, '#### Choosing a source and checking sign-in\n\n### Tabs + frames\n'))).toThrow('empty or reversed');
    expect(() => buildCookieWorkflowJudgeInput(fixture(skill, '### Tabs + frames\n#### Choosing a source and checking sign-in\nContent\n'))).toThrow('empty or reversed');
    expect(() => buildCookieWorkflowJudgeInput(fixture(skill.replace('`BROWSER.md`', '`other.md`')))).toThrow('missing cookie reference link');
    expect(() => buildCookieWorkflowJudgeInput(fixture(skill.replace('**Choosing a source and checking sign-in**', '**Other section**')))).toThrow('missing cookie reference link');
  });

  test('generated host workflows resolve shared references from the installation root and check Aside first', () => {
    for (const file of ['setup-browser-cookies/SKILL.md', '.agents/skills/gstack-setup-browser-cookies/SKILL.md']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const body = source.slice(source.indexOf('# Setup Browser Cookies'));
      expect(body).toContain('Use this checkout as the gstack root if it contains `BROWSER.md` and `browse/SKILL.md`');
      expect(body).toContain('the installed root containing `bin/gstack-skill-start`, never a generated host stub');
      expect(body).toContain("Read that root's `browse/SKILL.md`");
      expect(body).toContain('On `READY`, stop importing');
      expect(body.indexOf('**BROWSER SETUP**')).toBeLessThan(body.indexOf('## SETUP'));
      expect(body).toContain("Read that same root's `BROWSER.md`, **Choosing a source and checking sign-in**");
      expect(body).not.toContain('../BROWSER.md');
    }
    expect(readFileSync(join(ROOT, 'browse/SKILL.md'), 'utf8')).toContain('## BROWSER SETUP (Aside');
    expect(readFileSync(join(ROOT, 'BROWSER.md'), 'utf8')).toContain('#### Choosing a source and checking sign-in');
  });

  test('each owned dependency selects this judge in the fast PR profile', () => {
    for (const file of ['setup-browser-cookies/SKILL.md.tmpl', 'setup-browser-cookies/SKILL.md', 'BROWSER.md', 'test/helpers/cookie-workflow-judge-input.ts', 'test/cookie-workflow-judge-input.test.ts', 'test/helpers/cookie-workflow-manual-review.ts', 'test/cookie-workflow-manual-review.test.ts', 'test/helpers/manual-judge-review-fixture.ts', '.github/cookie-workflow-manual-review.json']) {
      const selectedJudges = selectTests([file], LLM_JUDGE_TOUCHFILES).selected;
      expect(selectedJudges).toEqual([NAME]);
      const selectedE2E = selectTests([file], E2E_TOUCHFILES).selected;
      const profile = selectPrProfile({ changedFiles: [file], selectedJudges, selectedE2E });
      expect(profile.judges).toEqual([NAME]);
      expect(profile.deferredPromptFiles).toEqual([]);
      expect(profile.missingCoverage).toEqual([]);
      expect(profile.needsFullValidation).toBe(false);
    }
    expect(selectTests(['README.md'], LLM_JUDGE_TOUCHFILES).selected).not.toContain(NAME);
  });

  test('the managed callback sends and records exact custom input without borrowing a normal cache identity', async () => {
    const root = fixture();
    const input = buildCookieWorkflowJudgeInput(root);
    let scores = passingScore;
    const h = actualCookieCallback(root, { judge: async () => scores });
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].prompt).toBe(input.prompt);
    expect(h.requests[0].model).toBeUndefined();
    expect(h.requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(h.records[0]).toMatchObject({ name: NAME, prompt: input.prompt, model: 'fixture-model', execution: 'executed', passed: true });
    expect(existsSync(join(root, 'cache'))).toBe(false);
    const fresh = actualCookieCallback(root);
    await fresh.run();
    expect(fresh.requests).toHaveLength(1);
    for (const dimension of ['clarity', 'completeness', 'actionability'] as const) {
      scores = { ...COOKIE_WORKFLOW_JUDGE.thresholds, [dimension]: COOKIE_WORKFLOW_JUDGE.thresholds[dimension] - 1, reasoning: 'Synthetic failing fixture score' };
      await expect(h.run()).rejects.toThrow();
      expect(h.records.at(-1)).toMatchObject({ passed: false, exit_reason: 'validation_failed', prompt: input.prompt });
    }
    expect(existsSync(join(root, 'cache'))).toBe(false);
  });

  test('custom input timeout aborts once and a late response cannot overwrite its successful retry', async () => {
    const root = fixture();
    let completeLate!: (value: FixtureScore) => void;
    let calls = 0, now = 0, timerId = 0;
    const timers = new Map<number, () => void>();
    const h = actualCookieCallback(root, {
      budget: 20, clock: () => now,
      setTimer: ((callback: () => void) => { timers.set(++timerId, callback); return timerId; }) as any,
      clearTimer: ((id: number) => { timers.delete(id); }) as any,
      judge: async () => ++calls === 1 ? new Promise(resolve => { completeLate = resolve; }) : passingScore,
    });
    const expired = h.run().catch((error: Error) => error);
    now = 20;
    for (const callback of [...timers.values()]) callback();
    expect((await expired as Error).message).toContain('deadline');
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ passed: false, exit_reason: 'timeout', prompt: buildCookieWorkflowJudgeInput(root).prompt });
    expect(h.requests[0].signal.aborted).toBe(true);
    await h.run();
    expect(h.records.map(record => record.passed)).toEqual([false, true]);
    expect(h.attempts.get(NAME)?.attempt).toBe(2);
    completeLate(passingScore);
    await new Promise(resolve => setImmediate(resolve));
    expect(h.records).toHaveLength(2);
    expect(existsSync(join(root, 'cache'))).toBe(false);
  });

  test('a superseding custom-input attempt cancels its predecessor without stale recording', async () => {
    let completeLate!: (value: FixtureScore) => void;
    let calls = 0;
    const h = actualCookieCallback(fixture(), {
      judge: async () => ++calls === 1 ? new Promise(resolve => { completeLate = resolve; }) : passingScore,
    });
    const old = h.run().catch((error: Error) => error);
    await h.run();
    expect((await old as Error).name).toBe('WorkflowJudgeSuperseded');
    expect(h.requests[0].signal.aborted).toBe(true);
    completeLate(passingScore);
    await new Promise(resolve => setImmediate(resolve));
    expect(h.records.map(record => [record.passed, record.exit_reason])).toEqual([[false, 'cancelled'], [true, undefined]]);
  });
});
