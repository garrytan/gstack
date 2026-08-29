# Using gstack in Cursor

This repository is wired as a Cursor-native gstack checkout. You do not need Claude Code, and you do not need `./setup --host cursor`, to use the skills in this repo.

## What loaded

| Surface | Path | Role |
|---------|------|------|
| Skills | `.cursor/skills/<name>/SKILL.md` | Slash-invocable workflows (`/office-hours`, `/ship`, …) |
| Rules | `.cursor/rules/*.mdc` | Always-on routing + safety |
| Hooks | `.cursor/hooks.json` | `/careful` and `/freeze` enforcement |
| Catalog | `AGENTS.md` | Skill index and Cursor tool map |

Type `/` in Agent chat and pick a gstack skill, or describe the work and the agent will load the matching skill.

## First run

```bash
bun install
./setup                 # builds browse/design binaries (optional but needed for /qa /browse /design-*)
```

If `browse/dist/browse` is missing, skills fall back to `bun run browse/src/cli.ts`.

## Regenerating skills

Cursor skills are generated from the same `.tmpl` sources as the rest of gstack:

```bash
bun run gen:cursor-native
```

Edit `office-hours/SKILL.md.tmpl` (not `.cursor/skills/office-hours/SKILL.md`), then regenerate.

Do **not** run `bun run gen:skill-docs --host cursor` on top of this checkout if you want to keep the unprefixed native skills as the ones Cursor discovers. That command writes a prefixed `gstack-*` install slice (gitignored) meant for `./setup --host cursor` into other projects.

## Tool mapping

gstack templates were written for Claude Code. The Cursor generator rewrites them:

- AskUserQuestion → AskQuestion
- Bash → Shell
- Agent → Task
- CLAUDE.md → AGENTS.md
- Skill tool → Read `.cursor/skills/<name>/SKILL.md`
- Chrome MCP → gstack browse binary

## Safety skills

`/careful`, `/freeze`, and `/guard` are opt-in. Hooks do nothing until the skill writes state under `~/.gstack/` (or `$GSTACK_HOME`):

- `careful-active` — enable destructive-command checks
- `freeze-dir.txt` — block writes outside that directory

`/unfreeze` clears the freeze file.
