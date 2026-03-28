# Codebase Structure

**Analysis Date:** 2026-03-28

## Directory Layout

```
[project-root]/
├── .github/               # GitHub Actions workflows and configs
├── .planning/             # Generated planning documents (this analysis)
├── agents/                # Skill agent configurations (YAML)
├── autonplan/             # Autonomous planning skill
├── benchmark/             # Performance benchmarking tools
├── bin/                   # Executable scripts and CLI entry points
├── browse/                # Headless browser automation skill (core)
├── browse/bin/            # Compiled browse binaries
├── browse/scripts/        # Browse-specific helper scripts
├── browse/src/            # Browse skill source code
├── browse/test/           # Browse skill tests
├── canary/                # Canary release skill
├── careful/               # Destructive operation protection skill
├── codex/                 # Codex agent adapter
├── connect-chrome/        # Chrome extension connector
├── cso/                   # Customer success operations skill
├── design/                # AI-powered design generation skill
├── design/src/            # Design skill source code
├── design/test/           # Design skill tests
├── design-consultation/   # Design consultation skill
├── design-review/         # Design review skill
├── design-shotgun/        # Rapid design exploration skill
├── docs/                  # Documentation files
├── document-release/      # Release documentation skill
├── extension/             # Browser extension source
├── freeze/                # File edit protection skill
├── gstack-upgrade/        # Self-upgrade skill
├── guard/                 # Combined careful+freeze skill
├── investigate/           # Investigation and analysis skill
├── land-and-deploy/       # Deployment automation skill
├── lib/                   # Shared libraries
├── office-hours/          # Project initialization skill
├── plan-ceo-review/       # CEO-level planning review 사실은 수정 필요
├── plan-design-review/    # Design review planning skill
├── plan-eng-review/       # Engineering planning skill
├── qa/                    # Quality assurance testing skill
├── qa-only/               # QA reporting only skill
├── retro/                 # Retrospective meeting skill
├── review/                # Pull request review skill
├── scripts/               # Cross-cutting utility scripts
├── setup-browser-cookies/ # Browser cookie import skill
├── setup-deploy/          # Deployment setup skill
├── ship/                  # Release shipping skill
├── supabase/              # Supabase integration skill
├── test/                  # Root-level test files
├── unfreeze/              # File edit protection removal skill
```

## Directory Purposes

**.github/:**
- Purpose: GitHub Actions workflows for CI/CD
- Contains: Workflow YAML files for skill docs, evals, CI images
- Key files: `.github/workflows/skill-docs.yml`, `.github/workflows/evals.yml`

**agents/:**
- Purpose: Skill agent configurations for external AI integrations
- Contains: YAML configurations for different AI providers
- Key files: `agents/openai.yaml`

**browse/:**
- Purpose: Core headless browser automation functionality
- Contains: Persistent browser server, CLI interface, automation commands
- Key files: 
  - `browse/src/server.ts` - Persistent browser automation server
  - `browse/src/cli.ts` - CLI interface for browser commands
  - `browse/src/config.ts` - Configuration resolution
  - `browse/dist/browse` - Compiled binary entry point

**design/:**
- Purpose: AI-powered UI mockup generation and design assistance
- Contains: Design generation, editing, and analysis tools
- Key files:
  - `design/src/cli.ts` - CLI for design commands
  - `design/src/generate.ts` - Image generation core
  - `design/src/serve.ts` - HTTP server for design boards
  - `design/dist/design` - Compiled binary entry point

**scripts/:**
- Purpose: Cross-cutting utility scripts for skill management
- Contains: Skill generation, validation, discovery, and development tools
- Key files:
  - `scripts/gen-skill-docs.ts` - Skill documentation generation
  - `scripts/skill-check.ts` - Skill health validation
  - `scripts/dev-skill.ts` - Skill development helper
  - `scripts/discover-skills.ts` - Skill discovery and listing

**bin/:**
- Purpose: Executable scripts and compiled binaries
- Contains: Global utilities and skill entry points
- Key files:
  - `bin/gstack-global-discover` - Global skill discovery utility
  - `bin/gstack-config` - Configuration management
  - `bin/gstack-analytics` - Usage analytics
  - `bin/gstack-review-log` - PR review logging

**test/:**
- Purpose: Root-level test files and helpers
- Contains: Test fixtures, helpers, and cross-cutting tests
- Key files:
  - `test/helpers/skill-parser.ts` - Skill YAML parsing
  - `test/helpers/session-runner.ts` - E2E test session management
  - `test/skill-e2e-*.test.ts` - End-to-end skill tests

## Key File Locations

**Entry Points:**
- `browse/dist/browse`: Primary browse CLI (compiled)
- `design/dist/design`: Primary design CLI (compiled)
- `bin/gstack-global-discover`: Skill discovery utility
- `browse/src/cli.ts`: Development browse CLI
- `design/src/cli.ts`: Development design CLI

**Configuration:**
- `browse/src/config.ts`: Browse skill configuration resolution
- `design/src/auth.ts`: Design skill API key management
- `.gstack/`: User-specific state directory (created at runtime)
- `package.json`: Project dependencies and scripts

**Core Logic:**
- `browse/src/server.ts`: Persistent browser automation server
- `browse/src/sidebar-agent.ts`: Chrome extension communication agent
- `design/src/generate.ts`: Core image generation logic
- `design/src/memory.ts`: Design session persistence

**Testing:**
- `browse/test/`: Browse skill unit and E2E tests
- `design/test/`: Design skill unit and E2e tests
- `test/`: Root-level test helpers and fixtures
- `test/skill-e2e-*.test.ts`: Cross-skill end-to-end tests

## Naming Conventions

**Files:**
- **Skills:** kebab-case directory names (e.g., `skill-name/`)
- **Source Files:** `.ts` extension, kebab-case naming (e.g., `skill-parser.test.ts`)
- **Templates:** `.tmpl` extension for template files (e.g., `SKILL.md.tmpl`)
- **Tests:** `.test.ts` suffix for test files (e.g., `skill-parser.test.ts`)
- **Binaries:** No extension for compiled binaries (e.g., `browse`, `design`)
- **Config:** Descriptive names with `.ts` extension (e.g., `config.ts`, `auth.ts`)

**Directories:**
- **Skill Modules:** kebab-case matching skill name (e.g., `browse/`, `design/`)
- **Source Code:** `src/` directory within skill modules
- **Tests:** `test/` directory within skill modules or at root
- **Scripts:** `scripts/` directory for cross-cutting utilities
- **Binaries:** `bin/` directory for executables, `*/dist/` for compiled skill binaries
- **Templates:** Root directory for skill templates (e.g., `SKILL.md.tmpl` in skill dirs)

## Where to Add New Code

**New Skill:**
- Primary code: `new-skill/src/` directory with `cli.ts`, core logic files
- Tests: `new-skill/test/` directory
- Template: `new-skill/SKILL.md.tmpl` (copy from existing)
- Config: Add to `scripts/gen-skill-docs.ts` if auto-generation needed

**New Component/Module:**
- Implementation: Within existing skill's `src/` directory
- Following patterns: Match existing file naming and structure
- Exports: Use named exports for functions, default for main classes

**Utilities:**
- Shared helpers: `scripts/` directory for cross-cutting utilities
- Skill-specific helpers: Within skill's `src/` directory
- Persistent: Consider if should be in `lib/` for true sharing across skills

**Configuration:**
- Skill-specific: Within skill's `src/` directory (e.g., `config.ts`, `auth.ts`)
- Global: Update `package.json` scripts or add to root config files

## Special Directories

**.planning/:**
- Purpose: Generated codebase analysis documents from `/gsd-map-codebase`
- Generated: Yes (by this analysis process)
- Committed: Yes (for reference by other GSD commands)

**.gstack/:**
- Purpose: User-specific state directory for skills
- Generated: Yes (at runtime by skills)
- Committed: No (listed in .gitignore)
- Contains: `browse.json` (server state), `openai.json` (API keys)

**test/fixtures/:**
- Purpose: Test data files for E2E and unit tests
- Generated: No (committed test data)
- Committed: Yes
- Contains: HTML fixtures, test images, sample data

**browse/test/fixtures/:**
- Purpose: Browser automation test fixtures
- Generated: No
- Committed: Yes
- Contains: Sample web pages for testing automation commands

**node_modules/:**
- Purpose: Dependency packages
- Generated: Yes (by bun install)
- Committed: No (listed in .gitignore)
- Contains: Playwright, puppeteer-core, diff, and other dependencies

---
*Structure analysis: 2026-03-28*