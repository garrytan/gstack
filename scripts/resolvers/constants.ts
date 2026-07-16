// ─── Shared Design Constants ────────────────────────────────

/**
 * gstack's AI slop anti-patterns — shared between DESIGN_METHODOLOGY and DESIGN_HARD_RULES.
 *
 * Overused fonts worth calling out in templates (not a pattern to blacklist, but a
 * convergence risk): Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat,
 * Poppins, and increasingly Space Grotesk. Every AI design tool picks one of these.
 * Design prompts should bias toward less-common display faces.
 */
export const AI_SLOP_BLACKLIST = [
  'Purple/violet/indigo gradient backgrounds or blue-to-purple color schemes',
  '**The 3-column feature grid:** icon-in-colored-circle + bold title + 2-line description, repeated 3x symmetrically. THE most recognizable AI layout.',
  'Icons in colored circles as section decoration (SaaS starter template look)',
  'Centered everything (`text-align: center` on all headings, descriptions, cards)',
  'Uniform bubbly border-radius on every element (same large radius on everything)',
  'Decorative blobs, floating circles, wavy SVG dividers (if a section feels empty, it needs better content, not decoration)',
  'Emoji as design elements (rockets in headings, emoji as bullet points)',
  'Colored left-border on cards (`border-left: 3px solid <accent>`)',
  'Generic hero copy ("Welcome to [X]", "Unlock the power of...", "Your all-in-one solution for...")',
  'Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA, every section same height)',
  'system-ui or `-apple-system` as the PRIMARY display/body font — the "I gave up on typography" signal. Pick a real typeface.',
];

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
 *   2. sources `gstack-codex-probe`,
 *   3. runs `command -v codex` (literal — keeps the e2e substring assertion),
 *      then `_gstack_codex_auth_probe`, then `_gstack_codex_version_check`,
 *   4. logs the relevant `_gstack_codex_log_event` for each non-ready outcome,
 *   5. sets ONE canonical mode var and echoes `CODEX_MODE: <mode>` so the agent
 *      gates later blocks on the echoed value.
 *
 * Mode values: `disabled` (config off) | `not_installed` | `not_authed` | `ready`.
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
export function codexPreflight(opts: { modeVar?: string; disabledBehavior: 'skip-all' | 'codex-only' }): string {
  const m = opts.modeVar ?? '_CODEX_MODE';
  const disabledLine = opts.disabledBehavior === 'codex-only'
    ? 'Skip the Codex passes only; the Claude adversarial subagent below STILL runs (it is free and fast). Print: "Codex passes skipped (codex_reviews disabled) — running Claude adversarial only."'
    : 'Skip this section entirely; do NOT fall back to a Claude subagent — disabled means no extra review step. Print: "Codex review skipped (codex_reviews disabled). Re-enable: `gstack-config set codex_reviews enabled`."';
  return `\`\`\`bash
# Codex preflight: one block (functions sourced here don't persist to later blocks).
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || echo off)
_CODEX_CFG=$(~/.claude/skills/gstack/bin/gstack-config get codex_reviews 2>/dev/null || echo enabled)
source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
if [ "$_CODEX_CFG" = "disabled" ]; then
  ${m}="disabled"
elif ! command -v codex >/dev/null 2>&1; then
  ${m}="not_installed"; _gstack_codex_log_event "codex_cli_missing" 2>/dev/null || true
elif ! _gstack_codex_auth_probe >/dev/null 2>&1; then
  ${m}="not_authed"; _gstack_codex_log_event "codex_auth_failed" 2>/dev/null || true
else
  ${m}="ready"; _gstack_codex_version_check 2>/dev/null || true
fi
echo "CODEX_MODE: $${m}"
\`\`\`

Branch on the echoed \`CODEX_MODE\`:
- **\`disabled\`** — the user turned Codex reviews off (\`codex_reviews=disabled\`). ${disabledLine}
- **\`not_installed\`** — Codex CLI absent. Print: "Codex not installed — using Claude subagent. Install for cross-model coverage: \`npm install -g @openai/codex\`." Fall back to the Claude subagent path.
- **\`not_authed\`** — installed but no credentials. Print: "Codex installed but not authenticated — using Claude subagent. Run \`codex login\` or set \`$CODEX_API_KEY\`." Fall back to the Claude subagent path.
- **\`ready\`** — run the Codex pass below.`;
}
