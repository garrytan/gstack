# gstack-ship (agent alias)

Thin Claude Code skill so agents invoke **Skill `gstack-ship`** instead of the flat `ship`
skill or the built-in `/ship` command. The workflow body stays in
`$GSTACK_ROOT/ship/SKILL.md` and upgrades with gstack.

## Install

After this change is in your gstack checkout, run setup from the gstack root:

```bash
cd ~/.claude/skills/gstack   # or your project-local skills path
git pull
./setup
test -f ~/.claude/skills/gstack-ship/SKILL.md
test -L ~/.claude/skills/gstack-ship/sections
```

Setup calls `link_claude_gstack_ship_alias` on both global and project-local Claude
install paths. It copies `gstack-ship/SKILL.md` and symlinks `sections/` to
`ship/sections/`.

## Verify

```bash
grep '^name: gstack-ship' ~/.claude/skills/gstack-ship/SKILL.md
```

Agents should use the Skill tool with name `gstack-ship`, which reads the canonical
`ship/SKILL.md` at runtime and runs `gstack-skill-start --skill ship`.

Humans may still type `/ship` in environments where the built-in command is intended.