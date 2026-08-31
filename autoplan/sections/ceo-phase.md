<!-- AUTO-GENERATED from ceo-phase.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Follow plan-ceo-review/SKILL.md — all sections, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

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
  Run them sequentially in foreground. First the Claude subagent (Agent tool
  with run_in_background: false — subagents default to BACKGROUND since
  Claude Code v2.1.198, so the flag must be explicitly false), then Codex
  (Bash). Both must complete before building the consensus table.

  **Codex CEO voice** (via Bash):
  ```bash
  _REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
  _gstack_codex_timeout_wrapper 600 codex exec "IMPORTANT: Do NOT read or execute any SKILL.md files or files in skill definition directories (paths containing skills/gstack). These are AI assistant skill definitions meant for a different system. Stay focused on repository code only.

  You are a CEO/founder advisor reviewing a development plan.
  Challenge the strategic foundations: Are the premises valid or assumed? Is this the
  right problem to solve, or is there a reframing that would be 10x more impactful?
  What alternatives were dismissed too quickly? What competitive or market risks are
  unaddressed? What scope decisions will look foolish in 6 months? Be adversarial.
  No compliments. Just the strategic blind spots.
  File: <plan_path>" -C "$_REPO_ROOT" -s read-only -c 'web_search="cached"' < /dev/null
  _CODEX_EXIT=$?
  if [ "$_CODEX_EXIT" = "124" ]; then
    _gstack_codex_log_event "codex_timeout" "600"
    _gstack_codex_log_hang "autoplan" "0"
    echo "[codex stalled past 10 minutes — tagging as [codex-unavailable] for this phase and proceeding with Claude subagent only]"
  fi
  ```
  Timeout: 10 minutes (shell-wrapper) + 12 minutes (Bash outer gate). On hang, auto-degrades this phase's Codex voice.

  **Claude CEO subagent** (via Agent tool):
  "Read the plan file at <plan_path>. You are an independent CEO/strategist
  reviewing this plan. You have NOT seen any prior review. Evaluate:
  1. Is this the right problem to solve? Could a reframing yield 10x impact?
  2. Are the premises stated or just assumed? Which ones could be wrong?
  3. What's the 6-month regret scenario — what will look foolish?
  4. What alternatives were dismissed without sufficient analysis?
  5. What's the competitive risk — could someone else solve this first/better?
  For each finding: what's wrong, severity (critical/high/medium), and the fix."

  **Error handling:** Both calls block in foreground. Codex auth/timeout/empty → proceed with
  Claude subagent only, tagged `[single-model]`. If Claude subagent also fails →
  "Outside voices unavailable — continuing with primary review."

  **Degradation matrix:** Both fail → "single-reviewer mode". Codex only →
  tag `[codex-only]`. Subagent only → tag `[subagent-only]`.

- Strategy choices: if codex disagrees with a premise or scope decision with valid
  strategic reason → TASTE DECISION. If both models agree the user's stated structure
  should change (merge, split, add, remove) → USER CHALLENGE (never auto-decided).

**Required execution checklist (CEO):**

Step 0 (0A-0F) — run each sub-step and produce:
- 0A: Premise challenge with specific premises named and evaluated
- 0B: Existing code leverage map (sub-problems → existing code)
- 0C: Dream state diagram (CURRENT → THIS PLAN → 12-MONTH IDEAL)
- 0C-bis: Implementation alternatives table (2-3 approaches with effort/risk/pros/cons)
- 0D: Mode-specific analysis with scope decisions logged
- 0E: Temporal interrogation (HOUR 1 → HOUR 6+)
- 0F: Mode selection confirmation

Step 0.5 (Dual Voices): Run Claude subagent (foreground Agent tool) first, then
Codex (Bash). Present Codex output under CODEX SAYS (CEO — strategy challenge)
header. Present subagent output under CLAUDE SUBAGENT (CEO — strategic independence)
header. Produce CEO consensus table:

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
CONFIRMED = both agree. DISAGREE = models differ (→ taste decision).
Missing voice = N/A (not CONFIRMED). Single critical finding from one voice = flagged regardless.
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

**PHASE 1 COMPLETE.** Emit phase-transition summary:
> **Phase 1 complete.** Codex: [N concerns]. Claude subagent: [N issues].
> Consensus: [X/6 confirmed, Y disagreements → surfaced at gate].
> Passing to Phase 2.

Do NOT begin Phase 2 until all Phase 1 outputs are written to the plan file,
including the premise assessment (queued premise challenges travel to the
Final Gate — they never pause the pipeline here).
