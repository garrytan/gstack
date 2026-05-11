/**
 * Skill fault detector — scans build state, plan files, and run artifacts
 * for well-known failure modes so the orchestrator can report them.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { BuildState } from "./types";
import {
  DEFAULT_MAX_CODEX_ITERATIONS,
  DEFAULT_MAX_TEST_ITERATIONS,
} from "./phase-runner";

export interface DetectorInput {
  state: BuildState | null;
  livingPlanPath: string;
  worktreePath: string;
  stateDir: string;
  stdoutLogPath: string;
}

export interface SkillFault {
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  description: string;
  sourceFiles: string[];
  evidence: {
    phaseIndex?: number;
    iterationCount?: number;
    stateValue?: string;
    planReviewRound?: number;
  };
}

function appendAnalytics(faults: SkillFault[]): void {
  const home = process.env.GSTACK_HOME ?? path.join(os.homedir(), ".gstack");
  const analyticsDir = path.join(home, "analytics");
  const analyticsPath = path.join(analyticsDir, "skill-faults.jsonl");
  try {
    fs.mkdirSync(analyticsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), faults }) + "\n";
    fs.appendFileSync(analyticsPath, line, "utf8");
  } catch {
    // Swallow analytics failures — must not block fault return.
  }
}

function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect skill faults from build state and run artifacts.
 * Never throws — bad inputs are handled gracefully.
 */
export function detectSkillFaults(input: DetectorInput): SkillFault[] {
  const faults: SkillFault[] = [];
  const state = input?.state ?? null;

  if (!state) {
    return faults;
  }

  try {
    // ------------------------------------------------------------------
    // CODEX_CONVERGENCE & TEST_FIXER_LOOP
    // ------------------------------------------------------------------
    if (state && Array.isArray(state.phases)) {
      for (const phase of state.phases) {
        if (
          phase.codexReview &&
          typeof phase.codexReview.iterations === "number" &&
          phase.codexReview.iterations >= DEFAULT_MAX_CODEX_ITERATIONS
        ) {
          faults.push({
            category: "CODEX_CONVERGENCE",
            severity: "HIGH",
            description: `Codex review did not converge after ${phase.codexReview.iterations} iterations (limit ${DEFAULT_MAX_CODEX_ITERATIONS}).`,
            sourceFiles: [],
            evidence: {
              phaseIndex: phase.index,
              iterationCount: phase.codexReview.iterations,
            },
          });
        }

        if (
          phase.testFix &&
          typeof phase.testFix.iterations === "number" &&
          phase.testFix.iterations >= DEFAULT_MAX_TEST_ITERATIONS
        ) {
          faults.push({
            category: "TEST_FIXER_LOOP",
            severity: "HIGH",
            description: `Test-fix loop did not converge after ${phase.testFix.iterations} iterations (limit ${DEFAULT_MAX_TEST_ITERATIONS}).`,
            sourceFiles: [],
            evidence: {
              phaseIndex: phase.index,
              iterationCount: phase.testFix.iterations,
            },
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // PREMATURE_COMPLETION — checked checkboxes for non-committed phases
    // ------------------------------------------------------------------
    const planContent = readFileSafe(input.livingPlanPath);
    if (planContent && state && Array.isArray(state.phases)) {
      // Split into phase blocks
      const blocks = planContent.split(/(?=### Phase)/);
      let phaseIdx = 0;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block.startsWith("### Phase")) continue;

        const phaseState = state.phases[phaseIdx];
        phaseIdx++;
        if (!phaseState) continue;
        if (phaseState.status === "committed") continue;

        const hasCheckedImpl = /^\s*-\s+\[[xX]\]\s+\*\*Implementation\b/m.test(block);
        const hasCheckedReview = /^\s*-\s+\[[xX]\]\s+\*\*Review & QA\b/m.test(block);

        if (hasCheckedImpl || hasCheckedReview) {
          faults.push({
            category: "PREMATURE_COMPLETION",
            severity: "MEDIUM",
            description: `Phase ${phaseState.number || i + 1} has checked task(s) but status is '${phaseState.status}', not 'committed'.`,
            sourceFiles: [input.livingPlanPath],
            evidence: { phaseIndex: phaseState.index ?? phaseIdx - 1 },
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // PLAN_SYNTHESIS_INVALID — missing Origin trace: or Acceptance:
    // ------------------------------------------------------------------
    if (planContent) {
      const blocks = planContent.split(/(?=### Phase)/);
      let phaseIdx = 0;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block.startsWith("### Phase")) continue;
        phaseIdx++;

        const hasOrigin = block.includes("Origin trace:");
        const hasAcceptance = block.includes("Acceptance:");

        if (!hasOrigin || !hasAcceptance) {
          faults.push({
            category: "PLAN_SYNTHESIS_INVALID",
            severity: "CRITICAL",
            description: `Phase block ${phaseIdx} is missing ${!hasOrigin && !hasAcceptance ? "Origin trace: and Acceptance:" : !hasOrigin ? "Origin trace:" : "Acceptance:"}.`,
            sourceFiles: [input.livingPlanPath],
            evidence: {},
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // WORKTREE_LEAK
    // ------------------------------------------------------------------
    if (state && state.completed === true && dirExists(input.worktreePath)) {
      faults.push({
        category: "WORKTREE_LEAK",
        severity: "MEDIUM",
        description: `Build is completed but worktree directory still exists at ${input.worktreePath}.`,
        sourceFiles: [],
        evidence: {},
      });
    }

    // ------------------------------------------------------------------
    // RED_SPEC_TRIVIAL
    // ------------------------------------------------------------------
    if (state && state.failureReason) {
      const reason = state.failureReason;
      if (reason.includes("trivially") || reason.includes("without implementation")) {
        faults.push({
          category: "RED_SPEC_TRIVIAL",
          severity: "MEDIUM",
          description: `Tests passed trivially without implementation: ${reason}`,
          sourceFiles: [],
          evidence: { stateValue: reason },
        });
      }
    }

    // ------------------------------------------------------------------
    // PLAN_MUTATOR_MISMATCH
    // ------------------------------------------------------------------
    if (state && state.failureReason) {
      const reason = state.failureReason;
      if (reason.includes("line not found") || reason.includes("checkbox")) {
        faults.push({
          category: "PLAN_MUTATOR_MISMATCH",
          severity: "HIGH",
          description: `Plan mutator could not locate expected content: ${reason}`,
          sourceFiles: [],
          evidence: {},
        });
      }
    }

    // ------------------------------------------------------------------
    // PLAN_REVIEW_STALEMATE
    // ------------------------------------------------------------------
    const reportPath = path.join(input.stateDir, "plan-review-report.json");
    const reportRaw = readFileSafe(reportPath);
    if (reportRaw) {
      try {
        const report = JSON.parse(reportRaw) as {
          round?: number;
          objections?: Array<{ severity?: string }>;
        };
        const round = typeof report.round === "number" ? report.round : 0;
        const hasCritical = Array.isArray(report.objections)
          ? report.objections.some(
              (o) => o && o.severity === "CRITICAL",
            )
          : false;
        if (round >= 3 && hasCritical) {
          faults.push({
            category: "PLAN_REVIEW_STALEMATE",
            severity: "CRITICAL",
            description: `Plan review is stalled at round ${round} with unresolved CRITICAL objections.`,
            sourceFiles: [reportPath],
            evidence: { planReviewRound: round },
          });
        }
      } catch {
        // Malformed JSON — ignore silently.
      }
    }

    // ------------------------------------------------------------------
    // FEATURE_VERIFIER_SCOPE
    // ------------------------------------------------------------------
    const stdoutContent = readFileSafe(input.stdoutLogPath);
    if (stdoutContent && stdoutContent.includes("VERIFICATION: GAPS")) {
      faults.push({
        category: "FEATURE_VERIFIER_SCOPE",
        severity: "HIGH",
        description: "Feature verifier reported gaps in feature coverage.",
        sourceFiles: [input.stdoutLogPath],
        evidence: {},
      });
    }
  } catch {
    // Outer safety net: never throw on bad input.
  }

  if (faults.length > 0) {
    appendAnalytics(faults);
  }

  return faults;
}
