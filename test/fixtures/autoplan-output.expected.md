---
status: LOCKED
generated_by: /autoplan
generated_at: 2026-04-27
plan_version: 1
---

# Plan: Add /widget skill (canonical fixture)

This is a synthetic plan used by `test/autoplan-output-shape.test.ts` to lock
the contract `/implement` reads. Editing this file is editing the contract:
both `/implement`'s AC parser prose AND `/autoplan`'s output emission must
agree on this shape.

## Problem Statement

Adding a new `/widget` skill that wraps an existing library. Used as a
non-trivial-but-bounded fixture for /implement's parser.

## Approaches Considered

### Approach A: Just write the skill (RECOMMENDED)

Trivial because the library already exists.

## Acceptance Criteria

### AC1: Add /widget skill template

Create `widget/SKILL.md.tmpl` with the standard frontmatter and a
phase-by-phase body that wraps the existing `widget-core.ts` library.
Generate `widget/SKILL.md` via `bun run gen:skill-docs --host all`.

- **Files**: `widget/SKILL.md.tmpl`, `widget/SKILL.md`
- **Test**: `bun test test/skill-validation.test.ts`
- **Files@SHA**: `abc1234`

### AC2: Wire widget binary into the build script

Add `bun build --compile bin/widget.ts --outfile bin/widget` to
`package.json` `scripts.build`, and add `bin/widget` to the chmod list.
Match the pattern used by `gstack-build-step` and `gstack-dashboard`.

- **Files**: `package.json`
- **Test**: `bun run build && file bin/widget`
- **Depends on**: AC1
- **Files@SHA**: `def5678`

### AC3: Add round-trip widget tests

Add `test/widget.test.ts` with at least 6 cases covering happy path,
slug validation, error surfaces, and the round-trip read-after-write
pattern.

- **Files**: `test/widget.test.ts`
- **Test**: `bun test test/widget.test.ts`
- **Depends on**: AC1, AC2

### AC4: Document the new skill in README

Add a one-paragraph blurb under `## Available skills` in `README.md`
pointing at `widget/SKILL.md`.

- **Files**: `README.md`
- **Depends on**: AC1
