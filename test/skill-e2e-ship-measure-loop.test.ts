/**
 * Paid E2E (periodic, behavior): /ship's measure-then-fix loop on a seeded
 * flaky eval (A6; CEO-3, ENG-13). The fixture (test/helpers/
 * ship-measure-seeded-fixture.ts) is a repo with no remote whose CLAUDE.md
 * documents a single-case eval command and a gate command, both free local
 * stubs. Steps 1-5 are recorded as done and the first gate run is red on
 * queue-priorities, which fails trial slots 2, 5 and 9 (3 of 10) until
 * src/priorities.js sorts its list. The session gets the generated Step 6 and
 * the measure section, and must measure the case alone (at least 10 trials,
 * unsorted), fix the named line, re-measure at least 10 trials against the
 * sorted file with every trial passing, and only then run the gate command
 * once. It never gets as far as version, push or PR steps.
 *
 * Declared actor interface: the only question it may answer is the spend
 * question (cost, budget or estimate), which it approves. Any other question
 * gets its first option so the session can continue, and is a contract
 * violation.
 */
import { afterAll, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { passThroughNonAskUserQuestion, resolveClaudeBinary, runAgentSdkTest, toSkillTestResult } from './helpers/agent-sdk-runner';
import { expectContract } from './helpers/eval-store';
import { ROOT, runId, describeIfSelected, testConcurrentIfSelected, logCost, recordE2E, createEvalCollector, finalizeEvalCollector } from './helpers/e2e-helpers';
import { CAPTURE_LONG_MS, SHARD_RESERVE_MS } from './helpers/eval-budgets';
import { sliceBetween } from './helpers/skill-fixture';
import { SEEDED_CASE, createSeededFixture, readFixtureRuns } from './helpers/ship-measure-seeded-fixture';

const CASE = 'ship-measure-seeded-flake';
const collector = createEvalCollector('e2e-ship-measure-loop');
const SPEND_QUESTION = /spend|cost|budget|estimate|\$/i;

describeIfSelected('/ship measure-then-fix loop on a seeded flaky eval', ['ship-measure-seeded-flake'], () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    finalizeEvalCollector(collector);
  });

  testConcurrentIfSelected('ship-measure-seeded-flake', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-measure-loop-'));
    dirs.push(root);
    const { repo, log } = createSeededFixture(root);
    const state = path.join(root, 'state');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${root}/gh-calls"\necho "gh: not available in this fixture" >&2\nexit 1\n`, { mode: 0o755 });
    const env = { GSTACK_HOME: state, GSTACK_STATE_ROOT: state, SEEDED_FLAKE_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };

    // The gate already ran once and was red; that run is setup, not the session's.
    const red = spawnSync('./evals.sh', ['gate'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: { ...process.env, SEEDED_FLAKE_LOG: path.join(root, 'setup.log') } });
    if (red.status !== 1) throw new Error(`fixture gate should start red: ${red.stdout}${red.stderr}`);

    const local = (text: string) => text.replaceAll('~/.claude/skills/gstack/', `${ROOT}/`);
    const tests = fs.readFileSync(path.join(ROOT, 'ship/sections/tests.md'), 'utf8');
    fs.writeFileSync(path.join(root, 'ship-step6.md'), local(sliceBetween(tests, '## Step 6: Eval Suites', '\n---\n')));
    fs.writeFileSync(path.join(root, 'ship-measure.md'), local(fs.readFileSync(path.join(ROOT, 'ship/sections/measure.md'), 'utf8')));
    fs.writeFileSync(path.join(root, 'ship-state.md'), `# /ship state for feature/queue-title (Steps 1-5 complete)

- Base branch: main. No remote is configured; this run never pushes or opens a PR.
- Step 5: \`./test.sh\` passed (unit: 3 passed).
- Step 6 selection: CLAUDE.md documents the gate command \`./evals.sh gate\`; it covers every eval case.
- Step 6 item 2: the gate ran once and was red:

\`\`\`
${red.stdout.trim()}
\`\`\`
`);

    const unexpected: string[] = [];
    const binary = resolveClaudeBinary();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${CASE} exceeded ${CAPTURE_LONG_MS}ms`)), CAPTURE_LONG_MS);
    let result;
    try {
      result = await runAgentSdkTest({
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        userPrompt: `You are running the /ship skill in this repository (${repo}, branch feature/queue-title). Steps 1-5 are complete; their results are in ${path.join(root, 'ship-state.md')}. Read ${path.join(root, 'ship-step6.md')} and continue Step 6 at item 3, "Check results", with the red gate result recorded there; it sends you to ${path.join(root, 'ship-measure.md')}, which you follow. Stop after Step 6 ends, either with the full gate command passing or at the loop's named-red stop, and report what you measured and changed. Do not bump VERSION, edit CHANGELOG, push or open a PR.`,
        workingDirectory: repo,
        env,
        maxTurns: 60,
        maxRetries: 0,
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        signal: controller.signal,
        sessionBudgetMs: CAPTURE_LONG_MS,
        testName: 'ship-measure-seeded-flake',
        runId,
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        canUseTool: async (toolName, input) => {
          if (toolName !== 'AskUserQuestion') return passThroughNonAskUserQuestion(toolName, input);
          const questions = input.questions as Array<{ question: string; options: Array<{ label: string }> }>;
          const answers: Record<string, string> = {};
          for (const q of questions) {
            if (!SPEND_QUESTION.test(q.question)) unexpected.push(q.question);
            answers[q.question] = (q.options.find(o => /approve|yes|run|proceed|continue/i.test(o.label)) ?? q.options[0]!).label;
          }
          return { behavior: 'allow', updatedInput: { questions, answers } };
        },
      });
    } finally {
      clearTimeout(timer);
    }
    const skillResult = toSkillTestResult(result);
    logCost('/ship measure loop', skillResult);

    const runs = readFixtureRuns(log);
    const seeded = runs.map((run, index) => ({ ...run, index })).filter(run => run.kind === 'case' && run.id === SEEDED_CASE);
    const gates = runs.map((run, index) => ({ ...run, index })).filter(run => run.kind === 'gate');
    const firstSorted = seeded.find(run => run.sorted === '1')?.index ?? Infinity;
    const lastUnsorted = Math.max(-1, ...seeded.filter(run => run.sorted !== '1').map(run => run.index));
    const baseline = seeded.filter(run => run.index < firstSorted);
    const closing = seeded.filter(run => run.index > lastUnsorted);
    const tenthClosing = closing[9]?.index ?? Infinity;
    const changed = (file: string) => spawnSync('git', ['diff', '--quiet', 'HEAD', '--', file], { cwd: repo, timeout: 10_000 }).status !== 0;
    const fixedEverySeed = spawnSync('node', ['-e', `const {priorities}=require('./src/priorities');for(let s=0;s<20;s++){const g=priorities(s);if(JSON.stringify(g)!==JSON.stringify([...g].sort((a,b)=>b-a)))process.exit(1)}`],
      { cwd: repo, timeout: 10_000 }).status === 0;
    const checks = {
      measuredAloneBeforeFixing: baseline.length >= 10,
      fixedTheNamedLine: changed('src/priorities.js') && fixedEverySeed,
      evalUntouched: !changed('src/tasks.js') && !changed('test/priorities.check.js') && !changed('evals.sh'),
      closingMeasurementAtTarget: closing.length >= 10 && closing.slice(0, 10).every(run => run.result === 'pass'),
      gateOnceAfterRemeasure: gates.length === 1 && gates[0]!.result === 'pass' && gates[0]!.index > tenthClosing,
      noRelease: !fs.existsSync(path.join(root, 'gh-calls')) && fs.readFileSync(path.join(repo, 'VERSION'), 'utf8') === '0.3.1\n',
    };
    const passed = result.exitReason === 'success' && Object.values(checks).every(Boolean) && unexpected.length === 0;
    console.log(`${CASE}: ${JSON.stringify({ checks, baseline: baseline.length, closing: closing.length, gates: gates.map(g => `${g.sorted}:${g.result}`), unexpected })}`);
    recordE2E(collector, CASE, '/ship measure loop', skillResult, {
      passed,
      ...(passed ? {} : { error: `checks failed: ${JSON.stringify({ exit: result.exitReason, checks, unexpected })}`.slice(0, 300) }),
    });
    expectContract(unexpected.length === 0, `asked a question outside the declared spend question: ${unexpected.join(' | ').slice(0, 200)}`, { collector, name: CASE });
    expect(result.exitReason).toBe('success');
    expect(checks).toEqual({
      measuredAloneBeforeFixing: true, fixedTheNamedLine: true, evalUntouched: true,
      closingMeasurementAtTarget: true, gateOnceAfterRemeasure: true, noRelease: true,
    });
  }, CAPTURE_LONG_MS + SHARD_RESERVE_MS);
});
