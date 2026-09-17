# gbrain-sync error lookup

Every error message `gstack-brain-*` can print, with problem, cause, and fix.

Search this file by the prefix after `BRAIN_SYNC:` or by the binary name in
the command output.

---

## `BRAIN_SYNC: brain repo detected: <url>`

**Problem.** You're on a machine that has `~/.gstack-artifacts-remote.txt`
(or the legacy `~/.gstack-brain-remote.txt`, copied from another machine) but
no local git repo at `~/.gstack/.git`.

**Cause.** You've set up GBrain sync elsewhere and your gstack hasn't been
restored on this machine yet.

**Fix.**
```bash
gstack-brain-restore
```
This pulls the repo into `~/.gstack/` and re-registers merge drivers.

If you don't want to restore here, dismiss the hint with:
```bash
gstack-config set artifacts_sync_mode_prompted true
```

---

## `BRAIN_SYNC: blocked: <pattern-family>:<snippet>`

**Problem.** Sync stopped because the secret scanner detected credential-shaped
content in a staged file. The queue is preserved; nothing was pushed.

**Cause.** One of the pre-commit secret patterns matched the file contents —
likely an AWS key, GitHub token, OpenAI key, PEM block, JWT, or bearer token
embedded in JSON.

**Fix (three options).**

1. **If it's a real secret**: edit the offending file to remove the secret,
   then re-run any skill to retry sync.

2. **If the pattern is a false positive** (e.g., your learning contains a
   GitHub token pattern in an example string that you *want* to publish):
   ```bash
   gstack-brain-sync --skip-file <path>
   ```
   This permanently excludes the path from future syncs.

3. **If you want to abandon this sync batch entirely** (start fresh):
   ```bash
   gstack-brain-sync --drop-queue --yes
   ```
   This clears the queue without committing. Future writes will re-populate
   it normally.

---

## `BRAIN_SYNC: push failed: auth.`

**Problem.** Git push was rejected because your auth with the remote expired
or is missing.

**Cause.** The remote is unreachable with current credentials.

**Fix.** Refresh auth based on your remote:

- **GitHub**: `gh auth status` (then `gh auth refresh` if needed)
- **GitLab**: `glab auth status`
- **Other**: `git remote -v` + check SSH keys or credential helper

After fixing auth, run any skill to retry sync automatically.

---

## `BRAIN_SYNC: push failed: <first-line-of-error>`

**Problem.** Push failed for a reason other than auth. The first line of
git's error appears after the colon.

**Cause.** Could be network issue, rejected push (remote ahead), server 500,
or repo access revoked.

**Fix.** Look at `~/.gstack/.brain-sync-status.json` for more detail, or run:
```bash
cd ~/.gstack && git status && git push origin HEAD
```
to see git's full error. The queue is cleared after any push attempt, but
your local commit still exists — the next skill run will retry the push.

---

## `BRAIN_SYNC: push failed: diverged: <reason>`

**Problem.** The push was rejected and the automatic merge with the remote
failed. `<reason>` is `conflict in <paths>` (up to three), or
`merge failed: <git's message>` when git stopped before merging anything
(for example, local changes the merge would overwrite). A plain removal
against an edit is not reported here: it is resolved by keeping the edit.

**Cause.** Two machines changed the same file in ways the merge drivers can't
reconcile, or the working tree is not in a state git can merge into.

**Fix.** The merge was aborted and your commits are still local. The status
keeps saying so, with the reason, until they reach the remote:
```bash
cd ~/.gstack && git fetch origin && git merge origin/main
# resolve, commit, then:
git push
```
Push it yourself: a merge commit you make is yours, and syncs never push
commits that are not all their own.

---

## `BRAIN_SYNC: blocked: commit refused: <message>`

**Problem.** Git refused the sync commit, usually because of the pre-commit
hook in `~/.gstack/.git/hooks/pre-commit` or a signing failure.

**Cause.** The message after the colon is git's own first line.

**Fix.** The drain unstaged its changes and kept the queue, so nothing is
lost and nothing stays half-staged. Fix the cause (edit the file the hook
flags, or `gstack-brain-sync --skip-file <path>`), then run any skill.
Removals don't go through this hook. A hook written before removal support
(it scans removed text) only matters for manual `git rm` commits. Re-running
`gstack-artifacts-init` refreshes it.

---

## `BRAIN_SYNC: blocked: removal commit failed: <message>`

**Problem.** Git refused the commit that publishes removals. Removals skip
the pre-commit hook, so the usual cause is commit signing
(`commit.gpgsign`) failing. `gstack-brain-sync --publish-removals` reports
the same refusal as `commit failed (<message>); nothing published`.

**Fix.** Nothing was committed and the queue was kept. Fix the cause named
after the colon, then run any skill (or re-run `--publish-removals`).

---

## `BRAIN_SYNC: blocked: staged removals differ from the approved set`

**Problem.** With `artifacts_sync_removals` on, a sync found removals in the
index that it did not approve (someone staged them by hand), or a file it was
about to remove came back.

**Fix.** Nothing was committed. Check `cd ~/.gstack && git status` and
unstage what you don't want (`git reset -q HEAD -- <path>`). To publish a
removal the valves hold, use `gstack-brain-sync --publish-removals --yes
<path>`. Then run any skill.

---

## `queue empty; N local commit(s) not on the remote yet`

**Not an error by itself.** Commits exist locally that the remote does not
have yet, usually because a push was rejected or interrupted.

- `(retried every 10 minutes)`: all of them are gstack-brain-sync's own, and
  every run retries them (merging the remote's changes first) at most once
  per 10 minutes.
- `not all gstack-brain-sync's own: they go out with the next synced change`:
  a commit you made by hand is among them. Syncs never push it on their own;
  the next sync that commits something pushes everything. To send them now:
  `cd ~/.gstack && git push`.

If a retry's merge fails, the status says `diverged from the remote` instead
(see above).

---

## `N removal(s) held for review`

**Not an error.** With `artifacts_sync_removals` on, a removal that looks like
a loss rather than a cleanup is held (see "Deleted and moved files" in
`gbrain-sync.md`). Review and publish:
```bash
gstack-brain-sync --list-removals
gstack-brain-sync --publish-removals --yes [<path>...]
```
If the files were lost by accident, restore them instead:
`cd ~/.gstack && git checkout -- <path>`.

---

## `gstack: brain-sync push NOT sent — the egress receipt could not be written`

**Problem.** The push was refused before anything left your machine. Every
brain-sync push writes a tamper-evident receipt to the egress ledger
(`~/.gstack/security/egress.jsonl`) before sending, fail-closed. The
receipt could not be written, so nothing was sent, no local commit was
made, and the queue is preserved — the next run retries the whole drain.
`gstack-brain-sync --status` shows `EGRESS_RECEIPT_FAILED` as the failure
detail.

**Cause.** `~/.gstack/security/` is not writable (the receipt writer creates
it when missing, so absence alone is not the cause), the disk is full, or
`GSTACK_HOME` points at a read-only location.

**Fix.**
```bash
mkdir -p ~/.gstack/security && chmod -R u+w ~/.gstack/security
```
Then run any skill (or `gstack-brain-sync --once`) to retry. Inspect the
ledger with `gstack-egress list`; verify its hash chain with
`gstack-egress verify`.

---

## `gstack-artifacts-init: ~/.gstack/ is already a git repo pointing at: <url>`

**Problem.** You tried to init with a remote URL that doesn't match the
existing one. The command refuses to overwrite.

**Cause.** You already ran `gstack-artifacts-init` with a different remote.

**Fix.** Either:

- Use the existing remote: run `gstack-artifacts-init` without `--remote`, or
  with the matching URL.
- Switch remotes: `git -C ~/.gstack remote set-url origin <url>` (the
  command's own suggestion), or `gstack-brain-uninstall` first, then re-init
  with the new URL. Neither deletes your data.

---

## `Remote not reachable via SSH: <url>`

**Problem.** Init couldn't reach the git remote to verify connectivity.

**Cause.** Wrong URL, missing auth, network issue.

**Fix.** Test manually:
```bash
git ls-remote <url>
```
If that fails, check:
- URL spelling
- GitHub: `gh auth status`
- GitLab: `glab auth status`
- Private network / VPN / DNS

---

## `Failed to create or find '<name>'. Try --remote <url>.`

**Problem.** Auto-repo-creation via `gh repo create` failed and the repo
isn't discoverable via `gh repo view` either.

**Cause.** `gh` is unauthenticated, a repo with that name already exists
owned by someone else, or your GitHub account hit a quota.

**Fix.**
```bash
gh auth status
```
If unauth'd, run `gh auth login`. If the repo name collides, pass a different
name:
```bash
gstack-artifacts-init --remote git@github.com:YOURUSER/custom-name.git
```

---

## `gstack-brain-restore: ~/.gstack/.git already points at <url>`

**Problem.** You tried to restore from a URL that doesn't match the existing
git config.

**Cause.** Stale `.git` from a previous init with a different remote.

**Fix.** `gstack-brain-uninstall`, then re-run `gstack-brain-restore <url>`.

---

## `gstack-brain-restore: ~/.gstack/ has existing allowlisted files that would be clobbered`

**Problem.** You're trying to restore, but `~/.gstack/` already contains
learnings or plans that would be overwritten.

**Cause.** Either (a) this machine has accumulated state from a pre-sync
gstack session, or (b) a previous failed restore left partial state.

**Fix (three options).**

1. **If this machine's state should become the new truth**: run
   `gstack-artifacts-init` instead of restore — this creates a brand-new brain
   repo from this machine's state.

2. **If you want to adopt the remote and discard this machine's state**:
   back up `~/.gstack/projects/` first, then remove the offending files and
   re-run restore.

3. **If you want to merge**: there's no automatic merge for this. Manually
   copy learnings from `~/.gstack/` into your running gstack on a machine
   with sync already on, then restore here.

---

## `gstack-brain-restore: <url> does not look like a gstack-brain repo`

**Problem.** The clone succeeded but the repo is missing `.brain-allowlist`
and `.gitattributes`.

**Cause.** You pointed restore at a random git repo, or someone deleted the
canonical config files from the brain repo.

**Fix.** Verify the URL. If it's correct, run `gstack-artifacts-init --remote
<url>` to re-seed the canonical config.

---

## Nothing is syncing but I expect it to

**Not an error, but a common gotcha.** Check in order:

1. `gstack-brain-sync --status` — is mode `off`?
2. `~/.gstack/.git` exists?
3. `gstack-config get artifacts_sync_mode` — should be `full` or `artifacts-only`.
4. The file you expect to sync — is it in the allowlist?
   `cat ~/.gstack/.brain-allowlist`
5. Privacy class filter — if mode is `artifacts-only`, behavioral files
   (timelines, developer-profile) are intentionally skipped.

If all those look right, run:
```bash
gstack-brain-sync --discover-new
gstack-brain-sync --once
```
to force a drain.
