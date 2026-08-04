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

/**
 * Phase-aware outside-voice preflight.
 *
 * codexPreflight()'s four states — `disabled | not_installed | not_authed | ready`,
 * echoed as `CODEX_MODE:` so every existing downstream branch still applies — plus a
 * FIFTH, `misconfigured`, which has no analogue there because codexPreflight() has no
 * backend to misname. The backend is resolved per review PHASE from config
 * (`outside_voice_loop` / `outside_voice_gate`) instead of being hardcoded to Codex.
 *
 * Why this is a separate export rather than a parameter on codexPreflight():
 * codexPreflight()'s output is asserted byte-for-byte by golden fixtures and e2e
 * substring checks. Leaving it untouched means adopting tiering is opt-in per call
 * site, and a skill that has not been migrated keeps behaving exactly as it did.
 *
 * The heavy lifting lives in `bin/gstack-outside-voice probe`, so backend detection
 * exists in exactly one place (shell), not duplicated between shell and TypeScript.
 * The codex version-check side effect is preserved for the codex backend only —
 * it is meaningless for a hosted API backend.
 *
 * `phase`:
 *   - `loop`       — the iterative fix-verify loop (many rounds; the cheap tier).
 *   - `final_gate` — the converged-artefact gate (frontier; repo access).
 */
export function outsideVoicePreflight(opts: {
  phase: 'loop' | 'final_gate';
  modeVar?: string;
  disabledBehavior: 'skip-all' | 'codex-only';
}): string {
  const m = opts.modeVar ?? '_CODEX_MODE';
  const disabledLine = opts.disabledBehavior === 'codex-only'
    ? 'Skip the outside-voice passes only; the Claude adversarial subagent below STILL runs (it is free and fast). Print: "Outside-voice passes skipped (disabled) — running Claude adversarial only."'
    // `disabled` arrives from TWO switches — the master `codex_reviews` and this phase's own
    // `outside_voice_*` — and probe cannot distinguish them, by design. Naming only the master
    // sends a user whose PHASE is off to flip a key that changes nothing, and leaves them
    // believing the feature is broken rather than configured. Reported in round 7 of this
    // build and misfiled as a false positive, because the search was scoped to codex/SKILL.md
    // while the text lives here.
    : `Skip this section entirely; do NOT fall back to a Claude subagent — disabled means no extra review step. Print: "Outside-voice review skipped (disabled). Two switches produce this state: re-enable the master with \`gstack-config set codex_reviews enabled\`, or this phase with \`gstack-config set outside_voice_${opts.phase === 'loop' ? 'loop' : 'gate'} codex\`."`;
  return `\`\`\`bash
# Outside-voice preflight for the "${opts.phase}" phase: one block (functions sourced here don't persist).
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || echo off)
# stderr is NOT suppressed here. \`backend\` warns when the configured value is unrecognised —
# a typo silently rerouting the cheap loop to the expensive backend — and an earlier version
# of this line sent that warning to /dev/null, so the guard existed and nobody could ever see
# it fire. Hardening one layer while the layer that reports it stays quiet just relocates the
# silence.
_OV_BACKEND=$(~/.claude/skills/gstack/bin/gstack-outside-voice backend --phase ${opts.phase} || echo codex)
# A non-zero exit means the PROBE failed, not that the backend is absent. Reporting it as
# \`not_installed\` is a diagnosis rather than a fallback: an unreadable ~/.gstack/config.yaml or a
# broken helper sent the user to install a client that was already installed, while the real
# error went to /dev/null. Probe reports its states on stdout and exits 0, so keep the failure
# as its own state and keep the stderr that explains it.
# Honour the RESOLVED temp root. Step 0.2 resolves $TMP_ROOT through gstack-paths precisely
# so a read-only or absent /tmp still works, and this line — added two rounds ago — then
# hard-coded /tmp again, so the probe would abort before it could report the very
# not_installed / not_authed fallback it exists to produce (no backticks in this comment:
# it lives inside a TS template literal, where a backtick ENDS the string). TMPDIR then
# /tmp remain as fallbacks because this preflight also renders into skills that never
# resolved TMP_ROOT.
_OV_PROBE_ERR=$(mktemp "\${TMP_ROOT:-\${TMPDIR:-/tmp}}/gstack-probe-err-XXXXXX")
${m}=$(~/.claude/skills/gstack/bin/gstack-outside-voice probe --phase ${opts.phase} 2>"$_OV_PROBE_ERR") || ${m}=probe_failed
[ "$${m}" = probe_failed ] && { echo "PROBE FAILED — its own stderr follows:"; cat "$_OV_PROBE_ERR"; }
rm -f "$_OV_PROBE_ERR"
# Version-check only applies to the codex backend; a hosted API has no local CLI.
if [ "$_OV_BACKEND" = "codex" ] && [ "$${m}" = "ready" ]; then
  source ~/.claude/skills/gstack/bin/gstack-codex-probe 2>/dev/null || true
  _gstack_codex_version_check 2>/dev/null || true
fi
echo "OUTSIDE_VOICE_BACKEND: $_OV_BACKEND"
echo "CODEX_MODE: $${m}"
\`\`\`

Branch on the echoed \`CODEX_MODE\` (the backend named by \`OUTSIDE_VOICE_BACKEND\` is what will actually run):
- **\`disabled\`** — outside-voice review is off for this phase. ${disabledLine}
- **\`not_installed\`** — the backend's client is absent (Codex CLI missing, or \`python3\` missing for a hosted backend — that is the program which actually issues the request; an earlier version probed \`curl\`, which is a different program and reported ready on a box that could not run the call). Print: "Outside voice not available for the ${opts.phase} phase — using Claude subagent." Fall back to the Claude subagent path.
- **\`not_authed\`** — the backend is selected but has no credentials. For \`codex\`: run \`codex login\` or set \`$CODEX_API_KEY\`. For \`openrouter\`: set \`$OPENROUTER_API_KEY\`. **Do NOT silently reroute to the other backend** — a phase configured for the cheap tier must never quietly bill the frontier one, and a gate configured for frontier must never quietly downgrade. Print the cause and fall back to the Claude subagent path.
- **\`misconfigured\`** — \`outside_voice_${opts.phase === 'loop' ? 'loop' : 'gate'}\` holds a value that is not \`codex\`, \`openrouter\` or \`disabled\`. **Do NOT treat this as \`disabled\` and do NOT pick a backend for the user.** "Off on purpose" and "off because of a typo" want opposite responses, and guessing either bills the frontier price for every loop round or quietly weakens the gate. Print: "Outside voice is misconfigured for the ${opts.phase} phase — fix \`outside_voice_${opts.phase === 'loop' ? 'loop' : 'gate'}\` in ~/.gstack/config.yaml." Fall back to the Claude subagent path. (\`exec\` refuses this state outright with exit 2.)
- **\`probe_failed\`** — the readiness probe itself exited non-zero, so the backend's state is **unknown**, not bad. Its stderr was printed above; the likeliest causes are an unreadable \`~/.gstack/config.yaml\` or a broken \`gstack-outside-voice\` install. **Do NOT read this as \`not_installed\`** — that sends the user to reinstall a client that is already there. Print the cause and fall back to the Claude subagent path.
- **\`ready\`** — run the outside-voice pass below via \`gstack-outside-voice exec --phase ${opts.phase}\`.`;
}
