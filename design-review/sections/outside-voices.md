<!-- AUTO-GENERATED from outside-voices.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Design Outside Voices (independent)

**Consent:** Outside voices run without a question when Codex is available and `codex_reviews` allows the send (unset means the default, enabled; the first send prints a one-time notice). `codex_reviews=disabled` runs only the native voice.

**Check Codex availability:**
```bash

if ! _OUTSIDE_CFG=$("$HOME/.claude/skills/gstack/bin/gstack-config" get --stored codex_reviews) || [ "$_OUTSIDE_CFG" = disabled ]; then
  echo 'CODEX_MODE: disabled'
elif ( # GSTACK_ACTIVE_HOST names the harness, never the model.
if { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
  echo 'Codex outside review unavailable: harness mismatch; no outside process started. Missing coverage.' >&2
  if { [ -n "${CLAUDECODE:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = claude ]; } && { [ -n "${CODEX_THREAD_ID:-}" ] || [ -n "${CODEX_SANDBOX:-}" ] || [ "${GSTACK_ACTIVE_HOST:-}" = codex ]; }; then
    echo 'Inherited harness markers conflict. Run setup --host <actual-harness> (claude or codex); do not guess a replacement provider.' >&2
  else
    echo 'Repair installed skills: run setup --host codex from your gstack checkout.' >&2
  fi
  exit 78
fi
); then
  if command -v codex >/dev/null 2>&1; then echo 'CODEX_MODE: ready'; else echo 'CODEX_MODE: not_installed'; fi
else
  echo 'CODEX_MODE: under_current_harness'
fi
```

The historical `CODEX_MODE` variable describes **Codex** availability here. `CODEX_MODE: disabled` or a send's `consent_missing` line: `codex_reviews` is off or unreadable; do not ask; record `outside_status: disabled`. Authentication and configured model validity are checked by the actual invocation, without overriding either. Missing/broken CLI: install or repair Codex; authentication failure: run `codex login`. Otherwise honor this caller’s opt-in/skip choice. Any non-ready outcome is missing outside coverage; follow the caller’s existing fallback. Never substitute another external provider.

Declined: skip both voices. `CODEX_MODE: disabled`: run only the native voice and record `outside_status: disabled`. Non-ready: retain the repair notice, use only the native voice, and record `outside_status: unavailable` even if it succeeds. The invocation rechecks the harness before spawning.

**When ready**, run both voices and await both before synthesis. Overlap calls
if supported; keep the native call blocking.

1. **Codex design voice** (via Bash):
Prompt (include the actual plan/product/frontend source context, not only file paths):

"Review the frontend source code in this repo. Evaluate against these design hard rules:
- Spacing: systematic (design tokens / CSS variables) or magic numbers?
- Typography: expressive purposeful fonts or default stacks?
- Color: CSS variables with defined system, or hardcoded hex scattered?
- Responsive: breakpoints defined? calc(100svh - header) for heroes? Mobile tested?
- A11y: ARIA landmarks, alt text, contrast ratios, 44px touch targets?
- Motion: one authored moment (an entrance or scroll-linked reveal, ease-out from a visible default) plus state transitions only where they carry information, or zero / ornamental only?
- Cards: used only when card IS the interaction? No decorative card grids?

First classify as MARKETING/LANDING PAGE vs APP UI vs HYBRID, then apply matching rules.

LITMUS CHECKS — answer YES/NO:
1. Brand/product unmistakable in first screen?
2. One strong visual anchor present?
3. Page understandable by scanning headlines only?
4. Each section has one job?
5. Are cards actually necessary?
6. Does motion improve hierarchy or atmosphere?
7. Would design feel premium with all decorative shadows removed?

HARD REJECTION — flag if ANY apply:
1. Generic SaaS card grid as first impression
2. Beautiful image with weak brand
3. Strong headline with no clear action
4. Busy imagery behind text
5. Sections repeating same mood statement
6. Carousel with no narrative purpose
7. App UI made of stacked cards instead of layout

Be specific. Reference file:line for every finding."

Write the **complete prompt and context**, including actual plan/spec/source, to a private file. Substitute its shell-quoted path for `<prepared-prompt-file>`; never interpolate user text into shell source. Request severity (Critical, High, Medium or Low) per finding, a Recommendation: <action> because <reason> line, and `VERDICT: CLEAN` or `VERDICT: FINDINGS` as the last line.

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
_CODEX_PROBE="$HOME/.claude/skills/gstack/bin/gstack-codex-probe"
_CODEX_OUT=$("$_CODEX_PROBE" select-model exec) || exit 1
_CODEX_SEL=$(echo "$_CODEX_OUT" | sed -n 's/^CODEX_SEL: //p')
_CODEX_SANDBOX_MODE=$(echo "$_CODEX_OUT" | sed -n 's/^CODEX_SANDBOX: //p')
"$_CODEX_PROBE" check-sandbox || exit 1
"$_CODEX_PROBE" show-first-use-notice
_OUTSIDE_EXIT=0
"$_CODEX_PROBE" run-with-timeout --effort high 300 codex exec - -C "$_REPO_ROOT" -s "${_CODEX_SANDBOX_MODE:?}" -c "model=\"${_CODEX_SEL:?}\"" -c skills.include_instructions=false -c 'web_search="cached"' --json -o "$_OUTSIDE_TMP/text" <"$_OUTSIDE_INPUT" >"$_OUTSIDE_TMP/events" 2>"$_OUTSIDE_TMP/stderr" || _OUTSIDE_EXIT=$?
cat "$_OUTSIDE_TMP/text" 2>/dev/null || tail -n 20 "$_OUTSIDE_TMP/events"

cat "$_OUTSIDE_TMP/stderr" >&2 || { [ "$_OUTSIDE_EXIT" -ne 0 ] || _OUTSIDE_EXIT=1; }
_OUTSIDE_RC=0
bun --no-env-file --config=/dev/null "$HOME/.claude/skills/gstack/lib/outside-review-result.ts" --label 'Codex outside review' --exit "$_OUTSIDE_EXIT" --stderr "$_OUTSIDE_TMP/stderr" --events "$_OUTSIDE_TMP/events" review "$_OUTSIDE_TMP/text" || _OUTSIDE_RC=$?
case "$_OUTSIDE_RC" in
  0|3) ;;
  4) echo 'OUTSIDE_STATUS: unverified provider=codex host=claude'; exit 4 ;;
  *) [ "$_OUTSIDE_EXIT" -ne 0 ] && exit "$_OUTSIDE_EXIT"; exit 1 ;;
esac
echo 'OUTSIDE_STATUS: completed provider=codex host=claude'
```

Use Bash `timeout: 360000`; show the full response in a `tool-output` fence. Require successful execution and valid markers. Refusal, empty/malformed output, missing score/severity/completion markers, timeout or CLI failure means `outside_status: unavailable`. P0/P1 findings block like native ones; `OUTSIDE_STATUS: unverified` is missing coverage. Use the caller's fallback; missing coverage is never clean/PASS. After either outcome, delete only your private prompt; scratch cleanup is automatic.

2. **Claude design subagent** (Agent tool, `run_in_background: false` when available; await its result. A launch receipt means it went background: await its completion notice.):
"Review the frontend source code in this repo. You are an independent senior product designer doing a source-code design audit. Focus on CONSISTENCY PATTERNS across files rather than individual violations:
- Are spacing values systematic across the codebase?
- Is there ONE color system or scattered approaches?
- Do responsive breakpoints follow a consistent set?
- Is the accessibility approach consistent or spotty?

For each finding: what's wrong, severity (critical/high/medium), and the file:line."

**Error handling (all non-blocking):**
- **Auth failure:** If stderr contains "auth", "login", "unauthorized", or "API key": "Codex authentication failed. Run `codex login` to authenticate."
- **Timeout:** "Codex timed out after 5 minutes."
- **Empty response:** "Codex returned no response."
- On any Codex error: proceed with Claude subagent output only, tagged `[single-model]`.
- If Claude subagent also fails: "Outside voices unavailable — continuing with primary review."

Output headers: `CODEX SAYS (design source audit):` and `CLAUDE SUBAGENT (design consistency):`.

**Synthesis — Litmus scorecard:**

Use the same scorecard format as /plan-design-review (shown above). Fill in from both outputs.
Merge findings into the triage with `[codex]` / `[subagent]` / `[cross-model]` tags.

**Log the result:**
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"design-outside-voices","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"STATUS","source":"SOURCE","host":"claude","outside_provider":"codex","outside_status":"OUTSIDE_STATUS","phase":"design","commit":"'"$(git rev-parse --short HEAD)"'"}'
```
STATUS="clean" requires a completed review with no findings; use "issues_found" for findings, "unavailable" if neither completed. SOURCE is the completed provider or in-host.

Retain the historical review-log skill ID; add `"host":"claude","outside_provider":"codex","outside_status":"completed|unavailable|disabled|skipped","phase":"design"`. Record differing attempt outcomes separately. `source:"codex"` requires completed CLI output; native uses `source:"in-host"` (historical `source:"claude"`: native Claude). Availability/native fallback is not outside completion. Preserve all reported modelUsage; unknown model identity stays unknown. Under `GSTACK_CODEX_NO_SANDBOX=1` add `"codex_sandbox":"danger-full-access"`.
