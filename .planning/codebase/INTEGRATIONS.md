# External Integrations

**Analysis Date:** 2026-03-28

## APIs & External Services

**AI/LLM Providers:**
- Anthropic Claude - Used for skill evaluation and LLM judging
  - SDK/Client: @anthropic-ai/sdk
  - Auth: ANTHROPIC_API_KEY environment variable
- OpenAI - Used for design generation, prototyping, and Codex metadata
  - SDK/Client: Direct fetch API calls
  - Auth: OPENAI_API_KEY environment variable or ~/.gstack/openai.json
- OpenAI Codex - Referenced for CLI installation and metadata generation
  - Integration: agents/openai.yaml metadata files
  - Auth: Requires separate codex CLI installation

**Data & Storage:**
- Supabase - Used for telemetry storage, update checking, and community pulse functions
  - SDK/Client: @supabase/supabase-js (loaded via esm.sh)
  - Auth: SUPABASE_URL and SUPABASE_ANON_KEY environment variables
  - Used in: telemetry-ingest, update-check, community-pulse edge functions

**Browser Automation:**
- Playwright - Primary browser automation for headless browsing
  - Used in: browse skill for URL validation, snapshot testing
  - Auth: None required (local browser instances)
- Puppeteer-core - Alternative browser automation
  - Used in: Some test scenarios and specific browsing features
  - Auth: None required

## Data Storage

**Databases:**
- Supabase PostgreSQL
  - Connection: Via SUPABASE_URL and SUPABASE_ANON_KEY env vars
  - Client: @supabase/supabase-js in edge functions
  - Tables: update_checks, telemetry, community_pulse data (inferred)

**File Storage:**
- Local filesystem only - No external file storage services integrated
  - Skills and data stored locally in ~/.gstack/ directory
  - Telemetry stored in Supabase

**Caching:**
- None - No external caching services detected
  - Local caching: In-memory or filesystem-based where needed

## Authentication & Identity

**Auth Provider:**
- Custom/Open standards approach
  - Implementation: Environment variable based API keys
  - Supported providers: Anthropic, OpenAI via direct API key configuration
  - No OAuth or third-party auth flows implemented

## Monitoring & Observability

**Error Tracking:**
- None - No external error tracking services detected
  - Local error handling: Console output and test assertions

**Logs:**
- Console output - Primary logging mechanism
- Structured logging: Limited to test helpers and E2E helper functions
- Telemetry: Collected and sent to Supabase via telemetry-ingest function

## CI/CD & Deployment

**Hosting:**
- Self-hosted CLI tools - Designed for local installation and execution
- No cloud hosting dependencies for core functionality

**CI Pipeline:**
- GitHub Actions - Used for automated testing and skill documentation generation
  - Workflows: skill-docs.yml, evals.yml, evals-periodic.yml, ci-image.yml
  - Triggers: Push, pull request, schedule

## Environment Configuration

**Required env vars:**
- SUPABASE_URL - Supabase project URL
- SUPABASE_ANON_KEY - Supabase anon key
- ANTHROPIC_API_KEY - Anthropic API key for Claude access
- OPENAI_API_KEY - OpenAI API key for GPT access

**Secrets location:**
- Environment variables - Expected to be set in runtime environment
- Local config: ~/.gstack/openai.json for OpenAI API key (0600 permissions)
- No secrets committed to repository

## Webhooks & Callbacks

**Incoming:**
- None - No incoming webhook endpoints in core codebase
  - Test examples: /webhook/stripe in skill-e2e-cso.test.ts (example only)

**Outgoing:**
- Supabase edge functions - Outgoing HTTP requests to external APIs
  - OpenAI API calls from design/* skills
  - Anthropic API calls from skill evaluation helpers
  - No other outgoing webhooks detected

---

*Integration audit: 2026-03-28*