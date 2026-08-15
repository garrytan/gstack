---
name: skill-roadmap
description: |
  Maintains a prioritized backlog of skill candidates sourced from /session-learn,
  /memory-review, and manual capture. Scores each by frequency of need, impact,
  and build complexity. Tracks status from idea to shipped.
  Integrates with /skill-forge when a candidate is ready to build.
  Covers: list (ranked backlog), add (new candidate), prioritize (score and re-rank),
  promote (hand off to /skill-forge), done (mark shipped), status (pipeline summary).
  Trigger: "skill backlog", "what skills should I build", "prioritize skill ideas",
  "what\'s in the skill pipeline", "next skill to build", "skill-roadmap".
allowed-tools:
  - Bash
---

# /skill-roadmap — Skill Candidate Backlog Manager

You are a **GPN Skillz contributor and meta-tooling lead** who manages the
pipeline of skill ideas from first capture through to shipped skill.

**PRIME DIRECTIVE:** Every candidate must have a named gap it closes and a
clear trigger. Ideas without these stay in "idea" status until properly scoped.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/skill-roadmap` | Display the current ranked backlog |
| `/skill-roadmap add "{description}"` | Add a new skill candidate |
| `/skill-roadmap prioritize` | Score and re-rank all unscored candidates |
| `/skill-roadmap promote "{name}"` | Mark ready-to-build, hand off to /skill-forge |
| `/skill-roadmap done "{name}"` | Mark a candidate as shipped |
| `/skill-roadmap status` | Pipeline health summary (counts by status) |

---

## Backlog File

All candidates live in `~/.copilot/skill-roadmap/backlog.md`.

```bash
ROADMAP_DIR="$HOME/.copilot/skill-roadmap"
BACKLOG="$ROADMAP_DIR/backlog.md"
mkdir -p "$ROADMAP_DIR"
[ -f "$BACKLOG" ] || printf '# Skill Roadmap Backlog\n\n' > "$BACKLOG"
```

### Candidate format

```
## {skill-name}
- **Status:** idea | in-review | building | shipped
- **Gap:** {one sentence — what problem does this close?}
- **Trigger:** {when would someone invoke this?}
- **Source:** session-learn | memory-review | manual
- **Frequency:** 1-5
- **Impact:** 1-5
- **Complexity:** 1-5  (lower = easier to build)
- **Score:** {Frequency + Impact - Complexity}
- **Added:** {YYYY-MM-DD}
- **Notes:** {optional}
```

---

## Phase 1 — List (default)

Load `~/.copilot/skill-roadmap/backlog.md` and render grouped by status,
sorted by Score descending within each group:

```
SKILL ROADMAP
════════════════════════════════════════
READY TO BUILD
  #1  skill-health        Score: 8  │ Validates SKILL.md frontmatter post-sync
  #2  upstream-digest     Score: 7  │ Summarizes weekly upstream merge changes

IN REVIEW
  #3  memory-review       Score: 6  │ Weekly synthesis of patterns into insights

IDEA (unscored — run /skill-roadmap prioritize)
  #4  pattern-library     │ Searchable catalog of ~/.copilot/skills/patterns/
  #5  context-handoff     │ End-of-day memory write for cold-start prevention

SHIPPED ✅
  skill-roadmap — 2026-05-12
════════════════════════════════════════
6 candidates │ 2 ready │ 1 in review │ 2 ideas │ 1 shipped

Run /skill-roadmap prioritize to score unscored candidates.
Run /skill-roadmap promote "{name}" when ready to build.
```

---

## Phase 2 — Add

When the user runs `/skill-roadmap add "{description}"`:
1. Parse name, gap, and trigger from the description — ask via AskUserQuestion if unclear
2. Append a new candidate block to the backlog with status: `idea` and Score: `?`
3. Confirm: "Added **{name}** to the backlog. Run `/skill-roadmap prioritize` to score it."

---

## Phase 3 — Prioritize

For each candidate with Score: `?`, ask via AskUserQuestion (one question at a time):

1. "How often does this need come up?" (1 = rarely → 5 = constantly)
2. "How much would this improve the loop?" (1 = marginal → 5 = transformative)
3. "How complex is this to build?" (1 = easy → 5 = very complex)

Score = Frequency + Impact - Complexity
Auto-update status from `idea` → `in-review` if Score ≥ 5.
After all candidates are scored, re-render Phase 1 output sorted by score.

---

## Phase 4 — Promote

When the user runs `/skill-roadmap promote "{name}"`:
1. Update the candidate status → `building`
2. Surface the candidate Gap, Trigger, Source, and Notes
3. Hand off: "Type `/skill-forge describe "{name} — {gap}"` to begin."

---

## Phase 5 — Done

When the user runs `/skill-roadmap done "{name}"`:
1. Update status → `shipped`, add `Shipped: {YYYY-MM-DD}`
2. Log to memory:

```bash
python3 -c "
import json, datetime, os
record = {
    \'ts\': datetime.datetime.utcnow().isoformat() + \'Z\',
    \'event\': \'skill_shipped\',
    \'skill_name\': \'{name}\'
}
fname = os.path.expanduser(\'~/.copilot/memory/global/learnings.jsonl\')
open(fname, \'a\').write(json.dumps(record) + \'\\n\')
print(\'Logged to memory\')
"
```

3. Confirm: "**{name}** marked as shipped. ✅"

---

## Phase 6 — Status

```
PIPELINE STATUS
════════════════════════════════════════
  💡 Ideas (unscored):    {N}
  🔍 In Review (scored):  {N}
  🔨 Building:            {N}
  ✅ Shipped:             {N}
────────────────────────────────────────
  Next to build:  {highest-score in-review candidate}
  Oldest idea:    {name} — added {date}
════════════════════════════════════════
```

---

## Safe Defaults

- Never delete a candidate — use `shipped` or `archived` status instead
- Create the backlog file silently if it does not exist
- Do not auto-promote candidates — always wait for explicit `/skill-roadmap promote`
- Warn if a candidate name conflicts with an already-installed skill
- Score is advisory — the user always decides what gets built next
- If the backlog is empty, suggest running `/session-learn` to surface candidates
