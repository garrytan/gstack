/**
 * E2E tests for /office-hours mode-posture regression (V1.1 gate).
 *
 * Exercises startup mode Q3 (forcing energy) and builder mode (generative wildness).
 * Both cases detect whether preamble Writing Style rules have flattened the
 * skill's distinctive posture at runtime.
 *
 * Judge: Sonnet via judgePosture() — cheap per-call.
 * Generator: whatever the skill runs with (Sonnet for office-hours).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { judgePosture } from './helpers/llm-judge';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-office-hours');

// --- Office Hours forcing-question energy (Q3 Desperate Specificity) ---

describeIfSelected('Office Hours Forcing Energy E2E', ['office-hours-forcing-energy'], () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-office-hours-forcing-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    const pitch = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'mode-posture', 'forcing-pitch.md'),
      'utf-8',
    );
    fs.writeFileSync(path.join(workDir, 'pitch.md'), pitch);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add pitch']);

    fs.mkdirSync(path.join(workDir, 'office-hours'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'office-hours', 'SKILL.md'),
      path.join(workDir, 'office-hours', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('office-hours-forcing-energy', async () => {
    const result = await runSkillTest({
      prompt: `Read office-hours/SKILL.md for the workflow.

Read pitch.md — that's the founder pitch the user is bringing to office hours. Select Startup Mode. Skip any AskUserQuestion — this is non-interactive.

Assume the founder has already answered Q1 (strongest evidence = "got on a waitlist of about 40 signups from LinkedIn posts") and Q2 (status quo = "PMs use Notion docs + lots of Zoom summaries by hand"). Jump directly to Q3 Desperate Specificity.

Write Q3 output — the forcing question you would ask this founder — to ${workDir}/q3.md. Write ONLY the question prose. No conversational wrapper, no meta-commentary, no Q1/Q2 recap.`,
      workingDirectory: workDir,
      maxTurns: 8,
      timeout: 240_000,
      testName: 'office-hours-forcing-energy',
      runId,
      model: 'claude-sonnet-4-6',
    });

    logCost('/office-hours (FORCING)', result);
    recordE2E(evalCollector, '/office-hours-forcing-energy', 'Office Hours Forcing Energy E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    const q3Path = path.join(workDir, 'q3.md');
    if (!fs.existsSync(q3Path)) {
      throw new Error('Agent did not emit q3.md — forcing energy eval requires Q3 output');
    }
    const q3Text = fs.readFileSync(q3Path, 'utf-8');
    expect(q3Text.length).toBeGreaterThan(80);

    const scores = await judgePosture('forcing', q3Text);
    console.log('Forcing energy scores:', JSON.stringify(scores, null, 2));
    expect(scores.axis_a).toBeGreaterThanOrEqual(4);  // stacking_preserved
    expect(scores.axis_b).toBeGreaterThanOrEqual(4);  // domain_matched_consequence
  }, 360_000);
});

// --- Office Hours builder-mode wildness ---

describeIfSelected('Office Hours Builder Wildness E2E', ['office-hours-builder-wildness'], () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-office-hours-builder-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    const idea = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'mode-posture', 'builder-idea.md'),
      'utf-8',
    );
    fs.writeFileSync(path.join(workDir, 'idea.md'), idea);

    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'add idea']);

    fs.mkdirSync(path.join(workDir, 'office-hours'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'office-hours', 'SKILL.md'),
      path.join(workDir, 'office-hours', 'SKILL.md'),
    );
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('office-hours-builder-wildness', async () => {
    const result = await runSkillTest({
      prompt: `Read office-hours/SKILL.md for the workflow.

Read idea.md — that's the user's weekend project idea. Select Builder Mode (Phase 2B). Skip any AskUserQuestion — this is non-interactive.

The user has confirmed the basic idea is "TypeScript + D3 web tool, start with JS/TS dependency graphs." They are now asking: "What are three adjacent unlocks I haven't mentioned yet — things that would turn this from a tool I used into something I'd show a friend?"

Write your response — the three adjacent unlocks — to ${workDir}/unlocks.md. Write ONLY the response prose. No meta-commentary, no mode recap. Lead with the fun; let me edit it down later.`,
      workingDirectory: workDir,
      maxTurns: 8,
      timeout: 240_000,
      testName: 'office-hours-builder-wildness',
      runId,
      model: 'claude-sonnet-4-6',
    });

    logCost('/office-hours (BUILDER)', result);
    recordE2E(evalCollector, '/office-hours-builder-wildness', 'Office Hours Builder Wildness E2E', result, {
      passed: ['success', 'error_max_turns'].includes(result.exitReason),
    });
    expect(['success', 'error_max_turns']).toContain(result.exitReason);

    const unlocksPath = path.join(workDir, 'unlocks.md');
    if (!fs.existsSync(unlocksPath)) {
      throw new Error('Agent did not emit unlocks.md — builder wildness eval requires output');
    }
    const unlocksText = fs.readFileSync(unlocksPath, 'utf-8');
    expect(unlocksText.length).toBeGreaterThan(200);

    const scores = await judgePosture('builder', unlocksText);
    console.log('Builder wildness scores:', JSON.stringify(scores, null, 2));
    expect(scores.axis_a).toBeGreaterThanOrEqual(4);  // unexpected_combinations
    expect(scores.axis_b).toBeGreaterThanOrEqual(4);  // excitement_over_optimization
  }, 360_000);
});

// Finalize eval collector for this file
if (evalsEnabled) {
  finalizeEvalCollector(evalCollector);
}
