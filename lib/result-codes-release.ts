/**
 * Result codes for the release path: gstack-ship-queue and the ship-policy
 * floor, pregate timing and its working-tree fingerprint, regen with missing
 * dependencies, approval classes and
 * the state-machine matrix. Kept beside lib/result-codes.ts (which spreads
 * this table into RESULT_CODES) so
 * the owner module stays within the module-size ratchet; the same rules apply:
 * one stable docs/troubleshooting.md anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const RELEASE_RESULT_CODES = {
  // Field list 2, W1: gstack-ship-queue and the ship-policy compatibility floor.
  POLICY_GSTACK_TOO_OLD: {
    anchor: 'policy-gstack-too-old',
    summary: 'the ship policy sets min_gstack_version above this gstack, so this gstack refuses to read it',
    fix: 'upgrade gstack (bin/gstack-upgrade, or the session install with --for <skill>) to the version named, then rerun',
  },
  QUEUE_NOT_READY: {
    anchor: 'queue-not-ready',
    summary: 'the lane is not ready to report: the working tree, HEAD or CI state does not match the pushed PR head',
    fix: 'commit and push the work (or wait for CI on that exact head), then rerun gstack-ship-queue ready',
  },
  QUEUE_PROOF_MISSING: {
    anchor: 'queue-proof-missing',
    summary: 'a proof input the queue step needs is missing or does not match (gated head, base, stamp journal, version or tree)',
    fix: 'supply the named input (fetch the gated head, pass the expected sha), or regate; nothing was written',
  },
  QUEUE_STAMP_NOT_STAMP_ONLY: {
    anchor: 'queue-stamp-not-stamp-only',
    summary: 'the stamp commit differs from the gated head by more than stamps, so the gate does not cover it',
    fix: 'inspect the printed residual paths; drop the stray edit, or run the gate again on the stamped head',
  },
  QUEUE_VERIFY_MISMATCH: {
    anchor: 'queue-verify-mismatch',
    summary: 'the coordinator could not reproduce the lane’s stamp claim: the PR head, the recomputed gate-ahead merge or the gated tree differs',
    fix: 'do not merge; ask the lane to rerun gstack-ship-queue stamp (or gate-ahead) on the current queue and report again',
  },
  QUEUE_GATE_MISSING: {
    anchor: 'queue-gate-missing',
    summary: 'the policy sets full_e2e and no passing full-gate record is bound to this tree',
    fix: 'run the gate the policy names (gstack-ship-queue gate-ahead, then --record) or pass the record of a passing run on this head',
  },
  GATE_AHEAD_ATTEMPT_INVALID: {
    anchor: 'gate-ahead-attempt-invalid',
    summary: 'the gate-ahead attempt is unknown, already recorded, or its worktree no longer holds the gated commit',
    fix: 'list attempts with gstack-ship-queue gate-ahead --list, then record the live one, or prepare a new attempt',
  },
  // Field list 2 W4 (pregate `timing`).
  PREGATE_TIMING_ASSERTION: {
    anchor: 'pregate-timing-assertion',
    summary: 'an added or changed test line compares an elapsed wall-clock or CPU time against a bound, or sleeps and then asserts (a warning, not a block)',
    fix: 'assert on the outcome, an injected clock or a forced deadline instead; when the bound is the contract, add `gstack-timing-ok: <reason>` in a comment on the line or the line above',
  },
  // Field list 2, W2 (approval classes) and W3 (state-machine round-trip matrix).
  APPROVAL_CLASSES_INVALID: {
    anchor: 'approval-classes-invalid',
    summary: '`.gstack/approval-classes.json` is malformed, a class matches nothing, or a path escapes the repository',
    fix: 'keep `classes` a non-empty list of uniquely named classes, each with `paths`, `patterns` or `migrations: true`, and every glob repo-relative (`gstack-approval-classes validate` checks the working-tree copy)',
  },
  APPROVAL_CLASS_FOUND: {
    anchor: 'approval-class-found',
    summary: 'the branch changes something a declared approval class covers',
    fix: 'get the owner\'s approval and put `Approved by <owner> <YYYY-MM-DD> via <plan sha|comment or review URL> for <class>@<digest12>` in the PR body, using the APPROVAL_SCOPE token the check printed',
  },
  APPROVAL_CITATION_MISSING: {
    anchor: 'approval-citation-missing',
    summary: 'a declared approval class has no citation that resolves and binds to its current effects, so no receipt was written',
    fix: 'add an `Approved by` line whose plan (with --approval-run <dir>) or maintainer comment names the APPROVAL_SCOPE token or the class and every effect path; for evidence gstack cannot read, attest it with `for <class>@<digest12>` on the line. Only the owner approves: never write the line without their approval',
  },
  APPROVAL_SOURCE_UNAVAILABLE: {
    anchor: 'approval-source-unavailable',
    summary: 'origin/<base> is not a resolvable commit, so the committed .gstack/approval-classes.json cannot be read and nothing was checked',
    fix: 'git fetch origin <base> (classes are never read from the working tree)',
  },
  STATE_MATRIX_INCOMPLETE: {
    anchor: 'state-matrix-incomplete',
    summary: 'the state-machines specialist output lacks a kind × owner action cell, maps a cell to a test that does not exist, or leaves an untested cell without a CRITICAL finding',
    fix: 'rerun the state-machines specialist on the same diff; its review coverage stays incomplete until gstack-state-matrix check passes',
  },
  // Fix wave 2026-10-15, PR 5 (item 10b, #3197).
  WTREE_UNAVAILABLE: {
    anchor: 'wtree-unavailable',
    summary: 'cannot fingerprint the working tree: bin/gstack-wtree could not start (on Windows, no Git Bash was found) or it ran and failed',
    fix: 'on Windows point GSTACK_GIT_BASH at Git Bash\'s bash.exe (Git Bash: export GSTACK_GIT_BASH=\'C:/Program Files/Git/bin/bash.exe\'; PowerShell: $env:GSTACK_GIT_BASH = \'C:\\Program Files\\Git\\bin\\bash.exe\'), or install Git for Windows (winget install --id Git.Git -e); elsewhere rerun ./setup so bin/gstack-wtree is present; then rerun gstack-pregate',
  },
  // Fix wave W5 (GSTA-31): pregate regen without installed dependencies.
  REGEN_DEPS_MISSING: {
    anchor: 'regen-deps-missing',
    summary: 'a regen command exited 0 with different outputs while package.json declares dependencies and node_modules is missing, so the outputs were not verified',
    fix: 'install the dependencies (the printed command, such as bun install), then rerun the check',
  },
} as const satisfies Record<string, ResultCode>;
