# gstack

gstack turns Claude Code (and other coding agents) into a virtual engineering team: a CEO who rethinks the product, an eng manager who locks architecture, a designer who catches AI slop, a reviewer who finds production bugs, a QA lead who opens a real browser, a security officer who runs OWASP + STRIDE audits, and a release engineer who ships the PR. All slash commands, all Markdown, all free, MIT license.

I'm [Garry Tan](https://x.com/garrytan), President & CEO of [Y Combinator](https://www.ycombinator.com/). This is the open source software factory I use every day, and I'm sharing it because these tools should be available to everyone. The story, the productivity numbers and how I run ten sprints at once are in [Why gstack](docs/why-gstack.md).

Fork it. Improve it. Make it yours. And if you want to hate on free open source software — you're welcome to, but I'd rather you just try it first.

**Who this is for:**
- **Founders and CEOs** — especially technical ones who still want to ship
- **First-time Claude Code users** — structured roles instead of a blank prompt
- **Tech leads and staff engineers** — rigorous review, QA, and release automation on every PR

## Quick start

1. Install gstack (two pastes, about 30 seconds of setup; see below).
2. Run `/office-hours` and describe what you're building. It pushes back on your framing and writes a design doc the other skills read.
3. Run `/review` on any branch with changes. It finds the bugs that pass CI but break in production, and fixes the obvious ones.
4. Run `/qa` on your staging URL, or on an isolated local API, CLI, job or webhook. It opens a real browser, reproduces bugs and fixes them.

Stop there. You'll know if this is for you. When you want the whole sprint, `/autoplan` reviews a plan end to end and `/ship` runs tests, review and the PR.

## Install — about 30 seconds

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.4.2+ (the tested version; setup refuses Bun older than 1.3.3, which would let compiled tools read a project's `.env`), and [Node.js](https://nodejs.org/) on Windows. **Recommended on macOS:** the [Aside](https://aside.com) browser (macOS 15+), which the browser skills, `/make-pdf` and `/diagram` drive first with your real logged-in sessions; without it, `./setup` builds gstack's own bundled browser. `/cso` needs a native toolchain as well; setup says so and leaves it unavailable when the toolchain is absent. Timing, the `/cso` prerequisites and the hooks setup registers: [docs/install.md](docs/install.md).

### Step 1: Install on your machine

Open Claude Code and paste this. Claude does the rest.

> Install gstack: run **`git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`** then add a "gstack" section to CLAUDE.md that says to use the /browse skill from gstack for all web browsing and never use mcp\_\_claude-in-chrome\_\_\* tools. Claude Code lists the installed skills itself, so the section needs no skill list. Then ask the user if they also want to add gstack to the current project so teammates get it.

### Step 2: Team mode — auto-update for shared repos (recommended)

From inside your repo, paste this. Switches you to team mode, bootstraps the repo so teammates get gstack automatically, and commits the change:

```bash
(cd ~/.claude/skills/gstack && ./setup --team) && ~/.claude/skills/gstack/bin/gstack-team-init required && git add .claude/ CLAUDE.md && git commit -m "require gstack for AI-assisted work"
```

No vendored files in your repo, no version drift, no manual upgrades. Every Claude Code session starts with a fast auto-update check (throttled to once/hour, network-failure-safe, completely silent). Team mode follows the `stable` channel: the twice-weekly tagged release (Monday and Thursday, at most once every 72 hours, plus verified security and regression fixes), not every merge to main. `gstack-config set update_channel main` follows every merge instead; see [docs/releases.md](docs/releases.md).

Swap `required` for `optional` if you'd rather nudge teammates than block them.

Team mode's `required` hook runs on Node.js, so every teammate needs Node.js on PATH ([details](docs/install.md#team-mode)). To remove gstack later: [docs/uninstall.md](docs/uninstall.md).

### Other AI Agents

gstack runs on more agents than Claude. Bare `./setup` installs for Claude
Code only (run inside OpenClaw, Hermes or a Dot, it also registers gstack's
skills with that harness: [docs/hosts.md](docs/hosts.md#agent-harnesses)).
Pick another agent with `--host <name>`, or install for every agent setup
detects on this machine with `--host auto`:

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup --host auto      # or: ./setup --host codex
./setup --status                         # one row per install: host, tier, scope, version, path
```

An explicit `--host X` installs for X only and never changes another agent's
install. `/gstack-upgrade` refreshes every install it registered, one row per
host, and says which ones failed.

Tiers: **full** is certified by a real workflow run (see
[Certify your host](docs/ADDING_A_HOST.md#certify-your-host)); **experimental**
installs and passes the conformance tests but has no certification run yet;
**instruction-only** installs nothing: setup prints what to copy.

| Agent | Tier | Install | First invocation | Safety skills | Outside review needs | Repair |
|-------|------|---------|------------------|---------------|----------------------|--------|
| Claude Code | full | `--host claude` (default) | `/office-hours` | enforced (hooks block) | Codex CLI, signed in | `./setup --host claude` |
| OpenAI Codex CLI | experimental | `--host codex` → `${CODEX_HOME:-~/.codex}/skills/gstack-*/` | ask for `gstack-office-hours` | advisory, not blocked | Claude Code CLI, signed in | `./setup --host codex` |
| OpenCode | experimental | `--host opencode` → `~/.config/opencode/skills/gstack-*/` + `/gstack-*` commands | `/gstack-office-hours` | advisory, not blocked | Codex CLI, signed in | `./setup --host opencode` |
| Cursor | experimental | `--host cursor` → `~/.cursor/skills/gstack-*/` | ask for `gstack-office-hours` | advisory, not blocked | Codex CLI, signed in | `./setup --host cursor` |
| Factory Droid | experimental | `--host factory` → `~/.factory/skills/gstack-*/` | ask for `gstack-office-hours` | advisory, not blocked | Codex CLI, signed in | `./setup --host factory` |
| Kiro | experimental | `--host kiro` → `~/.kiro/skills/gstack-*/` | ask for `gstack-office-hours` | advisory, not blocked | Codex CLI, signed in | `./setup --host kiro` |
| GitHub Copilot CLI | experimental | `--host copilot` → `~/.copilot/skills/gstack-*/` | `/gstack-office-hours` | advisory, not blocked | Codex CLI, signed in | `./setup --host copilot` |
| Antigravity CLI | experimental | `--host agy` (or `--host antigravity`) → `~/.gemini/antigravity-cli/skills/gstack-*/` | `/gstack-office-hours` | advisory, not blocked | Codex CLI, signed in | `./setup --host agy` |
| Slate | instruction-only | `--host slate` (points at the Claude install; Slate reads `.claude/skills`) | `/office-hours` via the Claude install | advisory, not blocked | — | `./setup --host claude` |
| OpenClaw | experimental | `--host openclaw` (five task skills and one `gstack` router skill in OpenClaw's skills folder; automatic when setup runs inside OpenClaw; ACP route in [docs/OPENCLAW.md](docs/OPENCLAW.md)) | ask for the task; the agent opens the matching task skill or the `gstack` router | advisory, not blocked | — | `./setup --host openclaw` |
| Hermes | experimental | `--host hermes` (every skill in `$HERMES_HOME/skills/gstack`; automatic when setup runs inside Hermes) | ask for the task, or `/gstack-review` | advisory, not blocked | — | `./setup --host hermes` |
| GBrain (mod) | instruction-only | `--host gbrain` (brain-aware variants ship from the GBrain repo) | — | advisory, not blocked | — | — |

Per-host notes (agent harnesses, Copilot, Antigravity, OpenClaw and ClawHub, the Codex behavioral profile and model tiers, outside-review providers, the design binary's models) are in [docs/hosts.md](docs/hosts.md). Any rules-reading agent (Zed, Amp, Jules) can use the 2KB [agents digest](agents-digest/gstack-AGENTS.md) with no install. Adding a host: [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md).

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
| `/plan-devex-review` | **Developer Experience Lead** | Interactive DX review: explores developer personas, benchmarks against competitors' TTHW, designs your magical moment, traces friction points step by step. Scores error messages for the agents that read them ([agent-ready errors](docs/agent-ready-errors.md)). Three modes: DX EXPANSION, DX POLISH, DX TRIAGE. 20-45 forcing questions. |
| `/design-consultation` | **Design Partner** | Build a complete design system from scratch. Researches the landscape, proposes creative risks, generates realistic product mockups. Writes `DESIGN.md` in the open DESIGN.md format, so impeccable, Google Stitch, and any tool that reads it share one file. |
| `/review` | **Staff Engineer** | Find the bugs that pass CI but blow up in production. Auto-fixes the obvious ones. Flags completeness gaps and gate integrity: every weakened test, timeout, snapshot or suppression reaches a human by name. Advisory simplification lens flags over-built code — never blocks, never auto-applies. |
| `/deslop-shared-libs` | **Shared Code Reviewer** | Find worthwhile shared-code extractions in recent work. Compares up to five opportunities and recommends the best three, with source evidence, reliability gains, and total code savings. Recommendations only. |
| `/write-skill` | **Skill Editor** | Write a new agent skill or improve one without bloat. A five-step edit ladder (fix the tool first, add nothing the model already does, edit the line instead of appending, lowest level that reaches the agent, rule not story), `gstack-skill-bill` for size per level and growth since the last diet, a drift check that every gstack command and flag a skill names still exists, and full diets proven by a before/after/no-skill test. |
| `/test-audit` | **Test Auditor** | Sweep existing tests for ones that cost more than they protect: source greps, duplicates, assertion-free probes, test-only exports. Every candidate carries an evidence card; report-only unless you approve a batch. |
| `/investigate` | **Debugger** | Systematic root-cause debugging. Iron Law: no fixes without investigation. Traces data flow, tests hypotheses, stops after 3 failed fixes. |
| `/verify` | **Build Loop** | Run the repo's own checks (typecheck, lint, build) and the tests `/ship`'s pre-gate would pick for your change, fix what breaks, repeat until green, then hand off to `/ship`. Asks once before running repo commands; never calls a change green when no test covers it. |
| `/design-review` | **Designer Who Codes** | Same audit as /plan-design-review, then fixes what it finds. Atomic commits, before/after screenshots. If you have impeccable installed, its engine runs first and every mechanical finding arrives tagged with its rule id. |
| `/devex-review` | **DX Tester** | Live developer experience audit. Actually tests your onboarding: navigates docs, tries the getting started flow, times TTHW, triggers CLI errors the way an agent meets them (`gstack-error-capture`: no terminal, contained, redacted). Compares against `/plan-devex-review` scores — the boomerang that shows if your plan matched reality. |
| `/design-shotgun` | **Design Explorer** | "Show me options." Generates 4-6 AI mockup variants, opens a comparison board in your browser, collects your feedback, and iterates. Taste memory learns what you like. Repeat until you love something, then hand it to `/design-html`. |
| `/design-html` | **Design Engineer** | Turn a mockup into production HTML that actually works. Pretext computed layout: text reflows, heights adjust, layouts are dynamic. 30KB, zero deps. Detects React/Svelte/Vue. Smart API routing per design type (landing page vs dashboard vs form). One slop-gate pass through the impeccable engine when you have it. The output is shippable, not a demo. |
| `/design-motion` | **Motion Designer** | Turn an approved mockup, a finalized page or a URL into a showcase loop. Rebuilds the exact frame, loads it from empty, gives each visual one story, records deterministic frames on a fake clock, and exports an MP4 for X, a website GIF and an 800×500 GIF once the seam, empty-beat, rest and overflow checks pass. Needs ffmpeg. |
| `/qa` | **QA Lead** | Explore browser, API, CLI, job and webhook behavior. Reproduce bugs, write failing regressions, fix the cause and re-verify before committing. |
| `/qa-only` | **QA Reporter** | Explore and report with replayable evidence. Suggest regression cases without changing product code or tests. |
| `/pair-agent` | **Multi-Agent Coordinator** | Share gstack's own browser with any AI agent. One command, one paste, connected. Works with OpenClaw, Hermes, Codex, Cursor, or anything that can curl. Each agent gets its own tab. Auto-launches headed mode so you watch everything. Auto-starts ngrok tunnel for remote agents. Scoped tokens, tab isolation, rate limiting, activity attribution. (Runs on the bundled browser — the fallback engine; agents driving Aside just open their own tabs.) |
| `/cso` | **Chief Security Officer** | Security audit with an application model, supported findings, independent challenge, and explicit coverage. Static assessment remains available without catalog profiles. With matching qualified profiles, comprehensive mode adds contained runtime/scanner execution and reviewable repair candidates for Node/Bun, Python, and Rails. Qualified runtime and scanner images are published for linux/amd64 and linux/arm64. Without Docker, audits run static assessment only. Runtime-tested bundles authenticate separate external assertions. Project-test completion remains `self_reported` because target code controls the test process; `tested` is reserved for a future target-independent completion witness. |
| `/ship` | **Release Engineer** | Sync main, run tests, explore changed behavior, audit coverage, gate integrity and docs, then verify, push and open a PR. |
| `/land-and-deploy` | **Release Engineer** | Merge the PR, wait for CI and deploy, verify production health. One command from "approved" to "verified in production." |
| `/modernize` | **Stale-PR Maintainer** | Bring an aging PR onto its current base and say whether it should still exist: MODERNIZE (rebase, `git range-diff` proof, push with a lease pinned to the observed head), REWORK (the problem stands, the diff does not) or CLOSE (recommended, never done without permission). Reads the base's moved range for conflicts in meaning, not only in text. |
| `/canary` | **SRE** | Post-deploy monitoring loop. Watches for console errors, performance regressions, and page failures. |
| `/benchmark` | **Performance Engineer** | Baseline page load times, Core Web Vitals, and resource sizes. Compare before/after on every PR. |
| `/ubicloud` | **Remote Runner** | Run a heavy suite, build or eval on an ephemeral 16-vCPU Ubicloud VM: owner- and TTL-named VMs with a reaper, quota preflight, a hang watchdog, and one committed verify per repository. |
| `/eval-plan` | **Eval Planner** | Preregister a paid eval before the first priced call: bars, arms, decoys and stop rules, a $0 stub-model dry run over the real inputs, and a three-item priced pilot whose extrapolation and spend table gate the approval. |
| `/document-release` | **Technical Writer** | Audit changed behavior against project docs on every ship, before final verification and publication. Also runs standalone. Shows updated, reviewed/current or blocked docs and any remaining gaps. |
| `/document-generate` | **Documentation Author** | Generate missing docs from scratch using the Diataxis framework. Researches the codebase first, then writes reference / how-to / tutorial / explanation docs that actually match the code. Invokable standalone or chained from `/document-release` when the coverage map finds gaps. Learn more: [tutorial](docs/tutorial-document-generate.md) • [how-to](docs/howto-document-a-shipped-feature.md) • [why Diataxis](docs/explanation-diataxis-in-gstack.md). |
| `/retro` | **Eng Manager** | Team-aware weekly retro. Per-person breakdowns, shipping streaks, test health trends, growth opportunities. `/retro global` runs across all your projects and AI tools (Claude Code, Codex, Gemini). |
| `/browse` | **QA Engineer** | Give the agent eyes. Drives your [Aside](https://aside.com) browser first — your real sessions, real clicks, real screenshots — through deterministic `aside repl` scripts. No Aside? It falls back to gstack's own Chromium: real clicks, ~100ms per command, and `/open-gstack-browser` shows it headed with sidebar, anti-bot stealth, and auto model routing. Every other browser skill stands on it. |
| `/scrape` | **Data Extractor** | Pull structured data off a web page — tables, lists, prices — in your Aside browser with the page's real logged-in state. On the fallback browser, `/skillify` turns the flow into a permanent browser-skill that runs in ~200ms next time. |
| `/setup-browser-cookies` | **Session Manager** | Copy selected cookies from Chrome, Chromium, Brave, Edge, Windows-only Opera and Opera GX, or macOS-only Comet and Arc into gstack's bundled browser. Choose your profile and domains; copying and sign-in verification are separate. Only needed on the fallback path — Aside already has your sessions. |
| `/autoplan` | **Review Pipeline** | One command, fully reviewed plan. Runs CEO → design → DX → eng review automatically (eng always last, so the shipping gate reviews the final amended plan) with encoded decision principles. Surfaces only taste decisions for your approval. |
| `/spec` | **Spec Author** | Turn vague intent into a precise, executable spec in five phases (why, scope, technical with mandatory code-reading, draft, file). Outside-review quality gate before filing (Claude Code on Codex; Codex on other harnesses; blocks below 7/10), fail-closed secret redaction, dedupe against existing issues, archive to `$GSTACK_STATE_ROOT/projects/$SLUG/specs/` for team-corpus recall. `--execute` spawns `claude -p` in a fresh worktree; `/ship` auto-closes the source issue on merge. Plan-mode aware. |
| `/learn` | **Memory** | Manage what gstack learned across sessions. Review, search, prune, and export project-specific patterns, pitfalls, and preferences. Learnings compound across sessions so gstack gets smarter on your codebase over time. |
| `/make-pdf` | **Publisher** | Markdown in, publication-quality document out. Mermaid and excalidraw fences render as vector diagrams, fully offline. Images scale to the page and never truncate; wide diagrams get their own landscape page. `--to html` emits one self-contained file, `--to docx` a Word doc. |
| `/diagram` | **Diagram Maker** | English in, editable diagram out. Emits a triplet: mermaid source, `.excalidraw` you can open and edit on excalidraw.com (hand-drawn style), and rendered SVG/PNG. Zero network. Embed the source in markdown and `/make-pdf` renders it. |

The same `/qa` and `/qa-only` commands test CLIs, APIs, jobs, workers and webhooks with no browser: [QA without a webpage](docs/qa-without-a-webpage.md).

### Which review should I use?

| Building for... | Plan stage (before code) | Live audit (after shipping) |
|-----------------|--------------------------|----------------------------|
| **End users** (UI, web app, mobile) | `/plan-design-review` | `/design-review` |
| **Developers** (API, CLI, SDK, docs) | `/plan-devex-review` | `/devex-review` |
| **Architecture** (data flow, perf, tests) | `/plan-eng-review` | `/review` |
| **All of the above** | `/autoplan` (runs CEO → design → DX → eng, auto-detects which apply; eng always last) | — |

### Power tools

| Skill | What it does |
|-------|-------------|
| `/codex` | **Second Opinion** — independent code review from OpenAI Codex CLI. Review, challenge, and consult modes. Available on every harness except Codex. |
| `/claude-code` | **Second Opinion** — independent code review from Claude Code. Review, challenge, and consult modes, with session continuity for consultation. Available on every harness except Claude Code. |
| `/careful` | **Safety Guardrails** — warns before destructive commands (rm -rf, DROP TABLE, force-push). Say "be careful" to activate. Override any MEDIUM warning; root/home recursive deletes and default-branch force-pushes are hard-denied. |
| `/freeze` | **Edit Lock** — restrict file edits to one directory. Prevents accidental changes outside scope while debugging. |
| `/guard` | **Full Safety** — `/careful` + `/freeze` in one command. Maximum safety for prod work. |
| `/unfreeze` | **Unlock** — remove the `/freeze` boundary. |
| `/open-gstack-browser` | **GStack Browser** — launch gstack's own browser headed, with sidebar, anti-bot stealth, auto model routing (Sonnet for actions, Opus for analysis), one-click cookie import, and Claude Code integration. Clean up pages, take smart screenshots, edit CSS, and pass info back to your terminal. The visible face of the fallback engine; with Aside open you watch the agent's tabs there instead. |
| `/setup-deploy` | **Deploy Configurator** — one-time setup for `/land-and-deploy`. Detects your platform, production URL, and deploy commands. |
| `/setup-gbrain` | **GBrain Onboarding** — from zero to running gbrain in under 5 minutes. PGLite local, Supabase existing URL, or auto-provision a new Supabase project via Management API. MCP registration for Claude Code + per-repo trust triad (read-write/read-only/deny). [Full guide](USING_GBRAIN_WITH_GSTACK.md). |
| `/sync-gbrain` | **Keep Brain Current** — re-index this repo's code into gbrain via `gbrain sources add` + `gbrain sync --strategy code`, refresh the `## GBrain Search Guidance` block in CLAUDE.md, and auto-remove guidance when the capability check fails. `--incremental` (default), `--full`, `--dry-run`. Idempotent; safe to re-run. |
| `/gstack-upgrade` | **Self-Updater** — upgrade gstack to latest. Detects global vs vendored install, syncs both, shows what changed. |
| `/captain` | **Crew Controller** — run many coding agents from one controller: lanes send a READY block and never merge, the controller merges through trains (stamp on call, verify, merge with the expected head), keeps the digest, relays approvals in a fixed shape and runs a daily flaky-fix pass. Also answers to `/crew`. [Team guide](docs/captain.md). |
| `/ios-qa` | **iOS Live-Device QA (v1.43.0.0+)** — drive a real iPhone or iPad over USB CoreDevice via an embedded `StateServer` in the app. Read Swift source, codegen typed `@Observable` accessors, run the agent loop. Optional `--tailnet` flag exposes the device to OpenClaw or any HTTP-capable agent on your Tailscale tailnet so remote agents can run iOS QA without ever touching the hardware. Capability-tier allowlist (observe/interact/mutate/restore), per-device session lock, audit log. |
| `/ios-fix`, `/ios-design-review`, `/ios-clean`, `/ios-sync` | iOS bug-fix loop, designer's-eye HIG audit, debug-bridge cleanup, and accessor resync. See `docs/skills.md`. End-to-end walkthrough: [docs/howto-ios-testing-with-gstack.md](docs/howto-ios-testing-with-gstack.md). |

Beyond the slash commands, gstack ships standalone CLIs (`gstack-egress`, `gstack-context-bill`, `gstack-model-benchmark`, `gstack-pr-wait`, the review and evidence ledgers, the iOS QA daemon): [docs/standalone-binaries.md](docs/standalone-binaries.md). The fallback browser's per-site [domain skills](docs/domain-skills.md) and raw CDP escape hatch, and the [voice-input aliases](docs/voice-input.md) many skills carry, have their own pages.

**[Deep dives with examples and philosophy for every skill →](docs/skills.md)**

## GBrain — persistent knowledge for your coding agent

[GBrain](https://github.com/garrytan/gbrain) is a persistent knowledge base for AI agents — think of it as the memory your agent actually keeps between sessions. GStack gives you a one-command path from zero to "it's running, my agent can call it."

```bash
/setup-gbrain
```

The four setup paths, the per-repo trust policy and memory sync, in brief: [docs/gbrain-quick-tour.md](docs/gbrain-quick-tour.md). **Full monty — every scenario, every flag, every bin helper, every troubleshooting step:** [USING_GBRAIN_WITH_GSTACK.md](USING_GBRAIN_WITH_GSTACK.md)

Other references: [docs/gbrain-sync.md](docs/gbrain-sync.md) (sync-specific guide) • [docs/gbrain-sync-errors.md](docs/gbrain-sync-errors.md) (error index)

## Platform notes

**macOS:** everything runs. With the [Aside](https://aside.com) browser (macOS 15+) open and signed in, the browser skills, `/make-pdf` and `/diagram` use it and your real sessions; otherwise they use the bundled browser `./setup` builds. gstack never installs Aside.

**Linux:** everything runs on the bundled browser; Aside is macOS-only, so the readiness probe says `NEEDS_ASIDE: Linux` once and the skills use gstack's own Chromium. If Chromium installs but cannot launch because the host blocks unprivileged user namespaces (Ubuntu 24.04+ AppArmor default), set `GSTACK_CHROMIUM_NO_SANDBOX=1`.

**Windows users:** gstack works on Windows 11 via Git Bash or WSL. Aside is macOS-only, so on Windows (and Linux) the browser skills, `/make-pdf`, and `/diagram` always use gstack's bundled browser. Node.js is required in addition to Bun — Bun has a known bug with Playwright's pipe transport on Windows ([bun#4253](https://github.com/oven-sh/bun/issues/4253)). The browse server automatically falls back to Node.js. Make sure both `bun` and `node` are on your PATH. Native `/cso` additionally requires PowerShell (PowerShell 7 `pwsh` is preferred; Windows PowerShell 5.1 is the fallback) and Visual Studio 2022 Build Tools with the Desktop development with C++ workload; setup leaves that skill explicitly unavailable when they are absent. /cso is optional: if its native helper fails to build or publish, setup still finishes, says which step failed with the log path and retry command, and keeps an earlier helper when it has one (`GSTACK_STRICT_BUILD=1` makes that failure fatal, as CI does).

**Known issue: Windows Smart App Control** ([#2595](https://github.com/garrytan/gstack/issues/2595)). gstack's compiled binaries (`browse`, `find-browse`, `design`, `pdf`, `gstack-global-discover`) are built on your machine and unsigned, so Windows 11 with Smart App Control on refuses to start them; Git Bash shows `Permission denied`. setup detects this, names the blocked binaries and the skills that need them, and `gstack-doctor` reports them as `blocked`. Today's workarounds are running gstack inside WSL, or turning Smart App Control off. Details: [troubleshooting](docs/troubleshooting.md#windows-smart-app-control). The sidebar terminal uses Consolas on Windows, so its text no longer renders spaced out.

From PowerShell, `.\setup.ps1` (same arguments as `./setup`) checks that Git for Windows, Bun and Node.js are on PATH, prints the `winget` command for any that are missing, and otherwise runs `./setup` in Git Bash.

On Windows without Developer Mode (MSYS2 / Git Bash), `setup` falls back to file copies instead of symlinks because `ln -snf` produces frozen copies that don't refresh on `git pull`. **Re-run `cd ~/.claude/skills/gstack && ./setup` after every `git pull`** so your skill files match the repo. `setup` prints a one-line note reminding you. Unix and WSL keep symlinks and don't need the re-run.

## Docs

| Doc | What it covers |
|-----|---------------|
| [Skill Deep Dives](docs/skills.md) | Philosophy, examples, and workflow for every skill (includes Greptile integration) |
| [The recommended harness](docs/recommended-harness.md) | gstack + Capy from zero to the first merged train: install, the Captain and its Drive, trains, the daily flaky pass, the twice-weekly release, the factory scorecard, what is Capy-specific, known Capy limits |
| [gstack + Capy: the software factory](capy/README.md) | What we built with Capy Captains and gstack, how the pieces fit, the measured before/after, tips, and how Garry uses it |
| [Why gstack](docs/why-gstack.md) | The story, the productivity numbers and their caveats, Karpathy's failure modes, parallel sprints |
| [Install details](docs/install.md) | Setup timing, requirements in detail, team mode, the hooks setup registers, agent harness registration |
| [Other agents](docs/hosts.md) | Agent harnesses (OpenClaw, Hermes, dots, QM, Muse Code, Grok, any other), OpenClaw and ClawHub, per-host notes, the Codex profile and model tiers, outside-review providers, the design binary's models |
| [QA without a webpage](docs/qa-without-a-webpage.md) | `/qa` and `/qa-only` on CLIs, APIs, jobs, workers and webhooks |
| [Standalone binaries](docs/standalone-binaries.md) | The standalone `gstack-*` CLIs (egress auditor, context bill, model benchmark, the review and evidence ledgers, the iOS QA daemon), and the CSO evaluation producer contract |
| [Privacy & Telemetry](docs/privacy.md) | What is sent, what never is, the update check, outside reviews, egress receipts |
| [Uninstall](docs/uninstall.md) | The uninstall script and manual removal |
| [Diagrams & Document Formats](docs/howto-diagrams-and-formats.md) | Mermaid/excalidraw fences in PDFs, image sizing and safety defaults, `--to html\|docx`, `/diagram` triplets |
| [First Production Deploy](docs/howto-bring-up-a-first-deploy.md) | What to do when `/setup-deploy` says nothing is deployed yet: hosting, env and secrets, DNS, checking it works, then back to `/setup-deploy` |
| [Builder Ethos](ETHOS.md) | Builder philosophy: Boil the Ocean, Search Before Building, three layers of knowledge |
| [GBrain quick tour](docs/gbrain-quick-tour.md) | The four setup paths, MCP registration, the per-repo trust policy, memory sync, Conductor env vars |
| [Using GBrain with GStack](USING_GBRAIN_WITH_GSTACK.md) | Every path, flag, bin helper, and troubleshooting step for `/setup-gbrain` |
| [GBrain Sync](docs/gbrain-sync.md) | Cross-machine memory setup, privacy modes, troubleshooting |
| [Architecture](ARCHITECTURE.md) | Design decisions and system internals |
| [Browser](BROWSER.md) | How gstack drives Aside first (the contract, the cookbook, rendering, research), when the fallback engine kicks in, and the fallback's full `$B` command reference |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, contributor mode, and dev mode |
| [Memorable recall bridge](docs/memorable-workflow-memory.md) | Opt-in third-party workflow memory through gstack: two consents, what gstack hands over and can attest, removal, troubleshooting |
| [Troubleshooting](docs/troubleshooting.md) | Every `not run` / `unavailable` message, what it means, and the fix |
| [Running a Captain crew](docs/captain.md) | One controller, many lanes on Capy: the drive layout, CREW.md, the READY contract, merge trains, approvals, the digest and the daily flaky pass, with templates |
| [Changelog](CHANGELOG.md) | What's new in every version |

## Privacy & Telemetry

gstack sends nothing about how you use it unless you opt in. Telemetry is off by default and asked about once; the update check (two or three GitHub requests: a `git ls-remote`, a fetch of `VERSION` and, when that version equals yours but `main` has moved, a compare-API call; with telemetry on it also reports your gstack version and OS; on by default) turns off with `gstack-config set update_check false`; outside reviews (on by default; the first one prints a notice) send code to Codex or Claude Code under your own login and turn off with `gstack-config set codex_reviews disabled`. Every off-machine send writes a receipt you can audit with `gstack-egress list`. The full account, including the exact fields telemetry carries and the local state that is not telemetry: [docs/privacy.md](docs/privacy.md).

## Troubleshooting

**Not sure what's wrong?** Run the doctor: `~/.claude/skills/gstack/bin/gstack-doctor`
(on other hosts, `./setup --status` in your gstack checkout ends with the
doctor's absolute path). Without starting a skill or spending anything, it
prints one row per check (install, state root, Bun, hooks, Codex and its cached
model probe, artifacts sync, the browse bundle, the other compiled binaries,
the /cso native helper, Claude Code, your largest session journal and recent
/autoplan guard codes), each `ok`, `warn`,
`not configured` or `fail` with the command that fixes it. It exits non-zero
only on `fail`. `--live` also runs the paid Codex model check (one short call).
Paste its output into bug reports.

**A message says `not run`, `unavailable` or names a fix?** Look it up in
[docs/troubleshooting.md](docs/troubleshooting.md): every gate message gstack
prints, what it means, what was kept, and the command that fixes it.

**Claude says it can't see the skills?** Check that they are installed (`ls ~/.claude/skills`) and restart Claude Code; it lists every installed skill with its description, so CLAUDE.md does not need to enumerate them (a pasted list goes stale with each release). Your project's `CLAUDE.md` only needs the browsing rule:

```
## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
```

If an older install prompt left an "Available skills:" line in your CLAUDE.md, delete it.

Skill not showing up, stale install, Codex skill descriptions, prefix modes, disabling skills, Chromium install problems: [quick answers](docs/troubleshooting.md#quick-answers).

---

Free, MIT licensed, open source. No premium tier, no waitlist.

I open sourced how I build software. You can fork it and make it your own.

> **We're hiring.** Want to ship real products at AI-coding speed and help harden gstack?
> Come work at YC — [ycombinator.com/software](https://ycombinator.com/software)
> Extremely competitive salary and equity. San Francisco, Dogpatch District.

## License

MIT. Free forever. Go build something.
