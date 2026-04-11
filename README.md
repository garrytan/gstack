# gemini-gstack

A Gemini CLI fork of [gstack](https://github.com/garrytan/gstack) — the AI engineering workflow framework by [Garry Tan](https://x.com/garrytan).

**What this is:** All of gstack's workflow skills (CEO review, eng review, QA, ship, etc.) and the headless browser, adapted to run natively on [Gemini CLI](https://github.com/google-gemini/gemini-cli). No Claude Code dependency. No Anthropic API key required.

**What this is not:** A drop-in replacement for gstack. Claude-specific features (design binary GPT Image API, Codex cross-model review) are removed. The core workflow — think, plan, build, review, test, ship — works identically.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Skills Reference](#skills-reference)
  - [The Sprint](#the-sprint)
  - [Power Tools](#power-tools)
  - [Voice Input](#voice-input)
- [Compatibility with Claude Code](#compatibility-with-claude-code)
  - [What Works](#what-works)
  - [What's Degraded](#whats-degraded)
  - [What's Removed](#whats-removed)
  - [Head-to-Head Test Results](#head-to-head-test-results)
- [Other AI Agents](#other-ai-agents)
- [Documentation](#documentation)
- [Uninstall](#uninstall)
- [Privacy & Telemetry](#privacy--telemetry)
- [Troubleshooting](#troubleshooting)
- [Upstream & License](#upstream--license)

---

## Quick Start

**Requirements:** [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+

### Install (30 seconds)

```bash
git clone --single-branch --depth 1 https://github.com/bjohnson135/gemini-gstack.git ~/.gemini/extensions/gstack
cd ~/.gemini/extensions/gstack && ./setup
```

Then add a gstack section to your project's `GEMINI.md`:

```markdown
## gstack
Use /browse from gstack for all web browsing.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy,
/canary, /benchmark, /browse, /qa, /qa-only, /design-review, /setup-browser-cookies,
/setup-deploy, /retro, /investigate, /document-release, /cso, /autoplan, /plan-devex-review,
/devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn.
```

---

## How It Works

```
You:    I want to build a daily briefing app for my calendar.
You:    /office-hours
Gemini: [asks about the pain — specific examples, not hypotheticals]

You:    Multiple Google calendars, events with stale info, wrong locations.
        Prep takes forever and the results aren't good enough...

Gemini: I'm going to push back on the framing. You said "daily briefing
        app." But what you actually described is a personal chief of
        staff AI.
        [extracts 5 capabilities you didn't realize you were describing]
        [challenges 4 premises — you agree, disagree, or adjust]
        [generates 3 implementation approaches with effort estimates]

You:    /plan-ceo-review
        [reads the design doc, challenges scope, runs 10-section review]

You:    /plan-eng-review
        [ASCII diagrams for data flow, state machines, error paths]

You:    Approve plan. Build it.
        [writes 2,400 lines across 11 files]

You:    /review
        [AUTO-FIXED] 2 issues. [ASK] Race condition → you approve fix.

You:    /qa https://staging.myapp.com
        [opens real browser, clicks through flows, finds and fixes a bug]

You:    /ship
        Tests: 42 → 51 (+9 new). PR: github.com/you/app/pull/42
```

Eight commands, end to end. That is not a copilot. That is a team.

---

## Skills Reference

### The Sprint

gstack is a process, not a collection of tools. The skills run in the order a sprint runs:

**Think &rarr; Plan &rarr; Build &rarr; Review &rarr; Test &rarr; Ship &rarr; Reflect**

Each skill feeds into the next. `/office-hours` writes a design doc that `/plan-ceo-review` reads. `/plan-eng-review` writes a test plan that `/qa` picks up. `/review` catches bugs that `/ship` verifies are fixed.

| Skill | Your specialist | What they do |
|-------|----------------|--------------|
| `/office-hours` | **YC Office Hours** | Start here. Six forcing questions that reframe your product before you write code. |
| `/plan-ceo-review` | **CEO / Founder** | Rethink the problem. Find the 10-star product hiding inside the request. |
| `/plan-eng-review` | **Eng Manager** | Lock in architecture, data flow, diagrams, edge cases, and tests. |
| `/plan-design-review` | **Senior Designer** | Rates each design dimension 0-10, explains what a 10 looks like. AI Slop detection. |
| `/plan-devex-review` | **DX Lead** | Interactive DX review: developer personas, TTHW benchmarks, friction point tracing. |
| `/design-consultation` | **Design Partner** | Build a complete design system from scratch. |
| `/review` | **Staff Engineer** | Find the bugs that pass CI but blow up in production. Auto-fixes the obvious ones. |
| `/investigate` | **Debugger** | Systematic root-cause debugging. No fixes without investigation. |
| `/design-review` | **Designer Who Codes** | Same audit as /plan-design-review, then fixes what it finds. |
| `/devex-review` | **DX Tester** | Live developer experience audit — actually tests your onboarding. |
| `/design-shotgun` | **Design Explorer** | Generates 4-6 AI mockup variants, opens comparison board, iterates on feedback. |
| `/design-html` | **Design Engineer** | Turn a mockup into production HTML. Pretext computed layout, 30KB, zero deps. |
| `/qa` | **QA Lead** | Test your app, find bugs, fix them, re-verify with regression tests. |
| `/qa-only` | **QA Reporter** | Same methodology as /qa but report only. No code changes. |
| `/pair-agent` | **Multi-Agent Coordinator** | Share your browser with any AI agent. Scoped tokens, tab isolation. |
| `/cso` | **Chief Security Officer** | OWASP Top 10 + STRIDE threat model. Zero-noise, 8/10+ confidence gate. |
| `/ship` | **Release Engineer** | Sync main, run tests, audit coverage, push, open PR. |
| `/land-and-deploy` | **Release Engineer** | Merge PR, wait for CI and deploy, verify production health. |
| `/canary` | **SRE** | Post-deploy monitoring loop for errors and regressions. |
| `/benchmark` | **Performance Engineer** | Baseline page load times, Core Web Vitals, resource sizes. |
| `/document-release` | **Technical Writer** | Update all project docs to match what you just shipped. |
| `/retro` | **Eng Manager** | Team-aware weekly retro with per-person breakdowns and shipping streaks. |
| `/browse` | **QA Engineer** | Real Chromium browser, real clicks, real screenshots. ~100ms per command. |
| `/autoplan` | **Review Pipeline** | One command: CEO &rarr; design &rarr; eng review automatically. |
| `/learn` | **Memory** | Manage what gstack learned across sessions. Learnings compound over time. |

### Power Tools

| Skill | What it does |
|-------|-------------|
| `/careful` | **Safety Guardrails** — warns before destructive commands (rm -rf, DROP TABLE, force-push). |
| `/freeze` | **Edit Lock** — restrict file edits to one directory. |
| `/guard` | **Full Safety** — `/careful` + `/freeze` in one command. |
| `/unfreeze` | **Unlock** — remove the `/freeze` boundary. |
| `/setup-deploy` | **Deploy Configurator** — one-time setup for `/land-and-deploy`. |
| `/gstack-upgrade` | **Self-Updater** — upgrade gstack to latest. |

**[Deep dives with examples and philosophy for every skill &rarr;](docs/skills.md)**

### Voice Input

gstack skills have voice-friendly trigger phrases. Say what you want naturally —
"run a security check", "test the website", "do an engineering review" — and the
right skill activates. Works with AquaVoice, Whisper, or any voice input tool.

---

## Compatibility with Claude Code

This fork translates all Claude Code concepts to Gemini CLI equivalents. The
generator automatically rewrites tool names, file paths, and invocation patterns.
Full details in **[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)**.

### What Works

All 36 workflow skills, the headless browser, git/GitHub operations, web search,
file operations, plan mode, skill invocation, task tracking, and safety guardrails
work at full parity. Every Claude Code tool has a direct Gemini CLI equivalent:

| Claude Code | Gemini CLI | Status |
|-------------|------------|--------|
| `Bash` | `run_shell_command` | Full parity |
| `Read` | `read_file` | Full parity |
| `Write` | `write_file` | Full parity |
| `Edit` | `replace` | Full parity |
| `Grep` | `grep_search` | Full parity |
| `Glob` | `glob` | Full parity |
| `AskUserQuestion` | `ask_user` | Full parity |
| `WebSearch` | `google_web_search` | Full parity |
| `WebFetch` | `web_fetch` | Full parity |
| `Skill` | `activate_skill` | Full parity |
| `TodoWrite` | `write_todos` | Full parity |
| `ExitPlanMode` | `exit_plan_mode` | Full parity |

### What's Degraded

| Feature | Impact |
|---------|--------|
| **Parallel subagents** | Gemini CLI has no `Agent` tool. Multi-specialist workflows (design-shotgun, autoplan) run sequentially instead of in parallel. Same results, more wall-clock time. |
| **Tool execution hooks** | Claude Code's `PreToolUse`/`PostToolUse` hooks don't exist in Gemini. Safety skills (`/careful`, `/freeze`, `/guard`) use advisory prose instead of hard blocks. |
| **Cross-project learnings** | Gemini gets project-scoped learnings only (no "I learned X in project Y" suggestions). |

### What's Removed

| Feature | Why |
|---------|-----|
| Codex second opinion (`/codex`) | Claude-specific cross-model integration |
| Design binary (GPT Image API) | Uses OpenAI's image generation API |
| Sidebar agent routing | Sonnet/Opus model-specific |
| Chrome MCP tools | Use the `$B` browse binary instead |

### Head-to-Head Test Results

We run identical prompts through both CLIs and compare results. Latest run (2026-04-10):

| Test | Claude | Gemini | Behavior |
|------|--------|--------|----------|
| File read | PASS (6s) | PASS (16s) | Equivalent |
| File search | PASS (8s) | PASS (15s) | Equivalent |
| Grep search | PASS (6s) | PASS (14s) | Equivalent |
| Shell command | PASS (5s) | PASS (13s) | Equivalent |
| Skill discovery | PASS (16s) | PASS (8s) | Equivalent |
| Code analysis | PASS (5s) | PASS (26s) | Equivalent |
| Multi-file comparison | PASS (10s) | PASS (48s) | Equivalent |
| Web search | PASS (13s) | PASS (27s) | Equivalent |
| Safety refusal | PASS (4s) | PASS (17s) | Equivalent |

**9/9 both passed.** Gemini produces equivalent results on every test. It tends to be
more thorough (reads more files for context) at the cost of more wall-clock time.
Claude is faster per-operation. Gemini was faster on skill discovery (8s vs 16s).

#### Skill-Level Comparison

We also ran actual gstack skill invocations head-to-head:

| Skill | Claude | Gemini | Notes |
|-------|--------|--------|-------|
| `/plan-ceo-review` | PASS (293s) | PASS (99s) | Both produced structured CEO reviews |
| `/plan-eng-review` | PASS (74s) | PASS (167s) | Both flagged JWT-in-localStorage |
| `/office-hours` | PASS (91s) | PASS (373s) | Both asked probing questions |
| `/cso` | PASS (188s) | PASS (115s) | Both ran security audits |
| `/review` | PASS (761s) | PASS (344s) | Both reviewed code diffs |

Both CLIs correctly activate and run every skill. Claude tends to spawn subagents
for deeper analysis; Gemini does everything in one session with more structured output.

Run the comparison yourself:

```bash
EVALS=1 bun test test/head-to-head.test.ts
```

See **[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)** for the full compatibility
matrix, skill-by-skill status, and how the translation system works.

---

## Other AI Agents

gstack also generates skills for other AI coding agents:

```bash
./setup --host <name>
```

| Agent | Flag | Skills install to |
|-------|------|-------------------|
| OpenAI Codex CLI | `--host codex` | `~/.codex/skills/gstack-*/` |
| OpenCode | `--host opencode` | `~/.config/opencode/skills/gstack-*/` |
| Cursor | `--host cursor` | `~/.cursor/skills/gstack-*/` |
| Factory Droid | `--host factory` | `~/.factory/skills/gstack-*/` |
| Slate | `--host slate` | `~/.slate/skills/gstack-*/` |
| Kiro | `--host kiro` | `~/.kiro/skills/gstack-*/` |

**Want to add support for another agent?** See [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md).

---

## Documentation

| Doc | What it covers |
|-----|---------------|
| **[Compatibility Matrix](docs/COMPATIBILITY.md)** | Claude vs Gemini: tool mapping, feature parity, skill status, head-to-head test results |
| **[Skill Deep Dives](docs/skills.md)** | Philosophy, examples, and workflow for every skill |
| **[Builder Ethos](ETHOS.md)** | Builder philosophy: Boil the Lake, Search Before Building |
| **[Architecture](ARCHITECTURE.md)** | Design decisions and system internals |
| **[Browser Reference](BROWSER.md)** | Full command reference for `/browse` |
| **[Adding a Host](docs/ADDING_A_HOST.md)** | How to add support for a new AI agent |
| **[Remote Browser Access](docs/REMOTE_BROWSER_ACCESS.md)** | Expose `/browse` over the network |
| **[Contributing](CONTRIBUTING.md)** | Dev setup, testing, and contributing |
| **[Changelog](CHANGELOG.md)** | What's new in every version |

---

## Uninstall

### Option 1: Run the uninstall script

```bash
~/.gemini/extensions/gstack/bin/gstack-uninstall
```

This handles skills, symlinks, global state (`~/.gstack/`), browse daemons, and temp files. Use `--keep-state` to preserve config and analytics. Use `--force` to skip confirmation.

### Option 2: Manual removal

```bash
# 1. Stop browse daemons
pkill -f "gstack.*browse" 2>/dev/null || true

# 2. Remove gstack extension
rm -rf ~/.gemini/extensions/gstack

# 3. Remove global state
rm -rf ~/.gstack

# 4. Remove other host integrations (skip any you never installed)
rm -rf ~/.codex/skills/gstack* 2>/dev/null
rm -rf ~/.factory/skills/gstack* 2>/dev/null
rm -rf ~/.kiro/skills/gstack* 2>/dev/null

# 5. Remove temp files
rm -f /tmp/gstack-* 2>/dev/null

# 6. Per-project cleanup (run from each project root)
rm -rf .gstack .gstack-worktrees .gemini/extensions/gstack 2>/dev/null
rm -rf .agents/skills/gstack* .factory/skills/gstack* 2>/dev/null
```

### Clean up GEMINI.md

The uninstall script does not edit GEMINI.md. In each project where gstack was added, remove the `## gstack` and `## Skill routing` sections.

### Playwright

`~/Library/Caches/ms-playwright/` (macOS) is left in place because other tools may share it. Remove it if nothing else needs it.

---

## Privacy & Telemetry

gstack includes **opt-in** usage telemetry to help improve the project. Here's exactly what happens:

- **Default is off.** Nothing is sent anywhere unless you explicitly say yes.
- **On first run,** gstack asks if you want to share anonymous usage data. You can say no.
- **What's sent (if you opt in):** skill name, duration, success/fail, gstack version, OS. That's it.
- **What's never sent:** code, file paths, repo names, branch names, prompts, or any user-generated content.
- **Change anytime:** `gstack-config set telemetry off` disables everything instantly.

**Local analytics are always available.** Run `gstack-analytics` to see your personal usage dashboard from the local JSONL file — no remote data needed.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Skill not showing up | `cd ~/.gemini/extensions/gstack && ./setup` |
| `/browse` fails | `cd ~/.gemini/extensions/gstack && bun install && bun run build` |
| Stale install | Run `/gstack-upgrade` — or set `auto_upgrade: true` in `~/.gstack/config.yaml` |
| Want shorter commands | `cd ~/.gemini/extensions/gstack && ./setup --no-prefix` |
| Want namespaced commands | `cd ~/.gemini/extensions/gstack && ./setup --prefix` |
| Gemini can't see skills | Make sure your project's `GEMINI.md` has a gstack section (see [Quick Start](#quick-start)) |
| Windows | Works on Windows 11 via Git Bash or WSL. Node.js required alongside Bun ([bun#4253](https://github.com/oven-sh/bun/issues/4253)). |

---

## Upstream & License

This is a fork of [garrytan/gstack](https://github.com/garrytan/gstack). The original supports Claude Code as the primary host. This fork replaces Claude with Gemini CLI. All credit for gstack's design, philosophy, and workflow skills goes to [Garry Tan](https://x.com/garrytan) and the gstack contributors.

MIT licensed. Free forever. Go build something.
