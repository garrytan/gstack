# Testing Patterns

**Analysis Date:** 2026-03-28

## Test Framework

**Runner:**
- Bun test framework (built-in)
- Config: Implicit via package.json test scripts

**Assertion Library:**
- Bun:test expect API

**Run Commands:**
```bash
bun test                            # Run all tests (excluding E2E)
bun test --watch                    # Watch mode
bun test --coverage                 # Coverage reporting
bun test test/skill-parser.test.ts  # Run specific test file
```

## Test File Organization

**Location:**
- Mixed approach: tests colocated with source and in centralized test/ directory
- Feature-specific tests in feature directories: `design/test/`, `browse/test/`
- General tests in root `test/` directory

**Naming:**
- Test files: `[feature].test.ts` or `[feature].e2e.test.ts`
- Helper/test utilities: `[name].ts` or `[name].test.ts`

**Structure:**
```
test/
├── skill-parser.test.ts
├── audit-compliance.test.ts
├── helpers/                    # Test helpers and fixtures
├── browse/                     # Browse-specific tests
└── design/                     # Design-specific tests
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, test, expect } from 'bun:test';
import { functionToTest } from './module';

describe('Function Name', () => {
  test('description of what is being tested', () => {
    // Arrange
    const input = 'test input';
    
    // Act
    const result = functionToTest(input);
    
    // Assert
    expect(result).toBe('expected output');
  });
});
```

**Patterns:**
- Setup: Using `beforeEach()`, `beforeAll()` when needed
- Teardown: Cleanup in `afterEach()`, `afterAll()` 
- Assertions: Using `expect()` matchers like `.toBe()`, `.toEqual()`, `.toHaveLength()`
- Async testing: Using `await` with expect assertions

## Mocking

**Framework:** Manual mocking approach (no external mocking library)

**Patterns:**
- Temporary directories for file system tests:
  ```typescript
  const FIXTURES_DIR = path.join(os.tmpdir(), 'skill-parser-test');
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  // ... create test files
  // cleanup happens automatically via OS temp cleanup
  ```
- Function spying/stubbing: Limited use, mostly dependency injection
- Network mocking: Not commonly used; tests use real fixtures or controlled inputs

**What to Mock:**
- File system operations (using temporary directories)
- External APIs when testing integration points (via fixture files)
- Date/time when testing time-dependent functionality

**What NOT to Mock:**
- Pure functions (test with real inputs/outputs)
- Simple utility functions
- Internal logic that can be tested directly

## Fixtures and Factories

**Test Data:**
- Inline fixture creation for simple cases:
  ```typescript
  const p = writeFixture('test.md', [
    '# Test',
    '\`\`\`bash',
    '$B goto https://example.com',
    '\`\`\`',
  ].join('\n'));
  ```
- Helper functions for complex setup:
  ```typescript
  function writeFixture(name: string, content: string): string {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    const p = path.join(FIXTURES_DIR, name);
    fs.writeFileSync(p, content);
    return p;
  }
  ```

**Location:**
- Test-specific helpers in `test/helpers/` directory
- Inline fixtures for simple test data
- Shared fixtures in test files when used by multiple tests

## Coverage

**Requirements:** No enforced coverage thresholds detected

**View Coverage:**
```bash
bun test --coverage
```

## Test Types

**Unit Tests:**
- Majority of tests are unit tests
- Test individual functions in isolation
- Examples: `skill-parser.test.ts`, `audit-compliance.test.ts`

**Integration Tests:**
- Some tests verify integration between modules
- Examples: E2E tests that test CLI command flows
- Limited use due to nature of CLI/automation tool

**E2E Tests:**
- Present for end-to-end workflows
- Files: `test/skill-e2e-*.test.ts`, `test/codex-e2e.test.ts`, `test/gemini-e2e.test.ts`
- Uses `@bun:test` with longer timeouts
- Tests complete user workflows

## Common Patterns

**Async Testing:**
```typescript
test('async operation', async () => {
  const result = await asyncFunction();
  expect(result).toBe('expected');
});
```

**Error Testing:**
```typescript
test('throws on invalid input', () => {
  expect(() => {
    functionThatThrows('invalid');
  }).toThrow(/invalid input/);
});
```

**File System Testing:**
```typescript
test('reads file correctly', () => {
  const tempFile = writeFixture('test.txt', 'content');
  const result = readFile(tempFile);
  expect(result).toBe('content');
  // OS cleans up temp file automatically
  // or explicit cleanup in afterAll()
});
```

**Command Line Testing:**
```typescript
test('CLI command works', async () => {
  const proc = Bun.spawn(['bun', 'run', 'cli', '--help']);
  const response = await new Response(proc.stdout).text();
  expect(response).toContain('Usage:');
});
```