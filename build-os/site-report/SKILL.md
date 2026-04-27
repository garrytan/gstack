
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

# /site-report: Site Visit Report

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

---

## Step 0: Identify the visit

```bash
echo "=== PROJECT ==="
grep -E "^(name|project_type|current_phase):" .build-os/config.yaml

echo ""
echo "=== PREVIOUS SITE REPORTS ==="
ls construction/site-reports/ 2>/dev/null | tail -5 || echo "None yet"

echo ""
echo "=== OPEN RFIS ==="
if [ -f construction/rfi-log.md ]; then
  grep -i "open\|pending" construction/rfi-log.md 2>/dev/null | head -10 || echo "None open"
else
  echo "No RFI log yet"
fi

echo ""
echo "=== SUBMITTALS ==="
if [ -f construction/submittals.md ]; then
  grep -i "pending\|outstanding" construction/submittals.md 2>/dev/null | head -10 || echo "None pending"
fi
```

Ask the owner: What was the date of this site visit? Who was present?

---

## Step 1: Visit observations

Ask the owner to describe what they saw. Useful prompts:
- What work was completed since the last visit?
- What is currently in progress?
- Any work that looks wrong, out of sequence, or of concern?
- Any areas of the site that are behind schedule?
- Any safety issues observed?
- Any changes the GC or subs are proposing informally? (These are potential change orders)

If the owner has photos, ask them to describe key photos (what they show and where on site).

---

## Step 2: PM analysis

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

Based on the observations:

**Schedule status:**
- Is the work progressing at the pace needed to hit the next milestone?
- Any trades that appear behind? Any idle time on site?
- What's on the critical path right now?

**Contractor management flags:**
- Any work that needs to be corrected before it's covered up?
- Any GC coordination failures (trades not sequenced, work blocking other trades)?
- Any verbal change requests from the GC that haven't been formally submitted?
- Any material delivery delays mentioned?

**Open items from last report:**
```bash
if ls construction/site-reports/*.md 2>/dev/null | head -1 | xargs -I{} head -50 {} 2>/dev/null; then
  echo "Check open items from last report above"
fi
```
For each item carried from the previous report: is it resolved, still open, or escalated?

---

## Step 3: Architect notes (if applicable)

If there are open RFIs or the visit revealed design questions:

**Architect voice:** Evaluate from the perspective of a licensed senior architect with 20 years of residential and commercial experience. Focus on design intent, code compliance (IBC, IRC, local amendments), constructability, spatial quality, and long-term performance. Flag anything that will create an RFI, a change order, or a defect. Be direct about quality — "this works" or "this doesn't." No hedging.

For any field conditions that don't match the drawings or that raise design questions:
- Is this an RFI? (Requires a written response — use `/rfi` to create it)
- Is this a scope change? (Requires a decision — use `/decide`)
- Is this a contractor error that needs correction? (Note it in the report with a deadline)

---

## Step 4: Write the site report

Write to `construction/site-reports/site-report-[YYYY-MM-DD].md`:

```markdown
# Site Report — [Date]
**Project:** [Project Name] | **Phase:** [Phase] | **Visit #:** [N]
**Present:** [Owner, GC name, others]
**Weather:** [brief]

---

## Work Completed Since Last Visit
- [item]
- [item]

## Work In Progress
- [item — with % complete estimate if available]

## Observations and Concerns
- [observation] — [action required / no action / RFI / decision needed]
- [observation] — [action required / no action / RFI / decision needed]

## Schedule Assessment
[ON TRACK / AT RISK / DELAYED] — [one sentence reason]
Next milestone: [what] by [date]

## Open Items
| # | Item | Owner | Due | Status |
|---|------|-------|-----|--------|
| 1 | [item] | [GC/owner/arch] | [date] | Open |
| 2 | [item carried from previous] | | | Still open |

## RFIs Generated This Visit
[List any RFIs that need to be created — owner runs /rfi after this report]

## Photos Needed
[List the specific photos the owner should take or request before the next visit]
See /site-photo-brief for the current phase photo guide.

## Next Site Visit
Recommended: [date] to observe [specific milestone or work in progress]
```

---

## Step 5: Schedule next visit

Ask: when is the next site visit? Recommend based on:
- **Critical upcoming inspections** (framing, rough-in, etc.) — visit 1-2 days before to catch issues
- **Milestone completions** — visit when a phase is wrapping up, before it's covered
- **Weekly cadence** — during active construction, weekly visits catch problems before they compound

If Google Calendar is configured via `/connect`, note the date for the session-start hook to surface.

Update `schedule/master.md` with the next visit date.

---

## Step 6: Confirm with owner

After writing the report, confirm:
1. Any items that need immediate action (correct work before covering, respond to informal change requests in writing)
2. Any RFIs to create now (run `/rfi`)
3. Any decisions to log now (run `/decide`)
4. Next visit date confirmed
