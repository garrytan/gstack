# gstack-codex

`gstack-codex` is a Codex-first fork of [garrytan/gstack](https://github.com/garrytan/gstack).
It keeps the strong parts of the original stack:

- the Bun + Playwright persistent browser runtime
- the skill-per-workflow layout
- the generated `SKILL.md` pipeline
- the `.gstack/` runtime state model

It replaces the Claude-specific parts with Codex-native conventions:

- install roots live under `~/.codex/skills` or `.codex/skills`
- the repo uses `AGENTS.md`, not the legacy Claude-only instruction file
- workflow prompts assume plain-text user decisions instead of Claude-only tool names
- skill discovery includes `agents/openai.yaml` metadata for each shipped skill
- the intentional fork deltas are tracked in `docs/codex-fork-ledger.md`

The result is a Codex-friendly “software factory” bundle: plan review, code review,
QA, browser automation, design review, release workflow, and documentation updates
in one repo.

**Who this is for:**
- **Founders and CEOs** — especially technical ones who still want to ship. This is how you build like a team of twenty.
- **First-time Codex users** — gstack gives you structured roles instead of a blank prompt.
- **Tech leads and staff engineers** — bring rigorous review, QA, and release automation to every PR.

## Quick start: your first 10 minutes

1. Install `gstack-codex` (30 seconds — see below).
2. Run `/plan-ceo-review` on any feature idea.
3. Run `/review` on any branch with changes.
4. Run `/qa` on your staging URL.
5. Stop there. You'll know if this is for you.

Expect first useful run in under 5 minutes on any repo with tests already set up.

## Install — takes 30 seconds

**Requirements:** [Codex](https://openai.com/codex/), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+

### Step 1: Install on your machine

If you already have a checkout of the fork:

```bash
mkdir -p ~/.codex/skills
cp -Rf /path/to/gstack-codex ~/.codex/skills/gstack-codex
cd ~/.codex/skills/gstack-codex
./setup
```

If you have a published fork URL, use `git clone <fork-url> ~/.codex/skills/gstack-codex` instead of the `cp -Rf` step.

Then add a `gstack` section to your global `AGENTS.md` telling Codex:

- use `/browse` from gstack for all web browsing
- never fall back to other browser MCP tools when gstack browse is available
- available skills: `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/design-consultation`, `/review`, `/ship`, `/browse`, `/qa`, `/qa-only`, `/design-review`, `/setup-browser-cookies`, `/retro`, `/document-release`

### Step 2: Add to your repo so teammates get it (optional)

```bash
mkdir -p .codex/skills
cp -Rf ~/.codex/skills/gstack-codex .codex/skills/gstack-codex
rm -rf .codex/skills/gstack-codex/.git
cd .codex/skills/gstack-codex
./setup
```

Then add a `gstack` section to this project's `AGENTS.md` with the same browsing
and skill guidance, plus a note that if the skills stop working, run:

```bash
cd .codex/skills/gstack-codex && ./setup
```

Real files get committed to your repo (not a submodule), so `git clone` just works.
Everything lives inside `.codex/`. Nothing touches your PATH or runs in the background.

## What this fork changes

- Bundle root: `gstack-codex`
- User install: `~/.codex/skills/gstack-codex`
- Vendored install: `.codex/skills/gstack-codex`
- Root instruction file: `AGENTS.md`
- Per-skill Codex metadata: `agents/openai.yaml`
- Browser runtime: still `browse/dist/browse`
- Rebase guide: `docs/codex-fork-ledger.md`

Nothing touches your PATH or installs a background daemon globally. The browser
server is still started on demand by the browse binary.

## See it work

```
You:    I want to add photo upload for sellers.
You:    /plan-ceo-review
Codex:  "Photo upload" is not the feature. The real job is helping
        sellers create listings that actually sell. What if we
        auto-identify the product, pull specs and comps from the
        web, and draft the listing automatically? That's 10 stars.
        "Upload a photo" is 3 stars. Which are we building?
        [8 expansion proposals, you cherry-pick 5, defer 3 to backlog]

You:    /plan-design-review
Codex:  Design Score: B  |  AI Slop Score: C
        "Upload flow looks like a default Bootstrap form."
        [80-item audit, infers your design system, exports DESIGN.md]
        [flags 3 AI slop patterns: gradient hero, icon grid, uniform radius]

You:    /plan-eng-review
Codex:  ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌─────────┐
        │ Upload  │───▶│ Classify │───▶│ Enrich   │───▶│ Draft   │
        │ (sync)  │    │ (async)  │    │ (async)  │    │ (async) │
        └─────────┘    └──────────┘    └──────────┘    └─────────┘
        [ASCII diagrams for every data flow, state machine, error path]
        [14-case test matrix, 6 failure modes mapped, 3 security concerns]

You:    Approve plan. Exit plan mode.
        [Codex writes 2,400 lines across 11 files — models, services,
         controllers, views, migrations, and tests. ~8 minutes.]

You:    /review
Codex:  [AUTO-FIXED] Orphan S3 cleanup on failed upload
        [AUTO-FIXED] Missing index on listings.status
        [ASK] Race condition on hero image selection → You: yes
        [traces every new enum value through all switch statements]
        3 issues — 2 auto-fixed, 1 fixed.

You:    /qa https://staging.myapp.com
Codex:  [opens real browser, logs in, uploads photos, clicks through flows]
        Upload → classify → enrich → draft: end to end ✓
        Mobile: ✓  |  Slow connection: ✓  |  Bad image: ✓
        [finds bug: preview doesn't clear on second upload — fixes it]
        Regression test generated.

You:    /ship
Codex:  Tests: 42 → 51 (+9 new)
        Coverage: 14/14 code paths (100%)
        PR: github.com/you/app/pull/42
```

One feature. Seven workflows. The agent reframed the product, ran a design audit,
drew the architecture, wrote code, found a race condition, opened a real browser
to QA test, fixed a regression, and updated the release surface. That is closer to
an opinionated team operating system than a single autocomplete tool.

## The team

| Skill | Your specialist | What they do |
|-------|----------------|--------------|
| `/plan-ceo-review` | **CEO / Founder** | Rethink the problem. Find the 10-star product hiding inside the request. Four modes: Expansion, Selective Expansion, Hold Scope, Reduction. |
| `/plan-eng-review` | **Eng Manager** | Lock in architecture, data flow, diagrams, edge cases, and tests. Forces hidden assumptions into the open. |
| `/plan-design-review` | **Senior Designer** | 80-item design audit with letter grades. AI Slop detection. Infers your design system. Report only — never touches code. |
| `/design-consultation` | **Design Partner** | Build a complete design system from scratch. Knows the landscape, proposes creative risks, generates realistic product mockups. Design at the heart of all other phases. |
| `/review` | **Staff Engineer** | Find the bugs that pass CI but blow up in production. Auto-fixes the obvious ones. Flags completeness gaps. |
| `/ship` | **Release Engineer** | Sync main, run tests, audit coverage, push, open PR. Bootstraps test frameworks if you don't have one. One command. |
| `/browse` | **QA Engineer** | Give the agent eyes. Real Chromium browser, real clicks, real screenshots. ~100ms per command. |
| `/qa` | **QA Lead** | Test your app, find bugs, fix them with atomic commits, re-verify. Auto-generates regression tests for every fix. |
| `/qa-only` | **QA Reporter** | Same methodology as /qa but report only. Use when you want a pure bug report without code changes. |
| `/design-review` | **Designer Who Codes** | Same audit as /plan-design-review, then fixes what it finds. Atomic commits, before/after screenshots. |
| `/setup-browser-cookies` | **Session Manager** | Import cookies from your real browser (Chrome, Arc, Brave, Edge) into the headless session. Test authenticated pages. |
| `/retro` | **Eng Manager** | Team-aware weekly retro. Per-person breakdowns, shipping streaks, test health trends, growth opportunities. |
| `/document-release` | **Technical Writer** | Update all project docs to match what you just shipped. Catches stale READMEs automatically. |

**[Deep dives with examples and philosophy for every skill →](docs/skills.md)**

## What's new and why it matters

**Design is at the heart.** `/design-consultation` doesn't just pick fonts. It researches what's out there in your space, proposes safe choices AND creative risks, generates realistic mockups of your actual product, and writes `DESIGN.md` — and then `/design-review` and `/plan-eng-review` read what you chose. Design decisions flow through the whole system.

**`/qa` was a massive unlock.** It let me go from 6 to 12 parallel workers. Codex saying *"I SEE THE ISSUE"* and then actually fixing it, generating a regression test, and verifying the fix — that changed how I work. The agent has eyes now.

**Smart review routing.** Just like at a well-run startup: CEO doesn't have to look at infra bug fixes, design review isn't needed for backend changes. gstack tracks what reviews are run, figures out what's appropriate, and just does the smart thing. The Review Readiness Dashboard tells you where you stand before you ship.

**Test everything.** `/ship` bootstraps test frameworks from scratch if your project doesn't have one. Every `/ship` run produces a coverage audit. Every `/qa` bug fix generates a regression test. 100% test coverage is the goal — tests make vibe coding safe instead of yolo coding.

**`/document-release` is the engineer you never had.** It reads every doc file in your project, cross-references the diff, and updates everything that drifted. README, ARCHITECTURE, CONTRIBUTING, AGENTS.md, TODOS — all kept current automatically.

## 10 sessions at once

gstack is powerful with one session. It is transformative with ten.

[Conductor](https://conductor.build) runs multiple Codex sessions in parallel — each in its own isolated workspace. One session running `/qa` on staging, another doing `/review` on a PR, a third implementing a feature, and seven more on other branches. All at the same time.

One person, ten parallel agents, each with the right cognitive mode. That is a different way of building software.

## Come ride the wave

This is **free, MIT licensed, open source, available now.** No premium tier. No waitlist. No strings.

I open sourced how I do development and I am actively upgrading my own software factory here. You can fork it and make it your own. That's the whole point. I want everyone on this journey.

Same tools, different outcome — because gstack gives you structured roles and review gates, not generic agent chaos. That governance is the difference between shipping fast and shipping reckless.

The models are getting better fast. The people who figure out how to work with them now — really work with them, not just dabble — are going to have a massive advantage. This is that window. Let's go.

Thirteen specialists. All slash commands. All Markdown. All free. **[github.com/garrytan/gstack](https://github.com/garrytan/gstack)** — MIT License

> **We're hiring.** Want to ship 10K+ LOC/day and help harden gstack?
> Come work at YC — [ycombinator.com/software](https://ycombinator.com/software)
> Extremely competitive salary and equity. San Francisco, Dogpatch District.

## Docs

| Doc | What it covers |
|-----|---------------|
| [Skill Deep Dives](docs/skills.md) | Philosophy, examples, and workflow for every skill (includes Greptile integration) |
| [Architecture](ARCHITECTURE.md) | Design decisions and system internals |
| [Browser Reference](BROWSER.md) | Full command reference for `/browse` |
| [Contributing](CONTRIBUTING.md) | Dev setup, testing, contributor mode, and dev mode |
| [Changelog](CHANGELOG.md) | What's new in every version |

## Troubleshooting

**Skill not showing up?** `cd ~/.codex/skills/gstack-codex && ./setup`

**`/browse` fails?** `cd ~/.codex/skills/gstack-codex && bun install && bun run build`

**Stale install?** Run `/gstack-upgrade` — or set `auto_upgrade: true` in `~/.gstack/config.yaml`

**Codex says it can't see the skills?** Make sure your project's `AGENTS.md` has a gstack section. Add this:

```
## gstack
Use /browse from gstack for all web browsing. Never use other browser MCP tools.
Available skills: /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /browse, /qa, /qa-only, /design-review,
/setup-browser-cookies, /retro, /document-release.
```

## License

MIT. Free forever. Go build something.
