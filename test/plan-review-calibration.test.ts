import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planDecisionCalibrations } from './fixtures/plan-decision-classification';
import { buildPlanReviewDecisionPrompt } from './helpers/plan-review-decisions';
import { ENG_BATCHING_FINDINGS } from './helpers/plan-review-cases';
import { E2E_TOUCHFILES, E2E_TIERS, selectTests } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const IDS = ['plan-ceo-finding-count', 'plan-eng-finding-count', 'plan-design-finding-count', 'plan-devex-finding-count',
  'plan-eng-multi-finding-batching', 'plan-ceo-split-overflow', 'plan-decision-classification'].sort();

test('semantic helper changes also select the separate DX analysis calibration', () => {
  for (const file of ['test/helpers/plan-review-decisions.ts', 'test/plan-review-decisions.test.ts',
    'test/helpers/plan-review-cases.ts', 'test/plan-review-cases.test.ts',
    'test/skill-e2e-plan-decision-classification.test.ts', 'test/fixtures/plan-decision-classification.ts', 'test/plan-review-calibration.test.ts']) {
    const shared = ['test/helpers/plan-review-decisions.ts', 'test/plan-review-decisions.test.ts',
      'test/helpers/plan-review-cases.ts', 'test/plan-review-cases.test.ts'].includes(file);
    const expected = shared ? [...IDS, 'plan-devex-peer-comparison-classification'] : [...IDS];
    if (file === 'test/helpers/plan-review-decisions.ts' || file === 'test/plan-review-decisions.test.ts')
      expected.push('plan-ceo-mode-routing');
    // The UI gate now uses the shared picker for acknowledged native questions.
    if (file === 'test/helpers/plan-review-cases.ts') expected.push('plan-design-with-ui-scope');
    // plan-review-cases.test.ts also verifies the Eng template/renderer gate.
    // Its direct behavioral consumers extend the unchanged helper-only set.
    if (file === 'test/plan-review-cases.test.ts') expected.push(
      'plan-eng-review', 'plan-eng-review-artifact', 'plan-review-report',
      'plan-eng-review-plan-mode', 'plan-mode-no-op', 'conductor-prose',
      'carve-section-loading', 'autoplan-chain-pty', 'plan-eng-finding-floor',
      'plan-eng-review-format-coverage', 'plan-eng-review-format-kind',
      'plan-ceo-review-prosons-cadence', 'plan-review-prosons-format',
      'codex-offered-eng-review', 'codex-plan-eng-format-coverage',
      'codex-plan-eng-format-kind', 'plan-eng-coverage-audit', 'autoplan-dual-voice',
    );
    expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(
      expected.sort());
  }
  for (const id of IDS) expect(E2E_TIERS[id]).toBe('periodic');
  expect(E2E_TOUCHFILES['plan-ceo-finding-count']).toContain('test/skill-e2e-plan-ceo-finding-count.test.ts');
});

test('calibration briefs preserve source-required structure and actual choices without phase/qid reliance', () => {
  const format = fs.readFileSync(path.join(ROOT, 'scripts/resolvers/preamble/generate-ask-user-format.ts'), 'utf8');
  const split = fs.readFileSync(path.join(ROOT, 'docs/askuserquestion-split.md'), 'utf8');
  const ceo = fs.readFileSync(path.join(ROOT, 'plan-ceo-review/sections/review-sections.md.tmpl'), 'utf8');
  for (const token of ['Project/branch/task:', 'ELI10:', 'Stakes if we pick wrong:', 'Recommendation:', 'Pros / cons:', 'Net:']) expect(format).toContain(token);
  const todo = ceo.slice(ceo.indexOf('Only unanswered TODO proposals'), ceo.indexOf('For each TODO, describe:')).replace(/\s+/g, ' ');
  expect(todo).toContain('Only unanswered TODO proposals reach this menu');
  expect(todo).toContain('Do not ask again about an item already deferred, skipped or kept');
  expect(todo).toContain('carry its actual answer and destination forward');
  expect(todo).toContain('Resolve each remaining proposal through all four steps of 0D, using the menu below');
  expect(todo).toContain('Never batch TODOs — one per question');
  for (const token of ['Include', 'Defer', 'Cut', 'Hold']) expect(split).toContain(token);
  const corpus = planDecisionCalibrations();
  expect(corpus).toHaveLength(4);
  for (const calibration of corpus) {
    const prompt = buildPlanReviewDecisionPrompt({ ...calibration.input, deadlineAt: Date.now() + 10000 });
    expect(prompt).toContain('Do not require qid markers');
    expect(prompt).toContain(JSON.stringify(calibration.input.targets));
    for (const fp of calibration.input.fingerprints) {
      expect(fp.preReview).toBe(true);
      expect(fp.selectedOptions).toHaveLength(fp.questions!.length);
      for (const question of fp.questions!) {
        for (const token of ['Project/branch/task:', 'ELI10:', 'Stakes if we pick wrong:', 'Recommendation:', 'Pros / cons:', 'Net:']) expect(question.question).toContain(token);
        expect(question.question).not.toContain('gstack-qid');
      }
    }
  }
  expect(corpus[3].input.fingerprints.map(fp => fp.selectedOptions)).toEqual([[1], [2], [3], [1], [2]]);
});

test('graph calibration uses the original graph target without requiring a payload-fetch change', () => {
  const target = ENG_BATCHING_FINDINGS.find(target => target.id === 'dependency-cache')!;
  expect(target.description).toContain('caching and reusing the dependency graph across retries');
  expect(target.description).toContain('Payload fetching or freshness is a separate policy');
  const corpus = planDecisionCalibrations();
  expect(corpus).toHaveLength(4);
  const negative = corpus.find(calibration => calibration.name === 'bundled-independent-remedies')!;
  expect(negative.input.targets.find(row => row.id === target.id)).toEqual(target);
  expect(negative.expected['graph-cache-with-payload-refresh']).toEqual({ kind: 'finding', targetIds: [target.id], independentDecisions: 1 });
  expect(negative.expected['payload-cache-with-graph-rebuild']).toEqual({ kind: 'finding', targetIds: [], independentDecisions: 1 });
  const prompt = buildPlanReviewDecisionPrompt({ ...negative.input, deadlineAt: Date.now() + 10000 });
  for (const id of ['graph-cache-with-payload-refresh', 'payload-cache-with-graph-rebuild']) {
    const fp = negative.input.fingerprints.find(fp => fp.toolUseId === id)!;
    expect(prompt).toContain(JSON.stringify(fp.questions));
  }
});

async function exercise(mode: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-calibration-free-'));
  const script = path.join(dir, 'calibration.test.ts');
  const receipt = path.join(dir, 'receipt.json');
  fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(ROOT)};
const mode = ${JSON.stringify(mode)};
const { planDecisionCalibrations } = await import(path.join(root, 'test/fixtures/plan-decision-classification.ts'));
const corpus = planDecisionCalibrations();
const bodies = [];
const records = [];
let calls = 0;
let lateResolve;
const now = Date.now;
const timeout = globalThis.setTimeout;
let clock = 0;
let finalizations = 0;
const providerError = new Error('controlled provider failure');
const collector = { addTest(entry) { records.push(entry); }, async finalize() { finalizations++; } };
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  createEvalCollector(tier) { expect(tier).toBe('e2e'); return collector; },
  describeIfSelected(_name, ids, fn) { expect(ids).toEqual(['plan-decision-classification']); if (mode !== 'unselected') fn(); },
  testIfSelected(id, fn, budget) { expect(id).toBe('plan-decision-classification'); expect(budget).toBe(600000); bodies.push(fn); },
}));
function response(calibration) {
  return { questions: calibration.input.fingerprints.flatMap(fp => fp.questions.map((q, i) => ({
    toolUseId: fp.toolUseId, questionIndex: i + 1, ...calibration.expected[fp.toolUseId],
    evidence: [{ field: 'optionLabel', optionIndex: 1, quote: q.options[0].label }],
    reason: 'Ground-truth response supplied by the free provider boundary fixture.',
    optionActions: calibration.input.kind === 'scope'
      ? ['include', 'defer', 'cut', 'hold'].map((action, index) => ({ optionIndex: index + 1, action })) : [],
  }))) };
}
mock.module(path.join(root, 'test/helpers/llm-judge.ts'), () => ({ callJudge: async (prompt, model, options) => {
  const calibration = corpus[calls++];
  expect(model).toBeUndefined();
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(prompt).toContain(JSON.stringify(calibration.input.targets));
  if (mode === 'provider-failure' && calls === 2) throw providerError;
  if (mode === 'malformed' && calls === 1) return {};
  if (mode === 'negative-diagnostic-injection' && calls === 3) {
    const raw = response(calibration);
    raw.questions[1].evidence[0].quote = 'This quote is not present in any native option';
    raw.questions[1].reason = 'bundled independent decisions';
    return raw;
  }
  if (['coupled-overcount', 'test-depth-overcount', 'independent-undercount'].includes(mode) && calls === 3) {
    const raw = response(calibration);
    const id = mode === 'coupled-overcount' ? 'direct-contract-regression'
      : mode === 'test-depth-overcount' ? 'same-behavior-test-depth' : 'independent-code-and-test-policy';
    raw.questions.find(row => row.toolUseId === id).independentDecisions = mode === 'independent-undercount' ? 1 : 2;
    return raw;
  }
  if (['graph-missing-credit', 'payload-spurious-credit'].includes(mode) && calls === 3) {
    const raw = response(calibration);
    const id = mode === 'graph-missing-credit' ? 'graph-cache-with-payload-refresh' : 'payload-cache-with-graph-rebuild';
    raw.questions.find(row => row.toolUseId === id).targetIds = mode === 'graph-missing-credit' ? [] : ['dependency-cache'];
    return raw;
  }
  if (mode === 'deadline') return await new Promise(resolve => { lateResolve = () => resolve(response(calibration)); });
  return response(calibration);
} }));
await import(path.join(root, 'test/skill-e2e-plan-decision-classification.test.ts'));
test('real calibration body preserves outcome and exactly one complete attempt record', async () => {
  if (mode === 'deadline') {
    Date.now = () => clock;
    globalThis.setTimeout = (callback, delay, ...args) => delay >= 120000
      ? timeout(() => { clock += delay; callback(...args); }, 5) : timeout(callback, delay, ...args);
  }
  let failure;
  try { if (bodies[0]) await bodies[0](); } catch (error) { failure = error; }
  finally { Date.now = now; globalThis.setTimeout = timeout; }
  if (mode === 'unselected') {
    expect(bodies).toHaveLength(0); expect(records).toHaveLength(0); expect(calls).toBe(0);
  } else {
    expect(records).toHaveLength(1);
    expect(records[0].passed).toBe(mode === 'success');
    expect(records[0].name).toBe('plan-decision-classification');
    expect(records[0].tier).toBe('e2e');
    expect(records[0].judge_reasoning).toContain('not measured zero spend');
    if (mode === 'success') {
      expect(failure).toBeUndefined(); expect(calls).toBe(4);
      expect(records[0].transcript).toHaveLength(4);
      expect(records[0].transcript.every(trace => trace.passed && trace.prompt && trace.response)).toBe(true);
    } else {
      expect(failure).toBeInstanceOf(Error);
      if (mode === 'provider-failure') { expect(failure).toBe(providerError); expect(calls).toBe(2); expect(records[0].exit_reason).toBe('harness_error'); }
      if (mode === 'malformed') { expect(calls).toBe(1); expect(records[0].exit_reason).toBe('validation_failed'); }
      if (mode === 'negative-diagnostic-injection') {
        expect(calls).toBe(3); expect(records[0].exit_reason).toBe('validation_failed');
        expect(records[0].transcript[2].response.questions[1].reason).toBe('bundled independent decisions');
      }
      if (['coupled-overcount', 'test-depth-overcount', 'independent-undercount'].includes(mode)) {
        expect(calls).toBe(3); expect(records[0].exit_reason).toBe('validation_failed');
        const id = mode === 'coupled-overcount' ? 'direct-contract-regression'
          : mode === 'test-depth-overcount' ? 'same-behavior-test-depth' : 'independent-code-and-test-policy';
        const row = records[0].transcript[2].response.questions.find(row => row.toolUseId === id);
        expect(row.independentDecisions).toBe(mode === 'independent-undercount' ? 1 : 2);
        expect(records[0].transcript[2].passed).toBeUndefined();
      }
      if (['graph-missing-credit', 'payload-spurious-credit'].includes(mode)) {
        expect(calls).toBe(3); expect(records[0].exit_reason).toBe('validation_failed');
        const id = mode === 'graph-missing-credit' ? 'graph-cache-with-payload-refresh' : 'payload-cache-with-graph-rebuild';
        const row = records[0].transcript[2].response.questions.find(row => row.toolUseId === id);
        expect(row.targetIds).toEqual(mode === 'graph-missing-credit' ? [] : ['dependency-cache']);
        expect(records[0].transcript[2].passed).toBeUndefined();
      }
      if (mode === 'deadline') {
        expect(records[0].exit_reason).toBe('timeout'); expect(calls).toBe(1);
        const before = JSON.stringify(records);
        lateResolve(); await Bun.sleep(20);
        expect(JSON.stringify(records)).toBe(before);
        expect(records[0].transcript[0].response).toBeUndefined();
      }
    }
  }
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ calls, records: records.length, passed: records[0]?.passed, exit: records[0]?.exit_reason }));
});
`);
  try {
    const child = Bun.spawn([process.execPath, 'test', script], { cwd: ROOT,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_PREFLIGHT_OK: '1', GSTACK_CLAUDE_CLI_VERSION: 'free calibration fixture' }, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, out + err).toBe(0);
      return JSON.parse(fs.readFileSync(receipt, 'utf8'));
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test.each(['success', 'provider-failure', 'malformed', 'negative-diagnostic-injection', 'coupled-overcount', 'test-depth-overcount', 'independent-undercount', 'graph-missing-credit', 'payload-spurious-credit', 'deadline', 'unselected'])('calibration attempt outcome stays accurate: %s', async mode => {
  const result = await exercise(mode);
  expect(result.records).toBe(mode === 'unselected' ? 0 : 1);
}, 15000);
