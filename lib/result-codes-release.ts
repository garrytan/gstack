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
  // GSTA-49 lane T1: merge trains in gstack-ship-queue (docs/ship-policy.md#run-a-merge-train).
  QUEUE_TRAIN_OFF: {
    anchor: 'queue-train-off',
    summary: 'the base revision’s .gstack/ship-policy.json declares no `train` block, so the merge-train surface is off and the per-PR queue applies',
    fix: 'use the per-PR queue (ready, stamp, verify), or land a `train` block with min_gstack_version on the base branch first',
  },
  QUEUE_TRAIN_UNTRUSTED: {
    anchor: 'queue-train-untrusted',
    summary: 'a PR’s head repository is not the base repository; fork work never runs in a train (the train branch and its dispatch carry repository secrets)',
    fix: 'leave the PR out of the train (gstack-ship-queue train build --prs <list without it>); fork work stays on the trusted-branch path',
  },
  QUEUE_TRAIN_MOVED: {
    anchor: 'queue-train-moved',
    summary: 'a PR’s head (or the train branch) is no longer the SHA the train pinned, so the train would not test what merges',
    fix: 'ask the lane for a fresh READY on the new head, then rebuild the train with the new pin (train build --prs <n>@<new sha>,...)',
  },
  QUEUE_TRAIN_CONFLICT: {
    anchor: 'queue-train-conflict',
    summary: 'merging a PR onto the previous prefix conflicts outside the version files and the CHANGELOG; nothing was dispatched and no branch pushed',
    fix: 'run the printed train build without that PR; the PR’s lane merges main (with the earlier PRs once they land) and reports READY again',
  },
  QUEUE_TRAIN_FREE_RED: {
    anchor: 'queue-train-free-red',
    summary: 'the free tests dispatched on train/<nonce> are red, missing, cancelled or ran on another SHA, so the paid gate was not dispatched',
    fix: 'read the free-tests run; a PR-caused red drops that PR (train build --prs <list without it>), a flaky one goes to its owner before the next build',
  },
  QUEUE_TRAIN_DISPATCH_UNKNOWN: {
    anchor: 'queue-train-dispatch-unknown',
    summary: 'a train dispatch was attempted but its run could not be found by nonce, so whether it started is unknown; it is never re-dispatched blindly',
    fix: 'run gstack-ship-queue train status --train <nonce>: it finds the run by nonce, or marks the dispatch absent so train build --train <nonce> may dispatch it',
  },
  QUEUE_TRAIN_WAITING: {
    anchor: 'queue-train-waiting',
    summary: 'the train is below its size and its oldest READY PR has waited less than the policy’s fill time, so it does not dispatch yet',
    fix: 'add READY PRs, rerun once the printed time has passed, or pass --urgent for a one-PR train',
  },
  QUEUE_TRAIN_PENDING: {
    anchor: 'queue-train-pending',
    summary: 'the train’s run (free tests, the full gate or the bisect) has not finished, so there is no verdict yet',
    fix: 'rerun the printed NEXT: command later; nothing is dispatched again while a run is pending',
  },
  QUEUE_TRAIN_INCOMPLETE: {
    anchor: 'queue-train-incomplete',
    summary: 'the train gate did not complete its census (INFRA or INCOMPLETE panels, an unbound, partial or cancelled shard, a slice killed before upload, or no published record), so it is never green',
    fix: 'when every gap is machine-classified INFRA or INCOMPLETE, take the one re-dispatch EVAL_POLICY.infraRedispatch allows (train rebuild --train <nonce> --infra) and report both runs; otherwise diagnose the run',
  },
  QUEUE_TRAIN_RED: {
    anchor: 'queue-train-red',
    summary: 'the train’s full gate is red on the train tree; its PRs do not merge, and nothing is retried to change the verdict',
    fix: 'bisect the red cases (train bisect --train <nonce> --spend-cap <usd>); after a rebuild’s second red, route the cases to a repair lane',
  },
  QUEUE_TRAIN_RED_ON_MAIN: {
    anchor: 'queue-train-red-on-main',
    summary: 'the bisect found the red cases red on every prefix, main (T0) included: main is broken, not the train’s PRs',
    fix: 'fix forward on main first (a one-PR train), then rebuild this train unchanged',
  },
  QUEUE_TRAIN_UNATTRIBUTED: {
    anchor: 'queue-train-unattributed',
    summary: 'the bisect pattern blames no PR and not main (all green, or not monotone); one trial cannot tell a flake from a break',
    fix: 'all green: the one preregistered rebuild (train rebuild --train <nonce>), reporting both runs; any other pattern: a repair lane, then a changed train',
  },
  QUEUE_TRAIN_BISECT_CAPPED: {
    anchor: 'queue-train-bisect-capped',
    summary: 'the bisect’s reserved price (every case×prefix trial, unknown costs at the policy reservation) passes the spend cap; completed prefixes are kept and the outcome stays unattributed',
    fix: 'resume with a higher cap (train bisect --train <nonce> --spend-cap <usd>); only prefixes without a result run',
  },
  QUEUE_TRAIN_PREFIX_INVALID: {
    anchor: 'queue-train-prefix-invalid',
    summary: 'a bisect prefix is not an ancestor of the train head on train/<nonce>, or a red case is not in the gate’s plan, so the bisect inputs are refused',
    fix: 'check that train/<nonce> still points at the recorded head (train status); a moved branch needs a new train',
  },
  QUEUE_TRAIN_REBUILD_REFUSED: {
    anchor: 'queue-train-rebuild-refused',
    summary: 'the rebuild is not allowed: the bisect was not all green, the train was already rebuilt (or re-dispatched), or there is no bisect or INFRA record',
    fix: 'route the red cases to a repair lane; the train is rebuilt only once the repair merges (a changed train)',
  },
  QUEUE_TRAIN_STAMP_MISMATCH: {
    anchor: 'queue-train-stamp-mismatch',
    summary: 'a stamped train prefix S_i is not the merge of S_(i-1) and its pin modulo stamps, or differs from the plain prefix T_i outside release paths, or could not be stamped; nothing was pushed',
    fix: 'read the named slot and files: a stamp hook writing product files is fixed in the hook; otherwise rebuild the train without that slot and report it',
  },
  QUEUE_TRAIN_TREE_MISMATCH: {
    anchor: 'queue-train-tree-mismatch',
    summary: 'main’s tree is neither the train’s prefix before this PR nor after it (modulo stamps), so the merge does not publish what the gate tested',
    fix: 'stop merging; if earlier PRs of the train merged, the queue is frozen (QUEUE_TRAIN_FROZEN); otherwise rebuild the train on current main',
  },
  QUEUE_TRAIN_STALE: {
    anchor: 'queue-train-stale',
    summary: 'every slot of this train already merged on GitHub and main is a prefix another train verified, so the record is stale; comparing today’s main to its prefixes proves nothing and does not freeze the queue',
    fix: 'settle the record with train prune --stale --train <nonce>; no backstop is needed',
  },
  QUEUE_TRAIN_FROZEN: {
    anchor: 'queue-train-frozen',
    summary: 'a train stopped partway through publication, so main holds a prefix no gate covered on its own; ordinary trains are refused until a repair lands',
    fix: 'admit one repair PR at its exact head (train build --repair --prs <n>@<sha>); the freeze clears when verify finds main’s tree after that merge in a green record',
  },
  // CREW rule 22 (Garry, 2026-10-25): /ship runs before every READY; the queue refuses a PR whose body has no current receipt.
  QUEUE_RECEIPT_MISSING: {
    anchor: 'queue-receipt-missing',
    summary: 'the PR body carries no valid /ship receipt, so the PR was never shipped through gstack and cannot be READY’d, admitted to a train or merged',
    fix: 'run /ship on the branch (unattended it writes the receipt into an open PR at HEAD with gstack-ship-receipt write --pr <n> --body …, else leaves it in .gstack/tmp/ship-receipt.md for the parent to post), then gstack-ship-queue ready again; there is no flag to skip this',
  },
  QUEUE_RECEIPT_STALE: {
    anchor: 'queue-receipt-stale',
    summary: 'the PR body’s /ship receipt is for another head than the one being READY’d or merged (a push after /ship, or a receipt copied from another PR)',
    fix: 'rerun /ship on the current head so the receipt names it, then gstack-ship-queue ready again; a slot’s stamp commit keeps the receipt written for its pinned head',
  },
  QUEUE_RECEIPT_DEPTH_RAISED: {
    anchor: 'queue-receipt-depth-raised',
    summary: 'the PR body’s /ship receipt records a review depth below the one its head needs (the queue recomputed it from git), or a current receipt records no review_depth at all',
    fix: 'run /ship on the head the READY names; the REVIEW_DEPTH line shows the receipt’s depth, the required depth, its reasons and inputs, and the receipt is left unchanged',
  },
  QUEUE_RECEIPT_EXCEPTION_INVALID: {
    anchor: 'queue-receipt-exception-invalid',
    summary: 'the PR body’s /ship receipt records an owner exception (docs or review loop) that is malformed, lacks the fix-check it follows, or whose line the body no longer carries verbatim',
    fix: 'restore the exception line in the PR body word for word, or run /ship again and record the owner’s acceptance with --docs or --review-loop-exception',
  },
  QUEUE_SCREEN_STALE_REF: {
    anchor: 'queue-screen-stale-ref',
    summary: 'GitHub’s refs/pull/<n>/merge is missing or still merges an older head than the PR’s: the PR conflicts with the base (a CHANGELOG-only conflict counts), so a screen dispatched on it would plan no cases and report success',
    fix: 'resolve the conflict with the base branch (or wait for GitHub to recompute the merge ref), push, then gstack-ship-queue ready --pr <n> --screen again; a lane never READYs on a screen that planned nothing',
  },
  QUEUE_SCREEN_NOT_RUN: {
    anchor: 'queue-screen-not-run',
    summary: 'the PR’s dispatched screen run concluded success but ran no slice (the run planned no cases: its route job found the PR head superseded by a push, or the plan selected nothing), so the head is not screened and the run is counted as not-run, never as green',
    fix: 'gstack-ship-queue ready --pr <n> --screen dispatches a fresh screen at the current head (a not-run screen is never followed); train build seats the pin unscreened and says so on its SCREEN: line',
  },
  QUEUE_TRAIN_STACK_RED: {
    anchor: 'queue-train-stack-red',
    summary: 'train build --dry-run --stack-tests ran a PR’s new test files on the integrated prefix that includes it (T<k>: main plus every slot up to that PR) and they failed; the tests pass on the PR head alone only because nothing before it in the train had changed what they read',
    fix: 'fix the PR’s tests against that prefix (read the STACK_TESTS: line for the files and the failing assertion), or reorder the train with --order so the PR they depend on comes first, then rerun the dry run; nothing was written, pushed or dispatched',
  },
  QUEUE_POST_MERGE_RED: {
    anchor: 'queue-post-merge-red',
    summary: 'a push workflow on the merged commit (free tests, the Windows subset, the main backstop) concluded failure, timed out or was cancelled after the train merged it; a neutral or skipped check is not red',
    fix: 'read the red run (gstack-ship-queue verify --post-merge <sha> prints one CHECK: line per workflow), repair on a new PR or roll back the merge; gstack-ship-queue train status names the freeze if the backstop filed one',
  },
  QUEUE_SCREEN_RED: {
    anchor: 'queue-screen-red',
    summary: 'the PR head’s dispatched screen run finished RED (its gate binding says so; a case that failed twice is real), so the head is not READY and a train will not seat it',
    fix: 'read the SCREEN_VERDICT line (gstack-ship-queue verify --pr <n> --screen prints the red and flaky cases), repair, push a new head, run /ship and ready again; a red screen is never re-dispatched at the same merge SHA',
  },
  READY_SCREEN_CHOICE_REQUIRED: {
    anchor: 'ready-screen-choice-required',
    summary: 'the base policy turns trains on, so READY needs an explicit screen choice: --screen (pay for a diff-relevant screen now) or --no-screen',
    fix: 'rerun gstack-ship-queue ready with the printed recommendation (--screen or --no-screen); say in the READY block if focused local cases already ran',
  },
  // Field list 2 W4 (pregate `timing`).
  PREGATE_TIMING_ASSERTION: {
    anchor: 'pregate-timing-assertion',
    summary: 'an added or changed test line compares an elapsed wall-clock or CPU time against a bound, or sleeps and then asserts (a warning, not a block)',
    fix: 'assert on the outcome, an injected clock or a forced deadline instead; when the bound is the contract, add `gstack-timing-ok: <reason>` in a comment on the line or the line above',
  },
  // Lane D (GSTA-112): the no-policy warning and the environment-cause verdict.
  PREGATE_NO_POLICY: {
    anchor: 'pregate-no-policy',
    summary: 'the repository has no pregate policy yet (no .gstack/pregate.json on the base branch and no user-owned file) and a touched file maps to no test lane; a warn, with a starter policy printed',
    fix: 'review the printed starter, write it with `gstack-pregate init`, edit the TODO entries, then commit .gstack/pregate.json on the base branch; from then on an unmapped file is PREGATE_NO_LANE',
  },
  PREGATE_ENVIRONMENT: {
    anchor: 'pregate-environment',
    summary: 'a check could not run because of the machine, not the diff: a runner or guard binary missing from PATH, a network error or quota refusal before any test ran, a full disk, or an unverified runtime; incomplete, never pass',
    fix: 'read the `environment:` line (kind and evidence), repair that on this machine or run the lane remotely (`--remote`, `gstack-pregate clear`), then rerun; a waiver cites the kind, never a test name',
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
  // The /ship review loop's finding scope (gstack-review-scope) and the receipt carry (gstack-ship-receipt carry).
  REVIEW_SCOPE_INPUT: {
    anchor: 'review-scope-input',
    summary: 'gstack-review-scope was given input it cannot classify: findings that are not a JSON array of objects, a --pass or --policy outside its values, or a pass 2+ call without --range-base',
    fix: 'pass the Step 9.3 findings as a JSON array (--findings <file> or stdin), --pass <n> from the invocation record, and from pass 2 on --range-base <sha> (HEAD at the start of the previous pass)',
  },
  REVIEW_SCOPE_RANGE: {
    anchor: 'review-scope-range',
    summary: 'gstack-review-scope could not read the diff it scopes findings against: the base or the range base does not resolve, or the range base is not an ancestor of HEAD',
    fix: 'fetch origin/<base>, check --range-base against the saved pass heads, and start a full pass (--pass 1) when history was rewritten',
  },
  RECEIPT_CARRY_REFUSED: {
    anchor: 'receipt-carry-refused',
    summary: 'gstack-ship-receipt carry could not carry the /ship receipt to HEAD: the PR body has no receipt, the working tree has uncommitted changes, the receipt head is not an ancestor of HEAD and the receipt records no tree to compare, or the product diff could not be compared',
    fix: 'commit or stash working-tree changes and rerun carry; when history was rewritten and the receipt predates head_tree, run /ship on the new head (merge the base in instead of rebasing next time)',
  },
  PROSE_LINT_FOUND: {
    anchor: 'prose-lint-found',
    summary: 'the prose /ship is about to publish (a CHANGELOG entry or a PR body) carries an AI tell a regular expression can decide',
    fix: 'rewrite each PROSE: line in the draft the way its hint says, then rerun gstack-prose-lint on the same file',
  },
  REVIEW_LOOP_EXCEPTION_INVALID: {
    anchor: 'review-loop-exception-invalid',
    summary: 'write --review-loop-exception got an exception that is malformed, follows no fix-check (review_loop.fix_checks is 0 or missing), names a fix-check head that is not the receipt head or its ancestor, or is missing from the PR body',
    fix: 'pass { accepted_by, date, via, reason, fix_check: { head, findings } } with the owner’s words, the --review-loop summary that counts the fix-check, and the printed "Review-loop exception: …" line in the body',
  },
  RECEIPT_CARRY_TREE_MISMATCH: {
    anchor: 'receipt-carry-tree-mismatch',
    summary: 'the branch was rebased or force-pushed since its /ship receipt, and HEAD\'s tree is not a tree the receipt covers, so no review saw this code',
    fix: 'run /ship on the new head; next time merge the base in instead of rebasing a reviewed branch (a rebase carries only onto a reviewed tree with the reviewed product diff)',
  },
  RECEIPT_CARRY_PRODUCT_CHANGED: {
    anchor: 'receipt-carry-product-changed',
    summary: 'the product diff against the base changed between the receipt\'s head and HEAD (a product file differs beyond a base merge, a test-only fix, release metadata or a regenerated output), so the reviewed verdict does not cover HEAD',
    fix: 'run /ship on the new head; the receipt carries only when every changed path is a test, release metadata, a registered output the pregate regen check proved, or the base merge, and the product patch-id is unchanged',
  },
  DOCS_AUDIT_BLOCKED: {
    anchor: 'docs-audit-blocked',
    summary: 'the documentation audit (/ship Step 14.5) is blocked: gstack-ship-receipt docs-caps found a declared doc cap over, or gstack-ship-receipt write was given a blocked audit with no owner exception and refused to record the ship as audited',
    fix: 'repair the audit (or trim the doc named by the DOCS_CAP: over line) and rerun Step 14.5; when the owner accepts the named risk, record it as docs.exception { accepted_by, date, via, reason } and carry the same line in the PR body\'s Documentation section',
  },
  RECEIPT_PROSE_MISMATCH: {
    anchor: 'receipt-prose-mismatch',
    summary: 'the PR body quotes a counter the ship receipt also records (review passes, deferred findings, gate case counts) with a different number, so the prose and the receipt disagree about the same run',
    fix: 'correct the body to the receipt\'s number (the PROSE: line names each field with both values); when the receipt is the stale one, rerun /ship so the receipt is rewritten from the run',
  },
  RECEIPT_CARRY_PREGATE_STALE: {
    anchor: 'receipt-carry-pregate-stale',
    summary: 'gstack-ship-receipt carry would rebind a receipt that records a pregate without a pregate result current for HEAD, so the carried receipt would claim the old tree\'s checks',
    fix: 'run gstack-pregate at HEAD (the remote tests stage when the policy requires it), then rerun carry with --pregate <pregate.json>',
  },
  RECEIPT_GIT_TOO_OLD: {
    anchor: 'receipt-git-too-old',
    summary: 'gstack-ship-receipt carry needs git 2.39 or later for `git patch-id --verbatim`; the installed git is older, so the product diff could not be compared',
    fix: 'upgrade git to 2.39 or later (the refusal names the installed version), then rerun carry; otherwise run /ship on the new head',
  },
  // Changelog fragments and the per-PR merge step (lib/changelog-fragments.ts, lib/ship-queue-land.ts).
  CHANGELOG_FRAGMENT_INVALID: {
    anchor: 'changelog-fragment-invalid',
    summary: 'a CHANGELOG fragment is not one regular .md file directly in the fragment directory with entry text, optional bump front matter and no release heading, or one of that name already landed with other text',
    fix: 'rewrite the named fragment as a flat <dir>/<slug>.md with only the entry text (and optional "bump: minor|major" front matter), rename it if the name already landed, then rerun',
  },
  QUEUE_LAND_LOCKED: {
    anchor: 'queue-land-locked',
    summary: 'another gstack-ship-queue land holds the repository land lock (refs/notes/gstack-land), so this one would race it for the next version',
    fix: 'wait for the holder named in the line to finish; if it crashed, gstack-ship-queue land --pr <n> --break-lock (refused while its journal shows a push in flight)',
  },
  QUEUE_LAND_CONFLICT: {
    anchor: 'queue-land-conflict',
    summary: 'the PR conflicts with the base branch in product files (or a release field cannot be resolved alone), so the merge step cannot stamp it',
    fix: 'the lane merges the base branch into the PR, resolves the named files, runs /ship and reports READY again',
  },
  QUEUE_LAND_DRIFT: {
    anchor: 'queue-land-drift',
    summary: 'the base branch moved between the merge step\'s last check and the squash merge, so main\'s tree is not the stamped tree land verified',
    fix: 'gstack-ship-queue land --pr <n> --repair opens a PR whose only change is a fragment for what the outside merge brought; /ship and land it, which releases the lock',
  },
  QUEUE_LAND_BASE_BUSY: {
    anchor: 'queue-land-base-busy',
    summary: 'the base branch moved during the stamp commit\'s CI on each of the allowed restamp attempts, so land stopped instead of restamping again',
    fix: 'find what is merging outside land (every merge should go through it), then rerun gstack-ship-queue land --pr <n>; it resumes from its journal',
  },
  // gstack-pr-wait (lib/pr-wait.ts): the landing-path PR watcher's two terminal codes.
  PR_WAIT_BLOCKED: {
    anchor: 'pr-wait-blocked',
    summary: 'the --until condition cannot be met without action: a check failed, the branch conflicts with its base, the PR closed, ready is blocked by unresolved threads or a BEHIND branch, GitHub stayed unreachable, or --timeout passed',
    fix: 'act on the event lines above it (fix the check, update or rebase the branch, resolve the threads), push, and start gstack-pr-wait again; after a timeout, start again with a larger --timeout or --timeout 0',
  },
  PR_WAIT_REFUSED: {
    anchor: 'pr-wait-refused',
    summary: 'the watcher did not start, or a local error stopped it before a verdict',
    fix: 'pass a PR number or URL the current gh login can read (--repo owner/name when the checkout is not that repository), stop the watcher the line names before starting another for the same PR, or fix the named local error',
  },
} as const satisfies Record<string, ResultCode>;
