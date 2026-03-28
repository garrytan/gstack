# Architecture

**Analysis Date:** 2026-03-28

## Pattern Overview

**Overall:** Modular skill-based architecture with headless browser automation core

**Key Characteristics:**
- Skills as independent, self-contained modules with defined interfaces
- Persistent headless browser server for automation tasks
- CLI wrappers that communicate with persistent services
- Template-driven skill generation system
- Centralized configuration and state management

## Layers

**Presentation Layer (CLI):**
- Purpose: Command-line interfaces for user interaction with skills
- Location: `*/src/cli.ts` files across modules (browse, design, etc.)
- Contains: Argument parsing, command routing, user output formatting
- Depends on: Service layers, configuration systems
- Used by: End users, scripts, other CLIs

**Service Layer:**
- Purpose: Core functionality implementation for each skill domain
- Location: `*/src/` directories (e.g., `browse/src/`, `design/src/`)
- Contains: Business logic, API integrations, core algorithms
- Depends on: Infrastructure layer, external SDKs
- Used by: Presentation layer, other services

**Infrastructure Layer:**
- Purpose: Shared utilities, configuration, state management, server infrastructure
- Location: `browse/src/config.ts`, `browse/src/server.ts`, `scripts/` utilities
- Contains: Persistent browser server, state persistence, config resolution, helper functions
- Depends on: External packages (playwright, puppeteer-core, etc.)
- Used by: All service and presentation layers

**Template/Generation Layer:**
- Purpose: Skill template system and documentation generation
- Location: `scripts/gen-skill-docs.ts`, `.tmpl` template files
- Contains: Template processing, skill scaffolding, documentation generation
- Depends on: File system, template engines
- Used by: Development workflows, skill creation process

## Data Flow

**Skill Execution Flow:**

1. **Command Invocation:** User runs `gstack <skill> <command>` or direct binary (`browse`, `design`)
2. **CLI Parsing:** Argument parsing and command routing in `*/src/cli.ts`
3. **Server Management:** For browse skill, ensures persistent server is running via `ensureServer()`
4. **Service Call:** Routes to appropriate service function based on command
5. **Execution:** Service performs core functionality (browser automation, design generation, etc.)
6. **Result Return:** Output formatted and returned to user via stdout/stderr

**Browser Automation Flow (Browse Skill):**
1. CLI reads state file (`.gstack/browse.json`) for server connection info
2. If missing/stale, starts persistent Bun server running `browse/src/server.ts`
3. CLI sends HTTP commands to server on localhost:port with bearer token auth
4. Server executes Playwright/Puppeteer commands against Chromium
5. Results returned via HTTP to CLI, then to user

**Skill Documentation Flow:**
1. `gen-skill-docs.ts` reads skill YAML/YAML-like configuration
2. Processes SKILL.md.tmpl templates with skill-specific data
3. Generates final SKILL.md files in each skill directory
4. Also generates codex-specific variants when requested

## Key Abstractions

**Skill Abstraction:**
- Purpose: Standardized interface for all gstack skills
- Examples: `agents/openai.yaml`, `*/SKILL.md`, `*/SKILL.md.tmpl`
- Pattern: Each skill has CLI, optional server, templates, tests, and documentation

**Persistent Server Abstraction:**
- Purpose: Long-running browser automation service
- Examples: `browse/src/server.ts`, `browse/src/cli.ts` management functions
- Pattern: State file (.gstack/browse.json) tracks PID, port, token; health checks via HTTP

**Configuration Abstraction:**
- Purpose: Centralized config resolution with defaults and environment overrides
- Examples: `browse/src/config.ts`, `resolveConfig()` function
- Pattern: Hierarchical resolution (defaults → file → env → args) with validation

**Template Abstraction:**
- Purpose: Reusable skill scaffolding and documentation generation
- Examples: `SKILL.md.tmpl` files, `gen-skill-docs.ts` script
- Pattern: Handlebars-style templating with skill metadata injection

## Entry Points

**Binary Entry Points:**
- `browse/dist/browse`: Compiled browse CLI (primary user entry point)
- `design/dist/design`: Compiled design CLI
- `bin/gstack-global-discover`: Global skill discovery utility
- `browse/dist/find-browse`: Helper for finding browse instances

**Script Entry Points:**
- `scripts/gen-skill-docs.ts`: Skill documentation generation
- `scripts/skill-check.ts`: Skill health validation
- `scripts/dev-skill.ts`: Skill development helper
- `scripts/discover-skills.ts`: Skill discovery and listing

**Direct Source Entry Points (Dev):**
- `browse/src/cli.ts`: Development browse CLI
- `design/src/cli.ts`: Development design CLI
- `*/src/cli.ts`: Development CLIs for other skills

## Error Handling

**Strategy:** Defensive programming with clear error messages and graceful degradation

**Patterns:**
- **Server Lifecycle:** Automatic restart on version mismatch or failure, with startup error capture
- **CLI Validation:** Early argument validation with clear usage instructions
- **Network Resilience:** Retry mechanisms for transient connection failures in HTTP communication
- **Process Management:** Cross-platform process detection and cleanup (Windows/Linux/macOS differences)
- **Authentication:** Token validation with automatic refresh on mismatch
- **File Operations:** Existence checks before read/write, graceful handling of missing files

**Specific Implementations:**
- Browse skill uses HTTP health checks (`isServerHealthy()`) instead of PID checks for cross-platform reliability
- Windows uses Node.js child_process with detached:true for proper process detachment
- Legacy state cleanup prevents conflicts between different installation methods
- Server startup includes timeout handling and error log capture for diagnostics

## Cross-Cutting Concerns

**Logging:** 
- Primary: Console output with color-coded prefixes (`[browse]`, `[design]`, etc.)
- Levels: Error (console.error), info/status (console.log), debug (conditional)
- Pattern: Consistent prefixed output for easy filtering

**Validation:**
- Input: Early validation of CLI arguments and configuration values
- API: Response validation from external services (OpenAI, browser automation)
- State: Version checking to detect mismatches between CLI and server binaries

**State Management:**
- Location: `.gstack/` directory in user home or project root
- Persistence: JSON state files for server connection info, tokens, version hashes
- Coordination: File-based locking to prevent race conditions during server startup
- Cleanup: Automatic cleanup of stale state and legacy /tmp files

**Authentication:**
- Mechanism: Bearer token auth for CLI-to-server communication
- Storage: Encrypted file storage (`~/.gstack/openai.json` for design, `.gstack/browse.json` for browse)
- Resolution: Multiple sources (file → env → interactive prompt) with guided setup

---
*Architecture analysis: 2026-03-28*