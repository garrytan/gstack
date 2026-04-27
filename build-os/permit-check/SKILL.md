
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

# /permit-check: Permit Review

**Architect voice:** Evaluate from the perspective of a licensed senior architect with 20 years of residential and commercial experience. Focus on design intent, code compliance (IBC, IRC, local amendments), constructability, spatial quality, and long-term performance. Flag anything that will create an RFI, a change order, or a defect. Be direct about quality — "this works" or "this doesn't." No hedging.

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

---

## Step 0: Load permit state

```bash
echo "=== PROJECT ==="
grep -E "^(name|project_type|current_phase|location):" .build-os/config.yaml

echo ""
echo "=== PERMITS DIRECTORY ==="
if [ -f permits/checklist.md ]; then
  cat permits/checklist.md
else
  echo "No permit checklist yet — will create one."
fi

if [ -f permits/code-notes.md ]; then
  echo ""
  echo "=== CODE NOTES ==="
  cat permits/code-notes.md
fi
```

---

## Step 1: Identify required permits

Based on project type, location, and scope, identify every permit that will be needed. Think comprehensively — missed permits cause stop-work orders.

**Typical permit categories by project type:**

*New construction:*
- Building permit (primary — covers structural, architectural)
- Grading / site work permit
- Utility connection permits: sewer, water, gas, electric
- Mechanical permit (HVAC)
- Plumbing permit
- Electrical permit
- Fire sprinkler permit (if required)
- Stormwater / drainage (if applicable)
- Driveway / curb cut (if applicable)
- Sign permit (if applicable)

*Renovation:*
- Building permit (if structural, egress, or occupancy change)
- Electrical permit (if panel work, new circuits, or service upgrade)
- Plumbing permit (if moving or adding fixtures)
- Mechanical permit (if new HVAC or ductwork)
- Demolition permit (some jurisdictions require separately)

For each permit identified, flag:
- **Issuing authority** (city building department, county, fire marshal, utility company, etc.)
- **Lead time** (how long does this jurisdiction typically take?)
- **Dependencies** (must A be issued before B can be submitted?)
- **Unique requirements** (owner-builder license limitations, bonding, special inspections, etc.)

---

## Step 2: Sequencing and critical path

**PM voice:** Evaluate from the perspective of a senior project manager who has delivered 50+ construction projects. Focus on schedule, contractor accountability, open items, risk, and what will slip if not addressed today. Name the contractor responsible for each open item. Flag anything on the critical path. Be specific about days and dates.

Map the permit sequence. Draw out the dependencies:

```
Primary building permit
  └─ Required before: all trade permits, GC mobilization

Utility connections
  └─ Water/sewer: required before certificate of occupancy
  └─ Electric service: required before final inspection
  └─ Gas: required before final inspection (if applicable)

Special inspections
  └─ Geotechnical: required before foundation permit
  └─ Structural: required before framing inspection
```

Identify the **critical path permit** — the one whose delay most threatens the project schedule. Flag it explicitly.

---

## Step 3: Submission risks

For each permit, assess the risk of delay or rejection:

- **Plan check issues:** anything in the current design that is likely to trigger a correction notice (non-compliant egress, setback violations, occupancy conflicts, missing details)
- **Jurisdiction quirks:** any unusual local requirements (some cities require pre-application meetings, specific drawing formats, CalGreen compliance checklists, etc.)
- **Owner-builder limitations:** owner-builder permits typically restrict electrical and plumbing work to licensed subs — confirm what applies in this jurisdiction
- **Historic or overlay districts:** any additional approval layers (historic preservation, design review board, HOA approvals)?

---

## Step 4: Write/update permits/checklist.md

Write the permit tracker:

```markdown
# Permit Checklist — [Project Name]

**Last updated:** YYYY-MM-DD | **Phase:** [current phase] | **Jurisdiction:** [city/county]

| Permit | Authority | Status | Submitted | Issued | Expiry | Notes |
|--------|-----------|--------|-----------|--------|--------|-------|
| Building permit | [dept] | Not submitted | | | | Critical path |
| Electrical permit | [dept] | Not submitted | | | | After building permit |
| Plumbing permit | [dept] | Not submitted | | | | |
| [others] | | | | | | |

## Key Deadlines
- Building permit target submission: [date]
- Building permit target issue: [date] (critical — blocks GC mobilization)
- [other deadlines]

## Open Items
- [ ] [action needed before submission]
- [ ] [contact to make]
```

---

## Step 5: Code notes

Update `permits/code-notes.md` with any code compliance notes from this review:

```markdown
# Code Notes — [Project Name]

**Applicable codes:** [IBC/IRC year], [local amendments], [accessibility if commercial]

## Compliance Notes
- [code item]: [compliant/risk/flagged for arch review]
- [code item]: [compliant/risk/flagged for arch review]

## Open Items Requiring Resolution
- [ ] [issue] — [what needs to happen to resolve it]
```

---

## Step 6: Schedule integration

Add permit deadlines to `schedule/master.md`. For each permit with a known or target submission date, add a calendar entry. The PM should add Google Calendar reminders for:
- 2 weeks before target submission (prep reminder)
- Target submission date
- Expected issue date (if known)

If Google Calendar is configured (via `/connect`), these will be added automatically.

---

## Step 7: What's next

Tell the owner:
1. The total number of permits required and the critical path permit
2. The #1 submission risk and how to mitigate it
3. The next action (typically: submit building permit or resolve a flagged issue)
4. Any permits that have long lead times that need to be started now
