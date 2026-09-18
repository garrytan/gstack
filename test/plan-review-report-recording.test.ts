/** Free actual-caller proofs: captured public tables, synthetic runner outcomes. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { recordE2E } from './helpers/e2e-helpers';
import { EvalCollector, isFinalizedEvalResultFile, listEvalJsonFiles, type EvalTestEntry } from './helpers/eval-store';
import { OFFICE_HOURS_BUN_GRACE_MS, runRecordedOfficeHoursAttempt } from './helpers/office-hours-attempt';
import { isPaidTestFile } from './helpers/paid-test-set';

const ROOT = path.resolve(import.meta.dir, '..');
const source = fs.readFileSync(path.join(ROOT, 'test/skill-e2e-plan.test.ts'), 'utf8');
const captures = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures/plan-review-report-public.json'), 'utf8')).captures;
const canonicalTable = captures.find((entry: any) => entry.id === 'passed-1').report_table;
// Only the table above is captured. These completion suffixes are synthetic controls.
const completion = '\n**VERDICT:** ENG ISSUES OPEN\n\nNO UNRESOLVED DECISIONS\n';
const openCompletion = '\n**VERDICT:** ENG ISSUES OPEN\n\n**UNRESOLVED DECISIONS:**\n- Choose delivery semantics.\n';
const CASE = '/plan-eng-review writes GSTACK REVIEW REPORT to plan file';

type Scenario = { kind: string; table?: string; exitReason?: string; open?: boolean };

async function exercise(scenarios: Scenario[], opts: { deadline?: boolean; sibling?: boolean } = {}) {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-report-recording-free-'));
  const evalDir = path.join(owned, 'evals');
  const setups: Array<() => void> = [], finalizers: Array<() => unknown> = [];
  const callbacks: Array<{ name: string; body: () => Promise<void>; cap: number }> = [];
  const records: EvalTestEntry[] = [], calls: any[] = [], fixtures: string[] = [], helperOptions: any[] = [];
  const collectorArgs: any[] = [], finalization: string[] = [];
  const outcomes: Array<{ kind: string; error: unknown; entries: EvalTestEntry[]; result: any }> = [];
  let current: Scenario = { kind: 'pass' }, result: any, lateResolve: ((value: any) => void) | undefined;
  const setupError = new Error('fixture copy unavailable');
  const runnerError = new Error('runner unavailable');
  class BoundCollector extends EvalCollector {
    constructor(tier: any, _dir?: string, namespace?: string) {
      super(tier, evalDir, namespace);
      collectorArgs.push({ tier, namespace });
    }
    addTest(entry: EvalTestEntry) {
      records.push(structuredClone(entry));
      super.addTest(entry);
    }
  }
  let executable = source;
  for (const declaration of source.matchAll(/^import[\s\S]*?;\n/gm)) executable = executable.replace(declaration[0], '');
  const js = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(executable);
  const args: Record<string, any> = {
    expect, ROOT, runId: 'public-report-free', evalsEnabled: true, CAPTURE_LONG_MS,
    OFFICE_HOURS_BUN_GRACE_MS, EvalCollector: BoundCollector, recordE2E,
    createEvalCollector: (tier: string) => new BoundCollector(tier),
    finalizeEvalCollector: async (collector: EvalCollector | null) => {
      if (collector) finalization.push(await collector.finalize());
    },
    describeIfSelected: (name: string, ids: string[], body: () => void) => {
      if (ids.includes('plan-review-report')) {
        expect(name).toBe('Plan Review Report E2E'); expect(ids).toEqual(['plan-review-report']); body();
      }
    },
    test: (name: string, body: () => Promise<void>, cap: number) => callbacks.push({ name, body, cap }),
    beforeAll: (body: () => void) => setups.push(body), afterAll: (body: () => unknown) => finalizers.push(body),
    logCost: () => {}, console: { log: () => {}, warn: () => {} }, path,
    os: { tmpdir: () => owned }, spawnSync: () => ({ status: 0 }),
    fs: {
      ...fs,
      mkdtempSync: (prefix: string) => {
        const dir = fs.mkdtempSync(prefix);
        expect(fs.realpathSync(dir).startsWith(fs.realpathSync(owned) + path.sep)).toBe(true);
        fixtures.push(dir); return dir;
      },
      copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
        if (current.kind === 'setup') throw setupError;
        return fs.copyFileSync(...args);
      },
    },
    runRecordedOfficeHoursAttempt: (options: Parameters<typeof runRecordedOfficeHoursAttempt>[0]) => {
      helperOptions.push(options);
      // Only this free noncooperative-runner control uses a short work deadline.
      // Production options and the runner's 600s work budget are asserted below.
      return runRecordedOfficeHoursAttempt(opts.deadline ? { ...options, budgetMs: 50 } : options);
    },
    runSkillTest: async (options: any) => {
      const file = path.join(options.workingDirectory, 'plan.md');
      const seed = fs.readFileSync(file, 'utf8');
      calls.push({ ...options, seed,
        main: fs.readFileSync(path.join(options.workingDirectory, 'plan-eng-review/SKILL.md'), 'utf8'),
        section: fs.readFileSync(path.join(options.workingDirectory, 'plan-eng-review/sections/review-sections.md'), 'utf8'),
      });
      if (current.kind === 'runner') throw runnerError;
      result = {
        exitReason: current.exitReason ?? 'success', browseErrors: [], duration: 25,
        output: 'public output '.repeat(200), model: options.model,
        firstResponseMs: 3, maxInterTurnMs: 7,
        costEstimate: { inputChars: 100, outputChars: 2800, estimatedTokens: 725, estimatedCost: 0.12,
          turnsUsed: current.kind === 'api-zero' ? 0 : 4 },
        toolCalls: [{ tool: 'Edit', input: { file_path: file }, output: 'saved' }],
        transcript: [{ type: 'fixture', label: current.kind }],
      };
      if (current.kind === 'deadline') return new Promise(resolve => { lateResolve = resolve; });
      let body = seed + '\n' + (current.table ?? canonicalTable) + (current.open ? openCompletion : completion);
      const replacements: Record<string, [string, string]> = {
        title: ['# Plan: Add Notifications System', '# Other plan'],
        websocket: ['WebSocket', 'socket'],
        report: ['## GSTACK REVIEW REPORT', '## Different report'],
        header: ['| Review |', '| Kind |'],
        ceo: ['CEO Review', 'CEO'], eng: ['Eng Review', 'Eng'], design: ['Design Review', 'Design'],
        unresolved: ['UNRESOLVED DECISIONS', 'DECISIONS'],
        bold: ['NO UNRESOLVED DECISIONS', '**NO UNRESOLVED DECISIONS**'],
      };
      if (replacements[current.kind]) body = body.replaceAll(...replacements[current.kind]);
      if (current.kind === 'trailing') body += '\nSome trailing prose.\n';
      if (current.kind === 'verdict-bullet') body = seed + '\n' + canonicalTable + openCompletion + '- VERDICT: done\n';
      if (current.kind === 'missing') fs.unlinkSync(file);
      else fs.writeFileSync(file, body);
      return result;
    },
  };
  try {
    new Function(...Object.keys(args), js)(...Object.values(args));
    expect(callbacks.map(callback => callback.name)).toEqual([CASE]);
    for (const setup of setups) setup();
    for (const scenario of scenarios) {
      current = scenario; result = undefined;
      const before = records.length;
      let error: unknown;
      try { await callbacks[0].body(); } catch (failure) { error = failure; }
      outcomes.push({ kind: scenario.kind, error, entries: records.slice(before), result });
      // A configured retry must start after cleanup of the previous attempt.
      if (helperOptions.length) for (const dir of fixtures) expect(fs.existsSync(dir)).toBe(false);
    }
    if (opts.deadline) {
      expect(lateResolve).toBeFunction();
      const saved = JSON.stringify(records);
      lateResolve!(result);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(JSON.stringify(records)).toBe(saved);
    }
    for (const finalize of finalizers) await finalize();
    if (opts.sibling) {
      const sibling = new EvalCollector('e2e', evalDir, 'sibling');
      sibling.addTest({ name: 'sibling', suite: 'Sibling', tier: 'e2e', passed: true, duration_ms: 1, cost_usd: 0 });
      await sibling.finalize();
    }
    const files = listEvalJsonFiles(evalDir);
    return { outcomes, calls, fixtures, helperOptions, collectorArgs, finalization,
      cap: callbacks[0].cap, setupError, runnerError,
      finals: files.filter(isFinalizedEvalResultFile).map(file => ({ file, value: JSON.parse(fs.readFileSync(file, 'utf8')) })),
      partials: files.filter(file => path.basename(file).startsWith('_partial')).map(file => ({ file, value: JSON.parse(fs.readFileSync(file, 'utf8')) })),
    };
  } finally { fs.rmSync(owned, { recursive: true, force: true }); }
}

for (const capture of captures.filter((entry: any) => entry.id.startsWith('failed'))) {
  test(`captured ${capture.id} malformed table fails the real assertion and records false once`, async () => {
    const actual = await exercise([{ kind: capture.id, table: capture.report_table }]);
    expect(String(actual.outcomes[0].error)).toContain('CEO Review');
    expect(actual.outcomes[0].entries).toHaveLength(1);
    expect(actual.outcomes[0].entries[0].passed).toBe(false);
    expect(actual.outcomes[0].entries[0].error).toContain('CEO Review');
  });
}

for (const [kind, expected] of [
  ['title', '# Plan: Add Notifications System'], ['websocket', 'WebSocket'],
  ['report', '## GSTACK REVIEW REPORT'], ['header', 'Review'], ['ceo', 'CEO Review'],
  ['eng', 'Eng Review'], ['design', 'Design Review'], ['unresolved', 'UNRESOLVED DECISIONS'],
  ['trailing', 'report must end'], ['bold', 'report must end'], ['verdict-bullet', 'report must end'],
] as const) test(`report assertion ${kind} remains a recorded failure`, async () => {
  const actual = await exercise([{ kind }]);
  const outcome = actual.outcomes[0];
  expect(String(outcome.error)).toContain(expected);
  expect(outcome.entries).toHaveLength(1);
  expect(outcome.entries[0]).toMatchObject({ passed: false, exit_reason: 'success', cost_usd: 0.12 });
  expect(outcome.entries[0].error).toContain(expected);
});

for (const exitReason of ['timeout', 'timeout_startup', 'exit_code_137', 'error_api']) {
  test(`report runner ${exitReason} cannot pass valid-looking output`, async () => {
    const actual = await exercise([{ kind: 'exit', exitReason }]);
    expect(String(actual.outcomes[0].error)).toContain(exitReason);
    expect(actual.outcomes[0].entries).toHaveLength(1);
    expect(actual.outcomes[0].entries[0]).toMatchObject({ passed: false, exit_reason: exitReason, cost_usd: 0.12 });
  });
}

test('zero-turn API failure is a failed attempt rather than a prerequisite skip', async () => {
  const actual = await exercise([{ kind: 'api-zero', exitReason: 'error_api' }]);
  expect(String(actual.outcomes[0].error)).toContain('error_api');
  expect(actual.outcomes[0].entries).toHaveLength(1);
  expect(actual.outcomes[0].entries[0]).toMatchObject({ passed: false, exit_reason: 'error_api', turns_used: 0 });
});

for (const kind of ['setup', 'runner', 'missing']) test(`report ${kind} failure records once and cleans its fixture`, async () => {
  const actual = await exercise([{ kind }]);
  const outcome = actual.outcomes[0];
  expect(outcome.error).toBeDefined(); expect(outcome.entries).toHaveLength(1);
  expect(outcome.entries[0].passed).toBe(false);
  if (kind !== 'missing') {
    expect(outcome.error).toBe(kind === 'setup' ? actual.setupError : actual.runnerError);
    expect(outcome.entries[0]).toMatchObject({ exit_reason: 'harness_error', cost_usd: 0 });
    expect(outcome.entries[0].error).toContain('cost and usage unavailable');
  } else expect(outcome.entries[0].error).toContain('ENOENT');
});

test('canonical reports preserve both successful exits, terminal forms, metadata and copied source', async () => {
  const actual = await exercise([{ kind: 'pass' }, { kind: 'pass', exitReason: 'error_max_turns', open: true }]);
  expect(actual.outcomes.map(outcome => outcome.error)).toEqual([undefined, undefined]);
  expect(actual.cap).toBe(CAPTURE_LONG_MS + OFFICE_HOURS_BUN_GRACE_MS);
  expect(actual.helperOptions).toHaveLength(2);
  for (const options of actual.helperOptions) expect(options.budgetMs).toBe(CAPTURE_LONG_MS);
  for (const call of actual.calls) {
    expect(call).toMatchObject({ testName: 'plan-review-report', model: 'claude-opus-4-7', maxTurns: 20,
      timeout: CAPTURE_LONG_MS, runId: 'public-report-free' });
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.prompt).toContain('Read plan-eng-review/SKILL.md and plan-eng-review/sections/review-sections.md');
    expect(call.prompt).toContain('"Plan File Review Report" section of plan-eng-review/sections/review-sections.md');
    expect(call.prompt).not.toContain('placeholder table with all five review rows (CEO, Codex, Eng, Design, DX)');
    expect(call.main).toBe(fs.readFileSync(path.join(ROOT, 'plan-eng-review/SKILL.md'), 'utf8'));
    expect(call.section).toBe(fs.readFileSync(path.join(ROOT, 'plan-eng-review/sections/review-sections.md'), 'utf8'));
    expect(call.section).toContain('| Review | Trigger | Why | Runs | Status | Findings |');
  }
  for (const outcome of actual.outcomes) {
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]).toMatchObject({ name: '/plan-review-report', suite: 'Plan Review Report E2E', tier: 'e2e', passed: true,
      duration_ms: 25, cost_usd: 0.12, model: 'claude-opus-4-7', first_response_ms: 3, max_inter_turn_ms: 7 });
    expect(outcome.entries[0].output).toHaveLength(2000);
    expect(outcome.entries[0].transcript).toEqual(outcome.result.transcript);
  }
});

test('retry attempts own pristine fixtures and namespaced serialization preserves failed and passed records', async () => {
  const actual = await exercise([{ kind: 'failed', table: captures[0].report_table }, { kind: 'pass' }], { sibling: true });
  expect(actual.calls).toHaveLength(2);
  expect(actual.calls[0].workingDirectory).not.toBe(actual.calls[1].workingDirectory);
  expect(actual.calls[0].seed).toBe(actual.calls[1].seed);
  expect(actual.calls.every(call => !call.seed.includes('## GSTACK REVIEW REPORT'))).toBe(true);
  expect(actual.collectorArgs).toEqual([{ tier: 'e2e', namespace: 'plan' }]);
  expect(actual.finalization).toHaveLength(1);
  expect(actual.finals).toHaveLength(2); expect(actual.partials).toHaveLength(2);
  for (const group of [actual.finals, actual.partials]) {
    const report = group.find(saved => saved.value.tests.some((entry: any) => entry.name === '/plan-review-report'))!;
    const sibling = group.find(saved => saved.value.tests.some((entry: any) => entry.name === 'sibling'))!;
    expect(report.file).not.toBe(sibling.file);
    expect(report.value).toMatchObject({ tier: 'e2e', total_tests: 2, passed: 1, failed: 1 });
    expect(report.value.tests.map((entry: any) => entry.attempt)).toEqual([1, 2]);
    expect(report.value.tests.map((entry: any) => entry.passed)).toEqual([false, true]);
  }
});

test('report deadline aborts, records once, cleans up and ignores late completion', async () => {
  const actual = await exercise([{ kind: 'deadline' }], { deadline: true });
  expect(actual.calls[0].signal.aborted).toBe(true);
  expect(actual.outcomes[0].error).toBeDefined();
  expect(actual.outcomes[0].entries).toHaveLength(1);
  expect(actual.outcomes[0].entries[0]).toMatchObject({ passed: false, exit_reason: 'timeout' });
}, 15_000);

test('report recording controls stay outside the paid test filename patterns', () => {
  expect(isPaidTestFile('test/plan-review-report-recording.test.ts')).toBe(false);
});
