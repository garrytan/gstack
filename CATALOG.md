# GPN Skillz — Skill Catalog

> **84 skills** across 8 workflow tiers + standalone utilities + meta-tools.
> Skills live in flat directories — this catalog is the logical map.
> For guided journeys through multiple skills, use **`/flow`**.

---

## How to Navigate This

**Starting something new?** → `/flow` — picks the right journey for your context.
**Know exactly what you need?** → Jump directly to the skill below.
**Debugging something?** → `/investigate` directly.
**Just thinking out loud?** → `/braindump` directly.

---

## Tier 1 — DISCOVER
> *Generate ideas, understand the market, talk to users before you build.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/braindump`](braindump/SKILL.md) | Zero-judgment idea capture. Best-friend-at-a-bar listener. Structures raw thinking into `.md` files. End-of-day digest. | You have 10 half-formed ideas and want to capture them fast |
| [`/spark`](spark/SKILL.md) | Post-brainstorm pattern & gap detector. Reads today's braindumps, spots recurring themes, blind spots, and unexplored angles, then prompts with provocative "what about..." suggestions. Personal assistant energy. | You've braindumped 3+ ideas and want to know what you're missing |
| [`/idea-capture`](idea-capture/SKILL.md) | Captures pre-requirement product ideas into a configured Git repo as the source of truth. Title, problem, value/why-now, tags, status. Promotes ideas directly into PDLC Phase A. | You have a rough idea or concept that isn't a formal requirement yet and want to log it for future PDLC entry |
| [`/office-hours`](office-hours/SKILL.md) | Structured ideation partner. Startup mode (6 hard questions) or Builder mode (enthusiastic collaborator). Saves a design doc. | You have an idea and want to think it through before committing |
| [`/customer-research`](customer-research/SKILL.md) | Plan and synthesise customer research. Defines learning goals, picks the right method, structures findings. | You need to validate demand before building |
| [`/customer-lens`](customer-lens/SKILL.md) | Activates a customer or stakeholder persona (developer, merchant, security buyer, exec, custom) to pressure-test ideas and specs. Flags what needs real-user validation. | You want to stress-test a feature, spec, or idea from an outsider's perspective before building or shipping |
| [`/platform-discovery`](platform-discovery/SKILL.md) | Structured intake for validating AI platform use cases with internal product teams. 3-phase cycle: prep, 45-min discovery call, 48-hr follow-up. Outputs team profile, use case registry entries, cross-team pattern synthesis. | Onboarding a product team to a shared AI platform, building a demand-driven adoption pipeline |
| [`/competitor-teardowns`](competitor-teardowns/SKILL.md) | Competitive intelligence. Teardowns, SWOT, battle cards, pricing intel, job posting signals. GP product vs. competitor product mapping. | Prepping for strategy, QBR, sales pitch, or competitor just launched something |
| [`/team-brainstorm`](team-brainstorm/SKILL.md) | Multiplayer braindump with shared intelligence. Team members capture ideas individually; agent deduplicates, cross-pollinates, provides constructive critique, and generates team synthesis reports. | Team ideation — async, parallel, no groupthink |
| [`/toolstack`](toolstack/SKILL.md) | Approved tool stack discovery & policy browser. Points at repos, registries, or data stores and reports what tools are available, what's approved, and how to get access. Scans for unapproved usage. | You want to know what tools are approved, or check a repo against policy |
| [`/vendor-eval`](vendor-eval/SKILL.md) | Vendor/product evaluation for internal procurement. Structured comparison of 2+ products — capability fit, TCO, governance risk, switching costs. Produces a one-pager decision memo. | Comparing vendors or products for internal use — not competitor analysis |
| [`/ai-guides`](ai-guides/SKILL.md) | How-to guide library for AI capabilities. Standing up MCPs, building skills, RAG pipelines, Vertex AI agents. Quickstart (5 min) and deep-dive (30 min) modes with interactive step verification. | You want to build an AI capability and need a hands-on guide |

---

## Tier 2 — STRATEGIZE
> *Is this worth building? What exactly? In what order?*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/plan-ceo-review`](plan-ceo-review/SKILL.md) | CEO/founder-mode review. Challenges premises, finds the 10-star product, expands scope when it creates a better product. | You have a plan and want to pressure-test ambition before locking it |
| [`/product-manager`](product-manager/SKILL.md) | Voice of the customer. Rigorous PM review — customer problem first, trade-offs, prioritisation, fundamentals. | You need a PM lens on a plan: what should we actually build and why |
| [`/business-case`](business-case/SKILL.md) | Builds investment-ready business cases. Problem framing, options, ROI, risks, recommendation. | You need to justify spend or get sign-off from leadership |
| [`/fin-model`](fin-model/SKILL.md) | Expert financial modeling. P&L, cash flow, 5-year depreciation schedules, ARR/MRR, NRB, ROI, NPV — inline Python, no spreadsheet. Cross-checks investment against R2E/R2C/R2W tiers from `/roadmap-plan`. | Deep financial analysis, NRB calculation, or checking whether the numbers behind a business case actually hold up |
| [`/roadmap-plan`](roadmap-plan/SKILL.md) | Outcome-based roadmaps. Translates strategy + OKRs into sequenced delivery with dependencies and capacity constraints. | You need to turn decisions into a plan teams can align on |
| [`/deck-review`](deck-review/SKILL.md) | Analyses a `.pptx` deck for a named exec audience. Strategic critique (strengths/gaps table, top fixes) + slide-by-slide presenter talking points. Delta mode for re-reviews. | You have a presentation to review, critique, or prepare talking points for |
| [`/portfolio-fund`](portfolio-fund/SKILL.md) | Portfolio-level funding request builder. Composes investment asks across innovation/core/growth mix. Pulls from /business-case, /fin-model, /roadmap-plan. Quarterly review and scenario modeling. | Building a portfolio funding ask — not a single business case but the whole investment mix |
| [`/prioritise`](prioritise/SKILL.md) | Idea triage & ranking. Walks through RICE, effort/impact matrix, weighted scoring, or gut ranking. Interactive — the human scores, the skill calculates. Feeds into `/roadmap-plan`. | You have 5+ ideas and need to decide which to build first |

---

## Tier 2.5 — EVALUATE
> *Define what good looks like. Score outputs. Regression-test skill quality.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/eval-create`](eval/SKILL.md) | Define success criteria, translate nuance into metrics, create Golden Examples. Builds a reusable eval file for `/eval-run`. | Before starting any PM workflow — define the bar first |
| [`/eval-run`](eval/SKILL.md) | Scores an actual output against stored eval criteria. Dimension-level scoring, gap analysis, regression mode. | After a skill run or deliverable — did this meet the bar? |

---

## Tier 3 — VALIDATE & COMPLY
> *Can we build it? Are we legally and technically allowed to? What gates must we pass?*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/pdlc`](pdlc/SKILL.md) | Product Development Lifecycle guide. 8 phases, 4 formal checkpoints, 8 pathways. Gate readiness coaching. | You need to know which PDLC phase you're in and what's required to proceed |
| [`/governance`](governance/SKILL.md) | Prepares content for governance ceremonies and checkpoint approvals. PwoW-aligned artefacts. | Approaching a formal review gate — Big Room Planning, QBR, checkpoint approval |
| [`/privacy`](privacy/SKILL.md) | Privacy office review prep. Data mapping, lawful basis, DPIA triggers, retention, consent. | Any feature touching personal data — must run before engineering starts |
| [`/pci-review`](pci-review/SKILL.md) | PCI DSS scope review. Cardholder data flows, in-scope systems, control gaps. | Any change touching payment card data or cardholder data environment |
| [`/security-threat-model`](security-threat-model/SKILL.md) | Threat modeling. Assets, trust boundaries, abuse cases, STRIDE analysis. | New APIs, auth flows, data stores, or external integrations |
| [`/security-controls`](security-controls/SKILL.md) | Turns threat model findings into concrete control decisions with ownership and priority. | After threat modeling — translates risks into implementation actions |

---

## Tier 4 — DESIGN & PLAN
> *How should it look, work, and be built? Lock the plan before a line of code is written.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/api-spec`](api-spec/SKILL.md) | Creates OpenAPI specs from business requirements. Field mapping with standards-compliant name options. Target audience: API product managers. | You have business reqs and need an OpenAPI spec before dev starts |
| [`/arch-diagram`](arch-diagram/SKILL.md) | Generates Mermaid architectural diagrams (C4 context, container, sequence, deployment) from a design plan or conversational description. | Before TAC or plan-eng-review — visualise your architecture before it gets challenged |
| [`/nfr-prep`](nfr-prep/SKILL.md) | NFR assessment and instruction document for system designs. Covers availability, performance, security, scalability, resilience, compliance. | Before TAC or Secure Design Review — lock down NFRs before architecture is finalised |
| [`/plan-design-review`](plan-design-review/SKILL.md) | UX/design review of a plan or PRD before build. Evaluates clarity, coherence, usability, trust. | You have a plan and want a design lens before engineering starts |
| [`/prototype`](prototype/SKILL.md) | Rapid wireframes as shareable HTML. Lo-fi (grey boxes, Balsamiq energy) or hi-fi (GP-branded). Self-contained single file with embedded callouts, annotations, and comments. Iterative. | You need a quick visual to share an idea before opening Figma or Lovable |
| [`/plan-devex-review`](plan-devex-review/SKILL.md) | Developer experience review. Setup burden, API ergonomics, documentation, internal tooling. | Platform changes, new APIs, developer-facing features |
| [`/plan-eng-review`](plan-eng-review/SKILL.md) | Engineering architecture review. Data flows, diagrams, edge cases, test coverage, performance. | You're about to start coding — catch architecture issues first |
| [`/autoplan`](autoplan/SKILL.md) | Auto-runs CEO, design, eng, and DX reviews sequentially with auto-decisions. Surfaces taste decisions at a final approval gate. | You want all four plan reviews in one pass with minimal back-and-forth |

---

## Tier 5 — BUILD & SHIP
> *Write it, test it, review it, deploy it safely.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/plan-eng-review`](plan-eng-review/SKILL.md) | *(see Tier 4)* | — |
| [`/review`](review/SKILL.md) | Pre-landing PR review. SQL safety, LLM trust boundaries, conditional side effects, structural issues. | Before merging any significant code change |
| [`/qa`](qa/SKILL.md) | Systematic QA testing + iterative bug fixing. Produces health scores and ship-readiness summary. | Feature is ready for testing — find and fix what's broken |
| [`/investigate`](investigate/SKILL.md) | Systematic debugging. Four phases: investigate → analyse → hypothesise → implement. Iron Law: no fixes without root cause. | Something is broken and you don't know why |
| [`/careful`](careful/SKILL.md) | Safety guardrails for destructive commands. Warns before `rm -rf`, `DROP TABLE`, force-push, `kubectl delete`. | Working near production, shared environments, or irreversible operations |
| [`/ship`](ship/SKILL.md) | Ship workflow. Merge base, run tests, diff review, bump version, update changelog, push, create PR. | Code is ready to deploy |
| [`/checkpoint`](checkpoint/SKILL.md) | Save and resume working state. Captures git state, decisions, remaining work across sessions. | End of a session, switching context, or before a long break |
| [`/overnight-build`](overnight-build/SKILL.md) | Universal post-braindump dispatcher. Classifies ideas (skill/code/park), routes to the right track, and executes overnight via agents. Skill-track writes SKILL.md; code-track creates a new repo with real code. | After a braindump session — hand off the build and sleep |

---

## Tier 6 — LAUNCH & OPERATE
> *Go live safely, onboard customers, keep it running, learn from it.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/launch-readiness`](launch-readiness/SKILL.md) | Go/no-go assessment. Operational readiness, support prep, rollout and rollback plans. | Feature is built — final check before flipping the switch |
| [`/merchant-onboarding`](merchant-onboarding/SKILL.md) | Maps the merchant journey from approved to live. Onboarding steps, blockers, activation. | Planning or fixing how merchants get up and running |
| [`/settlement-readiness`](settlement-readiness/SKILL.md) | Payment flow validation. Funding, reconciliation, exception handling, cut-off times. | Launching or changing any payment flow that touches settlement |
| [`/incident-response`](incident-response/SKILL.md) | Structured incident coordination. Triage, severity, stabilise, communicate, post-mortem. | Something is down or a security/privacy event is in progress |
| [`/support-ops`](support-ops/SKILL.md) | Customer support operations. Ticket triage, escalation playbooks, SLA reporting, knowledge base drafting. | Building or improving support processes, triage, and escalation workflows |
| [`/retro`](retro/SKILL.md) | Weekly engineering retrospective. Commit history, patterns, per-person contributions, trend tracking. | End of sprint/week — what did we ship and what should we change |
| [`/root-cause`](root-cause/SKILL.md) | Interactive 5 Whys & structured problem analysis. Walks through root cause frameworks (5 Whys, fishbone, fault tree). Challenges shallow answers. Produces markdown + GP-branded HTML. | Post-incident RCA, sprint retro deep-dive, or any problem that needs structured "but WHY?" analysis |
| [`/memory`](memory/SKILL.md) | Persistent memory layer. Learns across sessions, recalls past decisions, connects context between skills. | Always-on — other skills query it; invoke directly to search or learn |

---

## Tier 7 — GO TO MARKET
> *Position, sell, propose — turn product into revenue.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/gtm-messaging`](go-to-market/gtm-messaging/SKILL.md) | Positioning frameworks (April Dunford), messaging hierarchies, value propositions, campaign briefs, battle cards. | Launching a product, repositioning, or arming sales with messaging |
| [`/deal-qualify`](go-to-market/deal-qualify/SKILL.md) | MEDDIC/BANT deal qualification, gap analysis, win plans, account plans, pitch preparation. | Evaluating whether to invest in a deal, preparing for a pitch |
| [`/proposal-write`](go-to-market/proposal-write/SKILL.md) | RFP responses, executive summaries, pricing narratives, proposal outlines with owner assignments. | Responding to an RFP, writing a proposal, structuring a pricing narrative |
| [`/marketing`](go-to-market/marketing/SKILL.md) | Content creation (blog, case study, white paper, social, ad copy), campaign planning (brief, channels, timeline, metrics), performance reporting (lead funnels, MQL/SQL, event ROI), GP-branded landing pages (self-contained HTML). | Creating marketing content, planning campaigns, reporting results, building landing pages |
| [`/sales-ops`](revenue-ops/sales-ops/SKILL.md) | Pipeline health, forecast modeling, territory planning, quota modeling, CRM hygiene audits. | Analysing pipeline, building forecasts, planning territories |
| [`/customer-success`](revenue-ops/customer-success/SKILL.md) | Customer health scores, churn risk identification, success plans, expansion mapping, customer QBRs. | Managing customer health, preparing customer-facing reviews |
| [`/solution-consulting`](revenue-ops/solution-consulting/SKILL.md) | Technical discovery, integration scoping, solution briefs, demo prep, POC planning. | Pre-sales technical work, scoping integrations, planning POCs |

---

## Tier 8 — RISK OPERATIONS
> *Manage enterprise risk, fraud, credit, and collections. Professional-domain skills — augment, don't replace.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/operational-risk`](risk-ops/operational-risk/SKILL.md) | *(WIP)* Risk registers, vendor risk assessments, BCP, risk appetite statements, control assessments. | Building or reviewing risk registers, assessing vendors, BCP planning |
| [`/fraud-ops`](risk-ops/fraud-ops/SKILL.md) | *(WIP)* Case triage, fraud rule analysis, SAR preparation, chargeback management, pattern detection. | Structuring fraud investigations, tuning rules, managing disputes |
| [`/collections`](risk-ops/collections/SKILL.md) | *(WIP)* Collections strategy, portfolio segmentation, recovery analysis, communication playbooks. | Planning collections strategy, analysing recovery performance |
| [`/credit-risk`](risk-ops/credit-risk/SKILL.md) | *(WIP)* Credit policy review, portfolio monitoring, scorecard interpretation, exposure analysis. | Reviewing credit policy, monitoring portfolio health, analysing exposure |

---

## Standalone Utilities
> *Use anytime — these don't belong to a specific journey phase.*

| Skill | What It Does |
|-------|-------------|
| [`/accessibility`](accessibility/SKILL.md) | WCAG 2.2 audit. Screen reader support, keyboard navigation, colour contrast, ARIA. |
| [`/best-practices`](best-practices/SKILL.md) | Web best practices audit. Security headers, compatibility, code quality, modern patterns. |
| [`/demo-script`](demo-script/SKILL.md) | Generates a timed, copy-paste-ready demo script for anything — product, tool, workflow, or skills showcase. Interprets what you want to show and who the audience is, then outputs talk tracks, exact steps, expected outputs, and presenter tips in one markdown file. |
| [`/core-web-vitals`](core-web-vitals/SKILL.md) | LCP, INP, CLS optimisation. Page experience and search ranking. |
| [`/internal-comms`](internal-comms/SKILL.md) | GP-branded HTML email/page builder. 5 templates: celebration, announcement, newsletter, executive, spotlight. Logo embedded, Segoe UI, brand colors, Outlook-compatible table layout. Saves to `~/.copilot/comms/`. |
| [`/comms`](comms/SKILL.md) | **Audience-aware communications translator.** Routes to the right Insights Discovery colour profile. Pass `--red`, `--green`, `--blue`, or `--yellow`, or describe your audience and the skill recommends the profile. Preserves every fact, number, ask, and deadline. Supports `{{keep: ...}}` markers and a shared global protected-terms list. Saves to `~/.copilot/comms-drafts/`. |
| [`/comms --red`](comms/red/SKILL.md) | 🔴 Fiery Red: BLUF, decisive, exec-ready. TL;DR + bullets + optional detail. Intensity: `--tighten` / `--exec` / `--brutal`. |
| [`/comms --green`](comms/green/SKILL.md) | 🟢 Earth Green: warm, collaborative, relationship-first. Leads with shared purpose, "we" language, acknowledges impact. Intensity: `--warm` / `--considered`. |
| [`/comms --blue`](comms/blue/SKILL.md) | 🔵 Cool Blue: precise, evidence-led, structured. States methodology, flags caveats, logical flow. Intensity: `--clear` / `--rigorous`. |
| [`/comms --yellow`](comms/yellow/SKILL.md) | 🟡 Sunshine Yellow: energetic, visionary, big-picture. Leads with opportunity, celebrates wins, invites contribution. Intensity: `--upbeat` / `--vivid`. |
| [`/performance`](performance/SKILL.md) | Web performance audit. Load time, bundle size, render blocking, caching. |
| [`/seo`](seo/SKILL.md) | SEO optimisation. Meta tags, structured data, sitemap, crawlability. |
| [`/web-quality-audit`](web-quality-audit/SKILL.md) | Full web quality audit covering performance, accessibility, SEO, and best practices in one pass. |
| [`/contract-review`](contract-review/SKILL.md) | Pre-read assistant for contracts. Flags clauses, explains jargon, prepares questions for legal counsel. ⚠️ *Augments, does not replace attorneys.* |
| [`/share-teams`](share-teams/SKILL.md) | Push any skill output to MS Teams. Formats as Adaptive Cards or plain messages. Posts via webhook or MS Graph API. Channel map for one-command sharing. |
| [`/publish-feed`](publish-feed/SKILL.md) | Auto-generates RSS/Atom feeds across three lanes: Skills, Products, and Prototypes. Execs subscribe via Outlook/SharePoint/browser. Weekly Friday digests. |
| [`/translate`](translate/SKILL.md) | Expert translation via Google Cloud Translation or DeepL. LLM reviews output for cultural adaptation, tone, ambiguity. Localisation mode, protected glossary, back-translation quality check. |
| [`/hackathon`](hackathon/SKILL.md) | Time-boxed creative sprint. Creates a fresh GitHub repo, starts a countdown timer, scaffolds from templates. When time expires: auto-commit, tag submission, generate stats, run mini-retro. Constraint as a feature. |
| [`/reverse-analytics`](reverse-analytics/SKILL.md) | Extracts data from web pages (HTML tables via pandas), chart images (LLM vision with validation gate), or pasted data — then runs statistical analysis (trends, correlations, comparisons, funnels). Three modes: `web`, `image`, `analyse`. ⚠️ *Image mode is approximate (60–70%) and requires user validation.* |

---

## Meta-Tools
> *Skills about the skill library itself — continuous learning and skill creation.*

| Skill | What It Does | When to Use |
|-------|-------------|-------------|
| [`/ask`](ask/SKILL.md) | Natural language skill router. Describe what you need in plain words and it identifies the right GPN skill and runs it — no need to know skill names. Covers all 59 skills. Detects multi-step journey needs and routes to `/flow`. | When you're unsure which skill to use, or when describing a task without naming a specific skill. The universal entry point. |
| [`/session-learn`](session-learn/SKILL.md) | End-of-session pattern detector. Classifies workflows, workarounds, habits, and domain tasks. Writes findings to `/memory`. Recommends new skills via `/skill-forge` when a pattern crosses the signal threshold. | Run at session end — or configure as a stop hook. When you want to know what patterns you're repeating. |
| [`/skill-forge`](skill-forge/SKILL.md) | Skill builder. Converts a description or `/session-learn` pattern into a fully-formed `SKILL.md`, creates the directory, updates `CATALOG.md`, and opens a draft PR to GPN-Skillz. | When `/session-learn` surfaces a strong skill candidate, or when you want to contribute a new skill to the library. |
| [`/context-handoff`](context-handoff/SKILL.md) | End-of-session brief writer. Captures what was done, decisions made, open threads, and next actions. Saves a cold-start summary to `~/.copilot/context-handoff/latest.md`. | At the end of any working session — run alongside `/session-learn` to leave no context behind. |
| [`/doc-refresh`](doc-refresh/SKILL.md) | Audits copilot-instructions.md against installed skills — surfaces missing registrations and stale rows. Optionally fixes gaps and regenerates a cheat sheet. | When skills feel out of sync with your docs, after installing new skills, or when your cheat sheet is stale. |
| [`/memory-review`](memory-review/SKILL.md) | Weekly cross-session pattern synthesiser. Reads ~/.copilot/memory/ and surfaces what you're repeating, what's improving, and what's stuck across sessions. | Weekly — or whenever you want cross-session insight that single-session /session-learn can't see. |
| [`/pipeline-health`](pipeline-health/SKILL.md) | Health check for the GPN-Skillz overnight pipeline — runner status, recent workflow runs, failure logs. | When you suspect the overnight build failed, before relying on a pipeline output, or after a runner restart. |
| [`/retro-weekly`](retro-weekly/SKILL.md) | PM-level weekly retrospective. Synthesises what shipped, patterns, blockers, and next week's priorities from briefs, PRs, and memory. | End of each work week — run after /memory-review for richest data. |
| [`/skill-health`](skill-health/SKILL.md) | Read-only validator for installed skills. Checks each SKILL.md for frontmatter completeness, description ≤1024 chars, Trigger line, and name consistency. | After an upstream sync, or when a skill behaves unexpectedly — before opening a /skill-forge PR. |
| [`/skill-roadmap`](skill-roadmap/SKILL.md) | Skill candidate backlog manager. Tracks ideas from capture to shipped, scores by frequency/impact/complexity, and hands off to `/skill-forge` when ready to build. | You want to prioritize which skill to build next, or track the pipeline of skill candidates. |
| [`/upstream-digest`](upstream-digest/SKILL.md) | Fetches upstream GPN-Skillz and surfaces a digest of new and updated skills since your last sync. | When you want to know what Conor shipped, before a sync, or when skills seem out of date. |
| [`/skill-optimize`](skill-optimize/SKILL.md) | Autonomous skill improvement loop (Karpathy-style). Multi-agent cycle: Test → Analyse → Fix. Runs until eval score plateaus or regresses. Integrates with `/eval-create` + `/eval-run`. | You want to automatically improve a skill's quality score without manual iteration |
| [`/demo`](demo/SKILL.md) | Speed-run guided demo of the Skillz ecosystem. 4-8 minute curated experience through braindump → spark → strategy → build. Scores session out of 100. HTML output. | Stakeholder demos, onboarding new users, or showcasing the skill library |
| [`/sandbox`](sandbox/SKILL.md) | Safe experimentation mode. Wraps any skill in a dry-run — full experience, zero side effects. No file writes, no PRs, no commits. Token-optimised. Outputs are promotable to real. | New users exploring safely, or testing a skill without consequences |
| [`/mcp-catalog`](mcp-catalog/SKILL.md) | MCP discovery & capabilities browser. Lists supported MCPs with descriptions, example prompts, and compatibility matrix. Tests connectivity. | You want to know what MCPs are available and what they can do. |
| [`/session-story`](session-story/SKILL.md) | Packages a brainstorm session into a shareable narrative arc. Traces how ideas connected, where breakthroughs happened, what's still unexplored. Outputs as markdown, GP-branded HTML, or slides. | End of a brainstorm session — share the journey, not just the ideas. |
| [`/skill-brief`](skill-brief/SKILL.md) | Primes any GPN skill with context from prior sessions before it runs. Queries session store, memory, and context-handoff briefs to compose a cold-start summary so the skill picks up where you left off. | Before invoking a skill you haven't used in a while — or any time you want the skill to have full context on prior work. |

---

## The Six Journeys (use `/flow` to start)

```
JOURNEY 1 — NEW PRODUCT
  braindump → office-hours → competitor-teardowns → plan-ceo-review
  → customer-research → business-case → fin-model → product-manager
  → pdlc → privacy → security-threat-model → pci-review
  → governance → roadmap-plan → plan-design-review
  → plan-devex-review → plan-eng-review → launch-readiness → ship → retro

JOURNEY 2 — NEW FEATURE
  office-hours → product-manager → plan-eng-review
  → review → qa → launch-readiness → ship

JOURNEY 3 — COMPETITOR RESPONSE
  competitor-teardowns → plan-ceo-review → product-manager → roadmap-plan

JOURNEY 4 — QBR / EXEC PREP
  competitor-teardowns → business-case → fin-model → roadmap-plan → governance

JOURNEY 5 — BUG / INCIDENT
  investigate → careful → review → qa → ship
  [if live incident] → incident-response → retro

JOURNEY 6 — COMPLIANCE REVIEW
  privacy → security-threat-model → pci-review → security-controls → governance

JOURNEY 7 — SHIP SOMETHING
  review → careful → qa → ship

JOURNEY 8 — BRAINSTORM TO BUILD
  braindump → spark → prioritise → prototype → hackathon
  → review → ship → session-story → retro
```

---

*Last updated: 2026-05-21 | 84 skills | Use `/flow` for guided journeys | Use `/session-learn` to grow the library*
