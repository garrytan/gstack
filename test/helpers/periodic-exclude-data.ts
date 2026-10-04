/**
 * Periodic-lane exclusions — LITERALS ONLY (own file, deliberately NOT in
 * touchfiles-data.ts: that file is evaluated standalone by map-diff against
 * old git versions, and its contract must not grow unrelated exports).
 *
 * The weekly periodic CI lane runs EVERY periodic-tier file (EVALS_ALL=1) so
 * tests can't rot invisibly — the coverage contract. A file lands here only
 * when running it weekly is KNOWN waste (documented-red or requires manual
 * hardware), and every entry must carry a tracking pointer with a re-entry
 * condition, so an exclusion is a decision with an owner, not a place tests
 * go to die. Pinned by test/periodic-exclude-policy.test.ts: entries must
 * name real files and carry non-empty reason + tracking.
 *
 * Removing an entry re-activates the file on the next weekly run — that IS
 * the re-entry mechanism.
 */
export const PERIODIC_CI_EXCLUDE: Record<string, { reason: string; tracking: string }> = {
  'test/skill-e2e-aside.test.ts': {
    reason: 'needs macOS with the Aside app open (asideAvailable()); CI runners are Linux, so every case self-skips',
    tracking: 'TODOS.md "CI-unrunnable paid evals" (re-entry: the CLI/device is available in the CI image; review by 2026-12-28)',
  },
  'test/skill-e2e-ios-device.test.ts': {
    reason: 'needs a physical iPhone over USB/devicectl — manual hardware, not a CI runner capability',
    tracking: 'TODOS.md "CI-unrunnable paid evals" (re-entry: the CLI/device is available in the CI image; review by 2026-12-28)',
  },
};

/**
 * Case-level exclusions for case-sharded files (`<file>#<case id>`), same
 * contract as above: a case lands here only when a CI runner cannot execute it
 * (it self-skips), with reason + tracking. The planner records each as an
 * excluded manifest entry instead of an empty case shard, so the exact
 * one-case check stays strict for every planned case. Pinned by
 * test/periodic-exclude-policy.test.ts.
 */
export const CASE_CI_EXCLUDE: Record<string, { reason: string; tracking: string }> = {
  'test/skill-e2e-design.test.ts#design-review-fix': {
    reason: '/design-review drives the Aside browser; CI runners are Linux without Aside, so the case registers test.skip("needs Aside")',
    tracking: 'TODOS.md "CI-unrunnable paid evals" (re-entry: the CLI/device is available in the CI image; review by 2026-12-28)',
  },
};

/**
 * Paid-eval verdict policy, pre-registered (v1 approved 2026-09-29; v2
 * approved 2026-10-04, D1 of docs/test-audit-2026-10.md). Frozen before the
 * census: any change after seeing census results needs Garry's re-approval
 * and a fresh census, and bumps `version` (every trial record carries it as
 * policy_version; readers score only their own version, so pass-rate history
 * segments at the change).
 *   v2          - series identity = the bytes a case owns (paid test file,
 *                 fixtures, its skills' prompt files) + HARNESS_VERSION
 *                 (scripts/harness-version.json), keyed with model and CLI
 *                 version; weekly history = scheduled main runs plus main
 *                 dispatches; only v2 trials count toward quarantine entry.
 *   panel       - behavior cases and quarantined cases run n independent
 *                 trials; a behavior panel PASSES at >= k passing trials with
 *                 no contract violation. Rule and judge cases run one trial.
 *   quarantine  - entry below `entry.rate` per trial over >= `entry.minTrials`
 *                 new-policy trials; exit at >= `exit.rate` over >=
 *                 `exit.minTrials`; at most `capFraction` of each tier's
 *                 blocking cases; an entry expires after `expiryWeeklyRuns`.
 *   judge       - a judge case draws `samples` independent samples of one
 *                 prompt concurrently; numeric dimensions gate on the panel
 *                 mean against the unchanged threshold, booleans on a strict
 *                 majority; an erroring sample fails the panel, never resampled.
 *   drift       - one-sided Fisher exact alarm between input-identity series
 *                 (Holm-controlled across the cases tested in one report).
 *   infraRedispatch - a census whose every red verdict is machine-classified
 *                 INFRA or INCOMPLETE may be re-dispatched this many times as
 *                 a new run; both runs are reported.
 */
export const EVAL_POLICY = {
  version: 2,
  panel: { n: 3, k: 2 },
  quarantine: {
    entry: { rate: 0.95, minTrials: 10 },
    exit: { rate: 0.97, minTrials: 10 },
    capFraction: 0.10,
    expiryWeeklyRuns: 8,
  },
  judge: { samples: 3 },
  drift: { fisherAlpha: 0.05, fisherMinPerSide: 6 },
  infraRedispatch: 1,
} as const;

/**
 * Quarantined paid cases, keyed by registry id (an E2E_TIERS key). A
 * quarantined case still runs its full panel and reports in every lane, but
 * its failed verdict cannot fail the lane unless the panel is a hard break
 * (0 of n) or a trial violated a contract; it never counts as passing
 * coverage. An entry needs the entry rule met on the current input identity,
 * a written diagnosis that the failures are detector, harness or model-latency
 * failures (a product defect is never quarantined), and unchanged case
 * touchfiles in the change that adds it. Pinned by
 * test/periodic-exclude-policy.test.ts.
 *   reason       - the written diagnosis, with the pass-rate evidence
 *   failureClass - what the diagnosis found; a product defect has no class here
 *   tracking     - issue or TODOS pointer
 *   owner        - who removes it
 *   enteredAt    - YYYY-MM-DD the entry landed (expiry counts weekly runs from here)
 *   exit         - the measurable exit condition
 * At most EVAL_POLICY.quarantine.capFraction of a tier's cases (gate and
 * periodic are the blocking tiers) may be quarantined at once.
 */
export const CASE_QUARANTINE: Record<string, {
  reason: string;
  failureClass: 'detector' | 'harness' | 'model-latency';
  tracking: string;
  owner: string;
  enteredAt: string;
  exit: string;
}> = {};
