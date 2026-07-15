# OpenClaw ported skill index

## Product / planning
- `gstack-office-hours` — YC-style startup and product diagnostic
- `gstack-plan-ceo-review` — product/narrative review
- `gstack-plan-eng-review` — engineering plan review

## Review / debugging / security
- `gstack-review` — pre-ship review
- `gstack-investigate` — root-cause debugging
- `gstack-cso` — security review
- `gstack-codex` — independent coding-agent second opinion

## QA / design
- `gstack-qa` — test, fix, re-verify
- `gstack-qa-only` — report-only QA
- `gstack-design-review` — visual/interaction audit
- `gstack-design-consultation` — design direction and system planning
- `gstack-setup-browser-cookies` — authenticated browser setup guidance

## Shipping / deploy / docs
- `gstack-ship` — pre-merge branch hardening
- `gstack-land-and-deploy` — merge + deploy + verify
- `gstack-canary` — immediate post-deploy smoke verification
- `gstack-setup-deploy` — discover and document deploy context
- `gstack-document-release` — update docs after shipping

## Safety / scope control
- `gstack-careful` — caution before destructive actions
- `gstack-freeze` — restrict edits to a declared area
- `gstack-guard` — combine careful + freeze
- `gstack-unfreeze` — remove or widen the declared boundary

## Reflection
- `gstack-retro` — retrospective over a sprint/release/work window

## What remains intentionally incomplete
These ports preserve role and workflow value, not full runtime parity with Claude Code. In particular:
- no Claude hook enforcement for safety modes
- no generated-skill pipeline for OpenClaw variants yet
- no automatic cookie import or gstack browse daemon parity
