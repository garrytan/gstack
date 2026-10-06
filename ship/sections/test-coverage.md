<!-- AUTO-GENERATED from test-coverage.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Step 7: Test Coverage Audit

### Shared subagent dispatch

For Steps 7, 8 and 10, use the Agent tool with `run_in_background: false`.
Omitting the flag runs the subagent in the background. The explicit flag waits
for a result while keeping a fresh context. Do not invoke the target as a Skill
or run it inline instead. Inline work is allowed only under that section's
documented fallback, after a failed subagent has stopped.

Dispatch the audit through Agent with `subagent_type: "general-purpose"` and
`run_in_background: false`, using the shared foreground-dispatch rule above.
Wait for its LAST-line JSON before applying the coverage gate.

**Generation allowance:** Maximum 2 generation passes total per invocation.
Count each generation-authorized attempt before dispatch/inline execution, including
the initial audit, failures and zero-test results. Re-entry never resets it.
Two passes already used means no further generation; read-only reassessment uses no pass.

**Subagent prompt:** Supply `<base>`, Step 4's framework/bootstrap decision,
permitted paths/commands, remaining gaps, passes used and generation allowance,
plus the CLAUDE.md `## Test Coverage` values the gate below reads (`Generation cap:`,
`Base control:`, `Base control budget:`). No allowance means audit only; missing
permission is not approval. Preserve the 30-path/5-tests-per-pass/2-minute per-test caps.

**Before the first dispatch,** sweep base-control worktrees a previous interrupted run left behind:

```bash
git worktree prune
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'gstack-base-control.*' -mmin +10 2>/dev/null | while IFS= read -r d; do git worktree remove --force "$d/wt" >/dev/null 2>&1; rm -rf "$d"; done
```

````text
You are running a ship-workflow test coverage audit. Run `git diff origin/<base>` to include uncommitted tracked changes; also read relevant non-ignored untracked source/tests. Do not commit or push. Perform only this audit; return unresolved user decisions to the parent instead of asking or advancing to another workflow step.

Generation: <allowed|audit-only>; passes used: <N> of 2. Audit-only overrides every generation instruction below.

Coverage goal: every changed behavior is protected by a test that would catch a real regression. Test count is not a goal. Evaluate what was ACTUALLY coded (from the diff), not what was planned.

### Test Framework Detection

Before analyzing coverage, detect the project's test framework:

1. **Read CLAUDE.md** — look for a `## Testing` section with test command and framework name. If found, use that as the authoritative source.
2. **If CLAUDE.md has no testing section, auto-detect:**

```bash
setopt +o nomatch 2>/dev/null || true  # zsh compat
# Detect project runtime (markers are evidence, not commands to run blind)
[ -f manage.py ] && echo "RUNTIME:python FRAMEWORK:django"
{ [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f tox.ini ] || [ -f setup.cfg ] || [ -f requirements.txt ]; } && echo "RUNTIME:python"
{ [ -f Gemfile ] || [ -f Rakefile ] || [ -f .rspec ]; } && echo "RUNTIME:ruby"
[ -f package.json ] && echo "RUNTIME:node"
[ -f go.mod ] && echo "RUNTIME:go"
[ -f Cargo.toml ] && echo "RUNTIME:rust"
[ -f pom.xml ] && echo "RUNTIME:jvm BUILD:maven"
{ [ -f build.gradle ] || [ -f build.gradle.kts ]; } && echo "RUNTIME:jvm BUILD:gradle"
# Check for existing test infrastructure — config files, scripts, AND test files
ls jest.config.* vitest.config.* playwright.config.* cypress.config.* .rspec pytest.ini tox.ini phpunit.xml 2>/dev/null
[ -f package.json ] && grep -q '"test"[[:space:]]*:' package.json && echo "SCRIPT:package.json test"
[ -f Makefile ] && grep -qE '^(test|check):' Makefile && echo "TARGET:make test"
git ls-files | grep -cE '(^|/)(tests?|spec|__tests__)/|(^|/)tests?\.py$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb|ts|js|exs)$|\.(test|spec)\.[jt]sx?$|_spec\.rb$|Test\.(java|kt)$' | sed 's/^/TESTFILES:/'
```

3. **If no framework detected:** use the bootstrap decision already made in Step 4; report diagram-only coverage if setup was declined. Do not restart bootstrap from this audit.

**0. Before/after test count:**

```bash
# Count test files before any generation
git ls-files 2>/dev/null | grep -E '(\.test\.|\.spec\.|_test\.|_spec\.)' | wc -l
```

Store this number for the PR body.

**1. Trace every codepath changed** using `git diff origin/<base>`:

Read every changed file. For each one, trace how data flows through the code — don't just list functions, actually follow the execution:

1. **Read the diff.** For each changed file, read the full file (not just the diff hunk) to understand context.
Definition: a **targeted audit** reviews named concrete source/test files or a
branch diff. A **prototype** is existing runnable code referenced by the plan,
not a proposed future component.

When grounded in concrete source and test files, read them in a dedicated tool
call before drawing the diagram. Finish this source read before tracing data
flow in audit item 2 below; map user flows afterward. Do not mix diff, grep,
package/config, git, or commentary into that read; use separate calls for
context. Base the diagram on that read.
2. **Trace data flow.** Starting from each entry point (route handler, exported function, event listener, component render), follow the data through every branch:
   - Where does input come from? (request params, props, database, API call)
   - What transforms it? (validation, mapping, computation)
   - Where does it go? (database write, API response, rendered output, side effect)
   - What can go wrong at each step? (null/undefined, invalid input, network failure, empty collection)
3. **Diagram the execution.** For each changed file, draw an ASCII diagram showing:
   - Every function/method that was added or modified
   - Every conditional branch (if/else, switch, ternary, guard clause, early return)
   - Every error path (try/catch, rescue, error boundary, fallback)
   - Every call to another function (trace into it — does IT have untested branches?)
   - Every edge: what happens with null input? Empty array? Invalid type?

This is the critical step — you're building a map of every line of code that can execute differently based on input. Every branch in this diagram needs coverage that would catch a real regression; the test value bar below decides whether that is a new test, an extension of an existing one, or already covered.

**2. Map user flows, interactions, and error states:**

Code coverage isn't enough — you need to cover how real users interact with the changed code. For each changed feature, think through:

- **User flows:** What sequence of actions does a user take that touches this code? Map the full journey (e.g., "user clicks 'Pay' → form validates → API call → success/failure screen"). Each step in the journey needs coverage.
- **Interaction edge cases:** What happens when the user does something unexpected?
  - Double-click/rapid resubmit
  - Navigate away mid-operation (back button, close tab, click another link)
  - Submit with stale data (page sat open for 30 minutes, session expired)
  - Slow connection (API takes 10 seconds — what does the user see?)
  - Concurrent actions (two tabs, same form)
- **Error states the user can see:** For every error the code handles, what does the user actually experience?
  - Is there a clear error message or a silent failure?
  - Can the user recover (retry, go back, fix input) or are they stuck?
  - What happens with no network? With a 500 from the API? With invalid data from the server?
- **Empty/zero/boundary states:** What does the UI show with zero results? With 10,000 results? With a single character input? With maximum-length input?

Add these to your diagram alongside the code branches. A user flow with no test is just as much a gap as an untested if/else.

**3. Check each branch against existing tests:**

Go through your diagram branch by branch — both code paths AND user flows. For each one, search for a test that exercises it:
- Function `processPayment()` → look for `billing.test.ts`, `billing.spec.ts`, `test/billing_test.rb`
- An if/else → look for tests covering BOTH the true AND false path
- An error handler → look for a test that triggers that specific error condition
- A call to `helperFn()` that has its own branches → those branches need tests too
- A user flow → look for an integration or E2E test that walks through the journey
- An interaction edge case → look for a test that simulates the unexpected action

Quality scoring rubric:
- ★★★  Tests behavior with edge cases AND error paths
- ★★   Tests correct behavior, happy path only
- ★    Smoke test / existence check / trivial assertion (e.g., "it renders", "it doesn't throw"); weak, never counts as coverage

**Test value bar.** Propose or write a test only with all four answers; otherwise extend an existing test or drop it:

1. What observable behavior, invariant or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that? Prefer adding a row to an existing table-driven test or shared fixture over a near-duplicate.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no production caller needs? If yes, test at the real boundary instead.

A test that breaks under a behavior-preserving refactor asserts implementation: rewrite it at the owning boundary, unless exact output is the declared contract (goldens, prompt bytes, wire formats).

Value card: `Value: protects=<...>; fails_when=<...>; why_new=<...>; seam=none` (seam: `none` or its name); each field at most 160 UTF-8 bytes here (clamp to 157 plus `...`; written JSON keeps full values). Write it as a header comment in each generated test, next to the attribution (wrap, do not truncate); with no known comment syntax, put it in the PR body's Test value details. A missing upstream card never blocks: derive it; ignore unknown fields.

Example: Value: protects=refundPayment rejects an empty reason; fails_when=the reason guard is removed or inverted; why_new=billing.test.ts covers processPayment only; seam=none
Rejected (covered_elsewhere): "checkout renders"; checkout.e2e.ts:15 covers it, so extend that test.

Weak tests (★ smoke/existence/trivial, gate-failing or unrated) never count as coverage. X = paths with a ★★/★★★ test / total paths (value-weighted; the gate uses X); Y = paths with any test / total paths. Total paths = the diff's codepath trace, max 30; zero skips the gate. A path with only weak tests is uncovered in X, covered in Y, and goes to `weak_gaps` (reason `star_one|gate_failed|unrated`), not `gaps`. Rate stars only for tests reachable from changed paths.

Retention bar: keep a test that independently enforces a public API, protocol, config, migration, storage, security, platform, default, prompt-byte, generated-output (golden), package, release or architecture contract; static or slow is no reason to delete.

Regression proof: a regression test must fail at HEAD before any repair, in its own assertion (a pass at HEAD drops the regression label; an import, fixture or env failure is a test defect: correct once or drop). It must pass at base as the control (an assertion failure there marks it invalid; any other failure is "base control unavailable: collection error") and pass after the repair. Record: `Regression proof — fails at HEAD: yes · passes at base: yes | unavailable (<reason>) | manual · passes after fix: yes | pending`.

### E2E Test Decision Matrix

When checking each branch, also determine whether a unit test or E2E/integration test is the right tool:

**RECOMMEND E2E (mark as [→E2E] in the diagram):**
- Common user flow spanning 3+ components/services (e.g., signup → verify email → first login)
- Integration point where mocking hides real failures (e.g., API → queue → worker → DB)
- Auth/payment/data-destruction flows — too important to trust unit tests alone

**RECOMMEND EVAL (mark as [→EVAL] in the diagram):**
- Critical LLM call that needs a quality eval (e.g., prompt change → test output still meets quality bar)
- Changes to prompt templates, system instructions, or tool definitions

**STICK WITH UNIT TESTS:**
- Pure function with clear inputs/outputs
- Internal helper with no side effects
- Edge case of a single function (null input, empty array)
- Obscure/rare flow that isn't customer-facing

### REGRESSION RULE (mandatory)

**IRON RULE:** When the coverage audit identifies a REGRESSION — code that previously worked but the diff broke — a regression test is written immediately. No AskUserQuestion. No skipping. Regressions are the highest-priority test because they prove something broke.

A regression is when:
- The diff modifies existing behavior (not new code)
- The existing test suite (if any) doesn't cover the changed path
- The change introduces a new failure mode for existing callers

When uncertain whether a change is a regression, err on the side of writing the test.

**Red-first proof.** Apply the value bar's Regression proof to every regression test: the diff at HEAD is the pre-fix code, so run the new test at HEAD before any repair. Then, unless the parent says `Base control: off`, run this base control once per regression test in diff order, within a 3-minute total per /ship run (`Base control budget:` seconds per test, default 90). Past the total, record "base control unavailable: budget" and report "N of M regression tests got base control". The block is one shell invocation; it installs nothing and runs no build or postinstall.

```bash
# Set: BASE = the base branch this /ship run resolved; TEST = the test file; FIXTURES = new
# test-only fixtures it imports (repo-relative, may be empty); RUN = the detected
# runner for one file (e.g. "bun test $TEST"); BUDGET = seconds for this run (default 90).
ROOT=$(git rev-parse --show-toplevel)
CTL_TMP=$(mktemp -d "${TMPDIR:-/tmp}/gstack-base-control.XXXXXX")
cleanup() { git -C "$ROOT" worktree remove --force "$CTL_TMP/wt" >/dev/null 2>&1; rm -rf "$CTL_TMP"; [ -e "$CTL_TMP" ] && echo "BASE_CONTROL_LEFTOVER: $CTL_TMP (run: git worktree prune)"; }
trap cleanup EXIT INT TERM
(
  [ -f "$ROOT/package.json" ] || { echo "BASE_CONTROL: unavailable (ecosystem)"; exit 0; }
  git -C "$ROOT" remote get-url origin >/dev/null 2>&1 || { echo "BASE_CONTROL: unavailable (no base remote)"; exit 0; }
  timeout 30 git -C "$ROOT" fetch --quiet origin "$BASE" || { echo "BASE_CONTROL: unavailable (base not fetched)"; exit 0; }
  git -C "$ROOT" worktree add --quiet --detach "$CTL_TMP/wt" "origin/$BASE" >/dev/null 2>&1 || { echo "BASE_CONTROL: unavailable (worktree add failed)"; exit 0; }
  for f in $TEST $FIXTURES; do mkdir -p "$CTL_TMP/wt/$(dirname "$f")" && cp "$ROOT/$f" "$CTL_TMP/wt/$f"; done
  [ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$CTL_TMP/wt/node_modules"
  cd "$CTL_TMP/wt" && timeout "${BUDGET:-90}" sh -c "$RUN" > "$CTL_TMP/out" 2>&1; rc=$?
  tail -n 40 "$CTL_TMP/out"
  if [ "$rc" -eq 0 ]; then echo "BASE_CONTROL: passes at base"
  elif [ "$rc" -eq 124 ]; then echo "BASE_CONTROL: unavailable (budget)"
  else echo "BASE_CONTROL: fails at base (exit $rc)"; fi
)
```

Classify "fails at base" from the output: a failure in the test's own assertion marks it invalid (correct once or drop it); an import, collection, missing generated artifact or dependency failure is "base control unavailable: collection error" and the test stays. Print each unavailable result as: base control unavailable: <reason>. The fails-at-HEAD result still stands. To check by hand: `git worktree add --detach <tmp> <base>`; copy the test and its new fixtures to the same paths; run the detected test command in <tmp>; `git worktree remove --force <tmp>`. Then report `passes at base: manual`. (see ~/.claude/skills/gstack/docs/test-value-bar.md#base-control-unavailable)

Return `"regression_proof":{"red_at_head":N,"base_green":N,"base_unavailable":N}` counts in the JSON and each test's record line in the diagram.

**4. Output ASCII coverage diagram:**

For targeted audits, start Test review output with the coverage diagram. In full
plan reviews, put it inside the normal Test review section. Required outputs
keep the final terminal report order.

Include BOTH code paths and user flows in the same diagram. Mark E2E-worthy and eval-worthy paths:

```
CODE PATHS                                            USER FLOWS
[+] src/services/billing.ts                           [+] Payment checkout
  ├── processPayment()                                  ├── [★★★ TESTED] Complete purchase — checkout.e2e.ts:15
  │   ├── [★★★ TESTED] happy + declined + timeout      ├── [GAP] [→E2E] Double-click submit
  │   ├── [GAP]         Network timeout                 └── [GAP]        Navigate away mid-payment
  │   └── [GAP]         Invalid currency
  └── refundPayment()                                 [+] Error states
      ├── [★★  TESTED] Full refund — :89                ├── [★★  TESTED] Card declined message
      └── [★   TESTED] Partial (non-throw only) — :101  └── [GAP]        Network timeout UX

LLM integration: [GAP] [→EVAL] Prompt template change — needs eval test

COVERAGE: 5/13 paths tested (38%)  |  Code paths: 3/5 (60%)  |  User flows: 2/8 (25%)
QUALITY: ★★★:2 ★★:2 ★:1  |  GAPS: 8 (2 E2E, 1 eval)
```

Legend: ★★★ behavior + edge + error  |  ★★ happy path  |  ★ smoke check
[→E2E] = needs integration test  |  [→EVAL] = needs LLM eval

Avoid bare `[ ]` or `[x]` in diagrams unless the block includes
`Legend: [x] tested | [ ] no test`. Prefer `[GAP]`, `[★★ TESTED]`,
`[→E2E]`, `[→EVAL]`; keep user-flow markers off code-path rows.

**Fast path:** All paths covered → "Step 7: All new code paths have test coverage ✓" Continue.

**5. Generate tests for uncovered paths:**

If test framework detected (or bootstrapped in Step 4):
- Apply the test value bar before writing each test. Extend an existing test (a new table row, fixture case or assertion) before creating a file. Record every proposal you decline in `tests_rejected` with a `reason_code` from `duplicate_protects, needs_seam, incomplete_card, no_credible_regression, covered_elsewhere, implementation_coupled`.
- Never add a production seam for a test; a seam that is not `none` names its non-test callers: `seam=<name> (non-test callers: N, via <search command>)`.
- Write the value card as a header comment in each generated or extended test.
- Prioritize error handlers and edge cases first (happy paths are more likely already tested)
- Read 2-3 existing test files to match conventions exactly
- Generate the smallest native test for each path: unit tests for logic, mocking only services unrelated to the behavior under test (integration points where mocking hides real failures go to [→E2E]).
- For paths marked [→E2E]: generate integration/E2E tests using the project's E2E framework (Playwright, Cypress, Capybara, etc.)
- For paths marked [→EVAL]: generate eval tests using the project's eval framework, or flag for manual eval if none exists
- Write tests that exercise the specific uncovered path with real assertions
- Run each test. Passes → keep the change and report its path; the parent commits in Step 15.
- Fails → diagnose whether the test/fixture is invalid or a declared product contract is broken. Correct a demonstrated test defect once; preserve a valid red regression and route the reproduced product failure through the parent's fix/approval flow. Never delete or weaken it to manufacture green; retain unresolved coverage in the diagram.

Caps: 30 code paths max; 5 tests per generation pass (code + user flow combined; the parent's `Generation cap:` overrides 5); an extension uses one slot and a rejection uses none; 2-min per-test exploration cap. List each remaining gap below the diagram (inside `diagram`) as a proposed test with its value card.

Do not rate stars for tests you wrote in this pass: count them as unrated (weak, reason `unrated`). The parent's read-only rating dispatch rates them. Counts are disjoint, precedence extended > added > rejected: one gap lands in at most one of `tests_extended`, `tests_added`, `tests_rejected`.

If no test framework AND user declined bootstrap → diagram only, no generation. Note: "Test generation skipped — no test framework configured."

**Diff is test-only changes:** Return a skipped audit with null coverage, zero gaps, and "No new application code paths to audit."

**6. After-count and coverage summary:**

```bash
# Count test files after generation
git ls-files 2>/dev/null | grep -E '(\.test\.|\.spec\.|_test\.|_spec\.)' | wc -l
```

For PR body: `Tests: {before} → {after} (+{delta} new)`
Coverage line: `Test Coverage Audit: N new code paths. M covered (Y% any test, X% value-weighted). K tests generated, awaiting parent commit.`

### Test Plan Artifact

After producing the coverage diagram, write a test plan artifact so `/qa` and `/qa-only` can consume it:

```bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
SLUG=$(~/.claude/skills/gstack/bin/gstack-slug --get SLUG 2>/dev/null) && mkdir -p "$GSTACK_STATE_ROOT/projects/$SLUG" && echo "PROJECT_DIR: $GSTACK_STATE_ROOT/projects/$SLUG"
USER=$(whoami)
DATETIME=$(date +%Y%m%d-%H%M%S)
```

Write to `<PROJECT_DIR>/{user}-{branch}-ship-test-plan-{datetime}.md` (`PROJECT_DIR` printed above):

```markdown
# Test Plan
Generated by /ship on {date}
Branch: {branch}
Repo: {owner/repo}

## Affected Pages/Routes
- {URL path} — {what to test and why}

## Key Interactions to Verify
- {interaction description} on {page}

## Edge Cases
- {edge case} on {page}

## Critical Paths
- {end-to-end flow that must work}
```

After your analysis, output a single JSON object on the LAST LINE of your response (no other text after it):
{"coverage_pct":N,"gaps":N,"diagram":"<full markdown coverage diagram for PR body>","tests_added":["path",...],"coverage_pct_value":N,"weak_gaps":[{"path":"...","existing_test":"...","reason":"star_one|gate_failed|unrated"}],"tests_extended":["path",...],"tests_rejected":[{"path_or_gap":"...","reason_code":"...","reason":"..."}],"regression_proof":{"red_at_head":N,"base_green":N,"base_unavailable":N}}
`coverage_pct` is Y (paths with any test), `coverage_pct_value` is X (paths with a ★★/★★★ test), `gaps` counts only paths with no test. Use null for an undetermined or skipped coverage percentage, not zero. Include every remaining gap in the diagram so the parent can target a second pass.
````

**Parent processing:**

1. Read the subagent's final output. Parse the LAST line as JSON.
2. Store `coverage_pct`, `coverage_pct_value`, `gaps`, `weak_gaps`, `tests_added`,
   `tests_extended`, `tests_rejected` and `regression_proof`. A missing new key counts
   as empty; say so in the summary (an older installed prompt must not fail the gate).
   A key with the wrong type (for example `weak_gaps` not an array) is ignored the same
   way and printed as: malformed <key> ignored: the audit returned the wrong type, so it counts as empty. The likely cause is an outdated installed skill; run /gstack-upgrade. (see ~/.claude/skills/gstack/docs/test-value-bar.md#malformed-key-ignored)
3. **Machine checks** on every test written in this run (`tests_added` and
   `tests_extended`): a value-card header with four non-empty fields (else
   `incomplete_card`); `protects` unique across the run after casefolding and stripping
   punctuation and repeated whitespace (a later duplicate is `duplicate_protects`); seam
   `none`, or a named seam with at least one non-test caller (N = 0 or an unavailable
   caller check is `needs_seam`). Move each failure to `tests_rejected` with its
   `reason_code`, then remove it before anything else reads the diff: an untracked new
   file is deleted; for a tracked file, revert only this run's hunk with Edit, never
   the whole file. Write one rejected test path per line, relative to the repository
   root, into a private file:

```bash
_GT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp"
mkdir -p "$_GT" && chmod 700 "$_GT" || { echo "Not sent: cannot create $_GT for the text file." >&2; exit 1; }
_EX=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p "$(dirname "$_EX")" && { grep -qxF '/.gstack/tmp/' "$_EX" 2>/dev/null || echo '/.gstack/tmp/' >> "$_EX"; }
REJECTED_FILE=$(mktemp "${_GT:?}/rejected-tests.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "REJECTED_FILE: $REJECTED_FILE (name: ${REJECTED_FILE##*/})"
```

Write the text into each printed file with your file-write tool (Claude Code's Write tool needs a Read of the empty file first), exactly as it should appear. The text never goes into a shell command, heredoc or quoted argument. If a write fails or is refused, do not send: print the cause, the file path and the command below for sending by hand.

   Then run, substituting the printed name for `<rejected-file-name>`:

   ```bash
   REJECTED_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<rejected-file-name>"
   [ -s "$REJECTED_FILE" ] || { echo "Nothing removed: $REJECTED_FILE is empty; write the paths, then rerun." >&2; exit 1; }
   while IFS= read -r f; do
     [ -n "$f" ] || continue
     case "$f" in /*|..|../*|*/..|*/../*) echo "SKIPPED (outside repo): $f"; continue ;; esac
     if git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then echo "REVERT_HUNK: $f"; else rm -f -- "$f" && echo "REMOVED: $f"; fi
   done < "$REJECTED_FILE"
   rm -f "$REJECTED_FILE"
   ```

   No `tests_rejected` path may remain on disk as a new file. If every test written in
   a pass is rejected, print all <N> generated tests rejected by machine checks; see tests_rejected. The gate proceeds with the unchanged value-weighted coverage. (see ~/.claude/skills/gstack/docs/test-value-bar.md#all-generated-tests-rejected)
4. **Rating dispatch.** When this run wrote tests that survived the machine checks,
   dispatch one read-only Agent (`subagent_type: "general-purpose"`,
   `run_in_background: false`) with no generation permission; it uses no generation
   pass. Give it the diagram and the surviving test paths. It rates each against the
   ★ rubric and the test value bar and returns a LAST-line JSON
   `{"coverage_pct_value":N,"weak_gaps":[...]}` recomputed with its ratings; use those
   two values. Until rated, this run's tests count as weak (`unrated`). If it fails,
   times out or returns invalid JSON, the gate is skipped for this run ("rating
   unavailable").
5. Embed `diagram` verbatim in the PR body's `## Test Coverage` section (Step 19).
6. Print a one-line summary: `Coverage: {X}% value-weighted ({Y}% including {W} weakly covered paths), {gaps} gaps. {tests_added.length} tests added.`
   Bindings for the PR body's Test value line: K = `tests_added.length`,
   R = `tests_rejected.length`, E = `tests_extended.length`, W = `weak_gaps.length`.

**Audit failure:** On failure, invalid JSON or no completion after ~10 minutes,
stop the child and confirm it stopped before running the same audit inline.
Fallback recovers the audit; it does not pass or bypass the coverage gate.
Apply that gate to the recovered results, including its undetermined-percentage
and test-only rules. Preserve partial results as incomplete, not passing coverage.


**7. Coverage gate:**

The parent owns this gate, including after inline fallback. Generated tests stay uncommitted until Step 15. The gate only asks; it never hard-fails. Use Step 7's remaining generation allowance; supply it and the remaining gaps to the same audit prompt. At the cap, omit A's generation pass and recommend stopping; A then only lists proposals and the listed risk choices remain available.

Read CLAUDE.md's `## Test Coverage` section for `Minimum:` and `Target:`; otherwise use defaults: Minimum = 60%, Target = 80%. Also read the optional `Generation cap:` (tests per pass, default 5), `Base control:` (`auto` default, or `off`), `Base control budget:` (seconds per run, default 90) and `Star rating:` (`auto` default, or `off`). Missing keys use the defaults.

**Gate number X.** Take the first matching row; never substitute 0:

| Step 7 result | Gate number | Print |
|---|---|---|
| Rating dispatch failed or timed out | skip the gate | rating unavailable: the read-only rating dispatch failed or timed out, so the coverage gate is skipped for this run. Re-run Step 7 to re-rate the tests. (see ~/.claude/skills/gstack/docs/test-value-bar.md#rating-unavailable) |
| Zero paths, test-only diff, or `coverage_pct` null or unparseable | skip the gate | "Coverage gate: could not determine percentage — skipping." |
| `Star rating: off` | `coverage_pct` | "Star rating off: gate uses coverage_pct; weak paths still listed." |
| `coverage_pct_value` missing, not a number, or outside 0..100 | `coverage_pct` | value-weighted coverage unavailable (outdated installed skill); run /gstack-upgrade. The gate used coverage_pct (any test) this run. (see ~/.claude/skills/gstack/docs/test-value-bar.md#value-weighted-coverage-unavailable) |
| `coverage_pct_value` > `coverage_pct` | `coverage_pct` (clamped) | inconsistent coverage inputs: coverage_pct_value was above coverage_pct, so it was clamped to coverage_pct. Re-run Step 7 if the numbers look wrong. (see ~/.claude/skills/gstack/docs/test-value-bar.md#inconsistent-coverage-inputs) |
| Otherwise | `coverage_pct_value` | — |

Y is `coverage_pct`; W is `weak_gaps.length`; N is `gaps`. Remaining slots = 2 × generation cap − tests added or extended so far, and 0 once both passes are used. Option A reads "A) Strengthen the existing ★ test for each weak path and generate tests for true gaps ({slots} of {2 × cap} generation slots remaining)"; at 0 slots it reads "A) List the remaining gaps as proposed tests in the PR body" and dispatches nothing.

- **>= target:** Pass. "Coverage gate: PASS ({X}% value-weighted)." Continue; list weak paths in the PR body as proposed strengthening.
- **>= minimum, < target:** Use AskUserQuestion:
  - "Value-weighted coverage is {X}% ({Y}% including {W} weakly covered paths). {W} paths have only weak tests and {N} have none. Target is {target}%."
  - RECOMMENDATION: Choose A because weakly covered and untested paths are where regressions slip through.
  - Options:
    A) (as above, recommended)
    B) Ship anyway — I accept the coverage risk
    C) These paths don't need tests — mark as intentionally uncovered. Repo-wide sweep: run /test-audit.
  - If A and allowance remains: dispatch one generation pass with the weak paths and gaps, then re-evaluate here. At the cap, offer only B/C or stop, plus A as the proposals list; never another generation pass.
  - If B: Continue. Include in PR body: "Coverage gate: {X}% — user accepted risk."
  - If C: Continue. Include in PR body: "Coverage gate: {X}% — {N} paths intentionally uncovered."

- **< minimum:** Use AskUserQuestion:
  - "Value-weighted coverage is critically low ({X}%; {Y}% including {W} weakly covered paths). {N} of {M} code paths have no tests. Minimum threshold is {minimum}%."
  - RECOMMENDATION: Choose A because less than {minimum}% means more behavior is unprotected than protected.
  - Options:
    A) (as above, recommended)
    B) Override — ship with low coverage (I understand the risk)
  - If A and allowance remains: dispatch one generation pass, then re-evaluate here. At the cap, offer only B or stop, plus A as the proposals list; never another generation pass.
  - If B: Continue. Include in PR body: "Coverage gate: OVERRIDDEN at {X}%."

**Spawned or non-interactive session** (the preamble echoed `SESSION_KIND: spawned` or `headless`): ask nothing. Take A restricted to true `gaps` within the remaining slots; never edit tests for weak paths there. List weak paths in the PR body as proposed strengthening.

**100% coverage:** "Coverage gate: PASS (100%)." Continue.

---
