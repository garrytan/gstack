import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { devexPeerAnalysisCalibrations } from './fixtures/devex-peer-comparison-classification';
import { E2E_TOUCHFILES, E2E_TIERS, selectTests } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');
const ID = 'plan-devex-peer-comparison-classification';

test('DX artifact calibrations keep four acknowledged choices and vary only comparative analysis', () => {
  const corpus = devexPeerAnalysisCalibrations();
  expect(corpus).toHaveLength(3);
  expect(corpus.map(row => !!row.rejection)).toEqual([false, true, true]);
  for (const calibration of corpus) {
    expect(calibration.input.fingerprints).toHaveLength(4);
    expect(calibration.input.fingerprints.map(fp => fp.selectedOptions)).toEqual([[1], [1], [1], [1]]);
    expect(calibration.input.fingerprints).toEqual(corpus[0].input.fingerprints);
    expect(calibration.input.plan).toBe(corpus[0].input.plan);
    expect(calibration.input.targets).toEqual(corpus[0].input.targets);
    expect(calibration.input.targets.map(row => row.id)).toEqual(['persona', 'first-run-benchmark', 'mandatory-ci', 'aha', 'peer-comparison']);
    expect(Object.keys(calibration.expected)).toEqual(['persona', 'first-run-benchmark', 'mandatory-ci', 'aha']);
    expect(calibration.input.floor).toBe(4);
    expect(calibration.input.ceiling).toBe(7);
  }
});

test('the separate DX calibration has a canonical periodic selector and all direct fixture inputs', () => {
  expect(E2E_TIERS[ID]).toBe('periodic');
  for (const file of [`test/skill-e2e-${ID}.test.ts`, 'test/fixtures/devex-peer-comparison-classification.ts',
    'test/devex-peer-comparison-calibration.test.ts']) {
    expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual([ID]);
  }
  for (const file of ['test/helpers/plan-review-decisions.ts', 'test/helpers/plan-review-cases.ts',
    'test/helpers/llm-judge.ts', 'lib/eval-model.ts']) {
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toContain(ID);
  }
});

async function exercise(mode: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devex-calibration-free-'));
  const script = path.join(dir, 'calibration.test.ts');
  const receipt = path.join(dir, 'receipt.json');
  fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(ROOT)};
const mode = ${JSON.stringify(mode)};
const { devexPeerAnalysisCalibrations, groundedPeerEvidence } = await import(path.join(root, 'test/fixtures/devex-peer-comparison-classification.ts'));
const corpus = devexPeerAnalysisCalibrations();
const bodies = [];
const records = [];
let calls = 0;
let lateResolve;
let lastSignal;
const now = Date.now;
const timeout = globalThis.setTimeout;
let clock = 0;
const providerError = new Error('controlled provider failure on negative calibration');
const collector = { addTest(entry) { records.push(entry); }, async finalize() {} };
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  createEvalCollector(tier) { expect(tier).toBe('e2e'); return collector; },
  describeIfSelected(_name, ids, fn) { expect(ids).toEqual(['${ID}']); if (mode !== 'unselected') fn(); },
  testIfSelected(id, fn, budget) { expect(id).toBe('${ID}'); expect(budget).toBe(600000); bodies.push(fn); },
}));
function response(calibration) {
  return { questions: calibration.input.fingerprints.flatMap(fp => fp.questions.map((q, i) => ({
    toolUseId: fp.toolUseId, questionIndex: i + 1, ...calibration.expected[fp.toolUseId],
    evidence: [{ field: 'optionLabel', optionIndex: 1, quote: q.options[0].label }],
    reason: 'Free boundary fixture supplies the expected question classification.', optionActions: [],
  }))), devexPeerComparison: calibration.rejection ? {
    status: 'missing', peers: [], productQuote: '', groundingQuote: '', implicationQuote: '',
    reason: 'This analysis lacks supported comparative evidence for the selected developer journey.',
  } : structuredClone(groundedPeerEvidence) };
}
mock.module(path.join(root, 'test/helpers/llm-judge.ts'), () => ({ callJudge: async (prompt, model, options) => {
  const calibration = corpus[calls++];
  expect(model).toBeUndefined();
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(options.max_tokens).toBe(16384);
  lastSignal = options.signal;
  expect(prompt).toContain(JSON.stringify(calibration.input.fingerprints[0].questions));
  expect(prompt).toContain(JSON.stringify(calibration.input.devexPeerComparison.finalPlan));
  expect(prompt).toContain(JSON.stringify(calibration.input.targets.filter(row => row.id !== 'peer-comparison')));
  if (mode === 'provider-failure' && calls === 2) throw providerError;
  const raw = response(calibration);
  if (mode === 'malformed-negative' && calls === 2) delete raw.devexPeerComparison.groundingQuote;
  if (mode === 'forged-negative-evidence' && calls === 2) {
    raw.devexPeerComparison.peers = [{ name: 'PythonPeer', quote: 'PythonPeer has a nonexistent audited benchmark.' }];
  }
  if (mode === 'wrong-question-on-negative' && calls === 2) raw.questions[0].targetIds = [];
  if (mode === 'false-negative' && calls === 1) raw.devexPeerComparison = {
    status: 'missing', peers: [], productQuote: '', groundingQuote: '', implicationQuote: '', reason: 'Controlled false negative.',
  };
  if (mode === 'false-positive' && calls === 3) raw.devexPeerComparison = {
    status: 'complete', peers: [
      { name: 'PythonPeer', quote: 'PythonPeer measured TTHW: 3 seconds. Source: refs/pythonpeer.md.' },
      { name: 'CliPeer', quote: 'CliPeer measured TTHW: 2 seconds. Source: refs/clipeer.md.' },
      { name: 'HostedPeer', quote: 'HostedPeer measured TTHW: 1 second. Source: refs/hostedpeer.md.' },
    ], productQuote: 'Our SDK measured TTHW: 0.5 seconds including its mandatory five-minute precheck.',
    groundingQuote: 'These are actual measured durations, not estimates; no timing run or measurement record exists beyond the cited quickstarts.',
    implicationQuote: 'The Python app developer should prefer our SDK because its measured first run is the fastest.',
    reason: 'Controlled semantic false positive with locally valid exact quotes.',
  };
  if (mode === 'deadline') return await new Promise(resolve => { lateResolve = () => resolve(raw); });
  return raw;
} }));
await import(path.join(root, 'test/skill-e2e-${ID}.test.ts'));
test('real paid registration records the semantic outcome without provider or shape failures earning credit', async () => {
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
    expect(records[0].name).toBe('${ID}');
    expect(records[0].tier).toBe('e2e');
    expect(records[0].judge_reasoning).toContain('not measured zero spend');
    if (mode === 'success') {
      expect(failure).toBeUndefined(); expect(calls).toBe(3);
      expect(records[0].transcript).toHaveLength(3);
      expect(records[0].transcript.every(trace => trace.passed && trace.prompt && trace.response)).toBe(true);
    } else {
      expect(failure).toBeInstanceOf(Error);
      if (mode === 'provider-failure') {
        expect(failure).toBe(providerError); expect(calls).toBe(2); expect(records[0].exit_reason).toBe('harness_error');
      } else if (mode === 'deadline') {
        expect(calls).toBe(1); expect(lastSignal.aborted).toBe(true); expect(records[0].exit_reason).toBe('timeout');
        const before = JSON.stringify(records);
        lateResolve(); await Bun.sleep(20);
        expect(JSON.stringify(records)).toBe(before);
        expect(records[0].transcript[0].response).toBeUndefined();
      } else {
        expect(calls).toBe(mode === 'false-negative' ? 1 : mode === 'false-positive' ? 3 : 2);
        expect(records[0].exit_reason).toBe('validation_failed');
        expect(records[0].transcript.at(-1).passed).toBeUndefined();
      }
    }
  }
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ calls, records: records.length, passed: records[0]?.passed, exit: records[0]?.exit_reason }));
});
`);
  try {
    const child = Bun.spawn([process.execPath, 'test', script], { cwd: ROOT,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_PREFLIGHT_OK: '1', GSTACK_CLAUDE_CLI_VERSION: 'free DX calibration fixture' }, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, out + err).toBe(0);
      return JSON.parse(fs.readFileSync(receipt, 'utf8'));
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test.each(['success', 'provider-failure', 'malformed-negative', 'forged-negative-evidence', 'wrong-question-on-negative',
  'false-negative', 'false-positive', 'deadline', 'unselected'])('DX calibration keeps the actual attempt outcome: %s', async mode => {
  const result = await exercise(mode);
  expect(result.records).toBe(mode === 'unselected' ? 0 : 1);
}, 15000);
