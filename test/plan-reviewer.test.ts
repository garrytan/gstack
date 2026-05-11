/**
 * Unit tests for build/orchestrator/plan-reviewer.ts (tier: free).
 *
 * Tests parsePlanReviewVerdict() and reconcilePlanReview() without spawning
 * any sub-agents. runPlanReview() is tested via mock in the E2E tier.
 */

import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parsePlanReviewVerdict,
  reconcilePlanReview,
} from "../build/orchestrator/plan-reviewer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plan-reviewer-test-"));
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  dirs.length = 0;
});

function makePlanFile(dir: string, content?: string): string {
  const p = path.join(dir, "test-plan.md");
  fs.writeFileSync(
    p,
    content ??
      `# Test Plan\n\n## Feature 1: Core\n\n### Phase 1: Setup\n\n- [ ] **Implementation**: set it up\n- [ ] **Review**: check it\n`,
    "utf8",
  );
  return p;
}

function makeReportPath(dir: string): string {
  return path.join(dir, "plan-review-report.json");
}

// ---------------------------------------------------------------------------
// parsePlanReviewVerdict
// ---------------------------------------------------------------------------

describe("parsePlanReviewVerdict", () => {
  test("APPROVE verdict — no objections", () => {
    const output = `PLAN_REVIEW: APPROVE\n\n## Overall Assessment\nThe plan looks solid.\n`;
    const v = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });
    expect(v.verdict).toBe("APPROVE");
    expect(v.objections).toHaveLength(0);
    expect(v.assessment).toBe("The plan looks solid.");
    expect(v.reviewedBy).toBe("gpt-5.5");
    expect(v.round).toBe(1);
  });

  test("REVISE with SUGGESTION only", () => {
    const output = [
      "PLAN_REVIEW: REVISE",
      "",
      "## Objections",
      "- SUGGESTION: [Feature 1, Phase 1] consider adding a timeout → add a 5s timeout constant",
      "",
      "## Overall Assessment",
      "Mostly good, one suggestion.",
    ].join("\n");
    const v = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });
    expect(v.verdict).toBe("REVISE");
    expect(v.objections).toHaveLength(1);
    expect(v.objections[0].severity).toBe("SUGGESTION");
    expect(v.objections[0].location).toBe("Feature 1, Phase 1");
    expect(v.objections[0].issue).toBe("consider adding a timeout");
    expect(v.objections[0].suggestion).toBe("add a 5s timeout constant");
  });

  test("REVISE with IMPORTANT objection", () => {
    const output = [
      "PLAN_REVIEW: REVISE",
      "",
      "## Objections",
      "- IMPORTANT: [Feature 2, Phase 3] missing error handling → add try/catch around DB write",
      "",
      "## Overall Assessment",
      "One important gap.",
    ].join("\n");
    const v = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });
    expect(v.verdict).toBe("REVISE");
    const imp = v.objections.filter((o) => o.severity === "IMPORTANT");
    expect(imp).toHaveLength(1);
    expect(imp[0].location).toBe("Feature 2, Phase 3");
  });

  test("REVISE with CRITICAL objection", () => {
    const output = [
      "PLAN_REVIEW: REVISE",
      "",
      "## Objections",
      "- CRITICAL: [Feature 3, Phase 2] no tests for auth flow → add Phase 2.1 with auth tests",
      "",
      "## Overall Assessment",
      "Critical gap found.",
    ].join("\n");
    const v = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });
    expect(v.verdict).toBe("REVISE");
    const crit = v.objections.filter((o) => o.severity === "CRITICAL");
    expect(crit).toHaveLength(1);
    expect(crit[0].issue).toBe("no tests for auth flow");
  });

  test("REVISE with mixed CRITICAL + IMPORTANT objections", () => {
    const output = [
      "PLAN_REVIEW: REVISE",
      "",
      "## Objections",
      "- CRITICAL: [Feature 1, Phase 1] missing migration → add a db migration phase",
      "- IMPORTANT: [Feature 1, Phase 2] no rollback plan → add rollback step",
      "- SUGGESTION: [Feature 2, Phase 1] rename variable → use descriptive name",
      "",
      "## Overall Assessment",
      "Multiple issues.",
    ].join("\n");
    const v = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 2,
    });
    expect(v.verdict).toBe("REVISE");
    expect(v.objections).toHaveLength(3);
    expect(v.objections.filter((o) => o.severity === "CRITICAL")).toHaveLength(
      1,
    );
    expect(v.objections.filter((o) => o.severity === "IMPORTANT")).toHaveLength(
      1,
    );
    expect(
      v.objections.filter((o) => o.severity === "SUGGESTION"),
    ).toHaveLength(1);
    expect(v.round).toBe(2);
  });

  test("malformed output — no PLAN_REVIEW: line → synthetic APPROVE", () => {
    const output = "The plan looks great! Some suggestions follow...";
    const v = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });
    expect(v.verdict).toBe("APPROVE");
    expect(v.objections).toHaveLength(0);
    expect(v.reviewedBy).toBe("gpt-5.5");
  });

  test("malformed objection — missing → separator is skipped gracefully", () => {
    const output = [
      "PLAN_REVIEW: REVISE",
      "",
      "## Objections",
      "- IMPORTANT: [Feature 1, Phase 1] issue without arrow",
      "- SUGGESTION: [Feature 2, Phase 1] valid suggestion → fix it",
      "",
      "## Overall Assessment",
      "Mixed.",
    ].join("\n");
    const v = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });
    expect(v.verdict).toBe("REVISE");
    // Only the valid suggestion parses successfully; the malformed IMPORTANT is skipped
    expect(
      v.objections.filter((o) => o.severity === "SUGGESTION"),
    ).toHaveLength(1);
    expect(v.objections.filter((o) => o.severity === "IMPORTANT")).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// reconcilePlanReview — APPROVE
// ---------------------------------------------------------------------------

describe("reconcilePlanReview — APPROVE", () => {
  test("writes annotation header at top of plan file and returns 'proceed'", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planPath = makePlanFile(dir);
    const reportPath = makeReportPath(dir);

    const verdict = parsePlanReviewVerdict(
      "PLAN_REVIEW: APPROVE\n\n## Overall Assessment\nLooks good.\n",
      {
        reviewedBy: "gpt-5.5",
        round: 1,
      },
    );

    const outcome = await reconcilePlanReview(verdict, planPath, {
      planReviewReportPath: reportPath,
    });

    expect(outcome).toBe("proceed");
    const content = fs.readFileSync(planPath, "utf8");
    expect(content).toContain("<!-- gstack-plan-review");
    expect(content).toContain("reviewed: APPROVE");
    expect(content).toContain("reviewer: gpt-5.5");
    expect(content).toContain("resolution: approved");
    // Annotation appears before the first ## Feature heading
    const annotIdx = content.indexOf("<!-- gstack-plan-review");
    const featureIdx = content.indexOf("## Feature 1");
    expect(annotIdx).toBeGreaterThanOrEqual(0);
    expect(annotIdx).toBeLessThan(featureIdx);
    // No JSON report written for APPROVE
    expect(fs.existsSync(reportPath)).toBe(false);
  });

  test("skipped-unavailable annotation uses correct resolution label", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planPath = makePlanFile(dir);

    const verdict: import("../build/orchestrator/plan-reviewer").PlanReviewVerdict =
      {
        verdict: "APPROVE",
        objections: [],
        assessment: "",
        reviewedBy: "skipped-unavailable",
        round: 1,
      };

    const outcome = await reconcilePlanReview(verdict, planPath, {
      planReviewReportPath: makeReportPath(dir),
    });

    expect(outcome).toBe("proceed");
    const content = fs.readFileSync(planPath, "utf8");
    expect(content).toContain("resolution: skipped-unavailable");
  });
});

// ---------------------------------------------------------------------------
// reconcilePlanReview — SUGGESTION only
// ---------------------------------------------------------------------------

describe("reconcilePlanReview — REVISE/SUGGESTION", () => {
  test("inline comment placed near matching phase heading, returns 'proceed'", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planPath = makePlanFile(dir);
    const reportPath = makeReportPath(dir);

    const output = [
      "PLAN_REVIEW: REVISE",
      "## Objections",
      "- SUGGESTION: [Feature 1, Phase 1] add a constant → use TIMEOUT_MS = 5000",
      "## Overall Assessment",
      "Minor suggestion.",
    ].join("\n");
    const verdict = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });

    const outcome = await reconcilePlanReview(verdict, planPath, {
      planReviewReportPath: reportPath,
    });

    expect(outcome).toBe("proceed");
    const content = fs.readFileSync(planPath, "utf8");
    expect(content).toContain("<!-- SUGGESTION");
    expect(content).toContain("reviewed: REVISE-SUGGESTIONS");
    expect(fs.existsSync(reportPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcilePlanReview — IMPORTANT (non-TTY / CI)
// ---------------------------------------------------------------------------

describe("reconcilePlanReview — REVISE/IMPORTANT (non-TTY)", () => {
  test("auto-accepts all IMPORTANT in non-interactive mode, returns 'proceed'", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planPath = makePlanFile(dir);
    const reportPath = makeReportPath(dir);

    const output = [
      "PLAN_REVIEW: REVISE",
      "## Objections",
      "- IMPORTANT: [Feature 1, Phase 1] no error handling → add try/catch",
      "## Overall Assessment",
      "One important issue.",
    ].join("\n");
    const verdict = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });

    // process.stdin.isTTY is falsy in bun test — auto-accept path runs.
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    
    let outcome;
    try {
      outcome = await reconcilePlanReview(verdict, planPath, {
        planReviewReportPath: reportPath,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(outcome).toBe("proceed");
    const content = fs.readFileSync(planPath, "utf8");
    expect(content).toMatch(/REVISE-IMPORTANT-AUTO-ACCEPTED/);
    expect(content).toContain("resolution: auto-accepted");
    expect(fs.existsSync(reportPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcilePlanReview — CRITICAL
// ---------------------------------------------------------------------------

describe("reconcilePlanReview — REVISE/CRITICAL", () => {
  test("writes JSON report atomically and returns 'critical_exit'", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planPath = makePlanFile(dir);
    const reportPath = makeReportPath(dir);

    const output = [
      "PLAN_REVIEW: REVISE",
      "## Objections",
      "- CRITICAL: [Feature 2, Phase 1] auth tests missing → add Phase 2.1",
      "## Overall Assessment",
      "Critical gap.",
    ].join("\n");
    const verdict = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });

    const outcome = await reconcilePlanReview(verdict, planPath, {
      planReviewReportPath: reportPath,
    });

    expect(outcome).toBe("critical_exit");
    // JSON report written
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.verdict).toBe("REVISE");
    expect(report.round).toBe(1);
    expect(report.objections).toHaveLength(1);
    expect(report.objections[0].severity).toBe("CRITICAL");
    expect(report.objections[0].location).toBe("Feature 2, Phase 1");
    // No stale temp file left behind
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.includes(".tmp.json"));
    expect(tmpFiles).toHaveLength(0);
  });

  test("JSON report schema correctness", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planPath = makePlanFile(dir);
    const reportPath = makeReportPath(dir);

    const output = [
      "PLAN_REVIEW: REVISE",
      "## Objections",
      "- CRITICAL: [Feature 1, Phase 2] missing rollback → add rollback phase",
      "- IMPORTANT: [Feature 1, Phase 3] no retry → add retry logic",
      "## Overall Assessment",
      "Two issues, one critical.",
    ].join("\n");
    const verdict = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 2,
    });
    await reconcilePlanReview(verdict, planPath, {
      planReviewReportPath: reportPath,
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    // Required top-level fields
    expect(typeof report.verdict).toBe("string");
    expect(Array.isArray(report.objections)).toBe(true);
    expect(typeof report.assessment).toBe("string");
    expect(typeof report.reviewedBy).toBe("string");
    expect(typeof report.round).toBe("number");
    expect(report.round).toBe(2);
    // Objection schema
    for (const obj of report.objections) {
      expect(["CRITICAL", "IMPORTANT", "SUGGESTION"]).toContain(obj.severity);
      expect(typeof obj.location).toBe("string");
      expect(typeof obj.issue).toBe("string");
      expect(typeof obj.suggestion).toBe("string");
    }
  });

  test("plan file gets CRITICAL annotation header", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const planPath = makePlanFile(dir);

    const output = [
      "PLAN_REVIEW: REVISE",
      "## Objections",
      "- CRITICAL: [Feature 1, Phase 1] no migration → add migration phase",
      "## Overall Assessment",
      "Critical issue.",
    ].join("\n");
    const verdict = parsePlanReviewVerdict(output, {
      reviewedBy: "gpt-5.5",
      round: 1,
    });
    await reconcilePlanReview(verdict, planPath, {
      planReviewReportPath: makeReportPath(dir),
    });

    const content = fs.readFileSync(planPath, "utf8");
    expect(content).toContain("<!-- gstack-plan-review");
    expect(content).toContain("reviewed: CRITICAL");
    expect(content).toContain("objections_critical: 1");
  });
});
