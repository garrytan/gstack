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

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePlan, isPhaseComplete } from './parser';
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
} from './state';
import {
  decideNextAction,
  applyResult,
  markCommitted,
  findNextPhaseIndex,
  DEFAULT_MAX_CODEX_ITERATIONS,
  DEFAULT_MAX_TEST_ITERATIONS,
  type Action,
} from './phase-runner';
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
} from './sub-agents';
import { flipPhaseCheckboxes, flipTestSpecCheckbox } from './plan-mutator';
import { shipAndDeploy } from './ship';
import {
  createWorktrees,
  applyWinner,
  teardownWorktrees,
} from './worktree';
import type { BuildState, Phase, DualImplTestResult } from './types';

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
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    planFile: '',
    printOnly: false,
    dryRun: false,
    noResume: false,
    noGbrain: false,
    skipShip: false,
    maxCodexIter: DEFAULT_MAX_CODEX_ITERATIONS,
    dualImpl: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print-only') args.printOnly = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-resume' || a === '--restart') args.noResume = true;
    else if (a === '--no-gbrain') args.noGbrain = true;
    else if (a === '--skip-ship') args.skipShip = true;
    else if (a === '--dual-impl') args.dualImpl = true;
    else if (a === '--test-cmd') {
      const next = argv[++i];
      if (!next) { console.error('--test-cmd requires a value'); process.exit(2); }
      args.testCmd = next;
    } else if (a === '--max-codex-iter') {
      const next = argv[++i];
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`--max-codex-iter expects a positive integer, got: ${next}`);
        process.exit(2);
      }
      args.maxCodexIter = n;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    console.error('usage: gstack-build <plan-file> [flags]   (-h for help)');
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
  --dual-impl          Tournament mode: Gemini and Codex implement in parallel
                       (isolated git worktrees), Opus judges and the winner
                       is cherry-picked back. Existing TDD pipeline runs after.
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
    console.log('(no phases parsed)');
    return;
  }
  const numWidth = Math.max(5, ...phases.map((p) => p.number.length));
  const nameWidth = Math.max(20, ...phases.map((p) => p.name.length));

  console.log(`  ${'Phase'.padEnd(numWidth)}  ${'Name'.padEnd(nameWidth)}  Impl  Review  Status`);
  console.log('  ' + '-'.repeat(numWidth + nameWidth + 28));

  for (const p of phases) {
    const impl = p.implementationDone ? ' ✓ ' : ' · ';
    const rev = p.reviewDone ? ' ✓  ' : ' ·  ';
    let status: string;
    if (isPhaseComplete(p)) status = 'done';
    else if (p.implementationDone || p.reviewDone) status = 'partial';
    else status = 'pending';
    console.log(`  ${p.number.padEnd(numWidth)}  ${p.name.padEnd(nameWidth)}  ${impl}   ${rev} ${status}`);
  }
}

function logActivity(event: Record<string, any>) {
  const dir = path.join(os.homedir(), '.gstack', 'analytics');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  try {
    fs.appendFileSync(path.join(dir, 'build-runs.jsonl'), line);
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
function buildGeminiPromptBody(phase: Phase, planFile: string, branch: string): string {
  return [
    `# Phase ${phase.number}: ${phase.name}`,
    '',
    `Branch: ${branch}`,
    `Plan file: ${planFile}`,
    '',
    '## Phase description (verbatim from the plan)',
    '',
    phase.body.trim(),
    '',
    '## Instructions',
    '',
    `1. Make all failing tests pass with minimal correct code. Do NOT change test assertions.\n2. If there are no existing failing tests, implement the work described above.`,
    `3. If the project uses GitHub Actions, ensure your changes pass them.`,
    `4. Commit your changes to the current branch with a clear conventional-commit message.`,
    `5. Do NOT run /review, /qa, /ship, or any orchestration skill — those are downstream of you.`,
    `6. Do NOT update the plan file's checkboxes — the orchestrator handles that.`,
    `7. Fail forward: if a test fails, fix it before returning. Only return when the code is done and committed.`,
    `8. Reference existing code by file path — your --yolo file tools work, you don't need code inlined.`,
    '',
    '## Output format',
    '',
    'Write a short markdown summary to the output file (path provided to you in the shell prompt). Include:',
    '- Files changed (list of paths with one-line description each)',
    '- Tests run (which test files, pass/fail count)',
    '- Commit SHA (the conventional-commit message and commit hash)',
    '- Anything surprising or worth flagging to the orchestrator',
  ].join('\n');
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
  geminiOutputPath: string | null
): string {
  return [
    `# Codex Review — Phase ${phase.number}: ${phase.name} (iter ${iteration})`,
    '',
    `Branch: ${branch}`,
    `Plan file: ${planFile}`,
    geminiOutputPath ? `Gemini's implementation summary: ${geminiOutputPath}` : '',
    '',
    '## Phase description (what was supposed to be built)',
    '',
    phase.body.trim(),
    '',
    '## Your task',
    '',
    `1. Run /gstack-review on the current branch's working tree against its base.`,
    `2. If iteration > 1, this is a re-review after Codex tried to fix earlier findings — be especially thorough.`,
    `3. Use --yolo / workspace-write file tools to inspect the actual code; don't ask the orchestrator to inline anything.`,
    `4. Fix bugs as you find them (workspace-write sandbox is enabled).`,
    `5. Write your full review report to the output file path (provided in the shell prompt).`,
    `6. The output file MUST end with a single line: \`GATE PASS\` if no remaining issues, or \`GATE FAIL\` with a list of remaining issues.`,
  ]
    .filter(Boolean)
    .join('\n');
}


export function buildGeminiTestSpecPrompt(phase: Phase, planFile: string): string {
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
    `5. Write your output summary to the output file path (provided in shell prompt).`
  ].join('\n');
}

export function buildCodexImplPromptBody(phase: Phase, planFile: string): string {
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
  ].join('\n');
}

export function buildJudgePrompt(opts: {
  phase: Phase;
  geminiDiff: string;
  codexDiff: string;
  geminiTestResult: DualImplTestResult;
  codexTestResult: DualImplTestResult;
}): string {
  const { phase, geminiDiff, codexDiff, geminiTestResult, codexTestResult } = opts;
  const trim = (s: string, max = 5000) =>
    s.length <= max ? s : s.slice(0, max) + `\n\n[...truncated ${s.length - max} bytes]`;

  const fmtTest = (r: DualImplTestResult) =>
    `Exit code: ${r.testExitCode === null ? 'killed' : r.testExitCode} | ` +
    `Failures: ${r.failureCount ?? 'unknown'}` +
    (r.timedOut ? ' | TIMED OUT' : '');

  return [
    `You are a code quality judge. Two implementations of the same task were produced`,
    `independently. Compare them and pick the better one.`,
    ``,
    `## Task: Phase ${phase.number} — ${phase.name}`,
    ``,
    phase.body.trim(),
    ``,
    `## Gemini implementation (diff from base)`,
    ``,
    '```diff',
    trim(geminiDiff),
    '```',
    ``,
    `## Gemini test result`,
    fmtTest(geminiTestResult),
    ``,
    `## Codex implementation (diff from base)`,
    ``,
    '```diff',
    trim(codexDiff),
    '```',
    ``,
    `## Codex test result`,
    fmtTest(codexTestResult),
    ``,
    `## Your verdict`,
    ``,
    `Pick the implementation that: (1) passes more tests, (2) is cleaner and more correct,`,
    `(3) introduces fewer unnecessary changes, (4) is easier to maintain.`,
    ``,
    `Respond EXACTLY in this format on its own lines:`,
    ``,
    `WINNER: gemini`,
    `REASONING: <one paragraph, concrete reasons>`,
    ``,
    `Replace 'gemini' with 'codex' if Codex wins. Use lowercase. The WINNER line must`,
    `be at the start of its line — do not embed it in prose.`,
  ].join('\n');
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
    `Write your output summary to the output file path (provided in shell prompt).`
  ].join('\n');
}

function summarizePhase(phaseNumber: string, phaseName: string, marker: string) {
  console.log(`\n[${marker}] Phase ${phaseNumber}: ${phaseName}`);
}

/**
 * Read `git diff baseCommit..HEAD` from a worktree.
 * Returns null on git failure — caller MUST fail-closed (Phase 4 review HIGH:
 * silent empty diff would let the judge see no evidence and pick arbitrarily).
 */
function readWorktreeDiff(worktreePath: string, baseCommit: string): string | null {
  const r = spawnSync('git', ['diff', `${baseCommit}..HEAD`], {
    cwd: worktreePath,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout || '';
}

/** Count commits in a worktree since base. Returns null on git failure. */
function countCommitsSinceBase(worktreePath: string, baseCommit: string): number | null {
  const r = spawnSync('git', ['rev-list', '--count', `${baseCommit}..HEAD`], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const n = Number((r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

async function runPhase(args: {
  state: BuildState;
  phase: Phase;
  cwd: string;
  noGbrain: boolean;
  dryRun: boolean;
  maxCodexIter: number;
  testCmd?: string;
}): Promise<'done' | 'failed'> {
  const { state, phase, cwd, noGbrain, dryRun, maxCodexIter } = args;
  let phaseState = state.phases[phase.index];

  while (true) {
    const action: Action = decideNextAction(phaseState, maxCodexIter, phase, DEFAULT_MAX_TEST_ITERATIONS);

    if (action.type === 'DONE') return 'done';
    if (action.type === 'FAIL') {
      state.failedAtPhase = phase.index;
      state.failureReason = action.reason;
      saveState(state, { noGbrain, log: console.warn });
      console.error(`✗ Phase ${phase.number} (${phase.name}) failed: ${action.reason}`);
      return 'failed';
    }

    if (action.type === 'MARK_COMPLETE') {
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
            return 'failed';
          }
        }
        const flips = flipPhaseCheckboxes({
          planFile: state.planFile,
          implementationLine: phase.implementationCheckboxLine,
          reviewLine: phase.reviewCheckboxLine,
        });
        if (flips.implementation.error || flips.review.error) {
          state.failedAtPhase = phase.index;
          state.failureReason = `plan checkbox flip failed: impl=${flips.implementation.error || 'ok'}; review=${flips.review.error || 'ok'}`;
          saveState(state, { noGbrain, log: console.warn });
          console.error(`✗ Phase ${phase.number}: ${state.failureReason}`);
          return 'failed';
        }
      }
      phaseState = markCommitted(phaseState);
      state.phases[phase.index] = phaseState;
      state.currentPhaseIndex = phase.index + 1;
      saveState(state, { noGbrain, log: console.warn });
      console.log(`  ✓ Phase ${phase.number} committed`);
      return 'done';
    }

    if (action.type === 'RUN_GEMINI') {
      console.log(`  → Gemini: implementing Phase ${phase.number} (iter ${action.iteration})`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({ exitCode: 0, stdout: '[dry-run] Gemini would have implemented' });
      } else {
        // File-path I/O: write input prompt to disk, pass paths to runGemini.
        const inputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-${action.iteration}-input.md`
        );
        const outputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-${action.iteration}-output.md`
        );
        fs.writeFileSync(inputFilePath, buildGeminiPromptBody(phase, state.planFile, state.branch));
        // Pre-create empty output file so a missing-file error is unambiguous.
        fs.writeFileSync(outputFilePath, '');
        result = await runGemini({
          inputFilePath,
          outputFilePath,
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
          iteration: action.iteration,
        });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === 'RUN_CODEX_REVIEW') {
      console.log(`  → Codex review iter ${action.iteration}`);
      let result: SubAgentResult;
      if (dryRun) {
        // For dry-run, simulate a single GATE PASS so we walk through
        // the happy path without infinite loops.
        result = mockResult({ exitCode: 0, stdout: '[dry-run] Codex would review. GATE PASS' });
      } else {
        const inputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-codex-${action.iteration}-input.md`
        );
        const outputFilePath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-codex-${action.iteration}-output.md`
        );
        // Locate Gemini's output from this iteration so Codex can read it.
        const geminiOutputPath = path.join(
          logDir(state.slug),
          `phase-${phase.number}-gemini-${action.iteration}-output.md`
        );
        const geminiOutputExists = fs.existsSync(geminiOutputPath);
        fs.writeFileSync(
          inputFilePath,
          buildCodexReviewBody(
            phase,
            state.planFile,
            state.branch,
            action.iteration,
            geminiOutputExists ? geminiOutputPath : null
          )
        );
        fs.writeFileSync(outputFilePath, '');
        result = await runCodexReview({
          inputFilePath,
          outputFilePath,
          cwd,
          slug: state.slug,
          phaseNumber: phase.number,
          iteration: action.iteration,
        });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === 'RUN_GEMINI_TEST_SPEC') {
      console.log(`  → Test Specification: Phase ${phase.number} (iter ${action.iteration})`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({ exitCode: 0, stdout: '[dry-run] Gemini would write test spec' });
      } else {
        const inputFilePath = path.join(logDir(state.slug), `phase-${phase.number}-gemini-testspec-${action.iteration}-input.md`);
        const outputFilePath = path.join(logDir(state.slug), `phase-${phase.number}-gemini-testspec-${action.iteration}-output.md`);
        fs.writeFileSync(inputFilePath, buildGeminiTestSpecPrompt(phase, state.planFile));
        fs.writeFileSync(outputFilePath, '');
        result = await runGeminiTestSpec({ inputFilePath, outputFilePath, cwd, slug: state.slug, phaseNumber: phase.number, iteration: action.iteration });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === 'VERIFY_RED') {
      console.log(`  → Verify Red: running tests to confirm they fail`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({ exitCode: 1, stdout: '[dry-run] tests would fail (Red)' });
      } else {
        const testCmd = args.testCmd ?? detectTestCmd(cwd);
        if (!testCmd) {
          console.warn('  ⚠ no test command detected; assuming Red for VERIFY_RED');
          result = mockResult({ exitCode: 1, stdout: 'no test command detected; assuming Red' });
        } else {
          result = await runTests({ testCmd, cwd, slug: state.slug, phaseNumber: phase.number, iteration: 1 });
        }
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === 'RUN_TESTS') {
      console.log(`  → Tests: iter ${action.iteration}`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({ exitCode: 0, stdout: '[dry-run] tests would pass (Green)' });
      } else {
        const testCmd = args.testCmd ?? detectTestCmd(cwd);
        if (!testCmd) {
          // No test cmd: skip test verification, treat as green.
          console.warn('  ⚠ no test command detected; skipping test verification');
          result = mockResult({ exitCode: 0, stdout: 'no test command; skipped' });
        } else {
          result = await runTests({ testCmd, cwd, slug: state.slug, phaseNumber: phase.number, iteration: action.iteration });
        }
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === 'RUN_GEMINI_FIX') {
      console.log(`  → Gemini: fixing failing tests, iter ${action.iteration}`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({ exitCode: 0, stdout: '[dry-run] Gemini would fix tests' });
      } else {
        const inputFilePath = path.join(logDir(state.slug), `phase-${phase.number}-gemini-fix-${action.iteration}-input.md`);
        const outputFilePath = path.join(logDir(state.slug), `phase-${phase.number}-gemini-fix-${action.iteration}-output.md`);
        fs.writeFileSync(inputFilePath, buildGeminiFixPrompt(phase, state.planFile));
        fs.writeFileSync(outputFilePath, '');
        result = await runGemini({ inputFilePath, outputFilePath, cwd, slug: state.slug, phaseNumber: phase.number, iteration: action.iteration, logPrefix: 'gemini-fix' });
      }
      phaseState = applyResult(phaseState, action, result);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    // -----------------------------------------------------------------
    // Dual-implementor (--dual-impl) action handlers
    // -----------------------------------------------------------------

    if (action.type === 'RUN_DUAL_IMPL') {
      console.log(`  → Dual Impl: spawning Gemini + Codex in parallel worktrees (iter ${action.iteration})`);
      let result: SubAgentResult;
      if (dryRun) {
        result = mockResult({ exitCode: 0, stdout: '[dry-run] Dual Impl would spawn both' });
        phaseState = applyResult(phaseState, action, result, {
          dualImplInit: {
            geminiWorktreePath: '/tmp/dryrun-gemini',
            codexWorktreePath: '/tmp/dryrun-codex',
            geminiBranch: 'dryrun-gemini',
            codexBranch: 'dryrun-codex',
            baseCommit: 'dryrun-base',
          },
        });
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      // Real path: create worktrees, run both impls in parallel.
      let pair;
      try {
        pair = createWorktrees({ cwd, slug: state.slug, phaseNumber: phase.number });
      } catch (err) {
        const msg = `Failed to create dual-impl worktrees: ${(err as Error).message}`;
        phaseState = applyResult(phaseState, action, mockResult({ exitCode: 1, stderr: msg }));
        phaseState.error = msg;
        phaseState.status = 'failed';
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
      let dualImplOk = false;
      try {
        const implPromptBody = buildGeminiPromptBody(phase, state.planFile, state.branch);
        const codexPromptBody = buildCodexImplPromptBody(phase, state.planFile);

        const slug = state.slug;
        const phaseN = phase.number;
        const it = action.iteration;

        const geminiInputPath = path.join(logDir(slug), `phase-${phaseN}-dual-gemini-${it}-input.md`);
        const geminiOutputPath = path.join(logDir(slug), `phase-${phaseN}-dual-gemini-${it}-output.md`);
        const codexInputPath = path.join(logDir(slug), `phase-${phaseN}-dual-codex-${it}-input.md`);
        const codexOutputPath = path.join(logDir(slug), `phase-${phaseN}-dual-codex-${it}-output.md`);

        fs.writeFileSync(geminiInputPath, implPromptBody);
        fs.writeFileSync(geminiOutputPath, '');
        fs.writeFileSync(codexInputPath, codexPromptBody);
        fs.writeFileSync(codexOutputPath, '');

        // Run both in parallel — the only way to make tournament selection meaningful.
        const [gRes, cRes] = await Promise.all([
          runGemini({
            inputFilePath: geminiInputPath,
            outputFilePath: geminiOutputPath,
            cwd: pair.geminiWorktreePath,
            slug,
            phaseNumber: phaseN,
            iteration: it,
            logPrefix: 'dual-gemini',
          }),
          runCodexImpl({
            inputFilePath: codexInputPath,
            outputFilePath: codexOutputPath,
            cwd: pair.codexWorktreePath,
            slug,
            phaseNumber: phaseN,
            iteration: it,
          }),
        ]);

        // Validate each implementor produced committed work — uncommitted edits
        // would pass tests but applyWinner would have nothing to cherry-pick.
        // (Phase 4 review, HIGH; refined Phase 5 /codex review P2.)
        const gCommits = countCommitsSinceBase(pair.geminiWorktreePath, pair.baseCommit);
        const cCommits = countCommitsSinceBase(pair.codexWorktreePath, pair.baseCommit);
        const gCommitted = (gCommits ?? 0) > 0;
        const cCommitted = (cCommits ?? 0) > 0;

        // Catastrophic = timeout, OR both have non-zero exit, OR neither committed.
        const eitherTimedOut = gRes.timedOut || cRes.timedOut;
        const bothExitNonZero = gRes.exitCode !== 0 && cRes.exitCode !== 0;
        const neitherCommitted = !gCommitted && !cCommitted;

        if (eitherTimedOut || bothExitNonZero || neitherCommitted) {
          phaseState.status = 'failed';
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
          stdout: `gemini ok (${gCommits} commits)\ncodex ok (${cCommits} commits)`,
          logPath: gRes.logPath,
        });
        phaseState = applyResult(phaseState, action, synthetic, { dualImplInit: dualState });

        // /codex review P2 — if exactly one side committed, the other is ineligible
        // (tests would pass on uncommitted edits but applyWinner can't cherry-pick).
        // Skip RUN_DUAL_TESTS + RUN_JUDGE_OPUS entirely; auto-select the committed side.
        if (gCommitted && !cCommitted) {
          console.log(`  ⚠ Codex did not commit (gemini=${gCommits} commits, codex=0) — auto-selecting gemini, skipping tests + judge`);
          phaseState.dualImpl = {
            ...(phaseState.dualImpl as any),
            selectedImplementor: 'gemini',
            selectedBy: 'auto',
          };
          phaseState.status = 'dual_winner_pending';
        } else if (!gCommitted && cCommitted) {
          console.log(`  ⚠ Gemini did not commit (gemini=0, codex=${cCommits} commits) — auto-selecting codex, skipping tests + judge`);
          phaseState.dualImpl = {
            ...(phaseState.dualImpl as any),
            selectedImplementor: 'codex',
            selectedBy: 'auto',
          };
          phaseState.status = 'dual_winner_pending';
        }
        // else: both committed — normal flow → dual_impl_done → RUN_DUAL_TESTS

        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        dualImplOk = true; // suppress finally teardown; downstream phases own cleanup
      } catch (err) {
        const msg = `Dual implementation crashed unexpectedly: ${(err as Error).message}`;
        phaseState.status = 'failed';
        phaseState.error = msg;
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
      } finally {
        if (!dualImplOk) {
          try {
            teardownWorktrees({ cwd, dualImpl: dualState });
          } catch (err) {
            console.warn(`  ⚠ worktree teardown raised: ${(err as Error).message}`);
          }
        }
      }
      continue;
    }

    if (action.type === 'RUN_DUAL_TESTS') {
      console.log(`  → Dual Tests: running tests on both worktrees in parallel`);
      const dual = phaseState.dualImpl;
      if (!dual) {
        phaseState.status = 'failed';
        phaseState.error = 'RUN_DUAL_TESTS reached without dualImpl state — orchestrator bug';
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      let geminiTR: DualImplTestResult;
      let codexTR: DualImplTestResult;

      if (dryRun) {
        geminiTR = { worktreePath: dual.geminiWorktreePath, testExitCode: 0, testLogPath: 'dryrun', timedOut: false, failureCount: 0 };
        codexTR  = { worktreePath: dual.codexWorktreePath,  testExitCode: 0, testLogPath: 'dryrun', timedOut: false, failureCount: 0 };
      } else {
        const testCmd = args.testCmd ?? detectTestCmd(cwd);
        if (!testCmd) {
          // No test cmd: assume both green so judge runs.
          console.warn('  ⚠ no test command detected for dual-tests; assuming both green');
          geminiTR = { worktreePath: dual.geminiWorktreePath, testExitCode: 0, testLogPath: 'no-test-cmd', timedOut: false, failureCount: 0 };
          codexTR  = { worktreePath: dual.codexWorktreePath,  testExitCode: 0, testLogPath: 'no-test-cmd', timedOut: false, failureCount: 0 };
        } else {
          const [g, c] = await Promise.all([
            runTests({ testCmd, cwd: dual.geminiWorktreePath, slug: state.slug, phaseNumber: phase.number, iteration: 1, logSuffix: 'gemini' }),
            runTests({ testCmd, cwd: dual.codexWorktreePath,  slug: state.slug, phaseNumber: phase.number, iteration: 1, logSuffix: 'codex'  }),
          ]);
          geminiTR = {
            worktreePath: dual.geminiWorktreePath,
            testExitCode: g.exitCode,
            testLogPath: g.logPath,
            timedOut: g.timedOut,
            failureCount: parseFailureCount(g.stdout + '\n' + g.stderr),
          };
          codexTR = {
            worktreePath: dual.codexWorktreePath,
            testExitCode: c.exitCode,
            testLogPath: c.logPath,
            timedOut: c.timedOut,
            failureCount: parseFailureCount(c.stdout + '\n' + c.stderr),
          };
        }
      }

      const synthetic = mockResult({ exitCode: 0, stdout: `g=${geminiTR.testExitCode} c=${codexTR.testExitCode}` });
      phaseState = applyResult(phaseState, action, synthetic, {
        geminiTestResult: geminiTR,
        codexTestResult: codexTR,
      });
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === 'RUN_JUDGE_OPUS') {
      console.log(`  → Judge Opus: deciding between Gemini and Codex`);
      const dual = phaseState.dualImpl;
      if (!dual || !dual.geminiTestResult || !dual.codexTestResult) {
        phaseState.status = 'failed';
        phaseState.error = 'RUN_JUDGE_OPUS reached without dual test results — orchestrator bug';
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      let verdict: 'gemini' | 'codex' | null;
      let reasoning: string;
      let logPath = 'dryrun';

      if (dryRun) {
        verdict = 'gemini';
        reasoning = '[dry-run] judge would pick gemini';
      } else {
        const geminiDiff = readWorktreeDiff(dual.geminiWorktreePath, dual.baseCommit);
        const codexDiff = readWorktreeDiff(dual.codexWorktreePath, dual.baseCommit);

        // Fail-closed if either diff couldn't be read — judge would see empty
        // evidence and pick arbitrarily. (Phase 4 review, HIGH.)
        if (geminiDiff === null || codexDiff === null) {
          teardownWorktrees({ cwd, dualImpl: dual });
          phaseState.status = 'failed';
          phaseState.error =
            `Failed to read worktree diff before judge: ` +
            `gemini=${geminiDiff === null ? 'failed' : 'ok'}, ` +
            `codex=${codexDiff === null ? 'failed' : 'ok'}`;
          state.phases[phase.index] = phaseState;
          saveState(state, { noGbrain, log: console.warn });
          continue;
        }

        const inputPath = path.join(logDir(state.slug), `phase-${phase.number}-judge-input.md`);
        const outputPath = path.join(logDir(state.slug), `phase-${phase.number}-judge-output.md`);
        fs.writeFileSync(
          inputPath,
          buildJudgePrompt({
            phase,
            geminiDiff,
            codexDiff,
            geminiTestResult: dual.geminiTestResult,
            codexTestResult: dual.codexTestResult,
          })
        );
        fs.writeFileSync(outputPath, '');

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

        if (judgeRes.timedOut || judgeRes.exitCode !== 0) {
          // Tear down worktrees and fail closed.
          teardownWorktrees({ cwd, dualImpl: dual });
          phaseState.status = 'failed';
          phaseState.error = `Judge Opus failed: exit=${judgeRes.exitCode} timedOut=${judgeRes.timedOut}`;
          state.phases[phase.index] = phaseState;
          saveState(state, { noGbrain, log: console.warn });
          continue;
        }
      }

      if (verdict === null) {
        // Malformed judge output — fail closed (Phase 3 review).
        teardownWorktrees({ cwd, dualImpl: dual });
        phaseState.status = 'failed';
        phaseState.error = `Judge Opus output was malformed (no anchored WINNER line); reasoning: ${reasoning}`;
        state.phases[phase.index] = phaseState;
        saveState(state, { noGbrain, log: console.warn });
        continue;
      }

      const synthetic = mockResult({ exitCode: 0, stdout: `WINNER: ${verdict}`, logPath });
      phaseState = applyResult(phaseState, action, synthetic, {
        judgeVerdict: verdict,
        judgeReasoning: reasoning,
      });
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    if (action.type === 'APPLY_WINNER') {
      console.log(`  → Apply Winner: ${action.winner} (cherry-picking onto main cwd)`);
      const dual = phaseState.dualImpl;
      if (!dual) {
        phaseState.status = 'failed';
        phaseState.error = 'APPLY_WINNER reached without dualImpl state — orchestrator bug';
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
        phaseState.status = 'failed';
        phaseState.error =
          `applyWinner(${action.winner}) failed: ${applyError ?? 'unknown'}\n` +
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

      const synthetic = mockResult({ exitCode: 0, stdout: `applied ${action.winner}` });
      phaseState = applyResult(phaseState, action, synthetic);
      state.phases[phase.index] = phaseState;
      saveState(state, { noGbrain, log: console.warn });
      continue;
    }

    // Exhaustive switch — should never reach here.
    const _never: never = action;
    void _never;
    return 'failed';
  }
}

function mockResult(overrides: Partial<SubAgentResult>): SubAgentResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    logPath: '/dev/null',
    durationMs: 0,
    retries: 0,
    ...overrides,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.planFile)) {
    console.error(`plan file not found: ${args.planFile}`);
    process.exit(2);
  }

  const content = fs.readFileSync(args.planFile, 'utf8');
  const { phases, warnings } = parsePlan(content, { dualImpl: args.dualImpl });

  console.log(`Plan: ${args.planFile}`);
  console.log(`Phases parsed: ${phases.length}`);
  console.log('');
  printPhaseTable(phases);

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (args.printOnly) {
    process.exit(0);
  }

  if (phases.length === 0) {
    console.error('\nno executable phases found; nothing to do');
    process.exit(2);
  }

  const slug = deriveSlug(args.planFile);

  // Lock contention check.
  if (!acquireLock(slug)) {
    const info = readLockInfo(slug);
    console.error(
      `\nanother gstack-build instance is running for "${slug}".\n` +
        `lock info:\n${info}\n` +
        `if stale, remove ~/.gstack/build-state/${slug}.lock and retry.`
    );
    process.exit(3);
  }

  ensureLogDir(slug);

  // Load or create state. --no-resume forces a fresh start.
  let state: BuildState;
  if (args.noResume) {
    state = freshState({
      planFile: args.planFile,
      branch: getCurrentBranch(),
      phases,
    });
    saveState(state, { noGbrain: args.noGbrain, log: console.warn });
  } else {
    const loaded = loadState(slug, { noGbrain: args.noGbrain, log: console.warn });
    if (loaded) {
      console.log(`\nresuming state from ${loaded.lastUpdatedAt}`);
      state = loaded;
    } else {
      state = freshState({
        planFile: args.planFile,
        branch: getCurrentBranch(),
        phases,
      });
      saveState(state, { noGbrain: args.noGbrain, log: console.warn });
    }
  }

  // SIGINT — release lock, save state, exit 130.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    console.error('\n[interrupted] saving state and releasing lock...');
    try {
      saveState(state, { noGbrain: args.noGbrain });
    } catch {
      // ignore
    }
    releaseLock(slug);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const startedAt = Date.now();
  logActivity({ event: 'start', slug, plan: args.planFile, dryRun: args.dryRun });

  // Drive the loop.
  const cwd = path.dirname(args.planFile).includes('plans')
    ? path.resolve(path.dirname(args.planFile), '..')
    : path.dirname(args.planFile);

  let exitCode = 0;
  try {
    while (true) {
      const idx = findNextPhaseIndex(state.phases);
      if (idx === -1) break;
      const phase = phases[idx];
      summarizePhase(phase.number, phase.name, '▶');

      const outcome = await runPhase({
        state,
        phase,
        cwd,
        noGbrain: args.noGbrain,
        dryRun: args.dryRun,
        maxCodexIter: args.maxCodexIter,
        testCmd: args.testCmd,
      });

      if (outcome === 'failed') {
        exitCode = 1;
        break;
      }
    }

    if (exitCode === 0 && !args.skipShip && !args.dryRun) {
      console.log('\n▶ All phases committed. Running /ship + /land-and-deploy.');
      const result = await shipAndDeploy({ cwd, slug });
      if (result.exitCode !== 0 || result.timedOut) {
        console.error(`✗ ship failed (exit ${result.exitCode}, timed_out=${result.timedOut}); see ${result.logPath}`);
        exitCode = 1;
      } else {
        console.log(`  ✓ shipped (${(result.durationMs / 1000).toFixed(0)}s)`);
        state.completed = true;
        saveState(state, { noGbrain: args.noGbrain, log: console.warn });
      }
    } else if (exitCode === 0 && (args.skipShip || args.dryRun)) {
      state.completed = !args.dryRun;
      saveState(state, { noGbrain: args.noGbrain, log: console.warn });
      console.log(`\n${args.dryRun ? '(dry-run) ' : ''}all phases done${args.skipShip ? ' (ship skipped)' : ''}`);
    }
  } finally {
    releaseLock(slug);
    logActivity({
      event: exitCode === 0 ? 'success' : 'failed',
      slug,
      durationMs: Date.now() - startedAt,
      exitCode,
    });
  }

  process.exit(exitCode);
}

function getCurrentBranch(): string {
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
    });
    return result.stdout?.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
