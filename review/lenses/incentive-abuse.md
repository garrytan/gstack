---
lens: incentive-abuse
cli_aliases: [bad-faith-user]
status: DRAFT
summary: Finds product states and economic incentives that make repeated user abuse rational, scalable, or cheap.
primary_skill: [/review]
supported_skills: [/plan-eng-review]
severity: [SYSTEMIC_ABUSE, FINANCIAL_ABUSE, ACCESS_BYPASS, INCENTIVE_EXPLOIT, MODERATION_GAP]
ranking: "expected user payoff divided by user cost, multiplied by repeatability"
scope_disclaimer: "Defensive incentive-abuse review. It does not provide payloads, evasion procedures, or step-by-step exploitation instructions."
required_artifacts: [diff_or_plan, state_transition_model]
optional_artifacts: [pricing_rules, abuse_controls, identity_model]
required_context: [incentive_structure, business_model]
optional_context: [target_customer]
allowed_evidence_kinds: [file_line, file_range, cross_file, missing_control, missing_record, policy_mismatch, unmeasured_claim]
on_missing_required_evidence: INSUFFICIENT_EVIDENCE
invocation_triggers:
  path_globs:
    - "**/credits/**"
    - "**/trials/**"
    - "**/refunds/**"
    - "**/referrals/**"
    - "**/promotions/**"
    - "**/rewards/**"
    - "**/moderation/**"
    - "**/entitlements/**"
    - "**/rate-limit*/**"
    - "**/recovery/**"
  semantic_triggers:
    - "pr_label=incentive-surface"
    - "file_metadata=@surface:incentive"
    - "user_declared=incentive-surface"
evidence_threshold: STRONG_OR_MODERATE
materiality_threshold: MATERIAL_OR_BLOCKING
escalation_policy: ADVISORY_PLUS_MATERIAL
autofix_policy: ask_always
safety_directive: "Identify abuse conditions, economic incentives, detection gaps, and controls. Do not provide harmful payloads, evasion procedures, or step-by-step exploitation instructions."
---

==== LENS PROMPT START | INCENTIVE ABUSE ====

## When I use this lens

I use this lens for credits, trials, refunds, referrals, promotions, rewards, disputes, quotas, marketplaces, moderation, identity recovery, paid resources, entitlements, reputation systems, and any workflow where a user can gain value while imposing cost on the platform.

## Objective

Identify where a rational user can manipulate incentives, edge cases, state transitions, or trust boundaries to obtain money, access, influence, compute, data, service, or preferential treatment beyond what the product intends.

## Search strategy

Look for replayable actions, duplicate submissions, UI-only limits, client-controlled economic state, invalid transition ordering, low-cost automation, identity resets, weaponized disputes or appeals, partial-completion value, unbounded platform cost, weak anomaly detection, and enforcement that does not survive account recreation.

A valid finding must identify the user payoff, platform cost, scaling condition, detection gap, and smallest preventive, detective, economic, or recovery control.

Use `middle_fields`: `abuse_scenario`, `user_payoff`, `platform_cost`, `scaling_condition`, `detection_gap`.

Use severities: `SYSTEMIC_ABUSE`, `FINANCIAL_ABUSE`, `ACCESS_BYPASS`, `INCENTIVE_EXPLOIT`, `MODERATION_GAP`.

==== LENS PROMPT END | INCENTIVE ABUSE ====
