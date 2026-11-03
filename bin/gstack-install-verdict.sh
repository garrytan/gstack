# shellcheck shell=bash
# gstack-install-verdict.sh — the install verdict and install admission, Bash
# side (sourced, never executed). lib/install-verdict.ts is the TypeScript
# twin gstack-autoplan's mutating verbs call; test/install-verdict.test.ts
# pins both. Bash 3.2 plus POSIX tools (sha256sum or shasum).
#
# The verdict is what the last install check certified on this machine for
# one checkout and one project (the caller's git toplevel, or none):
#   <state root>/install-verdicts/<sha256(checkout realpath)>/<sha256(project realpath | "none")>.json
# written atomically by bin/gstack-capy-install (install and --check) with
#   schema_version 2, checkout, head, for (comma-separated: an ok run at the same
#   HEAD and Bun keeps the workflows an earlier ok install certified, #3561),
#   required[] (their union), pins_planning_only, ok,
#   trailer, min_revision, launch_path, time, project, pin (the exact Bun pin),
#   bun_path (realpath), bun_version, bun_rule (gstack_bun_resolve), bun_install,
#   node_path (realpath), node_version, node_rule (gstack_node_resolve; empty
#   when the project pins no Node)
# and named in the GSTACK_LAUNCH line as GSTACK_INSTALL_VERDICT=<path>. It is
# the one record the bun shim, lib/pregate/runtime.ts and admission read.
# Readers fall back to the schema 1 file keyed by the checkout alone,
# <state root>/install-verdicts/<sha256(checkout realpath)>.json. An install
# profile's verdict (for=review-voice) at the keyed path yields to the launched
# GSTACK_INSTALL_VERDICT, so a reviewer's install never shadows it (GST-1161).
#
# Admission (gstack-skill-start, after SESSION_KIND): an unattended session,
# or an explicit GSTACK_SESSION_KIND=spawned session with GSTACK_CAPY=1,
# refuses when the Bun first on PATH is below gstack's supported minimum and,
# with GSTACK_CAPY=1 only, when the verdict is missing, failing, for another
# checkout or HEAD, or narrower than the workflow (a component it needs, or a
# planning-only pins SKIP for a workflow that runs the repo's tests), when a
# workflow that runs the repo's tests starts in a project the verdict did not
# check, and when the Bun running is not the one the verdict recorded. A
# verdict for an install profile (for=review-voice) refuses every workflow with
# the full-install --for <skill> command. Other
# spawned sessions (ambient OpenClaw) only warn. GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1
# admits anyway and says so.

GSTACK_BUN_CONFIG=/dev/null; case "${OSTYPE:-}" in msys*|cygwin*) if command -v cygpath >/dev/null 2>&1; then GSTACK_BUN_CONFIG=NUL; fi ;; esac

# gstack_source_root BIN_DIR — the source checkout behind an install: an
# installed runtime root's recorded .source-path (setup _link_runtime_dists),
# else BIN_DIR/.. resolved. Prints the realpath; returns 1 when unresolvable.
gstack_source_root() {
  local up src=""
  up=$(cd "$1/.." 2>/dev/null && pwd -L) || return 1
  [ -f "$up/.source-path" ] && src=$(head -1 "$up/.source-path" 2>/dev/null)
  [ -n "$src" ] && [ -d "$src" ] || src="$up"
  (cd "$src" 2>/dev/null && pwd -P)
}

# gstack_support_env_get ROOT KEY — a dotted-number value from
# ROOT/capy/support.env (parsed, never sourced); empty when absent.
gstack_support_env_get() {
  sed -n "s/^$2=\([0-9][0-9.]*\)[[:space:]]*\$/\1/p" "$1/capy/support.env" 2>/dev/null | head -1
}

_gstack_iv_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; fi
}

# gstack_install_verdict_path STATE_ROOT CHECKOUT_REALPATH [PROJECT_REALPATH]
gstack_install_verdict_path() { printf '%s/install-verdicts/%s/%s.json\n' "$1" "$(_gstack_iv_sha256 "$2")" "$(_gstack_iv_sha256 "${3:-none}")"; }
# gstack_install_verdict_legacy_path STATE_ROOT CHECKOUT_REALPATH — the schema 1 file.
gstack_install_verdict_legacy_path() { printf '%s/install-verdicts/%s.json\n' "$1" "$(_gstack_iv_sha256 "$2")"; }

# gstack_install_project CHECKOUT_REALPATH — the project a verdict is keyed by
# for this working directory: its git toplevel (realpath), empty outside a
# repository or inside the checkout itself.
gstack_install_project() {
  local top
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  top=$(cd "$top" 2>/dev/null && pwd -P) || return 0
  [ "$top" = "$1" ] || printf '%s\n' "$top"
}

_gstack_iv_json() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037')"; }

# gstack_install_verdict_write FILE CHECKOUT HEAD FOR REQUIRED(space list) PINS_PLANNING_ONLY(0|1) OK(0|1) TRAILER MIN LAUNCH_PATH
#                              PROJECT PIN BUN_PATH BUN_VERSION BUN_RULE BUN_INSTALL [NODE_PATH NODE_VERSION NODE_RULE]
gstack_install_verdict_write() {
  local file="$1" tmp id req="" first=1
  for id in $5; do
    [ "$first" -eq 1 ] || req="$req, "
    first=0
    req="$req$(_gstack_iv_json "$id")"
  done
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 1
  tmp="$file.tmp.$$"
  {
    printf '{\n "schema_version": 2,\n "checkout": %s,\n "head": %s,\n "for": %s,\n' "$(_gstack_iv_json "$2")" "$(_gstack_iv_json "$3")" "$(_gstack_iv_json "$4")"
    printf ' "required": [%s],\n "pins_planning_only": %s,\n "ok": %s,\n' "$req" "$([ "$6" = 1 ] && echo true || echo false)" "$([ "$7" = 1 ] && echo true || echo false)"
    printf ' "trailer": %s,\n "min_revision": %s,\n "launch_path": %s,\n' "$(_gstack_iv_json "$8")" "$(_gstack_iv_json "$9")" "$(_gstack_iv_json "${10}")"
    printf ' "project": %s,\n "pin": %s,\n "bun_path": %s,\n "bun_version": %s,\n' "$(_gstack_iv_json "${11:-}")" "$(_gstack_iv_json "${12:-}")" "$(_gstack_iv_json "${13:-}")" "$(_gstack_iv_json "${14:-}")"
    printf ' "bun_rule": %s,\n "bun_install": %s,\n' "$(_gstack_iv_json "${15:-}")" "$(_gstack_iv_json "${16:-}")"
    printf ' "node_path": %s,\n "node_version": %s,\n "node_rule": %s,\n "time": %s\n}\n' "$(_gstack_iv_json "${17:-}")" "$(_gstack_iv_json "${18:-}")" "$(_gstack_iv_json "${19:-}")" "$(_gstack_iv_json "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  } > "$tmp" && mv -f "$tmp" "$file"
}

# gstack_install_verdict_field FILE KEY — a string, boolean or number value;
# for an array, its items space-separated.
gstack_install_verdict_field() {
  local flat
  flat=$(tr '\n' ' ' < "$1" 2>/dev/null) || return 1
  case "$(printf '%s' "$flat" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\(.\).*/\1/p")" in
    '"') printf '%s' "$flat" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" ;;
    '[') printf '%s' "$flat" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p" | tr ',' ' ' | tr -d '"' | tr -s ' ' | sed 's/^ //; s/ $//' ;;
    *) printf '%s' "$flat" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([A-Za-z0-9.]*\).*/\1/p" ;;
  esac
}

# gstack_install_admission BIN_DIR SKILL KIND — sets _ia_applies (0|1),
# _ia_refuse (0|1), _ia_warn (0|1), _ia_status (ok|runtime|verdict),
# _ia_line (the INSTALL: or INSTALL_VERDICT: line to print, may be empty).
# Needs gstack-bun-version.sh and gstack-doctor-components.sh sourced.
gstack_install_admission() {
  local bin="$1" skill="$2" kind="$3" hard=0 capy=0 src where found detail="" fix="" code="" file trailer v_head head id project v_project running v_bun
  _ia_applies=0 _ia_refuse=0 _ia_warn=0 _ia_status=ok _ia_line=""
  case "$kind" in unattended|spawned) _ia_applies=1 ;; *) return 0 ;; esac
  [ "${GSTACK_CAPY:-}" = 1 ] && capy=1
  { [ "$kind" = unattended ] || { [ "${GSTACK_SESSION_KIND:-}" = spawned ] && [ "$capy" -eq 1 ]; }; } && hard=1
  where=$(command -v bun 2>/dev/null || true)
  found=$([ -n "$where" ] && bun --version </dev/null 2>/dev/null | head -1 | tr -cd 'A-Za-z0-9.+-')
  if [ "$(gstack_bun_status "${found:-0.0.0}")" != ok ]; then
    _ia_status=runtime code=RUNTIME_BELOW_MINIMUM
    if [ -n "$where" ]; then detail="bun $found at $where is below the supported minimum $GSTACK_BUN_TESTED"; else detail="bun not found on PATH (gstack needs $GSTACK_BUN_TESTED)"; fi
    file=""; gstack_bun_resolve "$(gstack_bun_store "${_GH:-$HOME/.gstack}")" 2>/dev/null && file=$(dirname "$_gb_bin")
    if [ -n "$file" ]; then fix="launch with the GSTACK_LAUNCH line (PATH=$file:\$PATH)"
    else fix="run the Capy skill installer (scripts/install.sh --for $skill), which installs the verified Bun $GSTACK_BUN_TESTED, then launch with its GSTACK_LAUNCH line"; fi
  elif [ "$capy" -eq 1 ]; then
    src=$(gstack_source_root "$bin") || src=""
    project=$(gstack_install_project "$src")
    file=$(gstack_install_verdict_path "${_GH:-$HOME/.gstack}" "$src" "$project")
    case "$(gstack_install_verdict_field "$file" schema_version 2>/dev/null)" in
      1|2) if gstack_doctor_install_profile "$(gstack_install_verdict_field "$file" for)" && [ -f "${GSTACK_INSTALL_VERDICT:-}" ]; then file="$GSTACK_INSTALL_VERDICT"; fi ;;
    esac
    [ -f "$file" ] || [ ! -f "${GSTACK_INSTALL_VERDICT:-}" ] || file="$GSTACK_INSTALL_VERDICT"
    [ -f "$file" ] || file=$(gstack_install_verdict_legacy_path "${_GH:-$HOME/.gstack}" "$src")
    code=INSTALL_UNVERIFIED
    fix="run the Capy skill installer (scripts/install.sh --for $skill) on this machine, then launch with the GSTACK_LAUNCH line it prints"
    if [ ! -f "$file" ]; then
      detail="no install verdict at $file for $src"
      fix="run the Capy skill installer (scripts/install.sh --for $skill) from ${project:-this directory}: the verdict is keyed by the project directory the installer runs in, so a run from the skill's own folder does not cover ${project:-it}; then launch with the GSTACK_LAUNCH line it prints"
    else
      trailer=$(gstack_install_verdict_field "$file" trailer)
      v_head=$(gstack_install_verdict_field "$file" head)
      head=$(git -C "$src" rev-parse HEAD 2>/dev/null)
      v_schema=$(gstack_install_verdict_field "$file" schema_version)
      if { [ -z "$(gstack_install_verdict_field "$file" ok)" ] && [ -z "$v_schema" ]; } || { [ "$v_schema" != 1 ] && [ "$v_schema" != 2 ]; }; then
        detail="the install verdict at $file is unreadable or has an unsupported schema_version; rerun the installer"
      elif [ "$(gstack_install_verdict_field "$file" ok)" != true ]; then
        detail="the install verdict says: $trailer"
      elif [ "$(gstack_install_verdict_field "$file" checkout)" != "$src" ]; then
        detail="the install verdict is for checkout $(gstack_install_verdict_field "$file" checkout), not $src"
      elif [ -z "$head" ] || [ "$v_head" != "$head" ]; then
        detail="the install verdict is for another HEAD (${v_head:0:12}; $src is at ${head:0:12})"
      elif [ "$(gstack_install_verdict_field "$file" pins_planning_only)" = true ] && ! gstack_doctor_skill_pins_advisory "$skill"; then
        detail="the install verdict is planning-only (pins skipped for $(gstack_install_verdict_field "$file" for)) and $skill runs the repo's tests"
      elif [ "$(gstack_install_verdict_field "$file" schema_version)" != 1 ] && ! gstack_doctor_skill_pins_advisory "$skill" \
           && v_project=$(gstack_install_verdict_field "$file" project) && [ "$v_project" != "$project" ]; then
        detail="the install verdict checked ${v_project:-no project}, not ${project:-this directory (no project)}, and $skill runs the repo's tests"
        fix="run the Capy skill installer (scripts/install.sh --for $skill) from ${project:-this directory}, then launch with the GSTACK_LAUNCH line it prints"
      else
        for id in $(gstack_doctor_skill_requires "$skill" 2>/dev/null); do
          case " $(gstack_install_verdict_field "$file" required) " in *" $id "*) ;; *) detail="the install verdict certified for=$(gstack_install_verdict_field "$file" for), which does not cover $id that $skill needs"; break ;; esac
        done
        if [ -n "$detail" ] && gstack_doctor_install_profile "$(gstack_install_verdict_field "$file" for)"; then
          detail="$detail ($(gstack_install_verdict_field "$file" for) certifies only the read-only helpers)"
          fix="run GSTACK_CAPY_ROOT=$src bash $src/capy/skill/gstack/scripts/install.sh --for $skill (upgrades this checkout in place: ./setup and host profiles, no second clone), then launch with the GSTACK_LAUNCH line it prints"
        fi
      fi
      v_bun=$(gstack_install_verdict_field "$file" bun_path)
      if [ -z "$detail" ] && [ -n "$v_bun" ]; then
        running=$(gstack_realpath "$where" 2>/dev/null)
        _gstack_bun_is_shim "$where" && running=$(bun --no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}" -p process.execPath </dev/null 2>/dev/null | head -1)
        if [ -n "$running" ] && [ "$running" != "$v_bun" ]; then
          _ia_status=runtime code=BUN_RESOLUTION_DRIFT
          detail="bun $found at $running is running, but the install verdict recorded bun $(gstack_install_verdict_field "$file" bun_version) at $v_bun"
          fix="launch with the GSTACK_LAUNCH line (PATH=$(dirname "$v_bun"):\$PATH), or re-run the Capy skill installer with --check (scripts/install.sh --check --for $skill) to see what changed"
        fi
      fi
      [ -n "$detail" ] || { _ia_line="INSTALL_VERDICT: ok $trailer"; return 0; }
    fi
    [ "$_ia_status" = runtime ] || _ia_status=verdict
  else
    return 0
  fi
  if [ "${GSTACK_ALLOW_UNSUPPORTED_RUNTIME:-}" = 1 ]; then
    _ia_line="INSTALL_VERDICT: overridden (GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1): $detail"
  elif [ "$hard" -eq 1 ]; then
    _ia_refuse=1 _ia_line="INSTALL: fail $_ia_status — $detail; fix: $fix ($code)"
  else
    _ia_warn=1 _ia_line="INSTALL: warn $_ia_status — $detail; fix: $fix ($code)"
  fi
}
