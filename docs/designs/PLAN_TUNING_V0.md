# Plan Tuning v0 — Design Doc

**Status:** Approved for v1 implementation
**Branch:** garrytan/plan-tune-skill
**Authors:** Garry Tan (user), with AI-assisted reviews from Claude Opus 4.7 + OpenAI Codex gpt-5.4
**Date:** 2026-04-16

## What this document is

A canonical record of what `/plan-tune` v1 is, what it is NOT, what we considered, and why we made each call. Committed to the repo so future contributors (and future Garry) can trace reasoning without archeology. Supersedes the two `~/.gstack/projects/` artifacts (office-hours design doc + CEO plan) which are per-user local records.

## The feature, in one paragraph

gstack's 40+ skills fire AskUserQuestion constantly. Power users answer the same questions the same way repeatedly and have no way to tell gstack "stop asking me this." More fundamentally, gstack has no model of how each user prefers to steer their work — scope-appetite, risk-tolerance, detail-preference, autonomy, architecture-care — so every skill's defaults are middle-of-the-road for everyone. `/plan-tune` v1 builds the schema + observation layer: a typed question registry, per-question explicit preferences, inline "tune:" feedback, and a profile (declared + inferred dimensions) inspectable via plain English. It does not yet adapt skill behavior based on the profile. That comes in v2, after v1 proves the substrate works.

## Why we're building the smaller version

The feature started life as a full adaptive substrate: psychographic dimensions driving auto-decisions, blind-spot coaching, LANDED celebration HTML page, all bundled. Four rounds of review (office-hours, CEO EXPANSION, DX POLISH, eng review) cleared it. Then outside voice (Codex) delivered a 20-point critique. The critical findings, in priority order:

1. **"Substrate" was false.** The plan wired 5 skills to read the profile on preamble, but AskUserQuestion is a prompt convention, not middleware. Agents can silently skip the instructions. You cannot reliably build auto-decide on top of an unenforceable convention. Without a typed question registry that every AskUserQuestion routes through, the substrate claim is marketing.
2. **Internal logical contradictions.** E4 (blind-spot) + E6 (mismatch) + ±0.2 clamp on declared dimensions do not compose. If user self-declaration is ground truth via the clamp, E6's mismatch detection is detecting noise. If behavior can correct the profile, the clamp suppresses the signal E6 needs.
3. **Profile poisoning.** Inline "tune: never ask" could be emitted by malicious repo content (README, PR description, tool output) and the agent would dutifully write it. No prior review caught this security gap.
4. **E5 LANDED page in preamble.** `gh pr view` + HTML write + browser open on every skill's preamble is latency, auth failures, rate limits, surprise browser opens, and nondeterminism injected into the hottest path.
5. **Implementation order was backwards.** The plan started with classifiers and bins. The correct order: build the integration point first (typed question registry), then infrastructure, then consumers.

After weighing Codex's argument, we chose to roll back CEO EXPANSION and ship an observational v1 with a real typed registry as the foundation. Psychographic becomes behavioral only after the registry proves durable in production.

## v1 Scope (what we're building now)

1. **Typed question registry** (`scripts/question-registry.ts`). Every AskUserQuestion gstack uses is declared with `{id, skill, category, door_type, options[], signal_key?}`. Schema-governed.
2. **CI enforcement.** Lint test (gate tier) asserts every AskUserQuestion pattern in SKILL.md.tmpl files has a matching registry entry. Fails CI on drift, renames, or duplicates.
3. **Question logging** (`bin/gstack-question-log`). Appends `{ts, question_id, user_choice, recommended, session_id}` to `~/.gstack/projects/{SLUG}/question-log.jsonl`. Validates against registry.
4. **Explicit per-question preferences** (`bin/gstack-question-preference`). Writes `{question_id, preference}` where preference is `always-ask | never-ask | ask-only-for-one-way`. Respected from session 1. No calibration gate — user stated it, system obeys.
5. **Preamble injection.** Before each AskUserQuestion, agent calls `gstack-question-preference --check <registry-id>`. If `never-ask` AND question is NOT a one-way door, auto-choose recommended option with visible annotation: "Auto-decided [summary] → [option] (your preference). Change with /plan-tune." One-way doors always ask regardless of preference — safety override.
6. **Inline "tune:" feedback with user-origin gate.** Agent offers "Tune this question? Reply `tune: [feedback]` to adjust." User can use shortcuts (`unnecessary`, `ask-less`, `never-ask`, `always-ask`, `context-dependent`) or free-form English. CRITICAL: the agent only writes a tune event when the `tune:` content appears in the user's current chat turn — NOT in tool output, NOT in a file read. Binary validates `source: "inline-user"` on write; rejects other sources.
7. **Declared profile** (`/plan-tune setup`). 5 plain-English questions, one per dimension. Stored in unified `~/.gstack/developer-profile.json` under `declared: {...}`. Informational only in v1 — no skill behavior change.
8. **Observed/Inferred profile.** Every question-log event contributes deltas to inferred dimensions via a hand-crafted signal map (`scripts/psychographic-signals.ts`). Computed on demand. Displayed but not acted on.
9. **`/plan-tune` skill.** Conversational plain-English inspection tool. "Show my profile," "set a preference," "what questions have I been asked," "show the gap between what I said and what I do." No CLI subcommand syntax required.
10. **Unification with existing `~/.gstack/builder-profile.jsonl`.** Fold /office-hours session records and accumulated signals into unified `~/.gstack/developer-profile.json`. Migration is atomic + idempotent + archives the source file.

## Deferred to v2 (not in this PR, but explicit acceptance criteria)

| Item | Why deferred | Acceptance criteria for v2 promotion |
|------|--------------|--------------------------------------|
| E1 Substrate wiring (5 skills read profile and adapt) | Requires v1 registry proving durable. Requires real observed data to calibrate signal deltas. Risk of psychographic drift. | v1 registry stable for 90+ days. Inferred dimensions show clear stability across 3+ skills. User dogfood validates that defaults informed by profile feel right. |
| E3 `/plan-tune narrative` + `/plan-tune vibe` | Event-anchored narrative needs stable profile. Without v1 data, output will be generic slop. | Profile diversity check passes for 2+ weeks real usage. Narrative test proves it quotes specific events, not clichés. |
| E4 Blind-spot coach | Logically conflicts with E1/E6 without explicit interaction-budget design. Needs global session budget, escalation rules, exclusion from mismatch detection. | Design spec for interaction budget + escalation. Dogfood confirms challenges feel coaching, not nagging. |
| E5 LANDED celebration HTML page | Cannot live in preamble (Codex #9, #10). When promoted, moves to explicit command `/plan-tune show-landed` OR post-ship hook — not passive detection in the hot path. | Explicit command or hook design. /design-shotgun → /design-html for the visual direction. Security + privacy review for PR data aggregation. |
| E6 Auto-adjustment based on mismatch | In v1, /plan-tune shows the gap between declared and inferred. In v2, it could suggest declaration updates. Requires dual-track profile to be stable. | Real mismatch data from v1 shows consistent patterns. Suggestion UX designed separately. |
| Psychographic-driven auto-decide | Zero behavioral change in v1. Only explicit preferences act. | Real usage shows explicit preferences cover most cases. Inferred profile stable enough to trust. |

## Rejected entirely (Codex was right, we're not doing these)

| Item | Why rejected |
|------|--------------|
| Substrate-as-prompt-convention (vs. typed registry) | Codex #1. Agents can silently skip instructions. Building psychographic on top is sand. |
| ±0.2 clamp on declared dimensions | Codex #6. Creates logical contradiction with E6 mismatch detection. Pick ONE: editable preference OR inferred behavior. Now: both, tracked separately (dual-track profile). |
| One-way door classification by parsing prose summaries | Codex #4. Safety depends on wording. door_type must be declared at question definition site (registry), not inferred. |
| Single event-schema file mixing declarations + overrides + verdicts + feedback | Codex #5. Incompatible domain objects. Now split into three files: question-log.jsonl, question-preferences.json, question-events.jsonl. |
| TTHW telemetry for /plan-tune onboarding | Codex #14. Contradicts local-first framing. Local logging only. |
| Inline tune: writes without user-origin verification | Codex #16. Profile poisoning attack. Now: user-origin gate is non-optional. |

## Architecture

```
~/.gstack/
  developer-profile.json            # unified: declared + inferred + sessions (from office-hours)

~/.gstack/projects/{SLUG}/
  question-log.jsonl                # every AskUserQuestion, append-only, registry-validated
  question-preferences.json         # explicit per-question user choices
  question-events.jsonl             # tune: feedback events, user-origin gated
```

**Unified profile schema** (superseding both v0.16.2.0 builder-profile.jsonl and the proposed developer-profile.json):

```json
{
  "identity": {"email": "..."},
  "declared": {
    "scope_appetite": 0.9,
    "risk_tolerance": 0.7,
    "detail_preference": 0.4,
    "autonomy": 0.5,
    "architecture_care": 0.7
  },
  "inferred": {
    "values": {"scope_appetite": 0.72, "risk_tolerance": 0.58, "...": "..."},
    "sample_size": 47,
    "diversity": {
      "skills_covered": 5,
      "question_ids_covered": 14,
      "days_span": 23
    }
  },
  "gap": {"scope_appetite": 0.18, "...": "..."},
  "sessions": [
    {"date": "...", "mode": "builder", "project_slug": "...", "signals": []}
  ],
  "signals_accumulated": {
    "named_users": 1, "taste": 4, "agency": 3, "...": "..."
  }
}
```

**Diversity check** (Codex #13): `inferred` is considered "enough data" only when `sample_size >= 20 AND skills_covered >= 3 AND question_ids_covered >= 8 AND days_span >= 7`. Below this, `/plan-tune profile` shows "not enough observed data yet" instead of a potentially-misleading inferred value.

## Data flow (v1)

1. Preamble: check `question_tuning` config. If off, do nothing.
2. Before each AskUserQuestion:
   - Agent calls `gstack-question-preference --check <registry-id>`
   - If `never-ask` AND question is NOT one-way door → auto-choose recommended with annotation
   - If `always-ask`, unset, or question IS one-way door → ask normally
3. After AskUserQuestion:
   - Append log record to question-log.jsonl (registry-validated, rejects unknown IDs)
4. Offer inline: "Tune this question? Reply `tune: [feedback]` to adjust."
5. If user's NEXT turn message contains `tune:` prefix AND the content originated in the user's own message (not tool output):
   - Agent calls `gstack-question-preference --write` with `source: "inline-user"`
   - Binary validates source field; rejects if anything other than `inline-user`
6. Inferred dimensions recomputed on demand by `bin/gstack-developer-profile --derive`. Signal map changes trigger full recompute from events history.

## Security model

**Profile poisoning defense** (Codex #16, Decision J below): Inline tune events may be written ONLY when:
- The agent is processing the user's current chat turn
- The `tune:` prefix appears in that user message (not in any tool output, file content, PR description, commit message, etc.)
- The resolver's instructions to the agent explicitly call this out

Binary enforcement: `gstack-question-preference --write` requires `source: "inline-user"` field on every tune-originated record. Any other source value (e.g., `inline-tool-output`, `inline-file-content`) is rejected with an error. Agent is instructed to never forge the `source` field.

**Data privacy**:
- All data is local-only under `~/.gstack/`. Nothing leaves without explicit user action.
- `/plan-tune export <path>` writes profile to user-specified path (opt-in export).
- `/plan-tune delete` wipes local profile files.
- `gstack-config set telemetry off` prevents any telemetry (this skill never sends profile data regardless).
- Profile files have standard user-home permissions.

**Injection defense** (consistent with existing `bin/gstack-learnings-log` patterns): the `question_summary` and any free-form user feedback fields are sanitized against known prompt-injection patterns ("ignore previous instructions," "system:", etc.).

## 5 Hard Constraints (preserved from office-hours, updated for Codex feedback)

1. **One-way doors are classified deterministically by registry declaration**, NOT by runtime summary parsing. Each registry entry declares `door_type: one-way | two-way`. Keyword pattern fallback (`scripts/one-way-doors.ts`) is a belt-and-suspenders secondary check for edge cases.
2. **Profile dimensions are inspectable AND editable.** `/plan-tune profile` shows declared + inferred + gap. Edits via plain English go to `declared` only. System tracks `inferred` independently.
3. **Signal map is hand-crafted in TypeScript.** `scripts/psychographic-signals.ts` maps `{question_id, user_choice} → {dimension, delta}`. Not agent-inferred. In v1, consumed only for `inferred.values` display — not for driving decisions.
4. **No psychographic-driven auto-decide in v1.** Only explicit per-question preferences act. This sidesteps the "calibration gate can be gamed" critique (Codex #13) entirely — v1 doesn't have a gate to pass.
5. **Per-project preferences beat global preferences.** `~/.gstack/projects/{SLUG}/question-preferences.json` wins over any future global preference file. Global profile (`~/.gstack/developer-profile.json`) is a starting point for diversity across projects.

## Why event-sourced + dual-track

**Why event-sourced for the inferred profile**:
- Signal map can change between gstack versions. Recompute from events, no data migration needed.
- Auditable: `/plan-tune profile --trace autonomy` shows every event that contributed to the value.
- Future-proof: new dimensions can be derived from existing history.

**Why dual-track (declared + inferred, separately)** (Decision B below):
- Resolves the logical contradiction Codex #6 identified.
- `declared` is user sovereignty. User states who they are. System obeys for anything user-driven (preferences, declarations, overrides).
- `inferred` is observation. System tracks behavioral patterns. Displayed but not acted on in v1.
- `gap` is the interesting signal. Large gaps suggest the user's self-description isn't matching their behavior — valuable self-insight, but not auto-corrected.

## Interaction model — plain English everywhere

(From /plan-devex-review, user correction on CLI syntax):

`/plan-tune` (no args) enters conversational mode. No CLI subcommand syntax required.

Menu in plain language:
- "Show me my profile"
- "Review questions I've been asked"
- "Set a preference about a question"
- "Update my profile — I've changed my mind about something"
- "Show me the gap between what I said and what I do"
- "Turn it off"

User replies conversationally. Agent interprets, confirms the intended change, then writes. For example:
- User: "I'm more of a boil-the-ocean person than 0.5 suggests"
- Agent: "Got it — update `declared.scope_appetite` from 0.5 to 0.8? [Y/n]"
- User: "Yes"
- Agent writes the update

Confirmation step is required for any mutation of `declared` from free-form input (Codex #15 trust boundary).

Power users can type shortcuts (`narrative`, `vibe`, `reset`, `stats`, `enable`, `disable`, `diff`). Neither is required. Both work.

## Files to Create

### Core schema
- `scripts/question-registry.ts` — typed registry. Seeded from audit of all SKILL.md.tmpl AskUserQuestion invocations.
- `scripts/one-way-doors.ts` — secondary keyword fallback. Primary: `door_type` in registry.
- `scripts/psychographic-signals.ts` — hand-crafted signal map for inferred computation.

### Binaries
- `bin/gstack-question-log` — append log record, validate against registry.
- `bin/gstack-question-preference` — read/write/check/clear explicit preferences.
- `bin/gstack-developer-profile` — supersedes `bin/gstack-builder-profile`. Subcommands: `--read` (legacy compat), `--derive`, `--gap`, `--profile`.

### Resolvers
- `scripts/resolvers/question-tuning.ts` — three generators: `generateQuestionPreferenceCheck(ctx)` (pre-question check), `generateQuestionLog(ctx)` (post-question log), `generateInlineTuneFeedback(ctx)` (post-question tune: prompt with user-origin gate instructions).

### Skill
- `plan-tune/SKILL.md.tmpl` — conversational, plain-English inspection and preference tool.

### Tests
- `test/plan-tune.test.ts` — registry completeness, duplicate ID check, preference precedence (never-ask + not-one-way → AUTO_DECIDE; never-ask + one-way → ASK_NORMALLY), user-origin gate (rejects non-inline-user sources), derivation + recompute, unified profile schema, migration regression with 7-session fixture.

## Files to Modify

- `scripts/resolvers/index.ts` — register 3 new resolvers.
- `scripts/resolvers/preamble.ts` — `_QUESTION_TUNING` config read; inject 3 resolvers for tier >= 2.
- `bin/gstack-builder-profile` — legacy shim delegates to `bin/gstack-developer-profile --read`.
- Migration script — folds existing builder-profile.jsonl into unified developer-profile.json. Atomic, idempotent, archives source as `.migrated-YYYY-MM-DD`.

## NOT touched in v1

Explicitly unchanged — no `{{PROFILE_ADAPTATION}}` placeholders, no behavior change based on profile:

- `ship/SKILL.md.tmpl`, `review/SKILL.md.tmpl`, `office-hours/SKILL.md.tmpl`, `plan-ceo-review/SKILL.md.tmpl`, `plan-eng-review/SKILL.md.tmpl`

These skills gain preamble injection for logging / preference checking / tune feedback only. No profile-driven defaults. v2 work.

## Decisions log (with pros/cons for each)

### Decision A: Bundle all three (question-log + sensitivity + psychographic) vs. ship smaller wedge — INITIAL ANSWER: BUNDLE; REVISED: REGISTRY-FIRST OBSERVATIONAL

Initial user position (office-hours): "The psychographic IS the differentiation. Ship the whole thing so the feedback loop can actually tune behavior." This drove CEO EXPANSION.

**Pros of bundling:** Ambition. The learning layer is what makes this more than config. Without psychographic, it's a fancy settings menu.

**Cons of bundling (surfaced by Codex):** The substrate didn't exist. Psychographic on top of prompt-convention is sand. E1/E4/E6 compose incoherently. Profile poisoning was unaddressed. E5 in preamble is a hidden hot-path side effect. Implementation order built machinery around an unenforceable convention.

**Revised answer:** Registry-first observational v1 (this doc). Preserves the ambition as a v2 target with explicit acceptance criteria. Ships a defensible foundation. User accepted this after seeing Codex's 20-point critique.

### Decision B: Event-sourced vs. stored dimensions vs. hybrid — ANSWER: EVENT-SOURCED + USER-DECLARED ANCHOR (B+C)

**Approach A (stored dimensions):** Mutate in place. Simple.
- Pros: Smallest data model. Easy to reason about.
- Cons: Lossy. No history. Signal map changes require migration. Profile changes are opaque to the user.

**Approach B (event-sourced):** Store raw events, derive dimensions.
- Pros: Auditable. Recomputable on signal map changes. No data migration ever. Matches existing learnings.jsonl pattern.
- Cons: More complex derivation. Events file grows over time (compaction deferred to v2).

**Approach C (hybrid — user-declared anchor, events refine):** Initial profile is user-stated; events refine within ±0.2.
- Pros: Day-1 value. User sovereignty. Calibration anchor instead of starting from zero.
- Cons: ±0.2 clamp creates logical conflict with mismatch detection (Codex #6 caught this).

**Chosen: B+C combined with ±0.2 CLAMP REMOVED.** Event-sourced underneath, declared profile as first-class separate field. No clamp. Declared and inferred live as independent values. Gap between them is displayed but not auto-corrected in v1.

### Decision C: One-way door classification — runtime prose parsing vs. registry declaration — ANSWER: REGISTRY DECLARATION (post-Codex)

**Runtime prose parsing (original):** `isOneWayDoor(skill, category, summary)` plus keyword patterns.
- Pros: Minimal friction for skill authors. No schema to maintain.
- Cons (Codex #4): Safety depends on wording. A destructive-op question phrased mildly could be misclassified. Unacceptable for a safety gate.

**Registry declaration (revised):** Every registry entry declares `door_type`.
- Pros: Deterministic. Auditable. CI-enforceable (all questions must declare).
- Cons: Maintenance burden. Every new skill question must classify.

**Chosen: registry declaration as primary, keyword patterns as fallback.** Schema governance is the cost of safety.

### Decision D: Inline tune feedback grammar — structured keywords vs. free-form natural language — ANSWER: STRUCTURED WITH FREE-FORM FALLBACK

**Structured keywords only:** `tune: unnecessary | ask-less | never-ask | always-ask | context-dependent`.
- Pros: Unambiguous. Clean profile data.
- Cons: Users must memorize.

**Free-form only:** Agent interprets whatever user says.
- Pros: Natural. No syntax to learn.
- Cons: Inconsistent profile data. Hard to debug why a tune didn't take effect.

**Chosen: both.** Shortcuts documented for power users; agent accepts and normalizes free English. Plain-English interaction is the default; structured keywords are an optional fast-path.

### Decision E: CLI subcommand structure for /plan-tune — ANSWER: PLAIN ENGLISH CONVERSATIONAL (no subcommand syntax required)

**`/plan-tune profile`, `/plan-tune profile set autonomy 0.4`, etc.** (original):
- Pros: Fast for power users. Self-documenting via --help.
- Cons: Users must memorize. Every invocation feels like a CLI session, not a conversation.

**Plain-English conversational (revised after user correction):** `/plan-tune` enters a menu. User says what they want in natural language.
- Pros: Zero memorization. Feels like talking to a coach, not a shell.
- Cons: Slower for power users. Requires good agent interpretation.

**Chosen: conversational with optional shortcuts.** Neither path is required. Most users never see the shortcuts. Confirmation step required before mutating declared profile (safety against agent misinterpretation — Codex #15 trust boundary).

### Decision F: Landed celebration — passive preamble detection vs. explicit command vs. post-ship hook — ANSWER: DEFERRED TO v2; WHEN PROMOTED, NOT IN PREAMBLE

**Passive detection in preamble (original):** Every skill's preamble runs `gh pr view` to detect recent merges.
- Pros: Works regardless of which skill the user runs. User doesn't need to do anything special.
- Cons (Codex #9): Latency, auth failures, rate limits, surprise browser opens, nondeterminism injected into every skill's preamble. Side effect in hot path.

**Explicit command (`/plan-tune show-landed`):** User opts in.
- Pros: No hot-path side effects. User controls when to see it.
- Cons: Requires user discovery. The "surprise you when you earned it" magic is lost.

**Post-ship hook (`/ship` triggers detection after PR creation):** Tied to /ship.
- Pros: Natural timing. No preamble cost.
- Cons: /ship isn't always the landing event (manual merges, team members merging, etc.).

**Chosen: DEFERRED entirely.** v2 will design this properly. When promoted, it moves out of preamble. User accepted Codex's argument that a celebration page in the preamble is strategic misfit for an already-risky feature.

### Decision G: Calibration gate — 20 events vs. diversity-checked — ANSWER: DIVERSITY-CHECKED

**"20 events" (original):** Simple count.
- Pros: Trivial to implement.
- Cons (Codex #13): Gameable. 20 inline "unnecessary" replies to ONE question should not calibrate five dimensions.

**Diversity check (revised):** `sample_size >= 20 AND skills_covered >= 3 AND question_ids_covered >= 8 AND days_span >= 7`.
- Pros: Profile has actually been exercised across the system before it's trusted.
- Cons: Slightly more complex.

**Chosen: diversity check.** In v1 used only for "enough data to display" threshold. In v2 will be the gate for psychographic-driven auto-decide.

### Decision H: Implementation order — classifiers first vs. integration point first — ANSWER: INTEGRATION POINT FIRST (registry + CI lint)

**Classifiers first (original):** Build bin tools, then resolvers, then skill template.
- Pros: Atomic building blocks. Can unit-test before integration.
- Cons (Codex #19): Builds machinery around an unenforceable convention. If the convention doesn't hold, all the work is wasted.

**Integration point first (revised):** Build typed registry + CI lint first. Prove the integration works before building infrastructure on top.
- Pros: Foundation is proven. Infrastructure has something durable to rely on.
- Cons: Requires auditing every existing AskUserQuestion in gstack — substantial up-front work.

**Chosen: integration point first.** Codex's argument was decisive. The audit is exactly the point — it forces us to catalog what we actually have before building adaptation on top.

### Decision I: Telemetry for TTHW — opt-in telemetry vs. local-only — ANSWER: LOCAL-ONLY

**Opt-in telemetry (original, suggested in DX review):** Instrument TTHW via telemetry event.
- Pros: Quantitative measure of onboarding experience across all users.
- Cons (Codex #14): Contradicts local-first OSS framing. Adds telemetry surface specifically for this skill.

**Local-only (revised):** Logging is local. Respect existing `telemetry` config; skill adds no new telemetry channels.
- Pros: Consistent with gstack's local-first ethos.
- Cons: No aggregate view of onboarding time.

**Chosen: local-only.** If we need TTHW data later, we add it as a gstack-wide telemetry event behind existing opt-in, not a skill-specific one.

### Decision J: Profile poisoning defense — no defense vs. confirmation gate vs. user-origin gate — ANSWER: USER-ORIGIN GATE

**No defense (original — caught by Codex):** Agent writes any tune event it sees.
- Pros: Simplest. No additional trust checks.
- Cons (Codex #16): Malicious repo content, PR descriptions, tool output can inject `tune: never ask` and poison the profile. This is a real attack surface.

**Confirmation gate:** Every tune write prompts "Confirmed? [Y/n]".
- Pros: Universal defense.
- Cons: Friction on every legitimate use.

**User-origin gate:** Agent only writes tune events when the `tune:` prefix appears in the user's own chat message for the current turn (not tool output, not file content). Binary validates `source: "inline-user"`.
- Pros: Blocks the attack without friction on legitimate use.
- Cons: Relies on agent correctly identifying source. Binary-level validation is the enforcement.

**Chosen: user-origin gate.** Matches the threat model (malicious content in automated inputs) without degrading the normal flow.

## Success Criteria

- `bun test` passes including new `test/plan-tune.test.ts`.
- Every AskUserQuestion invocation in every SKILL.md.tmpl has a registry entry. CI lint enforces.
- Migration from `~/.gstack/builder-profile.jsonl` preserves 100% of sessions + signals_accumulated. Regression test with 7-session fixture.
- One-way door registry-declared entries: 100% of destructive ops, architecture forks, scope-adds > 1 day CC effort, security/compliance choices are classified `one-way`.
- User-origin gate test: attempting to write a tune event with `source: "inline-tool-output"` is rejected.
- Dogfood: Garry uses `/plan-tune` for 2+ weeks. Reports back whether:
  - `tune: never-ask` felt natural to type or got ignored
  - Registry maintenance (adding new questions) felt like reasonable discipline or schema bureaucracy
  - Inferred dimensions were stable across sessions or noisy
  - Plain-English interaction felt like a coach or like arguing with a chatbot

## Implementation Order

1. Audit every `AskUserQuestion` invocation in every gstack SKILL.md.tmpl. Build initial `scripts/question-registry.ts` with IDs, categories, door_types, options. This is the foundation; everything else sits on it.
2. Write `test/plan-tune.test.ts` registry-completeness test (gate tier). Verify it catches drift — temporarily remove one registry entry, confirm CI fails.
3. Seed `scripts/one-way-doors.ts` with keyword-pattern fallback classifier.
4. Seed `scripts/psychographic-signals.ts` with initial `{question_id, user_choice} → {dimension, delta}` mappings. Numbers are tentative — v1 ships, v2 recalibrates.
5. Seed `scripts/archetypes.ts` with archetype definitions (referenced by future v2 `/plan-tune vibe`).
6. `bin/gstack-question-log` — validates against registry, rejects unknown IDs.
7. `bin/gstack-question-preference` — all subcommands + tests.
8. `bin/gstack-developer-profile` — `--read` (legacy), `--derive`, `--gap`, `--profile`.
9. Migration script — builder-profile.jsonl → unified developer-profile.json. Atomic, idempotent, archives source. Regression test with fixture.
10. `scripts/resolvers/question-tuning.ts` — three generators (preference check, log, inline tune with user-origin gate instructions).
11. Register the 3 resolvers in `scripts/resolvers/index.ts`.
12. Update `scripts/resolvers/preamble.ts` — `_QUESTION_TUNING` config read; conditionally inject for tier >= 2 skills.
13. `plan-tune/SKILL.md.tmpl` — conversational plain-English skill.
14. `bun run gen:skill-docs` — all SKILL.md files regenerated; verify each stays under 100KB token ceiling.
15. `bun test` — all 45+ test cases green.
16. Dogfood 2+ weeks. Collect real question-log + preferences data. Measure against success criteria.
17. `/ship` v1. v2 scope discussion after dogfood.

## Open Questions (v2 scope decisions, deferred until real data)

1. Exact signal map deltas. v1 ships with initial guesses; v2 recalibrates from observed data.
2. When `inferred` and `declared` gap becomes large, do we auto-suggest updating `declared`? Or just display?
3. When a signal map version changes, do we auto-recompute or prompt user? Default: auto-recompute with diff display.
4. Cross-project profile inheritance vs. isolation. v1 is per-project preferences + global profile; v2 may add explicit cross-project learning opt-ins.
5. Should /plan-tune support a "team profile" mode where a shared developer-profile informs collaboration? v2+.

## Reviews incorporated

- **/office-hours (2026-04-16, 1 session):** Set 5 hard constraints, chose event-sourced + user-declared architecture.
- **/plan-ceo-review (2026-04-16, EXPANSION mode):** 6 expansions accepted, later rolled back after Codex review.
- **/plan-devex-review (2026-04-16, POLISH mode):** Plain-English interaction model; this survived to v1.
- **/plan-eng-review (2026-04-16):** Test plan and completeness checks; partially superseded by registry-first rewrite.
- **/codex (2026-04-16, gpt-5.4 high reasoning):** 20-point critique drove the rollback. 15+ legitimate findings the Claude reviews missed.

## Credits and caveats

This plan was developed through an iterative AI-collaboration loop over ~6 hours of planning. The author (Garry Tan) directed every scope decision; AI voices (Claude Opus 4.7 and OpenAI Codex gpt-5.4) challenged and refined the plan. Without Codex's outside voice, a much larger and less-defensible plan would have shipped. The value of cross-model review on high-stakes architectural changes is real and measurable.
