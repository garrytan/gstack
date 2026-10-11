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
    fix: 'reply with `all`, `<id><option>` tokens (for example `d3b uc1a`), or `all except <tokens>`; bare yes/no is ambiguous',
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
    fix: 'install the pinned version for this platform, or change the pin in the project',
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
  // C-stamp (plan C1, C2, C3, C5, C7): ship policy, restamp, tree receipt, ship receipt.
  POLICY_SOURCE_UNAVAILABLE: {
    anchor: 'policy-source-unavailable',
    summary: 'policy source unavailable: origin/<base> is not a resolvable commit, so the reviewed .gstack/ship-policy.json cannot be read',
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
} as const satisfies Record<string, ResultCode>;

export type ResultCodeName = keyof typeof RESULT_CODES;

/** Alias kept for the doctor/installer side. */
export type ResultCodeId = ResultCodeName;

export const TROUBLESHOOTING_DOC = 'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md';

/** `(CODE; <doc>#anchor)` — the suffix the doctor and installer rows carry. */
export function resultCodeSuffix(code: ResultCodeName): string {
  return `(${code}; ${TROUBLESHOOTING_DOC}#${RESULT_CODES[code].anchor})`;
}

/** One error line: `<context>: <summary>[ (<detail>)]; fix: <fix> (<CODE>)`. */
export function resultLine(context: string, code: ResultCodeName, detail?: string): string {
  const row: ResultCode = RESULT_CODES[code];
  const what = detail ? `${row.summary} (${detail})` : row.summary;
  return `${context}: ${what}; fix: ${row.fix} (${code})`;
}
