
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

# /daily-brief: Today's Project Status

---

## Step 0: Check for context file

```bash
echo "=== PROJECT ==="
grep -E "^(name|current_phase):" .build-os/config.yaml

echo ""
if [ -f .build-os/daily-context.md ]; then
  echo "=== EXISTING CONTEXT (from session-start hook) ==="
  cat .build-os/daily-context.md
  echo ""
  echo "Context file age: $(find .build-os/daily-context.md -newer .build-os/config.yaml -print 2>/dev/null | wc -l) (1=fresh today, 0=stale)"
else
  echo "No daily context file. Will build from scratch."
  echo "Tip: run /connect to install the session-start hook for automatic context."
fi
```

---

## Step 1: Calendar — today and this week

Use the Google Calendar MCP to fetch events for the next 7 days matching `[{Project Name}]`.

For each event, classify:
- **Site visit** → prompt: "Do you want to run `/site-photo-brief` to prepare?"
- **Inspection** → prompt: "Inspection in [N] days — are you ready? Key items: [brief checklist based on inspection type]"
- **Bid due** → check: has the bid been received? If not, flag as URGENT
- **Phase gate target** → check: is the project on track to pass the gate by this date?
- **RFI response due** → check: is the RFI still open in `construction/rfi-log.md`?

---

## Step 2: Open items from Notion

Use the Notion MCP to query:
- **RFIs** where status = "Open" and response_due <= today + 3 days
- **Budget items** with estimate but no actual (in construction phase)
- **Decisions** with cost_impact = "unknown" older than 7 days (need pricing)

Show any items that are overdue or due within 3 days.

---

## Step 3: Email flags

If `.build-os/email-flags.md` exists (written by a previous `/email-scan`):
```bash
[ -f .build-os/email-flags.md ] && cat .build-os/email-flags.md
```

Otherwise: "No recent email scan. Run `/email-scan` to check for flagged contractor emails."

---

## Step 4: Unprocessed Granola notes

Use the Notion MCP to check for unprocessed Granola notes (imported = false):
- If any exist: "You have [N] unprocessed meeting notes in Notion. Run `/import-notes` to import them."
- If none: note that the import queue is clear.

---

## Step 5: Prioritized action list

Based on Steps 1-4, generate a prioritized list:

```
build-os | [Project Name] | [Phase] | $[budget status]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TODAY
  [● URGENT items with today's deadline]

THIS WEEK
  [● Items due this week, by date]
  [● Upcoming inspections or site visits with prep suggestions]

OPEN
  [● Overdue items (past due date)]
  [● Unpriced decisions]

QUEUE
  [● N unprocessed Granola notes → /import-notes]
  [● Last email scan: [date] → /email-scan to refresh]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
What do you want to tackle first?
```

If nothing is urgent and the project is on track, say so: "No urgent items. Project is on track for [next milestone] on [date]."

---

## Step 6: Update context file

Rewrite `.build-os/daily-context.md` with today's brief so other skills can read it:

```bash
echo "Context file updated: .build-os/daily-context.md"
```
