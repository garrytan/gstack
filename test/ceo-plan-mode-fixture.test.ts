/** Exercise the paid smoke's real callback without starting a model process. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

test.each(['asked', 'plan_ready', 'silent_write', 'wrote_findings_before_asking', 'timeout', 'exited', 'runner-error', 'assertion-error', 'retry'])
('CEO plan-mode smoke owns its committed target and preserves %s', scenario => {
  // Long-form spelling: the child reports its fixture cwd with Windows 8.3 short names expanded.
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ceo-smoke-free-')));
  const script = path.join(directory, 'registration.test.ts');
  const factsFile = path.join(directory, 'facts.json');
  fs.writeFileSync(script, `
import { afterAll, describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = ${JSON.stringify(ROOT)}, scenario = ${JSON.stringify(scenario)};
const runner = path.join(root, 'test/helpers/claude-pty-runner.ts');
const { assertReportAtBottomIfPlanWritten } = await import(runner);
const attempts = [];
mock.module(path.join(root, 'test/helpers/e2e-gate.ts'), () => ({
  describeE2ETier: tier => { expect(tier).toBe('gate'); return describe; },
}));
mock.module(runner, () => ({
  runPlanSkillObservation: async opts => {
    const fact = { cwd: opts.cwd, checked: false, asserted: false };
    attempts.push(fact);
    expect(path.dirname(opts.cwd)).toBe(${JSON.stringify(directory)});
    expect(fs.realpathSync(opts.cwd)).not.toBe(fs.realpathSync(root));
    const git = args => execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', timeout: 5000 });
    expect(fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim())).toBe(fs.realpathSync(opts.cwd));
    expect(git(['rev-parse', 'origin/main']).trim()).toBe(git(['rev-parse', 'HEAD']).trim());
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['ls-files']).trim().split('\\n')).toEqual(['CLAUDE.md', 'PLAN.md', 'README.md', 'src/tasks.ts']);
    const plan = fs.readFileSync(path.join(opts.cwd, 'PLAN.md'), 'utf8');
    expect(git(['show', 'HEAD:PLAN.md'])).toBe(plan);
    // The initial project context owns the plan; this smoke starts with the
    // bare slash command and must not add a separate paste/acknowledgment turn.
    expect(opts).not.toHaveProperty('initialPlanContent');
    expect(plan).toContain('# Plan: Archive completed tasks');
    expect(plan).toContain('src/tasks.ts');
    expect(plan).toContain('loading existing saved tasks');
    // The subject is bounded naturally; it never dictates the tested answer.
    expect(plan.length).toBeLessThan(1200);
    expect(plan).not.toMatch(/AskUserQuestion|Step 0|HOLD SCOPE|ask (?:me|a question)|first terminal/i);
    expect(git(['show', 'HEAD:CLAUDE.md'])).toContain(plan);
    expect(git(['show', 'HEAD:CLAUDE.md'])).toContain('its source checkout is not the review target');
    expect(opts).toEqual({
      skillName: 'plan-ceo-review', inPlanMode: true, cwd: opts.cwd,
      timeoutMs: 420_000,
      env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
    });
    fact.checked = true;
    if (scenario === 'runner-error') throw new Error('controlled observation failure');
    const outcome = scenario === 'retry' ? (attempts.length === 1 ? 'timeout' : 'asked')
      : scenario === 'assertion-error' ? 'asked' : scenario;
    return { outcome, summary: 'controlled observation', elapsedMs: 42, evidence: 'controlled public evidence' };
  },
  assertReportAtBottomIfPlanWritten: obs => {
    attempts.at(-1).asserted = true;
    expect(obs.outcome).toBe('asked');
    if (scenario === 'assertion-error') throw new Error('controlled report assertion failure');
    assertReportAtBottomIfPlanWritten(obs);
  },
}));
afterAll(() => fs.writeFileSync(${JSON.stringify(factsFile)}, JSON.stringify(attempts)));
await import(path.join(root, 'test/skill-e2e-plan-ceo-plan-mode.test.ts'));
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', ...(scenario === 'retry' ? ['--retry', '1'] : []), script], {
      cwd: ROOT, timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-global-gitconfig'),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.signalCode ?? null, output).toBeNull();
    expect(child.exitCode, output).toBe(['asked', 'retry'].includes(scenario) ? 0 : 1);
    expect(output).not.toContain('Unhandled error between tests');
    const attempts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
    expect(attempts).toHaveLength(scenario === 'retry' ? 2 : 1);
    expect(new Set(attempts.map(attempt => attempt.cwd)).size).toBe(attempts.length);
    for (const [index, attempt] of attempts.entries()) {
      expect(attempt.checked, output).toBe(true);
      expect(attempt.asserted).toBe(['asked', 'assertion-error'].includes(scenario) || scenario === 'retry' && index === 1);
      expect(fs.existsSync(attempt.cwd), 'fixture is removed after success, assertion failure, and runner error').toBe(false);
    }
    if (scenario === 'runner-error') expect(output).toContain('controlled observation failure');
    else if (scenario === 'assertion-error') expect(output).toContain('controlled report assertion failure');
    else if (scenario !== 'asked') {
      expect(output).toContain('plan-ceo-review smoke FAILED: outcome=' + (scenario === 'retry' ? 'timeout' : scenario));
      expect(output).toContain('controlled public evidence');
    }
    expect(fs.readdirSync(directory).filter(name => name.startsWith('gstack-plan-count-'))).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
