# GitHub Skills and Automation Roadmap for AMMOR Intelligence Group

## Scope

AMMOR Intelligence Group needs a GitHub operating model that supports:
- fraud-intel evidence integrity
- government and insurance compliance readiness
- fast safe delivery on claims/cases AI workflows
- clean PR/release governance for enterprise trust

## Learned skill categories and priority ranking

| # | GitHub skill / category | Why this helps AMMOR | Value |
| --- | --- | --- | --- |
| 1 | GitHub Advanced Security (code scanning + alerting) | Centralizes vulnerability findings and ties findings to audit evidence for regulator review | Critical |
| 2 | CodeQL scanning | Detects high-impact bugs in auth, input handling, and data flow before code ships | Critical |
| 3 | Secret scanning (GitHub + repo tooling) | Prevents leaked API tokens or government credentials from entering history | Critical |
| 4 | Dependency scanning (Trivy + Dependabot alerts) | Reduces supply-chain risk for model clients, browser drivers, and infra tooling | High |
| 5 | Dependabot updates and security PRs | Keeps dependency risk current, with a repeatable patch cadence | High |
| 6 | GitHub Actions security workflows on PR | Forces security checks before merge and creates immutable evidence artifacts | Critical |
| 7 | Compliance workflow gate (automated risk score) | Converts scan outcomes into enforceable merge decisions with audit evidence | High |
| 8 | Chain-of-custody checks in CI artifacts | Preserves integrity evidence of every assessment run for investigations | High |
| 9 | Permission hardening in workflow YAML | Prevents accidental use of overly broad credentials during scans and deploys | Critical |
| 10 | Repository and workflow audit-log validation | Supports forensic review for incident response and SOC-style workflows | High |
| 11 | Dependabot security alerts + alerts workflow | Surfaces external advisories quickly, lowers exposure window | High |
| 12 | Mandatory PR templates + issue templates | Improves triage quality and repeatable defect documentation | High |
| 13 | Milestones + labels + roadmap board discipline | Keeps claims, evidence, AI pipeline, and portal work visible by quarter | Medium |
| 14 | GitHub Projects / roadmap automation | Gives executive and compliance teams a single source of status | Medium |
| 15 | GitHub Actions CI (unit + e2e + audit jobs) | Catches regressions across policy checks, service code, and toolchain changes | Critical |
| 16 | Frontend quality checks (responsive/accessibility snapshots) in CI | Prevents broken user evidence flows and dashboard UX defects in demo environments | High |
| 17 | Visual regression checks (screenshot diff) in CI | Detects accidental UI breakage that can disrupt claim review workflows | Medium |
| 18 | Automated API smoke tests in CI | Verifies evidence upload, case actions, and audit endpoints are stable | High |
| 19 | Login/auth integration test coverage in CI | Ensures entitlement checks and role protections stay intact | High |
| 20 | Human/AI handoff workflow tests | Validates queue transitions from AI analyze -> human review | High |
| 21 | Release automation and release checklist | Standardizes deployment readiness and rollback readiness | High |
| 22 | Deploy safety checks (env validation, migration checks, rollback artifacts) | Reduces deployment blast radius and post-deploy recovery time | Critical |
| 23 | Copilot/Codex instructions + safe-task rules | Ensures future agents follow non-negotiable platform safety constraints | Critical |
| 24 | Automated compliance documentation generation | Keeps risk reports, access-control evidence, and change history current | High |
| 25 | Community health files (CONTRIBUTING + docs paths) | Improves onboarding and contribution quality for enterprise-ready teams | Medium |

## Why these skills match AMMOR

- Fraud intelligence platforms must prove control maturity, not only function.
- Enterprise procurement evaluates evidence trails, not developer intent.
- Government customers require stronger proof of process than feature correctness.
- Super-admin and evidence flows require stricter gatekeeping than ordinary SaaS projects.

## Implemented now (Critical + High)

- `.github/workflows/security-workflow.yml` for pull-request scanning and artifact generation.
- `.github/workflows/compliance-workflow.yml` for risk scoring and PR gating.
- `.github/workflows/testing-workflow.yml` for required automated testing on PRs.
- `.github/workflows/deployment-safety-workflow.yml` for deployment preflight checks.
- `.github/dependabot.yml` (existing, retained and aligned).
- `.github/SECURITY.md`, `.github/security/chain-latest.json` evidence ledger support.
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `scripts/security/security-summary.mjs`
- `scripts/security/compliance-audit.mjs`
- `scripts/deployment/deployment-safety.mjs`
- `docs/github-skills-roadmap-for-ammor.md`
- `docs/github-skills*` and workflow guide docs (security/compliance/deployment/testing/setup)
- `docs/RELEASE_CHECKLIST.md`
- `.github/copilot-instructions.md`
- `CLAUDE.md` updates for AMMOR non-negotiable rules

## Roadmap for remaining medium tasks

1. Add screenshot-diff or visual regression tooling (Percy, Playwright trace comparison, or `playwright` visual mode).
2. Add explicit dashboard/responsive/accessibility tests for `drag-and-drop`, evidence upload, and portal transitions.
3. Add GitHub Project board migration for issue automation and roadmap burn-down.
4. Add deployment provider-specific checks for Railway, Vercel, and Supabase release hooks.
5. Add periodic compliance replay job against previous chain entries (quarterly evidence drift checks).

## How this ties to security + compliance deliverables

- Critical path starts on PR open.
- Security/compliance evidence is emitted every PR in workflow artifacts and PR comments.
- Testing and deployment safety run before merge and before release gates.
- Human review can now verify risk, evidence, and test outcomes in one pass.
