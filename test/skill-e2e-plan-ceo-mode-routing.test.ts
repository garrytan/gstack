/**
 * /plan-ceo-review mode-routing E2E (periodic, paid, real-PTY).
 *
 * Asserts: when /plan-ceo-review reaches its Step 0F mode-selection
 * AskUserQuestion and the user picks HOLD SCOPE or SCOPE EXPANSION,
 * the downstream rendered output reflects that mode's distinctive
 * posture language.
 *
 * Why this exists: existing tests verify that the question fires. Nothing
 * verifies the answer actually routes. A regression where Step 0F shows
 * the question but the agent ignores the choice (e.g. always defaults
 * to EXPANSION) would not be caught by any prior test.
 *
 * Tier: periodic (not gate). Each run navigates 8-12 prior AskUserQuestions (telemetry,
 * proactive, routing, vendoring, brain, office-hours, premise×3, approach)
 * before reaching Step 0F. At ~30s per AskUserQuestion that's a 4-6 min navigation
 * phase per case. The full 2-case suite runs ~12-15 min, $3-4. Too slow
 * for gate-tier; weekly is fine.
 *
 * Mode coverage: HOLD SCOPE + SCOPE EXPANSION cover the two posture poles
 * (rigor vs ambition). SELECTIVE EXPANSION and SCOPE REDUCTION are V2 once
 * the navigation phase is shorter or has a deterministic fast-path through
 * Step 0A/0C-bis.
 *
 * Posture assertions: each mode has distinct downstream language. The
 * checks below are deliberately permissive — they catch the binary
 * "did the mode posture even apply" question, not Opus-specific phrasing.
 *
 *   HOLD SCOPE        — "rigor" or "bulletproof" or "hold scope"
 *   SCOPE EXPANSION   — "expansion" or "10x" or "delight" or "dream"
 */

import { describe, test } from 'bun:test';
import {
  launchClaudePty,
  isNumberedOptionListVisible,
  isPermissionDialogVisible,
  parseNumberedOptions,
  isPlanReadyVisible,
  MODE_RE,
  optionsSignature,
  TAIL_SCAN_BYTES,
  type ClaudePtySession,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'periodic';
const describeE2E = shouldRun ? describe : describe.skip;

interface ModeCase {
  mode: 'HOLD SCOPE' | 'SCOPE EXPANSION';
  /** Regex applied to visible-since-mode-pick text. At least one must match. */
  postureRe: RegExp;
}

const CASES: ModeCase[] = [
  { mode: 'HOLD SCOPE',      postureRe: /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i },
  { mode: 'SCOPE EXPANSION', postureRe: /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i },
];

/**
 * Navigate prior AskUserQuestions by picking option 1 until we hit an AskUserQuestion whose
 * options match one of the 4 mode names. Returns the option index
 * matching `targetMode`, with the buffer marker pointing AT that AskUserQuestion.
 *
 * Throws if we don't reach the mode AskUserQuestion within `maxNav` prior AskUserQuestions or
 * the overall budget.
 */
async function navigateToModeAskUserQuestion(
  session: ClaudePtySession,
  since: number,
  targetMode: ModeCase['mode'],
  opts: { maxNav?: number; budgetMs?: number } = {},
): Promise<{ modeIndex: number; visibleAtMode: string }> {
  // /plan-ceo-review's mode AskUserQuestion (Step 0F) sits behind several preamble
  // and Step 0A-0C-bis gates: telemetry, proactive, routing, vendoring,
  // brain privacy, office-hours offer, premise challenge (3 questions),
  // approach selection. 12 hops is the conservative ceiling.
  const maxNav = opts.maxNav ?? 12;
  const budgetMs = opts.budgetMs ?? 420_000;
  const start = Date.now();
  let priorAnswered = 0;
  let lastSeenList: Array<{ index: number; label: string }> = [];

  while (Date.now() - start < budgetMs) {
    if (session.exited()) {
      throw new Error(
        `claude exited (code=${session.exitCode()}) during nav.\n` +
        `Last visible:\n${session.visibleSince(since).slice(-2000)}`,
      );
    }
    await Bun.sleep(2000);
    const visible = session.visibleSince(since);
    if (!isNumberedOptionListVisible(visible)) continue;
    const opts = parseNumberedOptions(visible);
    if (opts.length < 2) continue;

    // Has the rendered list changed since last poll? If not, we're seeing
    // the same prompt and shouldn't double-press.
    const sig = optionsSignature(opts);
    const lastSig = optionsSignature(lastSeenList);
    if (sig === lastSig) continue;
    lastSeenList = opts;

    // Is THIS the mode AskUserQuestion?
    if (opts.some(o => MODE_RE.test(o.label))) {
      const target = opts.find(o => o.label.toUpperCase().includes(targetMode));
      if (!target) {
        throw new Error(
          `Mode AskUserQuestion rendered but target "${targetMode}" not in option labels:\n` +
          opts.map(o => `  ${o.index}. ${o.label}`).join('\n'),
        );
      }
      return { modeIndex: target.index, visibleAtMode: visible };
    }

    // Permission dialog? Grant with "1" but don't count it against nav budget.
    // Classify on the recent tail only — old permission text persists in
    // visibleSince and would re-trigger forever.
    //
    // Note: runPlanSkillObservation has its own permission-dialog filter that
    // simply skips classification (since it observes, doesn't drive). This nav
    // loop drives the PTY directly via launchClaudePty and so owns its own
    // dialog handling — granting with "1" so the workflow advances. Both
    // paths share TAIL_SCAN_BYTES as the recent-tail window so tuning stays
    // in sync.
    if (isPermissionDialogVisible(visible.slice(-TAIL_SCAN_BYTES))) {
      session.send('1\r');
      await Bun.sleep(1500);
      continue;
    }

    // Not the mode AskUserQuestion — answer with option 1 (recommended) and continue.
    if (priorAnswered >= maxNav) {
      throw new Error(
        `Navigated ${maxNav} prior AskUserQuestions without reaching the mode AskUserQuestion. ` +
        `Last list:\n${opts.map(o => `  ${o.index}. ${o.label}`).join('\n')}`,
      );
    }
    priorAnswered++;
    session.send('1\r');
    // Give the agent a beat to advance before re-polling.
    await Bun.sleep(2000);
  }
  throw new Error(`Mode AskUserQuestion not reached within ${budgetMs}ms`);
}

describeE2E('/plan-ceo-review mode routing (gate)', () => {
  for (const c of CASES) {
    test(
      `mode "${c.mode}" routes to its distinctive posture`,
      async () => {
        const session = await launchClaudePty({
          permissionMode: 'plan',
          timeoutMs: 540_000,
        });
        try {
          await Bun.sleep(8000);
          const since = session.mark();
          session.send('/plan-ceo-review\r');

          const { modeIndex } = await navigateToModeAskUserQuestion(session, since, c.mode);

          // Snapshot the visible buffer at mode-pick time, then send the index.
          const sincePick = session.rawOutput().length;
          session.send(`${modeIndex}\r`);

          // Wait for downstream evidence: either next AskUserQuestion or plan_ready or
          // a posture-distinctive substring shows up.
          const budgetMs = 240_000;
          const start = Date.now();
          let postureMatched = false;
          let downstreamSnapshot = '';
          while (Date.now() - start < budgetMs) {
            await Bun.sleep(2500);
            if (session.exited()) {
              throw new Error(
                `claude exited (code=${session.exitCode()}) after mode pick.\n` +
                `Downstream:\n${session.visibleSince(sincePick).slice(-2000)}`,
              );
            }
            downstreamSnapshot = session.visibleSince(sincePick);
            if (c.postureRe.test(downstreamSnapshot)) {
              postureMatched = true;
              break;
            }
            // Don't bail early on plan_ready alone — the posture text may
            // arrive as the agent finishes writing the plan. Only break
            // once we either match posture or run the clock.
            if (
              isPlanReadyVisible(downstreamSnapshot) &&
              isNumberedOptionListVisible(downstreamSnapshot) &&
              !c.postureRe.test(downstreamSnapshot)
            ) {
              // Plan-ready AND a follow-up AskUserQuestion are both visible but
              // posture text has not appeared yet. Keep polling for a bit.
            }
          }
          if (!postureMatched) {
            throw new Error(
              `Mode "${c.mode}" routing FAILED: no posture match for ${c.postureRe.source}.\n` +
              `--- downstream visible since mode pick (last 3KB) ---\n` +
              downstreamSnapshot.slice(-3000),
            );
          }
        } finally {
          await session.close();
        }
      },
      600_000,
    );
  }
});
