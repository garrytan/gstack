import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-office-hours.test.ts'), 'utf8');
const owners = ['office-hours-forcing-energy', 'office-hours-builder-wildness'] as const;
type Owner = typeof owners[number];
type Scenario = { exitReason?: string; artifact?: 'missing' | 'short'; scores?: { axis_a: number; axis_b: number; reasoning: string }; judgeError?: Error };

async function exercise(owner: Owner, scenarios: Scenario[]) {
  // Evaluate the actual callbacks with all external effects replaced. No SDK or judge module is imported.
  let executable = source;
  for (const declaration of source.matchAll(/^import[\s\S]*?;\n/gm)) executable = executable.replace(declaration[0], '');
  const js = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(executable);
  const setups: Array<() => void> = [], finalizers: Array<() => void> = [];
  const callbacks = new Map<string, () => Promise<void>>();
  const files = new Map<string, string>(), records: any[] = [], calls: any[] = [], judged: any[] = [], removed: string[] = [];
  const collector = {};
  let index = -1, current: Scenario = {}, currentResult: any;
  const args: Record<string, any> = {
    expect, beforeAll: (fn: () => void) => setups.push(fn), afterAll: (fn: () => void) => finalizers.push(fn),
    CAPTURE_MS, CAPTURE_LONG_MS, ROOT: '/source', runId: 'synthetic-posture-run', evalsEnabled: true,
    describeIfSelected: (_title: string, _names: string[], fn: () => void) => fn(),
    testConcurrentIfSelected: (name: string, fn: () => Promise<void>, timeout: number) => { expect(timeout).toBe(CAPTURE_LONG_MS); callbacks.set(name, fn); },
    createEvalCollector: () => collector, finalizeEvalCollector: () => {}, logCost: () => {}, console: { log: () => {} },
    recordE2E: (target: unknown, name: string, suite: string, result: unknown, extra: any) => {
      expect(target).toBe(collector); expect(result).toBe(currentResult); expect(name).toBe('/' + owner);
      records.push({ attempt: index, name, suite, result, ...structuredClone(extra) });
    },
    spawnSync: () => ({ status: 0 }), path, os: { tmpdir: () => '/tmp' },
    fs: {
      mkdtempSync: (prefix: string) => prefix + 'owned', mkdirSync: () => {}, copyFileSync: () => {}, cpSync: () => {},
      rmSync: (file: string) => removed.push(file), existsSync: (file: string) => files.has(file),
      writeFileSync: (file: string, body: string) => files.set(file, body),
      readFileSync: (file: string) => file.startsWith('/source/') ? 'synthetic source fixture' : files.get(file),
    },
    runSkillTest: async (opts: any) => {
      index++; current = scenarios[index]!; expect(current).toBeDefined(); calls.push(opts);
      expect(opts.testName).toBe(owner); expect(opts.maxTurns).toBe(8); expect(opts.timeout).toBe(CAPTURE_MS);
      expect(opts.model).toBe('claude-sonnet-4-6'); expect(opts.runId).toBe('synthetic-posture-run');
      expect(opts.prompt).toContain('Skip any AskUserQuestion');
      const file = path.join(opts.workingDirectory, owner === owners[0] ? 'q3.md' : 'unlocks.md');
      files.delete(file);
      if (current.artifact !== 'missing') files.set(file, current.artifact === 'short' ? 'short' : 'public response '.repeat(30));
      currentResult = { exitReason: current.exitReason ?? 'success', browseErrors: [], durationMs: 123 + index, costUsd: 0.11, output: 'public completion' };
      return currentResult;
    },
    judgePosture: async (mode: string, text: string) => {
      expect(mode).toBe(owner === owners[0] ? 'forcing' : 'builder'); expect(text.length).toBeGreaterThan(200);
      judged.push({ attempt: index, mode });
      if (current.judgeError) throw current.judgeError;
      return current.scores ?? { axis_a: 4, axis_b: 4, reasoning: 'both required posture axes met' };
    },
  };
  new Function(...Object.keys(args), js)(...Object.values(args));
  expect([...callbacks.keys()]).toEqual([...owners]); for (const setup of setups) setup();
  const thrown: unknown[] = [];
  for (const _scenario of scenarios) { try { await callbacks.get(owner)!(); thrown.push(undefined); } catch (error) { thrown.push(error); } }
  for (const finalize of finalizers) finalize();
  expect(calls).toHaveLength(scenarios.length); expect(removed).toHaveLength(2);
  return { records, thrown, judged };
}

for (const owner of owners) test(`posture late axis_b failure records false exactly once: ${owner}`, async () => {
  const scores = { axis_a: 4, axis_b: 3, reasoning: 'actual-style posture quality miss' };
  const x = await exercise(owner, [{ scores }]);
  expect(x.thrown[0]).toBeDefined(); expect(x.records).toHaveLength(1); expect(x.records[0].passed).toBe(false);
  expect(x.records[0].judge_scores).toEqual({ axis_a: 4, axis_b: 3 }); expect(x.records[0].judge_reasoning).toBe(scores.reasoning);
});

test('posture returned timeout and missing or short artifacts remain failed without a judge call', async () => {
  for (const owner of owners) for (const scenario of [{ exitReason: 'timeout' }, { artifact: 'missing' }, { artifact: 'short' }] as Scenario[]) {
    const x = await exercise(owner, [scenario]); expect(x.thrown[0]).toBeDefined(); expect(x.judged).toHaveLength(0);
    expect(x.records).toHaveLength(1); expect(x.records[0].passed).toBe(false); expect(x.records[0].judge_scores).toBeUndefined();
  }
});

test('posture both axis failures and thrown judge preserve failed verdict and original exception', async () => {
  for (const owner of owners) {
    for (const scores of [{ axis_a: 3, axis_b: 4, reasoning: 'first axis miss' }, { axis_a: 3, axis_b: 3, reasoning: 'both axes miss' }]) {
      const x = await exercise(owner, [{ scores }]); expect(x.thrown[0]).toBeDefined(); expect(x.judged).toHaveLength(1);
      expect(x.records).toHaveLength(1); expect(x.records[0].passed).toBe(false);
      expect(x.records[0].judge_scores).toEqual({ axis_a: scores.axis_a, axis_b: scores.axis_b }); expect(x.records[0].judge_reasoning).toBe(scores.reasoning);
    }
    const error = new Error('synthetic judge service failure'); const x = await exercise(owner, [{ judgeError: error }]);
    expect(x.thrown[0]).toBe(error); expect(x.records).toHaveLength(1); expect(x.records[0].passed).toBe(false); expect(x.records[0].judge_scores).toBeUndefined();
  }
});

test('posture success and existing max-turn allowance require both actual judge axes', async () => {
  for (const owner of owners) for (const exitReason of ['success', 'error_max_turns']) {
    const x = await exercise(owner, [{ exitReason }]); expect(x.thrown[0]).toBeUndefined(); expect(x.judged).toHaveLength(1);
    expect(x.records).toHaveLength(1); expect(x.records[0].passed).toBe(true); expect(x.records[0].judge_scores).toEqual({ axis_a: 4, axis_b: 4 });
  }
});

test('posture consecutive failed and passing callbacks retain separate final verdicts', async () => {
  for (const owner of owners) {
    const x = await exercise(owner, [{ scores: { axis_a: 4, axis_b: 3, reasoning: 'first fails' } }, {}]);
    expect(x.thrown[0]).toBeDefined(); expect(x.thrown[1]).toBeUndefined(); expect(x.records).toHaveLength(2);
    expect(x.records.map(r => r.passed)).toEqual([false, true]); expect(x.records.map(r => r.attempt)).toEqual([0, 1]);
    expect(x.records[0].judge_scores).toEqual({ axis_a: 4, axis_b: 3 }); expect(x.records[1].judge_scores).toEqual({ axis_a: 4, axis_b: 4 });
  }
});

test('posture recorder controls select exactly the two existing paid owners', () => {
  expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes('test/office-posture-recording.test.ts')).map(([name]) => name)).toEqual([...owners]);
});
