
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

# /what-if: Downstream Impact Analysis

The most useful question in construction: "If we change this, what else changes?" This skill runs that analysis before you commit.

---

## Step 0: Load context

```bash
echo "=== PROJECT ==="
grep -E "^(name|project_type|current_phase):" .build-os/config.yaml

echo ""
echo "=== CURRENT BUDGET ==="
[ -f budget/estimate.md ] && head -25 budget/estimate.md

echo ""
echo "=== SCHEDULE ==="
[ -f schedule/master.md ] && head -20 schedule/master.md
```

---

## Step 1: Define the proposed change

Ask the owner to describe the change. It can be:
- A **material substitution** (cheaper windows, different roofing material, alternate flooring)
- A **scope addition** (adding a room, adding a feature)
- A **scope reduction** (cutting a bathroom, simplifying the kitchen)
- A **design change** (moving a wall, changing the roof pitch, reconfiguring the site plan)
- A **contractor substitution** (switching from GC A to GC B mid-project)
- A **schedule change** (delaying start, accelerating timeline)
- A **budget reallocation** (taking money from one trade to fund another)

Collect:
1. What specifically is changing?
2. Why is this change being considered? (cost pressure, owner preference, field condition, availability?)
3. What phase is the project in? (Earlier = more flexibility, later = more ripple)

---

## Step 2: Multi-role impact assessment

**Architect voice:** Evaluate from the perspective of a licensed senior architect with 20 years of residential and commercial experience. Focus on design intent, code compliance (IBC, IRC, local amendments), constructability, spatial quality, and long-term performance. Flag anything that will create an RFI, a change order, or a defect. Be direct about quality — "this works" or "this doesn't." No hedging.

**Design and code impact:**
- Does this change require revising drawings or specs?
- Does it require a permit revision or re-submittal? (A material change that affects fire rating, structural, or energy code can trigger a plan check revision)
- Does it affect adjacent systems? (Changing the window size affects rough framing, sill height, HVAC load, drywall quantities)
- Does it change the design intent in a way the owner would regret?
- What is the design verdict: does this change improve, maintain, or degrade the quality of the project?

**Estimator voice:** Evaluate from the perspective of a construction cost estimator with deep knowledge of current market pricing. Use $/SF benchmarks for the project type and region — be specific ("residential light framing in the Pacific Northwest runs $40-55/SF for labor and material"). Flag underestimated line items, scope missing from the estimate, and unpriced change orders.

**Cost impact:**
- What is the direct cost change? (Be specific: "+$X for the higher-spec material" or "-$Y saved on labor")
- What are the downstream cost ripples? (A smaller window saves $X but requires patching the rough opening for $Y — net may be less than expected)
- Does this change affect the contingency? (Changes late in construction carry higher risk of unintended consequences)
- Is there a timing penalty? (Changing a material after it's been ordered incurs restocking fees, re-ordering lead time costs)

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

**Schedule impact:**
- Does this change add time? (Material reorders, revised drawings, re-inspection)
- Does it affect the critical path?
- Are any subs already mobilized or materials already ordered? (Reversing that has a cost)
- What's the last responsible moment to make this change without penalty?

---

## Step 3: Verdict

Based on the three assessments, give a clear verdict:

**🟢 GO** — The change is net positive or neutral across all three dimensions. Make it.

**🟡 CAUTION** — The change has real trade-offs. Proceed only if the owner understands and accepts the specific downside: [state it explicitly]. Recommend logging a decision via `/decide` before proceeding.

**🔴 STOP** — The change would hurt the project in a way that outweighs the benefit. Specifically: [state the reason]. Recommend against proceeding unless [specific condition changes].

State the verdict clearly, then give the owner a path forward in each case.

---

## Step 4: Log if CAUTION or STOP

If the verdict is CAUTION and the owner wants to proceed anyway, or if it's STOP and they want to override: direct them to `/decide` to formally log the decision with the risks acknowledged.

This protects the owner: if the change causes a problem later, there's a documented record that the risk was known and accepted.
