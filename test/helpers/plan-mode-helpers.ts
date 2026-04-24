/**
 * Shared helpers for plan-mode E2E tests.
 *
 * Four sibling per-skill smoke tests (plan-ceo, plan-eng, plan-design, plan-devex)
 * plus the no-op regression test use this helper. The goal: run a review skill
 * in plan mode, confirm it goes straight to its Step 0 AskUserQuestion without
 * writing files or calling ExitPlanMode first (the vestigial handshake
 * regression we fixed in ceo-plan 2026-04-24).
 *
 * This file was renamed from `plan-mode-handshake-helpers.ts` when the
 * handshake was removed. The write-guard detection (no Write/Edit before the
 * first AskUserQuestion) is the load-bearing piece that catches silent
 * regressions a simple "first question text matches" check would miss.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  runAgentSdkTest,
  passThroughNonAskUserQuestion,
  resolveClaudeBinary,
  type AgentSdkResult,
} from './agent-sdk-runner';

/** Distinctive phrase matching what Claude Code's harness actually injects. */
export const PLAN_MODE_REMINDER =
  'Plan mode is active. The user indicated that they do not want you to execute yet';

export interface PlanModeCaptureResult {
  sdkResult: AgentSdkResult;
  /** Each AskUserQuestion that fired, with its input payload. */
  askUserQuestions: Array<{ input: Record<string, unknown>; orderIndex: number }>;
  /** Tool-use events in the order they fired (names only). */
  toolOrder: string[];
  /** Whether any Write or Edit tool fired BEFORE the first AskUserQuestion. */
  writeOrEditBeforeAsk: boolean;
  /** Whether ExitPlanMode fired BEFORE the first AskUserQuestion. */
  exitPlanModeBeforeAsk: boolean;
}

/**
 * Run a skill via the Agent SDK with canUseTool intercepting every tool use.
 * Inject the plan-mode distinctive phrase into the system prompt, auto-answer
 * the first AskUserQuestion (so the skill stops cleanly after Step 0), and
 * return the captured events for assertion.
 */
export async function runPlanModeSkillTest(opts: {
  /** Skill name, e.g. 'plan-ceo-review'. */
  skillName: string;
  /**
   * For the first AskUserQuestion, pick the option whose label contains this
   * substring. Pick a "cheap" answer that terminates the skill quickly (e.g.
   * "HOLD SCOPE" for plan-ceo-review).
   */
  firstAnswerSubstring: string;
  /** If true, DO NOT inject the reminder — used by the no-op regression test. */
  omitPlanModeReminder?: boolean;
  /** Max turns for the SDK call (default 4 — Step 0 + answer should fit). */
  maxTurns?: number;
}): Promise<PlanModeCaptureResult> {
  const { skillName, firstAnswerSubstring, omitPlanModeReminder, maxTurns } = opts;

  const askUserQuestions: PlanModeCaptureResult['askUserQuestions'] = [];
  const toolOrder: string[] = [];
  let toolIndex = 0;
  let firstAskIndex = -1;

  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `plan-mode-${skillName}-`),
  );

  const binary = resolveClaudeBinary();

  try {
    // In real plan mode Claude Code injects a system-reminder; in SDK tests we
    // use systemPrompt.append which the model treats as equally authoritative.
    const reminderAppend = omitPlanModeReminder
      ? ''
      : `\n\n<system-reminder>\n${PLAN_MODE_REMINDER}. This supercedes any other instructions you have received.\n</system-reminder>\n`;

    const sdkResult = await runAgentSdkTest({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: reminderAppend,
      },
      userPrompt: `Read the skill file at ${path.resolve(
        import.meta.dir,
        '..',
        '..',
        skillName,
        'SKILL.md',
      )} and follow its instructions. There is no real plan to review — just start the skill and respond to any AskUserQuestion that fires.`,
      workingDirectory: workingDir,
      maxTurns: maxTurns ?? 4,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      canUseTool: async (toolName, input) => {
        toolOrder.push(toolName);
        if (toolName === 'AskUserQuestion') {
          if (firstAskIndex === -1) firstAskIndex = toolIndex;
          askUserQuestions.push({ input, orderIndex: toolIndex });
          toolIndex++;
          // Auto-answer the FIRST question with the configured substring; for
          // later questions, pick the first option to keep the run short.
          const q = (input.questions as Array<{ question: string; options: Array<{ label: string }> }>)[0];
          const isFirst = askUserQuestions.length === 1;
          const matched = isFirst
            ? q.options.find((o) => o.label.toLowerCase().includes(firstAnswerSubstring.toLowerCase()))
            : undefined;
          const answer = matched ? matched.label : q.options[0]!.label;
          return {
            behavior: 'allow',
            updatedInput: {
              questions: input.questions,
              answers: { [q.question]: answer },
            },
          };
        }
        toolIndex++;
        return passThroughNonAskUserQuestion(toolName, input);
      },
    });

    const writeOrEditBeforeAsk =
      firstAskIndex > 0 &&
      toolOrder.slice(0, firstAskIndex).some((t) => t === 'Write' || t === 'Edit');

    const exitPlanModeBeforeAsk =
      firstAskIndex > 0 &&
      toolOrder.slice(0, firstAskIndex).some((t) => t === 'ExitPlanMode');

    return {
      sdkResult,
      askUserQuestions,
      toolOrder,
      writeOrEditBeforeAsk,
      exitPlanModeBeforeAsk,
    };
  } finally {
    try {
      fs.rmSync(workingDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Assert a captured AskUserQuestion is NOT the old vestigial handshake
 * (A=exit-and-rerun / C=cancel). The handshake is gone — if a test ever sees
 * one again, that's the regression we're guarding against.
 */
export function assertNotHandshakeShape(
  aq: { input: Record<string, unknown> },
): void {
  const questions = aq.input.questions as Array<{
    question: string;
    options: Array<{ label: string }>;
  }>;
  if (!questions || questions.length === 0) return;
  const q = questions[0]!;
  const labels = q.options.map((o) => o.label.toLowerCase());
  const looksLikeHandshake =
    labels.some((l) => l.includes('exit') && l.includes('rerun')) &&
    labels.some((l) => l.includes('cancel'));
  if (looksLikeHandshake) {
    throw new Error(
      `First AskUserQuestion looks like the vestigial plan-mode handshake ` +
      `(options: ${labels.join(', ')}). The handshake was removed; skills ` +
      `should go straight to their Step 0 question in plan mode.`,
    );
  }
}

export { execSync };
