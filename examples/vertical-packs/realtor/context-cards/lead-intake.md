---
id: context_real_estate_lead_intake_v1
domain: real_estate
workflow: lead_intake
version: 1
source_trace_count: 0
token_budget: 1000
---

# Lead Intake Context Card

## Goal

Convert messy inbound real estate leads into CRM-ready records, missing-info
questions, and safe follow-up drafts.

## Stable Rules

- Separate facts from assumptions.
- Do not infer protected-class attributes.
- Do not imply steering based on demographic, family, disability, religion, or
  other protected-class signals.
- Ask for missing budget, timing, location, financing, and showing availability.
- Mark uncertain fields as `unknown` instead of guessing.
- Keep client-facing drafts warm, concise, and approval-gated.

## Tool And Data Contracts

- CRM fields: name, contact_method, budget_range, target_locations,
  property_type, bedrooms, bathrooms, timing, financing_status,
  showing_availability, notes, missing_fields.
- Preserve source confidence per field: `explicit`, `inferred_from_text`, or
  `unknown`.
- Never store raw inbound messages in committed examples.

## Human Approval Required For

- Client-facing follow-up drafts
- Pricing advice
- Financing assumptions
- Fair-housing-sensitive copy
- Any statement that could be read as steering

## Examples

- `examples/vertical-packs/realtor/traces/example-trace.redacted.json`

## Eval References

- `examples/vertical-packs/realtor/evals/listing-copy-qa.yaml`

## Known Failure Modes

- Unsupported inference
- Overconfident budget or financing assumptions
- Missing fair-housing-sensitive wording review
- Mixing facts and assumptions in CRM notes
