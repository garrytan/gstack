# research-stack development

## Commands

```bash
bun install          # install dependencies
bun test             # run skill validation tests (<2s)
bun run build        # regenerate SKILL.md files from templates
bun run gen:skill-docs  # regenerate SKILL.md files (same as build)
bun run skill:check  # health dashboard for all skills
bun run dev:skill    # watch mode: auto-regen + validate on change
```

## Testing

```bash
bun test             # run before every commit — free, <2s
```

`bun test` runs skill validation and gen-skill-docs quality checks. Run before every commit.

## Project structure

```
research-stack/
├── hypothesis/      # /hypothesis skill
├── run-experiment/  # /run-experiment skill
├── report/          # /report skill
├── discuss/         # /discuss skill
├── peer-review/     # /peer-review skill
├── scripts/         # Build + DX tooling
│   ├── gen-skill-docs.ts  # Template → SKILL.md generator
│   ├── resolvers/   # Template resolver modules (preamble, research, learnings, etc.)
│   ├── skill-check.ts     # Health dashboard
│   └── dev-skill.ts       # Watch mode
├── test/            # Skill validation tests
│   ├── helpers/     # skill-parser.ts
│   ├── skill-validation.test.ts  # Static validation
│   └── gen-skill-docs.test.ts    # Generator quality checks
├── bin/             # CLI utilities (rstack-learnings-log, rstack-config, etc.)
├── lib/             # Shared libraries (worktree.ts)
├── .github/         # CI workflows (release, skill-docs freshness, actionlint)
├── SKILL.md.tmpl    # Root skill template (edit this, not SKILL.md)
├── SKILL.md         # Generated from template (don't edit directly)
└── package.json     # Scripts and dependencies
```

## Research workflow

research-stack provides 5 skills for the hypothesis-experiment-report cycle:

1. `/hypothesis` — structure a research idea into a testable hypothesis + experiment spec
2. `/run-experiment` — generate and execute experiment code with research log tracking
3. `/report` — analyze results and produce a structured research report
4. `/discuss` — interactive discussion threads on experiment findings
5. `/peer-review` — critical review of methodology, statistics, and conclusions

All experiment artifacts follow the `research/` directory structure:
`research/{hypotheses, specs, results, reports, discussions, reviews}/`.

## Research conventions

Skills look for a `## Research conventions` section in the target project's CLAUDE.md.
If missing, `/hypothesis` and `/run-experiment` auto-detect project characteristics
and prompt the researcher to confirm before writing conventions.

Expected format in the target project's CLAUDE.md:

```
## Research conventions
language: python 3.11+
test_command: pytest -x
compute_backend: local
random_seed_strategy: explicit
preferred_libraries: [numpy, scipy, stim, pymatching]
```

This section is read by the research resolver (`scripts/resolvers/research.ts`)
and injected into every skill invocation via `{{RESEARCH_CONVENTIONS}}`.

## SKILL.md workflow

SKILL.md files are **generated** from `.tmpl` templates. To update skill docs:

1. Edit the `.tmpl` file (e.g. `hypothesis/SKILL.md.tmpl`)
2. Run `bun run gen:skill-docs` (or `bun run build`)
3. Commit both the `.tmpl` and generated `.md` files

**Merge conflicts on SKILL.md files:** NEVER resolve conflicts on generated SKILL.md
files by accepting either side. Instead: (1) resolve conflicts on the `.tmpl` templates
and `scripts/gen-skill-docs.ts` (the sources of truth), (2) run `bun run gen:skill-docs`
to regenerate all SKILL.md files, (3) stage the regenerated files.

## Platform-agnostic design

Skills must NEVER hardcode language-specific commands, file patterns, or directory
structures. Instead:

1. **Read CLAUDE.md** for project-specific config (language, test commands, libraries)
2. **If missing, AskUserQuestion** — let the researcher tell you or auto-detect
3. **Persist the answer to CLAUDE.md** so we never have to ask again

The project owns its config; research-stack reads it.

## Writing SKILL templates

SKILL.md.tmpl files are **prompt templates read by Claude**, not bash scripts.
Each bash code block runs in a separate shell — variables do not persist between blocks.

Rules:
- **Use natural language for logic and state.** Don't use shell variables to pass
  state between code blocks. Instead, tell Claude what to remember and reference
  it in prose (e.g., "the base branch detected in Step 0").
- **Don't hardcode branch names.** Detect `main`/`master`/etc dynamically.
  Use `{{BASE_BRANCH_DETECT}}` for PR-targeting skills.
- **Keep bash blocks self-contained.** Each code block should work independently.
  If a block needs context from a previous step, restate it in the prose above.
- **Express conditionals as English.** Instead of nested `if/elif/else` in bash,
  write numbered decision steps: "1. If X, do Y. 2. Otherwise, do Z."

## Commit style

**Always bisect commits.** Every commit should be a single logical change. When
you've made multiple changes (e.g., a rename + a rewrite + new tests), split them
into separate commits before pushing.

Examples of good bisection:
- Template changes separate from generated file regeneration
- Resolver changes separate from template changes
- Mechanical refactors separate from new features

## CHANGELOG + VERSION style

Version is managed in `package.json` (semver). Release CI auto-tags on version bump.

**CHANGELOG is branch-scoped.** Every feature branch that ships gets its own version
bump and CHANGELOG entry describing what THIS branch adds.

CHANGELOG.md is **for users**, not contributors:
- Lead with what the user can now **do** that they couldn't before.
- Use plain language, not implementation details.
- Put contributor/internal changes in a separate section at the bottom.

## Search before building

Before designing any solution that involves concurrency, unfamiliar patterns,
infrastructure, or anything where the runtime/framework might have a built-in:

1. Search for "{runtime} {thing} built-in"
2. Search for "{thing} best practice {current year}"
3. Check official runtime/framework docs
