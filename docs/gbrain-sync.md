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
  `security/device-salt`, consumer tokens in `config.yaml`
- Machine-specific state: Chromium profiles, ONNX model weights,
  caches, eval-cache, CDP-profile, one-time prompt markers
  (`.welcome-seen`, `.telemetry-prompted`, `.vendoring-warned-*`, etc.)
- Question-preferences: per-machine UX preferences
  (`question-preferences.json`, `question-log.jsonl`, `question-events.jsonl`).

The exact allowlist lives in `~/.gstack/.brain-allowlist`. The CLI manages
it; you can append your own entries below the marker line.

## First-run setup (30–90 seconds)

```bash
gstack-brain-init
```

The command:

1. Turns `~/.gstack/` into a git repo.
2. Asks for a remote URL (default: `gh repo create --private
   gstack-brain-$USER`). Any git remote works — GitHub, GitLab, Gitea,
   self-hosted.
3. Pushes an initial commit with just the config.
4. Writes `~/.gstack-brain-remote.txt` (URL-only, no secrets —
   safe to copy to another machine).
5. Wires the gstack-brain repo into your local gbrain as a federated
   source (via `gbrain sources add` + `git worktree`) so `gbrain search`
   can index your synced learnings, plans, and designs. Implementation
   lives in `bin/gstack-gbrain-source-wireup`. The old
   `gstack-brain-reader add --ingest-url ...` HTTP path was removed in
   v1.15.1.0 — it depended on a `/ingest-repo` endpoint gbrain never
   shipped.

After init, the **next skill you run** will ask you ONE question about
privacy mode:

- **Everything allowlisted (recommended)**: learnings, reviews, plans,
  designs, retros, timelines, and developer profile all sync.
- **Only artifacts**: plans, designs, retros, learnings — skip
  behavioral data (timelines, developer profile).
- **Decline**: keep everything local. You can turn sync on later with
  `gstack-config set gbrain_sync_mode full`.

Your answer is persisted. You won't be asked again.

## Cross-machine workflow

On machine A: run `gstack-brain-init` once. That's it — every skill
invocation now drains the sync queue at its start and end boundaries
(~200–800 ms network pause per skill).

On machine B:

1. Copy `~/.gstack-brain-remote.txt` from machine A to machine B
   (password manager, dotfile repo, USB stick — your call).
2. Run any gstack skill. The preamble sees the URL file and prints:
   ```
   BRAIN_SYNC: brain repo detected: <url>
   BRAIN_SYNC: run 'gstack-brain-restore' to pull your cross-machine memory
   ```
3. Run `gstack-brain-restore`. That clones the repo, rehydrates your
   learnings/plans/retros, and re-registers the git merge drivers.
4. Re-enter consumer tokens (they're machine-local and NOT synced —
   `gstack-config set gbrain_token <your-token>`).
5. Next skill: your yesterday-on-machine-A learning surfaces. That's the
   magical moment.

## Status, health, and queue depth

```bash
gstack-brain-sync --status
```

Shows: last successful push, pending queue depth, any sync blocks, and the
current privacy mode.

Every skill run prints a `BRAIN_SYNC:` line near the top of the preamble
output. Scan it for problems.

## Privacy modes in detail

| Mode | What syncs |
|------|------------|
| `off` | Nothing (default). |
| `artifacts-only` | Plans, designs, retros, learnings, reviews. Skips timelines + developer-profile. |
| `full` | Everything in the allowlist, including behavioral state. |

Change anytime with:
```bash
gstack-config set gbrain_sync_mode full
gstack-config set gbrain_sync_mode off
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

If a scan hits, sync stops, the queue is preserved, and your preamble
prints:

```
BRAIN_SYNC: blocked: <pattern-family>:<snippet>
```

To remediate:

1. Review the offending file.
2. If the match is a false positive on content you explicitly want to
   sync, run `gstack-brain-sync --skip-file <path>` to permanently
   exclude that path.
3. Otherwise, edit the file to remove the secret and re-run any skill.

There's a defense-in-depth hook at `~/.gstack/.git/hooks/pre-commit` that
runs the same scan if you manually `git commit` against the repo.

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

## Cross-machine pull cadence

The preamble runs `git fetch` + `git merge --ff-only` once per 24 hours
(cached via `~/.gstack/.brain-last-pull`). You don't need to think about
this — it happens automatically at the first skill invocation each day.

## Uninstall

```bash
gstack-brain-uninstall
```

This:

- Removes `~/.gstack/.git/` and all `.brain-*` config files.
- Clears `gbrain_sync_mode` in `gstack-config`.
- Does NOT touch your learnings, plans, retros, or developer profile.

Add `--delete-remote` to also delete the private GitHub repo (GitHub only,
uses `gh repo delete`).

Re-init anytime with `gstack-brain-init`.

## Troubleshooting

See [gbrain-sync-errors.md](gbrain-sync-errors.md) for an index of every
error message gstack-brain may print, with problem / cause / fix for each.

## Under the hood

For the architectural decisions behind this feature (allowlist vs
denylist, daemon vs preamble-boundary sync, JSONL merge driver, privacy
stop-gate), see the
[approved plan](../system-instruction-you-are-working-jaunty-kahn.md) in
the gstack plans directory.
