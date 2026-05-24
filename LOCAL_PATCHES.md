# Local Patches — Triage

Living document. Every patch carried on top of `upstream/main` belongs here, with
a triage decision: **carry on our main**, **move to extension point**, or **delete**.

`anoopkansupada/gstack` is our canonical repo. `upstream` (garrytan/gstack) is
read-only — we pull, never push. The default action for any local patch is to
carry it on our main indefinitely; upstreaming is opt-in only when Anoop says so.

Audit cadence: every `/gstack-upgrade`.

Last audit: 2026-05-23

---

## Patches that touch core / shared skills

### 1. `aff14a72` — `plan-eng-review`: Step 0.5 existing-capability check
- **Files:** `skills/plan-eng-review/SKILL.md`
- **What it does:** 60-second pre-design check for plans touching gbrain / OpenClaw / Hermes substrates — surfaces existing integrations / launchd jobs before greenlighting new infra code.
- **Why it exists:** memory `feedback_probe_mini_integrations_first` — caught a 2,200-page redundant ingestion design 2026-05-20.
- **Triage: CARRY.** Operationally valuable for Anoop's substrate-heavy workflow; conflict cost low (single-file skill prose addition).

---

## Patches in extension points (never conflict)

None currently.

---

## Rules for future patches

1. **Default to extension points.** Before touching `skills/<upstream-skill>/SKILL.md`, ask: can this be a *new* skill (`skills/my-skill/`) or a `references/` addition? Modifying upstream skills generates rebase conflicts every `/gstack-upgrade`.

2. **Don't commit scratch.** Local debugging files belong outside the repo.

3. **`/gstack-upgrade` is the canonical upgrade flow.** Don't hand-roll. If it breaks, fix the skill.

4. **Our fork is canonical.** Push to `origin` (= anoopkansupada/gstack). `upstream` (garrytan) is read-only — we pull, never push. Don't propose upstream PRs unless Anoop asks.
