# nstack

AI workflow skills for Claude Code. One repo, one install, entire engineering workflow.

nstack turns Claude Code into a virtual engineering team: a CEO who rethinks the product, an eng manager who locks architecture, a designer who catches AI slop, a reviewer who finds production bugs, a QA lead who opens a real browser, a security officer who runs OWASP + STRIDE audits, and a release engineer who ships the PR. Twenty-three specialists and eight power tools, all slash commands, all Markdown, all free, MIT license.

**Think, Plan, Build, Review, Test, Ship, Reflect.** Each skill feeds into the next.

## Quick start (30 seconds)

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+

### Option A: Add to your project (recommended)

Clone into your project so teammates get it automatically:

```bash
git clone --depth 1 https://github.com/neilenatarajan/nstack.git .claude/skills/nstack
cd .claude/skills/nstack && ./setup
```

Commit `.claude/skills/nstack/` to your repo. Anyone who clones gets the skills. Nothing touches your PATH or runs in the background.

### Option B: Install globally

```bash
git clone --depth 1 https://github.com/neilenatarajan/nstack.git ~/.claude/skills/nstack
cd ~/.claude/skills/nstack && ./setup
```

### Option C: One-command global install

```bash
./install
```

Clones from GitHub, builds binaries, links skills, and adds routing rules to `~/.claude/CLAUDE.md`. Re-run to update to latest. Works in Conductor as a setup script.

Then try it:

1. `/office-hours` -- describe what you're building
2. `/review` -- on any branch with changes
3. `/qa` on your staging URL
4. `/ship` -- tests, PR, done

## How it works

```
You:    I want to build a daily briefing app for my calendar.
You:    /office-hours
Claude: [asks forcing questions, challenges your framing]
        "You said 'daily briefing app.' What you described is a
         personal chief of staff AI."
        [extracts capabilities, generates implementation approaches]

You:    /plan-eng-review
        [ASCII diagrams, test matrix, failure modes]

You:    Approve plan. Exit plan mode.
        [writes 2,400 lines across 11 files]

You:    /review
        [AUTO-FIXED] 2 issues. [ASK] Race condition -> you approve.

You:    /qa https://staging.myapp.com
        [opens real browser, finds and fixes a bug]

You:    /ship
        Tests: 42 -> 51 (+9 new). PR opened.
```

## Skills

| Skill | What it does |
|-------|-------------|
| `/office-hours` | Start here. Forcing questions that reframe your product before you write code. |
| `/plan-ceo-review` | Rethink the problem. Find the 10-star product. Four modes: Expansion, Selective, Hold, Reduction. |
| `/plan-eng-review` | Lock architecture, data flow, diagrams, edge cases, tests. |
| `/plan-design-review` | Rate each design dimension 0-10, explain what a 10 looks like, then fix the plan. |
| `/plan-devex-review` | DX review: developer personas, TTHW benchmarks, friction points. |
| `/autoplan` | Runs CEO, design, eng review automatically. Surfaces only taste decisions. |
| `/review` | Find bugs that pass CI but blow up in production. Auto-fixes the obvious ones. |
| `/investigate` | Systematic root-cause debugging. No fixes without investigation. |
| `/design-review` | Design audit + fix loop. Atomic commits, before/after screenshots. |
| `/devex-review` | Live DX audit. Tests your onboarding, times TTHW, screenshots errors. |
| `/design-consultation` | Build a complete design system from scratch. |
| `/design-shotgun` | Generate multiple AI design variants, compare in browser, iterate. |
| `/design-html` | Production-quality HTML with Pretext for computed text layout. |
| `/qa` | Test your app in a real browser, find bugs, fix them, add regression tests. |
| `/qa-only` | Same as /qa but report only. No code changes. |
| `/cso` | OWASP Top 10 + STRIDE threat model. Each finding includes a concrete exploit. |
| `/ship` | Sync main, run tests, audit coverage, push, open PR. |
| `/land-and-deploy` | Merge PR, wait for CI and deploy, verify production. |
| `/canary` | Post-deploy monitoring. Console errors, perf regressions, page failures. |
| `/benchmark` | Baseline page load times, Core Web Vitals, resource sizes. |
| `/document-release` | Update all project docs to match what you shipped. |
| `/retro` | Weekly retro with per-person breakdowns, shipping streaks, test health. |
| `/browse` | Real Chromium browser, real clicks, real screenshots. ~100ms per command. |
| `/codex` | Independent review from OpenAI Codex CLI. Cross-model analysis. |
| `/careful` | Safety guardrails. Warns before destructive commands. |
| `/freeze` | Lock edits to one directory while debugging. |
| `/guard` | /careful + /freeze in one command. |
| `/learn` | Manage project-specific patterns, pitfalls, preferences across sessions. |
| `/nstack-upgrade` | Self-updater. Detects global vs vendored, syncs both. |

## Per-repo storage

nstack stores learnings, timeline, and review data in `.nstack/` at the root of your repo. This means:

- **Learnings travel with the project.** Clone the repo, get the accumulated knowledge.
- **No global state conflicts.** Multiple projects, isolated storage.
- **Falls back to `~/.nstack/`** outside a git repo or when `NSTACK_HOME` is set.

Add `.nstack/` to your `.gitignore` if you don't want to share learnings across the team, or commit it to share project-specific patterns.

## Other AI agents

nstack works on 8 AI coding agents, not just Claude. Setup auto-detects which agents you have installed.

```bash
# Auto-detect all agents
./setup

# Or target a specific one
./setup --host codex      # OpenAI Codex CLI (~/.codex/skills/nstack-*/)
./setup --host opencode   # OpenCode (~/.config/opencode/skills/nstack-*/)
./setup --host cursor     # Cursor (~/.cursor/skills/nstack-*/)
./setup --host factory    # Factory Droid (~/.factory/skills/nstack-*/)
./setup --host openclaw   # OpenClaw (~/.openclaw/skills/nstack-*/)
./setup --host slate      # Slate
./setup --host kiro       # Amazon Kiro
```

## Troubleshooting

**Skill not showing up?** `cd .claude/skills/nstack && ./setup`

**`/browse` fails?** `cd .claude/skills/nstack && bun install && bun run build`

**Stale install?** Run `/nstack-upgrade`

**Want shorter commands?** `./setup --no-prefix` (switches `/nstack-qa` to `/qa`)

**Windows:** Works on Windows 11 via Git Bash or WSL. Requires Node.js alongside Bun ([bun#4253](https://github.com/oven-sh/bun/issues/4253)).

## Docs

| Doc | What it covers |
|-----|---------------|
| [Skill Deep Dives](docs/skills.md) | Philosophy, examples, and workflow for every skill |
| [Builder Ethos](ETHOS.md) | Boil the Lake, Search Before Building, three layers of knowledge |
| [Architecture](ARCHITECTURE.md) | Design decisions and system internals |
| [Browser Reference](BROWSER.md) | Full command reference for `/browse` |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, contributor mode |
| [Changelog](CHANGELOG.md) | What's new in every version |

## License

MIT. Free forever.
