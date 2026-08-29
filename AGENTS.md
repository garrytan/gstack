# gstack — AI Engineering Workflow (Cursor)

gstack is a collection of specialist skills for software development: CEO reviewer, eng manager, designer, QA lead, release engineer, debugger, and more.

This checkout is **Cursor-native**. Skills live in `.cursor/skills/`. Type `/office-hours` (or any skill name) in Agent chat, or `@` a skill to attach it. The agent also auto-invokes a skill when your request matches its description.

## Available skills

### Plan-mode reviews

| Skill | What it does |
|-------|-------------|
| `/office-hours` | Start here. Reframes your product idea before you write code. |
| `/plan-ceo-review` | CEO-level review: find the 10-star product in the request. |
| `/plan-eng-review` | Lock architecture, data flow, edge cases, and tests. |
| `/plan-design-review` | Rate each design dimension 0-10, explain what a 10 looks like. |
| `/plan-devex-review` | DX-mode review: TTHW, magical moments, friction points, persona traces. |
| `/plan-tune` | Self-tune AskQuestion sensitivity per question. |
| `/autoplan` | One command runs CEO → design → eng → DX review. |
| `/design-consultation` | Build a complete design system from scratch. |
| `/spec` | Turn vague intent into a precise, executable spec in five phases. Files a GitHub issue. |

### Implementation + review

| Skill | What it does |
|-------|-------------|
| `/review` | Pre-landing PR review. Finds bugs that pass CI but break in prod. |
| `/codex` | Second opinion via OpenAI Codex CLI. Review, challenge, or consult modes. |
| `/investigate` | Systematic root-cause debugging. No fixes without investigation. |
| `/design-review` | Live-site visual audit + fix loop with atomic commits. |
| `/design-shotgun` | Generate multiple AI design variants, comparison board, iterate. |
| `/design-html` | Generate production-quality Pretext-native HTML/CSS. |
| `/devex-review` | Live developer experience audit (TTHW measured against the real flow). |
| `/qa` | Open a real browser, find bugs, fix them, re-verify. |
| `/qa-only` | Same methodology as /qa but report only — no code changes. |
| `/scrape` | Pull data from a web page. First call prototypes; codified call runs in ~200ms. |
| `/skillify` | Codify the most recent successful `/scrape` flow into a permanent browser-skill. |

### Release + deploy

| Skill | What it does |
|-------|-------------|
| `/ship` | Run tests, review, push, open PR. Workspace-aware version queue. |
| `/land-and-deploy` | Merge the PR, wait for CI and deploy, verify production health. |
| `/canary` | Post-deploy monitoring loop using the browse daemon. |
| `/landing-report` | Read-only dashboard for the workspace-aware ship queue. |
| `/document-release` | Update all docs to match what you just shipped. |
| `/document-generate` | Generate Diataxis docs (tutorial / how-to / reference / explanation) from code. |
| `/setup-deploy` | One-time deploy config detection (Fly.io, Render, Vercel, etc.). |
| `/gstack-upgrade` | Update gstack to the latest version. |

### Operational + memory

| Skill | What it does |
|-------|-------------|
| `/context-save` | Save working context (git state, decisions, remaining work). |
| `/context-restore` | Resume from a saved context. |
| `/learn` | Manage what gstack learned across sessions. |
| `/retro` | Weekly retro with per-person breakdowns and shipping streaks. |
| `/health` | Code quality dashboard (type checker, linter, tests, dead code). |
| `/benchmark` | Performance regression detection (page load, Core Web Vitals). |
| `/benchmark-models` | Cross-model benchmark for skills. |
| `/cso` | OWASP Top 10 + STRIDE security audit. |
| `/setup-gbrain` | Set up gbrain for cross-machine session memory sync. |
| `/sync-gbrain` | Keep gbrain current with this repo's code. |

### Browser + agent integration

| Skill | What it does |
|-------|-------------|
| `/browse` | Headless browser — real Chromium, real clicks, ~100ms/command. |
| `/open-gstack-browser` | Launch the visible GStack Browser with sidebar + stealth. |
| `/setup-browser-cookies` | Import cookies from your real browser for authenticated testing. |
| `/pair-agent` | Pair a remote AI agent with your browser. |

### iOS QA

| Skill | What it does |
|-------|-------------|
| `/ios-qa` | Live-device iOS QA via USB CoreDevice tunnel + embedded StateServer. |
| `/ios-fix` | Autonomous iOS bug fixer with regression snapshot capture. |
| `/ios-design-review` | Designer's-eye QA on a real iPhone — 10-dimension Apple HIG rubric. |
| `/ios-clean` | Strip DebugBridge + #if DEBUG wiring before a Release build. |
| `/ios-sync` | Regenerate the iOS debug bridge against the latest upstream templates. |

### Safety + scoping

| Skill | What it does |
|-------|-------------|
| `/careful` | Warn before destructive commands (rm -rf, DROP TABLE, force-push). |
| `/freeze` | Lock edits to one directory. Hard block, not just a warning. |
| `/guard` | Activate both careful + freeze at once. |
| `/unfreeze` | Remove directory edit restrictions. |
| `/make-pdf` | Turn any markdown file into a publication-quality PDF. |
| `/diagram` | English in, diagram out: mermaid source + editable .excalidraw + SVG/PNG, offline. |

## How to invoke

1. Type `/` in Agent chat and pick a skill (e.g. `/review`).
2. Or say the work in plain language — routing in `.cursor/rules/gstack.mdc` plus each skill's `description` tells the agent when to load it.
3. When a skill matches, **Read `.cursor/skills/<name>/SKILL.md` and follow it**. Do not skip to a thinner improvisation.

## Cursor tools

| Do | Don't |
|----|-------|
| `AskQuestion` | AskUserQuestion |
| `Shell` | Bash |
| `Task` | Agent |
| `StrReplace` | Edit |
| `AGENTS.md` | CLAUDE.md for product config |
| browse binary (`$B` / `bun run dev`) | Chrome MCP tools |

## Build commands

```bash
bun install              # install dependencies
bun run test             # run free tests via the strict shard runner (no API spend, ~90-100s)
bun run test:windows     # curated Windows-safe subset (runs on windows-latest)
bun run build            # generate docs + compile binaries
bun run gen:skill-docs   # regenerate Claude-host SKILL.md files from templates
bun run gen:cursor-native  # regenerate .cursor/skills/ from templates
bun run skill:check      # health dashboard for all skills
```

## Platform support

- **macOS** + **Linux**: full test suite supported.
- **Windows**: curated Windows-safe subset runs on `windows-latest`. Setup (`./setup`) requires Git Bash or MSYS today. `bin/gstack-paths` resolves state roots through `GSTACK_HOME`.

## Key conventions

- Cursor skills in `.cursor/skills/` are generated from `.tmpl` templates by `bun run gen:cursor-native`. Edit the template, then regenerate.
- Original `*/SKILL.md` files are the Claude Code host output. Cursor Agent should not follow those; use `.cursor/skills/` instead.
- The browse binary provides headless browser access. Use `$B <command>` in skills, or `bun run dev <command>` until `browse/dist/browse` is built (`./setup` or `bun run build`).
- Safety skills write state under `~/.gstack/` (or `$GSTACK_HOME`). Cursor hooks in `.cursor/hooks.json` enforce `/careful` and `/freeze` only after those files exist.
- Persist project-specific commands (test, eval, deploy) in `AGENTS.md` so they are not re-asked.
