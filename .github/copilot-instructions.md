# Copilot CLI — Team Instructions

## About This Repository

This repository contains the Global Payments Copilot skills library — a curated set of
skills for product strategy, design, privacy, engineering workflow, and web quality.
These skills are designed to work together across GP projects.

## Values

All team members using Copilot should apply these principles:

- **Think like a client** — Start from the customer problem, not the solution
- **Act like an owner** — Consider cost vs benefit, strategic alignment, and long-term implications
- **Win as one team** — Support the 2-in-a-box / 3-in-a-box model (PM + EM + ADM)

## How to Use This Library

- **Not sure which skill to use?** Just type `/ask` and describe what you need in plain language — it will identify and run the right skill automatically.
- For personal, cross-project use: install this repo at `~/.copilot/skills/`
- For project-specific use: copy selected skill directories into `.github/skills/`
- For repo instructions: keep this file at `.github/copilot-instructions.md`

## Getting Started

| Skill | Purpose | Typical user |
|-------|---------|--------------|
| `/ask` | Natural language skill router — describe what you need and it identifies and runs the right skill automatically. The universal entry point when you don't know which skill to reach for. | Everyone |
| `/flow` | Guided journey orchestrator — maps your context to a named multi-step journey and tracks progress through it. | Everyone |

## Product, Design & Governance Skills

| Skill | Purpose | Typical user |
|-------|---------|--------------|
| `/braindump` | Capture raw ideas quickly without critique before formal analysis begins; keep markdown as the source of truth | PM, Design, Founders |
| `/office-hours` | Challenge or shape an idea before writing a formal plan | PM, Design, Founders |
| `/memory` | Recall prior decisions, preferences, and project context across sessions using local files first | PM, EM, Design |
| `/product-manager` | Product thinking — customer lens, prioritisation, trade-offs | PM, EM |
| `/customer-research` | Plan discovery, interviews, synthesis, and decision-ready research readouts | PM, Design, EM |
| `/platform-discovery` | Structured intake for validating AI platform use cases with internal product teams — prep, 45-min call, 48-hr follow-up, use case registry, cross-team pattern synthesis | PM, Platform |
| `/business-case` | Decision-ready business cases, investment options, and funding recommendations | PM, Leadership, Finance |
| `/roadmap-plan` | Build roadmap options, quarterly sequencing, and now/next/later plans | PM, EM, ProdOps |
| `/launch-readiness` | Prepare launch, rollout, support, GTM, and go/no-go readiness material | PM, EM, ProdOps |
| `/merchant-onboarding` *(WIP)* | Draft the merchant activation journey, open questions, owners, and SME handoff brief | PM, Ops, Implementations |
| `/settlement-readiness` *(WIP)* | Draft the settlement, reconciliation, exception, and money-movement readiness map and SME handoff brief | Product, Payments Ops, Finance |
| `/plan-ceo-review` | Strategic challenge of a plan's premise, scope, and ambition | PM, Leadership |
| `/plan-design-review` | Pre-implementation UX and design review for a plan or concept | PM, Design |
| `/plan-eng-review` | Technical architecture and feasibility review | EM, Architects |
| `/plan-devex-review` | Developer-experience review of a plan, workflow, or tooling change | EM, Platform |
| `/pdlc` | Navigate the PDLC — phases A–H, checkpoints 1–4, pathways, funding models | PM, EM, ProdOps |
| `/governance` | Prepare for governance ceremonies, checkpoints, and IT governance gates | PM, ProdOps, Leadership |
| `/privacy` | Prepare for privacy office review, DPIA-style analysis, and law/principle alignment | PM, Legal, Security |
| `/security-threat-model` | Prepare threat models, abuse cases, control gaps, and security-review material | EM, Architects, Security |
| `/security-controls` | Turn security findings into concrete controls, owner actions, and evidence plans | EM, Architects, Security |
| `/pci-review` | Prepare PCI DSS scope reviews, cardholder-data flow maps, and compliance-readiness material | EM, Architects, Risk |

## Engineering Workflow Skills

| Skill | Purpose | Typical user |
|-------|---------|--------------|
| `/autoplan` | Run the full strategic, design, technical, and DX review pipeline automatically | EM, Engineers |
| `/careful` | High-risk changes requiring extra validation | Engineers |
| `/checkpoint` | Save and review progress at key milestones | Engineers |
| `/investigate` | Deep-dive debugging and root cause analysis | Engineers |
| `/incident-response` | Coordinate live incident triage, containment, communications, and recovery | Engineers, EM, Ops |
| `/review` | Pre-landing code review with specialist checklists | Engineers |
| `/qa` | Quality assurance and test coverage | QA, Engineers |
| `/ship` | Ship to production with confidence | Engineers |
| `/retro` | Post-delivery retrospective | All |

## Design & Web Quality Skills

| Skill | Purpose | Typical user |
|-------|---------|--------------|
| `/design-review` | Review an implemented UI or flow for clarity, consistency, trust, and usability | Design, PM |
| `/web-quality-audit` | Full web quality audit across all dimensions | Engineers, QA |
| `/performance` | Core Web Vitals and runtime performance | Engineers |
| `/accessibility` | WCAG compliance and inclusive design | Engineers, Design |
| `/seo` | Search engine optimisation | Engineers, Marketing |
| `/best-practices` | General web best practices | Engineers |
| `/core-web-vitals` | LCP, INP, CLS deep dives | Engineers |

## Go-to-Market Skills

| Skill | Purpose | Typical user |
|-------|---------|--------------|
| `/gtm-messaging` | Positioning frameworks, messaging hierarchies, value propositions, campaign briefs, battle cards | Marketing, PM, Sales |
| `/deal-qualify` | MEDDIC/BANT deal qualification, account planning, deal strategy, pitch preparation | Sales, Sales Ops |
| `/proposal-write` | RFP responses, executive summaries, pricing narratives, proposal structure | Sales, Solution Consulting |

## Revenue Operations Skills

| Skill | Purpose | Typical user |
|-------|---------|--------------|
| `/sales-ops` | Pipeline health, forecast modeling, territory planning, quota modeling, CRM hygiene | Sales Ops, Sales Leadership |
| `/customer-success` | Customer health scores, churn risk, success plans, expansion mapping, customer QBRs | Customer Success, AM |
| `/solution-consulting` | Technical discovery, integration scoping, solution briefs, demo prep, POC planning | Solution Consulting, Pre-Sales |

## Risk Operations Skills

> Professional-domain skills — augment analysts, do not replace professional judgment.

| Skill | Purpose | Typical user |
|-------|---------|--------------|
| `/operational-risk` *(WIP)* | Risk registers, vendor risk, BCP, risk appetite, control assessments | Risk, Compliance |
| `/fraud-ops` *(WIP)* | Case triage, fraud rule analysis, SAR prep, chargeback management, pattern detection | Fraud Ops, Compliance |
| `/collections` *(WIP)* | Collections strategy, portfolio segmentation, recovery analysis, communication playbooks | Collections, Recoveries |
| `/credit-risk` *(WIP)* | Credit policy review, portfolio monitoring, scorecard interpretation, exposure analysis | Credit Risk, Underwriting |
| `/contract-review` | Pre-read assistant for contracts — flags clauses, explains jargon, prepares questions for counsel | Legal, PM, Procurement |
| `/support-ops` | Ticket triage, escalation playbooks, SLA reporting, knowledge base drafting | Support, Customer Ops |

Treat skills marked **WIP** as scaffolds: they should surface assumptions, open
questions, and needed SME input rather than claim a finished GP operating
process.

For `/braindump` and `/memory`, default to local files under `~/.copilot/`.
Only use `mempalace` when the machine and data are explicitly approved for local
semantic indexing; do not assume it is preinstalled or fully offline.

## Recommended Workflows

### Starting a new initiative
1. `/braindump` — capture rough ideas quickly if the thinking is still messy
2. `/office-hours` — pressure test the problem and idea
3. `/plan-ceo-review` — challenge the premise before committing
4. `/product-manager` — refine scope, prioritise features, define success metrics
5. `/customer-research` — validate assumptions with real customer evidence before committing too hard
6. `/business-case` — shape the investment narrative and funding recommendation
7. `/roadmap-plan` — turn strategy into a credible sequence with clear trade-offs
8. `/plan-design-review` — review UX assumptions if users touch it
9. `/plan-eng-review` — review feasibility and architecture
10. `/pdlc` — identify the lifecycle phase and pathway
11. `/governance` or `/privacy` — prepare the relevant review package

### Running customer discovery
1. `/product-manager` — clarify the problem, risky assumptions, and what decision the learning should inform
2. `/customer-research` — plan interviews, create a guide, or synthesise notes into findings
3. `/plan-design-review` — challenge concepts or UX hypotheses if the research touches solution design
4. `/roadmap-plan` or `/business-case` — turn the learning into sequencing or funding decisions
5. `/pdlc` — align the learning to discovery and checkpoint expectations when needed

### Planning the next quarter
1. `/product-manager` — confirm which outcomes and customer problems matter most
2. `/business-case` or `/pdlc funding` — clarify whether the work sits in funded roadmap capacity or needs a separate ask
3. `/roadmap-plan` — build the roadmap with committed, target, and exploratory work clearly separated
4. `/plan-eng-review` — pressure-test dependencies, sequencing, and technical feasibility
5. `/governance` — package the roadmap for QBR, big room planning, or review forums

### Preparing for launch
1. `/pdlc` — confirm launch-phase expectations and any remaining lifecycle gaps
2. `/launch-readiness` — assess support, monitoring, communications, rollout, and go/no-go readiness
3. `/qa` — validate launch-blocking quality risks and edge cases
4. `/ship` — execute the production-minded release workflow when the code is ready
5. `/governance` — package any checkpoint, review, or escalation material still needed

### Building and shipping
1. `/autoplan` — run the review pipeline automatically when appropriate
2. `/careful` — flag high-risk areas before coding
3. `/review` — review code before landing
4. `/qa` — validate quality and test coverage
5. `/ship` — deploy with confidence

### Preparing for privacy or governance review
1. `/pdlc` — confirm where the initiative sits in the lifecycle
2. `/business-case` — clarify the decision, investment logic, and funding ask
3. `/privacy` — map data, lawful basis, retention, transfers, and review questions
4. `/memory` — recall prior decisions or earlier review context if relevant
5. `/governance` — package the broader approval materials and dependencies

### Preparing for security review
1. `/plan-eng-review` — map the technical design and implementation shape
2. `/security-threat-model` — identify threats, abuse cases, and required controls
3. `/security-controls` — convert the risks into concrete controls, owners, and evidence expectations
4. `/privacy` — add privacy review if personal data is in scope
5. `/governance` — package the material for SIA, SDR, TAC, or broader governance

### Preparing for PCI review
1. `/plan-eng-review` — map where payment data, tokens, admin access, and dependencies exist
2. `/security-threat-model` — identify threat paths and control weaknesses around payment flows
3. `/pci-review` — assess likely scope, connected systems, vendor boundaries, and control gaps
4. `/governance` — package the material for compliance, architecture, or checkpoint review

### Handling a live incident
1. `/incident-response` — coordinate triage, impact, containment, and communications
2. `/investigate` — go deeper on root cause once the system is stabilised
3. `/privacy` or `/governance` — escalate if data exposure, audit, or formal review is involved
4. `/retro` — capture learning and follow-up after the incident is under control

## Installation Notes

For project-level distribution, copy only the skill directories you want into `.github/skills/`.
Keep this file at `.github/copilot-instructions.md` in the consuming repository.

---

## Contributing to This Repository

### Validation

Always run before opening a PR:

```bash
python3 .github/scripts/validate_skills.py
```

To run a single skill's frontmatter check, pass its path:

```bash
python3 .github/scripts/validate_skills.py  # validates the whole tree; there is no single-file mode
```

The validator enforces:
- Every `SKILL.md` has valid YAML frontmatter (`name`, `description`, `allowed-tools`)
- `name` in frontmatter **must exactly match the parent directory name**
- No machine-specific absolute home directory paths in prose (code blocks are exempt)
- No doubled-tilde paths (e.g. a home directory prefix written twice)
- All `/skill-name` references in prose point to a real skill directory or a known built-in

### SKILL.md Format

```yaml
---
name: skill-name          # must match directory name exactly
description: |
  What the skill does and when to invoke it. Keep ≤1024 chars —
  the Copilot CLI sidebar truncates longer descriptions, which
  silently removes the skill from the agent's context window.
allowed-tools:
  - Bash                  # add WebSearch if the skill needs it
---
```

### Skill Architecture — Where Does a New Skill Live?

| Location | When to use |
|----------|-------------|
| Top-level directory | Standalone skill that appears in the sidebar (16-slot budget — discuss before adding) |
| Inside a meta-skill directory (e.g. `strategy/`, `deliver/`) | Sub-skill loaded on demand; keeps sidebar lean |
| `on-demand/risk/` or `on-demand/utils/` | Specialised skill only needed in specific high-context sessions |
| `patterns/` | Recurring workflow observation — **not** a skill; format: `YYYY-MM-DD-{name}.md` |

### Adding a Skill — Checklist

1. Create `{skill-name}/SKILL.md` with correct frontmatter (name = directory name, description ≤1024 chars)
2. Update `CATALOG.md` — add entry to the correct tier table
3. Update `README.md` — add to the skill count and the relevant tier table
4. Update `.github/copilot-instructions.md` — add a row to the correct skill table so Copilot can invoke it
5. Update `ask/signals.md` — add a row to the correct domain section so `/ask` can route to the new skill
6. Run `python3 .github/scripts/validate_skills.py` — must pass with 0 errors
7. Commit on a feature branch and open a **draft PR** targeting `main`

### WIP Skills

Label incomplete skills clearly in frontmatter description and body:

```
*(WIP)* — surfaces assumptions and open questions; does not claim a finished process
```

Do not fill WIP skills with guessed enterprise process detail. Convert uncertainty into open questions and SME contribution prompts.

### patterns/ Directory

`patterns/` is for repeatable workflow observations surfaced by `/session-learn`. One file per pattern, named `YYYY-MM-DD-{name}.md`. Use statuses: `open`, `addressed`, `wont-fix`, `skill-candidate`. When a pattern crosses the signal threshold, use `/skill-forge` to build the full skill.
