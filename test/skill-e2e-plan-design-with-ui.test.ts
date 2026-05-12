/**
 * /plan-design-review with UI scope (gate, paid, real-PTY).
 *
 * Counterpart to the existing no-UI early-exit test. When the input plan
 * DOES describe UI changes, /plan-design-review must NOT early-exit and
 * must reach a real skill numbered-option AskUserQuestion (its first design-rating
 * question), with the captured evidence NOT echoing the early-exit phrase.
 *
 * Why: today we only test the negative path (no-UI → early-exit). A
 * regression that flips the UI-detection logic — making EVERY plan early-
 * exit — would pass the no-UI test (vacuously) and ship undetected. This
 * test is the positive coverage.
 *
 * How: launch claude in plan mode in the gstack repo cwd (so the skill
 * registry is loaded). Send /plan-design-review with the fixture path
 * inline so the skill reviews the UI-heavy plan rather than git diff or
 * .claude/plans/. Drive past permission dialogs. Wait for a numbered-
 * option list that is NOT a permission dialog. Assert evidence does NOT
 * contain "no UI scope".
 */

import { describe, test } from 'bun:test';
import * as path from 'path';
import {
  launchClaudePty,
  isNumberedOptionListVisible,
  isPermissionDialogVisible,
  parseNumberedOptions,
  isPlanReadyVisible,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

const ROOT = path.resolve(import.meta.dir, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'plans', 'ui-heavy-feature.md');

describeE2E('/plan-design-review with UI scope (gate)', () => {
  test(
    'reaches a real skill AskUserQuestion (or plan_ready) without echoing the no-UI early-exit phrase',
    async () => {
      const fixtureRelPath = path.relative(ROOT, FIXTURE);

      const session = await launchClaudePty({
        permissionMode: 'plan',
        cwd: ROOT,
        timeoutMs: 480_000,
      });

      let outcome: 'real_question' | 'plan_ready' | 'timeout' | 'exited' = 'timeout';
      let evidence = '';
      let debugBuffer = ''; // captured at end so timeout error has data

      try {
        await Bun.sleep(8000);
        const since = session.mark();
        // Send the slash command alone first; then provide the UI-heavy
        // plan content as a follow-up message. Claude Code rejects slash
        // commands with trailing arguments unless the skill defines them.
        session.send('/plan-design-review\r');
        await Bun.sleep(3000);
        session.send(
          `Please review this plan for UI scope:\n\n` +
          `Title: User Dashboard Page\n` +
          `New React page UserDashboard.tsx with three subcomponents: ` +
          `ActivityFeed, NotificationsPanel, QuickActions. ` +
          `Tailwind CSS responsive layout (mobile/desktop breakpoints), ` +
          `loading skeletons, empty states, hover states on every interactive element, ` +
          `modal dialog for "mark all read", toast notifications for action feedback. ` +
          `Reference plan file: ${fixtureRelPath}\r`
        );

        const budgetMs = 360_000;
        const start = Date.now();
        let lastPermSig = '';
        while (Date.now() - start < budgetMs) {
          await Bun.sleep(2500);
          if (session.exited()) {
            outcome = 'exited';
            evidence = session.visibleSince(since).slice(-3000);
            break;
          }
          const visible = session.visibleSince(since);

          // Classify the recent tail only — old permission text persists
          // in visibleSince(since) and would otherwise re-trigger forever.
          // 5KB window: plan-design-review Step 0 renders a numbered AUQ with
          // box dividers + per-option descriptions + footer prompt. The full
          // rendering frequently exceeds 2.5KB, especially after TTY cursor-
          // positioning escapes resolve through stripAnsi. A 2.5KB tail can
          // capture the cursor `❯1.` line without capturing the line that has
          // `2.`, defeating isNumberedOptionListVisible. 5KB comfortably
          // covers the full AUQ block without including stale scrollback.
          const recentTail = visible.slice(-5000);

          // Real skill AskUserQuestion visible (not a permission dialog)?
          if (
            isNumberedOptionListVisible(recentTail) &&
            parseNumberedOptions(recentTail).length >= 2 &&
            !isPermissionDialogVisible(recentTail)
          ) {
            outcome = 'real_question';
            evidence = visible.slice(-3000);
            break;
          }

          // Permission dialog: grant once per unique rendering.
          if (isPermissionDialogVisible(recentTail)) {
            const sig = visible.slice(-500);
            if (sig !== lastPermSig) {
              lastPermSig = sig;
              session.send('1\r');
              await Bun.sleep(1500);
              continue;
            }
          }

          // Plan-ready terminal — also acceptable (skill ran end-to-end
          // and surfaced claude's "Ready to execute" prompt).
          if (isPlanReadyVisible(visible)) {
            outcome = 'plan_ready';
            evidence = visible.slice(-3000);
            break;
          }
        }
        // Capture buffer state at end so a timeout error has diagnostic data.
        debugBuffer = session.visibleSince(since).slice(-4000);
      } finally {
        await session.close();
      }

      // PASS: real_question or plan_ready, AND evidence does NOT echo the
      // early-exit phrase.
      if (outcome === 'exited' || outcome === 'timeout') {
        throw new Error(
          `plan-design-review with UI scope FAILED: outcome=${outcome}\n` +
            `--- buffer at timeout (last 4KB) ---\n${debugBuffer || evidence}`,
        );
      }
      const NO_UI_PHRASE = /no\s+UI\s+scope|isn'?t\s+applicable/i;
      if (NO_UI_PHRASE.test(evidence)) {
        throw new Error(
          `plan-design-review early-exited despite UI-heavy fixture.\n` +
            `--- evidence (last 3KB) ---\n${evidence}`,
        );
      }
    },
    540_000,
  );
});
