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
} from './state';
import {
  decideNextAction,
  applyResult,
  markCommitted,
  findNextPhaseIndex,
  DEFAULT_MAX_CODEX_ITERATIONS,
  type Action,
} from './phase-runner';
import { runGemini, runCodexReview, type SubAgentResult } from './sub-agents';
import { flipPhaseCheckboxes } from './plan-mutator';
import { shipAndDeploy } from './ship';
import type { BuildState, Phase } from './types';

interface Args {
  planFile: string;
  printOnly: boolean;
  dryRun: boolean;
  noResume: boolean;
  noGbrain: boolean;
  skipShip: boolean;
  maxCodexIter: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    planFile: '',
    printOnly: false,
    dryRun: false,
    noResume: false,
    noGbrain: false,
    skipShip: false,
    maxCodexIter: DEFAULT_MAX_CODEX_ITERATIONS,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--print-only') args.printOnly = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-resume' || a === '--restart') args.noResume = true;
    else if (a === '--no-gbrain') args.noGbrain = true;
    else if (a === '--skip-ship') args.skipShip = true;
    else if (a === '--max-codex-iter') {
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

function printHelp() {
  console.log(`gstack-build — code-driven phase orchestrator

Usage:
  gstack-build <plan-file> [flags]

Flags:
  --print-only         Parse and show phase table; exit.
  --dry-run            Walk state machine without spawning sub-agents.
  --no-resume          Ignore existing state, start fresh.
  --no-gbrain          Skip gbrain mirror; local JSON only.
  --skip-ship          Skip the final /ship + /land-and-deploy step.
  --max-codex-iter N   Cap recursive Codex iterations (default 5).
  -h, --help           Show this help.

Plan file format: standard /build implementation plan with:
  ### Phase N: <name>
  - [ ] **Implementation (Gemini Sub-agent)**: ...
  - [ ] **Review & QA (Codex Sub-agent)**: ...

State files: ~/.gstack/build-state/<slug>/
Activity log: ~/.gstack/analytics/build-runs.jsonl
`);
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

function buildGeminiPrompt(phase: Phase, planFile: string, branch: string): string {
  return [
    `You are executing Phase ${phase.number}: ${phase.name} of an implementation plan.`,
    `Branch: ${branch}`,
    `Plan file: ${planFile}`,
    '',
    'Phase description (verbatim from the plan):',
    '---',
    phase.body.trim(),
    '---',
    '',
    'Instructions:',
    `1. Implement the work described above. Write the code, tests, and any docs the phase calls for.`,
    `2. If the project uses GitHub Actions, ensure your changes pass them.`,
    `3. Commit your changes to the current branch with a clear conventional-commit message.`,
    `4. Do NOT run /review, /qa, /ship, or any orchestration skill — those are downstream of you.`,
    `5. Do NOT update the plan file's checkboxes — the orchestrator handles that.`,
    `6. Fail forward: if a test fails, fix it before returning. Only return when the code is done and committed.`,
    '',
    'Return ONLY the work summary. No explanation. No narrative.',
  ].join('\n');
}

function summarizePhase(phaseNumber: string, phaseName: string, marker: string) {
  console.log(`\n[${marker}] Phase ${phaseNumber}: ${phaseName}`);
}

async function runPhase(args: {
  state: BuildState;
  phase: Phase;
  cwd: string;
  noGbrain: boolean;
  dryRun: boolean;
  maxCodexIter: number;
}): Promise<'done' | 'failed'> {
  const { state, phase, cwd, noGbrain, dryRun, maxCodexIter } = args;
  let phaseState = state.phases[phase.index];

  while (true) {
    const action: Action = decideNextAction(phaseState, maxCodexIter);

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
        const prompt = buildGeminiPrompt(phase, state.planFile, state.branch);
        result = await runGemini({
          prompt,
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
        result = await runCodexReview({
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
  const { phases, warnings } = parsePlan(content);

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

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
