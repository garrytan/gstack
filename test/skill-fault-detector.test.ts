/**
 * Unit tests for build/orchestrator/skill-fault-detector.ts (tier: free).
 *
 * RED phase of TDD — these tests are written before any implementation exists.
 * All tests MUST fail until skill-fault-detector.ts is created.
 *
 * Coverage:
 *   - detectSkillFaults() returns [] for null state and no-fault inputs
 *   - CODEX_CONVERGENCE: iterations >= DEFAULT_MAX_CODEX_ITERATIONS
 *   - TEST_FIXER_LOOP: iterations >= DEFAULT_MAX_TEST_ITERATIONS
 *   - PREMATURE_COMPLETION: [x] Implementation / [x] Review & QA in plan for non-committed phases
 *   - PLAN_SYNTHESIS_INVALID: phase block missing Origin trace: or Acceptance:
 *   - WORKTREE_LEAK: completed=true but worktreePath dir exists
 *   - RED_SPEC_TRIVIAL: failureReason contains 'trivially' or 'without implementation'
 *   - PLAN_MUTATOR_MISMATCH: failureReason contains 'line not found' or 'checkbox'
 *   - PLAN_REVIEW_STALEMATE: plan-review-report.json has round>=3 and CRITICAL objection
 *   - FEATURE_VERIFIER_SCOPE: stdoutLogPath contains "VERIFICATION: GAPS"
 *   - No throw on bad inputs (null state, non-existent paths, malformed files)
 *   - Analytics failures don't block fault return
 *   - Analytics appended to ${GSTACK_HOME}/analytics/skill-faults.jsonl
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  detectSkillFaults,
  type DetectorInput,
  type SkillFault,
} from "../build/orchestrator/skill-fault-detector";
import {
  DEFAULT_MAX_CODEX_ITERATIONS,
  DEFAULT_MAX_TEST_ITERATIONS,
} from "../build/orchestrator/phase-runner";
import type { BuildState, PhaseState } from "../build/orchestrator/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = fs.mkdtempSync(
    path.join(os.tmpdir(), "skill-fault-detector-test-"),
  );
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tmpDirs.length = 0;
});

let savedGstackHome: string | undefined;

beforeEach(() => {
  savedGstackHome = process.env.GSTACK_HOME;
});

afterEach(() => {
  if (savedGstackHome !== undefined) {
    process.env.GSTACK_HOME = savedGstackHome;
  } else {
    delete process.env.GSTACK_HOME;
  }
});

/** Minimal valid PhaseState for a committed phase. */
function committedPhase(index = 0): PhaseState {
  return {
    index,
    number: String(index + 1),
    name: `Phase ${index + 1}`,
    status: "committed",
  };
}

/** Minimal valid BuildState with one committed phase. */
function baseState(overrides: Partial<BuildState> = {}): BuildState {
  return {
    planFile: "/tmp/plan.md",
    planBasename: "plan",
    slug: "build-test",
    branch: "main",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    currentPhaseIndex: 0,
    phases: [committedPhase(0)],
    completed: false,
    ...overrides,
  };
}

/** Valid living plan content: all phase blocks have Origin trace: and Acceptance: */
function validPlanContent(numPhases = 1): string {
  const phases = Array.from({ length: numPhases }, (_, i) =>
    [
      `### Phase ${i + 1}: Something`,
      "",
      `Origin trace: Feature ${i + 1}`,
      `Acceptance: tests pass`,
      "",
      `- [ ] **Implementation**: implement it`,
      `- [ ] **Review & QA**: review it`,
    ].join("\n"),
  );
  return `# Test Plan\n\n## Feature 1: Core\n\n${phases.join("\n\n")}`;
}

/** Write a living plan file and return its path. */
function writePlan(dir: string, content: string): string {
  const p = path.join(dir, "plan.md");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/** Build a minimal DetectorInput. */
function makeInput(
  dir: string,
  overrides: Partial<DetectorInput> = {},
): DetectorInput {
  const planPath = path.join(dir, "plan.md");
  if (!fs.existsSync(planPath)) {
    writePlan(dir, validPlanContent());
  }
  const stdoutLog = path.join(dir, "run.log");
  if (!fs.existsSync(stdoutLog)) {
    fs.writeFileSync(stdoutLog, "", "utf8");
  }
  return {
    state: baseState(),
    livingPlanPath: planPath,
    worktreePath: path.join(dir, "worktree-nonexistent"),
    stateDir: dir,
    stdoutLogPath: stdoutLog,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Null / no-fault baseline
// ---------------------------------------------------------------------------

describe("detectSkillFaults — null / no-fault cases", () => {
  test("returns empty array when state is null", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, { state: null });
    const faults = detectSkillFaults(input);
    expect(Array.isArray(faults)).toBe(true);
    expect(faults).toHaveLength(0);
  });

  test("returns empty array when no faults apply (clean state)", () => {
    const dir = makeTmpDir();
    const faults = detectSkillFaults(makeInput(dir));
    expect(faults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CODEX_CONVERGENCE
// ---------------------------------------------------------------------------

describe("CODEX_CONVERGENCE", () => {
  test("detected when codexReview.iterations >= DEFAULT_MAX_CODEX_ITERATIONS", () => {
    const dir = makeTmpDir();
    const phaseWithHitLimit: PhaseState = {
      ...committedPhase(0),
      codexReview: {
        iterations: DEFAULT_MAX_CODEX_ITERATIONS,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseWithHitLimit] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "CODEX_CONVERGENCE");
    expect(fault).toBeDefined();
    expect(fault!.severity).toMatch(/^(CRITICAL|HIGH|MEDIUM)$/);
    expect(fault!.evidence.phaseIndex).toBe(0);
    expect(fault!.evidence.iterationCount).toBe(DEFAULT_MAX_CODEX_ITERATIONS);
  });

  test("not detected when codexReview.iterations is one below limit", () => {
    const dir = makeTmpDir();
    const phaseUnderLimit: PhaseState = {
      ...committedPhase(0),
      codexReview: {
        iterations: DEFAULT_MAX_CODEX_ITERATIONS - 1,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseUnderLimit] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "CODEX_CONVERGENCE"),
    ).toBeUndefined();
  });

  test("detected when codexReview.iterations exceeds limit", () => {
    const dir = makeTmpDir();
    const phaseOverLimit: PhaseState = {
      ...committedPhase(0),
      codexReview: {
        iterations: DEFAULT_MAX_CODEX_ITERATIONS + 2,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseOverLimit] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "CODEX_CONVERGENCE"),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TEST_FIXER_LOOP
// ---------------------------------------------------------------------------

describe("TEST_FIXER_LOOP", () => {
  test("detected when testFix.iterations >= DEFAULT_MAX_TEST_ITERATIONS", () => {
    const dir = makeTmpDir();
    const phaseAtLimit: PhaseState = {
      ...committedPhase(0),
      testFix: {
        iterations: DEFAULT_MAX_TEST_ITERATIONS,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseAtLimit] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "TEST_FIXER_LOOP");
    expect(fault).toBeDefined();
    expect(fault!.evidence.phaseIndex).toBe(0);
    expect(fault!.evidence.iterationCount).toBe(DEFAULT_MAX_TEST_ITERATIONS);
  });

  test("not detected when testFix.iterations is one below limit", () => {
    const dir = makeTmpDir();
    const phaseUnder: PhaseState = {
      ...committedPhase(0),
      testFix: {
        iterations: DEFAULT_MAX_TEST_ITERATIONS - 1,
        outputLogPaths: [],
      },
    };
    const input = makeInput(dir, {
      state: baseState({ phases: [phaseUnder] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "TEST_FIXER_LOOP"),
    ).toBeUndefined();
  });

  test("not detected when testFix is undefined", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ phases: [committedPhase(0)] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "TEST_FIXER_LOOP"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PREMATURE_COMPLETION
// ---------------------------------------------------------------------------

describe("PREMATURE_COMPLETION", () => {
  test("detected when plan has [x] **Implementation** for non-committed phase", () => {
    const dir = makeTmpDir();
    const planWithChecked = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [ ] **Review & QA**: not done",
    ].join("\n");
    const planPath = writePlan(dir, planWithChecked);
    const nonCommittedPhase: PhaseState = {
      ...committedPhase(0),
      status: "tests_green", // not 'committed'
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [nonCommittedPhase] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PREMATURE_COMPLETION");
    expect(fault).toBeDefined();
  });

  test("detected when plan has [x] **Review & QA** for non-committed phase", () => {
    const dir = makeTmpDir();
    const planWithChecked = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [x] **Review & QA**: done",
    ].join("\n");
    const planPath = writePlan(dir, planWithChecked);
    const nonCommittedPhase: PhaseState = {
      ...committedPhase(0),
      status: "review_clean",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [nonCommittedPhase] }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PREMATURE_COMPLETION");
    expect(fault).toBeDefined();
  });

  test("NOT detected when checked phase status IS committed", () => {
    const dir = makeTmpDir();
    const planWithChecked = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [x] **Implementation**: done",
      "- [x] **Review & QA**: done",
    ].join("\n");
    const planPath = writePlan(dir, planWithChecked);
    const committedPh: PhaseState = {
      ...committedPhase(0),
      status: "committed",
    };
    const input = makeInput(dir, {
      livingPlanPath: planPath,
      state: baseState({ phases: [committedPh] }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PREMATURE_COMPLETION"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PLAN_SYNTHESIS_INVALID
// ---------------------------------------------------------------------------

describe("PLAN_SYNTHESIS_INVALID", () => {
  test("detected when a phase block is missing Origin trace:", () => {
    const dir = makeTmpDir();
    const planMissingOrigin = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Acceptance: tests pass",
      "",
      "- [ ] **Implementation**: implement",
    ].join("\n");
    const planPath = writePlan(dir, planMissingOrigin);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID");
    expect(fault).toBeDefined();
  });

  test("detected when a phase block is missing Acceptance:", () => {
    const dir = makeTmpDir();
    const planMissingAcceptance = [
      "# Plan",
      "",
      "### Phase 1: Setup",
      "",
      "Origin trace: Feature 1",
      "",
      "- [ ] **Implementation**: implement",
    ].join("\n");
    const planPath = writePlan(dir, planMissingAcceptance);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID");
    expect(fault).toBeDefined();
  });

  test("NOT detected when all phase blocks have both Origin trace: and Acceptance:", () => {
    const dir = makeTmpDir();
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_SYNTHESIS_INVALID"),
    ).toBeUndefined();
  });

  test("detected for only the offending phase (multi-phase plan)", () => {
    const dir = makeTmpDir();
    const planMixed = [
      "# Plan",
      "",
      "### Phase 1: Good",
      "",
      "Origin trace: Feature 1",
      "Acceptance: tests pass",
      "",
      "- [ ] **Implementation**: implement phase 1",
      "",
      "### Phase 2: Bad",
      "",
      "Origin trace: Feature 2",
      // Missing Acceptance:
      "",
      "- [ ] **Implementation**: implement phase 2",
    ].join("\n");
    const planPath = writePlan(dir, planMixed);
    const input = makeInput(dir, { livingPlanPath: planPath });
    const faults = detectSkillFaults(input);
    const synthesisInvalid = faults.filter(
      (f) => f.category === "PLAN_SYNTHESIS_INVALID",
    );
    expect(synthesisInvalid.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// WORKTREE_LEAK
// ---------------------------------------------------------------------------

describe("WORKTREE_LEAK", () => {
  test("detected when state.completed=true but worktreePath directory exists", () => {
    const dir = makeTmpDir();
    const worktreePath = path.join(dir, "leaked-worktree");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "WORKTREE_LEAK");
    expect(fault).toBeDefined();
  });

  test("NOT detected when state.completed=true and worktreePath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath: path.join(dir, "nonexistent-worktree"),
    });
    const faults = detectSkillFaults(input);
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeUndefined();
  });

  test("NOT detected when state.completed=false even if worktreePath exists", () => {
    const dir = makeTmpDir();
    const worktreePath = path.join(dir, "active-worktree");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: false }),
      worktreePath,
    });
    const faults = detectSkillFaults(input);
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RED_SPEC_TRIVIAL
// ---------------------------------------------------------------------------

describe("RED_SPEC_TRIVIAL", () => {
  test("detected when failureReason contains 'trivially'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({
        failureReason: "Tests passed trivially without implementation",
      }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "RED_SPEC_TRIVIAL");
    expect(fault).toBeDefined();
    expect(fault!.evidence.stateValue).toContain("trivially");
  });

  test("detected when failureReason contains 'without implementation'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "Spec passed without implementation" }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "RED_SPEC_TRIVIAL");
    expect(fault).toBeDefined();
  });

  test("NOT detected when failureReason is unrelated", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "Network timeout during Gemini call" }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "RED_SPEC_TRIVIAL"),
    ).toBeUndefined();
  });

  test("NOT detected when failureReason is undefined", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir);
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "RED_SPEC_TRIVIAL"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PLAN_MUTATOR_MISMATCH
// ---------------------------------------------------------------------------

describe("PLAN_MUTATOR_MISMATCH", () => {
  test("detected when failureReason contains 'line not found'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({
        failureReason: "Plan mutation failed: line not found in plan file",
      }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_MUTATOR_MISMATCH");
    expect(fault).toBeDefined();
  });

  test("detected when failureReason contains 'checkbox'", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({
        failureReason: "Could not find checkbox in plan to flip",
      }),
    });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_MUTATOR_MISMATCH");
    expect(fault).toBeDefined();
  });

  test("NOT detected when failureReason is unrelated", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ failureReason: "Gemini timed out after 30 minutes" }),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "PLAN_MUTATOR_MISMATCH"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PLAN_REVIEW_STALEMATE
// ---------------------------------------------------------------------------

describe("PLAN_REVIEW_STALEMATE", () => {
  function writePlanReviewReport(stateDir: string, report: object): void {
    fs.writeFileSync(
      path.join(stateDir, "plan-review-report.json"),
      JSON.stringify(report),
      "utf8",
    );
  }

  test("detected when plan-review-report.json has round>=3 and CRITICAL objection", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 3,
      objections: [
        {
          severity: "CRITICAL",
          location: "Feature 1, Phase 1",
          issue: "missing tests",
          suggestion: "add tests",
        },
      ],
      assessment: "critical gap",
      reviewedBy: "gpt-5",
    });
    const input = makeInput(dir);
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE");
    expect(fault).toBeDefined();
    expect(fault!.evidence.planReviewRound).toBe(3);
  });

  test("detected when round > 3", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 5,
      objections: [
        { severity: "CRITICAL", location: "F1P1", issue: "x", suggestion: "y" },
      ],
      assessment: "",
      reviewedBy: "gpt-5",
    });
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeDefined();
  });

  test("NOT detected when round >= 3 but no CRITICAL objection", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 4,
      objections: [
        {
          severity: "IMPORTANT",
          location: "F1P1",
          issue: "x",
          suggestion: "y",
        },
      ],
      assessment: "",
      reviewedBy: "gpt-5",
    });
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });

  test("NOT detected when round < 3 even with CRITICAL objection", () => {
    const dir = makeTmpDir();
    writePlanReviewReport(dir, {
      verdict: "REVISE",
      round: 2,
      objections: [
        { severity: "CRITICAL", location: "F1P1", issue: "x", suggestion: "y" },
      ],
      assessment: "",
      reviewedBy: "gpt-5",
    });
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });

  test("NOT detected when plan-review-report.json does not exist", () => {
    const dir = makeTmpDir();
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });

  test("NOT detected when plan-review-report.json is malformed JSON", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, "plan-review-report.json"),
      "{not valid",
      "utf8",
    );
    const faults = detectSkillFaults(makeInput(dir));
    expect(
      faults.find((f) => f.category === "PLAN_REVIEW_STALEMATE"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FEATURE_VERIFIER_SCOPE
// ---------------------------------------------------------------------------

describe("FEATURE_VERIFIER_SCOPE", () => {
  test("detected when stdoutLogPath contains a line matching 'VERIFICATION: GAPS'", () => {
    const dir = makeTmpDir();
    const stdoutLog = path.join(dir, "run.log");
    fs.writeFileSync(
      stdoutLog,
      [
        "Phase 1 starting...",
        "VERIFICATION: GAPS found in feature coverage",
        "Phase 1 complete.",
      ].join("\n"),
      "utf8",
    );
    const input = makeInput(dir, { stdoutLogPath: stdoutLog });
    const faults = detectSkillFaults(input);
    const fault = faults.find((f) => f.category === "FEATURE_VERIFIER_SCOPE");
    expect(fault).toBeDefined();
  });

  test("NOT detected when stdoutLogPath does not contain 'VERIFICATION: GAPS'", () => {
    const dir = makeTmpDir();
    const stdoutLog = path.join(dir, "run.log");
    fs.writeFileSync(
      stdoutLog,
      "All verifications passed.\nFeature complete.\n",
      "utf8",
    );
    const input = makeInput(dir, { stdoutLogPath: stdoutLog });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "FEATURE_VERIFIER_SCOPE"),
    ).toBeUndefined();
  });

  test("NOT detected when stdoutLogPath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      stdoutLogPath: path.join(dir, "nonexistent.log"),
    });
    const faults = detectSkillFaults(input);
    expect(
      faults.find((f) => f.category === "FEATURE_VERIFIER_SCOPE"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Robustness — no throw on bad inputs
// ---------------------------------------------------------------------------

describe("detectSkillFaults — no throw on bad inputs", () => {
  test("does not throw when state is null", () => {
    const dir = makeTmpDir();
    expect(() =>
      detectSkillFaults(makeInput(dir, { state: null })),
    ).not.toThrow();
  });

  test("does not throw when livingPlanPath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      livingPlanPath: path.join(dir, "nonexistent-plan.md"),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when livingPlanPath is malformed/empty", () => {
    const dir = makeTmpDir();
    const emptyPlan = path.join(dir, "empty.md");
    fs.writeFileSync(emptyPlan, "", "utf8");
    const input = makeInput(dir, { livingPlanPath: emptyPlan });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when stateDir does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      stateDir: path.join(dir, "nonexistent-state-dir"),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when stdoutLogPath does not exist", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      stdoutLogPath: path.join(dir, "no-such-file.log"),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("does not throw when phases array is empty", () => {
    const dir = makeTmpDir();
    const input = makeInput(dir, {
      state: baseState({ phases: [] }),
    });
    expect(() => detectSkillFaults(input)).not.toThrow();
  });

  test("still returns other faults when one detector errors internally", () => {
    const dir = makeTmpDir();
    // Trigger WORKTREE_LEAK while also having a malformed plan-review-report
    const worktreePath = path.join(dir, "leaked");
    fs.mkdirSync(worktreePath);
    fs.writeFileSync(
      path.join(dir, "plan-review-report.json"),
      "{bad json",
      "utf8",
    );
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });
    const faults = detectSkillFaults(input);
    // WORKTREE_LEAK must still be returned; malformed review report must not throw
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

describe("analytics", () => {
  test("appends a JSONL line to ${GSTACK_HOME}/analytics/skill-faults.jsonl", () => {
    const dir = makeTmpDir();
    const fakeHome = path.join(dir, "gstack-home");
    fs.mkdirSync(fakeHome);
    process.env.GSTACK_HOME = fakeHome;

    // Trigger at least one fault so analytics fire
    const worktreePath = path.join(dir, "leaked");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });
    detectSkillFaults(input);

    const jsonlPath = path.join(fakeHome, "analytics", "skill-faults.jsonl");
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs
      .readFileSync(jsonlPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toHaveProperty("ts");
    expect(parsed).toHaveProperty("faults");
  });

  test("analytics failures do not block fault return", () => {
    const dir = makeTmpDir();
    // Point GSTACK_HOME at a file (not a directory) so the analytics write will fail
    const fakePath = path.join(dir, "not-a-dir");
    fs.writeFileSync(fakePath, "i am a file");
    process.env.GSTACK_HOME = fakePath;

    const worktreePath = path.join(dir, "leaked");
    fs.mkdirSync(worktreePath);
    const input = makeInput(dir, {
      state: baseState({ completed: true }),
      worktreePath,
    });

    // Must not throw AND must still return the WORKTREE_LEAK fault
    let faults: SkillFault[] = [];
    expect(() => {
      faults = detectSkillFaults(input);
    }).not.toThrow();
    expect(faults.find((f) => f.category === "WORKTREE_LEAK")).toBeDefined();
  });

  test("no analytics appended when zero faults detected", () => {
    const dir = makeTmpDir();
    const fakeHome = path.join(dir, "gstack-home");
    fs.mkdirSync(fakeHome);
    process.env.GSTACK_HOME = fakeHome;

    const faults = detectSkillFaults(makeInput(dir));
    expect(faults).toHaveLength(0);

    const jsonlPath = path.join(fakeHome, "analytics", "skill-faults.jsonl");
    // Either file doesn't exist or it's empty — no line should be written for zero faults
    if (fs.existsSync(jsonlPath)) {
      const content = fs.readFileSync(jsonlPath, "utf8").trim();
      expect(content).toBe("");
    }
  });
});
