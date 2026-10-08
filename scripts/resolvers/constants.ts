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
 * Historical no-role Codex default and the pinned eval ruler some tests import.
 * It does not follow the role catalog in lib/model-catalog.ts: plan-review
 * calls resolve their model through lib/model-policy.ts at invocation time.
 *
 * A no-role runtime model is resolved per invocation kind by
 * `gstack-codex-probe select-model exec|review` (backed by
 * resolveCodexRuntimeModel in scripts/resolve-codex-generation-model.ts):
 * explicit request (`--model`), then GSTACK_CODEX_MODEL, then Codex config.toml
 * (`model`; `review_model` first for native review; honors CODEX_HOME), then this
 * default (#2914). The selection is printed before the first paid call and the
 * probe checks the same record the flags below pass.
 */
export const CODEX_FRONTIER_MODEL = 'gpt-6-astra';
/**
 * Nested gstack Codex calls are one-shot reviews: keep installed skills (gstack's
 * own included) out of the model's context so the reviewer cannot re-run a whole
 * skill workflow inside its budget (#2847). Read-only sandboxes do not prevent this.
 */
export const CODEX_SKILLS_ISOLATION_FLAG = '-c skills.include_instructions=false';
/** Captured from `select-model` by codexSelect(); `:?` stops an unselected command. */
const SELECTED_MODEL = '${_CODEX_SEL:?}';
/** The sandbox codexSelect() captured; read-only unless GSTACK_CODEX_NO_SANDBOX=1. */
export const CODEX_SANDBOX_REF = '${_CODEX_SANDBOX_MODE:?}';
/** Requires codexSelect('exec') earlier in the same block. */
export const CODEX_MODEL_CONFIG_FLAG = `-c "model=\\"${SELECTED_MODEL}\\"" ${CODEX_SKILLS_ISOLATION_FLAG}`;
/** Requires codexSelect('review'); native review prefers review_model, so both carry the selection. */
export const CODEX_REVIEW_MODEL_CONFIG_FLAG = `-c "review_model=\\"${SELECTED_MODEL}\\"" ${CODEX_MODEL_CONFIG_FLAG}`;
/** The executed probe; pathRewrites map the Claude path per host. */
export const CODEX_PROBE_PATH = '~/.claude/skills/gstack/bin/gstack-codex-probe';

/**
 * Runs `gstack-codex-probe select-model` and captures its KEY: value lines into
 * `_CODEX_SEL` and `_CODEX_SANDBOX_MODE` for CODEX_MODEL_CONFIG_FLAG and
 * CODEX_SANDBOX_REF. The probe is executed, never sourced, so no shell state
 * crosses from the helper and the calling shell does not matter.
 *
 * With `role`, `role-ready` supplies the plan-review record instead: one
 * selection, auth, sandbox and model probe. It and the block's later
 * `run-with-timeout <budgetSecs>` dispatch share one exported deadline, so
 * readiness time is charged to the review instead of extending it. `optional`
 * (manual /codex) keeps select-model unless the agent sets `_CODEX_ROLE`.
 */
export function codexSelect(kind: 'exec' | 'review', probe: string = CODEX_PROBE_PATH, role?: { budgetSecs: number; optional?: boolean }): string {
  const select = `_CODEX_OUT=$("$_CODEX_PROBE" select-model ${kind}) || exit 1`;
  const ready = `export _CODEX_DEADLINE=$(($(date +%s)+${role?.budgetSecs})); _CODEX_OUT=$("$_CODEX_PROBE" role-ready ${kind}) || exit $?`;
  return `_CODEX_PROBE=${probe}
${!role ? select : role.optional ? `_CODEX_ROLE=''\nif [ -n "$_CODEX_ROLE" ]; then ${ready}\nelse ${select}; fi` : ready}
_CODEX_SEL=$(echo "$_CODEX_OUT" | sed -n 's/^CODEX_SEL: //p')
_CODEX_SANDBOX_MODE=$(echo "$_CODEX_OUT" | sed -n 's/^CODEX_SANDBOX: //p')`;
}

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
 * Emits ONE self-contained bash block that runs `gstack-codex-probe` as a
 * command (one subcommand per check), so it works from bash, zsh or sh and
 * nothing it learns persists to later blocks except the echoed mode. It:
 *   1. reads the `codex_reviews` master switch,
 *   2. checks that the probe is installed and executable
 *      (`CODEX_MODE: helper_unavailable` with the fix otherwise),
 *   3. runs `command -v codex` (literal — keeps the e2e substring assertion),
 *      then `check-auth`, `check-sandbox`, `probe-model` and `check-version`,
 *   4. logs the relevant `log-event` for each non-ready outcome,
 *   5. sets ONE canonical mode var and echoes `CODEX_MODE: <mode>` so the agent
 *      gates later blocks on the echoed value.
 *
 * Mode values: `disabled` (config off) | `helper_unavailable` (the probe is
 * missing or not executable) | `not_installed` | `not_authed` |
 * `broken_install` | `sandbox_unavailable` | `model_unusable` | `quota_exhausted` |
 * `unverified` (echoed as `unverified (rate_limited)` after a probe-time 429) | `ready`.
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
export function codexPreflight(opts: { modeVar?: string; disabledBehavior: 'skip-all' | 'codex-only'; nativeReview?: boolean; role?: boolean }): string {
  const m = opts.modeVar ?? '_CODEX_MODE';
  const disabledLine = opts.disabledBehavior === 'codex-only'
    ? 'Skip the Codex passes only; the Claude adversarial subagent below STILL runs (it is free and fast). Print: "Codex passes skipped (codex_reviews disabled) — running Claude adversarial only."'
    : 'Skip this section entirely; do NOT fall back to a Claude subagent — disabled means no extra review step. Print: "Codex review skipped (codex_reviews disabled). Re-enable: `gstack-config set codex_reviews enabled`."';
  const nativeRoute = opts.disabledBehavior === 'codex-only'
    ? 'Keep the required Claude adversarial pass; do not dispatch a duplicate.'
    : 'Fall back to the Claude subagent path.';
  return `\`\`\`bash
# Codex preflight: the probe runs as a command, so any shell works.
_CODEX_PROBE=${CODEX_PROBE_PATH}
_CODEX_CFG=$(~/.claude/skills/gstack/bin/gstack-config get codex_reviews 2>/dev/null || echo enabled)
_gstack_helper_error=""
[ -x "$_CODEX_PROBE" ] || _gstack_helper_error="gstack: cannot load gstack-codex-probe; re-run ./setup. https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#sourced-helper-location"
if [ "$_CODEX_CFG" = "disabled" ]; then
  ${m}="disabled"
elif { [ -n "\${CODEX_THREAD_ID:-}" ] || [ -n "\${CODEX_SANDBOX:-}" ] || [ "\${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
  ${m}="under_codex"
elif ! command -v codex >/dev/null 2>&1; then
  ${m}="not_installed"; "$_CODEX_PROBE" log-event codex_cli_missing 2>/dev/null || true
elif [ -n "$_gstack_helper_error" ]; then
  ${m}="helper_unavailable"; echo "$_gstack_helper_error"
elif ! "$_CODEX_PROBE" check-auth >/dev/null 2>&1; then
  ${m}="not_authed"; "$_CODEX_PROBE" log-event codex_auth_failed 2>/dev/null || true
else${opts.role ? '' : `
  # Free sandbox check before the paid probe; probe exit 2 = the CLI cannot run.`}
  _CODEX_MP=0${opts.role ? '' : '; _CODEX_PS=""'}
  "$_CODEX_PROBE" check-sandbox || _CODEX_MP=3${opts.role ? `
  if [ "$_CODEX_MP" -eq 3 ]; then
    ${m}="sandbox_unavailable"` : `
  for _CODEX_KIND in exec${opts.nativeReview ? ' review' : ''}; do
    [ "$_CODEX_MP" -eq 0 ] || break
    _CODEX_PO=$("$_CODEX_PROBE" probe-model $_CODEX_KIND); _CODEX_MP=$?; printf '%s\\n' "$_CODEX_PO"
    case "$_CODEX_PO" in *"STATE: inconclusive"*) _CODEX_PS=inconclusive ;; *"STATE: rate_limited"*) _CODEX_PS=rate_limited ;; esac
  done
  if [ "$_CODEX_MP" -eq 3 ]; then
    ${m}="sandbox_unavailable"
  elif [ "$_CODEX_MP" -eq 2 ]; then
    ${m}="broken_install"
  elif [ "$_CODEX_MP" -eq 4 ]; then
    ${m}="quota_exhausted"
  elif [ "$_CODEX_MP" -ne 0 ]; then
    ${m}="model_unusable"
  elif [ "$_CODEX_PS" = inconclusive ]; then
    ${m}="unverified"
  elif [ "$_CODEX_PS" = rate_limited ]; then
    ${m}="unverified (rate_limited)"`}
  else
    ${m}="ready"; "$_CODEX_PROBE" check-version || true
  fi
fi
echo "CODEX_MODE: $${m}"
\`\`\`

Branch on the echoed \`CODEX_MODE\`:
- **\`disabled\`** — the user turned Codex reviews off (\`codex_reviews=disabled\`). ${disabledLine}
- **\`helper_unavailable\`** — the probe is missing or not executable; relay the line above (cause and fix). ${nativeRoute}
- **\`not_installed\`** — Codex CLI absent. Print: "Codex not installed; outside coverage unavailable. Install: \`npm install -g @openai/codex\`." ${nativeRoute}
- **\`under_codex\`** — stale artifact selected its own harness. Print: "Codex outside review unavailable: harness mismatch; no outside process started. Missing coverage. Repair: setup --host codex." Skip the outside invocation and follow the workflow's native-review instructions below. Conflicting inherited harness markers are not grounds to guess another provider.
- **\`not_authed\`** — installed but no credentials. Print: "Codex not authenticated; outside coverage unavailable. Run \`codex login\` or set \`$CODEX_API_KEY\`." ${nativeRoute}
- **\`broken_install\`** — the CLI is on PATH but cannot execute (spawn ENOENT, non-executable binary, missing vendor payload). Print: "Codex is installed but its binary cannot run — Codex passes skipped. Reinstall: \`npm install -g @openai/codex\`." Relay the probe's HINT lines. ${nativeRoute}
- **\`model_unusable\`** — the selected model (see \`CODEX_MODEL:\`) is invalid or unavailable to the account (HTTP 400 on every call). Relay the probe's HINT lines and the fix (\`GSTACK_CODEX_MODEL=<supported-model>\` or config.toml \`model\`); never substitute a model. ${nativeRoute} The ~10s round trip is cached for 1h.
- **\`quota_exhausted\`** — Codex usage limit: relay the probe's lines verbatim (reset time, retry); no more Codex calls this run. ${nativeRoute}
- **\`sandbox_unavailable\`** — Codex's sandbox cannot start here (containers without user namespaces); the probe printed the reason and fix. No paid call ran; outside coverage is unavailable. ${nativeRoute}
- **\`ready\`** or **\`unverified\`** — run the Codex pass below. \`unverified\` means the model check timed out or, with \`(rate_limited)\`, hit a 429; say so, and let the pass's own verdict decide.${opts.role ? `
Plan-review role: the invocation probes the [policy](https://github.com/garrytan/gstack/blob/main/docs/model-policy.md) model; its exit 1, 2 or 4 is \`model_unusable\`, \`broken_install\` or \`quota_exhausted\`.` : ''}`;
}

/**
 * Canonical foreground-dispatch guidance (#497 → #2440 → a third recurrence at
 * a /ship documentation dispatch). Claude Code v2.1.198 made Agent-tool subagents run in the
 * BACKGROUND by default; a synchronous dispatch site must pass the flag
 * explicitly or the parent waits on output that never arrives. Rendered via
 * {{FOREGROUND_DISPATCH_NOTE}} in section templates; resolver sites may
 * interpolate it directly. Same name as the placeholder for grep-ability.
 */
/** The Claude Code release that flipped Agent-tool subagents to background-by-default (#497/#2440 class). Interpolated at every RESOLVER site — grep 'Claude Code v2.1' when bumping. */
export const CC_BACKGROUND_DEFAULT_SINCE = 'Claude Code v2.1.198';
/** Claude Code's fork-subagent schema has no run_in_background, so every foreground request is conditional (CEO-20). */
export const FOREGROUND_IF_AVAILABLE = '`run_in_background: false` when available';
/** The recovery when a requested foreground dispatch still ran in the background. */
export const BACKGROUND_RECOVERY = 'A launch receipt means it went background: await its completion notice.';

export const FOREGROUND_DISPATCH_NOTE =
  `**Foreground required:** pass ${FOREGROUND_IF_AVAILABLE} on the Agent call — subagents run in the background by default since ${CC_BACKGROUND_DEFAULT_SINCE}, so omitting an available flag gives a background run. ${BACKGROUND_RECOVERY} Dispatch through the Agent tool only: invoking the target as a Skill, or executing its workflow inline in your own context, forfeits the fresh-context isolation this dispatch exists for, even though the skill may appear in your available-skills list. (Where a step defines an inline fallback, it applies only after a dispatched subagent has failed.)`;
