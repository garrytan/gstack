# Team Coordination Store: gstack as Engineering Intelligence Platform

> Design doc for the Supabase-backed team data store and universal eval infrastructure.
> Authored 2026-03-15. Status: Phase 1 complete. Phase 2 complete (skill hooks, sync test/show, team trends). Phase 3-4 not started.

## Table of Contents

- [The Problem](#the-problem)
- [The Vision (Platonic Ideal)](#the-vision-platonic-ideal)
- [10-Year Trajectory](#10-year-trajectory)
- [Key Decisions](#key-decisions)
- [Architecture](#architecture)
- [gstack eval: Universal Eval Infrastructure](#gstack-eval-universal-eval-infrastructure)
- [Supabase Schema](#supabase-schema)
- [Integration Points](#integration-points)
- [Phased Rollout](#phased-rollout)
- [Data Flows](#data-flows)
- [Error & Rescue Map](#error--rescue-map)
- [Security & Threat Model](#security--threat-model)
- [Observability](#observability)
- [What Already Exists](#what-already-exists-reuse-map)
- [What's NOT in Scope](#whats-not-in-scope)
- [Risks & Mitigations](#risks--mitigations)
- [Verification Plan](#verification-plan)
- [Review Decisions Log](#review-decisions-log)

---

## The Problem

gstack currently stores all data as local flat files:

| Data | Location | Format |
|------|----------|--------|
| Eval results | `~/.gstack-dev/evals/*.json` | JSON (EvalResult schema v1) |
| Retro snapshots | `.context/retros/*.json` | JSON (metrics + per-author) |
| Greptile triage | `~/.gstack/greptile-history.md` | Pipe-delimited text |
| QA reports | `.gstack/qa-reports/` | Markdown + baseline.json |
| Ship logs | **Not yet implemented** | Planned JSON |
| Claude transcripts | `~/.claude/history.jsonl` | JSONL (Claude Code's domain) |

This works for solo developers. For teams on vendored gstack, it means:

- **Zero shared visibility** into code quality, shipping velocity, or eval regressions
- **No cross-contributor comparison** — each developer's data is isolated on their machine
- **No regression detection** — an eval suite can regress and nobody notices until production breaks
- **Duplicated infrastructure** — the author runs another project with a sophisticated eval system (60+ runners, S3 storage, caching, cost tracking, baselines) locked inside Ruby/Rails that solves the same problems gstack solves in Bun/TS

---

## The Vision (Platonic Ideal)

Imagine this: a new engineer joins the team. They run `gstack sync setup`, authenticate in 30 seconds, and immediately see:

- The team's shipping velocity — 14 PRs merged this week, trending up
- Which areas of the codebase are most active — `app/services/` is a hotspot
- How the AI is performing — eval detection rate is 92%, up from 85% last month
- What the AI struggles with — response email evals consistently score low on brevity
- How senior engineers use Claude differently than juniors — more targeted prompts, fewer turns
- A weekly digest arriving in Slack every Monday with the team's pulse

They don't need to ask anyone. They don't need to read a wiki. The data is alive, flowing, and organized.

When they run `/ship`, the last line says "Synced to team ✓". When an eval regresses, a Slack alert fires within minutes. When someone ships a fix that improves detection rate by 10%, it shows up on the leaderboard.

The system is invisible when it works and loud when something breaks. Skills don't know sync exists — they read local files, and the local files happen to contain team data. The infrastructure layer is purely additive. Turn it off with one config change. Delete the config and it's as if it never existed.

This is what "engineering intelligence" means: the team's collective knowledge about code quality, AI effectiveness, and shipping patterns — organized, shared, and actionable.

---

## 10-Year Trajectory

```
YEAR 1 (this plan)
├── Supabase data store — team sync for evals, retros, QA, ships, reviews
├── Universal eval infrastructure — adapter mode, any language pushes results
├── Eval cache, cost tracking, baselines, comparison — ported from existing Rails project
├── Live eval dashboard — browser-based, SSE streaming
├── Team dashboard — velocity, quality trends, cost tracking
├── Edge functions — regression alerts, weekly digests
└── Inline sync in skills — "Synced to team ✓"

YEAR 2
├── Native eval runner — gstack runs evals directly (YAML → LLM → judge)
├── Cross-team benchmarking — opt-in anonymized aggregates across teams
├── AI usage analytics — which prompts/tools are most effective
├── PR-integrated quality gates — eval results as GitHub check runs
├── CI/CD first-class support — GitHub Actions eval workflow
└── Multi-repo support — one team, many repos, unified dashboard

YEAR 3
├── Prompt optimization engine — analyze eval history to suggest prompt improvements
├── Regression prediction — ML on eval trends to predict quality drops before they happen
├── Custom judge profiles — teams define their own quality criteria and scoring rubrics
├── Eval marketplace — share and discover eval suites across the gstack community
└── Voice health dashboard — per-author quality scoring

YEAR 5
├── Engineering intelligence API — other tools consume gstack's data layer
├── Autonomous quality maintenance — gstack detects regressions and proposes fixes
├── Cross-organization insights — "teams like yours typically..." recommendations
├── Real-time collaboration — live pair-eval sessions, shared debugging
└── Training data curation — eval results feed into fine-tuning pipelines

YEAR 10
├── The engineering intelligence layer — as fundamental as git or CI
├── Every AI-assisted engineering team has a shared data substrate
├── Eval-driven development is standard practice, not an afterthought
├── The gap between "how the AI performed" and "what the team shipped" is closed
└── gstack is to AI-native engineering what GitHub is to version control
```

The key insight: **data compounds**. Year 1 data makes year 2 features possible. Year 2 data makes year 3 predictions accurate. By year 5, the accumulated eval history is more valuable than any individual eval run. The platform gets smarter the longer a team uses it.

---

## Key Decisions

All decisions were made during the CEO-mode plan review on 2026-03-15.

| # | Decision | Resolution | Rationale |
|---|----------|------------|-----------|
| 1 | Hosting model | Self-hosted Supabase per team | Maximum control, data sovereignty |
| 2 | Transcript handling | Opt-in, no scrubbing | Trust the team — same model as shared Slack. Supabase encrypts at rest + in transit. RLS enforces team isolation. |
| 3 | Read architecture | Cache-based | Skills never touch network. `gstack sync pull` writes to `.gstack/team-cache/`. Skills read local files only. Preserves "sync is invisible" invariant. |
| 4 | Eval integration | Adapter mode (not native runner) | Your app runs evals. gstack is infrastructure: storage, comparison, caching, dashboards, sharing. |
| 5 | Test case format | YAML for cases, JSON for results | YAML for human-authored inputs (comments, multiline). JSON for machine-generated outputs. |
| 6 | Queue overflow | No cap, warning-based | Don't silently drop data. `gstack sync status` warns if >100 items or >24h old. |
| 7 | Queue drain | Parallel 10-concurrent | `Promise.allSettled()`. 500 items in ~10s instead of 100s. |
| 8 | Cache staleness | Metadata file | `.gstack/team-cache/.meta.json` tracks last_pull + row counts per table. |

---

## Architecture

### System Diagram

```
                           TEAM SUPABASE INSTANCE
                           ┌─────────────────────────────────────────────┐
                           │  PostgreSQL + RLS                            │
                           │  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
                           │  │eval_runs │ │retro_    │ │eval_costs   │ │
                           │  │          │ │snapshots │ │(per-model)  │ │
                           │  └──────────┘ └──────────┘ └─────────────┘ │
                           │  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
                           │  │qa_reports│ │greptile_ │ │ship_logs    │ │
                           │  │          │ │triage    │ │             │ │
                           │  └──────────┘ └──────────┘ └─────────────┘ │
                           │  ┌──────────┐ ┌──────────┐                 │
                           │  │session_  │ │teams +   │  Auth.users     │
                           │  │transcr.  │ │members   │                 │
                           │  └──────────┘ └──────────┘                 │
                           │                                             │
                           │  Edge Functions (Phase 4):                  │
                           │  • regression-alert (on eval_runs INSERT)   │
                           │  • weekly-digest (cron → email/Slack)       │
                           └──────────┬──────────────────────────────────┘
                                      │ HTTPS (REST API)
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
   Developer A Machine      Developer B Machine        CI Runner
   ┌─────────────────┐     ┌─────────────────┐     ┌──────────────┐
   │ gstack eval push │     │ gstack eval push │     │ ENV:          │
   │ gstack eval cache│     │ gstack eval      │     │ ACCESS_TOKEN │
   │ /retro /ship /qa │     │   compare        │     │              │
   │                  │     │ /retro /ship /qa │     │ gstack eval  │
   │ ~/.gstack/       │     │                  │     │   push       │
   │   auth.json(0600)│     │ ~/.gstack/       │     └──────────────┘
   │   eval-cache/    │     │   auth.json(0600)│
   │   sync-queue.json│     │   eval-cache/    │
   │                  │     │   sync-queue.json│
   │ .gstack/         │     │                  │
   │   team-cache/    │     │ .gstack/         │
   │     .meta.json   │     │   team-cache/    │
   └─────────────────┘     └─────────────────┘
```

### Config & Credential Storage: 4 Layers

**Layer 1: Project config — `.gstack-sync.json` (committed to repo)**

```json
{
  "supabase_url": "https://xyzcompany.supabase.co",
  "supabase_anon_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "team_slug": "xyzcompany"
}
```

The anon key is **safe to commit**. This is Supabase's design — the anon key only grants access through RLS policies, which require a valid user JWT. It's the same key that ships in every Supabase client-side app. Without a valid user token, the anon key gets you nothing.

Project-level only: Supabase URL, anon key, team slug. No user preferences here — those are per-developer (Layer 2).

**Layer 2: User settings — `~/.gstack/config.yaml` (via `gstack-config`)**

```yaml
# Existing settings (v0.3.9)
auto_upgrade: true
update_check: true

# New sync settings
sync_enabled: true          # enable/disable team sync (per-user)
sync_transcripts: false     # opt-in transcript sharing (per-user)
```

Managed via the existing `gstack-config` CLI (`bin/gstack-config`):
```bash
gstack-config get sync_enabled     # → "true" or ""
gstack-config set sync_enabled true
gstack-config set sync_transcripts false
gstack-config list                 # → all settings
```

Rationale: `sync_enabled` and `sync_transcripts` are **user preferences**, not project config. One developer might want sync off while the rest of the team has it on. `gstack-config` already handles this pattern for `auto_upgrade` and `update_check`.

**Layer 3: User auth — `~/.gstack/auth.json` (mode 0o600, never committed)**

```json
{
  "https://xyzcompany.supabase.co": {
    "access_token": "eyJ...",
    "refresh_token": "v1.xxx...",
    "expires_at": 1710460800,
    "user_id": "uuid",
    "team_id": "uuid",
    "email": "dev@company.com"
  }
}
```

Keyed by `supabase_url` so developers on multiple teams/projects just work. Written with `chmod 0o600` — same pattern as `browse.json` in `browse/src/server.ts`.

**Layer 4: Admin bootstrap — one-time Supabase project setup**

```bash
# Admin runs once to set up the project:
gstack sync init --supabase-url https://xyzcompany.supabase.co

# Prompts for service role key (or reads SUPABASE_SERVICE_ROLE_KEY env).
# Runs migrations, creates team, generates .gstack-sync.json.
# Service role key is NOT saved anywhere.
```

CI/automation uses `GSTACK_SUPABASE_ACCESS_TOKEN` env var.

### Auth Flow

`gstack sync setup` reads URL from `.gstack-sync.json` → opens browser for OAuth or magic link → polls for completion → writes tokens to `~/.gstack/auth.json` (mode 0o600) → sets `sync_enabled=true` via `gstack-config`.

On first successful auth, shows a team welcome: "3 members, 47 eval runs this week, last ship 2h ago."

### Sync Pattern: Bidirectional, Non-Fatal

**Writes:** Every local data write gets a `push*()` call after. Pattern:
- 5-second timeout
- try/catch (never throws, never blocks the calling skill)
- Idempotent (upsert on natural keys: timestamp + hostname + repo_slug)
- Falls back to local queue (`~/.gstack/sync-queue.json`) if offline

**Reads:** `gstack sync pull` queries Supabase and writes team data to `.gstack/team-cache/`. Skills read local files only — they never import sync or touch the network. Cache metadata in `.gstack/team-cache/.meta.json` tracks freshness:

```json
{
  "last_pull": "2026-03-15T10:30:00Z",
  "tables": {
    "retro_snapshots": { "rows": 47, "latest": "2026-03-14" },
    "eval_runs": { "rows": 123, "latest": "2026-03-15T09:00:00Z" }
  }
}
```

**Queue:** No cap on size. `gstack sync status` warns if >100 items or oldest entry >24h. Drain uses 10-concurrent `Promise.allSettled()` — 500 items drain in ~10s.

For skills (retro, review, qa, ship), sync happens via `bin/gstack-sync` called at end of skill with `|| true` — same pattern as existing `bin/gstack-update-check`.

### Opt-in Transcript Sync

When `sync_transcripts: true` in `~/.gstack/config.yaml` (set via `gstack-config set sync_transcripts true`):
- `gstack-sync push-transcript` reads `~/.claude/history.jsonl` (new entries since last sync marker)
- Stores in `session_transcripts` table with RLS policy (admin-only read by default)
- No scrubbing — trust the team. Opt-in = consent. Same trust model as a shared Slack channel.
- Useful for: team code review of AI usage patterns, onboarding, identifying prompt improvements

---

## gstack eval: Universal Eval Infrastructure

gstack eval is the **infrastructure layer** for LLM evals. It does not run your evals — your app does that in whatever language it's written in. gstack handles everything after results exist: storage, comparison, caching, dashboards, team sharing.

### Design: Adapter Mode

```
YOUR APP (any language)              GSTACK EVAL (infrastructure)
═══════════════════════              ════════════════════════════

Rails rake eval:run ──┐
Python pytest-evals ──┼──▶ JSON result ──▶ gstack eval push ──▶ Supabase
Go test -run Eval ────┘    (standard        ├──▶ gstack eval compare
                            format)          ├──▶ gstack eval list
                                             ├──▶ gstack eval baselines
                                             ├──▶ gstack eval cost
                                             ├──▶ gstack eval watch (live dashboard)
                                             └──▶ gstack dashboard (team-wide)
```

Your eval runners keep their language, their models, their service objects. gstack provides the plumbing.

### What We're Porting from an Existing Rails Project

The author runs another project with a production-grade eval infrastructure in Ruby/Rails. The patterns are general-purpose and worth extracting into gstack as framework-agnostic infrastructure:

- **60+ eval runners** with YAML test cases
- **Multi-judge LLM evaluation** — multiple judge profiles scoring on 8+ quality criteria
- **3-tier pipeline** — progressive refinement across model tiers (cheap → expensive)
- **SHA-based input caching** with atomic writes and version invalidation
- **S3 result storage** with auto-labeling, deduplication, and score aggregation
- **Cost tracking** with per-model dashboards and tier comparison
- **Baseline generation** — markdown reports with cross-tier comparison
- **Rake tasks** for list, compare, cache management, fixture export

| Existing Rails Pattern | gstack (Bun/TS) | Port scope |
|---|---|---|
| S3 result storage | `lib/sync.ts` (Supabase) | Full port: upload, list, compare, aggregate |
| Cost tracker | `lib/eval-cost.ts` | Full port: per-model tracking, terminal + HTML dashboard |
| Eval cache | `lib/eval-cache.ts` | Full port: SHA-based, atomic, CLI-accessible from any language |
| Baseline generator | `lib/eval-baselines.ts` | Full port: markdown reports from results |
| Judge tier selection | `lib/eval-tier.ts` | Full port: fast/standard/full model mapping |
| Rake tasks | `bin/gstack-eval` CLI | Full port: list, compare, cache, baselines, cost |
| YAML test cases | Standard format spec | Define format, document for any language |
| Eval runners (60+) | **Stay in Rails** | NOT ported — adapter mode |
| LLM-as-judge | `lib/eval-judge.ts` | Extend existing with multi-judge |

### For existing Rails projects

Integrating an existing Rails eval system requires ~20 lines of change:

```ruby
# BEFORE (S3):
EvalResultStorage.upload(results, label: auto_label)

# AFTER (gstack):
path = "#{gstack_dir}/result.json"
File.write(path, JSON.pretty_generate(gstack_format(results)))
system("gstack eval push #{path}")
```

Rails keeps its eval runners, YAML cases, service objects, and models. S3 is replaced by `gstack eval push → Supabase`.

### Standard Eval Result Format (JSON)

Any language produces this. gstack consumes it. Designed as a superset of patterns
found across 42+ eval suites covering content generation, tool-calling agents, email
generation, scoring/classification, fact-checking, clustering, memory extraction,
and A/B comparison testing.

```json
{
  "schema_version": 1,
  "label": "dev_fix-terseness_standard",
  "timestamp": "2026-03-15T10:30:00Z",
  "git_sha": "abc123",
  "git_branch": "dev/fix-terseness",
  "prompt_sha": "a08ff469",
  "hostname": "dev-machine",
  "tier": "standard",
  "total": 18,
  "passed": 17,
  "failed": 1,
  "duration_seconds": 893.4,
  "by_category": {
    "post_generation": { "passed": 16, "total": 17 },
    "tool_usage": { "passed": 1, "total": 1 }
  },
  "all_results": [
    {
      "name": "must_cite_sources",
      "category": "post_generation",
      "passed": true,
      "duration_ms": 45000,
      "failures": [],
      "judge_scores": { "accuracy": 0.85, "voice_fidelity": 0.72 },
      "response_preview": "The proposed legislation would...",
      "output": {},
      "comparison": null
    }
  ],
  "costs": [
    {
      "model": "claude-sonnet-4-6",
      "calls": 25,
      "input_tokens": 45123,
      "output_tokens": 12456
    }
  ]
}
```

**Per-result `output` field** — open object, suite-specific. Different eval types
populate different keys. gstack stores as-is (JSONB) for display/comparison:

```json
{
  "output": {
    "response": "Agent text response",
    "tool_calls": [{"name": "search", "input": {"query": "..."}}],
    "body": "Generated email body...",
    "subject": "Email subject line",
    "score": 72,
    "reasoning": "High alignment because...",
    "flags": ["red_flag_1"],
    "items": [{"id": "claim_1", "severity": "yellow", "commentary": "..."}],
    "chunks": ["chunk 1 text", "chunk 2 text"],
    "clusters": [{"theme": "Housing", "articles": ["..."]}],
    "memories": [{"content": "Enjoys cycling", "category": "personal"}],
    "extracted_fields": {"occupation": "engineer", "city": "Oakland"},
    "title": "Generated title",
    "structured_content": "Full article body..."
  }
}
```

**Per-result `comparison` field** — for A/B testing and tier-chaining evals:

```json
{
  "comparison": {
    "type": "ab_test",
    "control_scores": {"accuracy": 0.80, "voice": 0.75},
    "treatment_scores": {"accuracy": 0.85, "voice": 0.78},
    "deltas": [
      {"criterion": "accuracy", "control": 0.80, "treatment": 0.85, "delta": 0.05}
    ],
    "tolerance": 0.05
  }
}
```

**`failures` array format:**

```json
{
  "failures": [
    {
      "type": "threshold",
      "expectation_type": "voice_check",
      "message": "Voice check failed: 2 of 5 criteria below threshold",
      "criterion": "voice_fidelity",
      "expected": 0.7,
      "actual": 0.58,
      "details": [
        {"criterion": "no_hedging", "score": 0.3, "threshold": 0.7},
        {"criterion": "direct_tone", "score": 0.4, "threshold": 0.6}
      ],
      "scores": {
        "no_hedging": 0.3, "no_filler": 0.6, "direct_tone": 0.4,
        "uses_specifics": 0.8, "operator_energy": 0.9
      }
    },
    {
      "type": "deterministic",
      "expectation_type": "body_contains",
      "check": "body_contains",
      "pattern": "Series B",
      "message": "Pattern not found in output"
    }
  ]
}
```

Fields: `type` = generic class (`threshold` | `deterministic`). `expectation_type` = domain-specific
check name from the YAML case. `details` = per-criterion breakdown for multi-criteria checks.
`scores` = ALL scores (passing + failing) for context. `message` = human-readable summary.

### YAML Test Case Format

Human-authored, comments supported, multiline strings via `|` blocks.
Designed as a superset of 60+ expectation types across 42+ eval suites.

Three sections: **metadata** (universal), **input** (suite-specific, open-ended),
and **expectations** (standardized assertion types).

#### Minimal example

```yaml
name: must_cite_sources
description: Post must cite original source material
category: post_generation
expectations:
  - type: body_contains
    patterns: ["Series B", "$50M"]
  - type: quality_check
    criteria:
      accuracy: 0.7
      no_hallucination: 0.8
```

#### Full example (all field categories)

```yaml
# ── Metadata (universal) ──────────────────────────
name: admin_search_knowledge
description: Admin asks a content question, should use search tool
category: tool_usage
tags: [admin, regression, tool_calling]

# ── Prompt source files (for cache invalidation) ──
# SHA of these files becomes part of the cache key.
prompt_source_files:
  - app/services/chat_responder_service.rb
  - config/system_prompts/agent.txt

# ── Input context (suite-specific, open-ended) ────
# gstack treats input as opaque data passed to the runner.
# Different suites use different shapes:

# Agent/chat evals:
user_message: "What articles have we published about housing policy?"
user_state:
  fixture: admin_user
  overrides:
    city: "San Francisco"

# Email generation evals:
# user_context:
#   first_name: "David"
#   membership_status: active
#   memories: ["Works as ML engineer"]
# conversation_thread:
#   - direction: inbound
#     body: "Hi, I heard about your organization..."

# Content scoring/classification:
# content:
#   title: "Policy Analysis"
#   raw_content: "The proposed legislation..."

# Fixture-based generation:
# fixture_name: bundle_housing_policy

# Text processing:
# text: "Full article text..."
# strategies: [recursive, semantic]
# chunk_size: 80

# Media analysis:
# media_type: youtube
# transcript: "Full transcript..."
# metadata: { duration_seconds: 2700 }

# ── Expectations (standardized) ───────────────────
expectations:

  # ── Tool calling ──
  - type: tool_called
    tool: search_knowledge
    required: true
    input_contains:
      query: "housing"
  - type: tool_not_called
    tool: update_user_profile

  # ── Text matching (supports regex: /pattern/i) ──
  - type: response_contains
    patterns: ["housing", "/\\b(policy|legislation)\\b/i"]
  - type: response_excludes
    patterns: ["I don't have access"]
  - type: body_contains
    patterns: ["Dear David"]
  - type: body_excludes
    patterns: ["Best regards", "/here's the kicker/i"]
  - type: body_contains_any
    patterns: ["housing", "homes", "zoning"]

  # ── Length constraints ──
  - type: body_word_count
    min_words: 80
    max_words: 300
  - type: body_min_length
    min_words: 600

  # ── Structural checks ──
  - type: has_title
    min_words: 3
    max_words: 15
  - type: has_tldr
    min_chars: 50
    max_chars: 300
  - type: subject_not_empty
  - type: has_signoff
  - type: ends_with_question
  - type: body_has_headers
    min_count: 3
  - type: body_integrity
    max_shrinkage_pct: 10

  # ── Numeric scoring ──
  - type: score_range
    min: 40
    max: 65

  # ── Classification ──
  - type: channel_is
    channel: housing_policy
  - type: content_type_in
    values: [advocacy, opinion]
  - type: worthy

  # ── Field extraction ──
  - type: has_field
    field: occupation
    min_length: 5
  - type: has_fields
    fields: [topic_summary, sections]
  - type: min_fields_filled
    value: 4

  # ── Memory extraction ──
  - type: has_category
    value: "issue"
  - type: min_memories
    value: 2

  # ── Clustering / grouping ──
  - type: cluster_count_range
    min: 1
    max: 4
  - type: all_attendees_assigned
  - type: no_duplicate_assignments
  - type: themes_not_generic
    forbidden_themes: ["General group"]

  # ── Fact-check ──
  - type: item_count_range
    min: 5
    max: 20
  - type: no_false_positives
    max_actionable: 6
  - type: has_severity
    severity: green
    min: 1

  # ── LLM-as-judge checks ──
  - type: quality_check
    criteria:
      accuracy: 0.7
      completeness: 0.6
      no_hallucination: 0.8
      voice_fidelity: 0.7
  - type: voice_check
    criteria:
      no_filler: 0.5
      no_hedging: 0.6
      direct_tone: 0.6
      uses_specifics: 0.6
  - type: quality_check
    judge_profile: strict       # named profile (defined in judge-profiles.yaml)
    criteria:
      accuracy: 0.8             # profile can override default thresholds

# ── A/B testing (optional) ─────────────────────────
# comparison:
#   type: ab_test
#   control:
#     env: { DISABLE_FEATURE: "1" }
#   treatment:
#     env: {}
#   tolerance: 0.05
#   flaky_criteria:
#     some_criterion: 0.10

# ── Tier chaining (optional) ───────────────────────
# tier_chain:
#   - tier: quick
#     model: sonnet-4-6
#     output_file: quick_result.json
#   - tier: full
#     model: opus-4-6
#     input_from: quick_result.json
```

#### Complete expectation type inventory (60+ types)

| Category | Type | Key Fields | LLM? |
|----------|------|------------|------|
| **Tool calling** | `tool_called` | tool, required, input_contains | No |
| | `tool_not_called` | tool | No |
| **Text matching** | `response_contains` | patterns | No |
| | `response_excludes` | patterns | No |
| | `response_contains_any` | patterns | No |
| | `body_contains` | patterns | No |
| | `body_excludes` | patterns | No |
| | `body_contains_any` | patterns | No |
| | `title_excludes` | patterns | No |
| | `tldr_excludes` | patterns | No |
| | `reasoning_contains` | patterns | No |
| **Length** | `body_word_count` | min_words, max_words | No |
| | `body_min_length` | min_words | No |
| | `word_count_range` | min, max | No |
| | `commentary_length` | min_chars, max_chars | No |
| **Structure** | `has_title` | min_words, max_words | No |
| | `has_tldr` | min_chars, max_chars | No |
| | `has_subtitle` | min_chars, max_chars | No |
| | `has_read_time` | min, max | No |
| | `has_signoff` | — | No |
| | `has_links` | min_count | No |
| | `has_media_embeds` | min_count, max_count, pattern | No |
| | `body_has_headers` | min_count | No |
| | `subject_not_empty` | — | No |
| | `ends_with_question` | — | No |
| | `body_integrity` | max_shrinkage_pct | No |
| **Scoring** | `score_range` | min, max | No |
| | `expect_score_above` | value | No |
| | `expect_score_below` | value | No |
| | `bias_score_range` | min, max | No |
| | `quality_score_range` | min, max | No |
| **Classification** | `channel_is` | channel | No |
| | `channel_not` | channel | No |
| | `content_type_in` | values | No |
| | `worthy` / `not_worthy` | — | No |
| | `expected_pass` | value, expected_comment_type | No |
| **Field extraction** | `has_field` | field, min_length | No |
| | `has_fields` | fields | No |
| | `field_is` | field, value | No |
| | `field_contains` | field, patterns | No |
| | `field_missing` | field | No |
| | `min_fields_filled` | value | No |
| **Memory** | `has_category` | value | No |
| | `min_memories` | value | No |
| | `max_memories` | value | No |
| **Clustering** | `cluster_count_range` | min, max | No |
| | `group_count_range` | min, max | No |
| | `group_size_range` | min, max | No |
| | `min_stories` / `max_stories` | count | No |
| | `all_attendees_assigned` | — | No |
| | `no_duplicate_assignments` | — | No |
| | `themes_not_generic` | forbidden_themes | No |
| | `has_high_score_cluster` | min, score | No |
| | `all_clusters_have_evidence` | — | No |
| **Chunks** | `chunk_count_range` | min, max | No |
| | `lossless` | — | No |
| | `word_bound` | max_words | No |
| **Threads** | `has_tweets` | min_count, max_count | No |
| | `char_limits` | — | No |
| | `link_in_last_tweet` | — | No |
| **Fact-check** | `item_count_range` | min, max | No |
| | `no_false_positives` | max_actionable | No |
| | `has_severity` | severity, min | No |
| | `violation_severity_at_least` | violation, severity | No |
| **Media** | `selects_expected_images` | expected_filenames, min_selected | No |
| | `extracts_clean_content` | min_length | No |
| | `min_concepts` | count | No |
| **Research** | `min_sections` | count | No |
| | `has_commentaries` | min | No |
| | `title_changed` | — | No |
| **Source audit** | `source_audit_ran` | — | No |
| | `urls_from_sources` | allow_tweets, allow_internal | No |
| | `outline_sources_cited` | min_ratio | No |
| **LLM judge** | `quality_check` | criteria (dict), judge_profile | Yes |
| | `voice_check` | criteria (dict or string) | Yes |
| | `question_quality` | criteria | Yes |

### Eval Cache (language-agnostic CLI)

```
~/.gstack/eval-cache/
  {suite}/
    {sha-key}.json    ← { _cache_version, _cached_at, _suite, _case_name, data }
```

Cache key = `SHA256(source_files_content + test_input)[0..15]`

Any language uses the cache via CLI:

```bash
# Read (returns JSON to stdout, exit 0 on hit, exit 1 on miss)
gstack eval cache read my_suite abc123def456

# Write (reads JSON from stdin or argument)
gstack eval cache write my_suite abc123def456 '{"data": ...}'

# Management
gstack eval cache stats            # Per-suite file count, disk usage, date range
gstack eval cache verify           # Check all entries for validity
gstack eval cache clear [suite]    # Clear all or per-suite
```

Env vars: `EVAL_CACHE=0` (disable), `EVAL_CACHE_CLEAR=1` (clear before run),
`EVAL_JUDGE_CACHE=0` (skip cached judge scores — re-run LLM judges even if cached).

Judge responses are cached separately from eval data. This lets you re-run deterministic
checks (text matching, length, tool calling) without re-calling expensive LLM judges.

Ported from `eval_cache.rb` — same atomic write (tmp+rename), same version/validation, same SHA computation.

### Multiprocess Worker Support

For large test suites (60+ cases), eval workers run in parallel processes:

```
~/.gstack/eval-partials/{suite}/worker_{pid}.json
```

Each worker writes partial results. `gstack eval push` merges them before upload:
1. Workers write `worker_{pid}.json` atomically (tmp+rename)
2. Push reads all `worker_*.json` in the partials directory
3. Deduplicates by test name (keeps longest `duration_ms`)
4. Merges into a single result JSON
5. Pushes merged result to Supabase

Env var: `EVAL_WORKERS=4` (number of parallel processes, default 1).

### Eval Cost Tracker

Reads the `costs` array from result JSON. Terminal dashboard:

```
┌─────────────────────────────────────────────────────────────┐
│  EVAL COST DASHBOARD (standard tier)                        │
├──────────────────┬───────┬──────────┬──────────┬────────────┤
│ Model            │ Calls │ Input    │ Output   │ Est. Cost  │
├──────────────────┼───────┼──────────┼──────────┼────────────┤
│ sonnet-4-6       │   25  │   45,123 │   12,456 │ $0.1234    │
│ opus-4-6         │    5  │   78,900 │   45,123 │ $0.5678    │
├──────────────────┼───────┼──────────┼──────────┼────────────┤
│ TOTAL            │   30  │  124,023 │   57,579 │ $0.6912    │
│ At full tier: ~$0.9234  │  At fast tier: ~$0.3456           │
└─────────────────────────────────────────────────────────────┘
```

Also generates HTML dashboard and pushes aggregated costs to Supabase `eval_costs` table.

### Auto-Labeling

```
Label = EVAL_LABEL env || sanitized_git_branch
Append tier suffix: _fast, _full (omit for standard)
```

### Eval Tier & Run Scopes

Two orthogonal tier concepts:

**Run scope** — how much of the test suite to execute:
```
EVAL_TIER=quick      # Subset of cases (fast smoke test)
EVAL_TIER=standard   # Full suite (default)
EVAL_TIER=full       # Full suite + expensive multi-judge checks
```

**Judge model tier** — which model judges use:
```
EVAL_JUDGE_TIER=fast|standard|full
Aliases: haiku→fast, sonnet→standard, opus→full
```

**Debug output:**
```
EVAL_VERBOSE=1       # Persistent logging to ~/.gstack/log/evals/
                     # Format: YYYYMMDD-{test-name}-{random}.txt
                     # Includes full untruncated LLM inputs/outputs
```

### CLI Commands

```bash
# Result management
gstack eval push <file.json>       # Push result to Supabase + local store
                                   # Dedup: skips insert if git_sha+label+tier already exists
gstack eval list [label]           # List all results (local + Supabase)
gstack eval compare [a] [b]       # Compare two runs — color-coded score deltas
gstack eval baselines [date]       # Generate markdown baseline report
gstack eval cost [file.json]       # Show cost dashboard from result

# Cache (any language, CLI interface)
gstack eval cache read <suite> <key>
gstack eval cache write <suite> <key> [data]
gstack eval cache stats
gstack eval cache clear [suite]
gstack eval cache verify

# Live monitoring
gstack eval watch                  # Browser dashboard (Bun.serve + SSE)
```

### Live Eval Dashboard (browser-based)

`gstack eval watch` starts a local Bun HTTP server, auto-opens browser:
- Progress bar, pass/fail tally, cost accumulating in real-time
- Per-test results table updating as each test completes
- Estimated time remaining
- Live updates via Server-Sent Events (SSE) — simpler than WebSocket, one-directional
- Reuses browse server patterns: random port selection, state file, auto-shutdown
- Eval runner writes progress to a known file; dashboard reads and streams it

### Future: Native Eval Runner Mode

For projects that want gstack to run evals directly (YAML cases → Anthropic API → judge → result) without any app framework. Deferred as a separate initiative after adapter mode proves valuable.

---

## Supabase Schema

```sql
-- ═══════════════════════════════════════════════
-- Teams and membership
-- ═══════════════════════════════════════════════

create table teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz default now()
);

create table team_members (
  team_id uuid references teams(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz default now(),
  primary key (team_id, user_id)
);

-- ═══════════════════════════════════════════════
-- Eval results (merges gstack EvalResult + external project format)
-- ═══════════════════════════════════════════════

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  version text not null,
  branch text not null,
  git_sha text not null,
  repo_slug text not null,
  label text not null,                -- auto-label (branch + tier suffix)
  timestamp timestamptz not null,
  hostname text not null,
  user_id uuid references auth.users(id),
  tier text not null
    check (tier in ('e2e', 'llm-judge', 'fast', 'standard', 'full')),
  total_tests int not null,
  passed int not null,
  failed int not null,
  total_cost_usd numeric(10,4) not null,
  total_duration_ms int not null,
  tests jsonb not null,               -- EvalTestEntry[] (transcripts stripped)
  judge_averages jsonb,               -- { criterion: avg_score } (aggregated)
  created_at timestamptz default now()
);

-- Eval cost tracking (per-model, per-run)
create table eval_costs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  eval_run_id uuid references eval_runs(id) on delete cascade,
  model text not null,
  calls int not null,
  input_tokens int not null,
  output_tokens int not null,
  estimated_cost_usd numeric(10,6) not null,
  created_at timestamptz default now()
);

-- ═══════════════════════════════════════════════
-- Skill data (retro, review, QA, ship)
-- ═══════════════════════════════════════════════

create table retro_snapshots (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  repo_slug text not null,
  user_id uuid references auth.users(id),
  date date not null,
  window text not null,               -- '7d', '14d', '30d'
  metrics jsonb not null,             -- commits, LOC, test ratio, sessions, etc.
  authors jsonb not null,             -- per-contributor breakdown
  version_range jsonb,
  streak_days int,
  tweetable text,
  greptile jsonb,
  backlog jsonb,
  created_at timestamptz default now()
);

create table greptile_triage (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  user_id uuid references auth.users(id),
  date date not null,
  repo text not null,                 -- owner/repo
  triage_type text not null
    check (triage_type in ('fp', 'fix', 'already-fixed')),
  file_pattern text not null,
  category text not null,             -- race-condition, null-check, security, etc.
  created_at timestamptz default now()
);

create table qa_reports (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  repo_slug text not null,
  user_id uuid references auth.users(id),
  url text not null,
  mode text not null,                 -- full, quick, regression, diff-aware
  health_score numeric(5,2),
  issues jsonb,
  category_scores jsonb,
  report_markdown text,
  created_at timestamptz default now()
);

create table ship_logs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  repo_slug text not null,
  user_id uuid references auth.users(id),
  version text not null,
  branch text not null,
  pr_url text,
  review_findings jsonb,
  greptile_stats jsonb,
  todos_completed text[],
  test_results jsonb,
  created_at timestamptz default now()
);

-- ═══════════════════════════════════════════════
-- Session transcripts (opt-in only)
-- ═══════════════════════════════════════════════

create table session_transcripts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  user_id uuid references auth.users(id),
  session_id text not null,
  repo_slug text not null,
  messages jsonb not null,            -- [{role, display_text, tool_names, timestamp}]
  total_turns int,
  tools_used jsonb,                   -- {Bash: 8, Read: 3, ...}
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now()
);

-- ═══════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════

create index idx_eval_runs_team_label on eval_runs(team_id, label, timestamp desc);
create index idx_eval_runs_team_ts on eval_runs(team_id, timestamp desc);
create index idx_eval_costs_run on eval_costs(eval_run_id);
create index idx_retro_team_date on retro_snapshots(team_id, date desc);
create index idx_greptile_team_date on greptile_triage(team_id, date desc);
create index idx_qa_team_created on qa_reports(team_id, created_at desc);
create index idx_ship_team_created on ship_logs(team_id, created_at desc);

-- ═══════════════════════════════════════════════
-- Row Level Security (same pattern all tables)
-- ═══════════════════════════════════════════════

alter table teams enable row level security;
alter table team_members enable row level security;
alter table eval_runs enable row level security;
alter table eval_costs enable row level security;
alter table retro_snapshots enable row level security;
alter table greptile_triage enable row level security;
alter table qa_reports enable row level security;
alter table ship_logs enable row level security;
alter table session_transcripts enable row level security;

-- Team members can read their team's data
create policy "team_read" on eval_runs for select using (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "team_insert" on eval_runs for insert with check (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
-- Only admins/owners can delete
create policy "team_admin_delete" on eval_runs for delete using (
  team_id in (select team_id from team_members
    where user_id = auth.uid() and role in ('owner', 'admin'))
);
-- (Repeat for all data tables)
```

### Dashboard Queries Unlocked

```sql
-- Eval regression detection
select label, timestamp, passed, total_tests,
  passed::float / total_tests as pass_rate
from eval_runs where team_id = $1
order by timestamp desc limit 20;

-- Team velocity (PRs per week per person)
select date_trunc('week', created_at) as week,
  user_id, count(*) as ships
from ship_logs where team_id = $1
group by 1, 2 order by 1 desc;

-- Cost trending
select date_trunc('week', created_at) as week,
  sum(estimated_cost_usd) as total_cost,
  sum(input_tokens + output_tokens) as total_tokens
from eval_costs where team_id = $1
group by 1 order by 1 desc;

-- Greptile signal quality
select category,
  count(*) filter (where triage_type = 'fp') as fps,
  count(*) filter (where triage_type = 'fix') as fixes,
  round(count(*) filter (where triage_type = 'fp')::numeric / count(*) * 100) as fp_pct
from greptile_triage where team_id = $1
group by category order by count(*) desc;

-- QA health trending
select created_at::date, repo_slug, health_score
from qa_reports where team_id = $1
order by created_at desc;
```

---

## Integration Points (critical existing files)

| Integration | File | Change |
|---|---|---|
| Eval push | `test/helpers/eval-store.ts:420` (`finalize()`) | After local write, call `pushEvalRun()` |
| Eval judge | `test/helpers/llm-judge.ts` | Extend with multi-judge judging, tier selection |
| Retro push | `retro/SKILL.md.tmpl` Step 13 | Bash call: `gstack-sync push-retro "$FILE"` |
| Greptile push | `review/greptile-triage.md` | After append, call `gstack-sync push-greptile` |
| QA push | `qa/SKILL.md.tmpl` Phase 6 | After baseline, call `gstack-sync push-qa` |
| Ship push | `ship/SKILL.md.tmpl` new Step 9 | Write ship log + push |
| Config reuse | `browse/src/config.ts` | Import `getRemoteSlug()`, `getGitRoot()` |
| User settings | `bin/gstack-config` | Reuse for sync preferences (`sync_enabled`, `sync_transcripts`) |
| Atomic write | `eval-store.ts:413-416` | Extract shared `atomicWriteJSON()` utility |
| Eval watch | `scripts/eval-watch.ts` | Adapt for browser-based SSE dashboard |
| Comparison | `eval-store.ts:167` `compareEvalResults()` | Extend with color-coded diff + cross-team |

---

## New Files

```
gstack/
├── lib/                             # Shared library
│   ├── sync.ts                      # Supabase client, push/pull, token refresh
│   ├── sync-config.ts               # .gstack-sync.json + ~/.gstack/auth.json
│   ├── auth.ts                      # Device auth flow, token management
│   ├── eval-cache.ts                # SHA-based cache (ported from eval_cache.rb)
│   ├── eval-cost.ts                 # Token accumulator + dashboards
│   ├── eval-tier.ts                 # Model tier selection (fast/standard/full)
│   ├── eval-baselines.ts            # Markdown baseline generator
│   ├── eval-format.ts               # Standard result format validation + helpers
│   └── util.ts                      # atomicWriteJSON(), numberWithCommas()
├── bin/
│   ├── gstack-sync                  # Bash wrapper (setup, init, pull, status, migrate)
│   └── gstack-eval                  # Bun entry (push, cache, list, compare, etc.)
├── eval/
│   ├── watch-server.ts              # Bun.serve() for live eval dashboard
│   └── watch-ui.html               # SSE-powered live dashboard page
├── supabase/
│   └── migrations/
│       ├── 001_teams.sql
│       ├── 002_eval_runs_and_costs.sql
│       ├── 003_skill_data.sql
│       └── 004_rls_policies.sql
├── docs/
│   └── eval-result-format.md        # Standard format spec for any language
├── .gstack-sync.json.example
└── test/lib/
    ├── sync.test.ts
    ├── eval-cache.test.ts
    ├── eval-cost.test.ts
    └── eval-format.test.ts
```

---

## Phased Rollout

### Phase 1: Foundation + eval infrastructure

- `lib/sync.ts`, `lib/auth.ts`, `lib/sync-config.ts`, `lib/util.ts`
- `bin/gstack-sync` (setup, init, pull, status, migrate)
- Supabase migrations (teams, team_members, eval_runs, eval_costs)
- Standard eval result format spec (`docs/eval-result-format.md`, `lib/eval-format.ts`)
- `bin/gstack-eval` (push, list, compare, cost, cache)
- `lib/eval-cache.ts` (port from existing Rails eval cache pattern)
- `lib/eval-cost.ts` (port from existing Rails cost tracker pattern)
- `lib/eval-tier.ts` (fast/standard/full model mapping)
- Hook `EvalCollector.finalize()` → auto-push when sync configured
- YAML test case format spec + `yaml` npm dependency
- First-run team welcome in `gstack sync setup`
- Color-coded visual diff in `gstack eval compare`

### Phase 2: Ship logs + Greptile + skill sync + live dashboard

- Add ship_logs, greptile_triage tables
- Ship log local write + push (new Step 9 in ship template)
- Greptile triage push after append
- `gstack eval watch` — live browser dashboard (Bun.serve + SSE)
- `lib/eval-baselines.ts` (markdown baseline generator)
- Inline sync indicator in skill output ("Synced to team ✓")

### Phase 3: Retro + QA + transcript sync

- Add retro_snapshots, qa_reports, session_transcripts tables
- Hook retro and QA write paths
- Opt-in transcript sync

### Phase 4: Team dashboard + edge functions

- `gstack dashboard` — team-wide HTML dashboard, reads from Supabase
- Supabase edge function: regression alerts on eval_runs INSERT
- Weekly digest edge function (cron → email/Slack)
- Team admin commands (create, invite)
- `gstack eval leaderboard` — fun weekly team stats

---

## Data Flows

### Push (write) flow — all four paths

```
  Skill writes local file
         │
         ▼
  loadSyncConfig()
         │
    ┌────┴────┐
    │ config? │
    │         │
   NO        YES
    │         │
    ▼         ▼
  RETURN   refreshTokenIfNeeded()
  (noop)      │
         ┌────┴────┐
         │ token   │
         │ valid?  │
        NO        YES
         │         │
         ▼         ▼
      queue to   supabase.from(table).upsert(data)
      sync-         │
      queue.    ┌───┴───────┬──────────┐
      json      │           │          │
               OK      TIMEOUT     ERROR
                │       (5s)        │
                ▼         │         ▼
             DONE      queue to   log warning
                       sync-      + queue
                       queue.json

  NIL PATH:  .gstack-sync.json missing → noop
  EMPTY PATH: sync_enabled=false → noop
  ERROR PATH: Supabase unreachable → 5s timeout → queue + continue
```

### Pull-to-cache (read) flow

```
  gstack sync pull
         │
         ▼
  loadSyncConfig()
         │
    ┌────┴────┐
    │ config? │
   NO        YES
    │         │
    ▼         ▼
  skip     supabase.from(table).select(...)
             │
        ┌───┴──────┬──────────┐
        │          │          │
       OK      TIMEOUT     ERROR
        │       (3s)        │
        ▼          │         ▼
     write to    keep       keep
     cache/      stale      stale
        │        cache      cache
        ▼
     update
     .meta.json
```

---

## Error & Rescue Map

```
METHOD/CODEPATH              | WHAT CAN GO WRONG              | RESCUED? | ACTION                    | USER SEES
-----------------------------|--------------------------------|----------|---------------------------|------------------
loadSyncConfig()             | .gstack-sync.json missing      | Y        | Return null → noop        | Nothing
                             | JSON malformed                 | Y        | Log warning, return null  | Nothing
                             | auth.json missing              | Y        | Return null → noop        | Nothing
refreshToken()               | Supabase auth down             | Y        | Queue + continue          | Nothing
                             | Token revoked                  | Y        | Clear token, prompt setup | "Run gstack sync setup"
pushEvalRun() (all push*)    | Supabase 503                   | Y        | Queue for retry           | Nothing
                             | Network timeout (5s)           | Y        | Queue for retry           | Nothing
                             | Rate limit (429)               | Y        | Backoff + queue           | Nothing
                             | RLS violation (403)            | Y        | Log, skip                 | Warning in status
                             | Duplicate (409)                | Y        | Ignore (idempotent)       | Nothing
                             | Token expired                  | Y        | Refresh → retry once      | Nothing
pullToCache()                | Supabase timeout (3s)          | Y        | Use stale cache           | Stale data
                             | Empty result set               | Y        | Write empty cache         | Nothing
                             | Cache dir EACCES               | Y        | Log warning               | Warning in status
                             | Cache JSON corrupt             | Y        | Delete + re-pull          | Nothing
queueForRetry()              | Queue file EACCES              | Y        | Log, data lost            | Warning in status
drainQueue()                 | Partial failure                | Y        | Failed items stay queued  | Nothing
pushTranscript()             | history.jsonl EBUSY            | Y        | Skip this cycle           | Nothing
gstack sync setup            | OAuth timeout                  | Y        | Clear error message       | Error
                             | Localhost port in use          | Y        | Try 3 ports               | Error if all fail
                             | Already authenticated          | Y        | "Re-auth or keep?"        | Prompt
gstack sync init             | Tables already exist           | Y        | Idempotent (IF NOT EXISTS)| Nothing
                             | Service key invalid            | Y        | Clear error               | Error
```

All 16 error paths are rescued. 0 critical gaps.

---

## Security & Threat Model

| # | Threat | Likelihood | Impact | Mitigated? | How |
|---|--------|------------|--------|------------|-----|
| 1 | Anon key exposed in repo | Certain | LOW | YES | By Supabase design — RLS enforces access |
| 2 | Auth token stolen from auth.json | Low | HIGH | YES | 0o600, per-machine, auto-expire |
| 3 | MITM on Supabase HTTPS | Very Low | HIGH | YES | TLS 1.2+, Supabase cert management |
| 4 | RLS bypass via malformed JWT | Low | HIGH | YES | Supabase validates JWTs server-side |
| 5 | Cross-team data leak via REST API | Low | HIGH | YES | RLS on all tables |
| 6 | CI token leaked via logs | Medium | HIGH | PARTIAL | Document short-lived + scoped tokens |
| 7 | Transcript contains secrets | Medium | MEDIUM | YES | Opt-in = consent, trust the team |
| 8 | sync-queue.json has pending data | Medium | LOW | YES | 0o600 on file |
| 9 | Service role key in shell history | Low | CRITICAL | YES | Prompt-based, never stored, or env var |
| 10 | Supabase JS SDK supply chain | Very Low | HIGH | PARTIAL | Pin version, audit |

---

## Observability

### Sync log

`~/.gstack/sync.log` — append-only, one line per operation:

```
[2026-03-15T10:30:00Z] PUSH eval_runs OK 5 tests, 0.3s
[2026-03-15T10:30:01Z] PUSH retro_snapshots QUEUED timeout after 5s
[2026-03-15T10:35:00Z] DRAIN 47/47 OK 2.1s
```

### Status command

```
$ gstack sync status
─────────────────
  Project:       .gstack-sync.json (supabase_url: https://xyzcompany.supabase.co)
  User settings: sync_enabled=true, sync_transcripts=false (via gstack-config)
  Connected:     yes
  Authenticated: yes (dev@company.com, team: xyzcompany)
  Last push:     2 min ago (eval_runs)
  Last pull:     1h ago
  Queue:         0 items
  Cache:         retro: 47 rows (2h old), eval: 123 rows (2h old)
  Sync log:      ~/.gstack/sync.log (1.2KB)
```

### Inline sync in skills

After `/ship` or `/retro` completes:
```
Synced to team ✓
```
or
```
Queued (offline)
```
or nothing (sync not configured).

---

## What Already Exists (reuse map)

| Existing code | File | Reuse |
|---|---|---|
| `EvalCollector` + `finalize()` | `test/helpers/eval-store.ts:420` | Hook for eval push |
| `getRemoteSlug()` | `browse/src/config.ts:119` | Repo identification |
| `getGitRoot()` | `browse/src/config.ts:28` | Project root detection |
| Atomic write (tmp+rename) | `eval-store.ts:413-416` | Extract to `atomicWriteJSON()` |
| Bash wrapper pattern | `bin/gstack-update-check` | Template for `bin/gstack-sync` + `bin/gstack-eval` |
| 0o600 state file | `browse/src/server.ts` | Pattern for `auth.json` |
| `compareEvalResults()` | `eval-store.ts:167` | Extend for cross-team |
| `formatComparison()` | `eval-store.ts:267` | Extend with color diff |
| `llm-judge.ts` | `test/helpers/llm-judge.ts` | Extend with multi-judge |
| eval-watch.ts | `scripts/eval-watch.ts` | Adapt for browser SSE |
| `gstack-config` get/set/list | `bin/gstack-config` | User settings for sync preferences (v0.3.9) |

---

## What's NOT in Scope

| Item | Rationale |
|---|---|
| Native eval runner mode | Adapter-only first. Future TODO after adapter proves out. |
| Hosted gstack cloud service | Self-hosted Supabase per team. |
| Cross-team benchmarking | Phase 5+ — needs anonymization + multi-team opt-in. |
| Porting existing eval runners | Runners stay in their source language. gstack is infrastructure. |
| Real-time sync (WebSocket) | Push-on-write + cache pull is sufficient. |
| Transcript scrubbing | Trust the team. Opt-in = consent. |

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Supabase adds a dependency | `@supabase/supabase-js` imported conditionally. If missing or unconfigured, all sync functions return immediately. Zero impact on non-sync users. |
| Sync failures slow down skills | All push: 5s timeout, non-fatal. All pull: cache-based, skills never block on network. |
| Large eval transcripts | Strip `transcript` field from EvalTestEntry before push. Full transcripts stay local-only. |
| Token expiry mid-session | Auto-refresh before each push. If refresh fails, queue to `sync-queue.json` for retry. |
| Schema drift | Flexible fields use `jsonb`. Only fields needed for indexing/querying are proper columns. `schema_version` for forward compat. |
| Queue overflow | No cap. Warn via `gstack sync status` if >100 items or oldest entry >24h. |
| Concurrent queue writes | Atomic read-modify-write via `atomicWriteJSON()` (tmp+rename pattern). |
| Cache staleness | `.meta.json` tracks last_pull + row counts per table. Skills can display "team data as of 2h ago". |

---

## Verification Plan

1. `gstack sync setup` → complete auth → verify `~/.gstack/auth.json` written with 0o600
2. `gstack eval push result.json` → verify row in Supabase dashboard
3. `gstack eval cache stats` → verify cache populated after eval run
4. `gstack eval compare main feature-branch` → verify color-coded delta output
5. `gstack eval cost result.json` → verify cost dashboard renders
6. `gstack sync pull` → verify `.gstack/team-cache/` populated with `.meta.json`
7. Offline test: disconnect network → run evals → reconnect → verify queued syncs drain
8. `/ship` → verify ship log in Supabase
9. `/retro` → verify team data from cache appears in output
10. `gstack sync status` → verify health output (connected, authenticated, queue, cache)

---

## Review Decisions Log

All decisions from the /plan-ceo-review session on 2026-03-15:

| # | Question | Options | Chosen | Rationale |
|---|----------|---------|--------|-----------|
| 0F | Mode selection | Expansion / Hold / Reduction | **EXPANSION** | Greenfield team infra, cathedral-tier vision |
| 1 | Read-side architecture | Cache / Direct / Hybrid | **Cache-based** | Skills never touch network. "Sync is invisible" invariant. |
| 2 | Queue overflow | Cap / Warn / Both | **Warn only** | Don't silently drop data. Surface via status. |
| 3 | Transcript secrets | Scrub / Trust / Metadata-only | **Trust the team** | Supabase is encrypted. Opt-in = consent. |
| 4 | Cache staleness | Meta file / File mtime / None | **Meta file** | `.meta.json` gives skills + status a single source of truth. |
| 5 | Queue drain performance | Parallel / Sequential / Background | **Parallel 10x** | 500 items in ~10s vs 100s. |
| — | Scope expansion | Full convergence / Eval sync only / Defer | **Full convergence** | Existing Rails eval infra + gstack team sync = universal platform |
| — | Integration mode | Native + Adapter / Native only / Adapter only | **Adapter only** | App runs evals, gstack is infrastructure. Start with C, add B as TODO. |
| — | Case format | YAML / JSON / Both | **YAML cases, JSON results** | YAML for human-authored (comments, multiline), JSON for machine output. |
| T1 | Regression alerts | TODOS / Skip / Build Phase 4 | **Phase 4** | Killer feature of team sync. |
| T2 | Weekly digest | TODOS / Skip / Build Phase 4 | **Phase 4** | Passive team visibility. |
| T3 | Eval case format spec | Phase 1 / TODOS / Port directly | **Phase 1** | Foundational to eval CLI. |
| D1 | Live eval dashboard | Phase 1 / TODOS / Phase 4 | **Phase 2** | Bun.serve + SSE, reuses browse patterns. |
| D2 | Team leaderboard | TODOS / Skip / Phase 4 | **Phase 4** | Fun gamification alongside dashboard. |
| D3 | Inline sync indicator | Phase 2 / TODOS / Skip | **Phase 2** | XS effort, builds trust in sync. |
| D4 | First-run welcome | Phase 1 / TODOS / Skip | **Phase 1** | Part of setup flow. |
| D5 | Visual eval diff | Phase 1 / TODOS / Skip | **Phase 1** | Color-coded compare is essential UX. |
