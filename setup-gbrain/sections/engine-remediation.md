<!-- AUTO-GENERATED from engine-remediation.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
### Step 1.5 remediation: broken-engine AskUserQuestion + repair branches

The user has a non-working local engine (Garry's repro: `~/.gbrain/config.json`
points at a dead Postgres URL). Fire a targeted AskUserQuestion BEFORE Step 2:

> D# — Your local gbrain engine isn't responding. How do you want to fix it?
> Project/branch/task: <one-sentence grounding using detected slug + branch>
> ELI10: gbrain has a config at `~/.gbrain/config.json` but the engine it points
> at isn't reachable. That could be a transient outage (Postgres container
> stopped, Tailscale down) OR a stale config you want to abandon. Different
> remediation for each case.
> Stakes if we pick wrong: "Switch to PGLite" overwrites your existing config
> (one-way door if the user actually wanted the broken engine). "Retry" preserves
> existing state for transient cases.
> Recommendation: A (Retry) — always try the cheap option first; if engine is
> just temporarily down it'll come back without any destructive change.
> Note: options differ in kind, not coverage — no completeness score.
> A) Retry — re-probe the engine (recommended; ~80ms)
>   ✅ Cheapest test: re-runs `gbrain sources list` to see if engine is back
>   ✅ Zero side effects; existing config preserved
>   ❌ If engine is permanently dead, retries forever; user must choose another option
> B) Switch to local PGLite (one-way — moves existing config to .bak)
>   ✅ Fastest path to a working local engine if user has abandoned the old one
>   ✅ ~30s; no accounts; private to this machine
>   ❌ Destructive — existing config moved to ~/.gbrain/config.json.gstack-bak-{ts}
> C) Switch brain mode (continue to Step 2 path picker)
>   ✅ Lets user pick Path 1/2/3/4 to re-init from scratch
>   ✅ Preserves existing config until they explicitly init the new one
>   ❌ Longer flow if user just wants to repair to PGLite
> D) Quit (do nothing)
>   ✅ No cons — this is a hard-stop choice
>   ❌ N/A
> Net: A is the right starting move; B/C are explicit destructive paths; D bails.

**If A (Retry)**: re-run `~/.claude/skills/gstack/bin/gstack-gbrain-detect`
with `GSTACK_DETECT_NO_CACHE=1` (busts the 60s cache). If the new
`gbrain_local_status` is `ok`, continue to Step 2. If still `broken-db` or
`broken-config`, fire the same AskUserQuestion again (the user picks again).

**If B (Switch to PGLite)** — execute the rollback-safe init sequence (plan D7):

```bash
BACKUP="$HOME/.gbrain/config.json.gstack-bak-$(date +%s)"
mv "$HOME/.gbrain/config.json" "$BACKUP"
# gstack default: voyage-code-3 (1024d) when VOYAGE_API_KEY is set — best for
# code retrieval. Without the key, fall back to gbrain's own auto-selected
# embedding provider chain (OpenAI 1536d when OPENAI_API_KEY is present, etc.).
# Never select gbrain's legacy zeroentropyai recipe for a new brain: the hosted
# API sunsets September 4, 2026 (#2365); the wireup helper warns existing installs.
set --  # flags ride the positional params — unquoted $VAR breaks under zsh word-splitting (#1798)
if [ -n "${VOYAGE_API_KEY:-}" ]; then
  set -- --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
fi
if ! gbrain init --pglite --json "$@"; then
  # Restore on failure
  mv "$BACKUP" "$HOME/.gbrain/config.json"
  echo "gbrain init failed. Your previous config was restored at $HOME/.gbrain/config.json." >&2
  echo "PGLite directory at ~/.gbrain/pglite/ may be in a partial state — \`rm -rf ~/.gbrain/pglite\` if needed before retrying." >&2
  exit 1
fi
echo "Switched to local PGLite. Previous config saved at $BACKUP — review before deleting."
```

Then jump to Step 5a (MCP registration; the new PGLite engine is registered as
local-stdio).

**If C (Switch brain mode)**: continue to Step 2's normal path picker.

**If D (Quit)**: STOP the skill cleanly.
