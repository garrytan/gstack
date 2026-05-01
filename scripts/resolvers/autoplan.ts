import type { TemplateContext } from './types';

type Phase = 'ceo' | 'design' | 'eng' | 'dx';

const CLAUDE_JSON_PARSE_SNIPPET = String.raw`python3 - "$CLAUDE_RESP_FILE" <<'PY'
import json, sys
path = sys.argv[1]
try:
    obj = json.load(open(path))
except Exception as exc:
    print(f"CLAUDE_JSON_PARSE_ERROR: {exc}")
    sys.exit(0)

if obj.get("is_error"):
    print("CLAUDE_ERROR: true")

result = obj.get("result") or obj.get("response") or ""
if result:
    print(result)

usage = obj.get("usage") or {}
input_tokens = usage.get("input_tokens", 0) or 0
output_tokens = usage.get("output_tokens", 0) or 0
cache_read = usage.get("cache_read_input_tokens", 0) or 0
model = obj.get("model") or "unknown"
session_id = obj.get("session_id") or ""

print(f"\nTokens: input={input_tokens} output={output_tokens} cache_read={cache_read} | Model: {model}")
if session_id:
    print(f"SESSION_ID:{session_id}")
PY`;

const PHASE_PROMPTS: Record<Phase, { codex: string; claude: string; tmpPrefix: string }> = {
  ceo: {
    tmpPrefix: 'ceo',
    codex: `IMPORTANT: Do NOT read or execute any SKILL.md files or files in skill definition directories (paths containing skills/gstack). These are AI assistant skill definitions meant for a different system. Stay focused on repository code only.

You are a CEO/founder advisor reviewing a development plan.
Challenge the strategic foundations: Are the premises valid or assumed? Is this the
right problem to solve, or is there a reframing that would be 10x more impactful?
What alternatives were dismissed too quickly? What competitive or market risks are
unaddressed? What scope decisions will look foolish in 6 months? Be adversarial.
No compliments. Just the strategic blind spots.
File: <plan_path>`,
    claude: `Read the plan file at <plan_path>. You are an independent CEO/founder advisor
reviewing a development plan. Challenge the strategic foundations:
1. Are the premises valid or assumed?
2. Is this the right problem to solve, or is there a reframing that would be 10x more impactful?
3. What alternatives were dismissed too quickly?
4. What competitive or market risks are unaddressed?
5. What scope decisions will look foolish in 6 months?
Be adversarial. No compliments. Just the strategic blind spots.
You may use read-only file tools (Read, Grep, Glob). Do NOT modify files or run commands.`,
  },
  design: {
    tmpPrefix: 'design',
    codex: `IMPORTANT: Do NOT read or execute any SKILL.md files or files in skill definition directories (paths containing skills/gstack). These are AI assistant skill definitions meant for a different system. Stay focused on repository code only.

Read the plan file at <plan_path>. Evaluate this plan's
UI/UX design decisions.

Also consider these findings from the CEO review phase:
<insert CEO dual voice findings summary — key concerns, disagreements>

Does the information hierarchy serve the user or the developer? Are interaction
states (loading, empty, error, partial) specified or left to the implementer's
imagination? Is the responsive strategy intentional or afterthought? Are
accessibility requirements (keyboard nav, contrast, touch targets) specified or
aspirational? Does the plan describe specific UI decisions or generic patterns?
What design decisions will haunt the implementer if left ambiguous?
Be opinionated. No hedging.`,
    claude: `Read the plan file at <plan_path>. You are an independent senior product designer
reviewing this plan's UI/UX design decisions.

Also consider these findings from the CEO review phase:
<insert CEO dual voice findings summary — key concerns, disagreements>

Evaluate:
1. Does the information hierarchy serve the user or the developer?
2. Which interaction states (loading, empty, error, partial) are unspecified?
3. Is the responsive strategy intentional or an afterthought?
4. Are accessibility requirements concrete or aspirational?
5. What design decisions will haunt the implementer if left ambiguous?
Be opinionated. No hedging.
You may use read-only file tools (Read, Grep, Glob). Do NOT modify files or run commands.`,
  },
  eng: {
    tmpPrefix: 'eng',
    codex: `IMPORTANT: Do NOT read or execute any SKILL.md files or files in skill definition directories (paths containing skills/gstack). These are AI assistant skill definitions meant for a different system. Stay focused on repository code only.

Review this plan for architectural issues, missing edge cases,
and hidden complexity. Be adversarial.

Also consider these findings from prior review phases:
CEO: <insert CEO consensus table summary — key concerns, DISAGREEs>
Design: <insert Design consensus table summary, or 'skipped, no UI scope'>

File: <plan_path>`,
    claude: `Read the plan file at <plan_path>. You are an independent senior engineer
reviewing this plan for architectural issues, missing edge cases, and hidden complexity.

Also consider these findings from prior review phases:
CEO: <insert CEO consensus table summary — key concerns, DISAGREEs>
Design: <insert Design consensus table summary, or 'skipped, no UI scope'>

Evaluate:
1. Architecture: Is the component structure sound? Coupling concerns?
2. Edge cases: What breaks under 10x load? What's the nil/empty/error path?
3. Tests: What's missing from the test plan? What would break at 2am Friday?
4. Security: New attack surface? Auth boundaries? Input validation?
5. Hidden complexity: What looks simple but isn't?
Be adversarial.
You may use read-only file tools (Read, Grep, Glob). Do NOT modify files or run commands.`,
  },
  dx: {
    tmpPrefix: 'dx',
    codex: `IMPORTANT: Do NOT read or execute any SKILL.md files or files in skill definition directories (paths containing skills/gstack). These are AI assistant skill definitions meant for a different system. Stay focused on repository code only.

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
Be adversarial. Think like a developer who is evaluating this against 3 competitors.`,
    claude: `Read the plan file at <plan_path>. You are an independent DX engineer
reviewing this plan's developer experience.

Also consider these findings from prior review phases:
CEO: <insert CEO consensus summary>
Eng: <insert Eng consensus summary>

Evaluate:
1. Getting started: how many steps from zero to hello world? What's the TTHW?
2. API/CLI ergonomics: naming consistency, sensible defaults, progressive disclosure?
3. Error handling: does every error path specify problem + cause + fix + docs link?
4. Documentation: copy-paste examples? Information architecture? Interactive elements?
5. Escape hatches: can developers override every opinionated default?
Be adversarial.
You may use read-only file tools (Read, Grep, Glob). Do NOT modify files or run commands.`,
  },
};

function codexOutsideVoiceBlock(ctx: TemplateContext, phase: Phase): string {
  const prompt = PHASE_PROMPTS[phase].codex;
  return `  **Codex outside voice** (via Bash):
  \`\`\`bash
  _REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
  _gstack_codex_timeout_wrapper 600 codex exec "${prompt}" -C "$_REPO_ROOT" -s read-only --enable web_search_cached < /dev/null
  _CODEX_EXIT=$?
  if [ "$_CODEX_EXIT" = "124" ]; then
    _gstack_codex_log_event "codex_timeout" "600"
    _gstack_codex_log_hang "autoplan" "0"
    echo "[outside voice stalled past 10 minutes — tagging as [outside-voice-unavailable] for this phase and proceeding with subagent only]"
  fi
  \`\`\`
  Timeout: 10 minutes (shell-wrapper) + 12 minutes (Bash outer gate). On hang, auto-degrades this phase's outside voice.`;
}

function claudeOutsideVoiceBlock(phase: Phase): string {
  const meta = PHASE_PROMPTS[phase];
  return `  **Claude outside voice** (via Bash):
  \`\`\`bash
  _REPO_ROOT=$(git rev-parse --show-toplevel) || { echo "ERROR: not in a git repo" >&2; exit 1; }
  cd "$_REPO_ROOT"
  CLAUDE_PROMPT_FILE=$(mktemp /tmp/gstack-autoplan-claude-${meta.tmpPrefix}-XXXXXXXX.txt)
  CLAUDE_RESP_FILE=$(mktemp /tmp/gstack-autoplan-claude-${meta.tmpPrefix}-XXXXXXXX.json)
  CLAUDE_ERR_FILE=$(mktemp /tmp/gstack-autoplan-claude-${meta.tmpPrefix}-XXXXXXXX.txt)
  cat > "$CLAUDE_PROMPT_FILE" <<'EOF'
${meta.claude}
EOF
  cat "$CLAUDE_PROMPT_FILE" | claude -p --output-format json --disable-slash-commands --allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write > "$CLAUDE_RESP_FILE" 2>"$CLAUDE_ERR_FILE"
  ${CLAUDE_JSON_PARSE_SNIPPET}
  cat "$CLAUDE_ERR_FILE"
  rm -f "$CLAUDE_PROMPT_FILE" "$CLAUDE_RESP_FILE" "$CLAUDE_ERR_FILE"
  \`\`\`
  Timeout: 10 minutes (Bash outer gate). On auth failure, empty response, parse failure, or timeout, auto-degrades this phase's outside voice.`;
}

export function generateAutoplanOutsideVoicePreflight(ctx: TemplateContext): string {
  if (ctx.host === 'codex') {
    return `## Phase 0.5: Outside-voice preflight

Before invoking any outside voice, preflight the CLI and auth once for the rest of
the workflow. On Codex hosts, the outside voice is Claude CLI and the subagent is
the host-native Codex subagent.

\`\`\`bash
CLAUDE_BIN=$(command -v claude 2>/dev/null || echo "")
if [ -z "$CLAUDE_BIN" ]; then
  echo "[outside-voice-unavailable: Claude CLI not found] — proceeding with subagent only"
  _OUTSIDE_VOICE_AVAILABLE=false
elif [ -f "$HOME/.claude/.credentials.json" ] || [ -n "\${ANTHROPIC_API_KEY:-}" ]; then
  _OUTSIDE_VOICE_AVAILABLE=true
else
  echo "[outside-voice-unavailable: Claude auth missing] — proceeding with subagent only. Run \`claude\` interactively or set \$ANTHROPIC_API_KEY to enable dual-voice review."
  _OUTSIDE_VOICE_AVAILABLE=false
fi
\`\`\`

If \`_OUTSIDE_VOICE_AVAILABLE=false\`, all outside-voice phases below degrade to
\`[outside-voice-unavailable]\`. /autoplan still completes with the host-native
subagent only.`;
  }

  return `## Phase 0.5: Outside-voice preflight

Before invoking any outside voice, preflight the CLI: verify auth (multi-signal) and
warn on known-bad CLI versions. On non-Codex hosts, the outside voice is Codex CLI
and the subagent is the host-native subagent.

\`\`\`bash
_TEL=$(${ctx.paths.binDir}/gstack-config get telemetry 2>/dev/null || echo off)
source ${ctx.paths.binDir}/gstack-codex-probe

if ! command -v codex >/dev/null 2>&1; then
  _gstack_codex_log_event "codex_cli_missing"
  echo "[outside-voice-unavailable: Codex CLI not found] — proceeding with subagent only"
  _OUTSIDE_VOICE_AVAILABLE=false
elif ! _gstack_codex_auth_probe >/dev/null; then
  _gstack_codex_log_event "codex_auth_failed"
  echo "[outside-voice-unavailable: Codex auth missing] — proceeding with subagent only. Run \`codex login\` or set \$CODEX_API_KEY to enable dual-voice review."
  _OUTSIDE_VOICE_AVAILABLE=false
else
  _gstack_codex_version_check
  _OUTSIDE_VOICE_AVAILABLE=true
fi
\`\`\`

If \`_OUTSIDE_VOICE_AVAILABLE=false\`, all outside-voice phases below degrade to
\`[outside-voice-unavailable]\`. /autoplan still completes with the host-native
subagent only — saves token spend on prompts we can't use.`;
}

export function generateAutoplanOutsideVoiceBlock(ctx: TemplateContext, args?: string[]): string {
  const phase = args?.[0] as Phase | undefined;
  if (!phase || !(phase in PHASE_PROMPTS)) {
    throw new Error('{{AUTOPLAN_OUTSIDE_VOICE_BLOCK}} requires one of: ceo, design, eng, dx');
  }
  return ctx.host === 'codex' ? claudeOutsideVoiceBlock(phase) : codexOutsideVoiceBlock(ctx, phase);
}
