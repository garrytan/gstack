/**
 * AUTO_DECIDE opt-in preserved under Conductor flags (periodic-tier, paid, real-PTY).
 *
 * Regression test for v1.21+ fix: the new "Tool resolution" preamble
 * (scripts/resolvers/preamble/generate-ask-user-format.ts) tells the model
 * to prefer mcp__*__AskUserQuestion variants and fall back to plan-file
 * decisions when neither is callable. This must NOT break the legitimate
 * `/plan-tune` AUTO_DECIDE path: when the user has explicitly opted into
 * auto-deciding a specific question via `gstack-question-preference --write
 * never-ask`, the model is supposed to honor that — it should still
 * auto-pick the recommended option and emit the AUTO_DECIDE annotation
 * ("Auto-decided <summary> → <option> (your preference). Change with
 * /plan-tune.") instead of opening a question prompt.
 *
 * Periodic tier: AUTO_DECIDE behavior depends on the model adhering to
 * the QUESTION_TUNING preamble injection. Non-deterministic; runs weekly
 * or manually rather than gating CI.
 *
 * Set up:
 *   - tmpDir as GSTACK_HOME (isolated state, doesn't touch the user's
 *     real ~/.gstack)
 *   - question_tuning=true in the tmp config
 *   - preference for plan-ceo-review-mode → never-ask (source: plan-tune)
 *
 * Spawn:
 *   claude --permission-mode plan --disallowedTools AskUserQuestion
 *   /plan-ceo-review
 *
 * Expected:
 *   - outcome === 'auto_decided' (the AUTO_DECIDE preamble fired and the
 *     "Auto-decided ... (your preference)" text rendered)
 *
 * If outcome is 'asked', the model ignored the user's `/plan-tune`
 * preference — that's a regression against the opt-in feature. If outcome
 * is 'plan_ready' with no AUTO_DECIDE text, the model auto-decided BUT
 * skipped the annotation (acceptable; AUTO_DECIDE annotation is good
 * practice but not the load-bearing behavior).
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation } from './helpers/claude-pty-runner';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

const ROOT = path.resolve(import.meta.dir, '..');

describeE2E('AUTO_DECIDE opt-in preserved under Conductor flags (periodic)', () => {
  test('user-opted-in question still auto-decides when AskUserQuestion is --disallowedTools', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-auto-decide-'));
    try {
      // 1. Bootstrap the tmp GSTACK_HOME with question_tuning=true.
      const configBin = path.join(ROOT, 'bin', 'gstack-config');
      const setRes = spawnSync(configBin, ['set', 'question_tuning', 'true'], {
        env: { ...process.env, GSTACK_HOME: tmpHome },
        encoding: 'utf-8',
      });
      if (setRes.status !== 0) {
        throw new Error(`gstack-config set failed: ${setRes.stderr || setRes.stdout}`);
      }

      // 2. Resolve slug for the project (uses git remote — same as the spawned
      //    claude would resolve). The preference file path keys on this slug.
      const slugBin = path.join(ROOT, 'bin', 'gstack-slug');
      const slugRes = spawnSync(slugBin, [], {
        cwd: ROOT,
        env: { ...process.env, GSTACK_HOME: tmpHome },
        encoding: 'utf-8',
      });
      // gstack-slug emits `eval`-able shell exports like `SLUG=garrytan-gstack`.
      const slug = (slugRes.stdout.match(/SLUG=([^\s;]+)/)?.[1] ?? 'unknown').replace(/['"]/g, '');

      // 3. Write the preference: plan-ceo-review-mode → never-ask. The
      //    'plan-tune' source bypasses the inline-user origin gate.
      const prefBin = path.join(ROOT, 'bin', 'gstack-question-preference');
      const writeRes = spawnSync(
        prefBin,
        ['--write', JSON.stringify({
          question_id: 'plan-ceo-review-mode',
          preference: 'never-ask',
          source: 'plan-tune',
        })],
        {
          env: { ...process.env, GSTACK_HOME: tmpHome },
          encoding: 'utf-8',
        },
      );
      if (writeRes.status !== 0) {
        throw new Error(`gstack-question-preference --write failed: ${writeRes.stderr || writeRes.stdout}`);
      }

      // Sanity: the preference file landed where we expect.
      const prefFile = path.join(tmpHome, 'projects', slug, 'question-preferences.json');
      if (!fs.existsSync(prefFile)) {
        throw new Error(`expected preference file at ${prefFile}; not found. slug=${slug}`);
      }

      // 4. Run /plan-ceo-review with the Conductor flag set + isolated state.
      const obs = await runPlanSkillObservation({
        skillName: 'plan-ceo-review',
        inPlanMode: true,
        extraArgs: ['--disallowedTools', 'AskUserQuestion'],
        timeoutMs: 300_000,
      });

      // 5. Pass: 'auto_decided' (the strongest signal) or 'plan_ready' with
      //    no question rendered. Fail: 'asked' (model ignored the opt-in).
      if (obs.outcome === 'asked') {
        throw new Error(
          `AUTO_DECIDE regression: the model surfaced an AskUserQuestion despite the user's never-ask preference.\n` +
            `summary: ${obs.summary}\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
      if (obs.outcome === 'silent_write' || obs.outcome === 'exited' || obs.outcome === 'timeout') {
        throw new Error(
          `AUTO_DECIDE preserve test inconclusive: outcome=${obs.outcome}\n` +
            `summary: ${obs.summary}\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
      expect(['auto_decided', 'plan_ready']).toContain(obs.outcome);
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 360_000);
});
