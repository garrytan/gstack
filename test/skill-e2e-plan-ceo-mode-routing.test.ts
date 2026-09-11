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

import { test } from 'bun:test';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier } from './helpers/e2e-gate';
import {
  launchClaudePty,
  isNumberedOptionListVisible,
  isPlanReadyVisible,
  selectPtyNumberedOption,
  planCountQuestionInput,
  capturePlanCountQuestion,
  type AskUserQuestionFingerprint,
  type ClaudePtySession,
} from './helpers/claude-pty-runner';
import { hasNativePostAnswerCeoPosture, nextCeoModeNavigation, nextCeoPostureContinuation } from './helpers/ceo-mode-option';
import { createPlanCountFixture } from './helpers/plan-count-fixture';
import { readPlanCountTranscript, type NativePublicToolEvent, type PlanCountTranscript } from './helpers/plan-count-transcript';
import { readPendingQuestion, pendingQuestionRecorderStatus } from './helpers/plan-count-pending-question';
import { createPlanCountSnapshotWriter } from './helpers/plan-count-artifacts';

const describeE2E = describeE2ETier('periodic');

interface ModeCase {
  mode: 'HOLD SCOPE' | 'SCOPE EXPANSION';
  /** Regex applied to visible-since-mode-pick text. At least one must match. */
  postureRe: RegExp;
}

const CASES: ModeCase[] = [
  { mode: 'HOLD SCOPE',      postureRe: /\b(rigor|bulletproof|hold\s*scope|maximum\s+rigor)\b/i },
  { mode: 'SCOPE EXPANSION', postureRe: /\b(expansion|10x|delight|dream|cathedral|opt[\s-]?in)\b/i },
];

// Both cases review the same plan, available before the slash command starts.
// The checkout supplying skills must not become the implicit review target.
const PLAN = [
  '# Plan: Add saved project views',
  '',
  '## Review request',
  'Review this plan directly; skip optional /office-hours.',
  'After I select a review mode, briefly explain in your own words how you will',
  'apply that mode to this plan before asking the next review question.',
  '',
  '## Goal',
  'Team members repeatedly recreate filters on a project task list. Let each',
  'member save a named combination of filters and sort order and reopen it later.',
  '',
  '## Approach',
  '- Add a saved_views table scoped to the project and member.',
  '- Provide authenticated create, list, update, and delete endpoints.',
  '- Add a view picker and a save action beside the existing task filters.',
  '- Keep existing task access rules when applying a saved view.',
  '',
  '## Validation',
  '- Test persistence, project access, and reopening a view after task changes.',
  '- Measure whether members reuse saved views during a two-week pilot.',
].join('\n');

/**
 * Navigate prior AskUserQuestions with the existing prerequisite skip, otherwise option 1,
 * until we hit an AskUserQuestion whose
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
  cwd: string,
  opts: { maxNav?: number; budgetMs?: number;
    checkpoint?: (viewport: string, transcript: PlanCountTranscript | null) => void } = {},
): Promise<{ modeIndex: number; visibleAtMode: string; question: AskUserQuestionFingerprint }> {
  // /plan-ceo-review's mode AskUserQuestion (Step 0F) sits behind several preamble
  // and Step 0A-0C-bis gates: telemetry, proactive, routing, vendoring,
  // brain privacy, office-hours offer, premise challenge (3 questions),
  // approach selection. 12 hops is the conservative ceiling.
  const maxNav = opts.maxNav ?? 12;
  const budgetMs = opts.budgetMs ?? 420_000;
  const start = Date.now();
  let priorAnswered = 0;
  const seenQuestions = new Set<string>();

  while (Date.now() - start < budgetMs) {
    if (session.exited()) {
      throw new Error(
        `claude exited (code=${session.exitCode()}) during nav.\n` +
        `Last visible:\n${session.visibleSince(since).slice(-2000)}`,
      );
    }
    await Bun.sleep(2000);
    const visible = await session.currentScreen();
    const transcript = session.hermeticConfigDir ? readPlanCountTranscript(session.hermeticConfigDir, cwd) : null;
    opts.checkpoint?.(visible, transcript);
    const pending = transcript?.calls.find(call => !call.answered && !call.failed) ??
      (transcript ? readPendingQuestion(session.pendingQuestionFile, cwd, session.hermeticConfigDir, start, transcript) : undefined);
    const action = nextCeoModeNavigation(visible, targetMode, seenQuestions, pending, session.visibleText());
    if (action.kind === 'wait') continue;
    // Native permission and multi-question Submit menus are controls, not
    // review questions, so neither consumes the navigation question budget.
    if (action.kind === 'permission' || action.kind === 'submission') {
      session.send(action.input);
      await Bun.sleep(1500);
      continue;
    }
    if (action.kind === 'mode') {
      return { modeIndex: action.index, visibleAtMode: visible, question: action.question };
    }

    // Follow the captured prerequisite choice; other navigation still uses option 1.
    if (priorAnswered >= maxNav) {
      throw new Error(
        `Navigated ${maxNav} prior AskUserQuestions without reaching the mode AskUserQuestion. ` +
        `Target: ${targetMode}. Last question: ${action.question.promptSnippet}\n` +
        `Last list:\n${action.question.options.map(o => `  ${o.index}. ${o.label}`).join('\n')}`,
      );
    }
    priorAnswered++;
    const input = planCountQuestionInput(visible, action.question, action.index);
    if (input.includes('\r')) await selectPtyNumberedOption(session, action.index);
    else session.send(input);
    // Give the agent a beat to advance before re-polling.
    await Bun.sleep(2000);
  }
  throw new Error(
    `Mode AskUserQuestion for "${targetMode}" not reached within ${budgetMs}ms; priorAnswered=${priorAnswered}.\n` +
    `--- latest visible navigation (last 3KB) ---\n${session.visibleSince(since).slice(-3000)}`,
  );
}

describeE2E('/plan-ceo-review mode routing (gate)', () => {
  for (const c of CASES) {
    test(
      `mode "${c.mode}" routes to its distinctive posture`,
      async () => {
        const fixture = createPlanCountFixture(PLAN);
        let session: ClaudePtySession | undefined;
        const saveSnapshot = createPlanCountSnapshotWriter();
        let lastSnapshotAt = 0;
        let commandStartedAt = Date.now();
        let selectionStartedAt: number | undefined;
        let outcome = 'running';
        let artifacts: {artifactDir?: string; artifactError?: string} = {};
        const capture = (state: string, viewport: string, native: PlanCountTranscript | null, force = false) => {
          if (!session || (!force && Date.now() - lastSnapshotAt < 30_000)) return;
          artifacts = saveSnapshot({skillName:'plan-ceo-review-mode', cwd:fixture.cwd,
            claudeConfigDir:session.hermeticConfigDir, raw:session.rawOutput(), visible:session.visibleText(), viewport,
            observation:{state, targetMode:c.mode, commandStartedAt, selectionStartedAt, native,
              pendingQuestionRecorder:pendingQuestionRecorderStatus(session.pendingQuestionFile, fixture.cwd, session.hermeticConfigDir),
              pendingQuestion:native ? readPendingQuestion(session.pendingQuestionFile, fixture.cwd,
                session.hermeticConfigDir, commandStartedAt, native) : undefined,
              exitCode:session.exitCode(), retention:'Current raw/visible/viewport and parsed public native metadata; full parent JSONL retention is not guaranteed.'}});
          lastSnapshotAt = Date.now();
        };
        try {
          session = await launchClaudePty({
            cwd: fixture.cwd,
            permissionMode: 'plan',
            timeoutMs: CAPTURE_LONG_MS,
            seedSkills: true,
            observeScreen: true,
            observeSetupQuestions: true,
          });
          await Bun.sleep(8000);
          const since = session.mark();
          commandStartedAt = Date.now();
          session.send('/plan-ceo-review\r');

          const { modeIndex, visibleAtMode, question } = await navigateToModeAskUserQuestion(session, since, c.mode, fixture.cwd,
            {checkpoint:(viewport,native)=>capture('navigating',viewport,native)});

          // Native shortcuts accept immediately. Preserve the captured question
          // identity; only the legacy prose-menu protocol needs Enter.
          selectionStartedAt = Date.now();
          const modeInput = planCountQuestionInput(visibleAtMode, question, modeIndex);
          if (modeInput.includes('\r')) await selectPtyNumberedOption(session, modeIndex);
          else session.send(modeInput);
          const sincePick = session.mark();

          // Wait for downstream evidence: either next AskUserQuestion or plan_ready or
          // a posture-distinctive substring shows up.
          const budgetMs = 240_000;
          const start = Date.now();
          let postureMatched = false;
          let downstreamSnapshot = '';
          let transcript: PlanCountTranscript = { status: 'missing', calls: [], assistantMessages: [] };
          let continuedQuestion = false;
          const seenDownstream = new Set<string>();
          while (Date.now() - start < budgetMs) {
            await Bun.sleep(2500);
            if (session.exited()) {
              throw new Error(
                `claude exited (code=${session.exitCode()}) after mode "${c.mode}" option ${modeIndex}.\n` +
                `Downstream:\n${session.visibleSince(sincePick).slice(-2000)}`,
              );
            }
            downstreamSnapshot = session.visibleSince(sincePick);
            const publicTools: NativePublicToolEvent[] = [];
            transcript = session.hermeticConfigDir
              ? readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd, event => publicTools.push(event))
              : { status: 'error', calls: [], assistantMessages: [], error: 'No isolated mode transcript directory' };
            if (hasNativePostAnswerCeoPosture(transcript, c.mode, c.postureRe, selectionStartedAt, publicTools)) {
              postureMatched = true;
              break;
            }
            const currentInput = await session.currentScreen();
            capture('awaiting_posture', currentInput, transcript);
            const pendingQuestion = readPendingQuestion(session.pendingQuestionFile, fixture.cwd,
              session.hermeticConfigDir, selectionStartedAt, transcript);
            const continuation = nextCeoPostureContinuation(currentInput, transcript,
              c.mode, selectionStartedAt, seenDownstream, continuedQuestion, session.visibleText(), pendingQuestion);
            if (continuation !== null) {
              if (continuation === 'question') continuedQuestion = true;
              if (continuation === 'permission') await selectPtyNumberedOption(session, 1);
              else if (continuation === 'submission') session.send('\r');
              else {
                const pending = transcript.calls.find(call => !call.answered && !call.failed) ?? pendingQuestion;
                const question = capturePlanCountQuestion(currentInput, new Set(), 0, false, pending)!;
                const input = planCountQuestionInput(currentInput, question, 1);
                if (input.includes('\r')) await selectPtyNumberedOption(session, 1);
                else session.send(input);
              }
              continue;
            }
            // Don't bail early on plan_ready alone — the posture text may
            // arrive as the agent finishes writing the plan. Only break
            // once we either match posture or run the clock.
            if (
              isPlanReadyVisible(downstreamSnapshot) &&
              isNumberedOptionListVisible(downstreamSnapshot) &&
              !hasNativePostAnswerCeoPosture(transcript, c.mode, c.postureRe, selectionStartedAt, publicTools)
            ) {
              // Plan-ready AND a follow-up AskUserQuestion are both visible but
              // posture text has not appeared yet. Keep polling for a bit.
            }
          }
          if (!postureMatched) {
            throw new Error(
              `Mode "${c.mode}" routing FAILED after sending option ${modeIndex}: no posture match for ${c.postureRe.source}.\n` +
              `Native transcript: ${transcript.status}; ${transcript.calls.length} calls, ${transcript.assistantMessages.length} assistant messages; continuedQuestion=${continuedQuestion}.\n` +
              `Artifacts: ${JSON.stringify(artifacts)}\n` +
              `--- observed mode menu (last 3KB) ---\n${visibleAtMode.slice(-3000)}\n` +
              `--- downstream visible since mode pick (last 3KB) ---\n` +
              downstreamSnapshot.slice(-3000),
            );
          }
          outcome = 'posture_confirmed';
        } catch (error) {
          outcome = 'failed';
          throw error;
        } finally {
          try {
            if (session) {
              try {
                capture(outcome, await session.currentScreen(), session.hermeticConfigDir
                  ? readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd) : null, true);
              } finally { await session.close(); }
            }
          } finally {
            fixture.cleanup();
          }
        }
      },
      CAPTURE_LONG_MS,
    );
  }
});
