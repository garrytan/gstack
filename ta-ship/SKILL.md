---
name: ta-ship
version: 1.0.0
description: |
  The Athletic ship workflow: codegen check, lint, commit with [TICKET] format,
  push, and create a PR using the Athletic pull_request_template. Extracts the
  JIRA ticket from the branch name automatically. Targets the correct base branch
  per repo (develop for apollo/web/hub). Use when asked to "ship", "push",
  "create a PR", "open a PR", or "commit and push".
triggers:
  - ship
  - push and open PR
  - create a PR
  - commit and push
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# /ta-ship — The Athletic Ship Workflow

Commit, push, and open a PR using the Athletic pull_request_template. Handles
repo-specific codegen, correct base branches, and JIRA ticket extraction.

---

## Step 1: Orientation

```bash
pwd
git branch --show-current
git remote get-url origin 2>/dev/null
git status --short
git diff --stat HEAD
```

**Detect repo** from the working directory path or remote URL:
- Path contains `theathletic-apollo-express` or remote contains `apollo-express` → **REPO=apollo**
- Path contains `/web` or remote ends in `TheAthletic/web` → **REPO=web**
- Path contains `/hub` or remote ends in `TheAthletic/hub` → **REPO=hub**
- Path contains `theathletic-serverless` or remote ends in `theathletic-serverless` → **REPO=serverless**
- Otherwise → **REPO=unknown**

**Base branch per repo:**
- apollo → `develop`
- web → `develop`
- hub → `develop`
- serverless → `develop`
- unknown → `develop` (fallback; verify with user if unsure)

**PR template location per repo:**
- apollo → `.github/pull_request_template.md`
- web → `docs/pull_request_template.md`
- hub → `docs/pull_request_template.md`
- serverless → `docs/pull_request_template.md`

**Extract JIRA ticket from branch name:**

Branch naming convention: `initials/PROJ_1234_description` or `proj-1234-description`

```bash
BRANCH=$(git branch --show-current)
# Match patterns like pcfc-2082, pcfc_2082, PCFC-2082
TICKET=$(echo "$BRANCH" | grep -oiE '[a-z]+-[0-9]+' | head -1 | tr '[:lower:]' '[:upper:]' | sed 's/_/-/')
echo "TICKET: ${TICKET:-NOT_FOUND}"
```

If `TICKET` is empty, check the last 5 commit messages for a ticket reference:
```bash
git log --oneline -5 | grep -oiE '\[?[A-Z]+-[0-9]+\]?' | head -1
```

If still not found, set `TICKET=JIRA-NUMBER` as a placeholder (fill in template).

**Guard: on base branch?**

If the current branch is `develop`, `main`, or `master` — **STOP**. Tell the user: "You're on the base branch. Create a feature branch first."

---

## Step 2: Codegen check

Run the appropriate codegen for the detected repo. **Skip entirely for `serverless`** — it has no GraphQL codegen.

For apollo/web/hub: Skip this step if the diff contains only non-schema, non-query files (docs, config, tests with no new queries).

### Apollo

Check whether schema files changed:
```bash
git diff HEAD --name-only | grep -E '\.(graphql|gql)$|src/schema\.ts'
```

If schema files changed, full codegen is required before this PR can be opened.
Run:
```bash
# Kill any existing servers on the required ports
lsof -ti :3333 -ti :3334 | xargs kill 2>/dev/null || true
sleep 1

# Start both servers in background
yarn dev:apollo &
APOLLO_PID=$!
yarn dev:subscriptions &
SUB_PID=$!

# Wait for subscriptions server (codegen introspects port 3334)
echo "Waiting for subscriptions server..."
for i in $(seq 1 30); do
  curl -s http://localhost:3334/gqlsubscriptions \
    -H 'Content-Type: application/json' \
    -d '{"query":"{ __typename }"}' 2>/dev/null | grep -q '__typename' && break
  sleep 2
done

# Run full codegen
yarn generate

# Typecheck
yarn typecheck

# Kill servers
kill $APOLLO_PID $SUB_PID 2>/dev/null || true
lsof -ti :3333 -ti :3334 | xargs kill 2>/dev/null || true
```

If codegen or typecheck fails — **STOP**. Show the error. Do not proceed.

After successful codegen, stage the generated file:
```bash
git add src/schema-types.ts supergraph.graphql 2>/dev/null || true
```

### Web

Check whether generated types exist:
```bash
ls src/generated/types.ts graphql.schema.json 2>/dev/null || echo "MISSING"
```

If missing, or if the diff adds/modifies `.graphql` files or files in `src/features/*/queries/`:
```bash
# Verify Apollo subscriptions server is reachable
curl -s http://localhost:3334/gqlsubscriptions \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}' 2>/dev/null | grep -q '__typename' \
  || { echo "ERROR: Apollo subscriptions server not running on :3334. Start it first: yarn dev:subscriptions (in apollo-express repo)"; exit 1; }

yarn generate-graph-types
```

If codegen fails — **STOP**. Do not proceed.

### Hub

Check whether generated types exist:
```bash
ls src/generated/graphql/ 2>/dev/null | wc -l | grep -qv '^0$' || echo "MISSING"
```

If missing, or if the diff adds/modifies `.graphql` files or files in `src/**/queries/`:
```bash
curl -s http://localhost:3334/gqlsubscriptions \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}' 2>/dev/null | grep -q '__typename' \
  || { echo "ERROR: Apollo subscriptions server not running on :3334. Start it first in the apollo-express repo."; exit 1; }

yarn generate-graph-types
```

If codegen fails — **STOP**. Do not proceed.

---

## Step 3: Lint and typecheck

```bash
yarn lint 2>&1 | tail -20
yarn typecheck 2>&1 | tail -20
```

**If lint or typecheck fails:** Show errors and use AskUserQuestion:
- "Lint/typecheck failed. Fix before shipping?"
- A) Yes — investigate and fix (recommended)
- B) Ship anyway — I'll fix in a follow-up

If B, note the failures in the PR description under "Known issues".

---

## Step 4: Tests

```bash
yarn test --passWithNoTests 2>&1 | tail -30
```

If tests fail, apply the same triage as lint above: in-branch failures block, pre-existing failures ask.

---

## Step 5: Commit

**Determine what to stage.** Never use `git add -A`. Review `git status` output and stage only intentional changes:

```bash
git status --short
```

For each untracked or modified file, decide whether it belongs in this commit.
Stage relevant files explicitly:
```bash
git add <file1> <file2> ...
```

**Compose the commit message.** Format: `[TICKET] Component/Area - Brief description`

- Extract component/area from the files changed (e.g. `Comments`, `LiveBlog`, `UserProfile`, `GraphQL Schema`)
- Keep the description under 72 chars after the ticket prefix
- Body: 1-2 sentences on *why*, not *what*

```bash
git commit -m "$(cat <<'EOF'
[TICKET] Component - Description

Why this change was needed (optional, omit if obvious).

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Replace `TICKET` with the extracted JIRA ticket.

---

## Step 6: Push

```bash
git push -u origin $(git branch --show-current)
```

If push fails due to pre-push hook (common cause: missing generated types) — fix the
underlying issue and retry. Do not use `--no-verify`.

---

## Step 7: Fill the PR template

Read the PR template for the detected repo:
- Apollo: `.github/pull_request_template.md`
- Web: `docs/pull_request_template.md`
- Hub: `docs/pull_request_template.md`

Gather context to fill it intelligently:
```bash
git diff origin/<base>...HEAD         # Full diff
git log origin/<base>..HEAD --oneline # Commit list
```

If `TICKET` is a real ticket (not the placeholder), fetch the JIRA description for context:
```bash
source ~/.zshrc 2>/dev/null
curl -s -u "mark.whelan@theathletic.com:$JIRA_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://theathletic.atlassian.net/rest/api/3/issue/${TICKET}" \
  2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
f = d.get('fields', {})
print('SUMMARY:', f.get('summary',''))
print('DESC:', str(f.get('description',''))[:300])
" 2>/dev/null || true
```

**Fill each section:**

### Description
Summarise what the PR does and why. Lead with the user-facing outcome, not the implementation. Reference any linked PRs in other repos if this is part of a cross-repo change.

### How could this cause a p1?
Be honest. Think through:
- What breaks if this code path is wrong?
- Any data mutation, caching change, or auth logic?
- If it's a pure UI addition with no data risk, say so.

### Screenshots (web/hub only)
- If the diff touches React components or SCSS → note that screenshots are required and leave the section for the author to fill in, or include a placeholder: `[Screenshots to be added — UI change in ComponentName]`
- If purely backend/schema → `Not UI related.`

### Testing — How can this be tested?
Write concrete steps based on the diff:
1. Environment/feature flag requirements
2. Step-by-step manual test path
3. Expected outcome

### PR title
Format: `[TICKET] Epic/Component - Clear description`
Example: `[PCFC-2082] LiveBlog - Add discuss tab to live blog page`

### JIRA ticket line
Replace `[JIRA-number]` at the bottom with the real ticket: `[${TICKET}](https://theathletic.atlassian.net/browse/${TICKET})`

---

## Step 8: Create the PR

```bash
gh pr create \
  --base <base-branch> \
  --title "[TICKET] Component - Description" \
  --body "$(cat <<'EOF'
<filled template body>
EOF
)"
```

Print the PR URL on completion.

---

## Rules

- **Never use `--no-verify`** on push or commit. If a hook fails, fix the underlying cause.
- **Never copy generated files** (`src/generated/types.ts`, `src/generated/graphql/`, `graphql.schema.json`) from another checkout. Always regenerate.
- **Never stage `src/generated/` files** — they are gitignored and must not be committed.
- **Always use absolute paths** when running commands in a worktree to avoid shifting the session CWD.
- **Node 22 required** for web git hooks: run `source ~/.nvm/nvm.sh && nvm use 22` if commit hooks fail on version mismatch.
