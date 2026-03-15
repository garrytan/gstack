# TODOS.md Format Reference

Shared reference for the canonical TODOS.md format. Referenced by `/ship` (Step 5.5) and `/plan-ceo-review` (TODOS.md updates section) to ensure consistent TODO item structure.

---

## File Structure

```markdown
# TODOS

## <Skill/Component>     ← e.g., ## Browse, ## Ship, ## Review, ## Infrastructure
<items sorted P0 first, then P1, P2, P3, P4>

## Completed
<finished items with completion annotation>
```

**Sections:** Organize by skill or component (`## Browse`, `## Ship`, `## Review`, `## QA`, `## Retro`, `## Infrastructure`). Within each section, sort items by priority (P0 at top).

---

## TODO Item Format

Each item is an H3 under its section:

```markdown
### <Title>

**What:** One-line description of the work.

**Why:** The concrete problem it solves or value it unlocks.

**Context:** Enough detail that someone picking this up in 3 months understands the motivation, the current state, and where to start.

**Effort:** S / M / L / XL
**Priority:** P0 / P1 / P2 / P3 / P4
**Depends on:** <prerequisites, or "None">
```

**Required fields:** What, Why, Context, Effort, Priority
**Optional fields:** Depends on, Blocked by

---

## Priority Definitions

- **P0** — Blocking: must be done before next release
- **P1** — Critical: should be done this cycle
- **P2** — Important: do when P0/P1 are clear
- **P3** — Nice-to-have: revisit after adoption/usage data
- **P4** — Someday: good idea, no urgency

---

## Completed Item Format

When an item is completed, move it to the `## Completed` section preserving its original content and appending:

```markdown
**Completed:** vX.Y.Z (YYYY-MM-DD)
```
