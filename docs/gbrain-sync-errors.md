# gbrain-sync error lookup

Every error message `gstack-brain-*` can print, with problem, cause, and fix.

Search this file by the prefix after `BRAIN_SYNC:` or by the binary name in
the command output.

---

## `BRAIN_SYNC: brain repo detected: <url>`

**Problem.** You're on a machine that has `~/.gstack-brain-remote.txt` (copied
from another machine) but no local git repo at `~/.gstack/.git`.

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

## `gstack-brain-init: ~/.gstack/.git is already a git repo pointing at <url>`

**Problem.** You tried to init with a remote URL that doesn't match the
existing one.

**Cause.** You already ran `gstack-brain-init` with a different remote.

**Fix.** Either:

- Use the existing remote: run `gstack-brain-init` without `--remote`, or
  with the matching URL.
- Switch remotes: `gstack-brain-uninstall` first, then re-init with the new
  URL. This does not delete your data.

---

## `Remote not reachable: <url>`

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

## `gstack-brain-init: failed to create or find '<name>'`

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
gstack-brain-init --remote git@github.com:YOURUSER/custom-name.git
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
   `gstack-brain-init` instead of restore — this creates a brand-new brain
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

**Fix.** Verify the URL. If it's correct, run `gstack-brain-init --remote
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
