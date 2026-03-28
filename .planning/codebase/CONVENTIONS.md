# Coding Conventions

**Analysis Date:** 2026-03-28

## Naming Patterns

**Files:**
- TypeScript files use kebab-case naming: `skill-parser.test.ts`, `gen-skill-docs.ts`
- Test files follow `[feature].test.ts` pattern: `audit-compliance.test.ts`, `skill-e2e.test.ts`
- Helper files in test directories use camelCase: `session-runner.ts`

**Functions:**
- Functions use camelCase: `extractBrowseCommands`, `validateSkill`, `parseArgs`
- Async functions follow same naming: `runSetup`, `main`

**Variables:**
- Constants use UPPER_SNAKE_CASE: `FIXTURES_DIR`, `ROOT`, `AI_SLOP_BLACKLIST`
- Variables use camelCase: `hasChanges`, `tokenBudget`, `cmds`
- Boolean variables use is/has prefixes: `inBashBlock`, `DRY_RUN`

**Types/Interfaces:**
- Interface names use PascalCase: `BrowseCommand`, `ValidationResult`, `TemplateContext`
- Type aliases follow PascalCase: `Host`

## Code Style

**Formatting:**
- Uses 2-space indentation consistently
- Line length varies but generally stays under 100 characters
- No explicit formatter configured; follows existing code patterns
- Semicolons are required and used consistently

**Linting:**
- No explicit linting configuration detected (.eslintrc, biome.json not found)
- Code quality maintained through consistent patterns and manual review
- TypeScript compiler provides strict type checking

## Import Organization

**Order:**
1. Built-in Node.js modules: `fs`, `path`, `os`
2. External packages: `bun:test`
3. Internal modules: relative paths from project root
4. Absolute internal paths: using `@/` or relative paths like `../../browse/src/commands`

**Path Aliases:**
- No path aliases detected in tsconfig.json
- Uses relative paths: `../../browse/src/commands`, `../helpers/skill-parser`
- Absolute paths from project root: `scripts/resolvers/types`

## Error Handling

**Patterns:**
- Synchronous code: Uses try/catch for file operations
  ```typescript
  try {
    fs.writeFileSync(outputPath, content);
  } catch (err) {
    // Handle error appropriately
  }
  ```
- Asynchronous code: Prefers try/catch with async/await
  ```typescript
  async function main(): Promise<void> {
    try {
      // async operations
    } catch (err: any) {
      console.error(err.message || err);
      process.exit(1);
    }
  }
  ```
- Validation: Early validation with descriptive errors
  ```typescript
  if (!key || !key.startsWith("sk-")) {
    console.error("Invalid key. Must start with 'sk-'.");
    process.exit(1);
  }
  ```

## Logging

**Framework:** Uses `console` methods directly

**Patterns:**
- Errors: `console.error()` for unexpected conditions and user-facing errors
- Info: `console.log()` for general output and status messages
- Debug: Limited use, mostly in development scripts
- No structured logging library detected

## Comments

**When to Comment:**
- File headers describe purpose and flow (seen in most files)
- Complex logic gets inline comments explaining why, not what
- TODO comments used for tracking future work: `// TODO:`

**JSDoc/TSDoc:**
- Used for all public APIs and complex functions
- Includes @param, @returns, and @throws where applicable
- Example:
  ```typescript
  /**
   * Extract all $B invocations from bash code blocks in a SKILL.md file.
   */
  export function extractBrowseCommands(skillPath: string): BrowseCommand[] {
  ```

## Function Design

**Size:** Functions tend to be small and focused
- Most functions under 50 lines
- Larger functions broken into smaller helpers (e.g., `processTemplate` in gen-skill-docs.ts)

**Parameters:** 
- Functions typically take 1-3 parameters
- Parameter objects used for multiple related options
- Explicit typing on all parameters and return values

**Return Values:** 
- Clear return types specified
- Functions return meaningful values or Promises for async operations
- Consistent error handling patterns

## Module Design

**Exports:** 
- Named exports preferred: `export function extractBrowseCommands(...)`
- Default exports used sparingly (mainly for classes or single-value exports)
- Barrel files not commonly used; direct imports preferred

**File Organization:**
- Feature-based grouping: browse/, design/, scripts/, test/
- Related functionality grouped in same directory
- Test files colocated with source or in parallel test/ directory structure