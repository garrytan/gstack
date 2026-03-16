# gstack

**gstack turns one generic coding agent into a team of specialists you can summon on demand.**

Eight opinionated workflow modes for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), plus a Codex-compatible layer that reuses the same browser engine, workflow references, and setup/build flow. Plan review, code review, one-command shipping, browser automation, QA testing, and engineering retrospectives — without maintaining two forks.

### Without gstack

- The agent takes your request literally — it never asks if you're building the right thing
- It will implement exactly what you said, even when the real product is something bigger
- "Review my PR" gives inconsistent depth every time
- "Ship this" turns into a long back-and-forth about what to do
- The agent can write code but can't see your app — it's half blind
- You still do QA by hand: open browser, click around, check pages, squint at layouts

### With gstack

| Skill | Mode | What it does |
|-------|------|--------------|
| `/plan-ceo-review` | Founder / CEO | Rethink the problem. Find the 10-star product hiding inside the request. |
| `/plan-eng-review` | Eng manager / tech lead | Lock in architecture, data flow, diagrams, edge cases, and tests. |
| `/review` | Paranoid staff engineer | Find the bugs that pass CI but blow up in production. Triages Greptile review comments. |
| `/ship` | Release engineer | Sync main, run tests, resolve Greptile reviews, push, open PR. For a ready branch, not for deciding what to build. |
| `/browse` | QA engineer | Give the agent eyes. It logs in, clicks through your app, takes screenshots, catches breakage. Full QA pass in 60 seconds. |
| `/qa` | QA lead | Systematic QA testing. On a feature branch, auto-analyzes your diff, identifies affected pages, and tests them. Also: full exploration, quick smoke test, regression mode. |
| `/setup-browser-cookies` | Session manager | Import cookies from your real browser (Comet, Chrome, Arc, Brave, Edge) into the headless session. Test authenticated pages without logging in manually. |
| `/retro` | Engineering manager | Team-aware retro: your deep-dive + per-person praise and growth opportunities for every contributor. |

## Demo: one feature, five modes

I start almost every feature in plan mode. I describe what I want to build, then use `/plan-ceo-review` to pressure-test whether I am even building the right thing. Only after the product direction is locked do I shift into engineering, review, ship, and test.

```
You:   [enter plan mode, describe the feature]
       I want to add seller photo upload to the listing app. Sellers
       should be able to upload a photo of their item and we create
       the listing from it.

You:   /plan-ceo-review

Claude: "Photo upload" is not the feature. The real job is helping sellers
        create listings that actually sell. Here's what the 10-star version
        looks like: auto-identify the product from the photo, pull specs and
        pricing comps from the web, draft the title and description, suggest
        the best hero image...

You:   /plan-eng-review

Claude: [Architecture diagram, state machine for upload → classify → enrich
        → draft pipeline, async job boundaries, failure modes, test matrix]

You:   [exit plan mode, implement the plan]

You:   /review

Claude: Race condition: two tabs can overwrite cover-photo selection.
        Trust boundary: pulling web data into draft generation creates
        a prompt injection vector. Missing: orphan cleanup for failed uploads.

You:   (fix the issues)

You:   /ship

Claude: [Syncs main, runs tests, pushes branch, opens PR — 6 tool calls, done]

You:   /qa

Claude: Analyzing branch diff... 8 files changed, 3 routes affected.
        [Tests /listings/new, /listings/:id, /api/listings against localhost:3000]
        All 3 routes working. Upload + enrichment flow passes end to end.

You:   /setup-browser-cookies staging.myapp.com

Claude: Imported 8 cookies for staging.myapp.com from Chrome.

You:   /qa https://staging.myapp.com --quick

Claude: [Smoke test: homepage + 5 pages, 30 seconds]
        Health Score: 91/100. No critical issues. 1 medium: mobile nav overlap.
```

## Who this is for

You already use Claude Code heavily and want consistent, high-rigor workflows instead of one mushy generic mode. You want to tell the model what kind of brain to use right now — founder taste, engineering rigor, paranoid review, or fast execution.

This is not a prompt pack for beginners. It is an operating system for people who ship.

## Codex compatibility

gstack now ships as two layers:

- Portable core: `browse/`, shared build/setup scripts, QA/review assets, and `references/workflows/*`
- Host glue: `CLAUDE.md` + top-level skill prompts for Claude, `AGENTS.md` + `.codex/skills/*` for Codex

Codex does not try to emulate Claude slash-command registration. Instead it gets:

- repo-local skills in `.codex/skills/`
- host-aware install via `./setup --host codex` or `./setup --host auto`
- compatibility wrappers like `bin/gstack-browse`, `bin/gstack-qa`, and `bin/gstack-review`
- an explicit alias contract: `/browse` maps to `gstack-browse`, `/qa` to `gstack-qa`, and so on

The compiled browser binary stays unchanged. Browser/QA flows still run through `browse/dist/browse`, not host-native browser tools.

## How to fly: 10 sessions at once

gstack is powerful with one Claude Code session. It is transformative with ten.

[Conductor](https://conductor.build) runs multiple Claude Code sessions in parallel — each in its own isolated workspace. That means you can have one session running `/qa` on staging, another doing `/review` on a PR, a third implementing a feature, and seven more working on other branches. All at the same time.

Each workspace gets its own isolated browser instance automatically — separate Chromium process, cookies, tabs, and logs stored in `.gstack/` inside each project root. No port collisions, no shared state, no configuration needed. `/browse` and `/qa` sessions never interfere with each other, even across ten parallel workspaces.

This is the setup I use. One person, ten parallel agents, each with the right cognitive mode for its task. That is not incremental improvement. That is a different way of building software.

## Install

**Requirements:** [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+, and either [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or Codex. `/browse` compiles a native binary — works on macOS and Linux (x64 and arm64).

### Codex: global install

Clone anywhere, then register Codex skills globally:

```bash
git clone https://github.com/garrytan/gstack.git ~/src/gstack
cd ~/src/gstack
./setup --host codex
```

This creates `~/.codex/skills/gstack` plus sibling skills:

- `gstack-browse`
- `gstack-qa`
- `gstack-review`
- `gstack-plan-ceo-review`
- `gstack-plan-eng-review`
- `gstack-browser-cookies`
- `gstack-ship`
- `gstack-retro`

### Codex: add to your repo so teammates get it

```bash
mkdir -p .codex/skills
cp -Rf ~/src/gstack .codex/skills/gstack
rm -rf .codex/skills/gstack/.git
cd .codex/skills/gstack
./setup --host codex
```

Then add an `AGENTS.md` section telling Codex to map `/browse`, `/qa`, `/review`, `/ship`, `/plan-ceo-review`, `/plan-eng-review`, `/setup-browser-cookies`, and `/retro` to the corresponding `gstack-*` skills.

### Claude: existing install path

Global install still works:

```bash
git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack
./setup --host claude
```

Project-local vendoring still works:

```bash
cp -Rf ~/.claude/skills/gstack .claude/skills/gstack
rm -rf .claude/skills/gstack/.git
cd .claude/skills/gstack
./setup --host claude
```

The Claude path is intentionally preserved. The Codex layer is additive, not a rewrite.

### What gets installed

- Host root: `~/.claude/skills/gstack` or `~/.codex/skills/gstack` depending on setup host
- Host-visible skill aliases:
  - Claude: `~/.claude/skills/browse`, `~/.claude/skills/qa`, `~/.claude/skills/review`, etc.
  - Codex: `~/.codex/skills/gstack-browse`, `~/.codex/skills/gstack-qa`, `~/.codex/skills/gstack-review`, etc.
- Browser binary at `browse/dist/browse` (~58MB, gitignored)
- `node_modules/` (gitignored)
- Codex workflow references in `references/workflows/`
- `/retro` saves JSON snapshots to `.context/retros/` in your project for trend tracking

Nothing touches your PATH or runs in the background. The compatibility wrapper scripts in `bin/` just print the exact Codex skill invocation text.

---

```
+----------------------------------------------------------------------------+
|                                                                            |
|   Are you a great software engineer who loves to write 10K LOC/day         |
|   and land 10 PRs a day like Garry?                                        |
|                                                                            |
|   Come work at YC: ycombinator.com/software                                |
|                                                                            |
|   Extremely competitive salary and equity.                                 |
|   Now hiring in San Francisco, Dogpatch District.                          |
|   Come join the revolution.                                                |
|                                                                            |
+----------------------------------------------------------------------------+
```

---

## How I use these skills

Created by [Garry Tan](https://x.com/garrytan), President & CEO of [Y Combinator](https://www.ycombinator.com/).

I built gstack because I do not want AI coding tools stuck in one mushy mode.

Planning is not review. Review is not shipping. Founder taste is not engineering rigor. If you blur all of that together, you usually get a mediocre blend of all four.

I want explicit gears.

These skills let me tell the model what kind of brain I want right now. I can switch cognitive modes on demand — founder, eng manager, paranoid reviewer, release machine. That is the unlock.

---

## `/plan-ceo-review`

This is my **founder mode**.

This is where I want the model to think with taste, ambition, user empathy, and a long time horizon. I do not want it taking the request literally. I want it asking a more important question first:

**What is this product actually for?**

I think of this as **Brian Chesky mode**.

The point is not to implement the obvious ticket. The point is to rethink the problem from the user's point of view and find the version that feels inevitable, delightful, and maybe even a little magical.

### Example

Say I am building a Craigslist-style listing app and I say:

> "Let sellers upload a photo for their item."

A weak assistant will add a file picker and save an image.

That is not the real product.

In `/plan-ceo-review`, I want the model to ask whether "photo upload" is even the feature. Maybe the real feature is helping someone create a listing that actually sells.

If that is the real job, the whole plan changes.

Now the model should ask:

* Can we identify the product from the photo?
* Can we infer the SKU or model number?
* Can we search the web and draft the title and description automatically?
* Can we pull specs, category, and pricing comps?
* Can we suggest which photo will convert best as the hero image?
* Can we detect when the uploaded photo is ugly, dark, cluttered, or low-trust?
* Can we make the experience feel premium instead of like a dead form from 2007?

That is what `/plan-ceo-review` does for me.

It does not just ask, "how do I add this feature?"
It asks, **"what is the 10-star product hiding inside this request?"**

That is a very different kind of power.

---

## `/plan-eng-review`

This is my **eng manager mode**.

Once the product direction is right, I want a different kind of intelligence entirely. I do not want more sprawling ideation. I do not want more "wouldn't it be cool if." I want the model to become my best technical lead.

This mode should nail:

* architecture
* system boundaries
* data flow
* state transitions
* failure modes
* edge cases
* trust boundaries
* test coverage

And one surprisingly big unlock for me: **diagrams**.

LLMs get way more complete when you force them to draw the system. Sequence diagrams, state diagrams, component diagrams, data-flow diagrams, even test matrices. Diagrams force hidden assumptions into the open. They make hand-wavy planning much harder.

So `/plan-eng-review` is where I want the model to build the technical spine that can carry the product vision.

### Example

Take the same listing app example.

Let's say `/plan-ceo-review` already did its job. We decided the real feature is not just photo upload. It is a smart listing flow that:

* uploads photos
* identifies the product
* enriches the listing from the web
* drafts a strong title and description
* suggests the best hero image

Now `/plan-eng-review` takes over.

Now I want the model to answer questions like:

* What is the architecture for upload, classification, enrichment, and draft generation?
* Which steps happen synchronously, and which go to background jobs?
* Where are the boundaries between app server, object storage, vision model, search/enrichment APIs, and the listing database?
* What happens if upload succeeds but enrichment fails?
* What happens if product identification is low-confidence?
* How do retries work?
* How do we prevent duplicate jobs?
* What gets persisted when, and what can be safely recomputed?

And this is where I want diagrams — architecture diagrams, state models, data-flow diagrams, test matrices. Diagrams force hidden assumptions into the open. They make hand-wavy planning much harder.

That is `/plan-eng-review`.

Not "make the idea smaller."
**Make the idea buildable.**

---

## `/review`

This is my **paranoid staff engineer mode**.

Passing tests do not mean the branch is safe.

`/review` exists because there is a whole class of bugs that can survive CI and still punch you in the face in production. This mode is not about dreaming bigger. It is not about making the plan prettier. It is about asking:

**What can still break?**

This is a structural audit, not a style nitpick pass. I want the model to look for things like:

* N+1 queries
* stale reads
* race conditions
* bad trust boundaries
* missing indexes
* escaping bugs
* broken invariants
* bad retry logic
* tests that pass while missing the real failure mode

### Example

Suppose the smart listing flow is implemented and the tests are green.

`/review` should still ask:

* Did I introduce an N+1 query when rendering listing photos or draft suggestions?
* Am I trusting client-provided file metadata instead of validating the actual file?
* Can two tabs race and overwrite cover-photo selection or item details?
* Do failed uploads leave orphaned files in storage forever?
* Can the "exactly one hero image" rule break under concurrency?
* If enrichment APIs partially fail, do I degrade gracefully or save garbage?
* Did I accidentally create a prompt injection or trust-boundary problem by pulling web data into draft generation?

That is the point of `/review`.

I do not want flattery here.
I want the model imagining the production incident before it happens.

---

## `/ship`

This is my **release machine mode**.

Once I have decided what to build, nailed the technical plan, and run a serious review, I do not want more talking. I want execution.

`/ship` is for the final mile. It is for a ready branch, not for deciding what to build.

This is where the model should stop behaving like a brainstorm partner and start behaving like a disciplined release engineer: sync with main, run the right tests, make sure the branch state is sane, update changelog or versioning if the repo expects it, push, and create or update the PR.

Momentum matters here.

A lot of branches die when the interesting work is done and only the boring release work is left. Humans procrastinate that part. AI should not.

### Example

Suppose the smart listing flow is finished.

The product thinking is done.
The architecture is done.
The review pass is done.
Now the branch just needs to get landed.

That is what `/ship` is for.

It takes care of the repetitive release hygiene so I do not bleed energy on:

* syncing with main
* rerunning tests
* checking for weird branch state
* updating changelog/version metadata
* pushing the branch
* opening or updating the PR

At this point I do not want more ideation.
I want the plane landed.

---

## Greptile integration

[Greptile](https://greptile.com) is a YC company that reviews your PRs automatically. It catches real bugs — race conditions, security issues, things that pass CI and blow up in production. It has genuinely saved my ass more than once. I love these guys.

**Setup:** Install Greptile on your GitHub repo at [greptile.com](https://greptile.com) — it takes about 30 seconds. Once it's reviewing your PRs, gstack picks up its comments automatically. No additional configuration.

The problem with any automated reviewer is triage. Greptile is good, but not every comment is a real issue. Some are false positives. Some flag things you already fixed three commits ago. Without a triage layer, the comments pile up and you start ignoring them — which defeats the purpose.

gstack solves this. `/review` and `/ship` are now Greptile-aware. They read Greptile's comments, classify each one, and take action:

- **Valid issues** get added to the critical findings and fixed before shipping
- **Already-fixed issues** get an auto-reply acknowledging the catch
- **False positives** get pushed back — you confirm, and a reply goes out explaining why it's wrong

The result is a two-layer review: Greptile catches things asynchronously on the PR, then `/review` and `/ship` triage those findings as part of the normal workflow. Nothing falls through the cracks.

It also learns. Every false positive you confirm gets saved to `~/.gstack/greptile-history.md`. Future runs auto-skip known FP patterns for your codebase. And `/retro` tracks Greptile's batting average over time — so you can see whether the signal-to-noise ratio is improving.

### Example

```
You:   /ship

Claude: [syncs main, runs tests, pre-landing review...]

        Greptile found 3 comments on this PR:

        [VALID] app/services/payment_service.rb:47 — Race condition:
        concurrent charges can double-debit. Recommend DB-level advisory
        lock around the charge block.
        → https://github.com/you/app/pull/42#discussion_r123

        [ALREADY FIXED] app/models/user.rb:12 — Missing null check
        on email before downcase.
        → Already fixed in commit abc1234. Auto-replying.

        [FALSE POSITIVE] lib/auth.rb:88 — "Token comparison should
        use constant-time comparison." We already use
        ActiveSupport::SecurityUtils.secure_compare here.
        → https://github.com/you/app/pull/42#discussion_r125

        Fixing the race condition in payment_service.rb...
        Applied advisory lock. Committed: fix: address Greptile
        review — advisory lock on concurrent charges

        The auth token comment is a false positive — we're already
        using secure_compare.

        Options for the false positive:
          A) Reply to Greptile explaining (recommended)
          B) Fix it anyway
          C) Ignore

You:    A

Claude: Replied to Greptile. Re-running tests after the fix...
        All tests pass. Continuing to version bump.

        [creates PR with Greptile Review section in body]
        PR: https://github.com/you/app/pull/42
```

Three Greptile comments. One real fix. One auto-acknowledged. One false positive pushed back with a reply. Total extra time: about 30 seconds. And the PR body has the full audit trail.

---

## `/browse`

This is my **QA engineer mode**.

`/browse` is the skill that closes the loop. Before it, the agent could think and code but was still half blind. It had to guess about UI state, auth flows, redirects, console errors, empty states, and broken layouts. Now it can just go look.

That is a real step-change. The full cycle becomes: plan, code, run the app, inspect the UI, reproduce the bug, verify the fix, ship. QA stops being "go click around manually" and becomes part of the same agentic loop. It gives the agent eyes. Now it can do the boring, high-context QA work itself: click through the app, catch breakage, verify the fix, and keep going. That feels like having a real operator in the machine.

It is a compiled binary that talks to a persistent Chromium daemon — built on [Playwright](https://playwright.dev/) by Microsoft. First call starts the browser (~3s). Every call after that: ~100-200ms. The browser stays running between commands, so cookies, tabs, and localStorage carry over.

After I push a branch, I tell Claude to go check staging. It does the entire QA pass for me:

```
You:   /browse staging.myapp.com — log in, test the signup flow, and check
       every page I changed in this branch

Claude: [18 tool calls, ~60 seconds]

        > browse goto https://staging.myapp.com/signup
        > browse snapshot -i
        > browse fill @e2 "test@example.com"
        > browse fill @e3 "password123"
        > browse click @e5                    (Submit)
        > browse screenshot /tmp/signup.png
        > Read /tmp/signup.png

        Signup works. Redirected to onboarding. Now checking changed pages.

        > browse goto https://staging.myapp.com/dashboard
        > browse screenshot /tmp/dashboard.png
        > Read /tmp/dashboard.png
        > browse console

        Dashboard loads. No console errors. Charts render with sample data.

        > browse goto https://staging.myapp.com/settings/billing
        > browse screenshot /tmp/billing.png
        > Read /tmp/billing.png

        Billing page loads. Plan selector shows Free/Pro/Enterprise.
        Stripe elements render correctly.

        > browse goto https://staging.myapp.com/api/health
        > browse text

        API health endpoint returns {"status":"ok","version":"2.4.1"}.

        All 4 pages load correctly. No console errors. No broken layouts.
        Signup → onboarding → dashboard flow works end to end.
```

18 tool calls, about a minute. It signed up a test user, navigated every page I changed, took screenshots, read them, checked the console for errors, and verified the API. That is a full QA pass. I did not open a browser.

It works for reading documentation, verifying deployments, filling out forms, taking screenshots, comparing pages across environments, and anything else where Claude needs eyes on a live URL.

**Security note:** `/browse` runs a persistent Chromium session. Cookies, localStorage, and session state carry over between commands. Do not use it against sensitive production environments unless you intend to — it is a real browser with real state. The session auto-shuts down after 30 minutes of idle time.

For the full command reference, technical internals, and architecture details, see [BROWSER.md](BROWSER.md).

---

## `/qa`

This is my **QA lead mode**.

`/browse` gives the agent eyes. `/qa` gives it a testing methodology.

The most common use case: you're on a feature branch, you just finished coding, and you want to verify everything works. Just say `/qa` — it reads your git diff, identifies which pages and routes your changes affect, spins up the browser, and tests each one. No URL required. No manual test plan. It figures out what to test from the code you changed.

```
You:   /qa

Claude: Analyzing branch diff against main...
        12 files changed: 3 controllers, 2 views, 4 services, 3 tests

        Affected routes: /listings/new, /listings/:id, /api/listings
        Detected app running on localhost:3000.

        [Tests each affected page — navigates, fills forms, clicks buttons,
        screenshots, checks console errors]

        QA Report: 3 routes tested, all working.
        - /listings/new: upload + enrichment flow works end to end
        - /listings/:id: detail page renders correctly
        - /api/listings: returns 200 with expected shape
        No console errors. No regressions on adjacent pages.
```

Four modes:

- **Diff-aware** (automatic on feature branches) — reads `git diff main`, identifies affected pages, tests them specifically. The fastest path from "I just wrote code" to "it works."
- **Full** — systematic exploration of the entire app. 5-15 minutes depending on app size. Documents 5-10 well-evidenced issues.
- **Quick** (`--quick`) — 30-second smoke test. Homepage + top 5 nav targets. Loads? Console errors? Broken links?
- **Regression** (`--regression baseline.json`) — run full mode, then diff against a previous baseline. Which issues are fixed? Which are new? What's the score delta?

```
You:   /qa https://staging.myapp.com

Claude: [Explores 12 pages, fills 3 forms, tests 2 flows]

        QA Report: staging.myapp.com — Health Score: 72/100

        Top 3 Issues:
        1. CRITICAL: Checkout form submits with empty required fields
        2. HIGH: Mobile nav menu doesn't close after selecting an item
        3. MEDIUM: Dashboard chart overlaps sidebar below 1024px

        [Full report with screenshots saved to .gstack/qa-reports/]
```

Reports and screenshots accumulate in `.gstack/qa-reports/` so you can track quality over time and compare runs.

**Testing authenticated pages:** Use `/setup-browser-cookies` first to import your real browser sessions, then `/qa` can test pages behind login.

---

## `/setup-browser-cookies`

This is my **session manager mode**.

Before `/qa` or `/browse` can test authenticated pages, they need cookies. Instead of manually logging in through the headless browser every time, `/setup-browser-cookies` imports your real sessions directly from your daily browser.

It auto-detects installed Chromium browsers (Comet, Chrome, Arc, Brave, Edge), decrypts cookies via the macOS Keychain, and loads them into the Playwright session. An interactive picker UI lets you choose exactly which domains to import — no cookie values are ever displayed.

```
You:   /setup-browser-cookies

Claude: Cookie picker opened — select the domains you want to import
        in your browser, then tell me when you're done.

        [You pick github.com, myapp.com in the browser UI]

You:    done

Claude: Imported 2 domains (47 cookies). Session is ready.
```

Or skip the UI entirely:

```
You:   /setup-browser-cookies github.com

Claude: Imported 12 cookies for github.com from Comet.
```

First import per browser triggers a macOS Keychain prompt — click "Allow" or "Always Allow."

---

## `/retro`

This is my **engineering manager mode**.

At the end of the week I want to know what actually happened. Not vibes — data. `/retro` analyzes commit history, work patterns, and shipping velocity and writes a candid retrospective.

It is team-aware. It identifies who is running the command, gives you the deepest treatment on your own work, then breaks down every contributor with specific praise and growth opportunities — the kind of feedback you would actually give in a 1:1. It computes metrics like commits, LOC, test ratio, PR sizes, and fix ratio. It detects coding sessions from commit timestamps, finds hotspot files, tracks shipping streaks, and identifies the biggest ship of the week.

```
You:   /retro

Claude: Week of Mar 1: 47 commits (3 contributors), 3.2k LOC, 38% tests, 12 PRs, peak: 10pm | Streak: 47d

        ## Your Week
        32 commits, +2.4k LOC, 41% tests. Peak hours: 9-11pm.
        Biggest ship: cookie import system (browser decryption + picker UI).
        What you did well: shipped a complete feature with encryption, UI, and
        18 unit tests in one focused push...

        ## Team Breakdown

        ### Alice
        12 commits focused on app/services/. Every PR under 200 LOC — disciplined.
        Opportunity: test ratio at 12% — worth investing before payment gets more complex.

        ### Bob
        3 commits — fixed the N+1 query on dashboard. Small but high-impact.
        Opportunity: only 1 active day this week — check if blocked on anything.

        [Top 3 team wins, 3 things to improve, 3 habits for next week]
```

It saves a JSON snapshot to `.context/retros/` so the next run can show trends. Run `/retro compare` to see this week vs last week side by side.

---

## Troubleshooting

**Skill not showing up in Claude Code?**
Run `cd ~/.claude/skills/gstack && ./setup` (or `cd .claude/skills/gstack && ./setup` for project installs). This rebuilds symlinks so Claude can discover the skills.

**`/browse` fails or binary not found?**
Run `cd ~/.claude/skills/gstack && bun install && bun run build`. This compiles the browser binary. Requires Bun v1.0+.

**Project copy is stale?**
Run `/gstack-upgrade` — it updates both the global install and any vendored project copy automatically.

**`bun` not installed?**
Install it: `curl -fsSL https://bun.sh/install | bash`

## Upgrading

Run `/gstack-upgrade` in Claude Code. It detects your install type (global or vendored), upgrades, syncs any project copies, and shows what's new.

Or set `auto_upgrade: true` in `~/.gstack/config.yaml` to upgrade automatically whenever a new version is available.

## Uninstalling

Paste this into Claude Code:

> Uninstall gstack: remove the skill symlinks by running `for s in browse plan-ceo-review plan-eng-review review ship retro qa setup-browser-cookies; do rm -f ~/.claude/skills/$s; done` then run `rm -rf ~/.claude/skills/gstack` and remove the gstack section from CLAUDE.md. If this project also has gstack at .claude/skills/gstack, remove it by running `for s in browse plan-ceo-review plan-eng-review review ship retro qa setup-browser-cookies; do rm -f .claude/skills/$s; done && rm -rf .claude/skills/gstack` and remove the gstack section from the project CLAUDE.md too.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and dev mode. See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions and system internals. See [BROWSER.md](BROWSER.md) for the browse command reference.

### Testing

```bash
bun test                     # free static tests (<5s)
EVALS=1 bun run test:evals   # full E2E + LLM evals (~$4, ~20min)
bun run eval:watch            # live dashboard during E2E runs
```

E2E tests stream real-time progress, write machine-readable diagnostics, and persist partial results that survive kills. See CONTRIBUTING.md for the full eval infrastructure.

## License

MIT
