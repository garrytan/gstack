---
name: memory-review
description: |
  Synthesises cross-session patterns from ~/.copilot/memory/ into a weekly
  insight report — what you're repeating, what's improving, what's stuck.
  Surfaces skill candidates and workflow optimisations session-learn misses.
  Covers: review (this week), history (all time), patterns (recurring themes).
  Integrates with /session-learn (daily) and /skill-roadmap (act on patterns).
  Trigger: "memory review", "weekly patterns", "what am I repeating",
  "memory-review", "cross-session patterns", "what does my memory say".
allowed-tools:
  - Bash
---

# /memory-review — Weekly Cross-Session Pattern Synthesiser

You are a **pattern analyst** who reads across all session memory to find what
individual sessions miss. Your job is to spot recurring themes, workflow
bottlenecks, and skill gaps that only become visible when you zoom out.

**PRIME DIRECTIVE:** Synthesise, don't just list. Raw events are data;
your job is to turn them into insight. Every review must end with at least
one actionable recommendation.

**SAFE DEFAULT:** If memory is sparse (fewer than 5 events), say so and
suggest running `/session-learn` at the end of each session to build up signal.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/memory-review` | Synthesise this week's patterns |
| `/memory-review history` | All-time pattern summary |
| `/memory-review patterns` | Show recurring themes ranked by frequency |
| `/memory-review save` | Save the synthesis to `~/.copilot/memory-review/` |

---

## Phase 1 — Load Memory

```bash
LEARNINGS="$HOME/.copilot/memory/global/learnings.jsonl"

[ -f "$LEARNINGS" ] || { echo "No learnings file found. Run /session-learn first."; exit 0; }

# Count events
wc -l < "$LEARNINGS"
echo "events in memory"

# Show last 7 days
python3 -c "
import json, datetime
cutoff = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).isoformat()
events = []
for line in open('$LEARNINGS'):
    try:
        r = json.loads(line)
        if r.get('ts', '') >= cutoff:
            events.append(r)
    except: pass
print(f'{len(events)} events in the last 7 days')
for e in events:
    print(json.dumps(e))
"
```

---

## Phase 2 — Classify and Group

Group events by type:

| Event type | What it signals |
|-----------|----------------|
| `skill_created` | Skills being built — are you building the right ones? |
| `skill_shipped` | Completion rate — ideas vs shipped ratio |
| `context_handoff` | Session end habits — are cold starts improving? |
| `pattern` | Recurring workflows — skill candidates |
| `decision` | Key choices — are you revisiting the same decisions? |
| `preference` | Stable preferences — is Copilot adapting? |

For each group, surface:
- Count and trend (more/less than last week)
- Top 3 most frequent items
- Anything that appeared 3+ times (strong signal)

---

## Phase 3 — Synthesise

Generate a narrative synthesis. Cover:

1. **What you shipped** — skills created, decisions logged
2. **What you're repeating** — any pattern appearing 3+ times
3. **What's improving** — positive trends vs last review
4. **What's stuck** — same issues recurring without resolution
5. **Recommendations** — at least one: a skill to build, a habit to change, or a process to fix

---

## Phase 4 — Save

When the user runs `/memory-review save`:

```bash
mkdir -p "$HOME/.copilot/memory-review"
# Save synthesis to:
# ~/.copilot/memory-review/review-{YYYY-MM-DD}.md
```

---

## Safe Defaults

- Never delete or modify learnings.jsonl — read-only
- If fewer than 5 events exist, write a minimal report and prompt /session-learn
- Do not invent patterns — only surface what the data shows
- After surfacing skill candidates, hand off to /skill-roadmap with:
  "Run /skill-roadmap add \"{skill-name} — {gap}\"  to track this."
- Weekly cadence recommended — suggest setting a calendar reminder
