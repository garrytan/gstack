# Cross-machine memory with GBrain sync

gstack writes a lot of useful state to `~/.gstack/` — learnings, retros, CEO
plans, design docs, developer profile. By default, all of that dies when you
switch laptops. **GBrain sync** pushes a curated subset to a private git
repo so your memory follows you across machines and becomes indexable by
GBrain.

## What you get

- Work on machine A, pick up seamlessly on machine B.
- Your learnings, plans, and designs are visible in GBrain (if you use it).
- A clean off-ramp (`gstack-brain-uninstall`) that never touches your data.
- No daemon, no system service, no background process.

## What does NOT leave your machine

By design, these stay local even when sync is on:

- Credentials: `.auth.json`, `auth-token.json`, `sidebar-sessions/`,
  `security/device-salt`
- Machine-specific state: Chromium profiles, ONNX model weights,
  caches, eval-cache, CDP-profile, one-time prompt markers
  (`.welcome-seen`, `.telemetry-prompted`, `.vendoring-warned-*`, etc.)
- Question-preferences: per-machine UX preferences
  (`question-preferences.json`, `question-log.jsonl`, `question-events.jsonl`).

The exact allowlist lives in `~/.gstack/.brain-allowlist`. The CLI manages
it; you can append your own entries below the marker line.

## First-run setup (30–90 seconds)

```bash
gstack-artifacts-init
```

The command:

1. Turns `~/.gstack/` into a git repo.
2. Asks for a remote URL (default: `gh repo create --private
   gstack-artifacts-$USER`). Any git remote works — GitHub, GitLab, Gitea,
   self-hosted.
3. Pushes an initial commit with just the config.
4. Writes `~/.gstack-artifacts-remote.txt` (URL-only, no secrets —
   safe to copy to another machine).
5. Prints the `gbrain sources add` hookup command for the brain host
   (never auto-executed — run it yourself, or on your own machine
   `bin/gstack-gbrain-source-wireup` does the same wiring) so
   `gbrain search` can index your synced learnings, plans, and designs.
   The old `gstack-brain-reader add --ingest-url ...` HTTP path was
   removed in v1.15.1.0 — it depended on a `/ingest-repo` endpoint gbrain
   never shipped.

After init, the **next skill you run** will ask you ONE question about
privacy mode:

- **Everything allowlisted (recommended)**: learnings, reviews, plans,
  designs, retros, timelines, and developer profile all sync.
- **Only artifacts**: plans, designs, retros, learnings — skip
  behavioral data (timelines, developer profile).
- **Decline**: keep everything local. You can turn sync on later with
  `gstack-config set artifacts_sync_mode full`.

Your answer is persisted. You won't be asked again.

## Cross-machine workflow

On machine A: run `gstack-artifacts-init` once. That's it — every skill
invocation now drains the sync queue at its start and end boundaries
(~200–800 ms network pause per skill).

On machine B:

1. Copy `~/.gstack-artifacts-remote.txt` from machine A to machine B
   (password manager, dotfile repo, USB stick — your call; the legacy
   `~/.gstack-brain-remote.txt` name is still recognized).
2. Run any gstack skill. The preamble sees the URL file and prints:
   ```
   BRAIN_SYNC: brain repo detected: <url>
   BRAIN_SYNC: run 'gstack-brain-restore' to pull your cross-machine memory
   ```
3. Run `gstack-brain-restore`. That clones the repo, rehydrates your
   learnings/plans/retros, and re-registers the git merge drivers.
4. Next skill: your yesterday-on-machine-A learning surfaces. That's the
   magical moment.

## Status, health, and queue depth

```bash
gstack-brain-sync --status
```

Shows: the status (`ok`, `idle`, `held`, `collision`, `blocked`,
`push_failed`, `error`), files held back by the secret scan or because
they are not valid JSON, with their fixes, files held because their path differs only by letter case from
another path (`case_held`, `case_names`; see
[troubleshooting](troubleshooting.md#artifact-case-collision)), the
`drainable` count, the last sync and push times, pending queue depth, and
the current privacy mode.

Every skill run prints an `ARTIFACTS_SYNC:` line near the top of the
preamble output. When the sync is stuck it adds an
`ARTIFACTS_SYNC: attention:` line; the table of those lines and their fixes
is in [gbrain-sync-errors.md](gbrain-sync-errors.md#artifacts_sync-attention--at-skill-start).

## Privacy modes in detail

| Mode | What syncs |
|------|------------|
| `off` | Nothing (default). |
| `artifacts-only` | Plans, designs, retros, learnings, reviews. Skips timelines + developer-profile. |
| `full` | Everything in the allowlist, including behavioral state. |

Change anytime with:
```bash
gstack-config set artifacts_sync_mode full
gstack-config set artifacts_sync_mode off
```

## Removed and moved files

By default the sync never publishes a removal: delete a synced design doc,
or move a project directory (a project slug migration does), and the old
path stays on the remote, where the brain keeps indexing it next to the new
copy. To publish removals too:

```bash
gstack-config set artifacts_sync_removals on
```

Each sync then commits the removal of synced files that are gone from disk.
Transcript pages are left alone, and a decision log and its active snapshot
go only together. A sync that would remove more than 20 files at once
publishes none of them: that looks like a loss, not a cleanup. Review and
publish those yourself, whatever the setting:

```bash
gstack-brain-sync --publish-removals        # list them
gstack-brain-sync --publish-removals --yes  # commit and push their removal
```

## Secret protection

Every commit is scanned for credential-shaped content before it leaves
your machine. Blocked patterns include:

- AWS access keys (`AKIA…`)
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`)
- OpenAI keys (`sk-…`)
- PEM blocks (`-----BEGIN …-----`)
- JWTs (`eyJ…`)
- Bearer tokens in JSON (`"authorization": "…"`, `"api_key": "…"`, etc.)
- Stripe live secret and restricted keys (`sk_live_…`, `rk_live_…`)
- Slack tokens (`xoxb-…`, `xoxp-…` and the other `xox?-` forms)
- npm tokens (`npm_…`)
- Database URLs with a password (`postgres://app:<password>@host`, and the
  same for MySQL, MongoDB, Redis and AMQP)

The last four follow gstack's redaction rules, so placeholders such as
`sk_live_EXAMPLE…`, `${DB_PASSWORD}` or `postgres:postgres@localhost` are
not held.

The scan reads the whole staged diff twice: once as `git diff` shows it to
you (your `diff.context` and any textconv driver apply), and once as raw text
with three unchanged lines around each edit. A match in either reading holds
the file. Both readings include file names. Each added line is also
scanned with its JSON strings decoded, so a secret written with `\u` escapes or inside an escaped
JSON string is still caught. Each edited block is also read as the new file
text, so a key on an unchanged line and a value added under it are matched
together, whatever your git `diff.context` setting is. Files git treats as
binary (a NUL byte, UTF-16 text) are scanned by their bytes, read plainly,
without NULs and as UTF-16. If git still reports a file as binary instead of
showing its bytes, the file is held as `binary-not-scanned`. Bytes that none
of these readings turn into text, such as a compressed file, are not held
unless a pattern matches them.

Because unchanged and removed lines are scanned too, a file that already holds
a flagged line is held on every edit while that line is in the diff. If the
flagged line was never synced, delete it and the next sync goes through. If it
is already committed in `~/.gstack`, deleting it leaves it on a removed line
of the next diff, so the file stays held and only `--skip-file` clears it.
Skipping stops syncing the file, so a copy that was already pushed stays on
the remote; if it was pushed, treat the secret as exposed.

If a scan hits, only the flagged file is held back (with any file coupled
to it); everything else syncs. The held file stays queued and is re-scanned
at every sync, and skill start prints:

```
ARTIFACTS_SYNC: attention: status=held held=1. Sync is holding back 1 file(s) that the secret scan flagged or that are not valid JSON; everything else still syncs. See which files and how to fix them: <bin> --status
```

To remediate:

1. Run `gstack-brain-sync --status` (the line prints its absolute path). Each
   entry under `held` names the file, the scanner rule and both fixes.
2. If the match is a false positive on content you never want synced, run
   `gstack-brain-sync --skip-file <path>` to permanently exclude that path;
   `gstack-brain-sync --unskip-file <path>` undoes it.
3. Otherwise, edit the file to remove the secret. If that line was never
   synced, the next skill run syncs the file. If it is already committed in
   `~/.gstack`, the file stays held and only `--skip-file` clears it; if it
   was pushed, treat the secret as exposed.

There's a defense-in-depth hook at `~/.gstack/.git/hooks/pre-commit` that
runs the same scanner (`bin/gstack-brain-secret-scan.py`) if you manually
`git commit` against the repo. `gstack-artifacts-init` and
`gstack-brain-restore` install it and copy the scanner next to it, so the
hook keeps working if gstack moves. A hook written by an older gstack checks
only the first six patterns; rerun `gstack-artifacts-init` to refresh it.

Separately (v1.63.0.0+), every push writes a tamper-evident receipt to the
egress ledger (`~/.gstack/security/egress.jsonl`) *before* anything is
sent, fail-closed: if the receipt can't be written, the push is refused
and the queue is preserved. Inspect the ledger with `gstack-egress list`
and verify its hash chain with `gstack-egress verify`.

## Two-machine conflicts

If you write on machine A and machine B the same day, both will push
append commits. Git's default would conflict at the file tail, but the
`.jsonl` and markdown files are registered with custom merge drivers:

- JSONL files use a sort-and-dedup driver that orders appends by ISO
  timestamp (falls back to SHA-256 hash of each line for determinism).
- Markdown artifacts (retros, plans, designs) use a union merge driver
  that concatenates both sides.

You shouldn't see conflict prompts. If you do (a real semantic conflict,
like two machines editing the same plan), git will stop and prompt.

When a push is rejected, brain-sync fetches and merges the other machine's
commits itself. Local edits to files that merge would change are set aside
and put back afterward, and a failed merge is aborted, so `~/.gstack` never
holds conflict markers. If a local edit conflicts with the other machine's
change, the other machine's version stays in the working tree and your edit
is kept in a git stash; `gstack-brain-sync --status` names the stash and the
`git -C ~/.gstack --literal-pathspecs restore --source=<stash> -- <path>`
command that brings it back.

JSON files such as `developer-profile.json` have no merge driver, so a
merge can leave conflict markers in them. The sync parses every staged
`.json` file and holds back one that does not parse (status `held`, rule
`invalid-json`) until you repair it, and `gstack-doctor` warns when a synced profile or
decision snapshot holds conflict markers.

A project's decision snapshot, `decisions.active.json`, is never merged: it
is rebuilt from that project's `decisions.jsonl`, which merges like any other
`.jsonl` file. When two machines each log a decision between pushes, their
snapshots conflict; if every conflict in brain-sync's merge is such a snapshot,
brain-sync rebuilds each one from the merged log, commits the merge and pushes,
whether or not your `.gitattributes` predates this. The one exception is a log
that lost lines on either side since the machines last agreed, as
`gstack-decision-log --compact` does to redacted decisions: the merged log is
the union of both sides, so a rebuild would bring the redacted decision back,
and brain-sync aborts that merge as before. Repositories set up by
`gstack-artifacts-init` also mark the snapshot `merge=binary`, so a merge you
run by hand keeps your side without conflict markers; finish it with
`gstack-decision-log --rebuild-snapshot <project-slug>` and `git add -f` the
snapshot before committing.

## Cross-machine pull cadence

The preamble runs `git fetch` + `git merge --ff-only` once per 24 hours
(cached via `~/.gstack/.brain-last-pull`). You don't need to think about
this — it happens automatically at the first skill invocation each day.

Historical note (#2516): that daily pull refreshed only `~/.gstack` itself —
NOT the detached worktree at `~/.gstack-brain-worktree` that gbrain actually
indexes, so the brain silently served stale pages until the next
setup-gbrain/sync-gbrain run. Since this fix, the daily sync also advances
the brain worktree (`gstack-gbrain-source-wireup --advance-only`, throttled
via `~/.gstack/.brain-worktree-last-advance`); a failed advance warns instead
of failing silently, and never force-resets a dirty worktree.

## Uninstall

```bash
gstack-brain-uninstall
```

This:

- Removes `~/.gstack/.git/` and all `.brain-*` config files.
- Clears `artifacts_sync_mode` in `gstack-config`.
- Does NOT touch your learnings, plans, retros, or developer profile.

Add `--delete-remote` to also delete the private GitHub repo (GitHub only,
uses `gh repo delete`).

Re-init anytime with `gstack-artifacts-init`.

## Troubleshooting

See [gbrain-sync-errors.md](gbrain-sync-errors.md) for an index of every
error message gstack-brain may print, with problem / cause / fix for each.

## Under the hood

The architectural decisions behind this feature: allowlist over denylist
(unknown files stay local by default), preamble-boundary sync over a daemon
(no background process to babysit), a JSONL merge driver so concurrent
machines union their queues instead of conflicting, and a privacy stop-gate
that asks once before anything syncs.
