<!-- AUTO-GENERATED from merge-and-deploy.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 4: Merge the PR

Enter only with Step 3.5 approval for this exact `PR_HEAD`. Record start time;
initialize `MERGE_ATTEMPT=none`, `MERGE_EXIT=0`, `MERGE_ERROR=''`, `WAITED=false`. Keep these values
across readbacks; never reset them to retry. Resolve `MERGE_METHOD` from Deploy
Configuration and `gh api "repos/$REPO" --jq '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}'`.
Prefer squash, then merge, then rebase when not configured. Disallowed/unknown
methods: **STOP** and ask. Set `MERGE_FLAG` to `--squash`, `--merge` or `--rebase`.
Run the following readback **before the first attempt**, after every attempt, and
while waiting. It is the only dispatcher; no command falls through to another merge.

### 4a-postfail: Post-failure PR-state check

**Universal invariant:** after ANY non-zero exit from `gh pr merge`, query authoritative
PR state before retrying or stopping. Do NOT retry blindly. Related: cli/cli#3442,
cli/cli#13380. `gh pr view` does not expose queue membership; use GraphQL for both
`autoMergeRequest` and `mergeQueueEntry`. Failed/unsupported/missing fields are unknown,
never evidence that a request or queue entry is absent.

```bash
READBACK=$(gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    state headRefOid baseRefName mergedAt mergeCommit { oid }
    autoMergeRequest { enabledAt } mergeQueueEntry { id state }
  } }
}' -f owner="${REPO%/*}" -f name="${REPO#*/}" -F number="$PR_NUMBER") || exit 1
printf '%s' "$READBACK" | jq -e '
  ((.errors // []) | length == 0) and
  (.data.repository.pullRequest | type == "object" and
    has("state") and has("headRefOid") and has("baseRefName") and has("mergeCommit") and
    has("autoMergeRequest") and has("mergeQueueEntry"))' >/dev/null || exit 1
PR_STATE=$(printf '%s' "$READBACK" | jq -er '.data.repository.pullRequest.state') || exit 1
CURRENT_HEAD=$(printf '%s' "$READBACK" | jq -er '.data.repository.pullRequest.headRefOid') || exit 1
CURRENT_BASE=$(printf '%s' "$READBACK" | jq -er '.data.repository.pullRequest.baseRefName') || exit 1
ACTIVE_REQUEST=$(printf '%s' "$READBACK" | jq -r '.data.repository.pullRequest | .autoMergeRequest != null or .mergeQueueEntry != null')
MERGE_ACTION=STOP
case "$PR_STATE" in
  MERGED)
    if [ "$CURRENT_HEAD" != "$PR_HEAD" ] || [ "$CURRENT_BASE" != "$BASE_BRANCH" ]; then
      MERGE_ACTION=MERGED_CHANGED
    else
      MERGE_ACTION=MERGED
    fi ;;
  OPEN)
    if [ "$CURRENT_HEAD" != "$PR_HEAD" ]; then
      MERGE_ACTION=HEAD_CHANGED
    elif [ "$CURRENT_BASE" != "$BASE_BRANCH" ]; then
      MERGE_ACTION=BASE_CHANGED
    elif [ "$ACTIVE_REQUEST" = true ]; then
      MERGE_ACTION=WAIT
    elif [ "$WAITED" = true ]; then
      MERGE_ACTION=STOP
    elif [ "$MERGE_ATTEMPT" = none ]; then
      MERGE_ACTION=START
    elif [ "$MERGE_ATTEMPT" = auto ] && [ "$MERGE_EXIT" -ne 0 ]; then
      case "$MERGE_ERROR" in
        *"Auto-merge is not allowed for this repository"*|*"Pull request is in clean status"*|*"Pull request is in unstable status"*) MERGE_ACTION=DIRECT ;;
      esac
    fi ;;
esac
printf '%s\n' "$MERGE_ACTION"
```

Readback failure or unknown state: **STOP**, preserve command errors and do not merge.
HEAD_CHANGED/BASE_CHANGED: invalidate the approval, **STOP** and return through Step 1
and readiness for the new target. MERGED_CHANGED: report the authoritative external
merge, but **STOP** cleanup/deploy/rollback until the changed head/base is reconciled;
the old scope/approval is unusable. Never replay it. WAIT goes to §4a. STOP surfaces the original stderr
and current state. **If `state == "CLOSED"`: STOP**, the PR closed without merging.

Only START makes the first attempt. Immediately before either merge command, repeat
readback and Step 1's local HEAD/branch/cleanliness check. Retargeting or local changes
invalidate readiness; `--match-head-commit` protects head, not destination.
```bash
MERGE_ATTEMPT=auto
MERGE_EXIT=0
MERGE_ERROR=$(gh pr merge "$MERGE_FLAG" --auto --delete-branch "$PR_NUMBER" --repo "$REPO" --match-head-commit "$PR_HEAD" 2>&1) || MERGE_EXIT=$?
```
Return to readback, even on exit 0. Only DIRECT permits **one direct fallback**:
readback has confirmed OPEN, no auto request and no queue entry, and the auto attempt
returned one of the two documented rejection classes: auto-merge disabled, or PR
already clean/unstable with nothing required pending. The latter does not mean
auto-merge is disabled. Recheck required CI as in Step 2 before the fallback; failures
or unknown check results stop, even if GitHub calls the PR mergeable.
```bash
MERGE_ATTEMPT=direct
MERGE_EXIT=0
MERGE_ERROR=$(gh pr merge "$MERGE_FLAG" --delete-branch "$PR_NUMBER" --repo "$REPO" --match-head-commit "$PR_HEAD" 2>&1) || MERGE_EXIT=$?
```
Return to readback. There is no fallback from a direct attempt. **Hard rule: never
replay a merge after MERGED**, or retry an unknown state/error. No `--admin` bypass.

**If `state == "MERGED"`:**

The server-side merge succeeded (possibly completed before the local cleanup phase failed, or a concurrent merge landed). Tell the user: "PR is merged on GitHub." (Do NOT say "the merge succeeded" — this handles the concurrent-merge case.)

Capture merge SHA:
```bash
MERGE_SHA=$(printf '%s' "$READBACK" | jq -er '.data.repository.pullRequest.mergeCommit.oid') || exit 1
```

Squash/rebase merge readback guard:
- Do **not** prove success by requiring the PR head SHA to be an ancestor of the base branch. GitHub squash and rebase merges deliberately create a new commit, so `git merge-base --is-ancestor <head_sha> origin/<base>` can fail even when the PR is merged.
- Once GitHub reports `state == "MERGED"` with a non-null `mergeCommit.oid`, treat that as authoritative. Record the merge SHA and continue.
- If local cleanup or readback is needed, fetch the base branch and compare/sync against the merge commit, not the old PR branch commit:
```bash
git fetch "https://github.com/$REPO.git" "$BASE_BRANCH"
git diff --quiet "$MERGE_SHA" FETCH_HEAD || git log --oneline --decorate -1 "$MERGE_SHA" FETCH_HEAD
```
- If the worktree is clean and only needs to stop looking diverged after a squash merge, prefer a named local branch at the merge commit, for example `git switch -c "codex/post-merge-pr-$PR_NUMBER" "$MERGE_SHA"`. Avoid detached HEAD in Codex Desktop worktrees because git action workers often expect `git symbolic-ref --short HEAD` to return a branch. Do not force-push or reset a user's branch unless they explicitly ask.

Worktree cleanup — non-destructive, candidate-based:
```bash
git worktree list --porcelain
```
Identify candidates: a worktree is stale if (a) it is checked out on the base branch, AND (b) it is not the user's current main working tree, AND (c) `git status --porcelain` inside it is empty (no uncommitted work).

- For each clean candidate: OFFER to remove it. Say: "There's a stale worktree at `<path>` checked out on `<branch>` with no uncommitted work. Remove it?" Remove only if user confirms (`git worktree remove <path> && git worktree prune`).
- If any candidate has uncommitted work: list the files, tell the user, and STOP worktree cleanup without removing anything.
- Do NOT use `--force`. Do NOT remove the user's primary working tree.

Remote-branch reconciliation: `--delete-branch` may not have completed. Verify the
branch outcome instead of claiming cleanup from a merge exit code:

```bash
# NB: gh leaves .headRepository.nameWithOwner EMPTY (verified against gh
# 2.83); compose owner/name from headRepositoryOwner.login + headRepository.name.
gh pr view "$PR_NUMBER" --repo "$REPO" --json headRepositoryOwner,headRepository,headRefName \
  --jq '"\(.headRepositoryOwner.login)/\(.headRepository.name)\t\(.headRefName)"'
git ls-remote --heads "https://github.com/<head-repository>.git" "<head-branch>"
```

Record the first field as `<head-repository>` (`owner/name`) and the second as
`<head-branch>`, then substitute both into `git ls-remote`. The PR head repository is
the authoritative branch location: for same-repository PRs it is the base repository;
for fork PRs it is the fork. Do not substitute the checkout's `origin`. If the metadata
lookup fails or either field is empty or contains a bare `/`, treat the branch state as
unknown and do not run the deletion path.

Three outcomes — never read a failed check as a clean branch:

- **Exit 0, empty output** — the remote branch is already gone (GitHub's post-merge deletion or a concurrent actor got there). Tell the user: "The remote branch has already been cleaned up." This makes re-runs of the recovery idempotent.
- **Exit 0, one ref line** — the branch survived: the failed merge command never reached its `--delete-branch` half. If `<head-repository>` is the BASE repository, OFFER deletion, confirm-first (matching the worktree-cleanup posture above): "The remote branch `<head-branch>` still exists in `<head-repository>` — the failed merge never ran its --delete-branch half. Delete it?" Only on confirmation: `git push "https://github.com/<head-repository>.git" --delete "<head-branch>"`. If `<head-repository>` is a FORK, do not offer deletion — the branch belongs to the contributor and the maintainer typically has no push rights there; report instead: "The branch lives on the contributor's fork `<head-repository>` — leaving it to them." If a local branch of the same name exists, offer `git branch -d "<head-branch>"` alongside (`-d`, never `-D` — a non-fast-forwarded local branch is the user's call).
- **Non-zero exit** — the check ITSELF failed (network, auth). Tell the user: "Couldn't verify remote branch state — leaving it alone." and skip the deletion offer entirely; a failed check is unknown state, not a clean branch.

Record the actual path (`auto`, `direct`, `queue`, or `external` when already merged
before our attempt), then continue to §4b (CI auto-deploy detection).

### 4a: Merge queue detection and messaging

**If `state == "OPEN"` and either request is non-null:** auto-merge is enabled or
merge queue is in use. Explain which is observed; an auto request alone does not
prove a queue. A queue reruns CI against the proposed merge. Record `MERGE_PATH=queue`
only when `mergeQueueEntry` was observed, otherwise `auto`.

Set `WAITED=true`. Repeat the readback every 30 seconds, up to 30 minutes; report progress every 2 minutes.
While OPEN with an active auto request **or** queue entry, keep waiting. Once waiting
has begun, never dispatch START or DIRECT: OPEN with confirmed absence of **both**
means removal/cancellation, so **STOP** and point to GitHub's checks/queue page.
MERGED returns to the merge-SHA/cleanup branch above. CLOSED, head change, failed
readback or timeout stops without replaying or cancelling the server-side request.
Explain that a timed-out active request may still merge later.

### 4b: CI auto-deploy detection

After the PR is merged, check if a deploy workflow was triggered by the merge:

```bash
gh run list --repo "$REPO" --branch "$BASE_BRANCH" --limit 10 --json databaseId,name,status,conclusion,workflowName,headSha
```

Look for runs matching `MERGE_SHA` and the deploy workflow identified before approval
(read its jobs, not just its name). Distinguish staging from production. If found:
- Tell the user: "PR merged. I can see a deploy workflow ('{workflow-name}') kicked off automatically. I'll monitor it and let you know when it's done."

If no deploy workflow is found after merge:
- Tell the user: "PR merged. I don't see a deploy workflow — your project might deploy a different way, or it might be a library/CLI that doesn't have a deploy step. I'll figure out the right verification in the next step."

If `MERGE_PATH=queue` and a deploy workflow exists:
- Tell the user: "PR made it through the merge queue and the deploy workflow is running. Monitoring it now."

Record merge timestamp, duration, and merge path for the deploy report.

---

## Step 5: Deploy strategy detection

Use the saved pre-merge scope and deployment facts; do not classify the cleaned-up
checkout. This skill observes existing deployment triggers, not invents new ones.

**One precedence rule for Steps 5-7:** an explicit verification URL or an actually triggered deployment takes precedence over a docs-only shortcut. Evaluate in order:

Select the production route below, then complete Step 5a **before executing that
route**. The docs-only no-deploy route can finish immediately; it needs no staging offer.

1. Matching deploy run/platform release: monitor it in Step 6, even for docs-only
   (it may be a docs site). A configured trigger whose run has not appeared remains
   pending; poll for the matching revision within Step 6's deadline, not another run.
2. Explicit `VERIFY_URL`: run Step 7 even for docs-only. Without deployment-revision
   evidence, report site health separately from whether this change is live.
3. `DOCS_ONLY=true`, no explicit URL, and no triggered/expected deployment: record
   SKIPPED (docs-only), then Step 9 with MERGED — NO DEPLOY NEEDED. Unknown deployment
   detection is not proof that nothing was triggered; use the question below instead.
4. Otherwise use configured production URL/status checks in Steps 6-7. If neither
   a usable URL nor deploy status exists, ask once. Also ask when Step 6 finishes
   without a production URL needed for canary:
   - **Re-ground:** "PR #NNN is merged. {Known deploy state}. I need a URL to check
     health; merge alone does not prove this revision is live."
   - **RECOMMENDATION:** A for a web app; B only when no deployment is required.
   - A) Provide the production URL → save it, continue to Step 7
   - B) No deploy needed (library/CLI) → Step 9, MERGED — NO DEPLOY NEEDED
   - C) Finish without verification → Step 9, use the evidence-based verdict table
   Offer B only with no observed or expected deploy; it cannot erase a running/failing deploy.

### 5a: Optional staging verification, not a deployment gate

For non-doc changes, offer this only when a staging/preview URL and successful
deployment record identify `PR_HEAD` (preview) or `MERGE_SHA` (post-merge staging).
A URL alone is insufficient. If unavailable, record staging N/A and take the
production route above. No staging trigger or promotion is executed here.

- **Re-ground:** "There is a deployment of this change at {staging URL}. I can check
  it too, but production may already be live; this does not hold or roll back production."
- **RECOMMENDATION:** A adds staging evidence without dropping production verification.
- A) Verify staging, then production
- B) Verify production only
- C) Verify staging only; leave production verification incomplete

A/C run Step 7 against the staging URL with `TARGET=staging`, preserving separate
staging and production evidence. Healthy staging sets `STAGING_STATUS=VERIFIED`:
A returns to the production route above; C goes to Step 9, STAGING VERIFIED —
PRODUCTION UNVERIFIED. On staging failures use Step 7's decision paths, never
automatically promote. B records SKIPPED and takes the production route.

---
