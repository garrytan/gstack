
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

# /rfi: Create a Request for Information

An RFI documents a field question and the design response. Every question that affects construction — drawing conflicts, field conditions, clarifications — gets a formal RFI. Verbal answers are not RFIs.

---

## Step 0: Load RFI state

```bash
echo "=== CURRENT PHASE ==="
grep -E "^(current_phase|project_type):" .build-os/config.yaml

echo ""
echo "=== OPEN RFIS ==="
if [ -f construction/rfi-log.md ]; then
  echo "Current RFI log:"
  cat construction/rfi-log.md
else
  echo "No RFI log yet — will initialize."
fi
```

Get the next RFI number by counting existing entries + 1.

---

## Step 1: Capture the field question

Ask the owner to describe the situation. Useful prompts:
- What specifically is unclear or conflicting in the drawings/specs?
- What is the GC or sub asking about?
- What are the options they're considering in the field?
- Is this blocking work? (If yes, mark as URGENT — 24h response needed)
- Do you have a photo of the field condition? (Describe it if so)

---

## Step 2: Architect interpretation

**Architect voice:** Evaluate from the perspective of a licensed senior architect with 20 years of residential and commercial experience. Focus on design intent, code compliance (IBC, IRC, local amendments), constructability, spatial quality, and long-term performance. Flag anything that will create an RFI, a change order, or a defect. Be direct about quality — "this works" or "this doesn't." No hedging.

For the field question described:

1. **Design intent** — what was the original design intent for this condition? What should be there?
2. **Suggested resolution** — what should the contractor do? Be specific and buildable
3. **Drawing or spec reference** — cite the specific drawing number or spec section that applies (or note if the drawings are silent on this issue)
4. **Alternatives** — if there are multiple acceptable resolutions, list them with a recommendation
5. **Impact assessment:**
   - Does this resolution change the scope? (if yes → needs `/decide`)
   - Does this resolution add cost? (if yes → needs `/cost-check` and possibly a change order)
   - Does this resolution affect schedule? (if yes → flag to PM)

---

## Step 3: Format the RFI

Write the formal RFI. Append to `construction/rfi-log.md`:

```markdown
---
## RFI #[N] — [Subject]

**Date:** YYYY-MM-DD
**Status:** Open
**Priority:** URGENT / NORMAL
**Response needed by:** YYYY-MM-DD (48h for urgent, 5 business days for normal)
**Submitted by:** [GC name or owner]

### Question
[Clear description of the field condition or drawing conflict. Specific location on drawings (sheet/detail number). What the contractor is asking.]

### Background
[Any context that helps understand the question. Field conditions, constraints, what was found on site.]

### Suggested Resolution
[Architect's suggested answer — specific and actionable]

### Drawing/Spec Reference
[Sheet number, detail, spec section]

### Response
_Pending_

### Impact if Unresolved
[What work is blocked or at risk until this is answered?]

---
```

Initialize `construction/rfi-log.md` if it doesn't exist:

```markdown
# RFI Log — [Project Name]

| RFI # | Subject | Date | Status | Response Date | Impact |
|-------|---------|------|--------|---------------|--------|
```

---

## Step 4: Impact flagging

If the suggested resolution in Step 2 involves:
- **A scope change** → "This resolution changes scope. Run `/decide` to log it as a decision."
- **A cost increase** → "This resolution adds cost. Run `/cost-check` to price it, then `/decide` to approve the change order."
- **A schedule impact** → Flag it in the site report at the next visit.

---

## Step 5: Confirm

Tell the owner:
- RFI #[N] created: "[subject]"
- Response needed by: [date]
- Work blocked: [yes/no — what]
- Any downstream actions needed (decide, cost-check)

If URGENT: suggest the owner send the RFI to the architect immediately (rather than waiting for the next session). The RFI text in `rfi-log.md` is ready to copy-paste into an email.
