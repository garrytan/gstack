# Referral System — Example Outputs

This shows what you'd actually see when you call each tool, using your real account types as examples.

---

## 1. Score a Single Account

**Tool:** `referral_scorer_score_account { "accountId": "..." }`

```
# Readiness Score: Stripe

**Score: 87/100 — HOT**

## Dimension Breakdown
| Dimension             | Score | Max | Notes                              |
|-----------------------|-------|-----|------------------------------------|
| Value Delivered       | 22    | 25  | CS Health: 92, NPS: 9, Usage: growing |
| Relationship Strength | 18    | 20  | C-suite sponsor, last interaction 5d ago |
| Recency of Win        | 17    | 20  | Expansion closed 3 weeks ago       |
| Network Value         | 16    | 20  | Network reach: 85, 4 former companies |
| Ask History           | 14    | 15  | 1 prior ask, positive response     |

## Active Triggers
- Expansion closed: $340K upsell (2 weeks ago)
- NPS score: 9/10 submitted (1 week ago)

## Anti-Triggers: None

## Recommendation
This account is HOT. The recent expansion and high NPS create a
strong ask window. Recommend a live ask within the next 14 days
before the value moment fades.
```

---

## 2. Score the Full Portfolio

**Tool:** `referral_scorer_score_portfolio {}`

```
# Portfolio Readiness Report

**Total:** 10 | **Hot:** 3 | **Warm:** 4 | **Not Yet:** 3

## Hot Accounts (Ready for Ask)
- **Stripe** — Score: 87, Champion: Sarah Chen (CTO), Trigger: Expansion closed $340K
- **Datadog** — Score: 82, Champion: Mike Torres (VP Eng), Trigger: QBR positive
- **Notion** — Score: 80, Champion: Lisa Park (Head of Ops), Trigger: NPS 9/10

## Warm Accounts (Nurture)
- **Figma** — Score: 72, Champion: Alex Rivera (Director Product)
- **Linear** — Score: 68, Champion: James Wu (VP Engineering)
- **Vercel** — Score: 61, Champion: Emma Davis (CTO)
- **Retool** — Score: 57, Champion: David Kim (Director Eng)

## Not Yet (3 accounts)
- Raycast — Score: 42
- Loom — Score: 35
- Pitch — Score: 28
```

---

## 3. Full Analysis (One Click — All Agents)

**Tool:** `orchestrator_run_full_analysis { "accountId": "..." }`

This chains all 9 agents together. Here's what comes back:

```
═══ FULL ANALYSIS: Stripe ═══
Run at: 2026-05-01T14:30:00Z | Duration: 2340ms

── PHASES ──
  ✓ data_gathering (120ms): Loaded 1 account, 2 champions, 4 triggers, 3 referrals
  ✓ readiness_scoring (85ms): Scored 87/100 (HOT) with PCP boost +5
  ✓ relationship_mapping (340ms): Mapped 12 connections, 3 warm paths
  ✓ success_dashboard (180ms): 3 active deals — 2 healthy, 1 at risk
  ✓ executive_summary (1615ms): Generated briefing via Claude

── READINESS ──
  Score: 87/100 (hot) [includes PCP boost: +5]

── TOP CHAMPIONS ──
  1. Sarah Chen (CTO) — 87 pts
  2. Jason Park (VP Engineering) — 71 pts

── TOP TARGETS ──
  1. Maria Garcia @ Figma — score 92, via Sarah Chen (former colleague)
  2. Tom Wright @ Vercel — score 85, via Jason Park (LinkedIn, same YC batch)
  3. Amy Liu @ Linear — score 78, via Sarah Chen (board connection)

── PORTFOLIO OPPORTUNITIES ──
  1. Notion (PE portfolio) — combined score: 88
  2. Ramp (shared investor: Sequoia) — combined score: 76

── PIPELINE HEALTH ──
  Total: 3 deals
  Healthy: 2 | At Risk: 1 | Stalled: 0 | Critical: 0

── COHORT COMPARISON ──
  Referral win rate: 62.5%
  Outbound win rate: 18.3%
  Speed advantage: 34.2 days faster

── RECOMMENDED ACTIONS ──
  → Ask Sarah Chen for intro to Maria Garcia at Figma (score 92, former colleague)
  → Follow up on at-risk deal: Acme Corp (18 days inactive)
  → Schedule QBR with Jason Park to strengthen relationship before ask
  → Explore Sequoia portfolio connection to Ramp

── EXECUTIVE BRIEFING ──
Stripe is your #1 referral-ready account. Sarah Chen's recent expansion
($340K) and NPS 9 create a strong ask window. Her former colleague Maria
Garcia at Figma is the highest-value target — Figma fits your ICP perfectly
(mid-market SaaS, 500+ employees, Series C). Recommend a live ask this week.

One deal (Acme Corp) needs attention — 18 days without activity. Reach out
to the AE to unblock. Overall pipeline from Stripe referrals has generated
$620K in the last 6 months with a 62.5% win rate vs 18.3% outbound.
```

---

## 4. Quick Health Check

**Tool:** `orchestrator_quick_health { "accountId": "..." }`

```
Stripe — Quick Health Check
Readiness: 87 (hot)
Pipeline: 3 deals (2H/1R/0S/0C)
Champions: 2 scored
Top action: Ask Sarah Chen for intro to Maria Garcia at Figma
```

---

## 5. Compose a Referral Ask (3 Versions)

**Tool:** `referral_ask_compose { "championId": "...", "connectionMapId": "..." }`

```
# Referral Ask: Sarah Chen → Maria Garcia at Figma

**Recommended Version:** LIVE
**Reason:** Strong relationship + recent expansion = best as in-person/call ask

---

## Live Ask (Script)

"Sarah, I wanted to say congratulations on the expansion — the team's
results with [your product] have been incredible. The 40% efficiency
gain your team saw is exactly the kind of outcome that gets me excited.

I actually wanted to ask you something. I noticed you used to work with
Maria Garcia at Figma. We've been seeing a lot of companies like Figma
face similar challenges to what your team had before we started working
together. Do you think she'd be open to a quick conversation? I'd love
to see if we could help them the way we helped you.

No pressure at all — I just thought of her because of how similar their
situation seems to yours."

**Key Mechanics:** Social proof anchor | Specific results | Easy opt-out

---

## Async Ask (Email/Slack)

**Subject:** Quick question — your former colleague at Figma

Sarah — congrats again on the expansion, well deserved.

Quick question: I noticed you used to work with Maria Garcia at Figma.
Given the results your team has seen (40% efficiency gain), I think her
team could benefit from a similar approach.

Would you be open to making a quick intro? Happy to draft something you
can forward if that's easier.

Either way, appreciate you — no pressure at all.

**Key Mechanics:** Low-friction forward | Specific value prop | Easy decline

---

## Soft Seed

"Sarah, totally unrelated — do you still keep in touch with Maria Garcia
at Figma? I've been hearing some interesting things about their growth."

**Key Mechanics:** Casual plant | No direct ask | Opens future conversation
```

---

## 6. Handle the Response

**Tool:** `referral_ask_handle_response { "referralId": "...", "response": "yes" }`

```
# Response: YES — Intro Sequence

## Suggested Intro Email (for Sarah to forward)

Subject: Connecting you with [Your Company] — re: AI adoption

Maria — wanted to connect you with [name] from [company]. We've been
working together for 2 years and the results have been great (40%
efficiency gain on our eng team).

I thought it might be worth a quick chat given what you're building at
Figma. No pressure — just thought there could be a good fit.

## Next Steps
1. Send Sarah the draft intro within 24 hours
2. Let Sarah customize and forward at her pace
3. Once Maria responds, book a 25-minute discovery call
4. Update referral status to "intro_sent"
```

---

## 7. Pipeline Health Dashboard

**Tool:** `success_pipeline_health {}`

```
# Pipeline Health Dashboard
**Active Deals:** 8 | **Critical:** 1 | **Stalled:** 2 | **At Risk:** 1 | **Healthy:** 4

### Acme Corp (via Stripe)
**Health:** 42/100 — AT RISK | **Status:** meeting_booked | **Days Inactive:** 18
- No activity since initial meeting
- Champion has not responded to last follow-up
- Deal size ($85K) aligns with ICP
**Action:** Re-engage champion Sarah Chen — ask for context on Acme's timeline

### CloudCo (via Datadog)
**Health:** 28/100 — CRITICAL | **Status:** opportunity_created | **Days Inactive:** 31
- Opp created but no movement in 31 days
- AE has not logged any activity
- Risk of deal going cold
**Action:** Escalate to AE manager — deal needs immediate re-engagement or close

### TechStart (via Notion)
**Health:** 91/100 — HEALTHY | **Status:** opportunity_created | **Days Inactive:** 3
- Strong momentum, demo completed
- Positive email exchange with champion
- Expected close: 2 weeks
**Action:** Prepare contract — deal on track
```

---

## 8. Cohort Analysis: Referral vs Outbound

**Tool:** `success_cohort_analysis {}`

```
# Cohort Analysis: Referral vs Outbound
**Period:** Last 12 months

## Performance by Source
| Metric            | Referral | Outbound |
|-------------------|----------|----------|
| Deals             | 24       | 156      |
| Pipeline          | $2,840,000 | $8,200,000 |
| Avg Deal Size     | $118,333 | $52,564  |
| Win Rate          | 62.5%    | 18.3%    |
| Avg Days to Close | 28       | 62       |
| Closed Won        | 15       | 29       |
| Open Deals        | 6        | 84       |

## Referral Advantage
- **Win Rate:** 3.4x higher than outbound
- **Speed:** 34 days faster to close
- **Deal Size:** 2.3x larger than outbound
- **CAC Reduction:** 78% lower than outbound
```

---

## 9. PCP Power-Law Analysis

**Tool:** `pcp_analyze_distribution {}`

```
# Power-Law Distribution Analysis
**Name:** Q1 2026 Analysis
**Analysis ID:** abc-123-def

## Revenue Concentration
| Tier                   | Accounts | % Revenue |
|------------------------|----------|-----------|
| Power Law (top 3%)     | 1        | 38.2%     |
| High Value (next 7%)   | 1        | 22.8%     |
| Core (next 40%)        | 4        | 31.4%     |
| Long Tail (bottom)     | 4        | 7.6%      |

**Gini Coefficient:** 0.742 (1.0 = maximum concentration)

## Top Power-Law Accounts
- **Stripe** — $2,400,000 (38.2% of total)

## Empirical ICP Weights (Top 10)
- **industry=SaaS** — Lift: 3.20x
- **employee_count=500-2000** — Lift: 2.85x
- **funding_stage=Series C+** — Lift: 2.40x
- **tech_stack=React** — Lift: 1.95x
- **region=US West** — Lift: 1.72x

**Next step:** Run `pcp_score_target` to score prospects against these weights.
```

---

## 10. Incentive Package Design

**Tool:** `referral_incentive_design_package { "company_name": "Whale Boss", ... }`

```
# Incentive Package: Whale Boss

## Primary Reward
- **Category:** Recognition
- **Description:** Exclusive "AI Pioneer" badge + feature in customer spotlight
- **Estimated Cost:** $250
- **Timing:** Delivered when intro is made

## Secondary Reward
- **Category:** Access
- **Description:** Early access to new features + quarterly strategy session with founder
- **Estimated Cost:** $500
- **Timing:** Delivered when referred deal closes

## Economics
- **Total Cost Per Referral:** $750
- **Reward Ceiling:** $3,600 (30% of outbound CAC)
- **CAC Savings:** 94%

## Ongoing Benefits
- Priority support queue
- Annual customer advisory board invitation
- Co-marketing opportunity (joint case study)

## Escalation Path
- **Referral #1:** Base package (1x)
- **Referral #3:** Add revenue share on first year (1.5x)
- **Referral #5:** Platinum tier — named partner benefits (2x)

## Language Guidance
**Use:** "thank you gift", "recognition", "our way of saying thanks"
**Avoid:** "commission", "payment", "bounty", "finder's fee"
```

---

## 11. Monthly Report

**Tool:** `referral_pm_generate_report { "type": "monthly_health" }`

```
# Monthly Health Report — April 2026

## Portfolio Health
- **Total Accounts:** 10
- **Hot:** 3 (30%)
- **Warm:** 4 (40%)
- **Not Yet:** 3 (30%)

## Activity
- **Asks Made:** 5
- **Intros:** 3 (60% from asks)
- **Meetings:** 2 (67% from intros)
- **Pipeline Value:** $245,000

## Lifetime
- **Closed Won:** $1,840,000
- **Referral CAC:** $750 vs Outbound: $12,000
- **Avg Time to Close:** 28 days

## Actions Next Month
- Ask Stripe champion Sarah Chen (score 87, expansion trigger)
- Re-engage stalled deal at CloudCo (31 days inactive)
- Schedule QBR with Linear to move from Warm → Hot
- Enrich Figma champion network (high-value target)
```

---

## 12. Data Sync Output

**Command:** `bun run sync`

```
🔍 DRY RUN — no data will be written

━━━ HubSpot Sync ━━━
  Fetching companies... 47 found
  Fetching contacts... 128 found
  Fetching deals... 83 found
  Synced 47 accounts, 128 champions, 83 deals, 12 triggers

━━━ Fathom Sync ━━━
  Fetching Fathom calls...
  Found 234 calls
  Processed 234 calls, created 67 signals, updated 45 champions
  ⚠ 12 unmatched participant emails (not in champions table)

━━━ Google Sheets Sync ━━━
  Fetching survey responses...
  Found 89 survey responses
  Processed 89 surveys, found 31 referrals
  Fetching referral tracking sheet...
  Found 22 referral entries
  Processed 22 entries, created 18 referrals

━━━ Sync Summary ━━━
  HubSpot: 47 accounts, 128 champions, 83 deals, 12 triggers
  Fathom: 234 calls, 67 signals, 45 champions updated
  Sheets: 89 surveys (31 referrals), 22 referral entries
  Duration: 8.3s
```

---

## 13. Webhook Response

**POST** `http://localhost:3001/webhook`

```json
{
  "event": "deal.closed_won",
  "processed": true,
  "actions": [
    "Created trigger event: expansion_closed for Stripe",
    "Re-scored 2 champions on account",
    "Sarah Chen: readiness moved 72 → 87 (HOT)",
    "Sent notification to #referrals channel"
  ]
}
```

---

## How to Access These Tools

### Option A: MCP Inspector (visual, good for testing)
```bash
npx @modelcontextprotocol/inspector
# Then start: bun run dev
# Browse tools in the inspector UI
```

### Option B: Claude Desktop / Cursor (conversational)
Add to your MCP config:
```json
{
  "referral-system": {
    "command": "bun",
    "args": ["run", "dev"],
    "cwd": "/path/to/referral-system"
  }
}
```
Then ask Claude: *"Score my portfolio for referral readiness"* and it calls the tools for you.

### Option C: HTTP API (for automation)
```bash
MCP_TRANSPORT=streamable_http bun run dev
# Then POST to http://localhost:3001/mcp
```
