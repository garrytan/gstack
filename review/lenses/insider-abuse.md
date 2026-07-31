---
lens: insider-abuse
cli_aliases: [malicious-insider]
status: READY
summary: Finds where legitimate internal authority can be converted into an unauthorized outcome without timely attribution or detection.
primary_skill: [/review]
supported_skills: [/plan-eng-review]
severity: [INSIDER_ABUSE_RISK, PRIVILEGE_ESCALATION, AUDIT_GAP, DATA_EXPOSURE, APPROVAL_GAP]
ranking: "blast radius multiplied by detection failure and ease of abuse"
scope_disclaimer: "Defensive controls review. It does not provide procedural exploit instructions or replace a full insider-threat assessment."
required_artifacts: [diff_or_plan, privileged_role_model]
optional_artifacts: [audit_log_schema, approval_workflow_docs]
required_context: [deployment_model]
optional_context: [data_classification]
allowed_evidence_kinds: [file_line, file_range, cross_file, missing_control, missing_record, policy_mismatch]
on_missing_required_evidence: INSUFFICIENT_EVIDENCE
invocation_triggers:
  path_globs:
    - "**/admin/**"
    - "**/support-tools/**"
    - "**/support_tools/**"
    - "**/rbac/**"
    - "**/permissions/**"
    - "**/audit/**"
    - "**/service-accounts/**"
    - "**/service_accounts/**"
    - "**/*admin*.*"
  semantic_triggers:
    - "pr_label=privileged-surface"
    - "file_metadata=@surface:privileged"
    - "user_declared=privileged-surface"
evidence_threshold: STRONG_OR_MODERATE
materiality_threshold: MATERIAL_OR_BLOCKING
escalation_policy: ADVISORY_PLUS_MATERIAL
autofix_policy: ask_always
safety_directive: "Describe abuse conditions, missing controls, and detection gaps. Do not provide procedural exploit steps, credential-theft methods, evasion techniques, or data-exfiltration instructions."
---

==== LENS PROMPT START | INSIDER ABUSE ====

## When I use this lens

I use this lens when a change affects administrative or support tooling, user impersonation, privileged data access, sensitive exports, permission changes, service accounts, secrets, financial actions, destructive actions, production access, audit records, approval workflows, maintenance paths, or emergency access.

I generally do not use it for a public read-only path with no sensitive data, privileged authority, or internal control surface.

## Objective

I want the evidence reviewed for one question:

**Where can an employee, contractor, administrator, support operator, developer, service account, or compromised internal identity convert legitimate authority into an unauthorized outcome without timely prevention, detection, attribution, or recovery?**

This is a defensive controls review. It is not a general external-attacker review and it must not become an exploitation guide.

## Search strategy

Look for:

- Privileges broader than the role requires
- Administrative actions without durable, tamper-resistant audit records
- Sensitive exports without approval, reason codes, rate limits, watermarking, or attribution
- Support tools that impersonate users or mutate user state without traceability
- Authorization derived from client-controlled state, headers, request parameters, or mutable metadata
- Missing separation of duties for destructive, financial, identity, or high-impact actions
- Debug, maintenance, migration, or emergency paths that can survive into production
- Data-access paths that bypass the normal authorization layer
- Sensitive actions without reauthentication, secondary approval, or bounded delegation
- Broad service-account permissions with weak ownership, rotation, or review
- Audit records that a privileged actor can modify, suppress, or route around
- Controls designed for external attackers that assume internal identities are trustworthy
- Recovery mechanisms that restore the service but cannot reconstruct responsibility
- Abuse that would be visible only through ad hoc log correlation rather than an explicit control signal

A valid finding must identify:

1. The legitimate authority that exists
2. The unauthorized outcome that authority can enable
3. The affected asset or decision
4. Why prevention, detection, attribution, or recovery is insufficient
5. The smallest control that materially reduces the risk

## Lens-specific output fields

For each finding, `middle_fields` must contain:

- `existing_authority`
- `abuse_scenario`
- `blast_radius`
- `detection_risk`
- `control_gap`

Use one of these severities:

- `INSIDER_ABUSE_RISK`
- `PRIVILEGE_ESCALATION`
- `AUDIT_GAP`
- `DATA_EXPOSURE`
- `APPROVAL_GAP`

Rank by blast radius, likelihood of detection failure, and ease of abuse.

==== LENS PROMPT END | INSIDER ABUSE ====
