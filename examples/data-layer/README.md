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
- `business-events.redacted.jsonl` - fake, redacted business events that can be
  used as shape examples for `.gstack/data-layer/business-events.jsonl`.

## Local Usage

Copy only the shapes you need into your private project-local folder:

```text
.gstack/data-layer/
  business-events.jsonl
  metric-definitions.json
  dashboard-spec.json
```

Then run:

```bash
gstack-data-layer-export --window 30d --project "local-project" --domain "real_estate"
```

The export writes dashboard-ready JSONL, JSON, and CSV files under
`.gstack/data-layer/exports/<date>/`.

Do not commit private `.gstack/data-layer/` files unless they have been reviewed
and sanitized.
