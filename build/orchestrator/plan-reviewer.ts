/**
 * Plan-level second-opinion reviewer (planReviewer role).
 *
 * Runs at gstack-build startup, before Phase 1 of Feature 1. Invokes the
 * configured planReviewer sub-agent (default: Codex/gpt-5.5/high), parses
 * its structured output, and routes by severity:
 *
 *   APPROVE              → annotate plan file, proceed
 *   REVISE/SUGGESTION    → inline comment annotations, proceed
 *   REVISE/IMPORTANT     → readline prompt (TTY) or auto-accept (non-TTY), proceed
 *   REVISE/CRITICAL      → write JSON report atomically, return "critical_exit"
 *                          (caller does process.exit(3))
 *
 * Templates:
 *   parsePlanReviewVerdict   ← feature-review.ts::parseFeatureReviewVerdict
 *   runPlanReview            ← sub-agents.ts::runCodexReview (file I/O pattern)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { ensureLogDir } from "./state";
import {
  runConfiguredRoleTask,
  isLikelyCodexTransportFailure,
} from "./sub-agents";
import type { RoleConfig } from "./role-config";
import type {
  PlanReviewVerdict,
  PlanReviewObjection,
  PlanReviewSeverity,
} from "./types";

export type { PlanReviewVerdict, PlanReviewObjection, PlanReviewSeverity };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the planReviewer's structured output into a PlanReviewVerdict.
 *
 * Expected format:
 *   PLAN_REVIEW: APPROVE | REVISE
 *   (objection lines only when REVISE)
 *   ## Overall Assessment
 *   <prose>
 *
 * Tolerant of extra whitespace. Returns a synthetic APPROVE verdict and logs
 * a warning on malformed output — never blocks the build on a broken review.
 */
export function parsePlanReviewVerdict(
  output: string,
  opts?: { reviewedBy?: string; round?: number },
): PlanReviewVerdict {
  const reviewedBy = opts?.reviewedBy ?? "unknown";
  const round = opts?.round ?? 1;

  const verdictMatch = output.match(/^PLAN_REVIEW:\s*(APPROVE|REVISE)\s*$/m);
  if (!verdictMatch) {
    console.warn(
      "[plan-review] malformed reviewer output — no PLAN_REVIEW: line found; treating as APPROVE",
    );
    return {
      verdict: "APPROVE",
      objections: [],
      assessment: "",
      reviewedBy,
      round,
    };
  }

  const verdict = verdictMatch[1] as PlanReviewSeverity;
  const objections: PlanReviewObjection[] = [];

  if (verdict === "REVISE") {
    // Match lines like: - CRITICAL: [Feature 2, Phase 1] issue text → suggestion text
    const objectionRe =
      /^-\s+(CRITICAL|IMPORTANT|SUGGESTION):\s+\[([^\]]+)\]\s+(.*?)\s+→\s+(.*?)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = objectionRe.exec(output)) !== null) {
      objections.push({
        severity: m[1] as PlanReviewObjection["severity"],
        location: m[2].trim(),
        issue: m[3].trim(),
        suggestion: m[4].trim(),
      });
    }

    // Log a warning for lines that look like objections but are malformed (missing →).
    const malformedRe = /^-\s+(CRITICAL|IMPORTANT|SUGGESTION):/gm;
    let mal: RegExpExecArray | null;
    while ((mal = malformedRe.exec(output)) !== null) {
      const line = output.slice(mal.index, output.indexOf("\n", mal.index));
      if (!line.includes("→")) {
        console.warn(
          `[plan-review] malformed objection line (missing →): ${line.trim()}`,
        );
      }
    }
  }

  const assessmentMatch = output.match(
    /##\s*Overall Assessment\s*\n([\s\S]*?)(?=\n##\s|$)/,
  );
  const assessment = assessmentMatch ? assessmentMatch[1].trim() : "";

  return { verdict, objections, assessment, reviewedBy, round };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Top-of-file HTML comment header written after any non-CRITICAL verdict. */
function buildAnnotationHeader(opts: {
  reviewed: string;
  reviewer: string;
  round: number;
  objectionsCritical: number;
  objectionsImportant: number;
  objectionsSuggestion: number;
  resolution: string;
}): string {
  const ts = new Date().toISOString();
  return (
    `<!-- gstack-plan-review\n` +
    `reviewed: ${opts.reviewed}\n` +
    `reviewer: ${opts.reviewer}\n` +
    `round: ${opts.round}\n` +
    `ts: ${ts}\n` +
    `objections_critical: ${opts.objectionsCritical}\n` +
    `objections_important: ${opts.objectionsImportant}\n` +
    `objections_suggestion: ${opts.objectionsSuggestion}\n` +
    `resolution: ${opts.resolution}\n` +
    `-->\n`
  );
}

/** Prepend annotation to plan file, inserting before the first ## Feature heading. */
function prependAnnotation(planPath: string, annotation: string): void {
  const content = fs.readFileSync(planPath, "utf8");
  // Replace existing annotation if present (may appear after a # Title preamble, not at byte 0).
  const annotIdx = content.indexOf("<!-- gstack-plan-review");
  if (annotIdx >= 0) {
    const endComment = content.indexOf("-->\n", annotIdx);
    const rest = endComment >= 0 ? content.slice(endComment + 4) : content;
    fs.writeFileSync(
      planPath,
      content.slice(0, annotIdx) + annotation + rest,
      "utf8",
    );
    return;
  }
  // Insert before first ## Feature heading if present; else prepend.
  const featureIdx = content.search(/^## Feature /m);
  if (featureIdx >= 0) {
    fs.writeFileSync(
      planPath,
      content.slice(0, featureIdx) + annotation + content.slice(featureIdx),
      "utf8",
    );
  } else {
    fs.writeFileSync(planPath, annotation + content, "utf8");
  }
}

/** Append inline objection comments after the matching feature/phase heading. */
function applyInlineAnnotations(
  planPath: string,
  objections: PlanReviewObjection[],
): void {
  let content = fs.readFileSync(planPath, "utf8");
  for (const obj of objections) {
    // Try to find "### Phase N" heading matching the location.
    const phaseMatch = obj.location.match(/Phase\s+(\S+)/i);
    if (phaseMatch) {
      // Add (?!\d) to prevent "Phase 1" matching "Phase 10", "Phase 11", etc.
      const phaseRe = new RegExp(
        `(###\\s*Phase\\s+${escapeRegExp(phaseMatch[1])}(?!\\d)[^\\n]*)`,
        "m",
      );
      const comment = `\n<!-- ${obj.severity} [${obj.location}]: ${obj.issue} → ${obj.suggestion} -->`;
      content = content.replace(phaseRe, `$1${comment}`);
    }
  }
  fs.writeFileSync(planPath, content, "utf8");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Prompt the user to apply, skip, or partially accept IMPORTANT objections. */
async function promptImportantObjections(
  objections: PlanReviewObjection[],
): Promise<PlanReviewObjection[]> {
  const important = objections.filter((o) => o.severity === "IMPORTANT");
  if (important.length === 0) return [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const accepted: PlanReviewObjection[] = [];
  try {
    for (const obj of important) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `\n[plan-review] IMPORTANT: [${obj.location}]\n  Issue: ${obj.issue}\n  Fix: ${obj.suggestion}\n  Apply? [y/skip/all] `,
          resolve,
        );
      });
      const ans = answer.trim().toLowerCase();
      if (ans === "all") {
        return important;
      }
      if (ans !== "skip" && ans !== "s") {
        accepted.push(obj);
      }
    }
  } finally {
    rl.close();
  }
  return accepted;
}

/**
 * Route the parsed verdict to the appropriate action.
 *
 * Returns "proceed" or "critical_exit". Caller does process.exit(3) on
 * "critical_exit".
 */
export async function reconcilePlanReview(
  verdict: PlanReviewVerdict,
  planPath: string,
  opts: {
    /** Absolute path for the JSON report written on CRITICAL (atomic rename). */
    planReviewReportPath: string;
  },
): Promise<"proceed" | "critical_exit"> {
  const critical = verdict.objections.filter((o) => o.severity === "CRITICAL");
  const important = verdict.objections.filter(
    (o) => o.severity === "IMPORTANT",
  );
  const suggestions = verdict.objections.filter(
    (o) => o.severity === "SUGGESTION",
  );

  // ---------- APPROVE ----------
  if (verdict.verdict === "APPROVE") {
    const annotation = buildAnnotationHeader({
      reviewed: "APPROVE",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: 0,
      objectionsImportant: 0,
      objectionsSuggestion: 0,
      resolution:
        verdict.reviewedBy === "skipped-unavailable"
          ? "skipped-unavailable"
          : "approved",
    });
    prependAnnotation(planPath, annotation);
    console.log(
      `[plan-review] ${verdict.reviewedBy === "skipped-unavailable" ? "⚠ skipped (reviewer unavailable)" : "✓ APPROVED"}`,
    );
    return "proceed";
  }

  // ---------- REVISE — CRITICAL takes priority ----------
  if (critical.length > 0) {
    const annotation = buildAnnotationHeader({
      reviewed: "CRITICAL",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: critical.length,
      objectionsImportant: important.length,
      objectionsSuggestion: suggestions.length,
      resolution: "critical-exit-pending-resynth",
    });
    prependAnnotation(planPath, annotation);

    // Atomic write: temp file → rename.
    const reportDir = path.dirname(opts.planReviewReportPath);
    fs.mkdirSync(reportDir, { recursive: true });
    const tmp = path.join(
      reportDir,
      `.plan-review-report-${Date.now()}.tmp.json`,
    );
    fs.writeFileSync(tmp, JSON.stringify(verdict, null, 2), "utf8");
    fs.renameSync(tmp, opts.planReviewReportPath);

    console.error(
      `[plan-review] ✗ CRITICAL objections found (${critical.length}) — exiting with code 3.\n` +
        `  Report: ${opts.planReviewReportPath}\n` +
        `  Re-synthesis round: ${verdict.round}`,
    );
    for (const c of critical) {
      console.error(`  • [${c.location}] ${c.issue}`);
    }
    return "critical_exit";
  }

  // ---------- REVISE — SUGGESTION only ----------
  if (important.length === 0) {
    applyInlineAnnotations(planPath, suggestions);
    const annotation = buildAnnotationHeader({
      reviewed: "REVISE-SUGGESTIONS",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: 0,
      objectionsImportant: 0,
      objectionsSuggestion: suggestions.length,
      resolution: "approved",
    });
    prependAnnotation(planPath, annotation);
    console.log(
      `[plan-review] ✓ REVISE (${suggestions.length} suggestion(s) annotated inline)`,
    );
    return "proceed";
  }

  // ---------- REVISE — IMPORTANT ----------
  if (!process.stdin.isTTY) {
    // Non-interactive (CI): auto-accept all IMPORTANT, annotate all inline, proceed.
    applyInlineAnnotations(planPath, [...important, ...suggestions]);
    const annotation = buildAnnotationHeader({
      reviewed: "REVISE-IMPORTANT-AUTO-ACCEPTED",
      reviewer: verdict.reviewedBy,
      round: verdict.round,
      objectionsCritical: 0,
      objectionsImportant: important.length,
      objectionsSuggestion: suggestions.length,
      resolution: "auto-accepted",
    });
    prependAnnotation(planPath, annotation);
    console.log(
      `[plan-review] ⚠ REVISE: ${important.length} IMPORTANT objection(s) auto-accepted (non-interactive mode)`,
    );
    for (const obj of important) {
      console.log(`  • [${obj.location}] ${obj.issue}`);
    }
    return "proceed";
  }

  // Interactive: prompt per-objection.
  console.log(
    `\n[plan-review] REVISE: ${important.length} IMPORTANT objection(s) need your input.`,
  );
  const accepted = await promptImportantObjections(verdict.objections);
  applyInlineAnnotations(planPath, [...accepted, ...suggestions]);

  const annotation = buildAnnotationHeader({
    reviewed: "REVISE-IMPORTANT-ACCEPTED",
    reviewer: verdict.reviewedBy,
    round: verdict.round,
    objectionsCritical: 0,
    objectionsImportant: important.length,
    objectionsSuggestion: suggestions.length,
    resolution: `user-accepted (${accepted.length}/${important.length})`,
  });
  prependAnnotation(planPath, annotation);
  console.log(
    `[plan-review] ✓ ${accepted.length}/${important.length} IMPORTANT objection(s) accepted by user`,
  );
  return "proceed";
}

// ---------------------------------------------------------------------------
// Sub-agent invocation
// ---------------------------------------------------------------------------

const PLAN_REVIEW_PROMPT = `Review this living implementation plan before autonomous TDD execution begins.

Review for:
1. COMPLETENESS — Does it cover all features from the source intent?
2. FEASIBILITY — Are phases reasonably scoped?
3. TEST COVERAGE GAPS — What edge cases or failure modes are missing?
4. RISK — Which phases are high-risk and need extra guard phases?
5. DEPENDENCIES — Implicit prerequisites not captured as phases?
6. TEST SPEC QUALITY — Does every phase have a \`#### Test Spec\` section?
   - Flag CRITICAL if SOME phases have \`#### Test Spec\` and OTHERS don't (structural
     inconsistency — the plan is malformed; the build will apply spec instructions
     to some phases but not others).
   - Flag IMPORTANT if NO phases have \`#### Test Spec\` (likely a legacy plan; user
     can pass --no-plan-review to proceed without fixing).
   - Flag IMPORTANT if a phase has a spec but fewer than 3 test cases, vague scenarios
     (no concrete inputs/outputs named), or no edge cases listed.
   - Flag SUGGESTION if the coverage target line is missing (add \`**Coverage target: ≥80%**\`).

Output format (strict, machine-parsed):
PLAN_REVIEW: APPROVE | REVISE

## Objections (omit section if APPROVE)
- CRITICAL: [Feature N, Phase M] <issue> → <suggested fix>
- IMPORTANT: [Feature N, Phase M] <issue> → <suggested fix>
- SUGGESTION: [Feature N, Phase M] <issue> → <suggested improvement>

## Overall Assessment
<1-2 paragraph assessment>
`;

/**
 * Invoke the configured planReviewer role and return a structured verdict.
 *
 * Single automatic retry on timeout or transport failure. On double-failure,
 * returns a synthetic APPROVE verdict with reviewedBy="skipped-unavailable"
 * so the build proceeds rather than blocking.
 */
export async function runPlanReview(opts: {
  planPath: string;
  role: RoleConfig;
  slug: string;
  timeoutMs: number;
  /** Absolute path to the log directory (logDir(slug)). */
  logDirPath: string;
  cwd: string;
  /** 1 or 2 — passed into the verdict for SKILL.md re-synthesis tracking. */
  round?: number;
}): Promise<PlanReviewVerdict> {
  const round = opts.round ?? 1;
  ensureLogDir(opts.slug);

  const planContent = (() => {
    try {
      return fs.readFileSync(opts.planPath, "utf8");
    } catch (err) {
      console.warn(
        `[plan-review] could not read plan file: ${(err as Error).message}`,
      );
      return "";
    }
  })();

  const inputPath = path.join(opts.logDirPath, "plan-review-input.md");
  const outputPath = path.join(opts.logDirPath, "plan-review-output.md");

  fs.writeFileSync(
    inputPath,
    `${PLAN_REVIEW_PROMPT}\n\n---\n\n## Living Plan\n\n${planContent}\n`,
    "utf8",
  );
  fs.writeFileSync(outputPath, "", "utf8");

  const syntheticApprove = (reason: string): PlanReviewVerdict => {
    console.warn(
      `[plan-review] ${reason} — proceeding with skipped-unavailable annotation`,
    );
    return {
      verdict: "APPROVE",
      objections: [],
      assessment: "",
      reviewedBy: "skipped-unavailable",
      round,
    };
  };

  const attempt = async (logSuffix: string) =>
    runConfiguredRoleTask({
      inputFilePath: inputPath,
      outputFilePath: outputPath,
      cwd: opts.cwd,
      slug: opts.slug,
      phaseNumber: "plan" as const,
      iteration: round,
      logPrefix: `plan-review${logSuffix}`,
      role: opts.role,
      timeoutMs: opts.timeoutMs,
      gate: false,
    });

  let result = await attempt("");

  if (
    result.timedOut ||
    (result.exitCode !== 0 && isLikelyCodexTransportFailure(result))
  ) {
    console.warn("[plan-review] first attempt failed — retrying once");
    // Reset output file for retry.
    fs.writeFileSync(outputPath, "", "utf8");
    result = await attempt("-retry");

    if (
      result.timedOut ||
      (result.exitCode !== 0 && isLikelyCodexTransportFailure(result))
    ) {
      return syntheticApprove(
        "reviewer timed out / transport failure on retry",
      );
    }
  }

  // Treat non-zero non-transport exit as "model not found" or misconfigured role.
  if (result.exitCode !== 0) {
    return syntheticApprove(
      `reviewer exited ${result.exitCode} (model not found or misconfigured) — check GSTACK_BUILD_PLANREVIEWER_MODEL`,
    );
  }

  const rawOutput = result.stdout || "";
  if (!rawOutput.trim()) {
    return syntheticApprove("reviewer produced no output");
  }

  return parsePlanReviewVerdict(rawOutput, {
    reviewedBy: opts.role.model,
    round,
  });
}
