# nstack

nstack turns Claude Code into your remote team. The tool currently has 23 specialists and 8 power tools.

I forked nstack from [GStack](https://github.com/garrytan/gstack) for two reasons:

1. GStack does an exceptional job of teaching AI to emulate SWE workflows. I wanted AI to emulate any workflow.
2. GStack functions as a content marketing tool for YC. I wanted something purely focused on my workflows.

Along the way, I've added some nice-to-haves like multi-model review Codex + Claude and some better file management. The core sprint methodology is the same. The voice, the features, and the direction are mine.

## Quick start

```bash
git clone --depth 1 https://github.com/neilenatarajan/nstack.git ~/.claude/skills/nstack
cd ~/.claude/skills/nstack && ./setup
```

Then in Claude Code:

1. `/office-hours` -- describe what you're building; start here for every new project.
2. `/autoplan` -- get a fully reviewed plan; this currently leans heavily into the SWE workflow but I intend to adapt the skill to other workflows.
3. Build it. Coming soon: `/build`.
4. `/review` -- find the bugs (SWE-only). Coming soon: a more generic review routing skill.
6. Some testing and qa stuff working into the flow soon.
6. `/ship` -- open the PR.
7. `/retro` -- reflect.

That's the sprint. You'll know if this is for you.

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+

## The sprint

nstack is a process, not a collection of tools. Seven phases, each feeding into the next:

**Think → Plan → Build → Review → Test → Ship → Reflect**

| Phase | Skills | What happens |
|-------|--------|-------------|
| **Think** | `/office-hours` | Reframe the problem. Challenge premises. Write a design doc. |
| **Plan** | `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/autoplan` | Lock architecture, scope, tests, UX. |
| **Build** | (you + Claude) | Implement the plan. |
| **Review** | `/review`, `/codex` | Find bugs. Auto-fix the obvious ones. Multi-model second opinion. |
| **Test** | `/qa`, `/qa-only`, `/benchmark` | Real browser, real clicks. Performance baselines. |
| **Ship** | `/ship`, `/land-and-deploy`, `/canary` | PR to production, post-deploy monitoring. |
| **Reflect** | `/retro`, `/document-release` | Weekly retro. Auto-update all docs. |

Each skill feeds into the next. `/office-hours` writes a design doc that `/plan-ceo-review` reads. `/plan-eng-review` writes a test plan that `/qa` picks up. `/review` catches bugs that `/ship` verifies are fixed.

**[Full sprint walkthrough with examples →](docs/SPRINT_GUIDE.md)**

### All skills

| Skill | Role | What it does |
|-------|------|-------------|
| `/office-hours` | Product Partner | Six forcing questions. Reframes your product before you write code. |
| `/plan-ceo-review` | CEO | Rethink the problem. Find the 10-star product. Four scope modes. |
| `/plan-eng-review` | Eng Manager | Architecture, data flow, edge cases, test matrix. |
| `/plan-design-review` | Designer | Rate each dimension 0-10. Fix the plan to get there. |
| `/plan-devex-review` | DX Lead | Developer personas, TTHW benchmarks, friction tracing. |
| `/design-consultation` | Design Partner | Build a design system from scratch. Realistic product mockups. |
| `/design-shotgun` | Design Explorer | Generate 4-6 AI mockup variants. Comparison board. Iterate. |
| `/design-html` | Design Engineer | Approved mockup → production HTML. Computed layout. Framework detection. |
| `/review` | Staff Engineer | Finds bugs that pass CI. Auto-fixes the obvious ones. |
| `/codex` | Second Opinion | Independent review from OpenAI Codex CLI. Three modes. |
| `/investigate` | Debugger | Root-cause debugging. No fixes without investigation. |
| `/qa` | QA Lead | Real browser. Find bugs, fix, re-verify. Regression tests. |
| `/qa-only` | QA Reporter | Same methodology. Report only, no code changes. |
| `/design-review` | Designer Who Codes | Visual audit + fix loop. Atomic commits, before/after screenshots. |
| `/devex-review` | DX Tester | Live DX audit. Tests onboarding, times TTHW, screenshots errors. |
| `/pair-agent` | Multi-Agent | Share your browser with any AI agent. Tab isolation, scoped tokens. |
| `/cso` | Security Officer | OWASP Top 10 + STRIDE. Zero-noise, verified findings. |
| `/ship` | Release Engineer | Tests, coverage audit, PR. Bootstraps test frameworks. |
| `/land-and-deploy` | Release Engineer | Merge, deploy, verify production health. |
| `/canary` | SRE | Post-deploy monitoring loop. |
| `/benchmark` | Perf Engineer | Page load times, Core Web Vitals, resource sizes. |
| `/document-release` | Tech Writer | Update all docs to match what shipped. |
| `/retro` | Eng Manager | Weekly retro. Per-person breakdowns. Cross-project mode. |
| `/browse` | QA Engineer | Persistent Chromium browser. ~100ms per command. |
| `/open-nstack-browser` | Browser | NStack Browser with sidebar, anti-bot stealth, model routing. |
| `/autoplan` | Review Pipeline | All reviews in sequence. Auto-decides. Surfaces taste decisions only. |
| `/learn` | Memory | Manage what nstack learned across sessions. Compounds over time. |

**[Deep dives with examples →](docs/skills.md)**

### Which review do I use?

| Building for... | Plan stage | Live audit |
|-----------------|-----------|-----------|
| End users (UI, web app) | `/plan-design-review` | `/design-review` |
| Developers (API, CLI, SDK) | `/plan-devex-review` | `/devex-review` |
| Architecture (data flow, perf) | `/plan-eng-review` | `/review` |
| All of the above | `/autoplan` | ... |

### Power tools

| Skill | What it does |
|-------|-------------|
| `/careful` | Warns before destructive commands (rm -rf, DROP TABLE, force-push). |
| `/freeze` | Lock edits to one directory while debugging. |
| `/guard` | `/careful` + `/freeze` in one command. |
| `/setup-deploy` | One-time deploy config for `/land-and-deploy`. |
| `/setup-browser-cookies` | Import cookies from your real browser into the headless session. |
| `/nstack-upgrade` | Upgrade to latest. Detects global vs vendored install. |

## Install

### Claude Code (primary)

Open Claude Code and paste:

> Install nstack: run **`git clone --depth 1 https://github.com/neilenatarajan/nstack.git ~/.claude/skills/nstack && cd ~/.claude/skills/nstack && ./setup`** then add a "nstack" section to CLAUDE.md listing the available skills.

### Team mode

Every developer installs globally, updates happen automatically:

```bash
cd ~/.claude/skills/nstack && ./setup --team
```

Bootstrap your repo so teammates get it:

```bash
cd <your-repo>
~/.claude/skills/nstack/bin/nstack-team-init required
git add .claude/ CLAUDE.md && git commit -m "require nstack for AI-assisted work"
```

### Other AI agents

nstack works on 8 agents. Setup auto-detects what you have installed:

```bash
git clone --depth 1 https://github.com/neilenatarajan/nstack.git ~/nstack
cd ~/nstack && ./setup
```

Or target a specific agent: `./setup --host <name>`

| Agent | Flag | Skills install to |
|-------|------|-------------------|
| OpenAI Codex CLI | `--host codex` | `~/.codex/skills/nstack-*/` |
| OpenCode | `--host opencode` | `~/.config/opencode/skills/nstack-*/` |
| Cursor | `--host cursor` | `~/.cursor/skills/nstack-*/` |
| Factory Droid | `--host factory` | `~/.factory/skills/nstack-*/` |
| Slate | `--host slate` | `~/.slate/skills/nstack-*/` |
| Kiro | `--host kiro` | `~/.kiro/skills/nstack-*/` |

See [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md) to add support for another agent.

### OpenClaw

OpenClaw spawns Claude Code sessions, so nstack skills work automatically. See [docs/OPENCLAW.md](docs/OPENCLAW.md) for setup and dispatch routing.

## Configuration

nstack stores settings in `~/.nstack/config.yaml`. Common options:

```yaml
skill_prefix: false    # true = /nstack-qa, false = /qa
proactive: true        # auto-suggest skills based on context
auto_upgrade: false    # auto-update on session start
```

Change with: `./setup --prefix` / `./setup --no-prefix`, or say "stop suggesting" to disable proactive mode.

## Troubleshooting

**Skill not showing up?** `cd ~/.claude/skills/nstack && ./setup`

**`/browse` fails?** `cd ~/.claude/skills/nstack && bun install && bun run build`

**Stale install?** Run `/nstack-upgrade` or set `auto_upgrade: true` in `~/.nstack/config.yaml`

**Want shorter commands?** `./setup --no-prefix` switches `/nstack-qa` to `/qa`.

**Want namespaced commands?** `./setup --prefix` switches `/qa` to `/nstack-qa`.

**Codex skill loading errors?** `cd ~/.codex/skills/nstack && git pull && ./setup --host codex`

**Windows:** Works on Windows 11 via Git Bash or WSL. Node.js required alongside Bun ([bun#4253](https://github.com/oven-sh/bun/issues/4253)).

**Claude can't see skills?** Add this to your project's CLAUDE.md:

```
## nstack
Use /browse from nstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy,
/canary, /benchmark, /browse, /open-nstack-browser, /qa, /qa-only, /design-review,
/setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex,
/cso, /autoplan, /pair-agent, /careful, /freeze, /guard, /unfreeze, /nstack-upgrade, /learn.
```

## Uninstall

```bash
~/.claude/skills/nstack/bin/nstack-uninstall
```

Use `--keep-state` to preserve config and analytics. Use `--force` to skip confirmation.

If you don't have the repo cloned:

```bash
pkill -f "nstack.*browse" 2>/dev/null || true
find ~/.claude/skills -maxdepth 1 -type l 2>/dev/null | while read -r link; do
  case "$(readlink "$link" 2>/dev/null)" in nstack/*|*/nstack/*) rm -f "$link" ;; esac
done
rm -rf ~/.claude/skills/nstack ~/.nstack
rm -rf ~/.codex/skills/nstack* ~/.factory/skills/nstack* ~/.kiro/skills/nstack* 2>/dev/null
rm -f /tmp/nstack-* 2>/dev/null
```

Per-project: `rm -rf .nstack .nstack-worktrees .claude/skills/nstack .agents/skills/nstack*`

Remove the `## nstack` and `## Skill routing` sections from each project's CLAUDE.md.

## Docs

| Doc | What it covers |
|-----|---------------|
| [Sprint Guide](docs/SPRINT_GUIDE.md) | Full walkthrough of the 7-phase sprint with examples |
| [Skill Deep Dives](docs/skills.md) | Philosophy, workflow, and examples for every skill |
| [Builder Ethos](ETHOS.md) | Boil the Lake, Search Before Building, User Sovereignty |
| [Architecture](ARCHITECTURE.md) | Design decisions and system internals |
| [Browser Reference](BROWSER.md) | Full command reference for `/browse` |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, and contributor workflow |
| [Changelog](CHANGELOG.md) | What's new in every version |

## License

MIT. Free forever. Go build something.
