---
name: index
preamble-tier: 1
version: 1.0.0
description: |
  Generate a compact codebase index that gives AI assistants instant context.
  Maps routes, models, lib exports, pages/views, and components into small
  reference files — replacing 50K+ tokens of exploration per conversation.
  Works with any framework: Node.js, Laravel/PHP, Rails, Django, Go, Rust, etc.
  Use when asked to "index the codebase", "generate codex", "map the project",
  "create codebase index", or "build a project map".
  Proactively suggest when starting work in a new or unfamiliar project,
  or when CLAUDE.md has no codebase index section. (gstack)
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
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
find ~/.gstack/sessions -mmin +120 -type f -exec rm {} + 2>/dev/null || true
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
if [ "$_TEL" != "off" ]; then
echo '{"skill":"index","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
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
# Learnings count
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
  if [ "$_LEARN_COUNT" -gt 5 ] 2>/dev/null; then
    ~/.claude/skills/gstack/bin/gstack-learnings-search --limit 3 2>/dev/null || true
  fi
else
  echo "LEARNINGS: 0"
fi
# Session timeline: record skill start (local-only, never sent anywhere)
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"index","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
# Check if CLAUDE.md has routing rules
_HAS_ROUTING="no"
if [ -f CLAUDE.md ] && grep -q "## Skill routing" CLAUDE.md 2>/dev/null; then
  _HAS_ROUTING="yes"
fi
_ROUTING_DECLINED=$(~/.claude/skills/gstack/bin/gstack-config get routing_declined 2>/dev/null || echo "false")
echo "HAS_ROUTING: $_HAS_ROUTING"
echo "ROUTING_DECLINED: $_ROUTING_DECLINED"
```

If `PROACTIVE` is `"false"`, do not proactively suggest gstack skills AND do not
auto-invoke skills based on conversation context. Only run skills the user explicitly
types (e.g., /qa, /ship). If you would have auto-invoked a skill, instead briefly say:
"I think /skillname might help here — want me to run it?" and wait for confirmation.
The user opted out of proactive behavior.

If `SKILL_PREFIX` is `"true"`, the user has namespaced skill names. When suggesting
or invoking other gstack skills, use the `/gstack-` prefix (e.g., `/gstack-qa` instead
of `/qa`, `/gstack-ship` instead of `/ship`). Disk paths are unaffected — always use
`~/.claude/skills/gstack/[skill-name]/SKILL.md` for reading skill files.

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

If `LAKE_INTRO` is `no`: Before continuing, introduce the Completeness Principle.
Tell the user: "gstack follows the **Boil the Lake** principle — always do the complete
thing when AI makes the marginal cost near-zero. Read more: https://garryslist.org/posts/boil-the-ocean"
Then offer to open the essay in their default browser:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

Only run `open` if the user says yes. Always run `touch` to mark as seen. This only happens once.

If `TEL_PROMPTED` is `no` AND `LAKE_INTRO` is `yes`: After the lake intro is handled,
ask the user about telemetry. Use AskUserQuestion:

> Help gstack get better! Community mode shares usage data (which skills you use, how long
> they take, crash info) with a stable device ID so we can track trends and fix bugs faster.
> No code, file paths, or repo names are ever sent.
> Change anytime with `gstack-config set telemetry off`.

Options:
- A) Help gstack get better! (recommended)
- B) No thanks

If A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry community`

If B: ask a follow-up AskUserQuestion:

> How about anonymous mode? We just learn that *someone* used gstack — no unique ID,
> no way to connect sessions. Just a counter that helps us know if anyone's out there.

Options:
- A) Sure, anonymous is fine
- B) No thanks, fully off

If B→A: run `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous`
If B→B: run `~/.claude/skills/gstack/bin/gstack-config set telemetry off`

Always run:
```bash
touch ~/.gstack/.telemetry-prompted
```

This only happens once. If `TEL_PROMPTED` is `yes`, skip this entirely.

If `PROACTIVE_PROMPTED` is `no` AND `TEL_PROMPTED` is `yes`: After telemetry is handled,
ask the user about proactive behavior. Use AskUserQuestion:

> gstack can proactively figure out when you might need a skill while you work —
> like suggesting /qa when you say "does this work?" or /investigate when you hit
> a bug. We recommend keeping this on — it speeds up every part of your workflow.

Options:
- A) Keep it on (recommended)
- B) Turn it off — I'll type /commands myself

If A: run `~/.claude/skills/gstack/bin/gstack-config set proactive true`
If B: run `~/.claude/skills/gstack/bin/gstack-config set proactive false`

Always run:
```bash
touch ~/.gstack/.proactive-prompted
```

This only happens once. If `PROACTIVE_PROMPTED` is `yes`, skip this entirely.

If `HAS_ROUTING` is `no` AND `ROUTING_DECLINED` is `false` AND `PROACTIVE_PROMPTED` is `yes`:
Check if a CLAUDE.md file exists in the project root. If it does not exist, create it.

Use AskUserQuestion:

> gstack works best when your project's CLAUDE.md includes skill routing rules.
> This tells Claude to use specialized workflows (like /ship, /investigate, /qa)
> instead of answering directly. It's a one-time addition, about 15 lines.

Options:
- A) Add routing rules to CLAUDE.md (recommended)
- B) No thanks, I'll invoke skills manually

If A: Append this section to the end of CLAUDE.md:

```markdown

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
```

Then commit the change: `git add CLAUDE.md && git commit -m "chore: add gstack skill routing rules to CLAUDE.md"`

If B: run `~/.claude/skills/gstack/bin/gstack-config set routing_declined true`
Say "No problem. You can add routing rules later by running `gstack-config set routing_declined false` and re-running any skill."

This only happens once per project. If `HAS_ROUTING` is `yes` or `ROUTING_DECLINED` is `true`, skip this entirely.

## Voice

**Tone:** direct, concrete, sharp, never corporate, never academic. Sound like a builder, not a consultant. Name the file, the function, the command. No filler, no throat-clearing.

**Writing rules:** No em dashes (use commas, periods, "..."). No AI vocabulary (delve, crucial, robust, comprehensive, nuanced, etc.). Short paragraphs. End with what to do.

The user always has context you don't. Cross-model agreement is a recommendation, not a decision — the user decides.

## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — All steps completed successfully. Evidence provided for each claim.
- **DONE_WITH_CONCERNS** — Completed, but with issues the user should know about. List each concern.
- **BLOCKED** — Cannot proceed. State what is blocking and what was tried.
- **NEEDS_CONTEXT** — Missing information required to continue. State exactly what you need.

### Escalation

It is always OK to stop and say "this is too hard for me" or "I'm not confident in this result."

Bad work is worse than no work. You will not be penalized for escalating.
- If you have attempted a task 3 times without success, STOP and escalate.
- If you are uncertain about a security-sensitive change, STOP and escalate.
- If the scope of work exceeds what you can verify, STOP and escalate.

Escalation format:
```
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
```

## Operational Self-Improvement

Before completing, reflect on this session:
- Did any commands fail unexpectedly?
- Did you take a wrong approach and have to backtrack?
- Did you discover a project-specific quirk (build order, env vars, timing, auth)?
- Did something take longer than expected because of a missing flag or config?

If yes, log an operational learning for future sessions:

```bash
~/.claude/skills/gstack/bin/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
```

Replace SKILL_NAME with the current skill name. Only log genuine operational discoveries.
Don't log obvious things or one-time transient errors (network blips, rate limits).
A good test: would knowing this save 5+ minutes in a future session? If yes, log it.

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
# Session timeline: record skill completion (local-only, never sent anywhere)
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"SKILL_NAME","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
# Local analytics (gated on telemetry setting)
if [ "$_TEL" != "off" ]; then
echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
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

## Plan Mode Safe Operations

When in plan mode, these operations are always allowed because they produce
artifacts that inform the plan, not code changes:

- `$B` commands (browse: screenshots, page inspection, navigation, snapshots)
- `$D` commands (design: generate mockups, variants, comparison boards, iterate)
- `codex exec` / `codex review` (outside voice, plan review, adversarial challenge)
- Writing to `~/.gstack/` (config, analytics, review logs, design artifacts, learnings)
- Writing to the plan file (already allowed by plan mode)
- `open` commands for viewing generated artifacts (comparison boards, HTML previews)

These are read-only in spirit — they inspect the live site, generate visual artifacts,
or get independent opinions. They do NOT modify project source files.

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

# /index: Codebase Indexer for AI Assistants

Generate compact reference files so AI assistants skip the 50K+ token
exploration phase. Auto-detects your framework, scans intelligently,
outputs small markdown files.

---

## Step 0: Check for existing index

```bash
cat CLAUDE.md 2>/dev/null | grep -A 5 "Codebase Index" || echo "NO_INDEX"
ls .ai-codex/ 2>/dev/null || echo "NO_INDEX_DIR"
```

If an index already exists, ask the user:

> Found an existing codebase index. Want me to **regenerate** it (fresh scan) or **update** it (incremental)?

If no index exists, proceed to Step 1.

---

## Step 1: Framework Detection

Detect the project's language and framework. Run these checks in parallel:

```bash
# Language markers
[ -f package.json ] && echo "LANG:node" && cat package.json | head -50
[ -f composer.json ] && echo "LANG:php" && cat composer.json | head -50
[ -f Gemfile ] && echo "LANG:ruby" && cat Gemfile | head -30
[ -f requirements.txt ] && echo "LANG:python"
[ -f pyproject.toml ] && echo "LANG:python" && cat pyproject.toml | head -30
[ -f go.mod ] && echo "LANG:go" && cat go.mod | head -10
[ -f Cargo.toml ] && echo "LANG:rust" && cat Cargo.toml | head -20
[ -f mix.exs ] && echo "LANG:elixir"
[ -f build.gradle ] || [ -f pom.xml ] && echo "LANG:java"
find . -maxdepth 1 -name "*.csproj" -print -quit 2>/dev/null | grep -q . && echo "LANG:dotnet"
[ -f pubspec.yaml ] && echo "LANG:dart"
echo "---"
# Framework markers
[ -f next.config.js ] || [ -f next.config.mjs ] || [ -f next.config.ts ] && echo "FW:nextjs"
[ -f nuxt.config.ts ] || [ -f nuxt.config.js ] && echo "FW:nuxt"
[ -f svelte.config.js ] && echo "FW:sveltekit"
[ -f astro.config.mjs ] && echo "FW:astro"
[ -f remix.config.js ] && echo "FW:remix"
[ -f angular.json ] && echo "FW:angular"
[ -f artisan ] && echo "FW:laravel"
[ -f config/routes.rb ] && echo "FW:rails"
[ -f manage.py ] && echo "FW:django"
[ -f config.exs ] || [ -f mix.exs ] && grep -q "phoenix" mix.exs 2>/dev/null && echo "FW:phoenix"
echo "---"
# Schema markers
[ -f prisma/schema.prisma ] && echo "SCHEMA:prisma"
find . -path "*/migrations/*.sql" -print -quit 2>/dev/null | grep -q . && echo "SCHEMA:sql-migrations"
find database/migrations -name "*.php" -print -quit 2>/dev/null | grep -q . && echo "SCHEMA:laravel-migrations"
find db/migrate -name "*.rb" -print -quit 2>/dev/null | grep -q . && echo "SCHEMA:rails-migrations"
[ -f schema.graphql ] || find . -name "*.graphql" -print -quit 2>/dev/null | grep -q . && echo "SCHEMA:graphql"
find . -path "*/models/*.py" -not -path "*/node_modules/*" -print -quit 2>/dev/null | grep -q . && echo "SCHEMA:django-models"
```

If detection is ambiguous or nothing is found, ask via AskUserQuestion:

> I couldn't auto-detect your framework. What stack is this project?
> A) Tell me (e.g., "Laravel 11 with Inertia + Vue")
> B) It's a monorepo — scan subdirectories separately
> C) It's a custom/non-standard setup — I'll guide you

---

## Step 2: Configure Output

Create the output directory:

```bash
mkdir -p .ai-codex
```

---

## Step 3: Generate Index Files

Based on the detected framework, generate **only the files that apply**.
Skip any file that would be empty. Each file should be under 200 lines —
compact enough for an AI to read in one shot.

### 3a. Routes (routes.md)

Map every API route with its HTTP method, path, and notable middleware/tags.

**Adapt detection to the framework:**

- **Laravel:** Read `routes/web.php`, `routes/api.php`, `routes/console.php`. Parse `Route::get/post/put/delete/resource/apiResource` calls. For route groups, expand the prefix.
  ```bash
  grep -rn "Route::" routes/ 2>/dev/null | head -100
  # Also check for route:list if artisan is available
  php artisan route:list --json 2>/dev/null | head -200
  ```

- **Rails:** Read `config/routes.rb`. Parse `resources`, `get/post/put/delete`, `namespace`, `scope`.
  ```bash
  cat config/routes.rb 2>/dev/null
  rails routes 2>/dev/null | head -100
  ```

- **Next.js (App Router):** Scan `app/api/**/route.ts` for exported HTTP method handlers.
  ```bash
  find app/api -name "route.ts" -o -name "route.js" 2>/dev/null
  ```

- **Next.js (Pages Router):** Scan `pages/api/**/*.ts`.

- **Express/Fastify/Hono (Node.js):** Grep for `router.get/post`, `app.get/post`, etc.
  ```bash
  grep -rn "router\.\(get\|post\|put\|patch\|delete\)\|app\.\(get\|post\|put\|delete\)" --include="*.ts" --include="*.js" src/ routes/ app/ 2>/dev/null | head -100
  ```

- **Django:** Read `urls.py` files. Parse `path()`, `re_path()`, `urlpatterns`.
  ```bash
  find . -name "urls.py" -not -path "*/node_modules/*" 2>/dev/null
  ```

- **FastAPI/Flask:** Grep for `@app.route`, `@app.get`, `@router.get`, etc.
  ```bash
  grep -rn "@app\.\(route\|get\|post\|put\|delete\)\|@router\.\(get\|post\|put\|delete\)" --include="*.py" . 2>/dev/null | head -100
  ```

- **Go:** Grep for `HandleFunc`, `Handle`, `r.Get`, `r.Post`, etc.
  ```bash
  grep -rn "HandleFunc\|\.Get(\|\.Post(\|\.Put(\|\.Delete(" --include="*.go" . 2>/dev/null | head -100
  ```

- **Phoenix (Elixir):** Read `router.ex`.
  ```bash
  find . -name "router.ex" 2>/dev/null
  ```

**Output format:**

```markdown
# Routes (generated YYYY-MM-DD)
# N routes total

## resource-group
GET,POST     /api/resource [auth,db]
GET,PUT,DEL  /api/resource/:id [auth,db]
POST         /api/resource/:id/action [auth]
```

Group routes by the first path segment after `/api/` (or top-level resource).
Tag with detected middleware: `auth`, `db`, `cache`, `rate-limit`, `admin`, etc.

### 3b. Models / Schema (models.md)

Map data models with key fields, relationships, and constraints.

**Adapt to the framework:**

- **Laravel (Eloquent):** Read `app/Models/*.php`. Extract `$fillable`, `$casts`, `$table`, relationship methods (`hasMany`, `belongsTo`, `belongsToMany`, `hasOne`, `morphTo`, etc.). Also read migrations for column types.
  ```bash
  find app/Models -name "*.php" 2>/dev/null
  find database/migrations -name "*.php" 2>/dev/null | tail -30
  ```

- **Rails (ActiveRecord):** Read `app/models/*.rb`. Extract `has_many`, `belongs_to`, `has_one`, validations. Read `db/schema.rb` for column types.
  ```bash
  cat db/schema.rb 2>/dev/null | head -200
  find app/models -name "*.rb" 2>/dev/null
  ```

- **Prisma:** Parse `prisma/schema.prisma`. Extract models, fields, relations, `@id`, `@unique`.
  ```bash
  cat prisma/schema.prisma 2>/dev/null
  ```

- **Django:** Read `models.py` files. Extract `class Model(models.Model)`, field types, `ForeignKey`, `ManyToManyField`.
  ```bash
  find . -name "models.py" -not -path "*/migrations/*" -not -path "*/node_modules/*" 2>/dev/null
  ```

- **Go (GORM/sqlc/ent):** Grep for struct definitions with `gorm:` tags or sqlc schemas.
  ```bash
  grep -rn "type.*struct" --include="*.go" models/ internal/models/ 2>/dev/null | head -50
  ```

- **TypeORM/Drizzle/Knex:** Read entity/schema definitions.
  ```bash
  find . -path "*/entities/*.ts" -o -path "*/schema/*.ts" -o -name "schema.ts" 2>/dev/null | head -20
  ```

- **SQL migrations (any framework):** If no ORM detected, read migration files for CREATE TABLE statements.

**Output format:**

```markdown
# Models (generated YYYY-MM-DD)
# N models

**User** id(PK) | email(UQ) | name | role(enum) -> Post[], Comment[]
**Post** id(PK) | userId(FK) | title | status(enum) -> User, Comment[], Tag[]

## Order (complex model — expanded)
  id              String    PK
  userId          String    FK -> User
  status          OrderStatus  enum(pending,paid,shipped,delivered)
  totalCents      Int
  -> User, OrderItem[], Payment[]
```

Small models (<=4 key fields) get one-line format.
Complex models (5+ key fields or many relations) get expanded format.
Skip audit fields (createdAt, updatedAt, deletedAt) unless they're unique/indexed.

### 3c. Library Exports (lib.md)

Map key functions, classes, and utilities with their signatures.

```bash
# Find library/utility directories
find . -maxdepth 3 \( -name "lib" -o -name "utils" -o -name "helpers" -o -name "services" -o -name "support" \) -type d -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/vendor/*" 2>/dev/null
```

For each library directory, extract exported functions/classes:

- **TypeScript/JavaScript:** Grep for `export function`, `export const`, `export class`, `export default`.
- **PHP:** Grep for `class `, `function `, `trait `, `interface ` in non-vendor, non-test files.
- **Python:** Grep for `def `, `class `, and `__all__` exports.
- **Ruby:** Grep for `def `, `class `, `module `.
- **Go:** Grep for exported functions (capitalized: `func FunctionName`).
- **Rust:** Grep for `pub fn`, `pub struct`, `pub enum`, `pub trait`.

**Output format:**

```markdown
# Library Exports (generated YYYY-MM-DD)
# fn=function, class=class. Type-only files omitted.

## lib/
auth.ts
  fn validateSession
  fn requireAuth(roles)
cart-utils.ts
  fn calculateTotal(items)
  fn applyDiscount(cart, code)
  fn formatPrice(cents, currency)
stripe.ts  fn createPaymentIntent
```

Group by directory. Single-export files get one-line format.
Multi-export files list up to 4 exports, then `+N more`.
Skip type-only files, test files, and generated code.

### 3d. Pages / Views (pages.md)

Map all pages/views with their rendering strategy and route.

- **Next.js:** Scan `app/**/page.tsx` and `pages/**/*.tsx`. Tag as `[client]` or `[server]` based on `'use client'` directive.
- **Laravel (Blade):** Scan `resources/views/**/*.blade.php`. Group by directory.
  ```bash
  find resources/views -name "*.blade.php" 2>/dev/null | head -80
  ```
- **Laravel (Inertia):** Scan `resources/js/Pages/**/*.vue` or `resources/js/Pages/**/*.tsx`.
  ```bash
  find resources/js/Pages -name "*.vue" -o -name "*.tsx" -o -name "*.jsx" 2>/dev/null | head -80
  ```
- **Rails:** Scan `app/views/**/*.erb` or `app/views/**/*.haml`.
- **Django:** Scan `templates/**/*.html`.
- **SvelteKit:** Scan `src/routes/**/+page.svelte`.
- **Nuxt:** Scan `pages/**/*.vue`.
- **Astro:** Scan `src/pages/**/*.astro`.

**Output format:**

```markdown
# Pages (generated YYYY-MM-DD)
# N pages

[server]   /                    HomePage
[client]   /products            ProductsPage
[server]   /products/:id        ProductDetailPage
[blade]    /admin/dashboard     admin.dashboard
[inertia]  /settings            Settings/Index.vue
```

### 3e. Components (components.md)

Map UI components with their props/parameters. Skip UI primitives
(shadcn, radix, headless-ui base components).

```bash
# Find component directories
find . -maxdepth 3 -name "components" -type d -not -path "*/node_modules/*" -not -path "*/vendor/*" 2>/dev/null
```

- **React/Vue/Svelte:** Extract component names and props from interface/type definitions.
- **Blade:** Map partials and their `@props` or parameters.
- **ERB/HAML:** Map partials.
- **Livewire/Alpine:** Extract component classes and their public properties.

**Output format:**

```markdown
# Components (generated YYYY-MM-DD)
# (c)=client component. UI primitives omitted.

## components/
(c) CartDrawer  items, onRemove, onCheckout
(c) ProductCard  product, onAddToCart
    PriceDisplay  amount, currency
(c) SearchBar  onSearch, placeholder
```

### 3f. Config Summary (config.md)

Map key configuration that AI assistants need to know.

```bash
# Env vars the app expects
cat .env.example 2>/dev/null || cat .env.sample 2>/dev/null | head -40
# Key config files
ls config/ 2>/dev/null | head -20
```

**Output format:**

```markdown
# Configuration (generated YYYY-MM-DD)

## Environment Variables
DATABASE_URL       — Primary database connection
REDIS_URL          — Cache/queue backend
API_KEY            — External service auth
STRIPE_SECRET_KEY  — Payment processing

## Key Config Files
config/database.php    — DB connections (mysql, redis, sqlite)
config/auth.php        — Authentication guards and providers
config/services.php    — Third-party service credentials
```

Only include env vars from `.env.example`/`.env.sample` (never `.env` itself).
Only list config files that exist and are meaningful.

---

## Step 4: Write Summary Index

Create `.ai-codex/INDEX.md` as a table of contents:

```markdown
# Codebase Index (generated YYYY-MM-DD)
# Framework: [detected framework]
# Language: [detected language]

| File | What it contains |
|------|-----------------|
| routes.md | N API routes grouped by resource |
| models.md | N data models with relationships |
| lib.md | N library exports across M files |
| pages.md | N pages/views |
| components.md | N components |
| config.md | Environment vars and key config |

Re-generate: run `/index` again after structural changes.
```

---

## Step 5: Update CLAUDE.md

Append an index reference to the project's CLAUDE.md so every future
conversation loads the index automatically.

**Check if a Codebase Index section already exists in CLAUDE.md.** If so,
replace it. If not, append it.

The section to add:

```markdown
## Codebase Index

Pre-built index files are in `.ai-codex/`. Read these FIRST before exploring:
- `.ai-codex/INDEX.md` — summary and table of contents
- `.ai-codex/routes.md` — all API routes
- `.ai-codex/models.md` — data models and relationships
- `.ai-codex/lib.md` — library exports and function signatures
- `.ai-codex/pages.md` — page/view tree
- `.ai-codex/components.md` — component index with props
- `.ai-codex/config.md` — environment vars and key config

Generated by `/index`. Re-run after structural changes.
```

Tell the user what was generated and how many lines/tokens it saves.

---

## Step 6: Report

Output a summary:

```
Index generated in .ai-codex/

  routes.md       42 lines    12 routes
  models.md       28 lines     8 models
  lib.md          55 lines    23 exports
  pages.md        18 lines    15 pages
  components.md   31 lines    20 components
  config.md       15 lines    10 env vars

  Total: 189 lines (~1,500 tokens)
  Estimated savings: ~50K tokens per conversation

  Added reference to CLAUDE.md so all future sessions load the index.
```

---

## Design Principles

1. **Compact over complete.** Each file should be under 200 lines. If a section
   would exceed that, collapse groups and add `+N more` indicators.

2. **Framework-agnostic.** Never assume Next.js, Prisma, or React. Detect first,
   adapt second, ask third.

3. **Skip what doesn't apply.** No empty files. If there are no API routes,
   don't generate routes.md.

4. **Never read secrets.** Read `.env.example`, never `.env`. Read schema files,
   never database contents.

5. **Idempotent.** Running `/index` twice produces the same result. Existing
   `.ai-codex/` contents are overwritten, not appended.

6. **Persist the detection.** The CLAUDE.md reference means future conversations
   don't need to re-detect — they just read the index files.

---

## Keeping the Index Fresh

The `/index` skill does the smart first-time scan. For ongoing updates, use
the standalone `gstack-reindex` script — fast (~1s), zero AI cost, hookable.

### Git pre-commit hook (recommended)

```bash
# Install the hook
cat > .git/hooks/pre-commit << 'HOOK'
#!/bin/sh
# Auto-update codebase index on commit
REINDEX="$(git rev-parse --show-toplevel)/.claude/skills/gstack/index/bin/reindex"
[ ! -x "$REINDEX" ] && REINDEX="$HOME/.claude/skills/gstack/index/bin/reindex"
[ -x "$REINDEX" ] && "$REINDEX" --hook --quiet
exit 0
HOOK
chmod +x .git/hooks/pre-commit
```

### Manual re-index

```bash
gstack-reindex              # regenerate .ai-codex/
gstack-reindex --quiet      # silent mode
gstack-reindex --check      # exit 1 if stale (CI mode)
```

### npm/composer script

```json
{ "scripts": { "reindex": "gstack-reindex && git add .ai-codex/" } }
```

Tell the user about the pre-commit hook option after generating the index.
