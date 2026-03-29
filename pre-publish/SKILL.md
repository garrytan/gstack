---
name: pre-publish
preamble-tier: 2
version: 1.0.0
description: |
  Pre-publish repo hygiene audit. Scans every git-tracked file before a repo
  goes public and catches dev scaffolding, hardcoded credentials, security
  disclosures, language inconsistency, and PII in sample/fixture data.
  Use before making any repo public, or run periodically on existing public repos.
  Proactively suggest when a user says "make this public", "open source this",
  or "publish this repo".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_PROACTIVE_PROMPTED=$([ -f ~/.gstack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_SKILL_PREFIX=$(~/.claude/skills/gstack/bin/gstack-config get skill_prefix 2>/dev/null || echo "false")
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
echo "SKILL_PREFIX: $_SKILL_PREFIX"
source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
REPO_MODE=${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
echo '{"skill":"document-release","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  if [ -f "$_PF" ]; then
    if [ "$_TEL" != "off" ] && [ -x "~/.claude/skills/gstack/bin/gstack-telemetry-log" ]; then
      ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true
    fi
    rm -f "$_PF" 2>/dev/null || true
  fi
  break
done
```



# /pre-publish — Repo Hygiene Audit

You are a pre-publish safety gate. Your job: scan every git-tracked file before a repo goes public and catch anything that would be embarrassing, dangerous, or harmful once visible to the world.

**Posture:** conservative. Flag on doubt. A false positive costs 30 seconds. A false negative costs users' privacy, API credits, or security.

**Five categories. All mandatory. No skips.**

---

## Step 0: Establish scope

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: not inside a git repo."
  exit 1
fi
REPO_NAME=$(basename "$REPO_ROOT")
echo "Auditing: $REPO_NAME"

git ls-files | grep -vE "^(\.venv|venv|node_modules|\.yarn|dist/|build/|__pycache__)" \
  > /tmp/pp_files.txt
TOTAL=$(wc -l < /tmp/pp_files.txt | tr -d ' ')
echo "Tracked files: $TOTAL"
```

---

## Step 1: Dev scaffolding

Files that belong in a developer's local workflow, not a public repo.

```bash
echo "=== 1. DEV SCAFFOLDING ==="

# Known scaffolding names
grep -iE "^(TODOS?|PLAN|FIXME|NOTES|ROADMAP-internal|SCRATCHPAD|INTERNAL|DRAFT|WIP|HACKS?|DEVNOTES?)\.(md|txt|yaml)?$" \
  /tmp/pp_files.txt

# gstack autoplan outputs (contain internal review reports)
grep -iE "(PLAN\.md$|\.plan\.md$)" /tmp/pp_files.txt

# CLAUDE.md with personal tool config rather than contributor guide
if git show HEAD:CLAUDE.md > /tmp/pp_claude.txt 2>/dev/null; then
  if grep -qiE "(available skills|gstack skills|/browse|/ship|/qa)" /tmp/pp_claude.txt; then
    echo "SCAFFOLDING | CLAUDE.md | contains personal tool config, not a contributor guide"
  fi
fi

# Personal deployment guides (contain names, personal paths)
grep -iE "(DEPLOY_FOR_|FOR_[A-Z]{2,}\.md$|SETUP_[A-Z]{2,}\.md$)" /tmp/pp_files.txt
```

Severity: **MEDIUM**. Offer to delete each finding or move to a gitignored `docs/internal/` folder.

---

## Step 2: Credentials and secrets

```bash
echo "=== 2. CREDENTIALS ==="

# Real credential patterns (skip obvious placeholders)
PATTERN='(sk-ant-api[0-9]{3}-[A-Za-z0-9_\-]{20,}|sk-[a-zA-Z0-9\-]{40,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]\s*[=:]\s*["\x27]?[A-Za-z0-9_\-]{32,}|[Ss][Ee][Cc][Rr][Ee][Tt]\s*[=:]\s*["\x27]?[A-Za-z0-9_\-]{20,})'
EXCLUDE='(example|placeholder|YOUR_|<YOUR|xxx|\.\.\.|fake|test_key|mock|your_.*_here)'

while IFS= read -r f; do
  [ -f "$REPO_ROOT/$f" ] || continue
  hit=$(grep -nE "$PATTERN" "$REPO_ROOT/$f" 2>/dev/null | grep -viE "$EXCLUDE" | head -3)
  [ -n "$hit" ] && echo "CREDENTIAL | $f | $hit"
done < /tmp/pp_files.txt

# Tracked .env files — always wrong
grep -E "(^|/)\.env$" /tmp/pp_files.txt | while read f; do
  echo "CREDENTIAL | $f | .env tracked in git — must be in .gitignore"
done
```

Severity: **CRITICAL**. For every real key found:
1. Show only the first 12 characters: `sk-kimi-g944...`
2. Say: "Revoke this key immediately before proceeding. Deleting the file is not enough — it is in git history."
3. Offer to run `git filter-repo --path {file} --invert-paths` to purge it from all commits.
4. Provide the vendor's key management URL if recognizable (Anthropic: console.anthropic.com/settings/keys; OpenAI: platform.openai.com/api-keys; Moonshot: platform.moonshot.cn/console/api-keys; DeepSeek: platform.deepseek.com/api_keys; AWS: console.aws.amazon.com/iam/home#/security_credentials).

---

## Step 3: Security disclosures

Undisclosed security issues documented in tracked files that are now public.

```bash
echo "=== 3. SECURITY DISCLOSURES ==="

grep -rniE \
  "(cannot ship|do not ship|not safe for production|security hardening deferred|\
no auth|unauthenticated.*port|no authentication|auth.*not implemented|\
security.*todo|security.*fixme|vulnerable|exposed.*endpoint|\
do not commit|do not push)" \
  "$REPO_ROOT" \
  --include="*.md" --include="*.txt" --include="*.yaml" \
  2>/dev/null | grep -vE "node_modules|\.venv|\.git" | head -20 | while read line; do
    echo "SECURITY | $line"
  done
```

Severity: **MEDIUM** if the issue is documented and linked to a GitHub Issue. **HIGH** if not.

---

## Step 4: Language consistency

```bash
echo "=== 4. LANGUAGE CONSISTENCY ==="

README_LANG="unknown"
if [ -f "$REPO_ROOT/README.md" ]; then
  README_LANG=$(python3 -c "
import re
text = open('$REPO_ROOT/README.md').read()[:800]
zh = len(re.findall(r'[\u4e00-\u9fff]', text))
en = len(re.findall(r'[a-zA-Z]', text))
print('zh' if zh > en * 0.15 else 'en')
" 2>/dev/null || echo "unknown")
fi
echo "README: $README_LANG"

for doc in DEPLOYMENT.md CONTRIBUTING.md INSTALL.md SETUP.md GUIDE.md; do
  [ -f "$REPO_ROOT/$doc" ] || continue
  lang=$(python3 -c "
import re
text = open('$REPO_ROOT/$doc').read()[:600]
zh = len(re.findall(r'[\u4e00-\u9fff]', text))
en = len(re.findall(r'[a-zA-Z]', text))
print('zh' if zh > en * 0.15 else 'en')
" 2>/dev/null || echo "unknown")
  [ "$lang" != "$README_LANG" ] && [ "$lang" != "unknown" ] && \
    echo "LANGUAGE | $doc | README=$README_LANG doc=$lang"
done
```

Severity: **MEDIUM**. Offer to translate the mismatched doc (backup original locally first).

---

## Step 5: Privacy and PII

The most serious category. PII committed to git cannot be truly removed — it lives in history forever once pushed.

Check: `data/`, `datasets/`, `samples/`, `fixtures/`, `examples/`, `testdata/`, `demo/`, any `.json/.jsonl/.csv/.tsv` in any directory, files with "chat", "message", "export", "backup" in the name.

```bash
echo "=== 5. PRIVACY / PII ==="

# High-risk files by path
grep -iE "(^|/)(data|dataset|sample|fixture|example|testdata|demo|export|backup|dump|chat|message|conversation|record)s?/" \
  /tmp/pp_files.txt

# High-risk files by extension (excluding package manifests)
grep -iE "\.(jsonl?|csv|tsv|sqlite|db)$" /tmp/pp_files.txt | \
  grep -vE "(package\.json|tsconfig|pyproject|requirements|Pipfile|\.schema\.)"

# Scan data-adjacent files for PII signals
grep -iE "\.(json|jsonl|csv|tsv|txt|md)$" /tmp/pp_files.txt | \
  grep -iE "(data|sample|fixture|example|demo|chat|message|export|test)" | \
  head -30 | while IFS= read -r f; do
  [ -f "$REPO_ROOT/$f" ] || continue
  # Chinese phone numbers
  phone=$(grep -cE '1[3-9][0-9]{9}' "$REPO_ROOT/$f" 2>/dev/null || echo 0)
  # Real email addresses (not safe placeholder domains)
  real_email=$(grep -oE '[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}' "$REPO_ROOT/$f" 2>/dev/null | \
    grep -cvE '@(example|test|foo|bar|domain|email|company|your|mail)\.(com|org|net|io)' 2>/dev/null || echo 0)
  # WeChat/social fields in JSON
  wechat=$(grep -cE '"(nickname|wxid|openid|unionid|username|realname|display_name|sender)"\s*:\s*"[^"]{2,}"' \
    "$REPO_ROOT/$f" 2>/dev/null || echo 0)
  # Personal file system paths
  paths=$(grep -cE '(/Users/[A-Za-z][^/\s]{2,}/|C:\\Users\\[^\\]+\\|/home/[a-z][^/\s]{2,}/)' \
    "$REPO_ROOT/$f" 2>/dev/null || echo 0)
  if [ "$phone" -gt 0 ] || [ "$real_email" -gt 0 ] || [ "$wechat" -gt 0 ] || [ "$paths" -gt 0 ]; then
    echo "PII | $f | phones=$phone real_emails=$real_email wechat_fields=$wechat personal_paths=$paths"
  fi
done

# Personal info in any doc
grep -rniE \
  "(@gmail\.com|@qq\.com|@163\.com|@126\.com|@hotmail\.com|/Users/[A-Z][a-z]{2,}/Desktop)" \
  "$REPO_ROOT" \
  --include="*.md" --include="*.txt" --include="*.yaml" \
  2>/dev/null | grep -vE "node_modules|\.venv|\.git|example|placeholder" | head -10 | while read line; do
    echo "PII | $line"
  done
```

Severity: **CRITICAL** for real PII. Say: "Deleting the file is not enough. Use `git filter-repo` to purge history, then notify affected users if required by law (GDPR, PIPL, CCPA)."

---

## Step 6: .gitignore completeness

```bash
echo "=== 6. GITIGNORE CHECK ==="
for pattern in ".env" "*.env" "data/" "storage/" "node_modules/" "__pycache__/" "*.key" "*.pem" "*.sqlite" "*.db"; do
  grep -qF "$pattern" "$REPO_ROOT/.gitignore" 2>/dev/null || \
    echo "MISSING_FROM_GITIGNORE | $pattern"
done
```

Offer to append missing patterns.

---

## Step 7: Report and fix loop

Compile all findings into a single structured report:

```
PRE-PUBLISH AUDIT: {repo}
Tracked files scanned: {N}
────────────────────────────────────────
CRITICAL  {n}  ← must fix, do not publish
HIGH      {n}  ← strongly recommended
MEDIUM    {n}  ← fix if possible
────────────────────────────────────────
[CRITICAL] {category} | {file} | {description}
           Action: {specific next step}

[HIGH]     ...

[MEDIUM]   ...

VERDICT: BLOCKED / PROCEED_WITH_CAUTION / CLEAN
```

- **BLOCKED** — any CRITICAL finding. Do not publish until resolved.
- **PROCEED_WITH_CAUTION** — HIGH or MEDIUM only.
- **CLEAN** — no findings.

For each finding, use AskUserQuestion to offer fixes. Auto-fix MEDIUM findings (delete scaffolding files, add .gitignore entries). Ask before touching credentials or PII (irreversible operations).

## Telemetry (run last)

After the skill workflow completes (success, error, or abort), log the telemetry event.
Determine the skill name from the `name:` field in this file's YAML frontmatter.
Determine the outcome from the workflow result (success if completed normally, error
if it failed, abort if the user interrupted).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This command writes telemetry to
`~/.gstack/analytics/` (user config directory, not project files). The skill
preamble already writes to the same directory — this is the same pattern.
Skipping this command loses session duration and outcome data.

Run this bash:

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
# Local analytics (always available, no binary needed)
echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# Remote telemetry (opt-in, requires binary)
if [ "$_TEL" != "off" ] && [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
  ~/.claude/skills/gstack/bin/gstack-telemetry-log \
    --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
    --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
fi
```

Replace `SKILL_NAME` with the actual skill name from frontmatter, `OUTCOME` with
success/error/abort, and `USED_BROWSE` with true/false based on whether `$B` was used.
If you cannot determine the outcome, use "unknown". The local JSONL always logs. The
remote binary only runs if telemetry is not off and the binary exists.

## Plan Status Footer

When you are in plan mode and about to call ExitPlanMode:

1. Check if the plan file already has a `## GSTACK REVIEW REPORT` section.
2. If it DOES — skip (a review skill already wrote a richer report).
3. If it does NOT — run this command:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-read
\`\`\`

Then write a `## GSTACK REVIEW REPORT` section to the end of the plan file:

- If the output contains review entries (JSONL lines before `---CONFIG---`): format the
  standard report table with runs/status/findings per skill, same format as the review
  skills use.
- If the output is `NO_REVIEWS` or empty: write this placeholder table:

\`\`\`markdown
## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \`/plan-ceo-review\` | Scope & strategy | 0 | — | — |
| Codex Review | \`/codex review\` | Independent 2nd opinion | 0 | — | — |
| Eng Review | \`/plan-eng-review\` | Architecture & tests (required) | 0 | — | — |
| Design Review | \`/plan-design-review\` | UI/UX gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run \`/autoplan\` for full review pipeline, or individual reviews above.
\`\`\`

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes to the plan file, which is the one
file you are allowed to edit in plan mode. The plan file review report is part of the
plan's living status.

## Step 0: Detect platform and base branch

First, detect the git hosting platform from the remote URL:

```bash
git remote get-url origin 2>/dev/null
```

- If the URL contains "github.com" → platform is **GitHub**
- If the URL contains "gitlab" → platform is **GitLab**
- Otherwise, check CLI availability:
  - `gh auth status 2>/dev/null` succeeds → platform is **GitHub** (covers GitHub Enterprise)
  - `glab auth status 2>/dev/null` succeeds → platform is **GitLab** (covers self-hosted)
  - Neither → **unknown** (use git-native commands only)

Determine which branch this PR/MR targets, or the repo's default branch if no
PR/MR exists. Use the result as "the base branch" in all subsequent steps.

**If GitHub:**
1. `gh pr view --json baseRefName -q .baseRefName` — if succeeds, use it
2. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` — if succeeds, use it

**If GitLab:**
1. `glab mr view -F json 2>/dev/null` and extract the `target_branch` field — if succeeds, use it
2. `glab repo view -F json 2>/dev/null` and extract the `default_branch` field — if succeeds, use it

**Git-native fallback (if unknown platform, or CLI commands fail):**
1. `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'`
2. If that fails: `git rev-parse --verify origin/main 2>/dev/null` → use `main`
3. If that fails: `git rev-parse --verify origin/master 2>/dev/null` → use `master`

If all fail, fall back to `main`.

Print the detected base branch name. In every subsequent `git diff`, `git log`,
`git fetch`, `git merge`, and PR/MR creation command, substitute the detected
branch name wherever the instructions say "the base branch" or `<default>`.

---

# Document Release: Post-Ship Documentation Update

You are running the `/document-release` workflow. This runs **after `/ship`** (code committed, PR
exists or about to exist) but **before the PR merges**. Your job: ensure every documentation file
in the project is accurate, up to date, and written in a friendly, user-forward voice.

You are mostly automated. Make obvious factual updates directly. Stop and ask only for risky or
subjective decisions.

**Only stop for:**
- Risky/questionable doc changes (narrative, philosophy, security, removals, large rewrites)
- VERSION bump decision (if not already bumped)
- New TODOS items to add
- Cross-doc contradictions that are narrative (not factual)

**Never stop for:**
- Factual corrections clearly from the diff
- Adding items to tables/lists
- Updating paths, counts, version numbers
- Fixing stale cross-references
- CHANGELOG voice polish (minor wording adjustments)
- Marking TODOS complete
- Cross-doc factual inconsistencies (e.g., version number mismatch)

**NEVER do:**
- Overwrite, replace, or regenerate CHANGELOG entries — polish wording only, preserve all content
- Bump VERSION without asking — always use AskUserQuestion for version changes
- Use `Write` tool on CHANGELOG.md — always use `Edit` with exact `old_string` matches

---

## Step 1: Pre-flight & Diff Analysis

1. Check the current branch. If on the base branch, **abort**: "You're on the base branch. Run from a feature branch."

2. Gather context about what changed:

```bash
git diff <base>...HEAD --stat
```

```bash
git log <base>..HEAD --oneline
```

```bash
git diff <base>...HEAD --name-only
```

3. Discover all documentation files in the repo:

```bash
find . -maxdepth 2 -name "*.md" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./.gstack/*" -not -path "./.context/*" | sort
```

4. Classify the changes into categories relevant to documentation:
   - **New features** — new files, new commands, new skills, new capabilities
   - **Changed behavior** — modified services, updated APIs, config changes
   - **Removed functionality** — deleted files, removed commands
   - **Infrastructure** — build system, test infrastructure, CI

5. Output a brief summary: "Analyzing N files changed across M commits. Found K documentation files to review."

---

## Step 2: Per-File Documentation Audit

Read each documentation file and cross-reference it against the diff. Use these generic heuristics
(adapt to whatever project you're in — these are not gstack-specific):

**README.md:**
- Does it describe all features and capabilities visible in the diff?
- Are install/setup instructions consistent with the changes?
- Are examples, demos, and usage descriptions still valid?
- Are troubleshooting steps still accurate?

**ARCHITECTURE.md:**
- Do ASCII diagrams and component descriptions match the current code?
- Are design decisions and "why" explanations still accurate?
- Be conservative — only update things clearly contradicted by the diff. Architecture docs
  describe things unlikely to change frequently.

**CONTRIBUTING.md — New contributor smoke test:**
- Walk through the setup instructions as if you are a brand new contributor.
- Are the listed commands accurate? Would each step succeed?
- Do test tier descriptions match the current test infrastructure?
- Are workflow descriptions (dev setup, contributor mode, etc.) current?
- Flag anything that would fail or confuse a first-time contributor.

**CLAUDE.md / project instructions:**
- Does the project structure section match the actual file tree?
- Are listed commands and scripts accurate?
- Do build/test instructions match what's in package.json (or equivalent)?

**Any other .md files:**
- Read the file, determine its purpose and audience.
- Cross-reference against the diff to check if it contradicts anything the file says.

For each file, classify needed updates as:

- **Auto-update** — Factual corrections clearly warranted by the diff: adding an item to a
  table, updating a file path, fixing a count, updating a project structure tree.
- **Ask user** — Narrative changes, section removal, security model changes, large rewrites
  (more than ~10 lines in one section), ambiguous relevance, adding entirely new sections.

---

## Step 3: Apply Auto-Updates

Make all clear, factual updates directly using the Edit tool.

For each file modified, output a one-line summary describing **what specifically changed** — not
just "Updated README.md" but "README.md: added /new-skill to skills table, updated skill count
from 9 to 10."

**Never auto-update:**
- README introduction or project positioning
- ARCHITECTURE philosophy or design rationale
- Security model descriptions
- Do not remove entire sections from any document

---

## Step 4: Ask About Risky/Questionable Changes

For each risky or questionable update identified in Step 2, use AskUserQuestion with:
- Context: project name, branch, which doc file, what we're reviewing
- The specific documentation decision
- `RECOMMENDATION: Choose [X] because [one-line reason]`
- Options including C) Skip — leave as-is

Apply approved changes immediately after each answer.

---

## Step 5: CHANGELOG Voice Polish

**CRITICAL — NEVER CLOBBER CHANGELOG ENTRIES.**

This step polishes voice. It does NOT rewrite, replace, or regenerate CHANGELOG content.

A real incident occurred where an agent replaced existing CHANGELOG entries when it should have
preserved them. This skill must NEVER do that.

**Rules:**
1. Read the entire CHANGELOG.md first. Understand what is already there.
2. Only modify wording within existing entries. Never delete, reorder, or replace entries.
3. Never regenerate a CHANGELOG entry from scratch. The entry was written by `/ship` from the
   actual diff and commit history. It is the source of truth. You are polishing prose, not
   rewriting history.
4. If an entry looks wrong or incomplete, use AskUserQuestion — do NOT silently fix it.
5. Use Edit tool with exact `old_string` matches — never use Write to overwrite CHANGELOG.md.

**If CHANGELOG was not modified in this branch:** skip this step.

**If CHANGELOG was modified in this branch**, review the entry for voice:

- **Sell test:** Would a user reading each bullet think "oh nice, I want to try that"? If not,
  rewrite the wording (not the content).
- Lead with what the user can now **do** — not implementation details.
- "You can now..." not "Refactored the..."
- Flag and rewrite any entry that reads like a commit message.
- Internal/contributor changes belong in a separate "### For contributors" subsection.
- Auto-fix minor voice adjustments. Use AskUserQuestion if a rewrite would alter meaning.

---

## Step 6: Cross-Doc Consistency & Discoverability Check

After auditing each file individually, do a cross-doc consistency pass:

1. Does the README's feature/capability list match what CLAUDE.md (or project instructions) describes?
2. Does ARCHITECTURE's component list match CONTRIBUTING's project structure description?
3. Does CHANGELOG's latest version match the VERSION file?
4. **Discoverability:** Is every documentation file reachable from README.md or CLAUDE.md? If
   ARCHITECTURE.md exists but neither README nor CLAUDE.md links to it, flag it. Every doc
   should be discoverable from one of the two entry-point files.
5. Flag any contradictions between documents. Auto-fix clear factual inconsistencies (e.g., a
   version mismatch). Use AskUserQuestion for narrative contradictions.

---

## Step 7: TODOS.md Cleanup

This is a second pass that complements `/ship`'s Step 5.5. Read `review/TODOS-format.md` (if
available) for the canonical TODO item format.

If TODOS.md does not exist, skip this step.

1. **Completed items not yet marked:** Cross-reference the diff against open TODO items. If a
   TODO is clearly completed by the changes in this branch, move it to the Completed section
   with `**Completed:** vX.Y.Z.W (YYYY-MM-DD)`. Be conservative — only mark items with clear
   evidence in the diff.

2. **Items needing description updates:** If a TODO references files or components that were
   significantly changed, its description may be stale. Use AskUserQuestion to confirm whether
   the TODO should be updated, completed, or left as-is.

3. **New deferred work:** Check the diff for `TODO`, `FIXME`, `HACK`, and `XXX` comments. For
   each one that represents meaningful deferred work (not a trivial inline note), use
   AskUserQuestion to ask whether it should be captured in TODOS.md.

---

## Step 8: VERSION Bump Question

**CRITICAL — NEVER BUMP VERSION WITHOUT ASKING.**

1. **If VERSION does not exist:** Skip silently.

2. Check if VERSION was already modified on this branch:

```bash
git diff <base>...HEAD -- VERSION
```

3. **If VERSION was NOT bumped:** Use AskUserQuestion:
   - RECOMMENDATION: Choose C (Skip) because docs-only changes rarely warrant a version bump
   - A) Bump PATCH (X.Y.Z+1) — if doc changes ship alongside code changes
   - B) Bump MINOR (X.Y+1.0) — if this is a significant standalone release
   - C) Skip — no version bump needed

4. **If VERSION was already bumped:** Do NOT skip silently. Instead, check whether the bump
   still covers the full scope of changes on this branch:

   a. Read the CHANGELOG entry for the current VERSION. What features does it describe?
   b. Read the full diff (`git diff <base>...HEAD --stat` and `git diff <base>...HEAD --name-only`).
      Are there significant changes (new features, new skills, new commands, major refactors)
      that are NOT mentioned in the CHANGELOG entry for the current version?
   c. **If the CHANGELOG entry covers everything:** Skip — output "VERSION: Already bumped to
      vX.Y.Z, covers all changes."
   d. **If there are significant uncovered changes:** Use AskUserQuestion explaining what the
      current version covers vs what's new, and ask:
      - RECOMMENDATION: Choose A because the new changes warrant their own version
      - A) Bump to next patch (X.Y.Z+1) — give the new changes their own version
      - B) Keep current version — add new changes to the existing CHANGELOG entry
      - C) Skip — leave version as-is, handle later

   The key insight: a VERSION bump set for "feature A" should not silently absorb "feature B"
   if feature B is substantial enough to deserve its own version entry.

---

## Step 9: Commit & Output

**Empty check first:** Run `git status` (never use `-uall`). If no documentation files were
modified by any previous step, output "All documentation is up to date." and exit without
committing.

**Commit:**

1. Stage modified documentation files by name (never `git add -A` or `git add .`).
2. Create a single commit:

```bash
git commit -m "$(cat <<'EOF'
docs: update project documentation for vX.Y.Z.W

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

3. Push to the current branch:

```bash
git push
```

**PR/MR body update (idempotent, race-safe):**

1. Read the existing PR/MR body into a PID-unique tempfile (use the platform detected in Step 0):

**If GitHub:**
```bash
gh pr view --json body -q .body > /tmp/gstack-pr-body-$$.md
```

**If GitLab:**
```bash
glab mr view -F json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('description',''))" > /tmp/gstack-pr-body-$$.md
```

2. If the tempfile already contains a `## Documentation` section, replace that section with the
   updated content. If it does not contain one, append a `## Documentation` section at the end.

3. The Documentation section should include a **doc diff preview** — for each file modified,
   describe what specifically changed (e.g., "README.md: added /document-release to skills
   table, updated skill count from 9 to 10").

4. Write the updated body back:

**If GitHub:**
```bash
gh pr edit --body-file /tmp/gstack-pr-body-$$.md
```

**If GitLab:**
Read the contents of `/tmp/gstack-pr-body-$$.md` using the Read tool, then pass it to `glab mr update` using a heredoc to avoid shell metacharacter issues:
```bash
glab mr update -d "$(cat <<'MRBODY'
<paste the file contents here>
MRBODY
)"
```

5. Clean up the tempfile:

```bash
rm -f /tmp/gstack-pr-body-$$.md
```

6. If `gh pr view` / `glab mr view` fails (no PR/MR exists): skip with message "No PR/MR found — skipping body update."
7. If `gh pr edit` / `glab mr update` fails: warn "Could not update PR/MR body — documentation changes are in the
   commit." and continue.

**Structured doc health summary (final output):**

Output a scannable summary showing every documentation file's status:

```
Documentation health:
  README.md       [status] ([details])
  ARCHITECTURE.md [status] ([details])
  CONTRIBUTING.md [status] ([details])
  CHANGELOG.md    [status] ([details])
  TODOS.md        [status] ([details])
  VERSION         [status] ([details])
```

Where status is one of:
- Updated — with description of what changed
- Current — no changes needed
- Voice polished — wording adjusted
- Not bumped — user chose to skip
- Already bumped — version was set by /ship
- Skipped — file does not exist

---

## Important Rules

- **Read before editing.** Always read the full content of a file before modifying it.
- **Never clobber CHANGELOG.** Polish wording only. Never delete, replace, or regenerate entries.
- **Never bump VERSION silently.** Always ask. Even if already bumped, check whether it covers the full scope of changes.
- **Be explicit about what changed.** Every edit gets a one-line summary.
- **Generic heuristics, not project-specific.** The audit checks work on any repo.
- **Discoverability matters.** Every doc file should be reachable from README or CLAUDE.md.
- **Voice: friendly, user-forward, not obscure.** Write like you're explaining to a smart person
  who hasn't seen the code.

