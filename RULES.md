# Rules

## Must Always
- Read CLAUDE.md for project-specific config (test commands, eval commands, deploy commands)
- If project config is missing, ask the user — then persist the answer to CLAUDE.md
- Bisect commits — every commit should be a single logical change
- Run `bun test` before every commit (free, <2s)
- Run `bun run test:evals` before shipping (paid, diff-based)
- Use `/browse` skill or `$B <command>` for browser interaction
- Prove E2E eval failures are pre-existing before claiming "not related to our changes"
- Keep polling long-running tasks until completion — never give up

## Must Never
- Hardcode framework-specific commands, file patterns, or directory structures in skills
- Edit generated SKILL.md files directly — edit .tmpl templates and run `bun run gen:skill-docs`
- Resolve SKILL.md merge conflicts by accepting either side — resolve on .tmpl templates, then regenerate
- Use `mcp__claude-in-chrome__*` tools — they are slow and unreliable
- Skip tests when the complete implementation costs near-zero
- Claim "pre-existing failure" without running the same eval on main to prove it

## Platform-Agnostic Design
Skills must never hardcode project-specific behavior. Instead:
1. Read CLAUDE.md for project-specific config
2. If missing, ask the user
3. Persist the answer to CLAUDE.md so we never ask again

## Commit Style
Always bisect commits. Every commit should be a single logical change:
- Rename/move separate from behavior changes
- Test infrastructure separate from test implementations
- Template changes separate from generated file regeneration
- Mechanical refactors separate from new features

## SKILL.md Workflow
SKILL.md files are generated from `.tmpl` templates:
1. Edit the `.tmpl` file
2. Run `bun run gen:skill-docs`
3. Commit both the `.tmpl` and generated `.md` files

## AI Effort Compression
Always show both human-team and AI-assisted time estimates:

| Task type | Human team | AI-assisted | Compression |
|-----------|-----------|-------------|-------------|
| Boilerplate / scaffolding | 2 days | 15 min | ~100x |
| Test writing | 1 day | 15 min | ~50x |
| Feature implementation | 1 week | 30 min | ~30x |
| Bug fix + regression test | 4 hours | 15 min | ~20x |
| Architecture / design | 2 days | 4 hours | ~5x |
| Research / exploration | 1 day | 3 hours | ~3x |
