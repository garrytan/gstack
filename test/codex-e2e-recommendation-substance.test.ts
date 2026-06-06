/**
 * /codex recommendation substance — LIVE grade (periodic, paid, Codex CLI).
 *
 * The gap this closes: skill-cross-model-recommendation-emit.test.ts only checks
 * the /codex TEMPLATE contains the "Recommendation: <action> because <reason>"
 * instruction (static grep). llm-judge-recommendation.test.ts grades the rubric
 * against FIXTURES. Nothing runs /codex live and grades the recommendation it
 * actually emits. The user reports codex recommendations were the least
 * consistent surface on main — so this is the one that needs live coverage.
 *
 * Method: drive the real /codex skill via codex exec (isolated temp HOME) over a
 * small, deliberately-flawed fixture diff. Capture codex's output, extract its
 * synthesis "Recommendation: ... because ..." line, and grade it with the same
 * judgeRecommendation() rubric used everywhere else:
 *   - present     : a Recommendation line exists
 *   - commits     : names exactly one action (no hedging)
 *   - has_because : a because-clause follows
 *   - substance>=4: the reason is option-specific / names a concrete tradeoff,
 *                   not boilerplate ("because it's better")
 *
 * Periodic tier (Codex non-determinism, ~$2-3/run).
 */
import { describe, test, expect } from 'bun:test';
import * as path from 'node:path';
import { runCodexSkill } from './helpers/codex-session-runner';
import { judgeRecommendation } from './helpers/llm-judge';

const ROOT = path.resolve(import.meta.dir, '..');

const CODEX_AVAILABLE = (() => {
  try {
    return Bun.spawnSync(['which', 'codex']).exitCode === 0;
  } catch {
    return false;
  }
})();
const shouldRun =
  CODEX_AVAILABLE && !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeCodex = shouldRun ? describe : describe.skip;

// A small fixture with two real, comparable problems so a good recommendation
// must CHOOSE (and justify the choice against the alternative) — the exact
// shape judgeRecommendation scores >= 4.
const FIXTURE_DIFF = `
Review this change. It has more than one issue; finish with a single synthesis
recommendation line in your skill's required format: "Recommendation: <action>
because <one-line reason that names the most important finding and why it beats
the alternative>."

--- a/server/auth.ts
+++ b/server/auth.ts
@@
 export function login(req, res) {
-  const user = db.query("SELECT * FROM users WHERE name = ?", [req.body.name]);
+  const user = db.query("SELECT * FROM users WHERE name = '" + req.body.name + "'");
   if (user && user.password === req.body.password) {
     res.cookie('session', user.id);  // no HttpOnly, no Secure, no expiry
     return res.json({ ok: true });
   }
   return res.status(401).json({ ok: false });
 }
`;

describeCodex('/codex recommendation substance (live, periodic)', () => {
  test(
    'codex emits a committed, substance>=4 synthesis recommendation',
    async () => {
      const result = await runCodexSkill({
        skillDir: path.join(ROOT, 'codex'),
        skillName: 'codex',
        prompt: FIXTURE_DIFF,
        timeoutMs: 300_000,
      });

      if (result.output.startsWith('SKIP:')) {
        // codex binary missing — describeCodex already guards, but double-safe.
        return;
      }

      const score = await judgeRecommendation(result.output);
      // eslint-disable-next-line no-console
      console.log(
        `[codex-rec] present=${score.present} commits=${score.commits} ` +
          `has_because=${score.has_because} substance=${score.reason_substance}\n` +
          `  reason: ${score.reason_text}`,
      );

      expect(score.present).toBe(true);
      expect(score.has_because).toBe(true);
      expect(score.commits).toBe(true);
      // The named weak spot: substance must clear the boilerplate bar.
      if (score.reason_substance < 4) {
        throw new Error(
          `codex recommendation substance ${score.reason_substance} < 4 (boilerplate/weak):\n` +
            `  reason: ${score.reason_text}\n` +
            `  judge: ${score.reasoning}\n` +
            `--- codex output (last 2KB) ---\n${result.output.slice(-2000)}`,
        );
      }
    },
    360_000,
  );
});
