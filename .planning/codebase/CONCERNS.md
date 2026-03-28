# Codebase Concerns

**Analysis Date:** 2026-03-28

## Tech Debt

**[Documentation gaps]:**
- Issue: Many skill directories lack clear documentation on purpose and usage
- Files: `agents/skill-*/README.md` (missing or minimal in many skills)
- Impact: Difficult for new contributors to understand skill boundaries and responsibilities
- Fix approach: Add standardized README templates for each skill with purpose, inputs, outputs, and examples

**[Configuration complexity]:**
- Issue: Multiple configuration mechanisms across skills (JSON, env vars, hardcoded values)
- Files: `agents/*/config.ts`, `agents/*/*.json`, `.env.example`
- Impact: Inconsistent configuration patterns increase cognitive load
- Fix approach: Establish unified configuration pattern using `resolveConfig()` utility

**[Build script fragmentation]:**
- Issue: Build and setup scripts scattered across multiple directories
- Files: `setup*`, `bin/*`, `scripts/*`, `package.json` scripts
- Impact: Difficult to discover and maintain development workflows
- Fix approach: Consolidate scripts into standardized locations with clear documentation

## Known Bugs

**[Skill registration failures]:**
- Symptoms: Skills fail to load due to missing adapter configurations
- Files: `agents/skill-parser.test.ts`, `agents/*/adapter.ts`
- Trigger: When skill adapter doesn't implement required interfaces correctly
- Workaround: Manual verification of adapter implementation
- Fix approach: Add runtime validation during skill loading with clear error messages

**[Browser cookie import race conditions]:**
- Symptoms: Cookie import fails intermittently when browser is busy
- Files: `browse/src/cookie-import-browser.ts`, `setup-browser-cookies/*`
- Trigger: Concurrent access to browser profile during import
- Workaround: Retry mechanism with exponential backoff
- Fix approach: Implement proper file locking or use browser automation APIs

## Security Considerations

**[Environment variable exposure]:**
- Risk: Accidental committing of `.env` files containing secrets
- Files: `.env.example` (template), potential `.env*` files in developer environments
- Current mitigation: `.gitignore` excludes `.env*` files
- Recommendations: Add pre-commit hook to scan for accidental secrets, use secrets scanning in CI

**[Insecure random number generation]:**
- Risk: Use of non-cryptographically random values for security-sensitive operations
- Files: `browse/src/sidebar-agent.ts` (generation of session IDs)
- Current mitigation: None identified
- Recommendations: Replace `Math.random()` with `crypto.randomUUID()` or similar secure alternatives

## Performance Bottlenecks

**[Skill loading latency]:**
- Problem: Initial skill discovery and loading takes significant time
- Files: `agents/skill-parser.ts`, `agents/skill-validation.ts`
- Cause: Sequential file system operations for each skill directory
- Improvement path: Implement skill caching with filesystem watchers for invalidation

**[Browser instance multiplication]:**
- Problem: Multiple browser instances spawned unnecessarily
- Files: `browse/src/browser-manager.ts`, `browse/src/server.ts`
- Cause: Lack of proper singleton pattern for browser manager
- Improvement path: enforce singleton pattern and reuse browser contexts where safe

## Fragile Areas

**[Agent communication protocol]:**
- Files: `agents/paperclip/*.ts`, `agents/*/adapter.ts`
- Why fragile: Loose coupling via JSON messages without schema validation
- Safe modification: Add JSON schema validation for all inter-agent messages
- Test coverage: Gaps in error handling for malformed messages

**[File system operation safety]:**
- Files: `scripts/*` (file manipulation scripts), `setup*` scripts
- Why fragile: Synchronous file operations without proper error handling
- Safe modification: Wrap FS operations in try/catch with meaningful error messages
- Test coverage: Limited unit testing for edge cases (permissions, missing directories)

## Scaling Limits

**[Concurrent skill execution]:**
- Current capacity: Sequential skill execution in workflows
- Limit: Long-running skills block entire workflow
- Scaling path: Implement proper async/await patterns and worker queues for parallel execution

**[Memory usage in browser operations]:**
- Current capacity: Single browser session per user
- Limit: Memory leaks in long-running browser sessions
- Scaling path: Implement periodic browser restart and memory monitoring

## Dependencies at Risk

**[PUPPETEER_EXECUTABLE_PATH]:**
- Risk: Hardcoded paths to browser executables in `browse/src/platform.ts`
- Impact: Breaks when browser updates or when running in different environments
- Migration plan: Use environment-configurable paths with auto-detection fallback

**[Node.js version compatibility]:**
- Risk: Use of modern Node.js features (`import.meta`, top-level await) that may break on older versions
- Impact: Limits deployment environments
- Migration plan: Either require specific Node.js version or transpile for broader compatibility

## Missing Critical Features

**[Skill versioning]:**
- Problem: No mechanism to track skill versions or dependencies
- Blocks: Safe updates and rollback of skills
- Proposed solution: Add version metadata to skill configuration and implement compatibility checking

**[Skill sandboxing]:**
- Problem: Skills run with full process access
- Blocks: Safe execution of third-party or untrusted skills
- Proposed solution: Implement skill execution in restricted environments (e.g., VMs, containers)

## Test Coverage Gaps

**[Error handling in adapters]:**
- What's not tested: Adapter failure scenarios and recovery
- Files: `agents/*/adapter.ts`
- Risk: Silent failures in skill execution
- Priority: High

**[Edge cases in file system operations]:**
- What's not tested: Permission errors, disk full, concurrent access
- Files: `scripts/*`, `setup*` scripts
- Risk: Unhandled exceptions causing partial setup states
- Priority: Medium

**[Browser automation failure modes]:**
- What's not tested: Network failures, browser crashes, element not found
- Files: `browse/src/*`
- Risk: Unreliable UI automation
- Priority: High

---
*Concerns audit: 2026-03-28*