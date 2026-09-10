import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { E2E_TOUCHFILES } from './helpers/touchfiles';

const source = fs.readFileSync(path.join(import.meta.dir, 'skill-e2e-office-hours-phase4.test.ts'), 'utf8');
const question = (word = 'architectural', options = 'A) Put retrieval on the server\nB) Put retrieval on the client') =>
  `Where should retrieval live?\nThis ${word} choice decides which component owns the retrieval algorithm and the cross-host API contract.\n${options}\nRecommendation: A because all hosts need a consistent algorithm with one owner.\n`;

async function runCaller(captured: string | undefined, scenario: 'success' | 'timeout' | 'judge-fail' | 'judge-throws' = 'success') {
  // Exercise the actual caller with no SDK, filesystem, git or judge dispatch.
  let executable = source;
  for (const declaration of source.matchAll(/^import[\s\S]*?;\n/gm)) executable = executable.replace(declaration[0], '');
  const js = new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(executable);
  const setups: Array<() => void> = [], callbacks: Array<() => Promise<void>> = [], finalizers: Array<() => Promise<void>> = [];
  const files = new Map<string,string>(), rows: any[] = [], calls: any[] = [];
  const collector = { addTest: (row: any) => rows.push(row) };
  let judged = 0;
  const result = { exitReason: scenario === 'timeout' ? 'timeout' : 'success', browseErrors: [], durationMs: 123, costUsd: 0.1, output: 'public completion' };
  const args: Record<string,any> = {
    expect, beforeAll: (fn: () => void) => setups.push(fn), afterAll: (fn: () => Promise<void>) => finalizers.push(fn),
    CAPTURE_MS, CAPTURE_LONG_MS, ROOT: '/source', runId: 'synthetic-run',
    describeIfSelected: (_title: string, _names: string[], fn: () => void) => fn(),
    testConcurrentIfSelected: (name: string, fn: () => Promise<void>, timeout: number) => { expect(name).toBe('office-hours-phase4-fork'); expect(timeout).toBe(CAPTURE_LONG_MS); callbacks.push(fn); },
    createEvalCollector: () => collector, finalizeEvalCollector: async () => {}, logCost: () => {},
    recordE2E: (target: typeof collector | null, _id: string, _title: string, actual: unknown, extra: any) => { expect(actual).toBe(result); target?.addTest({ ...extra, duration_ms: result.durationMs, cost_usd: result.costUsd }); },
    assertRecommendationQuality: async (opts: any) => {
      judged++; expect(opts.captured).toBe(captured); expect(opts.result).toBe(result);
      if (scenario === 'judge-throws') throw new Error('synthetic judge unavailable');
      opts.evalCollector?.addTest({ passed: opts.passed, judge_scores: { rec_substance: scenario === 'judge-fail' ? 1 : 5 } });
      if (scenario === 'judge-fail') throw new Error('synthetic judge assertion');
      return { present: true, commits: true, has_because: true, reason_substance: 5 };
    },
    spawnSync: () => ({status:0}), path, os: {tmpdir:()=>'/tmp'},
    fs: { mkdtempSync:(prefix:string)=>prefix+'owned', mkdirSync:()=>{}, rmSync:()=>{}, existsSync:(name:string)=>files.has(name),
      writeFileSync:(name:string,body:string)=>files.set(name,body), readFileSync:(name:string)=>name==='/source/office-hours/SKILL.md' ? '## AskUserQuestion Format\nformat\n## Phase 4: Alternatives Generation\nworkflow\n## Phase 4.5\nnext' : files.get(name) },
    runSkillTest: async (opts: any) => {
      calls.push(opts); expect(opts.timeout).toBe(CAPTURE_MS); expect(opts.maxTurns).toBe(12); expect(opts.model).toBe('claude-opus-4-7');
      expect(opts.prompt).toContain('Do NOT call any tool to ask the user.');
      if (captured !== undefined) files.set(path.join(opts.workingDirectory, 'phase4-capture.md'), captured);
      return result;
    },
  };
  new Function(...Object.keys(args), js)(...Object.values(args));
  expect(callbacks).toHaveLength(1); for (const fn of setups) fn();
  let thrown: unknown; try { await callbacks[0]!(); } catch(error) { thrown=error; }
  for (const fn of finalizers) await fn();
  expect(calls).toHaveLength(1);
  return {rows,thrown,judged};
}

test('Phase4 caller accepts architectural vocabulary while retaining a real fork and recommendation', async () => {
  for (const word of ['architectural', 'architecture', 'implementation']) {
    const x=await runCaller(question(word)); expect(x.thrown).toBeUndefined(); expect(x.judged).toBe(1); expect(x.rows).toHaveLength(1); expect(x.rows[0].passed).toBe(true);
  }
});

test('Phase4 caller rejects earlier-phase questions, missing recommendations and incomplete option forks', async () => {
  for (const capture of [question('customer-preference'), question().replace('because','given that'), question('architectural','A) Put retrieval on the server'), question('architectural','A) Put retrieval on the server\nA) Repeated same option')]) {
    const x=await runCaller(capture); expect(x.thrown).toBeDefined(); expect(x.judged).toBe(0); expect(x.rows).toHaveLength(1); expect(x.rows[0].passed).toBe(false);
  }
});

test('Phase4 a single labeled option does not satisfy the existing two-alternative minimum', async () => {
  const x = await runCaller(question('architecture', 'A) Put retrieval on the server'));
  expect(x.thrown).toBeDefined(); expect(x.judged).toBe(0);
});

test('Phase4 source examples and nested implementation steps cannot supply alternatives', async () => {
  for (const options of [
    'A) Use server retrieval\n```text\nB) Use client retrieval\n```',
    'A) Use server retrieval\n    1) Query candidates\n    2) Rank candidates',
    'A) Use server retrieval\n  1) Query candidates\n  2) Rank candidates',
    'Example:\n```text\nA) Use server retrieval\nB) Use client retrieval\n```',
    '> A) Use server retrieval\n> B) Use client retrieval',
  ]) {
    const x=await runCaller(question('architecture',options));
    expect(x.thrown).toBeDefined(); expect(x.judged).toBe(0); expect(x.rows).toHaveLength(1); expect(x.rows[0].passed).toBe(false);
  }
  for (const options of ['  A) Server retrieval\n  B) Client retrieval','1) Server retrieval\n2) Client retrieval']) {
    const x=await runCaller(question('architecture',options)); expect(x.thrown).toBeUndefined(); expect(x.rows[0].passed).toBe(true);
  }
});

test('Phase4 caller records every returned-result failure exactly once, including judge failures', async () => {
  for (const [capture,scenario] of [[undefined,'success'],[question(),'timeout'],[question(),'judge-fail'],[question(),'judge-throws']] as const) {
    const x=await runCaller(capture,scenario); expect(x.thrown).toBeDefined(); expect(x.rows).toHaveLength(1); expect(x.rows[0].passed).toBe(false);
  }
});

test('Phase4 caller controls select only the existing Phase4 paid owner', () => {
  expect(Object.entries(E2E_TOUCHFILES).filter(([,paths])=>paths.includes('test/office-hours-phase4-caller.test.ts')).map(([name])=>name)).toEqual(['office-hours-phase4-fork']);
});
