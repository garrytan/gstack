# Using GBrain with GStack

Your coding agent, with a memory it actually keeps.

[GBrain](https://github.com/garrytan/gbrain) is a persistent knowledge base designed for AI agents. It stores what your agent learns, what you've decided, what worked and what didn't, and lets the agent search all of it on demand. GStack gives you a one-command path from zero to "gbrain is running, and my agent can call it" — with paths for try-it-local, share-with-your-team, and everything between.

This is the full monty: every scenario, every flag, every helper bin, every troubleshooting step. For the quick pitch, see the [README's GBrain section](README.md#gbrain--persistent-knowledge-for-your-coding-agent). For error codes and sync-specific issues, see [docs/gbrain-sync.md](docs/gbrain-sync.md).

---

## The one-command install

```bash
/setup-gbrain
```

That's it. The skill detects your current state, asks three questions at most, and walks you through install, init, MCP registration for Claude Code, and per-repo trust policy. On a clean Mac with nothing installed it finishes in under five minutes. On a Mac where something's already set up it takes seconds (it detects the existing state and skips done work).

## What you get after setup

Once `/setup-gbrain` finishes, your coding agent has two retrieval surfaces it didn't have before:

- **Semantic code search across this repo.** `gbrain search "browser security canary"` returns ranked file regions, not exact-match grep hits. `gbrain code-def`, `code-refs`, `code-callers`, `code-callees` walk the call graph by symbol — useful when you don't know which file holds the implementation but you know what it does. The agent prefers these over Grep when the question is semantic; CLAUDE.md gets a `## GBrain Search Guidance` block that teaches it the routing rules.
- **Cross-session memory.** Plans, retros, decisions, and learnings from past sessions live in `~/.gstack/` and (if you opted in to artifacts sync) get pushed to a private git repo that gbrain indexes. `gbrain search "what did we decide about auth?"` actually finds the prior CEO plan instead of you re-describing context every session.

If you also enabled remote MCP (Path 4 below), brain queries route to a shared brain server that other machines can write to — your laptop, your desktop, and a teammate's machine all see the same memory.

## The four paths

You pick one when the skill asks "Where should your brain live?"

### Path 1: Supabase, you already have a connection string

Best for: you (or a teammate's cloud agent) already provisioned a Supabase brain and you want this local machine to use the same data.

**What happens:** Paste the Session Pooler URL (Settings → Database → Connection Pooler → Session → copy URI, port 6543). The skill reads it with echo off, shows you a redacted preview (`aws-0-us-east-1.pooler.supabase.com:6543/postgres` — host visible, password masked), hands it to `gbrain init` via the `GBRAIN_DATABASE_URL` environment variable, and the URL is never written to argv or your shell history.

**Trust warning:** Pasting this URL gives your local Claude Code full read/write access to every page in the shared brain. If that's not the trust level you want, pick PGLite local (Path 3) instead and accept the brains are disjoint.

### Path 2a: Supabase, auto-provision a new project

Best for: fresh Supabase account, you want a clean new project with zero clicking.

**What happens:** You paste a Supabase Personal Access Token (PAT). The skill shows you the scope disclosure first — *the token grants full access to every project in your Supabase account, not just the one we're about to create*. It lists your organizations, asks which one and which region (default `us-east-1`), generates a database password, calls `POST /v1/projects`, polls `GET /v1/projects/{ref}` every 5 seconds until the project is `ACTIVE_HEALTHY` (180s timeout), fetches the pooler URL, hands it to `gbrain init`. End-to-end: ~90 seconds.

At the end: explicit reminder to revoke the PAT at https://supabase.com/dashboard/account/tokens. The skill already discarded it from memory.

**If you Ctrl-C mid-provision:** The SIGINT trap prints your in-flight project ref + a resume command. You can delete the orphan at the Supabase dashboard, or run `/setup-gbrain --resume-provision <ref>` to pick up where you left off.

### Path 2b: Supabase, create manually

Best for: you'd rather click through supabase.com yourself than paste a PAT.

**What happens:** The skill walks you through the four manual steps (signup → new project → wait ~2 min → copy Session Pooler URL), then takes over from Path 1's paste step. Same security treatment as Path 1.

### Path 3: PGLite local

Best for: try-it-first, no account, no cloud, no sharing. Or a dedicated "this Mac's brain" that stays isolated from any cloud agent.

**What happens:** `gbrain init --pglite`. Brain lives at `~/.gbrain/brain.pglite`. No network calls. Done in 30 seconds.

This is the best first choice if you just want to see what gbrain feels like before committing to cloud. You can always migrate later with `/setup-gbrain --switch`.

### Path 4: Remote gbrain MCP (split-engine)

Best for: your brain runs on another machine you control (Tailscale, ngrok, internal LAN) or a teammate's server. You want the cross-machine memory benefit without standing up a local database, and you still want symbol-aware code search on this Mac.

**What happens:** You paste an MCP URL (e.g. `https://wintermute.tail554574.ts.net:3131/mcp`) and a bearer token. The skill verifies the URL over the wire, registers gbrain as an HTTP MCP in `~/.claude.json` at user scope, and offers to also stand up a tiny local PGLite for code search (~30 seconds, ~120 MB disk).

If you accept the local PGLite, you end up in **split-engine mode**:

- **Brain/context queries** (`mcp__gbrain__search`, `mcp__gbrain__query`, `mcp__gbrain__get_page`) route to the remote MCP. Plans, retros, learnings, cross-machine memory — all on the shared server.
- **Code queries** (`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, `gbrain search` for code) route to the local PGLite via the `.gbrain-source` pin in each worktree. Indexed locally, fast, never leaves the machine.

The two engines are independent. Wiping the local PGLite doesn't touch the remote brain; rotating the remote MCP bearer doesn't affect local code search. This is also the right configuration if your remote brain admin can't (or shouldn't) index every developer's checkout — local code stays local.

## MCP registration for Claude Code

By default the skill asks "Give Claude Code a typed tool surface for gbrain?" If you say yes, it runs:

```bash
claude mcp add gbrain -- gbrain serve
```

That registers gbrain's stdio MCP server with Claude Code. Now `gbrain search`, `gbrain put_page`, `gbrain get_page`, etc. show up as first-class tools in every session, not bash shell-outs.

**If `claude` is not on PATH**, the skill skips MCP registration gracefully with a manual-register hint. The CLI resolver still works from any skill that shells out to `gbrain` — MCP is an upgrade, not a prerequisite.

**Other local agents** (Cursor, Codex CLI, etc.) need their own MCP registration. The skill is Claude-Code-targeted for v1; other hosts can register `gbrain serve` manually in their own MCP config.

## Per-remote trust policy (the triad)

Every repo on your machine gets a policy decision: **read-write**, **read-only**, or **deny**.

- **read-write** — your agent can `gbrain search` from this repo's context AND write new pages back to the brain. Default for your own projects.
- **read-only** — your agent can search the brain but never writes new pages from this repo's sessions. Ideal for multi-client consultants: search the shared brain, don't contaminate it with Client A's code while you're in Client B's repo.
- **deny** — no gbrain interaction at all. The repo is invisible to gbrain tooling.

The skill asks once per repo the first time you run a gstack skill there. After that the decision is sticky — every worktree + branch of the same git remote shares the same policy, so you set it once and it follows you.

SSH and HTTPS remote variants collapse to the same key: `https://github.com/foo/bar.git` and `git@github.com:foo/bar.git` are the same repo.

**To change a policy:**

```bash
/setup-gbrain --repo      # re-prompt for this repo only

# Or directly:
~/.claude/skills/gstack/bin/gstack-gbrain-repo-policy set "github.com/foo/bar" read-only
```

**To see every policy:**

```bash
~/.claude/skills/gstack/bin/gstack-gbrain-repo-policy list
```

Storage: `~/.gstack/gbrain-repo-policy.json`, mode 0600, schema-versioned so future migrations stay deterministic.

## Keeping the brain current with `/sync-gbrain`

`/setup-gbrain` is one-time onboarding. `/sync-gbrain` is the verb you run every time you want gbrain to see fresh changes in this repo's code.

```bash
/sync-gbrain                # incremental: mtime fast-path, ~seconds on a clean tree
/sync-gbrain --full         # full reindex (~25-35 minutes on a big Mac)
/sync-gbrain --code-only    # only the code stage; skip memory + brain-sync
/sync-gbrain --dry-run      # preview what would sync; no writes
```

The skill runs three stages — code, memory, brain-sync — independently. A failure in one doesn't block the others. State persists to `~/.gstack/.gbrain-sync-state.json` so re-running picks up cleanly.

**What it does on a fresh worktree:**

1. **Pre-flight.** Checks `gbrain_local_status` (the local engine's health). If the engine is `broken-db` or `broken-config`, the skill STOPs with a remediation menu — it refuses to silently degrade. If the local engine is missing and you're in remote-MCP mode (Path 4), the code stage SKIPs cleanly and only brain-sync runs.
2. **Code stage.** Registers the cwd as a federated source via `gbrain sources add`, writes a `.gbrain-source` pin file in the repo root (kubectl-style context — every worktree gets its own pin, so Conductor sibling worktrees don't collide), runs `gbrain sync --strategy code`.
3. **Memory stage.** Stages your `~/.gstack/` transcripts + curated memory. In local-stdio MCP mode, ingests into the local engine. In remote-http MCP mode, persists staged markdown to `~/.gstack/transcripts/run-<pid>-<ts>/` for the remote brain admin's pull pipeline.
4. **Brain-sync stage.** Pushes curated artifacts (plans, designs, retros) to your private artifacts repo if you have one configured.
5. **CLAUDE.md guidance.** Capability-checks the round-trip (write a page → search → find it). If green, writes the `## GBrain Search Guidance` block to your project's CLAUDE.md. If red, REMOVES the block — the agent should never be told to use a tool that isn't installed.

**The watermark.** Sync state advances by commit hash. If gbrain hits a file it can't index (5 MB hard limit per file, or a file vanished mid-sync), the watermark stays put and subsequent syncs retry. To acknowledge an unfixable failure and move past it:

```bash
gbrain sync --source <source-id> --skip-failed
```

Re-runnable, idempotent, safe to run from multiple terminals on the same machine (locked at `~/.gstack/.sync-gbrain.lock`).

## Switching engines later

Picked PGLite and now want to join a team brain? One command:

```bash
/setup-gbrain --switch
```

The skill runs `gbrain migrate --to supabase --url "$URL"` wrapped in `timeout 180s`. Migration is bidirectional (Supabase → PGLite also works) and lossless — pages, chunks, embeddings, links, tags, and timeline all copy. Your original brain is preserved as a backup.

**If migration hangs:** another gstack session may be holding a lock on the source brain. The timeout fires at 3 minutes with an actionable message. Close other workspaces and re-run.

## GStack memory sync (a separate concern)

This is different from gbrain itself. Your gstack state (`~/.gstack/` — learnings, plans, retros, timeline, developer profile) is machine-local by default. "GStack memory sync" optionally pushes a curated, secret-scanned subset to a private git repo so your memory follows you across machines — and, if you're running gbrain, that git repo becomes indexable there too.

Turn it on with:

```bash
gstack-brain-init
```

You'll get a one-time privacy prompt: **everything allowlisted** / **artifacts only** (plans, designs, retros, learnings — skip behavioral data like timelines) / **off**. Every skill run syncs the queue at start and end — no daemon, no background process.

Secret-shaped content (AWS keys, GitHub tokens, PEM blocks, JWTs, bearer tokens) is blocked from sync before it leaves your machine.

**On a new machine:** Copy `~/.gstack-brain-remote.txt` over, run `gstack-brain-restore`, and yesterday's learnings surface on today's laptop.

Full guide: [docs/gbrain-sync.md](docs/gbrain-sync.md). Error index: [docs/gbrain-sync-errors.md](docs/gbrain-sync-errors.md).

`/setup-gbrain` offers to wire this up for you at the end of initial setup — it's one more AskUserQuestion, and it integrates with the same private-repo infrastructure.

## Cleanup orphan projects

If you Ctrl-C'd mid-provision, tried three different names before settling on one, or otherwise accumulated gbrain-shaped Supabase projects you don't use, there's a subcommand for that:

```bash
/setup-gbrain --cleanup-orphans
```

The skill re-collects a PAT (one-time, discarded after), lists every project in your Supabase account whose name starts with `gbrain` and whose ref doesn't match your active `~/.gbrain/config.json` pooler URL. For each orphan it asks per-project: *"Delete orphan project `<ref>` (`<name>`, created `<date>`)?"* — no batching, no "delete all" shortcut. The active brain is never offered for deletion.

## Command + flag reference

### `/setup-gbrain` entry modes

| Invocation | What it does |
|---|---|
| `/setup-gbrain` | Full flow: detect state, pick path, install, init, MCP, policy, optional memory-sync |
| `/setup-gbrain --repo` | Flip the per-remote trust policy for the current repo only |
| `/setup-gbrain --switch` | Migrate engine (PGLite ↔ Supabase) without re-running the other steps |
| `/setup-gbrain --resume-provision <ref>` | Resume a path-2a auto-provision that was interrupted during polling |
| `/setup-gbrain --cleanup-orphans` | List + per-project delete of orphan Supabase projects |

### Bin helpers (for scripting)

| Bin | Purpose |
|---|---|
| `gstack-gbrain-detect` | Emit current state as JSON: gbrain on PATH, version, config engine, doctor status, sync mode |
| `gstack-gbrain-install` | Detect-first installer (probes `~/git/gbrain`, `~/gbrain`, then fresh clone). Has `--dry-run` and `--validate-only` flags. PATH-shadow check exits 3 with remediation menu. |
| `gstack-gbrain-lib.sh` | Sourced, not executed. Provides `read_secret_to_env VARNAME "prompt" [--echo-redacted "<sed-expr>"]` |
| `gstack-gbrain-supabase-verify` | Structural URL check. Rejects direct-connection URLs (`db.*.supabase.co:5432`) with exit 3 |
| `gstack-gbrain-supabase-provision` | Management API wrapper. Subcommands: `list-orgs`, `create`, `wait`, `pooler-url`, `list-orphans`, `delete-project`. All require `SUPABASE_ACCESS_TOKEN` in env. `create` and `pooler-url` also require `DB_PASS`. `--json` mode available on every subcommand. |
| `gstack-gbrain-repo-policy` | Per-remote trust triad. Subcommands: `get`, `set`, `list`, `normalize` |
| `gstack-gbrain-source-wireup` | Registers your `~/.gstack/` brain repo with gbrain as a federated source via `gbrain sources add` + `git worktree`, then runs an initial `gbrain sync`. Idempotent. Replaces the dead `consumers.json + /ingest-repo` HTTP wireup from v1.12.x. Flags: `--strict`, `--source-id <id>`, `--no-pull`, `--uninstall`, `--probe`. |

### gbrain CLI (upstream tool)

Gbrain itself ships with these that gstack wraps:

| Command | Purpose |
|---|---|
| `gbrain init --pglite` | Initialize a local PGLite brain |
| `gbrain init --non-interactive` | Initialize via env (`GBRAIN_DATABASE_URL` or `DATABASE_URL`). Never pass a URL as argv — it'll leak to shell history. |
| `gbrain doctor --json` | Health check. Returns `{status: "ok"|"warnings"|"error", health_score: 0-100, checks: [...]}` |
| `gbrain migrate --to supabase --url ...` | Move a PGLite brain to Supabase (lossless, preserves source as backup) |
| `gbrain migrate --to pglite` | Reverse migration |
| `gbrain search "query"` | Search the brain |
| `gbrain put_page --title "..." --tags "a,b" <<<"content"` | Write a page |
| `gbrain get_page "<slug>"` | Fetch a page |
| `gbrain serve` | Start the MCP stdio server (used by `claude mcp add`) |

### Config files + state

| Path | What lives there |
|---|---|
| `~/.gbrain/config.json` | Engine (pglite/postgres), database URL or path, API keys. Mode 0600. Written by `gbrain init`. |
| `~/.gstack/gbrain-repo-policy.json` | Per-remote trust triad. Schema v2. Mode 0600. |
| `~/.gstack/.setup-gbrain.lock.d` | Concurrent-run lock (atomic mkdir). Released on normal exit + SIGINT. |
| `~/.gstack/.brain-queue.jsonl` | Pending sync entries for gstack memory sync |
| `~/.gstack/.brain-last-push` | Timestamp of last sync push (for `/health` scoring) |
| `~/.gstack-brain-remote.txt` | URL of your gstack memory sync remote (safe to copy between machines) |
| `~/.gstack/.setup-gbrain-inflight.json` | Reserved for future `--resume-provision` persisted state |

### Environment variables

| Var | Where it's read | What it does |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | `gstack-gbrain-supabase-provision` | PAT for Management API calls. Discarded after each setup run. |
| `DB_PASS` | `gstack-gbrain-supabase-provision` (create, pooler-url) | Generated DB password. Never in argv. |
| `GBRAIN_DATABASE_URL` | `gbrain init`, `gbrain doctor`, etc. | Postgres connection string (Supabase pooler URL for us). Env takes precedence over `~/.gbrain/config.json`. |
| `DATABASE_URL` | `gbrain init` (fallback) | Same semantics as `GBRAIN_DATABASE_URL`; checked second. |
| `SUPABASE_API_BASE` | `gstack-gbrain-supabase-provision` | Override the Management API host. Used by tests to point at a mock server. |
| `GBRAIN_INSTALL_DIR` | `gstack-gbrain-install` | Override default install path (`~/gbrain`) |
| `GSTACK_HOME` | every bin helper | Override `~/.gstack` state dir. Heavy test use. |
| `OPENAI_API_KEY` | `gbrain embed` subprocess | Required for embeddings during `gbrain sync` / `/sync-gbrain`. Without it, pages are imported structurally (symbol tables, chunks) but semantic search degrades — you'll see `[gbrain] embedding failed for code file ... OpenAI embedding requires OPENAI_API_KEY` in the sync log. |
| `ANTHROPIC_API_KEY` | `claude-agent-sdk`, paid evals | Required for `bun run test:evals` and any direct `query()` call against Claude. |
| `GSTACK_OPENAI_API_KEY` | `lib/conductor-env-shim.ts` | Conductor-injected fallback. Promoted to `OPENAI_API_KEY` when the canonical name is empty. |
| `GSTACK_ANTHROPIC_API_KEY` | `lib/conductor-env-shim.ts` | Same pattern as above for Anthropic. |

## Conductor + GSTACK_* env vars

If you run gstack inside a [Conductor](https://conductor.build) workspace, **Conductor explicitly strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the workspace env.** Setting them in `~/.zshrc` or `.env` won't help — the strip happens after env inheritance. To get a usable API key into a workspace, set `GSTACK_ANTHROPIC_API_KEY` and `GSTACK_OPENAI_API_KEY` in Conductor's workspace env config instead. Conductor passes those through untouched.

`lib/conductor-env-shim.ts` bridges the gap on the gstack side: when imported as a side effect (`import "../lib/conductor-env-shim";`), it promotes `GSTACK_FOO_API_KEY` to `FOO_API_KEY` for any subprocess that doesn't see the canonical name. The shim is already wired into:

- `bin/gstack-gbrain-sync.ts` — so `/sync-gbrain` picks up OpenAI for embeddings
- `bin/gstack-model-benchmark` — so `--judge` runs work without manual env mapping
- `scripts/preflight-agent-sdk.ts` — so paid-eval auth probes work
- `test/helpers/e2e-helpers.ts` — so `bun run test:evals` finds Anthropic

If you add a new TS entry point that hits a paid API or needs gbrain embeddings, add the same one-line import at the top. See [CONTRIBUTING.md "Conductor workspaces"](CONTRIBUTING.md#conductor-workspaces) for the contributor checklist.

`bin/gstack-codex-probe` is bash and doesn't read these directly — it relies on `~/.codex/` auth managed by the Codex CLI.

## Security model

One rule for every secret this skill touches: **env var only, never argv, never logged, never written to disk by us.** The only persistent storage is gbrain's own `~/.gbrain/config.json` at mode 0600, which is gbrain's discipline, not ours.

**Enforced in code:**

- CI grep test in `test/skill-validation.test.ts` fails the build if `$SUPABASE_ACCESS_TOKEN` or `$GBRAIN_DATABASE_URL` appears in an argv position
- CI grep test fails if `--insecure`, `-k`, or `NODE_TLS_REJECT_UNAUTHORIZED=0` appear in `bin/gstack-gbrain-supabase-provision`
- `set +x` at the top of the provision helper prevents debug tracing from leaking PAT
- Telemetry payload contains only enumerated categorical values (scenario, install result, MCP opt-in, trust tier) — never free-form strings that could contain secrets

**Enforced via tests:**

- `test/secret-sink-harness.test.ts` runs every secret-handling bin with a seeded secret and asserts the seed never appears in any captured channel (stdout, stderr, files under `$HOME`, telemetry JSONL). Four match rules per seed: exact, URL-decoded, first-12-char prefix, base64.
- Positive controls in the same test file deliberately leak seeds in every covered channel and assert the harness catches each one. Without the positive controls, a harness that silently under-reports would look identical to a working harness.

**What you can still leak** (the honest limits of v1):

- If you paste a secret into a normal chat message outside `read -s`, it's in the conversation transcript and any host-side logging
- The leak harness doesn't dump subprocess environment — a bin that `env >> ~/.log` would evade detection (no bin in v1 does this; grep tests prevent it)
- Your shell's own `HISTFILE` behavior is your shell's, not ours — we never pass secrets to argv so they don't land there via our code, but nothing stops you from pasting one into a raw `curl` command yourself

## Troubleshooting

### "PATH SHADOWING DETECTED" during install

Another `gbrain` binary is earlier in PATH than the one the installer just linked. The installer's version check caught it. Fix one of:

- `rm $(which gbrain)` if you don't need the other one
- Prepend `~/.bun/bin` to PATH in your shell rc so the linked binary wins
- Set `GBRAIN_INSTALL_DIR` to the shadowing binary's install directory and re-run

Then re-run `/setup-gbrain`.

### "rejected direct-connection URL"

You pasted a `db.<ref>.supabase.co:5432` URL. Those are IPv6-only and fail in most environments. Use the Session Pooler URL instead: Supabase dashboard → Settings → Database → Connection Pooler → **Session** → copy URI (port 6543).

### Auto-provision times out at 180s

The Supabase project is still initializing. Your ref was printed in the exit message. Wait a minute, then:

```bash
/setup-gbrain --resume-provision <ref>
```

The skill re-collects a PAT, skips project creation, resumes polling.

### "Another `/setup-gbrain` instance is running"

You have a stale lock directory. If you're sure no other instance is actually running:

```bash
rm -rf ~/.gstack/.setup-gbrain.lock.d
```

Then re-run.

### "No cross-model tension" on policy file

You edited `~/.gstack/gbrain-repo-policy.json` by hand with legacy `allow` values? No problem. On the next read, gstack auto-migrates `allow` → `read-write` and adds `_schema_version: 2`. One log line on stderr, idempotent, deterministic.

### `gbrain doctor` says "warnings"

`/health` treats that as yellow, not red. Check `gbrain doctor --json | jq .checks` to see which sub-checks are warning. Typical causes: resolver MECE overlap (skill names clashing) or DB connection not yet configured.

### `/sync-gbrain` reports `OK` but `gbrain search` returns nothing semantic

Embeddings probably failed during import. Symbol queries (`code-def`, `code-refs`) still work because they don't need embeddings, but `gbrain search "<terms>"` falls back to a degraded BM25 path. Look in the sync output for lines like:

```
[gbrain] embedding failed for code file <name>: OpenAI embedding requires OPENAI_API_KEY
```

The fix is to put `OPENAI_API_KEY` in the process env before re-running. On a bare Mac shell, source it from `~/.zshrc` before calling. In Conductor, set `GSTACK_OPENAI_API_KEY` at the workspace level — `lib/conductor-env-shim.ts` promotes it to canonical automatically when imported. Re-run `/sync-gbrain --code-only` to backfill embeddings on already-imported pages.

### `gbrain sync` blocked at a commit hash — `FILE_TOO_LARGE`

A file in your tree exceeds gbrain's 5 MB hard limit (`MAX_FILE_SIZE` in `gbrain/src/core/import-file.ts`). Common culprits: response replay caches, captured screenshots, large JSON fixtures. Gbrain doesn't honor `.gitignore`-style exclude lists for code sync; the only knob is acknowledging the failure:

```bash
gbrain sync --source <source-id> --skip-failed
```

Watermark advances past the offending commit. The same file fails again if it changes; re-skip when that happens.

### Switching PGLite → Supabase hangs

Another gstack session in a sibling Conductor workspace may be holding a lock on your local PGLite file via its preamble's `gstack-brain-sync` call. Close other workspaces, re-run `/setup-gbrain --switch`. The timeout is bounded at 180s so you'll never actually wait forever.

## Why this design

**Why per-remote trust triad and not binary allow/deny?** Multi-client consultants need search without write-back. A freelance dev working on Client A in the morning and Client B in the afternoon can't let A's code insights leak into a brain Client B can search. Read-only solves that cleanly.

**Why not bundle gbrain into gstack?** Gbrain is a separate, actively-developed project with its own release cadence, schema migrations, and MCP surface. Bundling would mean gstack has to gate gbrain updates, which slows gbrain improvements from reaching users. Separate-but-integrated lets each ship on its own cadence.

**Why `gbrain init --non-interactive` via env var and not a flag?** Connection strings contain database passwords. Passing them as argv lands the password in `ps`, shell history, and process listings. Env-var handoff keeps the secret in process memory only. Gbrain supports both `GBRAIN_DATABASE_URL` and `DATABASE_URL`; we use the former to avoid collisions with non-gbrain tooling.

**Why fail-hard on PATH shadowing instead of warn-and-continue?** A shadowed `gbrain` means every subsequent command calls a different binary than the one we just installed. That's a silent version-drift bug that surfaces as mysterious feature gaps weeks later. Setup skills have one job — set up a working environment. Refusing to install into a broken one is the setup-skill-correct behavior.

**Why not auto-import every repo?** Privacy + noise. An auto-import preamble hook that ingests every repo you touch would: (a) leak work code into a shared brain without consent, and (b) clog search with throwaway repos. The per-remote policy makes ingestion an explicit, per-repo decision. `/setup-gbrain` doesn't install any auto-import hook today — but the policy store is forward-compatible for one later.

## Related skills + next steps

- `/health` — includes a GBrain dimension (doctor status, sync queue depth, last-push age) in its 0-10 composite score. The dimension is omitted when gbrain isn't installed; running `/health` on a non-gbrain machine doesn't penalize that choice.
- `/gstack-upgrade` — keeps gstack itself up to date. Does NOT upgrade gbrain independently. To bump gbrain, update `PINNED_COMMIT` in `bin/gstack-gbrain-install` and re-run `/setup-gbrain`.
- `/retro` — weekly retrospective pulls learnings and plans from your gbrain when memory sync is on, letting the retro reference cross-machine history.

Run `/setup-gbrain` and see what sticks.
