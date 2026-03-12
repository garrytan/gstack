# gstack

**gstack turns Claude Code from one generic assistant into a team of specialists you can summon on demand.**

Six opinionated workflow skills for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Plan review, code review, one-command shipping, browser automation, and engineering retrospectives — all as slash commands.

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
| `/review` | Paranoid staff engineer | Find the bugs that pass CI but blow up in production. Not a style nitpick pass. |
| `/ship` | Release engineer | Sync main, run tests, push, open PR. For a ready branch, not for deciding what to build. |
| `/browse` | QA engineer | Give the agent eyes. It logs in, clicks through your app, takes screenshots, catches breakage. Full QA pass in 60 seconds. |
| `/retro` | Engineering manager | Analyze commit history, work patterns, and shipping velocity for the week. |

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

You:   /browse staging.myapp.com — test the listing flow

Claude: [22 tool calls — navigates routes, fills the upload form, verifies
        enrichment renders, checks console for errors, screenshots each step]
        All pages load correctly. Listing flow works end to end on staging.
```

## Who this is for

You already use Claude Code heavily and want consistent, high-rigor workflows instead of one mushy generic mode. You want to tell the model what kind of brain to use right now — founder taste, engineering rigor, paranoid review, or fast execution.

This is not a prompt pack for beginners. It is an operating system for people who ship.

## Install

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+. `/browse` compiles a native binary and `./setup` installs Playwright Chromium — works on macOS and Linux (x64 and arm64).

### Step 1: Install on your machine

Open Claude Code and paste this. Claude will do the rest.

> Install gstack: run `git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` then add a "gstack" section to CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, and lists the available skills: /plan-ceo-review, /plan-eng-review, /review, /ship, /browse, /retro. Then ask the user if they also want to add gstack to the current project so teammates get it.

### Step 2: Add to your repo so teammates get it (optional)

> Add gstack to this project: run `cp -Rf ~/.claude/skills/gstack .claude/skills/gstack && rm -rf .claude/skills/gstack/.git && cd .claude/skills/gstack && ./setup` then add a "gstack" section to this project's CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, lists the available skills: /plan-ceo-review, /plan-eng-review, /review, /ship, /browse, /retro, and tells Claude that if gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to build the binary and register skills.

Real files get committed to your repo (not a submodule), so `git clone` just works. The binary and node\_modules are gitignored — teammates just need to run `cd .claude/skills/gstack && ./setup` once to build (or `/browse` handles it automatically on first use).

### What gets installed

- Skill files (Markdown prompts) in `~/.claude/skills/gstack/` (or `.claude/skills/gstack/` for project installs)
- Symlinks at `~/.claude/skills/browse`, `~/.claude/skills/review`, etc. pointing into the gstack directory
- Browser binary at `browse/dist/browse` (~58MB, gitignored)
- Playwright Chromium (installed by `./setup` if missing)
- `node_modules/` (gitignored)
- `/retro` saves JSON snapshots to `.context/retros/` in your project for trend tracking

Everything lives inside `.claude/`. Nothing touches your PATH or runs in the background.

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

## `/retro`

This is my **engineering manager mode**.

At the end of the week I want to know what actually happened. Not vibes — data. `/retro` analyzes commit history, work patterns, and shipping velocity and writes a candid retrospective.

It computes metrics like commits, LOC, test ratio, PR sizes, and fix ratio. It detects coding sessions from commit timestamps, finds hotspot files, tracks shipping streaks, and identifies the biggest ship of the week.

```
You:   /retro

Claude: Week of Mar 1: 47 commits, 3.2k LOC, 38% tests, 12 PRs, peak: 10pm | Streak: 47d

        [Full retro with summary table, time patterns, session analysis,
         commit type breakdown, hotspots, focus score, top 3 wins,
         3 things to improve, 3 habits for next week]
```

It saves a JSON snapshot to `.context/retros/` so the next run can show trends. Run `/retro compare` to see this week vs last week side by side.

---

## Troubleshooting

**Skill not showing up in Claude Code?**
Run `cd ~/.claude/skills/gstack && ./setup` (or `cd .claude/skills/gstack && ./setup` for project installs). This rebuilds symlinks so Claude can discover the skills.

**`/browse` fails or binary not found?**
Run `cd ~/.claude/skills/gstack && bun install && bun run build`. This compiles the browser binary. Requires Bun v1.0+.

**Project copy is stale?**
Re-copy from global: `for s in browse plan-ceo-review plan-eng-review review ship retro; do rm -f .claude/skills/$s; done && rm -rf .claude/skills/gstack && cp -Rf ~/.claude/skills/gstack .claude/skills/gstack && rm -rf .claude/skills/gstack/.git && cd .claude/skills/gstack && ./setup`

**`bun` not installed?**
Install it: `curl -fsSL https://bun.sh/install | bash`

## Upgrading

Paste this into Claude Code:

> Update gstack: run `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main && ./setup`. If this project also has gstack at .claude/skills/gstack, update it too: run `for s in browse plan-ceo-review plan-eng-review review ship retro; do rm -f .claude/skills/$s; done && rm -rf .claude/skills/gstack && cp -Rf ~/.claude/skills/gstack .claude/skills/gstack && rm -rf .claude/skills/gstack/.git && cd .claude/skills/gstack && ./setup`

The `setup` script rebuilds the browser binary and re-symlinks skills. It takes a few seconds.

## Uninstalling

Paste this into Claude Code:

> Uninstall gstack: remove the skill symlinks by running `for s in browse plan-ceo-review plan-eng-review review ship retro; do rm -f ~/.claude/skills/$s; done` then run `rm -rf ~/.claude/skills/gstack` and remove the gstack section from CLAUDE.md. If this project also has gstack at .claude/skills/gstack, remove it by running `for s in browse plan-ceo-review plan-eng-review review ship retro; do rm -f .claude/skills/$s; done && rm -rf .claude/skills/gstack` and remove the gstack section from the project CLAUDE.md too.

## Development

See [BROWSER.md](BROWSER.md) for the full development guide, architecture, and command reference.

## License

MIT
