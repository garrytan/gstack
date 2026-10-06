// ─── Shared Design Constants ────────────────────────────────

import { DESIGN_SLOP_CATALOG } from '../../lib/design-catalog';

/**
 * gstack's AI slop anti-patterns — shared between DESIGN_METHODOLOGY and DESIGN_HARD_RULES.
 *
 * Derived from the typed catalog in lib/design-catalog.ts: the 11 entries flagged
 * `legacyBlacklist`, prose verbatim, in catalog order. Overused fonts live there
 * too (OVERUSED_FONTS_DISPLAY), role-scoped: banned as the display voice, several
 * still fine as body/UI on an Operate or Read surface.
 */
export const AI_SLOP_BLACKLIST: string[] = DESIGN_SLOP_CATALOG
  .filter(e => e.legacyBlacklist)
  .map(e => e.prose);

/** OpenAI hard rejection criteria (from "Designing Delightful Frontends with GPT-5.4", Mar 2026) */
export const OPENAI_HARD_REJECTIONS = [
  'Generic SaaS card grid as first impression',
  'Beautiful image with weak brand',
  'Strong headline with no clear action',
  'Busy imagery behind text',
  'Sections repeating same mood statement',
  'Carousel with no narrative purpose',
  'App UI made of stacked cards instead of layout',
];

/** OpenAI litmus checks — 7 yes/no tests for cross-model consensus scoring */
export const OPENAI_LITMUS_CHECKS = [
  'Brand/product unmistakable in first screen?',
  'One strong visual anchor present?',
  'Page understandable by scanning headlines only?',
  'Each section has one job?',
  'Are cards actually necessary?',
  'Does motion improve hierarchy or atmosphere?',
  'Would design feel premium with all decorative shadows removed?',
];

/**
 * Web-search flag for every codex invocation (#2525).
 *
 * codex >=0.144 deprecated the legacy `--enable`-based web_search_cached
 * spelling (web search is on by default; the deprecation notice says to set
 * `web_search` to "live", "indexed", "cached", or "disabled" at the top
 * level), and `--enable <FEATURE>` now means `-c features.<name>=true`
 * (verified on 0.147.0), so the legacy spelling is headed for hard
 * rejection. This is the ONE source
 * of truth: resolvers interpolate it directly and templates reference it via
 * the {{CODEX_WEB_SEARCH_FLAG}} token — never write the flag inline.
 *
 * Semantics note: unlike the legacy flag (which yielded to an existing
 * top-level `web_search` in config.toml), the -c form explicitly overrides
 * it. Deliberate: gstack wants deterministic cached search for review
 * invocations. Native `codex review` disables web search regardless of
 * configuration, so on that path the flag is a harmless no-op.
 */
export const CODEX_WEB_SEARCH_FLAG = `-c 'web_search="cached"'`;

/**
 * Default model for gstack-owned Codex invocations when nothing else chooses.
 *
 * The runtime model is resolved per invocation kind by
 * `_gstack_codex_select_model exec|review` (bin/gstack-codex-probe, backed by
 * resolveCodexRuntimeModel in scripts/resolve-codex-generation-model.ts):
 * explicit request, then GSTACK_CODEX_MODEL, then Codex config.toml (`model`;
 * `review_model` first for native review; honors CODEX_HOME), then this default
 * (#2914). The selection is printed before the first paid call and the probe
 * checks the same record the flags below pass.
 */
export const CODEX_FRONTIER_MODEL = 'gpt-6-astra';
/**
 * Nested gstack Codex calls are one-shot reviews: keep installed skills (gstack's
 * own included) out of the model's context so the reviewer cannot re-run a whole
 * skill workflow inside its budget (#2847). Read-only sandboxes do not prevent this.
 */
export const CODEX_SKILLS_ISOLATION_FLAG = '-c skills.include_instructions=false';
const SELECTED_MODEL = '${_GSTACK_CODEX_SEL:?}';
/** Requires `_gstack_codex_select_model exec` earlier in the same shell; `:?` stops an unselected command. */
export const CODEX_MODEL_CONFIG_FLAG = `-c "model=\\"${SELECTED_MODEL}\\"" ${CODEX_SKILLS_ISOLATION_FLAG}`;
/** Requires `_gstack_codex_select_model review`; native review prefers review_model, so both carry the selection. */
export const CODEX_REVIEW_MODEL_CONFIG_FLAG = `-c "review_model=\\"${SELECTED_MODEL}\\"" ${CODEX_MODEL_CONFIG_FLAG}`;

/**
 * Shared Codex error handling block for resolver output.
 * Used by ADVERSARIAL_STEP, CODEX_PLAN_REVIEW, CODEX_SECOND_OPINION,
 * DESIGN_OUTSIDE_VOICES, DESIGN_REVIEW_LITE, DESIGN_SKETCH.
 */
export function codexErrorHandling(feature: string): string {
  return `**Error handling:** All errors are non-blocking — the ${feature} is informational.
- Auth failure (stderr contains "auth", "login", "unauthorized"): note and skip
- Timeout: note timeout duration and skip
- Empty response: note and skip
On any error: continue — ${feature} is informational, not a gate.`;
}

/**
 * Shared Codex preflight bash block — the single source of truth for deciding
 * whether a Codex review pass should run. Used by ADVERSARIAL_STEP,
 * CODEX_PLAN_REVIEW, and CODEX_DOC_REVIEW so install/auth/config detection
 * lives in exactly one place.
 *
 * Emits ONE self-contained bash block (the caller must place it in a single
 * fenced block — CLAUDE.md: each block is a fresh shell, so functions sourced
 * here do NOT persist to later blocks). It:
 *   1. reads the `codex_reviews` master switch,
 *   2. sources `gstack-codex-probe` with POSIX `.`, so even sh/dash reach the
 *      helper's own diagnostic (`CODEX_MODE: helper_unavailable`),
 *   3. runs `command -v codex` (literal — keeps the e2e substring assertion),
 *      then `_gstack_codex_auth_probe`, then `_gstack_codex_version_check`,
 *   4. logs the relevant `_gstack_codex_log_event` for each non-ready outcome,
 *   5. sets ONE canonical mode var and echoes `CODEX_MODE: <mode>` so the agent
 *      gates later blocks on the echoed value.
 *
 * Mode values: `disabled` (config off) | `helper_unavailable` (the probe could
 * not be sourced; its own diagnostic is echoed) | `not_installed` | `not_authed` |
 * `broken_install` | `sandbox_unavailable` | `model_unusable` | `quota_exhausted` |
 * `unverified` | `ready`.
 * The path is host-rewritten at gen-skill-docs time (pathRewrites), so the
 * literal `~/.claude/skills/gstack` is correct here and becomes `$GSTACK_ROOT`
 * etc. for non-Claude hosts.
 *
 * `disabledBehavior` controls the `disabled`-mode interpretation, which is the
 * one branch that legitimately differs per caller (D1):
 *   - `skip-all` (plan / doc reviews): disabled means no extra review step at
 *     all — skip the section, no Claude fallback.
 *   - `codex-only` (diff adversarial): disabled gates only the Codex passes; the
 *     free Claude adversarial subagent still runs.
 */
export function codexPreflight(opts: { modeVar?: string; disabledBehavior: 'skip-all' | 'codex-only'; nativeReview?: boolean }): string {
  const m = opts.modeVar ?? '_CODEX_MODE';
  const disabledLine = opts.disabledBehavior === 'codex-only'
    ? 'Skip the Codex passes only; the Claude adversarial subagent below STILL runs (it is free and fast). Print: "Codex passes skipped (codex_reviews disabled) — running Claude adversarial only."'
    : 'Skip this section entirely; do NOT fall back to a Claude subagent — disabled means no extra review step. Print: "Codex review skipped (codex_reviews disabled). Re-enable: `gstack-config set codex_reviews enabled`."';
  const nativeRoute = opts.disabledBehavior === 'codex-only'
    ? 'Keep the required Claude adversarial pass; do not dispatch a duplicate.'
    : 'Fall back to the Claude subagent path.';
  return `\`\`\`bash
# Codex preflight: one block (functions sourced here don't persist to later blocks).
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || echo off)
_CODEX_CFG=$(~/.claude/skills/gstack/bin/gstack-config get codex_reviews 2>/dev/null || echo enabled)
_gstack_helper_error=""
. ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || _gstack_helper_error="\${_gstack_helper_error:-gstack: cannot load gstack-codex-probe; re-run ./setup. https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#sourced-helper-location}"
if [ "$_CODEX_CFG" = "disabled" ]; then
  ${m}="disabled"
elif { [ -n "\${CODEX_THREAD_ID:-}" ] || [ -n "\${CODEX_SANDBOX:-}" ] || [ "\${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
  ${m}="under_codex"
elif ! command -v codex >/dev/null 2>&1; then
  ${m}="not_installed"; _gstack_codex_log_event "codex_cli_missing" 2>/dev/null || true
elif [ -n "$_gstack_helper_error" ]; then
  ${m}="helper_unavailable"; echo "$_gstack_helper_error"
elif ! _gstack_codex_auth_probe >/dev/null 2>&1; then
  ${m}="not_authed"; _gstack_codex_log_event "codex_auth_failed" 2>/dev/null || true
else
  # The free sandbox check runs before the paid model probe. Probe code 2 means
  # the CLI cannot execute at all, a different fix from an unusable model.
  _CODEX_MP=0; _gstack_codex_sandbox_preflight || _CODEX_MP=3
  [ "$_CODEX_MP" -ne 0 ] || { _gstack_codex_model_probe; _CODEX_MP=$?; }${opts.nativeReview ? `
  [ "$_CODEX_MP" -ne 0 ] || { _gstack_codex_model_probe review; _CODEX_MP=$?; }` : ''}
  if [ "$_CODEX_MP" -eq 3 ]; then
    ${m}="sandbox_unavailable"
  elif [ "$_CODEX_MP" -eq 2 ]; then
    ${m}="broken_install"
  elif [ "$_CODEX_MP" -eq 4 ]; then
    ${m}="quota_exhausted"
  elif [ "$_CODEX_MP" -ne 0 ]; then
    ${m}="model_unusable"
  elif [ "\${_GSTACK_CODEX_PROBE_STATE:-}" = inconclusive ]; then
    ${m}="unverified"
  else
    ${m}="ready"; _gstack_codex_version_check 2>/dev/null || true
  fi
fi
echo "CODEX_MODE: $${m}"
\`\`\`

Branch on the echoed \`CODEX_MODE\`:
- **\`disabled\`** — the user turned Codex reviews off (\`codex_reviews=disabled\`). ${disabledLine}
- **\`helper_unavailable\`** — the helper could not load; relay the line above (cause and fix). ${nativeRoute}
- **\`not_installed\`** — Codex CLI absent. Print: "Codex not installed; outside coverage unavailable. Install: \`npm install -g @openai/codex\`." ${nativeRoute}
- **\`under_codex\`** — stale artifact selected its own harness. Print: "Codex outside review unavailable: harness mismatch; no outside process started. Missing coverage. Repair: setup --host codex." Skip the outside invocation and follow the workflow's native-review instructions below. Conflicting inherited harness markers are not grounds to guess another provider.
- **\`not_authed\`** — installed but no credentials. Print: "Codex not authenticated; outside coverage unavailable. Run \`codex login\` or set \`$CODEX_API_KEY\`." ${nativeRoute}
- **\`broken_install\`** — the CLI is on PATH but cannot execute (spawn ENOENT, non-executable binary, missing vendor payload). Print: "Codex is installed but its binary cannot run — Codex passes skipped. Reinstall: \`npm install -g @openai/codex\`." Relay the probe's HINT lines. ${nativeRoute}
- **\`model_unusable\`** — the selected model (see \`CODEX_MODEL:\`) is invalid or unavailable to the account (HTTP 400 on every call). Relay the probe's HINT lines and the fix (\`GSTACK_CODEX_MODEL=<supported-model>\` or config.toml \`model\`); never substitute a model. ${nativeRoute} The ~10s round trip is cached for 1h.
- **\`quota_exhausted\`** — Codex usage/rate limit: relay its line verbatim (reset time), no more Codex calls. ${nativeRoute}
- **\`sandbox_unavailable\`** — Codex's sandbox cannot start here (containers without user namespaces); the probe printed the reason and fix. No paid call ran; outside coverage is unavailable. ${nativeRoute}
- **\`ready\`** or **\`unverified\`** — run the Codex pass below. \`unverified\` means the model check timed out; say so, and let the pass's own verdict decide.`;
}

/**
 * Canonical foreground-dispatch guidance (#497 → #2440 → a third recurrence at
 * a /ship documentation dispatch). Claude Code v2.1.198 made Agent-tool subagents run in the
 * BACKGROUND by default; a synchronous dispatch site must pass the flag
 * explicitly or the parent waits on output that never arrives. Rendered via
 * {{FOREGROUND_DISPATCH_NOTE}} in section templates; resolver sites may
 * interpolate it directly. Same name as the placeholder for grep-ability.
 */
/** The Claude Code release that flipped Agent-tool subagents to background-by-default (#497/#2440 class). Interpolated at every RESOLVER site; three templates carry the literal inline (autoplan/sections/ceo-phase, cso, design-shotgun) — grep 'Claude Code v2.1' when bumping. */
export const CC_BACKGROUND_DEFAULT_SINCE = 'Claude Code v2.1.198';

export const FOREGROUND_DISPATCH_NOTE =
  `**Foreground required:** pass \`run_in_background: false\` on the Agent call — subagents run in the background by default since ${CC_BACKGROUND_DEFAULT_SINCE}, so omitting the flag gives a background run. Dispatch through the Agent tool only: invoking the target as a Skill, or executing its workflow inline in your own context, forfeits the fresh-context isolation this dispatch exists for, even though the skill may appear in your available-skills list; the explicit flag already makes the Agent call block. (Where a step defines an inline fallback, it applies only after a dispatched subagent has failed.)`;
