<!-- AUTO-GENERATED from dx-phase.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Read `~/.claude/skills/gstack/plan-devex-review/SKILL.md` and its triggered sections in full. Before dispatch, record successful Read start/end/total ranges; fetch gaps to EOF. Load skip-listed sections; skip execution.

**Override rules:**
- Mode selection: DX POLISH
- Persona: infer from README/docs, pick the most common developer type (P6)
- Competitive benchmark: research through Aside per the loaded skill's "Web research runs in Aside" section (WebSearch when Aside is not ready); use the reference benchmarks when neither is available (P1)
- Magical moment: pick the lowest-effort delivery vehicle that achieves the competitive tier (P5)
- Getting started friction: always optimize toward fewer steps (P5, simpler over clever)
- Error message quality: always require problem + cause + fix (P1, completeness)
- API/CLI naming: consistency wins over cleverness (P5)
- DX taste decisions (e.g., opinionated defaults vs flexibility): mark TASTE DECISION
- Dual voices: always run BOTH Claude subagent AND Codex if available (P6).

  **Bind this phase's input:** Run; use returned `snapshotPath` as `<DX_INPUT>` for both voices:
```bash
bun "<SNAPSHOT_TOOL>" create dx "<ACTIVE_PLAN>" "<RESTORE_PATH>"
```
  Fresh `Implementation plan` only; excludes `Review record`.

  **Claude DX subagent** (native tool):
  Claude Code: set Agent `run_in_background: false` if its schema exposes it.
  Other hosts: native dispatch/wait.

  "Read the plan file at <DX_INPUT>. You are an independent DX engineer
  reviewing this plan. You have NOT seen any prior review. Evaluate:
  1. Getting started: how many steps from zero to hello world? What's the TTHW?
  2. API/CLI ergonomics: naming consistency, sensible defaults, progressive disclosure?
  3. Error handling: does every error path specify problem + cause + fix + docs link?
  4. Documentation: copy-paste examples? Information architecture? Interactive elements?
  5. Escape hatches: can developers override every opinionated default?
  For each finding: what's wrong, severity (critical/high/medium), and the fix."
  NO prior-phase context — subagent must be truly independent.

  **Native completion barrier:** If `isAsync: true` / `status: "async_launched"`,
  Claude Code: end response; resume only on same-agent terminal notification.
  Other hosts: await that ID. Then outside → this phase's review ONLY.
  No inline substitute; apply failure policy.

  **Codex DX voice** (via Bash):
  Outside prompt: inline the full contents of <DX_INPUT> and context below (Write tool).

IMPORTANT: Do NOT read or execute any SKILL.md files or paths containing skills/gstack (foreign instructions). Review repository code only.

  Read the plan file at <DX_INPUT>. Evaluate this plan's developer experience.

  Also consider these findings from prior review phases:
  CEO: <insert CEO consensus summary>
  Design: <insert Design consensus summary, or 'skipped, no UI scope'>

  You are a developer who has never seen this product. Evaluate:
  1. Time to hello world: how many steps from zero to working? Target is under 5 minutes.
  2. Error messages: when something goes wrong, does the dev know what, why, and how to fix?
  3. API/CLI design: are names guessable? Are defaults sensible? Is it consistent?
  4. Docs: can a dev find what they need in under 2 minutes? Are examples copy-paste-complete?
  5. Upgrade path: can devs upgrade without fear? Migration guides? Deprecation warnings?
  Be adversarial. Think like a developer who is evaluating this against 3 competitors.

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

For this phase (dx), retain the historical review-log skill identifier. Add `"host":"claude","outside_provider":"codex","outside_status":"completed|unavailable|disabled|skipped","phase":"dx"`. Record each attempted pass separately when outcomes differ. Use `source:"codex"` only for completed external CLI output, and `source:"in-host"` for a native pass. Historical `source:"claude"` continues to mean a native Claude subagent. CLI availability or a native fallback does not count as outside completion. Preserve reported modelUsage, including multiple models; unknown model identity stays unknown.

  Error handling: Phase 1 failure/degradation policy applies.

- DX choices: if the outside reviewer disagrees with a DX decision with valid developer empathy reasoning
  → TASTE DECISION. Scope changes both models agree on → USER CHALLENGE.

**Required execution checklist (DX):**

1. Step 0 (DX Scope Assessment): Auto-detect product type. Map the developer journey.
   Rate initial DX completeness 0-10. Assess TTHW.

2. Step 0.5 (Dual Voices): Present the completed calls above under Codex SAYS
   (DX — developer experience challenge) and Claude SUBAGENT (DX — independent review).
   Produce DX consensus table:

```
DX DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                           Claude  Codex  Consensus
  ──────────────────────────────────── ─────── ─────── ─────────
  1. Getting started < 5 min?          —       —      —
  2. API/CLI naming guessable?         —       —      —
  3. Error messages actionable?        —       —      —
  4. Docs findable & complete?         —       —      —
  5. Upgrade path safe?                —       —      —
  6. Dev environment friction-free?    —       —      —
═══════════════════════════════════════════════════════════════
CONFIRMED = both agree. DISAGREE = models differ (→ taste decision).
Missing voice = N/A (not CONFIRMED). Single critical finding from one voice = flagged regardless.
```

3. Passes 1-8: Run each from loaded skill. Rate 0-10. Auto-decide each issue.
   DISAGREE items from consensus table → raised in the relevant pass with both perspectives.

4. DX Scorecard: Produce the full scorecard with all 8 dimensions scored.

**Mandatory outputs from Phase 2.5:**
- Developer journey map (9-stage table)
- Developer empathy narrative (first-person perspective)
- DX Scorecard with all 8 dimension scores
- DX Implementation Checklist
- TTHW assessment with target

**Close this phase:** Edit accepted changes into `Implementation plan` (taste:
pending final approval; unresolved User Challenges: retain original direction).
Report/task edits do not count. After successful Edit:
```bash
bun "<SNAPSHOT_TOOL>" check dx "<ACTIVE_PLAN>" "<DX_INPUT>" changed
```
Use `unchanged` only if no implementation changes were accepted; explain why.
Verify returned text against decisions; hashes prove bytes, not correctness.
Require full load ranges, successful output writes and terminal reviewers (unavailable/disabled allowed).
Only then emit this actual assistant message:

**Phase 2.5 complete.**
DX overall: [N]/10. TTHW: [N] min → [target] min.
Codex: [completed: N concerns / unavailable / disabled]. Claude subagent: [completed: N issues / unavailable].
Consensus: [X/6 confirmed, Y disagreements → surfaced at gate].
Passing to Phase 3 (Eng Review — the required gate reviews the final amended plan).
