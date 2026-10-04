/**
 * Paid-lane shared types and constants: the leaf module every paid-lane file imports. Moved from scripts/test-paid-shards.ts
 * so scripts/lib/paid-*.ts never import the CLI module back (no import cycle).
 */
import * as path from 'node:path';
import { normalizeRelativePath, type LanePolicy } from './shard-engine';
import type { EvalCaseKind, PanelShape, TrialFailureClass, TrialOutcome } from '../../test/helpers/eval-store';

export const ROOT = path.resolve(import.meta.dir, '..', '..');

export type PaidTier = 'gate' | 'periodic' | 'marathon';
export const PAID_TIERS: readonly PaidTier[] = ['gate', 'periodic', 'marathon'];
export type PaidProfile = 'pr' | 'full';

export interface PaidCaseSelection {
  e2e: string[] | null;
  judges: string[] | null;
}

export const DEFAULT_TIER: PaidTier = 'gate';
export const DEFAULT_SHARD_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_FILES_PER_SHARD = 1;
// 8 jobs × 2 within-shard ≈ 10-13 real in-flight sessions (39 of 75
// skill-e2e files hold exactly ONE test, so within-shard concurrency is
// dead weight for most shards) — under the documented-safe ~15 the legacy
// 40-way runner established. The old 4×4 yielded only ~4-6 in-flight and a
// 13-wave local gate worst case (~6.5h); 8×2 halves it. Watch the WS1
// flake telemetry for sustained 429 storms across 2 PR cycles — that is
// the rollback trigger. Prerequisite (landed): per-shard TMPDIR/
// CHROMIUM_PROFILE isolation in runPaidShard.
export const DEFAULT_JOBS = 8;
export const DEFAULT_WITHIN_SHARD_CONCURRENCY = 2;

/**
 * Paid-lane classification policy. Seeds keep only positive walls (a zero
 * is not a real paid-shard measurement). A shard that passed with zero
 * executed tests is legitimate under selection (in-file diff/tier
 * self-skips) and only warns; under EVALS_ALL it is hollow: 'passed-empty'.
 */
export const PAID_LANE_POLICY: LanePolicy = {
  acceptsSeedDuration: (ms) => ms > 0,
  zeroExecution: ({ promisedAll }) => (promisedAll ? 'passed-empty' : 'passed-with-warning'),
};

/** One overlay process preserves the original process-wide SDK semaphore. */
export const OVERLAY_MAX_ACTIVE_SHARDS = 1;

export function isOverlayTestFile(file: string): boolean {
  return /^skill-e2e-overlay-harness-.+\.test\.ts$/.test(path.basename(normalizeRelativePath(file)));
}

export interface PaidShardBudget {
  timeoutMs: number;
  source: 'explicit' | 'registered' | 'default';
  policyId: string | null;
}

export type ShardStatus =
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'never-started'
  | 'skipped-by-diff'
  // exit 0 with ZERO executed tests on a run that promised everything
  // (EVALS_ALL): the hollow-file green the census backstop exists to catch.
  // Under selective runs, 0-executed passed shards stay 'passed' (in-file
  // diff/tier self-skips are legitimate there) and get a WARNING line only.
  | 'passed-empty';

export interface ShardOutcome {
  shard: number;
  files: string[];
  status: ShardStatus;
  exitCode: number | null;
  elapsedMs: number;
  groupPid: number | null;
  /** Tests bun reported executing ("Ran N tests ..."), null when unknown. */
  executedTests: number | null;
  /** Tests bun reported skipping (" N skip" count line), null when unknown.
   *  "Ran N tests" COUNTS skips, so executedTests alone cannot distinguish a
   *  shard that verified work from one whose every test self-skipped —
   *  codex/gemini files green-by-skip on every CI runner (no binary) and the
   *  weekly census read them as covered. */
  skippedTests: number | null;
  /** Effective supervised wall; absent only for unstarted or legacy outcomes. */
  budget?: PaidShardBudget;
  /** Present when a verified receipt replaced execution (PR lane only). */
  reused?: { inputKey: string; runId: string; revision: string; completedAt: number };
  /** The parent could not run the shard at all (a runner error, never a trial verdict). */
  runnerError?: string;
  /** PR lane: the reuse input identity of a freshly executed shard whose inputs stayed unchanged. */
  inputKey?: string;
  /** Isolated trial shards only: the trial record this shard produced. */
  trial?: ShardTrialRecord;
}

/**
 * One isolated trial's record, derived from its shard status and the records
 * in its own eval dir. `outcome` null means the harness produced no trial
 * (never started, hollow, isolation broken, runner error): the panel is then
 * INCOMPLETE and the slice exits non-zero. A failed, timed-out or crashed
 * trial is a trial verdict; the slice still exits zero and the report decides.
 */
export interface ShardTrialRecord {
  case: string;
  trial: number;
  kind: EvalCaseKind;
  panel: PanelShape;
  quarantined: boolean;
  outcome: TrialOutcome | null;
  harness?: string;
  failure_class?: TrialFailureClass;
  exit_reason?: string;
  error?: string;
  timeout_at_turn?: number;
  cost_usd: number;
  duration_ms: number;
  model?: string;
}
