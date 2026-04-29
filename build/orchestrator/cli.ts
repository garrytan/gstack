#!/usr/bin/env bun
/**
 * gstack-build — code-driven phase orchestrator for the /build skill.
 *
 *   gstack-build <plan-file> [flags]
 *
 * Drives the build loop in code rather than via LLM, so it never stalls
 * with "Standing by, let me know what's next" between phases. Per-phase
 * work still spawns Gemini (impl) and Codex (review) as fresh subprocesses
 * with isolated context.
 *
 * Flags:
 *   --print-only    Parse and show phase table; exit.
 *   --dry-run       Walk state machine without spawning sub-agents.
 *   --no-resume     Ignore existing state, start fresh.
 *   --no-gbrain     Skip gbrain mirror; local JSON only.
 *   --skip-ship     Skip the final /ship + /land-and-deploy step.
 *   --test-cmd <cmd>     Override test command (default: auto-detect from package.json/pytest.ini/go.mod/Cargo.toml).
 *   --max-codex-iter N   Override GSTACK_BUILD_CODEX_MAX_ITER (default 5).
 *   -h, --help      This help.
 *
 * Exit codes:
 *   0  all phases done (and shipped, unless --skip-ship)
 *   1  a phase failed; state saved, can resume after fix
 *   2  bad args / plan file missing / parse error
 *   3  another instance is running (lock contention)
 *   130 user interrupt (SIGINT)
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePlan, isPhaseComplete } from "./parser";
import {
  freshState,
  loadState,
  saveState,
  acquireLock,
  releaseLock,
  readLockInfo,
  ensureLogDir,
  deriveSlug,
  logDir,
} from "./state";
import {
  decideNextAction,
  applyResult,
  markCommitted,
  findNextPhaseIndex,
  DEFAULT_MAX_CODEX_ITERATIONS,
  DEFAULT_MAX_TEST_ITERATIONS,
  type Action,
} from "./phase-runner";
import {
  runGemini,
  runCodexReview,
  detectTestCmd,
  runGeminiTestSpec,
  runTests,
  runCodexImpl,
  runJudgeOpus,
  parseFailureCount,
  parseJudgeVerdict,
  type SubAgentResult,
} from "./sub-agents";
import { flipPhaseCheckboxes, flipTestSpecCheckbox } from "./plan-mutator";
import { shipAndDeploy } from "./ship";
import { createWorktrees, applyWinner, teardownWorktrees } from "./worktree";
import type { BuildState, Phase, DualImplTestResult } from "./types";

export interface Args {
  planFile: string;
  printOnly: boolean;
  dryRun: boolean;
  noResume: boolean;
  noGbrain: boolean;
  skipShip: boolean;
  maxCodexIter: number;
  testCmd?: string;
  /** When true, every phase implements via Gemini+Codex tournament with Opus judge. */
  dualImpl: boolean;
  /** Model for Gemini (Implementor A). Default: gemini-3.1-pro-preview (thinking built-in). */
  geminiModel: string;
  /** Model for Codex (Implementor B, dual-impl). Default: gpt-5.3-codex-spark. */
  codexModel: string;
  /** Model for Codex review pass. Default: gpt-5.5. */
  codexReviewModel: string;
  /** Skip the pre-build working tree dirty check. */
  skipCleanCheck: boolean;
  /** Skip the unshipped feat/* branch sweep at startup. */
  skipSweep: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    planFile: "",
    printOnly: false,
    dryRun: false,
    noResume: false,
    noGbrain: false,
    skipShip: false,
    maxCodexIter: DEFAULT_MAX_CODEX_ITERATIONS,
    dualImpl: false,
    geminiModel: "gemini-3.1-pro-preview",
    codexModel: "gpt-5.3-codex-spark",
    codexReviewModel: "gpt-5.5",
    skipCleanCheck: false,
    skipSweep: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print-only") args.printOnly = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-resume" || a === "--restart") args.noResume = true;
    else if (a === "--no-gbrain") args.noGbrain = true;
    else if (a === "--skip-ship") args.skipShip = true;
    else if (a === "--skip-clean-check") args.skipCleanCheck = true;
    else if (a === "--skip-sweep") args.skipSweep = true;
    else if (a === "--dual-impl") args.dualImpl = true;
    else if (a === "--gemini-model") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        console.error("--gemini-model requires a value");
        process.exit(2);
      }
      args.geminiModel = next;
    } else if (a === "--codex-model") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        console.error("--codex-model requires a value");
        process.exit(2);
      }
      args.codexModel = next;
    } else if (a === "--codex-review-model") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        console.error("--codex-review-model requires a value");
        process.exit(2);
      }
      args.codexReviewModel = next;
    } else if (a === "--test-cmd") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        console.error("--test-cmd requires a value");
        process.exit(2);
      }
      args.testCmd = next;
    } else if (a === "--max-codex-iter") {
      const next = argv[++i];
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        console.error(
          `--max-codex-iter expects a positive integer, got: ${next}`,
        );
        process.exit(2);
      }
      args.maxCodexIter = n;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    console.error("usage: gstack-build <plan-file> [flags]   (-h for help)");
    process.exit(2);
  }
  args.planFile = path.resolve(positional[0]);
  return args;
}

export const HELP_TEXT = `gstack-build — code-driven phase orchestrator

Usage:
  gstack-build <plan-file> [flags]

Flags:
  --print-only         Parse and show phase table; exit.
  --dry-run            Walk state machine without spawning sub-agents.
  --no-resume          Ignore existing state, start fresh.
  --no-gbrain          Skip gbrain mirror; local JSON only.
  --skip-ship          Skip the final /ship + /land-and-deploy step.
  --skip-clean-check   Skip the pre-build working tree dirty check.
  --skip-sweep         Skip the unshipped feat/* branch sweep at startup.
  --dual-impl          Tournament mode: Gemini and Codex implement in parallel
                       (isolated git worktrees), Opus judges and the winner
                       is cherry-picked back. Existing TDD pipeline runs after.
  --gemini-model <m>   Model for Gemini (Implementor A). Default: gemini-3.1-pro-preview.
  --codex-model <m>    Model for Codex Implementor B (dual-impl). Default: gpt-5.3-codex-spark.
  --codex-review-model <m>
                       Model for Codex review pass. Default: gpt-5.5.
  --test-cmd <cmd>     Override test command (default: auto-detect from package.json/pytest.ini/go.mod/Cargo.toml).
  --max-codex-iter N   Cap recursive Codex iterations (default 5).
  -h, --help           Show this help.

Plan file format: standard /build implementation plan with:
  ### Phase N: <name>
  - [ ] **Implementation (Gemini Sub-agent)**: ...
  - [ ] **Review & QA (Codex Sub-agent)**: ...

State files: ~/.gstack/build-state/<slug>/
Activity log: ~/.gstack/analytics/build-runs.jsonl
`;

function printHelp() {
  console.log(HELP_TEXT);
}

function printPhaseTable(phases: Phase[]) {
  if (phases.length === 0) {
    console.log("(no phases parsed)");
    return;
  }
  const numWidth = Math.max(5, ...phases.map((p) => p.number.length));
  const nameWidth = Math.max(20, ...phases.map((p) => p.name.length));

  console.log(
    `  ${"Phase".padEnd(numWidth)}  ${"Name".padEnd(nameWidth)}  Impl  Review  Status`,
  );
  console.log("  " + "-".repeat(numWidth + nameWidth + 28));

  for (const p of phases) {
    const impl = p.implementationDone ? " ✓ " : " · ";
    const rev = p.reviewDone ? " ✓  " : " ·  ";
    let status: string;
    if (isPhaseComplete(p)) status = "done";
    else if (p.implementationDone || p.reviewDone) status = "partial";
    else status = "pending";
    console.log(
      `  ${p.number.padEnd(numWidth)}  ${p.name.padEnd(nameWidth)}  ${impl}   ${rev} ${status}`,
    );
  }
}

export function printPhaseReport(
  phase: Phase,
  phaseState: import("./types").PhaseState,
  nextPhaseName: string | null,
  cwd: string,
) {
  const w = 58;
  const bar = "═".repeat(w);
  const line = (label: string, value: string) =>
    `  ${label.padEnd(14)} ${value}`;

  const gitSha = (() => {
    try {
      const r = spawnSync("git", ["log", "--oneline", "-1"], {
        encoding: "utf8",
        cwd,
        timeout: 10_000,
      });
      if (r.status !== 0 || r.error) return "(unknown)";
      return r.stdout?.trim() || "(unknown)";
    } catch {
      return "(unknown)";
    }
  })();

  const testIter = phaseState.testRun?.iterations ?? 0;
  const fixIter = phaseState.testFix?.iterations ?? 0;
  const codexIter = phaseState.codexReview?.iterations ?? 0;
  const redAttempts = phaseState.redSpecAttempts ?? 0;
  const testStatus =
    phaseState.testRun?.finalStatus === "green"
      ? `✅ green (fix iters: ${fixIter}, test runs: ${testIter})`
      : `⚠ ${phaseState.testRun?.finalStatus ?? "n/a"}`;
  const reviewStatus =
    phaseState.codexReview?.finalVerdict === "GATE PASS"
      ? `✅ GATE PASS (iters: ${codexIter})`
      : `⚠ ${phaseState.codexReview?.finalVerdict ?? "n/a"} (iters: ${codexIter})`;

  console.log(`\n${"═".repeat(w)}`);
  console.log(`  PHASE ${phase.number} COMPLETE — ${phase.name}`);
  console.log(bar);
  if (phaseState.geminiTestSpec) {
    console.log(
      line("Test Spec:", `✅ written (red attempts: ${redAttempts})`),
    );
  }
  console.log(line("Tests:", testStatus));
  console.log(line("Review:", reviewStatus));
  console.log(line("Commit:", gitSha));
  console.log(
    line("Next:", nextPhaseName ? `Phase → ${nextPhaseName}` : "FINAL SHIP"),
  );
  console.log(`${"═".repeat(w)}\n`);
}

export async function verifyPostShip(
  cwd: string,
  branch: string,
): Promise<{ ok: boolean; report: string[] }> {
  const issues: string[] = [];
  const lines: string[] = [];

  const run = (cmd: string, args: string[], timeoutMs = 15_000) =>
    spawnSync(cmd, args, { encoding: "utf8", cwd, timeout: timeoutMs });

  // 1. No open PRs for the feature branch
  const openPR = run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      branch,
      "--json",
      "number",
      "--jq",
      "length",
    ],
    30_000,
  );
  if (openPR.status !== 0 || openPR.error) {
    issues.push("gh pr list failed — cannot verify PR state");
    lines.push(`  PR:          ⚠ gh command failed (check auth/network)`);
  } else {
    const openCount = Number(openPR.stdout?.trim());
    if (!Number.isFinite(openCount) || openCount > 0) {
      const label = Number.isFinite(openCount)
        ? `${openCount} open PR(s) for ${branch}`
        : "unexpected gh output";
      issues.push(label);
      lines.push(
        `  PR:          ⚠ ${label} — /land-and-deploy may not have completed`,
      );
    } else {
      lines.push(`  PR:          ✅ merged (0 open)`);
    }
  }

  // 2. No unmerged feat/* branches on origin (excluding the current branch)
  const fetchResult = run("git", ["fetch", "origin"], 30_000);
  if (fetchResult.status !== 0 || fetchResult.error) {
    // Fail-closed: if fetch failed, we can't trust the branch list
    issues.push("git fetch failed — cannot verify unmerged branch state");
    lines.push(
      `  Branches:    ⚠ git fetch failed — cannot verify (check network/auth)`,
    );
  } else {
    const unmerged = run("git", ["branch", "-r", "--no-merged", "origin/main"]);
    const unmergedFeat = (unmerged.stdout || "")
      .split("\n")
      .map((l: string) => l.trim())
      .filter(
        (l: string) => l.startsWith("origin/feat/") && l !== `origin/${branch}`,
      );
    if (unmergedFeat.length > 0) {
      issues.push(`unmerged feat branches: ${unmergedFeat.join(", ")}`);
      lines.push(`  Branches:    ⚠ unmerged: ${unmergedFeat.join(", ")}`);
    } else {
      lines.push(`  Branches:    ✅ no unmerged feat/* on origin/main`);
    }
  }

  // 3. Working tree clean
  const dirty = run("git", ["status", "--porcelain"]);
  if ((dirty.stdout || "").trim()) {
    issues.push("working tree is not clean after ship");
    lines.push(`  Working tree: ⚠ dirty — uncommitted changes remain`);
  } else {
    lines.push(`  Working tree: ✅ clean`);
  }

  // 4. Current HEAD on main matches origin/main (fail-closed: mismatch or unknown → issue)
  const localHeadR = run("git", ["rev-parse", "HEAD"]);
  const remoteHeadR = run("git", ["rev-parse", "origin/main"]);
  const localHead = localHeadR.status === 0 ? localHeadR.stdout?.trim() : null;
  const remoteHead =
    remoteHeadR.status === 0 ? remoteHeadR.stdout?.trim() : null;
  if (!localHead || !remoteHead) {
    issues.push("could not determine HEAD — rev-parse failed");
    lines.push(`  Main sync:   ⚠ could not determine HEAD (rev-parse failed)`);
  } else if (localHead !== remoteHead) {
    issues.push(
      `local HEAD ${localHead.slice(0, 7)} ≠ origin/main ${remoteHead.slice(0, 7)}`,
    );
    lines.push(
      `  Main sync:   ⚠ local HEAD ${localHead.slice(0, 7)} ≠ origin/main ${remoteHead.slice(0, 7)}`,
    );
  } else {
    lines.push(`  Main sync:   ✅ in sync`);
  }

  return { ok: issues.length === 0, report: lines };
}

function logActivity(event: Record<string, any>) {
  const dir = path.join(os.homedir(), ".gstack", "analytics");
  fs.mkdirSync(dir, { recursive: true });
  const line =
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  try {
    fs.appendFileSync(path.join(dir, "build-runs.jsonl"), line);
  } catch {
    // never sink the orchestrator
  }
}

/**
 * Build the Gemini prompt body that gets WRITTEN TO A FILE before invocation.
 * The orchestrator never inlines this content into the CLI call — runGemini's
 * shell-prompt is just a short "read $input, write $output" instruction. This
 * is the universal file-path I/O rule (see feedback_llm_file_io.md memory).
 */
function buildGeminiPromptBody(
  phase: Phase,
  planFile: string,
  branch: string,
): string {
  return [
    `# Phase ${phase.number}: ${phase.name}`,
    "",
    `Branch: ${branch}`,
    `Plan file: ${planFile}`,
    "",
    "## Phase description (verbatim from the plan)",
    "",
    phase.body.trim(),
    "",
    "## Instructions",
    "",
    `1. Make all failing tests pass with minimal correct code. Do NOT change test assertions.\n2. If there are no existing failing tests, implement the work described above.`,
    `3. If the project uses GitHub Actions, ensure your changes pass them.`,
    `4. Commit your changes to the current branch with a clear conventional-commit message.`,
    `5. Do NOT run /review, /qa, /ship, or any orchestration skill — those are downstream of you.`,
    `6. Do NOT update the plan file's checkboxes — the orchestrator handles that.`,
    `7. Fail forward: if a test fails, fix it before returning. Only return when the code is done and committed.`,
    `8. Reference existing code by file path — your --yolo file tools work, you don't need code inlined.`,
    "",
    "## Output format",
    "",
    "Write a short markdown summary to the output file (path provided to you in the shell prompt). Include:",
    "- Files changed (list of paths with one-line description each)",
    "- Tests run (which test files, pass/fail count)",
    "- Commit SHA (the conventional-commit message and commit hash)",
    "- Anything surprising or worth flagging to the orchestrator",
  ].join("\n");
}

/**
 * Build the Codex review context body that gets written to a file. Captures
 * which phase, what changed, what to verify so Codex can run /gstack-review
 * with full context without us inlining a huge diff.
 */
function buildCodexReviewBody(
  phase: Phase,
  planFile: string,
  branch: string,
  iteration: number,
  geminiOutputPath: string | null,
  hardeningNotes?: string,
): string {
  return [
    `# Codex Review — Phase ${phase.number}: ${phase.name} (iter ${iteration})`,
    "",
    `Branch: ${branch}`,
    `Plan file: ${planFile}`,
    geminiOutputPath
      ? `Gemini's implementation summary: ${geminiOutputPath}`
      : "",
    "",
    "## Phase description (what was supposed to be built)",
    "",
    phase.body.trim(),
    "",
    hardeningNotes
      ? (() => {
          // Strip gate sentinel keywords to prevent prompt injection via judge output.
          const safe = hardeningNotes.replace(/\bGATE PASS\b/gi, "GATE_PASS").replace(/\bGATE FAIL\b/gi, "GATE_FAIL");
          return `## Hardening notes from tournament judge\n\nThe following concrete issues were encountered by one or both implementors during their fix loops. The final implementation MUST NOT regress on any of these:\n\n${safe.slice(0, 3000)}${safe.length > 3000 ? `\n\n[...truncated ${safe.length - 3000} bytes]` : ""}\n`;
        })()
      : "",
    "## Your task",
    "",
    `1. Run /gstack-review on the current branch's working tree against its base.`,
    `2. If iteration > 1, this is a re-review after Codex tried to fix earlier findings — be especially thorough.`,
    `3. Use --yolo / workspace-write file tools to inspect the actual code; don't ask the orchestrator to inline anything.`,
    `4. Fix bugs as you find them (workspace-write sandbox is enabled).`,
    `5. Write your full review report to the output file path (provided in the shell prompt).`,
    `6. The output file MUST end with a single line: \`GATE PASS\` if no remaining issues, or \`GATE FAIL\` with a list of remaining issues.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGeminiTestSpecPrompt(
  phase: Phase,
  planFile: string,
): string {
  return [
    `# Phase ${phase.number}: ${phase.name} — Test Specification`,
    ``,
    `Plan file: ${planFile}`,
    ``,
    `## Phase description (verbatim from the plan)`,
    ``,
    phase.body.trim(),
    ``,
    `## Instructions`,
    ``,
    `1. Write failing tests that cover the behavior described above.`,
    `   Tests MUST fail before any implementation exists — this is the Red phase of TDD.`,
    `2. Do NOT implement the feature. Do NOT write production code. Write tests ONLY.`,
    `3. Cover: happy path + key edge cases using the project's existing test framework.`,
    `4. Commit the failing tests to the current branch.`,
    `5. Write your output summary to the output file path (provided in shell prompt).`,
  ].join("\n");
}

export function buildCodexImplPromptBody(
  phase: Phase,
  planFile: string,
): string {
  return [
    `# Phase ${phase.number}: ${phase.name} — Codex Implementation (dual-impl tournament)`,
    ``,
    `Plan file: ${planFile}`,
    ``,
    `## Phase description (verbatim from the plan)`,
    ``,
    phase.body.trim(),
    ``,
    `## Instructions`,
    ``,
    `You are competing against Gemini in a tournament. Both of you are implementing this phase`,
    `independently in isolated git worktrees. After both finish, an Opus judge will pick the better`,
    `implementation.`,
    ``,
    `1. Implement the changes to make all failing tests pass.`,
    `2. Do NOT change test assertions — only make tests pass.`,
    `3. Write minimal correct code. Avoid over-engineering.`,
    `4. Commit your changes to the current branch with a clear conventional-commit message.`,
    `5. Do NOT update the plan file's checkboxes — the orchestrator handles that.`,
    `6. Write your output summary to the output file path (provided in the shell prompt).`,
  ].join("\n");
}

export function buildJudgePrompt(opts: {
  phase: Phase;
  geminiDiff: string;
  codexDiff: string;
  geminiTestResult: DualImplTestResult;
  codexTestResult: DualImplTestResult;
  geminiFixIterations?: number | null;
  codexFixIterations?: number | null;
  /** Truncated test-failure output at each fix iteration for Gemini. */
  geminiFixHistory?: string;
  /** Truncated test-failure output at each fix iteration for Codex. */
  codexFixHistory?: string;
}): string {
  const { phase, geminiDiff, codexDiff, geminiTestResult, codexTestResult } =
    opts;
  // 40 000 chars ≈ 500 lines × 80 chars — matches the design spec cap.
  const trim = (s: string, max = 40000) =>
    s.length <= max
      ? s
      : s.slice(0, max) + `\n\n[...truncated ${s.length - max} bytes]`;
  // History cap: 3 000 chars per side is enough to see what bugs were hit.
  const trimHistory = (s: string) => trim(s, 3000);

  const fmtTest = (r: DualImplTestResult) =>
    `Exit code: ${r.testExitCode === null ? "killed" : r.testExitCode} | ` +
    `Failures: ${r.failureCount ?? "unknown"}` +
    (r.timedOut ? " | TIMED OUT" : "");

  const fmtFixIter = (n: number | null | undefined) => {
    if (n === undefined) return "";
    if (n === null) return "Fix loop: not run (impl failed or no test command)";
    if (n === 0) return `Fix iterations: 0 (passed on first try)`;
    return `Fix iterations: ${n} (required ${n} fix pass${n === 1 ? "" : "es"} to reach this state)`;
  };

  return [
    `You are a code quality judge. Two implementations of the same task were produced`,
    `independently by Gemini and Codex, each running their own recursive test-fix loop.`,
    `Compare them and pick the better one.`,
    ``,
    `## Task: Phase ${phase.number} — ${phase.name}`,
    ``,
    phase.body.trim(),
    ``,
    `## Gemini implementation (diff from base)`,
    ``,
    "```diff",
    trim(geminiDiff),
    "```",
    ``,
    `## Gemini test result`,
    fmtTest(geminiTestResult),
    fmtFixIter(opts.geminiFixIterations),
    opts.geminiFixHistory
      ? `\n## Gemini fix history (what failed at each iteration)\n\n${trimHistory(opts.geminiFixHistory)}`
      : "",
    ``,
    `## Codex implementation (diff from base)`,
    ``,
    "```diff",
    trim(codexDiff),
    "```",
    ``,
    `## Codex test result`,
    fmtTest(codexTestResult),
    fmtFixIter(opts.codexFixIterations),
    opts.codexFixHistory
      ? `\n## Codex fix history (what failed at each iteration)\n\n${trimHistory(opts.codexFixHistory)}`
      : "",
    ``,
    `## Your verdict`,
    ``,
    `Pick the implementation that:`,
    `(1) passes more tests — if both pass, prefer the one that needed fewer fix iterations`,
    `    (fewer iterations = understood the task on first attempt; more iterations = hacking-to-green),`,
    `(2) is cleaner and more correct — no silent error swallowing, no type casts used to dodge the`,
    `    type-checker, no undefined edge cases silently ignored,`,
    `(3) makes minimal, focused changes — no cosmetic churn, no unrelated refactors bundled in,`,
    `    no helper functions invented for a single call site,`,
    `(4) is easier to maintain — low coupling, follows existing codebase patterns, no hidden`,
    `    assumptions that only the author knows,`,
    `(5) has clean test hygiene — if either implementation modified test assertions, removed test`,
    `    cases, or added skip/todo markers to make tests pass, penalise it heavily regardless of`,
    `    its pass rate.`,
    ``,
    `IMPORTANT — test integrity: scan both diffs for changes to files matching *.test.ts,`,
    `*.spec.ts, *.test.js, *.spec.js, or paths containing __tests__/ or /test/. Any weakening`,
    `of assertions, removal of test cases, or addition of skip/todo is a serious red flag.`,
    ``,
    `Respond EXACTLY in this format — each keyword must be at the start of its own line:`,
    ``,
    `WINNER: gemini`,
    `REASONING: <one paragraph, concrete reasons — cite line counts, fix iterations, specific`,
    `code patterns that influenced your decision>`,
    `HARDENING: <bullet list of every concrete bug or edge case that appeared in EITHER`,
    `implementor's fix history, starting each item with "->". These are the issues the final`,
    `code MUST handle, regardless of which side wins. Include issues the winner already fixed`,
    `AND issues from the losing side that the winner may not have encountered. If there are no`,
    `failure histories or all issues are trivially handled, write "-> none identified".>`,
    ``,
    `Replace 'gemini' with 'codex' if Codex wins. Use lowercase. The WINNER line must`,
    `be at the start of its line — do not embed it in prose.`,
  ].join("\n");
}

export function buildGeminiFixPrompt(phase: Phase, planFile: string): string {
  return [
    `# Phase ${phase.number}: ${phase.name} — Fix Failing Tests`,
    ``,
    `Plan file: ${planFile}`,
    ``,
    `## Instructions`,
    ``,
    `Tests are failing after implementation — fix the code to make them pass, do NOT change test assertions.`,
    ``,
    `Write your output summary to the output file path (provided in shell prompt).`,
  ].join("\n");
}

function summarizePhase(
  phaseNumber: string,
  phaseName: string,
  marker: string,
) {
  console.log(`\n[${marker}] Phase ${phaseNumber}: ${phaseName}`);
}

/**
 * After an implementor's initial pass, run tests and fix recursively in that
 * worktree until green or maxFixIter exhausted. Both Gemini and Codex loops
 * run inside Promise.all — they are fully concurrent and independent.
 *
 * Returns the final DualImplTestResult and the number of fix passes that ran
 * (0 = passed on first try, N = needed N fix passes).
 */
async function runDualImplFixLoop(opts: {
  model: "gemini" | "codex";
  worktreePath: string;
  phase: Phase;
  planFile: string;
  branch: string;
  slug: string;
  phaseNumber: string;
  testCmd: string | null;
  maxFixIter: number;
  geminiModel?: string;
  codexModel?: string;
}): Promise<{
  testResult: DualImplTestResult;
  fixIterations: number | null;
  fixHistory: string;
}> {
  const {
    model,
    worktreePath,
    phase,
    planFile,
    branch,
    slug,
    phaseNumber,
    testCmd,
    maxFixIter,
    geminiModel,
    codexModel,
  } = opts;

  if (!testCmd) {
    return {
      testResult: {
        worktreePath,
        testExitCode: 0,
        testLogPath: "no-test-cmd",
        timedOut: false,
        failureCount: 0,
      },
      fixIterations: null,
      fixHistory: "",
    };
  }

  const ld = logDir(slug);
  // Collects truncated test output for each failing iteration — fed to the judge.
  const failureLog: string[] = [];

  // Initial test run (before any fixes).
  let testRun = await runTests({
    testCmd,
    cwd: worktreePath,
    slug,
    phaseNumber,
    iteration: 1,
    logSuffix: `${model}-pre`,
  });
  let testResult: DualImplTestResult = {
    worktreePath,
    testExitCode: testRun.exitCode,
    testLogPath: testRun.logPath,
    timedOut: testRun.timedOut,
    failureCount: parseFailureCount(testRun.stdout + "\n" + testRun.stderr),
  };
  if (testRun.exitCode === 0 && !testRun.timedOut)
    return { testResult, fixIterations: 0, fixHistory: "" };

  failureLog.push(
    `--- Before any fix (initial) ---\n${(testRun.stdout + "\n" + testRun.stderr).slice(0, 2000)}`,
  );

  let lastIter: number | null = null;
  for (let i = 1; i <= maxFixIter; i++) {
    const fixInput = path.join(
      ld,
      `phase-${phaseNumber}-dual-${model}-fix${i}-input.md`,
    );
    const fixOutput = path.join(
      ld,
      `phase-${phaseNumber}-dual-${model}-fix${i}-output.md`,
    );

    const fixBody = [
      `# Phase ${phase.number}: ${phase.name} — Fix Failing Tests (dual-impl ${model}, pass ${i})`,
      ``,
      `Plan file: ${planFile}`,
      model === "gemini" ? `Branch: ${branch}` : ``,
      ``,
      `## Failing test output`,
      ``,
      "```",
      (testRun.stdout + "\n" + testRun.stderr).slice(0, 8000),
      "```",
      ``,
      `## Instructions`,
      ``,
      `Fix the implementation to make the above tests pass.`,
      `Do NOT change test assertions — only modify implementation files.`,
      `Commit your fix when done.`,
      `Write your output summary to the output file path (provided in shell prompt).`,
    ]
      .filter(Boolean)
      .join("\n");

    fs.writeFileSync(fixInput, fixBody);
    fs.writeFileSync(fixOutput, "");

    let fixResult: SubAgentResult;
    if (model === "gemini") {
      fixResult = await runGemini({
        inputFilePath: fixInput,
        outputFilePath: fixOutput,
        cwd: worktreePath,
        slug,
        phaseNumber,
        iteration: i,
        logPrefix: `dual-gemini-fix${i}`,
        model: geminiModel,
      });
    } else {
      fixResult = await runCodexImpl({
        inputFilePath: fixInput,
        outputFilePath: fixOutput,
        cwd: worktreePath,
        slug,
        phaseNumber,
        iteration: i,
        logPrefix: `dual-codex-fix${i}`,
        model: codexModel,
      });
    }
    // If the model itself failed, there are no new commits — running tests again
    // would produce identical failures and waste the remaining fix budget.
    if (fixResult.timedOut || fixResult.exitCode !== 0) {
      failureLog.push(
        `--- Fix pass ${i} FAILED (model exited ${fixResult.exitCode ?? "killed"}, timedOut=${fixResult.timedOut}) — no changes committed ---`,
      );
      break;
    }
    lastIter = i;

    testRun = await runTests({
      testCmd,
      cwd: worktreePath,
      slug,
      phaseNumber,
      iteration: i + 1,
      logSuffix: `${model}-fix${i}`,
    });
    testResult = {
      worktreePath,
      testExitCode: testRun.exitCode,
      testLogPath: testRun.logPath,
      timedOut: testRun.timedOut,
      failureCount: parseFailureCount(testRun.stdout + "\n" + testRun.stderr),
    };

    const fixHistoryStr = failureLog.join("\n\n");
    if (testRun.exitCode === 0 && !testRun.timedOut) {
      // Auto-commit any tracked dirty changes so `testedCommit` (HEAD) matches
      // what tests actually ran against. Dirty worktrees cause SHA stale-cache
      // detection to fail-closed on resume.
      const dirty = spawnSync("git", ["diff", "HEAD", "--quiet"], { cwd: worktreePath });
      if (dirty.status !== 0) {
        spawnSync("git", ["add", "-u"], { cwd: worktreePath });
        spawnSync("git", [
          "commit", "-m",
          `chore: auto-commit staged changes after green tests (fix pass ${i}) [gstack-dual]`,
        ], { cwd: worktreePath });
      }
      return { testResult, fixIterations: i, fixHistory: fixHistoryStr };
    }
    failureLog.push(
      `--- After fix pass ${i} (still failing) ---\n${(testRun.stdout + "\n" + testRun.stderr).slice(0, 2000)}`,
    );
  }

  // Exhausted fix budget (or broke early on model crash) — return actual iteration count.
  return {
    testResult,
    fixIterations: lastIter,
    fixHistory: failureLog.join("\n\n"),
  };
}

/**
 * Read `git diff baseCommit..HEAD` from a worktree.
 * Returns null on git failure — caller MUST fail-closed (Phase 4 review HIGH:
 * silent empty diff would let the judge see no evidence and pick arbitrarily).
 */
function readWorktreeDiff(
  worktreePath: string,
  baseCommit: string,
): string | null {
  const r = spawnSync("git", ["diff", `${baseCommit}..HEAD`], {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout || "";
}

/** Count commits in a worktree since base. Returns null on git failure. */
function countCommitsSinceBase(
  worktreePath: string,
  baseCommit: string,
): number | null {
  const r = spawnSync("git", ["rev-list", "--count", `${baseCommit}..HEAD`], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const n = Number((r.stdout || "").trim());
  return Number.isFinite(n) ? n : null;
}

async function runPhase(args: {
  state: BuildState;
  phase: Phase;
  nextPhaseName: string | null;
  cwd: string;
  noGbrain: boolean;
  dryRun: boolean;
  maxCodexIter: number;
  testCmd?: string;
  geminiModel: string;
  codexModel: string;
  codexReviewModel: string;
}): Promise<"done" | "failed"> {
  const { state, phase, cwd, noGbrain, dryRun, maxCodexIter } = args;
  let phaseState = state.phases[phase.index];

  while (true) {
    const action: Action = decideNextAction(
      phaseState,
      maxCodexIter,
      phase,
      DEFAULT_MAX_TEST_ITERATIONS,
    );

    if (action.type === "DONE") return "done";
    if (action.type === "FAIL") {
      state.failedAtPhase = phase.index;
      state.failureReason = action.reason;
      saveState(state, { noGbrain, log: console.warn });
      console.error(
        `✗ Phase ${phase.number} (${phase.name}) failed: ${action.reason}`,
      );
      return "failed";
    }

    if (action.type === "MARK_COMPLETE") {
      if (!dryRun) {
        // Flip test-spec checkbox only if the test-spec step actually ran (Phase 4+).
        // Without the real TDD handlers wired, geminiTestSpec is never set, so we skip.
        if (phase.testSpecCheckboxLine !== -1 && phaseState.geminiTestSpec) {
          const specFlip = flipTestSpecCheckbox(state.planFile, phase);
          if (specFlip.error) {
            state.failedAtPhase = phase.index;
            state.failureReason = `plan test-spec checkbox flip failed: ${specFlip.error}`;
            saveState(state, { noGbrain, log: console.warn });
            console.error(`✗ Phase ${phase.number}: ${state.failureReason}`);
            return "failed";
          }
        }
        const flips = flipPhaseCheckboxes({
          planFile: state.planFile,
          implementationLine: phase.implementationCheckboxLine,
          reviewLine: phase.reviewCheckboxLine,
        });
        if (flips.implementation.error || flips.review.error) {
          state.failedAtPhase = phase.index;
          state.failureReason = `plan checkbox flip failed: impl=${flips.implementation.error || "ok"}; review=${flips.review.error || "ok"}`;
          saveState(state, { noGbrain, log: console.warn });
          console.error(`✗ Phase ${phase.number}: ${state.failureReason}`);
          return "failed";
        }
      }
      phaseState = markCommitted(phaseState);
      state.phases[phase.index] = phaseState;
      state.currentPhaseIndex = phase.index + 1;
      saveState(state, { noGbrain, log: console.warn });
      printPhaseReport(phase, phaseState, args.nextPhaseName, args.cwd);
      return "done";
    }

    if (action.type === "RUN_GEMINI") {
      console.log(
        `  → Gemini: implementing Phase ${phase.number} (iter ${action.iteration})`,
      );
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({
          exitCode: 0,
          stdout: "[dry-run] Gemini would have implemented",
        });
      } else {
        // File-path I/O: write input prompt to disk, pass paths to runGemini.
        const inputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-${action.iteration}-input.md`,
        );
        const outputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-${action.iteration}-output.md`,
        );
        fs.writeFileSync(
          inputFilePath,
          buildGeminiPromptBody(phase, state.planFile, state.branch),
        );
        // Pre-create empty output file so a missing-file error is unambiguous.
        fs.writeFileSync(outputFilePath, "");
        result = await runGemini({
          inputFilePath,
          outputFilePath,
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
          iteration: action.iteration,
          model: args.geminiModel,
        });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === "RUN_CODEX_REVIEW") {
      console.log(`  → Codex review iter ${action.iteration}`);
      let result: SubAgentResult;
      if (dryRun) {
        // For dry-run, simulate a single GATE PASS so we walk through
        // the happy path without infinite loops.
        result = mockResult({
          exitCode: 0,
          stdout: "[dry-run] Codex would review. GATE PASS",
        });
      } else {
        const inputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-codex-${action.iteration}-input.md`,
        );
        const outputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-codex-${action.iteration}-output.md`,
        );
        // Locate Gemini's output from this iteration so Codex can read it.
        const geminiOutputPath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-${action.iteration}-output.md`,
        );
        const geminiOutputExists = fs.existsSync(geminiOutputPath);
        fs.writeFileSync(
          inputFilePath,
          buildCodexReviewBody(
            phase,
            state.planFile,
            state.branch,
            action.iteration,
            geminiOutputExists ? geminiOutputPath : null,
            phaseState.dualImpl?.judgeHardeningNotes,
          ),
        );
        fs.writeFileSync(outputFilePath, "");
        result = await runCodexReview({
          inputFilePath,
          outputFilePath,
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
          iteration: action.iteration,
          model: args.codexReviewModel,
        });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === "RUN_GEMINI_TEST_SPEC") {
      console.log(
        `  → Test Specification: Phase ${phase.number} (iter ${action.iteration})`,
      );
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({
          exitCode: 0,
          stdout: "[dry-run] Gemini would write test spec",
        });
      } else {
        const inputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-testspec-${action.iteration}-input.md`,
        );
        const outputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-testspec-${action.iteration}-output.md`,
        );
        fs.writeFileSync(
          inputFilePath,
          buildGeminiTestSpecPrompt(phase, state.planFile),
        );
        fs.writeFileSync(outputFilePath, "");
        result = await runGeminiTestSpec({
          inputFilePath,
          outputFilePath,
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
          iteration: action.iteration,
          model: args.geminiModel,
        });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === "VERIFY_RED") {
      console.log(`  → Verify Red: running tests to confirm they fail`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({
          exitCode: 1,
          stdout: "[dry-run] tests would fail (Red)",
        });
      } else {
        const testCmd = args.testCmd ?? detectTestCmd(cwd);
        if (!testCmd) {
          console.warn(
            "  ⚠ no test command detected; assuming Red for VERIFY_RED",
          );
          result = mockResult({
            exitCode: 1,
            stdout: "no test command detected; assuming Red",
          });
        } else {
          result = await runTests({
            testCmd,
            cwd,
            slug: state.slug,
            phaseNumber: phase.number,
            iteration: 1,
          });
        }
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === "RUN_TESTS") {
      console.log(`  → Tests: iter ${action.iteration}`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({
          exitCode: 0,
          stdout: "[dry-run] tests would pass (Green)",
        });
      } else {
        const testCmd = args.testCmd ?? detectTestCmd(cwd);
        if (!testCmd) {
          // No test cmd: skip test verification, treat as green.
          console.warn(
            "  ⚠ no test command detected; skipping test verification",
          );
          result = mockResult({
            exitCode: 0,
            stdout: "no test command; skipped",
          });
        } else {
          result = await runTests({
            testCmd,
            cwd,
            slug: state.slug,
            phaseNumber: phase.number,
            iteration: action.iteration,
          });
        }
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === "RUN_GEMINI_FIX") {
      console.log(`  → Gemini: fixing failing tests, iter ${action.iteration}`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({
          exitCode: 0,
          stdout: "[dry-run] Gemini would fix tests",
        });
      } else {
        const inputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-fix-${action.iteration}-input.md`,
        );
        const outputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-fix-${action.iteration}-output.md`,
        );
        fs.writeFileSync(
          inputFilePath,
          buildGeminiFixPrompt(phase, state.planFile),
        );
        fs.writeFileSync(outputFilePath, "");
        result = await runGemini({
          inputFilePath,
          outputFilePath,
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
          iteration: action.iteration,
          logPrefix: "gemini-fix",
          model: args.geminiModel,
        });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    // -----------------------------------------------------------------
    // Dual-implementor (--dual-impl) action handlers
    // -----------------------------------------------------------------

    if (action.type === "RUN_DUAL_IMPL") {
      console.log(
        `  → Dual Impl: spawning Gemini + Codex in parallel worktrees (iter ${action.iteration})`,
      );
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({
          exitCode: 0,
          stdout: "[dry-run] Dual Impl would spawn both",
        });
        phaseState = applyResult(phaseState, action, result, {
          dualImplInit: {
            geminiWorktreePath: "/tmp/dryrun-gemini",
            codexWorktreePath: "/tmp/dryrun-codex",
            geminiBranch: "dryrun-gemini",
            codexBranch: "dryrun-codex",
            baseCommit: "dryrun-base",
          },
        });
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      // Real path: create worktrees, run both impls in parallel.

      // If a prior run crashed between createWorktrees and saveState, phaseState.dualImpl
      // already holds the orphaned paths — tear them down before creating a fresh pair.
      if (phaseState.dualImpl?.geminiWorktreePath) {
        console.log(
          `  ↩ Tearing down orphaned worktrees from interrupted prior run…`,
        );
        teardownWorktrees({ cwd, dualImpl: phaseState.dualImpl as any });
      }

      let pair;
      try {
        pair = createWorktrees({
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
        });
      } catch (err) {
        const msg = `Failed to create dual-impl worktrees: ${(err as Error).message}`;
        phaseState = applyResult(
          phaseState,
          action,
          mockResult({ exitCode: 1, stderr: msg }),
        );
        phaseState.error = msg;
        phaseState.status = "failed";
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      // Wrap everything post-createWorktrees in try/catch so an unexpected
      // error (failed writeFileSync, unexpected reject from Promise.all,
      // commit-validation throw) doesn't leak the worktrees. (Phase 4 review,
      // MEDIUM: cleanup guard.)
      const dualState = {
        geminiWorktreePath: pair.geminiWorktreePath,
        codexWorktreePath: pair.codexWorktreePath,
        geminiBranch: pair.geminiBranch,
        codexBranch: pair.codexBranch,
        baseCommit: pair.baseCommit,
      };

      // Persist worktree paths immediately so that if we crash before applyResult
      // saves them, the next resume finds them and can tear down the orphaned pair.
      phaseState = { ...phaseState, dualImpl: dualState };
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });

      let dualImplOk = false;
      try {
        const implPromptBody = buildGeminiPromptBody(
          phase,
          state.planFile,
          state.branch,
        );
        const codexPromptBody = buildCodexImplPromptBody(phase, state.planFile);

        const slug = state.slug;
        const phaseN = phase.number;
        const it = action.iteration;

        const geminiInputPath = path.join(
          logDir(slug),
          `phase-${phaseN}-dual-gemini-${it}-input.md`,
        );
        const geminiOutputPath = path.join(
          logDir(slug),
          `phase-${phaseN}-dual-gemini-${it}-output.md`,
        );
        const codexInputPath = path.join(
          logDir(slug),
          `phase-${phaseN}-dual-codex-${it}-input.md`,
        );
        const codexOutputPath = path.join(
          logDir(slug),
          `phase-${phaseN}-dual-codex-${it}-output.md`,
        );

        fs.writeFileSync(geminiInputPath, implPromptBody);
        fs.writeFileSync(geminiOutputPath, "");
        fs.writeFileSync(codexInputPath, codexPromptBody);
        fs.writeFileSync(codexOutputPath, "");

        // Run both in parallel — each model has its own recursive fix loop so it
        // arrives at the judge having already converged as far as it can.
        const dualTestCmd = args.testCmd ?? detectTestCmd(cwd);
        const [
          {
            implResult: gRes,
            testResult: gFinalTest,
            fixIterations: gFixIter,
            fixHistory: gFixHistory,
            testedCommit: gTestedCommit,
          },
          {
            implResult: cRes,
            testResult: cFinalTest,
            fixIterations: cFixIter,
            fixHistory: cFixHistory,
            testedCommit: cTestedCommit,
          },
        ] = await Promise.all([
          (async () => {
            const implResult = await runGemini({
              inputFilePath: geminiInputPath,
              outputFilePath: geminiOutputPath,
              cwd: pair.geminiWorktreePath,
              slug,
              phaseNumber: phaseN,
              iteration: it,
              logPrefix: "dual-gemini",
              model: args.geminiModel,
            });
            if (implResult.timedOut || implResult.exitCode !== 0) {
              const failTest: DualImplTestResult = {
                worktreePath: pair.geminiWorktreePath,
                testExitCode: 1,
                testLogPath: implResult.logPath,
                timedOut: implResult.timedOut,
              };
              return {
                implResult,
                testResult: failTest,
                fixIterations: null,
                fixHistory: "",
                testedCommit: undefined,
              };
            }
            const { testResult, fixIterations, fixHistory } =
              await runDualImplFixLoop({
                model: "gemini",
                worktreePath: pair.geminiWorktreePath,
                phase,
                planFile: state.planFile,
                branch: state.branch,
                slug,
                phaseNumber: phaseN,
                testCmd: dualTestCmd,
                maxFixIter: DEFAULT_MAX_TEST_ITERATIONS,
                geminiModel: args.geminiModel,
              });
            const gHeadR = spawnSync("git", ["-C", pair.geminiWorktreePath, "rev-parse", "HEAD"], { encoding: "utf8" });
            return { implResult, testResult, fixIterations, fixHistory, testedCommit: gHeadR.stdout.trim() || undefined };
          })(),
          (async () => {
            const implResult = await runCodexImpl({
              inputFilePath: codexInputPath,
              outputFilePath: codexOutputPath,
              cwd: pair.codexWorktreePath,
              slug,
              phaseNumber: phaseN,
              iteration: it,
              model: args.codexModel,
            });
            if (implResult.timedOut || implResult.exitCode !== 0) {
              const failTest: DualImplTestResult = {
                worktreePath: pair.codexWorktreePath,
                testExitCode: 1,
                testLogPath: implResult.logPath,
                timedOut: implResult.timedOut,
              };
              return {
                implResult,
                testResult: failTest,
                fixIterations: null,
                fixHistory: "",
                testedCommit: undefined,
              };
            }
            const { testResult, fixIterations, fixHistory } =
              await runDualImplFixLoop({
                model: "codex",
                worktreePath: pair.codexWorktreePath,
                phase,
                planFile: state.planFile,
                branch: state.branch,
                slug,
                phaseNumber: phaseN,
                testCmd: dualTestCmd,
                maxFixIter: DEFAULT_MAX_TEST_ITERATIONS,
                codexModel: args.codexModel,
              });
            const cHeadR = spawnSync("git", ["-C", pair.codexWorktreePath, "rev-parse", "HEAD"], { encoding: "utf8" });
            return { implResult, testResult, fixIterations, fixHistory, testedCommit: cHeadR.stdout.trim() || undefined };
          })(),
        ]);

        // Validate each implementor produced committed work — uncommitted edits
        // would pass tests but applyWinner would have nothing to cherry-pick.
        // (Phase 4 review, HIGH; refined Phase 5 /codex review P2.)
        const gCommits = countCommitsSinceBase(
          pair.geminiWorktreePath,
          pair.baseCommit,
        );
        const cCommits = countCommitsSinceBase(
          pair.codexWorktreePath,
          pair.baseCommit,
        );

        // null = git rev-list failed (worktree may be broken) — fail closed rather than
        // silently treating it as "0 commits" and auto-selecting the other side.
        if (gCommits === null || cCommits === null) {
          phaseState.status = "failed";
          phaseState.error = `Failed to count commits since base — cannot determine implementation eligibility (gemini=${gCommits}, codex=${cCommits})`;
          state.phases[phase.index] = phaseState;
          saveState(state, { noGbrain, log: console.warn });
          continue;
        }

        const gCommitted = gCommits > 0;
        const cCommitted = cCommits > 0;

        // Catastrophic = BOTH timed out, OR both exited non-zero, OR neither committed.
        // One-sided timeout is NOT catastrophic — if only one side timed out but the
        // other committed work, the auto-select logic below handles it (committed side wins).
        const bothTimedOut = gRes.timedOut && cRes.timedOut;
        const bothExitNonZero = gRes.exitCode !== 0 && cRes.exitCode !== 0;
        const neitherCommitted = !gCommitted && !cCommitted;

        if (bothTimedOut || bothExitNonZero || neitherCommitted) {
          phaseState.status = "failed";
          phaseState.error =
            `Dual implementation failed: ` +
            `gemini exit=${gRes.exitCode} timedOut=${gRes.timedOut} commits=${gCommits}; ` +
            `codex exit=${cRes.exitCode} timedOut=${cRes.timedOut} commits=${cCommits}`;
          state.phases[phase.index] = phaseState;
          saveState(state, { noGbrain, log: console.warn });
          // dualImplOk stays false → finally block will tear down.
          continue;
        }

        // Synthetic success result for applyResult's exit-code check.
        const synthetic = mockResult({
          exitCode: 0,
          stdout: `gemini ok (${gCommits} commits, ${gFixIter} fix iter)\ncodex ok (${cCommits} commits, ${cFixIter} fix iter)`,
          logPath: gRes.logPath,
        });
        phaseState = applyResult(phaseState, action, synthetic, {
          dualImplInit: {
            ...dualState,
            geminiTestResult: gFinalTest,
            codexTestResult: cFinalTest,
            geminiFixIterations: gFixIter,
            codexFixIterations: cFixIter,
            geminiFixHistory: gFixHistory,
            codexFixHistory: cFixHistory,
            geminiTestedCommit: gTestedCommit,
            codexTestedCommit: cTestedCommit,
          },
        });

        // /codex review P2 — if exactly one side committed, the other is ineligible
        // (tests would pass on uncommitted edits but applyWinner can't cherry-pick).
        // Skip RUN_DUAL_TESTS + RUN_JUDGE_OPUS entirely; auto-select the committed side.
        if (gCommitted && !cCommitted) {
          if (gFinalTest.testExitCode !== 0) {
            phaseState.status = "failed";
            phaseState.error = `Gemini auto-selected (codex=0 commits) but tests are failing (exit=${gFinalTest.testExitCode}) — worktrees will be torn down; re-run gstack-build to retry this phase`;
            state.phases[phase.index] = phaseState;
            saveState(state, { noGbrain, log: console.warn });
            continue;
          }
          console.log(
            `  ⚠ Codex did not commit (gemini=${gCommits} commits, codex=0) — auto-selecting gemini, skipping tests + judge`,
          );
          phaseState.dualImpl = {
            ...(phaseState.dualImpl as any),
            selectedImplementor: "gemini",
            selectedBy: "auto",
          };
          phaseState.status = "dual_winner_pending";
        } else if (!gCommitted && cCommitted) {
          if (cFinalTest.testExitCode !== 0) {
            phaseState.status = "failed";
            phaseState.error = `Codex auto-selected (gemini=0 commits) but tests are failing (exit=${cFinalTest.testExitCode}) — worktrees will be torn down; re-run gstack-build to retry this phase`;
            state.phases[phase.index] = phaseState;
            saveState(state, { noGbrain, log: console.warn });
            continue;
          }
          console.log(
            `  ⚠ Gemini did not commit (gemini=0, codex=${cCommits} commits) — auto-selecting codex, skipping tests + judge`,
          );
          phaseState.dualImpl = {
            ...(phaseState.dualImpl as any),
            selectedImplementor: "codex",
            selectedBy: "auto",
          };
          phaseState.status = "dual_winner_pending";
        }
        // else: both committed — normal flow → dual_impl_done → RUN_DUAL_TESTS

        // Test hygiene: if one side was auto-selected (the other had 0 commits),
        // verify the winner's commits didn't weaken test files to pass artificially.
        if (phaseState.status === "dual_winner_pending" && phaseState.dualImpl?.selectedBy === "auto") {
          const winner = phaseState.dualImpl.selectedImplementor;
          const winnerPath = winner === "gemini" ? pair.geminiWorktreePath : pair.codexWorktreePath;
          const testDiff = spawnSync(
            "git", ["-C", winnerPath, "diff", pair.baseCommit, "--", "*.test.ts", "*.spec.ts", "*.test.js", "*.spec.js", "*/__tests__/**", "__tests__/**"],
            { encoding: "utf8" },
          );
          if (testDiff.status !== 0 || testDiff.stdout.trim()) {
            console.warn(
              `  ⚠ Auto-selected ${winner} modified test files — routing to judge instead of auto-selecting`,
            );
            phaseState.dualImpl = {
              ...(phaseState.dualImpl as any),
              selectedImplementor: undefined,
              selectedBy: undefined,
            };
            phaseState.status = "dual_judge_pending";
          }
        }

        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        dualImplOk = true; // suppress finally teardown; downstream phases own cleanup
      } catch (err) {
        const msg = `Dual implementation crashed unexpectedly: ${(err as Error).message}`;
        phaseState.status = "failed";
        phaseState.error = msg;
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
      } finally {
        if (!dualImplOk) {
          try {
            teardownWorktrees({ cwd, dualImpl: dualState });
          } catch (err) {
            console.warn(
              `  ⚠ worktree teardown raised: ${(err as Error).message}`,
            );
          }
        }
      }
      continue;
    }

    if (action.type === "RUN_DUAL_TESTS") {
      console.log(
        `  → Dual Tests: running tests on both worktrees in parallel`,
      );
      const dual = phaseState.dualImpl;
      if (!dual) {
        phaseState.status = "failed";
        phaseState.error =
          "RUN_DUAL_TESTS reached without dualImpl state — orchestrator bug";
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      let geminiTR: DualImplTestResult;
      let codexTR: DualImplTestResult;

      if (dryRun) {
        geminiTR = {
          worktreePath: dual.geminiWorktreePath,
          testExitCode: 0,
          testLogPath: "dryrun",
          timedOut: false,
          failureCount: 0,
        };
        codexTR = {
          worktreePath: dual.codexWorktreePath,
          testExitCode: 0,
          testLogPath: "dryrun",
          timedOut: false,
          failureCount: 0,
        };
      } else if (dual.geminiTestResult && dual.codexTestResult) {
        // Fix loops already ran during impl phase — validate worktree HEADs still match
        // the commit we tested (detect stale state on resume after a crash).
        const gHead = spawnSync("git", ["-C", dual.geminiWorktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        const cHead = spawnSync("git", ["-C", dual.codexWorktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        const gStale = !gHead || (dual.geminiTestedCommit && gHead !== dual.geminiTestedCommit);
        const cStale = !cHead || (dual.codexTestedCommit && cHead !== dual.codexTestedCommit);
        if (gStale || cStale) {
          console.warn(
            `  ⚠ Dual Tests: worktree HEAD changed since cached results (gemini: ${dual.geminiTestedCommit} → ${gHead}, codex: ${dual.codexTestedCommit} → ${cHead}) — re-running tests`,
          );
          // Re-run tests inline since cached results are stale.
          // Reuse the existing testCmd detection below.
          const testCmd = args.testCmd ?? detectTestCmd(cwd);
          if (!testCmd) {
            console.warn("  ⚠ no test command detected for dual-tests; assuming both green");
            geminiTR = { worktreePath: dual.geminiWorktreePath, testExitCode: 0, testLogPath: "no-test-cmd", timedOut: false, failureCount: 0 };
            codexTR  = { worktreePath: dual.codexWorktreePath,  testExitCode: 0, testLogPath: "no-test-cmd", timedOut: false, failureCount: 0 };
          } else {
            const [g2, c2] = await Promise.all([
              runTests({ testCmd, cwd: dual.geminiWorktreePath, slug: state.slug, phaseNumber: phase.number, iteration: 1, logSuffix: "gemini-rerun" }),
              runTests({ testCmd, cwd: dual.codexWorktreePath,  slug: state.slug, phaseNumber: phase.number, iteration: 1, logSuffix: "codex-rerun" }),
            ]);
            geminiTR = { worktreePath: dual.geminiWorktreePath, testExitCode: g2.exitCode, testLogPath: g2.logPath, timedOut: g2.timedOut, failureCount: parseFailureCount(g2.stdout + "\n" + g2.stderr) };
            codexTR  = { worktreePath: dual.codexWorktreePath,  testExitCode: c2.exitCode, testLogPath: c2.logPath, timedOut: c2.timedOut, failureCount: parseFailureCount(c2.stdout + "\n" + c2.stderr) };
          }
        } else {
          // SHAs match — cached results are still valid.
          console.log(
            `  → Dual Tests: reusing pre-computed results from fix loops (gemini fix iter=${dual.geminiFixIterations ?? "n/a"}, codex fix iter=${dual.codexFixIterations ?? "n/a"})`,
          );
          geminiTR = dual.geminiTestResult;
          codexTR = dual.codexTestResult;
        }
      } else {
        const testCmd = args.testCmd ?? detectTestCmd(cwd);
        if (!testCmd) {
          // No test cmd: assume both green so judge runs.
          console.warn(
            "  ⚠ no test command detected for dual-tests; assuming both green",
          );
          geminiTR = {
            worktreePath: dual.geminiWorktreePath,
            testExitCode: 0,
            testLogPath: "no-test-cmd",
            timedOut: false,
            failureCount: 0,
          };
          codexTR = {
            worktreePath: dual.codexWorktreePath,
            testExitCode: 0,
            testLogPath: "no-test-cmd",
            timedOut: false,
            failureCount: 0,
          };
        } else {
          const [g, c] = await Promise.all([
            runTests({
              testCmd,
              cwd: dual.geminiWorktreePath,
              slug: state.slug,
              phaseNumber: phase.number,
              iteration: 1,
              logSuffix: "gemini",
            }),
            runTests({
              testCmd,
              cwd: dual.codexWorktreePath,
              slug: state.slug,
              phaseNumber: phase.number,
              iteration: 1,
              logSuffix: "codex",
            }),
          ]);
          geminiTR = {
            worktreePath: dual.geminiWorktreePath,
            testExitCode: g.exitCode,
            testLogPath: g.logPath,
            timedOut: g.timedOut,
            failureCount: parseFailureCount(g.stdout + "\n" + g.stderr),
          };
          codexTR = {
            worktreePath: dual.codexWorktreePath,
            testExitCode: c.exitCode,
            testLogPath: c.logPath,
            timedOut: c.timedOut,
            failureCount: parseFailureCount(c.stdout + "\n" + c.stderr),
          };
        }
      }

      const synthetic = mockResult({
        exitCode: 0,
        stdout: `g=${geminiTR.testExitCode} c=${codexTR.testExitCode}`,
      });
      phaseState = applyResult(phaseState, action, synthetic, {
        geminiTestResult: geminiTR,
        codexTestResult: codexTR,
      });

      // Test hygiene: if applyResult auto-selected a winner based on test outcome alone,
      // verify it didn't weaken test files (skip/delete assertions) to pass.
      if (
        !dryRun &&
        phaseState.status === "dual_winner_pending" &&
        phaseState.dualImpl?.selectedBy === "auto" &&
        phaseState.dualImpl?.selectedImplementor &&
        phaseState.dualImpl?.baseCommit
      ) {
        const winner = phaseState.dualImpl.selectedImplementor;
        const winnerPath = winner === "gemini" ? dual.geminiWorktreePath : dual.codexWorktreePath;
        const testDiff = spawnSync(
          "git", ["-C", winnerPath, "diff", phaseState.dualImpl.baseCommit, "--", "*.test.ts", "*.spec.ts", "*.test.js", "*.spec.js", "*/__tests__/**", "__tests__/**"],
          { encoding: "utf8" },
        );
        if (testDiff.status !== 0 || testDiff.stdout.trim()) {
          console.warn(
            `  ⚠ Auto-selected ${winner} modified test files — routing to judge instead of auto-selecting`,
          );
          phaseState.dualImpl = {
            ...(phaseState.dualImpl as any),
            selectedImplementor: undefined,
            selectedBy: undefined,
          };
          phaseState.status = "dual_judge_pending";
        }
      }

      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });

      // Tear down worktrees on hard failure (both timed out, or both fail with
      // no parseable failure count). These phases have no recovery value —
      // there is no winner to cherry-pick, so preserving worktrees only wastes disk.
      if (phaseState.status === "failed" && phaseState.dualImpl) {
        try {
          if (!dryRun)
            teardownWorktrees({ cwd, dualImpl: phaseState.dualImpl });
        } catch (err) {
          console.warn(
            `  ⚠ worktree teardown raised: ${(err as Error).message}`,
          );
        }
      }
      continue;
    }

    if (action.type === "RUN_JUDGE_OPUS") {
      console.log(`  → Judge Opus: deciding between Gemini and Codex`);
      const dual = phaseState.dualImpl;
      if (!dual || !dual.geminiTestResult || !dual.codexTestResult) {
        // Corrupted state — tear down worktrees if we have enough info.
        if (dual && !dryRun) {
          try {
            teardownWorktrees({ cwd, dualImpl: dual });
          } catch {}
        }
        phaseState.status = "failed";
        phaseState.error =
          "RUN_JUDGE_OPUS reached without dual test results — orchestrator bug";
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      let verdict: "gemini" | "codex" | null;
      let reasoning = "";
      let hardeningNotes = "";
      let logPath = "dryrun";

      if (dryRun) {
        verdict = "gemini";
        reasoning = "[dry-run] judge would pick gemini";
        hardeningNotes = "";
      } else {
        const geminiDiff = readWorktreeDiff(
          dual.geminiWorktreePath,
          dual.baseCommit,
        );
        const codexDiff = readWorktreeDiff(
          dual.codexWorktreePath,
          dual.baseCommit,
        );

        // Fail-closed if either diff couldn't be read — judge would see empty
        // evidence and pick arbitrarily. (Phase 4 review, HIGH.)
        if (geminiDiff === null || codexDiff === null) {
          teardownWorktrees({ cwd, dualImpl: dual });
          phaseState.status = "failed";
          phaseState.error =
            `Failed to read worktree diff before judge: ` +
            `gemini=${geminiDiff === null ? "failed" : "ok"}, ` +
            `codex=${codexDiff === null ? "failed" : "ok"}`;
          state.phases[phase.index] = phaseState;
          saveState(state, { noGbrain, log: console.warn });
          continue;
        }

        const inputPath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-judge-input.md`,
        );
        const outputPath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-judge-output.md`,
        );
        fs.writeFileSync(
          inputPath,
          buildJudgePrompt({
            phase,
            geminiDiff,
            codexDiff,
            geminiTestResult: dual.geminiTestResult,
            codexTestResult: dual.codexTestResult,
            geminiFixIterations: dual.geminiFixIterations,
            codexFixIterations: dual.codexFixIterations,
            geminiFixHistory: dual.geminiFixHistory,
            codexFixHistory: dual.codexFixHistory,
          }),
        );
        fs.writeFileSync(outputPath, "");

        const judgeRes = await runJudgeOpus({
          inputFilePath: inputPath,
          outputFilePath: outputPath,
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
        });
        logPath = judgeRes.logPath;
        const parsed = parseJudgeVerdict(judgeRes.stdout);
        verdict = parsed.verdict;
        reasoning = parsed.reasoning;
        hardeningNotes = parsed.hardeningNotes;

        if (judgeRes.timedOut || judgeRes.exitCode !== 0) {
          // Tear down worktrees and fail closed.
          teardownWorktrees({ cwd, dualImpl: dual });
          phaseState.status = "failed";
          phaseState.error = `Judge Opus failed: exit=${judgeRes.exitCode} timedOut=${judgeRes.timedOut}`;
          state.phases[phase.index] = phaseState;
          saveState(state, { noGbrain, log: console.warn });
          continue;
        }
      }

      if (verdict === null) {
        // Malformed judge output — fail closed (Phase 3 review).
        teardownWorktrees({ cwd, dualImpl: dual });
        phaseState.status = "failed";
        phaseState.error = `Judge Opus output was malformed (no anchored WINNER line); reasoning: ${reasoning}`;
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      const synthetic = mockResult({
        exitCode: 0,
        stdout: `WINNER: ${verdict}`,
        logPath,
      });
      phaseState = applyResult(phaseState, action, synthetic, {
        judgeVerdict: verdict,
        judgeReasoning: reasoning,
        judgeHardeningNotes: hardeningNotes,
      });
      // Test hygiene gate (judge path): fail closed if winner modified test files.
      // Same gate as auto-select path — judge can't catch test-weakening the same way.
      if (!dryRun) {
        const winnerPath = verdict === "gemini" ? dual.geminiWorktreePath : dual.codexWorktreePath;
        const hygieneDiff = spawnSync(
          "git",
          ["-C", winnerPath, "diff", dual.baseCommit, "--", "*.test.ts", "*.spec.ts", "*.test.js", "*.spec.js", "*/__tests__/**", "__tests__/**"],
          { encoding: "utf8" },
        );
        if (hygieneDiff.status !== 0 || hygieneDiff.stdout.trim()) {
          console.warn(`  ⚠ Judge-selected ${verdict} modified test files — failing closed (test hygiene)`);
          teardownWorktrees({ cwd, dualImpl: dual });
          phaseState.status = "failed";
          phaseState.error = `Judge-selected ${verdict} modified test assertions — potential test-weakening; phase requires manual review`;
          state.phases[phase.index] = phaseState;
          saveState(state, { noGbrain, log: console.warn });
          continue;
        }
      }
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === "APPLY_WINNER") {
      console.log(
        `  → Apply Winner: ${action.winner} (cherry-picking onto main cwd)`,
      );
      const dual = phaseState.dualImpl;
      if (!dual) {
        phaseState.status = "failed";
        phaseState.error =
          "APPLY_WINNER reached without dualImpl state — orchestrator bug";
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      let applyOk = true;
      let applyError: string | undefined;

      if (!dryRun) {
        const r = applyWinner({ cwd, winner: action.winner, dualImpl: dual });
        applyOk = r.ok;
        applyError = r.error;
      }

      if (!applyOk) {
        // PRESERVE worktrees on apply failure — they hold the only copy of the
        // winner's code. Surface paths/branches so the user can inspect, manually
        // recover, or replay. (Phase 4 review, MEDIUM: don't destroy recovery
        // artifact.)
        phaseState.status = "failed";
        phaseState.error =
          `applyWinner(${action.winner}) failed: ${applyError ?? "unknown"}\n` +
          `  Worktrees PRESERVED for recovery:\n` +
          `    gemini: ${dual.geminiWorktreePath} (branch ${dual.geminiBranch})\n` +
          `    codex:  ${dual.codexWorktreePath} (branch ${dual.codexBranch})\n` +
          `  Inspect, fix, then re-run. Manual cleanup when done:\n` +
          `    git worktree remove --force ${dual.geminiWorktreePath} && git branch -D ${dual.geminiBranch}\n` +
          `    git worktree remove --force ${dual.codexWorktreePath} && git branch -D ${dual.codexBranch}`;
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      // Apply succeeded — NOW we can safely tear down both worktrees.
      try {
        if (!dryRun) teardownWorktrees({ cwd, dualImpl: dual });
      } catch (err) {
        console.warn(`  ⚠ worktree teardown raised: ${(err as Error).message}`);
      }

      const synthetic = mockResult({
        exitCode: 0,
        stdout: `applied ${action.winner}`,
      });
      phaseState = applyResult(phaseState, action, synthetic);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    // Exhaustive switch — should never reach here.
    const _never: never = action;
    void _never;
    return "failed";
  }
}

function mockResult(overrides: Partial<SubAgentResult>): SubAgentResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    logPath: "/dev/null",
    durationMs: 0,
    retries: 0,
    ...overrides,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.codexModel !== "gpt-5.3-codex-spark" && !args.dualImpl) {
    console.warn(
      "[warn] --codex-model has no effect without --dual-impl (Codex implementor only runs in tournament mode)",
    );
  }

  if (!fs.existsSync(args.planFile)) {
    console.error(`plan file not found: ${args.planFile}`);
    process.exit(2);
  }

  const content = fs.readFileSync(args.planFile, "utf8");
  const { phases, warnings } = parsePlan(content, { dualImpl: args.dualImpl });

  console.log(`Plan: ${args.planFile}`);
  console.log(`Phases parsed: ${phases.length}`);
  console.log("");
  printPhaseTable(phases);

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (args.printOnly) {
    process.exit(0);
  }

  if (phases.length === 0) {
    console.error("\nno executable phases found; nothing to do");
    process.exit(2);
  }

  // Plan files in a plans/ subdirectory sit one level below the project root.
  const resolvedPlan = path.resolve(args.planFile);
  const cwdForPreflight =
    path.basename(path.dirname(resolvedPlan)) === "plans"
      ? path.resolve(path.dirname(resolvedPlan), "..")
      : path.dirname(resolvedPlan);

  // Skip both startup gates when running in simulation mode or skipping ship.
  const runStartupGates = !args.dryRun && !args.skipShip;

  if (!args.skipCleanCheck && runStartupGates) {
    const { clean, dirty } = checkWorkingTreeClean(cwdForPreflight);
    if (!clean) {
      console.error(
        "\n✗ working tree has uncommitted changes — commit or stash before building:\n",
      );
      for (const f of dirty) console.error(`  ${f}`);
      console.error("\n  (use --skip-clean-check to bypass)\n");
      process.exit(1);
    }
  }

  const slug = deriveSlug(args.planFile);

  // Sweep runs before the lock so that sibling unshipped branches are processed
  // regardless of whether this slug is already locked. Concurrent gstack-build
  // invocations are rare in practice; warn-and-continue handles sweep failures.
  const currentBranchForSweep = getCurrentBranch(cwdForPreflight);
  if (!args.skipSweep && runStartupGates) {
    await sweepUnshippedFeatBranches(
      cwdForPreflight,
      currentBranchForSweep,
      slug,
    );
  }

  // Lock contention check.
  if (!acquireLock(slug)) {
    const info = readLockInfo(slug);
    console.error(
      `\nanother gstack-build instance is running for "${slug}".\n` +
        `lock info:\n${info}\n` +
        `if stale, remove ~/.gstack/build-state/${slug}.lock and retry.`,
    );
    process.exit(3);
  }

  ensureLogDir(slug);

  // Load or create state. --no-resume forces a fresh start.
  let state: BuildState;
  if (args.noResume) {
    state = freshState({
      planFile: args.planFile,
      branch: getCurrentBranch(cwdForPreflight),
      phases,
      geminiModel: args.geminiModel,
      codexModel: args.codexModel,
      codexReviewModel: args.codexReviewModel,
    });
    saveState(state, { noGbrain: args.noGbrain, log: console.warn });
  } else {
    const loaded = loadState(slug, {
      noGbrain: args.noGbrain,
      log: console.warn,
    });
    if (loaded) {
      console.log(`\nresuming state from ${loaded.lastUpdatedAt}`);
      state = loaded;
      // Warn if CLI models differ from what the original run used.
      // After warning, update state to reflect CLI values so future saveState is accurate.
      let modelMismatch = false;
      if (loaded.geminiModel && loaded.geminiModel !== args.geminiModel) {
        console.warn(
          `[warn] --gemini-model ${args.geminiModel} differs from resumed state (${loaded.geminiModel}); using CLI value`,
        );
        modelMismatch = true;
      } else if (
        !loaded.geminiModel &&
        args.geminiModel !== "gemini-3.1-pro-preview"
      ) {
        console.warn(
          `[warn] --gemini-model ${args.geminiModel} may differ from original run (state predates model tracking)`,
        );
        modelMismatch = true;
      }
      if (loaded.codexModel && loaded.codexModel !== args.codexModel) {
        console.warn(
          `[warn] --codex-model ${args.codexModel} differs from resumed state (${loaded.codexModel}); using CLI value`,
        );
        modelMismatch = true;
      } else if (
        !loaded.codexModel &&
        args.codexModel !== "gpt-5.3-codex-spark"
      ) {
        console.warn(
          `[warn] --codex-model ${args.codexModel} may differ from original run (state predates model tracking)`,
        );
        modelMismatch = true;
      }
      if (
        loaded.codexReviewModel &&
        loaded.codexReviewModel !== args.codexReviewModel
      ) {
        console.warn(
          `[warn] --codex-review-model ${args.codexReviewModel} differs from resumed state (${loaded.codexReviewModel}); using CLI value`,
        );
        modelMismatch = true;
      } else if (
        !loaded.codexReviewModel &&
        args.codexReviewModel !== "gpt-5.5"
      ) {
        console.warn(
          `[warn] --codex-review-model ${args.codexReviewModel} may differ from original run (state predates model tracking)`,
        );
        modelMismatch = true;
      }
      if (modelMismatch) {
        // Update state fields so subsequent saveState persists the CLI values, not stale ones.
        state.geminiModel = args.geminiModel;
        state.codexModel = args.codexModel;
        state.codexReviewModel = args.codexReviewModel;
      }
    } else {
      state = freshState({
        planFile: args.planFile,
        branch: getCurrentBranch(cwdForPreflight),
        phases,
        geminiModel: args.geminiModel,
        codexModel: args.codexModel,
        codexReviewModel: args.codexReviewModel,
      });
      saveState(state, { noGbrain: args.noGbrain, log: console.warn });
    }
  }

  // SIGINT — release lock, save state, exit 130.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    console.error("\n[interrupted] saving state and releasing lock...");
    try {
      saveState(state, { noGbrain: args.noGbrain });
    } catch {
      // ignore
    }
    releaseLock(slug);
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const startedAt = Date.now();
  logActivity({
    event: "start",
    slug,
    plan: args.planFile,
    dryRun: args.dryRun,
  });

  // Drive the loop.
  const cwd = path.dirname(args.planFile).includes("plans")
    ? path.resolve(path.dirname(args.planFile), "..")
    : path.dirname(args.planFile);

  let exitCode = 0;
  try {
    while (true) {
      const idx = findNextPhaseIndex(state.phases);
      if (idx === -1) break;
      const phase = phases[idx];
      summarizePhase(phase.number, phase.name, "▶");

      const outcome = await runPhase({
        state,
        phase,
        nextPhaseName: phases[idx + 1]?.name ?? null,
        cwd,
        noGbrain: args.noGbrain,
        dryRun: args.dryRun,
        maxCodexIter: args.maxCodexIter,
        testCmd: args.testCmd,
        geminiModel: args.geminiModel,
        codexModel: args.codexModel,
        codexReviewModel: args.codexReviewModel,
      });

      if (outcome === "failed") {
        exitCode = 1;
        break;
      }
    }

    if (exitCode === 0 && !args.skipShip && !args.dryRun) {
      console.log(
        "\n▶ All phases committed. Running /ship + /land-and-deploy.",
      );
      const result = await shipAndDeploy({ cwd, slug });
      if (result.exitCode !== 0 || result.timedOut) {
        console.error(
          `✗ ship failed (exit ${result.exitCode}, timed_out=${result.timedOut}); see ${result.logPath}`,
        );
        exitCode = 1;
      } else {
        console.log(`  ✓ shipped (${(result.durationMs / 1000).toFixed(0)}s)`);
        const { ok, report } = await verifyPostShip(cwd, state.branch);
        const w = 58;
        console.log(`\n${"╔" + "═".repeat(w - 2) + "╗"}`);
        console.log(
          `║  WEEK/GROUP COMPLETE — EXECUTION REPORT${" ".repeat(w - 42)}║`,
        );
        console.log(`${"╠" + "═".repeat(w - 2) + "╣"}`);
        for (const l of report) console.log(`║${l.padEnd(w - 2)}║`);
        console.log(`${"╚" + "═".repeat(w - 2) + "╝"}\n`);
        if (!ok) {
          console.error("✗ post-ship guardrail failed — see issues above");
          exitCode = 1;
        } else {
          // Only mark completed after guardrails pass — keeps state/exit-code in agreement
          state.completed = true;
          saveState(state, { noGbrain: args.noGbrain, log: console.warn });
        }
      }
    } else if (exitCode === 0 && (args.skipShip || args.dryRun)) {
      state.completed = !args.dryRun;
      saveState(state, { noGbrain: args.noGbrain, log: console.warn });
      console.log(
        `\n${args.dryRun ? "(dry-run) " : ""}all phases done${args.skipShip ? " (ship skipped)" : ""}`,
      );
    }
  } finally {
    releaseLock(slug);
    logActivity({
      event: exitCode === 0 ? "success" : "failed",
      slug,
      durationMs: Date.now() - startedAt,
      exitCode,
    });
  }

  process.exit(exitCode);
}

export function checkWorkingTreeClean(cwd: string): {
  clean: boolean;
  dirty: string[];
} {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    const msg = (r.stderr || "").trim() || "git status failed";
    return { clean: false, dirty: [`<git error: ${msg}>`] };
  }
  const lines = (r.stdout || "").split("\n").filter(Boolean);
  const dirty = lines.filter((l: string) => !l.startsWith("??"));
  return { clean: dirty.length === 0, dirty };
}

export function findUnshippedFeatBranches(
  cwd: string,
  currentBranch: string,
): string[] {
  const fetchR = spawnSync("git", ["fetch", "--prune", "origin"], {
    cwd,
    encoding: "utf8",
  });
  if (fetchR.status !== 0) {
    console.warn(
      `  ⚠ git fetch failed (exit ${fetchR.status}) — branch list may be stale`,
    );
  }
  // Assumes origin/main is the default branch. If your repo uses master or another
  // default, pass --skip-sweep and handle the sweep manually.
  const r = spawnSync(
    "git",
    ["branch", "-r", "--no-merged", "origin/main", "--list", "origin/feat/*"],
    { cwd, encoding: "utf8" },
  );
  return (r.stdout || "")
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.startsWith("origin/feat/"))
    .map((l: string) => l.replace(/^origin\//, ""))
    .filter((b: string) => b !== currentBranch);
}

async function sweepUnshippedFeatBranches(
  cwd: string,
  currentBranch: string,
  slug: string,
): Promise<void> {
  const MAX_SWEEP_BRANCHES = 3;
  const allBranches = findUnshippedFeatBranches(cwd, currentBranch);
  if (allBranches.length === 0) return;

  const branches = allBranches.slice(0, MAX_SWEEP_BRANCHES);
  if (allBranches.length > MAX_SWEEP_BRANCHES) {
    console.warn(
      `\n  ⚠ ${allBranches.length} unshipped feat/* branches found — capping sweep at ${MAX_SWEEP_BRANCHES}. Use --skip-sweep to skip entirely.`,
    );
  }

  console.log(`\n▶ Unshipped feat/* branches: ${branches.join(", ")}`);
  try {
    for (const branch of branches) {
      console.log(
        `\n  ↳ checking out ${branch} and running /ship + /land-and-deploy...`,
      );
      const co = spawnSync(
        "git",
        ["checkout", "-B", branch, `origin/${branch}`],
        { cwd, encoding: "utf8" },
      );
      if (co.status !== 0) {
        console.warn(
          `  ⚠ checkout failed for ${branch} (exit ${co.status}) — skipping`,
        );
        continue;
      }
      const result = await shipAndDeploy({
        cwd,
        slug: `${slug}-sweep-${branch.replace(/[^a-z0-9-]/g, "-")}`,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        console.warn(
          `  ⚠ ship failed for ${branch} (exit ${result.exitCode}) — continuing`,
        );
      } else {
        console.log(`  ✓ shipped ${branch}`);
      }
    }
  } finally {
    // Always restore unconditionally — shipAndDeploy may leave the tree on a
    // different branch if it crashes mid-checkout, making getCurrentBranch unreliable.
    const restore = spawnSync("git", ["checkout", currentBranch], {
      cwd,
      encoding: "utf8",
    });
    if (restore.status !== 0) {
      console.warn(
        `  ⚠ could not restore branch: ${currentBranch} — you may be on a different branch`,
      );
    }
  }
}

function getCurrentBranch(cwd?: string): string {
  try {
    const result = spawnSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      ...(cwd ? { cwd } : {}),
    });
    return result.stdout?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
