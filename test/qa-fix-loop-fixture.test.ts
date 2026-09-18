/** Execute the real QA fix-loop body with its provider boundary replaced. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const ROOT = path.resolve(import.meta.dir, '..');

test('QA fixture regressions select only the QA fix loop', () => {
  expect(selectTests(['test/qa-fix-loop-fixture.test.ts'], E2E_TOUCHFILES).selected).toEqual(['qa-fix-loop']);
});

test.each(['success', 'bash-edit', 'max-turns', 'no-edit', 'no-commit', 'runner', 'retry', 'directory', 'recording', 'late-timeout'])
  ('QA attempt recording and fixture ownership: %s', scenario => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fix-body-'));
    const script = path.join(dir, 'body.fixture.test.ts');
    const factsPath = path.join(dir, 'facts.json');
    // Mocks live in a child so no other free test can inherit a replaced runner.
    fs.writeFileSync(script, `
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(ROOT)};
const scenario = ${JSON.stringify(scenario)};
const attempts = [], records = [], servers = [];
const late = scenario === 'late-timeout';
const workMs = 1000, drainMs = 80;
let finalized = false, outerMs;
const collector = { addTest: entry => {
  records.push({ ...entry, afterFinalization: finalized });
  if (scenario === 'recording') throw new Error('QA recorder failure');
} };
const serve = Bun.serve.bind(Bun);
Bun.serve = options => {
  const server = serve(options);
  const fact = { stopped: false, url: 'http://127.0.0.1:' + server.port };
  servers.push(fact);
  const stop = server.stop.bind(server);
  server.stop = (...args) => { fact.stopped = true; return stop(...args); };
  return server;
};
mock.module(path.join(root, 'test/helpers/aside-available.ts'), () => ({ asideAvailable: () => false }));
if (late) mock.module(path.join(root, 'test/helpers/eval-budgets.ts'), () => ({
  JUDGE_MS: 120_000, CAPTURE_MS: 300_000, CAPTURE_LONG_MS: workMs,
}));
mock.module(path.join(root, 'test/helpers/e2e-helpers.ts'), () => ({
  ROOT: root, browseBin: ${JSON.stringify(script)}, runId: 'free-qa-body',
  evalsEnabled: true, selectedTests: ['qa-fix-loop'],
  describeIfSelected: (name, ids, body) => { if (ids.includes('qa-fix-loop')) describe(name, body); },
  testConcurrentIfSelected: (id, body, budget) => {
    if (id !== 'qa-fix-loop') return;
    outerMs = budget;
    // Keep the actual native outer deadline, scaling only its 5s recording
    // margin to80ms. The pre-fix equal work/outer deadline stays equal.
    const nativeBudget = late ? (budget >= workMs + 5000 ? budget - 5000 + 80 : budget) : 5000;
    test(id, body, nativeBudget);
  },
  copyDirSync: (source, target) => fs.cpSync(source, target, { recursive: true }),
  setupBrowseShims: cwd => fs.mkdirSync(path.join(cwd, 'browse/bin'), { recursive: true }),
  logCost: () => {}, createEvalCollector: () => collector, finalizeEvalCollector: async () => {},
  recordE2E: (_collector, name, suite, result, extra) => collector.addTest({
    name, suite, exit_reason: result.exitReason, model: result.model,
    cost_usd: result.costEstimate.estimatedCost, ...extra,
  }),
}));
mock.module(path.join(root, 'test/helpers/session-runner.ts'), () => ({
  SESSION_DRAIN_GRACE_MS: late ? drainMs : 5000,
  runSkillTest: async options => {
    const cwd = options.workingDirectory;
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    const initial = fs.readFileSync(path.join(cwd, 'index.html'), 'utf8');
    const fact = { cwd, initial, commitsBefore: Number(git('rev-list', '--count', 'HEAD')),
      reportBefore: fs.existsSync(path.join(cwd, 'qa-reports/qa-report.md')),
      recordedBeforeCapture: records.length, captureBudgetMs: options.timeout };
    attempts.push(fact);
    if (scenario === 'runner') throw new Error('owned QA runner failure');
    if (late) {
      await new Promise(resolve => setTimeout(resolve, options.timeout + drainMs));
      return { exitReason: 'timeout', model: 'fixture-model',
        costEstimate: { estimatedCost: 0.25 }, toolCalls: [] };
    }
    const url = servers.at(-1).url;
    if (scenario === 'directory') {
      fact.directoryStatus = (await fetch(url + '/browse/')).status;
      fact.missingStatus = (await fetch(url + '/missing-route')).status;
      fact.initialServed = await (await fetch(url + '/')).text();
    }
    const unchanged = ['no-edit', 'recording'].includes(scenario) || scenario === 'retry' && attempts.length === 1;
    if (!unchanged) fs.writeFileSync(path.join(cwd, 'index.html'), initial.replace(' disabled', ''));
    fs.mkdirSync(path.join(cwd, 'qa-reports'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'qa-reports/qa-report.md'), 'previous attempt report');
    if (scenario !== 'no-commit') { git('add', 'index.html'); git('commit', '--allow-empty', '-m', 'fixture fix'); }
    if (scenario === 'directory') fact.fixedServed = await (await fetch(url + '/')).text();
    return {
      exitReason: scenario === 'max-turns' ? 'error_max_turns' : 'success',
      model: 'fixture-model', costEstimate: { estimatedCost: 0.25 },
      toolCalls: unchanged ? [] : scenario === 'bash-edit'
        ? [{ tool: 'Bash', input: { command: 'apply the source fix' } }]
        : [{ tool: 'Edit', input: { file_path: path.join(cwd, 'index.html') } }],
    };
  },
}));
afterAll(async () => {
  finalized = true;
  // Expose callbacks that outlive Bun's test deadline instead of hiding them
  // behind child exit; this reproduces the observed late recording race.
  if (late) await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify({ attempts, records, servers, outerMs }));
});
await import(path.join(root, 'test/skill-e2e-qa-workflow.test.ts'));
`);
    try {
      const args = ['test', ...(scenario === 'retry' ? ['--retry', '1'] : []), script];
      const child = spawnSync(process.execPath, args, {
        cwd: ROOT, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, EVALS: '', EVALS_ALL: '', TMPDIR: dir, TMP: dir, TEMP: dir },
      });
      expect(child.error).toBeUndefined();
      const shouldFail = ['no-edit', 'no-commit', 'runner', 'recording', 'late-timeout'].includes(scenario);
      expect(child.status, child.stderr).toBe(shouldFail ? 1 : 0);
      const { attempts, records, servers, outerMs } = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
      expect(attempts).toHaveLength(scenario === 'retry' ? 2 : 1);
      expect(records).toHaveLength(attempts.length);
      expect(servers).toHaveLength(attempts.length);
      for (const [index, attempt] of attempts.entries()) {
        expect(attempt.commitsBefore).toBe(1);
        expect(attempt.initial).toContain('type="submit" disabled');
        expect(attempt.initial).toContain('/nonexistent-broken-page');
        expect(attempt.reportBefore).toBe(false);
        expect(attempt.recordedBeforeCapture).toBe(index);
        expect(fs.existsSync(attempt.cwd)).toBe(false);
        expect(servers[index].stopped).toBe(true);
        expect(records[index].afterFinalization).toBe(false);
        expect(records[index].passed).toBe(!shouldFail && !(scenario === 'retry' && index === 0));
      }
      if (scenario === 'retry') {
        expect(attempts[0].cwd).not.toBe(attempts[1].cwd);
        expect(attempts[0].initial).toBe(attempts[1].initial);
      }
      if (scenario === 'runner') {
        expect(child.stderr).toContain('owned QA runner failure');
        expect(records[0]).toMatchObject({ passed: false, exit_reason: 'harness_error' });
        expect(records[0].error).toContain('cost and usage unavailable');
      } else {
        expect(records[0].cost_usd).toBe(0.25);
        expect(records[0].model).toBe('fixture-model');
        if (scenario === 'no-commit') {
          expect(records[0].error).toContain('toBeGreaterThan');
        } else if (['no-edit', 'retry', 'recording'].includes(scenario)) {
          expect(records[0].error).toContain('toBe(expected)');
        }
      }
      if (scenario === 'recording') {
        expect(child.stderr).toContain('toBe(expected)');
        expect(child.stderr).toContain('QA recorder failure');
      }
      if (scenario === 'late-timeout') {
        expect(outerMs).toBe(1000 + 80 + 5000);
        expect(attempts[0].captureBudgetMs).toBeGreaterThan(0);
        expect(attempts[0].captureBudgetMs).toBeLessThan(1000);
        expect(records[0].exit_reason).toBe('timeout');
        expect(child.stderr).not.toContain('Unhandled error between tests');
      }
      if (scenario === 'directory') {
        expect(attempts[0].directoryStatus).toBe(404);
        expect(attempts[0].missingStatus).toBe(404);
        expect(attempts[0].initialServed).toBe(attempts[0].initial);
        expect(attempts[0].fixedServed).not.toContain('type="submit" disabled');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
