
# /dashboard: All Projects

For builders running multiple projects simultaneously. Run this from any directory — it reads all projects from `~/.build-os/projects/`.

---

## Step 1: Enumerate projects

```bash
echo "=== ALL BUILD-OS PROJECTS ==="
if [ -d "${HOME}/.build-os/projects" ]; then
  ls "${HOME}/.build-os/projects/"
else
  echo "No projects found. Run /kickoff in a project folder to create one."
  exit 0
fi
```

For each project slug found, check if the project folder still exists by looking for the config path stored in the decisions file or by searching common locations. If a project folder can't be found, note it as "archived or moved."

---

## Step 2: Load status for each project

For each active project:

```bash
# Find the project root (search common parent directories)
_SLUG="[slug]"
# Try to find .build-os/config.yaml under common dirs
find "${HOME}" -name "config.yaml" -path "*/.build-os/config.yaml" -exec grep -l "slug: ${_SLUG}" {} \; 2>/dev/null | head -1
```

From each project's config, read:
- `name`, `project_type`, `current_phase`, `budget`
- Last 3 decisions (from `decisions.jsonl`)

---

## Step 3: Query cross-project calendar

Use the Google Calendar MCP to fetch all events in the next 14 days. Filter for events with `[` prefix (project-tagged events). Group by project name.

---

## Step 4: Query cross-project Notion

Use the Notion MCP to query the Projects database. For each project row, fetch linked records with overdue dates:
- RFIs with response_due <= today
- Budget items with variance > 10%
- Any flagged items

---

## Step 5: Render the dashboard

```
═══════════════════════════════════════════════════════
 build-os DASHBOARD — [date]
═══════════════════════════════════════════════════════

ACTIVE PROJECTS

 [Project Name]           Phase [N]: [Phase Name]
 $[est]/$[budget] ([±%])  [status flag]
 ⚠ [urgent item if any]

 [Project Name]           Phase [N]: [Phase Name]
 $[est]/$[budget] ([±%])  [status flag]
 ✓ On track

───────────────────────────────────────────────────────

THIS WEEK (all projects)

 [Day]  [[Project]] [event type]: [description]
 [Day]  [[Project]] [event type]: [description]
 [Day]  [[Project]] [event type]: [description] ← AT RISK

───────────────────────────────────────────────────────

URGENT (needs attention today)

 [[Project]] [item] — [why urgent]
 [[Project]] [item] — [why urgent]

═══════════════════════════════════════════════════════
```

Status flags:
- ✓ On track
- ⚠ [specific issue]
- 🔴 [critical issue requiring immediate action]

If a project has no issues: show it as ✓ with a one-line status.

---

## Step 6: Navigation

After the dashboard, tell the owner:
- "To work on a specific project: `cd [project-folder]` and open Claude Code there"
- "To run `/daily-brief` for a specific project: navigate to that project's folder"

If there are urgent items across multiple projects, ask: "Which project do you want to start with?"
