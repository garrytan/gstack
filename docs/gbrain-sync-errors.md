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

## `ARTIFACTS_SYNC: attention: ...` at skill start

**Problem.** The artifacts sync is stuck or partly stuck. Skill start prints
one fixed line per problem; `ok` and `idle` print nothing. Every line names
the absolute path of `gstack-brain-sync`; run it with `--status` to see the
cause, the held files and the fix.

| State | Trigger | Attention line (after `ARTIFACTS_SYNC: attention: `) | Fix |
|---|---|---|---|
| `held` | The secret scan held back flagged files and synced the rest | `status=held held=<N>. The secret scan is holding back <N> file(s); everything else still syncs. See which files and how to fix them: <bin> --status` | Edit the file so the scan no longer matches, or `<bin> --skip-file <path>` (permanent; undo with `--unskip-file <path>`) |
| `blocked` | A re-scan still flagged after the hold, so nothing was committed | `status=blocked. The secret scan flagged a file it could not hold back on its own, so nothing is syncing. See the fix: <bin> --status` | Edit or skip the files `--status` names, or clear the batch with `<bin> --drop-queue --yes` |
| `push_failed` | A commit is saved locally but the push failed | `status=push_failed. Synced files are committed locally but the push failed; it retries at skill start. See the cause: <bin> --status` | The fix `--status` names (usually `gh auth status`) |
| `error` | The drain stopped before committing and kept the queue | `status=error. The last sync stopped before committing; the queue is kept and retried. See the cause: <bin> --status` | The cause `--status` names: a git index lock, a commit hook, a `git add` failure |
| `unknown` | The status file holds a status code outside this table | `status=unknown. The sync status file is unreadable. See it: <bin> --status` | Run `<bin> --once` to rewrite it |
| stale-push | No push for 24 hours while the drain's `drainable` count is above zero | `stale-push. Files are ready to sync but nothing has been pushed for over 24 hours. See why: <bin> --status` | The waiting reason `--status` names (a coupled group waiting for a consistent generation, a `git add` failure) |
| stale-drain | `last_drain_at` older than 24 hours while the queue holds records | `stale-drain. The sync has not run for over 24 hours while files wait in the queue. See why: <bin> --status` | If no gstack process is running, remove `~/.gstack/.brain-sync.lock.d`, then run `<bin> --once` |

`<bin>` is the absolute path, for example
`~/.claude/skills/gstack/bin/gstack-brain-sync`. The source of truth is the
usage header of `bin/gstack-brain-sync`; skill start's tests are generated
from it.

**Held files.** When the secret scan flags a file, only that file is held
back (with any file coupled to it, such as a decision log and its active
snapshot); everything else syncs. The held file stays queued and is
re-scanned on every sync, so editing it clears the hold automatically.
`--status` lists each held file under `held`, with the scanner rule that
matched (never the matched text), the files held with it (`dependents`) and
both fixes:

1. **If it's a real secret**: edit the file to remove it. The next skill run
   re-scans and syncs it.
2. **If the match is a false positive** you never want synced:
   ```bash
   ~/.claude/skills/gstack/bin/gstack-brain-sync --skip-file <path>
   ```
   This permanently excludes the path from future syncs (for a coupled file,
   the files coupled with it stop too). To undo it and queue the path again:
   ```bash
   ~/.claude/skills/gstack/bin/gstack-brain-sync --unskip-file <path>
   ```
3. **To abandon the whole batch** (start fresh):
   ```bash
   ~/.claude/skills/gstack/bin/gstack-brain-sync --drop-queue --yes
   ```

**Git index lock.** A git process killed mid-write leaves
`~/.gstack/.git/index.lock`. The sync removes it once it is older than 10
minutes, because every gstack writer to `~/.gstack` takes the same sync lock
first. A younger lock means a git process is running there; the sync reports
`error` and retries at the next skill start.

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

## `database host unreachable (<code> <host>); your gbrain config is unchanged. Fix: check network or VPN, then re-run /sync-gbrain.`

**Problem.** `/sync-gbrain` skipped the code, memory and dream stages, or
`/setup-gbrain` reported `gbrain_local_status: db-unreachable`.

**Cause.** gbrain could not reach the database named in `~/.gbrain/config.json`
because of a network error (`ENOTFOUND` / `EAI_AGAIN` in an offline sandbox, a
VPN that is down, a refused or timed-out connection). Nothing is known to be
wrong with the config, so gstack leaves it alone and keeps brain-aware skill
blocks rendered, the same way it treats a slow `timeout`.

**Fix.** Restore network access (or the VPN), then:
```bash
/sync-gbrain
```
Do not move `~/.gbrain/config.json` aside; that remediation is only for
`broken-db` / `broken-config`.

---

## `[memory-ingest] ERR: gbrain import accounted for N-1 of N staged page(s) ... Refusing to advance state` on every run (a `.claude`-style project)

**Problem.** Before this release, ingest refused every batch that held a page
from a project whose slug starts with a dot (for example `.claude`), on every
run.

**Cause.** gbrain's import walker skips every path segment that starts with a
dot, so the staged page was never collected.

**Fix.** Nothing to do after upgrading: such slugs now stage as `dot-claude`,
and state recorded under the old name maps to the new one. Run
`/sync-gbrain` once to import the pages that were stuck.

---

## `[memory-ingest] FAILED <path>: <error> (left un-stamped; retried next run)`

**Problem.** gbrain refused one staged page during `/sync-gbrain`'s memory
stage (for example invalid frontmatter or an oversize page).

**Cause.** `gbrain import` named the page as a per-file failure (in its
`--json` `failures` list or a `Skipped <path>:` line). Before this release,
such pages were marked ingested and never retried.

**Fix.** Nothing is lost: the page is not marked ingested and is retried on
every run. If the same page keeps failing, read the error, fix the source
file it came from, then run `/sync-gbrain`.

---

## `[memory-ingest] re-queued <slug>: not found in gbrain source <id> after import (retried next run)`

**Problem.** gbrain said a page was imported (or unchanged), but the landing
check could not find it in the source it was imported into, or found
different content.

**Cause.** Usually a managed import that was accepted but is still
publishing (`Pending:` in gbrain's output), or a page gbrain skipped without
naming it.

**Fix.** Nothing to do; the next `/sync-gbrain` imports it again. If it
repeats on every run, upgrade gbrain (`gstack-gbrain-install`).

---

## `[memory-ingest] ERR: gbrain reported N failure(s) it did not attribute to a staged page ... Refusing to advance state.`

**Problem.** The memory stage failed and marked nothing ingested.

**Cause.** gbrain counted failures it did not name (it stops printing them
after five of the same kind), so gstack cannot tell which pages landed.

**Fix.** Re-run `/sync-gbrain`. After three refused runs the batch is split
in halves automatically to find the page gbrain cannot import; that page is
quarantined (next entry) and the rest import.

---

## `[memory-ingest] quarantined <slug> (<source path>): gbrain refuses every batch that contains it (...)`

**Problem.** One page kept making gbrain refuse the whole batch.

**Cause.** After three refused batches, gstack imported the batch in halves
until it isolated the page. Every other page was imported.

**Fix.** The page is retried automatically when its source file changes.
To retry now, fix or remove the source file named in the message, then run
`/sync-gbrain`.

---

## `[memory-ingest] reconcile: checked N, present M, re-queued K, not yet checked L (run again to continue)`

**Problem.** Not an error. This is the one-time catch-up after upgrading:
gstack re-checks transcripts it had marked ingested and re-queues the ones
missing from the brain, so transcripts lost by older versions import again.

**Cause.** Older versions could mark a page ingested that gbrain had
skipped. The upgrade records that a reconcile is pending; each ingest run
then checks a bounded batch (200 entries) until done.

**Fix.** Nothing to do; each `/sync-gbrain` continues where the last one
stopped. To run it now or check progress:
```bash
gstack-memory-ingest --reconcile --dry-run   # report only
gstack-memory-ingest --reconcile             # re-check the next 200 (--limit N)
```
"not yet checked" counts pages whose lookup failed (gbrain busy or
unreachable); they are never treated as missing. "unrecoverable" counts pages
missing from the brain whose transcript file no longer exists. The state file
is backed up to `~/.gstack/.transcript-ingest-state.json.pre-reconcile.bak`
before each pass.

---

## `[memory-ingest] reconcile: not run (...)`

**Problem.** A reconcile pass was requested but could not run.

**Cause.** gbrain is not installed or lacks `import`, or the brain is a
remote-HTTP brain (its pages are staged for the brain admin's pull, so there
is nothing to check locally).

**Fix.** For a missing gbrain, run `/setup-gbrain`, then
`gstack-memory-ingest --reconcile`. For a remote-HTTP brain, nothing to do.

---

## `[memory-ingest] ERR: another memory ingest (pid <N>) is writing <state file>; not run.`

**Problem.** The memory stage did nothing this run.

**Cause.** Another ingest, reconcile or `--request-reconcile` holds the
state lock (`~/.gstack/.transcript-ingest-state.json.lock`). A lock left by a
process that no longer exists is taken over automatically.

**Fix.** Wait for the other run to finish, then run `/sync-gbrain` again.

---

## `[memory-ingest] ERR: could not save ingest state <path>: <error>.`

**Problem.** The memory stage failed after importing.

**Cause.** The state file could not be written (disk full, permissions, or a
directory in its place). The run fails instead of pretending it recorded
progress; pages it imported are re-checked next run, which is cheap because
gbrain skips unchanged content.

**Fix.** Free disk space or fix permissions on `~/.gstack/`, then run
`/sync-gbrain`.

---

## `[memory-ingest] kept N unattributed transcript(s) on this machine: the brain is remote (Postgres or HTTP), ...`

**Problem.** `--include-unattributed` transcripts (sessions with no git
remote) were not imported.

**Cause.** Transcripts that cannot be attributed to a repository go only to
the machine-local, never-federated source `gstack-transcripts-unattributed`.
Your brain is remote (a Postgres or Supabase `database_url`, or a remote-HTTP
MCP brain), so sending them would take them off this machine. They are not
marked ingested and are not written to the publishable `~/.gstack/transcripts/`
staging either.

**Fix.** Nothing to do if that is what you want. To include such a session,
run it from a git repository with an `origin` remote so it is attributed.

---

## `[memory-ingest] kept N transcript page(s) for <repo> on this machine: could not register gbrain source <id> (...)`

**Problem.** Transcripts from one repository were not imported.

**Cause.** gstack imports each repository's transcripts into that
repository's own gbrain source (`gstack-transcripts-...`, machine-local and
not federated) and registers it before the first import. The installed gbrain
refused `gbrain sources add`, so the pages stay local and unstamped.

**Fix.**
```bash
gstack-gbrain-install      # upgrade gbrain
/sync-gbrain               # the pages import on the next run
```

---

## `curated artifacts pushed to git, but gbrain source <id> has 0 indexed pages. Fix: gbrain sync --source <id>, then re-run /sync-gbrain`

**Problem.** `/sync-gbrain`'s brain-sync stage is `ERR` even though the git
push worked.

**Cause.** The push only moves your curated artifacts to git. gbrain indexes
them separately, and the artifacts source this machine maintains reports zero
pages, so searches return nothing from it. Before this release the stage said
"curated artifacts pushed" and passed.

**Fix.**
```bash
gbrain sync --source <id>
/sync-gbrain
```
If it stays at zero, re-register the source with `gstack-gbrain-source-wireup`.

---

## `[gbrain-sync] gbrain source <id>: path unavailable (<path>); gstack skips it.`

**Problem.** A gbrain code source points at a directory that no longer
exists on this machine, usually a deleted Conductor worktree. gbrain's
autopilot keeps failing on it.

**Cause.** Each worktree gets its own `gstack-code-<repo>-<hash>` source.
Deleting the worktree leaves the source behind. gstack does not remove it on
its own: its indexed pages may be the only copy of work that was never
committed, and a source can belong to another machine sharing the brain.

**Fix.** Review, then remove the ones gstack can prove are gone:
```bash
gstack-gbrain-sync --prune-gone-worktrees --dry-run
gstack-gbrain-sync --prune-gone-worktrees
```
A source is removed only when its path was missing on two consecutive syncs,
its parent directory is readable, its id recomputes from this host and path
(so this machine created it), and its repository still exists but no longer
lists the worktree. Each removal is logged to `~/.gstack/.gbrain-prune.log`.
Run it from the main checkout of the same repository so gstack can find the
repository. Anything it keeps prints the reason; remove such a source by hand
with `gbrain sources remove <id>` only if you are sure.

---

## `dream: skipped — the installed gbrain cannot run only the resolve_symbol_edges phase, and the full dream cycle costs about 35 minutes (LLM phases).`

**Problem.** `/sync-gbrain --dream` (or `--full`) did not build the call
graph.

**Cause.** The call graph needs only gbrain's `resolve_symbol_edges` phase.
The installed gbrain cannot run that phase alone (no `dream --phase`, or no
such phase), and gstack no longer starts gbrain's full maintenance cycle on
its own: it takes about 35 minutes and runs LLM phases.

**Fix.**
```bash
gstack-gbrain-install          # upgrade gbrain, then:
/sync-gbrain --dream
```
Or run the full cycle yourself when you have the time: `gbrain dream --source <id>`.

---

## `call graph for <source>: unknown: installed gbrain does not expose cycle_freshness`

**Problem.** `/sync-gbrain` cannot tell whether this repo's call graph was
ever built, so it does not offer to build it.

**Cause.** The answer comes from `gbrain doctor`'s `cycle_freshness` check.
gstack now reads it from `gbrain doctor --json --scope=brain` (the `--fast`
mode it used before skips that check, so it always said "unknown"). Your
installed gbrain does not report the check at all.

**Fix.**
```bash
gstack-gbrain-install          # upgrade gbrain
/sync-gbrain --dream           # or build the call graph now regardless
```

---

## `artifacts remote: restored <url> because <owner>/gstack-artifacts-<user> does not exist and <owner>/gstack-brain-<user> does`

**Problem.** Printed once during upgrade. Artifact pushes had been failing
because `~/.gstack-artifacts-remote.txt` named a repository that was never
created.

**Cause.** The v1.27.0.0 upgrade passed a bare repo name to
`gh repo rename`, which always fails, then rewrote the remote to the new name
anyway. This upgrade points the remote (and `~/.gstack`'s `origin`) back at
the repository that exists.

**Fix.** Nothing is required; pushes work again. To finish the rename:
```bash
gh repo rename gstack-artifacts-<user> --repo <owner>/gstack-brain-<user> --yes
GSTACK_MIGRATE_ASSUME_YES=1 bash ~/.claude/skills/gstack/gstack-upgrade/migrations/v1.27.0.0.sh
```
If it instead says it `could not confirm ... exists (gh is not installed or not
signed in)`, run `gh auth login` and check the repository name on GitHub.

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
