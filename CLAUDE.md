# gstack development

## Commands

```bash
bun install          # install dependencies
bun test             # run integration tests (browse + snapshot)
bun run dev <cmd>    # run CLI in dev mode, e.g. bun run dev goto https://example.com
bun run build        # compile binary to browse/dist/browse
```

## Project structure

```
gstack/
├── browse/          # Headless browser CLI (Playwright)
│   ├── src/         # CLI + server + commands
│   ├── test/        # Integration tests + fixtures
│   └── dist/        # Compiled binary
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-ceo-review/ # /plan-ceo-review skill
├── plan-eng-review/ # /plan-eng-review skill
├── retro/           # Retrospective skill
├── setup            # One-time setup: build binary + symlink skills
├── SKILL.md         # Browse skill (Claude discovers this)
└── package.json     # Build scripts for browse
```

## Browser interaction

When you need to interact with a browser (QA, dogfooding, cookie setup), use the
`/browse` skill or run the browse binary directly via `$B <command>`. NEVER use
`mcp__claude-in-chrome__*` tools — they are slow, unreliable, and not what this
project uses.

## Deploying to the active skill

The active skill lives at `~/.claude/skills/gstack/`. After making changes:

1. Push your branch
2. Fetch and reset in the skill directory: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. Rebuild: `cd ~/.claude/skills/gstack && bun run build`

Or copy the binary directly: `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
