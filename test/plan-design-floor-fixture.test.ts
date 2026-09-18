import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

// Exercise the actual paid registration with only its PTY observation boundary
// replaced. No EVALS flags, credentials, model process, or paid runner are used.
function exercise(outcome: string = 'auq_observed') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'design-floor-free-'));
  const script = path.join(directory, 'registration.test.ts');
  const facts = path.join(directory, 'facts.json');
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FORCING_FLOOR_DESIGN } from ${JSON.stringify(path.join(ROOT, 'test/fixtures/forcing-finding-seeds.ts'))};
import { CAPTURE_LONG_MS } from ${JSON.stringify(path.join(ROOT, 'test/helpers/eval-budgets.ts'))};
const outcome = ${JSON.stringify(outcome)};
let calls = 0;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  runPlanSkillFloorCheck: async opts => {
    calls++;
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ calls, cwd: opts.cwd, seeded: false }));
    expect(path.dirname(opts.cwd)).toBe(${JSON.stringify(directory)});
    expect(opts.cwd).not.toBe(${JSON.stringify(ROOT)});
    expect(opts).toEqual({
      skillName: 'plan-design-review', slashCommand: '/plan-design-review',
      followUpPrompt: FORCING_FLOOR_DESIGN, cwd: opts.cwd,
      requestedPlanPath: '/tmp/gstack-test-plan-design-floor.md',
      timeoutMs: CAPTURE_LONG_MS,
      env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
    });
    const input = fs.readFileSync(path.join(opts.cwd, 'review-input.md'), 'utf8');
    expect(input).toBe(FORCING_FLOOR_DESIGN);
    expect(execFileSync('git', ['show', 'HEAD:review-input.md'], {
      cwd: opts.cwd, encoding: 'utf8', timeout: 5000,
    })).toBe(FORCING_FLOOR_DESIGN);
    const guide = fs.readFileSync(path.join(opts.cwd, 'CLAUDE.md'), 'utf8');
    expect(guide).toContain(${JSON.stringify('The requested review target is the plan in `review-input.md`.')});
    expect(guide).toContain('Read it before\\nchoosing review scope.');
    expect(guide).toContain('/plan-design-review');
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ calls, cwd: opts.cwd, seeded: true }));
    if (outcome === 'throw') throw new Error('controlled floor observation failure');
    return {
      auqObserved: outcome === 'auq_observed', outcome, elapsedMs: 600000,
      summary: outcome === 'timeout' ? 'scope target is still waiting' : 'controlled observation',
      evidence: 'What should I review? 1. Current branch diff 2. Plan or design doc',
    };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-design-finding-floor.test.ts'))});
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT, timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory, TEMP: directory, TMP: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.signalCode ?? null, output).toBeNull();
    expect(fs.existsSync(facts), output).toBe(true);
    const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(observed.calls).toBe(1);
    expect(observed.seeded, output).toBe(true);
    expect(fs.existsSync(observed.cwd), 'owned fixture must be removed after observation').toBe(false);
    return { code: child.exitCode, output };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('design floor supplies the exact committed target before the first PTY turn', () => {
  const result = exercise();
  expect(result.code, result.output).toBe(0);
}, 20_000);

test.each(['timeout', 'plan_ready', 'silent_write', 'exited'])('design floor still rejects %s and cleans its project', outcome => {
  const result = exercise(outcome);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('floor test FAILED: outcome=' + outcome);
}, 20_000);

test('design floor cleans its project when observation throws and preserves the error', () => {
  const result = exercise('throw');
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('controlled floor observation failure');
}, 20_000);
