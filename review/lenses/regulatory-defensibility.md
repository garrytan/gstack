---
lens: regulatory-defensibility
cli_aliases: [hostile-regulator]
status: DRAFT
summary: Finds concrete gaps between implementation behavior, disclosures, controls, records, and the company's ability to defend its conduct.
primary_skill: [/plan-eng-review]
supported_skills: [/review]
severity: [ENFORCEMENT_RISK, DISCLOSURE_GAP, AUDIT_GAP, CONSENT_GAP, POLICY_MISMATCH]
ranking: "plausibility of the theory of harm multiplied by severity and weakness of available evidence"
scope_disclaimer: "Regulatory defensibility review. It is not legal advice, a legal opinion, or a statement of settled law."
required_artifacts: [diff_or_plan, policy_or_disclosure_bundle]
optional_artifacts: [legal_source_pack, data_flow_diagram, retention_schedule]
required_context: [regulatory_posture, data_classification, product_claim]
optional_context: [deployment_model]
allowed_evidence_kinds: [file_line, file_range, cross_file, missing_artifact, missing_control, missing_record, policy_mismatch]
on_missing_required_evidence: INSUFFICIENT_EVIDENCE
invocation_triggers:
  path_globs:
    - "**/consent/**"
    - "**/privacy/**"
    - "**/data-export/**"
    - "**/deletion/**"
    - "**/retention/**"
    - "**/eligibility/**"
    - "**/automated-decisions/**"
    - "docs/privacy*.md"
    - "docs/terms*.md"
  semantic_triggers:
    - "pr_label=regulated-surface"
    - "file_metadata=@surface:regulated"
    - "user_declared=regulated-surface"
evidence_threshold: STRONG_OR_MODERATE
materiality_threshold: MATERIAL_OR_BLOCKING
escalation_policy: REQUIRES_DOMAIN_VALIDATION
autofix_policy: ask_always
safety_directive: null
---

==== LENS PROMPT START | REGULATORY DEFENSIBILITY ====

## When I use this lens

I use this lens for consent, disclosures, sensitive data, retention, deletion, automated decisions, identity, eligibility, access, pricing, children, health, finance, employment, safety, privileged actions, appeals, disputes, model authority, or contractual policy commitments.

## Objective

Identify concrete product behavior, control failures, disclosure mismatches, user-harm theories, and missing records that could make the company's conduct difficult to explain or prove.

Operate in jurisdiction-neutral defensibility mode unless a verified legal source pack and applicable jurisdiction are supplied. Do not cite statutes or infer legal obligations from model memory. Mark applicability questions `REQUIRES_DOMAIN_VALIDATION`.

## Search strategy

Look for unrecorded consent, undisclosed data use, misleading defaults, claims the implementation cannot substantiate, sensitive actions without durable records, automated decisions without review or appeal, data crossing trust boundaries, policy-code inconsistencies, incomplete deletion propagation, and controls described in policy but not technically enforced.

Use `middle_fields`: `regulatory_theory`, `affected_party`, `missing_record`, `defensibility`, `domain_validation_needed`.

Use severities: `ENFORCEMENT_RISK`, `DISCLOSURE_GAP`, `AUDIT_GAP`, `CONSENT_GAP`, `POLICY_MISMATCH`.

==== LENS PROMPT END | REGULATORY DEFENSIBILITY ====
