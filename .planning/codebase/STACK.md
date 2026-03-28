# Technology Stack

**Analysis Date:** 2026-03-28

## Languages

**Primary:**
- TypeScript - Used throughout the codebase for all source files

**Secondary:**
- JavaScript - Used in some test files and configuration
- Bash - Used in build scripts and helper scripts

## Runtime

**Environment:**
- Bun.js >=1.0.0 - Primary runtime as specified in package.json engines

**Package Manager:**
- Bun - Built-in package manager
- Lockfile: bun.lockb (present based on standard Bun usage)

## Frameworks

**Core:**
- None - This is a skills/tooling repository, not an application framework

**Testing:**
- Bun:test - Built-in test runner used for all testing
- Playwright - Used for browser automation in E2E tests
- Puppeteer-core - Used for browser automation in some tests

**Build/Dev:**
- Bun build - Used for compiling TypeScript to native binaries
- Custom scripts - Various TypeScript scripts for skill generation, documentation, etc.

## Key Dependencies

**Critical:**
- diff ^7.0.0 - Used for text comparison operations
- playwright ^1.58.2 - Browser automation for testing and browsing functionality
- puppeteer-core ^24.40.0 - Alternative browser automation library

**Infrastructure:**
- @anthropic-ai/sdk ^0.78.0 - Anthropic API client for Claude integration (devDependency)

## Configuration

**Environment:**
- Configured via .env.example file (contains template variables)
- Key configs: SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY, etc.

**Build:**
- package.json scripts - Defines all build and development commands
- bun run build - Main build command that compiles binaries and generates documentation

## Platform Requirements

**Development:**
- Bun.js >=1.0.0 required
- Git for version control
- Compatible with Windows, macOS, Linux

**Production:**
- Designed to run as CLI tools
- Target platforms: Any where Bun.js runs

---

*Stack analysis: 2026-03-28*