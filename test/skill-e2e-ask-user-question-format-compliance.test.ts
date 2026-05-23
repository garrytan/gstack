/**
 * AskUserQuestion format-compliance smoke (gate, paid, real-PTY).
 *
 * Asserts: when /plan-ceo-review fires its first AskUserQuestion in plan
 * mode, the rendered TTY output contains every element the preamble
 * format spec mandates (scripts/resolvers/preamble/generate-ask-user-format.ts
 * + voice directive):
 *
 *   1. ELI10 prose paragraph
 *   2. "Recommendation:" line
 *   3. Pros/Cons header
 *   4. ✅ pro bullet AND ❌ con bullet
 *   5. "Net:" closer line
 *   6. "(recommended)" label on one option
 *
 * Why real-PTY: the existing skill-e2e-plan-format tests cover what the
 * AGENT writes via the SDK (capture-to-file harness). This test covers
 * what the USER actually sees in the terminal — different bug class
 * (e.g., AskUserQuestion tool truncates long prose, conductor renderer mangles
 * bullets, model collapses sections under token pressure). Two layers
 * of defense for a format-discipline regression that previously ate ~6
 * weeks of compliance drift before it was noticed.
 *
 * Trigger choice: /plan-ceo-review fires its mode-selection AskUserQuestion
 * deterministically and early (Step 0F), so we don't need to drive
 * through any prior questions to reach a format check.
 *
 * See test/helpers/claude-pty-runner.ts for runner internals.
 */

import { describe, test, expect } from 'bun:test';
import {
  launchClaudePty,
  isNumberedOptionListVisible,
  isPermissionDialogVisible,
  parseNumberedOptions,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

// Format predicates. Permissive on whitespace and capitalization.
// Tightening these is V2 if real drift is observed.
const ELI10_RE        = /ELI10\s*:/i;
const RECOMMEND_RE    = /Recommendation\s*:/i;
const PROS_CONS_RE    = /Pros\s*\/\s*cons\s*:/i;
const PRO_BULLET_RE   = /✅/;
const CON_BULLET_RE   = /❌/;
const NET_LINE_RE     = /^[\s|]*Net\s*:/im;
const RECOMMENDED_LBL = /\(recommended\)/i;

interface FormatGap {
  field: string;
  re: RegExp;
}

function findFormatGaps(visible: string): FormatGap[] {
  const checks: FormatGap[] = [
    { field: 'ELI10:', re: ELI10_RE },
    { field: 'Recommendation:', re: RECOMMEND_RE },
    { field: 'Pros / cons:', re: PROS_CONS_RE },
    { field: '✅ pro bullet', re: PRO_BULLET_RE },
    { field: '❌ con bullet', re: CON_BULLET_RE },
    { field: 'Net:', re: NET_LINE_RE },
    { field: '(recommended) label', re: RECOMMENDED_LBL },
  ];
  return checks.filter(c => !c.re.test(visible));
}

describeE2E('AskUserQuestion format compliance (gate)', () => {
  test(
    'first AskUserQuestion from /plan-ceo-review contains all 7 mandated format elements',
    async () => {
      const session = await launchClaudePty({
        permissionMode: 'plan',
        timeoutMs: 600_000,
      });

      try {
        // Boot grace + auto trust-dialog handler.
        await Bun.sleep(8000);
        const since = session.mark();
        session.send('/plan-ceo-review\r');

        // Wait for a SKILL AskUserQuestion. Strategy: poll the visible buffer until it
        // contains both a numbered-option list AND the format markers we
        // expect (ELI10 + Recommendation). When both are present, it IS a
        // real format-compliant AskUserQuestion — not a permission dialog or trust
        // prompt.
        //
        // While polling, auto-grant any permission dialogs we see in the
        // recent tail (preamble side-effects: touch on a sensitive file,
        // etc) so the agent isn't blocked.
        //
        // Budget bumped 300s → 540s in v1.32: /plan-ceo-review's preamble runs
        // multiple bash blocks (gbrain sync probe, telemetry, learnings search,
        // dashboard read) before reaching its mode-selection AskUserQuestion in
        // Step 0F. On substantive branches (or under contention from concurrent
        // tests running at max-concurrency 15), 300s sometimes wasn't enough
        // for the model to drain Step 0 work before emitting the first AUQ.
        // 540s sits below the suite-level 360s/9min timeout headroom and
        // tracks the same magnitude the plan-design-with-ui test uses.
        const budgetMs = 540_000;
        const start = Date.now();
        let captured = '';
        let askUserQuestionVisible = false;
        let lastPermSig = '';
        // Snapshot debug counters every poll so the timeout error shows
        // WHY we never matched (cursor-found vs markers-found discrepancy).
        let debugCursorSeen = 0;
        let debugMarkersSeen = 0;
        let debugBothSeen = 0;

        while (Date.now() - start < budgetMs) {
          await Bun.sleep(2000);
          if (session.exited()) {
            throw new Error(
              `claude exited (code=${session.exitCode()}) before AskUserQuestion rendered.\n` +
                `Last visible:\n${session.visibleSince(since).slice(-2000)}`,
            );
          }
          const visible = session.visibleSince(since);
          // Marker check: anywhere in the post-slash region. Since `since`
          // is set right after sending /plan-ceo-review, there's no stale
          // AskUserQuestion above this line — the only AskUserQuestion that can produce these
          // markers is the current one.
          const hasEli10 = /ELI10\s*:/i.test(visible);
          const hasRecommend = /Recommendation\s*:/i.test(visible);

          // Cursor check: a numbered option list near the bottom of the
          // buffer means the AskUserQuestion is currently rendered (not scrolled away).
          const cursorTail = visible.slice(-4000);
          const hasCursor = isNumberedOptionListVisible(cursorTail) &&
                            parseNumberedOptions(cursorTail).length >= 2;

          if (hasCursor) debugCursorSeen++;
          if (hasEli10 && hasRecommend) debugMarkersSeen++;

          // Permission dialog branch: grant once per unique rendering, but
          // only when we don't already have format markers visible (so we
          // don't accidentally grant a permission inside a real AskUserQuestion).
          if (
            hasCursor &&
            !(hasEli10 && hasRecommend) &&
            isPermissionDialogVisible(cursorTail)
          ) {
            const sig = visible.slice(-500);
            if (sig !== lastPermSig) {
              lastPermSig = sig;
              session.send('1\r');
              await Bun.sleep(1500);
              continue;
            }
          }

          // Real AskUserQuestion check: cursor visible AND markers present anywhere in
          // the post-slash region.
          if (hasCursor && hasEli10 && hasRecommend) {
            debugBothSeen++;
            captured = visible;
            askUserQuestionVisible = true;
            break;
          }
        }
        if (!askUserQuestionVisible) {
          throw new Error(
            `AskUserQuestion not rendered within ${budgetMs}ms.\n` +
              `Debug counts: cursorSeen=${debugCursorSeen} markersSeen=${debugMarkersSeen} bothSeen=${debugBothSeen}\n` +
              `Last visible (4KB):\n${session.visibleSince(since).slice(-4000)}`,
          );
        }
        const gaps = findFormatGaps(captured);
        if (gaps.length > 0) {
          // Surface the captured text last 3KB on failure for debugging.
          const tail = captured.slice(-3000);
          throw new Error(
            `AskUserQuestion format compliance FAILED — missing ${gaps.length} mandated field(s):\n` +
              gaps.map(g => `  - ${g.field} (regex: ${g.re.source})`).join('\n') +
              `\n--- captured (last 3KB) ---\n${tail}`,
          );
        }

        // Sanity: the parsed option list contains at least 2 options and
        // one of them carries the (recommended) marker.
        const opts = parseNumberedOptions(captured);
        expect(opts.length).toBeGreaterThanOrEqual(2);
        const hasRecommended = opts.some(o => /\(recommended\)/i.test(o.label));
        if (!hasRecommended) {
          // It's also acceptable for the (recommended) marker to live in
          // prose above the box (some renderers wrap labels). The text-level
          // RECOMMENDED_LBL check above already covers that case.
          // Surface a friendlier message if the box itself missed it.
          // (This is non-fatal because findFormatGaps already passed.)
          // eslint-disable-next-line no-console
          console.warn(
            '(recommended) label appears in prose but not on a parsed option label — acceptable but watch for drift',
          );
        }
      } finally {
        await session.close();
      }
    },
    660_000,
  );
});
