# GStack Data Layer

A local-first BI/data layer for GStack/OpenClaw/Hermes users: measure what the
harness is doing, connect it to business KPIs, verify the data, guide the next
workflow, and preserve clean traces for future context/eval/SLM work.

## Why This Exists

GStack already helps builders plan, review, QA, ship, benchmark, retro, and
learn. It also has local analytics through `gstack-analytics`, which reads the
local `~/.gstack/analytics/skill-usage.jsonl` file.

The missing layer for vertical operators is business visibility:

- What is the agent harness doing?
- Which skills and workflows are used most?
- How long do they take, and how often do they succeed?
- Which outputs are accepted, edited, or rejected?
- Which crons fired, when they started, when they finished, and how long they ran?
- How many agents were active?
- How many tokens and dollars were used by hour, day, week, or month?
- Which user-defined categories are consuming resources?
- Which business workflows are touched?
- Which KPIs are moving?
- Which repeated workflows are ready for context compression, evals, or future
  open-weight SLM/adapters?

This is not a hosted dashboard and not model training. It is a small local data
foundation that turns activity and business-process outcomes into clean,
dashboard-ready artifacts.

## Data Flow

```text
Sources
  -> Collector
  -> Normalizer / Cleaner
  -> Local Store
  -> Metrics Catalog
  -> Dashboard Adapter
  -> Workflow Navigator
  -> Context / Eval / Trace Export
```

Initial sources:

- GStack local analytics JSONL
- GStack skill run metadata
- optional OpenClaw/Hermes harness events
- optional GBrain pages and reports
- optional user app, CRM, calendar, email, Stripe, Shopify, HubSpot, Salesforce,
  or manual CSV events after user opt-in

First PR scope is intentionally narrower:

- normalize local GStack analytics
- accept optional redacted business events
- define schemas
- export JSONL, JSON, and CSV artifacts
- document downstream dashboard targets

## Local Files

The default project-local path is:

```text
.gstack/data-layer/
  business-events.jsonl
  cron-runs.jsonl
  category-rules.json
  metric-definitions.json
  dashboard-spec.json
  exports/<YYYY-MM-DD>/
```

`.gstack/` is gitignored in this repo. Treat data-layer files as private by
default. Commit only sanitized examples that were intentionally reviewed.

The export helper writes:

- `agent-events.jsonl`
- `agent-events.csv`
- `business-events.jsonl`
- `business-events.csv`
- `cron-runs.jsonl`
- `cron-runs.csv`
- `workflow-outcomes.json`
- `workflow-outcomes.csv`
- `activity-series.json`
- `activity-series.csv`
- `category-summary.json`
- `category-summary.csv`
- `agent-concurrency.json`
- `agent-concurrency.csv`
- `cron-timeline.json`
- `cron-timeline.csv`
- `dashboard-summary.json`
- `dashboard-data.json`
- `dashboard.html`
- `daily-report.md`
- `README.md`

Run:

```bash
gstack-data-layer-export --window 30d --bucket day --project "local-project" --domain "real_estate"
```

Use `--bucket hour`, `--bucket day`, `--bucket week`, or `--bucket month` to
shape the time series for charts.

## Core Schemas

The first schema set lives under `schemas/`:

- `AgentEvent`: normalized agent or skill runs.
- `BusinessEvent`: redacted business-process events linked to agent runs.
- `MetricDefinition`: KPI definitions with numerator, denominator, owner, and
  grounding requirement.
- `KPIObservation`: measured KPI values for a time window.
- `WorkflowOutcome`: workflow rollups with review status, duration, business
  metric links, and future routing readiness.
- `DashboardSpec`: panels, metrics, and export targets.
- `CronRun`: scheduled/cron runs with start and finish timestamps for Gantt
  charting.
- `CategoryRuleSet`: user-defined resource categories such as personal, admin,
  work, financial, coding, sales, support, or any local custom bucket.
- `ActivitySeries`: flexible time buckets for runs, crons, tokens, costs, and
  active agents.
- `DashboardReport`: opt-in daily screenshot/report preferences.

These schemas are intentionally model-agnostic and vertical-agnostic. They use
examples and descriptions rather than hard-coding one provider, model family,
business domain, or database.

## Privacy Model

Local-first is the default.

- No remote transmission is added by the data layer.
- No raw prompts, raw code, client names, addresses, emails, phone numbers, or
  unredacted CRM records belong in shared examples.
- Raw repo slugs are not exported by the helper; when present, they are hashed.
- Raw agent ids are not exported by the helper; when present, they are hashed.
- Business data should stay under `.gstack/data-layer/` unless explicitly
  sanitized for sharing.
- Local analytics are different from remote telemetry. `gstack-analytics` and
  this data layer can operate on local files without sending anything anywhere.

If a future team/cloud mode exports to Postgres, Supabase, BigQuery, Snowflake,
or another system, that should be explicit opt-in.

## Dashboard Targets

The first version exports dashboard-ready files instead of bundling a dashboard.
Downstream targets can include:

- CSV
- JSON
- JSONL
- local `dashboard.html`
- daily screenshot reports from a user-approved agent
- DuckDB
- SQLite
- Postgres
- Supabase
- Vercel/Next.js dashboard starter
- Replit dashboard starter
- Streamlit
- Observable
- Evidence.dev
- Metabase
- Grafana
- Retool

The mergeable first step is local JSONL to normalized JSON/CSV plus a small
static HTML dashboard. Heavy dashboard dependencies should stay out of GStack
unless a later PR proves the need.

The local `dashboard.html` is intentionally dependency-free. It renders:

- resource overview
- agent activity by time bucket
- token use by time bucket
- cron runs and active-agent counts
- user-defined task categories
- Gantt-style cron timeline
- workflow outcomes

For daily resource management, users can approve an agent or local cron to run
the exporter, open `dashboard.html`, capture screenshots of the key sections,
and send them through a user-configured channel. The data layer does not send
anything by default and does not store delivery secrets.

## Relationship To Existing GStack Pieces

- `gstack-analytics`: current personal usage dashboard from local JSONL.
  The data layer normalizes that input for BI exports.
- `/retro`: already summarizes engineering work and skill usage. The data layer
  adds dashboard-ready business/workflow objects.
- `/benchmark`: already tracks performance baselines. Data-layer exports can link
  performance metrics to workflow and business outcomes later.
- `/learn`: captures project-specific patterns and preferences. The data layer
  gives `/learn` cleaner workflow and KPI artifacts to reason over.
- GBrain: remains the memory/retrieval layer. The data layer can produce pages,
  reports, and clean artifacts that GBrain can index, but it does not replace
  GBrain.
- Grounded review: issue #973 describes fact-checking file paths, math, CLI
  flags, and implementation claims. Data-layer metrics should eventually be
  reviewed the same way before users trust dashboard claims.
- Workflow navigation: issue #723 describes a "you are here" layer for users who
  think in workflow stages. Data-layer activity and outcomes are a natural input
  to that future navigator.
- Trace/eval future: PR #1198 explores context cards, evals, and
  training-ready traces. The data layer is the BI foundation that can later
  identify which workflows are clean, high-volume, and repetitive enough to
  export for context/eval/SLM work.

## Example KPI Families

Real estate / OpenClaw:

- lead response time
- lead-to-appointment rate
- appointment-to-offer rate
- offer-to-close rate
- closing rate by lead source
- follow-up completion rate
- listing-copy revision count
- CMA turnaround time
- showing coordination time saved
- CRM enrichment completion rate
- human edit rate by workflow
- fair-housing review flags

Agentic AI operations:

- agent runs by hour/day/week/month
- cron runs by hour/day/week/month
- cron success rate
- cron duration p50/p95
- active agents by period
- tokens in/out/total by period
- estimated cost by period
- cost per successful run
- cost per workflow
- human acceptance, edit, and rejection rates
- error and abort rates
- category resource mix
- workflow repeatability
- queue/backlog age where available
- time saved estimate
- daily dashboard/report delivery status

SaaS / tech:

- trial signups
- activation rate
- time to first value
- feature adoption
- support ticket volume
- bug fix turnaround
- churn-risk flags
- MRR / ARR movement
- demo booked rate
- issue-to-PR cycle time
- QA pass rate
- deploy frequency
- post-deploy incidents

Ecommerce:

- orders
- average order value
- cart abandonment
- refund rate
- support tickets per order
- campaign approval rate
- product-page copy revisions
- return reasons
- inventory issue flags
- response time
- upsell/cross-sell conversion

Agencies / services:

- inbound leads
- proposal turnaround time
- proposal acceptance rate
- onboarding completion
- billable hours saved
- revision cycles
- follow-up completion
- project status risk
- invoice collection status

Legal / finance ops:

- intake completion
- document review turnaround
- missing-document rate
- risk flags
- client response time
- compliance review pass rate
- human edit rate
- matter stage movement
- research memo acceptance rate

## Readiness Heuristics

These are planning heuristics, not hard scientific cutoffs:

- 20-50 skill runs: basic usage dashboard.
- 50-100 workflow runs: common workflows and bottlenecks.
- 100-300 workflow runs: workflow recommendations.
- 100-500 business events: early funnel metrics.
- 500-1,500 accepted outputs: context compression and narrow evals.
- 1,500-5,000 high-quality accepted examples: narrow adapter experiment
  candidate for repetitive extraction, classification, or drafting.
- 5,000-10,000+ clean examples: serious vertical intelligence corpus across
  related workflows.

## Follow-Up PRs

1. Grounded Data Review: verify metric definitions, denominators, date windows,
   math, file/path/function claims, CLI/API claims, and reproducibility.
2. Workflow Navigator: use local activity and business outcomes to recommend the
   next best skill or action.
3. Context/eval/trace exports: turn accepted, redacted workflows into context
   cards, eval cases, and optional training-ready traces.
4. Dashboard starters: optional thin examples for Next.js, Streamlit, Evidence,
   or other targets once the export format stabilizes.
