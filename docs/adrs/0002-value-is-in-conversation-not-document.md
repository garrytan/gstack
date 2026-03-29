---
number: 0002
title: The value of ADRs is in the conversation, not the document
status: accepted
date: 2026-03-27
tags: [philosophy, core-design, anti-pattern]
trigger_conditions:
  - "If someone proposes auto-generating ADRs without human involvement"
  - "If the decision gate is modified to skip the user interaction step"
  - "If ADR creation is added to /autoplan as a fully autonomous step"
---

# 0002. The Value of ADRs Is in the Conversation, Not the Document

## Status

Accepted

## Context

The `/adr` skill is designed so that an AI agent drafts ADRs and an AI agent reads them. This creates a natural temptation: if the agent writes them and the agent reads them, why involve the human at all? The agent could auto-detect decisions, auto-generate ADRs with plausible-sounding tradeoff analysis, and auto-consume them in future sessions. Maximum efficiency, zero human effort.

This temptation will intensify as the skill gets forked and adapted. Someone will look at the decision gate's pause → explain → user input flow and think "this interruption is unnecessary — just have the agent decide and document."

This ADR exists to explain why that's wrong.

## Decision

The human must be an active participant in every ADR creation. The skill drafts, probes, and structures — but the human reviews, challenges, and approves. The decision gate pauses for human input. The `/adr` interactive mode asks questions the human must answer. No mode produces a final ADR without human approval.

The agent's role is to ask the hard questions that humans skip: "What are you giving up? Who else is affected? What happens when this assumption breaks?" The human's role is to answer honestly, push back when the framing is wrong, and ultimately own the decision.

## Alternatives Considered

### Alternative: Fully autonomous ADR generation
- **Description:** The agent detects architectural decisions during coding, generates complete ADRs (context, decision, alternatives, tradeoffs), and writes them to `docs/adr/` without human interaction.
- **Advantages:** Zero friction. No interruption to coding flow. Every decision gets documented. Consistent format and quality.
- **Disadvantages:** Produces documents that look like decision records but aren't. The agent can generate plausible-sounding tradeoff analysis for any decision — including the wrong one. An auto-generated ADR for "we chose DynamoDB" will list real tradeoffs (vendor lock-in, eventual consistency) but won't capture "we chose DynamoDB because the founder saw a conference talk about it last week and got excited" — which is the actual decision context that matters. The document exists but the thinking never happened.
- **Ruling rationale:** An ADR without a conversation is a rationalization, not a decision record. The agent is good at generating *plausible* reasoning. It is not good at generating *honest* reasoning about why a human made a choice. Only the human knows whether they weighed the tradeoffs or just went with their gut. The conversation is what forces the weighing.

### Alternative: Agent drafts, human rubber-stamps
- **Description:** The agent generates a complete ADR and presents it for approval. The human clicks "approve" or "reject."
- **Advantages:** Minimal human effort. Still technically involves human review.
- **Disadvantages:** A well-written auto-generated ADR is extremely easy to rubber-stamp. The human reads it, thinks "yeah, that sounds right," and approves. The tradeoffs section says reasonable things. The alternatives section lists real options. But the human never actually *thought* about whether those are the right tradeoffs or whether those alternatives were seriously considered — they just confirmed that the text looks plausible.
- **Ruling rationale:** Rubber-stamping is worse than no ADR at all, because it creates false confidence. A team with no ADRs knows they're flying blind. A team with auto-generated, rubber-stamped ADRs thinks they have architectural discipline when they actually have architectural theater.

## Tradeoffs

**Technical tradeoffs:**
- **What we gain:** ADRs that reflect actual human reasoning, not AI-generated plausibility.
- **What we lose:** Speed. Human involvement is slower than autonomous generation.
- **Why this tradeoff is acceptable:** An ADR that takes 10 minutes of real conversation is worth more than 100 auto-generated ADRs, because the 10-minute conversation is where the human actually thinks about whether this is the right decision. The document is a byproduct of the thinking. Without the thinking, the document is waste.

**Team and hiring tradeoffs:**
- **What we gain:** When a new team member reads an ADR, they're reading the output of a real decision process, not a generated justification. They can trust it.
- **What we lose:** Nothing.

**Business and operational tradeoffs:**
- **What we gain:** Decisions that were actually made, not retroactively documented.
- **What we lose:** Some decisions will go undocumented because the human skips the gate. This is acceptable — an incomplete set of real ADRs is better than a complete set of fake ones.

## Consequences

- The skill must be designed to resist the temptation to automate away the human. Every mode requires human input before producing a final ADR.
- The decision gate's "skip" option is essential — it respects human autonomy. But the gate must pause and explain, not silently proceed.
- The `/adr` interactive mode asks probing questions (especially about tradeoffs) that the human must engage with. The structure makes rubber-stamping harder because there are specific questions that demand specific answers.
- Future contributors who want to add an "auto" mode should read this ADR first. The question to ask is: "Does this mode produce ADRs where the human actually thought about the tradeoffs, or does it produce documents that look like someone did?"
- This principle extends beyond the ADR skill. Any gstack skill that produces documents meant to represent human judgment (design docs, strategy docs, review findings) should involve the human in the reasoning, not just the approval.

## Trigger Conditions

- If someone proposes an auto-generation mode for ADRs, revisit this ADR to confirm the reasoning still holds.
- If LLM capabilities advance to the point where agents can reliably determine *actual* human reasoning (not just plausible reasoning), this decision may need revisiting. Current LLMs cannot do this.
- If dogfood data shows that human-involved ADRs are consistently low-quality (rubber-stamped despite the structure), the problem may be in the probing questions, not in the principle. Fix the questions, don't remove the human.