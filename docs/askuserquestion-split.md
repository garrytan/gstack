# AskUserQuestion split rule — full reference

Inline summary lives in the canonical preamble (`scripts/resolvers/preamble/generate-ask-user-format.ts`).
That subsection is intentionally compressed because it injects into every
tier-2+ skill's `SKILL.md`. This file is the deep reference the inline
guidance points to — load it when N>4 options come up and you need
worked examples or the full Hold / dependency / final-summary semantics.

## The bug this prevents

Pre-rule failure mode (transcript verbatim from the user complaint that
motivated this):

> "I'm hitting Conductor's limit of 4 options in the AUQ, so I need to
> cut one. E4 (the detect-mappings codegen) is the biggest lift and
> probably beyond scope for v0.42 anyway — users can hand-author their
> mapping rules for the 9 clusters. I'll drop that and keep E1, E2, E3,
> and E5..."
>
> "Conductor caps at 4 options. Trimming: E4 (detect-mappings codegen)
> is the largest-effort item and a natural v0.43+ follow-up — moving it
> to TODOS.md without asking. Re-firing with 4."

The agent unilaterally cut a real option without user input. The option
set is the user's decision space; shrinking it silently is the bug.

## Which shape: batched vs. split

Two compliant shapes. Pick by reading the options:

1. **Batched into ≤4-groups** — the options are coherent alternatives,
   one will be picked. Examples: "major / minor / patch / micro" for a
   version bump, "5 layout variants where the user picks one", "which
   framework: rspec / minitest / cucumber / none". Batch the top 4 into
   one AskUserQuestion; surface the 5th as a follow-up if none of the
   first 4 fit. This is the lower-friction path when applicable.

2. **Split per-option** — the options are independent scope items, each
   carrying its own include/defer/cut decision. Examples: "E1..E6, which
   do we ship?", "5 candidate integrations for Q3", "8 TODOs surfaced by
   the audit — which do we land?". Fire N sequential AskUserQuestion
   calls, one per option.

**Default to split per-option when unsure.** Batching wrong options
together — shoehorning orthogonal scope items into one question — is
the same failure mode as dropping.

## Split per-option mechanics

### Before the chain

Check for dependencies between options. If E3 requires E1, or E5
conflicts with E2, surface that in the per-option ELI10:

> "Cutting this orphans E3 — they're linked."

Without dependency surfacing, the chain produces incoherent picked sets
(user picks Include for E3 + Cut for E1, ships an unbuildable scope).

### D-numbering

- Parent decision: `D<N>` where N is the global question counter.
- Each per-option call: `D<N>.k` for k=1..K children.
- Final summary: `D<N>.final`.
- Single-option revise: `D<N>.revise-<k>`.

Example chain for 5 options at parent D3:

```
D3.1 → D3.2 → D3.3 → D3.4 → D3.5 → D3.final
```

### Per-option call shape

For each option Eₖ, fire an AskUserQuestion with:

- `D<N>.k` header (e.g. D3.1, D3.2 ... D3.5)
- ELI10 of just this option's scope, cost, and any dependency it carries
- Recommendation: Include / Defer / Cut, with concrete reason
- 4 buckets per option:
  - **A) Include** in this scope (recommended/not)
  - **B) Defer** to follow-up (TODOs / next version)
  - **C) Cut** entirely
  - **D) Hold** — stop the chain, discuss before deciding
- Note: options differ in kind, not coverage — no completeness score.
  (Include/Defer/Cut/Hold are decision actions, so the existing format
  rule applies: omit `Completeness: N/10` and use the kind-note instead.)

### Hold means stop, not queue

When the user picks Hold on any per-option call, **stop the chain
immediately**. Do not continue asking later options behind the Hold —
the user wants to discuss the picked option first. After discussion,
the user resumes by saying "continue" or naming the next option to ask
about.

Wrong behavior: queue E4 and E5 behind a Hold on E3, then fire them
later with stale context. Right behavior: stop, let the user reset the
parent decision, resume from where they left off.

### Final summary

After the chain resolves (without Hold), fire `D<N>.final` to confirm
and validate the assembled set.

**Step 1 — validate dependencies.** If the picked set is incoherent
(e.g. E3 picked Include but its required E1 was Cut), do NOT silently
accept. Re-prompt the conflict as a single AskUserQuestion:

> "E3 needs E1 but you cut E1. Revise:
> A) keep E1
> B) cut E3 too
> C) leave as-is and accept the broken state"

**Step 2 — confirm the assembled set.** If coherent:

> "Here's the assembled set: E1, E2, E5. Ship this scope?
> A) Ship this scope (recommended)
> B) Revise one option (you pick which)
> C) Cut more"

**Step 3 — targeted revise.** If the user picks B, ask which option to
revise, then fire ONE per-option AskUserQuestion at `D<N>.revise-<k>`
to update just that option. Do **not** re-run the whole chain.

## Sizing rules

- **N ≤ 4**: use the normal single AskUserQuestion form. Don't split.
- **N = 5 or 6**: split (or batch if a clean grouping exists).
- **N > 6**: BEFORE the chain, fire a meta-AskUserQuestion at `D<N>.0`:

  > "About to ask N per-option questions. Options:
  > A) Proceed with the full split (recommended only if every option is
  >    independent)
  > B) Narrow scope first — I'll propose a smaller set
  > C) Batch into groups of 4 instead"

  This is itself an AskUserQuestion tool call, not prose — it counts as
  the first prompt in the chain, not a violation of the "tool not prose"
  rule.

## question_id rules for split chains

Each per-option AskUserQuestion emits a unique `question_id` of the
form `<skill>-split-<option-slug>` where `<option-slug>` is the option's
key kebab-cased (lowercase, hyphens, ASCII only).

Examples:
- `plan-ceo-review-split-e4-detect-mappings`
- `ship-split-rspec`
- `plan-eng-review-split-add-coverage-test`

**Collision handling.** If two options would produce the same slug,
suffix with `-2`, `-3`, etc.

**Length.** Total length must be ≤64 chars (validated by
`bin/gstack-question-preference --write`). Truncate the option slug if
needed, preserving the `<skill>-split-` prefix.

## AUTO_DECIDE behavior with split chains

Two-layer defense.

**Layer 1 — mechanism.** Each per-option `question_id` is unique to its
option, so preferences set on one option's id cannot leak across the
chain. A `never-ask` on `ship-split-rspec` does not silently approve
`ship-split-minitest`.

**Layer 2 — runtime enforcement.** `bin/gstack-question-preference
--check` detects any id matching `*-split-*` (the canonical slug pattern
emitted by split chains) and forces `ASK_NORMALLY` even when a
`never-ask` or `ask-only-for-one-way` preference exists for that exact
id. The check emits an explanatory note when this override fires:

> "split-chain per-option calls always ASK_NORMALLY; your never-ask
> preference does not apply to options inside a sequential split."

**Result.** Split-chain per-option calls are NEVER AUTO_DECIDE-eligible.
This is a runtime contract, not just collision-resistance by id
uniqueness. The user's option set is sacred — restoring user
sovereignty over the decision space is the entire point of splitting.

## Interaction with per-skill rules

This rule **overrides any per-skill "batch decisions" guidance**.
Per-skill templates that explicitly require one-issue-per-call (e.g.
`plan-eng-review`) are already compatible — they're a stricter special
case of this rule.

## Worked example: 5 platform integrations

Fixture used by `test/skill-e2e-plan-ceo-split-overflow.test.ts`. A plan
has 5 independent chat-platform candidates:

- E1) Slack DM bot (~2 weeks, ~40% of asks)
- E2) Discord guild bot (~3 weeks, ~15%)
- E3) Microsoft Teams (~4 weeks, ~5%)
- E4) Telegram (~1 week, ~8%)
- E5) Mattermost (~2 weeks, ~3%)

User wants individual decisions per candidate, not a bundled pick. The
agent should:

1. Recognize this is a 5-option independent-scope decision → split.
2. Check dependencies (none here — each platform is standalone).
3. Fire `D3.1` through `D3.5`, one per platform, with Include / Defer /
   Cut / Hold buckets and an effort+demand-grounded recommendation per
   option.
4. After the chain, fire `D3.final` summarizing the assembled scope
   (e.g. "Ship E1 + E4 — Slack and Telegram pull most demand for least
   build cost. Defer the rest. A) Ship / B) Revise / C) Cut more").

Pre-fix failure shape (the bug): agent constructs a single
AskUserQuestion with E1..E4 as four options, drops E5 with prose like
"E5 is the smallest revenue segment, moving to TODOs". The user never
got to weigh in on E5. Floor-of-4 in the E2E test catches this.
