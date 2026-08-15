# TODOS.md Canonical Format

Use this format when a skill recommends creating or reorganising a `TODOS.md` file.

## Goals

- Group work by **skill**, **component**, or **workstream**
- Keep the highest-priority items at the top
- Make each item actionable and easy to scan
- Preserve completed work history instead of deleting it

## Recommended Structure

```md
# TODOS

## <Area / Skill / Component>

### P0 — Critical
- [ ] Short action-oriented item
- [ ] Another urgent item

### P1 — High
- [ ] Important item

### P2 — Medium
- [ ] Useful improvement

### P3 — Low
- [ ] Nice-to-have cleanup

### P4 — Parking Lot
- [ ] Future idea or speculative follow-up

### Completed
- [x] Completed item with short outcome note
```

## Rules

1. One action per bullet.
2. Start each item with a verb.
3. Keep wording specific enough that someone else could pick it up.
4. Move finished work to **Completed** instead of deleting it.
5. If an item is blocked, say why in the bullet rather than hiding it.

## Example

```md
# TODOS

## Privacy Review

### P0 — Critical
- [ ] Confirm lawful basis for customer analytics events
- [ ] Document retention period for exported CSV reports

### P1 — High
- [ ] Add processor list for email delivery vendor

### Completed
- [x] Mapped personal data fields captured in signup flow
```
