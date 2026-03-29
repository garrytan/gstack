---
number: 0005
title: Framework panel requires faithful representation and justified selection
status: accepted
date: 2026-03-27
tags: [social-skill, frameworks, prerequisite]
trigger_conditions:
  - "If the framework panel curation task is deprioritized or skipped"
  - "If someone adds a thinker to the panel without the justification work"
---

# 0005. Framework Panel Requires Faithful Representation and Justified Selection

## Status

Accepted

## Context

During the design of the `/social-strategy` skill's narrative framework panel, an initial set of five thinkers was proposed (Godin, Sierra, Miller, Cialdini, Christensen) with one-line heuristics for each: "Where's the value exchange?" (Godin), "Does the reader leave more capable?" (Sierra), etc.

On review, these reductions were recognized as unfaithful to the thinkers' actual work:

- Godin's thinking spans Permission Marketing, Purple Cow, Tribes, The Practice, and This Is Marketing. The thread through his work is about earning the privilege of attention through relevance and generosity — not about transactional "value exchange." Describing his framework as "where's the value exchange?" misrepresents him as more transactional than he is.
- Sierra's work on making users badass is about their internal experience of competence, growth, and empowerment — a richer idea than "does the reader leave more capable?"
- Christensen's JTBD framework is one piece of a larger body of work. His disruption theory and work on innovator's dilemma belong in `/strategist`, not `/social-strategy`. Using "Christensen" without specifying "the JTBD piece specifically" risks applying the wrong lens.
- The selection of these five thinkers was not justified — they were chosen because they came to mind, not through principled analysis of which thinkers' frameworks most usefully address founder communication failure modes. Notable omissions were not evaluated (Handley, Schwartz, Moore).

The core problem: if the skill invokes thinkers by name, it must represent them with enough fidelity that someone who has actually read their work wouldn't wince. One-line heuristics generated from AI training data do not meet this standard.

## Decision

The framework panel is a prerequisite research task, not a design-time decision. The specific thinkers, which parts of their work apply, and how they're represented in the skill must be determined through actual engagement with the source material. The design doc specifies the design intent (a curated panel of critics addressing distinct failure modes) and lists candidates, but does not commit to specific names or heuristics.

Steps 3 (narrative framework orientation), 4 (framework-informed content pillars), and the review mode's audience value criterion are blocked until this research is complete. The audit mode, voice fingerprinting, and style guide are independent and can be built and dogfooded without frameworks.

## Alternatives Considered

### Alternative: Ship with the initial five-name panel and one-line heuristics
- **Description:** Use the proposed Godin/Sierra/Miller/Cialdini/Christensen panel with simplified core questions. Refine the representations through dogfooding.
- **Advantages:** Concrete. Gives the planning pipeline something specific to challenge. Allows all skill modes to be built immediately. Even simplified representations provide more useful review feedback than no frameworks at all.
- **Disadvantages:** The simplified representations risk calcifying. Once they're in the skill template and producing useful-seeming output, there's no forcing function to go back and deepen them. The one-line heuristics become the permanent representation because they're "good enough." Additionally, invoking thinkers by name while misrepresenting their work is worse than not invoking them — it creates false authority. A review that says "Godin would ask: where's the value exchange?" sounds authoritative but attributes a framing to Godin that he might not endorse.
- **Ruling rationale:** The risk of permanent simplification is real and supported by the general pattern of TODOs that never get done. The "good enough" failure mode is especially likely here because the simplified heuristics *do* produce useful review output — they just do so by putting words in named thinkers' mouths. Blocking the framework-dependent features until the research is done creates the forcing function that a TODO wouldn't.

### Alternative: Use unnamed frameworks (avoid the fidelity problem entirely)
- **Description:** Define the failure modes and core questions without attributing them to named thinkers. "Is this self-promotional without audience value?" instead of "Godin would ask..."
- **Advantages:** Avoids the fidelity problem completely. No risk of misrepresentation.
- **Disadvantages:** Loses the cognitive portability of named frameworks. A founder who internalizes "think about what Godin would say" has a durable mental model they can apply without the tool. A founder who internalizes "is this self-promotional?" has generic advice that doesn't stick. The names give the questions weight, memorability, and a body of work the founder can explore further.
- **Ruling rationale:** The names are valuable precisely because they point to real bodies of work. But this value only holds if the pointer is accurate. An inaccurate pointer (invoking Godin but misrepresenting his thinking) is worse than no pointer, because it closes the door to the real insight. The solution is to get the pointers right, not to remove them.

## Tradeoffs

**Technical tradeoffs:**
- **What we gain:** When the framework panel ships, each thinker will be represented faithfully — someone who has read their work will recognize the representation as accurate. The review mode's authority comes from real understanding, not AI-generated summaries.
- **What we lose:** Three features are blocked: content pillar generation, framework-informed review, and the narrative framework orientation step. These are significant — they're core differentiators of the skill.
- **Why this tradeoff is acceptable:** The blocked features depend on getting the frameworks right. Shipping them with unfaithful representations would produce output that sounds authoritative but misrepresents the source material. The audit mode, voice fingerprinting, and style guide are substantial enough to dogfood without frameworks.

**Business and operational tradeoffs:**
- **What we gain:** The framework research is also valuable for the founder personally — engaging with Godin, Sierra, et al. as source material is directly useful for developing a social media strategy, independent of the skill.
- **What we lose:** Time. The research task requires reading (or re-reading) primary sources, not just summarizing.
- **Why this tradeoff is acceptable:** This is a "sharpen the axe" investment. The research makes both the skill and the founder's own content strategy better.

## Consequences

- The framework panel curation is a P1 prerequisite task. It cannot be deprioritized without accepting that three skill features remain unimplemented.
- The task explicitly requires human engagement with source material. An AI summarizing its training data on these thinkers is the failure mode this ADR is designed to prevent.
- Future contributors who want to add a thinker to the panel must provide the same level of justification: which works, which ideas apply, what failure mode they uniquely catch, and why their inclusion is better than the alternatives.
- The candidates list (Godin, Sierra, Miller, Cialdini, Christensen, Handley, Schwartz, Moore) is a starting point, not a commitment. The research may conclude that some candidates don't belong and others not yet considered do.

## Trigger Conditions

- If the framework panel curation task is deprioritized below P1 or deferred indefinitely, revisit this ADR — the alternative of shipping with simplified heuristics may become preferable to shipping nothing.
- If someone proposes adding a thinker to the panel without engaging with their source material (e.g., based on AI-generated summaries), this ADR should be cited as the reason that's insufficient.
