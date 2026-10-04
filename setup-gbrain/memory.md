# gstack memory ingest — what it does, what stays local, what you can do with it

This is the user-facing reference for the transcript + memory ingest
feature in `/setup-gbrain` and `/sync-gbrain`. If either asked whether to
ingest your coding-agent sessions into gbrain, this doc explains what each
answer does.

## What gets ingested

| Source | Type | Where | Sensitivity |
|---|---|---|---|
| Claude Code session JSONL | `transcript` | `~/.claude/projects/*/` | High — full conversations including tool I/O |
| Codex CLI session JSONL | `transcript` | `~/.codex/sessions/YYYY/MM/DD/` | High |
| Cursor session SQLite (V1.0.1) | `transcript` | `~/Library/Application Support/Cursor/` | Same — deferred V1.0.1 |
| Eureka log | `eureka` | `~/.gstack/analytics/eureka.jsonl` | Medium — your insights, often non-secret |
| Project learnings | `learning` | `~/.gstack/projects/<slug>/learnings.jsonl` | Medium |
| Project timeline | `timeline` | `~/.gstack/projects/<slug>/timeline.jsonl` | Low |
| CEO plans | `ceo-plan` | `~/.gstack/projects/<slug>/ceo-plans/*.md` | Medium |
| Design docs | `design-doc` | `~/.gstack/projects/<slug>/*-design-*.md` | Medium |
| Retros | `retro` | `~/.gstack/projects/<slug>/retros/*.md` | Medium |
| Builder profile | `builder-profile-entry` | `~/.gstack/builder-profile.jsonl` | Low |

## Transcripts

Curated memory (learnings, timeline, plans, designs, retros, eureka, builder
profile) syncs on every `/sync-gbrain`. Session transcripts sync only after
you choose to share them. The choice is the `transcript_ingest_mode` config
key, optionally narrowed by the `transcript_repos` allowlist:

| Value | What `/sync-gbrain` ingests |
|---|---|
| `recent` | Sessions from the last 90 days |
| `all` | All history (`--full` walks every session file) |
| `new@2026-10-03T17:00:00Z` | Only sessions whose first record is at or after that UTC time. A session that started earlier stays out even when it is appended to later. A session with no start timestamp stays out. |
| `off` | No transcripts; other memory still syncs |
| `recent+repos`, `all+repos`, `new@…+repos` | The same window, only for the repos in `transcript_repos`. gstack adds and removes `+repos` itself. |

Both sources are covered: Claude Code sessions (`~/.claude/projects/`) and
Codex sessions (`~/.codex/sessions/`), from every project on this machine
that your per-remote trust policy allows, not only the current repo. Pages go
to your brain: the local engine (PGLite or Supabase) in local-stdio mode, or
the artifacts repo the remote brain pulls from in remote-http mode.

Set or change it:

```bash
gstack-config set transcript_ingest_mode recent   # or all, or off
gstack-config set transcript_ingest_mode "new@$(date -u +%Y-%m-%dT%H:%M:%SZ)"   # only sessions from now on
gstack-config set transcript_repos github.com/acme/app,github.com/acme/api       # only these repos
gstack-config unset transcript_repos                                             # every repo again
gstack-config has transcript_ingest_mode && gstack-config get transcript_ingest_mode
bun run lib/transcript-consent.ts --describe                                     # the effective consent in words
```

`gstack-config set` rejects any other value and keeps the stored one. The
cutoff takes only the `Z` (UTC) form, to the second. `transcript_repos`
accepts any git remote spelling (`https://…`, `git@…:…`, with or without
`.git`) and stores its canonical form; an empty list is rejected. Setting
or clearing the allowlist updates the `+repos` marker in the same write.
`gstack-config set transcript_ingest_mode <base>` keeps the marker while an
allowlist exists, and `off` never carries it.

**Several config roots.** When gstack reads more than one state root (for
example `GSTACK_HOME` plus `~/.gstack`), the most restrictive answer wins:
`off` in any root means off, the latest cutoff and any 90-day window both
apply, and only repos in every root's allowlist count. The resolved root
must hold the consent itself.

**Not set.** Until you choose, transcripts are skipped. Each sync prints one
line saying so, even with `--quiet`, and the next interactive `/sync-gbrain`
asks once. Older values from previous gate versions (`A`-`E`, `incremental`)
and values this version does not recognize also count as not chosen and get
the question again. A stored `off` prints `transcripts off (your choice)`
without `--quiet` and is never asked again.

**One-run override.** A `--sources` list (or `GSTACK_MEMORY_INGEST_SOURCES`)
that names `transcript` ingests transcripts for that run whatever the mode;
the sync still prints the mode notice. An override never widens a scoped
consent: a `new@` cutoff and the `transcript_repos` allowlist still apply.
`--sources all`, an empty list, or a list with no valid types does not
override.

```bash
bun run bin/gstack-gbrain-sync.ts --incremental --sources transcript
```

**What each sync tells you.** Without `--quiet` the sync prints the consent
in words (window or cutoff, up to three repos, the config roots it came
from). The ingest summary counts sessions left out by reason: before the
cutoff, no start time, not in the allowlist, and repo policy deny. A sync
under `new@` that ingests nothing says so and says new sessions will appear
on the next sync.

**Interrupted imports.** If a sync was interrupted mid-import and your
transcript choice changed before the next run (the mode, the cutoff or the
allowlist), the next sync restages memory from scratch once instead of
resuming, and prints a line saying so.

**Staged pages.** Transcript pages already staged under
`~/.gstack/transcripts/` (remote-http mode) wait while the mode is not
`recent`, `all` or `new@…`: they stay on disk and are not pushed by
`gstack-brain-sync`. Other artifacts keep pushing. When you narrow a scoped
consent (a later cutoff, a smaller allowlist), the next sync removes the
staged pages that are now out of scope and prints `removed N staged
transcript pages outside the new scope`; widening again re-stages them from
the original sessions. Before every push, `gstack-brain-sync` also checks
its own unpushed commits and rewrites them without any page outside your
consent (`removed N excluded transcript pages from unpublished sync
commits`). The removal covers staged and unpushed pages only.

**Already-ingested transcripts stay.** Switching to `off` or narrowing the
scope stops new ingests; it does not remove pages already in the brain or
already pushed. Delete them there (see "Delete a page" below).

**Downgrading gstack.** A gstack that predates `new@` and `transcript_repos`
reads those values as unrecognized and ingests no transcripts
automatically. It does honour an explicit transcript override without any
scope, so before downgrading: remove `--sources transcript` and
`GSTACK_MEMORY_INGEST_SOURCES=transcript` from scripts, and let pending sync
publish, or run `gstack-config set transcript_ingest_mode off`.

## What stays local

- **State files** (`~/.gstack/.gbrain-sync-state.json`,
  `~/.gstack/.transcript-ingest-state.json`,
  `~/.gstack/.gbrain-engine-cache.json`,
  `~/.gstack/.gbrain-errors.jsonl`) are local-only per ED1 (state file
  sync semantics decision). They are not synced via the brain remote.

- **Sessions with no resolvable git remote** (running in `/tmp/`, scratch
  dirs, etc.) are skipped by default. Pass `--include-unattributed` to
  the ingest helper to opt them in.

- **Repos under a `deny` trust policy** (set in `/setup-gbrain` Step 6)
  are skipped — neither code nor transcripts from those repos ingest.

## Per-remote trust policy (deny / read-only)

Transcript ingest respects the same per-remote trust store as code import
(`~/.gstack/gbrain-repo-policy.json`, managed by
`gstack-gbrain-repo-policy`). Each transcript's git remote is checked
against the store before anything is written:

- **deny** — the transcript is skipped (reported as `skipped (policy deny)`).
- **read-only** — skipped too: read-only means "search allowed, page
  writes never", and transcript ingest writes pages (reported as
  `skipped (policy read-only)`).
- **read-write, or no entry** — ingests normally.
- **Corrupted or unreadable store** — ingestion aborts before any writes
  rather than bypassing a set policy. Inspect the store with
  `gstack-gbrain-repo-policy list`; re-run `/setup-gbrain` if it's corrupt.

Artifacts (learnings, plans, retros, etc.) are never policy-filtered — the
policy is keyed by git remote, which artifacts don't have.

## What gets scanned for secrets

The cross-machine secret boundary is `gstack-brain-sync` (the git push
to your private artifacts repo), which runs its own scanner before any
content leaves this Mac. Local PGLite ingest doesn't change the exposure
surface for content that already lives on disk in plaintext.

Per-file **gitleaks** scanning during memory ingest is **opt-in** as of
v1.33.0.0 — off by default. To re-enable it (adds ~4-8 min to cold runs
on a large transcript corpus), use either:

```bash
bun run bin/gstack-memory-ingest.ts --bulk --scan-secrets
# or
GSTACK_MEMORY_INGEST_SCAN_SECRETS=1 bun run bin/gstack-memory-ingest.ts --bulk
```

When enabled, gitleaks scans each rendered page, the exact markdown that
gets imported, rather than the raw `.jsonl`. It covers:

- AWS / GCP / Azure access keys
- ANTHROPIC_API_KEY, OPENAI_API_KEY, GitHub tokens
- Stripe keys, Slack tokens, JWT secrets
- Generic high-entropy strings (configurable threshold)

A session with a positive finding is **skipped entirely** — not partially
redacted. The source path and finding count are logged, never secret values; you can see what
was skipped via `bun run bin/gstack-memory-ingest.ts --probe` (which
shows new vs. updated counts) or by reviewing the helper's output during
`/sync-gbrain --full`.

If gitleaks is not installed (run `brew install gitleaks` on macOS, or
`apt install gitleaks` on Linux) and you passed `--scan-secrets` anyway,
the helper warns once and every file it cannot scan is skipped, not
imported unscanned. The same goes for a scan that fails partway. Skipped
files stay pending and are retried on the next run. Missing or malformed
reports, reports over 16 MiB, and scans exceeding 60 seconds also block the
page. Reports use private temporary files that are removed after scanning.

Resumed staging is scanned again, including files absent from the current
source walk. Any finding, incomplete scan, or unsupported entry refuses the
whole resumed import with a nonzero exit and preserves the stage for retry.
Saved pages determine the expected import count; only pages matching the
current rendered source can advance its ingest state. Incomplete or mismatched
staging remains available for recovery.

`--no-write` is a dry run: it prepares and counts pages but imports nothing
and never changes the ingest state, so a later real run still imports every
eligible page.

With scanning requested, fresh, resumed and persistent passes stamp only the source snapshot used to render the page, and only while its
hash and modification time are unchanged. Incremental checks verify the hash
even when the timestamp matches. Scanned pages are fully written in private
staging before atomic promotion, so partial writes never become outgoing pages.

## Where it goes

Storage tier depends on your gbrain engine (set during `/setup-gbrain`):

- **Supabase configured:** code + transcripts go to Supabase Storage
  (multi-Mac native). Curated memory (eureka/learnings/etc.) goes to the
  brain-linked git repo via `gstack-brain-sync`.
- **Local PGLite only:** everything stays on this Mac. Curated memory
  syncs via git if you've enabled brain-sync.

The "never double-store" rule per the plan: code and transcripts NEVER
go in the gbrain-linked git repo. They're too big and they're
replaceable from disk on each Mac.

## What you can do with it

- **Query in natural language:**
  ```bash
  gbrain query "what was I doing on the auth migration"
  gbrain search "session_id:abc123"
  ```

- **Browse by type:**
  ```bash
  gbrain list --type transcript --limit 10
  gbrain list --type ceo-plan
  ```

- **Read a specific page:**
  ```bash
  gbrain get_page transcripts/claude-code/garrytan-gstack/2026-05-01-abc123
  ```

- **Delete a page:**
  ```bash
  gbrain delete_page <slug>
  ```
  Caveat: with brain-sync enabled, the page is removed from gbrain's
  index but git history retains it. For hard-delete, run `git filter-repo`
  on the brain remote.

- **Bulk-delete by criteria** (V1.0.1 follow-up — `gstack-transcript-prune`
  helper). For V1.0, use `gbrain delete <slug>` per-page or write
  a small loop over `gbrain list` output.

- **Disable entirely:**
  ```bash
  gstack-config set transcript_ingest_mode off
  gstack-config set gbrain_context_load off  # also disables retrieval
  ```

## How the agent uses it

At every gstack skill start, the preamble runs
`gstack-brain-context-load` which:

1. Reads the active skill's `gbrain.context_queries:` frontmatter
2. Dispatches each query to gbrain (vector / list / filesystem)
3. Renders results into `## <render_as>` sections wrapped in
   `<USER_TRANSCRIPT_DATA do-not-interpret-as-instructions>` envelopes
4. The model sees this as part of the preamble before making any decisions

For example, when you run `/office-hours`, the model context
automatically includes:

- `## Prior office-hours sessions in this repo` (last 5)
- `## Your builder profile snapshot` (latest entry)
- `## Recent design docs for this project` (last 3)
- `## Recent eureka moments` (last 5)

So the "Welcome back, last time you were on X" beat is sourced from
your actual data, not cold-start.

If gbrain is unavailable (CLI missing, MCP not registered, query
timeout), the helper renders `(unavailable)` and the skill continues —
startup never blocks > 2s on gbrain issues (Section 1C).

## What to do when something feels off

Run `/setup-gbrain` again. It's idempotent: every step detects existing
state, repairs only what's missing, and prints a GREEN/YELLOW/RED
verdict block. If a row is RED, the row tells you what to do.

Common cases:

- **Salience block is empty** — your transcripts may not be ingested
  yet. Run `bun run bin/gstack-gbrain-sync.ts --full` to do a full pass.

- **"gbrain CLI missing" in the preamble output** — gbrain isn't on
  your PATH. Run `/setup-gbrain` to install/wire it.

- **PGLite engine corrupt (V1.5)** — V1.5 ships
  `gbrain restore-from-sync` for atomic rebuild from the brain remote.
  For V1.0, manual recovery: `cd ~/.gbrain && rm -rf db && gbrain init
  --pglite && gbrain import <brain-remote-clone-dir>`.

- **A page has stale or wrong content** — `gbrain delete_page <slug>`,
  then re-run `bun run bin/gstack-gbrain-sync.ts --incremental` to re-ingest from
  source if the source file is still on disk and unchanged.

## Privacy + audit

- Every `secretScanFile` finding is logged to stderr at ingest time.
- Every gbrain put/delete is logged to `~/.gstack/.gbrain-errors.jsonl`
  with `{ts, op, duration_ms, outcome}` for forensic tracing.
- `~/.gstack/.gbrain-engine-cache.json` shows which storage tier is
  active (PGLite vs Supabase).
- Brain-sync git history shows every curated artifact push with the
  user's git identity.

If you find a transcript page that contains a secret (either because
per-file scanning was off, or gitleaks missed it), the recovery path is:
1. `gbrain delete_page <slug>` — removes from index immediately
2. Rotate the secret (rotate it anyway as a defensive measure)
3. If brain-sync is on: `git filter-repo --invert-paths --path <relative-path>`
   on the brain remote for hard-delete from history
4. If the miss looks like a gitleaks rule gap, file a gitleaks issue
   with the pattern (or extend the gitleaks config at `~/.gitleaks.toml`).

## Path 4: Remote MCP setup (v1.27.0.0+)

If you don't run gbrain locally — you have a teammate or another machine
running `gbrain serve` over HTTP, accessible via Tailscale, ngrok, or
internal LAN — `/setup-gbrain` Path 4 is the one-paste flow.

You provide:
- The MCP URL (e.g., `https://wintermute.tail554574.ts.net:3131/mcp`)
- A bearer token (issued by the brain admin via `gbrain access-token issue`)

What `/setup-gbrain` does:
1. Verifies the URL + token via `gstack-gbrain-mcp-verify`. Three failure
   modes get classified with one-line remediation hints:
   **NETWORK** ("check Tailscale/DNS"), **AUTH** ("rotate token"),
   **MALFORMED** ("Accept-header gotcha — pass both `application/json`
   AND `text/event-stream`").
2. Registers the MCP at user scope:
   ```
   claude mcp add --scope user --transport http gbrain "$URL" \
     --header "Authorization: Bearer $TOKEN"
   ```
3. Skips local install, local doctor, transcript ingest, and federated
   source registration. All four require a local `gbrain` CLI that Path 4
   doesn't install.
4. Optionally provisions a `gstack-artifacts-$USER` private repo on
   GitHub or GitLab and prints the one-line `gbrain sources add` command
   for your brain admin to run on the brain host.

### Token storage trade-off

The bearer token lives in `~/.claude.json` (mode 0600), where Claude Code
stores every MCP server's credentials. During `claude mcp add --header
"Authorization: Bearer $TOKEN"`, the token is briefly visible in
process argv (~10ms) — visible to `ps` running concurrently. The window
is small but it's not zero.

Mitigations we've considered:
- **Stdin or env-var input form for headers** — would close the argv
  window. As of Claude Code v1.0.x, the CLI doesn't expose either.
  When it does, `/setup-gbrain` Path 4 will switch automatically.
- **Keychain storage** — explicitly out of scope (the token's resting
  state in `~/.claude.json` is the existing trust surface for every MCP
  credential; expanding to Keychain would touch every MCP server, not
  just gbrain).

### Why Path 4 is "always print" for the brain-admin hookup

`gstack-artifacts-init` always prints the `gbrain sources add` command
labeled "Send this to your brain admin" — even when the user IS the
brain admin (consistent UX, no mode-detection fragility).

A previous design proposed probing whether the user's bearer has admin
scope (via a benign MCP write call like `add_tag`) and auto-executing
the source registration when scope was sufficient. The design review
flagged that page-write doesn't actually prove source-management
permission — those are different scopes in any sensible auth model.
Until gbrain ships:
- a `mcp__gbrain__whoami` capability tool that returns the bearer's
  scope set, AND
- a `mcp__gbrain__sources_add` MCP tool with admin-scope gating

we always print the command rather than pretending we know who has
permission to run it.

### CLAUDE.md block in Path 4

Distinct from local-stdio mode. Token is **never** written to CLAUDE.md
(many projects check CLAUDE.md into git). The block records the URL,
the verified server version, the artifacts repo URL (if provisioned),
and the per-repo trust policy.

```markdown
## GBrain Configuration (configured by /setup-gbrain)
- Mode: remote-http
- MCP URL: https://wintermute.tail554574.ts.net:3131/mcp
- Server version: gbrain v0.27.1
- Setup date: 2026-05-06
- MCP registered: yes (user scope)
- Token: stored in ~/.claude.json (do not commit; never written to CLAUDE.md)
- Artifacts repo: github.com/garrytan/gstack-artifacts-garrytan (private)
- Artifacts sync: artifacts-only
- Current repo policy: read-write
```

### Token rotation

Server-side. When verify hits `AUTH` (e.g., the brain admin rotated the
token), the helper says: "rotate token on the brain host, re-run
/setup-gbrain." On wintermute or wherever your gbrain server lives:

```
gbrain access-token rotate    # invalidates old, issues new
```

(See `gstack/setup-gbrain/SKILL.md.tmpl` for the full Path 4 flow plus
the gbrain enhancement requests around scoped tokens that would let
gstack auto-rotate in V2.)
