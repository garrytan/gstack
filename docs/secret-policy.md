# gstack Secret Policy

## Absolute rules

1. **No secrets in git.** `.env` and all `*.env` files are gitignored and must never be committed.
2. **No secrets printed to logs or AI chat.** Never `echo $ANTHROPIC_API_KEY` or similar in scripts, terminals, or AI sessions.
3. **Private env files are chmod 600.** Only the owner may read them.
4. **`.env.example` contains placeholder names only** — empty values, no real tokens, no partial tokens.
5. **Secrets are loaded only through approved wrappers** — never inline in scripts.
6. **Never paste tokens into a chat session or AI terminal.** Run `bin/gstack-secret-set` in a private terminal instead.

## Secret storage

Real secrets live only outside the repo:
- `~/.env` (personal machine default — chmod 600)
- `~/.config/gstack/env.private` (preferred — chmod 600)
- `~/.config/oni/env.private` (ONI cross-system fallback — chmod 600)
- GitHub Actions CI secrets (for CI/CD jobs only)

Loading pattern (preferred — loads all sources in order):
```bash
source bin/gstack-env-load
```

To set a new credential interactively:
```bash
bin/gstack-secret-set VAR_NAME
```

## Leak scan requirement

Before pushing any commit, run a redacted leak scan:
```bash
python3 - <<'PY'
import re, subprocess, sys
patterns = {
    "openai_key": re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),
    "github_token": re.compile(r"(ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}"),
    "slack_token": re.compile(r"xox[baprs]-[A-Za-z0-9\-]{20,}"),
    "generic_secret": re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*=\s*['\"]?[A-Za-z0-9_\-./+=]{16,}"),
}
files = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
hits = []; [hits.append((f, i, n)) for f in files for i, l in enumerate(open(f, errors="ignore").read().splitlines(), 1) if not any(x in l.lower() for x in ["example", "your_", "<", "changeme"]) for n, p in patterns.items() if p.search(l)]
print("LEAK_SCAN_FAIL\n" + "\n".join(f"{f}:{i} {n}" for f, i, n in hits)) if hits else print("LEAK_SCAN_CLEAN")
PY
```

## Adding new credentials

1. Add the placeholder name (empty value) to `.env.example`
2. Document the env var in this file under the variables table
3. Run `bin/gstack-secret-set VAR_NAME` in a private terminal
4. Verify: `[[ -n "$VAR_NAME" ]] && echo "set" || echo "missing"`

## Rotating secrets

Run `bin/gstack-secret-set VAR_NAME` in a private terminal. For GitHub Actions secrets, update via the GitHub UI. Do not rotate through AI sessions.

## Variables tracked

| Variable | Purpose | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API / LLM-as-judge evals | `~/.config/gstack/env.private` |
| `OPENAI_API_KEY` | OpenAI embeddings / evals | `~/.config/gstack/env.private` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini model access | `~/.config/gstack/env.private` |
| `VOYAGE_API_KEY` | Voyage code embeddings (gbrain) | `~/.config/gstack/env.private` |
| `GITHUB_TOKEN` | GitHub API calls, CI auth | `~/.config/gstack/env.private` or CI secrets |
| `SUPABASE_ACCESS_TOKEN` | Supabase management API (provision ops) | `~/.config/gstack/env.private` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (server-side only) | `~/.config/gstack/env.private` |
| `DB_PASS` | Supabase DB password (provision ops) | `~/.config/gstack/env.private` |
| `RAILWAY_TOKEN` | Railway deployments | `~/.config/gstack/env.private` |
| `SLACK_BOT_TOKEN` | Slack integrations | `~/.config/gstack/env.private` |

**Note:** `GSTACK_SUPABASE_URL` and `GSTACK_SUPABASE_ANON_KEY` in `supabase/config.sh` are **public keys** — safe to commit per Supabase's RLS architecture (equivalent to a Firebase public config).
