import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

// Import the real five paid bodies in a separate process, before invoking any
// callback. Only provider/selection boundaries are stubbed; recordE2E is loaded
// from its actual source so default pass criteria and metadata stay covered.
async function exerciseCases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpa-recording-'));
  const script = path.join(dir, 'recording-fixture.test.ts');
  const facts = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = ${JSON.stringify(ROOT)};
const factsPath = ${JSON.stringify(facts)};
const { CLAUDE_FRONTIER_EVAL_MODEL } = await import(path.join(root, 'lib/eval-model.ts'));
const readFile = fs.readFileSync.bind(fs);
const recoveryResponses = JSON.parse(readFile(path.join(root, 'test/fixtures/third-party-actions-recovery-public.json'), 'utf8')).responses;
const writeFile = fs.writeFileSync.bind(fs);
const remove = fs.rmSync.bind(fs);
const source = readFile(path.join(root, 'test/helpers/e2e-helpers.ts'), 'utf8');
const start = source.indexOf('export function recordE2E(');
const end = source.indexOf('/**', start);
if (start < 0 || end < 0) throw new Error('recordE2E source boundary missing');
const recordSource = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end).replace('export function', 'function'));
const recordE2E = new Function(recordSource + '\\nreturn recordE2E;')();
const cases = new Map();
const records = [];
const facts = [];
let mode = 'pass';
let text = '';
let result;
let runnerCalls = 0;
let recordCalls = 0;
let recordThrows = false;
let selected = true;
const runnerError = new Error('fixture runner failed');
const fixtureError = new Error('fixture contract read failed');
const cleanupError = new Error('fixture cleanup failed');
const recordingError = new Error('fixture recorder failed');
let forwardCollector;
const collector = { addTest(entry) {
  recordCalls++;
  records.push(entry);
  forwardCollector?.addTest(entry);
  if (recordThrows) throw recordingError;
} };
mock.module('fs', () => ({ ...fs, readFileSync(file, ...args) {
  if ((mode === 'fixture' && String(file) === path.join(root, 'ship/SKILL.md')) ||
      (mode === 'apple-doc' && String(file) === path.join(root, 'ship/sections/apple-release.md'))) throw fixtureError;
  return readFile(file, ...args);
}, rmSync(file, ...args) {
  const value = remove(file, ...args);
  if (mode === 'cleanup' && path.basename(String(file)).startsWith('tpa-e2e-')) throw cleanupError;
  return value;
} }));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({
  runSkillTest: async (opts) => {
    runnerCalls++;
    if (opts.maxTurns !== 8 || opts.timeout !== 240000 || opts.model !== undefined ||
        JSON.stringify(opts.allowedTools) !== JSON.stringify(['Read', 'Bash'])) throw new Error('paid runner policy changed');
    if (mode === 'runner') throw runnerError;
    if (mode === 'undefined') throw undefined;
    result = {
      toolCalls: [{ tool: 'Bash', input: { command: 'fixture readiness probe' }, output: 'fixture' }],
      browseErrors: mode === 'browse-error' ? ['existing browse failure'] : [],
      exitReason: mode === 'exit' ? 'timeout' : 'success', duration: 123,
      output: 'x'.repeat(2100),
      transcript: [{ type: 'assistant', message: { content: [{ type: 'text', text }] } }],
      costEstimate: { inputChars: 70, outputChars: 2100, estimatedTokens: 19, estimatedCost: 0.37, turnsUsed: 3 },
      model: 'claude-sonnet-4-6', firstResponseMs: 7, maxInterTurnMs: 11,
    };
    return result;
  },
}));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  ROOT: root, runId: 'free-tpa-fixture', createEvalCollector: () => collector,
  describeIfSelected: (_name, _ids, body) => { if (selected) body(); },
  testIfSelected: (name, body, timeout) => {
    if (timeout !== 360000) throw new Error('paid Bun budget changed');
    cases.set(name, body);
  },
  logCost: () => {}, recordE2E, finalizeEvalCollector: async () => {},
}));
await import(path.join(root, 'test/skill-e2e-third-party-actions.test.ts'));
const positives = {
  'tpa-present': 'A) Aside for dashboard.acme.test. D) defer.',
  'tpa-absent-linux': "A) gstack's own visible browser B) manual instructions C) defer.",
  'tpa-broken': 'Please open the Aside app.',
  'tpa-absent-darwin': 'Download it at aside.com (macOS 15+).',
  'tpa-apple-ban': 'Generate the app-specific password on any device with fastlane-credentials.',
};
const negatives = {
  'tpa-present': ['A) dashboard.acme.test D) defer', 'Aside dashboard.acme.test defer', 'A) Aside dashboard.acme.test', 'A) Aside D) defer', 'A) Aside dashboard.acme.test D) defer; download it at aside.com'],
  'tpa-absent-linux': ["A) gstack's own visible browser B) manual; download it at aside.com", "A) Drive it in your Aside browser B) manual in gstack's own visible browser", "gstack's own visible browser; manual", "A) gstack's own visible browser", 'A) manual instructions'],
  'tpa-broken': ["A) Open the Aside app, then I will recheck and drive it in your Aside browser", 'No current question.'],
  'tpa-absent-darwin': ['Aside for macOS 15+', 'Download it at aside.com', 'A) Drive it in your Aside browser; Download it at aside.com (macOS 15+)'],
  'tpa-apple-ban': ['A) drive it; generate an app-specific password', 'Generate an app-specific password; drive account.apple.com', 'Generate credentials on any device', 'app-specific password'],
};
async function invoke(name, kind, output, throwRecording = false) {
  mode = kind; text = output; result = undefined; runnerCalls = 0; recordCalls = 0; recordThrows = throwRecording;
  records.length = 0;
  let failed = false; let error;
  try { await cases.get(name)(); } catch (caught) { failed = true; error = caught; }
  const created = fs.readdirSync(${JSON.stringify(dir)}).filter(name => name.startsWith('tpa-e2e-'));
  return { failed, error, entry: records[0], records: [...records], runnerCalls, recordCalls, created, result };
}
test('actual paid assertion boundaries and all failure stages retain one accurate record', async () => {
  expect([...cases.keys()]).toEqual(Object.keys(positives));
  const liveFailure = await invoke('tpa-broken', 'assertion', negatives['tpa-broken'][0]);
  expect(liveFailure.failed).toBe(true);
  expect(liveFailure.records).toHaveLength(1);
  expect(liveFailure.entry.passed).toBe(false);
  for (const [name, positive] of Object.entries(positives)) {
    for (const [kind, output] of [['pass', positive], ['exit', positive], ['runner', positive], ['fixture', positive], ...negatives[name].map(value => ['assertion', value])]) {
      const observed = await invoke(name, kind, output);
      facts.push({ name, kind, failed: observed.failed, records: observed.records.length, passed: observed.entry?.passed });
      expect(observed.failed, name + ':' + kind).toBe(kind !== 'pass');
      expect(observed.records, name + ':' + kind).toHaveLength(1);
      expect(observed.recordCalls).toBe(1);
      expect(observed.entry).toMatchObject({ name, suite: 'e2e-third-party-actions', tier: 'e2e', passed: kind === 'pass' });
      expect(observed.created).toEqual([]);
      if (kind === 'runner' || kind === 'fixture') {
        expect(observed.error).toBe(kind === 'runner' ? runnerError : fixtureError);
        expect(observed.entry).toMatchObject({ exit_reason: 'harness_error', cost_usd: 0, model: CLAUDE_FRONTIER_EVAL_MODEL });
        expect(observed.entry.error).toContain('cost and usage unavailable');
        expect(observed.entry.transcript).toBeUndefined();
        expect(observed.runnerCalls).toBe(kind === 'runner' ? 1 : 0);
      } else {
        expect(observed.entry).toMatchObject({ duration_ms: 123, cost_usd: 0.37, turns_used: 3, tokens_used: 19, model: 'claude-sonnet-4-6', first_response_ms: 7, max_inter_turn_ms: 11 });
        expect(observed.entry.output).toHaveLength(2000);
        expect(observed.entry.transcript).toEqual(observed.result.transcript);
        expect(observed.entry.exit_reason).toBe(observed.result.exitReason);
        expect(observed.entry.last_tool_call).toContain('fixture readiness probe');
        if (kind !== 'pass') expect(observed.entry.error).toBeTruthy();
      }
    }
    const browse = await invoke(name, 'browse-error', positive);
    expect(browse.failed).toBe(false);
    expect(browse.entry).toMatchObject({ passed: false, browse_errors: ['existing browse failure'] });
    expect(browse.recordCalls).toBe(1);
  }
  // An unavailable-option explanation remains a passing attempt; only a real
  // consent offer is forbidden by the updated contract assertion.
  const narration = await invoke('tpa-absent-darwin', 'pass',
    'Download it at aside.com (macOS 15+). Driving in your Aside browser is unavailable.');
  expect(narration.failed).toBe(false);
  expect(narration.entry.passed).toBe(true);
  expect(narration.recordCalls).toBe(1);
  for (const response of recoveryResponses) {
    for (const [output, passed] of [
      [response.text, true],
      [response.text.replace('option included.', 'option included; then I drive in your Aside browser.'), false],
    ]) {
      const observed = await invoke('tpa-broken', 'pass', output);
      expect(observed.failed).toBe(!passed);
      expect(observed.entry.passed).toBe(passed);
      expect(observed.recordCalls).toBe(1);
      expect(observed.entry.transcript).toEqual(observed.result.transcript);
    }
  }
  // A runner/setup exception has no returned model. Mirror the same capture
  // resolution that the real session runner would have used, including overrides.
  for (const [overrides, expected] of [
    [{}, CLAUDE_FRONTIER_EVAL_MODEL],
    [{ GSTACK_EVAL_MODEL: 'global-model' }, 'global-model'],
    [{ GSTACK_EVAL_MODEL: 'global-model', GSTACK_EVAL_MODEL_CAPTURE: 'capture-model' }, 'capture-model'],
    [{ GSTACK_EVAL_MODEL: 'global-model', GSTACK_EVAL_MODEL_CAPTURE: 'capture-model', EVALS_MODEL: 'evals-model' }, 'evals-model'],
  ]) {
    for (const key of ['EVALS_MODEL', 'GSTACK_EVAL_MODEL', 'GSTACK_EVAL_MODEL_CAPTURE']) delete process.env[key];
    Object.assign(process.env, overrides);
    const observed = await invoke('tpa-broken', 'runner', positives['tpa-broken']);
    expect(observed.failed).toBe(true);
    expect(observed.recordCalls).toBe(1);
    expect(observed.entry).toMatchObject({ passed: false, exit_reason: 'harness_error', model: expected });
  }
  for (const key of ['EVALS_MODEL', 'GSTACK_EVAL_MODEL', 'GSTACK_EVAL_MODEL_CAPTURE']) delete process.env[key];
  const doc = await invoke('tpa-apple-ban', 'apple-doc', positives['tpa-apple-ban']);
  expect(doc.error).toBe(fixtureError);
  expect(doc.entry).toMatchObject({ passed: false, exit_reason: 'harness_error' });
  expect(doc.recordCalls).toBe(1);
  expect(doc.runnerCalls).toBe(0);
  const cleanup = await invoke('tpa-broken', 'cleanup', positives['tpa-broken']);
  expect(cleanup.error).toBe(cleanupError);
  expect(cleanup.recordCalls).toBe(1);
  expect(cleanup.records).toHaveLength(1);
  expect(cleanup.entry).toMatchObject({ passed: false, cost_usd: 0.37, duration_ms: 123 });
  expect(cleanup.entry.transcript).toEqual(cleanup.result.transcript);
  expect(cleanup.created).toEqual([]);
  const undef = await invoke('tpa-broken', 'undefined', positives['tpa-broken']);
  expect(undef.failed).toBe(true);
  expect(undef.error).toBeUndefined();
  expect(undef.entry.passed).toBe(false);
  expect(undef.recordCalls).toBe(1);
  for (const kind of ['pass', 'runner', 'assertion']) {
    const observed = await invoke('tpa-broken', kind, kind === 'assertion' ? negatives['tpa-broken'][0] : positives['tpa-broken'], true);
    expect(observed.failed).toBe(true);
    expect(observed.recordCalls).toBe(1);
    expect(observed.records).toHaveLength(1);
    if (kind === 'pass') expect(observed.error).toBe(recordingError);
    else {
      expect(observed.error).toBeInstanceOf(AggregateError);
      expect(observed.error.errors).toHaveLength(2);
      expect(observed.error.errors[1]).toBe(recordingError);
      if (kind === 'runner') expect(observed.error.errors[0]).toBe(runnerError);
      else expect(observed.error.errors[0].message).toContain('in your Aside browser');
    }
  }
  const { EvalCollector } = await import(path.join(root, 'test/helpers/eval-store.ts'));
  forwardCollector = new EvalCollector('e2e', path.join(${JSON.stringify(dir)}, 'actual-collector'));
  await invoke('tpa-broken', 'assertion', negatives['tpa-broken'][0]);
  await invoke('tpa-broken', 'pass', positives['tpa-broken']);
  const saved = JSON.parse(readFile(await forwardCollector.finalize(), 'utf8'));
  expect(saved.tests.map(entry => [entry.name, entry.attempt, entry.passed, entry.cost_usd])).toEqual([
    ['tpa-broken', 1, false, 0.37], ['tpa-broken', 2, true, 0.37],
  ]);
  expect(saved.flaky_retries).toEqual([{ name: 'tpa-broken', attempts: 2 }]);
  forwardCollector = undefined;
  selected = false; cases.clear(); runnerCalls = 0; recordCalls = 0;
  await import(path.join(root, 'test/skill-e2e-third-party-actions.test.ts') + '?unselected');
  expect(cases.size).toBe(0);
  expect(runnerCalls).toBe(0);
  expect(recordCalls).toBe(0);
  writeFile(factsPath, JSON.stringify(facts));
});
`);
  try {
    const childEnv = { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_PREFLIGHT_OK: '1',
      GSTACK_CLAUDE_CLI_VERSION: 'free TPA fixture',
      HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir, GSTACK_EVAL_DIR: path.join(dir, 'evals') };
    for (const key of ['EVALS_MODEL', 'GSTACK_EVAL_MODEL', 'GSTACK_EVAL_MODEL_CAPTURE']) delete childEnv[key];
    const proc = Bun.spawn([process.execPath, 'test', script], {
      cwd: ROOT,
      env: childEnv,
      stdout: 'pipe', stderr: 'pipe',
    });
    const stop = () => { if (proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch {} } };
    const timeout = setTimeout(stop, 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      return { code, output: stdout + stderr, facts: fs.existsSync(facts) ? JSON.parse(fs.readFileSync(facts, 'utf8')) : [] };
    } finally {
      clearTimeout(timeout);
      stop();
      await proc.exited;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('TPA records the real paid case outcome once after all existing assertions', async () => {
  const observed = await exerciseCases();
  expect(observed.code, observed.output).toBe(0);
  expect(observed.facts).toHaveLength(39);
  expect(observed.facts.filter((entry: any) => entry.passed)).toHaveLength(5);
}, 20_000);
