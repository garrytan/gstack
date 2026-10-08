# shellcheck shell=bash
# gstack-host-renders.sh — the one owner of a checkout's installed-hosts record
# and of the prune of skill renders for hosts it does not serve (#1694).
#
# Sourced, never executed: scripts/build.sh, setup and the gstack-upgrade
# migration source it. Bash 3.2 clean.
#
# A checkout renders one skills tree per host (.agents/ for Codex, .factory/,
# .kiro/, ...). Rendering all of them inside an install put ~576 extra SKILL.md
# files (32 MB) under ~/.claude/skills/gstack, a tree Claude Code and
# Cursor-agent scan (#1694). Instead:
#   - setup adds each host it installs to $ROOT/.gstack-installed-hosts. The
#     record is additive: ./setup --host codex never drops a recorded factory.
#   - scripts/build.sh renders claude plus the recorded hosts. A checkout with
#     no record (a development checkout) or GSTACK_RENDER_HOSTS=all renders
#     every host.
#   - every ./setup prunes renders of unrecorded hosts with the
#     bin/gstack-relink proof rules: a symlink into this checkout (STRONG) is
#     removed; a file proven generated (WEAK: gen-skill-docs' banner, the
#     generator's exact openai.yaml shape, or byte identity with this checkout)
#     is moved to $GSTACK_STATE_ROOT/backups/host-renders/<ts>-<id>/; anything
#     else stays where it is. Only directories left empty are removed.

# host:render-dir for every host whose render lives in its own checkout dir.
# Claude renders into the tracked tree. test/host-renders.test.ts keeps this
# equal to hostSubdir in hosts/*.ts.
GSTACK_HOST_RENDER_DIRS="codex:.agents kiro:.kiro factory:.factory opencode:.opencode cursor:.cursor copilot:.copilot slate:.slate openclaw:.openclaw hermes:.hermes gbrain:.gbrain"

gstack_render_hosts_file() { printf '%s/.gstack-installed-hosts\n' "$1"; }

_gstack_render_host_known() {
  local pair
  [ "$1" = claude ] && return 0
  for pair in $GSTACK_HOST_RENDER_DIRS; do [ "${pair%%:*}" = "$1" ] && return 0; done
  return 1
}

# gstack_render_hosts_read ROOT — the recorded hosts, one per line, sorted.
gstack_render_hosts_read() {
  local file h
  file="$(gstack_render_hosts_file "$1")"
  [ -f "$file" ] || return 0
  while IFS= read -r h; do
    h="${h%%#*}"; h="$(printf '%s' "$h" | tr -d '[:space:]')"
    [ -n "$h" ] && _gstack_render_host_known "$h" && printf '%s\n' "$h"
  done < "$file" | sort -u
}

# gstack_render_hosts_has ROOT HOST
gstack_render_hosts_has() { gstack_render_hosts_read "$1" | grep -qx "$2"; }

# gstack_render_hosts_add ROOT HOST... — add hosts to the record (never removes
# one). Writes only when the set changed, by atomic rename.
gstack_render_hosts_add() {
  local root="$1" file tmp old new h
  shift
  file="$(gstack_render_hosts_file "$root")"
  old="$(gstack_render_hosts_read "$root")"
  new="$( { [ -n "$old" ] && printf '%s\n' "$old"; for h in "$@"; do _gstack_render_host_known "$h" && printf '%s\n' "$h"; done; } | sort -u)"
  [ -f "$file" ] && [ "$new" = "$old" ] && return 0
  tmp="$file.tmp.$$"
  if {
    echo "# Hosts installed from this gstack checkout, one per line. Written by ./setup;"
    echo "# scripts/build.sh renders skills only for these (#1694) and setup prunes the"
    echo "# renders of every other host. Add a host by running ./setup --host <name>."
    if [ -n "$new" ]; then printf '%s\n' "$new"; fi
  } > "$tmp" && mv -f "$tmp" "$file"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# gstack_render_hosts_select ROOT — sets GSTACK_RENDER_HOST_LIST ("all", or
# claude followed by the recorded hosts) and GSTACK_RENDER_HOST_REASON.
gstack_render_hosts_select() {
  local root="$1" file h
  file="$(gstack_render_hosts_file "$root")"
  GSTACK_RENDER_HOST_LIST=all
  case "${GSTACK_RENDER_HOSTS:-}" in
    all) GSTACK_RENDER_HOST_REASON="GSTACK_RENDER_HOSTS=all"; return 0 ;;
    '') ;;
    *) echo "warning: GSTACK_RENDER_HOSTS accepts only 'all' (got '${GSTACK_RENDER_HOSTS}'); ignoring it" >&2 ;;
  esac
  if [ ! -f "$file" ]; then
    GSTACK_RENDER_HOST_REASON="no installed-hosts record, so this is a development checkout"
    return 0
  fi
  GSTACK_RENDER_HOST_LIST=claude
  for h in $(gstack_render_hosts_read "$root"); do
    [ "$h" = claude ] || GSTACK_RENDER_HOST_LIST="$GSTACK_RENDER_HOST_LIST $h"
  done
  GSTACK_RENDER_HOST_REASON="the hosts installed from this checkout ($file); GSTACK_RENDER_HOSTS=all renders every host"
}

# _gstack_hr_link_abs LINK — absolute target of LINK, its directory part
# canonicalized (same rule as bin/gstack-relink's _link_target_abs).
_gstack_hr_link_abs() {
  local dest d b d_real
  dest="$(readlink "$1" 2>/dev/null || true)"
  [ -n "$dest" ] || return 1
  case "$dest" in /*) ;; *) dest="${1%/*}/$dest" ;; esac
  d="${dest%/*}"; b="${dest##*/}"
  if d_real="$(cd "$d" 2>/dev/null && pwd -P)"; then printf '%s/%s\n' "$d_real" "$b"; else printf '%s\n' "$dest"; fi
}

# gstack_render_hosts_seed ROOT — record the hosts this checkout already
# serves, for installs made before the record existed: registry rows whose
# source is ROOT, known install roots that resolve to ROOT (a bin/ link or the
# .source-path a Windows copy root carries), host skills entries that link
# into ROOT's render of that host, and gstack skill copies in a host skills dir
# that has no runtime root at all. Needs bin/gstack-install-registry.sh.
gstack_render_hosts_seed() {
  local root="$1" real host dest iroot src pair dir e target found=""
  real="$(cd "$root" 2>/dev/null && pwd -P)" || return 0
  command -v gstack_install_registry_rows >/dev/null 2>&1 || return 0
  while IFS='	' read -r host _ _ _ _ src _; do
    [ -n "$host" ] && [ "$src" = "$real" ] && found="$found $host"
  done <<EOF
$(gstack_install_registry_rows 2>/dev/null)
EOF
  while IFS='	' read -r host _ dest iroot; do
    [ -n "$host" ] || continue
    if { [ -e "$iroot" ] || [ -L "$iroot" ]; }; then
      src="$(_gstack_install_source "$iroot")"
      [ -z "$src" ] && [ -f "$iroot/.source-path" ] && src="$(head -1 "$iroot/.source-path" 2>/dev/null)"
      if [ -n "$src" ] && { [ "$src" = "$real" ] || [ "$(cd "$src" 2>/dev/null && pwd -P)" = "$real" ]; }; then
        found="$found $host"; continue
      fi
    fi
    dir=""
    for pair in $GSTACK_HOST_RENDER_DIRS; do [ "${pair%%:*}" = "$host" ] && dir="${pair#*:}"; done
    [ -n "$dir" ] && [ -d "$dest" ] || continue
    for e in "$dest"/gstack*; do
      if [ -L "$e" ]; then
        target="$(_gstack_hr_link_abs "$e")" || continue
        case "$target" in "$real/$dir"/*|"$root/$dir"/*) found="$found $host"; break ;; esac
      elif [ ! -e "$iroot" ] && [ -d "$e" ] && { [ -f "$e/.gstack-owned" ] || grep -q '<!-- AUTO-GENERATED from' "$e/SKILL.md" 2>/dev/null; }; then
        # Copied skills with no runtime root naming any checkout: a legacy
        # copy install. Keep serving it rather than guess it is someone else's.
        found="$found $host"; break
      fi
    done
  done <<EOF
$(gstack_install_known_roots 2>/dev/null)
EOF
  [ -n "$found" ] || return 0
  # shellcheck disable=SC2086 # word-split the host list on purpose
  gstack_render_hosts_add "$root" $found
}
