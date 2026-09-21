#!/usr/bin/env bash
# hook-extract.sh — SHARED JSON helpers for gstack PreToolUse hooks.
# Sourced (never executed) by careful/bin/check-careful.sh and
# freeze/bin/check-freeze.sh via a path relative to each hook script.
#
# ONE copy on purpose. These two hooks previously carried separate extractor
# copies; the escaped-quote truncation bug got fixed in careful's copy while
# freeze silently kept the broken one. Any future parsing fix lands here and
# reaches both hooks by construction.

# gstack_hook_extract_field PAYLOAD FIELD
#   Prints tool_input.FIELD when PAYLOAD is valid JSON and the field is a
#   string ("" when absent or non-string). Returns 1 when no parser is
#   available or the payload is not parseable JSON — the CALLER decides the
#   polarity for that case (careful asks, freeze denies).
#
#   python3 is tried first because it ships with macOS and most Linux distros
#   and is reliably on PATH in a hook environment; node is the fallback; perl
#   (JSON::PP is core) is last. On Windows (Git Bash / MSYS2 / Cygwin) perl
#   goes FIRST: Git for Windows always ships it, while python3 there is often
#   only the Microsoft Store stub, which costs up to a second per spawn and
#   then exits non-zero — five of those per deny blew the hook's time budget.
#   $OSTYPE is a bash builtin, so picking the order spawns nothing.
case "${OSTYPE:-}" in
  msys*|cygwin*) _GSTACK_HOOK_PARSERS="perl python3 node" ;;
  *) _GSTACK_HOOK_PARSERS="python3 node perl" ;;
esac

_ghef_python3() {
  python3 -c 'import sys,json
field = sys.argv[1]
d = json.loads(sys.stdin.read())
c = d.get("tool_input", {}).get(field, "")
sys.stdout.write(c if isinstance(c, str) else "")' "$1"
}
_ghef_node() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const c=(j&&j.tool_input&&j.tool_input[process.argv[1]])||"";process.stdout.write(typeof c==="string"?c:"")}catch(e){process.exit(3)}})' "$1"
}
_ghef_perl() {
  perl -MJSON::PP -MB -e 'binmode STDOUT, ":encoding(UTF-8)";
local $/; my $d = JSON::PP->new->utf8->allow_nonref->decode(<STDIN>);
my $t = ref($d) eq "HASH" ? $d->{tool_input} : undef;
my $c = ref($t) eq "HASH" ? $t->{$ARGV[0]} : undef;
my $f = defined($c) && !ref($c) ? B::svref_2object(\$c)->FLAGS : 0;
print(($f & B::SVp_POK) && !($f & (B::SVp_IOK | B::SVp_NOK)) ? $c : "")' "$1"
}
gstack_hook_extract_field() {
  _ghef_payload="$1"
  _ghef_field="$2"
  for _ghef_parser in $_GSTACK_HOOK_PARSERS; do
    command -v "$_ghef_parser" >/dev/null 2>&1 || continue
    printf '%s' "$_ghef_payload" | "_ghef_$_ghef_parser" "$_ghef_field" 2>/dev/null && return 0
  done
  return 1
}

# gstack_hook_json_string TEXT
#   Prints TEXT as a JSON string literal (surrounding quotes included),
#   encoding quotes, backslashes, control characters and newlines. Never build
#   hook JSON with printf/sed interpolation: a path containing a quote or a
#   newline produces malformed JSON, and Claude Code silently ignores the
#   whole decision — a deny that no-ops exactly when it matters.
_ghjs_python3() { python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))'; }
_ghjs_node() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'; }
_ghjs_perl() { perl -MJSON::PP -e 'local $/; my $s = <STDIN> // ""; utf8::decode($s); print JSON::PP->new->ascii->allow_nonref->encode($s)'; }
gstack_hook_json_string() {
  _ghjs_text="$1"
  for _ghjs_parser in $_GSTACK_HOOK_PARSERS; do
    command -v "$_ghjs_parser" >/dev/null 2>&1 || continue
    printf '%s' "$_ghjs_text" | "_ghjs_$_ghjs_parser" 2>/dev/null && return 0
  done
  # Last-resort fallback (no parser on PATH): strip to a safe charset so the
  # envelope stays valid JSON even if the message loses characters.
  printf '"%s"' "$(printf '%s' "$_ghjs_text" | tr -cd 'a-zA-Z0-9 ._/:@=+-' )"
}

# gstack_hook_decision DECISION REASON
#   Emits the full PreToolUse hookSpecificOutput envelope with REASON safely
#   JSON-encoded. DECISION is "ask" or "deny". The decision MUST be nested
#   under hookSpecificOutput — Claude Code ignores a top-level
#   permissionDecision, which silently no-ops the block.
gstack_hook_decision() {
  _ghd_decision="$1"
  _ghd_reason="$2"
  _ghd_encoded=$(gstack_hook_json_string "$_ghd_reason")
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":%s}}\n' "$_ghd_decision" "$_ghd_encoded"
}

# gstack_hook_state_root
#   Print the gstack state root, resolved with EXACTLY the chain bin/gstack-paths
#   uses (GSTACK_STATE_ROOT): GSTACK_HOME, then CLAUDE_PLUGIN_DATA only when
#   CLAUDE_PLUGIN_ROOT names gstack (a CLAUDE_PLUGIN_DATA leaked from another
#   plugin via CLAUDE_ENV_FILE must not redirect our state), then $HOME/.gstack,
#   then a project-local .gstack. Hooks run on every Edit/Bash call, so this is
#   pure bash — never spawn gstack-paths from a hook. The writers (/freeze,
#   /guard, /unfreeze, /investigate) resolve through gstack-paths; a reader that
#   used a different chain failed OPEN whenever GSTACK_HOME was set (#1459).
#   test/hook-scripts.test.ts pins parity against gstack-paths.
#   Printed WITHOUT a trailing newline: callers capture with a sentinel
#   (`r="$(gstack_hook_state_root; printf x)"; r="${r%x}"`) so a root that
#   itself ends in a newline round-trips exactly as gstack-paths' %q does —
#   otherwise writer and reader would again disagree on the directory.
gstack_hook_state_root() {
  if [ -n "${GSTACK_HOME:-}" ]; then
    printf '%s' "$GSTACK_HOME"
  elif [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && printf '%s' "${CLAUDE_PLUGIN_ROOT:-}" | grep -qi "gstack"; then
    printf '%s' "$CLAUDE_PLUGIN_DATA"
  elif [ -n "${HOME:-}" ]; then
    printf '%s' "$HOME/.gstack"
  else
    printf '%s' ".gstack"
  fi
}

# gstack_hook_log_fire SKILL PATTERN
#   Append a hook_fire analytics record (pattern name only, never command
#   content). Respects GSTACK_HOME so tests never pollute the operator's real
#   analytics file. Deliberately NOT gstack_hook_state_root: every other
#   analytics writer and reader (gstack-skill-start, gstack-retro-metrics,
#   gstack-analytics) uses this two-step chain, and the usage log must stay one
#   file. Best-effort: failures never affect the hook decision.
gstack_hook_log_fire() {
  _ghlf_dir="${GSTACK_HOME:-$HOME/.gstack}/analytics"
  mkdir -p "$_ghlf_dir" 2>/dev/null || true
  # Fields are JSON-encoded (a repo basename can carry quotes/backslashes) —
  # same rule this file states for decisions: never raw-interpolate into JSON.
  _ghlf_repo=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
  printf '{"event":"hook_fire","skill":%s,"pattern":%s,"ts":"%s","repo":%s}\n' \
    "$(gstack_hook_json_string "$1")" \
    "$(gstack_hook_json_string "$2")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(gstack_hook_json_string "$_ghlf_repo")" >> "$_ghlf_dir/skill-usage.jsonl" 2>/dev/null || true
}
