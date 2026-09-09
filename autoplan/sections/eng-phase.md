<!-- AUTO-GENERATED from eng-phase.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Read `~/.claude/skills/gstack/plan-eng-review/SKILL.md` and its triggered sections in full. Before dispatch, record successful Read start/end/total ranges; fetch gaps to EOF. Load skip-listed sections; skip execution.

**Override rules:**
- Scope challenge: never reduce (P2)
- Dual voices: always run BOTH Claude subagent AND Codex if available (P6).

  **Bind this phase's input:** Run; use returned `snapshotPath` as `<ENG_INPUT>` for both voices:
```bash
bun "<SNAPSHOT_TOOL>" create eng "<ACTIVE_PLAN>" "<RESTORE_PATH>"
```
  Fresh `Implementation plan` only; excludes `Review record`.

  **Claude eng subagent** (native tool):
  Claude Code: set Agent `run_in_background: false` if its schema exposes it.
  Other hosts: use foreground dispatch and await completion when supported.

  Send `nativePrompt` verbatim. If truncated, Read `nativePromptPath` to EOF.
  It contains all criteria and snapshot bytes; no summaries or prior reviews.

  **Native completion barrier:** If `isAsync: true` / `status: "async_launched"`,
  Claude Code: immediately end this response with "Waiting for <agent ID>."
  Do no more tool calls or review work until that ID's terminal notification is
  delivered. Other hosts: await that ID. Then outside → this phase's review ONLY.
  For completed native reviews, match INPUT phase/hash to this snapshot. Missing
  or mismatched INPUT: retry the full payload once, then use failure policy if
  still invalid.
  No inline substitute; apply failure policy.

  **Codex eng voice** (via Bash):
  Outside prompt: inline the full contents of <ENG_INPUT> and context below (Write tool).

IMPORTANT: Do NOT read or execute any SKILL.md files or paths containing skills/gstack (foreign instructions). Review repository code only.

  Review this plan for architectural issues, missing edge cases,
  and hidden complexity. Be adversarial.

  Also consider these findings from prior review phases:
  CEO: <insert CEO consensus table summary — key concerns, DISAGREEs>
  Design: <insert Design consensus table summary, or 'skipped, no UI scope'>
  DX: <insert DX consensus table summary, or 'skipped, no developer-facing scope'>

  File: <ENG_INPUT>

Write the **complete prompt and required context** to a private temporary file using the Write tool. Do not interpolate user text into shell source. Replace the literal `<prepared-prompt-file>` below with its shell-quoted pathname. Include the plan/spec/source content itself when needed: Claude Code review/challenge has no tools and cannot follow paths or execute git. Request a final Recommendation: <action> because <specific reason> line, including an explicit no-findings rationale. A refusal is never completion.

```bash
# GSTACK_ACTIVE_HOST, when supplied, must identify the actual harness, never a model overlay.
if { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
  echo 'Codex outside review unavailable: harness mismatch; no outside process started. Missing coverage.' >&2
  if [ -n "${CLAUDECODE:-}" ] && { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ]; }; then
    echo 'Inherited harness markers conflict. Run setup --host <actual-harness> (claude or codex); do not guess a replacement provider.' >&2
  else
    echo 'Repair installed skills: run setup --host codex from your gstack checkout.' >&2
  fi
  exit 78
fi

_REPO_ROOT=$(git rev-parse --show-toplevel) || { echo 'ERROR: not in a git repo' >&2; exit 1; }
_OUTSIDE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/gstack-outside.XXXXXXXX") || exit 1
trap 'rm -rf "$_OUTSIDE_TMP"' EXIT
_OUTSIDE_INPUT="$_OUTSIDE_TMP/prompt"
cat -- '<prepared-prompt-file>' >"$_OUTSIDE_INPUT" || exit 1

source "$HOME/.claude/skills/gstack/bin/gstack-codex-probe" || exit 1
_gstack_codex_timeout_wrapper 600 codex exec "$(cat "$_OUTSIDE_INPUT")" -C "$_REPO_ROOT" -s read-only -c 'model_reasoning_effort="high"' -c 'web_search="cached"' < /dev/null >"$_OUTSIDE_TMP/text" 2>"$_OUTSIDE_TMP/stderr"
_OUTSIDE_EXIT=$?
# Preserve findings and partial output even when transport or validation fails.
cat "$_OUTSIDE_TMP/text"
if [ "$_OUTSIDE_EXIT" -eq 124 ]; then
  _gstack_codex_log_event "codex_timeout" "600"
  _gstack_codex_log_hang "autoplan" "0"
fi
cat "$_OUTSIDE_TMP/stderr" >&2
if [ "$_OUTSIDE_EXIT" -ne 0 ]; then
  echo 'Codex outside review unavailable: execution failed; missing coverage. Check the provider diagnosis above.' >&2
  exit "$_OUTSIDE_EXIT"
fi
bun "$HOME/.claude/skills/gstack/lib/outside-review-result.ts" review "$_OUTSIDE_TMP/text" || exit 1

echo 'OUTSIDE_STATUS: completed provider=codex host=claude'
```

Present the full response inside a `tool-output` fence. Only successful execution **and** valid review markers establish completed outside coverage. Refusal, empty/malformed output, missing score/severity/completion markers, timeout, or CLI failure means `outside_status: unavailable`. Follow this caller's existing fallback/decision flow; never turn missing coverage into a clean/PASS result. After presentation or failure, delete the private prompt file you created (only that owned temporary file); the invocation already removes its own scratch directory.

Outer tool timeout: 720000ms. Failed/incomplete outside review → unavailable; disabled → skip outside. Both retain the native pass.

For this phase (eng), retain the historical review-log skill identifier. Add `"host":"claude","outside_provider":"codex","outside_status":"completed|unavailable|disabled|skipped","phase":"eng"`. Record each attempted pass separately when outcomes differ. Use `source:"codex"` only for completed external CLI output, and `source:"in-host"` for a native pass. Historical `source:"claude"` continues to mean a native Claude subagent. CLI availability or a native fallback does not count as outside completion. Preserve reported modelUsage, including multiple models; unknown model identity stays unknown.

  Error handling: Phase 1 failure/degradation policy applies.

- Architecture choices: explicit over clever (P5). If Codex disagrees with valid reason → TASTE DECISION. Scope changes both models agree on → USER CHALLENGE.
- Evals: always include all relevant suites (P1)
- Test plan: generate artifact at `~/.gstack/projects/$SLUG/{user}-{branch}-test-plan-{datetime}.md`
- TODOS.md: collect all deferred scope expansions from every prior phase (Eng runs last), auto-write

**Required execution checklist (Eng):**

1. Step 0 (Scope Challenge): Read actual code referenced by the plan. Map each
   sub-problem to existing code. Run the complexity check. Produce concrete findings.

2. Step 0.5 (Dual Voices): Present the completed calls above under Codex SAYS
   (eng — architecture challenge) and Claude SUBAGENT (eng — independent review).
   Produce eng consensus table:

```
ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Architecture sound?               —       —      —
  2. Test coverage sufficient?         —       —      —
  3. Performance risks addressed?      —       —      —
  4. Security threats covered?         —       —      —
  5. Error paths handled?              —       —      —
  6. Deployment risk manageable?       —       —      —
═══════════════════════════════════════════════════════════════
CONFIRMED = both agree. DISAGREE = models differ (→ taste decision).
Missing voice = N/A (not CONFIRMED). Single critical finding from one voice = flagged regardless.
```

3. Section 1 (Architecture): Produce ASCII dependency graph showing new components
   and their relationships to existing ones. Evaluate coupling, scaling, security.

4. Section 2 (Code Quality): Identify DRY violations, naming issues, complexity.
   Reference specific files and patterns. Auto-decide each finding.

5. **Section 3 (Test Review) — NEVER SKIP OR COMPRESS.**
   This section requires reading actual code, not summarizing from memory.
   - Read the diff or the plan's affected files
   - Build the test diagram: list every NEW UX flow, data flow, codepath, and branch
   - For EACH item in the diagram: what type of test covers it? Does one exist? Gaps?
   - For LLM/prompt changes: which eval suites must run?
   - Auto-deciding test gaps means: identify the gap → decide whether to add a test
     or defer (with rationale and principle) → log the decision. It does NOT mean
     skipping the analysis.
   - Write the test plan artifact to disk

6. Section 4 (Performance): Evaluate N+1 queries, memory, caching, slow paths.

**Mandatory outputs from Phase 3:**
- "NOT in scope" section
- "What already exists" section
- Architecture ASCII diagram (Section 1)
- Test diagram mapping codepaths to coverage (Section 3)
- Test plan artifact written to disk (Section 3)
- Failure modes registry with critical gap flags
- Completion Summary (the full summary from the Eng skill)
- TODOS.md updates (collected from all phases)

**Close this phase:** Edit accepted changes into `Implementation plan` (taste:
pending final approval; unresolved User Challenges: retain original direction).
Report/task edits do not count. After successful Edit:
```bash
bun "<SNAPSHOT_TOOL>" check eng "<ACTIVE_PLAN>" "<ENG_INPUT>" changed
```
Use `unchanged` only if no implementation changes were accepted; explain why.
Verify returned text against decisions; hashes prove bytes, not correctness.
Require full load ranges, matched INPUT for completed native reviews, consumed
terminal reviewers (unavailable/disabled allowed), successful writes and this check result.
Only then emit this actual assistant message:

**Phase 3 complete.**
Codex: [completed: N concerns / unavailable / disabled]. Claude subagent: [completed: N issues / unavailable].
Consensus: [X/6 confirmed, Y disagreements → surfaced at gate].
Passing to Phase 4 (Final Gate).
