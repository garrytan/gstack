/** Free checks for the bounded revalidation interface and native completion requirement. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createSharedInteractiveToolHandler, reviewPrompt, reviewRevalidationPrompt,
  SHARED_INTERACTIVE_MAX_TURNS, SHARED_LIBS_ROOT, type SharedLibsFixture,
} from './helpers/shared-libs-eval-fixture';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';

const f = { root: '/fixture root', repo: '/fixture root/repo', state: '/fixture root/state',
  bin: '/fixture root/bin' } as SharedLibsFixture;
const instructions = path.join(f.root, 'review-lifecycle.md');
const input = path.join(f.root, 'current-advisory.jsonl');
const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs.test.ts'), 'utf8');
const helper = fs.readFileSync(path.join(import.meta.dir, 'helpers/shared-libs-eval-fixture.ts'), 'utf8');
const native = JSON.parse(fs.readFileSync(path.join(import.meta.dir,
  'fixtures/shared-libs-revalidation-max-turns-public.json'), 'utf8'));
const pathsNative = JSON.parse(fs.readFileSync(path.join(import.meta.dir,
  'fixtures/shared-libs-paths-max-turns-public.json'), 'utf8'));
const pathsSource = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-shared-libs-paths.test.ts'), 'utf8');
const transpile = (text: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(text);

function pathCaptureAdapter(capture: (...args: any[]) => Promise<any>) {
  const start = pathsSource.indexOf('async function exerciseEligibility(');
  const end = pathsSource.indexOf('\ndescribeE2E(', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const rows: { scenario: string; row: any }[] = [];
  const removed: string[] = [];
  const attempts: any[] = [];
  const fixtures = new Map<string, SharedLibsFixture>();
  const afterCompletion = () => { throw new Error('A non-success capture reached completion checks'); };
  const exercise = new Function('deps', `const { captures, preparePathEligibilityFixture, fs, path,
    reviewLifecycleInstructions, reviewPrompt, reviewRevalidationPrompt, runSharedInteractive, readRequests,
    toolCommandTrace, sourceReadTrace, fixtureWorkingTree, reviewRecords, expect, CAPTURE_LONG_MS } = deps;
    ${transpile(pathsSource.slice(start, end))} return exerciseEligibility;`)({
    captures: { runAttempt: async (name: string, kinds: string[], timeout: number, work: any) => {
      attempts.push({ name, kinds, timeout });
      return work({ add: (scenario: string, row: any) => rows.push({ scenario, row }) });
    } },
    preparePathEligibilityFixture: (kind: string) => {
      const root = path.join('/fixture root', kind);
      const fixture = { root, repo: path.join(root, 'repo'), state: path.join(root, 'state'),
        bin: path.join(root, 'bin') } as SharedLibsFixture;
      fixtures.set(kind, fixture);
      return { fixture, current: { evidence_paths: ['src/retry-route.ts'] } };
    },
    fs: { readFileSync: () => 'authored caller', writeFileSync: () => {},
      rmSync: (root: string) => { removed.push(root); } }, path,
    reviewLifecycleInstructions: (fixture: SharedLibsFixture) => path.join(fixture.root, 'review-lifecycle.md'),
    reviewPrompt, reviewRevalidationPrompt, runSharedInteractive: capture, readRequests: () => [],
    toolCommandTrace: afterCompletion, sourceReadTrace: afterCompletion,
    fixtureWorkingTree: afterCompletion, reviewRecords: afterCompletion, expect, CAPTURE_LONG_MS,
  });
  return { exercise, rows, removed, attempts, fixtures };
}

describe('bounded shared-code revalidation prompt', () => {
  test('adds execution guidance after the complete shared prompt without supplying an answer or token', () => {
    const base = reviewPrompt(f, instructions, input);
    const prompt = reviewRevalidationPrompt(f, instructions, input);
    expect(prompt.slice(0, base.length)).toBe(base);
    const contract = prompt.slice(base.length);
    expect(contract).toContain(`${SHARED_INTERACTIVE_MAX_TURNS} assistant turns`);
    expect(contract).toContain(path.join(f.state, 'projects/fixture-shared-libs/.review-starts/<REVIEW_START>.json'));
    expect(contract).toContain('token actually returned by --start');
    expect(contract).not.toMatch(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/);
    expect(contract).toContain('Batch independent required source reads');
    expect(contract).toContain('Preserve every required evidence check and dependency');
    expect(contract).toContain('complete, untruncated read-back');
    expect(contract).toContain('same tool invocation');
    expect(contract).toContain('then return the final review summary');
    expect(contract).toContain('Failed persistence or verification remains a failure');
    expect(contract).toContain("Late source changes still require the workflow's normal re-review");
    expect(contract).not.toContain('choose Skip');
  });

  test('the actual revalidation capture uses the wrapper and preserves the skip actor', async () => {
    const scenario = source.slice(source.indexOf("test('shared-libs-review-revalidation'"));
    const marker = "'shared-libs-review-revalidation', async () => {";
    const start = scenario.indexOf(marker) + marker.length;
    const end = scenario.indexOf('}, result => {', start);
    expect(start).toBeGreaterThan(marker.length);
    expect(end).toBeGreaterThan(start);
    const result = { exitReason: 'success' };
    const calls: any[] = [];
    const callback = transpile(`async function invokeCapture() { ${scenario.slice(start, end)} }`);
    const invoke = new Function('deps', `const { f, instructions, input, reviewRevalidationPrompt, runSharedInteractive } = deps;
      let questions = []; ${callback} return invokeCapture;`)({
      f, instructions, input, reviewRevalidationPrompt,
      runSharedInteractive: async (...args: any[]) => { calls.push(args); return { result, questions: [] }; },
    });
    expect(await invoke()).toBe(result);
    expect(calls).toEqual([[f, 'shared-libs-review-revalidation', reviewRevalidationPrompt(f, instructions, input), 'skip']]);
    const lifecycle = source.slice(source.indexOf("test('shared-libs-review-lifecycle'"), source.indexOf("test('shared-libs-review-revalidation'"));
    expect(lifecycle).toContain('reviewPrompt(f, instructions, input)');
    expect(lifecycle).not.toContain('reviewRevalidationPrompt(');
  });

  test('the actual interactive runner uses the declared existing limit without changing clocks or actor', async () => {
    const start = helper.indexOf('export async function runSharedInteractive(');
    expect(start).toBeGreaterThan(0);
    let body = helper.slice(start).replace('export async function', 'async function');
    for (const [module, replacement] of [
      ['./agent-sdk-runner', 'deps.sdk'], ['@anthropic-ai/claude-agent-sdk', 'deps.provider'], ['./eval-budgets', 'deps.budgets'],
    ]) {
      expect(body).toContain(`await import('${module}')`);
      body = body.replace(`await import('${module}')`, replacement);
    }
    let observed: any;
    let shimCalls = 0;
    const invoke = new Function('deps', `const { fs, path, SHARED_LIBS_ROOT, SHARED_INTERACTIVE_MAX_TURNS,
      createSharedInteractiveToolHandler, installSourceShims, readRequests } = deps;
      ${transpile(body)} return runSharedInteractive;`)({
      fs, path, SHARED_LIBS_ROOT, SHARED_INTERACTIVE_MAX_TURNS, createSharedInteractiveToolHandler,
      installSourceShims: (fixture: SharedLibsFixture) => { expect(fixture).toBe(f); shimCalls++; },
      readRequests: () => [], budgets: { CAPTURE_MS },
      sdk: { runAgentSdkTest: async (options: any) => { observed = options; return { exitReason: 'success' }; },
        passThroughNonAskUserQuestion: (_name: string, value: unknown) => ({ behavior: 'allow', updatedInput: value }),
        resolveClaudeBinary: () => '/fixture/claude' },
      provider: { query: () => { throw new Error('No provider may run in this free adapter'); } },
    });
    await invoke(f, 'shared-libs-review-revalidation', 'prompt', 'skip');
    expect(shimCalls).toBe(1);
    expect(observed.maxTurns).toBe(SHARED_INTERACTIVE_MAX_TURNS);
    expect(observed.maxTurns).toBe(30);
    expect(observed.maxRetries).toBe(0);
    expect(observed.model).toBeUndefined();
    expect(observed.allowedTools).toContain('AskUserQuestion');
    expect(CAPTURE_MS).toBe(300_000);
    expect(CAPTURE_LONG_MS).toBe(600_000);
  });

  test('actual recordCapture rejects native max-turns even after verified CURRENT persistence', async () => {
    const persisted = JSON.parse('{' + native.events.at(-1).message.content[0].content);
    expect(persisted.completed).toBe(true);
    expect(persisted.converged).toBe(true);
    expect(persisted.review_binding.state).toBe('verified');
    expect(persisted.review_freshness.status).toBe('CURRENT');
    expect(native.terminal.subtype).toBe('error_max_turns');
    const start = source.indexOf('async function recordCapture(');
    const end = source.indexOf('\nfunction assertReadOnly(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const recordCapture = new Function('expect', `${transpile(source.slice(start, end))} return recordCapture;`)(expect);
    const rows: any[] = [];
    let verified = false;
    const result = { exitReason: native.terminal.subtype, turnsUsed: native.terminal.num_turns,
      durationMs: native.terminal.duration_ms, events: [...native.events, native.terminal],
      toolCalls: native.events.filter((event: any) => event.type === 'assistant')
        .flatMap((event: any) => event.message.content.map((block: any) => ({ tool: block.name, input: block.input }))) };
    await expect(recordCapture({ add: (scenario: string, row: any) => rows.push({ scenario, row }) }, 'secondary',
      'shared-libs-review-revalidation', async () => result, () => { verified = true; })).rejects.toThrow();
    expect(verified).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0].row.passed).toBe(false);
    expect(rows[0].row.exit_reason).toBe('error_max_turns');
    expect(rows[0].row.turns_used).toBe(31);
    expect(rows[0].row.transcript).toContainEqual(native.terminal);
    expect(rows[0].row.transcript).toContainEqual(native.events.at(-1));
  });

  test.each([
    ['shared-libs-review-path-eligibility', ['symlinks', 'submodule', 'ignored']],
    ['shared-libs-review-index-flags', ['assume-unchanged', 'skip-worktree']],
    ['shared-libs-review-prior-coverage', ['legacy', 'removed-filter']],
  ] as const)('the actual %s callback supplies the existing bounded interface to every scenario', async (name, kinds) => {
    const calls: any[][] = [];
    const adapter = pathCaptureAdapter(async (...args: any[]) => {
      calls.push(args);
      throw new Error('Free capture boundary reached');
    });
    await expect(adapter.exercise(name, [...kinds])).rejects.toThrow('Free capture boundary reached');
    expect(adapter.attempts).toEqual([{ name, kinds: [...kinds], timeout: CAPTURE_LONG_MS }]);
    expect(calls).toHaveLength(kinds.length);
    for (const kind of kinds) {
      const fixture = adapter.fixtures.get(kind)!;
      const expected = reviewRevalidationPrompt(fixture, path.join(fixture.root, 'review-lifecycle.md'),
        path.join(fixture.root, 'current-advisory.jsonl'))
        + '\nAll named caller sources are first-party authored runtime code. Inspect them directly, including any Git/path boundary, before deciding whether the previous review decision can be reused. The fixture contains no generated caller sources.';
      expect(calls.find(call => call[0] === fixture)).toEqual([fixture, name, expected, 'skip']);
      expect(adapter.rows.find(row => row.scenario === kind)?.row.passed).toBe(false);
      expect(adapter.removed).toContain(fixture.root);
    }
  });

  test('the actual path callback rejects max-turns after a correctly answered native Skip', async () => {
    const question = pathsNative.events[0].message.content[0];
    const answer = pathsNative.events[1].message.content[0];
    expect(question.name).toBe('AskUserQuestion');
    expect(answer.tool_use_id).toBe(question.id);
    expect(answer.is_error).not.toBe(true);
    expect(answer.content).toContain('="Skip".');
    expect(pathsNative.terminal).toMatchObject({ subtype: 'error_max_turns', is_error: true, num_turns: 31 });
    const questions: any[] = [];
    const answers: any[] = [];
    const adapter = pathCaptureAdapter(async (_fixture, _name, _prompt, choose) => {
      const permission = createSharedInteractiveToolHandler(choose, {
        nonQuestion: () => { throw new Error('Only the captured native question is expected'); },
        onQuestion: input => { questions.push(input); },
        onAnswer: (_input, values) => { answers.push(values); },
      });
      const decision = await permission(question.name, question.input);
      expect(decision).toEqual({ behavior: 'allow', updatedInput: { ...question.input,
        answers: { [question.input.questions[0].question]: 'Skip' } } });
      return { questions, result: { exitReason: pathsNative.terminal.subtype,
        turnsUsed: pathsNative.terminal.num_turns, durationMs: pathsNative.terminal.duration_ms,
        costUsd: pathsNative.terminal.total_cost_usd, costKnown: true,
        events: [...pathsNative.events, pathsNative.terminal],
        toolCalls: [{ tool: question.name, input: question.input }], output: '' } };
    });
    await expect(adapter.exercise('shared-libs-review-index-flags', ['skip-worktree'])).rejects.toThrow('error_max_turns');
    expect(answers).toEqual([{ [question.input.questions[0].question]: 'Skip' }]);
    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0]).toMatchObject({ scenario: 'skip-worktree', row: {
      passed: false, exit_reason: 'error_max_turns', turns_used: 31,
    } });
    expect(adapter.rows[0].row.transcript).toContainEqual(pathsNative.terminal);
    expect(adapter.rows[0].row.transcript).toContainEqual(pathsNative.events[1]);
    expect(adapter.removed).toEqual([adapter.fixtures.get('skip-worktree')!.root]);
  });
});
