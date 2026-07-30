# Legal Team Process

Every legal engagement at a company using AgentForce enterprise teams follows this process.
The goal is attorney-review-ready work product with a complete audit trail: the AI does the
drafting, analysis, and research end-to-end; humans review, decide, sign, and file. Nothing
leaves the building unreviewed, and nothing is ever executed by an agent.

## Overview

```
                    ┌──────────────────────────────────────────────────────┐
                    │                 /legal engagement                    │
                    └──────────────────────────────────────────────────────┘

 Foundation ──► Engagement modes (natural order) ──► Artifacts ──► Review PR ──► Execution
 ──────────     ────────────────────────────────     ─────────     ─────────     ─────────
 company +      --corporate  (entity is sound)       drafts,       humans +      officers
 legal          --ip         (company owns product)  memos,        attorney      sign, file,
 foundation     --paper      (sell on solid paper)   redlines,     review the    send, mail,
 docs           --review     (as contracts arrive)   audits        PR            calendar
                --employment-docs (as you hire)          │             │             │
                                                         ▼             ▼             ▼
                                              docs/enterprise/    PR approved   obligations
                                              legal/*-<date>.md   = released    tracked
```

## Phase 1 — Foundation

Two documents anchor every engagement:

- `docs/enterprise/foundation.md` — company foundation: product, stage, business model,
  target customer, geography and constraints.
- `docs/enterprise/legal/foundation.md` — legal foundation: exact entity name/type/state,
  existing contract templates and where signed agreements live, jurisdictions of customers
  and workers, counsel relationships and signature authority, equity/409A/83(b) state, and
  known legal debt.

The skill creates them via short interviews on first run and reads them on every run.
**Refresh rule:** if a foundation doc is more than 90 days old, the skill flags it and
offers a refresh. Entity changes, new jurisdictions, financings, and new products always
warrant an immediate refresh.

## Phase 2 — Engagements

| Mode | When to run it | What it produces | Prerequisite |
|------|----------------|------------------|--------------|
| `--corporate` | At formation; before any financing; quarterly hygiene | Hygiene audit, board consent drafts, data room index | None (run first) |
| `--ip` | Before financing/acquisition talks; after any contractor engagement; before naming/branding | Chain-of-title gap matrix + cure plan, OSS license inventory, trademark clearance memo | Entity exists (`--corporate`) |
| `--paper` | Before first sales deals; when self-serve launches; when templates are >1 year stale | NDA, MSA + Order Form, ToS, SLA, DPA drafts | Foundation; compliance data map recommended for the DPA |
| `--review` | Every time a counterparty sends a contract, or before signing anything | Review memo, redline issue list with paste-ready language, concession log entry, obligations calendar | Foundation (templates help but aren't required) |
| `--employment-docs` | Before each hire or contractor engagement | Offer letter, PIIA, contractor agreement drafts + classification memo | Entity + equity plan for option grants; `/people` owns the hiring process |

The natural order — corporate → ip → paper → review/employment as events demand — is
enforced softly: the skill warns and offers, never blocks.

**Shared ownership note:** the DPA is jointly owned with the compliance team. Compliance
owns the facts (data map, RoPA, subprocessor list); legal owns the contract document. DPA
annexes must reconcile with compliance artifacts before the DPA is sent to any customer.

## Phase 3 — Commit artifacts

All artifacts land in `docs/enterprise/legal/`:

```
docs/enterprise/legal/
  foundation.md
  INDEX.md                                  # one line per artifact: date, mode, link, gate
  CHECKLIST.md                              # standing human action checklist — grows over time
  concession-log.md                         # running negotiation precedent
  contract-review-acme-msa-2026-07-06.md    # dated artifacts
  msa-draft-2026-07-06.md
  ip-chain-of-title-audit-2026-07-06.md
  ...
```

Every human follow-up an engagement produces is appended to `CHECKLIST.md` (iron rule 4) —
a single living document ordered by execution/importance, not a fresh dated checklist per
engagement. Dated artifacts still hold the full analysis; the checklist lifts their action
items into one place.

The date in each filename and document header is the audit trail — it proves the work
happened and when. Do not remove or change these dates. Every artifact carries the
generation header (tool, date, mode, status, review gate) and the review-gate footer
(attorney review required; assumptions; jurisdiction flags; as-of date).

## Phase 4 — Human review & approval

Open a PR titled `docs: legal <mode> review package` containing the artifacts and INDEX
update.

**Review-gate legend:**

- `AI-final` — never used by the legal team. No legal artifact is AI-final.
- `Human review recommended` — internal memos, audits, checklists, scan reports, data room
  indexes. A founder's careful read suffices to act internally.
- `Licensed professional required (attorney)` — anything execution-bound or
  counterparty-facing: contracts, redlines to be sent, board consents, employment documents,
  trademark filings.

**The rule:** nothing externally binding — send, sign, file, or publish — happens until the
PR is approved AND the attorney gate (where marked) is satisfied. Merging the PR means "the
drafts are approved for the next step," not "the contract is executed."

## Phase 5 — External execution

The engagement's handoff summary ends with a human to-do checklist, and every item is
appended to the standing `docs/enterprise/legal/CHECKLIST.md` (iron rule 4) so it survives
past the current session. Typical items and where they execute:

- [ ] Attorney reviews gated artifacts (redlines, contracts, consents)
- [ ] Officer signs (e-signature platform) — agents never execute documents
- [ ] Send redline/response to the counterparty
- [ ] File: state filings, USPTO trademark application, 83(b) to the IRS (certified mail,
      keep proof)
- [ ] Publish: ToS/policies to the website with a real clickwrap acceptance flow
- [ ] Calendar: renewal notice windows, franchise tax (March 1), 409A refresh, Section 8/15
      trademark maintenance
- [ ] Store the signed agreement in the contract repository

Afterwards the team monitors: the obligations calendar (renewal/notice windows), the
concession log (template drift), foundation staleness, and any Tier 3 escalations awaiting
counsel.

## Operating cadence

- **Per event:** `--review` on every inbound contract; `--employment-docs` per hire.
- **Quarterly:** `--corporate` hygiene pass (ledger reconciliation, consent gaps, calendar
  check); concession log review for template drift.
- **Semi-annually:** `--ip` OSS rescan (dependency trees move); chain-of-title check for new
  contributors.
- **Annually or per financing:** full data room refresh; `--paper` template refresh against
  current market positions; foundation review.

## FAQ

**When do I actually need a human lawyer?**
For decisions, disputes, and signatures: any live dispute or termination, securities/tax
sign-off, court or agency filings (including patent work), and final review of anything you
will sign or send. The skill does the drafting and analysis so counsel's hours go to
judgment, not typing. Privilege only attaches with a lawyer — engage one BEFORE a dispute
heats up.

**Can I skip the review PR?**
Only for internal-only drafts (a checklist, a data room index you're filling in yourself).
Never for anything customer-, counterparty-, or authority-facing.

**Can I just sign the customer's paper to close the deal faster?**
Run `--review` first — it takes minutes. The failure mode this prevents is real: uncapped
liability accepted to close a quarter. Equally real: blowing a deal over a clause that's
market. The memo tells you which fight you're in.

**The AI drafted our MSA. Is it legally binding once we sign it?**
A signed contract binds regardless of who drafted it — which is exactly why the attorney
gate exists. The draft is work product for counsel review, not advice that it's safe to sign.

**Our contractor from two years ago never signed anything. Is it too late?**
No — run `--ip`, which drafts a confirmatory assignment for each gap. It IS too late once
you're mid-diligence and the contractor is hostile. Cure gaps while relationships are warm.

**Do we need all five contract stack documents?**
Sales-led B2B: NDA, MSA + Order Form, SLA, DPA. Self-serve: ToS (+ DPA if processing
customer personal data). The skill recommends the right subset from your foundation — don't
paper documents you won't use; stale templates are their own liability.
