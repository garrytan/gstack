
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

# /schedule-sync: Sync Project Dates to Google Calendar

Run this after `/kickoff`, after each `/phase-gate`, and whenever new dates are added to the project. All events use `[Project Name]` prefix so they're filterable.

---

## Step 0: Load all project dates

```bash
echo "=== PROJECT ==="
grep -E "^(name|current_phase):" .build-os/config.yaml

echo ""
echo "=== MASTER SCHEDULE ==="
[ -f schedule/master.md ] && cat schedule/master.md || echo "No schedule file"

echo ""
echo "=== PERMITS (deadlines) ==="
[ -f permits/checklist.md ] && grep -E "target|deadline|due" permits/checklist.md -i | head -15 || echo "No permit checklist"

echo ""
echo "=== RFIS (response deadlines) ==="
[ -f construction/rfi-log.md ] && grep "Response needed by" construction/rfi-log.md | head -10 || echo "No RFIs"

echo ""
echo "=== BIDS (due dates) ==="
ls contracts/rfps/*.md 2>/dev/null | xargs grep -h "Bid Due" 2>/dev/null | head -10 || echo "No RFPs"
```

---

## Step 1: Build the event list

From the data above, compile every date into a list:

| Event type | Date | Description | Reminder |
|---|---|---|---|
| Phase milestone | [date] | [phase name] target completion | 1 week before |
| Bid due | [date] | [trade] bid deadline | 48h before |
| RFI response | [date] | RFI #[N] response needed | 48h before |
| Permit submission | [date] | [permit name] submission target | 1 week before |
| Permit issuance | [date] | [permit name] expected issue | 2 weeks before |
| Inspection | [date] | [inspection name] | 48h before |
| Site visit | [date] | Scheduled site visit | 24h before |
| Phase gate target | [date] | [phase] gate review | 1 week before |

---

## Step 2: Compare with Google Calendar

Use the Google Calendar MCP to search for existing events containing `[{Project Name}]` in the next 90 days.

For each date in Step 1:
- If a matching event already exists on that date with the same description: **skip** (don't duplicate)
- If a similar event exists on a different date: **flag** as a conflict for owner review
- If no matching event exists: **create**

---

## Step 3: Create calendar events

For each new event, create using the Google Calendar MCP:

```
Title: [{Project Name}] {Event type}: {Description}
Date/time: {date} (all-day for milestones, specific time if known)
Description: Project: {name} | Phase: {current phase} | Source: build-os
Reminders: [{N} days before, {M} hours before as applicable]
```

Color coding:
- Phase milestones: green
- Deadlines (bids, RFI responses, permits): red
- Meetings and site visits: blue
- Inspections: orange

---

## Step 4: Pull back missing dates

Use the Google Calendar MCP to search for events containing `[{Project Name}]` that exist on the calendar but are NOT in `schedule/master.md` or the project files.

For each "orphan" calendar event:
- Show it to the owner: "This event is on your calendar but not in the project files: [event]"
- Owner confirms: add it to `schedule/master.md`, or it's personal/not project-related (skip)

---

## Step 5: Conflict check

Scan for scheduling conflicts that may need attention:
- Two inspections on the same day
- Bid due date with no lead time for the owner to review
- Phase gate target date before all prior milestones are complete
- Site visit scheduled for a day with no active work (GC's schedule)

Flag any conflicts to the owner.

---

## Step 6: Summary

```
Schedule sync complete — [date]
  [N] events added to Google Calendar
  [N] events already existed (skipped)
  [N] conflicts flagged for review
  [N] orphan calendar events pulled back

All events prefixed with [{Project Name}] for easy filtering.
```

After sync, remind the owner: "Run `/schedule-sync` again after each phase gate to keep the calendar current with new milestone dates."
