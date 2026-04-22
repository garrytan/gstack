# Threat Model Methodology & Output Schema

Read this file when producing any threat model. It defines the structured methodology,
templates, deliverable formats, and technology-specific checklists. This is the
authoritative reference for HOW to structure the analysis and WHAT to deliver.

The 9-step procedure maps to the phases below. Use these templates and tables to
structure the output.

---

## Phase 1 — System Decomposition (Step 1)

### 1.1 Scope & Artifacts Discovery

Populate this table first. If analyzing a repository, discover artifacts by reading
README, SECURITY.md, CODEOWNERS, package manifests, API specs, deployment configs,
and any existing security documentation.

```
SCOPE AND ARTIFACTS
─────────────────────────────────────────────────
Target of Evaluation (ToE):   [system/component name]
ToE Description:              [one-paragraph summary]
ToE DRI Owner(s):             [from CODEOWNERS, README, or user input]
Scope:                        [in-scope components and boundaries]
Source Code:                  [repository URL/path if available]
Documentation:                [design docs, API specs found]
Architecture Artifacts:       [diagrams, ADRs discovered]
Previous Security Reports:    [prior reviews, pen-test findings]
Date:                         [ISO-8601]
Methodology:                  Component-Driven STRIDE+ with AI Exploitability
Frameworks:                   MITRE ATT&CK, ATLAS, CWE, OWASP [applicable editions]
```

### 1.2 Component Inventory

Assign each component a unique ID. This is the foundation for traceability.

| ID | Name | Type | Description | Trust Zone | Entry Points | Protocols | Auth Mechanism |
|----|------|------|-------------|------------|-------------|-----------|----------------|
| C-01 | | Service / Library / Database / Queue / Gateway / Storage / Cache / ML Model / Agent / External API / CI/CD Pipeline / Secret Store / IdP | | Public DMZ / Internal App / Internal Data / Management / External SaaS / CI/CD / Cloud Control Plane / OT Zone | APIs, CLI, UI, message consumer, webhook, MQTT, serial | | |

Identify components by examining: directory structure, service definitions, entry points,
inter-service communication, database integrations, external API clients, message queue
producers/consumers, background job processors, AI/ML inference endpoints.

### 1.3 Data Flow Mapping

For each data flow between components:

| Flow ID | Source | Destination | Data Elements | Classification | Protocol | Authentication | Authorization | Encryption | Crosses Trust Boundary? |
|---------|--------|-------------|---------------|----------------|----------|----------------|---------------|------------|------------------------|
| DF-01 | | | | Public / Internal / Confidential / Restricted | | | | TLS / mTLS / App-layer / None | Yes (which boundary) / No |

Every trust boundary crossing is a high-priority analysis target.

### 1.4 Trust Boundary Map

| Boundary ID | Description | Components on Each Side |
|-------------|-------------|------------------------|
| TB-01 | Public Internet / DMZ | |
| TB-02 | DMZ / Internal Network | |
| TB-03 | Unauthenticated / Authenticated | |
| TB-04 | User / Admin Privilege | |
| TB-05 | IT / OT Network | |
| TB-06 | Tenant A / Tenant B | |

Identify boundaries from: network segmentation (K8s NetworkPolicies, security groups),
auth enforcement points, service mesh config, API gateway config, firewall rules.

---

## Phase 2 — Security Context (Steps 1-2)

### 2.1 Asset Registry

| Asset | Classification | Storage Location (Component ID) | Owner | Encryption at Rest | Encryption in Transit |
|-------|---------------|--------------------------------|-------|-------------------|----------------------|
| User Credentials | Critical | | | | |
| PII | High | | | | |
| API Keys / Secrets | Critical | | | | |
| Session Tokens | High | | | | |
| Business Data | Medium | | | | |
| ML Model Weights | High | | | | |
| Training Data | Varies | | | | |

Identify assets by analyzing: database schemas/models, configuration files, environment
variables, API request/response structures, file storage patterns.

### 2.2 Threat Agent Profiling

Evaluate which threat agents are relevant to this system:

| Category | Description | Relevant? | Capability Level | Motivation |
|----------|-------------|-----------|-----------------|------------|
| Internal Authorized | Legitimate users abusing privileges | | | |
| Internal Unauthorized | Employees without legitimate access | | | |
| External Authorized | Partners, API consumers, contractors | | | |
| External Unauthorized | Anonymous attackers, competitors | | | |
| Nation-State / APT | State-sponsored with AI agent capabilities | | | |
| AI-Augmented Attacker | Adversary using AI agents for automated exploitation | | | |
| Supply Chain Attacker | Compromising dependencies, build pipeline, SaaS integrations | | | |
| Insider Threat | Malicious employee or compromised account | | | |

### 2.3 Existing Security Controls Inventory

Identify implemented controls by searching for: authentication libraries/middleware,
authorization frameworks (RBAC, ABAC, OPA), input validation patterns, cryptographic
implementations, logging/monitoring integrations, rate limiting, WAF/API gateway config,
service mesh policies, network segmentation rules.

| Control | Implementation | Coverage | Gaps |
|---------|---------------|----------|------|
| Authentication | | Complete / Partial / Missing | |
| Authorization | | | |
| Input Validation | | | |
| Encryption (transit) | | | |
| Encryption (rest) | | | |
| Logging / Audit | | | |
| Rate Limiting | | | |
| Secrets Management | | | |
| Dependency Scanning | | | |
| Network Segmentation | | | |

---

## Phase 3 — Component Security Profiles (Step 2)

For EACH major component, complete this profile:

```
COMPONENT SECURITY PROFILE
─────────────────────────────────────────────────
Component ID:              [C-XX]
Component Name:            [descriptive name]
Description/Function:      [purpose and primary function]
Trust Zone:                [Public DMZ / Internal Trusted / Secure Enclave / OT Zone]

Data Handled:
  [Data type] — [Classification: Critical/High/Medium/Low]
  [Data type] — [Classification]

External Dependencies:
  [Components, services, APIs this relies on]

Key Security Controls:
  [Input validation, HMAC, RBAC, TLS, rate limiting, etc.]

Known Weaknesses/Assumptions:
  [Limitations, trust assumptions, e.g.,
   "Assumes upstream provides sanitized data",
   "No rate limiting implemented",
   "Relies on network-level isolation"]

Code Location:             [primary file paths, if applicable]
```

Component analysis checklist:
- Authentication mechanism and strength
- Authorization model and enforcement
- Input validation completeness
- Output encoding practices
- Error handling and information leakage
- Logging and audit trail
- Cryptographic practices
- Session management
- Dependency security posture
- Configuration security

---

## Phase 4 — Threat Identification (Step 3)

Apply STRIDE to each component and data flow using these structured questions,
then extend with real-world 2024-2026 attack patterns from the threat intelligence
reference.

### STRIDE Structured Questions

**Spoofing (Identity)**
- Can an attacker impersonate a legitimate user or component?
- Are authentication tokens properly validated (algorithm, signature, expiry, audience)?
- Can service-to-service authentication be bypassed?
- Can AI agent identities be spoofed in multi-agent systems?
- Can deepfake vishing compromise credential reset flows?

**Tampering (Integrity)**
- Can data be modified in transit or at rest?
- Are integrity checks in place (signatures, MACs, checksums)?
- Can an attacker inject malicious data (SQL, NoSQL, command, XSS, prompt)?
- Can supply chain dependencies be tampered with?
- Can CI/CD artifacts be modified between build and deployment?

**Repudiation (Non-repudiation)**
- Are security-relevant actions logged with sufficient detail?
- Can logs be tampered with or deleted?
- Is there sufficient audit trail for compliance and incident investigation?
- Can AI agent actions be attributed to the requesting principal?

**Information Disclosure (Confidentiality)**
- Is sensitive data exposed in logs, error messages, or API responses?
- Is encryption properly implemented (at rest and in transit)?
- Are there side-channel leakage risks (timing, cache, AI context window)?
- Can data be exfiltrated via trusted integrations or AI tools?

**Denial of Service (Availability)**
- Are there rate limiting and throttling controls?
- Can resources be exhausted (CPU, memory, storage, connections, API quotas)?
- Are there algorithmic complexity vulnerabilities (ReDoS, GraphQL depth)?
- Can backup/recovery infrastructure be targeted?

**Elevation of Privilege (Authorization)**
- Can users access resources beyond their assigned privileges?
- Are there IDOR (Insecure Direct Object Reference) vulnerabilities?
- Can horizontal or vertical privilege escalation occur?
- Can OAuth scopes or agent permissions be escalated?
- Can container/VM escape lead to host or cluster compromise?

---

## Phase 5 — Risk Scoring (Steps 4-5)

### Simple Scoring (conversational assessments)
```
Composite = (Likelihood[1-5] × Impact[1-5]) + AI_Modifier
AI_Modifier: AE-1 = +5, AE-2 = +3, AE-3 = +1, AE-4 = 0, AE-5 = -1
Critical: ≥ 15
```

### Granular Scoring (formal reports)
```
Likelihood = skill_required + access_required + existing_controls
  skill_required:    Low=3, Medium=2, High=1
  access_required:   None=3, User=2, Admin=1
  existing_controls: None=3, Partial=2, Strong=1
  Range: [3, 9]

Impact = confidentiality + integrity + availability + business_regulatory
  Each: High=3, Medium=2, Low=1 (business_regulatory: Critical=4, High=3, Medium=2, Low=1)
  Range: [4, 13]

Risk Score = Likelihood × Impact + AI_Modifier
  Range: [12, 117] before modifier

Risk Level:
  Critical: ≥ 70
  High: 40-69
  Medium: 20-39
  Low: < 20
```

---

## Phase 6 — Mitigation Design (Step 6)

For each threat, select a strategy:

| Strategy | When to Use |
|----------|-------------|
| **Mitigate** | Implement controls to reduce risk to acceptable level |
| **Transfer** | Shift risk to another party (insurance, contracts, shared responsibility) |
| **Avoid** | Remove the feature or redesign the architecture |
| **Accept** | Document and accept with explicit justification and owner sign-off |

Mitigations should focus on architectural changes over point fixes:
- Redesigning authentication/authorization flows
- Adding component isolation and blast radius reduction
- Implementing defense-in-depth layers
- Applying zero-trust principles
- Introducing secure-by-default configurations

---

## Deliverable: Threat and Mitigation Traceability Matrix

The core deliverable linking every threat to components, scoring, and mitigations:

| Threat ID | Threat Description | STRIDE | Component(s) | Data Flow(s) | Likelihood | Impact | AI Exploit | Composite | ATT&CK / ATLAS | CWE | Precedent | Strategy | Countermeasure | Timeframe | Status |
|-----------|-------------------|--------|-------------|-------------|-----------|--------|------------|-----------|-----------------|-----|-----------|----------|---------------|-----------|--------|
| T-001 | [attack scenario] | [S/T/R/I/D/E] | [C-XX] | [DF-XX] | | | [AE-X] | | [technique IDs] | | [2024-2026 incident] | [Mitigate/Accept/Avoid/Transfer] | [specific control] | [Immediate/Short/Strategic] | [Open/In Progress/Done] |

---

## Technology-Specific Checklists

Apply these when the relevant technology is present in the component.

### AI/ML Systems
- [ ] Model input validation and sanitization
- [ ] Prompt injection vectors (direct, indirect, cross-plugin, persistent)
- [ ] Training data poisoning risks (including RAG corpus)
- [ ] Model extraction / stealing attacks
- [ ] Adversarial input resilience
- [ ] Output filtering and guardrails
- [ ] Model versioning and integrity verification
- [ ] Inference infrastructure isolation
- [ ] Data lineage and provenance
- [ ] Agent permission scoping and action authorization
- [ ] MCP server security (tool poisoning, overprivileged access)
- [ ] Memory/session poisoning across agent interactions
- [ ] OWASP Top 10 for LLM Applications (2025)
- [ ] OWASP Top 10 for Agentic AI (2026)

### Web Applications / APIs
- [ ] OWASP Top 10 (2021) coverage
- [ ] OWASP API Security Top 10 (2023) coverage
- [ ] Authentication mechanism strength (phishing-resistant MFA?)
- [ ] Session management security
- [ ] CORS and CSP configuration
- [ ] API rate limiting and abuse prevention
- [ ] Input validation at every trust boundary
- [ ] HTTP security headers
- [ ] Request smuggling resilience

### Cloud-Native / Kubernetes
- [ ] Container image security (scanning, signing, provenance)
- [ ] Pod security standards (Restricted, Baseline, Privileged)
- [ ] Network policies (default-deny, namespace isolation)
- [ ] Secrets management (external secrets operator, not env vars)
- [ ] RBAC configuration (least privilege, no cluster-admin sprawl)
- [ ] Service mesh security (mTLS enforcement, not PERMISSIVE)
- [ ] Workload identity (IRSA, Workload Identity, Pod Identity)
- [ ] Admission control (OPA/Gatekeeper, Kyverno)
- [ ] Runtime security (Falco, Tetragon, Sysdig)

### Data Pipelines
- [ ] Data encryption at rest and in transit
- [ ] Access control granularity (column/row level)
- [ ] Data masking / anonymization / tokenization
- [ ] Audit logging completeness
- [ ] Data retention and destruction compliance
- [ ] Pipeline integrity (can stages be tampered with?)
- [ ] Data lineage tracking

### CI/CD & Supply Chain
- [ ] Source code integrity (signed commits, branch protection)
- [ ] Build environment isolation (no prod credentials in build)
- [ ] Artifact signing and provenance (SLSA framework)
- [ ] Dependency management (pinned, scanned, SBOMs)
- [ ] Secret management in pipelines (no secrets in logs/env)
- [ ] Deployment approval gates
- [ ] IaC security (state file protection, policy-as-code)

### IoT / OT / ICS
- [ ] Device authentication and unique identity
- [ ] Firmware integrity (secure boot, signed updates)
- [ ] Protocol security (authentication, encryption on MQTT/Modbus/DNP3)
- [ ] IT/OT segmentation (Purdue Model enforcement)
- [ ] Safety system independence (SIS not on control network)
- [ ] Physical consequence analysis
- [ ] Device lifecycle management (patching, decommissioning)

---

## Report Structure

Organize the final deliverable as follows:

### 1. Executive Summary
- Overall security posture assessment (1-2 paragraphs)
- Critical findings count and top 3 risks
- Top recommendations (architectural, not tactical)

### 2. Scope & Artifacts (completed table from Phase 1.1)

### 3. System Models
- Component inventory table
- Data flow mapping table
- Trust boundary map
- Architecture diagram (text or mermaid if requested)

### 4. Asset Registry & Threat Agent Analysis (Phase 2)

### 5. Component Security Profiles (one per major component)

### 6. Threat & Mitigation Traceability Matrix (the core deliverable)

### 7. Attack Trees (top 3 highest-risk paths with AI exploitability)

### 8. Detailed Findings (for Critical/High risks)
- Attack scenario narrative
- Technical analysis
- Evidence from code (file:line references if applicable)
- AI exploitability assessment
- Recommended countermeasures with timeframes

### 9. Residual Risks & Accepted Items

### 10. Assumptions & Gaps (Step 7)

### 11. Validation Plan
- How to verify mitigations work (red team scenarios, test cases)
- Metrics for ongoing security posture monitoring
- Recommended re-assessment cadence

### 12. Peer Review Notes
- Findings validated by review
- Updated threats based on reviewer input
- Disagreements and resolution

---

## JSON Schema (for programmatic use / model training)

When JSON output is requested:

```json
{
  "threat_model": {
    "metadata": {
      "target_of_evaluation": "", "description": "", "scope": "",
      "date": "", "methodology": "Component-Driven STRIDE+ with AI Exploitability",
      "frameworks": []
    },
    "component_inventory": [
      {
        "id": "C-XX", "name": "", "type": "", "description": "",
        "trust_zone": "", "entry_points": [], "protocols": [],
        "auth_mechanism": "", "data_handled": [],
        "dependencies": [], "security_controls": [],
        "known_weaknesses": [], "code_location": ""
      }
    ],
    "data_flows": [
      {
        "id": "DF-XX", "source": "C-XX", "destination": "C-XX",
        "data_elements": "", "classification": "", "protocol": "",
        "authentication": "", "authorization": "", "encryption": "",
        "crosses_trust_boundary": true
      }
    ],
    "trust_boundaries": [
      { "id": "TB-XX", "description": "", "components_separated": [] }
    ],
    "asset_registry": [
      { "asset": "", "classification": "", "location": "C-XX", "owner": "" }
    ],
    "threats": [
      {
        "id": "T-XXX", "title": "", "stride_categories": [],
        "components": [], "data_flows": [],
        "attack_scenario": "",
        "likelihood": {}, "impact": {},
        "ai_exploitability": "", "composite_score": 0, "risk_level": "",
        "mitre_references": [], "cwe": [],
        "real_world_precedent": "",
        "strategy": "mitigate|accept|avoid|transfer",
        "mitigations": [
          {
            "id": "M-XXX", "description": "",
            "timeframe": "immediate|short-term|strategic",
            "detection": "", "validation": "", "status": "open"
          }
        ]
      }
    ],
    "attack_trees": [],
    "residual_risks": [],
    "assumptions_and_gaps": [],
    "validation_plan": []
  }
}
```
