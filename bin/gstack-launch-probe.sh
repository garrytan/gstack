# shellcheck shell=bash
# gstack-launch-probe.sh — sourced by setup and bin/gstack-doctor.
#
# Windows Smart App Control (and other application-control policies) blocks
# unsigned executables at launch, and Git Bash reports that as a plain
# "Permission denied" (#2595, #2124). `[ -x ]` cannot see it, so this runs
# each compiled binary's side-effect-free `--version` and classifies it:
#
#   native   launched and exited 0
#   blocked  could not launch: spawn error, permission denied (exit 126/127),
#            or an application-control message in its output
#   broken   launched but exited non-zero or timed out: a build problem
#   missing  not built
#
# The exact Windows error text is unverified on a real SAC machine, so callers
# show the raw first output line ($_glp_detail) beside the classification.
# Bash 3.2 plus POSIX tools.

GSTACK_COMPILED_BINARIES="browse/dist/browse browse/dist/find-browse design/dist/design make-pdf/dist/pdf bin/gstack-global-discover"

# gstack_launch_probe PATH — sets _glp_state and _glp_detail.
gstack_launch_probe() {
  local out rc
  _glp_state=missing
  _glp_detail=""
  [ -e "$1" ] || return 0
  if command -v timeout >/dev/null 2>&1; then
    out=$(timeout 20 "$1" --version </dev/null 2>&1)
  else
    out=$("$1" --version </dev/null 2>&1)
  fi
  rc=$?
  _glp_detail=$(printf '%s\n' "$out" | tr -d '\r' | grep -v '^[[:space:]]*$' | head -1 | cut -c1-200)
  case "$out" in
    *[Aa]pplication\ [Cc]ontrol*|*"Smart App Control"*|*"blocked by group policy"*|*"has blocked this file"*)
      _glp_state=blocked; return 0 ;;
  esac
  case "$rc" in
    0) _glp_state=native ;;
    126|127) _glp_state=blocked ;;
    124) _glp_state=broken; _glp_detail="timed out after 20s${_glp_detail:+: $_glp_detail}" ;;
    *) _glp_state=broken; _glp_detail="exit $rc${_glp_detail:+: $_glp_detail}" ;;
  esac
}

# gstack_launch_probe_skills REL — the skills that stop working without it.
gstack_launch_probe_skills() {
  case "$1" in
    browse/dist/browse|browse/dist/find-browse) printf '%s' "/browse, /qa, /qa-only, /design-review, /canary, /benchmark, /pair-agent, /scrape, /make-pdf" ;;
    design/dist/design) printf '%s' "/design-consultation, /design-shotgun, /design-html, /plan-design-review" ;;
    make-pdf/dist/pdf) printf '%s' "/make-pdf" ;;
    bin/gstack-global-discover) printf '%s' "/retro global" ;;
  esac
}

# gstack_launch_probe_all ROOT EXE — probes every compiled binary under ROOT
# (EXE is ".exe" on Windows). Sets _glp_blocked and _glp_broken to
# newline-separated "rel<TAB>detail" rows, and _glp_missing to a list.
gstack_launch_probe_all() {
  local rel
  _glp_blocked="" _glp_broken="" _glp_missing=""
  for rel in $GSTACK_COMPILED_BINARIES; do
    gstack_launch_probe "$1/$rel$2"
    case "$_glp_state" in
      blocked) _glp_blocked="$_glp_blocked$rel	$_glp_detail
" ;;
      broken) _glp_broken="$_glp_broken$rel	$_glp_detail
" ;;
      missing) _glp_missing="${_glp_missing:+$_glp_missing, }$rel" ;;
    esac
  done
}
