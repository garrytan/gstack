/**
 * Result codes for gstack's Capy adaptations: the per-thread approval record
 * (gstack-approvals), the Captain brief (gstack-owner-brief render --captain),
 * PR screenshots (gstack-pr-shots), the installer's launch file and the Captain's pre-archive check and
 * issue close on land (gstack-archive-check; R86, R91). Kept beside lib/result-codes.ts (which
 * spreads this table into RESULT_CODES) so the owner module stays within the
 * module-size ratchet; the same rules apply: one stable docs/troubleshooting.md
 * anchor, a summary and a fix clause each.
 */
import type { ResultCode } from './result-codes';

export const CAPY_RESULT_CODES = {
  APPROVAL_RECORD_INVALID: {
    anchor: 'approval-record-invalid',
    summary: 'an approval row is missing a required field, holds a value outside its enum, or exceeds a length cap',
    fix: 'rerun the command this line names with the flag its detail names, inside its caps (gstack-approvals --help lists each command\'s flags); nothing was written',
  },
  APPROVAL_RULING_RUN_OPEN: {
    anchor: 'approval-ruling-run-open',
    summary: 'gstack-approvals rule ran on a checkout where a /ship run is open, with no --owner-ref, and a run\'s own runner never rules on its findings',
    fix: 'relay the owner\'s ruling with --owner-ref <thread code>:<message id or timestamp> --by <the owner> --words <their exact words>, or record it after the run stops; nothing was written',
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
  OWNER_ANSWERS_NO_DRIVE: {
    anchor: 'owner-answers-no-drive',
    summary: 'no owner Drive folder (user-<owner>) is mounted on this Capy machine, so there is no record to read or write',
    fix: 'run from a thread the owner owns, or pass --owner <name> for a mounted user-<name> folder; until then every ask goes to the owner',
  },
  OWNER_ANSWERS_AMBIGUOUS: {
    anchor: 'owner-answers-ambiguous',
    summary: 'more than one user-* Drive folder is mounted, so the owner is not known',
    fix: 'pass --owner <name> naming the owner whose record this is; nothing was read or written',
  },
  OWNER_ANSWERS_INVALID: {
    anchor: 'owner-answers-invalid',
    summary: 'a row, an ask file or a flag is missing a required value, holds a value outside its format, or exceeds a length cap',
    fix: 'rerun with the flags the help names (an action and target are one lower-case token each; scope is all, repo:<owner>/<name> or captain:<name>); nothing was written',
  },
  OWNER_ANSWERS_SECRET: {
    anchor: 'owner-answers-secret',
    summary: 'a field matched the secret scanner, so the row was not written',
    fix: 'remove the key, token or personal data from that field (the error names the field and rule, never the text) and rerun',
  },
  OWNER_ANSWERS_WRITE_FAILED: {
    anchor: 'owner-answers-write-failed',
    summary: 'the record directory could not be written',
    fix: 'check the path gstack-owner-answers status prints and its permissions, then rerun; a failed write removed its file, and an empty file left by a crash is named by status and must be removed',
  },
  OWNER_ANSWERS_NOT_FOUND: {
    anchor: 'owner-answers-not-found',
    summary: 'no row with that id is in the owner record',
    fix: 'gstack-owner-answers list --all shows every row id; rerun with one of them',
  },
  OWNER_ANSWERS_CONFLICT: {
    anchor: 'owner-answers-conflict',
    summary: 'a row for the same source, action, target and scope already records different words, author or limits, or the row named to supersede is already replaced',
    fix: 'check which words the owner actually said at that source; record a correction with supersede <row id> on the current row, never a second add',
  },
  OWNER_ANSWERS_SELF_VERIFY: {
    anchor: 'owner-answers-self-verify',
    summary: 'the actor that recorded a row tried to verify it',
    fix: 'a second actor reads the cited thread event and runs verify --by <its own name>; a row its recorder verified is never takeable',
  },
  OWNER_ANSWERS_NOT_TAKEABLE: {
    anchor: 'owner-answers-not-takeable',
    summary: 'a taken decision was logged against a row that cannot be taken',
    fix: 'send the ask to the owner instead (log it as asked); screen only proposes rows it can take, and the detail says why this one cannot',
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
  PIN_UNREASONED: {
    anchor: 'pin-unreasoned',
    summary: 'a Capy session start found the checkout more than 24 hours behind origin\'s default branch and pinned (GSTACK_CAPY_SELF_UPGRADE=off, GSTACK_CAPY_AUTO_UPGRADE=0, a detached HEAD or another branch) with no recorded reason, so it overrode the pin and fast-forwarded (R75)',
    fix: 'nothing when the pin was not deliberate; to keep a pin, record why: GSTACK_PIN_REASON=<why> for the session, or git -C <checkout> config gstack.pinReason "<why>"',
  },
  UPGRADE_SKIPPED: {
    anchor: 'upgrade-skipped',
    summary: 'the install-mode session was behind origin and its session-start fast-forward was skipped (dirty, diverged or pinned checkout, a live lease, or gstack-upgrade missing); the row is a WARN with the reason and the trailer stays ok with a behind= note, because a gap above the supported minimum is never a hard fail',
    fix: 'run the fix the row names (bin/gstack-upgrade after clearing its refusal, or the Capy skill installer) before the next workflow, since any behind= of 1 or more calls for it; below the supported minimum the bootstrapper fails revision instead',
  },
  PLAN_RECORD_MISSING: {
    anchor: 'plan-record-missing',
    summary: 'the PR body has no Plan: line, so the PR reads as Plan: required and nothing shows its plan step (GST-1751)',
    fix: "copy the brief's Plan line into the PR body with gstack-approvals render --plan \"<line>\": Plan: approved: <run id or row id>, or Plan: exempt: <reason>; then rerun",
  },
  PLAN_UNRESOLVED: {
    anchor: 'plan-unresolved',
    summary: 'Plan: approved: <token> (or a public repo\'s approved (record r-<id>)) names no approval row this machine can read, or a row that is a ruling or grant rather than a plan approval',
    fix: 'gstack-approvals import --autoplan <run dir> --by "<owner>" after the owner answered (or gstack-approvals add with their words for a plan approved outside /autoplan), then cite the run id or row id and rerun',
  },
  PLAN_NOT_APPROVED: {
    anchor: 'plan-not-approved',
    summary: 'the Plan line says required, or the cited plan row is pending or rejected, or its gate was answered in an agent\'s own words instead of the owner\'s',
    fix: 'finish the plan step: relay the gate to the owner through the Captain, answer it with their exact words (--owner-reply), import it, and cite the run; nothing was written',
  },
  PLAN_EXEMPT_UNKNOWN: {
    anchor: 'plan-exempt-unknown',
    summary: 'Plan: exempt: names a reason crew/docs/captain.md does not list (bug fix, s1, flaky, stamp, changelog-resolve, cap-repin, audited-list, read-only, or crew:<rule>)',
    fix: "use the exemption the brief names, spelled as listed; a change none of them covers is a feature: Plan: required",
  },
  PLAN_STORE_UNAVAILABLE: {
    anchor: 'plan-store-unavailable',
    summary: 'Plan: approved: needs the approval store, and this machine has neither the state root\'s approvals nor a Drive mirror, so missing cannot be told apart from unreadable',
    fix: 'run ready on the lane machine that imported the approval, or gstack-approvals sync there so the Drive mirror holds it; land checks the READY note and does not need the store',
  },
  QUEUE_PLAN_MISMATCH: {
    anchor: 'queue-plan-mismatch',
    summary: 'land found a READY note with no plan record, or a note whose Plan line differs from the PR body\'s, under plan_record: require',
    fix: 'the lane fixes the PR body\'s Plan line if needed and reruns gstack-ship-queue ready --pr <n> at the pin, which resolves the line and writes the record into the note',
  },
  ARCHIVE_READS_STALE: {
    anchor: 'archive-reads-stale',
    summary: 'the Capy reads handed to gstack-archive-check are older than 15 minutes (or dated in the future), so they may not show what the thread holds now',
    fix: 'rerun the archive program from crew/docs/captain.md#no-orphaned-work, which reads tools.thread.get and tools.issue.read again and stamps read_at with now(); nothing was archived',
  },
  ARCHIVE_READS_UNPARSED: {
    anchor: 'archive-reads-unparsed',
    summary: 'gstack-archive-check could not fully read the Capy reads (missing, empty or truncated output, or a line or state it does not know), so it cannot say the thread is clean',
    fix: 'pass the raw tools.thread.get result and the raw tools.issue.read text unedited and read every page of a multi-page issue list; tools.thread.get lists at most 20 PRs and cannot page, so a thread that has held more cannot be proven clean and stays unarchived; nothing was archived',
  },
  ARCHIVE_THREAD_MISMATCH: {
    anchor: 'archive-thread-mismatch',
    summary: 'the reads file holds another thread than --thread names',
    fix: 'read the thread you are archiving and pass its code to --thread; nothing was archived',
  },
  ARCHIVE_PR_NOT_MERGED: {
    anchor: 'archive-pr-not-merged',
    summary: 'gstack-archive-check landed was run on a PR GitHub does not report as merged, so no issue closes',
    fix: 'run it after gstack-ship-queue land prints MERGED for this PR; close nothing until then',
  },
  ARCHIVE_GH_READ_FAILED: {
    anchor: 'archive-gh-read-failed',
    summary: 'gh could not read a PR gstack-archive-check needs, or answered for another PR, so the check fails closed',
    fix: 'check `gh auth status` and the repository, then rerun (at most 2 times); if it still fails, leave the thread unarchived (or the issue open) and tell the Captain',
  },
  ARCHIVE_PR_STATE_UNKNOWN: {
    anchor: 'archive-pr-state-unknown',
    summary: 'gh pr view returned a PR state other than OPEN, CLOSED or MERGED (empty or unknown), so the PR may still be open and the check fails closed',
    fix: 'rerun once; if gh still prints that state, check `gh --version` and the PR on GitHub, leave the thread unarchived (or the issue open) and tell the Captain',
  },
  ARCHIVE_POLICY_UNREADABLE: {
    anchor: 'archive-policy-unreadable',
    summary: 'gstack-archive-check landed found no usable .gstack/plain-titles.json (missing, invalid or with no codes), so it cannot tell a tracker code from any other ref and closes nothing',
    fix: 'run it from the repository root, where .gstack/plain-titles.json lives; if the file is missing or invalid there, fix it on main (docs/ship-policy.md#plain-titles) and rerun; close nothing until then',
  },
  FIRST_USE_PLAN_UNREADY: {
    anchor: 'first-use-plan-unready',
    summary: 'the plan has no usable ### Day one table to freeze (missing, malformed, fewer than five complete rows, or a row still marked assumed)',
    fix: 'add or fix the ### Day one table (action, frequency, source, feature, route, first build, check) and confirm every assumed row with the owner, then run start again',
  },
  FIRST_USE_PLAY_SPEC_INCOMPLETE: {
    anchor: 'first-use-play-spec-incomplete',
    summary: 'the play spec is missing one or more of the ten parts every ask to play or try a build carries',
    fix: 'fill in the parts the line names in the play spec JSON (docs/first-use-check.md#play-spec), then run start again',
  },
  FIRST_USE_SAME_FAMILY: {
    anchor: 'first-use-same-family',
    summary: 'the checker is from the builder’s model family, its family is unknown, or a result was recorded by a model other than the run’s checker family',
    fix: 'name the builder and checker as provider/model ids from different families (for example anthropic/… and openai/…), and record results only from the checker',
  },
  FIRST_USE_NO_PRIVATE_DRIVE: {
    anchor: 'first-use-no-private-drive',
    summary: 'on Capy, the first-use record needs exactly one user-level Capy Drive folder (~/.capy/drive/user-*) and found none or several',
    fix: 'run it in a thread of the build’s owner, where his private user drive is mounted, or set GSTACK_FIRST_USE_DIR to his private folder; never fall back to the machine folder',
  },
  FIRST_USE_RECORD_INVALID: {
    anchor: 'first-use-record-invalid',
    summary: 'a first-use record input or file is invalid (bad flag value, unreadable manifest, a run outside the record root, bad evidence, or a write-once file that already exists)',
    fix: 'correct the value the line names; never edit or delete files in a run directory, start a new run instead',
  },
  FIRST_USE_REFUSED: {
    anchor: 'first-use-refused',
    summary: 'the build has not cleared its first-use check, so no "try this build" message or "v1 is ready" report may go out',
    fix: 'act on each reason the line lists: replay the failed or unplayed actions, rerun links within 15 minutes of sending, add the predicted score, or start a new run for a new build or changed day-one rows',
  },
} satisfies Record<string, ResultCode>;
