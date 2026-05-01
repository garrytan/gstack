# GStack Data Layer Examples

These files are sanitized, illustrative examples for the local-first GStack Data
Layer. They are not real customer records and do not contain real PII.

The example shows how an operator could connect GStack/OpenClaw activity to
business-process events and dashboard-ready KPIs without adding remote telemetry
or a hosted dashboard.

## Files

- `kpi-templates.json` - starter KPI definitions for real estate, SaaS,
  ecommerce, agencies/services, and legal/finance ops.
- `dashboard-spec.real-estate.json` - an illustrative dashboard specification for
  a real estate operator.
- `category-rules.json` - example user-defined resource categories such as
  personal, admin, work, financial, and coding.
- `business-events.redacted.jsonl` - fake, redacted business events that can be
  used as shape examples for `.gstack/data-layer/business-events.jsonl`.
- `cron-runs.redacted.jsonl` - fake scheduled run examples with start and finish
  timestamps for Gantt charts.
- `daily-report-spec.json` - an opt-in daily screenshot/report shape. It does
  not send data anywhere by itself.

## Local Usage

Copy only the shapes you need into your private project-local folder:

```text
.gstack/data-layer/
  business-events.jsonl
  cron-runs.jsonl
  category-rules.json
  metric-definitions.json
  dashboard-spec.json
```

Then run:

```bash
gstack-data-layer-export --window 30d --bucket day --project "local-project" --domain "real_estate"
```

The export writes dashboard-ready JSONL, JSON, CSV, and `dashboard.html` files under
`.gstack/data-layer/exports/<date>/`.

For daily resource management, a user-approved agent can open `dashboard.html`,
capture the Resource Overview, token chart, cron chart, category chart, and
Gantt-style cron timeline, then send the screenshot through a channel the user
explicitly configured. The data layer itself stays local-only.

Do not commit private `.gstack/data-layer/` files unless they have been reviewed
and sanitized.
