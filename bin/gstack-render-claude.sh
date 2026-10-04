# gstack-render-claude.sh — the Claude skill render shared by ./setup and
# `gstack-config gbrain-refresh`. Source it; it only defines functions.
# bash-3.2-clean and safe under `set -euo pipefail`.
#
# Overlay selection is opt-in: the overlay is the family of the persisted
# `claude_overlay_model` (written only by `./setup --claude-model <id>`), or
# `claude` when that key is absent. The ID is re-resolved through
# scripts/models.ts at every render, so an ID that stops resolving after an
# upgrade falls back to `claude` with the reason printed.
#
# Each render keeps a plain-text activation record beside it
# (<render dir>.overlay: overlay, source, model, version, gbrain, render), so
# `./setup --status` and the change-only banner never need bun. No record
# means the default `claude` overlay on the committed render.
#
# Callers define `_swap_in_render` (setup and bin/gstack-config each keep
# their tested copy) and may define `log` and `bun_cmd`; plain echo and bun
# are used otherwise.

_gstack_render_say() {
  if declare -F log >/dev/null 2>&1; then log "$@"; else echo "$@"; fi
}

_gstack_render_bun() {
  if declare -F bun_cmd >/dev/null 2>&1; then bun_cmd "$@"; else bun "$@"; fi
}

# gstack_claude_overlay SOURCE_DIR CONFIG_BIN — resolve the requested overlay.
# Sets _GSTACK_OVERLAY (family), _GSTACK_OVERLAY_SOURCE (explicit|default),
# _GSTACK_OVERLAY_ID (the configured ID, or claude), _GSTACK_OVERLAY_GENERIC
# (1 when a specific ID uses the generic overlay) and _GSTACK_OVERLAY_NOTE
# (why a configured ID fell back to claude, else empty; printed here).
gstack_claude_overlay() {
  local src="$1" CONFIG_BIN="$2" out rc=0
  _GSTACK_OVERLAY=claude
  _GSTACK_OVERLAY_SOURCE=default
  _GSTACK_OVERLAY_ID=claude
  _GSTACK_OVERLAY_GENERIC=0
  _GSTACK_OVERLAY_NOTE=""
  "$CONFIG_BIN" has claude_overlay_model >/dev/null 2>&1 || return 0
  _GSTACK_OVERLAY_SOURCE=explicit
  _GSTACK_OVERLAY_ID="$("$CONFIG_BIN" get claude_overlay_model 2>/dev/null || true)"
  out="$(cd "$src" && _gstack_render_bun run scripts/models.ts claude-overlay "$_GSTACK_OVERLAY_ID" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    _GSTACK_OVERLAY="$(printf '%s' "$out" | tail -1 | cut -f1)"
    _GSTACK_OVERLAY_GENERIC="$(printf '%s' "$out" | tail -1 | cut -f2)"
    return 0
  fi
  _GSTACK_OVERLAY=claude
  _GSTACK_OVERLAY_NOTE="claude_overlay_model '$_GSTACK_OVERLAY_ID' no longer resolves to a Claude overlay ($(printf '%s\n' "$out" | sed -n 2p)); using the generic claude overlay. Fix: ./setup --claude-model <claude-model-id>, or ./setup --claude-model claude."
  _gstack_render_say "  note: $_GSTACK_OVERLAY_NOTE"
}

# gstack_claude_overlay_field RECORD KEY — one field of an activation record.
gstack_claude_overlay_field() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1
}

# gstack_render_lock DIR / gstack_render_unlock DIR — serialize the swap and
# record write of concurrent renders (mkdir lock, no flock). A lock whose
# holder is gone is broken; after 30 s the swap proceeds unlocked.
gstack_render_lock() {
  local lock="$1.lock" i=0 pid
  mkdir -p "$(dirname "$1")" 2>/dev/null || true
  while ! mkdir "$lock" 2>/dev/null; do
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$lock"
      continue
    fi
    i=$((i + 1))
    [ "$i" -lt 300 ] || return 0
    sleep 0.1
  done
  echo "$$" > "$lock/pid"
}
gstack_render_unlock() {
  rm -rf "$1.lock"
}

# gstack_claude_render_action RENDER_DIR GBRAIN — what the default install's
# render dir needs: `user` (brain-aware :user render), `plain` (pinned
# overlay, no brain blocks), `remove` (serve the committed files) or `keep`.
# GBRAIN is ok, absent or unknown (detector missing or failed: no brain
# blocks, and a render is left alone unless an overlay change needs it).
gstack_claude_render_action() {
  local render_dir="$1" gbrain="$2" previous
  if [ "$gbrain" = ok ]; then _GSTACK_RENDER_ACTION=user; return 0; fi
  if [ "$_GSTACK_OVERLAY" != claude ]; then _GSTACK_RENDER_ACTION=plain; return 0; fi
  previous="$(gstack_claude_overlay_field "$render_dir.overlay" overlay)"
  if [ "$gbrain" = unknown ] && [ "${previous:-claude}" = claude ]; then
    _GSTACK_RENDER_ACTION=keep
  else
    _GSTACK_RENDER_ACTION=remove
  fi
}

# gstack_claude_render_plain SOURCE_DIR RENDER_DIR — render the pinned overlay
# without brain blocks into a temp dir and swap it in only on success.
gstack_claude_render_plain() {
  local src="$1" RENDER_DIR="$2" RENDER_TMP out rc=0
  RENDER_TMP="$RENDER_DIR.tmp.$$"
  rm -rf "$RENDER_TMP"
  _gstack_render_say "Rendering Claude skills with the $_GSTACK_OVERLAY overlay into $RENDER_DIR (source checkout stays clean)..."
  out="$(cd "$src" && _gstack_render_bun run gen:skill-docs --host claude --out-dir "$RENDER_TMP" --link-root "$RENDER_DIR" --model "$_GSTACK_OVERLAY" ${_DISABLED_CSV:+"--disabled-skills=$_DISABLED_CSV"} 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -rf "$RENDER_TMP"
    printf '%s\n' "$out" | tail -3
    return "$rc"
  fi
  gstack_render_lock "$RENDER_DIR"
  _swap_in_render "$RENDER_DIR" "$RENDER_TMP"
  gstack_render_unlock "$RENDER_DIR"
}

# gstack_claude_render_settle SOURCE_DIR RENDER_DIR GBRAIN OUTCOME [DEFAULT]
# Record what a render step left in place and report it. OUTCOME is rendered,
# removed or failed. DEFAULT is 1 (default install: a failed pinned render
# from an older gstack version falls back to the committed files) or 0 (a
# per-install render keeps its previous render). Prints the overlay banner
# only when the served overlay differs from the previous record's.
gstack_claude_render_settle() {
  local src="$1" render_dir="$2" gbrain="$3" outcome="$4" default="${5:-1}"
  local record="$2.overlay" version previous previous_version served render_kind
  version="$(cat "$src/VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
  previous="$(gstack_claude_overlay_field "$record" overlay)"
  previous_version="$(gstack_claude_overlay_field "$record" version)"
  case "$outcome" in
    rendered) served="$_GSTACK_OVERLAY"; render_kind=user ;;
    removed) served=claude; render_kind=committed ;;
    failed)
      if [ "$default" = 1 ] && [ "$_GSTACK_OVERLAY" != claude ] && [ -d "$render_dir" ] \
        && [ "$previous_version" != "$version" ]; then
        rm -rf "$render_dir"
        _gstack_render_say "  The $_GSTACK_OVERLAY overlay render failed and the previous render came from gstack ${previous_version:-unknown}, so the committed claude render is served. Rerun ./setup to retry."
        served=claude; render_kind=committed
      elif [ -d "$render_dir" ]; then
        [ "$_GSTACK_OVERLAY" = claude ] \
          || _gstack_render_say "  The $_GSTACK_OVERLAY overlay render failed; the previous render (${previous:-claude} overlay) stays in use. Rerun ./setup to retry."
        return 0
      else
        _gstack_render_say "  The $_GSTACK_OVERLAY overlay render failed; the committed claude render is served. Rerun ./setup to retry."
        served=claude; render_kind=committed
      fi
      ;;
    *) return 0 ;;
  esac
  gstack_render_lock "$render_dir"
  if [ "$render_kind" = committed ] && [ "$_GSTACK_OVERLAY_SOURCE" = default ]; then
    rm -f "$record"
  else
    printf 'overlay=%s\nsource=%s\nmodel=%s\nversion=%s\ngbrain=%s\nrender=%s\n' \
      "$served" "$_GSTACK_OVERLAY_SOURCE" "$_GSTACK_OVERLAY_ID" "${version:-unknown}" "$gbrain" "$render_kind" \
      > "$record.tmp.$$" && mv "$record.tmp.$$" "$record"
  fi
  gstack_render_unlock "$render_dir"
  if [ "$served" != "${previous:-claude}" ]; then
    _gstack_render_say ""
    _gstack_render_say "Claude skill overlay: $served (was ${previous:-claude})."
    if [ "$_GSTACK_OVERLAY_SOURCE" = explicit ]; then
      _gstack_render_say "  Source: claude_overlay_model = $_GSTACK_OVERLAY_ID, set by ./setup --claude-model."
      [ "$_GSTACK_OVERLAY_GENERIC" = 1 ] && _gstack_render_say "  $_GSTACK_OVERLAY_ID has no overlay of its own, so it uses the generic claude overlay."
    else
      _gstack_render_say "  Source: default (no claude_overlay_model set)."
    fi
    _gstack_render_say "  Return to the generic overlay: ./setup --claude-model claude"
  fi
}

# gstack_claude_overlay_status — `./setup --status` overlay lines. Reads only
# activation records and the registry: no bun, no writes.
gstack_claude_overlay_status() {
  local default_render rows dest render record overlay source model version kind
  default_render="${GSTACK_USER_RENDER_DIR:-$GSTACK_STATE_ROOT/render/claude}"
  rows="$(gstack_install_registry_rows 2>/dev/null | awk -F '\t' '$1 == "claude" { print $4 "\t" $9 }')"
  [ -n "$rows" ] || return 0
  echo "Claude skill overlay:"
  while IFS='	' read -r dest render; do
    [ -n "$dest" ] || continue
    case "$render" in
      ''|-|committed) record="$default_render.overlay"; render="$default_render"; kind="user render" ;;
      *) record="$render.overlay"; kind="per-install render" ;;
    esac
    overlay="$(gstack_claude_overlay_field "$record" overlay)"
    [ -d "$render" ] || kind="committed render"
    if [ -z "$overlay" ]; then
      echo "  $(_gstack_tilde "$dest"): claude (default, $kind)"
      continue
    fi
    source="$(gstack_claude_overlay_field "$record" source)"
    model="$(gstack_claude_overlay_field "$record" model)"
    version="$(gstack_claude_overlay_field "$record" version)"
    [ "$(gstack_claude_overlay_field "$record" render)" = committed ] && kind="committed render"
    if [ "$source" = explicit ]; then source="explicit: $model"; fi
    echo "  $(_gstack_tilde "$dest"): $overlay ($source, $kind, gstack $version)"
  done <<EOF
$rows
EOF
}
