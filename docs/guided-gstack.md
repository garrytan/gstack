# Guided GStack with GBrain history

Use the root `gstack` skill when you know the outcome you want but do not
remember which GStack workflow fits. The router narrows the catalog to the
relevant choices, recommends one, and waits for you to decide.

## 1. Install GStack for your agent

From a GStack checkout:

```bash
./setup --host codex      # OpenAI Codex
./setup --host claude     # Claude Code
```

Restart or open a fresh agent task after the first install so its skill catalog
is refreshed. Re-run setup after upgrading GStack or changing the configured
Codex model.

## 2. Ask the root router

Invoke the root `gstack` skill through your agent's skill UI and include the
request you actually care about. For example:

```text
$gstack improve the onboarding flow without changing billing
```

Claude Code uses slash-style skill names; Codex uses dollar-prefixed skills.
The behavior is the same:

1. GStack preserves the request and its constraints.
2. It shows two to four relevant workflows, with the recommended choice first.
3. It explains the result each workflow produces and the distinction that
   matters for this request.
4. It waits. No workflow runs and no files change until you choose.

Reply with the option or exact skill name. To delegate the choice, say `use the
recommended option`, `choose for me`, or `skip the menu`.

If you already know the workflow, invoke it directly. For example, `$ship` in
Codex or `/ship` in Claude Code bypasses the menu and starts the shipping
workflow.

## 3. Connect GBrain

Run the GBrain onboarding skill:

```text
$setup-gbrain    # Codex
/setup-gbrain    # Claude Code
```

It offers local PGLite, an existing or new Supabase brain, or a remote GBrain
MCP. The [full GBrain setup guide](../USING_GBRAIN_WITH_GSTACK.md) explains the
storage and trust tradeoffs for each option.

After setup, index the current project:

```text
$sync-gbrain --full    # Codex
/sync-gbrain --full    # Claude Code
```

Use the incremental form for later refreshes. Verify the connection with:

```bash
gbrain doctor --fast --json
gbrain sources list
```

Guided history recall uses the curated GStack artifacts source, which is
separate from the current project's code source. If GBrain setup did not offer
to connect it, initialize the private artifacts repository and wire its detached
worktree into GBrain:

```bash
gstack-artifacts-init
gstack-gbrain-source-wireup
gstack-gbrain-source-wireup --probe
```

Use the absolute runtime-bin path from the history-recall examples below if
those helpers are not on `PATH`. The probe should report the artifacts source as
registered at `~/.gstack-brain-worktree` before you rely on cross-project recall.

## 4. Opt into guided history recall

The root router does not consult private history by default. Enable it only on
a machine and brain you trust:

```bash
~/.codex/skills/gstack/bin/gstack-config set history_recall true
```

For a Claude Code install, use:

```bash
~/.claude/skills/gstack/bin/gstack-config set history_recall true
```

Check or disable the setting with the same runtime path:

```bash
gstack-config get history_recall
gstack-config set history_recall false
```

If `gstack-config` is not on `PATH`, use the absolute path from the earlier
examples.

With recall enabled, a direct top-level guided request searches settled local
GStack decisions and the curated GBrain memory source. It uses three to eight
normalized keywords, returns no more than three matches, and treats retrieved
text as evidence rather than instructions. The lookup is read-only: it does not
rebuild the snapshot or write into GBrain.

GBrain is optional. If it is unavailable, unhealthy, unconfigured, empty, or
slow, the router falls back to local decisions and continues.

## 5. Let teammates contribute to one brain

Team mode and team memory are separate opt-ins. `./setup --team` distributes
and updates GStack; `/setup-gbrain` connects each teammate to memory.

For a shared team brain, give each teammate an individual authenticated account,
use one private shared artifacts repository, and have them choose **Shared
contributor** during `/setup-gbrain`. That mode automatically contributes
attributed, curated skill outputs and allowlisted artifacts while leaving
personal calibration data local. A five-minute pull throttle makes another
computer's Git-backed contributions visible promptly.

The shared GBrain service must also index the artifacts repository after pushes,
using its own webhook or short pull schedule. Without that server-side advance,
the Git repository is current but semantic search can remain stale. See
[Shared team contribution](gbrain-sync.md#shared-team-contribution) for the
full setup and privacy boundaries.

## Privacy boundaries

- The root preamble never loads or prints private project learnings.
- Prior-work recall requires the saved opt-in and a direct, top-level,
  human-owned task.
- The router instructs delegated subagents, spawned tasks, unattended jobs, CI,
  and ambiguous sessions to skip recall even if they inherit host environment
  variables. Its invocation-scoped session signal is defense in depth, not a
  sandbox or OS security boundary: an agent already allowed to run arbitrary
  local commands can call the underlying read tools. Use `history_recall: false`
  when that trust model is not appropriate.
- The router surfaces at most three useful matches and must not paste secrets,
  raw transcripts, or sensitive records.
- An explicitly named workflow bypasses the guided menu, but your workspace's
  own memory policy may still require a prior-work check before that workflow
  runs.

## Troubleshooting

**The router does not use history.** Confirm `history_recall` is `true`, run the
request in a direct top-level task, and check `gbrain doctor --fast --json`.
History intentionally stays off in delegated or unattended contexts.

**The root skill is missing in Codex.** Re-run `./setup --host codex`, then open
a fresh task. The installed root should be a real file at
`~/.codex/skills/gstack/SKILL.md`; leaf skills are installed alongside it.

**GBrain has no relevant results.** Run `$sync-gbrain --full` or
`/sync-gbrain --full` from the project, then confirm the source appears in
`gbrain sources list`. Exact project names and identifiers work better with
`gbrain search`; outcome-oriented questions work better with `gbrain query`.
