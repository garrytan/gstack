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
  'test/skill-e2e-ship-idempotency.test.ts': {
    reason:
      'documented-red: the PTY child sits at the Claude Code welcome screen for the full budget '
      + '(readiness/typing race vs CLI 2.1.x); never green since it was born in v1.63',
    tracking: 'TODOS.md "periodic tier — three documented-red tests need structural repair" (1 of 3 resolved: sidebar trio already deleted)',
  },
  'test/skill-e2e-brain-privacy-gate.test.ts': {
    reason:
      'documented-red: the artifacts-sync stop-gate preconditions do not survive the hermetic env '
      + 'even with per-test HOME/GSTACK_HOME injection; never green anywhere',
    tracking: 'TODOS.md "periodic tier — three documented-red tests need structural repair"',
  },
  'test/skill-e2e-ios.test.ts': {
    reason: 'requires a live iOS device/simulator toolchain (xcodebuild, devicectl) — manual hardware, not a CI runner capability',
    tracking: 'TODOS.md "skill-e2e-ios CI story" (device/runner decision)',
  },
};
