# Codex Compatibility

gstack keeps one upstream repo and exposes host-specific entrypoints on top of it.

## Host layout

- Claude global install: `~/.claude/skills/gstack` plus sibling skill aliases like `~/.claude/skills/browse`.
- Codex global install: `~/.codex/skills/gstack` plus sibling skills like `~/.codex/skills/gstack-browse`.
- Codex repo-local install: project `.codex/skills/gstack` plus sibling `.codex/skills/gstack-*` aliases created by `./setup --host codex`.

`./setup --host codex` is the canonical registration step for Codex. `./setup --host auto` resolves from the current install path when possible and otherwise prefers Codex.

## Alias mapping

- `/browse` → `gstack-browse`
- `/qa` → `gstack-qa`
- `/review` → `gstack-review`
- `/ship` → `gstack-ship`
- `/plan-ceo-review` → `gstack-plan-ceo-review`
- `/plan-eng-review` → `gstack-plan-eng-review`
- `/setup-browser-cookies` → `gstack-browser-cookies`
- `/retro` → `gstack-retro`

The shell wrappers in `bin/gstack-*` are compatibility sugar. They print the exact Codex-facing skill name and preserve the old gstack mental model without pretending Codex has Claude-style slash-command registration.

## Browser resolution

Prefer these browse roots, in order:

1. project `.codex/skills/gstack`
2. project `.agents/skills/gstack`
3. project `.claude/skills/gstack`
4. `~/.codex/skills/gstack`
5. `~/.agents/skills/gstack`
6. `~/.claude/skills/gstack`

Use `browse/bin/find-browse` or `browse/dist/browse` from the resolved root. The compiled browser remains the primary cross-host engine.
