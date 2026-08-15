# GPN Skillz — Patterns Library

Curated, anonymised workflow patterns detected by `/session-learn` across GPN Skillz users.

This folder is the bridge between **local session learning** and **shared skill improvement**. When a pattern is detected locally, contributors can push it here so the whole team benefits — even if it doesn't yet warrant a full new skill.

---

## What belongs here

| ✅ Contribute | ❌ Don't include |
|---|---|
| Repeatable multi-step workflows | Raw session logs or personal data |
| Recurring workarounds | Machine-specific paths or credentials |
| Coding habits (good or bad) | One-off task notes |
| Domain knowledge gaps discovered in skills | Draft skill ideas (use `/skill-forge` instead) |
| Skill improvement suggestions | |

---

## File naming

```
patterns/YYYY-MM-DD-{pattern-name}.md
```

One file per pattern. If a pattern recurs across sessions, update the existing file — don't create duplicates.

---

## Pattern file format

```markdown
# {pattern-name}

**Type:** WORKFLOW | PROTOTYPE | WORKAROUND | HABIT | FINANCE | DEBUG | DOMAIN | COMMAND | DOCS | DATA
**First seen:** YYYY-MM-DD
**Frequency:** how many times observed (across sessions / contributors)
**Status:** open | addressed | wont-fix

## What happens
[Description of the pattern — what the user does, why it recurs]

## Why it matters
[Impact: wasted time, skill gap, error risk, improvement opportunity]

## Suggested fix
[What should change: skill edit, new sub-command, new skill, documentation]

## Evidence
[Commits, session files, skill names, tool calls that show this pattern]

## Resolution
[If addressed: what was changed and which commit fixed it]
```

---

## How session-learn contributes here

When `/session-learn` detects a pattern that doesn't meet the full new-skill threshold but is worth sharing, it can write a pattern file and push it:

```bash
# session-learn writes pattern file
python3 /tmp/write_pattern.py   # generates patterns/YYYY-MM-DD-{name}.md

# then commits
cd ~/.copilot/skills
git add patterns/
git commit -m "patterns: add {name} [{TYPE}]"
git push origin main
```

Contributors can then pick up open patterns and address them via skill edits or `/skill-forge`.

---

## Triage labels

Add one of these to the `Status` field:

| Status | Meaning |
|---|---|
| `open` | Pattern detected, no fix yet — up for grabs |
| `addressed` | Fixed in a skill — resolution documented |
| `wont-fix` | Acknowledged, not worth a skill change |
| `skill-candidate` | Strong enough signal — run `/skill-forge` |
