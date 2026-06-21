# AMMOR Security Guide

## Core controls

- GitHub Advanced Security for PR scans.
- Gitleaks secret scan.
- Trivy dependency scan.
- CodeQL static analysis.

## Workflow and evidence

- Security workflow runs on every pull request.
- Compliance workflow runs after security workflow and scores risk.
- `security-artifacts/security-summary.md` and `vulnerability-dashboard.md` are baseline evidence outputs.
- `compliance-artifacts/risk-assessment-report.md` is the compliance decision artifact.

## Operational rules

- Do not approve PRs with unresolved critical findings.
- Keep chain-of-custody files append-only and verify checksums.
- Never remove high-risk findings from historical records.

## Reviewer checklist

- Secret scan findings present and zero for exposed secrets.
- Dependency scan risk and status recorded.
- RBAC workflow permissions unchanged and least-privilege.
- Audit log integrity checks passed.
