# gstack

> "I don't think I've typed like a line of code probably since December, basically, which is an extremely large change." — [Andrej Karpathy](https://fortune.com/2026/03/21/andrej-karpathy-openai-cofounder-ai-agents-coding-state-of-psychosis-openclaw/), No Priors podcast, March 2026

When I heard Karpathy say this, I wanted to find out how. How does one person ship like a team of twenty? Peter Steinberger built [OpenClaw](https://github.com/openclaw/openclaw) — 247K GitHub stars — essentially solo with AI agents. The revolution is here. A single builder with the right tooling can move faster than a traditional team.

I'm [Garry Tan](https://x.com/garrytan), President & CEO of [Y Combinator](https://www.ycombinator.com/). I've worked with thousands of startups — Coinbase, Instacart, Rippling — when they were one or two people in a garage. Before YC, I was one of the first eng/PM/designers at Palantir, cofounded Posterous (sold to Twitter), and built Bookface, YC's internal social network.

**gstack is my answer.** I've been building products for twenty years, and right now I'm shipping more code than I ever have. In the last 60 days: **600,000+ lines of production code** (35% tests), **10,000-20,000 lines per day**, part-time, while running YC full-time. Here's my last `/retro` across 3 projects: **140,751 lines added, 362 commits, ~115k net LOC** in one week.

**2026 — 1,237 contributions and counting:**

![GitHub contributions 2026 — 1,237 contributions, massive acceleration in Jan-Mar](docs/images/github-2026.png)

**2013 — when I built Bookface at YC (772 contributions):**

![GitHub contributions 2013 — 772 contributions building Bookface at YC](docs/images/github-2013.png)

Same person. Different era. The difference is the tooling.

**gstack is how I do it.** It turns Claude Code into a virtual engineering team — a CEO who rethinks the product, an eng manager who locks architecture, a designer who catches AI slop, a reviewer who finds production bugs, a QA lead who opens a real browser, a security officer who runs OWASP + STRIDE audits, and a release engineer who ships the PR. Twenty specialists and eight power tools, all slash commands, all Markdown, all free, MIT license.

This is my open source software factory. I use it every day. I'm sharing it because these tools should be available to everyone.

Fork it. Improve it. Make it yours. And if you want to hate on free open source software — you're welcome to, but I'd rather you just try it first.

**Who this is for:**
- **Founders and CEOs** — especially technical ones who still want to ship
- **First-time Claude Code users** — structured roles instead of a blank prompt
- **Tech leads and staff engineers** — rigorous review, QA, and release automation on every PR

## Quick start

1. Install gstack (30 seconds — see below)
2. Run `/office-hours` — describe what you're building
3. Run `/plan-ceo-review` on any feature idea
4. Run `/review` on any branch with changes
5. Run `/qa` on your staging URL
6. Stop there. You'll know if this is for you.

## Install — 30 seconds

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+, [Node.js](https://nodejs.org/) (Windows only)

### Step 1: Install on your machine

Open Claude Code and paste this. Claude does the rest.

> Install gstack: run **`git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`** then add a "gstack" section to CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, and lists the available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade. Then ask the user if they also want to add gstack to the current project so teammates get it.

### Step 2: Add to your repo so teammates get it (optional)

> Add gstack to this project: run **`cp -Rf ~/.claude/skills/gstack .claude/skills/gstack && rm -rf .claude/skills/gstack/.git && cd .claude/skills/gstack && ./setup`** then add a "gstack" section to this project's CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, lists the available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, and tells Claude that if gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to build the binary and register skills.

Real files get committed to your repo (not a submodule), so `git clone` just works. Everything lives inside `.claude/`. Nothing touches your PATH or runs in the background.

### Codex, Gemini CLI, or Cursor

gstack works on any agent that supports the [SKILL.md standard](https://github.com/anthropics/claude-code). Skills live in `.agents/skills/` and are discovered automatically.

Install to one repo:

```bash
git clone https://github.com/garrytan/gstack.git .agents/skills/gstack
cd .agents/skills/gstack && ./setup --host codex
```

When setup runs from `.agents/skills/gstack`, it installs the generated Codex skills next to it in the same repo and does not write to `~/.codex/skills`.

Install once for your user account:

```bash
git clone https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup --host codex
```

`setup --host codex` creates the runtime root at `~/.codex/skills/gstack` and
links the generated Codex skills at the top level. This avoids duplicate skill
discovery from the source repo checkout.

Or let setup auto-detect which agents you have installed:

```bash
git clone https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup --host auto
```

For Codex-compatible hosts, setup now supports both repo-local installs from `.agents/skills/gstack` and user-global installs from `~/.codex/skills/gstack`. All 28 skills work across all supported agents. Hook-based safety skills (careful, freeze, guard) use inline safety advisory prose on non-Claude hosts.

### Pi

[Pi](https://github.com/mariozechner/pi-coding-agent) implements the [Agent Skills standard](https://agentskills.io/specification). Skills live in `~/.pi/agent/skills/` and are discovered automatically.

Install once for your user account:

```bash
git clone https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup --host pi
```

`setup --host pi` copies skills (with rewritten paths) to `~/.pi/agent/skills/` and symlinks runtime assets back to the checkout. Run `./setup --host pi` again after `git pull` to refresh, or use `/skill:gstack-upgrade`.

## See it work

```
You:    I want to build a daily briefing app for my calendar.
You:    /office-hours
Claude: [asks about the pain — specific examples, not hypotheticals]

You:    Multiple Google calendars, events with stale info, wrong locations.
        Prep takes forever and the results aren't good enough...

Claude: I'm going to push back on the framing. You said "daily briefing
        app." But what you actually described is a personal chief of
        staff AI.
        [extracts 5 capabilities you didn't realize you were describing]
        [challenges 4 premises — you agree, disagree, or adjust]
        [generates 3 implementation approaches with effort estimates]
        RECOMMENDATION: Ship the narrowest wedge tomorrow, learn from
        real usage. The full vision is a 3-month project — start with
        the daily briefing that actually works.
        [writes design doc → feeds into downstream skills automatically]

You:    /plan-ceo-review
        [reads the design doc, challenges scope, runs 10-section review]

You:    /plan-eng-review
        [ASCII diagrams for data flow, state machines, error paths]
        [test matrix, failure modes, security concerns]

You:    Approve plan. Exit plan mode.
        [writes 2,400 lines across 11 files. ~8 minutes.]

You:    /review
        [AUTO-FIXED] 2 issues. [ASK] Race condition → you approve fix.

You:    /qa https://staging.myapp.com
        [opens real browser, clicks through flows, finds and fixes a bug]

You:    /ship
        Tests: 42 → 51 (+9 new). PR: github.com/you/app/pull/42
```

You said "daily briefing app." The agent said "you're building a chief of staff AI" — because it listened to your pain, not your feature request. Eight commands, end to end. That is not a copilot. That is a team.

## The sprint

gstack is a process, not a collection of tools. The skills run in the order a sprint runs:

**Think → Plan → Build → Review → Test → Ship → Reflect**

Each skill feeds into the next. `/office-hours` writes a design doc that `/plan-ceo-review` reads. `/plan-eng-review` writes a test plan that `/qa` picks up. `/review` catches bugs that `/ship` verifies are fixed. Nothing falls through the cracks because every step knows what came before it.

| Skill | Your specialist | What they do |
|-------|----------------|--------------|
| `/office-hours` | **YC Office Hours** | Start here. Six forcing questions that reframe your product before you write code. Pushes back on your framing, challenges premises, generates implementation alternatives. Design doc feeds into every downstream skill. |
| `/plan-ceo-review` | **CEO / Founder** | Rethink the problem. Find the 10-star product hiding inside the request. Four modes: Expansion, Selective Expansion, Hold Scope, Reduction. |
| `/plan-eng-review` | **Eng Manager** | Lock in architecture, data flow, diagrams, edge cases, and tests. Forces hidden assumptions into the open. |
| `/plan-design-review` | **Senior Designer** | Rates each design dimension 0-10, explains what a 10 looks like, then edits the plan to get there. AI Slop detection. Interactive — one AskUserQuestion per design choice. |
| `/design-consultation` | **Design Partner** | Build a complete design system from scratch. Researches the landscape, proposes creative risks, generates realistic product mockups. |
| `/review` | **Staff Engineer** | Find the bugs that pass CI but blow up in production. Auto-fixes the obvious ones. Flags completeness gaps. |
| `/investigate` | **Debugger** | Systematic root-cause debugging. Iron Law: no fixes without investigation. Traces data flow, tests hypotheses, stops after 3 failed fixes. |
| `/design-review` | **Designer Who Codes** | Same audit as /plan-design-review, then fixes what it finds. Atomic commits, before/after screenshots. |
| `/qa` | **QA Lead** | Test your app, find bugs, fix them with atomic commits, re-verify. Auto-generates regression tests for every fix. |
| `/qa-only` | **QA Reporter** | Same methodology as /qa but report only. Pure bug report without code changes. |
| `/cso` | **Chief Security Officer** | OWASP Top 10 + STRIDE threat model. Zero-noise: 17 false positive exclusions, 8/10+ confidence gate, independent finding verification. Each finding includes a concrete exploit scenario. |
| `/ship` | **Release Engineer** | Sync main, run tests, audit coverage, push, open PR. Bootstraps test frameworks if you don't have one. |
| `/land-and-deploy` | **Release Engineer** | Merge the PR, wait for CI and deploy, verify production health. One command from "approved" to "verified in production." |
| `/canary` | **SRE** | Post-deploy monitoring loop. Watches for console errors, performance regressions, and page failures. |
| `/benchmark` | **Performance Engineer** | Baseline page load times, Core Web Vitals, and resource sizes. Compare before/after on every PR. |
| `/document-release` | **Technical Writer** | Update all project docs to match what you just shipped. Catches stale READMEs automatically. |
| `/retro` | **Eng Manager** | Team-aware weekly retro. Per-person breakdowns, shipping streaks, test health trends, growth opportunities. `/retro global` runs across all your projects and AI tools (Claude Code, Codex, Gemini). |
| `/browse` | **QA Engineer** | Real Chromium browser, real clicks, real screenshots. ~100ms per command. |
| `/setup-browser-cookies` | **Session Manager** | Import cookies from your real browser (Chrome, Arc, Brave, Edge) into the headless session. Test authenticated pages. |
| `/autoplan` | **Review Pipeline** | One command, fully reviewed plan. Runs CEO → design → eng review automatically with encoded decision principles. Surfaces only taste decisions for your approval. |

### Power tools

| Skill | What it does |
|-------|-------------|
| `/codex` | **Second Opinion** — independent code review from OpenAI Codex CLI. Three modes: review (pass/fail gate), adversarial challenge, and open consultation. Cross-model analysis when both `/review` and `/codex` have run. |
| `/careful` | **Safety Guardrails** — warns before destructive commands (rm -rf, DROP TABLE, force-push). Say "be careful" to activate. Override any warning. |
| `/freeze` | **Edit Lock** — restrict file edits to one directory. Prevents accidental changes outside scope while debugging. |
| `/guard` | **Full Safety** — `/careful` + `/freeze` in one command. Maximum safety for prod work. |
| `/unfreeze` | **Unlock** — remove the `/freeze` boundary. |
| `/setup-deploy` | **Deploy Configurator** — one-time setup for `/land-and-deploy`. Detects your platform, production URL, and deploy commands. |
| `/gstack-upgrade` | **Self-Updater** — upgrade gstack to latest. Detects global vs vendored install, syncs both, shows what changed. |

**[Deep dives with examples and philosophy for every skill →](docs/skills.md)**

## Parallel sprints

gstack works well with one sprint. It gets interesting with ten running at once.

[Conductor](https://conductor.build) runs multiple Claude Code sessions in parallel — each in its own isolated workspace. One session on `/office-hours`, another on `/review`, a third implementing a feature, a fourth running `/qa`. All at the same time. The sprint structure is what makes parallelism work — without a process, ten agents is ten sources of chaos. With a process, each agent knows exactly what to do and when to stop.

---

Free, MIT licensed, open source. No premium tier, no waitlist.

I open sourced how I build software. You can fork it and make it your own.

> **We're hiring.** Want to ship 10K+ LOC/day and help harden gstack?
> Come work at YC — [ycombinator.com/software](https://ycombinator.com/software)
> Extremely competitive salary and equity. San Francisco, Dogpatch District.

## Docs

| Doc | What it covers |
|-----|---------------|
| [Skill Deep Dives](docs/skills.md) | Philosophy, examples, and workflow for every skill (includes Greptile integration) |
| [Builder Ethos](ETHOS.md) | Builder philosophy: Boil the Lake, Search Before Building, three layers of knowledge |
| [Architecture](ARCHITECTURE.md) | Design decisions and system internals |
| [Browser Reference](BROWSER.md) | Full command reference for `/browse` |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, contributor mode, and dev mode |
| [Changelog](CHANGELOG.md) | What's new in every version |

## Privacy & Telemetry

gstack includes **opt-in** usage telemetry to help improve the project. Here's exactly what happens:

- **Default is off.** Nothing is sent anywhere unless you explicitly say yes.
- **On first run,** gstack asks if you want to share anonymous usage data. You can say no.
- **What's sent (if you opt in):** skill name, duration, success/fail, gstack version, OS. That's it.
- **What's never sent:** code, file paths, repo names, branch names, prompts, or any user-generated content.
- **Change anytime:** `gstack-config set telemetry off` disables everything instantly.

Data is stored in [Supabase](https://supabase.com) (open source Firebase alternative). The schema is in [`supabase/migrations/001_telemetry.sql`](supabase/migrations/001_telemetry.sql) — you can verify exactly what's collected. The Supabase publishable key in the repo is a public key (like a Firebase API key) — row-level security policies restrict it to insert-only access.

**Local analytics are always available.** Run `gstack-analytics` to see your personal usage dashboard from the local JSONL file — no remote data needed.

## Troubleshooting

**Skill not showing up?** `cd ~/.claude/skills/gstack && ./setup`

**`/browse` fails?** `cd ~/.claude/skills/gstack && bun install && bun run build`

**Stale install?** Run `/gstack-upgrade` — or set `auto_upgrade: true` in `~/.gstack/config.yaml`

**Codex says "Skipped loading skill(s) due to invalid SKILL.md"?** Your Codex skill descriptions are stale. Fix: `cd ~/.codex/skills/gstack && git pull && ./setup --host codex` — or for repo-local installs: `cd "$(readlink -f .agents/skills/gstack)" && git pull && ./setup --host codex`

**Windows users:** gstack works on Windows 11 via Git Bash or WSL. Node.js is required in addition to Bun — Bun has a known bug with Playwright's pipe transport on Windows ([bun#4253](https://github.com/oven-sh/bun/issues/4253)). The browse server automatically falls back to Node.js. Make sure both `bun` and `node` are on your PATH.

**Claude says it can't see the skills?** Make sure your project's `CLAUDE.md` has a gstack section. Add this:

```
## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse,
/qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro,
/investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard,
/unfreeze, /gstack-upgrade.
```

## License

MIT. Free forever. Go build something.
