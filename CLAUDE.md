# gstack development entrypoint

gstack is a collection of SKILL.md files that give AI agents structured software
engineering roles: CEO reviewer, engineering manager, designer, QA lead, release
engineer, debugger, and browser operator.

## Start here

1. Read this file for startup-critical rules.
2. Read `AGENTS.md` for the concise cross-agent operating protocol.
3. Read `docs/AGENT_CONTEXT_REFERENCE.md` for the full historical development guide.
4. Read the specific skill directory before editing or running that skill.

## Common commands

```bash
bun install
bun test
bun run build
bun run gen:skill-docs
bun run skill:check
```

Paid evals and E2E tests are opt-in. Run them only when the touched skill or host
adapter requires them, and never print API keys.

## Important conventions

- SKILL.md files are generated from templates; edit templates, not generated output.
- Use diff-based eval selection before paid tests when possible.
- Classify new E2E tests as gate or periodic.
- Use `$B <command>` inside skills for the browse binary.
- Safety skills (`careful`, `freeze`, `guard`) are advisory and require explicit care.

## Repository map

- `browse/` — headless browser CLI and server.
- `hosts/` — typed host configs for supported agent runtimes.
- `scripts/` — build, docs, host config, and skill tooling.
- `test/` — validation, fixtures, LLM judge, and E2E tests.
- skill directories — generated specialist workflows and templates.

## Full reference

The previous monolithic CLAUDE.md content now lives at:

- `docs/AGENT_CONTEXT_REFERENCE.md`

Load it on demand for detailed project structure, eval mechanics, host internals,
release history, and exhaustive skill-directory notes. Do not re-inline that reference
here; this file is intentionally small for context hygiene.
