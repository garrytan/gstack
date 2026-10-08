# shellcheck shell=bash
# gstack-install-registry.sh — the one owner of gstack's install registry.
#
# Sourced, never executed: setup, bin/gstack-relink and bin/gstack-uninstall
# source it. The registry records every install setup activated so upgrades
# refresh exactly those installs and nothing else (docs/ADDING_A_HOST.md,
# "Install ownership rules"). One file under the state root, written only here,
# under a lock, by atomic rename, mode 0600:
#
#   $GSTACK_STATE_ROOT/installs.tsv
#
# Tab-separated columns (no header row; '#' lines are comments; an empty
# field is stored as '-' because bash read collapses adjacent tabs):
#   host scope project destination install_root source version prefix render updated_at
#
#   scope        global | project
#   project      project root for scope=project, '-' otherwise
#   destination  skills directory the host discovers (the row key, with host)
#   install_root runtime root the installed skills call (render contract)
#   source       realpath of the gstack checkout that was activated
#   version      VERSION of that checkout when the row was published
#   prefix       skill_prefix render setting (true/false), '-' when n/a
#   render       render directory, or 'committed'
#
# Callers must set GSTACK_STATE_ROOT first (bin/gstack-state-root.sh). Bash 3.2
# clean; no flock (macOS lacks it), so the lock is an atomic mkdir.

gstack_install_registry_file() {
  printf '%s/installs.tsv\n' "${GSTACK_STATE_ROOT:?gstack-install-registry: GSTACK_STATE_ROOT is not set}"
}

# _gstack_registry_lock — take the registry lock (mkdir is atomic). A lock whose
# owner pid is gone is stale and is broken. Gives up after ~10 s.
_gstack_registry_lock() {
  local file lock tries owner
  file="$(gstack_install_registry_file)" || return 1
  lock="$file.lock"
  mkdir -p "$(dirname "$file")" || return 1
  tries=0
  while ! mkdir "$lock" 2>/dev/null; do
    owner="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock"
      continue
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 100 ]; then
      echo "gstack: install registry is locked by another setup ($lock). Wait for it to finish, then re-run." >&2
      return 1
    fi
    sleep 0.1
  done
  echo "$$" > "$lock/pid"
}

_gstack_registry_unlock() {
  rm -rf "$(gstack_install_registry_file).lock"
}

# _gstack_registry_publish TMP — atomically replace the registry with TMP.
_gstack_registry_publish() {
  local file
  file="$(gstack_install_registry_file)"
  chmod 600 "$1" && mv -f "$1" "$file"
}

# gstack_install_registry_rows — print every row (comments skipped).
gstack_install_registry_rows() {
  local file
  file="$(gstack_install_registry_file)" || return 1
  [ -f "$file" ] || return 0
  grep -v '^#' "$file" | grep -v '^[[:space:]]*$' || true
}

# gstack_install_registry_upsert HOST SCOPE PROJECT DESTINATION INSTALL_ROOT SOURCE VERSION PREFIX RENDER
# Publish one row (replacing the row with the same host + destination). Call
# only after the install is active.
gstack_install_registry_upsert() {
  local field file tmp now rc
  for field in "$@"; do
    case "$field" in
      *"	"*|*"
"*) echo "gstack: not registering an install whose path contains a tab or newline: $field" >&2; return 1 ;;
    esac
  done
  [ "$#" -eq 9 ] || { echo "gstack-install-registry: upsert needs 9 fields, got $#" >&2; return 1; }
  file="$(gstack_install_registry_file)" || return 1
  _gstack_registry_lock || return 1
  tmp="$file.tmp.$$"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rc=0
  {
    gstack_install_registry_rows | awk -F '\t' -v h="$1" -v d="$4" '!($1 == h && $4 == d)'
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${1:--}" "${2:--}" "${3:--}" "${4:--}" "${5:--}" "${6:--}" "${7:--}" "${8:--}" "${9:--}" "$now"
  } > "$tmp" || rc=1
  [ "$rc" -eq 0 ] && { _gstack_registry_publish "$tmp" || rc=1; }
  rm -f "$tmp"
  _gstack_registry_unlock
  return "$rc"
}

# gstack_install_registry_remove HOST DESTINATION — drop one row ('*' host = any).
gstack_install_registry_remove() {
  local file tmp rc=0
  file="$(gstack_install_registry_file)" || return 1
  [ -f "$file" ] || return 0
  _gstack_registry_lock || return 1
  tmp="$file.tmp.$$"
  gstack_install_registry_rows | awk -F '\t' -v h="$1" -v d="$2" '!((h == "*" || $1 == h) && $4 == d)' > "$tmp" || rc=1
  [ "$rc" -eq 0 ] && { _gstack_registry_publish "$tmp" || rc=1; }
  rm -f "$tmp"
  _gstack_registry_unlock
  return "$rc"
}

# gstack_install_registry_reconcile — drop rows whose install root is gone
# (uninstalled or moved), so an upgrade never resurrects a removed install.
# Prints one "dropped" line per removed row.
gstack_install_registry_reconcile() {
  local file tmp rc=0 host scope project dest root rest
  file="$(gstack_install_registry_file)" || return 1
  [ -f "$file" ] || return 0
  _gstack_registry_lock || return 1
  tmp="$file.tmp.$$"
  : > "$tmp"
  while IFS='	' read -r host scope project dest root rest; do
    [ -n "$host" ] || continue
    if [ -e "$root" ] || [ -L "$root" ]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$host" "$scope" "$project" "$dest" "$root" "$rest" >> "$tmp" || rc=1
    else
      echo "  registry: dropped $host install at $dest (its install root $root no longer exists)"
    fi
  done <<EOF
$(gstack_install_registry_rows)
EOF
  [ "$rc" -eq 0 ] && { _gstack_registry_publish "$tmp" || rc=1; }
  rm -f "$tmp"
  _gstack_registry_unlock
  return "$rc"
}

# gstack_install_render_dir HOST ROOT — the per-install render directory for an
# install whose root is not the host's default (render contract,
# docs/ADDING_A_HOST.md): keyed by the root's realpath, so two installs never
# share or overwrite a render.
gstack_install_render_dir() {
  local real
  real="$(cd "$2" 2>/dev/null && pwd -P)" || real="$2"
  printf '%s/render/installs/%s-%s\n' "${GSTACK_STATE_ROOT:?gstack-install-registry: GSTACK_STATE_ROOT is not set}" "$1" "$(printf '%s' "$real" | cksum | awk '{print $1}')"
}

# gstack_install_render_for HOST DESTINATION — the render directory the
# registry recorded for that install, or nothing when it serves committed files.
gstack_install_render_for() {
  gstack_install_registry_rows | awk -F '\t' -v h="$1" -v d="$2" '$1 == h && $4 == d && $9 != "committed" && $9 != "-" { r = $9 } END { if (r != "") print r }'
}

# gstack_host_tier HOST — the support tier declared in hosts/<host>.ts.
# test/host-config.test.ts keeps this table equal to hosts/index.ts.
gstack_host_tier() {
  case "$1" in
    claude) echo full ;;
    codex|kiro|factory|opencode|cursor|copilot|agy) echo experimental ;;
    slate|openclaw|hermes|gbrain) echo instruction-only ;;
    *) echo unknown ;;
  esac
}

# _gstack_tilde PATH — abbreviate $HOME for display.
_gstack_tilde() {
  case "$1" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# gstack_install_registry_render — the one row renderer shared by the setup
# summary, the /gstack-upgrade summary and `./setup --status`. Reads rows of
#   host scope source destination old new result [note]
# (tab-separated) on stdin; prints one line per install.
gstack_install_registry_render() {
  local host scope src dest old new result note ver
  printf '  %-9s %-16s %-8s %-10s %-27s %s\n' HOST TIER SCOPE RESULT VERSION 'DESTINATION  (source)'
  while IFS='	' read -r host scope src dest old new result note; do
    [ -n "$host" ] || continue
    if [ "${old:--}" = "${new:--}" ] || [ "${old:--}" = "-" ]; then ver="${new:--}"; else ver="$old -> $new"; fi
    printf '  %-9s %-16s %-8s %-10s %-27s %s  (source: %s)\n' "$host" "$(gstack_host_tier "$host")" "$scope" "$result" "$ver" "$(_gstack_tilde "$dest")" "$(_gstack_tilde "$src")"
    [ -n "$note" ] && printf '            %s\n' "$note"
  done
  return 0
}

# _gstack_install_source ROOT — realpath of the checkout behind an install
# root: the root itself when it is (or links to) a checkout, else the checkout
# its bin/ link points into. Empty when unknown.
_gstack_install_source() {
  local real
  real="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  if [ -f "$real/VERSION" ] && [ -f "$real/setup" ]; then printf '%s' "$real"; return 0; fi
  real="$(cd "$1/bin" 2>/dev/null && pwd -P)" || return 0
  real="$(dirname "$real")"
  [ -f "$real/VERSION" ] && printf '%s' "$real"
  return 0
}

# _gstack_vendored_source PATH — true when PATH is a project-vendored copy
# (…/.claude/skills/gstack or …/.agents/skills/gstack outside $HOME's own).
_gstack_vendored_source() {
  case "$1" in
    "$HOME/.claude/skills/gstack"|"$HOME/.agents/skills/gstack") return 1 ;;
    */.claude/skills/gstack|*/.agents/skills/gstack) return 0 ;;
  esac
  return 1
}

# gstack_install_known_roots — "host<TAB>scope<TAB>destination<TAB>install_root"
# for every location setup can install into, global and (inside a git repo)
# project-local. Used to discover installs made before the registry existed.
gstack_install_known_roots() {
  local claude_dir codex_dir proj
  claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
  codex_dir="${CODEX_HOME:-$HOME/.codex}/skills"
  printf 'claude\tglobal\t%s\t%s\n' "$claude_dir" "$claude_dir/gstack"
  if [ "$claude_dir" != "$HOME/.claude/skills" ]; then
    printf 'claude\tglobal\t%s\t%s\n' "$HOME/.claude/skills" "$HOME/.claude/skills/gstack"
  fi
  printf 'codex\tglobal\t%s\t%s\n' "$codex_dir" "$codex_dir/gstack"
  printf 'kiro\tglobal\t%s\t%s\n' "$HOME/.kiro/skills" "$HOME/.kiro/skills/gstack"
  printf 'factory\tglobal\t%s\t%s\n' "$HOME/.factory/skills" "$HOME/.factory/skills/gstack"
  printf 'opencode\tglobal\t%s\t%s\n' "$HOME/.config/opencode/skills" "$HOME/.config/opencode/skills/gstack"
  printf 'cursor\tglobal\t%s\t%s\n' "$HOME/.cursor/skills" "$HOME/.cursor/skills/gstack"
  printf 'copilot\tglobal\t%s\t%s\n' "$HOME/.copilot/skills" "$HOME/.copilot/skills/gstack"
  printf 'agy\tglobal\t%s\t%s\n' "$HOME/.gemini/antigravity-cli/skills" "$HOME/.gemini/antigravity-cli/skills/gstack"
  proj="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$proj" ] && [ "$proj" != "$HOME" ]; then
    printf 'claude\tproject\t%s\t%s\n' "$proj/.claude/skills" "$proj/.claude/skills/gstack"
    printf 'codex\tproject\t%s\t%s\n' "$proj/.agents/skills" "$proj/.agents/skills/gstack"
  fi
}

# _gstack_status_rows — summary rows (see gstack_install_registry_render) for
# every registered install, then every unregistered install found on disk.
_gstack_status_rows() {
  local host scope project dest root src ver prefix render ts cur result note seen="|"
  while IFS='	' read -r host scope project dest root src ver prefix render ts; do
    [ -n "$host" ] || continue
    seen="$seen$root|"
    cur="$(cat "$src/VERSION" 2>/dev/null || true)"
    note=""
    if [ ! -e "$root" ] && [ ! -L "$root" ]; then
      result=missing; note="install root $root is gone; the next setup or upgrade drops this row"
    elif [ -z "$cur" ]; then
      result=missing; cur="-"; note="source checkout $src is gone; reinstall from a fresh clone with ./setup --host $host"
    elif [ "$cur" = "$ver" ]; then
      result=current
    else
      result=stale; note="refresh: cd $src && ./setup --host $host"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$host" "$scope" "$src" "$dest" "$ver" "$cur" "$result" "$note"
  done <<ROWS
$(gstack_install_registry_rows)
ROWS
  while IFS='	' read -r host scope dest root; do
    [ -n "$host" ] || continue
    { [ -e "$root" ] || [ -L "$root" ]; } || continue
    case "$seen" in *"|$root|"*) continue ;; esac
    seen="$seen$root|"
    src="$(_gstack_install_source "$root")"
    [ -n "$src" ] || continue
    cur="$(cat "$src/VERSION" 2>/dev/null || echo '-')"
    note="installed before the registry; register it: cd $src && ./setup --host $host"
    if [ "$scope" = global ] && [ "$host" != claude ] && _gstack_vendored_source "$src"; then
      note="captured by the project-vendored copy at $src (#2879); choose: keep it (cd $src && ./setup --host $host --global) or repoint it at your global checkout (cd <global checkout> && ./setup --host $host)"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$host" "$scope" "$src" "$dest" "-" "$cur" unregistered "$note"
  done <<ROOTS
$(gstack_install_known_roots)
ROOTS
}

# gstack_install_status — `./setup --status`. Read-only: never builds, never
# writes, never takes the lock.
gstack_install_status() {
  local rows
  rows="$(_gstack_status_rows)"
  if [ -z "$rows" ]; then
    echo "gstack: no installs found (registry: $(_gstack_tilde "$(gstack_install_registry_file)")). Install with ./setup or ./setup --host <name>."
    return 0
  fi
  echo "gstack installs (registry: $(_gstack_tilde "$(gstack_install_registry_file)")):"
  printf '%s\n' "$rows" | gstack_install_registry_render
}

# gstack_disabled_normalize VALUE — the disabled_skills config value (comma
# separated; one value per key in gstack-config) as " a b c ": spaces, quotes
# and a gstack- prefix are stripped. gstack and gstack-upgrade can never be
# disabled, so they are dropped here too (a hand-edited config cannot remove
# the router or the way back). Empty or missing = every skill enabled.
gstack_disabled_normalize() {
  local v out=" " n
  v="$(printf '%s' "$1" | tr ',' ' ' | tr -d "\"'")"
  for n in $v; do
    n="${n#/}"
    case "$n" in gstack|gstack-upgrade) continue ;; esac
    n="${n#gstack-}"
    [ -n "$n" ] && out="$out$n "
  done
  printf '%s' "$out"
}
