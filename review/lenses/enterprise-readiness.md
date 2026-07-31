---
lens: enterprise-readiness
cli_aliases: [enterprise-buyer]
status: DRAFT
summary: Finds implementation gaps that can block enterprise security review, procurement, production deployment, governance, expansion, or renewal.
primary_skill: [/plan-eng-review]
supported_skills: [/review]
severity: [DEAL_BLOCKER, SECURITY_REVIEW_RISK, PROCUREMENT_FRICTION, OPERABILITY_GAP, ADOPTION_RISK]
ranking: "probability of blocking production deployment or expansion multiplied by operational consequence"
scope_disclaimer: "Enterprise readiness check. It does not replace a security audit, procurement process, legal review, or customer-specific architecture assessment."
required_artifacts: [diff_or_plan]
optional_artifacts: [security_control_matrix, data_flow_diagram, sla_slo_docs, integration_contracts]
required_context: [target_customer, deployment_model]
optional_context: [regulatory_posture, data_classification]
allowed_evidence_kinds: [file_line, file_range, cross_file, missing_artifact, missing_control, missing_record, policy_mismatch, unmeasured_claim]
on_missing_required_evidence: INSUFFICIENT_EVIDENCE
invocation_triggers:
  path_globs:
    - "**/sso/**"
    - "**/scim/**"
    - "**/rbac/**"
    - "**/permissions/**"
    - "**/audit/**"
    - "**/tenants/**"
    - "**/integrations/**"
    - "**/deploy/**"
    - "**/billing/**"
    - "**/metering/**"
    - "**/admin/**"
    - "**/config/**"
  semantic_triggers:
    - "pr_label=enterprise-surface"
    - "file_metadata=@surface:enterprise"
    - "user_declared=enterprise-surface"
evidence_threshold: STRONG_OR_MODERATE
materiality_threshold: MATERIAL_OR_BLOCKING
escalation_policy: ADVISORY_PLUS_MATERIAL
autofix_policy: ask_always
safety_directive: null
---

==== LENS PROMPT START | ENTERPRISE READINESS ====

## When I use this lens

I use this lens when a change affects enterprise onboarding, SSO, SCIM, RBAC, tenant isolation, APIs, integrations, data governance, auditability, deployment architecture, reliability, disaster recovery, centralized configuration, metering, billing, support operations, or expansion from a pilot to broad production use.

I generally do not use it for a consumer-only feature or an internal refactor with no effect on enterprise operation, governance, security evidence, or commercial predictability.

## Objective

I want the evidence reviewed for one question:

**What in this implementation could cause a capable enterprise buyer to delay, restrict, or reject production deployment, or make the product materially difficult to govern and operate at scale?**

The lens represents the combined evidence needs of the business owner, security team, IT team, procurement team, legal reviewers, and platform operators. It does not claim to complete any of those processes.

## Search strategy

Look for:

- Missing SSO, SCIM, RBAC, approval flows, or separation of duties
- Weak audit visibility, administrative reporting, or incident traceability
- Unclear data ownership, retention, residency, deletion, export, or model-training behavior
- Brittle or bespoke integrations that are difficult to monitor, recover, version, or support
- Missing tenant isolation, environment isolation, network boundaries, or deployment controls
- Reliability gaps involving graceful degradation, recovery, status visibility, runbooks, or support tooling
- Security controls that depend on user discipline rather than centrally enforceable policy
- Missing secrets management, key rotation, configuration governance, or drift detection
- Administrative actions that cannot be centrally governed, delegated, or reviewed
- Usage, pricing, billing, or entitlement behavior that procurement cannot predict or audit
- Excessive implementation, migration, training, or ongoing support burden
- Claims that cannot be demonstrated through logs, reports, controls, tests, or documentation
- Missing APIs, exports, event streams, or integration contracts required for production operation
- Features that work for one team but do not scale across many teams, tenants, or regions
- Recovery procedures that depend on undocumented individual knowledge

A valid finding must identify:

1. The concrete buyer or operator objection
2. The implementation evidence behind it
3. The affected stage: pilot, production approval, expansion, or renewal
4. The proof or control the buyer would request
5. The smallest change that materially improves deployability or governance

## Lens-specific output fields

For each finding, `middle_fields` must contain:

- `buyer_objection`
- `operational_consequence`
- `control_or_artifact_requested`
- `adoption_impact`

Use one of these severities:

- `DEAL_BLOCKER`
- `SECURITY_REVIEW_RISK`
- `PROCUREMENT_FRICTION`
- `OPERABILITY_GAP`
- `ADOPTION_RISK`

Rank by likelihood of blocking production deployment or expansion and by operational consequence.

==== LENS PROMPT END | ENTERPRISE READINESS ====
