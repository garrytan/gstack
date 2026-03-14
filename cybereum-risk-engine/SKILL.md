---
name: cybereum-risk-engine
version: 1.0.0
description: |
  Identifies, classifies, scores, and generates mitigation strategies for capital project risks
  including external risks (geopolitical, regulatory, supply chain, weather, labor market, commodity
  price) and internal risks (design maturity, contractor performance, procurement status, resource
  availability). Use this skill whenever a user asks to identify risks, run a risk assessment, build
  a risk register, generate project-specific risks, evaluate risk exposure, calculate risk-adjusted
  contingency, or asks "what risks should we be worried about" on any EPC, energy, infrastructure,
  nuclear, defense, or infrastructure capital project. Also use for risk pipeline generation, risk
  scoring, and risk-based schedule contingency.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Cybereum Risk Engine

AI-powered risk intelligence for capital projects. Combines LLM-driven external risk generation with structured internal risk assessment to produce a project-specific, actionable risk register calibrated to AACE, PMI, and DoD risk management standards.

---

## Risk Taxonomy

Cybereum classifies risks across two primary axes:

### External Risks (Outside Project Control)

| Category | Examples |
|----------|----------|
| Geopolitical | Sanctions, trade restrictions, export controls, country risk |
| Regulatory & Permitting | Environmental permits, NEPA, FERC, NRC, local zoning |
| Supply Chain | Long-lead equipment, material shortages, single-source dependencies |
| Commodity Price | Steel, copper, cement, rare earth, fuel |
| Labor Market | Craft labor availability, wage inflation, union actions |
| Climate & Weather | Extreme weather windows, hurricane season, permafrost |
| Technology | Emerging technology performance risk, obsolescence |
| Financial Market | Financing availability, interest rate changes, FX exposure |

### Internal Risks (Within Project Sphere)

| Category | Examples |
|----------|----------|
| Design Maturity | IFC completeness %, design changes, interdisciplinary conflicts |
| Contractor Performance | Schedule adherence, quality non-conformances, workforce productivity |
| Procurement | Long-lead status, expediting effectiveness, vendor qualification |
| Scope Definition | Scope gaps, change order volume, owner-supplied items |
| Estimating | Basis of estimate confidence, contingency adequacy, scope inclusions |
| Integration | Interfaces between packages, system tie-ins, commissioning readiness |
| Organizational | Staffing gaps, decision authority, owner-contractor alignment |

---

## Step 1: Project Context Intake

Before generating risks, establish:

1. **Project type**: Oil & gas / Power / Nuclear / Infrastructure / Defense / Data center
2. **Phase**: FEED / Detailed Engineering / Procurement / Construction / Commissioning
3. **Location**: Country, region, site conditions
4. **Scale**: TIC estimate range, duration, workforce peak
5. **Key constraints**: Fixed completion date, permitting milestones, regulatory approvals pending
6. **Existing risk register**: If provided, extend it; if not, generate from scratch

---

## Step 2: External Risk Generation (LLM Pipeline)

Generate project-specific external risks by reasoning across all eight external categories.

**For each risk, produce:**

```
Risk ID | Category | Risk Description | Trigger Conditions |
Probability (1-5) | Impact (1-5) | Risk Score (PxI) |
Early Warning Indicators | Mitigation Strategy | Owner | Status
```

**Risk generation prompt pattern:**

```
For a [project type] in [location] currently in [phase]:
- What supply chain risks are most likely given current market conditions?
- What regulatory/permitting risks exist for this project type?
- What commodity price exposures affect the critical cost accounts?
- What labor market conditions create workforce risk?
```

Generate minimum 15 external risks. Flag the top 5 by risk score as **Priority External Risks**.

---

## Step 3: Internal Risk Assessment

Assess internal risks based on project data provided:

### Design Maturity Risk Matrix

```
IFC Completeness | Risk Level | Contingency Implication
>90%            | Low        | 5-8% on remaining scope
70-90%          | Moderate   | 8-15%
50-70%          | High       | 15-25%
<50%            | Critical   | 25-40%+
```

### Contractor Performance Scoring

- SPI < 0.90: Flag as High performance risk
- Productivity factor < 0.80: Flag as Critical
- NCR rate trending up: Flag as Quality risk
- Labour turnover > 20%: Flag as workforce stability risk

### Procurement Risk Assessment

For each long-lead item:

```
Equipment | Vendor | Lead Time | Current Status | Float on Path |
Risk Level | Action Required
```

Flag any long-lead item where: Lead Time > Float on driving path

---

## Step 4: Risk Scoring and Prioritization

### Probability x Impact Matrix

```
        Impact
P       1 (Negligible) | 2 (Minor) | 3 (Moderate) | 4 (Major) | 5 (Catastrophic)
5 (VH)     5               10           15             20            25
4 (H)      4                8           12             16            20
3 (M)      3                6            9              12           15
2 (L)      2                4            6               8           10
1 (VL)     1                2            3               4            5
```

Priority risks (score >= 12) require active mitigation.

### Risk-Adjusted Contingency

Calculate P50 and P80 contingency reserve using simplified Monte Carlo approach:

```
P50 Contingency = Sum(Risk Score x Estimated Cost Impact) x 0.5
P80 Contingency = Sum(Risk Score x Estimated Cost Impact) x 0.8
Apply to: TIC estimate as % contingency line
```

---

## Step 5: Mitigation Strategy Generation

For each Priority Risk (score >= 12), generate:

1. **Mitigation action**: Specific, executable step to reduce probability or impact
2. **Contingency plan**: What to do if the risk materializes
3. **Early warning trigger**: The observable signal that activates contingency
4. **Owner**: Role responsible for mitigation execution
5. **Due date**: When mitigation must be implemented to remain effective

**Mitigation quality check:**

- Does it address root cause or just symptom?
- Is it within project team's control?
- Does it have a measurable outcome?
- Is the cost of mitigation less than the expected risk value?

---

## Step 6: Risk Register Output

Produce a structured risk register in this format:

### Executive Risk Summary

- Total risks identified: [N]
- Priority risks (score >= 12): [N]
- Risk-adjusted contingency recommendation: [P50: $X | P80: $Y]
- Top 3 risks requiring immediate owner action

### Risk Register Table

Full table with all fields per Step 2

### Risk Heatmap Description

Text-based 5x5 matrix showing risk distribution

### Mitigation Action Plan

For priority risks only -- owner, action, due date, status

---

## Sector-Specific Risk Libraries

### Nuclear (NRC-regulated)

High-priority sectors: Design certification, quality assurance program, ITAAC completion, supplier qualification, NRC inspection findings

### Defense / DoD Programs

High-priority sectors: Export control (ITAR/EAR), clearance requirements, government furnished equipment (GFE), DCAA audit exposure, CDRL deliverables

### Energy Infrastructure (FERC/NEPA)

High-priority sectors: ROW acquisition, environmental permits, interconnection queue, off-take agreement execution

### EPC / Industrial

High-priority sectors: Module fabrication quality, vendor-supplied engineering, multi-contract interface, productivity benchmarks

---

## Reference Files

- `references/risk-taxonomy-detail.md` -- Expanded risk category definitions and examples
- `references/contingency-methodology.md` -- AACE RP 40R-08 contingency determination
- `references/sector-risk-libraries.md` -- Nuclear, defense, energy, EPC sector-specific risks
- `references/early-warning-indicators.md` -- KPI thresholds that signal emerging risks

---

## Two-Pass Risk Review Protocol

Apply risk findings in two severity tiers (adapted from review checklist pattern):

**Pass 1 -- CRITICAL (requires immediate mitigation):**
- Any risk with score >= 16 (High probability x Major/Catastrophic impact)
- Negative float driven by risk materialization
- Single-source procurement dependencies on critical path
- Regulatory compliance gaps with deadline exposure
- Safety/environmental risks with no mitigation in place

**Pass 2 -- MONITORING (track and prepare):**
- Risks with score 9-15
- Emerging risks identified but not yet scored
- Risks with mitigations in place but approaching trigger thresholds
- Market/commodity risks requiring hedge decisions

Output format:
```
Risk Review: N risks (X critical, Y monitoring)

**CRITICAL** (immediate action):
- [RISK-ID] Risk description (Score: PxI = XX)
  Mitigation: specific action required
  Owner: [role] | Due: [date]

**MONITORING** (track):
- [RISK-ID] Risk description (Score: PxI = XX)
  Early warning: [indicator to watch]
```

---

## Risk Register History & Trends

Persist risk assessments for trend tracking:

```bash
mkdir -p .cybereum/risk-snapshots
```

Save as `.cybereum/risk-snapshots/{project-slug}-{YYYY-MM-DD}.json`:

```json
{
  "date": "2026-03-14",
  "project": "Project Name",
  "total_risks": 42,
  "critical_risks": 5,
  "monitoring_risks": 12,
  "closed_since_last": 3,
  "new_since_last": 7,
  "p50_contingency": 12500000,
  "p80_contingency": 18200000,
  "top_risk": "Long-lead transformer delivery delay",
  "risk_score_distribution": { "1-4": 15, "5-8": 10, "9-15": 12, "16-25": 5 }
}
```

When prior snapshots exist, show risk trend:
```
                    Last        Now         Delta
Total Risks:        38     ->    42         +4 (growing)
Critical:           3      ->    5          +2 (escalating)
Contingency (P80):  $15.2M ->   $18.2M     +$3.0M
New Risks:          --     ->    7          7 new this period
Closed Risks:       --     ->    3          3 resolved
```

---

## Output Modes

**Quick Scan**: Top 10 risks, 1-line each, with score. Under 2 minutes.

**Full Register**: Complete risk register with mitigations. For project setup or periodic review.

**Risk Update**: Compare current risks to previous register. Flag new risks, closed risks, score changes.

**Contingency Justification**: Formal AACE-style contingency memo for budget approval.
