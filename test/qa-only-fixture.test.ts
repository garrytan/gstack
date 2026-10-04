import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');

test('QA-only fixture helpers and owned sections select the no-fix consumer', () => {
  expect(selectTests(['test/fixtures/qa-only-observation-public.json'], E2E_TOUCHFILES).selected).toEqual(['qa-only-no-fix']);
  for (const file of ['test/helpers/qa-browser-deadline-evidence.ts', 'test/fixtures/qa-only-browser-probe.ts', 'test/helpers/qa-only-cleanup.ts']) {
    expect(selectTests([file], E2E_TOUCHFILES).selected.sort()).toEqual(['qa-bootstrap', 'qa-fix-loop', 'qa-only-no-fix', 'qa-quick']);
  }
  expect(selectTests(['browse/test/fixtures/qa-only.html'], E2E_TOUCHFILES).selected).toEqual([
    'aside-browse-basic', 'aside-browse-flow', 'qa-only-no-fix', 'carve-section-loading-browse',
  ]);
  expect(selectTests(['qa/sections/scope.md'], E2E_TOUCHFILES).selected).toContain('qa-only-no-fix');
});

test.each(['success', 'max-turns', 'dependencies', 'metadata', 'edit', 'source-write', 'source-delete', 'source-add', 'setup', 'runner', 'recording', 'runner-recording', 'artifact-error',
  'process-error', 'slow-setup', 'exhausted-setup', 'late-timeout', 'late-retry', 'late-failure-retry', 'unknown-timeout',
  'cleanup', 'cleanup-retry', 'runner-cleanup', 'cleanup-recording', 'remove-error', 'server-stop',
  'missing-deadline', 'unguarded-probe', 'forged-receipt', 'deadline-write', 'reset-deadline',
  'preparation-missing', 'preparation-failed', 'preparation-unacknowledged', 'preparation-wrong-path', 'preparation-late',
  'preparation-subagent', 'preparation-crossed-parent', 'preparation-empty', 'preparation-delayed-ack'])('the registered QA-only attempt owns setup, recording and cleanup: %s', scenario => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-only-body-'));
  const script = path.join(dir, 'body.fixture.test.ts');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(script, `
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = ${JSON.stringify(ROOT)}, scenario = ${JSON.stringify(scenario)};
const directories = [], attempts = [], records = [], servers = [], cleanups = [];
const { stopQaOnlyBrowser } = await import(path.join(root, 'test/helpers/qa-only-cleanup.ts'));
mock.module(path.join(root, 'test/helpers/qa-only-cleanup.ts'), () => ({ stopQaOnlyBrowser: async (cwd, budget) => {
  const artifact = attempts.at(-1) && path.join(${JSON.stringify(dir)}, 'e2e-runs', attempts.at(-1).runId, 'qa-reports/qa-only-report.md');
  const fact = { cwd, budget, done: false, artifactExists: !!artifact && fs.existsSync(artifact) };
  cleanups.push(fact);
  try { await stopQaOnlyBrowser(cwd, budget); } finally { fact.done = true; }
} }));
const originalRm = fs.rmSync;
if (scenario === 'remove-error') spyOn(fs, 'rmSync').mockImplementation((target, options) => {
  if (directories.includes(target)) throw new Error('QA-only removal failed');
  return originalRm(target, options);
});
mock.module(path.join(root, 'test/helpers/eval-store.ts'), () => ({ getProjectEvalDir: () => ${JSON.stringify(path.join(dir, 'evals'))} }));
const late = scenario.startsWith('late-'), workMs = 1000, drainMs = 80;
const realNow = Date.now, controlledClock = ['slow-setup', 'exhausted-setup'].includes(scenario);
const clockStart = realNow();
let clock = clockStart;
if (controlledClock) Date.now = () => clock;
let finalized = false, outerMs;
const collector = { addTest: row => {
  const cwd = directories.at(-1);
  records.push({ ...row, elapsedMs: Date.now() - clockStart, afterFinalization: finalized, fixtureExists: fs.existsSync(cwd), serverStopped: servers.at(-1).stopped, cleanupDone: cleanups.at(-1)?.done });
  if (['recording', 'runner-recording', 'cleanup-recording'].includes(scenario)) throw new Error('QA-only recorder failed');
} };
mock.module(path.join(root, 'test/helpers/aside-available.ts'), () => ({ asideAvailable: () => false }));
mock.module(path.join(root, 'browse/test/test-server.ts'), () => ({ startTestServer: () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('owned test server') });
  const fact = { stopped: false, url: 'http://127.0.0.1:' + server.port };
  const stop = server.stop.bind(server);
  server.stop = () => { fact.stopped = true; stop(true); if (scenario === 'server-stop') throw new Error('QA-only server stop failed'); };
  servers.push(fact);
  fact.cleanup = () => stop(true);
  return { server, url: fact.url };
} }));
if (late) mock.module(path.join(root, 'test/helpers/eval-budgets.ts'), () => ({
  JUDGE_MS: 120000, CAPTURE_MS: workMs, CAPTURE_LONG_MS: 600000,
}));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  ROOT: root, browseBin: process.execPath, runId: 'qa-only-free', evalsEnabled: true, selectedTests: ['qa-only-no-fix'],
  describeIfSelected: (name, ids, body) => { if (ids.includes('qa-only-no-fix')) describe(name, body); },
  testConcurrentIfSelected: (id, body, budget) => {
    if (id !== 'qa-only-no-fix') return;
    outerMs = budget;
    const deadline = late ? (budget >= workMs + 5000 ? budget - 5000 + 500 : budget) : 5000;
    test(id, body, deadline);
  },
  copyDirSync: (source, target) => {
    if (scenario === 'setup') throw new Error('QA-only setup failed');
    fs.cpSync(source, target, { recursive: true });
  },
  setupBrowseShims: cwd => {
    directories.push(cwd); fs.mkdirSync(path.join(cwd, 'browse/bin'), { recursive: true });
    if (controlledClock) clock += scenario === 'slow-setup' ? 295000 : 300000;
  },
  logCost() {}, createEvalCollector: () => collector, finalizeEvalCollector: async () => { finalized = true; },
  recordE2E: (_collector, name, suite, result, extra) => collector.addTest({ name, suite,
    exit_reason: result.exitReason, model: result.model, cost_usd: result.costEstimate.estimatedCost,
    transcript: result.transcript, ...extra }),
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({
  SESSION_DRAIN_GRACE_MS: late ? drainMs : 5000,
  runSkillTest: async options => {
    const cwd = options.workingDirectory;
    const fact = { cwd, exists: fs.existsSync(cwd), recordedBeforeCapture: records.length,
      reportBefore: fs.existsSync(path.join(cwd, 'qa-reports/qa-only-report.md')), captureMs: options.timeout,
      runId: options.runId, publicStreamDiagnostics: options.publicStreamDiagnostics };
    attempts.push(fact);
    expect(options.maxTurns).toBe(40);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(late ? workMs : 300000);
    expect(options.tools).toEqual(['Bash', 'Read', 'Write', 'Glob']);
    expect(options.allowedTools).toEqual(options.tools);
    const result = { exitReason: 'success', model: 'fixture-model', toolCalls: [],
      costEstimate: { estimatedCost: 0.25 }, transcript: [{ type: 'result', total_cost_usd: 0.25 }] };
    if (!fact.exists) return { ...result, exitReason: 'exit_code_1' };
    fact.initial = fs.readFileSync(path.join(cwd, 'index.html'), 'utf8');
    if (['cleanup', 'runner-cleanup', 'cleanup-recording'].includes(scenario) || scenario === 'cleanup-retry' && attempts.length === 1) {
      fs.mkdirSync(path.join(cwd, '.gstack'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.gstack/browse.json'), '{}');
    }
    if (['runner', 'runner-recording', 'runner-cleanup'].includes(scenario)) throw new Error('QA-only runner failed');
    if (scenario === 'dependencies') {
      for (const relative of ['qa/sections/scope.md', 'qa/sections/browser-setup.md', 'qa/sections/qa-patterns.md',
        'qa/sections/system-functional.md', 'qa/sections/exploratory.md', 'qa-only/sections/exploratory.md',
        'qa/templates/qa-report-template.md', 'qa/templates/functional-report-template.md']) {
        expect(fs.readFileSync(path.join(cwd, relative), 'utf8')).toBe(fs.readFileSync(path.join(root, relative), 'utf8'));
      }
      expect(options.prompt).toContain('owned installed skill assets');
      for (const directory of ['qa/sections', 'qa-only/sections', 'qa/templates']) expect(options.prompt).toContain(path.join(cwd, directory));
      expect(options.prompt).toContain('Do not discover or read an ambient skill installation');
      expect(options.prompt).toContain(path.join(root, 'bin', 'gstack-qa-deadline'));
      expect(options.prompt).toContain('never replace or edit it directly');
      expect(options.prompt).toContain('Scope this run to homepage load and console health');
      expect(options.prompt).toContain('Preserve that decoded object in checkpoints');
      expect(options.prompt).toContain(path.join(cwd, 'fixture-browser-probe.ts'));
      expect(fs.readFileSync(path.join(cwd, 'fixture-browser-probe.ts'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'test/fixtures/qa-only-browser-probe.ts'), 'utf8'));
    }
    fs.mkdirSync(path.join(cwd, 'qa-reports'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'qa-reports/qa-only-report.md'), 'owned report');
    const reportCall = { tool: 'Write', input: {
      file_path: path.join(cwd, 'qa-reports', scenario === 'preparation-wrong-path' ? 'other.md' : 'qa-only-report.md'),
      content: scenario === 'preparation-empty' ? ' ' : 'owned report',
    }, output: 'Write completed' };
    if (scenario !== 'preparation-missing') result.toolCalls.push(reportCall);
    fs.writeFileSync(path.join(cwd, 'qa-reports/checkpoint.json'), JSON.stringify({ attempt: attempts.length }));
    if (scenario === 'artifact-error') fs.writeFileSync(${JSON.stringify(path.join(dir, 'e2e-runs'))}, 'blocked artifact directory');
    if (scenario === 'slow-setup') {
      clock += options.timeout + 5000;
      fact.existsAfterDrain = fs.existsSync(cwd);
      return { ...result, exitReason: 'timeout' };
    }
    if (late && (scenario !== 'late-retry' || attempts.length === 1)) {
      await new Promise(resolve => setTimeout(resolve, options.timeout + drainMs));
      fact.existsAfterDrain = fs.existsSync(cwd);
      return { ...result, exitReason: 'timeout' };
    }
    if (scenario === 'unknown-timeout') return { ...result, exitReason: 'timeout', costEstimate: { estimatedCost: 0 }, transcript: [] };
    if (scenario === 'edit') result.toolCalls.push({ tool: 'Edit', input: { file_path: path.join(cwd, 'index.html') } });
    if (scenario === 'source-write') {
      fs.writeFileSync(path.join(cwd, 'index.html'), 'modified source');
      result.toolCalls.push({ tool: 'Write', input: { file_path: path.join(cwd, 'index.html') } });
    }
    if (scenario === 'source-delete') fs.unlinkSync(path.join(cwd, 'index.html'));
    if (scenario === 'source-add') fs.writeFileSync(path.join(cwd, 'new-product-file.html'), 'unexpected product file');
    if (scenario === 'max-turns') result.exitReason = 'error_max_turns';
    if (scenario === 'process-error') result.exitReason = 'exit_code_1';
    if (scenario !== 'missing-deadline') {
      const guard = path.join(root, 'bin/gstack-qa-deadline'), deadline = path.join(cwd, 'qa-reports/deadline.json');
      if (scenario === 'metadata') {
        for (const args of [['rev-parse', 'HEAD'], ['rev-parse', '--short', 'HEAD'], ['log', '-1', '--format=%cI'], ['branch', '--show-current']]) {
          expect(fs.existsSync(deadline)).toBe(false);
          const child = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
          expect(child.error).toBeUndefined();
          expect(child.status, child.stderr).toBe(0);
          expect(child.stdout.trim().length).toBeGreaterThan(0);
          result.toolCalls.push({ tool: 'Bash', input: { command: "git -C '" + cwd + "' " + args.join(' ') }, output: child.stdout + child.stderr });
        }
      }
      const invoke = args => {
        const child = spawnSync(process.execPath, [guard, ...args], { cwd, encoding: 'utf8', timeout: 5000 });
        if (child.error) throw child.error;
        expect(child.status, child.stderr).toBe(0);
        result.toolCalls.push({ tool: 'Bash', input: { command: [process.execPath, guard, ...args].map(arg => JSON.stringify(arg)).join(' ') }, output: child.stdout + child.stderr });
      };
      invoke(['start', deadline, '30']);
      invoke(['run', deadline, '--', process.execPath, '--version']);
      if (scenario === 'unguarded-probe') result.toolCalls.push({ tool: 'Bash', input: { command: process.execPath + ' --version' }, output: 'bare probe' });
      if (scenario === 'forged-receipt') result.toolCalls.at(-1).output = result.toolCalls.at(-1).output.replace('"budgetMs":30000', '"budgetMs":90000');
      if (scenario === 'deadline-write') result.toolCalls.push({ tool: 'Write', input: { file_path: deadline }, output: '' });
      if (scenario === 'reset-deadline') { fs.unlinkSync(deadline); invoke(['start', deadline, '30']); }
    }
    if (scenario === 'preparation-late') { result.toolCalls.splice(result.toolCalls.indexOf(reportCall), 1); result.toolCalls.push(reportCall); }
    const publicEvents = result.toolCalls.flatMap((call, index) => {
      const id = 'native-' + index, isReport = call === reportCall;
      const parent = isReport && scenario === 'preparation-subagent' ? 'child' : null;
      return [{ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: call.tool, input: call.input }] } },
        ...(isReport && scenario === 'preparation-unacknowledged' ? [] : [{ type: 'user',
          parent_tool_use_id: isReport && scenario === 'preparation-crossed-parent' ? 'child' : parent,
          message: { content: [{ type: 'tool_result', tool_use_id: id, content: call.output ?? '',
            is_error: isReport && scenario === 'preparation-failed' }] } }])];
    });
    if (scenario === 'preparation-delayed-ack') { const ack = publicEvents.splice(1, 1)[0]; publicEvents.splice(3, 0, ack); }
    result.transcript.unshift(...publicEvents);
    return result;
  },
}));
afterAll(async () => {
  finalized = true;
  if (late) await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify({ directories, attempts, records, servers, cleanups, outerMs }));
  for (const server of servers) server.cleanup();
  Date.now = realNow;
});
await import(path.join(root, 'test/skill-e2e-qa-workflow.test.ts'));
`);
  try {
    const child = spawnSync(process.execPath, ['test', ...(scenario.endsWith('-retry') ? ['--retry', '1'] : []), script], {
      cwd: ROOT, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, EVALS: '', EVALS_ALL: '', EVALS_RUN_ID: 'qa-only-parent-run', TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    expect(child.error).toBeUndefined();
    const shouldFail = scenario.startsWith('preparation-') || ['edit', 'source-write', 'source-delete', 'source-add', 'setup', 'runner', 'recording', 'runner-recording', 'artifact-error', 'process-error', 'slow-setup', 'exhausted-setup', 'late-timeout', 'late-failure-retry', 'unknown-timeout', 'missing-deadline', 'unguarded-probe', 'forged-receipt', 'deadline-write', 'reset-deadline', 'cleanup', 'runner-cleanup', 'cleanup-recording', 'remove-error', 'server-stop'].includes(scenario);
    expect(child.status, child.stdout + child.stderr).toBe(shouldFail ? 1 : 0);
    expect(child.stderr).not.toContain('Unhandled error between tests');
    const { directories, attempts, records, servers, cleanups, outerMs } = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    const count = scenario.endsWith('-retry') ? 2 : 1;
    expect(directories).toHaveLength(count);
    expect(servers).toHaveLength(count);
    expect(records).toHaveLength(count);
    expect(cleanups).toHaveLength(count);
    if (scenario.startsWith('preparation-')) expect(records[0].error).toContain('QA preparation:');
    if (['missing-deadline', 'unguarded-probe', 'forged-receipt', 'deadline-write', 'reset-deadline'].includes(scenario)) expect(records[0].passed).toBe(false);
    expect(attempts).toHaveLength(['setup', 'exhausted-setup'].includes(scenario) ? 0 : count);
    for (const [index, cwd] of directories.entries()) {
      const retained = ['artifact-error', 'cleanup', 'runner-cleanup', 'cleanup-recording', 'remove-error', 'server-stop'].includes(scenario) || scenario === 'cleanup-retry' && index === 0;
      expect(fs.existsSync(cwd)).toBe(retained);
      expect(servers[index].stopped).toBe(true);
      expect(records[index].afterFinalization).toBe(false);
      expect(records[index].fixtureExists).toBe(retained);
      expect(records[index].serverStopped).toBe(true);
      expect(records[index].cleanupDone).toBe(true);
      expect(cleanups[index].budget).toBeGreaterThan(0);
      expect(cleanups[index].budget).toBeLessThanOrEqual(4000);
      expect(records[index].passed).toBe(scenario === 'recording' || !shouldFail && !(['late-retry', 'cleanup-retry'].includes(scenario) && index === 0));
      if (scenario.includes('cleanup') && !(scenario === 'cleanup-retry' && index === 1)) expect(records[index].error).toContain('QA-only browser cleanup: invalid daemon identity');
    }
    for (const [index, attempt] of attempts.entries()) {
      expect(attempt.exists).toBe(true);
      expect(attempt.initial).toBe(fs.readFileSync(path.join(ROOT, 'browse/test/fixtures/qa-only.html'), 'utf8'));
      expect(attempt.reportBefore).toBe(false);
      expect(attempt.recordedBeforeCapture).toBe(index);
      expect(attempt.publicStreamDiagnostics).toBe(true);
      expect(attempt.runId).toMatch(new RegExp('^qa-only-parent-run-qa-only-\\d+-' + (index + 1) + '$'));
      if (!scenario.startsWith('runner') && scenario !== 'artifact-error') {
        expect(cleanups[index].artifactExists).toBe(true);
        const preserved = path.join(dir, 'e2e-runs', attempt.runId, 'qa-reports');
        expect(fs.readFileSync(path.join(preserved, 'qa-only-report.md'), 'utf8')).toBe('owned report');
        expect(JSON.parse(fs.readFileSync(path.join(preserved, 'checkpoint.json'), 'utf8'))).toEqual({ attempt: index + 1 });
      }
      if (attempt.existsAfterDrain !== undefined) expect(attempt.existsAfterDrain).toBe(true);
    }
    if (scenario.startsWith('late-')) {
      expect(outerMs).toBe(1000 + 80 + 5000);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout', cost_usd: 0.25 });
      expect(records[0].error).toContain('timeout');
      if (count === 2) expect(directories[0]).not.toBe(directories[1]);
      if (scenario === 'late-failure-retry') expect(records[1]).toMatchObject({ passed: false, exit_reason: 'timeout', cost_usd: 0.25 });
    } else expect(outerMs).toBe(300000 + 5000 + 5000);
    if (scenario === 'slow-setup') {
      expect(attempts[0].captureMs).toBe(5000);
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout', elapsedMs: 305000 });
      expect(outerMs - records[0].elapsedMs).toBe(5000);
    }
    if (scenario === 'exhausted-setup') {
      expect(records[0].error).toContain('QA-only work budget exhausted');
      expect(records[0].elapsedMs).toBe(300000);
      expect(outerMs - records[0].elapsedMs).toBe(10000);
    }
    if (scenario === 'setup' || scenario === 'exhausted-setup' || scenario === 'runner' || scenario === 'runner-recording' || scenario === 'runner-cleanup') {
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'harness_error', cost_usd: 0 });
      expect(records[0].error).toContain('cost and usage unavailable');
      if (scenario === 'runner-recording') {
        expect(child.stderr).toContain('QA-only runner failed');
        expect(child.stderr).toContain('QA-only recorder failed');
      }
      if (scenario === 'runner-cleanup') {
        expect(records[0].error).toContain('QA-only runner failed');
        expect(child.stderr).toContain('QA-only runner failed');
        expect(child.stderr).toContain('QA-only browser cleanup: invalid daemon identity');
      }
    } else if (scenario === 'unknown-timeout') {
      expect(records[0]).toMatchObject({ passed: false, exit_reason: 'timeout', cost_usd: 0 });
      expect(records[0].error).toContain('actual cost is unknown');
    } else expect(records[0].cost_usd).toBe(0.25);
    if (scenario === 'cleanup-recording') {
      expect(child.stderr).toContain('QA-only recorder failed');
      expect(child.stderr).toContain('QA-only browser cleanup: invalid daemon identity');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
