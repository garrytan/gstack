# sahlstack Fork Changelog

Fork-only releases of [Sahlwaredev/sahlstack](https://github.com/Sahlwaredev/sahlstack)
(Sahlware's fork of gstack). Fork releases bump the **4th version digit** on top of the
current upstream base (`<upstream X.Y.Z>.<fork build>`), so upstream's own
`X.Y.Z.0` releases never collide. Upstream changes stay in the root `CHANGELOG.md`;
fork changes are logged here to keep upstream merges clean.

## v1.58.5.5 — 2026-07-30

- **Action Checklist convention → standing checklist (supersedes v1.58.5.3):** human to-do
  items now live in ONE living `docs/enterprise/<team>/CHECKLIST.md` per team (categorized,
  ordered by execution/importance, checked off in place) instead of a new dated
  `action-checklist-<slug>-<YYYY-MM-DD>.md` per engagement. Each engagement APPENDS its items
  and adds a dated `## Changelog` entry carrying an `<!-- af-manual-action -->` marker, so the
  planner opens one issue for just the newly introduced items (deduped on the changelog date).
  Updated `enterprise/PROCESS.md`, the company-copy iron rule #4
  (`docs/agentforce/ENTERPRISE_PROCESS.md`), `enterprise/processes/README.md` + `legal.md`,
  and Phase 6 of all ten team skills + `/enterprise` + `/enterprise-autoplan`. Reference
  model: `docs/enterprise/legal/CHECKLIST.md`.

## v1.58.5.3 — 2026-07-15

- **Action Checklist convention (all enterprise teams):** every team engagement now writes
  its human to-do items to a dedicated, dated **checklist file**
  (`docs/enterprise/<team>/action-checklist-<slug>-<YYYY-MM-DD>.md`) that the user checks off
  as they progress — never buried in an artifact footer or left only in chat. Each file
  carries the standard header, an `<!-- af-manual-action -->` marker block (so the planner
  opens a correctly-tagged `af-manual-action` + `af-manager-review` issue pointing at the
  file), a "How to use this" line, and ordered `- [ ]` steps with time estimates + blocking
  markers. The printed handoff becomes a short pointer to the file. Threshold: 3+ human items.
  Canonical convention added to `enterprise/PROCESS.md`; Phase 6 updated in all ten team
  `SKILL.md.tmpl` (legal, marketing, sales, compliance, finance, people, bizops, strategy,
  deployment, customer-success), plus the `/enterprise` front door and `/enterprise-autoplan`
  validation. Requested by the founder after the legal `--ip` and SahlWorks naming engagements.

## v1.58.5.2 — 2026-07-12

- **Deployment team** (`/deployment`, `enterprise-deployment/`): tenth enterprise team —
  Kenji (Release Manager), Astrid (Platform & Infrastructure), Ravi (CI/CD), Imani (SRE),
  with Bram (Release Engineering Consultant) as the adversarial reviewer and new
  `/exec-review` board seat. Four modes: `--design` (greenfield stack dialog with dated
  cost math, environment topology, branching, dev→test→beta→prod promotion with blocking
  human approval gates), `--audit` (document + customer-verify an existing pipeline, DORA
  scoring, improvement roadmap, finalized plan), `--readiness` (three-layer per-release
  gate routing to marketing/legal/compliance/CS), `--runbook` (deploy/rollback/incident).
  Hard reuse boundary: binds `/setup-deploy`, `/ship`, `/land-and-deploy`, `/canary`,
  `/qa`, `/cso` into the plan of record rather than duplicating them. Wired into
  `/enterprise` (front door + routing), `enterprise/PROCESS.md` (bootstrap Phase 5,
  stage calibration, two new propagation rows, quarterly audit cadence),
  `enterprise/processes/deployment.md`, `PERSONAS.md`, and `/enterprise-autoplan`
  (activation phase). The plan of record is consumed by the agentforce repo's
  Company-tier `sahl-deploy-manager` workflow (gated, off by default).

## v1.58.5.1 — 2026-07-06

- **Fork identity:** version checks and upgrades now track `Sahlwaredev/sahlstack`
  instead of upstream gstack — `bin/gstack-update-check` (remote VERSION + SHA URLs),
  `/gstack-upgrade` (fresh-clone URL), and `bin/gstack-team-init` (team onboarding
  clone instructions). Without this, an auto-upgrade would have replaced a sahlstack
  install with upstream gstack and dropped the enterprise skills.
- **AgentForce enterprise team suite** (first shipped in `5b766d4`, on the v1.58.5.0
  base): nine business-team skills (`/strategy`, `/marketing`, `/sales`, `/legal`,
  `/compliance`, `/finance`, `/people`, `/customer-success`, `/bizops`), the
  `/exec-review` board pass, the `/enterprise` front door, `/enterprise-autoplan`,
  per-team process docs, and the company-level `enterprise/PROCESS.md`.
