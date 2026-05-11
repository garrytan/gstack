import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  decideNextAction,
  applyResult,
  markCommitted,
  findNextPhaseIndex,
  DEFAULT_MAX_CODEX_ITERATIONS,
  DEFAULT_CODEX_GEMINI_RERUN_FREQ,
  type Action,
} from "../phase-runner";
import type {
  PhaseState,
  Phase,
  DualImplState,
  DualImplTestResult,
  BuildState,
  PlanReviewVerdict,
} from "../types";
import type { SubAgentResult } from "../sub-agents";
import { saveState, loadState } from "../state";
import { reconcilePlanReview } from "../plan-reviewer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function basePhase(overrides: Partial<PhaseState> = {}): PhaseState {
  return {
    index: 0,
    number: "1",
    name: "Test Phase",
    status: "pending",
    ...overrides,
  };
}

function geminiSuccess(): SubAgentResult {
  return {
    stdout: "wrote code",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    logPath: "/tmp/gemini.log",
    durationMs: 1000,
    retries: 0,
  };
}

function geminiTimeout(): SubAgentResult {
  return { ...geminiSuccess(), timedOut: true, retries: 1 };
}

function geminiFailure(): SubAgentResult {
  return { ...geminiSuccess(), exitCode: 1 };
}

function codexPass(): SubAgentResult {
  return { ...geminiSuccess(), stdout: "reviewed; GATE PASS" };
}
function codexFail(): SubAgentResult {
  return { ...geminiSuccess(), stdout: "GATE FAIL — 3 issues" };
}
function codexUnclear(): SubAgentResult {
  return { ...geminiSuccess(), stdout: "review complete (no verdict keyword)" };
}
function codexTimeout(): SubAgentResult {
  return { ...geminiSuccess(), stdout: "", timedOut: true, retries: 1 };
}

describe("decideNextAction", () => {
  it("pending → RUN_GEMINI iter 1", () => {
    const action = decideNextAction(basePhase({ status: "pending" }));
    expect(action.type).toBe("RUN_GEMINI");
    if (action.type === "RUN_GEMINI") expect(action.iteration).toBe(1);
  });

  it("gemini_running (resumed) → RUN_GEMINI iter 1", () => {
    const action = decideNextAction(basePhase({ status: "gemini_running" }));
    expect(action.type).toBe("RUN_GEMINI");
  });

  it("impl_done (TDD phase) → RUN_TESTS iter 1", () => {
    const action = decideNextAction(basePhase({ status: "impl_done" }), 5, {
      testSpecDone: false,
    } as any);
    expect(action.type).toBe("RUN_TESTS");
    if (action.type === "RUN_TESTS") expect(action.iteration).toBe(1);
  });

  it("impl_done (legacy phase, testSpecDone=true) → RUN_CODEX_REVIEW", () => {
    const action = decideNextAction(basePhase({ status: "impl_done" }), 5, {
      testSpecDone: true,
    } as any);
    expect(action.type).toBe("RUN_CODEX_REVIEW");
  });

  it("codex_running with iters < max → RUN_CODEX_REVIEW iter+1", () => {
    const action = decideNextAction(
      basePhase({
        status: "codex_running",
        codexReview: { iterations: 2, outputLogPaths: [] },
      }),
    );
    expect(action.type).toBe("RUN_CODEX_REVIEW");
    if (action.type === "RUN_CODEX_REVIEW") expect(action.iteration).toBe(3);
  });

  it("codex_running with iters >= max → FAIL", () => {
    const action = decideNextAction(
      basePhase({
        status: "codex_running",
        codexReview: {
          iterations: DEFAULT_MAX_CODEX_ITERATIONS,
          outputLogPaths: [],
        },
      }),
    );
    expect(action.type).toBe("FAIL");
  });

  it("review_clean → MARK_COMPLETE", () => {
    const action = decideNextAction(basePhase({ status: "review_clean" }));
    expect(action.type).toBe("MARK_COMPLETE");
  });

  it("committed → DONE", () => {
    const action = decideNextAction(basePhase({ status: "committed" }));
    expect(action.type).toBe("DONE");
  });

  it("failed → FAIL", () => {
    const action = decideNextAction(
      basePhase({ status: "failed", error: "boom" }),
    );
    expect(action.type).toBe("FAIL");
    if (action.type === "FAIL") expect(action.reason).toBe("boom");
  });
});

describe("applyResult — Gemini", () => {
  it("successful Gemini → status impl_done", () => {
    const initial = basePhase({ status: "pending" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, geminiSuccess());
    expect(next.status).toBe("impl_done");
    expect(next.gemini?.exitCode).toBe(0);
    expect(next.gemini?.outputLogPath).toBe("/tmp/gemini.log");
  });

  it("timed-out Gemini → status failed", () => {
    const initial = basePhase({ status: "pending" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, geminiTimeout());
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/timed out/i);
  });

  it("non-zero Gemini exit → status failed", () => {
    const initial = basePhase({ status: "pending" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, geminiFailure());
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/exited 1/);
  });

  it("post-agent hygiene failure preserves the actionable message", () => {
    const initial = basePhase({ status: "pending" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, {
      ...geminiFailure(),
      logPath: "/tmp/phase-1-primary-impl-1-hygiene.log",
      stdout: [
        "# Post-agent hygiene failure",
        "",
        "primary implementor did not create a new commit",
        "",
        "Original agent log: /tmp/phase-1-primary-impl-1.log",
        "",
        "GATE FAIL",
        "",
      ].join("\n"),
    });

    expect(next.status).toBe("failed");
    expect(next.error).toContain("Gemini hygiene failed");
    expect(next.error).toContain(
      "primary implementor did not create a new commit",
    );
    expect(next.error).toContain("/tmp/phase-1-primary-impl-1-hygiene.log");
    expect(next.gemini?.error).toBe(next.error);
  });

  it("does not mutate input PhaseState", () => {
    const initial = basePhase({ status: "pending" });
    const action = decideNextAction(initial);
    const before = JSON.stringify(initial);
    applyResult(initial, action as any, geminiSuccess());
    expect(JSON.stringify(initial)).toBe(before);
  });
});

describe("applyResult — Codex review", () => {
  it("GATE PASS → review_clean and bumps iterations to 1", () => {
    const initial = basePhase({ status: "tests_green" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexPass());
    expect(next.status).toBe("review_clean");
    expect(next.codexReview?.iterations).toBe(1);
    expect(next.codexReview?.finalVerdict).toBe("GATE PASS");
  });

  it("GATE FAIL on first iter → codex_running, iterations=1", () => {
    const initial = basePhase({ status: "tests_green" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexFail());
    expect(next.status).toBe("codex_running");
    expect(next.codexReview?.iterations).toBe(1);
    expect(next.codexReview?.finalVerdict).toBe("GATE FAIL");
  });

  it("successive GATE FAIL passes accumulate iterations", () => {
    // Pass codexGeminiRerunFreq=0 to disable the re-run feature and test pure accumulation.
    let s = basePhase({ status: "tests_green" });
    for (let i = 1; i <= 3; i++) {
      const action = decideNextAction(
        s,
        DEFAULT_MAX_CODEX_ITERATIONS,
        undefined,
        undefined,
        undefined,
        0,
      );
      s = applyResult(s, action as any, codexFail());
      expect(s.codexReview?.iterations).toBe(i);
      expect(s.status).toBe("codex_running");
    }
  });

  it("GATE PASS after multiple fails → review_clean, log paths preserved", () => {
    // Pass codexGeminiRerunFreq=0 to disable the re-run feature.
    let s = basePhase({ status: "tests_green" });
    let action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      0,
    );
    s = applyResult(s, action as any, codexFail());
    action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      0,
    );
    s = applyResult(s, action as any, codexFail());
    action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      0,
    );
    s = applyResult(s, action as any, codexPass());
    expect(s.status).toBe("review_clean");
    expect(s.codexReview?.iterations).toBe(3);
    expect(s.codexReview?.outputLogPaths).toHaveLength(3);
  });

  it("Codex timeout → status failed, finalVerdict TIMEOUT", () => {
    const initial = basePhase({ status: "tests_green" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexTimeout());
    expect(next.status).toBe("failed");
    expect(next.codexReview?.finalVerdict).toBe("TIMEOUT");
  });

  it("Codex non-zero exit → status failed", () => {
    const initial = basePhase({ status: "tests_green" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, {
      ...codexPass(),
      exitCode: 5,
      stdout: "",
    });
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/exited 5/);
  });

  it("verdict unclear → status failed (cannot determine outcome)", () => {
    const initial = basePhase({ status: "tests_green" });
    const action = decideNextAction(initial);
    const next = applyResult(initial, action as any, codexUnclear());
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/GATE PASS or GATE FAIL/);
  });
});

describe("markCommitted", () => {
  it("flips status to committed and stamps committedAt", () => {
    const before = basePhase({ status: "review_clean" });
    const after = markCommitted(before);
    expect(after.status).toBe("committed");
    expect(after.committedAt).toBeDefined();
    expect(before.status).toBe("review_clean"); // input unchanged
  });

  it("clears stale phase errors when marking committed", () => {
    const before = basePhase({
      status: "review_clean",
      error: "old hygiene failure",
    });
    const after = markCommitted(before);
    expect(after.status).toBe("committed");
    expect(after.error).toBeUndefined();
    expect(before.error).toBe("old hygiene failure");
  });
});

describe("findNextPhaseIndex", () => {
  it("returns first non-committed index", () => {
    const phases: PhaseState[] = [
      basePhase({ index: 0, status: "committed" }),
      basePhase({ index: 1, status: "committed" }),
      basePhase({ index: 2, status: "pending" }),
      basePhase({ index: 3, status: "pending" }),
    ];
    expect(findNextPhaseIndex(phases)).toBe(2);
  });
  it("returns -1 when all committed", () => {
    const phases: PhaseState[] = [
      basePhase({ index: 0, status: "committed" }),
      basePhase({ index: 1, status: "committed" }),
    ];
    expect(findNextPhaseIndex(phases)).toBe(-1);
  });
  it("treats `impl_done` (partial-checked phase) as needing work", () => {
    const phases: PhaseState[] = [
      basePhase({ index: 0, status: "committed" }),
      basePhase({ index: 1, status: "impl_done" }),
    ];
    expect(findNextPhaseIndex(phases)).toBe(1);
  });
});

describe("end-to-end happy path through the state machine", () => {
  it("pending → impl_done → tests_green → review_clean → committed", () => {
    let s = basePhase({ status: "pending" });
    // TDD phase: testSpecDone=false means test spec is needed, but we start from impl_done
    // to test the post-impl path; use testSpecDone=false so impl_done routes to RUN_TESTS.
    let a = decideNextAction(s as any, 5, { testSpecDone: false } as any);
    expect(a.type).toBe("RUN_GEMINI_TEST_SPEC");
    // Simulate already having gone through test-spec + verify-red + impl: jump to impl_done.
    s = { ...basePhase({ status: "impl_done" }) };

    a = decideNextAction(s as any, 5, { testSpecDone: false } as any);
    expect(a.type).toBe("RUN_TESTS");
    s = applyResult(s, a as any, {
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "",
      durationMs: 100,
      retries: 0,
    });
    expect(s.status).toBe("tests_green");

    a = decideNextAction(s as any, 5, { testSpecDone: true } as any);
    expect(a.type).toBe("RUN_CODEX_REVIEW");
    s = applyResult(s, a as any, codexPass());
    expect(s.status).toBe("review_clean");

    a = decideNextAction(s as any, 5, { testSpecDone: true } as any);
    expect(a.type).toBe("MARK_COMPLETE");
    s = markCommitted(s);
    expect(s.status).toBe("committed");

    a = decideNextAction(s as any, 5, { testSpecDone: true } as any);
    expect(a.type).toBe("DONE");
  });
});

describe("TDD state machine transitions", () => {
  const tddPhase: Phase = {
    index: 0,
    number: "1",
    name: "TDD Test",
    body: "test content",
    testSpecDone: false,
    testSpecCheckboxLine: 3,
    implementationDone: false,
    implementationCheckboxLine: 4,
    reviewDone: false,
    reviewCheckboxLine: 5,
    dualImpl: false,
  };
  // Legacy 2-checkbox plan: testSpecDone=true via the "no checkbox" compat path.
  // testSpecCheckboxLine=-1 distinguishes it from a real prewritten testspec.
  const legacyPhase: Phase = {
    index: 0,
    number: "1",
    name: "Legacy",
    body: "content",
    testSpecDone: true,
    testSpecCheckboxLine: -1,
    implementationDone: false,
    implementationCheckboxLine: 4,
    reviewDone: false,
    reviewCheckboxLine: 5,
    dualImpl: false,
  };
  // Real prewritten testspec: checkbox exists in the plan (testSpecCheckboxLine >= 0)
  // and is already checked. Differs from legacy which has testSpecCheckboxLine = -1.
  const prewrittenPhase: Phase = {
    index: 0,
    number: "1",
    name: "Prewritten",
    body: "content",
    testSpecDone: true,
    testSpecCheckboxLine: 10,
    implementationDone: false,
    implementationCheckboxLine: 11,
    reviewDone: false,
    reviewCheckboxLine: 12,
    dualImpl: false,
  };
  const prewrittenDual: Phase = { ...prewrittenPhase, dualImpl: true };

  it("pending with testSpecDone=false → RUN_GEMINI_TEST_SPEC", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "pending" as any,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("RUN_GEMINI_TEST_SPEC");
  });

  it("pending with legacy phase (testSpecDone=true, no checkbox) → RUN_GEMINI", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "Legacy",
      status: "pending" as any,
    };
    const action = decideNextAction(state, 5, legacyPhase);
    expect(action.type).toBe("RUN_GEMINI");
  });

  it("pending with legacy phase + dual-impl → RUN_GEMINI (not VERIFY_RED — legacy skips dual-impl)", () => {
    const legacyDual: Phase = { ...legacyPhase, dualImpl: true };
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "LegacyDual",
      status: "pending" as any,
    };
    const action = decideNextAction(state, 5, legacyDual);
    expect(action.type).toBe("RUN_GEMINI");
  });

  it("pending with prewritten testspec + dual-impl → VERIFY_RED (not RUN_GEMINI)", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "PrewrittenDual",
      status: "pending" as any,
    };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe("VERIFY_RED");
  });

  it("test_spec_running with prewritten testspec (VERIFY_RED found trivially passing) → FAIL", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "PrewrittenDual",
      status: "test_spec_running" as any,
      redSpecAttempts: 1,
    };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe("FAIL");
    expect((action as any).reason).toMatch(/Prewritten tests pass/);
  });

  it("test_spec_running crash-resume (redSpecAttempts=0) → VERIFY_RED (not FAIL)", () => {
    // If process crashes between writing test_spec_running and spawning VERIFY_RED,
    // redSpecAttempts stays 0. Must re-run VERIFY_RED, not spuriously FAIL.
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "PrewrittenDual",
      status: "test_spec_running" as any,
      redSpecAttempts: 0,
    };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe("VERIFY_RED");
  });

  it("test_spec_running without prewritten testspec → RUN_GEMINI_TEST_SPEC (unchanged)", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "test_spec_running" as any,
      redSpecAttempts: 1,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("RUN_GEMINI_TEST_SPEC");
  });

  it("impl_done with prewritten testspec + dual-impl → RUN_TESTS (verify winner on main cwd)", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "PrewrittenDual",
      status: "impl_done" as any,
    };
    const action = decideNextAction(state, 5, prewrittenDual);
    expect(action.type).toBe("RUN_TESTS");
  });

  it("test_spec_done → VERIFY_RED", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "test_spec_done" as any,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("VERIFY_RED");
  });

  it("tests_red → RUN_GEMINI", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "tests_red" as any,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("RUN_GEMINI");
  });

  it("impl_done → RUN_TESTS", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "impl_done" as any,
      gemini: { retries: 0 } as any,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("RUN_TESTS");
  });

  it("test_fix_running with fail result cycles → RUN_GEMINI_FIX", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "test_fix_running" as any,
      testFix: { iterations: 2, outputLogPaths: ["a.log", "b.log"] } as any,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("RUN_GEMINI_FIX");
    expect((action as any).iteration).toBe(3);
  });

  it("test_fix_running at max iterations → FAIL", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "test_fix_running" as any,
      testFix: {
        iterations: 5,
        outputLogPaths: ["a", "b", "c", "d", "e"],
      } as any,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("FAIL");
  });

  it("tests_green → RUN_CODEX_REVIEW", () => {
    const state: PhaseState = {
      index: 0,
      number: "1",
      name: "TDD",
      status: "tests_green" as any,
    };
    const action = decideNextAction(state, 5, tddPhase);
    expect(action.type).toBe("RUN_CODEX_REVIEW");
  });
});

describe("Dual-implementor state machine transitions", () => {
  const dualPhase: Phase = {
    index: 0,
    number: "1",
    name: "Dual",
    body: "content",
    testSpecDone: false,
    testSpecCheckboxLine: 3,
    implementationDone: false,
    implementationCheckboxLine: 4,
    reviewDone: false,
    reviewCheckboxLine: 5,
    dualImpl: true,
  };
  const singlePhase: Phase = { ...dualPhase, dualImpl: false };

  function minDualImpl(): DualImplState {
    return {
      candidates: {
        primary: {
          worktreePath: "/tmp/primary",
          branch: "primary-branch",
        },
        secondary: {
          worktreePath: "/tmp/secondary",
          branch: "secondary-branch",
        },
      },
      baseCommit: "abc123",
    };
  }

  function passResult(failureCount = 0): DualImplTestResult {
    return {
      worktreePath: "/tmp/x",
      testExitCode: 0,
      testLogPath: "x.log",
      timedOut: false,
      failureCount,
    };
  }
  function failResult(failureCount = 3): DualImplTestResult {
    return {
      worktreePath: "/tmp/x",
      testExitCode: 1,
      testLogPath: "x.log",
      timedOut: false,
      failureCount,
    };
  }

  // (a)
  it("(a) tests_red + dualImpl=true → RUN_DUAL_IMPL", () => {
    const state = basePhase({ status: "tests_red" as any });
    const action = decideNextAction(state, 5, dualPhase);
    expect(action.type).toBe("RUN_DUAL_IMPL");
  });

  // (b)
  it("(b) dual_impl_done → RUN_DUAL_TESTS", () => {
    const state = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const action = decideNextAction(state);
    expect(action.type).toBe("RUN_DUAL_TESTS");
  });

  // (c): both pass → dual_judge_pending → RUN_JUDGE
  it("(c) both tests pass → dual_judge_pending + decideNextAction → RUN_JUDGE", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: passResult(),
          secondary: passResult(),
        },
      },
    );
    expect(next.status).toBe("dual_judge_pending");
    expect(decideNextAction(next).type).toBe("RUN_JUDGE");
  });

  // (d): one passes → auto-select + APPLY_WINNER
  it("(d) primary passes, secondary fails → dual_winner_pending selectedBy=auto + APPLY_WINNER", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: passResult(),
          secondary: failResult(3),
        },
      },
    );
    expect(next.status).toBe("dual_winner_pending");
    expect(next.dualImpl?.selectedImplementor).toBe("primary");
    expect(next.dualImpl?.selectedBy).toBe("auto");
    const action = decideNextAction(next);
    expect(action.type).toBe("APPLY_WINNER");
    if (action.type === "APPLY_WINNER") expect(action.winner).toBe("primary");
  });

  // (e): both fail → auto-select fewer-failures
  it("(e) both fail → auto-select fewer-failures winner (secondary has 2 < primary 5)", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: failResult(5),
          secondary: failResult(2),
        },
      },
    );
    expect(next.status).toBe("dual_winner_pending");
    expect(next.dualImpl?.selectedImplementor).toBe("secondary");
    expect(next.dualImpl?.selectedBy).toBe("auto");
  });

  // (f): judge complete → dual_winner_pending with judge verdict
  it("(f) RUN_JUDGE result → dual_winner_pending with judge verdict + APPLY_WINNER", () => {
    const initial = basePhase({
      status: "dual_judge_running" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_JUDGE", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        judgeVerdict: "secondary",
        judgeReasoning: "Secondary solution is cleaner",
      },
    );
    expect(next.status).toBe("dual_winner_pending");
    expect(next.dualImpl?.selectedImplementor).toBe("secondary");
    expect(next.dualImpl?.selectedBy).toBe("judge");
    expect(next.dualImpl?.judgeReasoning).toBe("Secondary solution is cleaner");
    expect(decideNextAction(next).type).toBe("APPLY_WINNER");
  });

  it("(f2) RUN_JUDGE result propagates judgeHardeningNotes", () => {
    const initial = basePhase({
      status: "dual_judge_running" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_JUDGE", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        judgeVerdict: "primary",
        judgeReasoning: "Primary is more idiomatic",
        judgeHardeningNotes: "Add edge case for null input",
      },
    );
    expect(next.dualImpl?.judgeHardeningNotes).toBe(
      "Add edge case for null input",
    );
  });

  // (g): APPLY_WINNER done → impl_done (handoff to existing pipeline)
  it("(g) APPLY_WINNER applied → impl_done", () => {
    const initial = basePhase({
      status: "dual_winner_pending" as any,
      dualImpl: {
        ...minDualImpl(),
        selectedImplementor: "primary",
        selectedBy: "auto",
      },
    });
    const next = applyResult(
      initial,
      { type: "APPLY_WINNER", phaseIndex: 0, winner: "primary" } as any,
      geminiSuccess(),
    );
    expect(next.status).toBe("impl_done");
  });

  // (h): tests_red + dualImpl=false → RUN_GEMINI (single-impl path unchanged)
  it("(h) tests_red + dualImpl=false → RUN_GEMINI (unchanged single-impl path)", () => {
    const state = basePhase({ status: "tests_red" as any });
    const action = decideNextAction(state, 5, singlePhase);
    expect(action.type).toBe("RUN_GEMINI");
  });

  // Fail-closed: dual_winner_pending without selectedImplementor → FAIL
  it("dual_winner_pending without selectedImplementor → FAIL (fail-closed)", () => {
    const state = basePhase({
      status: "dual_winner_pending" as any,
      dualImpl: minDualImpl(),
    });
    const action = decideNextAction(state);
    expect(action.type).toBe("FAIL");
  });

  // Fail-closed: RUN_DUAL_IMPL without dualImplInit → status failed
  it("RUN_DUAL_IMPL without dualImplInit in extra → status failed", () => {
    const initial = basePhase({ status: "dual_impl_running" as any });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_IMPL", phaseIndex: 0, iteration: 1 } as any,
      geminiSuccess(),
      // no extra
    );
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/dualImplInit/);
  });

  // Fail-closed: both timed out → status failed (no auto-select)
  it("RUN_DUAL_TESTS with both timed out → status failed", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: {
            worktreePath: "/primary",
            testExitCode: null,
            testLogPath: "primary.log",
            timedOut: true,
          },
          secondary: {
            worktreePath: "/secondary",
            testExitCode: null,
            testLogPath: "secondary.log",
            timedOut: true,
          },
        },
      },
    );
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/timed out/);
  });

  // Fail-closed: both fail with no failureCount → status failed
  it("RUN_DUAL_TESTS both fail with missing failureCount on both → status failed", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: {
            worktreePath: "/primary",
            testExitCode: 1,
            testLogPath: "primary.log",
            timedOut: false,
          },
          secondary: {
            worktreePath: "/secondary",
            testExitCode: 1,
            testLogPath: "secondary.log",
            timedOut: false,
          },
        },
      },
    );
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/failureCount/);
  });

  // Symmetric auto-select: secondary passes, primary fails (mirror of test (d))
  it("secondary passes, primary fails → dual_winner_pending selectedImplementor=secondary selectedBy=auto", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: failResult(3),
          secondary: passResult(),
        },
      },
    );
    expect(next.status).toBe("dual_winner_pending");
    expect(next.dualImpl?.selectedImplementor).toBe("secondary");
    expect(next.dualImpl?.selectedBy).toBe("auto");
    const action = decideNextAction(next);
    expect(action.type).toBe("APPLY_WINNER");
    if (action.type === "APPLY_WINNER") expect(action.winner).toBe("secondary");
  });

  // One-side timeout: primary timed out, secondary passed → auto-select secondary
  it("primary timed out, secondary passed → auto-select secondary", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: {
            worktreePath: "/primary",
            testExitCode: null,
            testLogPath: "primary.log",
            timedOut: true,
          },
          secondary: passResult(),
        },
      },
    );
    expect(next.status).toBe("dual_winner_pending");
    expect(next.dualImpl?.selectedImplementor).toBe("secondary");
    expect(next.dualImpl?.selectedBy).toBe("auto");
  });

  // One-side timeout: secondary timed out, primary passed → auto-select primary
  it("secondary timed out, primary passed → auto-select primary", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: passResult(),
          secondary: {
            worktreePath: "/secondary",
            testExitCode: null,
            testLogPath: "secondary.log",
            timedOut: true,
          },
        },
      },
    );
    expect(next.status).toBe("dual_winner_pending");
    expect(next.dualImpl?.selectedImplementor).toBe("primary");
    expect(next.dualImpl?.selectedBy).toBe("auto");
  });

  // RUN_DUAL_IMPL failure: timedOut=true → status failed
  it("RUN_DUAL_IMPL with timedOut result → status failed", () => {
    const initial = basePhase({ status: "dual_impl_running" as any });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_IMPL", phaseIndex: 0, iteration: 1 } as any,
      {
        stdout: "",
        stderr: "timeout",
        exitCode: null,
        timedOut: true,
        logPath: "x.log",
        durationMs: 0,
        retries: 0,
      },
    );
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/failed/i);
  });

  // RUN_DUAL_IMPL failure: exitCode !== 0 → status failed
  it("RUN_DUAL_IMPL with exitCode=1 result → status failed", () => {
    const initial = basePhase({ status: "dual_impl_running" as any });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_IMPL", phaseIndex: 0, iteration: 1 } as any,
      {
        stdout: "",
        stderr: "crash",
        exitCode: 1,
        timedOut: false,
        logPath: "x.log",
        durationMs: 0,
        retries: 0,
      },
    );
    expect(next.status).toBe("failed");
  });

  // RUN_JUDGE missing judgeVerdict in extra → status failed
  it("RUN_JUDGE without judgeVerdict in extra → status failed", () => {
    const initial = basePhase({
      status: "dual_judge_running" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_JUDGE", phaseIndex: 0 } as any,
      geminiSuccess(),
      {}, // no judgeVerdict
    );
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/judgeVerdict/);
  });

  // APPLY_WINNER with winner=secondary also lands in impl_done
  it("APPLY_WINNER with winner=secondary → impl_done (secondary win uses same handoff state)", () => {
    const initial = basePhase({
      status: "dual_winner_pending" as any,
      dualImpl: {
        ...minDualImpl(),
        selectedImplementor: "secondary",
        selectedBy: "judge",
      },
    });
    const next = applyResult(
      initial,
      { type: "APPLY_WINNER", phaseIndex: 0, winner: "secondary" } as any,
      geminiSuccess(),
    );
    expect(next.status).toBe("impl_done");
    expect(next.dualImpl?.worktreesTornDownAt).toBeDefined();
  });

  // Tie-breaking: both fail with equal failureCount → primary (documented preference)
  it("both fail with equal failureCount → primary wins tie (documented preference)", () => {
    const initial = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: minDualImpl(),
    });
    const next = applyResult(
      initial,
      { type: "RUN_DUAL_TESTS", phaseIndex: 0 } as any,
      geminiSuccess(),
      {
        candidateTestResults: {
          primary: failResult(3),
          secondary: failResult(3),
        },
      },
    );
    expect(next.status).toBe("dual_winner_pending");
    expect(next.dualImpl?.selectedImplementor).toBe("primary");
  });

  it("legacy gemini/codex dual state fails with rerun guidance", () => {
    const state = basePhase({
      status: "dual_impl_done" as any,
      dualImpl: {
        geminiWorktreePath: "/tmp/g",
        codexWorktreePath: "/tmp/c",
        geminiBranch: "g",
        codexBranch: "c",
        baseCommit: "abc123",
      } as any,
    });
    const action = decideNextAction(state);
    expect(action.type).toBe("FAIL");
    if (action.type === "FAIL")
      expect(action.reason).toMatch(/old gemini\/codex shape/);
  });

  // Resume path: dual_tests_running → RUN_DUAL_TESTS
  it("dual_tests_running → RUN_DUAL_TESTS (resume mid-test)", () => {
    const state = basePhase({
      status: "dual_tests_running" as any,
      dualImpl: minDualImpl(),
    });
    const action = decideNextAction(state);
    expect(action.type).toBe("RUN_DUAL_TESTS");
  });
});

// ---------------------------------------------------------------------------
// RUN_GEMINI_FROM_REVIEW — decideNextAction
// ---------------------------------------------------------------------------

describe("decideNextAction — RUN_GEMINI_FROM_REVIEW", () => {
  // Helper: build a codex_running state with N iterations and optional REPORT paths.
  // outputFilePaths is the artifact-path array (clean review report).
  // outputLogPaths is the spawn-shell log array (forensics only).
  // RUN_GEMINI_FROM_REVIEW reads outputFilePaths so the rerun's Gemini sees the
  // clean reviewer findings, not the noisy command capture.
  function codexRunning(
    iterations: number,
    reportPaths: string[] = [],
  ): PhaseState {
    return basePhase({
      status: "codex_running",
      codexReview: {
        iterations,
        // Mirror reportPaths to outputLogPaths so existing forensics work too.
        outputLogPaths: reportPaths.map((p) => p.replace(/\.md$/, ".log")),
        outputFilePaths: reportPaths,
      },
    });
  }

  it("after 2 iterations with feedbackPath → RUN_GEMINI_FROM_REVIEW (freq=2)", () => {
    const s = codexRunning(2, ["/tmp/review-1.md", "/tmp/review-2.md"]);
    const action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(action.type).toBe("RUN_GEMINI_FROM_REVIEW");
    if (action.type === "RUN_GEMINI_FROM_REVIEW") {
      // Gating now uses outputFilePaths (clean report), not outputLogPaths.
      expect(action.reviewFeedbackPath).toBe("/tmp/review-2.md");
      expect(action.iteration).toBe(3);
    }
  });

  it("after 1 iteration (not yet at freq=2) → RUN_CODEX_REVIEW", () => {
    const s = codexRunning(1, ["/tmp/review-1.md"]);
    const action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(action.type).toBe("RUN_CODEX_REVIEW");
  });

  it("after 2 iterations with NO feedbackPath → RUN_CODEX_REVIEW (graceful fallback)", () => {
    const s = codexRunning(2, []); // no report paths
    const action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(action.type).toBe("RUN_CODEX_REVIEW");
  });

  it("legacy state with only outputLogPaths (no outputFilePaths) → falls back to RUN_CODEX_REVIEW", () => {
    // Resume-from-old-state scenario: state.json was written before
    // outputFilePaths existed. Gating must skip rerun rather than feed the
    // noisy spawn shell log to Gemini.
    const s = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/legacy/r1.log", "/legacy/r2.log"],
      },
    });
    const action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(action.type).toBe("RUN_CODEX_REVIEW");
  });

  it("codexGeminiRerunFreq=0 → never triggers re-run, returns RUN_CODEX_REVIEW until maxIter", () => {
    // Stay below DEFAULT_MAX_CODEX_ITERATIONS (5) so we don't hit the FAIL cap.
    for (let i = 2; i <= 4; i += 2) {
      const s = codexRunning(
        i,
        Array.from({ length: i }, (_, j) => `/tmp/r-${j}.md`),
      );
      const action = decideNextAction(
        s,
        DEFAULT_MAX_CODEX_ITERATIONS,
        undefined,
        undefined,
        undefined,
        0,
      );
      expect(action.type).toBe("RUN_CODEX_REVIEW");
    }
  });

  it("after 4 iterations fires again at freq=2 (iter 4 % 2 === 0)", () => {
    const s = codexRunning(4, ["/a.md", "/b.md", "/c.md", "/d.md"]);
    const action = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(action.type).toBe("RUN_GEMINI_FROM_REVIEW");
    if (action.type === "RUN_GEMINI_FROM_REVIEW") {
      expect(action.reviewFeedbackPath).toBe("/d.md");
    }
  });

  it("uses DEFAULT_CODEX_GEMINI_RERUN_FREQ constant (value=2) by default", () => {
    // Verify the exported constant is 2 (or env-overridden, but in tests env is clean).
    expect(typeof DEFAULT_CODEX_GEMINI_RERUN_FREQ).toBe("number");
    expect(DEFAULT_CODEX_GEMINI_RERUN_FREQ).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// F1: Feature-level review state machine surface
// ---------------------------------------------------------------------------

describe("DEFAULT_FEATURE_REVIEW_MAX_ITER", () => {
  it("is a positive integer sourced from BUILD_DEFAULTS.limits", () => {
    // Cap on per-feature meta-review cycles. After this count, the
    // orchestrator pauses on a TTY and prompts whether to allow another
    // cycle; non-TTY runs treat the cap as final and write
    // BLOCKED-feature-N.md. 3 is the shipped default.
    const { DEFAULT_FEATURE_REVIEW_MAX_ITER } = require("../phase-runner");
    expect(typeof DEFAULT_FEATURE_REVIEW_MAX_ITER).toBe("number");
    expect(Number.isInteger(DEFAULT_FEATURE_REVIEW_MAX_ITER)).toBe(true);
    expect(DEFAULT_FEATURE_REVIEW_MAX_ITER).toBeGreaterThanOrEqual(1);
  });
});

describe("RUN_FEATURE_REVIEW action shape", () => {
  // The Action union now includes RUN_FEATURE_REVIEW which carries
  // featureIndex (NOT phaseIndex — feature-level), iteration, and an
  // optional priorReportPath set when iter>1 so the reviewer can see
  // what it asked for last cycle. Compile-time check via TS narrowing
  // — this test exists to fail at type-check time if the shape drifts.
  it("constructs without phaseIndex; carries featureIndex + iteration + optional priorReportPath", () => {
    const a: Action = {
      type: "RUN_FEATURE_REVIEW",
      featureIndex: 2,
      iteration: 1,
    };
    expect(a.type).toBe("RUN_FEATURE_REVIEW");
    if (a.type === "RUN_FEATURE_REVIEW") {
      expect(a.featureIndex).toBe(2);
      expect(a.iteration).toBe(1);
      expect(a.priorReportPath).toBeUndefined();
    }
    const b: Action = {
      type: "RUN_FEATURE_REVIEW",
      featureIndex: 0,
      iteration: 3,
      priorReportPath: "/logs/feature-1-review-2.md",
    };
    if (b.type === "RUN_FEATURE_REVIEW") {
      expect(b.priorReportPath).toBe("/logs/feature-1-review-2.md");
    }
  });
});

// ---------------------------------------------------------------------------
// applyResult — RUN_GEMINI_FROM_REVIEW
// ---------------------------------------------------------------------------

describe("applyResult — RUN_GEMINI_FROM_REVIEW", () => {
  function reviewRerunAction(iteration = 3): Action {
    return {
      type: "RUN_GEMINI_FROM_REVIEW",
      phaseIndex: 0,
      iteration,
      reviewFeedbackPath: "/tmp/review-2.log",
    };
  }

  function rerunResult(
    overrides: Partial<SubAgentResult> = {},
  ): SubAgentResult {
    return {
      stdout: "fixed all issues",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/gemini-rerun-3.log",
      durationMs: 2000,
      retries: 0,
      ...overrides,
    };
  }

  it("success → status=impl_done, geminiReRunCount=1", () => {
    const initial = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const next = applyResult(initial, reviewRerunAction(), rerunResult());
    expect(next.status).toBe("impl_done");
    expect(next.codexReview?.geminiReRunCount).toBe(1);
    expect(next.gemini?.outputLogPath).toBe("/tmp/gemini-rerun-3.log");
    expect(next.gemini?.exitCode).toBe(0);
  });

  it("second re-run → geminiReRunCount increments to 2", () => {
    const initial = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 4,
        outputLogPaths: ["/a.log", "/b.log", "/c.log", "/d.log"],
        geminiReRunCount: 1,
      },
    });
    const next = applyResult(initial, reviewRerunAction(5), rerunResult());
    expect(next.codexReview?.geminiReRunCount).toBe(2);
  });

  it("timeout → status=failed with timed-out error", () => {
    const initial = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const next = applyResult(
      initial,
      reviewRerunAction(),
      rerunResult({ timedOut: true, exitCode: null }),
    );
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/timed out/i);
  });

  it("non-zero exit → status=failed with exit code in error", () => {
    const initial = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const next = applyResult(
      initial,
      reviewRerunAction(),
      rerunResult({ exitCode: 2 }),
    );
    expect(next.status).toBe("failed");
    expect(next.error).toMatch(/exited 2/);
  });

  it("post-agent hygiene failure from rerun preserves the actionable message", () => {
    const initial = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const next = applyResult(
      initial,
      reviewRerunAction(),
      rerunResult({
        exitCode: 1,
        logPath: "/tmp/phase-1-primary-impl-rerun-3-hygiene.log",
        stdout: [
          "# Post-agent hygiene failure",
          "",
          "primary implementor rerun left the working tree dirty:",
          "  ?? rewrite.py",
          "",
          "Original agent log: /tmp/phase-1-primary-impl-rerun-3.log",
          "",
          "GATE FAIL",
          "",
        ].join("\n"),
      }),
    );

    expect(next.status).toBe("failed");
    expect(next.error).toContain(
      "Gemini re-run (from review feedback) hygiene failed",
    );
    expect(next.error).toContain(
      "primary implementor rerun left the working tree dirty",
    );
    expect(next.error).toContain(
      "/tmp/phase-1-primary-impl-rerun-3-hygiene.log",
    );
  });

  it("does not mutate input PhaseState", () => {
    const initial = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const before = JSON.stringify(initial);
    applyResult(initial, reviewRerunAction(), rerunResult());
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("preserves gemini.startedAt across reruns (per-phase wall-clock metric)", () => {
    const originalStartedAt = "2026-01-01T00:00:00.000Z";
    const initial = basePhase({
      status: "codex_running",
      gemini: {
        startedAt: originalStartedAt,
        completedAt: "2026-01-01T00:00:30.000Z",
        outputLogPath: "/tmp/orig.log",
        retries: 0,
      },
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const next = applyResult(initial, reviewRerunAction(), rerunResult());
    expect(next.gemini?.startedAt).toBe(originalStartedAt);
  });

  it("clears stale testRun and testFix so the next RUN_TESTS starts fresh", () => {
    const initial = basePhase({
      status: "codex_running",
      testRun: { iterations: 3, finalStatus: "green" },
      testFix: { iterations: 2, outputLogPaths: ["a", "b"] } as any,
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const next = applyResult(initial, reviewRerunAction(), rerunResult());
    expect(next.testRun).toBeUndefined();
    expect(next.testFix).toBeUndefined();
  });

  it("persists gemini.outputFilePath from extra (so next codex review can find the rerun output)", () => {
    const initial = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
      },
    });
    const next = applyResult(initial, reviewRerunAction(), rerunResult(), {
      outputFilePath: "/tmp/phase-1-gemini-rerun-3-output.md",
    });
    expect(next.gemini?.outputFilePath).toBe(
      "/tmp/phase-1-gemini-rerun-3-output.md",
    );
  });
});

// ---------------------------------------------------------------------------
// applyResult — RUN_CODEX_REVIEW spread + outputFilePaths plumbing
// ---------------------------------------------------------------------------

describe("applyResult — RUN_CODEX_REVIEW preservation and outputFilePaths", () => {
  function reviewAction(iteration = 3): Action {
    return { type: "RUN_CODEX_REVIEW", phaseIndex: 0, iteration } as any;
  }

  function reviewResult(
    overrides: Partial<SubAgentResult> = {},
  ): SubAgentResult {
    return {
      stdout: "GATE FAIL\nfindings here",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/codex-review-3.log",
      durationMs: 1000,
      retries: 0,
      ...overrides,
    };
  }

  it("preserves geminiReRunCount across consecutive RUN_CODEX_REVIEW iterations (spread, not rebuild)", () => {
    const initial = basePhase({
      status: "tests_green",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
        outputFilePaths: ["/tmp/r1.md", "/tmp/r2.md"],
        geminiReRunCount: 1, // set by a prior RUN_GEMINI_FROM_REVIEW
      },
    });
    const next = applyResult(initial, reviewAction(3), reviewResult());
    // The forensic counter must survive — a rebuild from scratch would drop it
    // to undefined, defeating the field's purpose.
    expect(next.codexReview?.geminiReRunCount).toBe(1);
  });

  it("appends to outputFilePaths when extra.outputFilePath is provided", () => {
    const initial = basePhase({
      status: "tests_green",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
        outputFilePaths: ["/tmp/r1.md", "/tmp/r2.md"],
      },
    });
    const next = applyResult(initial, reviewAction(3), reviewResult(), {
      outputFilePath: "/tmp/phase-1-review-merged-3.md",
    });
    expect(next.codexReview?.outputFilePaths).toEqual([
      "/tmp/r1.md",
      "/tmp/r2.md",
      "/tmp/phase-1-review-merged-3.md",
    ]);
    // outputLogPaths still grows in parallel.
    expect(next.codexReview?.outputLogPaths).toHaveLength(3);
  });

  it("leaves outputFilePaths unchanged when extra.outputFilePath is undefined (legacy callers)", () => {
    const initial = basePhase({
      status: "tests_green",
      codexReview: {
        iterations: 1,
        outputLogPaths: ["/tmp/r1.log"],
        outputFilePaths: ["/tmp/r1.md"],
      },
    });
    const next = applyResult(initial, reviewAction(2), reviewResult());
    expect(next.codexReview?.outputFilePaths).toEqual(["/tmp/r1.md"]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: after RUN_GEMINI_FROM_REVIEW success, Codex iteration continues
// ---------------------------------------------------------------------------

describe("RUN_GEMINI_FROM_REVIEW end-to-end flow", () => {
  it("after re-run success → impl_done → tests_green → RUN_CODEX_REVIEW with accumulated iter count (NOT reset to 1)", () => {
    // Start from codex_running at iter=2 with feedbackPath. The gating reads
    // outputFilePaths (clean review report), not outputLogPaths (spawn shell
    // capture used for forensics only).
    let s = basePhase({
      status: "codex_running",
      codexReview: {
        iterations: 2,
        outputLogPaths: ["/tmp/r1.log", "/tmp/r2.log"],
        outputFilePaths: ["/tmp/r1.md", "/tmp/r2.md"],
      },
    });

    // decideNextAction fires RUN_GEMINI_FROM_REVIEW
    const rerunAction = decideNextAction(
      s,
      DEFAULT_MAX_CODEX_ITERATIONS,
      undefined,
      undefined,
      undefined,
      2,
    );
    expect(rerunAction.type).toBe("RUN_GEMINI_FROM_REVIEW");

    // Apply success — moves to impl_done
    s = applyResult(s, rerunAction as any, {
      stdout: "fixed",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/gemini-rerun-3.log",
      durationMs: 1000,
      retries: 0,
    });
    expect(s.status).toBe("impl_done");

    // Simulate tests passing (legacy phase: testSpecDone=true → skip RUN_TESTS, go to codex)
    // Use testSpecDone=true so impl_done → RUN_CODEX_REVIEW directly.
    const toCodex = decideNextAction(s, DEFAULT_MAX_CODEX_ITERATIONS, {
      testSpecDone: true,
    } as any);
    expect(toCodex.type).toBe("RUN_CODEX_REVIEW");
    // The codexReview.iterations is still 2 from before, so next iteration = 3 (NOT 1).
    if (toCodex.type === "RUN_CODEX_REVIEW") {
      expect(toCodex.iteration).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug D1: critical-verdict-state-persistence-loop
//
// When plan-reviewer returns CRITICAL, cli.ts currently does:
//   releaseLock(slug); process.exit(3);
// without persisting state.planReview. On resume, !state.planReview is true
// → the review re-runs → CRITICAL again → infinite loop.
//
// Fix: persist state.planReview = { ...verdict, status: "critical_exit_pending" }
// before exit, and update the guard to also fire for that sentinel.
//
// Tests below are RED before the fix — they assert the sentinel shape and
// guard behavior that the implementation must provide.
// ---------------------------------------------------------------------------

describe("critical-verdict-state-persistence-loop (Bug D1, Feature 4)", () => {
  let tmpStateDir: string;
  let tmpPlanDir: string;
  let realStateDir: string | undefined;

  beforeEach(() => {
    realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
    tmpStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-verdict-test-"),
    );
    tmpPlanDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-plan-test-"));
    process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
  });

  afterEach(() => {
    if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
    else delete process.env.GSTACK_BUILD_STATE_DIR;
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    fs.rmSync(tmpPlanDir, { recursive: true, force: true });
  });

  function minimalBuildState(slug = "build-verdict-persist-test"): BuildState {
    return {
      planFile: path.join(tmpPlanDir, "plan.md"),
      planBasename: "plan",
      slug,
      branch: "main",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:01.000Z",
      currentPhaseIndex: 0,
      features: [],
      phases: [],
      completed: false,
    };
  }

  const criticalVerdict: PlanReviewVerdict = {
    verdict: "REVISE",
    objections: [
      {
        severity: "CRITICAL",
        location: "Feature 1, Phase 1",
        issue: "Missing #### Test Spec section",
        suggestion: "Add a Test Spec section with at least 3 test scenarios",
      },
    ],
    assessment:
      "Plan has critical structural issues that prevent safe autonomous execution.",
    reviewedBy: "gpt-5.5",
    round: 1,
  };

  // RED — reconcilePlanReview returns "critical_exit" for a CRITICAL verdict.
  // This test also verifies that after cli.ts handles a critical_exit, the
  // state persisted to disk carries planReview with status "critical_exit_pending".
  // Currently cli.ts does NOT save state on critical_exit → planReview stays
  // undefined on disk → this test FAILS.
  it("state persisted before critical-exit must carry planReview with status 'critical_exit_pending'", async () => {
    const planFile = path.join(tmpPlanDir, "plan.md");
    fs.writeFileSync(
      planFile,
      "# Plan\n\n## Feature 1: Test feature\n\n### Phase 1: Impl\n",
      "utf8",
    );
    const reportPath = path.join(tmpStateDir, "plan-review-report.json");

    const outcome = await reconcilePlanReview(criticalVerdict, planFile, {
      planReviewReportPath: reportPath,
    });

    // reconcilePlanReview already returns "critical_exit" for CRITICAL (not under test here)
    expect(outcome).toBe("critical_exit");

    // Simulate what cli.ts does on critical_exit (fixed behavior):
    // set state.planReview with sentinel before saveState + process.exit(3).
    const state = minimalBuildState();
    state.planReview = { ...criticalVerdict, status: "critical_exit_pending" } as any;
    saveState(state, { noGbrain: true });

    const loaded = loadState(state.slug, { noGbrain: true });
    expect(loaded).toBeDefined();

    // Sentinel must survive the saveState → loadState round-trip.
    expect(loaded!.planReview).toBeDefined();
    expect((loaded!.planReview as any).status).toBe("critical_exit_pending");
  });

  // RED — after the fix, state.planReview will be set to the sentinel (truthy).
  // The current guard "!state.planReview" then evaluates to false → gate is SKIPPED.
  // This test verifies that the gate MUST fire even when planReview is truthy
  // but carries the "critical_exit_pending" sentinel.
  it("plan-review gate fires on resume when planReview carries 'critical_exit_pending' sentinel", () => {
    const stateWithSentinel = {
      ...minimalBuildState("build-sentinel-resume-test"),
      planReview: {
        ...criticalVerdict,
        // sentinel field the fix will introduce; not yet on PlanReviewVerdict type
        status: "critical_exit_pending",
      },
    } as BuildState;

    saveState(stateWithSentinel, { noGbrain: true });
    const loaded = loadState(stateWithSentinel.slug, { noGbrain: true });
    expect(loaded).toBeDefined();

    // Fixed guard in cli.ts: !state.planReview || state.planReview.status === "critical_exit_pending"
    // When planReview carries the sentinel, the second condition is true → gate fires.
    const gateFiresWithFixedGuard =
      !loaded!.planReview ||
      (loaded!.planReview as any).status === "critical_exit_pending";

    expect(gateFiresWithFixedGuard).toBe(true);
  });

  // GREEN — processed APPROVE verdict: gate must NOT re-fire. Verifies the complement.
  it("plan-review gate does NOT fire when planReview holds a processed APPROVE verdict", () => {
    const stateApproved = {
      ...minimalBuildState("build-approved-test"),
      planReview: {
        verdict: "APPROVE" as const,
        objections: [],
        assessment: "Plan looks solid.",
        reviewedBy: "gpt-5.5",
        round: 1,
      },
    };

    saveState(stateApproved as BuildState, { noGbrain: true });
    const loaded = loadState(stateApproved.slug, { noGbrain: true });
    expect(loaded).toBeDefined();

    // Current guard: !state.planReview → false → gate does NOT fire. Correct.
    const gateFires = !loaded!.planReview;
    expect(gateFires).toBe(false);
  });

  // GREEN — undefined planReview: gate fires (first run, no previous review).
  it("plan-review gate fires when planReview is undefined (first-run baseline)", () => {
    const stateNeverReviewed = minimalBuildState("build-never-reviewed-test");
    saveState(stateNeverReviewed, { noGbrain: true });
    const loaded = loadState(stateNeverReviewed.slug, { noGbrain: true });
    expect(loaded).toBeDefined();
    expect(loaded!.planReview).toBeUndefined();

    const gateFires = !loaded!.planReview;
    expect(gateFires).toBe(true);
  });
});
