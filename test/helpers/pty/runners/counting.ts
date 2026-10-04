/**
 * runPlanSkillCounting. Moved from claude-pty-runner.ts.
 * Import through test/helpers/claude-pty-runner.ts from tests; pty/ modules import siblings directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPlanCountFixture } from '../../plan-count-fixture';
import { createPlanCountSnapshotWriter } from '../../plan-count-artifacts';
import { readPlanCountTranscript, unresolvedPlanQuestionCalls, type NativePlanQuestionCall, type PlanCountTranscript, type NativePublicToolEvent } from '../../plan-count-transcript';
import { withPendingExit } from '../../plan-count-pending-exit';
import { readPendingQuestion } from '../../plan-count-pending-question';
import { currentFilePermissionBinding, readPendingWriteInput, type FilePermissionEpoch } from '../../plan-count-file-permission';
import { autoplanArtifactRecorderStatus, autoplanArtifactApprovalBoundary } from '../../autoplan-artifact-recorder';
import { stripVTControlCharacters } from 'node:util';
import { capturePlanCountQuestion, createPlanCountPermissionGuard, matchesNativePlanQuestion, nativePlanCallFingerprint, planCountPrerequisitePick, planCountQuestionInput, planCountQuestionPhase } from '../auq';
import type { AskUserQuestionFingerprint, Step0BoundaryPredicate } from '../auq';
import { SANCTIONED_WRITE_SUBSTRINGS, classifyPlanCountFrame, isProseAUQVisible, planCountSubmissionInput } from '../classify';
import { selectPtyNumberedOption } from '../launch';
import type { ClaudePtySession } from '../launch';
import { evaluateOwnedNativePlanTerminal, hasNativePlanCompletion, hasNativePlanTerminal, isQuestionlessNativePlanExit } from '../plan-native';
import type { NativePlanTerminalEvaluator } from '../plan-native';
import { isNumberedOptionListVisible, isPermissionDialogVisible, isRejectedSlashCommand } from '../screen';
import { realPtyDriver, runPtySession, type PtyDriver, type PtyStep } from '../session';

// ────────────────────────────────────────────────────────────────────────────
// runPlanSkillCounting — drives a plan-* skill end-to-end through Step 0 then
// counts completed review-phase AskUserQuestion calls. The actual
// product asserted by the per-finding-count tests.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Result of a `runPlanSkillCounting` run. Includes both the count summary
 * (`step0Count`, `reviewCount`, `administrativeCount`) and the full fingerprint list for diagnostic
 * dumps when an assertion fails.
 */
export interface PlanSkillCountObservation {
  /** Durable full raw/visible PTY output plus JSON observation, when EVALS_RUN_ID or GSTACK_EVAL_DIR is set. */
  artifactDir?: string;
  artifactError?: string;
  outcome:
    | 'plan_ready'
    | 'completion_summary'
    | 'collection_complete'
    | 'ceiling_reached'
    | 'silent_write'
    | 'transcript_unavailable'
    | 'artifact_permission_failed'
    | 'no_review_questions'
    | 'exited'
    | 'timeout';
  summary: string;
  /** Visible terminal text at terminal time (last 3KB). */
  evidence: string;
  /** Wall time (ms) until the outcome was decided. */
  elapsedMs: number;
  /** All distinct AskUserQuestions observed, in observation order. */
  fingerprints: AskUserQuestionFingerprint[];
  /** Actual native calls, including unanswered/failed ones that add no coverage. */
  transcript: PlanCountTranscript;
  /** Setup questions; administrative calls are excluded. */
  step0Count: number;
  /** Review questions; administrative calls are excluded. */
  reviewCount: number;
  /** Answered administrative handoffs and artifact rendering, preserved separately. */
  administrativeCount: number;
  /** QA test plans (`projects/<slug>/*-eng-review-test-plan-*.md`) in the run's owned state root at the outcome. */
  engTestPlans: EngTestPlan[];
}

export interface EngTestPlan { file: string; content: string }

/** The /plan-eng-review QA test-plan artifacts under one state root, read before fixture cleanup. */
export function readEngTestPlans(stateRoot: string | undefined): EngTestPlan[] {
  const projects = stateRoot ? path.join(stateRoot, 'projects') : '';
  if (!projects || !fs.existsSync(projects)) return [];
  return fs.readdirSync(projects, { withFileTypes: true }).filter(slug => slug.isDirectory()).flatMap(slug =>
    fs.readdirSync(path.join(projects, slug.name)).filter(name => /-eng-review-test-plan-.*\.md$/.test(name)).sort().map(name => {
      const file = path.join('projects', slug.name, name);
      return { file, content: fs.readFileSync(path.join(stateRoot!, file), 'utf8') };
    }));
}

/** Options for runPlanSkillCounting. */
export interface PlanSkillCountingOptions {
  /** Skill name, e.g. 'plan-ceo-review'. Used for diagnostic strings only. */
  skillName: string;
  /** Slash command to send alone, e.g. '/plan-ceo-review'. No trailing args. */
  slashCommand: string;
  /** Fixture request seeded in initial project context before the slash command. */
  followUpPrompt: string;
  /** Observe this caller-owned disposable plan for permission identity only.
   * Does not impose the expectedPlanPath terminal-report contract. */
  permissionPlanPath?: string;
  /** Declared actor support for the required QA artifact; no other state path gains approval. */
  approveEngTestPlanEdits?: boolean;
  /** Per-skill predicate: which answered AUQ is the last Step-0 question. */
  isLastStep0AUQ: Step0BoundaryPredicate;
  /** Optional positive identity for a first finding when no final setup AUQ was emitted. */
  isFirstReviewAUQ?: Step0BoundaryPredicate;
  /** Optional native setup classifier; late/reordered setup must not become a finding. */
  isSetupAUQ?: Step0BoundaryPredicate;
  /** Optional native completed-review handoff identity, excluded from both count bands. */
  isCompletionHandoffAUQ?: Step0BoundaryPredicate;
  /** Opt-in one-shot semantic assessment at a real native Exit. Existing callers
   * retain their synchronous navigation and terminal policy. */
  evaluateTerminal?: NativePlanTerminalEvaluator;
  /** Accepted artifact rendering is not a finding; its answer still requires a fresh report. */
  isArtifactGenerationAUQ?: Step0BoundaryPredicate;
  /** Optional issue classifier across phases; receives full native call metadata. */
  isReviewAUQ?: (fp: AskUserQuestionFingerprint, priorCalls?: readonly NativePlanQuestionCall[]) => boolean;
  /** Stop a collection-only fixture once its acknowledged inputs are complete.
   * This is not review completion or a passing verdict; the caller still validates them. */
  isCollectionComplete?: (transcript: PlanCountTranscript, fingerprints: readonly AskUserQuestionFingerprint[],
    engTestPlans: readonly EngTestPlan[]) => boolean;
  /** Narrow caller-specific selection; null retains the normal answer policy.
   * The first argument retains full pending metadata for existing callers.
   * Native-bound selection uses activeCapture, whose metadata is present only
   * when capturePlanCountQuestion matched the currently visible native question. */
  pickAUQ?: (fp: AskUserQuestionFingerprint, activeCapture: AskUserQuestionFingerprint,
    context: Readonly<{ cwd: string; deadlineAt: number }>) => number | null;
  /** Opt-in declared actor: wait for a complete current native tab, then require
   * its picker answer. Unbound redraws never consume seen state or default to 1. */
  requireNativePicker?: boolean;
  /** Observe owned pending AUQs for callers that need identity before answering. */
  observeSetupQuestions?: boolean;
  /** Bind the declared Design board actor and renderer to one fixture-owned daemon state. */
  bindDesignBoardState?: boolean;
  /** Require native completion plus this caller-owned final report before accepting a soft terminal. */
  expectedPlanPath?: string;
  /** Additional versioned files available in the isolated fixture before the skill starts. */
  fixtureFiles?: Record<string, string>;
  /** Fixture actor already declined routing setup and cross-project learnings. */
  preconfiguredReviewActor?: boolean;
  /** Hard cap on review-phase count; helper returns when reached. Should be
   *  set ABOVE the test's assertion ceiling so the test sees the cap as a
   *  failure rather than a silent stop. */
  reviewCountCeiling: number;
  /** Numbered option to press by default. Defaults to 1 (recommended). */
  defaultPick?: number;
  /**
   * Optional override for the FIRST AUQ observed. Receives the fingerprint;
   * returns the option index to press. Subsequent review AUQs use defaultPick;
   * only the recognized optional office-hours prerequisite is declined by label.
   *
   * Skill-specific routing helper: /plan-ceo-review's first AUQ asks "what
   * scope?" with options like "branch diff" / "describe inline" / "skip
   * interview". Pressing the default 1 routes to "branch diff" (the wrong
   * review target for a seeded fixture). firstAUQPick lets the test pick
   * "Skip interview" or "describe inline" so the agent reviews the
   * fixture plan content, not the git diff.
   */
  firstAUQPick?: (fp: AskUserQuestionFingerprint) => number;
  /** Total budget including startup and cleanup. Must exceed the 5s cleanup reserve. Default 1_500_000. */
  timeoutMs?: number;
  startupReadyMarker?: string;
  /** Extra env merged into the spawned `claude` process. */
  env?: Record<string, string>;
  /** Override the spawned model. Defaults via launchClaudePty's chain. */
  model?: string;
  /** Launch seam and clock; tests pass the fake driver. Default: real launcher and clocks. */
  driver?: PtyDriver;
}

/**
 * Drive a plan-* skill in plan mode and count distinct native review-phase
 * AskUserQuestions until a terminal signal fires. Each run disables the
 * extra outside review in its own gstack config: independent reviewers can
 * add valid findings unrelated to the seeded-N cadence band. These counts
 * do not assert outside-review dispatch or its approval-question cadence.
 *
 * Flow:
 *   1. Seed the complete fixture request in an isolated git repository's
 *      PLAN.md and initial CLAUDE.md context, with owned native-only config,
 *      then boot the PTY in that cwd
 *      (8s grace + auto-trust dialog). Skills remain registered in user scope.
 *   2. Send `slashCommand` alone. The fixture is already in context; sending
 *      it later can queue it behind the skill's first question while the
 *      review incorrectly starts against the operator's live branch.
 *   3. Poll loop:
 *      - Skip permission dialogs (auto-grant with `defaultPick`).
 *      - Read fixture-scoped native JSONL. Count each AskUserQuestion call
 *        once after its matching successful answer record, regardless of
 *        how many questions the call batches. Full native metadata feeds
 *        phase predicates; ANSI redraws and permissions cannot add counts.
 *      - On a new numbered-option list, keep the existing PTY answer driver.
 *        Decline only the recognized optional office-hours
 *        prerequisite by label so a different skill does not rewrite the
 *        seeded plan before this review begins.
 *      - After the native answer, evaluate `isLastStep0AUQ(fingerprint)`. If true,
 *        subsequent AUQs are review-phase unless the caller positively identifies native setup.
 *      - Hard ceiling: if `reviewCount >= reviewCountCeiling`, return
 *        `ceiling_reached`. This bounds runaway counts; tests should set
 *        the ceiling above their assertion CEILING.
 *      - Soft terminals: `COMPLETION_SUMMARY_RE` match → `completion_summary`;
 *        plan-ready confirmation → `plan_ready`; silent write outside
 *        sanctioned dirs → `silent_write`; process exited → `exited`;
 *        wall clock exceeded → `timeout`.
 *
 * Boundary detection (D14): event-based, fired against the answered AUQ's
 * fingerprint, not against later rendered content. This avoids the race
 * where Step-0-final and Section-1-first AUQs straddle a section header
 * regex match.
 *
 * UI fingerprints still dedupe redraws. Counted fingerprints use the
 * native session/tool call IDs, so shared answer labels never collapse
 * different calls and one multi-question call remains one finding.
 */
export async function runPlanSkillCounting(opts: PlanSkillCountingOptions): Promise<PlanSkillCountObservation> {
  const driver = opts.driver ?? realPtyDriver;
  if (opts.requireNativePicker && !opts.pickAUQ)
    throw Error('Native picker binding requires a declared picker');
  if (opts.bindDesignBoardState && (opts.skillName !== 'plan-design-review' || !opts.pickAUQ))
    throw Error('Design board state binding requires the Design caller and its declared picker');
  if (opts.approveEngTestPlanEdits && (opts.skillName !== 'plan-eng-review' || !opts.expectedPlanPath))
    throw Error('Eng test-plan approval requires the Eng caller and its explicit report');
  if (opts.isCollectionComplete && opts.expectedPlanPath)
    throw Error('Collection-only completion cannot replace the final report contract');
  const budgetStarted = driver.monotonic();
  const startedAt = driver.now();
  const timeoutMs = opts.timeoutMs ?? 1_500_000;
  if (opts.startupReadyMarker !== undefined && !opts.startupReadyMarker.length) {
    throw new RangeError('Plan counting startup-ready marker must not be empty');
  }
  // The caller may use this same limit as its Bun timeout. Leave room for
  // close()'s 2s graceful + 1s forced exit waits and artifact/fixture cleanup.
  // A second work window after boot lets Bun retry while this body is alive.
  const cleanupReserveMs = 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= cleanupReserveMs) {
    throw new RangeError('Plan counting timeout must exceed the 5000ms cleanup reserve');
  }
  const workDeadline = budgetStarted + timeoutMs - cleanupReserveMs;
  const fixture = createPlanCountFixture(opts.followUpPrompt, { nativeReviewOnly: true,
    files: opts.fixtureFiles, preconfiguredReviewActor: opts.preconfiguredReviewActor });
  const run: CountingRun = {
    opts, driver, startedAt, timeoutMs, cleanupReserveMs, workDeadline, fixture, defaultPick: opts.defaultPick ?? 1,
    pickerContext: Object.freeze({cwd: fixture.cwd, deadlineAt: startedAt + timeoutMs - cleanupReserveMs}),
    saveSnapshot: createPlanCountSnapshotWriter(), fingerprints: [], planningDirectory: undefined,
    seen: new Set(), countedCalls: new Set(), filePermission: createPlanCountPermissionGuard(), ownedFilePermissions: [],
    lastMatchedNativeQuestion: undefined, transcript: { status: 'missing', calls: [], assistantMessages: [] },
    boundaryFired: false, step0Count: 0, reviewCount: 0, administrativeCount: 0, isFirstAUQ: true,
    lastCheckpointAt: 0, viewport: '', observedOutput: 0, lastObservationAt: -Infinity, lastOutputAt: driver.now(),
  };
  const permissionPaths = [
    ...(opts.expectedPlanPath ? [opts.expectedPlanPath, path.join(fixture.cwd, 'PLAN.md')] : []),
    ...(opts.permissionPlanPath ? [opts.permissionPlanPath] : []),
  ];
  return runPtySession<PlanSkillCountObservation>({
    driver,
    cleanup: () => fixture.cleanup(),
    launch: {
      permissionMode: 'plan',
      cwd: fixture.cwd,
      // Stop new output at the work cutoff so screen drain cannot consume
      // the reserve while the CLI continues streaming.
      timeoutMs: Math.max(1, remainingWork(run)),
      screenDeadlineAt: workDeadline,
      env: { ...opts.env, ...fixture.env,
        // The renderer may cd into its artifact directory before starting the daemon.
        ...(opts.bindDesignBoardState ? { DESIGN_DAEMON_STATE_FILE: path.join(fixture.cwd, '.gstack', 'design.json') } : {}),
      },
      model: opts.model,
      seedSkills: true,
      observeScreen: true,
      observePlanReady: true,
      observeSetupQuestions: opts.observeSetupQuestions,
      observeFilePermissions: permissionPaths.length ? [...new Set(permissionPaths)] : undefined,
      ...(opts.approveEngTestPlanEdits ? { observeAutoplanArtifacts: true, approveAutoplanArtifactEdits: true, engTestPlanArtifactOnly: true } : {}),
    },
    start: session => countingStart(run, session),
    poll: session => countingPoll(run, session),
    tick: session => countingTick(run, session),
    timeout: session => countingSnapshot(run, session, 'timeout',
      `no terminal outcome within ${timeoutMs}ms total budget (including startup and ${cleanupReserveMs}ms cleanup reserve; step0=${run.step0Count}, review=${run.reviewCount}); ` +
        `idleFor=${run.driver.now() - run.lastOutputAt}ms`,
      run.viewport),
    onError: (session, error) => countingFailure(run, session, error),
    onCloseError: (session, error) => {
      countingCapture(run, session, { state: 'cleanup_failed', error: String(error), transcript: run.transcript, fingerprints: run.fingerprints });
    },
  });
}

/** Mutable state of one counting attempt, shared by its session-loop steps. */
export interface CountingRun {
  opts: PlanSkillCountingOptions;
  driver: PtyDriver;
  startedAt: number;
  timeoutMs: number;
  cleanupReserveMs: number;
  /** Monotonic work cutoff: budget start + timeout - cleanup reserve. */
  workDeadline: number;
  fixture: { cwd: string; env: Record<string, string> };
  defaultPick: number;
  pickerContext: Readonly<{ cwd: string; deadlineAt: number }>;
  saveSnapshot: ReturnType<typeof createPlanCountSnapshotWriter>;
  fingerprints: AskUserQuestionFingerprint[];
  planningDirectory: string | undefined;
  seen: Set<string>;
  countedCalls: Set<string>;
  filePermission: ReturnType<typeof createPlanCountPermissionGuard>;
  // Each owned path keeps its own grant history when the workflow switches
  // between the active plan and the separate caller-owned final report.
  ownedFilePermissions: Array<{ expected: string; file: string; guard: ReturnType<typeof createPlanCountPermissionGuard> }>;
  lastMatchedNativeQuestion: NativePlanQuestionCall | undefined;
  transcript: PlanCountTranscript;
  boundaryFired: boolean;
  step0Count: number;
  reviewCount: number;
  administrativeCount: number;
  isFirstAUQ: boolean;
  lastCheckpointAt: number;
  viewport: string;
  observedOutput: number;
  lastObservationAt: number;
  /** Wall time of the last new PTY output; the timeout summary reports the idle span. */
  lastOutputAt: number;
}

function remainingWork(run: CountingRun): number {
  return Math.max(0, run.workDeadline - run.driver.monotonic());
}

async function waitForWork(run: CountingRun, ms: number): Promise<boolean> {
  const remaining = remainingWork(run);
  if (remaining <= 0) return false;
  const clipped = ms >= remaining;
  await run.driver.sleep(Math.min(ms, remaining));
  // A clipped wait cannot finish the requested interval. Timers may wake
  // just before the fractional deadline; that is no license to advance.
  return !clipped && remainingWork(run) > 0;
}

/** Durable observation with public tool events and pending owned write inputs. */
export function countingCapture(run: CountingRun, session: Pick<ClaudePtySession, 'hermeticConfigDir' | 'rawOutput' | 'visibleText'>,
  observation: object) {
  const publicTools: NativePublicToolEvent[] = [];
  if (session.hermeticConfigDir) readPlanCountTranscript(session.hermeticConfigDir, run.fixture.cwd,
    event => publicTools.push(event));
  return run.saveSnapshot({
    skillName: run.opts.skillName, observation: { ...observation,
      publicTools,
      pendingWriteInputs: run.ownedFilePermissions.flatMap(binding => {
        const input = readPendingWriteInput(binding.file, binding.expected, run.fixture.cwd, session.hermeticConfigDir, run.startedAt);
        return input ? [input] : [];
      }) }, raw: session.rawOutput(), visible: session.visibleText(), viewport: run.viewport,
    cwd: run.fixture.cwd, claudeConfigDir: session.hermeticConfigDir,
  });
}

function countingSnapshot(
  run: CountingRun,
  session: ClaudePtySession,
  outcome: PlanSkillCountObservation['outcome'],
  summary: string,
  visible: string,
): PlanSkillCountObservation {
  const clean = (text: string) => stripVTControlCharacters(text)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const failed = outcome === 'exited' || outcome === 'timeout';
  const observation: PlanSkillCountObservation = {
    outcome,
    summary,
    evidence: failed
      ? `exitCode=${session.exitCode()}\n--- post-command evidence (last 3KB) ---\n${clean(visible).slice(-3000)}` +
        `\n--- full-session evidence, including startup (last 6KB) ---\n${clean(session.visibleText()).slice(-6000)}`
      : visible.slice(-3000),
    elapsedMs: run.driver.now() - run.startedAt,
    fingerprints: run.fingerprints,
    transcript: run.transcript,
    step0Count: run.step0Count,
    reviewCount: run.reviewCount,
    administrativeCount: run.administrativeCount,
    engTestPlans: readEngTestPlans(run.fixture.env.GSTACK_STATE_ROOT),
  };
  const artifacts = countingCapture(run, session, observation);
  Object.assign(observation, artifacts);
  if (artifacts.artifactDir) observation.evidence += `\nFull PTY artifacts: ${artifacts.artifactDir}`;
  if (artifacts.artifactError) observation.evidence += `\nPTY artifact write failed: ${artifacts.artifactError}`;
  return observation;
}

async function countingStart(run: CountingRun, session: ClaudePtySession): Promise<undefined> {
  const { opts } = run;
  run.planningDirectory = session.hermeticConfigDir ? path.join(session.hermeticConfigDir, 'plans') : undefined;
  run.ownedFilePermissions = (session.pendingFilePermissionFiles ?? []).map(binding =>
    ({ ...binding, guard: createPlanCountPermissionGuard() }));
  run.lastCheckpointAt = run.driver.now();
  run.observedOutput = session.mark();
  let startupReady: boolean;
  if (opts.startupReadyMarker !== undefined) {
    await session.waitFor(opts.startupReadyMarker, { timeoutMs: Math.min(8000, remainingWork(run)) });
    startupReady = remainingWork(run) > 0;
  } else {
    startupReady = await waitForWork(run, 8000);
  }
  if (startupReady) {
    run.observedOutput = session.mark();
    if (opts.approveEngTestPlanEdits) {
      if (!session.startAutoplanArtifactEditApproval) throw Error('Owned Eng test-plan approval hook unavailable');
      session.startAutoplanArtifactEditApproval(run.driver.now());
    }
    session.send(`${opts.slashCommand}\r`);
  }
  return undefined;
}

/** Wake on output (or 2s), coalesce redraws for 250ms, then read the viewport. */
async function countingPoll(run: CountingRun, session: ClaudePtySession): Promise<boolean> {
  if (remainingWork(run) <= 0) return false;
  await session.waitForOutput(run.observedOutput, Math.min(2000, remainingWork(run)));
  if (remainingWork(run) <= 0) return false;
  if (session.rawOutput().length > run.observedOutput) run.lastOutputAt = run.driver.now();
  const coalesceMs = session.rawOutput().length > run.observedOutput
    ? 250 : 250 - (run.driver.monotonic() - run.lastObservationAt);
  if (coalesceMs > 0 && !await waitForWork(run, coalesceMs)) return false;
  run.observedOutput = session.mark();
  run.lastObservationAt = run.driver.monotonic();
  run.viewport = await session.currentScreen();
  return remainingWork(run) > 0;
}

async function countingTick(run: CountingRun, session: ClaudePtySession): Promise<PtyStep<PlanSkillCountObservation>> {
  const visible = run.viewport;
  const observed = countingObserve(run, session, visible);
  if (observed) return observed;
  const { opts } = run;
  const transcript = run.transcript;
  // A native AUQ can render before its JSONL tool-use record is flushed.
  // The opt-in hook supplies pending identity only; answered counts above
  // still come exclusively from the published native transcript.
  const pending = transcript.calls.find(c => !c.answered && !c.failed)
    ?? readPendingQuestion(session.pendingQuestionFile, run.fixture.cwd,
      session.hermeticConfigDir, run.startedAt, transcript);
  // Native ACKs → complete collection → caller validation. A process failure
  // above or a pending native question still prevents this early collection stop.
  if (opts.isCollectionComplete && !pending && transcript.status === 'ready' &&
      transcript.calls.length > 0 && transcript.calls.every(call => call.answered && !call.failed) &&
      !unresolvedPlanQuestionCalls(transcript.calls).length && remainingWork(run) > 0 &&
      opts.isCollectionComplete(transcript, run.fingerprints, readEngTestPlans(run.fixture.env.GSTACK_STATE_ROOT)) && remainingWork(run) > 0) {
    return { done: countingSnapshot(run, session, 'collection_complete', 'Caller-defined native collection is complete; final validation remains required', visible) };
  }
  const terminal = await countingTerminal(run, visible, pending);
  if ('done' in terminal) return { done: countingSnapshot(run, session, terminal.done[0], terminal.done[1], visible) };
  return countingRespond(run, session, visible, pending, terminal);
}

/** Read and count native calls; process-level terminals. Undefined keeps routing. */
function countingObserve(run: CountingRun, session: ClaudePtySession, visible: string): PtyStep<PlanSkillCountObservation> | undefined {
  const { opts, fixture, startedAt } = run;
  const finish = (outcome: PlanSkillCountObservation['outcome'], summary: string) =>
    ({ done: countingSnapshot(run, session, outcome, summary, visible) });
  let transcript: PlanCountTranscript = session.hermeticConfigDir
    ? readPlanCountTranscript(session.hermeticConfigDir, fixture.cwd)
    : { status: 'error', calls: [], assistantMessages: [], error: 'Claude count session has no isolated transcript directory' };
  transcript = run.transcript = withPendingExit(transcript, session.pendingPlanReadyFile, fixture.cwd,
    session.hermeticConfigDir, startedAt, visible);
  if (opts.approveEngTestPlanEdits) {
    const status = autoplanArtifactRecorderStatus(session.pendingAutoplanArtifactFile, fixture.cwd,
      session.hermeticConfigDir, session.autoplanArtifactStateRoot);
    const boundary = autoplanArtifactApprovalBoundary(status);
    if (boundary === 'failed') return finish('artifact_permission_failed',
      `Owned Eng QA test-plan approval failed: ${JSON.stringify(status)}`);
    // Native approval owns this Edit. Never answer its repaint or count a
    // metadata-only pending request; resume only after its actual result.
    if (boundary === 'pending') {
      if (run.driver.now() - run.lastCheckpointAt >= 30_000) {
        run.lastCheckpointAt = run.driver.now();
        const saved = countingCapture(run, session, { state: 'artifact_pending', elapsedMs: run.driver.now() - startedAt,
          fingerprints: run.fingerprints, step0Count: run.step0Count, reviewCount: run.reviewCount,
          administrativeCount: run.administrativeCount, transcript, artifactStatus: status });
        if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
      }
      return 'continue';
    }
  }
  if (transcript.status === 'error') return finish('transcript_unavailable', transcript.error!);
  countAnsweredCalls(run, transcript);
  if (run.reviewCount >= opts.reviewCountCeiling) {
    if (unresolvedPlanQuestionCalls(transcript.calls).length) {
      return finish('transcript_unavailable', 'Question count reached its ceiling with unresolved failed native calls');
    }
    return finish('ceiling_reached', `review-phase AUQ count reached ceiling (${opts.reviewCountCeiling})`);
  }
  // An outer test timeout/cancellation may prevent a terminal snapshot.
  // Keep bounded-cadence evidence without adding a timer to clean up.
  if (run.driver.now() - run.lastCheckpointAt >= 30_000) {
    run.lastCheckpointAt = run.driver.now();
    const saved = countingCapture(run, session, { state: 'in_progress', elapsedMs: run.driver.now() - startedAt,
      fingerprints: run.fingerprints, step0Count: run.step0Count, reviewCount: run.reviewCount,
      administrativeCount: run.administrativeCount, transcript });
    if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
  }
  if (session.exited()) {
    return finish('exited', `claude exited (code=${session.exitCode()}) during counting (step0=${run.step0Count}, review=${run.reviewCount})`);
  }
  if (isRejectedSlashCommand(visible, opts.slashCommand)) {
    return finish('exited', `claude rejected ${opts.slashCommand} as unknown command (skill not registered in this cwd)`);
  }
  return undefined;
}

/** Count each answered native call once; phase comes from the caller's predicates. */
function countAnsweredCalls(run: CountingRun, transcript: PlanCountTranscript): void {
  const { opts } = run;
  for (const [callIndex, call] of transcript.calls.entries()) {
    const signature = `${call.sessionId}:${call.toolUseId}`;
    if (!call.answered || run.countedCalls.has(signature)) continue;
    const fp = nativePlanCallFingerprint(call, run.driver.now() - run.startedAt, !run.boundaryFired);
    const phase = planCountQuestionPhase(fp, run.boundaryFired, opts.isLastStep0AUQ, opts.isFirstReviewAUQ, opts.isSetupAUQ, opts.isCompletionHandoffAUQ, opts.isArtifactGenerationAUQ);
    if (phase.administrative) {
      fp.preReview = false;
      fp.administrative = phase.administrative;
      run.administrativeCount += 1;
    } else {
      fp.preReview = opts.isReviewAUQ ? !opts.isReviewAUQ(fp, transcript.calls.slice(0, callIndex)) : phase.preReview;
      if (fp.preReview) run.step0Count += 1;
      else run.reviewCount += 1;
    }
    fp.promptSnippet = fp.promptSnippet.replace(/\s+/g, ' ').slice(0, 240);
    run.fingerprints.push(fp);
    run.countedCalls.add(signature);
    run.boundaryFired = phase.reviewStarted;
  }
}

/**
 * A long completed summary may scroll its heading off the viewport. With no
 * active input UI, retain the existing native/report validator; neither
 * display text nor a missing heading supplies completion evidence.
 */
export function isNativeCompletionSummary(input: { expectedPlanPath?: string; nativeCompletion: boolean;
  renderedFrame: ReturnType<typeof classifyPlanCountFrame>; visible: string; transcript: PlanCountTranscript; startedAt: number;
  administrative: ReadonlySet<string> }): boolean {
  return Boolean(!input.nativeCompletion && input.renderedFrame === null && input.expectedPlanPath &&
    !isNumberedOptionListVisible(input.visible) && !isPermissionDialogVisible(input.visible) && !isProseAUQVisible(input.visible) &&
    hasNativePlanTerminal(input.transcript, input.expectedPlanPath, input.startedAt, 'completion_summary', input.administrative));
}

interface CountingTerminal {
  newlyMatched: boolean;
  nativeCompletion: boolean;
  verifiedTerminal: boolean;
  nativeQuestionVisible: boolean;
  terminalHint: 'permission' | 'completion_summary' | 'plan_ready' | null;
  frame: 'permission' | 'completion_summary' | 'plan_ready' | null;
}

/** Terminal evidence for this frame, before any input is routed. */
async function countingTerminal(run: CountingRun, visible: string, pending: NativePlanQuestionCall | undefined):
  Promise<CountingTerminal | { done: [PlanSkillCountObservation['outcome'], string] }> {
  const { opts, startedAt, transcript, fingerprints } = run;
  const newlyMatched = Boolean(pending && matchesNativePlanQuestion(visible, pending, run.planningDirectory));
  if (newlyMatched) run.lastMatchedNativeQuestion = pending;
  const renderedFrame = classifyPlanCountFrame(visible);
  const administrative = new Set(fingerprints.filter(fp => fp.administrative === 'completion-handoff').map(fp => fp.signature));
  if (opts.evaluateTerminal && opts.expectedPlanPath && renderedFrame === 'plan_ready' && !newlyMatched) {
    const reviewed = await evaluateOwnedNativePlanTerminal(transcript, opts.expectedPlanPath, startedAt,
      startedAt + run.timeoutMs - run.cleanupReserveMs, opts.evaluateTerminal);
    if (reviewed) {
      // Once semantics are validated, lexical phase labels have no veto.
      // The earlier progress snapshots remain unchanged diagnostic evidence.
      administrative.clear();
      for (const identity of reviewed.administrative) administrative.add(identity);
      for (const fp of fingerprints) {
        fp.preReview = !reviewed.substantive.has(fp.signature) && !administrative.has(fp.signature);
        if (administrative.has(fp.signature)) fp.administrative = 'completion-handoff';
        else delete fp.administrative;
      }
      run.reviewCount = reviewed.substantive.size;
      run.administrativeCount = administrative.size;
      run.step0Count = fingerprints.length - run.reviewCount - run.administrativeCount;
    }
  }
  const nativeCompletion = Boolean(opts.expectedPlanPath && hasNativePlanCompletion(transcript, opts.expectedPlanPath, startedAt));
  const nativeSummary = isNativeCompletionSummary({ expectedPlanPath: opts.expectedPlanPath, nativeCompletion,
    renderedFrame, visible, transcript, startedAt, administrative });
  const terminalFrame = nativeSummary ? 'completion_summary' : renderedFrame;
  const isTerminalHint = terminalFrame === 'completion_summary' || terminalFrame === 'plan_ready';
  const verifiedTerminal = nativeSummary || Boolean(opts.expectedPlanPath && isTerminalHint &&
    hasNativePlanTerminal(transcript, opts.expectedPlanPath, startedAt, terminalFrame, administrative));
  if (run.reviewCount === 0 && fingerprints.some(fp => fp.administrative === 'artifact-generation') &&
      (nativeCompletion || verifiedTerminal)) {
    return { done: ['no_review_questions', 'Completed artifact generation supplied no review finding decisions'] };
  }
  // A streamed heading cannot dismiss the last bound native question.
  // Only an accepted terminal may supersede its answered redraw; otherwise
  // permission wording inside that question could queue a stray answer.
  const acceptedTerminal = isTerminalHint && (!opts.expectedPlanPath || verifiedTerminal);
  const nativeQuestionVisible = newlyMatched || (!acceptedTerminal &&
    Boolean(run.lastMatchedNativeQuestion && matchesNativePlanQuestion(visible, run.lastMatchedNativeQuestion, run.planningDirectory)));
  const terminalHint = nativeQuestionVisible ? null : terminalFrame;
  let frame = terminalHint;
  // Clear unverified hints before routing active permissions and Submit.
  if (opts.expectedPlanPath && isTerminalHint && !verifiedTerminal) frame = null;
  // A real approval gate is never an AUQ or a file permission. Wait for
  // its report/native evidence before input routing; verified gates still
  // pass the existing silent-write check below. A positively matched
  // native question above takes precedence over gate text.
  const nonReviewCalls = new Set(fingerprints.filter(fp => fp.preReview || fp.administrative)
    .map(fp => fp.signature));
  if (opts.expectedPlanPath && terminalHint === 'plan_ready' && run.reviewCount === 0 &&
      isQuestionlessNativePlanExit(transcript, opts.expectedPlanPath, startedAt, visible, nonReviewCalls)) {
    return { done: ['no_review_questions',
      'Native plan approval reached with zero review-phase AskUserQuestion calls; review coverage is missing'] };
  }
  return { newlyMatched, nativeCompletion, verifiedTerminal, nativeQuestionVisible, terminalHint, frame };
}

/** Route permissions, Submit and the current question; then terminal outcomes. */
async function countingRespond(run: CountingRun, session: ClaudePtySession, visible: string,
  pending: NativePlanQuestionCall | undefined, t: CountingTerminal): Promise<PtyStep<PlanSkillCountObservation>> {
  const { opts, fixture, startedAt, transcript } = run;
  const finish = (outcome: PlanSkillCountObservation['outcome'], summary: string) =>
    ({ done: countingSnapshot(run, session, outcome, summary, visible) });
  const { frame } = t;
  if (opts.expectedPlanPath && t.terminalHint === 'plan_ready' && !t.verifiedTerminal) return 'continue';
  let permissionGuard = run.filePermission;
  let permissionEpoch: FilePermissionEpoch | null | undefined;
  const currentBinding = currentFilePermissionBinding(run.ownedFilePermissions, fixture.cwd,
    session.hermeticConfigDir, startedAt, transcript, visible);
  if (currentBinding) { permissionGuard = currentBinding.binding.guard; permissionEpoch = currentBinding.epoch; }
  else permissionEpoch = currentBinding;
  const permission = t.nativeQuestionVisible || t.terminalHint === 'plan_ready'
    ? null : permissionGuard(visible, session.visibleText(), permissionEpoch);
  if (frame === 'permission' || (permission === 'grant' && frame === null)) {
    if (remainingWork(run) <= 0) return 'break';
    if (permission !== 'handled') session.send(`${run.defaultPick}\r`);
    await waitForWork(run, 1500);
    return 'continue';
  }

  const submissionInput = frame === null ? planCountSubmissionInput(visible) : null;
  if (submissionInput !== null) {
    if (remainingWork(run) <= 0) return 'break';
    session.send(submissionInput);
    await waitForWork(run, 1500);
    return 'continue';
  }

  // Silent write detection — only fires if no numbered prompt is on
  // screen (otherwise the write is gated by a permission/AUQ).
  const writeRe = /⏺\s*(?:Write|Edit)\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = writeRe.exec(visible)) !== null) {
    const target = m[1] ?? '';
    const sanctioned = SANCTIONED_WRITE_SUBSTRINGS.some((s) =>
      target.includes(s),
    );
    if (!sanctioned && !isNumberedOptionListVisible(visible)) {
      return finish('silent_write', `Write/Edit to ${target} fired before any AskUserQuestion`);
    }
  }

  if (opts.expectedPlanPath && t.verifiedTerminal && (frame === 'completion_summary' || frame === 'plan_ready')) {
    return finish(frame, `native ${frame} and final report verified (step0=${run.step0Count}, review=${run.reviewCount})`);
  }

  // Legacy callers without a report contract retain their terminal policy.
  if (frame === 'completion_summary' || frame === 'plan_ready') {
    if (transcript.status !== 'ready' || transcript.calls.some(c => !c.answered && !c.failed) ||
        unresolvedPlanQuestionCalls(transcript.calls).length) {
      return finish('transcript_unavailable', frame === 'completion_summary'
        ? 'Completion has no complete native question transcript'
        : 'Plan-ready gate has no complete native question transcript');
    }
    return finish(frame, frame === 'completion_summary'
      ? `skill emitted completion summary / verdict / status line (step0=${run.step0Count}, review=${run.reviewCount})`
      : `skill emitted plan-mode "Ready to execute" confirmation (step0=${run.step0Count}, review=${run.reviewCount})`);
  }

  if (opts.expectedPlanPath && !transcript.planReadyRequests?.length && !isNumberedOptionListVisible(visible) &&
      hasNativePlanCompletion(transcript, opts.expectedPlanPath, startedAt)) {
    return finish('completion_summary',
      `native review completion and final report verified (step0=${run.step0Count}, review=${run.reviewCount})`);
  }

  // A dismissed or repainted permission is never a native question.
  if (permission === 'handled') return 'continue';
  return countingAnswer(run, session, visible, pending, t.newlyMatched);
}

/** Dedupe the complete question and press its policy-selected option. */
async function countingAnswer(run: CountingRun, session: ClaudePtySession, visible: string,
  pending: NativePlanQuestionCall | undefined, newlyMatched: boolean): Promise<PtyStep<PlanSkillCountObservation>> {
  const { opts, startedAt } = run;
  // Dedupe the complete question, not just its answer labels: separate
  // findings often reuse the same Add to plan / Defer / Skip menu.
  if (opts.requireNativePicker && !newlyMatched) return 'continue';
  const capturedSeen = opts.requireNativePicker ? new Set(run.seen) : run.seen;
  const fp = capturePlanCountQuestion(visible, capturedSeen, run.driver.now() - startedAt, !run.boundaryFired, pending, run.planningDirectory);
  if (!fp) return 'continue';
  const boundNativeTab = pending && fp.nativeCall === pending && fp.nativeQuestionIndex !== undefined;
  if (opts.requireNativePicker && !boundNativeTab) return 'continue';
  // Press to advance — first AUQ may use the override pick.
  const routing = pending?.questions.length === 1
    ? nativePlanCallFingerprint(pending, fp.observedAtMs, fp.preReview) : fp;
  const prerequisitePick = planCountPrerequisitePick(routing, fp);
  // Native tool records may flush only after the answer. Let a guarded
  // caller recognize that visible menu. A known packet needs a positively
  // matched active tab before a caller can change that tab's choice.
  // The captured fingerprint alone proves whether native metadata matched
  // this active UI; an unrelated pending record is not a routing identity.
  let callerPick: number | null = null;
  if ((!opts.requireNativePicker || prerequisitePick === null) &&
      (!pending || pending.questions.length === 1 || boundNativeTab)) {
    callerPick = opts.pickAUQ?.(routing, fp, run.pickerContext) ?? null;
  }
  if (opts.requireNativePicker && prerequisitePick === null && callerPick === null)
    throw Error('Declared native picker returned no authorized choice');
  const pickIdx = prerequisitePick ?? callerPick ??
    (run.isFirstAUQ && opts.firstAUQPick ? opts.firstAUQPick(routing) : run.defaultPick);
  if (opts.requireNativePicker) for (const signature of capturedSeen) run.seen.add(signature);
  run.isFirstAUQ = false;
  const questionInput = planCountQuestionInput(visible, fp, pickIdx);
  if (remainingWork(run) <= 0) return 'break';
  if (questionInput.includes('\r')) {
    // The helper separates digit and Enter by 500ms. Do not let that
    // delayed confirmation send input after this counting window closes.
    await selectPtyNumberedOption({ send: input => {
      if (remainingWork(run) > 0) session.send(input);
    } }, pickIdx);
  } else session.send(questionInput);

  // Give the agent a beat to advance to the next state.
  await waitForWork(run, 2000);
  return 'continue';
}

/** Caller/actor errors used to leave only the preceding 30s checkpoint.
 * Retain the actual throw frame and public native state before close()
 * removes the hook and fixture, without replacing the original failure. */
function countingFailure(run: CountingRun, session: ClaudePtySession, error: unknown): void {
  try {
    // Keep the exact frame/transcript that the throwing caller observed;
    // awaiting a redraw here would erase that ordering evidence.
    const saved = countingCapture(run, session, { state: 'threw', error: error instanceof Error ? error.message : String(error),
      elapsedMs: run.driver.now() - run.startedAt, fingerprints: run.fingerprints, step0Count: run.step0Count,
      reviewCount: run.reviewCount, administrativeCount: run.administrativeCount, transcript: run.transcript,
      pendingQuestion: readPendingQuestion(session.pendingQuestionFile, run.fixture.cwd,
        session.hermeticConfigDir, run.startedAt, run.transcript) });
    if (saved.artifactDir) console.error(`Full PTY artifacts: ${saved.artifactDir}`);
    if (saved.artifactError) console.error(`PTY artifact write failed: ${saved.artifactError}`);
  } catch (captureError) { console.error(`PTY failure capture failed: ${String(captureError)}`); }
}
