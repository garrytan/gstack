# Enterprise Team Processes

One process document per team — the enterprise analogue of a development process doc
(discovery → artifacts → review PR → execution), adapted to each business domain.

The **company-level** process — which order to run the teams for a new product, what a
single-team engagement looks like, the change-propagation matrix, and what triggers a
board pass — lives one level up in [../PROCESS.md](../PROCESS.md). This directory is the
per-team detail beneath it.

Every process shares the same skeleton:

```
Foundation docs → Engagement modes (natural order) → Dated artifacts in docs/enterprise/<team>/
        → Human follow-ups appended to docs/enterprise/<team>/CHECKLIST.md
        → Human review PR ("docs: <team> <mode> review package") → External execution → Cadence
```

And the same four iron rules:

1. **Dated artifacts are the audit trail.** Every artifact filename and header carries the
   date it was produced. Do not remove or change these dates — they prove what was known and
   reviewed, and when.
2. **Nothing externally binding ships before the review PR is approved.** Drafts can iterate
   freely on a branch; sending, signing, filing, or publishing anything customer- or
   authority-facing waits for human approval of the review package.
3. **Review gates are explicit.** Every artifact is classified `AI-final`,
   `Human review recommended`, or `Licensed professional required (attorney / CPA / broker /
   auditor)` — and the classification is printed on the artifact itself.
4. **Human follow-ups live in one standing checklist per team.** Every human action item an
   engagement produces goes into a single living document, `docs/enterprise/<team>/CHECKLIST.md`
   — never buried in a dated artifact and never left only in chat. The document grows over
   time: new engagements append to it, categories are added as needed, and items are ordered
   by execution/importance (what gates what, what is time-critical, what is deferred). Dated
   artifacts still hold the full analysis; the checklist is the execution layer that lifts
   their action items into one place and points back to them, so nothing is lost when an
   artifact scrolls out of view. Check items off in place as they complete — the closed items
   are part of the audit trail. Each engagement adds a dated `## Changelog` entry listing the
   items it introduced, carrying an `af-manual-action` marker so the planner opens one issue
   for just the new items. Exact shape: the Action Checklist convention in [../PROCESS.md](../PROCESS.md).

| Process | Team skill |
|---------|-----------|
| [strategy.md](strategy.md) | `/strategy` |
| [marketing.md](marketing.md) | `/marketing` |
| [sales.md](sales.md) | `/sales` |
| [legal.md](legal.md) | `/legal` |
| [compliance.md](compliance.md) | `/compliance` |
| [finance.md](finance.md) | `/finance` |
| [people.md](people.md) | `/people` |
| [customer-success.md](customer-success.md) | `/customer-success` |
| [bizops.md](bizops.md) | `/bizops` |
| [deployment.md](deployment.md) | `/deployment` |

`/exec-review` has no process doc of its own: it is the review gate the other processes call
for cross-domain plans, and the natural final step before a review PR is opened.
