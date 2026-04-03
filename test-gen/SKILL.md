---
name: test-gen
preamble-tier: 1
version: 1.0.0
description: |
  Generate unit tests for uncovered code. Reads your existing tests to learn
  the project's style (framework, assertions, naming, mocking patterns), then
  writes new tests that match. Finds functions with no test coverage and
  prioritizes by complexity and risk.
  Use when asked to "write tests", "generate tests", "add test coverage",
  "test this file", "cover untested code", or "test-gen".
  Proactively suggest before /ship when test coverage is low, or after
  /build when new code has no tests. (gstack)
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
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
echo '{"skill":"test-gen","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
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
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"test-gen","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
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

# /test-gen: Unit Test Generator

Find untested code, learn your test style, generate tests that match.

---

## Step 0: Learn the test style

Before writing a single test, read the project's existing tests to learn
conventions. This is the most important step — generated tests that don't
match the project style are worse than no tests.

### 0a. Detect test framework and runner

```bash
# Check CLAUDE.md for test commands first
cat CLAUDE.md 2>/dev/null | grep -i "test" | head -10

# Detect test framework from config files
[ -f jest.config.js ] || [ -f jest.config.ts ] && echo "FW:jest"
[ -f vitest.config.js ] || [ -f vitest.config.ts ] && echo "FW:vitest"
[ -f playwright.config.ts ] && echo "FW:playwright"
[ -f phpunit.xml ] || [ -f phpunit.xml.dist ] && echo "FW:phpunit"
[ -f .rspec ] && echo "FW:rspec"
[ -f pytest.ini ] || [ -f pyproject.toml ] && grep -q "pytest" pyproject.toml 2>/dev/null && echo "FW:pytest"
[ -f conftest.py ] && echo "FW:pytest"
grep -q "testing" go.mod 2>/dev/null && echo "FW:go-test"
[ -f Cargo.toml ] && echo "FW:cargo-test"
grep -q "ExUnit" mix.exs 2>/dev/null && echo "FW:exunit"
```

### 0b. Find existing tests

```bash
# Find test directories and files
find . -type d \( -name "tests" -o -name "test" -o -name "__tests__" -o -name "spec" \) -not -path "*/node_modules/*" -not -path "*/vendor/*" 2>/dev/null | head -10

# Count existing tests
find . \( -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" -o -name "*Test.php" -o -name "*_test.go" -o -name "*_test.py" -o -name "test_*.py" -o -name "*_spec.rb" \) -not -path "*/node_modules/*" -not -path "*/vendor/*" 2>/dev/null | wc -l
```

### 0c. Read 2-3 existing tests to learn the style

Pick the most representative existing tests — ideally one unit test and one
that tests a service/model similar to what you'll be generating.

Read each test file and extract:
- **Import style:** What test utilities, assertion libraries, mocking tools?
- **Naming convention:** `describe/it`, `test()`, `test_method_name`, camelCase vs snake_case?
- **Setup pattern:** `beforeEach`, `setUp`, factories, fixtures, or inline?
- **Assertion style:** `expect().toBe()`, `$this->assert*()`, `assert`, `eq`?
- **Mocking approach:** Jest mocks, Mockery, factory patterns, dependency injection?
- **File organization:** One test file per source file? Grouped by feature? Flat?
- **Test data:** Factories, fixtures, builders, or inline literals?

**Store these observations as "the style guide" for this session.** Every test
you generate must follow these patterns exactly.

---

## Step 1: Parse the user's request

The user may want:

| Request | Action |
|---------|--------|
| "test this file" / "test src/auth.ts" | Generate tests for a specific file |
| "write tests for the auth module" | Generate tests for a directory/module |
| "add test coverage" / "cover untested code" | Find all untested files, prioritize, generate |
| "test this function" | Generate tests for a specific function |
| "increase coverage to 80%" | Find gaps and fill them systematically |

If the user specifies a file or function, skip to Step 3.
If they want broad coverage, proceed to Step 2.

---

## Step 2: Find untested code

Identify source files that have no corresponding test file.

**Build a map of source → test pairs:**

For each source file, check if a test file exists using the project's naming
convention (detected in Step 0):

- `src/auth.ts` → `test/auth.test.ts` or `__tests__/auth.test.ts`
- `app/Services/AuthService.php` → `tests/Unit/Services/AuthServiceTest.php`
- `app/models/user.rb` → `spec/models/user_spec.rb`
- `src/auth.py` → `tests/test_auth.py` or `tests/auth_test.py`
- `internal/auth/auth.go` → `internal/auth/auth_test.go`

```bash
# Example for Node.js — adapt to detected framework
find src/ lib/ -name "*.ts" -not -name "*.test.*" -not -name "*.spec.*" -not -name "*.d.ts" 2>/dev/null | while read f; do
  BASE=$(basename "$f" .ts)
  DIR=$(dirname "$f")
  # Check common test locations
  TEST_EXISTS=0
  for pattern in "test/${BASE}.test.ts" "__tests__/${BASE}.test.ts" "${DIR}/${BASE}.test.ts" "${DIR}/__tests__/${BASE}.test.ts"; do
    [ -f "$pattern" ] && TEST_EXISTS=1 && break
  done
  [ "$TEST_EXISTS" -eq 0 ] && echo "UNTESTED: $f"
done
```

**Prioritize by risk:**

For each untested file, score it:
- **Complexity:** How many functions/methods? How many branches/conditionals?
- **Criticality:** Auth, payments, data mutation = high. Utils, formatters = low.
- **Change frequency:** Recently modified files are higher priority.

```bash
# Check recent changes to untested files
for f in <untested-files>; do
  COMMITS=$(git log --oneline --since="30 days ago" -- "$f" 2>/dev/null | wc -l | tr -d ' ')
  echo "$COMMITS changes: $f"
done
```

Present the prioritized list:

```
Untested files (prioritized by risk):

HIGH RISK (auth/payments/data):
  1. src/services/PaymentService.ts    14 functions, 8 recent commits
  2. src/middleware/auth.ts              6 functions, 3 recent commits
  3. app/Models/Order.php               22 methods, 12 recent commits

MEDIUM RISK (business logic):
  4. src/services/NotificationService.ts  8 functions
  5. src/utils/pricing.ts                 5 functions

LOW RISK (formatting/display):
  6. src/utils/formatDate.ts              2 functions
  7. src/helpers/string.ts                4 functions

Generate tests for which? (1-7, "all", or specify a file)
```

---

## Step 3: Generate tests

For each file to test:

### 3a. Read the source file

Read the entire source file. Understand:
- Every public function/method and its signature
- Input types, return types, side effects
- Error cases and edge cases (nulls, empty arrays, boundary values)
- Dependencies that need mocking

### 3b. Plan the test cases

For each function, identify test cases:

| Category | Examples |
|----------|----------|
| **Happy path** | Valid input → expected output |
| **Edge cases** | Empty input, null, zero, max values, Unicode |
| **Error cases** | Invalid input, missing required fields, network failure |
| **Boundary values** | Off-by-one, empty array vs single item vs many |
| **State transitions** | Before/after side effects, database mutations |

Don't test trivial getters/setters. Focus on logic, branching, and
error handling.

### 3c. Write the test file

Generate the test file following the style guide from Step 0.

**Critical rules:**
1. **Match the existing style exactly.** If the project uses `describe/it`,
   don't use `test()`. If they use Mockery, don't use manual mocks.
2. **Use the project's factories/fixtures.** Don't create test data
   differently from how existing tests do it.
3. **Test behavior, not implementation.** Assert on outputs and side effects,
   not internal method calls (unless the project's existing tests do that).
4. **One assertion per test** (unless the project's style groups them).
5. **Descriptive test names.** Follow the naming pattern from existing tests.
6. **Handle async correctly.** Match the project's async test patterns.

### 3d. Verify the tests run

After writing each test file, run it:

```bash
# Run just the new test file — adapt command to detected framework
# Node.js: npx jest path/to/test.test.ts
# PHP: php artisan test --filter TestClassName
# Python: pytest path/to/test_file.py -v
# Ruby: rspec spec/path/to/spec.rb
# Go: go test ./path/to/package/ -run TestName -v
```

If tests fail:
1. Read the error message
2. Fix the test (not the source code!)
3. Re-run until green
4. If a test reveals an actual bug in the source, note it but don't fix it —
   report it to the user as a finding

---

## Step 4: Report

```
/test-gen report
═══════════════════════════════════════════════════════

Generated: 4 test files, 27 test cases

  tests/Unit/Services/PaymentServiceTest.php
    ✓ 8 tests written, 8 passing
    Coverage: processPayment, refund, validateCard, webhookHandler

  tests/Unit/Middleware/AuthMiddlewareTest.php
    ✓ 6 tests written, 6 passing
    Coverage: authenticate, requireRole, tokenRefresh

  tests/Unit/Models/OrderTest.php
    ✓ 9 tests written, 8 passing, 1 FOUND BUG
    Coverage: calculateTotal, applyDiscount, transitionStatus
    BUG: applyDiscount allows negative totals when discount > subtotal

  tests/Unit/Services/NotificationServiceTest.php
    ✓ 4 tests written, 4 passing
    Coverage: sendEmail, sendSms, queueNotification

Findings:
  - BUG in Order::applyDiscount — no floor on negative totals
  - PaymentService::webhookHandler has no error handling for
    malformed Stripe events (test covers it, but source should too)

Run: php artisan test --filter "PaymentServiceTest|AuthMiddlewareTest|OrderTest|NotificationServiceTest"
```

---

## Design Principles

1. **Learn before writing.** Read 2-3 existing tests before generating anything.
   Style mismatch is the #1 reason generated tests get deleted.

2. **Test behavior, not implementation.** Unless the project's existing tests
   test implementation details — then match that style.

3. **Run every test.** Don't submit tests that haven't been verified to pass.
   A failing generated test is worse than no test.

4. **Report bugs, don't fix them.** If a test reveals a bug in source code,
   that's a finding. Don't silently fix the source — the user needs to know.

5. **Prioritize by risk.** Auth, payments, and data mutations before formatters
   and display helpers. Test the code that will hurt most when it breaks.

6. **Conservative scope.** Generate 5-10 well-crafted tests, not 50 shallow ones.
   Quality over quantity. The user can always ask for more.
