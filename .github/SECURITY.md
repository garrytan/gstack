# Security Policy

AMMOR Intelligence Group and this repository rely on GitHub-native security controls, plus repository automation built in this stack, to keep fraud-intelligence and platform code in a hardened state.

## Supported Versions

This policy applies to all supported branches in this repository.

If you discover a security issue, report it privately before public disclosure.

## Reporting Security Issues

- Start with a direct incident entry in the pull request or internal security channel.
- Include reproduction steps, affected scope, and evidence artifacts.
- Do not include production credentials, account data, or live database extracts in reports.

## What We Monitor

- Secret and credential leakage (repo scanning, logs, issue/PR descriptions)
- Dependency and package supply-chain vulnerabilities
- Access control policy deviations in workflow automation
- Security event integrity and evidence-chain continuity

## Security Tooling in This Repository

- GitHub Advanced Security (Code Scanning / Dependabot Alerts)
- Gitleaks secret scanning
- Trivy vulnerability scanning
- Dependency update automation
- PR comment-based compliance reporting
- PR-triggered testing workflow (`testing-workflow.yml`)
- Deployment safety workflow (`deployment-safety-workflow.yml`)
- Release checklist governance (`docs/RELEASE_CHECKLIST.md`)
