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
      // Fire /autoplan with a 5-min hard timeout on the spawn itself.
      // The skill itself has 10-min phase timeouts + auth-gate failfast.
      // If Codex is unavailable on the test machine, the skill should print
      // [codex-unavailable] and still complete the Claude subagent half.
      const result = await runSkillTest({
        name: 'autoplan-dual-voice',
        workdir: workDir,
        prompt: `/autoplan ${planPath}`,
        timeoutMs: 300_000, // 5 min
        evalCollector,
      });

      // Accept EITHER outcome as success:
      //   (a) Both voices produced output (ideal case)
      //   (b) Codex unavailable + Claude voice produced output (graceful degrade)
      const out = result.stdout + result.stderr;
      const claudeVoiceFired = /Claude\s+(CEO|subagent)|claude-subagent/i.test(out);
      const codexVoiceFired = /codex\s+(exec|review|CEO\s+voice)|\[via:codex\]/i.test(out);
      const codexUnavailable = /\[codex-unavailable\]|AUTH_FAILED|codex_cli_missing/i.test(out);

      expect(claudeVoiceFired).toBe(true);
      expect(codexVoiceFired || codexUnavailable).toBe(true);

      // Hang protection: if the skill reached Phase 1 at all, our hardening worked.
      // If it didn't, this is a regression from the pre-wave stdin-deadlock era.
      const reachedPhase1 = /Phase 1|CEO\s+Review|Strategy\s*&\s*Scope/i.test(out);
      expect(reachedPhase1).toBe(true);

      logCost(result);
      recordE2E('autoplan-dual-voice', result);
    },
    330_000, // per-test timeout slightly > spawn timeout so cleanup can run
  );
});
