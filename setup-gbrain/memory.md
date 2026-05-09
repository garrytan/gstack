# gstack memory ingest — what it does, what stays local, what you can do with it

This is the user-facing reference for the V1 transcript + memory ingest
feature in `/setup-gbrain`. If you ran `/setup-gbrain` and it asked
"Ingest THIS repo's transcripts into gbrain?", this doc explains what
happens after you say yes.

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

## What gets scanned for secrets

Every ingested page passes through **gitleaks** before write
(per D19 — replaces the regex scanner that previously ran only on
staged git diffs). Gitleaks is industry-standard, covers:

- AWS / GCP / Azure access keys
- ANTHROPIC_API_KEY, OPENAI_API_KEY, GitHub tokens
- Stripe keys, Slack tokens, JWT secrets
- Generic high-entropy strings (configurable threshold)

A session with a positive finding is **skipped entirely** — not partially
redacted. The match line + rule ID are logged to stderr; you can see what
was skipped via `bun run bin/gstack-memory-ingest.ts --probe` (which
shows new vs. updated counts) or by reviewing the helper's output during
`/gbrain-sync --full`.

If gitleaks is not installed (run `brew install gitleaks` on macOS, or
`apt install gitleaks` on Linux), the helper warns once and disables
secret scanning. **In that mode, transcripts ingest unscanned. Don't run
ingest without gitleaks if you have any concern about secrets in your
sessions.**

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
  gbrain list_pages --type transcript --limit 10
  gbrain list_pages --type ceo-plan
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
  helper). For V1.0, use `gbrain delete_page <slug>` per-page or write
  a small loop over `gbrain list_pages` output.

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
  yet. Run `gstack-gbrain-sync --full` to do a full pass.

- **"gbrain CLI missing" in the preamble output** — gbrain isn't on
  your PATH. Run `/setup-gbrain` to install/wire it.

- **PGLite engine corrupt (V1.5)** — V1.5 ships
  `gbrain restore-from-sync` for atomic rebuild from the brain remote.
  For V1.0, manual recovery: `cd ~/.gbrain && rm -rf db && gbrain init
  --pglite && gbrain import <brain-remote-clone-dir>`.

- **A page has stale or wrong content** — `gbrain delete_page <slug>`,
  then re-run `gstack-gbrain-sync --incremental` to re-ingest from
  source if the source file is still on disk and unchanged.

## Privacy + audit

- Every `secretScanFile` finding is logged to stderr at ingest time.
- Every gbrain put/delete is logged to `~/.gstack/.gbrain-errors.jsonl`
  with `{ts, op, duration_ms, outcome}` for forensic tracing.
- `~/.gstack/.gbrain-engine-cache.json` shows which storage tier is
  active (PGLite vs Supabase).
- Brain-sync git history shows every curated artifact push with the
  user's git identity.

If you find a transcript page that contains a secret gitleaks missed,
the recovery path is:
1. `gbrain delete_page <slug>` — removes from index immediately
2. Rotate the secret (rotate it anyway as a defensive measure)
3. If brain-sync is on: `git filter-repo --invert-paths --path <relative-path>`
   on the brain remote for hard-delete from history
4. File a gitleaks issue with the pattern (or extend the gitleaks config
   at `~/.gitleaks.toml`).

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
