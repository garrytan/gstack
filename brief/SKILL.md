---
name: brief
version: 0.1.0
description: |
  Daily prep brief for back-to-back meetings. Pulls today's calendar events
  (via gcalcli), looks up each attendee's prior context from Granola (via the
  Granola MCP server), and prints a one-screen brief: who you're meeting,
  what you last talked about, and what you said you'd follow up on.
  Use when asked to "brief me", "today's brief", "morning brief", "who am I
  meeting today", "prep for today", or "/brief".
triggers:
  - brief me on today
  - prep for today's meetings
  - who am I meeting today
  - morning brief
  - daily brief
allowed-tools:
  - Bash
  - Read
---

# /brief — Daily Prep Brief

Pulls today's calendar (gcalcli) + each attendee's prior context (Granola MCP)
and prints a one-screen brief in the terminal. No daemon, no DB, no server —
this skill is the entire tool.

Designed for once-a-day, pull-to-read use. Run it in the morning before your
first meeting.

---

## Step 0 — Preflight

This skill runs in two environments:

- **On a Mac** with `gcalcli` + Granola MCP available — pulls live data.
- **On Claude Code on the web** (sandbox) — reads a pre-generated snapshot
  pushed from the user's Mac via `bin/brief-snapshot`.

Detect which environment you're in. Run this bash:

```bash
echo "--- snapshot ---"
SNAPSHOT_PATH=""
for candidate in \
  "$(git rev-parse --show-toplevel 2>/dev/null)/.brief-data/snapshot.json" \
  "/home/user/gstack_robertf/.brief-data/snapshot.json" \
  "$HOME/code/gstack_robertf/.brief-data/snapshot.json"; do
  if [ -n "$candidate" ] && [ -s "$candidate" ]; then
    SNAPSHOT_PATH="$candidate"
    break
  fi
done
if [ -n "$SNAPSHOT_PATH" ]; then
  echo "SNAPSHOT: $SNAPSHOT_PATH"
  AGE_S=$(( $(date +%s) - $(stat -c %Y "$SNAPSHOT_PATH" 2>/dev/null || stat -f %m "$SNAPSHOT_PATH") ))
  echo "SNAPSHOT_AGE_SECONDS: $AGE_S"
else
  echo "SNAPSHOT: none"
fi

echo "--- live tools ---"
if command -v gcalcli >/dev/null 2>&1 && gcalcli list >/dev/null 2>&1; then
  echo "GCALCLI: ok"
else
  echo "GCALCLI: unavailable"
fi
echo "GRANOLA_MCP: check your tool list for mcp__granola__* tools"
```

### Decision tree

After running the bash above:

- **If `SNAPSHOT` is a path AND `SNAPSHOT_AGE_SECONDS` is < 86400 (24h):**
  read the snapshot file with the Read tool. **Skip Step 1 and Step 2** — the
  snapshot already contains the meetings + attendee_history. Go to Step 3 to
  render. If the snapshot's `today` field doesn't match today's date, treat it
  as stale and continue to live tools.
- **If `SNAPSHOT` exists but is stale (>24h) AND live tools work:** prefer live
  tools (Step 1 and Step 2). The snapshot is only a fallback for headless web
  use.
- **If `SNAPSHOT: none` AND live tools work** (Mac case): proceed to Step 1
  with live tools.
- **If `SNAPSHOT: none` AND live tools unavailable** (web sandbox without a
  pushed snapshot): print this verbatim and stop:

  > No snapshot found, and no live calendar/Granola access in this environment.
  > To use /brief on Claude Code on the web, run `./bin/brief-snapshot` on your
  > Mac first. That generates `.brief-data/snapshot.json` and pushes it to this
  > repo. Then re-run /brief here.

- **GCALCLI: unavailable on a Mac** (live use): print install instructions and
  stop:

  > `gcalcli` is not installed. The /brief skill needs it to read your calendar.
  > Install with: `brew install gcalcli && gcalcli init` (macOS) or
  > `pip install gcalcli && gcalcli init` (other). Re-run /brief after auth.

---

## Step 1 — Today's calendar

Run this bash to pull today's agenda in TSV format (parseable, stable):

```bash
TODAY=$(date +%Y-%m-%d)
TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d "+1 day" +%Y-%m-%d)
echo "DATE: $TODAY"
gcalcli agenda --tsv --details=description --details=attendees \
  "$TODAY" "$TOMORROW" 2>/dev/null
```

If the TSV output is empty or only contains a header, today has no events.
Print **"No meetings today."** and stop. Don't continue to Step 2.

Otherwise, parse the TSV. Each row contains: start time, end time, link, hangout
link, title, location, description, attendees (comma-separated emails). Build a
list of meetings, each with title, start time, attendees (emails).

---

## Step 2 — Per-attendee Granola lookup

For each unique attendee email across today's meetings, call the Granola MCP
search tool you identified in Step 0. Pass the attendee email (or, if Granola's
schema only supports name search, the display name). Request up to 3 most
recent notes, sorted by date descending.

Build a map: `email -> [list of {date, title, summary, action_items}]`.

### Identity matching

If Granola returns multiple matches for an attendee (common-first-name
collision), include both in the brief and let the user disambiguate. Don't
silently pick one. Surface the ambiguity:

```
Sarah (3 prior meetings — possibly multiple Sarahs):
  - Sarah Chen (sarah@acme.com, last met Apr 22): ...
  - Sarah Walsh (sarah.w@beta.io, last met Mar 8): ...
```

### Privacy

If a Granola note has a `private` or `visibility=private` field set, OR is in
a folder whose name contains `private` or `personal` (case-insensitive), skip
it. Don't mention skipped notes in the brief. (Future: revisit if Granola adds
finer-grained visibility controls.)

### Failure handling

- If Granola MCP times out or errors for a specific attendee → render that
  person's section with `Granola lookup failed` instead of dropping them.
- If Granola MCP errors for ALL attendees → fall back to calendar-only mode
  for the rest of the brief (Step 3 handles this).

---

## Step 2.5 — Render from snapshot (web path)

If Step 0 selected the snapshot path, the JSON has the structure produced by
`bin/brief-snapshot`. Read it once (Read tool), then jump to Step 3 with
`meetings` and `attendee_history` populated from the JSON. Mention the
snapshot's `generated_at` time in the brief output, like:

```
Today, Wednesday May 7  (snapshot generated 6 minutes ago on Mac)
```

Don't re-fetch from live tools — that's the whole point of the snapshot path.

---

## Step 3 — Format and print the brief

Print the brief in this exact format:

```
Today, <Day> <Month> <Date>

[<HH:MMam/pm>] <Meeting title> — <attendee count or "1:1">
  <For each attendee with prior history:>
  <Name> (<role hint if available>, <N> prior meetings):
    Last <relative date>: <one-sentence summary of last meeting topic>.
    Open: <verbatim follow-up the user committed to, if any>.
    Status: <inferred from later notes if mentioned, else omit line>
  <For each attendee with no prior history:>
  No prior history: <Name>.
  <If meeting has 0 prior-history attendees:>
  No prior history with anyone in this meeting.

[<next meeting>] ...
```

Order meetings by start time. Use the user's local timezone (system default).

### Sample output

```
Today, Wednesday May 7

[10:00am] Sarah Chen — 1:1
  Last met 2 weeks ago: discussed hiring plan for Q3.
  Open: send revised JD for the eng manager role.
  Status: not sent yet (no later note mentions it).

[2:00pm] Kickoff with Acme Corp (3 attendees)
  Marcus Lin (founder, 2 prior meetings):
    Last Apr 25: pricing pushback on enterprise tier; you offered to revisit.
    Open: send revised pricing deck.
  Priya Rao (eng, 1 prior meeting):
    Last Mar 30: integration questions about webhook retries.
  No prior history: Tom Walsh.

[4:30pm] Coffee with David — first meeting
  No prior history. Calendar invite says: "intro chat re: design feedback."
```

### Calendar-only fallback

If Granola was unavailable (Step 0 detected no granola tool, OR Step 2 errored
for all attendees), still print the brief — just with calendar data only.
Add this line right after the date header:

```
(Granola unavailable — past context not loaded.)
```

Then print each meeting with attendees but no "Last..." / "Open:" lines.

---

## Step 4 — Stop

Print the brief, then stop. Do NOT proactively send follow-up emails, file
reminders, or take any action on the user's behalf. The brief is read-only
output. The user decides what to do with it.

Do not write the brief to disk by default. (Future: an opt-in flag could
archive briefs under `~/.gstack/briefs/$(date +%Y-%m-%d).md`. Not v1.)

---

## Implementation notes (for the agent reading this skill)

- **You are the orchestrator.** This SKILL.md tells you what to do; you do it
  via Bash + the Granola MCP tool you already have. There is no separate
  helper script, no compiled binary, no extra files in this skill directory.
- **Be fast.** The user typed `/brief` because they want the answer in
  seconds, not a conversation. Don't ask clarifying questions unless something
  is genuinely ambiguous. Don't AskUserQuestion. Just run the steps and print.
- **Be specific, not generic.** "Discussed hiring" is bad. "Discussed hiring
  the eng manager (Sarah said target Q3)" is good. Quote the user's
  follow-ups verbatim when Granola has the exact phrasing.
- **Latency budget.** ~3-8s for gcalcli, ~2-4s per attendee for Granola, ~5-10s
  for you to compose. Total should be well under a minute. If you find
  yourself doing >2 Granola lookups per attendee, you've gone wrong — back off.
- **Respect privacy.** Skip private notes. If a meeting is one-on-one and
  obviously personal (e.g., "Therapy" in the title), still surface the
  meeting time but don't pull or summarize Granola notes for it.
