// lib/merge.ts — pure merge-regime logic for /land and /land-and-deploy.
//
// This module is the single source of truth for the four risky merge
// operations, kept pure (no I/O) so they can be unit-tested with fixtures:
//
//   detectRegime  — none | github | trunk, from gh/check/config signals
//   planSubmit    — ordered list of submit commands per regime (trunk = comment-first)
//   classifyLand  — landed | ejected | pending | closed, from PR state + checks
//   buildLandState / validateConsume — the last-land.json handoff contract
//
// The CLI wrapper (bin/gstack-merge) gathers the live data via gh/git/fs and
// calls these functions. Keeping logic here means an E2E that inspects a
// command tests prompt text, but the unit tests here test behavior.

export type Regime = 'none' | 'github' | 'trunk';

export const LAND_STATE_SCHEMA_VERSION = 1;

// --- Regime detection ---------------------------------------------------

export interface PrCheck {
  /** Check name, e.g. "Trunk Merge Queue (main)". */
  name?: string;
  /** gh exposes `state` (e.g. SUCCESS) and/or `bucket` (pass/fail/pending). */
  state?: string;
  bucket?: string;
}

export interface DetectInput {
  /** Base branch the PR targets, e.g. "main". */
  base: string;
  /** Output of `gh pr checks --json name,state,bucket`. */
  checks: PrCheck[];
  /** Contents of .trunk/trunk.yaml if present, else null. */
  trunkYaml: string | null;
  /** Explicit "Merge queue: X" from CLAUDE.md ## Merge Configuration, else null. */
  configRegime?: string | null;
  /** True when branch protection on `base` has a GitHub-native merge queue. */
  githubMergeQueue?: boolean;
}

export interface DetectResult {
  regime: Regime;
  /** How the regime was decided — for honest narration. */
  source: 'config' | 'trunk-status-check' | 'trunk-yaml' | 'github-branch-protection' | 'default';
}

const VALID_REGIMES: Regime[] = ['none', 'github', 'trunk'];

/** Name of the GitHub status check Trunk posts on PRs, e.g. "Trunk Merge Queue (main)". */
export function trunkQueueCheckName(base: string): string {
  return `Trunk Merge Queue (${base})`;
}

/** Match any "Trunk Merge Queue (<branch>)" check regardless of branch. */
export function isTrunkQueueCheck(name: string | undefined): boolean {
  return !!name && /^Trunk Merge Queue \(.+\)$/.test(name);
}

/**
 * Decide the merge regime. Precedence:
 *   1. explicit config key (the project owns its config)
 *   2. live Trunk status check on the PR (the authoritative live signal)
 *   3. .trunk/trunk.yaml `merge:` section (secondary — NOT `.trunk/` presence
 *      alone, which `trunk check` also creates)
 *   4. GitHub-native merge queue from branch protection
 *   5. none
 */
export function detectRegime(input: DetectInput): DetectResult {
  const cfg = (input.configRegime || '').trim().toLowerCase();
  if (VALID_REGIMES.includes(cfg as Regime)) {
    return { regime: cfg as Regime, source: 'config' };
  }

  if (input.checks.some((c) => isTrunkQueueCheck(c.name))) {
    return { regime: 'trunk', source: 'trunk-status-check' };
  }

  // Secondary: a `merge:` section in .trunk/trunk.yaml means merge-queue is
  // configured for this repo (distinct from a bare .trunk/ that only carries
  // `trunk check` linter config).
  if (input.trunkYaml && /^\s*merge\s*:/m.test(input.trunkYaml)) {
    return { regime: 'trunk', source: 'trunk-yaml' };
  }

  if (input.githubMergeQueue) {
    return { regime: 'github', source: 'github-branch-protection' };
  }

  return { regime: 'none', source: 'default' };
}

// --- Submit planning ----------------------------------------------------

export interface SubmitCandidate {
  /** Program to run. */
  cmd: string;
  /** Args (pr number substituted). */
  args: string[];
  /** Human description for narration. */
  desc: string;
}

export interface SubmitPlan {
  regime: Regime;
  /** Candidates to try in order; first that runs cleanly wins. */
  candidates: SubmitCandidate[];
  /** Whether `--delete-branch` is owned by us (false for trunk — Trunk owns it). */
  deleteBranch: boolean;
}

export interface SubmitOpts {
  /** `trunk` CLI is installed + on PATH. */
  trunkCliAvailable?: boolean;
  /** $TRUNK_API_TOKEN is set (enables the REST fallback). */
  trunkToken?: boolean;
  /** Optional priority word for trunk (urgent|high|medium|low|lowest). */
  priority?: string;
}

/**
 * Build the ordered submit plan for a regime.
 *
 * trunk is **comment-first**: `gh pr comment "/trunk merge"` needs zero new
 * auth (gh is already required and Trunk's "GitHub commands" toggle is
 * default-ON), so it works the moment Trunk's GitHub App is installed. The
 * trunk CLI and REST are opportunistic upgrades.
 */
export function planSubmit(regime: Regime, pr: number, opts: SubmitOpts = {}): SubmitPlan {
  const prRef = String(pr);
  if (regime === 'none') {
    return {
      regime,
      deleteBranch: true,
      candidates: [
        { cmd: 'gh', args: ['pr', 'merge', prRef, '--squash', '--delete-branch'], desc: 'direct squash merge' },
      ],
    };
  }

  if (regime === 'github') {
    return {
      regime,
      deleteBranch: true,
      candidates: [
        { cmd: 'gh', args: ['pr', 'merge', prRef, '--auto', '--delete-branch'], desc: 'GitHub auto-merge / merge queue' },
        // If --auto is not enabled on the repo, fall back to a direct squash.
        { cmd: 'gh', args: ['pr', 'merge', prRef, '--squash', '--delete-branch'], desc: 'direct squash merge (auto unavailable)' },
      ],
    };
  }

  // trunk — comment-first, then CLI, then REST. NEVER `gh pr merge`, NEVER
  // --delete-branch (Trunk owns the merge and branch cleanup).
  const commentBody = opts.priority ? `/trunk merge --priority=${opts.priority}` : '/trunk merge';
  const candidates: SubmitCandidate[] = [
    { cmd: 'gh', args: ['pr', 'comment', prRef, '--body', commentBody], desc: 'enqueue via GitHub comment (/trunk merge)' },
  ];
  if (opts.trunkCliAvailable) {
    const cliArgs = ['merge', prRef];
    if (opts.priority) cliArgs.push('--priority', opts.priority);
    candidates.push({ cmd: 'trunk', args: cliArgs, desc: 'enqueue via trunk CLI' });
  }
  if (opts.trunkToken) {
    // REST fallback is executed specially by the CLI wrapper (curl with token);
    // represented here so callers/tests see the full ordered chain.
    candidates.push({ cmd: 'trunk-rest', args: [prRef], desc: 'enqueue via Trunk REST API' });
  }
  return { regime, deleteBranch: false, candidates };
}

// --- Landing classification ---------------------------------------------

export type LandStatus = 'landed' | 'ejected' | 'pending' | 'closed';

export interface ClassifyInput {
  /** PR state: OPEN | MERGED | CLOSED. */
  state: string;
  /** `gh pr view --json mergeCommit -q .mergeCommit.oid`, null if absent. */
  mergeCommitOid: string | null;
  /** True if `git branch -r --contains <headRefOid>` shows the base branch. */
  baseContainsHead: boolean;
  /** The Trunk/GitHub merge-queue check on the PR, if present. */
  queueCheck?: { name?: string; state?: string; bucket?: string } | null;
  /** Whether GitHub auto-merge is enabled (autoMergeRequest non-null). */
  autoMergeEnabled?: boolean;
}

const EJECTED_STATES = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'FAIL']);

/**
 * Decide whether a PR has landed. Uniform across all three regimes:
 *
 *   landed  = MERGED AND (mergeCommit.oid non-null OR base contains the head)
 *   pending = MERGED but SHA not yet visible (squash/rebase lag), or still in queue
 *   ejected = queue check failed/cancelled while PR is still OPEN
 *   closed  = CLOSED without merging
 *
 * The (oid OR baseContainsHead) guard handles rebase-merge repos where
 * mergeCommit.oid stays null — H3.
 */
export function classifyLand(input: ClassifyInput): { status: LandStatus; reason: string } {
  const state = (input.state || '').toUpperCase();

  if (state === 'MERGED') {
    if (input.mergeCommitOid || input.baseContainsHead) {
      return { status: 'landed', reason: 'PR is MERGED and the commit is on the base branch' };
    }
    return { status: 'pending', reason: 'PR is MERGED but the merge SHA is not visible yet (squash/rebase lag)' };
  }

  if (state === 'CLOSED') {
    return { status: 'closed', reason: 'PR was closed without merging' };
  }

  // state OPEN
  const cs = (input.queueCheck?.state || input.queueCheck?.bucket || '').toUpperCase();
  if (input.queueCheck && EJECTED_STATES.has(cs)) {
    return { status: 'ejected', reason: `merge-queue check reported ${cs}` };
  }

  return { status: 'pending', reason: 'PR is still open (in queue or merge pending)' };
}

// --- Handoff state (last-land.json) -------------------------------------

export interface LandState {
  schema_version: number;
  pr: number;
  sha: string;
  headRefOid: string;
  base: string;
  head_branch: string;
  repo: string; // owner/name
  regime: Regime;
  ts: string; // ISO 8601
}

export interface BuildLandStateInput {
  pr: number;
  sha: string;
  headRefOid: string;
  base: string;
  head_branch: string;
  repo: string;
  regime: Regime;
  /** ISO timestamp — injected so this stays pure/deterministic in tests. */
  ts: string;
}

/** Assemble a validated LandState. Throws if the landing SHA is missing. */
export function buildLandState(input: BuildLandStateInput): LandState {
  if (!input.sha) {
    throw new Error('refusing to write last-land.json with an empty merge SHA — landing not confirmed');
  }
  return {
    schema_version: LAND_STATE_SCHEMA_VERSION,
    pr: input.pr,
    sha: input.sha,
    headRefOid: input.headRefOid,
    base: input.base,
    head_branch: input.head_branch,
    repo: input.repo,
    regime: input.regime,
    ts: input.ts,
  };
}

export interface ConsumeExpectation {
  pr: number;
  repo: string;
  /** Max age in ms before the state is considered stale. Default 6h. */
  maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Validate a last-land.json the parent is about to consume. Guards against
 * stale-state-drives-wrong-deploy (H5): the file must be for THIS pr+repo,
 * recent, schema-compatible, and carry a non-null SHA.
 */
export function validateConsume(
  state: Partial<LandState> | null,
  expected: ConsumeExpectation,
  nowMs: number,
): { ok: boolean; reason?: string } {
  if (!state) return { ok: false, reason: 'no last-land.json found' };
  if (state.schema_version !== LAND_STATE_SCHEMA_VERSION) {
    return { ok: false, reason: `schema_version mismatch (got ${state.schema_version}, want ${LAND_STATE_SCHEMA_VERSION})` };
  }
  if (!state.sha) return { ok: false, reason: 'last-land.json has no merge SHA' };
  if (state.pr !== expected.pr) {
    return { ok: false, reason: `last-land.json is for PR #${state.pr}, not #${expected.pr}` };
  }
  if (state.repo !== expected.repo) {
    return { ok: false, reason: `last-land.json is for repo ${state.repo}, not ${expected.repo}` };
  }
  const ts = state.ts ? Date.parse(state.ts) : NaN;
  if (Number.isNaN(ts)) return { ok: false, reason: 'last-land.json has an invalid timestamp' };
  const maxAge = expected.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (nowMs - ts > maxAge) {
    return { ok: false, reason: `last-land.json is stale (${Math.round((nowMs - ts) / 60000)} min old)` };
  }
  return { ok: true };
}
