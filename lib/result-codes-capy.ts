/**
 * Result codes for gstack's Capy adaptations: the per-thread approval record
 * (gstack-approvals), the Captain brief (gstack-owner-brief render --captain),
 * PR screenshots (gstack-pr-shots) and the installer's launch file. Kept beside lib/result-codes.ts (which
 * spreads this table into RESULT_CODES) so the owner module stays within the
 * module-size ratchet; the same rules apply: one stable docs/troubleshooting.md
 * anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const CAPY_RESULT_CODES = {
  APPROVAL_RECORD_INVALID: {
    anchor: 'approval-record-invalid',
    summary: 'an approval row is missing a required field, holds a value outside its enum, or exceeds a length cap',
    fix: 'rerun gstack-approvals add with every required flag (--ask, --words, --scope, --by) inside the caps it names; nothing was written',
  },
  APPROVAL_RECORD_SECRET: {
    anchor: 'approval-record-secret',
    summary: 'a field of the approval row matched the secret scanner, so the row was refused and nothing was written',
    fix: 'record the words with the secret removed (write [redacted] in its place) or ask the person to restate them; the refusal names the field and rule, never the text',
  },
  APPROVAL_RECORD_NO_BRANCH: {
    anchor: 'approval-record-no-branch',
    summary: 'the approval record is kept per branch, and HEAD is detached or this is not a git repository',
    fix: 'check out the branch the work ships from, or pass --branch <name>',
  },
  APPROVAL_RECORD_UNAVAILABLE: {
    anchor: 'approval-record-unavailable',
    summary: 'no approval record exists on this machine and the state root is ephemeral with no Drive mirror, so an empty table could be a lost one',
    fix: 'restore the record (copy it back from the thread report, or run on the machine that holds it), or set up the Capy Drive mirror; the section says "Record unavailable" instead of "No approvals recorded"',
  },
  APPROVAL_RECORD_WRITE_FAILED: {
    anchor: 'approval-record-write-failed',
    summary: 'the approval record or its Drive mirror could not be written',
    fix: 'check the path and permission the line names (the state root must be writable), then rerun; a failed append wrote nothing',
  },
  APPROVAL_IMPORT_UNANSWERED: {
    anchor: 'approval-import-unanswered',
    summary: 'the autoplan run has no answered gate to import',
    fix: 'answer the gate first (gstack-autoplan answer ... --by human|agent:<id>), then rerun the import; it is idempotent, so a retry imports nothing twice',
  },
  CAPTAIN_BRIEF_INCOMPLETE: {
    anchor: 'captain-brief-incomplete',
    summary: 'the plan lacks one or more of the sections the Captain brief needs (ELI5 on a run whose gate carries it, Before → after, Why it matters, What caused this work, Big decisions), so the brief is not ready for approval',
    fix: 'add the named sections to the plan, revise the run if the plan is under review, and render again; --allow-incomplete prints a preview that still says it is not ready',
  },
  PR_SHOTS_INPUT_NOT_FOUND: {
    anchor: 'pr-shots-input-not-found',
    summary: 'a before/after input does not exist: the file, the base ref, the path at that ref, or the heading on both sides',
    fix: 'check the ref, path and heading the line names (gstack-pr-shots reads tracked files and repository-local captures only)',
  },
  PR_SHOTS_INPUT_REFUSED: {
    anchor: 'pr-shots-input-refused',
    summary: 'an input was refused before rendering: it matched the secret scanner, is binary, is too large, lies outside the repository and state root, or names an option-like ref',
    fix: 'remove the secret from the capture (the line names the side, line and rule, never the text), or point at a tracked text file inside the repository',
  },
  PR_SHOTS_IDENTICAL: {
    anchor: 'pr-shots-identical',
    summary: 'the before and after inputs are the same, so there is no change to picture',
    fix: 'pick the file or section this change actually touched (git diff --stat origin/<base>...HEAD lists them)',
  },
  PR_SHOTS_RENDER_FAILED: {
    anchor: 'pr-shots-render-failed',
    summary: 'a browser was available but rendering shot.html failed',
    fix: 'read the renderer transcript the line names; screenshot shot.html with your own browser at 880px width, or use the text fallback in text.md',
  },
  LAUNCH_FILE_UNWRITABLE: {
    anchor: 'capy-install-launch-file-unwritable',
    summary: 'the install passed but its launch file (the sourceable GSTACK_LAUNCH_FILE beside the verdict) could not be written, so the run is a fail: no caller is handed only the launch line to re-type',
    fix: 'make the verdict directory under the state root writable, or set GSTACK_STATE_ROOT to a writable directory, then re-run bin/gstack-capy-install',
  },
  PROJECT_FLOOR_UNMET: {
    anchor: 'project-floor-unmet',
    summary: 'the installed gstack is below the floor the project declares (min_gstack_version in its .gstack/ship-policy.json); the row is a WARN and the trailer stays ok, because a floor is a project rule, not a security minimum',
    fix: 'run the install command the row names (the Capy skill installer fast-forwards a clean checkout to origin in one step; gstack-upgrade elsewhere) before the first workflow, or lower the floor in the project',
  },
  PROJECT_NODE_PIN_UNMET: {
    anchor: 'project-node-pin-unmet',
    summary: "the Node on PATH does not satisfy the project's Node pin while every Bun pin is met; the pins row is a WARN and the trailer stays ok, because gstack runs on Bun and the project's own tests may select their Node (nvm, CI)",
    fix: "put a Node that satisfies the pin first on PATH (the Capy skill installer installs an exact pin into gstack's runtime store and launches it through the GSTACK_LAUNCH PATH), or change the pin in the project",
  },
  UPGRADE_SKIPPED: {
    anchor: 'upgrade-skipped',
    summary: 'the install-mode session was behind origin and its session-start fast-forward was skipped (dirty, diverged or pinned checkout, a live lease, or gstack-upgrade missing); the row is a WARN with the reason and the trailer stays ok with a behind= note, because a gap above the supported minimum is never a hard fail',
    fix: 'run the fix the row names (bin/gstack-upgrade after clearing its refusal, or the Capy skill installer) when the lane needs the newer gstack; below the supported minimum the bootstrapper fails revision instead',
  },
} satisfies Record<string, ResultCode>;
