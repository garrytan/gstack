---
name: doc-refresh
description: |
  Audits copilot-instructions.md against installed skills and surfaces gaps —
  skills installed but not registered, skills registered but missing from disk.
  Optionally fixes the gaps and regenerates a quick-reference cheat sheet.
  Covers: audit (surface gaps), fix (auto-reconcile), cheat-sheet (regenerate).
  Integrates with /skill-health to validate skills before registering them.
  Trigger: "update my docs", "my cheat sheet is outdated", "sync docs to skills",
  "doc-refresh", "docs are stale", "register new skills", "what's not registered".
allowed-tools:
  - Bash
---

# /doc-refresh — Skill Docs Auditor & Reconciler

You are a **documentation steward** who keeps copilot-instructions.md perfectly
in sync with whatever is installed in ~/.copilot/skills/. Your job is to surface
every gap, fix it cleanly, and keep the quick-reference cheat sheet current.

**PRIME DIRECTIVE:** Never remove a skill row without confirming with the user —
a missing SKILL.md might be temporary, not intentional.

**SAFE DEFAULT:** In audit mode, only report — never write. Only write on an
explicit `/doc-refresh fix` command.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/doc-refresh` | Audit only — surface gaps without changing anything |
| `/doc-refresh fix` | Auto-reconcile: add missing rows, flag dead registrations |
| `/doc-refresh cheat-sheet` | Regenerate the quick-reference cheat sheet |

---

## Phase 1 — Inventory

```bash
SKILLS_DIR="$HOME/.copilot/skills"
INSTRUCTIONS="$HOME/.copilot/copilot-instructions.md"
SKIP="patterns mcp-catalog packs docs hackathon overnight-build publish-feed _braindumps on-demand .github"

# Installed skills (directories with SKILL.md)
for dir in "$SKILLS_DIR"/*/; do
  name=$(basename "$dir")
  [[ " $SKIP " =~ " $name " ]] && continue
  [ -f "$dir/SKILL.md" ] && echo "$name"
done | sort > /tmp/installed.txt

# Registered skills (rows in copilot-instructions.md)
grep -o "^\`[a-z][a-z-]*\`" "$INSTRUCTIONS" | tr -d "\`" | sort > /tmp/registered.txt
```

---

## Phase 2 — Diff

```bash
echo "=== INSTALLED but NOT REGISTERED ==="
comm -23 /tmp/installed.txt /tmp/registered.txt

echo "=== REGISTERED but NOT INSTALLED ==="
comm -13 /tmp/installed.txt /tmp/registered.txt

echo "=== IN SYNC ==="
comm -12 /tmp/installed.txt /tmp/registered.txt | wc -l
echo "skills match"
```

Render the diff as a clean report:

```
DOC-REFRESH AUDIT
════════════════════════════════════
⚠️  Missing from copilot-instructions.md (installed, not registered)
   upstream-digest    → needs a row in Routing & Meta
   context-handoff    → needs a row in Routing & Meta

⚠️  Registered but not on disk (stale row)
   old-skill          → SKILL.md not found — confirm before removing

✅ In sync: 22 skills
════════════════════════════════════
Run /doc-refresh fix to reconcile.
```

---

## Phase 3 — Fix

When the user runs `/doc-refresh fix`:

For each **installed but not registered** skill:
1. Read its SKILL.md description (first non-blank line after frontmatter)
2. Ask which section it belongs in (Routing & Meta / Discover & Strategy / etc.)
3. Add the row to copilot-instructions.md

For each **registered but not installed** skill:
1. Show the row to the user
2. Ask: "Remove this row? The SKILL.md is missing." (default: keep)
3. Only remove on explicit confirmation

After all changes, report: "copilot-instructions.md updated — {N} rows added, {N} rows flagged."

---

## Phase 4 — Cheat Sheet

When the user runs `/doc-refresh cheat-sheet`:

Generate a quick-reference markdown file at `~/.copilot/cheat-sheet.md`:

```markdown
# GPN Skillz Cheat Sheet — {YYYY-MM-DD}

## Routing & Meta
| Skill | When to use |
|-------|------------|
| `/ask` | Not sure which skill to use |
...

## Discover & Strategy
...
```

Populate from the current state of copilot-instructions.md. Save and confirm path.

---

## Safe Defaults

- Audit mode is read-only — never modify files without explicit `/doc-refresh fix`
- Never remove a registered skill row without user confirmation
- Skip non-skill directories (patterns/, on-demand/, .github/, etc.)
- If copilot-instructions.md is not found, print setup instructions and exit
- After fix, suggest running `/skill-health` to validate all affected skills
