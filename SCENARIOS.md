# Scenarios — When and How to Use Copilot Skills

Real-world scenarios showing how Global Payments teams use Copilot skills in their
day-to-day work. Written for product managers, designers, and leadership — no
technical background required.

---

## 📋 Table of Contents

1. [I have an idea for a new product feature](#scenario-1-i-have-an-idea-for-a-new-product-feature)
2. [I need to prepare for a governance checkpoint](#scenario-2-i-need-to-prepare-for-a-governance-checkpoint)
3. [My executive asked me to justify this initiative](#scenario-3-my-executive-asked-me-to-justify-this-initiative)
4. [I'm writing a product brief](#scenario-4-im-writing-a-product-brief)
5. [I need to decide: business case or product funding?](#scenario-5-i-need-to-decide-business-case-or-product-funding)
6. [I'm preparing for a Quarterly Business Review](#scenario-6-im-preparing-for-a-quarterly-business-review)
7. [I want to prioritise my backlog](#scenario-7-i-want-to-prioritise-my-backlog)
8. [My team is about to ship — is everything ready?](#scenario-8-my-team-is-about-to-ship--is-everything-ready)
9. [I need to check if our product meets accessibility standards](#scenario-9-i-need-to-check-if-our-product-meets-accessibility-standards)
10. [I want to run a retro after a major release](#scenario-10-i-want-to-run-a-retro-after-a-major-release)
11. [I'm a designer reviewing web performance](#scenario-11-im-a-designer-reviewing-web-performance)
12. [I need to understand where we are in the PDLC](#scenario-12-i-need-to-understand-where-we-are-in-the-pdlc)
13. [I'm onboarding to a new product area](#scenario-13-im-onboarding-to-a-new-product-area)
14. [I need to challenge a plan before it goes to leadership](#scenario-14-i-need-to-challenge-a-plan-before-it-goes-to-leadership)
15. [I need to prepare for a privacy office review](#scenario-15-i-need-to-prepare-for-a-privacy-office-review)
16. [I need to prepare for a security design review](#scenario-16-i-need-to-prepare-for-a-security-design-review)
17. [We have a live incident and need to respond fast](#scenario-17-we-have-a-live-incident-and-need-to-respond-fast)
18. [I need to shape next quarter's roadmap](#scenario-18-i-need-to-shape-next-quarters-roadmap)
19. [I need to validate an idea with customers before I commit](#scenario-19-i-need-to-validate-an-idea-with-customers-before-i-commit)
20. [I need to know whether this payment change is in PCI scope](#scenario-20-i-need-to-know-whether-this-payment-change-is-in-pci-scope)
21. [We are approaching go-live and need a real launch readout](#scenario-21-we-are-approaching-go-live-and-need-a-real-launch-readout)
22. [I know the risks — now I need the right control plan](#scenario-22-i-know-the-risks--now-i-need-the-right-control-plan)
23. [Planned / WIP skills](#planned--wip-skills)

---

## Scenario 1: I have an idea for a new product feature

**You are:** Product Manager
**Situation:** A client has requested a feature and you think it has merit, but you're
not sure if it's worth pursuing or how it fits into the roadmap.

**What to do:**

```
/product-manager
```

Tell Copilot about the feature idea. It will:
- Ask you to describe the **customer problem** (not the solution) first
- Challenge you: Is this a real pain point or a nice-to-have?
- Help you frame it using **RICE or ICE scoring** so you can compare it to other backlog items
- Ask about strategic alignment: Does this map to a current OKR?
- Suggest whether this belongs in Product Intake & Triage or can be handled within existing capacity

**What you'll get:** A structured assessment of whether to pursue the idea, how to
position it, and what to prepare if you want to take it forward.

---

## Scenario 2: I need to prepare for a governance checkpoint

**You are:** Product Manager or Product Ops
**Situation:** Your initiative is approaching Checkpoint 2 (Product Development Greenlight)
and you need to make sure everything is in order.

**What to do:**

```
/pdlc checkpoint 2
```

This shows you exactly what artefacts and approvals are needed. Then:

```
/governance
```

This helps you:
- Structure your submission using the **DARE framework** (who is the Decider, Advisor, Recommender, Executer?)
- Build a checkpoint readiness checklist
- Identify gaps before you walk into the room
- Format your materials for the specific audience

**What you'll get:** A governance-ready package with clear owners, decisions needed,
and supporting evidence — structured so reviewers can say yes quickly.

---

## Scenario 3: My executive asked me to justify this initiative

**You are:** Product Manager or Sub-domain Lead
**Situation:** Leadership wants to know why this initiative matters, why now, and what
we're saying no to by doing it.

**What to do:**

```
/plan-ceo-review
```

Paste or describe your plan. Copilot will apply a **CEO lens** — the kind of scrutiny
a chief executive would bring:
- Why does this matter to the business?
- What's the opportunity cost?
- Is the scope right or are we boiling the ocean?
- What's the 90-day version vs the 12-month vision?
- Where are the hidden risks?

**What you'll get:** A battle-tested version of your plan with the weak spots identified
and concrete suggestions for strengthening the narrative.

**Pro tip:** Run this *before* your executive asks. It's much better to find the gaps
yourself than to be surprised in a review.

---

## Scenario 4: I'm writing a product brief

**You are:** Product Manager
**Situation:** You need to write a product brief for a new initiative that will evolve
through Checkpoints 1–4.

**What to do:**

```
/product-manager
```

Tell Copilot you're writing a product brief. It will guide you through:
- **Problem statement** — Written from the customer's perspective
- **Success metrics** — How will we know this worked?
- **Scope** — What's in, what's explicitly out
- **Assumptions and risks** — What could go wrong
- **Dependencies** — Who else needs to be involved

Then check your brief against the lifecycle:

```
/pdlc phase B
```

This confirms your brief covers everything needed for the Discovery phase.

**What you'll get:** A structured product brief that's ready for stakeholder review
and aligned to PDLC requirements.

---

## Scenario 5: I need to decide: business case or product funding?

**You are:** Product Manager or Finance partner
**Situation:** A new initiative needs funding and you're not sure whether to write a
traditional business case or use the product funding envelope.

**What to do:**

```
/business-case funding
```

Copilot will help you evaluate:
- Is this a **one-off initiative** with a discrete scope? → Standalone business case
- Is this part of an **existing product's ongoing investment**? → Product funding envelope
- Does this align to **already-funded OKRs**? → Reference the existing envelope
- Is the scope likely to **evolve based on customer learning**? → Product funding (more flexible)

If a standalone case is needed, continue with:

```
/business-case
```

**What you'll get:** A clear recommendation on which funding path to take, plus a draft
investment narrative if a business case is required.

---

## Scenario 6: I'm preparing for a Quarterly Business Review

**You are:** Sub-domain Lead or Product Ops
**Situation:** QBR is next week and you need to pull together OKR progress, metrics,
and the narrative for your domain.

**What to do:**

```
/governance
```

Tell Copilot you're preparing for QBR. It will help you structure:
- **OKR progress summary** at domain and product level
- **Key metrics and trends** — what's improving, what's at risk
- **Decisions needed** — framed with DARE roles
- **Forward look** — priorities for next quarter and any re-allocation requests

For the strategic narrative:

```
/product-manager
```

This helps you frame the story: Why are we where we are? What did we learn?
What are we doing about it?

**What you'll get:** A QBR-ready deck structure with clear talking points, risk callouts,
and decision asks.

---

## Scenario 7: I want to prioritise my backlog

**You are:** Product Manager
**Situation:** You have 30 items in your backlog and need to decide what makes the cut
for next quarter.

**What to do:**

```
/product-manager
```

Describe your backlog or paste the list. Copilot will help you:
- Apply **RICE scoring** (Reach, Impact, Confidence, Effort) to each item
- Or use **ICE scoring** (Impact, Confidence, Ease) for faster assessment
- Group items by theme and strategic alignment
- Identify quick wins vs strategic bets
- Flag items that don't align to any current OKR

**What you'll get:** A prioritised, scored backlog with a clear rationale for the
top items and a "not now" list with reasons.

---

## Scenario 8: My team is about to ship — is everything ready?

**You are:** Engineering Manager or Product Manager
**Situation:** The engineering team says the feature is ready. You want to make sure
nothing is being missed before it goes live.

**What to do:**

The engineering team uses:

```
/qa        — Check test coverage and edge cases
/review    — Final code review with specialist checklists
/ship      — Production deployment checklist
```

As PM, you use:

```
/pdlc phase E
```

This checks Operational Readiness: Are support paths defined? Is monitoring in place?
Are rollback plans documented? Is the go-to-market plan ready?

**What you'll get:** Confidence that both the technical and operational sides are
covered before the feature reaches customers.

---

## Scenario 9: I need to check if our product meets accessibility standards

**You are:** UX/UI Designer or Product Manager
**Situation:** You want to ensure your web application is accessible to all users,
including those with disabilities.

**What to do:**

```
/accessibility
```

Copilot will audit against **WCAG standards** and check:
- Colour contrast ratios
- Keyboard navigation
- Screen reader compatibility
- Focus management
- ARIA attributes
- Form labels and error messages

For a broader check that includes accessibility alongside other quality dimensions:

```
/web-quality-audit
```

**What you'll get:** A detailed report of accessibility issues ranked by severity,
with specific fix recommendations and code examples where applicable.

---

## Scenario 10: I want to run a retro after a major release

**You are:** Product Manager, Engineering Manager, or Scrum Master
**Situation:** Your team just shipped a major feature and you want to capture what
worked and what to improve.

**What to do:**

```
/retro
```

Copilot facilitates a structured retrospective:
- What went well?
- What didn't go well?
- What should we change?
- Action items with owners

It also helps you identify **systemic patterns** — issues that keep recurring across
retros — rather than just surface-level symptoms.

**What you'll get:** A retro summary with prioritised action items and patterns to
watch, ready to share with the team.

---

## Scenario 11: I'm a designer reviewing web performance

**You are:** UX/UI Designer
**Situation:** Users are complaining the app feels slow. You want to understand the
performance impact of recent design changes.

**What to do:**

```
/performance
```

Or for specific metrics:

```
/core-web-vitals
```

These skills check:
- **LCP** (Largest Contentful Paint) — How fast does the main content appear?
- **INP** (Interaction to Next Paint) — How responsive is the page to clicks and taps?
- **CLS** (Cumulative Layout Shift) — Do things jump around while loading?

Copilot will identify which design elements (large images, web fonts, animations,
layout shifts) are contributing to poor scores and suggest alternatives that maintain
the design intent while improving speed.

**What you'll get:** Actionable performance insights tied to specific design decisions,
with before/after recommendations.

---

## Scenario 12: I need to understand where we are in the PDLC

**You are:** Anyone on the product team
**Situation:** You've joined a project mid-stream or you've lost track of what phase
you're in and what's needed next.

**What to do:**

```
/pdlc assess
```

Describe your project's current state — what artefacts exist, what milestones have
been passed, what's in progress. Copilot will:
- Identify your **current phase** (A–H)
- Determine your **pathway** (one of 8 — from New Product Introduction to BAU)
- Show which **checkpoints** are mandatory, optional, or not required for your pathway
- List **gaps** — what's missing or incomplete for your current phase
- Recommend **next actions** with clear owners (using RACI)

**What you'll get:** A clear status report: "You are in Phase C (Design & Analysis),
on the New Feature pathway. Checkpoint 2 is mandatory. You're missing X, Y, and Z."

---

## Scenario 13: I'm onboarding to a new product area

**You are:** New Product Manager, Engineer, or Designer joining a team
**Situation:** You're new to a product area and need to get up to speed quickly on
the initiative's status, strategy, and processes.

**What to do:**

Start with the big picture:

```
/product-manager
```

Ask Copilot to help you build an onboarding checklist for the product area. It will
prompt you to gather:
- Current OKRs and how they map to domain/enterprise strategy
- Active initiatives and their PDLC phase
- Key stakeholders and the 2-in-a-box/3-in-a-box structure
- Upcoming governance checkpoints or QBRs
- Known risks and dependencies

Then for process context:

```
/pdlc
```

This gives you the full lifecycle map so you understand where each initiative sits
and what's expected next.

**What you'll get:** A structured onboarding brief that gets you productive in days
rather than weeks.

---

## Scenario 14: I need to challenge a plan before it goes to leadership

**You are:** Product Manager, Sub-domain Lead, or peer reviewer
**Situation:** A colleague has asked you to review their plan before they present it
to leadership. You want to give genuinely useful feedback.

**What to do:**

```
/plan-ceo-review
```

Paste the plan. Copilot applies a rigorous strategic lens:
- Is the problem statement clear and compelling?
- Does the solution match the problem's scale?
- Are the success metrics meaningful (not vanity metrics)?
- What's the "Step 0" question — should we even be doing this?
- What are the top 3 risks that aren't addressed?

Then for product-specific feedback:

```
/product-manager
```

This adds the customer lens:
- Will this actually solve a customer problem?
- Is the scope right-sized for the value delivered?
- Are we building the right thing, not just building the thing right?

**What you'll get:** Constructive, structured feedback that helps your colleague
strengthen their plan before the high-stakes meeting.

---

## Scenario 15: I need to prepare for a privacy office review

**You are:** Product Manager, Product Ops, Legal partner, or Engineering Manager
**Situation:** A feature or workflow touches personal data and you need to prepare for
privacy-office questions before governance or launch.

**What to do:**

```
/privacy
```

Describe the feature, the data involved, and any third parties or analytics tools in
scope. Copilot will help you structure:

- The **personal data inventory** — what is collected, inferred, shared, stored, or deleted
- The **purpose and likely lawful basis** — why the data is needed and what legal framing may apply
- **Retention and deletion** expectations
- **Transfer and vendor** questions, including cross-border concerns
- **DPIA-style escalation triggers** such as profiling, monitoring, sensitive data, or children’s data

If the initiative is part of a wider approval package, then run:

```
/governance
```

This helps you package the privacy content alongside the broader checkpoint or governance
materials.

**What you'll get:** A reviewer-ready privacy prep pack with clear gaps, open questions,
and a recommendation on whether the work looks like a standard review or needs deeper
privacy escalation.

---

## Scenario 16: I need to prepare for a security design review

**You are:** Engineering Manager, Product Manager, Architect, or Security partner
**Situation:** A feature, service, or integration is moving toward TAC, SDR, or a wider
security review and you want to surface the real risks before the reviewers do.

**What to do:**

```
/security-threat-model
```

Describe the system or change in scope. Copilot will help you structure:

- The **system context and trust boundaries** — what talks to what, and where the risk boundaries sit
- The **assets and entry points** — secrets, admin paths, APIs, uploads, third parties, customer data
- **Abuse cases and likely attack paths** — not just intended use
- **Control gaps** — what exists, what is missing, and what needs ownership
- **Escalation triggers** — whether this looks like it needs deeper security-architecture scrutiny

If the initiative is also moving through the formal governance pipeline, then run:

```
/governance sdr
```

**What you'll get:** A reviewer-ready threat-model pack with clear abuse cases, missing
controls, residual risks, and the next security review action.

---

## Scenario 17: We have a live incident and need to respond fast

**You are:** Engineering Manager, Incident Lead, Product Manager, or Operations partner
**Situation:** A service is degraded, there may be customer impact, and the team needs a
clear response structure right now.

**What to do:**

```
/incident-response
```

Tell Copilot what is happening, what you know so far, and what the current impact looks
like. It will help you structure:

- **Severity and impact** — what is affected, how bad it is, and who needs to know now
- **Containment actions** — the smallest safe move to reduce harm quickly
- **Evidence and timeline** — what to preserve before systems change further
- **Communication updates** — facts, unknowns, hypotheses, and the next update time
- **Recovery checks and follow-up actions** — what must be true before the incident is stable

If the incident points to deeper technical diagnosis, then follow with:

```
/investigate
```

If the incident may involve personal data or regulatory exposure, also use:

```
/privacy
```

**What you'll get:** A structured incident-response pack you can use in the moment,
plus a clearer path from triage to containment to recovery.

---

## Scenario 18: I need to shape next quarter's roadmap

**You are:** Product Manager, Engineering Manager, Product Ops, or Domain Lead
**Situation:** You have more asks than capacity and need a roadmap for next quarter that
is realistic, explainable, and aligned to your goals.

**What to do:**

```
/roadmap-plan quarter
```

Describe the outcomes you need to hit, the major initiatives in play, key dependencies,
and any hard constraints such as governance, privacy, security, or platform commitments.
Copilot will help you structure:

- The **strategic anchors** — the OKRs, customer problems, risks, or commitments driving the roadmap
- The **roadmap by horizon** — what is committed now, what is target next, and what stays later
- **Dependencies and sequencing** — what must happen first, and what could slip the plan
- The **not now list** — what is explicitly deferred so the roadmap stays credible
- **Confidence and change triggers** — what would force a replan

If you still need to justify the investment or funding path, then use:

```
/business-case
```

If you need to align the roadmap to lifecycle checkpoints or governance ceremonies, then use:

```
/pdlc
/governance
```

**What you'll get:** A stakeholder-ready roadmap pack with clear sequencing, trade-offs,
confidence levels, and decisions that still need to be made.

---

## Scenario 19: I need to validate an idea with customers before I commit

**You are:** Product Manager, Designer, Product Ops, or Engineering Manager
**Situation:** You have a promising idea, but you do not want to commit roadmap space or
funding before hearing from the right customers.

**What to do:**

```
/customer-research plan
```

Describe the decision you need to make, the assumptions you are carrying, and who you
think the target customers or users are. Copilot will help you structure:

- The **learning goals** — what you most need to learn before deciding
- The **participant strategy** — who to speak to, who not to over-index on, and why
- A **neutral discussion guide** — questions that surface real behaviour instead of polite agreement
- The **evidence model** — how to separate quotes, observations, themes, and decisions
- The **next step** — what should change in the brief, roadmap, or funding case if the research confirms or challenges your assumptions

If you already have notes or transcripts, continue with:

```
/customer-research synthesis
```

If the learning will affect roadmap or funding choices, then use:

```
/roadmap-plan
/business-case
```

**What you'll get:** A lightweight research pack that helps you validate the idea,
reduce assumption risk, and turn customer input into a clearer decision.

---

## Scenario 20: I need to know whether this payment change is in PCI scope

**You are:** Product Manager, Engineering Manager, Architect, or Risk / Compliance partner
**Situation:** A change touches payment capture, cardholder data, tokenization, payment
APIs, or settlement flows, and you need to know what is likely in PCI scope before
committing to delivery or review.

**What to do:**

```
/pci-review
```

Describe the feature or change, the payment flow, any third parties involved, and where
cardholder data or tokens may appear. Copilot will help you structure:

- The **payment-data flow** — where PAN, tokens, logs, screenshots, exports, or admin paths may be involved
- The **scope view** — what looks in scope, connected to scope, or unsafe to treat as out of scope
- The **control gaps** — access, segmentation, encryption, monitoring, change control, and vendor boundaries
- The **evidence list** — what reviewers will expect to see before they trust the scope claim
- The **next step** — what needs redesign, escalation, or tighter controls before moving on

If the same change also needs a wider security review, continue with:

```
/security-threat-model
```

If the output needs to be packaged for a broader checkpoint or review forum, then use:

```
/governance
```

**What you'll get:** A reviewer-ready PCI prep pack with a clearer view of CDE scope,
data-flow risk, control ownership, and what still needs escalation.

---

## Scenario 21: We are approaching go-live and need a real launch readout

**You are:** Product Manager, Engineering Manager, Product Ops, or Launch lead
**Situation:** The feature is close, but you need a cross-functional view of whether the
launch is actually ready — not just whether the code is merged.

**What to do:**

```
/launch-readiness
```

Describe what is launching, to whom, the rollout shape, and what you currently know
about support, monitoring, customer communications, and rollback plans. Copilot will help you structure:

- The **launch scope and rollout shape** — pilot, beta, limited GA, or full launch
- The **operational readiness picture** — monitoring, runbooks, support routing, incident ownership, and rollback controls
- The **customer and commercial readiness** — enablement, docs, comms, onboarding, and stakeholder alignment
- The **go/no-go criteria** — what must be true before launch and what would trigger a pause
- The **owner action list** — which gaps are still blocking confidence

If you need to confirm where this sits in the lifecycle, use:

```
/pdlc phase E
```

If you need to validate the technical release mechanics too, continue with:

```
/qa
/ship
```

**What you'll get:** A launch-readiness pack with clear blockers, named owners, go/no-go
criteria, and a more defensible launch decision.

---

## Scenario 22: I know the risks — now I need the right control plan

**You are:** Engineering Manager, Architect, Security partner, or Product Manager
**Situation:** You already have security findings, a threat model, or reviewer questions,
but now the team needs a concrete control plan with real owners and evidence.

**What to do:**

```
/security-controls
```

Describe the system, the main risks or findings, and any known review context such as
SDR, SIA, ATO, PCI, or incident follow-up. Copilot will help you structure:

- The **risk-to-control mapping** — what each control is actually meant to prevent, detect, or recover from
- The **control mix** — preventive, detective, recovery, and governance controls
- The **ownership model** — who implements, who validates, and who depends on another team
- The **evidence plan** — what reviewers will need to see before they trust the controls
- The **residual risk view** — what is still open, compensating, or not yet strong enough

If you still need to sharpen the threat picture first, use:

```
/security-threat-model
```

If the controls need to be packaged for governance or ATO review, continue with:

```
/governance
```

**What you'll get:** A reviewer-ready security control plan with clearer ownership,
evidence, gaps, and next actions.

---

## Planned / WIP Skills

### `/merchant-onboarding` (WIP)

This skill is currently a scaffold rather than a finished GP playbook. Use it
when you need to map the journey from merchant approval or contract signature to
first live transaction, capture assumptions, and assemble the open questions for
SMEs in onboarding, underwriting, risk, implementation, support, and payments
operations.

```
/merchant-onboarding
```

It will help you produce a high-level journey map, owner view, blocker list, and
contribution brief. Treat the output as a draft to validate and extend with
domain experts before using it as an operating process.

### `/settlement-readiness` (WIP)

This skill is currently a scaffold rather than a finished GP playbook. Use it
when you need to map the journey from approved or captured transaction to funds
settled, reconciled, reported, and supported correctly, while capturing the open
questions for SMEs in payments operations, reconciliation, finance, treasury,
support, and risk.

```
/settlement-readiness
```

It will help you produce a high-level settlement journey map, owner view,
exception list, and contribution brief. Treat the output as a draft to validate
and extend with domain experts before using it as an operating process.

---

## Quick Reference: Which Skill When?

| I need to... | Use this skill |
|--------------|---------------|
| Challenge a plan's premise | `/plan-ceo-review` |
| Capture rough ideas without critique | `/braindump` |
| Recall past decisions or context | `/memory` |
| Think through a product problem | `/product-manager` |
| Plan or synthesise customer research | `/customer-research` |
| Prepare a business case or decision memo | `/business-case` |
| Shape a roadmap or next-quarter plan | `/roadmap-plan` |
| Review a plan's UX before build | `/plan-design-review` |
| Review developer workflow or tooling experience | `/plan-devex-review` |
| Navigate the PDLC | `/pdlc` |
| Prepare for governance | `/governance` |
| Prepare for privacy review | `/privacy` |
| Prepare for a security review or threat model | `/security-threat-model` |
| Turn security findings into an owned control plan | `/security-controls` |
| Prepare for a PCI scope or cardholder-data review | `/pci-review` |
| Prepare for launch or go-live readiness | `/launch-readiness` |
| Draft a merchant onboarding journey and open-question set *(WIP)* | `/merchant-onboarding` |
| Draft a settlement and reconciliation readiness map *(WIP)* | `/settlement-readiness` |
| Review architecture | `/plan-eng-review` |
| Prioritise my backlog | `/product-manager` |
| Audit an implemented user flow | `/design-review` |
| Check web accessibility | `/accessibility` |
| Audit web performance | `/performance` |
| Run a full quality check | `/web-quality-audit` |
| Plan implementation work | `/autoplan` |
| Review code before landing | `/review` |
| Ship to production | `/ship` |
| Run a retrospective | `/retro` |
| Debug a problem | `/investigate` |
| Coordinate a live incident | `/incident-response` |
| Prepare for QBR | `/governance` |
| Decide on funding model | `/business-case funding` |

---

## Tips for Getting the Most Out of Skills

1. **Be specific.** "Review my plan" gives okay results. "Review my plan for the Como
   loyalty feature — we're targeting Checkpoint 2 next month" gives great results.

2. **Compose skills.** Use `/plan-ceo-review` then `/product-manager` then `/business-case` then `/pdlc` in
   sequence for a thorough initiative review.

3. **Challenge the output.** Skills are coaching tools, not oracles. Push back if
   something doesn't fit your context.

4. **Share scenarios.** When you find a skill combination that works well, share it
   with your team. The best workflows are discovered through use.

5. **Iterate.** Skills get better the more context you provide. Start with a rough
   description and refine as Copilot asks clarifying questions.
