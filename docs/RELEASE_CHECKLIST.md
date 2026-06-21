# AMMOR Release Checklist

## Pre-merge checks

- [ ] Security workflow passes on PR.
- [ ] Compliance workflow reports risk within acceptable threshold.
- [ ] `bun test` passes.
- [ ] AMMOR product flow test artifacts (`qa-artifacts/ammor-product-tests/*`) generated when AMMOR workspaces exist.
- [ ] AMMOR product workspaces have required scripts before merge: `test:claims`, `test:cases`, `test:api`, `test:ai`, `test:dashboard`, `test:e2e`.
- [ ] AMMOR UX/accessibility artifacts (`qa-artifacts/ammor-product-tests/*-ux-gates.*`) present when `AMMOR_RUN_UX_GATES` is enabled.
- [ ] UX checks include visual and accessibility scripts, including `test:visual` and `test:a11y` or `test:wcag`.
- [ ] Required PR template items completed.
- [ ] Chain-of-custody evidence files present and hash-verified.
- [ ] Release notes and changelog impact identified.

## Mandatory one-time safety-gate validation (post-setup)

- [ ] Configure repository variables/secrets:
  - `AMMOR_RUN_AUDIT_TESTS` (optional)
  - `AMMOR_ENFORCE_PRODUCT_TEST_SCRIPTS`
  - `AMMOR_ENFORCE_UX_TEST_SCRIPTS`
  - `AMMOR_RUN_UX_GATES`
  - `AMMOR_UX_BASE_URL` (if UX gates enabled)
  - `COMPLIANCE_RISK_THRESHOLD`
- [ ] Run **Actions → AMMOR Safety Gate Runner** on `main`.
- [ ] Collect and verify artifacts:
  - `security-artifacts/security-summary.*`
  - `compliance-artifacts/risk-assessment-report.*`
  - `qa-artifacts/ammor-testing-aggregate.*`
  - `deployment-safety-artifacts/deployment-safety.*`
- [ ] Confirm roadmap sync inputs are configured (`AMMOR_ROADMAP_PROJECT_ID` and `AMMOR_ROADMAP_TOKEN`) before closing the first post-change milestone.

## Deployment readiness

- [ ] Environment manifests reviewed for Railway/Vercel/Supabase targets.
- [ ] Required secrets and non-secret configuration variables confirmed in deployment platform.
- [ ] Database migration plan approved and scoped (no destructive statements).
- [ ] Rollback plan written with validation command sequence.
- [ ] Incident response lead and on-call owner assigned.
- [ ] Product readiness sign-off from Security, QA, and Product owners.

## Post-deployment checks

- [ ] Smoke flows pass in preview.
- [ ] Health endpoint responds with expected status.
- [ ] Evidence upload workflow returns expected hash and immutable record.
- [ ] AI analysis queue transitions AI Analyze -> Human Review correctly.
- [ ] Audit log stream includes action, actor, and commit id for critical actions.
- [ ] Dashboard rendering and responsiveness verified in at least two screen sizes.

## Rollback plan

- Revert the deployment through platform controls.
- Re-run last known-good deployment workflow.
- Validate rollback by checking evidence hashes in `chain-latest.json`.
- Record outcome in release notes and incident tracker.
