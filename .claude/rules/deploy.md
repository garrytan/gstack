---
paths:
  - ".claude/skills/gstack/**"
---

# Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

Or copy the binaries directly:
- `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
- `cp design/dist/design ~/.claude/skills/gstack/design/dist/design`
