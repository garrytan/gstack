import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, evalsEnabled,
  describeIfSelected, logCost, recordE2E,
  copyDirSync, createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// E2E for /autoplan's dual-voice (Claude subagent + Codex). Periodic tier:
// non-deterministic, costs ~$1/run, not a gate. The purpose is to catch
// regressions where one of the two voices fails silently post-hardening.

const evalCollector = createEvalCollector('e2e-autoplan-dual-voice');

describeIfSelected('Autoplan dual-voice E2E', ['autoplan-dual-voice'], () => {
  let workDir: string;
  let planPath: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-autoplan-dv-'));

    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 10000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(workDir, 'README.md'), '# test repo\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Copy /autoplan + its review-skill dependencies (they're loaded from disk).
    copyDirSync(path.join(ROOT, 'autoplan'), path.join(workDir, 'autoplan'));
    copyDirSync(path.join(ROOT, 'plan-ceo-review'), path.join(workDir, 'plan-ceo-review'));
    copyDirSync(path.join(ROOT, 'plan-eng-review'), path.join(workDir, 'plan-eng-review'));
    copyDirSync(path.join(ROOT, 'plan-design-review'), path.join(workDir, 'plan-design-review'));
    copyDirSync(path.join(ROOT, 'plan-devex-review'), path.join(workDir, 'plan-devex-review'));

    // Register the skills as project-level slash commands. The root copies
    // above are NOT enough on their own: claude -p only discovers skills under
    // .claude/skills/, and an unregistered slash command short-circuits with
    // "Unknown command: /autoplan" (0 turns, ~1s) on claude >= 2.x — the model
    // never runs, so both voice assertions fail. Same install pattern as
    // installSkills() in skill-routing-e2e.test.ts.
    const skillsBase = path.join(workDir, '.claude', 'skills');
    for (const skill of ['autoplan', 'plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review']) {
      const dest = path.join(skillsBase, skill);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(ROOT, skill, 'SKILL.md'), path.join(dest, 'SKILL.md'));
    }

    // Write a tiny plan file for /autoplan to review.
    planPath = path.join(workDir, 'TEST_PLAN.md');
    fs.writeFileSync(planPath, `# Test Plan: add /greet skill

## Context
Add a new /greet skill that prints a welcome message.

## Scope
- Create greet/SKILL.md with a simple "hello" flow
- Add to gen-skill-docs pipeline
- One unit test
`);
  });

  afterAll(() => {
    finalizeEvalCollector(evalCollector);
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  // Skip entirely unless evals enabled (periodic tier).
  test.skipIf(!evalsEnabled)(
    'both Claude + Codex voices produce output in Phase 1 (within timeout)',
    async () => {
      // Fire /autoplan with a 10-min hard timeout on the spawn itself.
      // The skill itself has 10-min phase timeouts + auth-gate failfast.
      // If Codex is unavailable on the test machine, the skill should print
      // [codex-unavailable] and still complete the Claude subagent half.
      // Budget note: 5 min / 30 turns was enough at v1.0-era skill sizes, but
      // the full-depth Phase 1 (registered skill + CEO review subagent) now
      // needs longer — at 300s the run was killed mid-CEO-review with both
      // voices already fired but no Phase-1-complete marker yet.
      const result = await runSkillTest({
        testName: 'autoplan-dual-voice',
        workingDirectory: workDir,
        prompt: `/autoplan ${planPath}`,
        timeout: 600_000, // 10 min
        // /autoplan spawns subagents and calls codex via Bash; it needs the
        // full tool set to get past Phase 1. Bash+Read+Write alone wasn't
        // enough — the skill stalled trying to invoke Agent/Skill.
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'Skill'],
        maxTurns: 40,
        runId,
      });

      // Accept EITHER outcome as success:
      //   (a) Both voices produced output (ideal case)
      //   (b) Codex unavailable + Claude voice produced output (graceful degrade)
      // Search ONLY the tool-call structure — NOT the prompt string that went in.
      // Matching against full transcript is risky because the prompt itself
      // contains "plan-ceo-review" and other marker strings that would produce
      // false positives regardless of skill behavior. Filter to tool_result
      // content + assistant messages emitted DURING execution.
      const transcript = Array.isArray(result.transcript) ? result.transcript : [];
      // The transcript holds RAW stream-json events: tool_use blocks live
      // INSIDE assistant events' message.content, and tool_results inside
      // user events — no top-level entry ever has type 'tool_use'. Filtering
      // on that shape matched nothing, silently reducing `out` to
      // result.output alone, so a run killed at the spawn timeout (no result
      // event) had NOTHING to match and every assertion failed.
      const executionContent = transcript
        .filter((entry: any) => entry && (entry.type === 'assistant' || entry.type === 'user'))
        .map((entry: any) => JSON.stringify(entry))
        .join('\n');
      const out = (result.output ?? '') + '\n' + executionContent;

      // Claude voice: require evidence of a dispatched Agent subagent, not
      // merely the literal string "Agent(" (which could appear in any text).
      // Task/Agent tool_use entries have name:"Agent" or subagent_type:"..."
      const claudeVoiceFired = /"name":\s*"Agent"|"subagent_type":\s*"[^"]/.test(out) ||
                               /Claude\s+(CEO|subagent)\s+(review|complete|finished)|claude-subagent\s/i.test(out);
      // Codex voice: require evidence of codex CLI invocation (command string in
      // a Bash tool_use), not prompt-text mentions.
      const codexVoiceFired = /"command":\s*"[^"]*codex\s+(exec|review)/.test(out) ||
                              /CODEX SAYS\s*\(/i.test(out);
      // Unavailable markers: explicit probe-failure strings emitted by the skill.
      const codexUnavailable = /\[codex-unavailable\]|AUTH_FAILED\b|CODEX_NOT_AVAILABLE\b|codex_cli_missing|Codex CLI not found/i.test(out);

      expect(claudeVoiceFired).toBe(true);
      expect(codexVoiceFired || codexUnavailable).toBe(true);

      // Hang protection: require pipeline-progress evidence, not name mentions.
      // Full Phase 1 COMPLETION (three parallel review subagents, each loading a
      // 25-35K-token skill) routinely exceeds 10 minutes on sonnet, so requiring
      // the "Phase 1 complete" banner would force a 20-minute test for no extra
      // dual-voice signal. Accept EITHER the completion banner (autoplan/SKILL.md
      // "PHASE 1 COMPLETE" mandatory output) OR structural evidence that the
      // Phase 1 review dispatch actually happened: an Agent tool_use whose input
      // carries review instructions (execution artifact built by the skill, not
      // an echo of our prompt).
      const reachedPhase1 = /Phase\s+1\s+(complete|done|finished)|CEO\s+Review\s+(complete|done|approved)|Strategy\s*&\s*Scope\s+(complete|done)|Phase\s+2\s+(started|begin)/i.test(out);
      const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
      const reviewDispatched = toolCalls.some((tc: any) =>
        (tc?.tool === 'Agent' || tc?.tool === 'Task') &&
        /review|ceo|eng manager|strategy/i.test(JSON.stringify(tc?.input ?? {})));
      expect(reachedPhase1 || reviewDispatched).toBe(true);

      logCost('autoplan-dual-voice', result);
      recordE2E(evalCollector, 'autoplan-dual-voice', 'Autoplan dual-voice E2E', result, {
        passed: claudeVoiceFired && (codexVoiceFired || codexUnavailable) && (reachedPhase1 || reviewDispatched),
      });
    },
    630_000, // per-test timeout slightly > spawn timeout so cleanup can run
  );
});
