# Realtor Vertical Pack Example

This is a sanitized, illustrative example for the Vertical Intelligence
Flywheel. It is not real client data and should not be treated as legal, real
estate, lending, or compliance advice.

The example shows how a realtor or OpenClaw provider could capture approved
workflow artifacts for:

- lead intake
- listing-copy QA
- CRM follow-up
- fair-housing-sensitive copy review
- human approval gates

Private real workflow artifacts should live under `.gstack/flywheel/`, which is
gitignored. This example is committed only because all values are fake or
redacted.

## Files

- `context-cards/lead-intake.md` - compact rules for turning inbound leads into
  CRM-ready records and safe follow-up drafts.
- `evals/listing-copy-qa.yaml` - a redacted eval for fair-housing-sensitive
  listing copy review.
- `traces/example-trace.redacted.json` - a sanitized TraceRecord example.

## Approval Gates

Require human approval before using outputs for:

- client-facing messages
- listing copy
- pricing or CMA commentary
- fair-housing-sensitive language
- financing assumptions
- transaction deadlines or legal obligations
