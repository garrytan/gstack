import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
type Spec = { suite: 'consistency' | 'ab' | 'direct'; runs?: number; reject?: number; rejectAll?: boolean;
  capacity?: number; queryMs?: number; outerMs?: number;
  setupReject?: number; cleanupReject?: number; judgeReject?: number; empty?: number; omit?: string; omitIndex?: number; scores?: number[] };

function exercise(spec: Spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auq-parallel-free-'));
  const worker = path.join(root, 'registration.test.ts');
  fs.writeFileSync(worker, `import ${JSON.stringify(path.join(import.meta.dir, 'helpers/auq-parallel-worker.ts'))};`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', worker], {
      cwd: ROOT, timeout: 15_000,
      env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root, TEMP: root, TMP: root,
        AUQ_PARALLEL_SPEC: JSON.stringify(spec), AUQ_PARALLEL_ROOT: root,
        AUQ_CONSISTENCY_RUNS: String(spec.runs ?? 3), EVALS_HERMETIC: '1', EVALS_RUN_ID: 'free',
        GSTACK_CLAUDE_BIN: '/fixture/claude', GSTACK_EVAL_DIR: path.join(root, 'artifacts'),
        ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
        GSTACK_SDK_MAX_CONCURRENCY: String(spec.capacity ?? 3), GSTACK_EVAL_MODEL_CAPTURE: 'fixture-model',
        GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.signalCode ?? null, output).toBeNull();
    expect(fs.existsSync(path.join(root, 'facts.json')), output).toBe(true);
    const facts = JSON.parse(fs.readFileSync(path.join(root, 'facts.json'), 'utf8'));
    if (spec.suite === 'direct') return { code: child.exitCode, output, facts };
    const ids = spec.suite === 'consistency' ? Array.from({ length: spec.runs ?? 3 }, (_, i) => String(i)) : ['carved', 'verbose'];
    const started = ids.filter((_, i) => i !== spec.setupReject);
    for (const kind of ['capture-start', 'query-start', 'query-close', 'capture-settle', 'cleanup']) {
      expect(facts.events.filter((event: any) => event.kind === kind).map((event: any) => event.id).sort(), output)
        .toEqual([...started].sort());
    }
    expect(facts.active).toBe(0); expect(facts.judging).toBe(0); expect(facts.answers).toBe(0);
    expect(facts.leftovers).toEqual(spec.cleanupReject === undefined ? [] : [facts.fixtures[spec.cleanupReject]]);
    expect(facts.ownedStateLeftovers).toEqual([]);
    expect(new Set(facts.fixtures).size).toBe(started.length);
    expect(new Set(facts.inputs.map((input: any) => input.config)).size).toBe(started.length);
    expect(new Set(facts.inputs.map((input: any) => input.state)).size).toBe(started.length);
    expect(facts.peak).toBe(Math.min(spec.capacity ?? 3, started.length));
    expect(facts.judgePeak).toBeLessThanOrEqual(spec.suite === 'consistency' ? 1 : 2);
    const lastCapture = facts.events.findLastIndex((event: any) => event.kind === 'capture-settle');
    const firstCleanup = facts.events.findIndex((event: any) => event.kind === 'cleanup');
    expect(firstCleanup, output).toBeGreaterThan(lastCapture);
    if (spec.suite === 'ab') expect(firstCleanup).toBeGreaterThan(facts.events.findLastIndex((event: any) => event.kind === 'judge-settle'));
    expect(facts.judges.map((judge: any) => judge.id).sort()).toEqual(ids.filter((_, i) =>
      !spec.rejectAll && i !== spec.reject && i !== spec.setupReject && i !== spec.empty).sort());
    expect(facts.receipts).toHaveLength(started.length);
    for (const receipt of facts.receipts) {
      expect(receipt).toMatchObject({ source: 'can_use_tool', workflowCompleted: false, answered: false,
        maxTurns: 12, timeoutMs: 240_000 });
    }
    for (const { request } of facts.judgeRequests) {
      expect(request).toMatchObject({ model: 'claude-haiku-4-5-20251001', max_tokens: 8192 });
    }
    for (const input of facts.inputs) {
      expect(input).toMatchObject({ model: 'fixture-model', maxTurns: 12, tools: ['Read', 'Write', 'AskUserQuestion'],
        allowedTools: ['Read', 'Write', 'AskUserQuestion'], permissionMode: 'default', settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code' } });
      expect(input.skill).toBe(fs.readFileSync(path.join(ROOT, input.id === 'verbose'
        ? 'test/fixtures/auq-pre-cut-plan-ceo-review-SKILL.md' : 'plan-ceo-review/SKILL.md'), 'utf8'));
      expect(input.sections.length > 0).toBe(input.id !== 'verbose');
      expect(input.prompt).toContain(path.join(input.cwd, 'plan-ceo-review/SKILL.md'));
      expect(input.prompt).toContain(path.join(input.cwd, 'plan.md'));
    }
    return { code: child.exitCode, output, facts };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test.each([
  { suite: 'consistency', capacity: 1, runs: 3 },
  { suite: 'consistency', capacity: 3, runs: 7 },
  { suite: 'consistency', capacity: 3, runs: 3 },
  { suite: 'ab', capacity: 1 },
] as const)('slow native captures retain their admitted budget: %j', spec => {
  const result = exercise({ ...spec, queryMs: 150_000 });
  expect(result.code, result.output).toBe(0);
  expect(result.facts.pendingTimers).toBe(0);
  expect(result.facts.receipts.every((receipt: any) => receipt.outcome === 'question_captured')).toBe(true);
  const deadlines = result.facts.events.filter((event: any) => event.kind === 'capture-start').map((event: any) => event.caseDeadline);
  expect(new Set(deadlines).size).toBe(1);
  expect(deadlines[0]).toBe(spec.suite === 'consistency' ? spec.runs * 300_000 + 60_000 : 600_000);
  expect(result.facts.elapsed).toBe(Math.ceil((spec.suite === 'consistency' ? spec.runs : 2) / spec.capacity) * 150_000
    + (spec.suite === 'consistency' ? spec.runs * 90 : 90));
}, 20_000);

test.each([
  { outerMs: 500_000, queryMs: 150_000, elapsed: 450_000, queries: 3, passed: 3 },
  { outerMs: 200_000, queryMs: 150_000, elapsed: 200_000, queries: 2, passed: 1 },
  { outerMs: -1, queryMs: 150_000, elapsed: 0, queries: 0, passed: 0 },
  { outerMs: 960_000, queryMs: 250_000, elapsed: 720_000, queries: 3, passed: 0 },
  { queryMs: 150_000, elapsed: 240_000, queries: 3, passed: 1 },
  { queryMs: 250_000, elapsed: 240_000, queries: 3, passed: 0 },
])('actual capture bounds queued and active work without changing legacy deadlines: %j', scenario => {
  const { code, output, facts } = exercise({ suite: 'direct', capacity: 1, runs: 3, ...scenario });
  expect(code, output).toBe(0);
  expect(facts.elapsed).toBe(scenario.elapsed);
  expect(facts.inputs).toHaveLength(scenario.queries);
  expect(facts.settlements).toHaveLength(3);
  expect(facts.settlements.filter((result: any) => result.status === 'fulfilled')).toHaveLength(scenario.passed);
  for (const result of facts.settlements.filter((result: any) => result.status === 'rejected')) {
    expect(result.reason).toContain('AUQ capture failed (timeout)');
  }
  expect(facts.receipts).toHaveLength(3);
  expect(facts.receipts.filter((receipt: any) => receipt.outcome === 'question_captured')).toHaveLength(scenario.passed);
  expect(facts.receipts.filter((receipt: any) => receipt.outcome === 'timeout')).toHaveLength(3 - scenario.passed);
  expect(facts.receipts.every((receipt: any) => receipt.timeoutMs === 240_000 && !receipt.answered)).toBe(true);
  expect(facts.active).toBe(0); expect(facts.answers).toBe(0); expect(facts.pendingTimers).toBe(0);
  expect(facts.leftovers).toEqual([]); expect(facts.ownedStateLeftovers).toEqual([]);
  expect(facts.events.filter((event: any) => event.kind === 'query-close')).toHaveLength(scenario.queries);
  expect(facts.events.filter((event: any) => event.kind === 'cleanup')).toHaveLength(3);
}, 20_000);

test('consistency starts all three independent native captures and retains the passing score boundaries', () => {
  const result = exercise({ suite: 'consistency', scores: [3, 5, 4] });
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('STABLE across 3 runs');
}, 20_000);

test('consistency uses the existing three-query bound even for seven requested samples', () => {
  const result = exercise({ suite: 'consistency', runs: 7 });
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('STABLE across 7 runs');
}, 20_000);

test.each(['consistency', 'ab'] as const)('%s waits for successful siblings after a capture rejects', suite => {
  const result = exercise({ suite, reject: 0 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('capture rejection');
  expect(result.output).toContain(suite === 'consistency' ? '[AUQ-consistency run 3/3]' : '[AUQ-AB VERBOSE]');
}, 20_000);

test.each(['consistency', 'ab'] as const)('%s retains slow queued siblings and all-settled cleanup after rejection', suite => {
  const result = exercise({ suite, capacity: 1, queryMs: 150_000, reject: 0 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('capture rejection');
  expect(result.facts.receipts.filter((receipt: any) => receipt.outcome === 'question_captured'))
    .toHaveLength(suite === 'consistency' ? 2 : 1);
  expect(result.facts.pendingTimers).toBe(0);
}, 20_000);

test.each(['consistency', 'ab'] as const)('%s preserves every rejection after all children settle', suite => {
  const result = exercise({ suite, rejectAll: true });
  expect(result.code, result.output).toBe(1);
  for (const input of result.facts.inputs) expect(result.output).toContain(`capture rejection ${input.id}`);
}, 20_000);

test.each(['consistency', 'ab'] as const)('%s cleans the owned sibling after fixture setup rejects', suite => {
  const result = exercise({ suite, setupReject: 1 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('setup rejection');
}, 20_000);

test.each(['consistency', 'ab'] as const)('%s retains capture errors and other results when cleanup also rejects', suite => {
  const result = exercise({ suite, reject: 0, cleanupReject: 0 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('capture rejection');
  expect(result.output).toContain('cleanup rejection');
  expect(result.output).toContain(suite === 'consistency' ? '[AUQ-consistency run 3/3]' : '[AUQ-AB VERBOSE]');
}, 20_000);

test.each(['ELI10:', 'Recommendation:', 'Pros / cons:', '✅', '❌', 'Net:', '(recommended)'])('consistency still rejects missing format element %s', omit => {
  const result = exercise({ suite: 'consistency', omit });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(`format element "${omit}" missing in run(s) 3`);
}, 20_000);

test('consistency retains the substance floor and spread oracle', () => {
  const result = exercise({ suite: 'consistency', scores: [2, 5, 4] });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('min substance 2 < 3');
  expect(result.output).toContain('spread 3 > 2');
}, 20_000);

test.each(['consistency', 'ab'] as const)('%s retains the empty-capture assertion', suite => {
  const result = exercise({ suite, empty: 0 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(suite === 'consistency' ? 'produced no AUQ at all' : 'A/B inconclusive');
}, 20_000);

test.each(['consistency', 'ab'] as const)('%s retains judge-unavailable scoring without abandoning siblings', suite => {
  const result = exercise({ suite, judgeReject: 0 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(suite === 'consistency' ? 'min substance 0 < 3' : 'carved substance regressed >1 pt');
}, 20_000);

test('A/B runs both distinct arms and preserves the one-point substance tolerance', () => {
  const result = exercise({ suite: 'ab', scores: [3, 4] });
  expect(result.code, result.output).toBe(0);
  expect(result.facts.judgePeak).toBe(2);
  expect(result.output).toContain('NO DEGRADATION');
}, 20_000);

test('A/B still rejects any format regression', () => {
  const result = exercise({ suite: 'ab', omit: 'Net:', omitIndex: 0 });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('carved dropped: [Net:]');
}, 20_000);

test('A/B still rejects a substance regression over one point', () => {
  const result = exercise({ suite: 'ab', scores: [3, 5] });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('carved substance regressed >1 pt');
}, 20_000);
