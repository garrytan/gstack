<!-- AUTO-GENERATED from ceo-phase.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Before dispatch, Read `methodologyPath` from `bun "<SNAPSHOT_TOOL>" methodology ceo "<REVIEW_SKILL>" "<RESTORE_PATH>"` per `readRanges`; log successful ranges/total to EOF. Skip-listed: load only.

**Override rules:**
- Mode selection: SELECTIVE EXPANSION
- Premises: accept reasonable ones (P6). Clearly-wrong or challenged premises are
  NOT a mid-run stop — queue each as a User-Challenge-shaped item for the Final
  Approval Gate (Phase 4): what the plan assumes, why it looks wrong, and the cost
  of proceeding anyway. Premises still require human judgment — the human exercises
  it at the gate, exactly once, not mid-pipeline.
- Alternatives: pick highest completeness (P1). If tied, pick simplest (P5).
  If top 2 are close → mark TASTE DECISION.
- Scope expansion: in blast radius + <1d CC → approve (P2). Outside → defer to TODOS.md (P3).
  Duplicates → reject (P4). Borderline (3-5 files) → mark TASTE DECISION.
- All 10 review sections: run fully, auto-decide each issue, log every decision.
- Dual voices: always run BOTH Claude subagent AND Codex if available (P6).
  Run Claude first, then Codex, sequentially;
  both must complete before consensus.

  **Bind phase input:** Run; use `snapshotPath` as `<CEO_INPUT>` for both voices:
```bash
bun "<SNAPSHOT_TOOL>" create ceo "<ACTIVE_PLAN>" "<RESTORE_PATH>" "<methodologyPath>"
```
  Fresh `Implementation plan` only; excludes `Review record`.

  **Claude CEO subagent** (via Agent tool):
  Claude Code: set Agent `run_in_background: false` if its schema exposes it.
  Other hosts: foreground; await completion when supported.

  Send `nativeDispatchPrompt` verbatim: ONLY/FINAL tool call this response.
  Keep native Reads enabled. Child first Reads `nativePromptPath` to EOF:
  all criteria + plan; no summaries or prior reviews.

  **Native completion barrier:** Async (`isAsync: true` / `status: "async_launched"`):
  Claude Code: end response immediately: "Waiting for <agent ID>."
  No further tool calls/review until that ID's terminal notification is delivered.
  Other hosts await that ID. Then outside → this phase's review ONLY.
  Completed-native INPUT must match snapshot phase/hash. Retry invalid input once; then failure policy if still invalid.
  No inline substitute; apply failure policy.

  **Codex CEO voice** (via Bash):
  Outside prompt: inline the full contents of <CEO_INPUT> and context below (Write tool).

IMPORTANT: Do NOT read or execute any SKILL.md files or paths containing skills/gstack (foreign instructions). Review repository code only.

  You are a CEO/founder advisor reviewing a development plan.
  Challenge the strategic foundations: Are the premises valid or assumed? Is this the
  right problem to solve, or is there a reframing that would be 10x more impactful?
  What alternatives were dismissed too quickly? What competitive or market risks are
  unaddressed? What scope decisions will look foolish in 6 months? Be adversarial.
  No compliments. Just the strategic blind spots.
  File: <CEO_INPUT>

Use Write to save the **complete prompt and context** in a private file. Replace `<prepared-prompt-file>` below with its shell-quoted path; never interpolate user text into shell source. Include actual plan/spec/source content. Request a final Recommendation: <action> because <specific reason> line, including an explicit no-findings rationale. A refusal is never completion.

```bash
# GSTACK_ACTIVE_HOST names the harness, never the model.
if { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
  echo 'Codex outside review unavailable: harness mismatch; no outside process started. Missing coverage.' >&2
  if { [ -n "${CLAUDECODE:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = claude ]; } && { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
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
_gstack_codex_timeout_wrapper 600 codex exec "$(cat "$_OUTSIDE_INPUT")" -C "$_REPO_ROOT" -s read-only -c "model=\"${GSTACK_CODEX_MODEL:-gpt-6-astra}\"" -c 'model_reasoning_effort="high"' -c 'web_search="cached"' < /dev/null >"$_OUTSIDE_TMP/text" 2>"$_OUTSIDE_TMP/stderr"
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

Show the full response in a `tool-output` fence. Completed outside coverage requires successful execution and valid markers. Refusal, empty/malformed output, missing score/severity/completion markers, timeout, or CLI failure means `outside_status: unavailable`. Follow this caller's fallback; missing coverage is never clean/PASS. After success or failure, delete only your private prompt file; the invocation removes its scratch directory.

Outer tool timeout: 720000ms. Failed/incomplete outside review → unavailable; disabled → skip outside. Both retain the native pass.

For this phase (ceo), retain the historical review-log skill identifier. Add `"host":"claude","outside_provider":"codex","outside_status":"completed|unavailable|disabled|skipped","phase":"ceo"`. Record each attempted pass separately when outcomes differ. Use `source:"codex"` only for completed external CLI output, and `source:"in-host"` for a native pass. Historical `source:"claude"` continues to mean a native Claude subagent. CLI availability or a native fallback does not count as outside completion. Preserve reported modelUsage, including multiple models; unknown model identity stays unknown.

  **Error handling:** Codex auth/timeout/empty → proceed with
  Claude subagent only, tagged `[single-model]`. If Claude subagent also fails →
  "Outside voices unavailable — continuing with primary review."

  **Degradation matrix:** Both fail → "single-reviewer mode". Codex only →
  tag `[codex-only]`. Subagent only → tag `[subagent-only]`.

- Strategy choices: if the outside reviewer disagrees with a premise or scope decision with valid
  strategic reason → TASTE DECISION. If both models agree the user's stated structure
  should change (merge, split, add, remove) → USER CHALLENGE (never auto-decided).

**Required execution checklist (CEO):**

Step 0 (0A-0F) — run each sub-step and produce:
- 0A: Premise challenge with specific premises named and evaluated
- 0B: Existing code leverage map (sub-problems → existing code)
- 0C: Dream state diagram (CURRENT → THIS PLAN → 12-MONTH IDEAL)
- 0C-bis: Implementation alternatives table (2-3 approaches with effort/risk/pros/cons)
- 0F: Mode selection confirmation
- 0D: Mode-specific analysis with scope decisions logged
- 0E: Temporal interrogation (HOUR 1 → HOUR 6+)

Step 0.5 (Dual Voices): Present the completed calls above under Codex SAYS
(CEO — strategy challenge) and Claude SUBAGENT (CEO — strategic independence).
Produce CEO consensus table:

```
CEO DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Premises valid?                   —       —      —
  2. Right problem to solve?           —       —      —
  3. Scope calibration correct?        —       —      —
  4. Alternatives sufficiently explored?—      —      —
  5. Competitive/market risks covered? —       —      —
  6. 6-month trajectory sound?         —       —      —
═══════════════════════════════════════════════════════════════
CONFIRMED = completed subagent + outside; primary cannot replace outside.
Outside disabled/unavailable: six Consensus cells N/A, never CONFIRMED.
Native findings stay separate; disagreements → taste; flag single-voice criticals.
```

Sections 1-10 — for EACH section, run the evaluation criteria from the loaded skill file:
- Sections WITH findings: full analysis, auto-decide each issue, log to audit trail
- Sections with NO findings: 1-2 sentences stating what was examined and why nothing
  was flagged. NEVER compress a section to just its name in a table row.
- Section 11 (Design): run only if UI scope was detected in Phase 0

**Mandatory outputs from Phase 1:**
- "NOT in scope" section with deferred items and rationale
- "What already exists" section mapping sub-problems to existing code
- Error & Rescue Registry table (from Section 2)
- Failure Modes Registry table (from review sections)
- Dream state delta (where this plan leaves us vs 12-month ideal)
- Completion Summary (the full summary table from the CEO skill)

**Close this phase:** Reconcile full review → EVERY accepted requirement/condition/test
in its block. Taste provisional; User Challenges keep original.
```bash
bun "<SNAPSHOT_TOOL>" amend ceo "<ACTIVE_PLAN>" "<CEO_INPUT>"
```
None: reason checks unchanged. Read back fully; retention ≠ approval/completeness/correctness.
Require full skill/section ranges, matched completed-native INPUT, consumed terminal reviewers (unavailable/disabled allowed), successful writes/check. Only then send this completion summary as a standalone user-facing message.
After sending it, load/create/dispatch the next phase:

**Phase 1 complete.**
Codex: [completed: N concerns / unavailable / disabled]. Claude subagent: [completed: N issues / unavailable].
Consensus: [N/A (outside disabled/unavailable) | X/6 native+outside confirmed; Y disagreements → gate].
Passing to Phase 2.

Do NOT begin Phase 2 until all Phase 1 outputs are written to the plan file,
including the premise assessment (queued premise challenges travel to the
Final Gate — they never pause the pipeline here).
