# Plan Tuning v1 — Design Doc

**Status:** Approved for implementation (2026-04-18)
**Branch:** garrytan/plan-tune-skill
**Authors:** Garry Tan (user), with AI-assisted reviews from Claude Opus 4.7 + OpenAI Codex gpt-5.4
**Supersedes scope:** adds writing-style + LOC-receipts layer on top of [PLAN_TUNING_V0.md](./PLAN_TUNING_V0.md) (observational substrate). V0 remains in place unchanged.
**Related:** [PACING_UPDATES_V0.md](./PACING_UPDATES_V0.md) — extracted pacing overhaul, V1.1 plan.

## What this document is

A canonical record of what /plan-tune v1 is, what it is NOT, what we considered, and why we made each call. Committed to the repo so future contributors (and future Garry) can trace reasoning without archeology. Supersedes any per-user local plan artifacts.

## Credit

This plan exists because of **[Louise de Sadeleer](https://x.com/LouiseDSadeleer/status/2045139351227478199)**, who sat through a complete gstack run as a non-technical user and told us the truth about how it feels. Her specific feedback:

1. "I was getting a bit tired after a while and it felt a little bit rigid." — *pacing/fatigue*
2. "I'm just gonna say yes yes yes" (during architecture review). — *disengagement*
3. "What I find funny is his emphasis on how many lines of code he produces. AI has produced for him of course." — *LOC framing*
4. "As a non-engineer this is a bit complicated to understand." — *jargon density + outcome framing*

V1 addresses #3 and #4 directly: jargon-glossing + outcome-framed writing that reads like a real person wrote it for the reader, plus a defensible LOC reframe. Louise's #1 and #2 (pacing/fatigue) require a separate design round — extracted to [PACING_UPDATES_V0.md](./PACING_UPDATES_V0.md) as the V1.1 plan.

## The feature, in one paragraph

gstack skill output is the product. If the prose doesn't read well for a non-technical founder, they check out of the review and click "yes yes yes." V1 adds a writing-style standard that applies to every tier ≥ 2 skill: jargon glossed on first use (from a curated ~50-term list), questions framed in outcome terms ("what breaks for your users if...") not implementation terms, short sentences, concrete nouns. Power users who want the tighter V0 prose can set `gstack-config set explain_level terse`. Binary switch, no partial modes. Plus: the README's "600,000+ lines of production code" framing — rightly called out as LOC vanity by Louise — gets replaced with a real computed 2013-vs-2026 pro-rata multiple from an `scc`-backed script, with honest caveats about public-vs-private repo visibility.

## Why we're building the smaller version

V1 went through four substantial scope revisions over multiple review passes. Final scope is smaller than any intermediate version because each review pass caught real problems.

**Revision 1 — Four-level experience axis (rejected).** Original proposal: ask users on first run whether they're an experienced dev, an engineer-without-solo-experience, non-technical-who-shipped-on-a-team, or non-technical-entirely. Skills adapt per level. Rejected during CEO review's premise-challenge step because (a) the onboarding ask adds friction at exactly the moment V1 is trying to reduce it, (b) "what level am I?" is itself a confusing question for the users who most need help, (c) technical expertise isn't one-dimensional (designer level A on CSS, level D on deploy), (d) engineers benefit from the same writing standards non-technical users do.

**Revision 2 — ELI10 by default, terse opt-out (accepted).** Every skill's output defaults to the writing standard. Power users who want V0 prose set `explain_level: terse`. Codex Pass 1 caught critical gaps (static-markdown gating, host-aware paths, README update mechanism) — all three integrated.

**Revision 3 — ELI10 + review-pacing overhaul (proposed, scoped back).** Added a pacing workstream: rank findings, auto-accept two-way doors, max 3 AskUserQuestion prompts per phase, Silent Decisions block with flip-command. Intended to address Louise's #1 and #2 directly. Eng review Pass 2 caught scoring-formula and path-consistency bugs. Eng review Pass 3 + Codex Pass 2 surfaced 10+ structural gaps in the pacing workstream that couldn't be fixed via plan-text editing.

**Revision 4 — ELI10 + LOC only (final).** User chose scope reduction: ship V1 with writing style + LOC receipts, defer pacing to V1.1 via [PACING_UPDATES_V0.md](./PACING_UPDATES_V0.md). This is the approved V1 scope.

The through-line: every review pass correctly narrowed the ambition until the remaining scope had no structural gaps. Matches the CEO review skill's SCOPE REDUCTION mode, arrived at late via engineering review rather than early via strategic choice.

## v1 Scope (what we're building now)

1. **Writing Style section in preamble** (`scripts/resolvers/preamble.ts`). Six rules: jargon-gloss on first use per skill invocation, outcome framing, short sentences / concrete nouns / active voice, decisions close with user impact, gloss-on-first-use-unconditional (even if user pasted the term), user-turn override (user says "be terse" → skip for that response).
2. **Jargon boundary via repo-owned list** (`scripts/jargon-list.json`). ~50 curated high-frequency technical terms. Terms not on the list are assumed plain-English enough. Terms inlined into generated SKILL.md prose at `gen-skill-docs` time (zero runtime cost).
3. **Terse opt-out** (`gstack-config set explain_level terse`). Binary: `default` vs `terse`. Terse skips the Writing Style block entirely and uses V0 prose style.
4. **Host-aware preamble echo.** `_EXPLAIN_LEVEL=$(${binDir}/gstack-config get explain_level 2>/dev/null || echo "default")`. Host-portable via existing V0 `ctx.paths.binDir` pattern.
5. **gstack-config validation.** Document `explain_level: default|terse` in header. Whitelist values. Warn on unknown with specific message + default to `default`.
6. **LOC reframe in README.** Remove "600,000+ lines of production code" hero framing. Insert `<!-- GSTACK-THROUGHPUT-PLACEHOLDER -->` anchor. Build-time script replaces anchor with computed multiple + caveat.
7. **`scc`-backed throughput script** (`scripts/garry-output-comparison.ts`). For each of 2013 + 2026, enumerate Garry-authored public commits, extract added lines from `git diff`, classify via `scc --stdin` (or regex fallback). Output `docs/throughput-2013-vs-2026.json` with per-language breakdown + caveats.
8. **`scc` as standalone install script** (`scripts/setup-scc.sh`). Not a `package.json` dependency (truly optional — 95% of users never run throughput). OS-detects and runs `brew install scc` / `apt install scc` / prints GitHub releases link.
9. **README update pipeline** (`scripts/update-readme-throughput.ts`). Reads `docs/throughput-2013-vs-2026.json` if present, replaces the anchor with computed number. If missing, writes `GSTACK-THROUGHPUT-PENDING` marker that CI rejects — forces contributor to run the script before commit.
10. **/retro adds logical SLOC + weighted commits above raw LOC.** Raw LOC stays for context but is visually demoted.
11. **Upgrade migration** (`gstack-upgrade/migrations/v<VERSION>.sh`). One-time post-upgrade interactive prompt offering to restore V0 prose via `explain_level: terse` for users who prefer it. Flag-file gated.
12. **Documentation.** CLAUDE.md gains a Writing Style section (project convention). CHANGELOG.md gets V1 entry (user-facing narrative, mentions scope reduction + V1.1 pacing). README.md gets a Writing Style explainer section (~80 words). CONTRIBUTING.md gains a note on jargon-list maintenance (PRs to add/remove terms).
13. **Tests.** 6 new test files + extension of existing `gen-skill-docs.test.ts`. All gate tier except LLM-judge E2E (periodic).
14. **V0 dormancy negative tests.** Assert 5D dimension names and 8 archetype names don't appear in default-mode skill output. Prevents V0 psychographic machinery from leaking into V1.
15. **V1 and V1.1 design docs.** PLAN_TUNING_V1.md (this file). PACING_UPDATES_V0.md (V1.1 plan, created during V1 implementation from the extracted appendix). TODOS.md P0 entry.

## Deferred

**To V1.1 (explicit, with dedicated design doc):**
- Review pacing overhaul (ranking, auto-accept, max-3-per-phase, Silent Decisions block, flip mechanism). Reasoning: see [PACING_UPDATES_V0.md](./PACING_UPDATES_V0.md) §"Why it's extracted." Has 10+ structural gaps unfixable via prose-only changes.
- Preamble first-run meta-prompt audit (lake intro, telemetry, proactive, routing). Louise saw all of them on first run; they count against fatigue. V1.1 considers suppressing until session N.

**To V2 (or later):**
- Confusion-signal detection from question-log driving on-the-fly translation offers.
- 5D psychographic-driven skill adaptation (V0 E1 item).
- /plan-tune narrative + /plan-tune vibe (V0 E3 item).
- Per-skill or per-topic explain levels.
- Team profiles.
- AST-based "delivered features" metric.

## Rejected entirely (considered, not doing)

- **Four-level declared experience axis (A/B/C/D).** Rejected during CEO review premise-challenge. See "Why we're building the smaller version" above.
- **ELI10 as a new resolver file (`scripts/resolvers/eli10-writing.ts`).** Codex Pass 1 caught the conflict with existing "smart 16-year-old" framing in preamble's AskUserQuestion Format section. Fold into existing preamble instead.
- **Runtime suppression of the Writing Style block.** Codex Pass 1 caught that `gen-skill-docs` produces static Markdown — runtime `EXPLAIN_LEVEL=terse` can't hide content already baked in. Solution: conditional prose gate (prose convention, same category as V0's `QUESTION_TUNING` gate).
- **Middle writing mode between default and terse.** Revision 3 proposed "terse = no glosses but keep outcome framing." Codex Pass 2 caught the contradiction with migration messaging. Binary wins: terse = V0 prose, full stop.
- **User-editable jargon list at runtime.** Revision 3 proposed `~/.gstack/jargon-list.json` as user override. Codex Pass 2 caught the contradiction with gen-time inlining. Resolved: repo-owned only, PRs to add/remove, regenerate to take effect.
- **`devDependencies.optional` field in package.json.** Not a real npm/bun field. Eng review Pass 2 caught. Standalone install script instead.
- **Using the same string as replacement anchor AND CI-reject marker in README.** Eng review Pass 2 / Codex Pass 2 caught that this makes the pipeline destroy its own update path. Two-string solution: `GSTACK-THROUGHPUT-PLACEHOLDER` (anchor, stays across runs) vs `GSTACK-THROUGHPUT-PENDING` (explicit "build didn't run" marker that CI rejects).
- **"Every technical term gets a gloss" as acceptance criterion.** Codex Pass 2 caught the contradiction with the curated-list rule. Acceptance rewritten to match rule: "every term on `scripts/jargon-list.json` that appears gets a gloss."
- **Acceptance criterion "≤ 12 AskUserQuestion prompts per /autoplan."** Removed from V1 — that target requires the pacing overhaul now in V1.1.

## Architecture

```
~/.gstack/
  developer-profile.json           # unchanged from V0
  config.yaml                       # + explain_level key (default | terse)

scripts/
  jargon-list.json                  # NEW: ~50 repo-owned terms (gen-time inlined)
  garry-output-comparison.ts        # NEW: scc + git per-year, author-scoped
  update-readme-throughput.ts       # NEW: README anchor replacement
  setup-scc.sh                      # NEW: OS-detecting scc installer
  resolvers/preamble.ts             # MODIFIED: Writing Style section + EXPLAIN_LEVEL echo

docs/
  designs/PLAN_TUNING_V1.md         # NEW: this file
  designs/PACING_UPDATES_V0.md      # NEW: V1.1 plan (extracted)
  throughput-2013-vs-2026.json      # NEW: computed, committed

~/.claude/skills/gstack/bin/
  gstack-config                     # MODIFIED: explain_level header + validation

gstack-upgrade/migrations/
  v<VERSION>.sh                     # NEW: V0 → V1 interactive prompt
```

### Data flow

```
User runs tier-≥2 skill
       │
       ▼
Preamble bash (per-invocation):
  _EXPLAIN_LEVEL=$(${binDir}/gstack-config get explain_level 2>/dev/null || "default")
  echo "EXPLAIN_LEVEL: $_EXPLAIN_LEVEL"
       │
       ▼
Generated SKILL.md body (static Markdown, baked at gen-skill-docs):
  - AskUserQuestion Format section (existing V0)
  - Writing Style section (NEW, conditional prose gate)
       │
       ├── "Skip if EXPLAIN_LEVEL: terse OR user says 'be terse' this turn"
       ├── 6 writing rules (jargon, outcome, short, impact, first-use, override)
       └── Jargon list inlined from scripts/jargon-list.json
       │
       ▼
Agent applies or skips based on runtime EXPLAIN_LEVEL + user-turn signal
       │
       ▼
V0 QUESTION_TUNING + question-log + preferences unchanged
       │
       ▼
Output to user (gloss-on-first-use, outcome-framed, short sentences; or V0 prose if terse)
```

### Data flow: throughput script (build-time)

```
bun run build
   │
   ├── gen:skill-docs (regenerates SKILL.md files with jargon list inlined)
   ├── update-readme-throughput (reads JSON if present; replaces anchor OR writes PENDING marker)
   └── other steps (binary compilation, etc.)

Separately, on-demand:
bun run scripts/garry-output-comparison.ts
   │
   ├── scc preflight (if missing → exit with setup-scc.sh hint)
   ├── For 2013 + 2026: enumerate Garry-authored commits in public garrytan/* repos
   ├── For each commit: git diff, extract ADDED lines, classify via scc --stdin
   └── Write docs/throughput-2013-vs-2026.json (per-language + caveats)
```

## Security + privacy

- **No new user data.** V1 extends preamble prose + config key. No new personal data collected.
- **No runtime file reads of sensitive data.** Jargon list is a repo-committed curated list.
- **Migration script is one-shot.** Flag-file prevents re-fire.
- **scc runs on public repos only.** No access to private work.

## Decisions log (with pros/cons)

### Decision A: Four-level experience axis vs. ELI10 by default — ANSWER: ELI10 BY DEFAULT

**Four-level axis (rejected):** Ask users to self-identify as A/B/C/D on first run. Skills adapt per level.
- Pros: Explicit user sovereignty. Power users get V0 behavior.
- Cons: Adds onboarding friction. Forces users to label themselves. Technical expertise isn't one-dimensional. Engineers benefit from the same writing standards non-technical users do.

**ELI10 by default with terse opt-out (chosen):** Every skill's output defaults to the writing standard. Power users set `explain_level: terse`.
- Pros: No onboarding question. Good writing benefits everyone. Power users still have an escape hatch.
- Cons: Silently changes V0 behavior on upgrade → requires migration prompt.

### Decision B: New resolver file vs. extend existing preamble — ANSWER: EXTEND EXISTING

**New resolver (rejected):** `scripts/resolvers/eli10-writing.ts` as a separate generator.
- Pros: Modular.
- Cons (Codex #7): Conflicts with existing "smart 16-year-old" framing in preamble's AskUserQuestion Format section. Two sources of truth.

**Extend preamble (chosen):** Writing Style section added to `scripts/resolvers/preamble.ts` directly below AskUserQuestion Format.
- Pros: One source of truth. Composes with existing rules.
- Cons: `preamble.ts` grows.

### Decision C: Runtime suppression vs. conditional prose gate — ANSWER: CONDITIONAL PROSE GATE

**Runtime suppression (rejected):** Preamble read of `explain_level` triggers suppression logic.
- Pros: Simpler mental model.
- Cons (Codex #1): `gen-skill-docs` produces static Markdown. Once baked, content can't be retroactively hidden. Runtime suppression is fictional.

**Conditional prose gate (chosen):** "Skip this block if EXPLAIN_LEVEL: terse OR user says 'be terse' this turn." Prose convention; agent obeys or disobeys at runtime.
- Pros: Testable. Matches V0's `QUESTION_TUNING` pattern. Honest about the mechanism.
- Cons: Depends on agent prose compliance (no hard runtime gate).

### Decision D: Jargon list location — runtime-user-editable vs. repo-owned gen-time — ANSWER: REPO-OWNED GEN-TIME

**User-editable at runtime (rejected):** `~/.gstack/jargon-list.json` overrides `scripts/jargon-list.json`.
- Pros: User can add terms specific to their domain.
- Cons (Codex #4, Pass 2): Gen-time inlining means user edits require regeneration. Contradiction.

**Repo-owned, gen-time inlined (chosen):** `scripts/jargon-list.json` only. PRs to add/remove. `bun run gen:skill-docs` inlines terms into preamble prose.
- Pros: One source of truth. Zero runtime cost. Composable with existing build.
- Cons: Users can't add terms locally. Mitigation: documented in CONTRIBUTING.md; PRs accepted.

### Decision E: Pacing overhaul in V1 vs. V1.1 — ANSWER: V1.1 (extracted)

**Pacing in V1 (rejected):** Bundle ranking + auto-accept + Silent Decisions + max-3-per-phase cap + flip mechanism.
- Pros: Addresses Louise's fatigue directly.
- Cons (Eng review Pass 3 + Codex Pass 2): 10+ structural gaps unfixable via plan-text editing. Session-state model undefined. `phase` field missing from question-log. Registry doesn't cover dynamic review findings. Flip mechanism has no implementation. Migration prompt itself is an interrupt. First-run preamble prompts also count. Pacing as prose can't invert existing ask-per-section execution order.

**Extract to V1.1 (chosen):** Ship ELI10 + LOC in V1. Pacing gets its own design round with full review cycle.
- Pros: Ships V1 honestly. Gives V1.1 real baseline data from V1 usage (Louise's V1 transcript). Matches SCOPE REDUCTION mode from CEO review.
- Cons: Louise's fatigue complaint isn't fully addressed until V1.1. Mitigation: V1 still improves her experience via writing quality; V1.1 follows up with pacing.

### Decision F: README update mechanism — single string vs. two-string — ANSWER: TWO-STRING

**Single string (rejected):** `<!-- GSTACK-THROUGHPUT-MULTIPLE: N× -->` as both replacement anchor AND CI-reject marker.
- Pros: Simple.
- Cons (Codex Pass 2): Pipeline breaks on itself — CI rejects commits containing the marker, but the marker IS the anchor.

**Two-string (chosen):** `GSTACK-THROUGHPUT-PLACEHOLDER` (anchor, stable) + `GSTACK-THROUGHPUT-PENDING` (explicit missing-build marker, CI rejects).
- Pros: Anchor persists; CI catches actual failure state.
- Cons: Two symbols to remember.

## Review record

| Review | Runs | Status | Key findings integrated |
|---|---|---|---|
| CEO Review | 1 | CLEAR (HOLD SCOPE) | Premise pivot: four-level axis → ELI10 by default. Cross-model tensions resolved via explicit user choice. |
| Codex Review | 2 | ISSUES_FOUND + drove scope reduction | Pass 1: 25 findings, 3 critical blockers (static-markdown, host-paths, README mechanism). Pass 2: 20 findings on revised plan, drove V1.1 extraction. |
| Eng Review | 3 | CLEAR (SCOPE_REDUCED) | Pass 1: critical gaps + 3 decisions (all A). Pass 2: scoring-formula bug, path contradiction, fake `devDependencies.optional` field. Pass 3: identified pacing structural gaps, drove extraction. |
| DX Review | 1 | CLEAR (TRIAGE) | 3 critical (docs plan, upgrade migration, hero moment). 9 auto-accepted as Silent DX Decisions. |

Review report persisted in `~/.gstack/` via `gstack-review-log`. Plan file retained with full history at `~/.claude/plans/system-instruction-you-are-working-transient-sunbeam.md`.
