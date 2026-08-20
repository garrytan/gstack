import { beforeAll, afterAll, expect } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-plan-tune');

// ---------------------------------------------------------------------------
// /plan-tune E2E: verify the skill recognizes plain-English intent and hits
// the right binary paths without CLI subcommand syntax.
//
// This is a gate-tier test — if /plan-tune requires memorized subcommands or
// fails on plain English, that is a regression of the core v1 DX promise.
// ---------------------------------------------------------------------------

describeIfSelected('PlanTune E2E', ['plan-tune-inspect'], () => {
  let workDir: string;
  let gstackHome: string;
  let slug: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-tune-'));
    gstackHome = path.join(workDir, '.gstack-home');

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(workDir, 'README.md'), '# test\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Copy the /plan-tune skill (extract the flow section only — full template
    // is ~45KB and includes preamble boilerplate the agent doesn't need).
    copyDirSync(path.join(ROOT, 'plan-tune'), path.join(workDir, 'plan-tune'));

    // Copy required bins — the skill references these by path.
    const binDir = path.join(workDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const script of [
      'gstack-slug',
      'gstack-config',
      'gstack-question-log',
      'gstack-question-preference',
      'gstack-developer-profile',
      'gstack-builder-profile',
    ]) {
      const src = path.join(ROOT, 'bin', script);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(binDir, script));
        fs.chmodSync(path.join(binDir, script), 0o755);
      }
    }

    // gstack-developer-profile --derive imports from scripts/ — copy those too.
    const scriptsDir = path.join(workDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const src of ['question-registry.ts', 'psychographic-signals.ts', 'archetypes.ts', 'one-way-doors.ts']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', src), path.join(scriptsDir, src));
    }

    // Compute slug the same way the binary does (basename fallback).
    slug = path.basename(workDir).replace(/[^a-zA-Z0-9._-]/g, '');

    // Seed a few question-log entries so "review questions" has something to show.
    const projectDir = path.join(gstackHome, 'projects', slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const entries = [
      {
        ts: '2026-04-10T10:00:00Z',
        skill: 'plan-ceo-review',
        question_id: 'plan-ceo-review-mode',
        question_summary: 'Which review mode?',
        category: 'routing',
        door_type: 'two-way',
        options_count: 4,
        user_choice: 'expand',
        recommended: 'selective',
        followed_recommendation: false,
        session_id: 's1',
      },
      {
        ts: '2026-04-11T10:00:00Z',
        skill: 'ship',
        question_id: 'ship-test-failure-triage',
        question_summary: 'Test failed',
        category: 'approval',
        door_type: 'one-way',
        options_count: 3,
        user_choice: 'fix-now',
        recommended: 'fix-now',
        followed_recommendation: true,
        session_id: 's2',
      },
      {
        ts: '2026-04-12T10:00:00Z',
        skill: 'ship',
        question_id: 'ship-changelog-voice-polish',
        question_summary: 'Polish changelog voice',
        category: 'approval',
        door_type: 'two-way',
        options_count: 2,
        user_choice: 'skip',
        recommended: 'accept',
        followed_recommendation: false,
        session_id: 's3',
      },
    ];
    fs.writeFileSync(
      path.join(projectDir, 'question-log.jsonl'),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    // Pre-set question_tuning=true so the skill doesn't enter the first-time setup flow.
    const cfgDir = path.join(gstackHome);
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.yaml'), 'question_tuning: true\n');
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    finalizeEvalCollector(evalCollector);
  });

  // -------------------------------------------------------------------------
  // Plain-English intent: "review my questions"
  // -------------------------------------------------------------------------
  testConcurrentIfSelected('plan-tune-inspect', async () => {
    const result = await runSkillTest({
      prompt: `Read ./plan-tune/SKILL.md for the /plan-tune skill instructions.

The user has invoked /plan-tune and says: "Review the questions I've been asked recently."

IMPORTANT:
- Use GSTACK_HOME="${gstackHome}" as an environment variable for all bin calls.
- Replace any ~/.claude/skills/gstack/bin/ references with ./bin/ (relative path).
- Replace any ~/.claude/skills/gstack/scripts/ references with ./scripts/.
- Do NOT use AskUserQuestion.
- Do NOT implement code changes.
- Route the user's intent to the right section of the skill (Review question log).
- Show them the logged questions with counts and the follow/override ratio.`,
      workingDirectory: workDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
      timeout: 120_000,
      testName: 'plan-tune-inspect',
      runId,
    });

    logCost('/plan-tune review', result);

    const output = result.output.toLowerCase();

    // Agent must have surfaced at least 2 of the 3 logged question_ids
    const mentionsCEO = output.includes('plan-ceo-review-mode') || output.includes('review mode');
    const mentionsShipTest = output.includes('ship-test-failure-triage') || output.includes('test failed');
    const mentionsChangelog = output.includes('changelog') || output.includes('ship-changelog-voice-polish');
    const foundCount = [mentionsCEO, mentionsShipTest, mentionsChangelog].filter(Boolean).length;

    // Agent should note override behavior (user overrode CEO review and changelog polish)
    const noticedOverride =
      output.includes('overrid') ||
      output.includes('skip') ||
      output.includes('expand');

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, '/plan-tune', 'Plan-tune inspection flow (plain English)', result, {
      passed: exitOk && foundCount >= 2,
    });

    expect(exitOk).toBe(true);
    expect(foundCount).toBeGreaterThanOrEqual(2);

    if (!noticedOverride) {
      console.warn('Agent did not surface override/skip behavior from the log');
    }
  }, 180_000);
});
