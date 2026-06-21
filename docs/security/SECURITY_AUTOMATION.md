# AMMOR Fraud Intelligence Security Automation

## Purpose

This folder defines the GitHub security automation used for every pull request:

- scan for leaked secrets, API keys, tokens, and credentials
- scan dependencies for vulnerabilities
- upload evidence to GitHub Security
- enforce compliance and RBAC checks
- preserve chain-of-custody records for audit review
- publish risk assessment and a vulnerability dashboard

## Workflow set

- `.github/workflows/security-workflow.yml`
  Scans are executed on each pull request:
  - `gitleaks` for secret scanning
  - `trivy` for dependency scanning
  - `codeql` for source security analysis
  - creates `security-summary.json` and `security-summary.md`

- `.github/workflows/compliance-workflow.yml`
  Runs whenever Security Workflow completes and validates:
  - RBAC / workflow permission posture
  - required security documentation and config files
  - evidence and chain-of-custody integrity
  - creates `risk-assessment-report.md`, `vulnerability-dashboard.md`, and chain entries

## Evidence artifacts

- Artifact name: `security-automation-report`
  Contains scan findings + summary for the run.
- Artifact name: `compliance-report-<run-id>`
  Contains chain record, compliance JSON, dashboard, and risk report.
- Compliance gate threshold: PRs fail in `compliance-workflow` when
  `risk.score` is greater than `COMPLIANCE_RISK_THRESHOLD` (default `25`).
  You can tune this threshold via repository variable `COMPLIANCE_RISK_THRESHOLD`.

## Repository controls enabled

- Dependabot config: `.github/dependabot.yml`
- GitHub policy documentation: `.github/SECURITY.md`
- Baseline evidence chain: `.github/security/chain-latest.json`
- PR comment automation: auto updates one compliance report comment

## How to review a run

1. Open the **Security Workflow** run and check `security-summary.md`.
2. Open the **Compliance Workflow** artifact and read:
   - `vulnerability-dashboard.md`
   - `risk-assessment-report.md`
   - `chain-entry.json`
3. Verify compliance audit hash integrity in the risk report and confirm chain continuity.
4. Check PR comment on the source PR for gate status and actionable findings.

## Optional hardening

- Set a branch rule requiring:
  - `Security Workflow`
  - `Compliance Workflow`
- Raise or lower `COMPLIANCE_RISK_THRESHOLD` in workflow if your governance model changes.

## Planned follow-ups

- Replace `codeql` language list if this repo adds other languages.
- Extend dependency scanning to include container/OS package scope if containerized workloads are added.
- Add release-branch-only enforcement for branch protection checks once org-level policy is ready.
- Trigger all three safety families from **Actions → AMMOR Safety Gate Runner** (security + testing + deployment) to reproduce a full PR-gate artifact run outside PR timing.
- Keep `AMMOR_ROADMAP_PROJECT_ID` and optional `AMMOR_ROADMAP_TOKEN` set only if project sync is enabled via `.github/ammor-roadmap-automation.json`.
