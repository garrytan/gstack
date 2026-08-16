---
lens: competitive-durability
cli_aliases: [competitor]
status: DEFERRED
summary: Tests what remains differentiated and economically defensible after a credible competitor copies, bundles, underprices, or routes around the visible feature.
primary_skill: [/plan-ceo-review]
supported_skills: [/review]
severity: [MOAT_FAILURE, COPYABILITY_RISK, POSITIONING_WEAKNESS, DISTRIBUTION_RISK, MARGIN_PRESSURE]
ranking: "probability of a credible competitive response multiplied by damage to durable advantage"
scope_disclaimer: "Competitive durability review. It does not replace full competitive strategy, market research, or named-competitor diligence."
required_artifacts: [positioning_bundle, competitive_set, pricing_packaging]
optional_artifacts: [distribution_plan, public_api_strategy, data_compounding_model]
required_context: [competitive_context, business_model, product_claim]
optional_context: [target_customer]
allowed_evidence_kinds: [file_line, file_range, cross_file, missing_artifact, missing_control, missing_record, policy_mismatch, unmeasured_claim]
on_missing_required_evidence: INSUFFICIENT_EVIDENCE
invocation_triggers:
  path_globs:
    - "**/api/**"
    - "**/integrations/**"
    - "**/pricing/**"
    - "**/open-source/**"
    - "docs/strategy/**"
    - "docs/positioning/**"
  semantic_triggers:
    - "pr_label=competitive-surface"
    - "file_metadata=@surface:competitive"
    - "user_declared=competitive-surface"
evidence_threshold: STRONG_ONLY
materiality_threshold: MATERIAL_OR_BLOCKING
escalation_policy: MATERIAL
autofix_policy: ask_always
safety_directive: null
---

==== LENS PROMPT START | COMPETITIVE DURABILITY ====

## When I use this lens

I use this lens only when the evidence bundle contains positioning, a named competitive set, and pricing or value-capture assumptions. A feature diff alone is not sufficient.

## Objective

Identify how a credible, well-resourced competitor could copy, bundle, underprice, acquire a dependency, or route around the product, and what durable advantage remains afterward.

## Search strategy

Look for visible features without compounding data or workflow depth, APIs that commoditize the core value, incomplete workflows an incumbent can bundle, pricing exposed to undercutting, supplier dependencies that can absorb the margin, missing switching costs, technical advantages likely to decay, and distribution assumptions the company does not control.

Use `middle_fields`: `competitive_response`, `enabling_weakness`, `advantage_at_risk`, `time_to_neutralize`, `residual_moat`.

Use severities: `MOAT_FAILURE`, `COPYABILITY_RISK`, `POSITIONING_WEAKNESS`, `DISTRIBUTION_RISK`, `MARGIN_PRESSURE`.

==== LENS PROMPT END | COMPETITIVE DURABILITY ====
