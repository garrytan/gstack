# AMMOR GitHub + Agent Instructions

## Non-negotiable safety rules

- Never modify credentials, service API keys, login providers, or auth grants.
- Never remove or disable the super admin account.
- Never reset production database data or drop schema/data in migration scripts.
- Never delete production data assets.
- Never replace brand names or branding visuals.
- Never run destructive SQL against production without explicit incident-response approval.
- Do not mark work complete while required tests have not passed.

## Workflow guardrails

- Run `bun test` before considering a change complete.
- For security-sensitive changes, validate with `bun run test:audit` and the compliance workflow evidence.
- Keep PR and issue references in scope; do not mix unrelated platform, deployment, and security edits in one PR unless explicitly related.
- For every PR change to auth, evidence, or workflow files, document:
  - what changed,
  - what tests were run,
  - why risk posture improved or remained unchanged.

## AMMOR operating model

- Security and compliance workflows must stay PR-first and evidence-first.
- Prefer additive changes over rewrites unless there is a clear correctness reason.
- If a workflow file changes, keep permissions scoped to least-privilege and record rationale.
- Maintain audit artifacts, chain metadata, and dashboard outputs when possible.

## Safe task prompt template

When asking for assistance, include:
- target system area (claims, cases, evidence, dashboard, AI analysis, deploy),
- expected risk level,
- exact evidence command to run,
- acceptance condition.
