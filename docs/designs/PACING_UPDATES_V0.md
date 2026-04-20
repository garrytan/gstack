# Pacing Updates v0 — Design Doc

**Status:** V1.1 plan (not yet implemented).
**Extracted from:** [PLAN_TUNING_V1.md](./PLAN_TUNING_V1.md) during implementation, when review rigor revealed the pacing workstream had structural gaps unfixable via plan-text editing.
**Authors:** Garry Tan (user), with AI-assisted reviews from Claude Opus 4.7 + OpenAI Codex gpt-5.4.
**Review plan:** CEO + Codex + DX + Eng cycle, same rigor as V1.

## Credit

This plan exists because of **[Louise de Sadeleer](https://x.com/LouiseDSadeleer/status/2045139351227478199)**. Her "yes yes yes" during architecture review wasn't only about jargon (V1 addresses that) — it was pacing and agency. Too many interruptive decisions over too long a review. V1.1 addresses the pacing half.

## Problem

Louise's fatigue reading gstack review output came from two sources:

1. **Jargon density** — technical terms appeared without explanation. *Addressed in V1 (ELI10 writing).*
2. **Interruption volume** — `/autoplan` ran 4 phases (CEO + Design + Eng + DX), each with 5–10 AskUserQuestion prompts. Total ≈ 30–50 prompts over ~45 minutes. Non-technical users check out at ~10–15 interruptions. **This is V1.1.**

Translation alone doesn't fix interruption volume. A translated interruption is still an interruption. The fix needs to change WHEN findings surface, not just HOW they're worded.

## Why it's extracted (structural gaps from V1's third eng review + Codex pass 2)

During V1 planning, a pacing workstream was drafted: rank findings, auto-accept two-way doors, max 3 AskUserQuestion prompts per review phase, Silent Decisions block for auto-accepted items, "flip <id>" command to re-open auto-accepted decisions post-hoc. The third eng-review pass + second Codex pass surfaced 10 gaps that couldn't be closed with plan-text edits:

1. **Session-state model undefined.** Pacing needs per-phase state (which findings surfaced, which auto-accepted, which user can flip). V1 has per-skill-invocation state for glossing but no backing store for per-phase pacing memory.
2. **Phase identifier missing from question-log.** Silent Eng #8 wanted to warn when > 3 prompts within one phase. V0's `question-log.jsonl` has no `phase` field. V1 claimed "no schema change" — contradicts the enforcement target.
3. **Question registry ≠ finding registry.** V0's `scripts/question-registry.ts` covers *questions* (registered at skill definition time). Review findings are *dynamic* (discovered at runtime). `door_type: one-way` enforcement via registry doesn't cover ad-hoc findings. One-way-door safety isn't enforceable for findings the agent generates mid-review.
4. **Pacing as prose can't invert existing control flow.** V1 planned to add a "rank findings, then ask" rule to preamble prose. But existing skill templates like `plan-eng-review/SKILL.md.tmpl` have per-section STOP/AskUserQuestion sequences. A prose rule in preamble can't reliably override a hardcoded per-section STOP. The behavioral change is sequencing, not prompt wording.
5. **Flip mechanism has no implementation.** "Reply `flip <id>` to change" was prose. No command parser, no state store, no replay behavior. If the conversation compacts and the Silent Decisions block leaves context, the original decision is lost.
6. **Migration prompt is itself an interrupt.** V1's post-upgrade migration prompt (offering to restore V0 prose) counts against the interruption budget V1.1 is trying to reduce. V1.1 must decide: exempt from budget, or include as interrupt-1-of-N?
7. **First-run preamble prompts count too.** Lake intro, telemetry, proactive, routing injection — Louise saw all of them on first run. They're interruptions before the first real skill runs. V1.1 must audit which of these are load-bearing for new users vs. deferrable until session N.
8. **Ranking formula not calibrated against real data.** V1 considered `product 0-8` (broken: `{0,1,2,4,8}` distribution), then `sum 0-6` with threshold ≥ 4. But neither was validated against actual finding distribution. V1.1 should instrument V0 question-log to measure what real findings look like, then calibrate.
9. **"Every one-way door surfaces" vs "max 3 per phase" contradicts.** One-way cap = uncapped (safety); two-way cap = 3. But the plan had both rules without explicit precedence. V1.1 must state: one-way doors surface uncapped regardless of phase budget.
10. **Undefined verification values.** V1 plan had "Silent Decisions block ≥ N entries" with N never defined, and `active: true` field in throughput JSON never defined. V1.1 gets concrete values.

## Scope for V1.1

1. **Define session-state model.** Per-skill-invocation vs per-phase vs per-conversation. Backing store: likely a JSON file at `~/.gstack/sessions/<session_id>/pacing-state.json` that records which findings surfaced vs. auto-accepted per phase. Cleanup: same TTL as existing session tracking in preamble.

2. **Add `phase` field to question-log.jsonl schema.** Classify each AskUserQuestion by which review phase it came from (CEO / Design / Eng / DX / other). Migration: existing entries default to `"unknown"`. Non-breaking schema extension.

3. **Extend registry coverage for dynamic findings.** Two options, pick during CEO review:
   - (a) Widen `scripts/question-registry.ts` to allow runtime registration (ad-hoc IDs still get logged + classified).
   - (b) Add a secondary runtime classifier `scripts/finding-classifier.ts` that maps finding text → risk tier using pattern matching.

4. **Move pacing from preamble prose into skill-template control flow.** Update each review skill template to: (i) internally complete the phase, (ii) rank findings with the `gstack-pacing-rank` binary, (iii) emit up to 3 AskUserQuestion prompts, (iv) emit Silent Decisions block with the rest. Not a preamble rule — explicit sequence in each template.

5. **Flip mechanism implementation.** New binary `bin/gstack-flip-decision`. Command parser accepts `flip <id>` from user message. Looks up the original decision in pacing-state.json. Re-opens as an explicit AskUserQuestion. New choice persists.

6. **Migration-prompt budget decision.** Explicit rule: one-shot migration prompts are exempt from the per-phase interruption budget. Rationale: they fire before review phases start, not during.

7. **First-run preamble audit.** Audit lake intro, telemetry, proactive, routing injection. For each: is this load-bearing for a first-time user, or deferrable? Likely outcome: suppress all but lake intro until session 2+. Offer remaining ones via a `/plan-tune first-run` command that users can invoke voluntarily.

8. **Ranking threshold calibration.** Instrument V0's question-log (already running, has history). Measure the actual distribution of `severity × irreversibility × user-decision-matters` across recent CEO + Eng + DX + Design reviews. Pick threshold based on real data. Target: ~20% of findings surface, ~80% auto-accept.

9. **Explicit rule: one-way doors uncapped.** Hard-coded in skill template prose: "one-way doors surface regardless of phase interruption budget." Two-way findings cap at 3 per phase.

10. **Concrete verification values.** Define `N` for Silent Decisions (e.g., ≥ 5 entries expected for a non-trivial plan), define the throughput JSON schema with concrete field names.

## Acceptance criteria for V1.1

- **Interruption count:** Louise (or similar non-technical collaborator) reruns `/autoplan` end-to-end on a plan comparable to V0-baseline. AskUserQuestion count ≤ 50% of V0 baseline. (V1 captures this baseline transcript for V1.1 calibration.)
- **One-way-door coverage:** 100% of safety-critical decisions (`door_type: one-way` OR classifier-flagged dynamic findings) surface individually at full technical detail. Uncapped.
- **Flip round-trip:** User types `flip test-coverage-bookclub-form`. The original auto-accepted decision re-opens as an AskUserQuestion. User's new choice persists to the Silent Decisions block (or is removed if user flips to explicit surfacing).
- **Per-phase observability:** `/plan-tune` can display per-phase AskUserQuestion counts for any session, reading from question-log.jsonl's new `phase` field.
- **First-run reduction:** New users see ≤ 1 meta-prompt (lake intro) before their first real skill runs, vs. V1's 4 (lake + telemetry + proactive + routing).
- **Human rerun:** Louise + Garry independent qualitative reviews, same pattern as V1.

## Dependencies on V1

V1.1 builds on V1's infrastructure:
- `explain_level` config key + preamble echo pattern (A4).
- Jargon list + Writing Style section (V1.1's interruption language should respect ELI10 rules).
- V0 dormancy negative tests (V1.1 won't wake the 5D psychographic machinery either).
- V1's captured Louise transcript (baseline for acceptance criterion calibration).

V1.1 does NOT depend on any V2 items (E1 substrate wiring, narrative/vibe, etc.).

## Review plan

- **Pre-work:** capture real question-log distribution from current V0 data. Use as calibration input for Scope #8.
- **CEO review.** Premise challenge: is pacing the right fix, or should V1.1 consider removing phases entirely? (E.g., collapse CEO + Design + Eng + DX into a single unified review pass.) Scope mode: SELECTIVE EXPANSION likely (pacing is the core, related improvements are cherry-picks).
- **Codex review.** Independent pass on the V1.1 plan. Expect particular scrutiny on the control-flow change (Scope #4) since that's the area V1 struggled with.
- **DX review.** Focus on the flip mechanism's DX — is `flip <id>` discoverable, is the command syntax natural, is the error path clear?
- **Eng review ×N.** Expect multiple passes, same as V1.

## NOT touched in V1.1

V2 items remain deferred:
- Confusion-signal detection
- 5D psychographic-driven skill adaptation (V0 E1)
- /plan-tune narrative + /plan-tune vibe (V0 E3)
- Per-skill or per-topic explain levels
- Team profiles
- AST-based "delivered features" metric
