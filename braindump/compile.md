# Braindump — Compile, Week & Review Modes

---

## Review Mode

Show what's been captured today.

### Step 1: Gather today's ideas

```bash
BRAINDUMP_DIR="$HOME/.copilot/braindumps/$(date +%Y-%m-%d)"
if [ -d "$BRAINDUMP_DIR" ]; then
  echo "COUNT=$(ls "$BRAINDUMP_DIR"/idea-*.md 2>/dev/null | wc -l | tr -d ' ')"
  for f in "$BRAINDUMP_DIR"/idea-*.md; do
    echo "=== $(basename "$f") ==="
    head -20 "$f"
    echo "---"
  done
else
  echo "NO_IDEAS_TODAY"
fi
```

### Step 2: Present the board

```
TODAY'S IDEAS ({date})
════════════════════════════════════════
#    Time   Title                        Tags                Energy
──   ─────  ───────────────────────────  ──────────────────  ────────
001  09:15  Example title                tag1, tag2          excited
════════════════════════════════════════
{N} ideas captured | {M} connections found

THEME CLUSTERS:
• {Theme A} (ideas {list}) — {1-line observation}
• {Theme B} (ideas {list}) — {1-line observation}
```

### Step 3: Offer actions

Via AskUserQuestion:
- Dig into a specific idea (which #?)
- Start compiling today's digest
- Back to dumping — I've got more

---

## Compile Mode

End-of-day structured compilation. Makes ideas ingestible by `/strategy` and `/plan`.

### Step 1: Gather all ideas

```bash
BRAINDUMP_DIR="$HOME/.copilot/braindumps/$(date +%Y-%m-%d)"
IDEA_COUNT=$(ls "$BRAINDUMP_DIR"/idea-*.md 2>/dev/null | wc -l | tr -d ' ')
echo "IDEA_COUNT=$IDEA_COUNT"
```

Read ALL idea files from today.

### Step 2: Analyze themes and clusters

Group by: tag overlap (2+ shared tags), conceptual similarity, energy patterns, evolution through the day.

### Step 3: Write the daily digest

Write to `{BRAINDUMP_DIR}/digest-{YYYY-MM-DD}.md`:

```markdown
---
date: {YYYY-MM-DD}
total_ideas: {N}
themes: [{theme1}, {theme2}, {theme3}]
top_energy: {highest-energy idea title}
status: compiled
---

# Daily Idea Digest — {date}

## Summary
{2-3 sentences: how many ideas, what themes emerged, what stood out. Warm, not analytical.}

## Theme Clusters

### 🔥 {Theme 1 name} (Ideas {list})
{What this cluster is about. Which idea has the most energy.}

**Ideas in this cluster:**
- **Idea {NNN}: {title}** — {1-line essence}

**Thread to pull:** {Most promising direction — an invitation, not a challenge.}

### 💡 {Theme 2 name} (Ideas {list})
{Same structure}

### 🌱 Standalone ideas
{Ideas that didn't cluster but are worth keeping. 1-liner each.}

## Connections Across Clusters
{Ideas that bridge two themes — often the most interesting.}

## Energy Map
{Which times of day were most productive? Which themes had the most excitement?}

## For /strategy or /discover
{The 1-3 ideas with the most energy and novelty. Note what makes each worth a deeper session.}

## Raw Idea Index
{Simple numbered list linking to each idea file.}
```

### Step 4: Optionally sync to MemPalace

Read `~/.copilot/skills/braindump/utils.md` for the MemPalace gate and sync logic.
Only sync compiled digests — never raw idea files.

### Step 5: Present completion

```
DAILY DIGEST COMPILED
════════════════════════════════════════
Date:       {date}
Ideas:      {N} captured
Themes:     {N} clusters identified
Top Energy: "{highest-energy idea title}"
Filed to:   {digest file path}
MemPalace:  {synced | skipped}
════════════════════════════════════════
```

Via AskUserQuestion:
- Open the digest file
- Take the hottest idea to /discover (office-hours)
- Done for today

---

## Week Mode

Weekly summary across multiple days.

### Step 1: Gather the week's digests

```bash
BRAINDUMP_BASE="$HOME/.copilot/braindumps"
for i in $(seq 0 6); do
  DATE=$(date -v-${i}d +%Y-%m-%d 2>/dev/null || date -d "$i days ago" +%Y-%m-%d 2>/dev/null)
  DIGEST="$BRAINDUMP_BASE/$DATE/digest-$DATE.md"
  if [ -f "$DIGEST" ]; then
    echo "=== $DATE ==="
    head -30 "$DIGEST"
    echo "---"
  fi
done
```

### Step 2: Cross-day analysis

Identify: recurring themes (appeared 2+ days), idea evolution, biggest cluster, surprise cross-day connections.

### Step 3: Write weekly summary

Write to `{BRAINDUMP_BASE}/weekly-{YYYY-Www}.md`:

```markdown
---
week: {YYYY-Www}
days_active: {N}
total_ideas: {N}
recurring_themes: [{theme1}, {theme2}]
---

# Weekly Idea Summary — Week {N}, {year}

## Numbers
- {N} ideas across {M} days / {K} theme clusters / {J} cross-day connections

## Recurring Themes
{Themes appearing on 2+ days. These are your obsessions — worth paying attention to.}

## Idea Evolution
{Ideas that grew, morphed, or connected across days.}

## Top Ideas for Deep Dive
{The 3-5 ideas with the most energy, recurrence, and novelty. Each with a /discover suggestion.}
```

Present and offer to take top ideas to `/discover` (office-hours).
