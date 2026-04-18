# Threat Intelligence Reference — 2024-2026

Read this file in full before producing any threat model. It contains the real-world attack
data, attacker capability benchmarks, and scoring frameworks that ground every finding.

---

## Attacker Capabilities — AI-Augmented Offense

The adversary profile has fundamentally changed. Assume every attacker has access to:

- **Automated exploit generation**: AI agents generate working CVE exploits in 10-15 minutes
  at ~$1 per exploit. The grace period between vulnerability disclosure and weaponization
  has effectively collapsed.
- **Superior social engineering**: AI-generated phishing outperforms elite human red teams
  by 24% (a 42-percentage-point swing since 2023).
- **Polymorphic malware**: LLM-powered malware regenerates unique code on every execution.
  Tools like BlackMamba produce signatures that evade hash-based detection completely.
  Over 70% of major breaches in 2025 involved polymorphic malware.
- **Machine-speed operations**: The fastest recorded eCrime breakout time is 27 seconds
  from initial access to lateral movement. Median handoff between initial access and
  secondary threat group collapsed to 22 seconds in 2025.
- **Autonomous attack chains**: State-sponsored actors (documented: Chinese GTG-1002
  campaign, September 2025) executed campaigns where AI agents autonomously handled 80-90%
  of tactical execution across 30+ targets simultaneously — from reconnaissance through
  credential harvesting — at physically impossible request rates.
- **AI-enabled reconnaissance at scale**: 89% increase in attacks by AI-enabled adversaries
  year-over-year. 90+ organizations had legitimate AI tools exploited to generate malicious
  commands and steal data.

## Dominant Real-World Attack Patterns (2024-2026)

### Identity-First Attacks (Primary Vector)
- 82% of detections in 2025 were malware-free — adversaries used valid credentials,
  stolen tokens, and session hijacking.
- 56% of exploited vulnerabilities required no authentication at all.
- Adversaries need only valid credentials and patience — not zero-days.
- Deepfake vishing is now the #1 initial access vector for cloud compromises at 23%.
- AitM (Adversary-in-the-Middle) phishing proxy kits steal fully authenticated session
  tokens, bypassing MFA entirely.
- Machine identity sprawl creates dangerous blind spots — service accounts, API keys,
  and AI agent identities are rarely governed.

### Supply Chain Compromise (Fastest Growing)
- Major supply chain and third-party breaches quadrupled over five years.
- Key incidents:
  - OAuth supply chain breach (2025): 700+ SaaS environments compromised via OAuth consent phishing.
  - CVE-2025-61882 (Oracle EBS): zero-day exploited by Clop for mass extortion.
  - Education platform breach (Dec 2024): student/teacher data stolen; ransom paid.
  - CamoLeak (2025): AI coding assistant vulnerability exfiltrated private repo secrets.
  - s1ngularity incident (Aug 2025): build system supply chain compromise; malware issued
    natural-language prompts to local AI dev tools for credential exfiltration.
- MCP server vulnerabilities: 102 CVEs in 2025 alone.

### Ransomware & Extortion
- Groups: Scattered Spider, ShinyHunters, Qilin, Clop, Scattered Lapsus$ Hunters.
- Automotive manufacturer (Aug 2025): £1.9B cost, 5-week production halt, 5,000+ supply chain businesses.
- Major UK retailers (2025): coordinated supply chain ransomware campaign across multiple brands.
- Beverage manufacturer (Sep 2025): operations suspended, 27GB stolen by Qilin.
- Attackers now systematically target backup infrastructure and virtualization layers.

### Agentic AI as Attack Surface
- 363 CVEs in agentic AI systems in 2025 (6% of all AI CVEs).
- Agent-to-agent impersonation, memory poisoning, cascading multi-agent failures.
- 250 poisoned documents can implant backdoors with no detectable performance degradation.
- 300,000+ AI assistant credentials listed for sale on the dark web in 2025.

### Initial Infection Vectors (2025 M-Trends)
| Vector | Share |
|--------|-------|
| Exploits | 32% |
| Voice phishing (vishing) | 11% |
| Prior compromise | 10% |
| Stolen credentials | 9% |
| Web compromise | 8% |
| Insider threat | 6% |
| Email phishing | 6% |
| Third-party compromise | 5% |
| Other | 13% |

---

## AI Exploitability Scale

### AE-1 — TRIVIAL
AI agent discovers AND exploits in under 5 minutes. Fully automatable. Cost: < $1.

### AE-2 — LOW EFFORT
AI agent exploits within 1 hour with moderate tool chaining. Cost: < $10.

### AE-3 — MODERATE
Requires specialized tooling or multi-step reasoning. One human decision point. Cost: < $100.

### AE-4 — SIGNIFICANT
Human expertise to plan; AI accelerates execution. Cost: $100-$1000.

### AE-5 — HARDENED
AI agents cannot meaningfully accelerate exploitation. Requires deep domain expertise or physical access.

### Composite Risk Score Formula (General)
```
Composite = (Likelihood × Impact) + AI_Modifier
```
AI_Modifier: AE-1 = +5, AE-2 = +3, AE-3 = +1, AE-4 = 0, AE-5 = -1.

Scores ≥ 15 = CRITICAL.

---

## STRIDE Extended for 2024-2026

### S — Spoofing
Credential theft via AitM, session token hijacking, deepfake vishing, OAuth consent
phishing, agent-to-agent identity spoofing, machine identity impersonation.

### T — Tampering
Supply chain package tampering, CI/CD artifact manipulation, model weight poisoning,
prompt injection (all variants), MCP tool poisoning, IaC drift injection.

### R — Repudiation
Living-off-the-land log evasion, cloud audit timestamp manipulation, agent action
attribution failures, ransomware audit trail destruction.

### I — Information Disclosure
Exfiltration via stolen tokens, AI context window side-channels, uncontrolled RAG
retrieval, CamoLeak-style extraction, credential exposure in agent memory.

### D — Denial of Service
Ransomware shutdown, backup infrastructure destruction, virtualization layer attacks,
machine-speed API abuse, adversarial prompt resource exhaustion.

### E — Elevation of Privilege
Lateral movement via credentials through SaaS, agent permission escalation, VM cloning
for offline identity provider access, container escape chains, OAuth scope escalation.

---

## Framework References

Map findings to these where applicable:
- MITRE ATT&CK (conventional threats)
- MITRE ATLAS (AI/ML-specific threats)
- CWE (code/design weaknesses)
- OWASP Top 10: Web (2021), API (2023), LLM (2025), Agentic AI (2026)
- NIST CSF 2.0
- CAPEC (attack patterns)

---

## Sources

Statistics and incident data in this file are drawn from the following public reports:

- **CrowdStrike Global Threat Report (2025, 2026)**: Malware-free detection rates, eCrime
  breakout times, AI-enabled adversary growth, identity-first attack statistics
- **Mandiant M-Trends (2025, 2026)**: Initial infection vector distribution, median dwell
  times, supply chain compromise trends
- **MITRE ATT&CK and ATLAS knowledge bases**: Technique IDs, adversary group profiles
- **OWASP Foundation**: Top 10 lists for Web, API, LLM Applications, and Agentic AI
- **Industry incident disclosures**: OAuth supply chain breach (2025), s1ngularity build
  system compromise (Aug 2025), CamoLeak AI coding assistant vulnerability (2025),
  automotive manufacturer ransomware (Aug 2025), UK retail supply chain campaign (2025)
- **NIST National Vulnerability Database**: CVE counts for agentic AI systems
- **Academic research**: AI-generated phishing efficacy comparisons, polymorphic malware
  detection evasion studies, RAG poisoning research (250-document threshold)

Individual statistics should be verified against the original source reports for use in
formal compliance or audit documentation.
