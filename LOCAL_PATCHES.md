# Local Patches — Triage & Upstream Plan

Living document. Every patch carried on top of `upstream/main` belongs here, with
a triage decision: **PR upstream**, **keep local (extension point)**, or **delete**.

Audit cadence: every upgrade (`/gstack-upgrade`). If a patch sits here for >30 days
without a PR filed or a justification, delete it or land it.

Last audit: 2026-05-23

---

## Patches that touch core / shared skills

### 1. `aff14a72` — `plan-eng-review`: Step 0.5 existing-capability check
- **Files:** `skills/plan-eng-review/SKILL.md`
- **What it does:** adds a 60-second pre-design check for plans touching gbrain / OpenClaw / Hermes substrates — surfaces existing integrations / launchd jobs before greenlighting new infra code.
- **Why it exists:** memory `feedback_probe_mini_integrations_first` — caught a 2,200-page redundant ingestion design 2026-05-20.
- **Triage: PR UPSTREAM.** Generalizes well — any operator with a substrate-style integration system benefits from a pre-build capability check. Likely fast review.
- **PR action:** open against `garrytan/gstack` titled `feat(plan-eng-review): Step 0.5 existing-capability check before substrate code`.
- **Owner:** Anoop
- **Status:** not yet filed

---

## Patches in extension points (never conflict)

None currently — gstack repo is clean in this regard.

---

## Rules for future patches

1. **Default to extension points.** Before touching `skills/<upstream-skill>/SKILL.md`, ask: can this be a *new* skill (`skills/my-skill/`) or a `references/` addition? Modifying upstream skills generates rebase conflicts every gstack-upgrade.

2. **If you must touch an upstream-skill SKILL.md, file the upstream PR within 7 days.** Carrying core-skill patches without upstreaming is interest-bearing debt.

3. **Don't commit scratch.** Local debugging files belong outside the repo or in `/scratch/` (gitignored).

4. **`/gstack-upgrade` is the canonical upgrade flow.** Don't hand-roll. If it breaks, fix the skill, not the workaround.
