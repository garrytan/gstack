# AMMOR Developer Setup Guide

## Requirements

- Bun 1.0+
- Git, Node optional for editor tooling
- Access to required eval keys for full AI-powered test tiers

## One-time setup

- Clone the repo and run `bun install`.
- Copy `.env.example` to `.env` and fill local-only test keys.
- Configure your branch naming so PR titles remain searchable.
- Confirm write access to workflow artifacts and security checks.

## Mandatory development defaults

- Prefer PR-first changes for security, workflows, and evidence modules.
- Never hardcode secrets in files.
- Use task-specific branches to keep change history readable.

## Runbook for this repository

- `bun test` before every commit.
- `bun run test:audit` on security-sensitive edits.
- Security scan and compliance changes should be validated against existing workflow reports.

## Local validation expectations

- If you touch workflow files, run a documentation pass against:
  - `.github/workflows/security-workflow.yml`
  - `.github/workflows/compliance-workflow.yml`
  - `.github/workflows/testing-workflow.yml`
  - `.github/workflows/deployment-safety-workflow.yml`
- Confirm no template files are missing:
  - `.github/PULL_REQUEST_TEMPLATE.md`
  - `.github/ISSUE_TEMPLATE/bug_report.md`
  - `.github/ISSUE_TEMPLATE/feature_request.md`
- Verify evidence docs are present:
  - `docs/RELEASE_CHECKLIST.md`
  - `docs/github-skills-roadmap-for-ammor.md`
  - `docs/compliance-guide.md`
  - `docs/deployment-guide.md`

## Required repository variables and secrets for AMMOR safety automation

- `AMMOR_RUN_UX_GATES` (`true`/`false`) — enable portal visual and accessibility jobs.
- `AMMOR_UX_BASE_URL` — optional base URL for UX checks.
- `AMMOR_ENFORCE_PRODUCT_TEST_SCRIPTS` (`true`/`false`) — fail PR if required AMMOR product scripts are missing in discovered workspace.
- `AMMOR_ENFORCE_UX_TEST_SCRIPTS` (`true`/`false`) — fail PR if required visual/a11y UX scripts are missing in discovered workspace.
- `AMMOR_RUN_AUDIT_TESTS` (`true`/`false`) — enable security-focused audit tests in the testing workflow.
- `COMPLIANCE_RISK_THRESHOLD` — optional integer threshold for PR gate pass/fail decisions.
- `AMMOR_ROADMAP_PROJECT_ID` — optional GitHub Project V2 node ID for roadmap automation.
- `AMMOR_ROADMAP_TOKEN` — optional secret for project synchronization.
- `AMMOR_ROADMAP_STATUS_FIELD_ID` — optional project status field id.
