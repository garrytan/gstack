# /ask — Signal Table

Skill paths are relative to `$SKILLS_DIR` (defaults to `~/.copilot/skills/`).
For each skill: strong signals trigger DIRECT routing; weak signals contribute
to CLARIFY candidates. Journey entries route to `/flow` instead of a single skill.

---

## IDEATION & CAPTURE

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/braindump` | `braindump/SKILL.md` | brain dump, capture ideas, thinking out loud, hear me out, idea capture, just listen, I've been thinking | rough thoughts, random thought, rambling, stream of consciousness, no judgment |
| `/spark` | `spark/SKILL.md` | what am I missing, patterns in my ideas, braindump gaps, angle I haven't considered, after braindumping, post-brainstorm | recurring themes, blind spots, what else |
| `/office-hours` | `discover/office-hours/SKILL.md` | think through an idea, pressure test idea, design doc, startup mode, structured ideation, talk through a concept, challenge my thinking | help me develop this, sounding board, before I commit |
| `/hackathon` | `hackathon/SKILL.md` | hackathon, time-boxed sprint, countdown timer, constraint-based build, timed build | rapid build, creative sprint, build in a day |

---

## RESEARCH & DISCOVERY

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/customer-research` | `discover/customer-research/SKILL.md` | customer interviews, user research, validate with customers, research plan, discovery research, synthesize findings, talk to users | what do customers think, user feedback, validate assumptions |
| `/platform-discovery` | `platform-discovery/SKILL.md` | platform discovery call, run a discovery call, platform intake, use case discovery, team onboarding to platform, validate platform demand, add team to registry, synthesise patterns, cross-team use cases, ai platform adoption | internal product team, onboard team, use case registry, demand signal |
| `/competitor-teardowns` | `discover/competitor-teardowns/SKILL.md` | competitor analysis, SWOT, battle card, competitor launched, pricing intel, competitive intelligence, market intelligence | what is competitor doing, how do we stack up, prepping for sales |
| `/reverse-analytics` | `reverse-analytics/SKILL.md` | extract data from web page, analyze chart image, HTML table, parse data from page, reverse engineer metrics, data from screenshot | scrape data, chart analysis, pull metrics |

---

## STRATEGY

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/plan-ceo-review` | `strategy/plan-ceo-review/SKILL.md` | pressure test plan, founder review, challenge premises, CEO review, 10-star product, strategic challenge, what am I missing about my plan | ambitious enough, is this big enough, founder mode |
| `/product-manager` | `strategy/product-manager/SKILL.md` | PM review, customer problem, what should we build, voice of customer, product thinking, trade-offs, prioritize features, product lens | PM opinion, product feedback, what does the customer want |
| `/business-case` | `strategy/business-case/SKILL.md` | business case, justify investment, ROI, sign-off from leadership, investment narrative, cost benefit, funding recommendation, options analysis | make the case for, convince stakeholders, justify the spend |
| `/fin-model` | `fin-model/SKILL.md` | financial model, P&L, cash flow, ARR, MRR, NPV, NRB, revenue model, 5-year forecast, depreciation schedule, unit economics, R2E R2C R2W | financial analysis, crunch the numbers, model this revenue |
| `/roadmap-plan` | `strategy/roadmap-plan/SKILL.md` | roadmap, sequence delivery, OKRs, what order to build, quarter plan, dependencies and sequence, now next later | delivery plan, what comes first, plan the work |
| `/prioritise` | `prioritise/SKILL.md` | rank these ideas, which to build first, RICE scoring, impact matrix, idea triage, score these options, weighted scoring | prioritization, rank my backlog, what's most important |

---

## EVALUATION

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/eval` (create) | `eval/SKILL.md` | define success criteria, what does good look like, golden examples, define the bar before, evaluation criteria, eval-create | success metrics upfront, measure quality of output |
| `/eval` (run) | `eval/SKILL.md` | score this output, did this meet the bar, grade this, evaluate against criteria, regression test quality, eval-run | how did this do, quality check output |

*Note: both modes live in `eval/SKILL.md` — the skill detects create vs run mode from context.*

---

## COMPLIANCE & GOVERNANCE

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/pdlc` | `pdlc/SKILL.md` | what phase am I in, PDLC, product development lifecycle, checkpoint, gate readiness, which pathway, lifecycle phase | where are we in the process, next milestone |
| `/governance` | `governance/SKILL.md` | governance review, QBR prep, checkpoint approval, big room planning, PwoW, governance ceremony, formal review gate, exec presentation | prepare for review, governance package |
| `/privacy` | `privacy/SKILL.md` | GDPR, DPIA, personal data, PII, privacy review, data mapping, lawful basis, data protection, CCPA, consent, data retention | does this need a privacy review, is this GDPR compliant |
| `/pci-review` | `on-demand/risk/pci-review/SKILL.md` | PCI, PCI DSS, cardholder data, payment card scope, CDE, PAN, CVV, payment data compliance | is this in scope for PCI, cardholder data environment |
| `/security-threat-model` | `on-demand/risk/security-threat-model/SKILL.md` | threat model, STRIDE, abuse cases, trust boundaries, security review, attack vectors, threat analysis | what could go wrong, security risks, model the threats |
| `/security-controls` | `on-demand/risk/security-controls/SKILL.md` | security controls, remediation plan, control gaps, fix security findings, implement controls, control decisions | what controls do we need, address the security findings |

---

## DESIGN & PLAN

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/plan-design-review` | `plan/plan-design-review/SKILL.md` | UX review of plan, design review before build, usability review before coding, design feedback on PRD | design lens on the plan, UX before engineering starts |
| `/prototype` | `prototype/SKILL.md` | wireframe, mockup, prototype, lo-fi, visual, show the idea, clickable prototype, rough visual, HTML mock | sketch this out, visualize the flow, quick design |
| `/plan-devex-review` | `plan/plan-devex-review/SKILL.md` | developer experience, API ergonomics, dev docs review, developer-facing change, platform change | DX review, how is it to use this API, setup burden |
| `/plan-eng-review` | `plan/plan-eng-review/SKILL.md` | architecture review, technical review, data flow review, edge cases before coding, engineering review of plan, technical feasibility | is this architected well, eng feedback, before I start coding |
| `/autoplan` | `plan/autoplan/SKILL.md` | run all reviews, full plan review, autoplan, all four reviews, full review pipeline, CEO design eng DX in one | run everything on this plan |

---

## BUILD & SHIP

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/review` | `deliver/review/SKILL.md` | code review, PR review, before I push, review my code, pre-landing review, check my changes, pre-merge | look at my code, review this PR, is this ready to merge |
| `/qa` | `deliver/qa/SKILL.md` | QA testing, find bugs, ship readiness, test this feature, quality assurance, test coverage, health score | test it, QA this, does it work properly |
| `/investigate` | `on-demand/risk/investigate/SKILL.md` | debug, root cause, something is broken, error, why is this failing, investigate this issue, broken, crashing | fix this bug, what's wrong, troubleshoot |
| `/careful` | `on-demand/utils/careful/SKILL.md` | working near prod, destructive command, rm -rf, careful mode, safety mode, dangerous operation, irreversible | be careful, safety check, near production |
| `/ship` | `deliver/ship/SKILL.md` | ready to deploy, ship this, merge and push, create PR, deploy to production, release this, bump version, changelog | deploy it, push this, go live now |
| `/checkpoint` | `deliver/checkpoint/SKILL.md` | save my state, pause and save, resume later, save session, save progress, where I left off | bookmark progress, checkpoint |
| `/overnight-build` | `overnight-build/SKILL.md` | build overnight, hand off to agents, dispatch to agents, run while I sleep, after braindump | agent build, automated build |

---

## LAUNCH & OPERATIONS

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/launch-readiness` | `ops/launch-readiness/SKILL.md` | go/no-go, ready to launch, before go-live, launch readiness, pre-launch check, is this ready to ship | launch checklist, final check before going live |
| `/merchant-onboarding` | `ops/merchant-onboarding/SKILL.md` | merchant journey, onboard merchants, merchant activation, from approved to live, merchant setup | how does a merchant get started, merchant boarding |
| `/incident-response` | `on-demand/risk/incident-response/SKILL.md` | incident, outage, sev1, sev2, service down, war room, breach, live incident, something is down | crisis, emergency, production issue right now |
| `/support-ops` | `ops/support-ops/SKILL.md` | support tickets, escalation playbook, SLA reporting, knowledge base, triage support, support processes | how to handle support, customer complaint workflows |
| `/retro` | `deliver/retro/SKILL.md` | retrospective, what did we ship, end of sprint, sprint review, team retro, what went well | look back on the sprint, shipping retrospective |
| `/memory` | `memory/SKILL.md` | remember this, recall decision, what did we decide, past context, find previous, session memory, cross-session recall | what was decided, do you remember, context from before |

---

## GO-TO-MARKET & REVENUE

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/gtm-messaging` | `go-to-market/gtm-messaging/SKILL.md` | positioning, messaging, value proposition, battle card, launch messaging, go-to-market message, campaign brief | market message, how to talk about this, what's our pitch |
| `/deal-qualify` | `go-to-market/deal-qualify/SKILL.md` | deal qualification, MEDDIC, BANT, win plan, account plan, pitch prep, qualify this deal | is this deal worth pursuing, how do we win this |
| `/proposal-write` | `go-to-market/proposal-write/SKILL.md` | RFP response, write a proposal, pricing narrative, executive summary for client, proposal structure | respond to RFP, proposal draft, client bid |
| `/marketing` | `go-to-market/marketing/SKILL.md` | blog post, case study, social copy, campaign, landing page, white paper, ad copy, content creation | write content, marketing material, social post |
| `/sales-ops` | `revenue-ops/sales-ops/SKILL.md` | pipeline health, forecast, territory planning, quota, CRM hygiene, pipeline analysis, sales metrics | pipeline review, sales forecast, territory plan |
| `/customer-success` | `revenue-ops/customer-success/SKILL.md` | customer health, churn risk, expansion opportunity, customer QBR, success plan, at-risk customer | customer is unhappy, expansion planning, renewal risk |
| `/solution-consulting` | `revenue-ops/solution-consulting/SKILL.md` | technical discovery, integration scoping, demo prep, POC planning, pre-sales technical, solution brief | scope the integration, technical pre-sales, POC plan |

---

## RISK OPERATIONS

*Professional-domain skills — augment analysts, do not replace professional judgment.*

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/operational-risk` | `risk-ops/operational-risk/SKILL.md` | risk register, vendor risk, BCP, risk appetite, control assessment, operational risk framework | operational risks, vendor assessment, business continuity |
| `/fraud-ops` | `risk-ops/fraud-ops/SKILL.md` | fraud case, SAR, chargeback, fraud rule, fraud investigation, suspicious activity, dispute management | fraud alert, suspicious transaction, fraud pattern |
| `/collections` | `risk-ops/collections/SKILL.md` | collections strategy, recovery analysis, portfolio segmentation, debt collections, recovery rate | collect on this debt, collections playbook |
| `/credit-risk` | `risk-ops/credit-risk/SKILL.md` | credit policy, scorecard, exposure analysis, credit portfolio, underwriting, credit review | credit decision, portfolio risk, lending exposure |

---

## WEB QUALITY

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/accessibility` | `web/accessibility/SKILL.md` | WCAG, screen reader, keyboard navigation, colour contrast, ARIA, accessibility audit, inclusive design | is this accessible, a11y, disabled users |
| `/core-web-vitals` | `web/core-web-vitals/SKILL.md` | LCP, INP, CLS, page experience, core web vitals, web performance metrics | page feels slow, layout shift, input delay |
| `/performance` | `web/performance/SKILL.md` | load time, bundle size, render blocking, caching, web performance, slow page, optimise | page is slow, performance issue, speed up the site |
| `/seo` | `web/seo/SKILL.md` | SEO, meta tags, structured data, sitemap, crawlability, search ranking | search optimisation, Google ranking, indexing |
| `/design-review` | `web/design-review/SKILL.md` | review the UI, design of implemented page, UX of built feature, check the design of, usability of built screen | how does this look, UX review of implemented feature |
| `/web-quality-audit` | `on-demand/risk/web-quality-audit/SKILL.md` | full web audit, audit everything, web quality, comprehensive web audit, all quality dimensions | check everything on this site, full audit |
| `/best-practices` | `on-demand/utils/best-practices/SKILL.md` | best practices audit, security headers, modernise code, code quality check, web standards | is this up to standard, best practice check |

---

## COMMUNICATIONS & UTILITIES

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/internal-comms` | `internal-comms/SKILL.md` | GP-branded email, internal announcement, team newsletter, celebration email, comms to staff, employee comms | send this to the team, internal update, all-hands message |
| `/comms` | `comms/SKILL.md` | rewrite for audience, Insights Discovery, communication style, adapt tone, audience-aware, colour profile, red green blue yellow | change the tone, adapt for this person, translate this message |
| `/contract-review` | `contract-review/SKILL.md` | contract, clause, NDA, MSA, legal pre-read, review this agreement, flag contract issues, SaaS agreement | look at this contract, check the terms, legal review |
| `/session-story` | `session-story/SKILL.md` | package this session, share the brainstorm, narrative of session, how ideas connected, share the journey | story of our session, what we explored today |

---

## META-SKILLS

| Skill | Path | Strong signals | Weak signals |
|-------|------|----------------|-------------|
| `/session-learn` | `session-learn/SKILL.md` | patterns this session, what did I repeat, end of session review, session learning, what workflows did I use | session summary, what did I do today |
| `/skill-forge` | `skill-forge/SKILL.md` | create a new skill, build a skill, contribute to skills library, make a SKILL.md, new skill for | add to the library, new skill |
| `/eval` | `eval/SKILL.md` | define success criteria, score this, golden examples, evaluate this output | eval, quality check |

---

## JOURNEY DETECTION

Route to `/flow` (path: `flow/SKILL.md`) when the user asks for:

- "walk me through the process", "guide me step by step", "what journey"
- "where do I start with a new product/feature/initiative"
- "what comes next after I finish X"
- "what's the full sequence for launching/building/shipping"
- "I'm not sure where to begin", "orchestrate this for me"
- Any request that clearly spans 5+ sequential skills with dependencies

**Do not route to /flow** if the user has a specific single deliverable in mind
(e.g., "write a business case" → `/business-case`, not `/flow`).

---

## COMMON AMBIGUOUS PAIRS

Use these to resolve CLARIFY cases faster:

| Ambiguous input | Likely candidates | Differentiator |
|----------------|------------------|----------------|
| "review this" | `/review` vs `/plan-eng-review` vs `/plan-design-review` | Code = `/review`; architecture plan = `/plan-eng-review`; UX/design plan = `/plan-design-review` |
| "I need to plan this" | `/roadmap-plan` vs `/plan-eng-review` vs `/autoplan` | Delivery sequence = `/roadmap-plan`; technical architecture = `/plan-eng-review`; all reviews = `/autoplan` |
| "something is broken" | `/investigate` vs `/incident-response` | Live production outage = `/incident-response`; local debug = `/investigate` |
| "privacy review" | `/privacy` vs `/pci-review` | Personal data (PII) = `/privacy`; payment card data = `/pci-review` |
| "write a document" | varies | Business justification = `/business-case`; roadmap = `/roadmap-plan`; comms = `/comms`; proposal = `/proposal-write` |
| "prepare for a meeting" | `/governance` vs `/gtm-messaging` vs `/deal-qualify` | Internal exec/gate = `/governance`; customer pitch = `/deal-qualify`; product launch = `/gtm-messaging` |
