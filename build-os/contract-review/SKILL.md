
## Project Context

Run this to load the current project state:

```bash
if [ ! -f .build-os/config.yaml ]; then
  echo "ERROR: Not in a build-os project. cd into a project folder or run /kickoff first."
  exit 1
fi

echo "=== PROJECT CONFIG ==="
cat .build-os/config.yaml
echo ""

# Slug for global state access
_NAME=$(grep "^name:" .build-os/config.yaml | sed 's/^name: *//' | tr -d '"'"'"')
_SLUG=$(echo "${_NAME}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | tr -s '-' | sed 's/^-\|-$//g')

echo "=== RECENT DECISIONS ==="
_DEC="${HOME}/.build-os/projects/${_SLUG}/decisions.jsonl"
if [ -f "${_DEC}" ] && [ -s "${_DEC}" ]; then
  echo "($(wc -l < "${_DEC}" | xargs) total, showing last 3)"
  tail -3 "${_DEC}"
else
  echo "No decisions logged yet."
fi
```

Use the project state above throughout this session. Do not ask the owner for information already in the config.

```bash
echo "=== BUDGET STATUS ==="
if [ -f budget/estimate.md ]; then
  head -35 budget/estimate.md
else
  _B=$(grep "^budget:" .build-os/config.yaml | sed 's/^budget: *//' | tr -d '"'"'"')
  echo "Original budget: $${_B} — no estimate file yet (run /cost-check to initialize)"
fi
```

# /contract-review: Contract Risk Review

**Important:** This is a risk-flagging tool, not legal advice. For contracts over $50K or with unusual terms, the owner should also have an attorney review before signing.

---

## Step 1: Receive the contract

Ask the owner to paste the contract text or describe the key terms. Accepted input:
- Full contract text (paste directly)
- Contractor proposal or scope letter
- AIA contract (state which form: A101, A102, A201, etc.)
- Summary of key terms if full text isn't available

For each document reviewed, note: what type of contract is this (lump sum, cost-plus, T&M, GMP)?

---

## Step 2: Scope review

**Estimator voice:** Evaluate from the perspective of a construction cost estimator with deep knowledge of current market pricing. Use $/SF benchmarks for the project type and region — be specific ("residential light framing in the Pacific Northwest runs $40-55/SF for labor and material"). Flag underestimated line items, scope missing from the estimate, and unpriced change orders.

Evaluate the scope of work section:

**Clarity:**
- Is the scope specific enough that disputes about what's included are unlikely?
- Any ambiguous language ("as directed," "as required," "similar to") that could generate change orders?
- Are the specification sections and drawing sets referenced by name and revision date?

**Exclusions:**
- What does the contract explicitly exclude? Are any of those exclusions surprising or problematic?
- Are "by owner" items clearly listed? Is the owner actually prepared to provide them?

**Allowances:**
- Are allowances clearly defined with dollar amounts?
- Are the allowance amounts realistic, or are they "low-ball" numbers that will generate change order claims?

**Unit prices:**
- For renovation or uncertain-scope work: does the contract include unit prices for variable items?

**Change order process:**
- Is the change order process defined? (How are changes initiated? What's the markup on labor and material?)
- Is there a time limit on submitting change orders? (Some contracts require notice within 48-72 hours)

---

## Step 3: Design responsibility review

**Architect voice:** Evaluate from the perspective of a licensed senior architect with 20 years of residential and commercial experience. Focus on design intent, code compliance (IBC, IRC, local amendments), constructability, spatial quality, and long-term performance. Flag anything that will create an RFI, a change order, or a defect. Be direct about quality — "this works" or "this doesn't." No hedging.

Evaluate design responsibility and construction documentation:

**Drawing responsibility:**
- Are the drawings and specs explicitly listed as contract documents?
- Is design responsibility clearly allocated? (Who is responsible for coordination between trades?)
- Shop drawings and submittals: is the review process defined? Who reviews, what's the turnaround?

**RFI process:**
- Is there an RFI process defined? Who can issue RFIs? What's the required response time?
- Is the architect's role in RFI responses defined, or are they routed only to the owner?

**Substitutions:**
- Are the conditions for material substitutions clearly defined? (Substitutions should require written approval)

**Means and methods:**
- Does the contract inappropriately delegate design responsibility to the contractor? ("Contractor shall design and install [system]" without specification is a red flag)

---

## Step 4: Commercial terms review

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

Evaluate schedule, payment, and risk allocation:

**Schedule:**
- Is the contract start date and completion date specified?
- Is there a liquidated damages clause? (If yes: is the daily amount reasonable? Is there a cap?)
- Are milestone dates defined? (Important for phased projects)
- Is force majeure defined? (COVID-era contracts often have unusually broad force majeure clauses)

**Payment:**
- Payment terms: net 30? Net 10? Pay-when-paid (common in subcontracts, owner-unfavorable)?
- Retainage: what percentage, when released? (Standard: 10% held until substantial completion, then 5%)
- Final payment conditions: what triggers final payment? Certificate of occupancy? Punch list completion?
- Lien release: is a lien waiver required before each payment?

**Termination:**
- Termination for convenience: does the owner have the right to terminate? At what cost?
- Termination for cause: what constitutes cause? What's the cure period?

**Insurance and bonding:**
- Are insurance requirements specified? Do they match what was in the RFP?
- Is a performance bond or payment bond required? (Worth considering for contracts over $100K)

**Warranty:**
- What is the warranty period? (1 year minimum for new construction, some jurisdictions require more)
- Is the warranty on workmanship? Materials? Both?

---

## Step 5: Risk summary

Produce a risk summary:

```markdown
## Contract Risk Summary — [Contractor] — [Date]

### HIGH RISK (must resolve before signing)
- [Clause/section]: [Issue] → [Suggested fix]
- [Clause/section]: [Issue] → [Suggested fix]

### MEDIUM RISK (negotiate if possible)
- [Clause/section]: [Issue] → [Suggested language or approach]

### LOW RISK (note for reference)
- [Observation]

### Missing entirely (should be added)
- [Term that's absent and should be present]

### Overall assessment
[One paragraph: is this contract appropriate for the scope and risk profile? Any deal-breakers?]
```

---

## Step 6: Save and next steps

Write the risk summary to `contracts/executed/review-[contractor]-[date].md`.

Tell the owner:
1. Number of HIGH, MEDIUM, LOW items
2. Whether this contract is safe to sign as-is, or requires negotiation
3. The 1-2 most important items to push back on
4. Whether an attorney review is recommended given contract size and risk level
