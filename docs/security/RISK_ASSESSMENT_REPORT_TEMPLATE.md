# Risk Assessment Report Template

## Executive summary

- Run ID:
- Pull Request:
- Generated:
- Reviewer:

## Risk posture

- Overall risk score: `/100`
- Risk level: `low | medium | high | critical`
- Security status:

## Control matrix

| Control | Status | Evidence | Remediation |
| --- | --- | --- | --- |
| Secret scan | Pass / Fail | gitleaks.sarif | |
| Dependency scan | Pass / Fail | trivy.sarif | |
| CodeQL | Pass / Fail | GitHub Security Alerts | |
| RBAC workflow permissions | Pass / Fail | compliance report | |
| Audit logging integrity | Pass / Fail | chain-entry.json | |

## Violations

- (populate from generated compliance report)

## Residual risk and decisions

- Explain any accepted risks for this PR.

## Evidence and chain-of-custody

- Previous chain hash:
- Current chain hash:
- Evidence files hashed:
  - `security-summary.json`
  - `security-summary.md`
  - `gitleaks.sarif`
  - `trivy.sarif`
