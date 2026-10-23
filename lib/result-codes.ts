/**
 * Result codes for the unattended workflow commands (gstack-artifact,
 * gstack-gate, gstack-autoplan-timing, gstack-review-log --findings, the
 * skill-start guard line) and the install side (gstack-doctor --check,
 * gstack-capy-install, gstack-browser-ensure; the Bash side reads the same
 * table from the generated bin/gstack-doctor-components.sh). Sibling of lib/gate-outcomes.ts, whose `state`
 * enum is for gate outcomes only: a result code has no state, just one
 * stable anchor in docs/troubleshooting.md, a summary and a `fix:` clause.
 * Every error line a workflow command prints ends with `(<CODE>)` so a parent
 * agent greps the code, never the prose. test/troubleshooting-anchors.test.ts
 * checks every anchor exists; add a row here before printing a new code.
 */
import { RELEASE_RESULT_CODES } from './result-codes-release';
import { CAPY_RESULT_CODES } from './result-codes-capy';

export interface ResultCode {
  /** Stable `<a id>` in docs/troubleshooting.md. */
  anchor: string;
  /** What happened, in plain words; `<detail>` adds the real value. */
  summary: string;
  fix: string;
}

export const RESULT_CODES = {
  ARTIFACT_INVALID_JSON: {
    anchor: 'artifact-invalid-json',
    summary: 'the manifest or a JSON artifact is not valid JSON',
    fix: 'regenerate the run with the tool that writes it; never hand-edit a manifest',
  },
  ARTIFACT_UNSUPPORTED_VERSION: {
    anchor: 'artifact-unsupported-version',
    summary: 'the artifact declares a schema_version this gstack does not read',
    fix: 'run /gstack-upgrade on the consumer, or regenerate the run with this gstack',
  },
  ARTIFACT_SCHEMA: {
    anchor: 'artifact-schema',
    summary: 'a required field is missing or holds a value outside its enum',
    fix: 'compare the row with `gstack-artifact schema <name>` and regenerate it',
  },
  ARTIFACT_MISSING: {
    anchor: 'artifact-missing',
    summary: 'an artifact named by the manifest is not in the run directory',
    fix: 'copy the whole run directory, not single files; rerun the phase that writes the missing file',
  },
  ARTIFACT_STALE: {
    anchor: 'artifact-stale',
    summary: 'an artifact’s bytes no longer match the hash the manifest recorded',
    fix: 'treat the run as tampered or partially rewritten; regenerate it or re-bind the file through the tool that wrote it',
  },
  ARTIFACT_PATH_ESCAPE: {
    anchor: 'artifact-path-escape',
    summary: 'an artifact path resolves outside the run directory (a `..` segment, an absolute path or a symlink)',
    fix: 'keep every artifact inside the run directory and name it with a plain relative path',
  },
  ARTIFACT_MALFORMED_JSONL: {
    anchor: 'artifact-malformed-jsonl',
    summary: 'a JSONL artifact has a line (usually the tail) that is not one JSON object',
    fix: 'the writer was interrupted mid-append; rerun the phase that writes the file',
  },
  ARTIFACT_DUPLICATE_ID: {
    anchor: 'artifact-duplicate-id',
    summary: 'two rows share one id',
    fix: 'ids are run-bound and unique per file; regenerate the rows with the tool that assigns them',
  },
  ARTIFACT_UNBOUND_ID: {
    anchor: 'artifact-unbound-id',
    summary: 'a row id does not start with the run id',
    fix: 'ids are `<run>-...`; regenerate the row with the run id the manifest names',
  },
  ARTIFACT_DANGLING_REF: {
    anchor: 'artifact-dangling-ref',
    summary: 'a row references an id no artifact in this run defines',
    fix: 'write the referenced finding, decision or task first, or drop the reference',
  },
  ARTIFACT_DEPENDENCY_CYCLE: {
    anchor: 'artifact-dependency-cycle',
    summary: 'tasks depend on each other in a cycle',
    fix: 'break the cycle in `depends_on`; a lane cannot start a task that waits on itself',
  },
  ARTIFACT_COUNT_MISMATCH: {
    anchor: 'artifact-count-mismatch',
    summary: 'a count in run.json disagrees with the rows in the file it summarizes',
    fix: 'regenerate run.json after the last row was written; a count never replaces the file',
  },
  ARTIFACT_RUN_INTERRUPTED: {
    anchor: 'artifact-run-interrupted',
    summary: 'the run did not reach a terminal status or a reviewer never returned',
    fix: 'resume the run (`gstack-autoplan resume --out <dir>`) or treat its artifacts as partial',
  },
  ARTIFACT_REVIEWER_MISSING: {
    anchor: 'artifact-reviewer-missing',
    summary: 'a required phase or one of its voices has no terminal outcome or no bound output file',
    fix: 'finish the phase; a missing voice is missing coverage, never N/A by default',
  },
  ARTIFACT_GUARD_LINE_MISSING: {
    anchor: 'artifact-guard-line-missing',
    summary: 'an unattended run’s review-record.md does not state that the publication guard was not enforced',
    fix: 'start the run through gstack-skill-start so the GUARD_NOT_INSTALLED line is recorded',
  },
  GUARD_NOT_INSTALLED: {
    anchor: 'guard-not-installed',
    summary: 'this host does not execute the autoplan publication hook, so phase publication order is unverified',
    fix: 'nothing to do on this host; the run record carries this line, and the snapshot hashes per phase stand in for the guard',
  },
  REVIEW_STATUS_MISMATCH: {
    anchor: 'review-status-mismatch',
    summary: 'the review-log row claims a status or count that its findings file contradicts',
    fix: 'log through `--findings <file>` and let the row be derived; fix the findings file, not the claim',
  },
  GATE_REV_STALE: {
    anchor: 'gate-rev-stale',
    summary: 'the reply answers an older revision of the gate list',
    fix: 'render the current gate list, read it, and reply with its gate_rev',
  },
  GATE_REPLY_UNPARSED: {
    anchor: 'gate-reply-unparsed',
    summary: 'part of the reply matched no gate item or option, so nothing was applied',
    fix: 'reply with `rec`, `as-is`, `<id><option>` tokens (for example `d3b uc1a`), or `rec except <tokens>`; bare yes/no is ambiguous',
  },
  ANSWER_BY_REQUIRED: {
    anchor: 'answer-by-required',
    summary: 'an unattended gate answer named no valid answerer, so nothing was applied',
    fix: 'pass `--by human` when the owner typed the tokens, or `--by agent:<thread or id>` when an agent relays or decides; the value lands on every decision row as answered_by',
  },
  // PR A (multi-agent wave): gstack-doctor --check, gstack-capy-install, gstack-browser-ensure.
  COMPONENT_MISSING: {
    anchor: 'doctor-component-missing',
    summary: 'a component the selected workflow needs is not installed, not built or not current',
    fix: 'run the command in the row\'s fix clause, then re-run gstack-doctor --check',
  },
  RUNTIME_BELOW_MINIMUM: {
    anchor: 'doctor-runtime-below-minimum',
    summary: 'the Bun on PATH is absent, below gstack\'s security floor, or below its supported minimum',
    fix: 'install the supported Bun through setup\'s checksum-verified recipe (bin/gstack-capy-install does this on Capy), then re-run ./setup',
  },
  PROJECT_PIN_MISMATCH: {
    anchor: 'doctor-project-pin-mismatch',
    summary: 'the running Bun or Node is outside a version the target project pins (package.json engines, .tool-versions, .nvmrc, .bun-version or a CI workflow)',
    fix: 'install the pinned version for this platform (on Capy: run the gstack skill\'s `scripts/install.sh` without --check), or change the pin in the project',
  },
  REVISION_UNMET: {
    anchor: 'doctor-revision-unmet',
    summary: 'the installed gstack checkout is not at the revision --revision requested',
    fix: 'run /gstack-upgrade (or git -C <checkout> fetch && git checkout <ref>, then ./setup) to move the checkout',
  },
  RUNTIME_PIN_CONFLICT: {
    anchor: 'capy-install-runtime-conflict',
    summary: 'gstack\'s supported Bun minimum and the project\'s Bun pin cannot both be satisfied, so the installer changed nothing',
    fix: 'raise the project\'s pin to gstack\'s supported minimum, or install gstack on a machine whose Bun the project accepts',
  },
  BROWSER_UNAVAILABLE: {
    anchor: 'browser-ensure-failed',
    summary: 'Chromium could not be installed or launched by gstack-browser-ensure',
    fix: 'read the installer output above (offline, proxy, AppArmor); on Ubuntu 24.04+ try GSTACK_CHROMIUM_NO_SANDBOX=1, then re-run gstack-browser-ensure',
  },
  INSTALL_PREFLIGHT_FAILED: {
    anchor: 'capy-install-preflight-failed',
    summary: 'a tool the installer needs before ./setup (git, curl, node, jq) is missing, or the Bun install recipe failed its checksum',
    fix: 'install the named tool, then re-run bin/gstack-capy-install',
  },
  SETUP_PS1_EMPTY_ARGUMENT: {
    anchor: 'setup-ps1-empty-argument',
    summary: 'an argument given to .\\setup.ps1 is an empty string, which its Git Bash hand-off cannot carry, so nothing ran',
    fix: 'drop the empty argument or give it a value, then run .\\setup.ps1 again',
  },
  // C-stamp (plan C1, C2, C3, C5, C7): ship policy, restamp, tree receipt, ship receipt.
  POLICY_SOURCE_UNAVAILABLE: {
    anchor: 'policy-source-unavailable',
    summary: 'policy source unavailable: origin/<base> is not a resolvable commit, or a pin file committed on it cannot be read, so the reviewed .gstack/ship-policy.json cannot be read',
    fix: 'git fetch origin <base> --depth=1 (the working-tree copy is never used silently)',
  },
  POLICY_INVALID: {
    anchor: 'policy-invalid',
    summary: '.gstack/ship-policy.json has an unknown key, a wrong type or a value outside its enum',
    fix: 'run `gstack-ship-policy validate`, compare with `gstack-ship-policy init --explain`, and fix the file on the base branch',
  },
  POLICY_CONTAINMENT: {
    anchor: 'policy-containment',
    summary: 'a repo-controlled path, glob, command or list in the policy escapes the repository or exceeds its size cap',
    fix: 'use repo-relative paths without `..`, globs under 256 characters, lists under 64 entries and a release_tool under 512 characters',
  },
  POLICY_EXISTS: {
    anchor: 'policy-exists',
    summary: '.gstack/ship-policy.json already exists; nothing written',
    fix: 'edit the existing file, or pass --force to overwrite it',
  },
  REPO_COMMANDS_NOT_ALLOWED: {
    anchor: 'repo-commands-not-allowed',
    summary: 'repo commands not executed: the policy declares commands and this invocation did not opt in',
    fix: 'pass --allow-repo-commands (what /ship does), or run without the release tool',
  },
  QUEUE_STALE: {
    anchor: 'queue-stale',
    summary: 'the base SHA or queue order the allocation assumed has moved',
    fix: 'recompute with the printed command (gstack-restamp --next ... with the current --expect-base) before merging',
  },
  RESTAMP_VERSION_SOURCE: {
    anchor: 'restamp-version-source',
    summary: 'the configured version source is absent, ambiguous or broken at the base revision or on the branch',
    fix: 'create VERSION or pin .gstack/version-path; gstack never invents a version',
  },
  RESTAMP_MERGE_CONFLICT: {
    anchor: 'restamp-merge-conflict',
    summary: 'the gate-ahead merge of the branch and its predecessor conflicts; nothing written',
    fix: 'merge the predecessor into the branch under /ship Step 3’s conflict rules, then run --after again',
  },
  RESTAMP_RELEASE_TOOL_FAILED: {
    anchor: 'restamp-release-tool-failed',
    summary: 'the policy’s release_tool exited non-zero in the staging worktree; nothing written to the branch',
    fix: 'run the release tool by hand in the repo, fix it, and rerun gstack-restamp',
  },
  RESTAMP_OUTPUT_OUTSIDE_ALLOWED: {
    anchor: 'restamp-output-outside-allowed',
    summary: 'the release tool wrote a path outside the enumerated allowed-output set; nothing written to the branch',
    fix: 'list the path in `release_outputs` or `stamp_paths` on the base branch, or stop the tool from writing it',
  },
  RESTAMP_CONFLICT: {
    anchor: 'restamp-conflict',
    summary: 'a file to write or roll back no longer holds the bytes the journal recorded (a later edit); the restamp stopped',
    fix: 'inspect .gstack/tmp/restamp-journal.json, reconcile the file by hand, then rerun gstack-restamp',
  },
  RESTAMP_PREDECESSOR_MOVED: {
    anchor: 'restamp-predecessor-moved',
    summary: 'PREDECESSOR MOVED: the predecessor head the gate assumed is no longer that PR’s head',
    fix: 'gstack-restamp --after <pr> again and regate on the new synthetic tree',
  },
  CHANGELOG_DUPLICATE_HEADING: {
    anchor: 'changelog-duplicate-heading',
    summary: 'two CHANGELOG sections carry the same version heading',
    fix: 'merge the duplicate sections into one entry under the new version',
  },
  CHANGELOG_TOP_MISMATCH: {
    anchor: 'changelog-top-mismatch',
    summary: 'the first CHANGELOG entry is not the version being stamped',
    fix: 'move the PR’s entry to the top (gstack-restamp does this) or fix the heading to match VERSION',
  },
  CHANGELOG_SECTION_MISSING: {
    anchor: 'changelog-section-missing',
    summary: 'the CHANGELOG has no `[Unreleased]` or old-version section for this PR to re-head',
    fix: 'write the PR’s entry under `## [Unreleased]` (stamp-at-merge) and rerun',
  },
  GATE_REUSE_NOT_ELIGIBLE: {
    anchor: 'gate-reuse-not-eligible',
    summary: 'the earlier gate ran under a different identity (tree, runtime pins, lockfile, CI config, gate command or selection)',
    fix: 'rerun the named lanes on the final stamped tree with the printed command',
  },
  EVIDENCE_IDENTITY_UNKNOWN: {
    anchor: 'evidence-identity-unknown',
    summary: 'the evidence bundle lacks the execution identity (committed tree, runtime, lockfile or command hash) a reuse decision needs',
    fix: 'rebuild the bundle on the gate machine with `gstack-evidence bundle` after the lanes ran on a committed head',
  },
  EVIDENCE_BUNDLE_INVALID: {
    anchor: 'evidence-bundle-invalid',
    summary: 'the evidence bundle is not valid JSON or not the schema this gstack reads',
    fix: 'rebuild it with `gstack-evidence bundle`; never hand-edit a bundle',
  },
  PREREGISTRATION_NOT_ANCESTOR: {
    anchor: 'preregistration-not-ancestor',
    summary: 'a preregistration_shas entry is not an ancestor of HEAD',
    fix: 'rebase or merge so the preregistered commit is in the branch history, or remove the entry on the base branch',
  },
  HISTORY_POLICY_VIOLATION: {
    anchor: 'history-policy-violation',
    summary: 'the policy says history: merge-only and the plan squashes, rebases or rewrites the branch',
    fix: 'merge the base branch instead (git merge origin/<base>) and keep every commit',
  },
  RECEIPT_MISSING: {
    anchor: 'receipt-missing',
    summary: 'no ```gstack-ship-receipt``` block was found in the PR body',
    fix: 'write it with `gstack-ship-receipt write ... --pr <n>` (/ship Step 18) before reading it',
  },
  RECEIPT_INVALID: {
    anchor: 'receipt-invalid',
    summary: 'the ship receipt block does not validate against the ship-receipt schema',
    fix: 'regenerate it with `gstack-ship-receipt write`; never hand-edit the block',
  },
  // B-runner (gstack-autoplan, gstack-outside-voice, lib/spend-ledger.ts).
  EXECUTION_UNKNOWN: {
    anchor: 'execution-unknown',
    summary: 'an attempt was dispatched but never reached a terminal record, so the provider may have finished and charged',
    fix: 'submit the result file if the reviewer finished (`gstack-autoplan submit ... --attempt <id>`), or redispatch explicitly with `gstack-autoplan next --redispatch <id>`; nothing is redispatched automatically',
  },
  RUN_LOCKED: {
    anchor: 'run-locked',
    summary: 'another gstack-autoplan process owns this run directory',
    fix: 'wait for it to exit, or if its pid is gone run `gstack-autoplan resume --out <dir>` to take ownership',
  },
  RUN_NOT_INITIALIZED: {
    anchor: 'run-not-initialized',
    summary: 'the run directory has no run.json written by gstack-autoplan',
    fix: 'start with `gstack-autoplan next --plan <file> --out <dir>` (the first call initializes the run)',
  },
  PHASE_NOT_AWAITING: {
    anchor: 'phase-not-awaiting',
    summary: 'the submitted phase or voice is not waiting for a result',
    fix: 'run `gstack-autoplan status --out <dir>` and submit for the attempt `next` printed',
  },
  ATTEMPT_MISMATCH: {
    anchor: 'attempt-mismatch',
    summary: 'the attempt id does not name the open attempt for this phase and voice, or it was already submitted',
    fix: 'pass the attempt id `next` printed for this voice; a result is bound exactly once',
  },
  RESULT_RECEIPT_MISSING: {
    anchor: 'result-receipt-missing',
    summary: 'the result file does not start with the full-read receipt `INPUT: <phase> <snapshot sha256>` for this attempt',
    fix: 'the reviewer must read the prompt file through EOF and begin its result with the INPUT line the prompt names; a result for another snapshot is refused',
  },
  RESULT_FINDINGS_MISSING: {
    anchor: 'result-findings-missing',
    summary: 'the result file has no valid canonical findings block (a ```gstack-findings fence of JSONL rows)',
    fix: 'end the review with one ```gstack-findings fence, one JSON object per line with at least severity and title; `[]` rows are not findings, an empty fence means no findings',
  },
  MODEL_FAMILY_CONFLICT: {
    anchor: 'model-family-conflict',
    summary: 'the outside model is in the same family as the native reviewer, or its family is unknown',
    fix: 'pass `--model <id>` of a different family (anthropic, openai, google, xai, deepseek, qwen, zai, moonshot, meta, mistral); a same-family result is not an outside voice',
  },
  SPEND_CAP_EXCEEDED: {
    anchor: 'spend-cap-exceeded',
    summary: 'spent + reserved + the next estimate would exceed the spend cap',
    fix: 'raise `--spend-cap`, settle or release unsettled attempts, or stop; unknown charges count as their reservation',
  },
  CONSENSUS_MISSING: {
    anchor: 'consensus-missing',
    summary: 'a closed prior phase has no consensus record to include in the Eng dispatch',
    fix: 'resume the run so the phase closes through reconciliation; the Eng prompt is never sent without every prior phase summary',
  },
  OUTSIDE_RUNNER_UNAVAILABLE: {
    anchor: 'outside-runner-unavailable',
    summary: 'the selected outside-voice runner cannot run here (CLI missing, no API key, or no result file for host-subagent)',
    fix: 'install or log in the CLI (`gstack-codex-login` from OPENAI_API_KEY), set an API key for `--runner api`, or pass `--result <file> --model <id>` for `--runner host-subagent`',
  },
  // PR D (gstack-plan-reality check).
  REALITY_ROW_MISSING: {
    anchor: 'reality-row-missing',
    summary: 'a plan review carries no `REALITY:` line for an applicable reality row, or marks a tier 1 row n/a',
    fix: 'work the row (`gstack-plan-reality rows --phase <p>` prints its check) and emit `REALITY: <row> pass|finding <summary> <file:line>`; unattended, the phase is incomplete until it does',
  },
  REALITY_RECEIPT_MISSING: {
    anchor: 'reality-receipt-missing',
    summary: 'a `REALITY:` line names its row but carries no file:line or commit receipt',
    fix: 'cite where the check was made (`path:line`, `path:line-line` or a commit sha); a row without a receipt is a claim, not a row',
  },
  // C-pregate (plan C4, C6, C8): generated-file registry, issue links, the cheap pre-gate.
  REGEN_REGISTRY_INVALID: {
    anchor: 'regen-registry-invalid',
    summary: '.gstack/generated.json is not valid JSON, has an unknown key, a missing field or a duplicate id',
    fix: 'run `gstack-regen validate`, compare with `gstack-regen init --explain`, and fix the file on the base branch',
  },
  REGEN_CONTAINMENT: {
    anchor: 'regen-containment',
    summary: 'a registry glob escapes the repository or a command is not one line under 512 bytes',
    fix: 'use repo-relative globs without `..`, at most 64 per list, and a single-line command',
  },
  REGEN_STALE: {
    anchor: 'regen-stale',
    summary: 'a generated output differs from what its registered command produces (stale, or hand-edited)',
    fix: 'run the printed regen command and commit the outputs; never hand-merge a generated file',
  },
  REGEN_COMMAND_FAILED: {
    anchor: 'regen-command-failed',
    summary: 'a registered regen command exited non-zero in the scratch worktree',
    fix: 'run the command by hand in the repository, read its output, fix the generator or its inputs',
  },
  PREGATE_CONFIG_INVALID: {
    anchor: 'pregate-config-invalid',
    summary: 'the pregate policy (.gstack/pregate.json, or the user-owned copy) has an unknown key, a wrong type, a non-downgradable check in `warn`, or an uncontained glob',
    fix: 'run `gstack-pregate validate` and fix the file on the base branch (secrets and required lanes cannot be downgraded)',
  },
  PREGATE_SECRETS: {
    anchor: 'pregate-secrets',
    summary: 'gstack-redact found a HIGH or MEDIUM finding in the branch’s added lines',
    fix: 'rotate the credential, remove it from the added lines (git history included), then rerun; `secrets` cannot be downgraded',
  },
  PREGATE_STRAYS: {
    anchor: 'pregate-strays',
    summary: 'a file was added at the repository root or outside the usual directories (scratch, tmp, zz-*)',
    fix: 'delete the stray or move it under a tracked directory; declare an intentional root file in .gstack/pregate.json `strays.allow`',
  },
  PREGATE_LITERALS: {
    anchor: 'pregate-literals',
    summary: 'a changed exported constant’s old value still appears in the test tree (nightly- and Heavy-only files included)',
    fix: 'update every listed test to the new value, or keep the old constant; a nightly-only file is still a consumer',
  },
  PREGATE_NO_LANE: {
    anchor: 'pregate-no-lane',
    summary: 'a touched source file maps to no test lane through imports, repo-path literals, the bin/<name> convention or a declaration',
    fix: 'add a test that names the file, or declare its lane (or an explicit empty lane) under `dependencies` in .gstack/pregate.json. Markdown no test depends on is already a docs/no-tests empty lane; other documentation goes in `empty_lanes`',
  },
  PREGATE_LANE_FAILED: {
    anchor: 'pregate-lane-failed',
    summary: 'a local test lane the touched files select failed or ran zero tests under pipefail',
    fix: 'read the lane log, fix the in-branch failure, rerun `gstack-pregate --stage tests`; a `| tail`-hidden exit is still a failure',
  },
  PREGATE_INCOMPLETE: {
    anchor: 'pregate-incomplete',
    summary: 'a check timed out, its tool is unavailable, or the tree changed while it ran; the result is incomplete, never pass',
    fix: 'install the named tool or raise --timeout, keep the tree still during the run, then rerun the check',
  },
  PREGATE_STALLED: {
    anchor: 'pregate-stalled',
    summary: 'a test command printed nothing for the stall timeout, so its process group was killed; the check is incomplete, never pass',
    fix: 'read the lane log for the last file started, fix the hang, or raise `--stall-timeout` (`stall_timeout_s`; 0 disables) for a test that is quiet for longer, then rerun `gstack-pregate --stage tests`',
  },
  PREGATE_RECEIPT_INVALID: {
    anchor: 'pregate-receipt-invalid',
    summary: 'the receipt offered to `gstack-pregate clear` for the remote gate obligation does not show the tested tree passing',
    fix: 'rerun the remote gate on this tree and pass its output with `gstack-pregate clear --remote pregate.json/remote_gate --receipt <file>`, or run `gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands`',
  },
  PREGATE_STALE: {
    anchor: 'pregate-stale',
    summary: 'pregate.json was recorded against a different tree than the one being published',
    fix: 'rerun `gstack-pregate` after the final generation and stamp; publication needs results that are current',
  },
  PREGATE_REMOTE_UNCLEARED: {
    anchor: 'pregate-remote-uncleared',
    summary: 'a requires-remote lane obligation (a platform lane this machine cannot run) has no matching receipt',
    fix: 'dispatch the named workflow job, then pass its run id with `gstack-pregate clear --remote <workflow/job> --run-url <url>` (or an evidence bundle lane) before publishing',
  },
  ISSUE_UNREADABLE: {
    anchor: 'issue-unreadable',
    summary: 'an issue a closure trailer or --issue names could not be read through gstack-issue-guard, so its link is Refs, never Fixes',
    fix: 'check `gh auth status` and the issue number; rerun gstack-issue-links once the issue reads',
  },
  ISSUE_LOOKUP_FAILED: {
    anchor: 'issue-lookup-failed',
    summary: 'gstack-issue-links could not read the repository, this PR\'s author, the open PRs closing a fixed issue, or the flake issues naming a CI run, so Related or Flake lines may be missing or list the owner\'s own PRs',
    fix: 'check `gh auth status` and the repository (`--repo <owner/repo>`), pass `--author <login>` when gh runs as an app, then rerun gstack-issue-links; report the gap in the handoff if it still fails',
  },
  ISSUE_LINKS_MISSING: {
    anchor: 'issue-links-missing',
    summary: 'the PR body lacks a line gstack-issue-links wrote to issues.json, so the body and the ship receipt would disagree about what the PR closes or relates to',
    fix: 'paste every line gstack-issue-links printed under `## Issues` in the body, then rerun gstack-ship-receipt write; nothing was written',
  },
  // PR E (multi-agent wave): gstack-eval-plan, gstack-lane-check, gstack-evidence verify,
  // gstack-owner-brief, gstack-contributor-mode, gstack-banned-terms.
  PREREG_INCOMPLETE: {
    anchor: 'prereg-incomplete',
    summary: 'the preregistration file lacks a required section or a section is empty',
    fix: 'fill every section `gstack-eval-plan prereg --check` names (bars, arms, decoys, stop rules, held-out exposure) before any priced call',
  },
  EVAL_PRICE_MISSING: {
    anchor: 'eval-price-missing',
    summary: 'an arm names a model with no row in the price table, so its admission cannot be estimated',
    fix: 'add the model to lib/pricing.ts (provider page, USD per million tokens, as_of) or drop the arm; a $0 estimate is never an admission',
  },
  EVAL_DRY_RUN_FAILED: {
    anchor: 'eval-dry-run-failed',
    summary: 'the $0 stub-model dry run found an input or checklist problem (input shape, output budget, retry prompt)',
    fix: 'repair the named input rows or settings and rerun `gstack-eval-plan dry-run`; the pilot refuses to start on a failed dry run',
  },
  EVAL_ARMS_UNRESOLVED: {
    anchor: 'eval-arms-unresolved',
    summary: 'no eval arm could be resolved from the model policy or the repo policy document',
    fix: 'run `gstack-models resolve --role eval-arms`, or pass `--arms <model,model>` / `--policy-doc <file>` naming models in the price table',
  },
  EVAL_BUDGET_EXHAUSTED: {
    anchor: 'eval-budget-exhausted',
    summary: 'the pilot or run stopped because spent + reserved + unknown charges reached the cap',
    fix: 'read the spend table, settle or release open attempts, then raise `--cap` deliberately or stop; never rerun to make room',
  },
  LANE_CONFLICT: {
    anchor: 'lane-conflict',
    summary: 'a planned file is already changed by an in-flight branch or pull request',
    fix: 'assign the file one owner: wait for that PR, stack on its branch, or drop the file from this lane',
  },
  LANE_REF_UNAVAILABLE: {
    anchor: 'lane-ref-unavailable',
    summary: 'a branch or pull request named for the lane check could not be resolved',
    fix: 'fetch the branch (`git fetch origin <branch>`) or check `gh auth status`; an unresolved lane is reported, never assumed clear',
  },
  EVIDENCE_UNVERIFIED: {
    anchor: 'evidence-unverified',
    summary: 'a bundle claim could not be verified on this machine (tree moved, log missing, or the probe was not rerun)',
    fix: 'rerun the lane here with `gstack-evidence verify <bundle> --rerun`, or treat the claim as an imported assertion',
  },
  BANNED_TERM_FOUND: {
    anchor: 'banned-term-found',
    summary: 'the diff adds a banned term outside its allowed locations',
    fix: 'remove the term or move the text to a path `.gstack/banned-terms.json` allows for it',
  },
  BANNED_TERMS_INVALID: {
    anchor: 'banned-terms-invalid',
    summary: '`.gstack/banned-terms.json` is malformed or an allowed path escapes the repository',
    fix: 'keep `terms` a non-empty string list and every `allowed_paths` entry a plain repo-relative glob (no `..`, no absolute path)',
  },
  CONTRIBUTOR_SOURCE_UNAVAILABLE: {
    anchor: 'contributor-source-unavailable',
    summary: 'neither a `maintainers` list in .gstack/ship-policy.json nor the collaborators API could classify the PR author',
    fix: 'add `maintainers` to the ship policy, or run `gh auth login`; the review proceeds with contributor mode off and records the source',
  },
  BRIEF_INPUT_MISSING: {
    anchor: 'brief-input-missing',
    summary: 'the run directory lacks a file the owner brief renders from (gate.json, decisions.jsonl or findings.jsonl)',
    fix: 'finish the run to the gate (`gstack-autoplan next`) so the gate list and decisions exist, then render the brief',
  },
  DRAFT_DIRECTION_UNRESOLVED: {
    anchor: 'draft-direction-unresolved',
    summary: 'a `draft direction stands until the owner decides` line names a decision that is still pending',
    fix: 'answer the gate (`gstack-autoplan answer`) before closing; the close rewrites only decided lines',
  },
  PREGATE_GUARD_FAILED: {
    anchor: 'pregate-guard-failed',
    summary: 'a repo guard from .gstack/pregate.json whose files the branch touched exited non-zero',
    fix: 'run the guard command printed in the table, apply the guard\'s fix line, commit, then rerun `gstack-pregate run --allow-repo-commands`',
  },
  MIGRATION_COLLISION: {
    anchor: 'migration-collision',
    summary: 'a migration number this branch adds is already used on the base branch or by another open PR',
    fix: 'take the next free migration number when this PR is next to merge (rename the file and its id), commit, then rerun `gstack-pregate regate --against <gated-head> --bundle <file>`',
  },
  SEALED_OUTPUT_REFUSED: {
    anchor: 'sealed-output-refused',
    summary: 'a push or PR would publish sealed or eval output (a sealed path, a transcript, a quoted answer, a seed or a local home path) to a public or unknown destination, or the sealed policy is unreadable',
    fix: 'remove it from every published commit, or add one reviewed `rule<TAB>path<TAB>sha<TAB>reason` line to the base branch\'s .gstack/sealed-allow.tsv; a private destination sets sealed.visibility "private" in the base branch\'s .gstack/pregate.json',
  },
  EVAL_GATE_UNPRICED: {
    anchor: 'eval-gate-unpriced',
    summary: 'the paid gate has no call-plan file (no `--plan-file`, no base-policy `price_file`) or the file has no GSTACK_EVAL_CALLS lines, so its cost is unknown',
    fix: 'have the repo commit a call-plan file (docs/eval-calls.md) and set `price_file` in .gstack/pregate.json, or pass `--allow-unpriced "<reason>"` only on the owner\'s say-so',
  },
  EVAL_GATE_OVER_CAP: {
    anchor: 'eval-gate-over-cap',
    summary: 'the paid gate\'s priced total, or one call\'s reservation (input plus maximum output), is above the cap',
    fix: 'cut questions, arms or `max_out_tokens` in the call plan, or raise `--cap-usd` / `--smoke-cap-usd` deliberately with the owner; never split calls to slip under it',
  },
  EVAL_PLAN_STALE: {
    anchor: 'eval-plan-stale',
    summary: 'the call-plan file\'s binding does not match (a different gate command, a head behind HEAD, an input whose sha256 at HEAD differs) or the declared price_file is not in HEAD',
    fix: 'regenerate the call-plan file at HEAD for the exact gate command you are approving, commit it, and rerun `gstack-eval-plan price-gate`',
  },
  PLAN_SECTIONS_INVALID: {
    anchor: 'plan-sections-invalid',
    summary: 'the plan does not have exactly one non-empty `## Implementation plan` section followed by one `## Review record` section',
    fix: 'add the missing heading, or rerun the first `gstack-autoplan next` with --scaffold to review a scaffolded copy (your plan file is never edited); duplicate, reversed or empty sections are fixed by hand',
  },
  PLAN_AMEND_PENDING: {
    anchor: 'plan-amend-pending',
    summary: 'the owner accepted plan changes at the gate that the plan has not absorbed yet',
    fix: 'edit the plan, then `gstack-autoplan revise --out <dir> --plan <file> --incorporates <decision id,...>`; settle a packaging or ordering change with `gstack-autoplan revise --out <dir> --settle <id>`; or drop one with `gstack-autoplan revise --out <dir> --withdraw <decision id>`',
  },
  AMENDMENT_UNKNOWN: {
    anchor: 'amendment-unknown',
    summary: '`revise --incorporates` or `--withdraw` named a decision that is not a pending amendment (never accepted as a plan change, or already incorporated or withdrawn)',
    fix: 'name only the ids the refusal lists after `pending:`; with none pending, drop --incorporates and run `gstack-autoplan revise --out <dir> --plan <file>`',
  },
  AMENDMENT_NOT_SETTLEABLE: {
    anchor: 'amendment-not-settleable',
    summary: '`revise --settle` named an accepted change that needs a plan edit (its item changes scope, cost or direction, or names no packaging/ordering change), or the plan has edits no revise has recorded',
    fix: 'edit the plan, then `gstack-autoplan revise --out <dir> --plan <file> --incorporates <decision id>` (add `--settle <id>` to settle packaging/ordering changes in the same call); settle alone only on the plan the run already reviews',
  },
  GATE_REC_STALE: {
    anchor: 'gate-rec-stale',
    summary: 'a `rec` reply was rendered before `gstack-autoplan recommend` changed the recommendations it takes, or the gate predates `rec` (a gate.json without rec_rev, rendered when `all` left changes pending)',
    fix: 'render the gate again (`gstack-gate render <dir>/gate.json --all`), relay it, and answer with the printed `--rec-hash`',
  },
  CHECKPOINT_INVALID: {
    anchor: 'checkpoint-invalid',
    summary: 'no autoplan checkpoint generation can be restored: a manifest is unreadable, a listed file is missing, escapes the generation (by path or symlink) or does not match its sha256, or the staged run does not validate',
    fix: 'run `gstack-autoplan checkpoints --from <dir>` to see each generation\'s hash status and restore an intact one; nothing was written to --out',
  },
  CHECKPOINT_OVERLAP: {
    anchor: 'checkpoint-overlap',
    summary: 'the checkpoint directory and the run directory (or the restore target) are the same directory or one contains the other, symlinks resolved',
    fix: 'point GSTACK_AUTOPLAN_CHECKPOINT_DIR (or --from / --out) at a directory outside the run; nothing was moved or deleted',
  },
  CHECKPOINT_TARGET_EXISTS: {
    anchor: 'checkpoint-target-exists',
    summary: '`gstack-autoplan resume --from` restores only into an empty or missing --out directory',
    fix: 'pass a new --out directory, or resume the run already there without --from',
  },
  OWNER_REPLY_REQUIRED: {
    anchor: 'owner-reply-required',
    summary: 'an agent answered the gate (`--by agent:<id>`) without the owner\'s verbatim reply',
    fix: 'pass the owner\'s words exactly with `--owner-reply "<text>"`, `--owner-reply -` (stdin) or `--owner-reply-file <path>`',
  },
  GATE_OWNER_REPLY_MISMATCH: {
    anchor: 'gate-owner-reply-mismatch',
    summary: 'the owner\'s verbatim reply parses under the gate grammar but resolves to different choices than the relayed tokens',
    fix: 'relay exactly what the owner chose (or their reply itself, e.g. `--reply rec`); ask the owner when their words and the tokens disagree',
  },
  GSTACK_VERSION_CHANGED: {
    anchor: 'gstack-version-changed',
    summary: 'the run directory was written by a different gstack version',
    fix: 'nothing to do for an older run (journaled forward migrations ran); a run written by a newer gstack needs that gstack: upgrade with bin/gstack-upgrade',
  },
  ARTIFACT_GATE_UNSETTLED: {
    anchor: 'artifact-gate-unsettled',
    summary: 'the run says complete while an approval item of its last gate revision or an accepted plan amendment is still pending',
    fix: 'answer the gate until every approval settles and revise (or withdraw) every accepted change with `gstack-autoplan`; never hand-edit status',
  },
  // Field wave lane A (items 1-4): gstack-upgrade, the Capy skill bootstrapper, install admission.
  UPGRADE_REFUSED: {
    anchor: 'upgrade-refused',
    summary: 'bin/gstack-upgrade changed nothing: the checkout is dirty, diverged, pinned (detached or off the remote default branch), not a gstack checkout, or the incoming release holds',
    fix: 'resolve the named cause (commit or move the listed changes, check out the default branch), then re-run bin/gstack-upgrade; it never stashes or resets',
  },
  UPGRADE_BUSY: {
    anchor: 'upgrade-busy',
    summary: 'bin/gstack-upgrade changed nothing: another live session holds a workflow lease on this installation (bin/gstack-lease live), so moving the checkout would change gstack under it',
    fix: 'wait for those sessions to finish (bin/gstack-lease list names each pid and age), then re-run bin/gstack-upgrade; GSTACK_UPGRADE_FORCE=1 overrides when you know they are idle',
  },
  UPGRADE_FETCH_FAILED: {
    anchor: 'upgrade-fetch-failed',
    summary: 'bin/gstack-upgrade could not fetch the remote default branch, so it cannot tell whether the checkout is current',
    fix: 'check network access to the checkout\'s origin (git -C <checkout> remote -v), then re-run bin/gstack-upgrade',
  },
  REVISION_BELOW_MINIMUM: {
    anchor: 'revision-below-minimum',
    summary: 'the installed gstack revision is below the supported minimum declared in capy/support.env on the remote default branch',
    fix: 'run the Capy skill installer without --check (it fast-forwards a clean, unpinned checkout), or bin/gstack-upgrade; a pinned, dirty or diverged checkout is named in the row',
  },
  CAPY_WRAPPER_STALE: {
    anchor: 'capy-wrapper-stale',
    summary: 'the Capy skill copy that ran (or, without provenance, every Drive copy) is older than the checkout\'s GSTACK_CAPY_MIN_WRAPPER',
    fix: 'this session: run <checkout>/capy/skill/gstack/scripts/install.sh, which certifies; owner: copy <checkout>/capy/skill/gstack/ over the Drive skill folder (it recurs every session until the copy changes)',
  },
  BUN_RESOLUTION_DRIFT: {
    anchor: 'bun-resolution-drift',
    summary: 'the Bun the install verdict recorded for this checkout and project is gone, reports another version, or no longer satisfies the pins (or the Bun running is not it)',
    fix: 'run the fix the row prints: the installer, which records the current resolution or re-downloads a verified Bun into the store',
  },
  BUN_INSTALL_VERSION_INVALID: {
    anchor: 'bun-install-version-invalid',
    summary: 'GSTACK_BUN_INSTALL_VERSION names a Bun without a verified archive, or one below gstack\'s supported minimum',
    fix: 'unset GSTACK_BUN_INSTALL_VERSION, or set it to a version listed in GSTACK_BUN_VERIFIED (bin/gstack-bun-version.sh)',
  },
  INSTALL_UNVERIFIED: {
    anchor: 'install-unverified',
    summary: 'a Capy session (GSTACK_CAPY=1) has no passing install verdict for this checkout, HEAD and workflow, so the workflow refused to start',
    fix: 'run the Capy skill installer with --for <workflow> on this machine and launch with the GSTACK_LAUNCH line it prints',
  },
  // Fix wave 2026-10-15, PR 1a (items 7 and 11).
  BROWSE_TAB_UNRECOVERABLE: {
    anchor: 'browse-tab-unrecoverable',
    summary: 'every tab was closed outside browse and a new one could not be opened, because the browser or its context is gone',
    fix: 'run `browse restart` (`$B restart` in a gstack skill); `browse status` and `browse stop` keep working',
  },
  BUN_VERSION_UNREADABLE: {
    anchor: 'bun-version-unreadable',
    summary: 'bun --version did not print a version gstack can compare with the incoming release\'s Bun floor, so the update was held and nothing was changed',
    fix: 'reinstall Bun from https://bun.sh (bun upgrade may not run on a broken install), check that bun --version prints a version such as 1.4.2, then update again',
  },
  // #3197: the one Windows bash resolver (lib/script-invocation.ts) found no usable Git Bash.
  BASH_UNAVAILABLE: {
    anchor: 'bash-unavailable',
    summary: 'no Git Bash found to run gstack\'s bash scripts on Windows',
    fix: 'install Git for Windows (winget install --id Git.Git -e), or set GSTACK_GIT_BASH to its bash.exe for good: in PowerShell, [Environment]::SetEnvironmentVariable(\'GSTACK_GIT_BASH\', \'C:\\Program Files\\Git\\bin\\bash.exe\', \'User\') and restart Claude Code, or add it to the "env" block of ~/.claude/settings.json',
  },
  // Fix wave 2026-10-15, PR 3 (item 23, #1796).
  IOS_LAUNCH_ENV_INVALID: {
    anchor: 'ios-launch-env-invalid',
    summary: 'GSTACK_IOS_LAUNCH_ENV is set but is not a JSON object of string to string, or sets a GSTACK_ variable the debug bridge reserves, so the app was not launched',
    fix: 'set it to a JSON object such as GSTACK_IOS_LAUNCH_ENV=\'{"DEBUG_BRIDGE":"1"}\' (string values, no GSTACK_ keys), or unset it, then restart gstack-ios-qa-daemon',
  },
  // Fix wave 2026-10-15, PR 4 (item 17, #3182).
  OUTSIDE_VOICE_UNAVAILABLE: {
    anchor: 'outside-voice-unavailable',
    summary: 'a plan review ran without its second opinion: the outside provider did not run or failed, and the bounded native Plan reviewer was not offered or did not finish within five minutes',
    fix: 'repair the provider the line names (install it, or log in with `codex login`); for the native fallback use Claude Code 2.1.277 or later with background tasks enabled (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` unset), then re-run the review',
  },
  // Field list 2, W6: the public copy of an autoplan run.
  ARTIFACT_MACHINE_PATH: {
    anchor: 'artifact-machine-path',
    summary: 'a public copy of an autoplan run still contains a machine path the run recorded (its run directory, home, plan directory, checkpoint directory or worktree root)',
    fix: 'export with `gstack-autoplan export --out <run> --public <dir>`, which rewrites recorded roots in prose; a root inside a code span or fence in the plan is never rewritten, so edit the plan, revise, and export again',
  },
  ARTIFACT_PUBLIC_TARGET_EXISTS: {
    anchor: 'artifact-public-target-exists',
    summary: '`gstack-autoplan export --public <dir>` writes only into an empty directory or over an earlier public copy of the same run',
    fix: 'pass an empty or new --public directory, or the directory that already holds this run\'s public copy',
  },
  // Field list 2 (2026-10-16), W8: preregistered diagnostics run before the freeze commit.
  PREREG_DIAGNOSTIC_UNTESTED: {
    anchor: 'prereg-diagnostic-untested',
    summary: 'the declared summarizer, run on the declared synthetic fixture, did not report every preregistered diagnostic at its expected count',
    fix: 'fix the summarizer or the declared definition (expected count, fixture) until every PREREG_DIAGNOSTIC line says ok, then commit the freeze; never freeze a diagnostic the summarizer has not counted',
  },
  // Field list 2 (2026-10-16), W9: .gstack/eval-models.json.
  EVAL_MODELS_INVALID: {
    anchor: 'eval-models-invalid',
    summary: 'the eval model rules (.gstack/eval-models.json) are unreadable or invalid, so no arm can be checked',
    fix: 'fix what the line names (docs/eval-models.md: schema_version 1, a non-empty allow, optional deny, scopes and families newest first), or fetch the base branch; no arm passes until the rules parse',
  },
  EVAL_MODEL_DENIED: {
    anchor: 'eval-model-denied',
    summary: 'an arm names a model the eval model rules deny, or one no allow entry covers for its scope',
    fix: 'pick a model the rules allow for that scope (the EVAL_MODEL line names the rule), or change .gstack/eval-models.json in a reviewed PR',
  },
  EVAL_MODEL_OLD_GENERATION: {
    anchor: 'eval-model-old-generation',
    summary: 'an arm names an older generation of a model family the eval model rules order newest first',
    fix: 'use the newest id of the family the EVAL_MODEL line names, or reorder families in .gstack/eval-models.json in a reviewed PR',
  },
  EVAL_MODEL_GENERATION_UNRESOLVED: {
    anchor: 'eval-model-generation-unresolved',
    summary: 'the eval model rules declare families (newest generation only) and an arm names a model in none of them, so its generation cannot be checked',
    fix: 'add the model to its family in .gstack/eval-models.json (newest first) in a reviewed PR, or pick a model a family lists',
  },
  // #3226: gstack-error-capture (lib/dx-error-capture.ts) prints these; exit codes and recovery live there.
  DX_CAPTURE_USAGE: {
    anchor: 'dx-capture-usage',
    summary: 'gstack-error-capture arguments are malformed: an unknown flag, a flag missing its value, no `--`, or no command after it',
    fix: 'gstack-error-capture [--deadline <s>] [--max-bytes <n>] [--pass-env NAME,...] [--copy-config <path>] [--cwd <dir>] [--approved] [--launch-check] -- <cmd> [args]',
  },
  DX_CAPTURE_BAD_DEADLINE: {
    anchor: 'dx-capture-bad-deadline',
    summary: '--deadline is not a positive number of seconds (at most 3600, up to 3 decimals)',
    fix: '--deadline 20',
  },
  DX_CAPTURE_BAD_MAX_BYTES: {
    anchor: 'dx-capture-bad-max-bytes',
    summary: '--max-bytes is not an integer from 1 to 1048576',
    fix: '--max-bytes 65536',
  },
  DX_CAPTURE_BAD_PASS_ENV: {
    anchor: 'dx-capture-bad-pass-env',
    summary: '--pass-env names an invalid or unset variable, or one the containment owns (PATH, HOME, XDG_CONFIG_HOME, TERM, USERPROFILE)',
    fix: '--pass-env NAME with NAME set in the calling environment',
  },
  DX_CAPTURE_BAD_CWD: {
    anchor: 'dx-capture-bad-cwd',
    summary: '--cwd is not an existing directory',
    fix: '--cwd <existing directory> --approved',
  },
  DX_CAPTURE_APPROVAL_REQUIRED: {
    anchor: 'dx-capture-approval-required',
    summary: '--pass-env, --copy-config or --cwd was given without --approved; they hand the target credentials or real files',
    fix: 'ask the user to approve the named variables, files or directory, then add --approved',
  },
  DX_CAPTURE_CONFIG_REFUSED: {
    anchor: 'dx-capture-config-refused',
    summary: '--copy-config names a missing file, a symlink, a non-regular file, a path outside HOME, a duplicate, or a file over 1 MiB',
    fix: '--copy-config <regular file under $HOME, no symlinks>',
  },
  DX_CAPTURE_NOT_FOUND: {
    anchor: 'dx-capture-not-found',
    summary: 'the command does not resolve to an executable file; the record carries launch "not_found" and nothing ran',
    fix: 'install the command or pass its absolute path after --',
  },
  DX_CAPTURE_TEMP_DIR: {
    anchor: 'dx-capture-temp-dir',
    summary: 'the private 0700 containment directory under the gstack state root could not be created',
    fix: 'make $GSTACK_STATE_ROOT/error-capture a writable directory you own (not a symlink), then rerun',
  },
  DX_CAPTURE_CONTAINMENT_UNAVAILABLE: {
    anchor: 'dx-capture-containment-unavailable',
    summary: 'process-group or Windows job containment is unavailable on this platform; nothing ran',
    fix: 'run the capture on Linux, macOS or Windows with job objects available',
  },
  DX_CAPTURE_SUPERVISOR_FAILED: {
    anchor: 'dx-capture-supervisor-failed',
    summary: 'the deadline supervisor failed before reporting a result',
    fix: 'rerun the same command once; if it repeats, run bin/gstack-qa-deadline --help to check the supervisor',
  },
  DX_CAPTURE_INTERRUPTED: {
    anchor: 'dx-capture-interrupted',
    summary: 'the helper received SIGINT, SIGTERM or SIGHUP; the target group was killed and no record was printed',
    fix: 'rerun the same command without interrupting it',
  },
  DX_CAPTURE_REDACTION_FAILED: {
    anchor: 'dx-capture-redaction-failed',
    summary: 'the finished record still matched a secret check, so nothing was printed',
    fix: 'do not rerun with more --pass-env; report the command name to the gstack maintainers',
  },
  DX_CAPTURE_INTERNAL: {
    anchor: 'dx-capture-internal',
    summary: 'unexpected helper failure; the line names the error class and its first stack frame',
    fix: 'rerun once; if it repeats, report the printed frame to the gstack maintainers',
  },
  ...RELEASE_RESULT_CODES,
  ...CAPY_RESULT_CODES,
} as const satisfies Record<string, ResultCode>;

export type ResultCodeName = keyof typeof RESULT_CODES;

/** Alias kept for the doctor/installer side. */
export type ResultCodeId = ResultCodeName;

export const TROUBLESHOOTING_DOC = 'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md';

/** `(CODE; <doc>#anchor)` — the suffix the doctor and installer rows carry. */
export function resultCodeSuffix(code: ResultCodeName): string {
  return `(${code}; ${TROUBLESHOOTING_DOC}#${RESULT_CODES[code].anchor})`;
}

/** The installer form: `<context>: <summary>[ — <detail>]; fix: <fix> (<CODE>; <doc>#anchor)`. */
export function resultLineWithDocs(context: string, code: ResultCodeName, detail?: string): string {
  const row: ResultCode = RESULT_CODES[code];
  return `${context}: ${row.summary}${detail ? ` — ${detail}` : ''}; fix: ${row.fix} ${resultCodeSuffix(code)}`;
}

/** One error line: `<context>: <summary>[ (<detail>)]; fix: <fix> (<CODE>)`. */
export function resultLine(context: string, code: ResultCodeName, detail?: string): string {
  const row: ResultCode = RESULT_CODES[code];
  const what = detail ? `${row.summary} (${detail})` : row.summary;
  return `${context}: ${what}; fix: ${row.fix} (${code})`;
}
