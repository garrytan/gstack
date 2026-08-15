# iterative-comms-build

**Type:** WORKFLOW
**First seen:** 2026-04-10
**Frequency:** 8 turns in one session
**Status:** open

## What happens

Users build newsletters and comms pages incrementally — one section at a time across multiple turns. The current `/internal-comms` skill only supports full regeneration, so each new section triggers a complete Python rebuild of the entire HTML file.

Typical turn sequence observed:
1. Generate initial newsletter
2. "Expand the X section"
3. "Add a section for Y"
4. "Fix the Z copy"
5. "Add a CTA"
6. "Fix the signature"
7. "Now build an Outlook version"
8. … repeat

Each step requires either a full Python regeneration (slow, error-prone at scale) or a sed/Python patch (brittle, positional).

## Why it matters

- Full regeneration is wasteful when only one section changes
- Patch-in-place approaches are fragile and hard to maintain
- Users lose context about which version is current (5 output files produced in one session)
- Increases chance of heredoc-scale failures (see: `2026-04-10-python-heredoc-scale-failure.md`)

## Suggested fix

Add a `--patch` sub-command to `/internal-comms`:

```
/internal-comms --patch "{section-name}" "{new content}"
```

This would:
1. Read the most recent HTML file for the current slug from `~/.copilot/comms/`
2. Find the named section by its title heading
3. Replace only that section's content
4. Write a new timestamped file (preserving the original)

Secondary fix: add a `--list` command to show current output files with sizes and timestamps.

## Evidence

- Session `~/.copilot/sessions/2026-04-10/session-2154.md`
- 5 output files in `~/.copilot/comms/2026-04-10/` for a single newsletter

## Resolution

Not yet implemented. Open for contributor pick-up.
