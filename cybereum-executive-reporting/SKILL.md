---
name: cybereum-executive-reporting
version: 1.0.0
description: |
  Generates professional executive reports, status briefings, board presentations, and governance
  documents for capital projects. Produces DOCX, PPTX, or PDF-ready structured content following
  capital project reporting standards. Use this skill whenever a user asks to generate a project
  status report, executive summary, monthly report, owner report, board briefing, project dashboard
  narrative, PMO report, lender report, or any formal written communication about capital project
  performance. Also use for commissioning reports, phase completion reports, milestone reports, and
  investor briefings on capital programs.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Cybereum Executive Reporting

Professional report generation engine for capital project governance. Produces publication-ready content calibrated to the audience -- from PMO dashboards to lender reports to board briefings -- following AACE, PMI, and industry best-practice reporting standards.

---

## Report Type Selection

Identify the report type first:

| Report Type | Primary Audience | Key Sections | Typical Length |
|---|---|---|---|
| Monthly Progress Report | Owner / PMO | Status, EVM, Schedule, Risk, Actions | 8-15 pages |
| Executive Dashboard Narrative | Executive Leadership | Headlines, KPIs, Decisions Required | 2-3 pages |
| Board Briefing | Board of Directors | Program health, financials, major decisions | 10-15 slides |
| Lender/Investor Report | Lenders, Equity | Covenant compliance, forecast, risk | 5-10 pages |
| Phase Completion Report | Owner, Regulator | Scope achieved, lessons learned, next phase | 10-20 pages |
| Risk Report | PMO, Owner | Risk register, new risks, mitigation status | 5-8 pages |
| Commissioning Report | Operations, Owner | System completion, punch list, turnover | Variable |
| Milestone Briefing | Stakeholders | Milestone achieved, next milestone path | 2-3 pages |

---

## Step 1: Report Intake

Gather from the user:

1. **Report type** (from table above)
2. **Project name, type, location, phase**
3. **Reporting period** (e.g., "March 2026" or "Q1 2026")
4. **Key metrics available**: % complete, cost spent, schedule status, CPI, SPI
5. **Notable events this period**: Issues, decisions, milestones achieved
6. **Audience**: Technical / Executive / Financial / Regulatory
7. **Format needed**: DOCX / PPTX / narrative text

---

## Step 2: Structure Generation

### Monthly Progress Report Structure

```
1. EXECUTIVE SUMMARY
   - Project status indicator (Green / Yellow / Red)
   - Top 3 accomplishments this period
   - Top 3 challenges / issues
   - Forecast vs. baseline (1 sentence each: cost, schedule)

2. PROJECT STATUS OVERVIEW
   - Scope: % engineering, % procurement, % construction complete
   - Overall project % complete (weighted)
   - Key milestone status table

3. SCHEDULE PERFORMANCE
   - Current forecast vs. baseline completion
   - SPI / SPI(t) with trend
   - Critical path narrative
   - Near-critical risks

4. COST PERFORMANCE
   - Spent to date vs. plan
   - CPI with trend
   - EAC vs. BAC
   - Contingency remaining

5. PROCUREMENT STATUS
   - Long-lead equipment tracker
   - Purchase order status summary
   - Expediting concerns

6. RISK & OPPORTUNITY REGISTER (SUMMARY)
   - New risks this period
   - Closed risks
   - Top 5 active risks

7. HSE PERFORMANCE
   - Incident rates (TRIR, LTIR)
   - Notable safety events
   - Manhours worked

8. DECISIONS REQUIRED
   - Numbered list of decisions needed from Owner/Executive
   - Each with: Description, By Whom, By When, Consequence of Delay

9. ACTION ITEMS
   - Open actions from prior report (status)
   - New actions this period

10. NEXT PERIOD LOOKAHEAD
    - Key planned activities next 30/60/90 days
    - Upcoming milestones
    - Anticipated decisions
```

### Executive Dashboard Narrative Structure

```
PROJECT HEALTH: [GREEN / YELLOW / RED]

HEADLINE: [1 sentence -- most important thing to know right now]

THIS PERIOD
- [Accomplishment 1]
- [Accomplishment 2]
- [Issue / Challenge]

PERFORMANCE SNAPSHOT
  Schedule: [On track / X days behind / X days ahead]
  Cost:      [On budget / X% over / X% under -- EAC vs. BAC]
  Forecast:  [Completion date -- P50]

TOP RISK: [Single sentence on the highest risk item]

DECISION REQUIRED: [If any -- what, from whom, by when]
```

---

## Step 3: Content Generation Rules

### Writing Style for Capital Projects

**Use active voice:**
- Good: "The contractor completed structural steel erection on Unit 1."
- Bad: "Structural steel erection on Unit 1 was completed by the contractor."

**Quantify everything:**
- Good: "Overall project is 67% complete, 4 points behind the baseline of 71%."
- Bad: "The project is slightly behind schedule."

**Lead with performance, follow with cause:**
- Good: "The project is 8 days behind schedule, driven by a 3-week weather delay in civil works during February."
- Bad: "There was bad weather in February, which caused the project to fall behind."

**State decisions directly:**
- Good: "A decision is required by March 15 to authorize the additional $2.4M for foundation re-design."
- Bad: "There may need to be some additional funding approved at some point."

### Status Color Indicators

```
GREEN:  On track. No issues requiring escalation. CPI > 0.95, SPI > 0.95.
YELLOW: Watch status. One or more metrics off-track; corrective actions in place.
RED:    Off-track. Recovery plan required. CPI < 0.90 or SPI < 0.85 or milestone missed.
```

### Numerical Formatting Standards

- Cost: Report in $M to 1 decimal (e.g., "$142.5M")
- Percentages: Report to 1 decimal (e.g., "67.3% complete")
- Dates: Use full month name (e.g., "March 15, 2026")
- Indices: Report to 2 decimal places (CPI: 0.94)
- Days: Always state "working days" or "calendar days"

---

## Step 4: Audience Calibration

### For Executives / Board

- Eliminate all jargon. Replace with business language.
- Lead with financial exposure, not technical details.
- Every issue must connect to: "What does this mean for our budget and completion date?"
- Include "Decisions Required" as a prominent section.
- Maximum 1 page of text per topic.

### For Technical PMO / Engineers

- Include activity-level detail, logic analysis, index calculations.
- Use standard EVM and schedule terminology.
- Include root cause analysis, not just symptoms.
- Reference specific activity IDs, WBS codes, contract packages.

### For Lenders / Financial Stakeholders

- Emphasize covenant compliance (debt service coverage, drawdown milestones).
- Include contingency remaining vs. identified risks (coverage ratio).
- Reference independent engineer findings if available.
- Avoid acknowledging issues not already disclosed in loan documents without counsel review note.

### For Regulators (NRC, FERC, DoD)

- Use regulatory-specific terminology and reference class designations.
- State compliance status explicitly for each applicable requirement.
- Include open items log with due dates.

---

## Step 5: Report Assembly Protocol

1. **Draft Executive Summary last** -- after all sections are complete, the headline becomes clear
2. **Table formatting**: All performance tables should have: Metric | Baseline | Current | Variance | Trend
3. **Milestone table standard:**

```
Milestone | Baseline Date | Forecast Date | Variance | Status
```

4. **Action item table standard:**

```
# | Action | Owner | Due Date | Status | Notes
```

5. **Risk summary table standard:**

```
Rank | Risk | Probability | Impact | Score | Mitigation | Owner | Status
```

---

## Step 6: Document Creation

When creating the actual file:

- **DOCX**: Read the docx SKILL.md at `/mnt/skills/public/docx/SKILL.md` before generating
- **PPTX**: Read the pptx SKILL.md at `/mnt/skills/public/pptx/SKILL.md` before generating
- **PDF**: Read the pdf SKILL.md at `/mnt/skills/public/pdf/SKILL.md` before generating

Apply Cybereum visual identity:

- Primary color: Dark navy `#0A0E1A` / Electric blue `#00D4FF`
- Secondary: Slate gray `#1E2440`
- Accent: Amber `#FFB800` for warnings; Red `#FF3B30` for critical
- Font: Headers in bold sans-serif; body in clean sans-serif
- Logo: Include Cybereum wordmark in header if branding applies

---

## Cross-Skill Integration

Executive Reporting integrates with all other Cybereum skills to pull live analysis:

- **Schedule Intelligence**: Pull DCMA 14-Point scorecard and critical path narrative for Schedule section
- **EVM Control**: Pull CPI/SPI dashboard and EAC forecast for Cost section
- **Risk Engine**: Pull top 5 risks and mitigation status for Risk section
- **Completion Prediction**: Pull P50/P80 forecast dates for Forecast section
- **Decision-AI**: Pull Schwerpunkt and corrective actions for Decisions Required section
- **Reference Class**: Pull optimism bias assessment for Lender/Investor reports

When generating a report, invoke the relevant skill analysis before writing each section.

---

## Reference Files

- `references/reporting-standards.md` -- AACE RP 11R-88 Progress and Performance reporting
- `references/executive-writing-guide.md` -- Capital project executive communication principles
- `references/sector-report-templates.md` -- Report templates by sector: Nuclear, EPC, Defense, Infrastructure
- `assets/cybereum-report-template.md` -- Base template with Cybereum formatting

---

## Quality Checklist (Before Finalizing)

- [ ] Every metric has a baseline for comparison
- [ ] Every issue has a mitigation or decision linked
- [ ] Status color matches the narrative (no "GREEN" with unmitigated critical path slip)
- [ ] Decisions Required section is complete and specific
- [ ] All numbers cross-reference (EAC in narrative = EAC in table)
- [ ] Reading level appropriate for stated audience
- [ ] No passive voice in executive sections
- [ ] Dates are specific, not relative ("by end of Q2" -> "by June 30, 2026")
