# Pack System

> Role-based skill bundles for GPN-Skillz

---

## Overview

The pack system lets different teams install only the skills they need. Each pack is a YAML manifest in the `packs/` directory that lists skills and can include other packs.

## Available Packs

| Pack | Skills | Best For |
|------|--------|----------|
| **core** | braindump, memory, flow, session-learn, skill-forge, eval | Everyone |
| **product** | core + product-manager, roadmap-plan, business-case, customer-research, office-hours, plan-ceo-review, competitor-teardowns, fin-model | Product Managers |
| **engineering** | core + deliver, plan, investigate, incident-response, careful, checkpoint | Engineers |
| **web-quality** | design-review, web-quality-audit, performance, accessibility, seo, core-web-vitals, best-practices | Front-end / Design |
| **sales** | core + go-to-market (gtm-messaging, deal-qualify, proposal-write) | Sales Teams |
| **sales-operations** | sales + revenue-ops (sales-ops) | Sales Ops |
| **customer-operations** | core + ops (launch-readiness, merchant-onboarding, support-ops), customer-success | Customer Ops |
| **risk** | core + risk-ops (operational-risk, fraud-ops, collections, credit-risk) | Risk Teams |
| **credit-risk** | core + risk-ops/credit-risk, risk-ops/collections | Credit Risk |
| **fraud-ops** | core + risk-ops/fraud-ops | Fraud Analysts |
| **legal** | core + contract-review, privacy, governance | Legal / Procurement |
| **full** | All packs combined | Power users / maintainers |

## Installation

```bash
cd ~/.copilot/skills   # or wherever you cloned GPN-Skillz
python3 install.py --pack sales
```

This copies only the skills in the `sales` pack (and its included packs like `core`) to your skills directory and generates a lean `copilot-instructions.md`.

## Creating Custom Packs

Create a YAML file in `packs/`:

```yaml
name: my-team
description: Skills for my team
includes:
  - core
  - product
skills:
  - contract-review
```

See [packs/README.md](https://github.com/conor-redmond_glpay/GPN-Skillz/blob/main/packs/README.md) for full documentation.
