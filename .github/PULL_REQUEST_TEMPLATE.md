# AMMOR Pull Request

## Summary

- What changed:
- Why it helps AMMOR:
- Ticket / issue link:

## Risk and compliance checks

- [ ] `bun test`
- [ ] `bun run test:audit` (if changed)
- [ ] `security-workflow` compatible changes reviewed
- [ ] `docs/security/SECURITY_AUTOMATION.md` updates included (if changed)
- [ ] Chain-of-custody evidence preserved (security summary and compliance files not edited manually)

## Security and data constraints

- [ ] No login credentials changed.
- [ ] No authentication providers changed.
- [ ] No production database data reset or deleted.
- [ ] No super admin user removed or redefined.
- [ ] No existing brand assets replaced.

## Evidence review

- Files changed:
- Evidence links:
  - Security summary (if PR changed security tooling):
  - Compliance report (if PR touched security logic):
  - Deployment safety check output:

## What to verify before merge

- [ ] Merge checks pass and gate conditions are documented.
- [ ] Rollback plan noted in `docs/RELEASE_CHECKLIST.md`.
- [ ] Reviewer confirms no demo-breaking placeholders or mock-only paths were introduced.
