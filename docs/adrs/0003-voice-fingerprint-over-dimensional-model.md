---
number: 0003
title: Qualitative voice fingerprint over formal dimensional model
status: accepted
date: 2026-03-27
tags: [social-skill, voice, methodology]
trigger_conditions:
  - "If dogfood data from 5-10 sessions reveals consistent dimensional patterns that suggest a useful taxonomy"
  - "If the voice fingerprints prove too vague to distinguish founder writing from AI output in /social-strategy review"
---

# 0003. Qualitative Voice Fingerprint Over Formal Dimensional Model

## Status

Accepted

## Context

The `/social-strategy` skill needs to characterize a founder's voice well enough to (a) define an organizational voice modulation guide and (b) evaluate draft content for voice consistency in `/social-strategy review`. The question is how to represent voice: as a scored dimensional profile or as a qualitative characterization.

This decision went through a full design cycle before being resolved. An initial 6-dimension model (register, epistemic stance, humor mode, complexity comfort, emotional exposure, contrarian comfort) was proposed, complete with a coverage matrix mapping 4 writing prompts to dimensions, interview-mode personas for gap-filling, and per-dimension confidence scores. This was then challenged on the grounds that the dimensions were unvalidated — proposed without empirical grounding or literature review.

A research plan was developed (three levels: literature review, empirical sampling, in-use validation). Before committing to any research approach, the fundamental question was re-examined: does the skill actually need dimensional measurement at all?

## Decision

Use a qualitative voice fingerprint — a rich prose characterization with examples and anti-examples — instead of a scored dimensional model. The voice doc describes who the founder sounds like in specific, edgy language, not in numerical scores. The style guide handles effectiveness coaching and domain-specific language risks as a separate, personalized artifact.

## Alternatives Considered

### Alternative: 6-dimension scored model with coverage matrix
- **Description:** Define 6 voice dimensions (register, epistemic stance, humor mode, complexity comfort, emotional exposure, contrarian comfort). Score each 1-10 based on writing sample analysis. Design prompts to cover each dimension at least twice. Use interview-mode personas to fill gaps in low-confidence dimensions.
- **Advantages:** Systematic. Reproducible. Gives the review mode specific dimensions to score against. Sounds rigorous.
- **Disadvantages:** The 6 dimensions were proposed without empirical validation — no literature review, no factor analysis, no evidence that these are independent or complete. "Contrarian comfort" might just be a combination of epistemic stance and emotional exposure. Important dimensions might be missing entirely (narrative structure, abstraction level, temporal orientation). The dimensional scores create false precision: "epistemic stance: 7/10" sounds meaningful but has no validated scale behind it. Additionally, the skill isn't emulating voice (where dimensions would be useful for synthesis) — it's recognizing voice and coaching effectiveness, which are qualitative judgments.
- **Ruling rationale:** The dimensions were unvalidated, the scores would create false confidence, and the skill's actual job (recognition and coaching) doesn't require dimensional measurement. Building a formal measurement instrument on an unvalidated foundation would produce confident-sounding nonsense.

### Alternative: Research-first approach (validate dimensions, then build)
- **Description:** Conduct a literature review of stylometry research, empirically sample 20-30 effective founder voices, do informal factor analysis, and derive a validated dimensional model before building.
- **Advantages:** Would produce a grounded model. Connects to existing research in computational linguistics.
- **Disadvantages:** Significant time investment before any usable skill. May be solving the wrong problem — the skill needs to recognize and coach, not measure.
- **Ruling rationale:** The research is worth doing post-dogfood if dimensional patterns emerge from actual use. But blocking the build on upfront research assumes dimensions are the right abstraction, which is itself unvalidated. Better to ship with a simpler approach and let the data tell us whether formalization is needed.

## Tradeoffs

**Technical tradeoffs:**
- **What we gain:** A simpler, more honest representation of voice that doesn't claim precision it can't deliver. Review mode evaluates "does this sound like you?" as a holistic judgment, not as a dimensional checklist.
- **What we lose:** Reproducibility. Two runs of the skill on the same writing samples might produce different fingerprints. No numerical scores to track over time.
- **Why this tradeoff is acceptable:** The skill is for founder self-awareness and content coaching, not for academic voice analysis. A qualitative fingerprint that captures "mordant, technically precise, leads with the point, uses hedging phrases habitually" is more useful for review-mode coaching than "register: 3/10, epistemic stance: 7/10."

**Business and operational tradeoffs:**
- **What we gain:** Faster time to usable skill. No research phase blocking development.
- **What we lose:** If a dimensional model turns out to be necessary later, some rework. The voice doc format may need to change.
- **Why this tradeoff is acceptable:** The voice doc is a single artifact that can be regenerated. The cost of rework is low compared to the cost of shipping nothing while researching the perfect model.

## Consequences

- The voice doc format is prose-based, not structured data. This is harder for agents to parse programmatically but more useful for the review mode's qualitative evaluation.
- If dogfood reveals that the qualitative fingerprints are too vague to be useful in review mode, the dimensional model can be revisited — but it should be derived from empirical patterns in the fingerprints, not imposed a priori.
- The design explicitly documents that a dimensional model was considered and rejected, so future contributors don't re-derive it without understanding why it was abandoned.
- There's a potential cross-pollination with voice/style characterization work in other domains (e.g., PersonaHub modality coverage for synthetic training data). If a dimensional taxonomy emerges from that work, it may be worth importing.

## Trigger Conditions

- If 5-10 dogfood sessions reveal consistent patterns in the voice fingerprints that cluster into identifiable dimensions, those dimensions should be formalized — derived from data, not imposed.
- If `/social-strategy review` can't reliably distinguish "the founder wrote this" from "AI wrote this" using the qualitative fingerprint, the fingerprint isn't specific enough and a more structured approach may be needed.
