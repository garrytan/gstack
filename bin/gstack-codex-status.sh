# shellcheck shell=bash
# gstack-codex-status.sh — free, read-only Codex facts shared by
# `./setup --status` and bin/gstack-doctor. Sourced, never executed. Bash 3.2
# builtins plus head/tr/date; it never runs a model, never writes, and never
# needs bun, so `./setup --status` stays "no bun, no build, no writes".
#
# The model-probe cache is <state root>/.codex-model-probe, written only by
# bin/gstack-codex-probe: first line "STATUS EPOCH SIGNATURE". Only the status
# word and the epoch are read here; the signature check (and so whether the
# entry would still be reused) stays the probe's own logic.

# gstack_codex_cache_read STATE_ROOT — sets _gcx_probe to MODEL_OK,
# MODEL_UNUSABLE, MODEL_QUOTA_EXHAUSTED, unrecognized, or "" (never probed),
# and _gcx_age to the entry's age in seconds ("" when the epoch is unusable).
gstack_codex_cache_read() {
  _gcx_probe="" _gcx_age=""
  _gcx_line=""
  [ -f "$1/.codex-model-probe" ] && _gcx_line=$(head -1 "$1/.codex-model-probe" 2>/dev/null)
  [ -n "$_gcx_line" ] || return 0
  _gcx_status="${_gcx_line%% *}"
  _gcx_ts="${_gcx_line#* }"; _gcx_ts="${_gcx_ts%% *}"
  case "$_gcx_status" in
    MODEL_OK|MODEL_UNUSABLE|MODEL_QUOTA_EXHAUSTED) _gcx_probe="$_gcx_status" ;;
    *) _gcx_probe=unrecognized ;;
  esac
  case "$_gcx_ts" in ''|*[!0-9]*) return 0 ;; esac
  _gcx_now=$(date +%s 2>/dev/null)
  case "$_gcx_now" in ''|*[!0-9]*) return 0 ;; esac
  [ "$_gcx_ts" -le "$_gcx_now" ] && _gcx_age=$((_gcx_now - _gcx_ts))
  return 0
}

# gstack_codex_age_text SECONDS — "40s ago", "12m ago", "3h ago", "2d ago";
# "age unknown" when SECONDS is empty.
gstack_codex_age_text() {
  case "$1" in
    ''|*[!0-9]*) printf 'age unknown' ;;
    *) if [ "$1" -lt 60 ]; then printf '%ss ago' "$1"
       elif [ "$1" -lt 3600 ]; then printf '%sm ago' "$(($1 / 60))"
       elif [ "$1" -lt 172800 ]; then printf '%sh ago' "$(($1 / 3600))"
       else printf '%sd ago' "$(($1 / 86400))"; fi ;;
  esac
}

# gstack_codex_version — sets _gcx_version to the first line of
# `codex --version`, clamped to a version-like charset and 60 characters;
# "" when codex is absent or prints nothing. Returns codex's exit code.
gstack_codex_version() {
  _gcx_version=""
  command -v codex >/dev/null 2>&1 || return 127
  _gcx_vout=$(codex --version </dev/null 2>/dev/null)
  _gcx_vrc=$?
  _gcx_version=$(printf '%s\n' "$_gcx_vout" | head -1 | tr -cd 'A-Za-z0-9 ._+()-' | cut -c1-60)
  return "$_gcx_vrc"
}

# gstack_codex_status_line GSTACK_ROOT STATE_ROOT — the `./setup --status`
# Codex row: install and version, the codex_reviews setting, and the cached
# model probe with its age. No paid call.
gstack_codex_status_line() {
  _gcx_reviews=$("$1/bin/gstack-config" get codex_reviews 2>/dev/null || echo enabled)
  case "$_gcx_reviews" in enabled|disabled) ;; *) _gcx_reviews=unknown ;; esac
  if ! command -v codex >/dev/null 2>&1; then
    printf 'Codex: not installed (codex_reviews=%s; outside reviews in /review, /ship, /autoplan and /codex need it)\n' "$_gcx_reviews"
    return 0
  fi
  gstack_codex_version
  gstack_codex_cache_read "$2"
  case "$_gcx_probe" in
    '') _gcx_probe_text="not probed" ;;
    *) _gcx_probe_text="$_gcx_probe $(gstack_codex_age_text "$_gcx_age")" ;;
  esac
  printf 'Codex: installed (%s); codex_reviews=%s; model probe: %s\n' "${_gcx_version:-version unknown}" "$_gcx_reviews" "$_gcx_probe_text"
}
