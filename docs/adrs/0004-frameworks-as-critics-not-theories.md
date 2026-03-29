---
number: 0004
title: Narrative frameworks as panel of critics, not competing theories
status: accepted
date: 2026-03-27
tags: [social-skill, frameworks, review-mode]
trigger_conditions:
  - "If dogfood shows that certain frameworks consistently produce no useful critique and are just noise"
  - "If domain-specific frameworks emerge that should replace or supplement the general set"
  - "If the framework panel curation task concludes that the panel concept itself is wrong"
---

# 0004. Narrative Frameworks as Panel of Critics, Not Competing Theories

## Status

Accepted (design pattern accepted; specific panel members not yet curated — see note)

**Note:** This ADR covers the decision to use frameworks as a panel of complementary critics rather than as competing theories to select between. The specific thinkers comprising the panel are subject to a separate prerequisite research task (framework panel curation). The names mentioned below are candidates, not commitments.

## Context

The `/social-strategy` skill uses narrative frameworks (Godin, Sierra, Miller, Cialdini, Christensen) during content pillar development and draft review. The question is whether these frameworks should be treated as competing theories (select the best one for the situation, like `/strategist` does with Porter vs. Rumelt) or as complementary lenses (apply all relevant ones simultaneously).

The `/strategist` skill's framework selection is the precedent within gstack. It diagnoses the situation and selects the most appropriate competitive strategy framework. This works because the strategy frameworks genuinely lead to different analyses — a Porter analysis of industry structure is a fundamentally different exercise than a Wardley map of value chains.

The narrative frameworks serve a different purpose. They're not analytical tools for understanding a market — they're cognitive reframing devices that break founders out of the default "let me tell you about my thing" mode.

## Decision

Apply all relevant narrative frameworks simultaneously as a panel of named critics. Each framework critiques the same content through its own lens. Not every framework applies to every draft — the skill applies the ones that have something meaningful to say. This differs from the `/strategist` pattern of selecting one framework.

## Alternatives Considered

### Alternative: Framework selection (strategist pattern)
- **Description:** Diagnose the founder's situation, select 1-2 most relevant frameworks, apply only those throughout the engagement.
- **Advantages:** Consistent with the `/strategist` design pattern. Simpler for the user to understand. Less noise in review output.
- **Disadvantages:** The narrative frameworks catch different failure modes. Godin catches value exchange problems. Sierra catches authenticity and audience empowerment problems. Miller catches hero framing. Cialdini catches persuasion mechanics. Christensen catches job-to-be-done framing. Selecting only one or two means missing failure modes that the unselected frameworks would catch. Unlike competitive strategy frameworks, these aren't competing analyses of the same problem — they're different questions about the same content.
- **Ruling rationale:** A Godin critique and a Sierra critique of the same draft are not redundant. One asks "where's the value exchange?" and the other asks "does the reader leave more capable?" Both can be true simultaneously. Selecting one would mean missing the other's insight.

### Alternative: Framework-agnostic review (no named frameworks)
- **Description:** Review content against general best practices without naming specific frameworks. Just evaluate: is this valuable? Is this authentic? Does this serve the audience?
- **Advantages:** Simpler. No framework knowledge required. Less academic feel.
- **Disadvantages:** Loses the cognitive reframing power that is the whole point. The named frameworks give the founder specific mental models they can internalize and apply when writing. "Think about what Godin would say" is a portable tool the founder can use without the skill. "Make sure your content is valuable" is advice so generic it's useless.
- **Ruling rationale:** The frameworks' value is precisely that they're named, memorable, and each carry a specific question. A founder who internalizes "would my audience thank me for this?" (Godin) and "does the reader leave more capable?" (Sierra) has durable tools for self-editing. Generic advice doesn't stick.

## Tradeoffs

**Technical tradeoffs:**
- **What we gain:** Each piece of content gets evaluated from multiple angles. Failure modes that one framework would miss get caught by another.
- **What we lose:** Review output is longer and potentially noisier. If 4 frameworks all critique the same draft, that's a lot of feedback.
- **Why this tradeoff is acceptable:** The skill only applies frameworks that have something meaningful to say. A brief congratulatory announcement might trigger Godin (no value exchange) and Miller (founder as hero) but not Christensen (the JTBD framing isn't relevant here). The output is filtered, not exhaustive.

**Business and operational tradeoffs:**
- **What we gain:** Founders internalize multiple mental models for content evaluation, making them better writers independently of the tool.
- **What we lose:** Slight learning curve — the founder needs to understand 5 frameworks, not 1.
- **Why this tradeoff is acceptable:** The frameworks are introduced during the interactive session (Step 3) with brief explanations. They're not academic deep-dives — each one is a single question. The learning cost is minimal.

## Consequences

- Review mode output uses named framework attributions: "*Godin:* Where's the value exchange?" — not anonymous critique. The names are the interface.
- Content pillars are annotated with which framework lens they serve, creating a traceable connection between strategy and execution.
- The framework set (Godin, Sierra, Miller, Cialdini, Christensen) is the v1 set. It may need expansion for domain-specific contexts or contraction if some frameworks consistently add no value. A post-dogfood TODO covers this.
- This design decision explicitly diverges from the `/strategist` pattern. Future contributors should understand this is intentional, not an oversight.

## Trigger Conditions

- If dogfood shows that one or more frameworks consistently produce no useful critique across multiple sessions and content types, they should be dropped from the default set.
- If domain-specific frameworks emerge (e.g., regulatory communication frameworks for health tech, developer relations frameworks for devtools), they may supplement or replace the general set for specific industries.
