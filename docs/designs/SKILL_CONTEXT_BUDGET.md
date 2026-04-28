# Skill Context Budget Plan

Status: proposed
Date: 2026-04-28
Branch: `chore/skill-context-budget-plan`

## Problem

gstack's skill surface is doing two different jobs with the same files:

1. **Routing/discovery**: the host needs enough metadata to decide whether a
   skill applies.
2. **Execution**: once selected, the model needs the actual workflow.

Today, discovery points at full `SKILL.md` files whose frontmatter descriptions
are long, and execution files inline large shared preambles plus large workflow
sections. That burns context before the user task has started and makes some
skills expensive to read even after they are correctly selected.

Measured on this clone:

| Metric | Current |
|---|---:|
| Visible generated `SKILL.md` files | 47 |
| Total visible `SKILL.md` bytes | 2,297,236 |
| Approx visible body tokens | 574,309 |
| Skills over 50 KB | 18 |
| Frontmatter description chars | 20,951 |
| Approx frontmatter description tokens | 5,238 |

Largest bodies:

| Skill | Bytes |
|---|---:|
| `ship/SKILL.md` | 145,370 |
| `plan-ceo-review/SKILL.md` | 119,001 |
| `office-hours/SKILL.md` | 103,944 |
| `plan-design-review/SKILL.md` | 94,388 |
| `plan-devex-review/SKILL.md` | 94,240 |
| `design-review/SKILL.md` | 88,647 |
| `plan-eng-review/SKILL.md` | 85,742 |
| `land-and-deploy/SKILL.md` | 82,818 |
| `autoplan/SKILL.md` | 79,479 |
| `review/SKILL.md` | 78,992 |

There is already a concrete symptom in `test/skill-e2e-workflow.test.ts`: the
Codex E2E test extracts only the review-relevant section because the full
`codex/SKILL.md` is large enough to exhaust turns.

## Goals

- Reduce eager skill discovery context without making skills harder to invoke.
- Keep skill behavior intact by loading detailed workflow text only after routing.
- Add budget tests so future growth is visible and eventually blocked.
- Make the change host-aware: Claude, Codex, OpenCode, OpenClaw, Factory, and
  other generated hosts should all benefit without one-off patches.

## Non-Goals

- Do not build a runtime tool-output compactor. `docs/designs/GCOMPACTION.md`
  covers that separate problem and is blocked on host API support.
- Do not rewrite all skill workflows in one PR.
- Do not hard-fail existing large skills before the repo has a migration path.
- Do not remove behavior solely to hit byte targets; move it behind lazy loading
  or shared references first.

## Design Principles

1. **Discovery is not execution.** Discovery metadata should be a compact routing
   index; full workflow instructions should be read only for selected skills.
2. **Budgets must ratchet.** Start with measured warn-only thresholds, then lower
   and harden once the first slimming pass lands.
3. **Reference files are acceptable.** A skill can instruct the agent to read
   `references/...` only when that branch of the workflow is reached.
4. **Behavioral invariants get tests.** Any slimming pass needs static checks and
   at least targeted E2E coverage for the affected skill family.

## Proposed Architecture

### 1. Add a Skill Context Budget Reporter

Create `scripts/skill-context-budget.ts` with two modes:

- `--report`: print a table and JSON summary.
- `--check`: enforce configured thresholds.

Metrics:

- generated skill body bytes, lines, and approximate tokens
- frontmatter description chars and approximate tokens
- eager catalog estimate: one line per skill with name, short description, and path
- largest skills
- largest descriptions
- per-host generated totals when host output directories exist
- hidden/generated duplicate totals under host subdirectories

Initial thresholds should be warn-only except where clearly safe:

| Budget | Initial | Enforcement |
|---|---:|---|
| Per-description target | 180 chars | warn |
| Per-description hard limit | 360 chars | fail for new or edited templates |
| Eager catalog target | 12,000 chars | warn |
| Individual skill target | 50 KB | warn |
| Individual skill hard ceiling | 160 KB | fail, matching current generator ceiling |
| Preamble target for tier >= 2 | 22 KB | warn |

Wire it into:

- `bun run skill:budget`
- `bun run skill:budget:check`
- `bun test` via a new free unit test
- `bun run skill:check` summary output

This should reuse `scripts/discover-skills.ts` and the existing frontmatter
parser logic from `scripts/gen-skill-docs.ts` or move that parser into a shared
helper.

### 2. Split Routing Metadata From Long Descriptions

The frontmatter `description` field should become short enough to be safe for
eager catalogs. Long explanations should move to the body or to references.

Template convention:

```yaml
---
name: ship
description: Ship workflow: test, review, version, changelog, commit, push, and open a PR.
triggers:
  - ship it
  - create a pr
  - push this branch
---
```

Rules:

- `description` is one sentence, preferably <= 180 chars.
- `triggers` carries invocation phrases, not prose.
- Host-specific `openai.yaml` keeps using `short_description`.
- Existing long "Use when..." text moves into a body section named
  `## Routing Notes` if the workflow still needs it.

Expected result:

- 47-skill description total falls from 20,951 chars to <= 8,500 chars.
- The active catalog with paths should stay under about 11,000 chars.

### 3. Make the Shared Preamble Load-Bearing But Smaller

Current `scripts/resolvers/preamble.ts` composes useful sections, but many of
them are inlined into every large skill. Keep only session-critical instructions
inline:

- update/session/config echo block
- routing prefix rules
- user-decision and AskUserQuestion contract
- completion/status bookkeeping

Move expanded guidance into references:

- `references/preamble/voice.md`
- `references/preamble/writing-style.md`
- `references/preamble/context-recovery.md`
- `references/preamble/search-before-building.md`
- `references/preamble/completeness.md`

Generated skills should say when to read those references. Example:

```md
For substantial implementation or review work, read
`$GSTACK_ROOT/references/preamble/context-recovery.md` before starting.
```

This preserves behavior for complex tasks while keeping every skill's default
read smaller.

### 4. Split Mega Workflows Into Router + References

For the top 10 skills, keep `SKILL.md.tmpl` as the routing and phase skeleton.
Move rarely used branches into explicit reference files.

Priority order:

1. `codex`: extract review, consult, challenge, and session-continuity modes.
2. `ship`: extract coverage audit, plan validation, review-army, Greptile, and
   document-release handoff sections.
3. `review`: extract specialist checklists and report templates.
4. `plan-ceo-review`, `plan-eng-review`, `plan-design-review`,
   `plan-devex-review`: extract scoring rubrics and outside-voice protocols.
5. `qa` and `design-review`: extract bug report templates, browser command
   recipes, and fix-loop rubrics.

Target body budgets after migration:

| Skill family | Target |
|---|---:|
| `codex` | <= 30 KB |
| `review` | <= 45 KB |
| `ship` | <= 70 KB |
| plan-review skills | <= 60 KB each |
| QA/design-review skills | <= 55 KB each |

The generated workflow can still load multiple references during execution, but
only after the model has selected the relevant mode.

### 5. Host Output Hygiene

Generated host variants should not accidentally become discoverable by unrelated
hosts. Add a budget reporter check that flags `SKILL.md` files under hidden host
subdirectories, and document expected install layout for each host.

Candidate rules:

- Claude global install should contain Claude-facing skills only.
- Codex global install should contain Codex-facing skills only.
- Repo-local generated host directories should stay outside other hosts'
  discovery paths or include a host-specific ignore/sentinel when supported.

This is mostly a packaging/install concern, not a prompt-writing concern.

## Implementation Sequence

### Phase 0: Metrics and Guardrails

Files:

- `scripts/skill-context-budget.ts`
- `test/skill-context-budget.test.ts`
- `package.json`
- `scripts/skill-check.ts`

Deliverables:

- report current body and discovery budgets
- fail only for parser errors and the existing 160 KB hard ceiling
- warn on large descriptions, large preambles, and >50 KB skills

Validation:

```bash
bun run skill:budget
bun run skill:budget:check
bun test test/skill-context-budget.test.ts
```

### Phase 1: Description Slimming

Files:

- every `*/SKILL.md.tmpl` frontmatter description
- `test/gen-skill-docs.test.ts`

Deliverables:

- one-sentence descriptions
- invocation phrases moved to `triggers`
- test asserts all generated descriptions are <= 360 chars
- warning target <= 180 chars

Validation:

```bash
bun run gen:skill-docs
bun test test/gen-skill-docs.test.ts test/skill-validation.test.ts
```

### Phase 2: Shared Preamble Slim

Files:

- `scripts/resolvers/preamble.ts`
- `scripts/resolvers/preamble/*`
- `references/preamble/*.md`
- `test/gen-skill-docs.test.ts`
- golden fixture updates

Deliverables:

- tier >= 2 preamble target reduced from the current 33 KB guard toward 22 KB
- voice/writing/context sections moved to lazy references where safe
- existing tests assert the core voice and AskUserQuestion contracts remain

Validation:

```bash
bun run gen:skill-docs
bun test test/gen-skill-docs.test.ts test/preamble-compose.test.ts
```

### Phase 3: Split One Mega Skill First

Start with `codex` because the E2E test already works around body size.

Files:

- `codex/SKILL.md.tmpl`
- `codex/references/*.md`
- `test/skill-e2e-workflow.test.ts`

Deliverables:

- `codex/SKILL.md` <= 30 KB
- E2E test reads the full generated skill, not a sliced section
- no loss of review/challenge/consult mode coverage

Validation:

```bash
bun run gen:skill-docs
bun test test/gen-skill-docs.test.ts test/skill-e2e-workflow.test.ts
```

### Phase 4: Ratchet and Repeat

After `codex` proves the pattern:

- split `review`
- split `ship`
- split the plan-review family
- lower body warnings from 50 KB to 40 KB
- convert the per-description 360 char limit from "new/edited templates" to all
  templates

## Acceptance Criteria

- `bun run skill:budget:check` passes.
- Total frontmatter description chars <= 8,500.
- Eager catalog estimate <= 11,000 chars including paths.
- No generated visible `SKILL.md` exceeds 160 KB.
- `codex/SKILL.md` no longer needs section slicing in E2E.
- Tier >= 2 preamble guard is ratcheted below 25 KB.
- Behavior-preserving tests pass for generator, validation, and the first split
  mega-skill.

## Risks

- **Behavior drift from slimming.** Mitigate with golden fixture diffs and E2E
  tests for each split skill.
- **Host-specific routing regressions.** Mitigate by testing generated output for
  Claude and Codex first, then all hosts.
- **Too many lazy reads.** A split skill can become slower if it loads many
  references unconditionally. Each reference must be mode- or phase-gated.
- **Budget gaming.** Byte limits alone can remove useful instruction. Pair every
  budget ratchet with behavior invariants.

## Open Questions

- Does Claude Code's eager skill catalog consume full `description` only, or also
  other frontmatter fields like `triggers`? We should verify empirically before
  relying on trigger-heavy metadata.
- Which hosts support ignore files or non-discoverable reference directories?
- Should shared references live under root `references/` or under each skill
  directory? Root references reduce duplication; per-skill references make
  ownership clearer.
- Should `skill:budget:check` compare against an explicit JSON baseline to catch
  percentage growth, or only enforce absolute limits?

## Recommended First PR

Ship Phase 0 and Phase 1 together:

1. Add `scripts/skill-context-budget.ts`.
2. Add free budget tests.
3. Add `skill:budget` scripts.
4. Slim descriptions in templates only.
5. Regenerate `SKILL.md` files.

This creates immediate context savings with low behavior risk, and it gives later
preamble/workflow refactors a measurable gate.
