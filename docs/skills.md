# Skill Deep Dives

Detailed guides for every gstack skill — philosophy, workflow, and examples.

| Skill | Your specialist | What they do |
|-------|----------------|--------------|
| [`/office-hours`](#office-hours) | **YC Office Hours** | Start here. Six forcing questions that reframe your product before you write code. Pushes back on your framing, challenges premises, generates implementation alternatives. Design doc feeds into every downstream skill. |
| [`/plan-ceo-review`](#plan-ceo-review) | **CEO / Founder** | Rethink the problem. Find the 10-star product hiding inside the request. Four modes: Expansion, Selective Expansion, Hold Scope, Reduction. |
| [`/plan-eng-review`](#plan-eng-review) | **Eng Manager** | Lock in architecture, data flow, diagrams, edge cases, and tests. Forces hidden assumptions into the open. |
| [`/plan-design-review`](#plan-design-review) | **Senior Designer** | Interactive plan-mode design review. Rates each dimension 0-10, explains what a 10 looks like, fixes the plan. Works in plan mode. |
| [`/design-consultation`](#design-consultation) | **Design Partner** | Build a complete design system from scratch. Knows the landscape, proposes creative risks, generates realistic product mockups. Design at the heart of all other phases. |
| [`/review`](#review) | **Staff Engineer** | Find the bugs that pass CI but blow up in production. Auto-fixes the obvious ones. Flags completeness gaps. |
| [`/investigate`](#investigate) | **Debugger** | Systematic root-cause debugging. Iron Law: no fixes without investigation. Traces data flow, tests hypotheses, stops after 3 failed fixes. |
| [`/design-review`](#design-review) | **Designer Who Codes** | Live-site visual audit + fix loop. 80-item audit, then fixes what it finds. Atomic commits, before/after screenshots. |
| [`/design-shotgun`](#design-shotgun) | **Design Explorer** | Generate multiple AI design variants, open a comparison board in your browser, and iterate until you approve a direction. Taste memory biases toward your preferences. |
| [`/design-html`](#design-html) | **Design Engineer** | Generates production-quality Pretext-native HTML. Works with approved mockups, CEO plans, design reviews, or from scratch. Text reflows on resize, heights adjust to content. Smart API routing per design type. Framework detection for React/Svelte/Vue. |
| [`/qa`](#qa) | **QA Lead** | Test your app, find bugs, fix them with atomic commits, re-verify. Auto-generates regression tests for every fix. |
| [`/qa-only`](#qa) | **QA Reporter** | Same methodology as /qa but report only. Use when you want a pure bug report without code changes. |
| [`/scrape`](#scrape) | **Browser Data Extractor** | Pull data from a web page. First call prototypes via `$B`; subsequent calls on a matching intent run a codified browser-skill in ~200ms. |
| [`/skillify`](#skillify) | **Skill Codifier** | Walks back through your conversation, finds the last `/scrape` prototype, synthesizes script + test + fixture, runs the test, asks before committing. |
| [`/ship`](#ship) | **Release Engineer** | Sync main, run tests, audit coverage, push, open PR. Bootstraps test frameworks if you don't have one. One command. |
| [`/land-and-deploy`](#land-and-deploy) | **Release Engineer** | Merge the PR, wait for CI and deploy, verify production health. One command from "approved" to "verified in production." |
| [`/canary`](#canary) | **SRE** | Post-deploy monitoring loop. Watches for console errors, performance regressions, and page failures using the browse daemon. |
| [`/benchmark`](#benchmark) | **Performance Engineer** | Baseline page load times, Core Web Vitals, and resource sizes. Compare before/after on every PR. Track trends over time. |
| [`/cso`](#cso) | **Chief Security Officer** | OWASP Top 10 + STRIDE threat modeling security audit. Scans for injection, auth, crypto, and access control issues. |
| [`/document-release`](#document-release) | **Technical Writer** | Update all project docs to match what you just shipped. Catches stale READMEs automatically. |
| [`/retro`](#retro) | **Eng Manager** | Team-aware weekly retro. Per-person breakdowns, shipping streaks, test health trends, growth opportunities. |
| [`/browse`](#browse) | **QA Engineer** | Give the agent eyes. Real Chromium browser, real clicks, real screenshots. ~100ms per command. |
| [`/setup-browser-cookies`](#setup-browser-cookies) | **Session Manager** | Import cookies from your real browser (Chrome, Arc, Brave, Edge) into the headless session. Test authenticated pages. |
| [`/autoplan`](#autoplan) | **Review Pipeline** | One command, fully reviewed plan. Runs CEO → design → eng → DX review automatically with encoded decision principles. Surfaces only taste decisions for your approval. |
| [`/plan-devex-review`](#plan-devex-review) | **DX Reviewer** | Plan-stage DX review. TTHW (time-to-hello-world), magical moments, friction points, persona traces. Three modes: Expansion, Polish, Triage. |
| [`/devex-review`](#devex-review) | **DX Reviewer (live)** | Live developer experience audit. Walks the actual onboarding flow, measures TTHW, catches the docs lies. |
| [`/plan-tune`](#plan-tune) | **Question Tuner** | Self-tune AskUserQuestion sensitivity per question. Mark questions as never-ask, always-ask, or only-for-one-way. |
| [`/learn`](#learn) | **Memory** | Manage what gstack learned across sessions. Review, search, prune, and export project-specific patterns and preferences. |
| [`/context-save`](#context-save) | **Save State** | Save working context (git state, decisions, remaining work) so any future session can resume. |
| [`/context-restore`](#context-restore) | **Restore State** | Resume from a saved context, even across Conductor workspace handoffs. |
| [`/health`](#health) | **Code Quality Dashboard** | Wraps type checker, linter, tests, dead code detection. Computes a weighted 0-10 score; tracks trends over time. |
| [`/landing-report`](#landing-report) | **Ship Queue Dashboard** | Read-only snapshot of the workspace-aware ship queue. Which version slots are claimed, which sibling workspaces have WIP. |
| [`/benchmark-models`](#benchmark-models) | **Model Benchmark** | Side-by-side cross-model benchmark for skills (Claude vs GPT vs Gemini). Latency, tokens, cost, optional LLM-judged quality. |
| | | |
| **Multi-AI** | | |
| [`/codex`](#codex) | **Second Opinion** | Independent review from OpenAI Codex CLI. Three modes: code review (pass/fail gate), adversarial challenge, and open consultation with session continuity. Cross-model analysis when both `/review` and `/codex` have run. |
| [`/pair-agent`](#pair-agent) | **Remote Agent Bridge** | Pair a remote AI agent (OpenClaw, Codex, Cursor, Hermes) with your browser. Scoped tunnel, locked allowlist, session token. |
| [`/setup-gbrain`](#setup-gbrain) | **Memory Sync** | Set up gbrain for cross-machine session memory sync. One command from zero to live. |
| | | |
| **Safety & Utility** | | |
| [`/careful`](#safety--guardrails) | **Safety Guardrails** | Warns before destructive commands (rm -rf, DROP TABLE, force-push, git reset --hard). Override any warning. Common build cleanups whitelisted. |
| [`/freeze`](#safety--guardrails) | **Edit Lock** | Restrict all file edits to a single directory. Blocks Edit and Write outside the boundary. Accident prevention for debugging. |
| [`/guard`](#safety--guardrails) | **Full Safety** | Combines /careful + /freeze in one command. Maximum safety for prod work. |
| [`/unfreeze`](#safety--guardrails) | **Unlock** | Remove the /freeze boundary, allowing edits everywhere again. |
| [`/open-gstack-browser`](#open-gstack-browser) | **GStack Browser** | Launch GStack Browser with sidebar, anti-bot stealth, auto model routing, cookie import, and Claude Code integration. Watch every action live. |
| [`/setup-deploy`](#setup-deploy) | **Deploy Configurator** | One-time setup for `/land-and-deploy`. Detects your platform, production URL, and deploy commands. |
| [`/gstack-upgrade`](#gstack-upgrade) | **Self-Updater** | Upgrade gstack to the latest version. Detects global vs vendored install, syncs both, shows what changed. |
| [`/make-pdf`](#make-pdf) | **PDF Generator** | Turn any markdown file into a publication-quality PDF. Proper margins, page numbers, cover pages, clickable TOC. |

---

## `/office-hours`

This is where every project should start.

Before you plan, before you review, before you write code — sit down with a YC-style partner and think about what you're actually building. Not what you think you're building. What you're *actually* building.

### The reframe

Here's what happened on a real project. The user said: "I want to build a daily briefing app for my calendar." Reasonable request. Then it asked about the pain — specific examples, not hypotheticals. They described an assistant missing things, calendar items across multiple Google accounts with stale info, prep docs that were AI slop, events with wrong locations that took forever to track down.

It came back with: *"I'm going to push back on the framing, because I think you've outgrown it. You said 'daily briefing app for multi-Google-Calendar management.' But what you actually described is a personal chief of staff AI."*

Then it extracted five capabilities the user didn't realize they were describing:

1. **Watches your calendar** across all accounts and detects stale info, missing locations, permission gaps
2. **Generates real prep work** — not logistics summaries, but *the intellectual work* of preparing for a board meeting, a podcast, a fundraiser
3. **Manages your CRM** — who are you meeting, what's the relationship, what do they want, what's the history
4. **Prioritizes your time** — flags when prep needs to start early, blocks time proactively, ranks events by importance
5. **Trades money for leverage** — actively looks for ways to delegate or automate

That reframe changed the entire project. They were about to build a calendar app. Now they're building something ten times more valuable — because the skill listened to their pain instead of their feature request.

### Premise challenge

After the reframe, it presents premises for you to validate. Not "does this sound good?" — actual falsifiable claims about the product:

1. The calendar is the anchor data source, but the value is in the intelligence layer on top
2. The assistant doesn't get replaced — they get superpowered
3. The narrowest wedge is a daily briefing that actually works
4. CRM integration is a must-have, not a nice-to-have

You agree, disagree, or adjust. Every premise you accept becomes load-bearing in the design doc.

### Implementation alternatives

Then it generates 2-3 concrete implementation approaches with honest effort estimates:

- **Approach A: Daily Briefing First** — narrowest wedge, ships tomorrow, M effort (human: ~3 weeks / CC: ~2 days)
- **Approach B: CRM-First** — build the relationship graph first, L effort (human: ~6 weeks / CC: ~4 days)
- **Approach C: Full Vision** — everything at once, XL effort (human: ~3 months / CC: ~1.5 weeks)

Recommends A because you learn from real usage. CRM data comes naturally in week two.

### Two modes

**Startup mode** — for founders and intrapreneurs building a business. You get six forcing questions distilled from how YC partners evaluate products: demand reality, status quo, desperate specificity, narrowest wedge, observation & surprise, and future-fit. These questions are uncomfortable on purpose. If you can't name a specific human who needs your product, that's the most important thing to learn before writing any code.

**Builder mode** — for hackathons, side projects, open source, learning, and having fun. You get an enthusiastic collaborator who helps you find the coolest version of your idea. What would make someone say "whoa"? What's the fastest path to something you can share? The questions are generative, not interrogative.

### The design doc

Both modes end with a design doc written to `~/.gstack/projects/` — and that doc feeds directly into `/plan-ceo-review` and `/plan-eng-review`. The full lifecycle is now: `office-hours → plan → implement → review → QA → ship → retro`.

After the design doc is approved, `/office-hours` reflects on what it noticed about how you think — not generic praise, but specific callbacks to things you said during the session. The observations appear in the design doc too, so you re-encounter them when you re-read later.

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

### Four modes

- **SCOPE EXPANSION** — dream big. The agent proposes the ambitious version. Every expansion is presented as an individual decision you opt into. Recommends enthusiastically.
- **SELECTIVE EXPANSION** — hold your current scope as the baseline, but see what else is possible. The agent surfaces opportunities one by one with neutral recommendations — you cherry-pick the ones worth doing.
- **HOLD SCOPE** — maximum rigor on the existing plan. No expansions surfaced.
- **SCOPE REDUCTION** — find the minimum viable version. Cut everything else.

Visions and decisions are persisted to `~/.gstack/projects/` so they survive beyond the conversation. Exceptional visions can be promoted to `docs/designs/` in your repo for the team.

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

### Review Readiness Dashboard

Every review (CEO, Eng, Design) logs its result. At the end of each review, you see a dashboard:

```
+====================================================================+
|                    REVIEW READINESS DASHBOARD                       |
+====================================================================+
| Review          | Runs | Last Run            | Status    | Required |
|-----------------|------|---------------------|-----------|----------|
| Eng Review      |  1   | 2026-03-16 15:00    | CLEAR     | YES      |
| CEO Review      |  1   | 2026-03-16 14:30    | CLEAR     | no       |
| Design Review   |  0   | —                   | —         | no       |
+--------------------------------------------------------------------+
| VERDICT: CLEARED — Eng Review passed                                |
+====================================================================+
```

Eng Review is the only required gate (disable with `gstack-config set skip_eng_review true`). CEO and Design are informational — recommended for product and UI changes respectively.

### Plan-to-QA flow

When `/plan-eng-review` finishes the test review section, it writes a test plan artifact to `~/.gstack/projects/`. When you later run `/qa`, it picks up that test plan automatically — your engineering review feeds directly into QA testing with no manual copy-paste.

---

## `/plan-design-review`

This is my **senior designer reviewing your plan** — before you write a single line of code.

Most plans describe what the backend does but never specify what the user actually sees. Empty states? Error states? Loading states? Mobile layout? AI slop risk? These decisions get deferred to "figure it out during implementation" — and then an engineer ships "No items found." as the empty state because nobody specified anything better.

`/plan-design-review` catches all of this during planning, when it's cheap to fix.

It works like `/plan-ceo-review` and `/plan-eng-review` — interactive, one issue at a time, with the **STOP + AskUserQuestion** pattern. It rates each design dimension 0-10, explains what a 10 looks like, then edits the plan to get there. The rating drives the work: rate low = lots of fixes, rate high = quick pass.

Seven passes over the plan: information architecture, interaction state coverage, user journey, AI slop risk, design system alignment, responsive/accessibility, and unresolved design decisions. For each pass, it finds gaps and either fixes them directly (obvious ones) or asks you to make a design choice (genuine tradeoffs).

### Example

```
You:   /plan-design-review

Claude: Initial Design Rating: 4/10

        "This plan describes a user dashboard but never specifies
         what the user sees first. It says 'cards with icons' —
         which looks like every SaaS template. It mentions zero
         loading states, zero empty states, and no mobile behavior."

        Pass 1 (Info Architecture): 3/10
        "A 10 would define primary/secondary/tertiary content
         hierarchy for every screen."
        → Added information hierarchy section to plan

        Pass 2 (Interaction States): 2/10
        "The plan has 4 UI features but specifies 0 out of 20
         interaction states (4 features × 5 states each)."
        → Added interaction state table to plan

        Pass 4 (AI Slop): 4/10
        "The plan says 'clean, modern UI with cards and icons'
         and 'hero section with gradient'. These are the top 2
         AI-generated-looking patterns."
        → Rewrote UI descriptions with specific, intentional alternatives

        Overall: 4/10 → 8/10 after fixes
        "Plan is design-complete. Run /design-review after
         implementation for visual QA."
```

When you re-run it, sections already at 8+ get a quick pass. Sections below 8 get full treatment. For live-site visual audits post-implementation, use `/design-review`.

---

## `/design-consultation`

This is my **design partner mode**.

`/plan-design-review` audits a site that already exists. `/design-consultation` is for when you have nothing yet — no design system, no font choices, no color palette. You are starting from zero and you want a senior designer to sit down with you and build the whole visual identity together.

It is a conversation, not a form. The agent asks about your product, your users, and your audience. It thinks about what your product needs to communicate — trust, speed, craft, warmth, whatever fits — and works backward from that to concrete choices. Then it proposes a complete, coherent design system: aesthetic direction, typography (3+ fonts with specific roles), color palette with hex values, spacing scale, layout approach, and motion strategy. Every recommendation comes with a rationale. Every choice reinforces every other choice.

But coherence is table stakes. Every dev tool dashboard looks the same — clean sans-serif, muted grays, a blue accent. They are all coherent. They are all forgettable. The difference between a product that looks "nice" and one that people actually recognize is the **deliberate creative risks**: the unexpected serif for headings, the bold accent nobody else in your category uses, the tighter spacing that makes your data feel authoritative instead of airy.

That is what `/design-consultation` is really about. It does not just propose a safe system. It proposes safe choices AND risks — and tells you which is which. "Here are the choices that keep you literate in your category. And here is where I think you should break from convention, and why." You pick which risks to take. The agent checks that the whole system still coheres either way.

If you want, the agent will research what's already out there in your space — take screenshots of real sites, analyze their fonts and colors and spacing — so you can see the landscape before you make choices. This is not about copying. It is about getting in the ballpark so you know what the conventions are, and then deciding which ones are worth breaking.

After you agree on the system, it generates an interactive HTML preview page — not just swatches and font samples, but realistic product pages. If you are building a dashboard, you see a dashboard with a sidebar, data tables, and stat cards. If you are building a marketing site, you see a hero section with real copy and a CTA. Everything rendered in your design system, with your product name, in light and dark mode. You see what your product could feel like before a single line of production code is written.

Then it writes `DESIGN.md` to your repo root — your project's design source of truth — and updates `CLAUDE.md` so every future Claude Code session respects the system. From that point on, `/design-review` can audit against it, and any agent working on your frontend knows the rules.

### Example

```
You:   /design-consultation

Claude: From the README, this looks like a developer analytics dashboard
        for engineering teams. Sound right? Tell me about the feeling
        you want — and would you like me to look at what's out there
        first so we can see the landscape?

You:    Yes, it's for eng managers. Show me what's out there.

Claude: [browses Linear, Vercel, Datadog, Posthog — takes screenshots]

        Here's the landscape. They all converge on clean sans-serifs
        and muted blue-gray palettes. Linear stands out with dark-first
        and tight spacing. The rest feel interchangeable.

        Here's my proposal — and where I'd play it safe vs. take risks:

        AESTHETIC: Industrial/Utilitarian — data-first, every pixel earns its place
        TYPOGRAPHY: Geist (body + UI), Instrument Serif (display), JetBrains Mono (data)
        COLOR: Restrained — slate neutrals, single teal accent (#0D9488)
        SPACING: 4px base, compact density
        LAYOUT: Grid-disciplined, 12-column
        MOTION: Minimal-functional — only transitions that aid comprehension

        SAFE CHOICES (match category expectations):
          Geist for body — your users already know this font from Vercel
          Slate neutrals — warm grays feel right for data-heavy UIs
          Grid-disciplined layout — dashboards need predictable alignment

        RISKS (where you'd stand out):
          Instrument Serif for display headings — nobody in dev tools
            uses a serif. It creates instant hierarchy contrast and
            signals "we care about craft" in a space full of sans-serifs.
          Single teal accent instead of blue — everyone else in this space uses blue.
            Teal is close enough to feel trustworthy, different enough
            to be recognizable.
          4px compact density — tighter than Linear, says "we respect
            your screen real estate."

        The safe choices keep you literate. The risks are where your
        product gets its own face. Which risks appeal to you?

You:    Love the serif risk. Let's see it.

Claude: Preview opened in your browser.
        [/tmp/design-consultation-preview-1710000000.html]

        The page shows a realistic dashboard: sidebar nav, header with
        avatar, stat cards, data table — all in your design system.
        Instrument Serif at hero scale, Geist in body text, JetBrains
        Mono in the data table. Teal accent on buttons and active states.
        Light and dark mode toggle in the corner.

        How does it feel? Want to adjust anything before I write DESIGN.md?

You:    Ship it.

Claude: Wrote DESIGN.md (typography, color, spacing, layout, motion).
        Updated CLAUDE.md with design system guidelines.
        All future sessions will respect these choices.
```

---

## `/design-review`

This is my **designer who codes mode**.

`/plan-design-review` reviews your plan before implementation. `/design-review` audits and fixes the live site after.

It runs an 80-item visual audit on your live site, then enters a fix loop: for each design finding, it locates the source file, makes the minimal CSS/styling change, commits with `style(design): FINDING-NNN`, re-navigates to verify, and takes before/after screenshots. One commit per fix, fully bisectable.

The self-regulation heuristic is tuned for design work — CSS-only changes get a free pass (they are inherently safe and reversible), but changes to component JSX/TSX files count against the risk budget. Hard cap at 30 fixes. If the risk score exceeds 20%, it stops and asks.

### Example

```
You:   /design-review https://myapp.com

Claude: [Runs full 80-item visual audit on the live site]
        Design Score: C  |  AI Slop Score: D
        12 findings (4 high, 5 medium, 3 polish)

        Fixing 9 design issues...

        style(design): FINDING-001 — replace 3-column icon grid with asymmetric layout
        style(design): FINDING-002 — add heading scale 48/32/24/18/16
        style(design): FINDING-003 — remove gradient hero, use bold typography
        style(design): FINDING-004 — add second font for headings
        style(design): FINDING-005 — vary border-radius by element role
        style(design): FINDING-006 — left-align body text, reserve center for headings
        style(design): FINDING-007 — add hover/focus states to all interactive elements
        style(design): FINDING-008 — add prefers-reduced-motion media query
        style(design): FINDING-009 — set max content width to 680px for body text

        Final audit:
        Design Score: C → B+  |  AI Slop Score: D → A
        9 fixes applied (8 verified, 1 best-effort). 3 deferred.

        [Report with before/after screenshots saved to .gstack/design-reports/]
```

Nine commits, each touching one concern. The AI Slop score went from D to A because the three most recognizable patterns (gradient hero, 3-column grid, uniform radius) are gone.

---

## `/design-shotgun`

This is my **design exploration mode**.

You know the feeling. You have a feature, a page, a landing screen... and you're not sure what it should look like. You could describe it to Claude and get one answer. But one answer means one perspective, and design is a taste game. You need to see options.

`/design-shotgun` generates 3 visual design variants using the GPT Image API, opens a comparison board in your browser, and waits for your feedback. You pick a direction, request changes, or ask for entirely new variants. The board supports remix, regenerate, and approval actions.

### The loop

1. You describe what you want (or point at an existing page)
2. The skill reads your `DESIGN.md` for brand constraints (if it exists)
3. It generates 3 distinct design variants as PNGs
4. A comparison board opens in your browser with all 3 side-by-side
5. You click "Approve" on the one you like, or give feedback for another round
6. The approved variant saves to `~/.gstack/projects/$SLUG/designs/` with an `approved.json`

That `approved.json` is one way to feed `/design-html`. The design pipeline chains: shotgun picks the direction, design-html renders it as working code. But `/design-html` also works with CEO plans, design reviews, or just a description.

### Taste memory

The skill remembers your preferences across sessions. If you consistently prefer minimal designs over busy ones, it biases future generations. This isn't a setting you configure... it emerges from your approvals.

### Example

```
You:   /design-shotgun — hero section for a developer tools landing page

Claude: [Generates 3 variants]
        Variant A: Bold typography, dark background, code snippet hero
        Variant B: Split layout, product screenshot left, copy right
        Variant C: Minimal, centered headline, gradient accent

        [Opens comparison board at localhost:PORT]

You:    [Clicks "Approve" on Variant A in the browser]

Claude: Approved Variant A. Saved to ~/.gstack/projects/myapp/designs/
        Next: run /design-html to generate production HTML from this mockup.
```

---

## `/design-html`

This is my **design-to-code mode**.

Every AI code generation tool produces static CSS. Hardcoded heights. Text that overflows on resize. Breakpoints that snap instead of flowing. The output looks right at exactly one viewport size and breaks at every other.

`/design-html` fixes this. It generates HTML using [Pretext](https://github.com/chenglou/pretext) by Cheng Lou (ex-React core, Midjourney frontend). Pretext is a 15KB library that computes text layout without DOM measurement. Text reflows. Heights adjust to content. Cards size themselves. Chat bubbles shrinkwrap. All sub-millisecond, all dynamic.

It works with multiple input sources: an approved mockup from `/design-shotgun`, a CEO plan from `/plan-ceo-review`, design review context from `/plan-design-review`, a PNG you provide, or just a description of what you want. It detects what context exists and asks how you want to proceed.

### Smart API routing

Not every page needs the full Pretext engine. The skill reads the design and picks the right tools:

- **Simple layouts** (landing, marketing): `prepare()` + `layout()` for resize-aware heights
- **Card grids** (dashboard, listing): `prepare()` + `layout()` for self-sizing cards
- **Chat UIs**: `walkLineRanges()` for tight-fit bubbles with zero wasted pixels
- **Editorial layouts**: `layoutNextLine()` for text flowing around obstacles
- **Complex editorial**: Full engine with `layoutWithLines()` for manual line rendering

### The refinement loop

1. Reads the approved mockup from `approved.json`
2. Uses GPT-4o vision to extract implementation spec (colors, typography, layout)
3. Generates self-contained HTML with Pretext inlined (15KB, zero network dependency)
4. Spins up a live-reload server so you see changes instantly
5. Screenshots at 3 viewports (mobile, tablet, desktop) to verify layout
6. AskUserQuestion: what needs to change?
7. Surgical edits via the Edit tool (not full regeneration)
8. Repeat until you say "done"

### Framework detection

If your project uses React, Svelte, or Vue (detected from `package.json`), the skill offers to generate a framework component instead of vanilla HTML. Framework output uses `npm install @chenglou/pretext` instead of inline vendoring.

### Example

```
You:   /design-html

Claude: Found approved mockup: variant-A.png (hero section)
        Design type: simple layout → using prepare() + layout()

        [Generates HTML with Pretext, opens live-reload server]
        [Screenshots at 375px, 768px, 1440px — all verified]

        The HTML is live at localhost:3456. Resize your browser.
        Text reflows dynamically. What needs to change?

You:    Make the headline bigger and add more spacing below the CTA

Claude: [Edits font-size and margin, browser auto-reloads]
        Updated. Two changes applied.

You:    Done

Claude: Saved to ~/.gstack/projects/myapp/designs/hero-20260330/finalized.html
```

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
* forgotten enum handlers — add a new status or type constant, and `/review` traces it through every switch statement and allowlist in your codebase, not just the files you changed

### Fix-First

Findings get action, not just listed. Obvious mechanical fixes (dead code, stale comments, N+1 queries) are applied automatically — you see `[AUTO-FIXED] file:line Problem → what was done` for each one. Genuinely ambiguous issues (security, race conditions, design decisions) get surfaced for your call.

### Completeness gaps

`/review` now flags shortcut implementations where the complete version costs less than 30 minutes of CC time. If you chose the 80% solution and the 100% solution is a lake, not an ocean, the review will call it out.

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

## `/investigate`

When something is broken and you don't know why, `/investigate` is your systematic debugger. It follows the Iron Law: **no fixes without root cause investigation first.**

Instead of guessing and patching, it traces data flow, matches against known bug patterns, and tests hypotheses one at a time. If three fix attempts fail, it stops and questions the architecture instead of thrashing. This prevents the "let me try one more thing" spiral that wastes hours.

---

## `/qa`

This is my **QA lead mode**.

`/browse` gives the agent eyes. `/qa` gives it a testing methodology.

The most common use case: you're on a feature branch, you just finished coding, and you want to verify everything works. Just say `/qa` — it reads your git diff, identifies which pages and routes your changes affect, spins up the browser, and tests each one. No URL required. No manual test plan.

Four modes:

- **Diff-aware** (automatic on feature branches) — reads `git diff main`, identifies affected pages, tests them specifically
- **Full** — systematic exploration of the entire app. 5-15 minutes. Documents 5-10 well-evidenced issues.
- **Quick** (`--quick`) — 30-second smoke test. Homepage + top 5 nav targets.
- **Regression** (`--regression baseline.json`) — run full mode, then diff against a previous baseline.

### Automatic regression tests

When `/qa` fixes a bug and verifies it, it automatically generates a regression test that catches the exact scenario that broke. Tests include full attribution tracing back to the QA report.

### Example

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

**Testing authenticated pages:** Use `/setup-browser-cookies` first to import your real browser sessions, then `/qa` can test pages behind login.

---

## `/ship`

This is my **release machine mode**.

Once I have decided what to build, nailed the technical plan, and run a serious review, I do not want more talking. I want execution.

`/ship` is for the final mile. It is for a ready branch, not for deciding what to build.

This is where the model should stop behaving like a brainstorm partner and start behaving like a disciplined release engineer: sync with main, run the right tests, make sure the branch state is sane, update changelog or versioning if the repo expects it, push, and create or update the PR.

### Test bootstrap

If your project doesn't have a test framework, `/ship` sets one up — detects your runtime, researches the best framework, installs it, writes 3-5 real tests for your actual code, sets up CI/CD (GitHub Actions), and creates TESTING.md. 100% test coverage is the goal — tests make vibe coding safe instead of yolo coding.

### Coverage audit

Every `/ship` run builds a code path map from your diff, searches for corresponding tests, and produces an ASCII coverage diagram with quality stars. Gaps get tests auto-generated. Your PR body shows the coverage: `Tests: 42 → 47 (+5 new)`.

### Review gate

`/ship` checks the [Review Readiness Dashboard](#review-readiness-dashboard) before creating the PR. If the Eng Review is missing, it asks — but won't block you. Decisions are saved per-branch so you're never re-asked.

A lot of branches die when the interesting work is done and only the boring release work is left. Humans procrastinate that part. AI should not.

---

## `/land-and-deploy`

This is my **deploy pipeline mode**.

`/ship` creates the PR. `/land-and-deploy` finishes the job: merge, deploy, verify.

It merges the PR, waits for CI, waits for the deploy to finish, then runs canary checks against production. One command from "approved" to "verified in production." If the deploy breaks, it tells you what failed and whether to rollback.

First run on a new project triggers a dry-run walk-through so you can verify the pipeline before it does anything irreversible. After that, it trusts the config and runs straight through.

### Setup

Run `/setup-deploy` first. It detects your platform (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions, or custom), discovers your production URL and health check endpoints, and writes the config to CLAUDE.md. One-time, 60 seconds.

### Example

```
You:   /land-and-deploy

Claude: Merging PR #42...
        CI: 3/3 checks passed
        Deploy: Fly.io — deploying v2.1.0...
        Health check: https://myapp.fly.dev/health → 200 OK
        Canary: 5 pages checked, 0 console errors, p95 < 800ms

        Production verified. v2.1.0 is live.
```

---

## `/canary`

This is my **post-deploy monitoring mode**.

After deploy, `/canary` watches the live site for trouble. It loops through your key pages using the browse daemon, checking for console errors, performance regressions, page failures, and visual anomalies. Takes periodic screenshots and compares against pre-deploy baselines.

Use it right after `/land-and-deploy`, or schedule it to run periodically after a risky deploy.

```
You:   /canary https://myapp.com

Claude: Monitoring 8 pages every 2 minutes...

        Cycle 1: ✓ All pages healthy. p95: 340ms. 0 console errors.
        Cycle 2: ✓ All pages healthy. p95: 380ms. 0 console errors.
        Cycle 3: ⚠ /dashboard — new console error: "TypeError: Cannot read
                   property 'map' of undefined" at dashboard.js:142
                 Screenshot saved.

        Alert: 1 new console error after 3 monitoring cycles.
```

---

## `/benchmark`

This is my **performance engineer mode**.

`/benchmark` establishes performance baselines for your pages: load time, Core Web Vitals (LCP, CLS, INP), resource counts, and total transfer size. Run it before and after a PR to catch regressions.

It uses the browse daemon for real Chromium measurements, not synthetic estimates. Multiple runs averaged. Results persist so you can track trends across PRs.

```
You:   /benchmark https://myapp.com

Claude: Benchmarking 5 pages (3 runs each)...

        /           load: 1.2s  LCP: 0.9s  CLS: 0.01  resources: 24 (890KB)
        /dashboard  load: 2.1s  LCP: 1.8s  CLS: 0.03  resources: 31 (1.4MB)
        /settings   load: 0.8s  LCP: 0.6s  CLS: 0.00  resources: 18 (420KB)

        Baseline saved. Run again after changes to compare.
```

---

## `/cso`

This is my **Chief Security Officer**.

Run `/cso` on any codebase and it performs an OWASP Top 10 + STRIDE threat model audit. It scans for injection vulnerabilities, broken authentication, sensitive data exposure, XML external entities, broken access control, security misconfiguration, XSS, insecure deserialization, known-vulnerable components, and insufficient logging. Each finding includes severity, evidence, and a recommended fix.

```
You:   /cso

Claude: Running OWASP Top 10 + STRIDE security audit...

        CRITICAL: SQL injection in user search (app/models/user.rb:47)
        HIGH: Session tokens stored in localStorage (app/frontend/auth.ts:12)
        MEDIUM: Missing rate limiting on /api/login endpoint
        LOW: X-Frame-Options header not set

        4 findings across 12 files scanned. 1 critical, 1 high.
```

---

## `/document-release`

This is my **technical writer mode**.

After `/ship` creates the PR but before it merges, `/document-release` reads every documentation file in the project and cross-references it against the diff. It updates file paths, command lists, project structure trees, and anything else that drifted. Risky or subjective changes get surfaced as questions — everything else is handled automatically.

```
You:   /document-release

Claude: Analyzing 21 files changed across 3 commits. Found 8 documentation files.

        README.md: updated skill count from 9 to 10, added new skill to table
        CLAUDE.md: added new directory to project structure
        CONTRIBUTING.md: current — no changes needed
        TODOS.md: marked 2 items complete, added 1 new item

        All docs updated and committed. PR body updated with doc diff.
```

It also polishes CHANGELOG voice (without ever overwriting entries), cleans up completed TODOS, checks cross-doc consistency, and asks about VERSION bumps only when appropriate.

---

## `/retro`

This is my **engineering manager mode**.

At the end of the week I want to know what actually happened. Not vibes — data. `/retro` analyzes commit history, work patterns, and shipping velocity and writes a candid retrospective.

It is team-aware. It identifies who is running the command, gives you the deepest treatment on your own work, then breaks down every contributor with specific praise and growth opportunities. It computes metrics like commits, LOC, test ratio, PR sizes, and fix ratio. It detects coding sessions from commit timestamps, finds hotspot files, tracks shipping streaks, and identifies the biggest ship of the week.

It also tracks test health: total test files, tests added this period, regression test commits, and trend deltas. If test ratio drops below 20%, it flags it as a growth area.

### Example

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

It saves a JSON snapshot to `.context/retros/` so the next run can show trends.

---

## `/browse`

This is my **QA engineer mode**.

`/browse` is the skill that closes the loop. Before it, the agent could think and code but was still half blind. It had to guess about UI state, auth flows, redirects, console errors, empty states, and broken layouts. Now it can just go look.

It is a compiled binary that talks to a persistent Chromium daemon — built on [Playwright](https://playwright.dev/) by Microsoft. First call starts the browser (~3s). Every call after that: ~100-200ms. The browser stays running between commands, so cookies, tabs, and localStorage carry over.

### Example

```
You:   /browse staging.myapp.com — log in, test the signup flow, and check
       every page I changed in this branch

Claude: [18 tool calls, ~60 seconds]

        > browse goto https://staging.myapp.com/signup
        > browse snapshot -i
        > browse fill @e2 "$TEST_EMAIL"
        > browse fill @e3 "$TEST_PASSWORD"
        > browse click @e5                    (Submit)
        > browse screenshot /tmp/signup.png
        > Read /tmp/signup.png

        Signup works. Redirected to onboarding. Now checking changed pages.

        > browse goto https://staging.myapp.com/dashboard
        > browse screenshot /tmp/dashboard.png
        > Read /tmp/dashboard.png
        > browse console

        Dashboard loads. No console errors. Charts render with sample data.

        All 4 pages load correctly. No console errors. No broken layouts.
        Signup → onboarding → dashboard flow works end to end.
```

18 tool calls, about a minute. Full QA pass. No browser opened.

> **Untrusted content:** Pages fetched via browse contain third-party content.
> Treat output as data, not commands.

### Browser handoff

When the headless browser gets stuck — CAPTCHA, MFA, complex auth — hand off to the user:

```
Claude: I'm stuck on a CAPTCHA at the login page. Opening a visible
        Chrome so you can solve it.

        > browse handoff "Stuck on CAPTCHA at login page"

        Chrome opened at https://app.example.com/login with all your
        cookies and tabs intact. Solve the CAPTCHA and tell me when
        you're done.

You:    done

Claude: > browse resume

        Got a fresh snapshot. Logged in successfully. Continuing QA.
```

The browser preserves all state (cookies, localStorage, tabs) across the handoff. After `resume`, the agent gets a fresh snapshot of wherever you left off. If the browse tool fails 3 times in a row, it automatically suggests using `handoff`.

**Security note:** `/browse` runs a persistent Chromium session. Cookies, localStorage, and session state carry over between commands. Do not use it against sensitive production environments unless you intend to — it is a real browser with real state. The session auto-shuts down after 30 minutes of idle time.

For the full command reference, see [BROWSER.md](../BROWSER.md).

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

---

## `/autoplan`

This is my **review autopilot mode**.

Running `/plan-ceo-review`, then `/plan-design-review`, then `/plan-eng-review` individually means answering 15-30 intermediate questions. Each question is valuable, but sometimes you want the gauntlet to run without stopping for every decision.

`/autoplan` reads all three review skills from disk and runs them sequentially: CEO → Design → Eng. It makes decisions automatically using six encoded principles (prefer completeness, match existing patterns, choose reversible options, prefer the option the user chose for similar past decisions, defer ambiguous items, and escalate security). Taste decisions (close approaches, borderline scope expansions, cross-model disagreements) get saved and presented at a final approval gate.

One command, fully reviewed plan out.

```
You:   /autoplan

Claude: Running CEO review... [4 scope decisions auto-resolved]
        Running design review... [3 design dimensions auto-scored]
        Running eng review... [2 architecture decisions auto-resolved]

        TASTE DECISIONS (need your input):
        1. Scope: Codex suggested adding search — borderline expansion. Add?
        2. Design: Two approaches scored within 1 point. Which feels right?

        [Shows both options with context]

You:    1) Yes, add search. 2) Option A.

Claude: Plan complete. 9 decisions auto-resolved, 2 taste decisions approved.
```

---

## `/learn`

This is my **institutional memory mode**.

gstack learns from every session. Patterns, pitfalls, preferences, architectural decisions... they accumulate in `~/.gstack/projects/$SLUG/learnings.jsonl`. Each learning has a confidence score, source attribution, and the files it references.

`/learn` lets you see what gstack has absorbed, search for specific patterns, prune stale entries (when referenced files no longer exist), and export learnings for team sharing. The real magic is in other skills... they automatically search learnings before making recommendations, and display "Prior learning applied" when a past insight is relevant.

```
You:   /learn

Claude: 23 learnings for this project (14 high confidence, 6 medium, 3 low)

        Top patterns:
        - [9/10] API responses always wrapped in { data, error } envelope
        - [8/10] Tests use factory helpers in test/support/factories.ts
        - [8/10] All DB queries go through repository pattern, never direct

        3 potentially stale (referenced files deleted):
        - "auth middleware uses JWT" — auth/middleware.ts was deleted
        [Prune these? Y/N]
```

---

## `/open-gstack-browser`

This is my **co-presence mode**.

`/browse` runs headless by default. You don't see what the agent sees. `/open-gstack-browser` changes that. It launches GStack Browser (rebranded Chromium with anti-bot stealth) controlled by Playwright, with the sidebar extension auto-loaded. You watch every action in real time.

The sidebar chat is a Claude instance that controls the browser. It auto-routes to the right model: Sonnet for navigation and actions (click, goto, fill, screenshot), Opus for reading and analysis (summarize, find bugs, describe). One-click cookie import from the sidebar footer. The browser stays alive as long as the window is open... no idle timeout in headed mode. The menu bar says "GStack Browser" instead of "Chrome for Testing."

The sidebar agent ships a layered prompt injection defense: a local 22MB ML classifier scans every page and tool output, a Haiku transcript check votes on the full conversation, a canary token catches session-exfil attempts, and a verdict combiner requires two classifiers to agree before blocking. A shield icon in the header shows status (green/amber/red). Details in [ARCHITECTURE.md](../ARCHITECTURE.md#prompt-injection-defense-sidebar-agent).

```
You:   /open-gstack-browser

Claude: Launched GStack Browser with sidebar extension.
        Anti-bot stealth active. All $B commands run in headed mode.
        Type in the sidebar to direct the browser agent.
        Sidebar model routing: sonnet for actions, opus for analysis.
```

---

## `/setup-deploy`

One-time deploy configuration. Run this before your first `/land-and-deploy`.

It auto-detects your deploy platform (Fly.io, Render, Vercel, Netlify, Heroku, GitHub Actions, or custom), discovers your production URL, health check endpoints, and deploy status commands. Writes everything to CLAUDE.md so all future deploys are automatic.

```
You:   /setup-deploy

Claude: Detected: Fly.io (fly.toml found)
        Production URL: https://myapp.fly.dev
        Health check: /health → expects 200
        Deploy command: fly deploy
        Status command: fly status

        Written to CLAUDE.md. Run /land-and-deploy when ready.
```

---

## `/codex`

This is my **second opinion mode**.

When `/review` catches bugs from Claude's perspective, `/codex` brings a completely different AI — OpenAI's Codex CLI — to review the same diff. Different training, different blind spots, different strengths. The overlap tells you what's definitely real. The unique findings from each are where you find the bugs neither would catch alone.

### Three modes

**Review** — run `codex review` against the current diff. Codex reads every changed file, classifies findings by severity (P1 critical, P2 high, P3 medium), and returns a PASS/FAIL verdict. Any P1 finding = FAIL. The review is fully independent — Codex doesn't see Claude's review.

**Challenge** — adversarial mode. Codex actively tries to break your code. It looks for edge cases, race conditions, security holes, and assumptions that would fail under load. Uses maximum reasoning effort (`xhigh`). Think of it as a penetration test for your logic.

**Consult** — open conversation with session continuity. Ask Codex anything about the codebase. Follow-up questions reuse the same session, so context carries over. Great for "am I thinking about this correctly?" moments.

### Cross-model analysis

When both `/review` (Claude) and `/codex` (OpenAI) have reviewed the same branch, you get a cross-model comparison: which findings overlap (high confidence), which are unique to Codex (different perspective), and which are unique to Claude. This is the "two doctors, same patient" approach to code review.

```
You:   /codex review

Claude: Running independent Codex review...

        CODEX REVIEW: PASS (3 findings)
        [P2] Race condition in payment handler — concurrent charges
             can double-debit without advisory lock
        [P3] Missing null check on user.email before downcase
        [P3] Token comparison not using constant-time compare

        Cross-model analysis (vs /review):
        OVERLAP: Race condition in payment handler (both caught it)
        UNIQUE TO CODEX: Token comparison timing attack
        UNIQUE TO CLAUDE: N+1 query in listing photos
```

---

## Safety & Guardrails

Four skills that add safety rails to any Claude Code session. They work via Claude Code's PreToolUse hooks — transparent, session-scoped, no configuration files.

### `/careful`

Say "be careful" or run `/careful` when you're working near production, running destructive commands, or just want a safety net. Every Bash command gets checked against known-dangerous patterns:

- `rm -rf` / `rm -r` — recursive delete
- `DROP TABLE` / `DROP DATABASE` / `TRUNCATE` — data loss
- `git push --force` / `git push -f` — history rewrite
- `git reset --hard` — discard commits
- `git checkout .` / `git restore .` — discard uncommitted work
- `kubectl delete` — production resource deletion
- `docker rm -f` / `docker system prune` — container/image loss

Common build artifact cleanups (`rm -rf node_modules`, `dist`, `.next`, `__pycache__`, `build`, `coverage`) are whitelisted — no false alarms on routine operations.

You can override any warning. The guardrails are accident prevention, not access control.

### `/freeze`

Restrict all file edits to a single directory. When you're debugging a billing bug, you don't want Claude accidentally "fixing" unrelated code in `src/auth/`. `/freeze src/billing` blocks all Edit and Write operations outside that path.

`/investigate` activates this automatically — it detects the module being debugged and freezes edits to that directory.

```
You:   /freeze src/billing

Claude: Edits restricted to src/billing/. Run /unfreeze to remove.

        [Later, Claude tries to edit src/auth/middleware.ts]

Claude: BLOCKED — Edit outside freeze boundary (src/billing/).
        Skipping this change.
```

Note: this blocks Edit and Write tools only. Bash commands like `sed` can still modify files outside the boundary — it's accident prevention, not a security sandbox.

### `/guard`

Full safety mode — combines `/careful` + `/freeze` in one command. Destructive command warnings plus directory-scoped edits. Use when touching prod or debugging live systems.

### `/unfreeze`

Remove the `/freeze` boundary, allowing edits everywhere again. The hooks stay registered for the session — they just allow everything. Run `/freeze` again to set a new boundary.

---

## `/gstack-upgrade`

Keep gstack current with one command. It detects your install type (global at `~/.claude/skills/gstack` vs vendored in your project at `.claude/skills/gstack`), runs the upgrade, syncs both copies if you have dual installs, and shows you what changed.

```
You:   /gstack-upgrade

Claude: Current version: 0.7.4
        Latest version: 0.8.2

        What's new:
        - Browse handoff for CAPTCHAs and auth walls
        - /codex multi-AI second opinion
        - /qa always uses browser now
        - Safety skills: /careful, /freeze, /guard
        - Proactive skill suggestions

        Upgraded to 0.8.2. Both global and project installs synced.
```

Set `auto_upgrade: true` in `~/.gstack/config.yaml` to skip the prompt entirely — gstack upgrades silently at the start of each session when a new version is available.

---

## Greptile integration

[Greptile](https://greptile.com) is a YC company that reviews your PRs automatically. It catches real bugs — race conditions, security issues, things that pass CI and blow up in production. It has genuinely saved my ass more than once. I love these guys.

### Setup

Install Greptile on your GitHub repo at [greptile.com](https://greptile.com) — it takes about 30 seconds. Once it's reviewing your PRs, gstack picks up its comments automatically. No additional configuration.

### How it works

The problem with any automated reviewer is triage. Greptile is good, but not every comment is a real issue. Some are false positives. Some flag things you already fixed three commits ago. Without a triage layer, the comments pile up and you start ignoring them — which defeats the purpose.

gstack solves this. `/review` and `/ship` are now Greptile-aware. They read Greptile's comments, classify each one, and take action:

- **Valid issues** get added to the critical findings and fixed before shipping
- **Already-fixed issues** get an auto-reply acknowledging the catch
- **False positives** get pushed back — you confirm, and a reply goes out explaining why it's wrong

The result is a two-layer review: Greptile catches things asynchronously on the PR, then `/review` and `/ship` triage those findings as part of the normal workflow. Nothing falls through the cracks.

### Learning from history

Every false positive you confirm gets saved to `~/.gstack/greptile-history.md`. Future runs auto-skip known FP patterns for your codebase. And `/retro` tracks Greptile's batting average over time — so you can see whether the signal-to-noise ratio is improving.

### Example

```
You:   /ship

Claude: [syncs main, runs tests, pre-landing review...]

        Greptile found 3 comments on this PR:

        [VALID] app/services/payment_service.rb:47 — Race condition:
        concurrent charges can double-debit. Recommend DB-level advisory
        lock around the charge block.

        [ALREADY FIXED] app/models/user.rb:12 — Missing null check
        on email before downcase.
        → Already fixed in commit abc1234. Auto-replying.

        [FALSE POSITIVE] lib/auth.rb:88 — "Token comparison should
        use constant-time comparison." We already use
        ActiveSupport::SecurityUtils.secure_compare here.

        Fixing the race condition in payment_service.rb...

        The auth token comment is a false positive.
        Options: A) Reply to Greptile explaining  B) Fix anyway  C) Ignore

You:    A

Claude: Replied to Greptile. All tests pass.
        PR: github.com/you/app/pull/42
```

Three Greptile comments. One real fix. One auto-acknowledged. One false positive pushed back with a reply. Total extra time: about 30 seconds.
