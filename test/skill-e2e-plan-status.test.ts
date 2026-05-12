/**
 * Gate-tier E2E for /plan-status.
 *
 * Verifies the skill can resolve a plan file, classify phase/criteria items,
 * and produce a status report. Uses a filesystem-only fixture (no git commits
 * that match plan deliverables) — the git evidence path is not exercised here.
 *
 * Gate tier: deterministic, read-only, filesystem-only fixture, < $0.50/run.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId,
  describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-plan-status');

describeIfSelected('Plan Status E2E', ['plan-status'], () => {
  let workDir: string;
  let gstackHome: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-plan-status-'));
    gstackHome = path.join(workDir, '.gstack-home');

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(workDir, 'README.md'), '# Test project\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial commit']);

    // Install the plan-status skill
    const skillDir = path.join(workDir, '.claude', 'skills', 'plan-status');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'plan-status', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));

    // Copy bin scripts referenced by the preamble
    const binDir = path.join(workDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const script of ['gstack-update-check', 'gstack-slug', 'gstack-config', 'gstack-repo-mode']) {
      const src = path.join(ROOT, 'bin', script);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(binDir, script));
        fs.chmodSync(path.join(binDir, script), 0o755);
      }
    }

    // Copy the fixture plan
    fs.copyFileSync(
      path.join(ROOT, 'test', 'fixtures', 'plans', 'sample-ruby-llm-plan.md'),
      path.join(workDir, 'fixture-plan.md'),
    );

    // Create a minimal gstack analytics file (empty — no prior skill runs)
    const analyticsDir = path.join(gstackHome, 'analytics');
    fs.mkdirSync(analyticsDir, { recursive: true });
    fs.writeFileSync(path.join(analyticsDir, 'skill-usage.jsonl'), '');

    // Routing CLAUDE.md
    fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), `# Test project

## Skill routing
When the user invokes /plan-status, ALWAYS use the Skill tool first.

Environment:
- The plan-status skill is at ./.claude/skills/plan-status/SKILL.md
- Bin scripts are at ./bin/ — replace ~/.claude/skills/gstack/bin/ with ./bin/
- Use GSTACK_HOME="${gstackHome}" for all gstack bin scripts
- The analytics file is at ${gstackHome}/analytics/skill-usage.jsonl
`);
  });

  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    finalizeEvalCollector(evalCollector);
  });

  testConcurrentIfSelected('plan-status', async () => {
    const result = await runSkillTest({
      prompt: `Run /plan-status on the plan file at ./fixture-plan.md.

IMPORTANT:
- Use GSTACK_HOME="${gstackHome}" for all gstack bin scripts.
- The bin scripts are at ./bin/ (replace ~/.claude/skills/gstack/bin/ with ./bin/ in any commands).
- The plan file is ./fixture-plan.md — use it directly, do not search for other plans.
- Do NOT use AskUserQuestion.
- Do NOT make any file edits.
- Produce the full status report and stop after Step 5.`,
      workingDirectory: workDir,
      maxTurns: 20,
      allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
      timeout: 180_000,
      testName: 'plan-status',
      runId,
    });

    logCost('/plan-status', result);

    const output = result.output;

    // Loose assertions: report header present + at least one status label
    const hasHeader = /plan.?status/i.test(output);
    const hasDone = /\bDONE\b/.test(output);
    const hasRemaining = /\bREMAINING\b/.test(output);
    const hasStatusLabel = hasDone || hasRemaining;

    const exitOk = ['success', 'error_max_turns'].includes(result.exitReason);

    recordE2E(evalCollector, '/plan-status', 'Plan status E2E', result, {
      passed: exitOk && hasHeader && hasStatusLabel,
    });

    expect(exitOk).toBe(true);
    expect(hasHeader).toBe(true);
    expect(hasStatusLabel).toBe(true);
  }, 240_000);
});
