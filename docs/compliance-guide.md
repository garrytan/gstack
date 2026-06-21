# AMMOR Compliance Guide

## Scope

AMMOR operations align to enterprise and government workflows requiring clear evidence and process control:
- Access control and role separation.
- Change history and artifact preservation.
- Incident traceability.
- Data handling restrictions.

## Evidence chain

- Use generated compliance reports as primary evidence.
- Keep `docs/` and `.github/security/chain-latest.json` updated by automation.
- Preserve old chain snapshots when evidence changes.

## Evidence workflows

- Security workflow artifacts: `security-artifacts` from `.github/workflows/security-workflow.yml`.
- Compliance workflow artifacts: `risk-assessment-report`, `vulnerability-dashboard`, `chain-entry.json`, and `chain-state.json` from `.github/workflows/compliance-workflow.yml`.
- Deployment safety artifacts: `deployment-safety` bundle from `.github/workflows/deployment-safety-workflow.yml`.
- Testing artifacts: `qa-artifacts` from `.github/workflows/testing-workflow.yml` including product tests and portal UX checks.
- One-click dispatch: `.github/workflows/ammor-safety-gate-runner.yml` (Security + Testing + Deployment Safety).

## Required review records

- Risk score and threshold result.
- Deployment safety status.
- Test evidence and security audit status.
- Rollback readiness confirmation.

## Cadence

- Security-compliance runs each PR.
- Quarterly deep evidence replay is recommended for governance attestations.

## Roadmap tracking automation

- Use `.github/ammor-roadmap-automation.json` for milestone + optional project mapping.
- Workflow: `.github/workflows/ammor-roadmap-automation.yml` keeps issue/PR tracking aligned automatically by label.
