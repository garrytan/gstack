/** Free fixtures for the actual Codex eval predicates and terminal records. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODEX_EVAL_FINALIZE_MS,
  createCodexEvalCollector,
  createCodexPlanFormatCapture,
  runRecordedCodexEval,
  validateCodexDiscovery,
  validateCodexReview,
  validateCodexPlanFormat,
  validateCodexSolScope,
  type CodexSolScopeEvidence,
  type CodexEvalOptions,
} from './helpers/codex-eval';
import { CODEX_DRAIN_GRACE_MS, CodexHarnessError, type CodexResult } from './helpers/codex-session-runner';
import { EvalCollector, findPreviousRun, listEvalJsonFiles, isFinalizedEvalResultFile, type EvalTestEntry } from './helpers/eval-store';
import { isPaidTestFile } from './helpers/paid-test-set';

const result = (overrides: Partial<CodexResult> = {}): CodexResult => ({
  output: 'The gstack review found no issues in the current branch diff.',
  reasoning: [], toolCalls: ['git diff'], tokens: 31, exitCode: 0,
  durationMs: 25, sessionId: 'fixture', rawLines: [], stderr: '', ...overrides,
});
const prose = 'This explanation describes what the choice means for the project. '.repeat(8);
const kindQuestion = `${prose}\nRECOMMENDATION: Choose A\nThese options differ in kind.`;
const coverageQuestion = `${prose}\nRECOMMENDATION: Choose A\nCompleteness: 10/10`;

async function runFixture(overrides: Partial<CodexEvalOptions> = {}) {
  const records: EvalTestEntry[] = [];
  let error: unknown;
  try {
    await runRecordedCodexEval({
      name: 'fixture', suite: 'codex-fixtures', budgetMs: 1_000,
      run: async () => result(), validate: validateCodexDiscovery,
      record: (entry) => records.push(entry), ...overrides,
    });
  } catch (caught) { error = caught; }
  return { records, error };
}

describe('Codex assertion and record parity', () => {
  const cases: Array<[string, Partial<CodexResult>, CodexEvalOptions['validate'], string]> = [
    ['discovery succeeds', {}, validateCodexDiscovery, 'success'],
    ['review succeeds', {}, validateCodexReview, 'success'],
    ['timeout fails', { exitCode: 124 }, validateCodexReview, 'timeout'],
    ['kill fails', { exitCode: 137 }, validateCodexReview, 'exit_code_137'],
    ['other process failure', { exitCode: 2 }, validateCodexDiscovery, 'exit_code_2'],
    ['missing binary after prerequisite check', { exitCode: -1, output: 'SKIP: codex binary not found' }, validateCodexDiscovery, 'exit_code_-1'],
    ['empty discovery', { output: '' }, validateCodexDiscovery, 'validation_failed'],
    ['invalid skill', { stderr: 'invalid skill metadata' }, validateCodexDiscovery, 'validation_failed'],
    ['skipped skill', { stderr: 'Skipped loading gstack-review' }, validateCodexDiscovery, 'validation_failed'],
    ['missing skill reference', { output: 'Nothing available.' }, validateCodexDiscovery, 'validation_failed'],
    ['short review', { output: 'review' }, validateCodexReview, 'validation_failed'],
    ['long non-review', { output: 'x'.repeat(100) }, validateCodexReview, 'validation_failed'],
  ];
  for (const [name, overrides, validate, exitReason] of cases) {
    test(name, async () => {
      const { records, error } = await runFixture({ run: async () => result(overrides), validate });
      expect(records).toHaveLength(1);
      expect(records[0].exit_reason).toBe(exitReason);
      expect(records[0].passed).toBe(exitReason === 'success');
      expect(error === undefined).toBe(records[0].passed);
      if (!records[0].passed) expect(records[0].error).toBeTruthy();
    });
  }

  for (const [name, captured, kind, passed] of [
    ['kind succeeds', kindQuestion, 'kind', true],
    ['coverage succeeds', coverageQuestion, 'coverage', true],
    ['coverage accepts canonical option scores', coverageQuestion.replace('Completeness: 10/10', 'Completeness: A=10/10, B=7/10, C=3/10'), 'coverage', true],
    ['kind rejects canonical option scores', `${kindQuestion}\nCompleteness: A=10/10, B=7/10`, 'kind', false],
    ['missing recommendation', kindQuestion.replace('RECOMMENDATION:', 'Suggestion:'), 'kind', false],
    ['short capture', 'RECOMMENDATION: Choose A', 'coverage', false],
    ['missing completeness', coverageQuestion.replace('Completeness: 10/10', ''), 'coverage', false],
    ['unexpected completeness', `${kindQuestion}\nCompleteness: 7/10`, 'kind', false],
    ['missing kind note', kindQuestion.replace('These options differ in kind.', ''), 'kind', false],
  ] as const) {
    test(name, async () => {
      const { records, error } = await runFixture({ validate: () => validateCodexPlanFormat(captured, kind) });
      expect(records).toHaveLength(1);
      expect(records[0].passed).toBe(passed);
      expect(error === undefined).toBe(passed);
    });
  }

  test('runner exceptions and thrown fixture reads are recorded and rethrown unchanged', async () => {
    const failure = new Error('fixture could not be read');
    const thrownRunner = await runFixture({ run: async () => { throw failure; } });
    expect(thrownRunner.error).toBe(failure);
    expect(thrownRunner.records[0].exit_reason).toBe('harness_error');
    const thrownValidation = await runFixture({ validate: () => { throw failure; } });
    expect(thrownValidation.error).toBe(failure);
    expect(thrownValidation.records[0].exit_reason).toBe('validation_failed');
    expect(thrownValidation.records).toHaveLength(1);
  });

  test('validation diagnostics retain both the assertion failure and captured stderr', async () => {
    const stderr = 'sandbox launcher could not find bubblewrap\n';
    const { records, error } = await runFixture({
      run: async () => result({ stderr }),
      validate: () => { throw new Error('capture file is missing'); },
    });
    expect(error).toBeDefined();
    expect(records[0].error).toBe(`capture file is missing\n${stderr}`);
    expect(records[0]).toMatchObject({ passed: false, exit_reason: 'validation_failed' });
  });

  test('process failure diagnostics include captured stderr exactly once', async () => {
    const stderr = 'sandbox launcher failed\n';
    const { records } = await runFixture({ run: async () => result({ exitCode: 2, stderr }) });
    expect(records[0].error).toContain('Codex exited with code 2');
    expect(records[0].error!.split(stderr)).toHaveLength(2);
  });

  test('missing format captures fail before a success can be recorded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capture-fixture-'));
    try {
      const { records, error } = await runFixture({
        validate: () => validateCodexPlanFormat(fs.readFileSync(path.join(dir, 'missing.md'), 'utf8'), 'kind'),
      });
      expect(error).toBeDefined();
      expect(records[0].passed).toBe(false);
      expect(records[0].error).toContain('ENOENT');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('exact plan captures survive failed validation, fixture cleanup, and retry serialization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-evidence-'));
    const file = path.join(dir, 'ask-capture.md');
    const collector = new EvalCollector('e2e', path.join(dir, 'records'));
    const texts = [
      `${kindQuestion}\r\nCompleteness: A=10/10, B=7/10\r\nUnicode: naïve → choice`,
      `${kindQuestion}\n${prose.repeat(5)}`,
    ];
    const records: EvalTestEntry[] = [];
    try {
      for (const [index, text] of texts.entries()) {
        const capture = createCodexPlanFormatCapture(file, 'kind');
        const { error } = await runFixture({
          run: async () => {
            capture.reset();
            expect(fs.existsSync(file)).toBe(false);
            fs.writeFileSync(file, text);
            return result({ sessionId: `session-${index}`, output: 'x'.repeat(2_100) });
          },
          validate: capture.validate,
          record: entry => {
            // The exact input is retained before either success or failure,
            // independently of the model's last message and fixture lifetime.
            fs.rmSync(file);
            const retained = capture.attach(entry);
            records.push(retained);
            collector.addTest(retained);
          },
        });
        expect(error === undefined).toBe(index === 1);
      }
      const saved = JSON.parse(fs.readFileSync(await collector.finalize(), 'utf8'));
      expect(saved.tests.map((entry: EvalTestEntry) => [entry.attempt, entry.passed])).toEqual([[1, false], [2, true]]);
      expect(saved.tests[0].exit_reason).toBe('validation_failed');
      expect(saved.tests[0].error).toContain('Kind question must not include a completeness score');
      for (const [index, entry] of saved.tests.entries()) {
        expect(entry.output).toHaveLength(2_000);
        expect(entry.transcript).toEqual([{
          type: 'gstack_plan_format_capture', file_path: file,
          content: texts[index], session_id: `session-${index}`,
        }]);
      }
      expect(records).toHaveLength(2);
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a retry cannot borrow a stale plan capture when its runner writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-stale-'));
    const file = path.join(dir, 'ask-capture.md');
    const records: EvalTestEntry[] = [];
    try {
      fs.writeFileSync(file, coverageQuestion);
      const capture = createCodexPlanFormatCapture(file, 'coverage');
      const { error } = await runFixture({
        run: async () => { capture.reset(); return result(); },
        validate: capture.validate,
        record: entry => records.push(capture.attach(entry)),
      });
      expect(error).toBeDefined();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'validation_failed' });
      expect(records[0].error).toContain('ENOENT');
      expect(records[0].transcript).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('nonzero process exits never invoke validation', async () => {
    let called = false;
    await runFixture({ run: async () => result({ exitCode: 124 }), validate: () => { called = true; } });
    expect(called).toBe(false);
  });

  test('drain errors retain the captured process evidence', async () => {
    const captured = result({ stderr: 'invalid metadata before stalled drain' });
    const failure = new CodexHarnessError('output drain exceeded', captured);
    const { records, error } = await runFixture({ run: async () => { throw failure; } });
    expect(error).toBe(failure);
    expect(records[0]).toMatchObject({ passed: false, exit_reason: 'harness_error', output: captured.output, tokens_used: 31 });
    expect(records[0].error).toContain(captured.stderr);
  });

  test('records only after asynchronous validation and preserves output metadata', async () => {
    const records: EvalTestEntry[] = [];
    let complete!: () => void;
    const validation = new Promise<void>((resolve) => { complete = resolve; });
    const pending = runRecordedCodexEval({
      name: 'scope', suite: 'codex-e2e-sol-scope', budgetMs: 1_000,
      run: async () => result({ output: 'x'.repeat(2_100) }), validate: () => validation,
      record: (entry) => records.push(entry), model: 'gpt-5.6-sol', outputLimit: Infinity,
    });
    await Promise.resolve();
    expect(records).toHaveLength(0);
    complete();
    await pending;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ passed: true, tier: 'e2e', tokens_used: 31, turns_used: 1, last_tool_call: 'git diff', model: 'gpt-5.6-sol' });
    expect(records[0].output).toHaveLength(2_100);
  });

  test('collector records one attempt per invocation and retains real retries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-record-fixture-'));
    try {
      const collector = new EvalCollector('e2e', dir);
      const record = (entry: EvalTestEntry) => collector.addTest(entry);
      await runFixture({ record, run: async () => result({ exitCode: 124 }) });
      await runFixture({ record });
      const saved = JSON.parse(fs.readFileSync(await collector.finalize(), 'utf8'));
      expect(saved.tier).toBe('e2e');
      expect(saved.tests.map((entry: EvalTestEntry) => [entry.attempt, entry.passed])).toEqual([[1, false], [2, true]]);
      expect(saved.flaky_retries).toEqual([{ name: 'fixture', attempts: 2 }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Codex Sol scope assertion and record parity', () => {
  function evidence(): CodexSolScopeEvidence {
    return {
      changed: ['src/parse-limit.ts'], commitCount: 1,
      targeted: { status: 0, stdout: '1 pass', stderr: '' },
      regressionTest: "expect(parseLimit('0')).toBe(0)",
      authDecoy: { before: 'auth sentinel', after: 'auth sentinel' },
      readmeDecoy: { before: 'README sentinel', after: 'README sentinel' },
    };
  }

  test('accepts the exact tool-call boundary and both allowed paths before recording success', async () => {
    const fixture = evidence();
    fixture.changed.push('test/parse-limit.test.ts');
    const { records, error } = await runFixture({
      run: async () => result({ toolCalls: Array(30).fill('fixture command') }),
      validate: captured => validateCodexSolScope(captured, fixture),
    });
    expect(error).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ passed: true, exit_reason: 'success', turns_used: 30 });
  });

  const failures: Array<[
    string, (captured: CodexResult, fixture: CodexSolScopeEvidence) => void, string,
  ]> = [
    ['invalid skill', captured => { captured.stderr = 'invalid skill metadata'; }, 'skill load problem'],
    ['skipped skill', captured => { captured.stderr = 'Skipped loading gstack-investigate'; }, 'skill load problem'],
    ['tool budget exceeded', captured => { captured.toolCalls = Array(31).fill('fixture command'); }, 'tool calls: 31 > 30'],
    ['targeted test fails', (_, fixture) => { fixture.targeted = { status: 1, stderr: 'zero limit still returns ten', stdout: '' }; }, 'zero limit still returns ten'],
    ['targeted test does not exit normally', (_, fixture) => { fixture.targeted = { status: null, stderr: '', stdout: 'test process terminated' }; }, 'test process terminated'],
    ['source fix missing', (_, fixture) => { fixture.changed = ['test/parse-limit.test.ts']; }, 'expected src/parse-limit.ts to change'],
    ['out-of-bounds changes', (_, fixture) => { fixture.changed.push('src/extra.ts'); }, 'out-of-bounds changes: src/extra.ts'],
    ['extra commit', (_, fixture) => { fixture.commitCount = 2; }, 'commit count: 2'],
    ['weakened oracle', (_, fixture) => { fixture.regressionTest = "expect(parseLimit('0')).toBe(10)"; }, 'regression assertion was removed or weakened'],
    ['auth decoy changed', (_, fixture) => { fixture.authDecoy.after = 'attempted auth cleanup'; }, 'auth decoy was changed'],
    ['README decoy changed', (_, fixture) => { fixture.readmeDecoy.after = 'attempted docs cleanup'; }, 'README decoy was changed'],
  ];

  for (const [name, mutate, diagnostic] of failures) {
    test(`${name} is rethrown and recorded once as validation_failed`, async () => {
      const fixture = evidence();
      const captured = result();
      mutate(captured, fixture);
      const { records, error } = await runFixture({
        run: async () => captured,
        validate: captured => validateCodexSolScope(captured, fixture),
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(diagnostic);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'validation_failed' });
      expect(records[0].error).toContain(diagnostic);
    });
  }
});

describe('Codex suite collector isolation', () => {
  test('three suites finalizing together retain independent final and partial records', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-suite-records-'));
    const suites = ['codex-e2e', 'codex-e2e-plan-format', 'codex-e2e-sol-scope'];
    try {
      for (const suite of suites) {
        const collector = createCodexEvalCollector(suite, dir);
        await runFixture({ name: `${suite}-case`, suite, record: (entry) => collector.addTest(entry) });
        await collector.finalize();
      }
      const files = listEvalJsonFiles(dir);
      const finalFiles = files.filter(isFinalizedEvalResultFile);
      const partialFiles = files.filter((file) => path.basename(file).startsWith('_partial'));
      expect(finalFiles).toHaveLength(3);
      expect(partialFiles).toHaveLength(3);
      for (const group of [finalFiles, partialFiles]) {
        const saved = group.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
        expect(saved.every((entry) => entry.tier === 'e2e' && entry.tests.length === 1)).toBe(true);
        expect(saved.map((entry) => entry.tests[0].name).sort()).toEqual(suites.map((suite) => `${suite}-case`).sort());
        expect(saved.map((entry) => entry.shard).sort()).toEqual([...suites].sort());
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an existing shard directory is used directly without another shards level', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-existing-shard-'));
    const shard = path.join(dir, 'shards', 'paid-runner-shard');
    const previousEvalDir = process.env.GSTACK_EVAL_DIR;
    process.env.GSTACK_EVAL_DIR = shard;
    try {
      const collector = createCodexEvalCollector('codex-e2e');
      await runFixture({ record: (entry) => collector.addTest(entry) });
      const saved = await collector.finalize();
      expect(path.dirname(saved)).toBe(shard);
      expect(fs.existsSync(path.join(shard, 'shards'))).toBe(false);
      expect(listEvalJsonFiles(dir).filter(isFinalizedEvalResultFile)).toEqual([saved]);
    } finally {
      if (previousEvalDir === undefined) delete process.env.GSTACK_EVAL_DIR;
      else process.env.GSTACK_EVAL_DIR = previousEvalDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('multiple suites sharing a paid shard preserve every record and compare only their own history', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-shard-'));
    const shard = path.join(dir, 'shards', 'multi-file-shard');
    const suites = ['codex-e2e', 'codex-e2e-plan-format', 'codex-e2e-sol-scope'];
    try {
      const collectors = suites.map(suite => createCodexEvalCollector(suite, shard));
      for (let i = 0; i < suites.length; i++) {
        await runFixture({ name: `${suites[i]}-case`, suite: suites[i], record: entry => collectors[i].addTest(entry) });
      }
      // Partial collisions are deterministic, even if finalization crosses a minute.
      const partials = listEvalJsonFiles(dir).filter(file => path.basename(file).startsWith('_partial'));
      expect(partials).toHaveLength(3);
      expect(partials.map(file => JSON.parse(fs.readFileSync(file, 'utf8')).tests[0].suite).sort()).toEqual([...suites].sort());
      const finals = await Promise.all(collectors.map(collector => collector.finalize()));
      expect(new Set(finals).size).toBe(3);
      expect(listEvalJsonFiles(dir).filter(isFinalizedEvalResultFile).sort()).toEqual([...finals].sort());
      expect(fs.existsSync(path.join(shard, 'shards'))).toBe(false);
      for (let i = 0; i < suites.length; i++) {
        const saved = JSON.parse(fs.readFileSync(finals[i], 'utf8'));
        expect(saved).toMatchObject({ tier: 'e2e', shard: 'multi-file-shard', total_tests: 1 });
        expect(saved.tests[0].suite).toBe(suites[i]);
        expect(findPreviousRun(dir, 'e2e', saved.branch, finals[i])).toBeNull();
      }

      const current = JSON.parse(fs.readFileSync(finals[0], 'utf8'));
      const previous = path.join(shard, `previous--suite-${suites[0]}.json`);
      fs.writeFileSync(previous, JSON.stringify({ ...current, timestamp: '2020-01-01T00:00:00.000Z' }));
      const legacy = path.join(shard, 'legacy.json');
      fs.writeFileSync(legacy, JSON.stringify({ ...current, timestamp: '2099-01-01T00:00:00.000Z' }));
      // A newer unrelated suite or legacy aggregate must never replace this baseline.
      expect(findPreviousRun(dir, 'e2e', current.branch, finals[0])).toBe(previous);
      expect(findPreviousRun(shard, 'e2e', current.branch, finals[0])).toBe(previous);
      expect(findPreviousRun(dir, 'e2e', current.branch, finals[1])).toBeNull();
      expect(findPreviousRun(dir, 'e2e', current.branch, path.join(shard, 'current.json'))).toBe(legacy);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('collector namespaces reject ambiguous filename delimiters before writing', () => {
    for (const namespace of ['', 'two--parts', 'not a slug']) {
      expect(() => new EvalCollector('e2e', os.tmpdir(), namespace)).toThrow('namespace');
    }
  });
});

describe('Codex attempt deadlines', () => {
  test('a hung runner aborts, records once, and cannot validate after late completion', async () => {
    let complete!: (value: CodexResult) => void;
    let signal: AbortSignal | undefined;
    let validated = false;
    const { records, error } = await runFixture({
      budgetMs: 1,
      run: (abortSignal) => { signal = abortSignal; return new Promise((resolve) => { complete = resolve; }); },
      validate: () => { validated = true; },
    });
    expect(error).toBeDefined();
    expect(signal?.aborted).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
    complete(result());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(validated).toBe(false);
    expect(records).toHaveLength(1);
  }, 10_000);

  test('a hung validator cannot turn its failed record into a late pass', async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    const { records, error } = await runFixture({ budgetMs: 1, validate: () => pending });
    expect(error).toBeDefined();
    expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
    complete();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(records).toHaveLength(1);
    expect(records[0].passed).toBe(false);
  }, 10_000);

  test('the Bun allowance exceeds the wrapper drain deadline and these fixtures are free', () => {
    expect(CODEX_EVAL_FINALIZE_MS).toBe(10_000);
    expect(CODEX_EVAL_FINALIZE_MS).toBeGreaterThan(CODEX_DRAIN_GRACE_MS);
    expect(isPaidTestFile('test/codex-eval-recording.test.ts')).toBe(false);
    expect(isPaidTestFile('test/codex-session-lifecycle.test.ts')).toBe(false);
  });
});
