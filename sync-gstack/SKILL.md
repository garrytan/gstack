---
name: sync-gstack
version: 2.0.0
description: |
  Sync gstack-governed fork with upstream gstack. Fetches latest from garrytan/gstack,
  modifies the generator (preamble trim) and templates (React/TS adaptations),
  regenerates SKILL.md files, then creates a PR on the fork for review.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
---

# Sync Gstack-Governed with Upstream

Pull latest upstream gstack, modify the generator and templates to apply governed trims and
React/TS adaptations, regenerate all SKILL.md files, create a PR.

**Architecture note:** SKILL.md files are generated from `.tmpl` templates by
`scripts/gen-skill-docs.ts`. Running `./setup` (which calls `bun run build`) regenerates
them. Never edit generated SKILL.md files directly — edits go in `.tmpl` files or in the
generator script.

## Prerequisites

The fork must have an `upstream` remote pointing to `garrytan/gstack`:
```bash
cd ~/.claude/skills/gstack-governed
git remote -v  # should show upstream → garrytan/gstack
```

If missing: `git remote add upstream https://github.com/garrytan/gstack.git`

## Workflow

### Step 1 — Fetch upstream + assess what changed

```bash
cd ~/.claude/skills/gstack-governed
git fetch upstream
```

Show what is new upstream:
```bash
git log HEAD..upstream/main --oneline
```

Read the CHANGELOG diff:
```bash
git diff HEAD..upstream/main -- CHANGELOG.md
```

Print a summary of what is new upstream: new skills, changed templates, generator changes,
new commands, version bumps. This summary goes into the PR body later.

### Step 2 — Create sync branch from upstream

Create a branch based on upstream/main. Use the current date for the branch name.

```bash
git checkout -b sync-upstream-$(date +%Y%m%d) upstream/main
```

At this point the working tree matches upstream exactly — no governed modifications yet.

### Step 3 — Modify the generator (preamble trim)

The generator is `scripts/gen-skill-docs.ts`. The `generatePreamble()` function controls
what `{{PREAMBLE}}` resolves to in every template.

Upstream's `generatePreamble()` likely contains update check logic (`_UPD=` bash blocks),
session tracking, and contributor mode sections. The governed fork strips all of that,
keeping only the AskUserQuestion format block.

**Replace the entire body of `generatePreamble()`** so it returns only this:

```
## AskUserQuestion Format

**ALWAYS follow this structure for every AskUserQuestion call:**
1. **Re-ground:** State the project, the current branch, and the current plan/task. (1-2 sentences)
2. **Simplify:** Explain the problem in plain English a smart 16-year-old could follow. No raw function names, no internal jargon, no implementation details. Use concrete examples and analogies. Say what it DOES, not what it's called.
3. **Recommend:** `RECOMMENDATION: Choose [X] because [one-line reason]`
4. **Options:** Lettered options: `A) ... B) ... C) ...`

Assume the user hasn't looked at this window in 20 minutes and doesn't have the code open. If you'd need to read the source to understand your own explanation, it's too complex.

Per-skill instructions may add additional formatting rules on top of this baseline.
```

If `generatePreamble()` already matches this (no update check, no session tracking, no
contributor mode), skip this step — upstream may have adopted the same trim.

Also check `generateQAMethodology()` in the same file. If upstream re-added a `### Rails`
framework subsection, remove it. Ensure `### General SPA (React, Vue, Angular)` is present
with hydration, client-side routing, CLS, and stale state checks.

**Verification:**
```bash
grep -n '_UPD=\|UPGRADE_AVAILABLE\|Contributor Mode\|session_id\|### Rails' scripts/gen-skill-docs.ts
```

If matches are found inside `generatePreamble()` or `generateQAMethodology()`, the trim is
incomplete.

### Step 4 — Apply React/TS template adaptations

Edit `.tmpl` files (never generated `.md` files). For each skill below, apply the specified
changes. Use the Edit tool for precise replacements.

Use conditional language: check whether upstream re-introduced content before removing it.
If a section is already absent, skip that sub-step.

---

**4a. ship/SKILL.md.tmpl**

- Remove any Step related to VERSION bump if upstream re-added it
- Remove any Step related to CHANGELOG generation if upstream re-added it
- Remove any eval suite step (e.g. "Step 3.25: Eval Suites") if present
- Remove any TODOS.md auto-update step if present
- Replace test command references: `bin/test-lane` and `npm run test` become
  "project's test/lint/typecheck commands from CLAUDE.local.md 'Project Scripts' table"
- Replace commit ordering vocabulary:
  - "migrations" → "schema changes"
  - "Models & services" → "Components & hooks"
  - "Controllers & views" → "Pages & routes"

```bash
grep -n 'bin/test-lane\|npm run test\|VERSION bump\|CHANGELOG gen\|Eval Suites\|migrations\|Models & services\|Controllers & views' ship/SKILL.md.tmpl
```

---

**4b. review/SKILL.md.tmpl**

- Replace ActiveRecord / ORM vocabulary with GraphQL client / data fetching hooks
- Replace "Models" → "Components", "Controllers" → "Pages/Routes", "Concerns" → "Hooks"
- Replace "Models/Controllers/Concerns" → "Components/Hooks/Services/Utils" where grouped

**DO NOT modify `review/checklist.md` or `review/TODOS-format.md`** — these are maintained directly in the fork and are not generated.

---

**4c. retro/SKILL.md.tmpl**

- Replace "Models / Controllers / Concerns" → "Components / Hooks / Services / Utils"
  (handle both spaced and unspaced slash variants)

---

**4d. plan-eng-review/SKILL.md.tmpl**

- Replace Rails-specific error types with React/TS equivalents:
  `ActiveRecord::RecordNotFound` → `NotFoundError`,
  `ActionController::RoutingError` → `TypeError / AbortError`,
  Rails error vocabulary → TypeError, AbortError, DOMException, GraphQL client errors
- Replace architecture vocabulary: "Models" → "Components", "Controllers" → "Pages/Routes",
  "Concerns" → "Hooks"
- Ensure this exists: "When a plan requires new API queries/mutations, include a 'Request
  for BE team' section: ideal query shape, missing API capabilities, N+1 risks."
- Replace "JS or Rails test" → "project's test framework from CLAUDE.local.md"

---

**4e. plan-ceo-review/SKILL.md.tmpl**

- Apply the same vocabulary replacements as plan-eng-review (4d)

---

**4f. qa/SKILL.md.tmpl + qa-only/SKILL.md.tmpl**

- If upstream re-added a `### Rails` framework guidance subsection in the template, remove it
  (also check `generateQAMethodology()` in the generator — covered in Step 3)
- Ensure React/SPA checks are present: hydration errors, client-side routing, CLS
- Change artifact path references from `.gstack/` to `.local-context/`

---

**4g. browse/SKILL.md.tmpl (and root SKILL.md.tmpl)**

- Change any artifact path references from `.gstack/` to `.local-context/`
- If no `.gstack/` references exist, skip

---

**4h. Verify ALL remaining skills are stack-agnostic**

Every skill not explicitly adapted in 4a–4g must be checked for Rails/Ruby vocabulary
before passing through. Do not assume any skill is clean — upstream may have added
framework-specific content to previously agnostic skills.

Scan every `.tmpl` file not already handled above:
```bash
grep -rn 'ActiveRecord\|bin/test-lane\|npm run test\|Rails\|Models/Controllers\|Controllers & views\|Models & services\|rescue\|migration' \
  document-release/SKILL.md.tmpl \
  gstack-upgrade/SKILL.md.tmpl \
  setup-browser-cookies/SKILL.md.tmpl \
  SKILL.md.tmpl \
  browse/SKILL.md.tmpl
```

Also check any NEW `.tmpl` files that upstream may have added since the last sync:
```bash
find . -name 'SKILL.md.tmpl' -not -path './node_modules/*' | sort
```

Compare this list against the skills handled in 4a–4g. Any template not listed above
is new — read it, check for Rails/Ruby vocabulary, and apply adaptations if needed.

If grep matches are found in any file, apply the same vocabulary replacements described
in the earlier steps. If all files are clean, they pass through unchanged.

### Step 5 — Regenerate all SKILL.md files

```bash
bun install && bun run gen:skill-docs
```

Verify regeneration:
```bash
git diff --stat
```

Every `*/SKILL.md` should show changes matching the template/generator modifications.

**Sanity check** — confirm no governed-trimmed content leaked through:
```bash
grep -rn '_UPD=\|Contributor Mode\|bin/test-lane\|ActiveRecord\|Controllers & views' */SKILL.md SKILL.md
```

If any matches are found, trace back to the template or generator and fix.

### Step 6 — Commit and push

Stage templates, generator, and generated files:
```bash
git add scripts/gen-skill-docs.ts
git add $(find . -name 'SKILL.md.tmpl' -not -path './node_modules/*')
git add $(find . -name 'SKILL.md' -not -path './node_modules/*' -not -path './sync-gstack/*')
```

Read the upstream VERSION for the commit message:
```bash
cat VERSION
```

Commit referencing the upstream version (replace `<VERSION>` with the value from above):
```bash
git commit -m "Sync upstream v<VERSION>: trim preamble in generator, apply React/TS template adaptations"
```

Push to the fork:
```bash
git push origin HEAD
```

### Step 7 — Create PR

Create the PR on the fork repo. Replace `<VERSION>` with the upstream version and fill in
the changelog summary from Step 1.

```bash
gh pr create --repo lucaslim/gstack-governed \
  --title "Sync upstream v<VERSION>" \
  --body "$(cat <<'EOF'
## Summary

Synced with upstream garrytan/gstack and applied governed modifications:

**Generator changes (scripts/gen-skill-docs.ts):**
- `generatePreamble()`: stripped to AskUserQuestion format only (removed update check, session tracking, contributor mode)
- `generateQAMethodology()`: removed Rails framework guidance subsection (if re-added by upstream)

**Template adaptations (.tmpl files):**
- ship: removed VERSION/CHANGELOG/eval/TODOS steps, replaced test commands, React/TS commit vocab
- review: ActiveRecord/ORM → GraphQL, Models/Controllers/Concerns → Components/Hooks/Services/Utils
- retro: Models/Controllers/Concerns → Components/Hooks/Services/Utils
- plan-eng-review: Rails errors → React/TS, added BE team request section, replaced test commands
- plan-ceo-review: same vocab as plan-eng-review
- qa + qa-only: removed Rails subsection, .gstack/ → .local-context/

**Stack-agnostic (passed through):** document-release, gstack-upgrade, setup-browser-cookies

**Regenerated:** All SKILL.md files via `bun run gen:skill-docs`

## Upstream changes

<paste changelog diff summary from Step 1>

## Review checklist

- [ ] Generator: `generatePreamble()` outputs only AskUserQuestion format
- [ ] Generator: `generateQAMethodology()` has no Rails subsection
- [ ] Templates: no `bin/test-lane`, `npm run test`, or Rails vocabulary
- [ ] Templates: `.local-context/` used instead of `.gstack/` for QA artifacts
- [ ] Generated: `bun run gen:skill-docs --dry-run` shows all FRESH
- [ ] review/checklist.md, review/TODOS-format.md untouched
- [ ] Stack-agnostic skills passed through unchanged
EOF
)"
```

### Step 8 — Report

Print:
- Upstream version synced to
- Summary of upstream changes (from CHANGELOG diff in Step 1)
- Which templates were modified vs. passed through
- Link to PR
- Reminder: after merging, deploy with:
  ```
  cd ~/.claude/skills/gstack-governed && git checkout main && git pull && ./setup
  ```

## Skill Coverage Reference

All skills and their sync treatment:

| Skill | Template | Adaptation |
|-------|----------|------------|
| gstack (root) | SKILL.md.tmpl | Preamble trim via generator; .gstack/ → .local-context/ |
| browse | browse/SKILL.md.tmpl | Preamble trim via generator; .gstack/ → .local-context/ |
| ship | ship/SKILL.md.tmpl | Remove VERSION/CHANGELOG/eval/TODOS; React/TS vocab; test cmds |
| review | review/SKILL.md.tmpl | ActiveRecord → GraphQL; Models/Controllers → Components/Hooks |
| retro | retro/SKILL.md.tmpl | Models/Controllers/Concerns → Components/Hooks/Services/Utils |
| plan-eng-review | plan-eng-review/SKILL.md.tmpl | Rails errors → React/TS; add BE team section; test cmds |
| plan-ceo-review | plan-ceo-review/SKILL.md.tmpl | Same as plan-eng-review |
| qa | qa/SKILL.md.tmpl | Remove Rails subsection; .gstack/ → .local-context/ |
| qa-only | qa-only/SKILL.md.tmpl | Same as qa |
| document-release | document-release/SKILL.md.tmpl | Verify clean, then pass through |
| gstack-upgrade | gstack-upgrade/SKILL.md.tmpl | Verify clean, then pass through |
| setup-browser-cookies | setup-browser-cookies/SKILL.md.tmpl | Verify clean, then pass through |
| (any new upstream skill) | (detect in 4h) | Verify clean, adapt if needed |

**Not generated from template:** sync-gstack/SKILL.md (this file), review/checklist.md,
review/TODOS-format.md — maintained directly in the fork.
