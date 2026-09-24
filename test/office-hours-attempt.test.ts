/** Free recording fixtures; every runner and judge below is synthetic. */
import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OFFICE_HOURS_BUN_GRACE_MS, OFFICE_HOURS_RECORD_GRACE_MS, runRecordedOfficeHoursAttempt, type OfficeHoursAttemptOptions } from './helpers/office-hours-attempt';
import { EvalCollector, listEvalJsonFiles, isFinalizedEvalResultFile, type EvalTestEntry } from './helpers/eval-store';
import { runSkillTest, SESSION_DRAIN_GRACE_MS, type SkillTestResult } from './helpers/session-runner';
import { isPaidTestFile } from './helpers/paid-test-set';
import { spawnSync } from 'node:child_process';
import { Messages } from '@anthropic-ai/sdk/resources/messages';
import { judgePosture } from './helpers/llm-judge';

const ROOT = path.resolve(import.meta.dir, '..');
const result = (exitReason = 'success'): SkillTestResult => ({
  toolCalls: [{ tool: 'Write', input: { file_path: 'q3.md' }, output: 'ok' }],
  browseErrors: ['retained diagnostic'], exitReason, duration: 25,
  output: 'x'.repeat(2100),
  costEstimate: { inputChars: 10, outputChars: 2100, estimatedTokens: 528, estimatedCost: 0.12, turnsUsed: 2 },
  transcript: [{ type: 'fixture' }], model: 'claude-sonnet-4-6', firstResponseMs: 5, maxInterTurnMs: 10,
});

async function runFixture(overrides: Partial<OfficeHoursAttemptOptions> = {}) {
  const records: EvalTestEntry[] = [];
  const collector = new EvalCollector('e2e', os.tmpdir(), 'office-hours-unit');
  const recorder = spyOn(collector, 'addTest').mockImplementation(entry => { records.push(entry); });
  let caught: unknown;
  try {
    await runRecordedOfficeHoursAttempt({
      collector, name: '/fixture', suite: 'Office Hours Fixture', model: 'claude-sonnet-4-6',
      run: async () => result(),
      validate: captured => { expect(['success', 'error_max_turns']).toContain(captured.exitReason); },
      ...overrides,
    });
  } catch (error) { caught = error; }
  finally { recorder.mockRestore(); }
  return { records, caught };
}

describe('Office Hours complete attempt records', () => {
  for (const exitReason of ['success', 'error_max_turns']) {
    test(`accepts ${exitReason} with unchanged result metadata`, async () => {
      const { records, caught } = await runFixture({ run: async () => result(exitReason) });
      expect(caught).toBeUndefined();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        name: '/fixture', suite: 'Office Hours Fixture', tier: 'e2e', passed: true,
        duration_ms: 25, cost_usd: 0.12, transcript: [{ type: 'fixture' }], output: 'x'.repeat(2000),
        turns_used: 2, tokens_used: 528, browse_errors: ['retained diagnostic'], exit_reason: exitReason,
        timeout_at_turn: undefined, last_tool_call: 'Write({"file_path":"q3.md"})',
        model: 'claude-sonnet-4-6', first_response_ms: 5, max_inter_turn_ms: 10,
      });
    });
  }

  for (const exitReason of ['timeout', 'timeout_startup', 'exit_code_1']) {
    test(`records rejected runner outcome ${exitReason} once with its diagnostics`, async () => {
      const { records, caught } = await runFixture({ run: async () => result(exitReason) });
      expect(caught).toBeInstanceOf(Error);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: exitReason, cost_usd: 0.12 });
      expect(records[0].error).toContain(exitReason);
      expect(records[0].timeout_at_turn).toBe(exitReason === 'timeout' ? 2 : undefined);
    });
  }

  test('records assertion and judge exceptions once, preserving the thrown value', async () => {
    for (const failure of [new Error('posture assertion failed'), new Error('judge unavailable'), 'judge rejected', undefined]) {
      const { records, caught } = await runFixture({ validate: async () => { throw failure; } });
      expect(caught).toBe(failure);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'success', cost_usd: 0.12 });
      expect(records[0].error).toBe(failure instanceof Error ? failure.message : String(failure));
    }
  });

  test('records synchronous and asynchronous runner exceptions without inventing usage', async () => {
    const failure = new Error('runner unavailable');
    for (const run of [() => { throw failure; }, async () => { throw failure; }]) {
      const { records, caught } = await runFixture({ run, validate: () => { throw new Error('must not validate'); } });
      expect(caught).toBe(failure);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'harness_error', cost_usd: 0, model: 'claude-sonnet-4-6' });
      expect(records[0].error).toContain('runner unavailable');
      expect(records[0].error).toContain('cost and usage unavailable');
      expect(records[0].duration_ms).toBeGreaterThanOrEqual(0);
      expect(records[0].tokens_used).toBeUndefined();
      expect(records[0].transcript).toBeUndefined();
    }
  });

  test('does not record a pass while asynchronous validation is pending', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const collector = new EvalCollector('e2e', os.tmpdir(), 'office-hours-pending');
    const records: EvalTestEntry[] = [];
    const recorder = spyOn(collector, 'addTest').mockImplementation(entry => { records.push(entry); });
    try {
      const attempt = runRecordedOfficeHoursAttempt({
        collector, name: '/pending', suite: 'Office Hours Fixture', model: 'fixture',
        run: async () => result(), validate: () => pending,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(records).toEqual([]);
      release();
      expect(await attempt).toMatchObject({ exitReason: 'success' });
      expect(records).toHaveLength(1);
      expect(records[0].passed).toBe(true);
    } finally { release(); recorder.mockRestore(); }
  });

  test('a disabled collector still propagates validation failures', async () => {
    const failure = new Error('fixture failed');
    const { records, caught } = await runFixture({ collector: null, validate: () => { throw failure; } });
    expect(caught).toBe(failure);
    expect(records).toEqual([]);
  });
});

describe('Office Hours deadlines', () => {
  test('work and cleanup allowances stay separate from Bun finalization time', () => {
    expect(OFFICE_HOURS_RECORD_GRACE_MS).toBe(5_000);
    expect(OFFICE_HOURS_BUN_GRACE_MS).toBe(10_000);
    expect(SESSION_DRAIN_GRACE_MS).toBeLessThanOrEqual(OFFICE_HOURS_RECORD_GRACE_MS);
  });

  test('synchronous runner entry consumes the budget and never launches validation late', async () => {
    let validated = false;
    let signal: AbortSignal | undefined;
    const { records, caught } = await runFixture({
      budgetMs: 5,
      run: async abortSignal => {
        signal = abortSignal;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return result();
      },
      validate: () => { validated = true; },
    });
    expect(signal?.aborted).toBe(true);
    expect(validated).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout', cost_usd: 0.12 });
  });

  test('cancellation precedes recording, retains cleanup usage, and preserves a genuine process failure', async () => {
    for (const exitReason of ['success', 'exit_code_7']) {
      let validated = false;
      let cancelled = false;
      const { records } = await runFixture({
        budgetMs: 5,
        run: signal => new Promise(resolve => {
          signal.addEventListener('abort', () => {
            cancelled = true;
            setTimeout(() => resolve(result(exitReason)), 5);
          }, { once: true });
        }),
        validate: () => { validated = true; },
      });
      expect(cancelled).toBe(true);
      expect(validated).toBe(false);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        passed: false, cost_usd: 0.12, exit_reason: exitReason === 'success' ? 'timeout' : 'exit_code_7',
      });
    }
  });

  for (const stage of ['runner', 'judge'] as const) {
    test(`a non-cooperative ${stage} is bounded and late completion cannot change the record`, async () => {
      let complete!: () => void;
      let signal: AbortSignal | undefined;
      let validations = 0;
      const pending = new Promise<void>(resolve => { complete = resolve; });
      const started = Date.now();
      const { records } = await runFixture({
        budgetMs: 5,
        run: async abortSignal => {
          signal = abortSignal;
          if (stage === 'runner') await pending;
          return result();
        },
        validate: async () => { validations++; await pending; },
      });
      expect(Date.now() - started).toBeLessThan(OFFICE_HOURS_BUN_GRACE_MS);
      expect(signal?.aborted).toBe(true);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
      const saved = JSON.stringify(records);
      complete();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(JSON.stringify(records)).toBe(saved);
      expect(validations).toBe(stage === 'runner' ? 0 : 1);
    }, 10_000);
  }

  test('a synchronous validator crossing the deadline cannot claim a pass', async () => {
    const { records } = await runFixture({
      budgetMs: 5,
      validate: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
  });

  test('posture forwards cancellation to the existing request/retry helper without changing the rubric', async () => {
    const controller = new AbortController();
    const reason = new Error('posture deadline');
    const create = spyOn(Messages.prototype, 'create').mockImplementation((_body: unknown, opts: any) =>
      new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(reason), { once: true })) as any);
    try {
      const pending = judgePosture('forcing', 'fixture prose', controller.signal);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][1]).toEqual({ signal: controller.signal });
      expect(create.mock.calls[0][0].messages[0].content).toContain('stacking_preserved (1-5)');
      expect(create.mock.calls[0][0].messages[0].content).toContain('fixture prose');
      await expect(judgePosture('builder', 'do not dispatch', controller.signal)).rejects.toBe(reason);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { create.mockRestore(); }
  });
});

// POSIX fake executables (#!/bin/bash); never resolve the real provider CLI.
async function withProcessFixture(body: string, check: (dir: string, env: Record<string, string>) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hours-process-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash\necho $$ > "$FIXTURE_DIR/parent.pid"\n${body}\n`, { mode: 0o755 });
  try {
    await check(dir, { PATH: `${bin}:${process.env.PATH || ''}`, FIXTURE_DIR: dir });
  } finally {
    for (const file of ['parent.pid', 'child.pid']) {
      const pid = Number(fs.existsSync(path.join(dir, file)) && fs.readFileSync(path.join(dir, file), 'utf8').trim());
      if (pid > 0) {
        try { process.kill(file === 'parent.pid' ? -pid : pid, 'SIGKILL'); } catch {}
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function running(pid: number): boolean {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state.length > 0 && !state.startsWith('Z');
}

const successLine = JSON.stringify({ type: 'result', subtype: 'success', result: 'captured output', num_turns: 2, total_cost_usd: 0.12 });

describe('Office Hours real session runner with fake processes', () => {
  test('a spawn failure closes both pipes and retains its diagnostic', async () => {
    await withProcessFixture('exit 0', async (dir) => {
      const captured = await runSkillTest({
        prompt: 'fixture', workingDirectory: dir, timeout: 30_000, testName: 'missing-provider',
        env: { PATH: dir }, // This directory has no claude executable; no real provider can run.
      });
      expect(captured.exitReason).toBe('exit_code_1');
      expect(captured.duration).toBeLessThan(2_000);
      const diagnostic = JSON.parse(fs.readFileSync(path.join(dir, '.gstack/test-transcripts/missing-provider-failure.json'), 'utf8'));
      expect(diagnostic.stderr).toMatch(/ENOENT|Executable not found/);
      expect(diagnostic.stderr).toContain('claude');
    });
  });

  test('pre-abort and expired synchronous setup never spawn the provider', async () => {
    await withProcessFixture('exit 0', async (dir, env) => {
      const controller = new AbortController();
      const reason = new Error('already expired');
      controller.abort(reason);
      await expect(runSkillTest({ prompt: 'fixture', workingDirectory: dir, env, signal: controller.signal })).rejects.toBe(reason);
      const captured = await runSkillTest({
        prompt: 'fixture', workingDirectory: dir, timeout: 5,
        get env() {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          return env;
        },
      });
      expect(captured.exitReason).toBe('timeout_startup');
      expect(captured.duration).toBeGreaterThanOrEqual(20);
      expect(fs.existsSync(path.join(dir, 'parent.pid'))).toBe(false);
    });
  });

  test('abort kills the group, preserves captured usage, and cannot turn a success line into a pass', async () => {
    await withProcessFixture(`echo '${successLine}'\nsleep 60 &\necho $! > "$FIXTURE_DIR/child.pid"\nwait`, async (dir, env) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 200);
      try {
        const captured = await runSkillTest({ prompt: 'fixture', workingDirectory: dir, timeout: 30_000, env, signal: controller.signal });
        expect(captured.exitReason).toBe('timeout');
        expect(captured.output).toBe('captured output');
        expect(captured.costEstimate.estimatedCost).toBe(0.12);
        expect(captured.duration).toBeLessThan(5_000);
        for (const file of ['parent.pid', 'child.pid']) {
          expect(running(Number(fs.readFileSync(path.join(dir, file), 'utf8')))).toBe(false);
        }
      } finally { clearTimeout(timer); }
    });
  }, 10_000);

  for (const pipe of ['stdout', 'stderr'] as const) {
    test(`real failure survives ${pipe} held open after process exit and drain finishes within its allowance`, async () => {
      const redirect = pipe === 'stdout' ? '2>/dev/null' : '>/dev/null';
      await withProcessFixture(`echo '${successLine}'\necho 'fixture auth failure' >&2\nsleep 60 ${redirect} &\necho $! > "$FIXTURE_DIR/child.pid"\nexit 7`, async (dir, env) => {
        const captured = await runSkillTest({ prompt: 'fixture', workingDirectory: dir, timeout: 30_000, env, testName: 'drain' });
        expect(captured.exitReason).toBe('exit_code_7');
        expect(captured.duration).toBeLessThan(SESSION_DRAIN_GRACE_MS + 2_000);
        expect(captured.output).toBe('captured output');
        const diagnostic = JSON.parse(fs.readFileSync(path.join(dir, '.gstack/test-transcripts/drain-failure.json'), 'utf8'));
        expect(diagnostic.stderr).toContain('fixture auth failure');
        expect(running(Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8')))).toBe(false);
      });
    }, 10_000);
  }

  test('abort during a failed process drain preserves the independently observed exit', async () => {
    await withProcessFixture(`echo '${successLine}'\nsleep 60 &\necho $! > "$FIXTURE_DIR/child.pid"\nexit 7`, async (dir, env) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 200);
      try {
        const captured = await runSkillTest({ prompt: 'fixture', workingDirectory: dir, timeout: 30_000, env, signal: controller.signal });
        expect(captured.exitReason).toBe('exit_code_7');
        expect(captured.duration).toBeLessThan(2_000);
      } finally { clearTimeout(timer); }
    });
  }, 10_000);

  test('exit zero with an incomplete output drain is a failure, and clean exits keep success/max-turns results', async () => {
    await withProcessFixture(`echo '${successLine}'\nsleep 60 &\necho $! > "$FIXTURE_DIR/child.pid"\nexit 0`, async (dir, env) => {
      const captured = await runSkillTest({ prompt: 'fixture', workingDirectory: dir, timeout: 30_000, env });
      expect(captured.exitReason).toBe('error_output_drain');
      expect(captured.duration).toBeLessThan(SESSION_DRAIN_GRACE_MS + 2_000);
    });
    for (const subtype of ['success', 'error_max_turns']) {
      await withProcessFixture(`echo '${successLine.replace('"success"', JSON.stringify(subtype))}'\nexit 0`, async (dir, env) => {
        const captured = await runSkillTest({ prompt: 'fixture', workingDirectory: dir, env });
        expect(captured.exitReason).toBe(subtype);
        expect(captured.duration).toBeLessThan(2_000);
      });
    }
  }, 10_000);
});

// Re-run the actual paid test bodies in an isolated Bun process, replacing BOTH
// paid boundaries before importing them. Each scripted defect must fail once;
// only the last retry is valid, so weakening any oracle shortens the ledger.
const defects = {
  'office-hours-forcing-energy': ['runner', 'exit', 'missing', 'length', 'judge', 'axis_a', 'axis_b', 'pass'],
  'office-hours-builder-wildness': ['runner', 'exit', 'missing', 'length', 'judge', 'axis_a', 'axis_b', 'pass'],
  'office-hours-brain-writeback': ['runner', 'exit', 'missing', 'slug', 'payload', 'frontmatter', 'title', 'tags', 'length', 'pass'],
};

async function runSuiteFixture(mode: 'retry' | 'unselected' | 'disabled' | 'deadline') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hours-lifecycle-'));
  const evalDir = path.join(dir, 'evals');
  const script = path.join(dir, 'office-hours-fixture.test.ts');
  fs.writeFileSync(script, `
import { mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(ROOT)};
const defects = ${JSON.stringify(defects)};
const counts = {};
const current = {};
const signals = {};
const deadlineFixture = ${mode === 'deadline'};
if (deadlineFixture) mock.module(join(root, 'test/helpers/eval-budgets.ts'), () => ({ CAPTURE_MS: 300_000, CAPTURE_LONG_MS: 50 }));
mock.module(join(root, 'test/helpers/session-runner.ts'), () => ({
  runSkillTest: async (opts) => {
    const id = opts.testName;
    if (!(opts.signal instanceof AbortSignal) || opts.signal.aborted) throw new Error('missing/live runner signal');
    if (opts.timeout !== (id === 'office-hours-brain-writeback' ? (deadlineFixture ? 50 : 600_000) : 300_000)) throw new Error('model work budget changed');
    signals[id] = opts.signal;
    const attempt = counts[id] = (counts[id] || 0) + 1;
    const defect = deadlineFixture ? 'pass' : defects[id][attempt - 1];
    if (!defect) throw new Error('unexpected extra attempt');
    current[id] = defect;
    if (defect === 'runner') throw new Error('fixture runner unavailable');
    const dir = opts.workingDirectory;
    if (id === 'office-hours-brain-writeback') {
      if (deadlineFixture) return new Promise(resolve => opts.signal.addEventListener('abort', () => {
        resolve({ ...${JSON.stringify(result())}, exitReason: 'timeout' });
      }, { once: true }));
      if (defect !== 'missing' && defect !== 'exit') {
        writeFileSync(join(dir, 'gbrain-calls.log'), defect === 'slug' ? 'gbrain put wrong-slug' : 'gbrain put office-hours/pixel-fund');
      }
      if (!['missing', 'exit', 'slug', 'payload'].includes(defect)) {
        const fields = [defect === 'frontmatter' ? 'no header' : '---', defect === 'title' ? '' : 'title: Pixel fund', defect === 'tags' ? '' : 'tags: [fixture]', '---'];
        let payload = fields.join('\\n') + '\\n' + 'Design detail. '.repeat(25);
        if (defect === 'length') payload = payload.slice(0, 200);
        writeFileSync(join(dir, 'gbrain-payloads', 'pixel-fund.md'), payload);
      }
    } else if (defect !== 'missing' && defect !== 'exit') {
      const forcing = id.includes('forcing');
      writeFileSync(join(dir, forcing ? 'q3.md' : 'unlocks.md'), 'x'.repeat(defect === 'length' ? (forcing ? 80 : 200) : 300));
    }
    return { ...${JSON.stringify(result())}, exitReason: defect === 'exit' ? 'timeout' : 'error_max_turns' };
  },
}));
mock.module(join(root, 'test/helpers/llm-judge.ts'), () => ({
  judgeRecommendation: () => { throw new Error('unexpected judge'); },
  judgePosture: async (mode, text, signal) => {
    const id = mode === 'forcing' ? 'office-hours-forcing-energy' : 'office-hours-builder-wildness';
    if (signal !== signals[id] || signal.aborted) throw new Error('judge cancellation not connected');
    if (deadlineFixture) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const defect = current[id];
    if (defect === 'judge') throw new Error('fixture judge unavailable');
    return { axis_a: defect === 'axis_a' ? 3 : 4, axis_b: defect === 'axis_b' ? 3 : 4, reasoning: 'fixture' };
  },
}));
await import(join(root, 'test/skill-e2e-office-hours.test.ts'));
await import(join(root, 'test/skill-e2e-office-hours-brain-writeback.test.ts'));
`);
  try {
    const proc = Bun.spawn([process.execPath, 'test', '--retry', mode === 'deadline' ? '0' : '9', script], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
        EVALS: mode === 'disabled' ? '' : '1', EVALS_ALL: '', EVALS_TIER: 'periodic',
        EVALS_SELECTION_JSON: JSON.stringify({ selected: mode === 'unselected' ? [] : null, reason: 'free fixture' }),
        EVALS_PREFLIGHT_OK: '1', GSTACK_EVAL_DIR: evalDir, GSTACK_CLAUDE_CLI_VERSION: 'free fixture',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code, stdout + stderr).toBe(mode === 'deadline' ? 1 : 0);
    const files = listEvalJsonFiles(evalDir);
    return {
      finals: files.filter(isFinalizedEvalResultFile).map(file => JSON.parse(fs.readFileSync(file, 'utf8'))),
      partials: files.filter(file => path.basename(file).startsWith('_partial')).map(file => JSON.parse(fs.readFileSync(file, 'utf8'))),
      output: stdout + stderr,
    };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('Office Hours actual suite lifecycle with free stubs', () => {
  test('runner/judge deadlines finalize all three failed attempts before Bun can time out', async () => {
    const { finals, partials, output } = await runSuiteFixture('deadline');
    expect(finals).toHaveLength(2);
    expect(partials).toHaveLength(2);
    for (const group of [finals, partials]) {
      const entries = group.flatMap(saved => saved.tests);
      expect(entries).toHaveLength(3);
      expect(entries.every(entry => entry.passed === false && entry.exit_reason === 'timeout' && entry.attempt === 1)).toBe(true);
      expect(entries.every(entry => entry.error.includes('attempt exceeded 50ms'))).toBe(true);
    }
    expect(output).toContain('3 fail');
    expect(output).not.toContain('timed out after');
  }, 10_000);

  test('all original assertions and retry failures survive afterAll finalization in a shared directory', async () => {
    const { finals, partials } = await runSuiteFixture('retry');
    expect(finals).toHaveLength(2);
    expect(partials).toHaveLength(2);
    for (const group of [finals, partials]) {
      expect(group.every(saved => saved.tier === 'e2e')).toBe(true);
      const entries = group.flatMap(saved => saved.tests);
      expect(entries).toHaveLength(26);
      for (const [id, expected] of Object.entries(defects)) {
        const attempts = entries.filter(entry => entry.name === '/' + id);
        expect(attempts.map(entry => entry.attempt)).toEqual(expected.map((_, i) => i + 1));
        expect(attempts.map(entry => entry.passed)).toEqual(expected.map(defect => defect === 'pass'));
        expect(attempts.slice(0, -1).every(entry => typeof entry.error === 'string' && entry.error.length > 0)).toBe(true);
        expect(attempts.at(-1).exit_reason).toBe('error_max_turns');
      }
      expect(group.reduce((sum, saved) => sum + saved.passed, 0)).toBe(3);
      expect(group.reduce((sum, saved) => sum + saved.failed, 0)).toBe(23);
    }
    expect(finals.every(saved => !saved._partial)).toBe(true);
  }, 60_000);

  for (const mode of ['unselected', 'disabled'] as const) {
    test(`${mode} cases remain skips and create no attempts`, async () => {
      const { finals, partials, output } = await runSuiteFixture(mode);
      expect(finals).toHaveLength(mode === 'disabled' ? 0 : 2);
      expect(finals.every(saved => saved.total_tests === 0 && saved.passed === 0 && saved.failed === 0)).toBe(true);
      expect(partials).toEqual([]);
      for (const id of Object.keys(defects)) {
        expect(output.split('\n').some(line => line.startsWith('(skip)') && line.endsWith('> ' + id))).toBe(true);
      }
      expect(output).toContain('0 pass');
      expect(output).toContain('0 fail');
    }, 30_000);
  }

  test('this recording regression file belongs to the free suite', () => {
    expect(isPaidTestFile('test/office-hours-attempt.test.ts')).toBe(false);
  });
});

// Native Claude marks max-turn exhaustion is_error=true and exits 1. Keep
// the existing office-hours oracle without trusting success-shaped failures.
describe('session runner native CLI max-turns exit semantics', () => {
  const maxTurnsLine = JSON.stringify({
    type: 'result', subtype: 'error_max_turns', is_error: true,
    num_turns: 8, total_cost_usd: 0.12, errors: ['Reached maximum number of turns (8)'],
  });
  const cases = [
    { name: 'clean native max-turn exit', line: maxTurnsLine, end: 'exit 1', expected: 'error_max_turns' },
    { name: 'genuine exit 7', line: maxTurnsLine, end: 'exit 7', expected: 'exit_code_7' },
    { name: 'signal termination', line: maxTurnsLine, end: 'kill -TERM $$', expected: 'exit_code_143' },
    { name: 'max-turn label without is_error', line: maxTurnsLine.replace('"is_error":true', '"is_error":false'), end: 'exit 1', expected: 'exit_code_1' },
    { name: 'success-shaped exit 1', line: successLine, end: 'exit 1', expected: 'exit_code_1' },
    { name: 'success-shaped is_error exit 1', line: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'error' }), end: 'exit 1', expected: 'exit_code_1' },
  ];
  for (const { name, line, end, expected } of cases) {
    test(name, async () => {
      await withProcessFixture(`echo '${line}'\n${end}`, async (dir, env) => {
        const captured = await runSkillTest({ prompt: 'free fixture', workingDirectory: dir, timeout: 30_000, env });
        expect(captured.exitReason).toBe(expected);
        if (name === 'clean native max-turn exit') {
          expect(captured.costEstimate.turnsUsed).toBe(8);
          expect(captured.costEstimate.estimatedCost).toBe(0.12);
        }
      });
    });
  }
  for (const pipe of ['stdout', 'stderr'] as const) {
    test(`max-turn exit 1 with ${pipe} held open is not accepted`, async () => {
      const redirect = pipe === 'stdout' ? '2>/dev/null' : '>/dev/null';
      await withProcessFixture(`echo '${maxTurnsLine}'\nsleep 60 ${redirect} &\necho $! > "$FIXTURE_DIR/child.pid"\nexit 1`, async (dir, env) => {
        const captured = await runSkillTest({ prompt: 'free fixture', workingDirectory: dir, timeout: 30_000, env });
        expect(captured.exitReason).toBe('exit_code_1');
        expect(captured.duration).toBeLessThan(SESSION_DRAIN_GRACE_MS + 2_000);
      });
    }, 10_000);
  }
  test('abort during a max-turn exit 1 drain retains the process failure', async () => {
    await withProcessFixture(`echo '${maxTurnsLine}'\nsleep 60 &\necho $! > "$FIXTURE_DIR/child.pid"\nexit 1`, async (dir, env) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 200);
      try {
        const captured = await runSkillTest({ prompt: 'free fixture', workingDirectory: dir, timeout: 30_000, env, signal: controller.signal });
        expect(captured.exitReason).toBe('exit_code_1');
      } finally { clearTimeout(timer); }
    });
  });
  test('a timeout cannot be overwritten by a max-turn result line', async () => {
    await withProcessFixture(`echo '${maxTurnsLine}'\nexec sleep 60`, async (dir, env) => {
      const captured = await runSkillTest({ prompt: 'free fixture', workingDirectory: dir, timeout: 200, env });
      expect(captured.exitReason).toBe('timeout');
    });
  });
});

// Exercise the real format registrations and recommendation helper. Only the
// native capture and SDK request boundaries are fake; no provider is reachable.
const FORMAT_CASES = [
  ['skill-e2e-plan-format.test.ts', 'plan-ceo-review-format-mode'],
  ['skill-e2e-plan-format.test.ts', 'plan-ceo-review-format-approach'],
  ['skill-e2e-plan-format.test.ts', 'plan-eng-review-format-coverage'],
  ['skill-e2e-plan-format.test.ts', 'plan-eng-review-format-kind'],
  ['skill-e2e-plan-prosons.test.ts', 'plan-review-prosons-format'],
  ['skill-e2e-plan-prosons.test.ts', 'plan-review-prosons-hardstop-neg'],
  ['skill-e2e-plan-prosons.test.ts', 'plan-review-prosons-neutral-neg'],
  ['skill-e2e-plan-prosons.test.ts', 'plan-ceo-review-prosons-cadence'],
] as const;

async function runFormatLifecycle(file: string, id: string, scenario: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-finalization-'));
  const evalDir = path.join(dir, 'evals');
  const facts = path.join(dir, 'events.jsonl');
  const script = path.join(dir, 'format.test.ts');
  fs.writeFileSync(script, `
import { mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(ROOT)}, selected = ${JSON.stringify(id)}, scenario = ${JSON.stringify(scenario)};
const event = value => fs.appendFileSync(${JSON.stringify(facts)}, JSON.stringify(value) + '\\n');
let attempt = 0;
let currentSignal;
mock.module(path.join(root, 'test/helpers/eval-budgets.ts'), () => ({ CAPTURE_MS: 300, CAPTURE_LONG_MS: 600 }));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({
  SESSION_DRAIN_GRACE_MS: 50,
  runSkillTest: async opts => {
    const id = ++attempt;
    currentSignal = opts.signal;
    event({ kind: 'start', id, timeout: opts.timeout, maxTurns: opts.maxTurns, model: opts.model, cwd: opts.workingDirectory });
    opts.signal?.addEventListener('abort', () => event({ kind: 'abort', id }), { once: true });
    const timeout = scenario === 'both-timeout' || (scenario === 'recover' && id === 1);
    await new Promise(resolve => setTimeout(resolve, timeout ? opts.timeout + 50 : scenario === 'late-judge' || scenario === 'near-success' ? 220 : 20));
    event({ kind: 'ready', id, fixtureExists: fs.existsSync(opts.workingDirectory) });
    if (!timeout) {
      const kind = selected.endsWith('-mode') || selected.endsWith('-kind');
      const text = scenario === 'bad-format' ? 'invalid' :
        'D1 — Fixture decision\\nELI10: Pick the complete contract.\\nStakes if we pick wrong: users lose updates.\\n' +
        'Recommendation: A because the indexed contract preserves deterministic outcomes.\\n' +
        (kind ? 'Note: options differ in kind, not coverage.\\n' : 'Completeness: A=10/10, B=7/10\\n') +
        'Pros/cons:\\nA) Complete (recommended)\\n✅ Retains all outcomes\\n✅ Preserves ordering\\n❌ More work\\n' +
        'B) Partial\\n✅ Less work\\n✅ Smaller diff\\n❌ Drops outcomes\\nNet: completeness versus implementation effort.\\n';
      fs.writeFileSync(path.join(opts.workingDirectory, 'ask-capture.md'), text);
    }
    return { exitReason: timeout ? 'timeout' : 'success', duration: timeout ? opts.timeout : 220,
      model: opts.model, toolCalls: [], browseErrors: [], output: 'x'.repeat(2100),
      transcript: [{ type: 'fixture', attempt: id }], firstResponseMs: 5, maxInterTurnMs: 10,
      costEstimate: { estimatedCost: 0.12, estimatedTokens: 528, turnsUsed: 2 } };
  },
}));
const fakeJudgeRequest = async (body, options) => {
  event({ kind: 'judge-start', id: attempt, sameSignal: options?.signal === currentSignal, model: body.model });
  const id = attempt;
  await new Promise(resolve => setTimeout(resolve, scenario === 'late-judge' ? 130 : 10));
  event({ kind: 'judge-ready', id, aborted: options?.signal?.aborted ?? false });
  return { content: [{ type: 'text', text: JSON.stringify({ reason_substance: scenario === 'bad-score' ? 3 : 5, reasoning: 'fixture specific tradeoff' }) }] };
};
mock.module('@anthropic-ai/sdk', () => ({ default: class { messages = { create: fakeJudgeRequest }; } }));
globalThis.fetch = () => { throw new Error('No network is permitted in this free lifecycle fixture'); };
const { EvalCollector } = await import(path.join(root, 'test/helpers/eval-store.ts'));
const addTest = EvalCollector.prototype.addTest;
spyOn(EvalCollector.prototype, 'addTest').mockImplementation(function(entry) {
  event({ kind: 'record', id: entry.transcript?.[0]?.attempt, passed: entry.passed, exitReason: entry.exit_reason });
  return addTest.call(this, entry);
});
const finalize = EvalCollector.prototype.finalize;
spyOn(EvalCollector.prototype, 'finalize').mockImplementation(function() {
  event({ kind: 'finalized' });
  return finalize.call(this);
});
await import(path.join(root, 'test', ${JSON.stringify(file)}));
`);
  try {
    const proc = Bun.spawnSync([process.execPath, 'test', '--retry', '1', '--concurrent', '--max-concurrency', '2', script], {
      cwd: ROOT, timeout: 15_000, stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env, EVALS: '1', EVALS_ALL: '', EVALS_TIER: 'periodic', EVALS_PREFLIGHT_OK: '1',
        EVALS_SELECTION_JSON: JSON.stringify({ selected: [id], reason: 'free format lifecycle' }),
        GSTACK_EVAL_DIR: evalDir, GSTACK_CLAUDE_CLI_VERSION: 'free fixture',
        ANTHROPIC_API_KEY: 'free-fixture', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      },
    });
    const output = proc.stdout.toString() + proc.stderr.toString();
    const events = fs.readFileSync(facts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const finals = listEvalJsonFiles(evalDir).filter(isFinalizedEvalResultFile)
      .map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    return { code: proc.exitCode, output, events, entries: finals.flatMap(saved => saved.tests) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('Plan format actual capture and judge lifecycle', () => {
  for (const [file, id] of FORMAT_CASES) {
    for (const scenario of ['recover', 'both-timeout', 'bad-format']) {
      test(`${id}: ${scenario} finishes before retry and fixture cleanup`, async () => {
        const { code, output, events, entries } = await runFormatLifecycle(file, id, scenario);
        expect(code, output).toBe(scenario === 'recover' ? 0 : 1);
        expect(output).not.toContain('Unhandled error between tests');
        const starts = events.filter(event => event.kind === 'start');
        expect(starts.map(({ timeout, maxTurns, model }) => ({ timeout, maxTurns, model })))
          .toEqual([1, 2].map(() => ({ timeout: 300, maxTurns: 10, model: 'claude-opus-4-7' })));
        expect(events.filter(event => event.kind === 'ready').map(event => event.fixtureExists)).toEqual([true, true]);
        expect(entries).toHaveLength(2);
        expect(entries.map(entry => entry.attempt)).toEqual([1, 2]);
        expect(entries.map(entry => entry.passed)).toEqual([false, scenario === 'recover']);
        expect(entries.every(entry => entry.cost_usd === 0.12 && entry.output.length === 2000)).toBe(true);
        expect(events.filter(event => event.kind === 'record')).toHaveLength(2);
        expect(events.findIndex(event => event.kind === 'record' && event.id === 1))
          .toBeLessThan(events.findIndex(event => event.kind === 'start' && event.id === 2));
        expect(events.findIndex(event => event.kind === 'record' && event.id === 2))
          .toBeLessThan(events.findIndex(event => event.kind === 'finalized'));
        expect(events.filter(event => event.kind === 'finalized')).toHaveLength(1);
        for (const start of starts) expect(fs.existsSync(start.cwd)).toBe(false);
        if (scenario === 'recover' && file.includes('plan-format')) {
          expect(entries[1].judge_scores.rec_substance).toBe(5);
          expect(entries[1].judge_reasoning).toContain('fixture specific tradeoff');
        }
      });
    }
  }

  for (const scenario of ['near-success', 'late-judge', 'bad-score']) {
    test(`recommendation ${scenario} stays inside the shared work deadline`, async () => {
      const { code, output, events, entries } = await runFormatLifecycle(FORMAT_CASES[0][0], FORMAT_CASES[0][1], scenario);
      expect(code, output).toBe(scenario === 'near-success' ? 0 : 1);
      expect(output).not.toContain('Unhandled error between tests');
      expect(events.filter(event => event.kind === 'judge-start')).toHaveLength(scenario === 'near-success' ? 1 : 2);
      expect(events.filter(event => event.kind === 'judge-start').every(event => event.sameSignal)).toBe(true);
      expect(entries).toHaveLength(scenario === 'near-success' ? 1 : 2);
      expect(entries.every(entry => entry.passed === (scenario === 'near-success'))).toBe(true);
      if (scenario === 'late-judge') {
        expect(entries.every(entry => entry.exit_reason === 'timeout' && !entry.judge_scores)).toBe(true);
        expect(events.filter(event => event.kind === 'judge-ready').every(event => event.aborted)).toBe(true);
      }
      if (scenario === 'bad-score') expect(entries.every(entry => entry.judge_scores.rec_substance === 3)).toBe(true);
      expect(events.filter(event => event.kind === 'record')).toHaveLength(entries.length);
    });
  }
});
