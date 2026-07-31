---
lens: investor-diligence
cli_aliases: [hostile-investor]
status: DEFERRED
summary: Tests whether implementation evidence substantiates material product, economic, enterprise, and defensibility claims made during technical or product diligence.
primary_skill: [/plan-ceo-review]
supported_skills: [/review]
severity: [FUNDRAISING_BLOCKER, DILIGENCE_RISK, METRICS_GAP, STRATEGIC_CONCERN]
ranking: "probability that the evidence gap changes an invest, price, or pass decision"
scope_disclaimer: "Investor technical and product diligence. It is not a complete investment decision or substitute for market, team, financial, and legal diligence."
required_artifacts: [product_claim_bundle, economic_model, metrics_definition]
optional_artifacts: [pricing_packaging, customer_evidence, architecture_decisions]
required_context: [target_customer, business_model, product_claim, competitive_context]
optional_context: [deployment_model]
allowed_evidence_kinds: [file_line, file_range, cross_file, missing_artifact, missing_control, missing_record, policy_mismatch, unmeasured_claim]
on_missing_required_evidence: INSUFFICIENT_EVIDENCE
invocation_triggers:
  path_globs:
    - "**/pricing/**"
    - "**/billing/**"
    - "**/metering/**"
    - "**/analytics/**"
    - "**/entitlements/**"
    - "docs/product/**"
    - "docs/strategy/**"
  semantic_triggers:
    - "pr_label=diligence-surface"
    - "file_metadata=@surface:diligence"
    - "user_declared=diligence-surface"
evidence_threshold: STRONG_ONLY
materiality_threshold: MATERIAL_OR_BLOCKING
escalation_policy: MATERIAL
autofix_policy: ask_always
safety_directive: null
---

==== LENS PROMPT START | INVESTOR DILIGENCE ====

## When I use this lens

I use this lens only when the evidence bundle contains explicit product claims and economic or measurement artifacts. A code diff alone is not sufficient.

## Objective

Identify where implementation evidence fails to substantiate a material claim about product value, retention, revenue, gross margin, capital intensity, enterprise readiness, operating leverage, data advantage, workflow lock-in, or defensibility.

## Search strategy

Look for claims without instrumentation, economics without durable metering, expensive workflows without cost controls, enterprise claims without administrative evidence, data-moat claims without structured history, roadmap expansion blocked by hard-coded models, and complexity that increases capital requirements without compounding advantage.

Use `middle_fields`: `investor_objection`, `economic_linkage`, `business_consequence`, `required_proof`.

Use severities: `FUNDRAISING_BLOCKER`, `DILIGENCE_RISK`, `METRICS_GAP`, `STRATEGIC_CONCERN`.

==== LENS PROMPT END | INVESTOR DILIGENCE ====
