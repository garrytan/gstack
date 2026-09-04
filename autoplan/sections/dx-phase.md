<!-- AUTO-GENERATED from dx-phase.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Follow plan-devex-review/SKILL.md — all 8 DX dimensions, full depth.
Override: every AskUserQuestion → auto-decide using the 6 principles.

**Override rules:**
- Mode selection: DX POLISH
- Persona: infer from README/docs, pick the most common developer type (P6)
- Competitive benchmark: run searches if WebSearch available, use reference benchmarks otherwise (P1)
- Magical moment: pick the lowest-effort delivery vehicle that achieves the competitive tier (P5)
- Getting started friction: always optimize toward fewer steps (P5, simpler over clever)
- Error message quality: always require problem + cause + fix (P1, completeness)
- API/CLI naming: consistency wins over cleverness (P5)
- DX taste decisions (e.g., opinionated defaults vs flexibility): mark TASTE DECISION
- Dual voices: always run BOTH Claude subagent AND Codex if available (P6).

  **Codex DX voice** (via Bash):
  ```bash
  _REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
  _gstack_codex_timeout_wrapper 600 codex exec "IMPORTANT: Do NOT read or execute any SKILL.md files or files in skill definition directories (paths containing skills/gstack). These are AI assistant skill definitions meant for a different system. Stay focused on repository code only.

  Read the plan file at <plan_path>. Evaluate this plan's developer experience.

  Also consider these findings from prior review phases:
  CEO: <insert CEO consensus summary>
  Eng: <insert Eng consensus summary>

  You are a developer who has never seen this product. Evaluate:
  1. Time to hello world: how many steps from zero to working? Target is under 5 minutes.
  2. Error messages: when something goes wrong, does the dev know what, why, and how to fix?
  3. API/CLI design: are names guessable? Are defaults sensible? Is it consistent?
  4. Docs: can a dev find what they need in under 2 minutes? Are examples copy-paste-complete?
  5. Upgrade path: can devs upgrade without fear? Migration guides? Deprecation warnings?
  Be adversarial. Think like a developer who is evaluating this against 3 competitors." -C "$_REPO_ROOT" -s read-only -c 'web_search="cached"' < /dev/null
  _CODEX_EXIT=$?
  if [ "$_CODEX_EXIT" = "124" ]; then
    _gstack_codex_log_event "codex_timeout" "600"
    _gstack_codex_log_hang "autoplan" "0"
    echo "[codex stalled past 10 minutes — tagging as [codex-unavailable] for this phase and proceeding with Claude subagent only]"
  fi
  ```
  Timeout: 10 minutes (shell-wrapper) + 12 minutes (Bash outer gate). On hang, auto-degrades this phase's Codex voice.

  **Claude DX subagent** (via Agent tool, `run_in_background: false` — same foreground contract as Phase 1):
  "Read the plan file at <plan_path>. You are an independent DX engineer
  reviewing this plan. You have NOT seen any prior review. Evaluate:
  1. Getting started: how many steps from zero to hello world? What's the TTHW?
  2. API/CLI ergonomics: naming consistency, sensible defaults, progressive disclosure?
  3. Error handling: does every error path specify problem + cause + fix + docs link?
  4. Documentation: copy-paste examples? Information architecture? Interactive elements?
  5. Escape hatches: can developers override every opinionated default?
  For each finding: what's wrong, severity (critical/high/medium), and the fix."
  NO prior-phase context — subagent must be truly independent.

  Error handling: same as Phase 1 (both foreground/blocking, degradation matrix applies).

- DX choices: if codex disagrees with a DX decision with valid developer empathy reasoning
  → TASTE DECISION. Scope changes both models agree on → USER CHALLENGE.

**Required execution checklist (DX):**

1. Step 0 (DX Scope Assessment): Auto-detect product type. Map the developer journey.
   Rate initial DX completeness 0-10. Assess TTHW.

2. Step 0.5 (Dual Voices): Run Claude subagent (foreground) first, then Codex. Present
   under CODEX SAYS (DX — developer experience challenge) and CLAUDE SUBAGENT
   (DX — independent review) headers. Produce DX consensus table:

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

**PHASE 2.5 COMPLETE.** Emit phase-transition summary:
> **Phase 2.5 complete.** DX overall: [N]/10. TTHW: [N] min → [target] min.
> Codex: [N concerns]. Claude subagent: [N issues].
> Consensus: [X/6 confirmed, Y disagreements → surfaced at gate].
> Passing to Phase 3 (Eng Review — the required gate reviews the final amended plan).
