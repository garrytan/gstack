---
name: go-to-market
description: |
  Go-to-market skills — positioning, messaging, deal qualification, proposals,
  and marketing operations.
  Covers: gtm-messaging (positioning frameworks, value props, campaign briefs),
  deal-qualify (MEDDIC/BANT qualification, account planning, deal strategy),
  proposal-write (RFP responses, executive summaries, pricing narratives),
  marketing (content creation, campaign planning, performance reporting, GP-branded
  landing pages).
  Use when preparing sales materials, positioning a product, qualifying deals,
  responding to RFPs, planning campaigns, or building marketing content.
  Trigger: "GTM", "positioning", "sales materials", "deal qualify", "write a proposal", "marketing campaign".
allowed-tools:
  - Bash
---

# /go-to-market — Sales & Marketing Meta-Skill

Dispatches to the correct sub-skill based on what the user needs.

## Detect Command

| Input | Sub-skill | Action |
|-------|-----------|--------|
| `/go-to-market gtm-messaging` or positioning/messaging/value-prop | gtm-messaging | Load gtm-messaging |
| `/go-to-market deal-qualify` or qualify/MEDDIC/deal/account-plan | deal-qualify | Load deal-qualify |
| `/go-to-market proposal-write` or RFP/proposal/exec-summary | proposal-write | Load proposal-write |
| `/go-to-market marketing` or content/campaign/landing-page/marketing-report | marketing | Load marketing |

## Load Sub-Skill

Read the requested sub-skill and follow its instructions:

```bash
cat ~/.copilot/skills/go-to-market/{sub-skill}/SKILL.md
```

## Available Sub-Skills

- **gtm-messaging** — Positioning frameworks, messaging hierarchies, value propositions, campaign briefs
- **deal-qualify** — MEDDIC/BANT deal qualification, account planning, deal strategy, pitch prep
- **proposal-write** — RFP responses, executive summaries, pricing narratives, proposal structure
- **marketing** — Content creation, campaign planning, performance reporting, GP-branded landing pages
