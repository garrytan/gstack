# gstack — AI Engineering Workflow

gstack is a collection of SKILL.md files that give AI agents structured roles for
software development. Each skill is a specialist: CEO reviewer, eng manager,
designer, QA lead, release engineer, debugger, and more.

## Available skills

Skills live in `.agents/skills/`. Invoke them by name (e.g., `/office-hours`).

| Skill | What it does |
|-------|-------------|
| `/office-hours` | Start here. Reframes your product idea before you write code. |
| `/plan-ceo-review` | CEO-level review: find the 10-star product in the request. |
| `/plan-eng-review` | Lock architecture, data flow, edge cases, and tests. |
| `/plan-design-review` | Rate each design dimension 0-10, explain what a 10 looks like. |
| `/design-consultation` | Build a complete design system from scratch. |
| `/review` | Pre-landing PR review. Finds bugs that pass CI but break in prod. |
| `/debug` | Systematic root-cause debugging. No fixes without investigation. |
| `/design-review` | Design audit + fix loop with atomic commits. |
| `/qa` | Open a real browser, find bugs, fix them, re-verify. |
| `/qa-only` | Same as /qa but report only — no code changes. |
| `/ship` | Run tests, review, push, open PR. One command. |
| `/document-release` | Update all docs to match what you just shipped. |
| `/retro` | Weekly retro with per-person breakdowns and shipping streaks. |
| `/browse` | Headless browser — real Chromium, real clicks, ~100ms/command. |
| `/setup-browser-cookies` | Import cookies from your real browser for authenticated testing. |
| `/careful` | Warn before destructive commands (rm -rf, DROP TABLE, force-push). |
| `/freeze` | Lock edits to one directory. Hard block, not just a warning. |
| `/guard` | Activate both careful + freeze at once. |
| `/unfreeze` | Remove directory edit restrictions. |
| `/gstack-upgrade` | Update gstack to the latest version. |

## Build commands

```bash
bun install              # install dependencies
bun test                 # run tests (free, <5s)
bun run build            # generate docs + compile binaries
bun run gen:skill-docs   # regenerate SKILL.md files from templates
bun run skill:check      # health dashboard for all skills
```

## Key conventions

- SKILL.md files are **generated** from `.tmpl` templates. Edit the template, not the output.
- Run `bun run gen:skill-docs --host codex` to regenerate Codex-specific output.
- The browse binary provides headless browser access. Use `$B <command>` in skills.
- Safety skills (careful, freeze, guard) use inline advisory prose — always confirm before destructive operations.
