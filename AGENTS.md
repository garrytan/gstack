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

### Test commands

```bash
# Run all tests (excluding slow E2E tests)
bun test

# Run specific test suites
bun run test:evals          # LLM evaluation tests
bun run test:e2e            # End-to-end tests
bun run test:codex          # Codex-specific E2E tests
bun run test:gemini         # Gemini-specific E2E tests
bun run test:audit          # Audit compliance tests

# Run a single test file
bun test test/skill-parser.test.ts

# Run a single test function (if supported by test runner)
bun test test/skill-parser.test.ts -t "extracts \$B commands"
```

## Code style guidelines

### Language & formatting

- **Primary language**: TypeScript with ES modules (`"type": "module"` in package.json)
- **Formatter**: No explicit formatter configured; follow existing code patterns
- **Line length**: Aim for 80-100 characters; use judgment for readability
- **Indentation**: 2 spaces (not tabs)
- **Semicolons**: Required (follow existing code)
- **Quotes**: Single quotes for strings, double quotes only when needed (e.g., JSX attributes)
- **File naming**: `.ts` for TypeScript files, `.test.ts` for test files
- **Directory organization**: Feature-based grouping (browse/, design/, scripts/, etc.)

### Imports

- **Order**: Built-in modules → external packages → internal modules
- **Syntax**: 
  - Named imports: `import { fs } from 'fs';`
  - Default imports: `import fs from 'fs';` (when appropriate)
  - Namespace imports: `import * as fs from 'fs';`
- **Path aliases**: Use relative paths (`./helpers/util`) or absolute from project root
- **Bun-specific**: Use `bun:test` for testing imports: `import { describe, test, expect } from 'bun:test';`

### Types

- **Type definitions**: Prefer interfaces over types for object shapes
- **Explicit typing**: 
  - Function parameters and return values should be typed
  - Avoid `any`; use `unknown` when type is truly unknown
  - Use generics for reusable components
- **Nullable types**: Explicitly mark with `| null` or use strict null checks
- **Type inference**: Trust TypeScript inference for simple cases

### Naming conventions

- **Variables & functions**: camelCase (e.g., `fetchUserData`)
- **Classes & types**: PascalCase (e.g., `BrowserManager`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_START_WAIT`)
- **Files**: kebab-case (e.g., `skill-parser.test.ts`)
- **Private members**: Prefix with underscore only if truly internal (`_internalMethod`)
- **Boolean variables**: Use is/has/can prefixes (e.g., `isEnabled`, `hasError`)

### Error handling

- **Synchronous code**: Use try/catch for recoverable errors
- **Asynchronous code**: 
  - Prefer try/catch with async/await
  - For promises: `.then(result => ...).catch(error => handleError(error))`
- **Validation**: Validate inputs early; throw descriptive errors
- **Logging**: Use console.error for unexpected conditions; avoid console.log in libraries
- **User-facing errors**: Provide clear, actionable messages
- **Error types**: Consider creating custom error classes for domain-specific errors

### Documentation

- **JSDoc**: Use for all public APIs and complex functions
- **File headers**: Include purpose and flow description (see existing files)
- **Complex logic**: Add inline comments explaining why, not what
- **TODO comments**: Use `// TODO:` for tracking future work
- **Magic numbers**: Replace with named constants with explanations

### Testing patterns

- **Test files**: Name as `[feature].test.ts` alongside implementation or in `test/` directory
- **Test structure**: 
  - `describe()` for test suites
  - `test()` for individual test cases
  - `beforeAll()/afterAll()` for suite setup/teardown
  - `beforeEach()/afterEach()` for test isolation
- **Assertions**: Use `expect()` from `bun:test`
- **Mocking**: 
  - Manual mocks for simple cases
  - Temporary directories for file system tests (`os.tmpdir()`)
  - Child process testing with `spawnSync` for CLI commands
- **E2E tests**: 
  - Mark with `.e2e.test.ts` suffix
  - Use test servers for HTTP testing
  - Clean up resources in `afterAll()`

### Specific patterns in this codebase

- **Configuration**: Use `resolveConfig()` pattern for loading settings
- **Process detection**: Check `process.platform` for OS-specific behavior
- **Constants**: Define timeouts, limits, and magic values as constants at top of file
- **HTTP servers**: Use consistent patterns for starting/stopping test servers
- **File operations**: Always check existence before reading/writing; use synchronous versions in CLI scripts for simplicity
- **CLI args**: Parse with `process.argv.slice(2)` or use parsing libraries for complex interfaces
- **Environment**: Use `process.env` for configuration; provide defaults and validation

## Safety guidelines

- **Destructive operations**: Always confirm before running commands like `rm -rf`, `DROP TABLE`, or force pushes
- **File modifications**: Prefer editing existing files over creating new ones unless explicitly required
- **Branch protection**: Never force push to main/master branches
- **Secret handling**: Never log or commit secrets, keys, or credentials
- **Testing**: Run relevant tests before considering work complete
- **Build verification**: Ensure `bun run build` succeeds after changes

## Agent-specific instructions

When operating as an agent in this repository:

1. **Start with understanding**: Read related files before making changes
2. **Follow existing patterns**: Match the coding style of the file you're editing
3. **Test thoroughly**: Run relevant unit tests and verify manually when appropriate
4. **Document changes**: Update comments and JSDoc when modifying behavior
5. **Consider edge cases**: Think about error conditions and input validation
6. **Keep changes focused**: Make minimal, purposeful changes
7. **Verify build**: Ensure `bun run build` still works after your changes
8. **Respect conventions**: Follow the established patterns for imports, naming, and error handling

## Documentation

- SKILL.md files are **generated** from `.tmpl` templates. Edit the template, not the output.
- Run `bun run gen:skill-docs --host codex` to regenerate Codex-specific output.
- The browse binary provides headless browser access. Use `$B <command>` in skills.
- Safety skills (careful, freeze, guard) use inline advisory prose — always confirm before destructive operations.