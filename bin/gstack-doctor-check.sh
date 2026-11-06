# shellcheck shell=bash
# gstack-doctor-check.sh — `gstack-doctor --check`: the one-line install verdict.
#
# Sourced by bin/gstack-doctor after its prelude (ROOT, ROOT_REAL, BIN, SRC,
# DOCS, STATE_ROOT, EXE, clamp, cfg, the launch probe, the codex status helpers)
# and never executed on its own. Prints `required: <ids>`, one
# `PASS | FAIL | SKIP <id>` row per component in bin/gstack-doctor-components.sh
# (generated from lib/doctor-components.ts; the same ids feed --for, --require
# and --json), then exactly one trailer: `gstack: ok <revision> for=<what>` on
# exit 0, or `gstack: fail <id,id>` on exit 1. Every FAIL row carries a `fix:`
# clause and a lib/result-codes.ts code with its docs/troubleshooting.md anchor.
# Nothing here writes. Bash 3.2 plus POSIX tools; it reports with bun absent
# (the `pins` row then SKIPs with a reason instead of vanishing). The paid
# Codex model probe runs only with --live.
#
# Inputs (set by bin/gstack-doctor): CHECK_FOR (skill), CHECK_REQUIRE (csv),
# CHECK_JSON (0|1), CHECK_PROJECT (path or ""), CHECK_REVISION (ref or ""),
# CHECK_MIN_REVISION (the supported minimum the Capy wrapper read from the
# remote's capy/support.env, `unknown` when its fetch failed, or ""), LIVE.
# GSTACK_CAPY_WRAPPER_PATH (optional) names the wrapper a below-minimum fix runs.

GSTACK_BUN_CONFIG=/dev/null; case "${OSTYPE:-}" in msys*|cygwin*) if command -v cygpath >/dev/null 2>&1; then GSTACK_BUN_CONFIG=NUL; fi ;; esac
. "$BIN/gstack-doctor-components.sh" || { echo "gstack-doctor: $BIN/gstack-doctor-components.sh is missing; reinstall with cd $SRC && ./setup" >&2; exit 1; }
. "$BIN/gstack-install-registry.sh" 2>/dev/null || { echo "gstack-doctor: $BIN/gstack-install-registry.sh is missing; reinstall with cd $SRC && ./setup" >&2; exit 1; }
. "$BIN/gstack-bun-version.sh" 2>/dev/null || { echo "gstack-doctor: $BIN/gstack-bun-version.sh is missing; reinstall with cd $SRC && ./setup" >&2; exit 1; }

_dc_rows=""        # one "status<TAB>id<TAB>detail<TAB>fix<TAB>code" per line
_dc_failed=""      # comma-separated FAIL ids
_dc_required=""    # space-separated required ids (core included)
_dc_optional=""    # space-separated ids that SKIP when absent
_dc_label=""       # for=<...> in the trailer
_dc_host_rows=""   # cached _gstack_status_rows

# _dc_has LIST ID — true when the space-separated LIST contains ID.
_dc_has() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

# _dc_url CODE — the (CODE; docs anchor) suffix for a FAIL row.
_dc_url() { printf '(%s; %s#%s)' "$1" "$DOCS" "$(gstack_result_anchor "$1")"; }

# _dc_row STATUS ID DETAIL [FIX] [CODE] — record and (in text mode) print one
# row. WARN never fails the run: its FIX is printed as given, so a row whose
# action belongs to the owner says `owner action: ...` and one the lane can run
# itself says `fix: ...` (the floor, a skipped upgrade, a Node pin).
_dc_row() {
  local status="$1" id="$2" detail="$3" fix="${4:-}" code="${5:-}"
  _dc_rows="$_dc_rows$status	$id	$detail	$fix	$code
"
  [ "$status" = FAIL ] && _dc_failed="${_dc_failed:+$_dc_failed,}$id"
  [ "$CHECK_JSON" -eq 1 ] && return 0
  case "$status" in
    PASS) printf 'PASS %s%s\n' "$id" "${detail:+ $detail}" ;;
    SKIP) printf 'SKIP %s (%s)\n' "$id" "$detail" ;;
    WARN) printf 'WARN %s — %s; %s %s\n' "$id" "$detail" "$fix" "$(_dc_url "$code")" ;;
    FAIL) printf 'FAIL %s — %s; fix: %s %s\n' "$id" "$detail" "$fix" "$(_dc_url "$code")" ;;
  esac
}

# _dc_fail_or_skip ID DETAIL FIX CODE SKIP_REASON — FAIL when required, else SKIP.
_dc_fail_or_skip() {
  if _dc_has "$_dc_required" "$1"; then _dc_row FAIL "$1" "$2" "$3" "$4"; else _dc_row SKIP "$1" "$5"; fi
}

# _dc_json_str TEXT — TEXT as a JSON string literal.
_dc_json_str() {
  printf '"%s"' "$(printf '%s' "$1" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | tr -d '\000-\010\013-\037' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }')"
}

# _dc_resolve_required — fills _dc_required, _dc_optional and _dc_label from
# --for / --require / the installed hosts. Exits 2 on an unknown skill or id.
_dc_resolve_required() {
  local extra="" id host csv
  if [ -n "$CHECK_FOR" ] && [ -n "$CHECK_REQUIRE" ]; then
    echo "gstack-doctor: --for and --require are exclusive" >&2; exit 2
  fi
  if [ -n "$CHECK_FOR" ]; then
    extra=$(gstack_doctor_skill_requires "$CHECK_FOR") || { echo "gstack-doctor: unknown skill '$CHECK_FOR' (known: $GSTACK_DOCTOR_SKILLS)" >&2; exit 2; }
    _dc_optional=$(gstack_doctor_skill_optional "$CHECK_FOR")
    _dc_label="for=$CHECK_FOR"
  elif [ -n "$CHECK_REQUIRE" ]; then
    csv=$(printf '%s' "$CHECK_REQUIRE" | tr ',' ' ')
    for id in $csv; do
      gstack_doctor_component_kind "$id" >/dev/null || { echo "gstack-doctor: unknown component '$id' in --require (known: $GSTACK_DOCTOR_COMPONENTS)" >&2; exit 2; }
      extra="${extra:+$extra }$id"
    done
    _dc_label="require=$(printf '%s' "$extra" | tr ' ' ',')"
  else
    for host in $GSTACK_DOCTOR_HOSTS; do
      _dc_host_status "$host"
      [ "$_dc_hs_result" = none ] || extra="${extra:+$extra }$host"
    done
    if [ -n "$extra" ]; then
      _dc_label="for=installed-hosts:$(printf '%s' "$extra" | tr ' ' ',')"
    else
      extra="claude"
      _dc_label="for=installed-hosts:none(claude required)"
    fi
  fi
  _dc_required="${extra:+$extra }$GSTACK_DOCTOR_CORE"
}

# _dc_host_status HOST — the registry's verdict for HOST installed from this
# checkout: sets _dc_hs_result (current|stale|missing|unregistered|none),
# _dc_hs_dest, _dc_hs_scope, _dc_hs_ver, _dc_hs_note.
_dc_host_status() {
  local host scope src dest reg cur result note real
  _dc_hs_result=none _dc_hs_dest="" _dc_hs_scope="" _dc_hs_ver="" _dc_hs_note=""
  [ -n "$_dc_host_rows" ] || _dc_host_rows="$(_gstack_status_rows)"
  while IFS='	' read -r host scope src dest reg cur result note; do
    [ "$host" = "$1" ] || continue
    real="$(cd "$src" 2>/dev/null && pwd -P)"
    if [ "$real" != "$ROOT_REAL" ] && [ "$(cd "$dest/gstack" 2>/dev/null && pwd -P)" != "$ROOT_REAL" ]; then continue; fi
    [ "$_dc_hs_result" = current ] && continue
    _dc_hs_result="$result" _dc_hs_dest="$dest" _dc_hs_scope="$scope" _dc_hs_ver="$cur" _dc_hs_note="$note"
  done <<ROWS
$_dc_host_rows
ROWS
}

_dc_check_host() {
  local id="$1" fix="cd $SRC && ./setup --host $1"
  [ "$1" = claude ] && fix="$fix --no-prefix"
  [ "$1" = codex ] && fix="$fix --model <model id, e.g. gpt-6-astra>"
  _dc_host_status "$id"
  case "$_dc_hs_result" in
    current) _dc_row PASS "$id" "$_dc_hs_scope current ($_dc_hs_ver) at $_dc_hs_dest" ;;
    none) _dc_fail_or_skip "$id" "$(gstack_doctor_component_title "$id") not installed from $ROOT" "$fix" COMPONENT_MISSING "not needed; $(gstack_doctor_component_title "$id") not installed" ;;
    *) _dc_fail_or_skip "$id" "$(gstack_doctor_component_title "$id") $_dc_hs_result at $_dc_hs_dest${_dc_hs_note:+ ($_dc_hs_note)}" "$fix" COMPONENT_MISSING "not needed; $(gstack_doctor_component_title "$id") $_dc_hs_result" ;;
  esac
}

_dc_check_patch() {
  local file="" model fix="cd $SRC && ./setup --host codex --model <model id, e.g. gpt-6-astra>"
  _dc_host_status codex
  if [ "$_dc_hs_result" = none ]; then
    _dc_fail_or_skip patch "Codex skills are not installed, so the Codex render carries no behavioral patch" "$fix" COMPONENT_MISSING "not needed; Codex skills not installed"
    return
  fi
  for file in "$_dc_hs_dest/gstack-review/SKILL.md" "$_dc_hs_dest/review/SKILL.md"; do [ -f "$file" ] && break; done
  if [ ! -f "$file" ]; then
    _dc_fail_or_skip patch "no review skill in the Codex render at $_dc_hs_dest" "$fix" COMPONENT_MISSING "not needed; no Codex review render"
    return
  fi
  # A tier 2+ render keeps the patch in the shared sections/preamble.md its SKILL.md points to.
  for f in "$file" "${file%/SKILL.md}/sections/preamble.md"; do
    model=$(grep -F 'Model-Specific Behavioral Patch (' "$f" 2>/dev/null | sed 's/.*Model-Specific Behavioral Patch (\([^)]*\)).*/\1/' | clamp 'A-Za-z0-9._:/-' 60)
    [ -n "$model" ] && { file="$f"; break; }
  done
  if [ -n "$model" ]; then
    _dc_row PASS patch "$model (${file#"$_dc_hs_dest"/})"
  else
    _dc_fail_or_skip patch "no 'Model-Specific Behavioral Patch' heading in $file (rendered without --model)" "$fix" COMPONENT_MISSING "not needed; no model patch in the Codex render"
  fi
}

_dc_check_codex_cli() {
  local probe="$BIN/gstack-codex-probe" reviews sel rc model out state optional_note="optional; a Claude subagent serves as the outside voice"
  cfg codex_reviews enabled; reviews=$_cfg
  if ! command -v codex >/dev/null 2>&1; then
    _dc_fail_or_skip codex-cli "Codex CLI not installed" "npm install -g @openai/codex, then codex login" COMPONENT_MISSING "$optional_note; Codex CLI not installed"
    return
  fi
  if [ "$reviews" = disabled ]; then
    _dc_fail_or_skip codex-cli "codex_reviews disabled" "$BIN/gstack-config set codex_reviews enabled" COMPONENT_MISSING "$optional_note; codex_reviews disabled"
    return
  fi
  sel=$("$probe" select-model exec </dev/null 2>&1); rc=$?
  model=$(printf '%s\n' "$sel" | sed -n 's/^CODEX_SEL: //p' | clamp 'A-Za-z0-9._:/-' 80)
  if [ "$rc" -ne 0 ] || [ -z "$model" ]; then
    _dc_fail_or_skip codex-cli "select-model exited $rc without a model" "run $probe select-model exec for the cause; reinstall with cd $SRC && ./setup" COMPONENT_MISSING "$optional_note; the Codex helper could not select a model"
    return
  fi
  if ! "$probe" check-auth </dev/null >/dev/null 2>&1; then
    _dc_fail_or_skip codex-cli "installed but not authenticated (model $model)" "codex login, or: printenv OPENAI_API_KEY | codex login --with-api-key" COMPONENT_MISSING "$optional_note; Codex CLI not authenticated"
    return
  fi
  gstack_codex_version
  if [ "$LIVE" -eq 1 ]; then
    out=$("$probe" probe-model exec </dev/null 2>&1); rc=$?
    state=$(printf '%s\n' "$out" | sed -n 's/^CODEX_PROBE_STATE: //p' | clamp 'a-z_' 40)
    case "$rc" in
      0) _dc_row PASS codex-cli "${_gcx_version:-version unknown}; model $model; live probe ok${state:+ ($state)}" ;;
      *) _dc_fail_or_skip codex-cli "${_gcx_version:-version unknown}; model $model; live probe exit $rc${state:+ ($state)}" "set GSTACK_CODEX_MODEL=<supported-model>, or read $probe probe-model exec" COMPONENT_MISSING "$optional_note; live probe exit $rc${state:+ ($state)}" ;;
    esac
    return
  fi
  _dc_row PASS codex-cli "${_gcx_version:-version unknown}; model $model; authenticated (paid probe not run; add --live)"
}

_dc_check_browse_bundle() {
  local missing="" f fix="cd $SRC && ./setup"
  if [ ! -x "$ROOT/browse/dist/browse$EXE" ]; then
    _dc_fail_or_skip browse-bundle "browse/dist not built" "$fix" COMPONENT_MISSING "not needed; browse bundle not built"
    return
  fi
  gstack_launch_probe "$ROOT/browse/dist/browse$EXE"
  case "$_glp_state" in
    native) ;;
    *) _dc_fail_or_skip browse-bundle "browse/dist/browse $_glp_state at launch (${_glp_detail:-no output})" "$fix" COMPONENT_MISSING "not needed; browse binary $_glp_state"; return ;;
  esac
  for f in server-node.mjs .build-complete; do [ -e "$ROOT/browse/dist/$f" ] || missing="${missing:+$missing, }$f"; done
  if [ -n "$missing" ]; then
    _dc_fail_or_skip browse-bundle "incomplete build (missing browse/dist: $missing)" "$fix" COMPONENT_MISSING "not needed; incomplete browse build"
  else
    _dc_row PASS browse-bundle "browse/dist built and launches"
  fi
}

# _dc_check_browser — Chromium launch plus a setContent smoke render, through
# node when present (Bun cannot launch Chromium on Windows) else bun. Only when
# required: a planning machine never pays for the launch.
_dc_check_browser() {
  local out rc engine fix="$ROOT/bin/gstack-browser-ensure" script
  if ! _dc_has "$_dc_required" browser; then
    _dc_row SKIP browser "$GSTACK_BROWSER_LAZY_REASON"
    return
  fi
  script='(async () => { const { chromium } = require(process.cwd() + "/node_modules/playwright"); const b = await chromium.launch({ timeout: 30000 }); try { const p = await b.newPage(); await p.setContent("<title>gstack smoke test</title><h1>Ready</h1>", { timeout: 10000 }); if (await p.title() !== "gstack smoke test") throw new Error("smoke render returned the wrong title"); console.log("RENDER_OK " + b.version()); } finally { await b.close(); } })().then(() => process.exit(0), e => { console.error(String(e && e.message || e).split("\\n")[0]); process.exit(1); });'
  if command -v node >/dev/null 2>&1; then
    engine=node
    out=$(cd "$ROOT" && { command -v timeout >/dev/null 2>&1 && timeout 90 node -e "$script" </dev/null 2>&1 || node -e "$script" </dev/null 2>&1; }); rc=$?
  elif command -v bun >/dev/null 2>&1; then
    engine=bun
    out=$(cd "$ROOT" && bun --no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}" -e "$script" </dev/null 2>&1); rc=$?
  else
    _dc_row FAIL browser "neither node nor bun is on PATH to launch Chromium" "install Node.js (https://nodejs.org) or Bun, then $fix" BROWSER_UNAVAILABLE
    return
  fi
  if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^RENDER_OK'; then
    _dc_row PASS browser "Chromium $(printf '%s\n' "$out" | sed -n 's/^RENDER_OK //p' | clamp '0-9.' 20) launched and rendered ($engine)"
  else
    _dc_row FAIL browser "Chromium did not launch and render via $engine (exit $rc: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | clamp ' -~' 160))" "$fix" BROWSER_UNAVAILABLE
  fi
}

_dc_check_cso() {
  local file="$SRC/bin/.gstack-cso-build-result" reason=""
  if [ -x "$SRC/bin/gstack-cso-launcher$EXE" ] && [ -x "$SRC/bin/gstack-cso-core$EXE" ]; then
    _dc_row PASS cso "native helper built"
    return
  fi
  [ -f "$file" ] && reason=$(sed -n 's/^reason=//p' "$file" 2>/dev/null | clamp ' -~' 100)
  _dc_fail_or_skip cso "native helper not built${reason:+ ($reason)}" "cd $SRC && ./setup (it names any missing build prerequisite)" COMPONENT_MISSING "optional; toolchain absent or helper not built${reason:+: $reason}"
}

# _dc_check_helpers — the read-only helpers `--for review-voice` certifies
# (GSTACK_DOCTOR_HELPERS): each one's `--help` loads its module graph with the
# Bun first on PATH, bounded by timeout when present. Checked only when required.
_dc_check_helpers() {
  local h failed="" bound=""
  if ! _dc_has "$_dc_required" helpers; then
    _dc_row SKIP helpers "not needed; --for review-voice certifies them"
    return
  fi
  command -v timeout >/dev/null 2>&1 && bound="timeout 60"
  for h in $GSTACK_DOCTOR_HELPERS; do
    $bound "$BIN/$h" --help </dev/null >/dev/null 2>&1 || failed="${failed:+$failed, }$h"
  done
  if [ -z "$failed" ]; then
    _dc_row PASS helpers "$(printf '%s' "$GSTACK_DOCTOR_HELPERS" | sed 's/ /, /g') launch with bun $(bun --version </dev/null 2>/dev/null | clamp 'A-Za-z0-9.+-' 40)"
  else
    _dc_row FAIL helpers "$failed did not launch (--help) with $(command -v bun 2>/dev/null || echo 'no bun on PATH')" "launch with the GSTACK_LAUNCH line; if it persists, $SRC/bin/gstack-upgrade restores a clean checkout at the tip" COMPONENT_MISSING
  fi
}

# _dc_launch_note — when a supported Bun sits off PATH (gstack-capy-install
# keeps verified ones in the runtime store), sets _dc_ln_dir/_dc_ln_ver/_dc_ln_note
# and _dc_ln_fix so a fresh shell's FAIL says where it is and how to launch with it.
_dc_launch_note() {
  _dc_ln_dir="" _dc_ln_ver="" _dc_ln_note="" _dc_ln_fix=""
  gstack_bun_resolve "$(gstack_bun_store "$STATE_ROOT")" 2>/dev/null || return 1
  [ "$_gb_bin" != "$(gstack_realpath "$(command -v bun 2>/dev/null || echo /nonexistent)" 2>/dev/null)" ] || return 1
  _dc_ln_dir=$(dirname "$_gb_bin") _dc_ln_ver="$_gb_ver"
  _dc_ln_note="; verified bun $_dc_ln_ver found at $_dc_ln_dir (not on PATH)"
  _dc_ln_fix="export PATH=\"$_dc_ln_dir:\$PATH\" or prefix commands with the GSTACK_LAUNCH line"
}

# _dc_shim_note — the per-directory bun shim in ~/.local/bin: gstack's (the
# marker line) and where it resolves from here, or a foreign file left alone.
_dc_shim_note() {
  local shim="$HOME/.local/bin/bun" target
  [ -e "$shim" ] || [ -L "$shim" ] || return 0
  if _gstack_bun_is_shim "$shim"; then
    target=$(GSTACK_BUN_SHIM_EXPLAIN=1 "$shim" --version 2>&1 >/dev/null </dev/null | sed -n 's/.* chose=\([^ ]*\).*/\1/p' | head -1)
    printf '; shim %s -> %s' "$shim" "${target:-nothing (no eligible bun)}"
  else
    printf '; %s is not gstack'"'"'s shim (no marker), left untouched: launch with the GSTACK_LAUNCH line' "$shim"
  fi
}

_dc_check_runtime() {
  local where found fix="install Bun $GSTACK_BUN_TESTED with the checksum-verified recipe in $SRC/bin/gstack-capy-install (or: bun upgrade), then cd $SRC && ./setup" extra
  _dc_launch_note && fix="$_dc_ln_fix"
  if [ -n "${GSTACK_DOCTOR_RUNTIME_DRIFT:-}" ]; then
    _dc_row FAIL runtime "bun resolution drifted: $GSTACK_DOCTOR_RUNTIME_DRIFT" "${GSTACK_DOCTOR_RUNTIME_DRIFT_FIX:-re-run the Capy skill installer}" BUN_RESOLUTION_DRIFT
    return
  fi
  if ! where=$(command -v bun 2>/dev/null); then
    _dc_row FAIL runtime "bun not found on PATH (gstack needs $GSTACK_BUN_TESTED; floor $GSTACK_BUN_FLOOR)$_dc_ln_note" "$fix" RUNTIME_BELOW_MINIMUM
    return
  fi
  found=$(bun --version </dev/null 2>/dev/null | clamp 'A-Za-z0-9.+-' 40)
  _dc_bun="$found"
  extra="$(_dc_shim_note)"
  [ -n "${GSTACK_BUN_INSTALL_VERSION:-}" ] && extra="$extra; install version $GSTACK_BUN_INSTALL_VERSION from GSTACK_BUN_INSTALL_VERSION"
  case "$(gstack_bun_status "$found")" in
    ok) _dc_row PASS runtime "bun $found at $where (floor $GSTACK_BUN_FLOOR, supported minimum $GSTACK_BUN_TESTED)$extra" ;;
    untested) _dc_row FAIL runtime "bun $found at $where is below the supported minimum $GSTACK_BUN_TESTED (above the security floor $GSTACK_BUN_FLOOR)$_dc_ln_note$extra" "$fix" RUNTIME_BELOW_MINIMUM ;;
    too-old) _dc_row FAIL runtime "bun $found at $where is below the security floor $GSTACK_BUN_FLOOR (supported minimum $GSTACK_BUN_TESTED)$_dc_ln_note$extra" "$fix" RUNTIME_BELOW_MINIMUM ;;
    *) _dc_row FAIL runtime "could not read the version of $where$_dc_ln_note$extra" "$fix" RUNTIME_BELOW_MINIMUM ;;
  esac
}

_dc_check_pins() {
  local project="$CHECK_PROJECT" node="" out rc verdict summary failline
  if [ -n "$CHECK_FOR" ] && gstack_doctor_install_profile "$CHECK_FOR"; then
    _dc_row SKIP pins "helper runtime; $CHECK_FOR runs gstack's read-only helpers on gstack's own Bun, never the repo's tests"
    return
  fi
  if ! command -v bun >/dev/null 2>&1; then
    _dc_row SKIP pins "no bun to evaluate the project pins${project:+ of $project} (install Bun, then re-run)"
    return
  fi
  if [ -z "$project" ]; then
    project=$(git rev-parse --show-toplevel 2>/dev/null)
    if [ -z "$project" ]; then
      _dc_row SKIP pins "no project: $(pwd) is not inside a git repository; pass --project <path>"
      return
    fi
    if [ "$(cd "$project" && pwd -P)" = "$ROOT_REAL" ]; then
      _dc_row SKIP pins "no project: $(pwd) is inside the gstack checkout itself; pass --project <path>"
      return
    fi
  fi
  if [ ! -d "$project" ]; then
    _dc_row SKIP pins "project directory $project does not exist; pass --project <path>"
    return
  fi
  node=$(node --version </dev/null 2>/dev/null | clamp 'v0-9.' 20); node="${node#v}"
  out=$(bun --no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}" "$BIN/gstack-runtime-pins.ts" --project "$project" ${_dc_bun:+--bun "$_dc_bun"} ${node:+--node "$node"} </dev/null 2>&1); rc=$?
  verdict=$(printf '%s\n' "$out" | sed -n 's/^PINS_VERDICT: //p' | tail -1 | clamp 'a-z' 8)
  summary=$(printf '%s\n' "$out" | sed -n 's/^PIN_SUMMARY: //p' | tr '\n' '|' | sed 's/|$//; s/|/; /g')
  case "$verdict" in
    pass) _dc_row PASS pins "$project: $summary" ;;
    none) _dc_row PASS pins "$project pins no runtime (no engines, .tool-versions, .nvmrc, .bun-version or CI pin)" ;;
    fail) failline=$(printf '%s\n' "$out" | sed -n 's/^PIN_FAIL: //p' | tr '\n' '|' | sed 's/|$//; s/|/; /g')
          if [ -n "$CHECK_FOR" ] && gstack_doctor_skill_pins_advisory "$CHECK_FOR"; then
            _dc_row SKIP pins "planning-only; repo pins differ: $failline, launch bun ${_dc_bun:-unknown}"
            _dc_pins_advisory=1
            return
          fi
          local fix="install the pinned version for this platform (bin/gstack-capy-install installs gstack's verified Bun alongside when a pin names it), or change the pin in $project" note=""
          [ -n "${GSTACK_CAPY_WRAPPER_PATH:-}" ] && fix="bash $GSTACK_CAPY_WRAPPER_PATH${CHECK_FOR:+ --for $CHECK_FOR} (installs the project's pinned Bun when it is a verified version: $GSTACK_BUN_VERIFIED; otherwise it names the conflict), or change the pin in $project"
          if printf '%s\n' "$out" | grep -q '^PIN_FAIL: node '; then
            local nwant
            nwant=$(printf '%s\n' "$out" | sed -n 's/^PIN_EXACT_REQUIRED: node \([^ ]*\) .*/\1/p' | head -1)
            [ -n "$nwant" ] || nwant=$(printf '%s\n' "$out" | sed -n 's/^PIN_CI_ALTERNATIVES: node //p' | tr ' ' '\n' | grep . | sort -t. -k1,1nr -k2,2nr -k3,3nr | head -1)
            note="; node read from $(command -v node 2>/dev/null || echo 'nowhere (no node on PATH)')"
            if [ -n "${GSTACK_CAPY_WRAPPER_PATH:-}" ]; then
              fix="bash $GSTACK_CAPY_WRAPPER_PATH${CHECK_FOR:+ --for $CHECK_FOR} (installs the project's pinned Node${nwant:+ $nwant} into gstack's runtime store and launches it through the GSTACK_LAUNCH PATH), or change the pin in $project"
            elif [ -n "$nwant" ]; then
              fix="nvm install $nwant and put its bin directory first on PATH (the Capy skill installer installs it into gstack's runtime store instead), or change the pin in $project"
            else
              fix="install a Node that satisfies the project's Node pins and put it first on PATH, or change the pin in $project"
            fi
          fi
          if [ -n "$_dc_ln_dir" ] && [ "$_dc_ln_ver" != "$_dc_bun" ] \
             && bun --no-env-file --config="${GSTACK_BUN_CONFIG:-/dev/null}" "$BIN/gstack-runtime-pins.ts" --project "$project" --bun "$_dc_ln_ver" ${node:+--node "$node"} </dev/null 2>/dev/null | grep -q '^PINS_VERDICT: pass'; then
            note="; bun $_dc_ln_ver found at $_dc_ln_dir (not on PATH) satisfies them" fix="$_dc_ln_fix"
          fi
          # Only the Node pin unmet: a WARN, never a FAIL. gstack itself runs
          # on Bun, and the project's tests may select their own Node (nvm, a
          # CI matrix), so the image's Node must not fail the session; the row
          # still names the Node read and the fix.
          if ! printf '%s\n' "$out" | grep -v '^PIN_FAIL: node ' | grep -q '^PIN_FAIL: '; then
            _dc_row WARN pins "$failline$note (node pin only; bun pins pass)" "fix: $fix" PROJECT_NODE_PIN_UNMET
            return
          fi
          _dc_row FAIL pins "$failline$note" "$fix" PROJECT_PIN_MISMATCH ;;
    *) _dc_row SKIP pins "gstack-runtime-pins could not evaluate $project (exit $rc: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | clamp ' -~' 120))" ;;
  esac
}

_dc_check_state_root() {
  local durable=yes note="no GSTACK_EPHEMERAL marker"
  if [ "${GSTACK_EPHEMERAL:-}" = 1 ]; then
    durable=no; note="GSTACK_EPHEMERAL=1: learnings and logs vanish with this machine; set GSTACK_STATE_ROOT for a durable root"
  fi
  [ -d "$STATE_ROOT" ] || note="$note; not created yet"
  if [ -d "$STATE_ROOT" ] && [ ! -w "$STATE_ROOT" ]; then
    _dc_row FAIL state-root "$STATE_ROOT durable=$durable (selected by $_gstack_sr_var) is not writable" "fix its permissions, or set GSTACK_STATE_ROOT to a writable directory" COMPONENT_MISSING
    return
  fi
  _dc_row PASS state-root "$STATE_ROOT durable=$durable (selected by $_gstack_sr_var; $note)"
}

# _dc_cfg KEY DEFAULT — a clamped config value, never the file or a message.
_dc_cfg() { local v; cfg "$1" "$2"; v=$(printf '%s' "$_cfg" | clamp 'a-z0-9_-' 24); printf '%s' "${v:-$2}"; }

_dc_check_privacy() {
  _dc_row PASS privacy "telemetry=$(_dc_cfg telemetry off) artifacts_sync=$(_dc_cfg artifacts_sync_mode off) codex_reviews=$(_dc_cfg codex_reviews enabled) update_check=$(_dc_cfg update_check true)"
}

# cores: the CPU count plus the configured test_backend (gstack-config, local |
# ubicloud); under 8 cores with test_backend=local the row recommends ubicloud
# for the full unit and E2E tiers (plan E2). Always PASS: a small machine is a
# fact, not a broken install.
_dc_check_cores() {
  local n backend
  n=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)
  n=$(printf '%s' "$n" | clamp '0-9' 6)
  cfg test_backend local; backend=$(printf '%s' "$_cfg" | clamp 'a-z' 8); backend=${backend:-local}
  case "$n" in ''|0) _dc_row PASS cores "unknown CPU count test_backend=$backend"; return ;; esac
  if [ "$n" -lt 8 ] && [ "$backend" = local ]; then
    _dc_row PASS cores "$n test_backend=local (under 8: run full unit and E2E tiers on a remote gate; set gstack-config set test_backend ubicloud, scripts/ubicloud/ubi-runner.sh)"
  else
    _dc_row PASS cores "$n test_backend=$backend"
  fi
}

# _dc_version_below A B — true when dotted numeric version A sorts below B.
_dc_version_below() {
  local a="$1." b="$2." x y
  while [ -n "$a" ] || [ -n "$b" ]; do
    x="${a%%.*}" y="${b%%.*}"; a="${a#*.}" b="${b#*.}"
    case "$x" in ''|*[!0-9]*) x=0 ;; esac
    case "$y" in ''|*[!0-9]*) y=0 ;; esac
    [ "$((10#$x))" -lt "$((10#$y))" ] && return 0
    [ "$((10#$x))" -gt "$((10#$y))" ] && return 1
  done
  return 1
}

# _dc_check_min_revision INSTALLED HEAD — sets the PASS-row suffix _dc_min_note,
# or prints the REVISION_BELOW_MINIMUM FAIL row for --min-revision and returns 1.
# Returns 1 after printing a FAIL row.
_dc_check_min_revision() {
  local installed="$1" head="$2" fix
  _dc_min_note=""
  case "$CHECK_MIN_REVISION" in
    '') return 0 ;;
    unknown*) _dc_min_note=" (remote minimum unknown (fetch failed); not compared)"; return 0 ;;
  esac
  if _dc_version_below "$installed" "$CHECK_MIN_REVISION"; then
    if [ -n "${GSTACK_CAPY_WRAPPER_PATH:-}" ]; then
      fix="bash $GSTACK_CAPY_WRAPPER_PATH${CHECK_FOR:+ --for $CHECK_FOR} (fast-forwards), or $SRC/bin/gstack-upgrade"
    else
      fix="$SRC/bin/gstack-upgrade (fast-forwards to the remote default branch, then reinstalls)"
    fi
    _dc_row FAIL revision "installed $installed${head:+ at $head} is below the supported minimum $CHECK_MIN_REVISION" "$fix" REVISION_BELOW_MINIMUM
    return 1
  fi
  _dc_min_note=" (>= supported minimum $CHECK_MIN_REVISION)"
}

_dc_check_revision() {
  local installed head="" want="$CHECK_REVISION" target=""
  installed=$(clamp '0-9A-Za-z.+-' 40 2>/dev/null <"$ROOT/VERSION")
  head=$(git -C "$ROOT_REAL" rev-parse --short HEAD 2>/dev/null | clamp '0-9a-f' 12)
  _dc_revision="${installed:-unknown}"
  _dc_check_min_revision "${installed:-0}" "$head" || return
  if [ -z "$want" ]; then
    _dc_row PASS revision "${installed:-unknown}${head:+ ($head)}$_dc_min_note"
    return
  fi
  if [ "$want" = "$installed" ] || [ "$want" = "v$installed" ]; then
    _dc_row PASS revision "$installed${head:+ ($head)} matches --revision $want$_dc_min_note"
    return
  fi
  target=$(git -C "$ROOT_REAL" rev-parse --verify --quiet "$want^{commit}" 2>/dev/null | clamp '0-9a-f' 40)
  if [ -n "$target" ] && [ "$target" = "$(git -C "$ROOT_REAL" rev-parse HEAD 2>/dev/null)" ]; then
    _dc_row PASS revision "$installed ($head) is --revision $want$_dc_min_note"
    return
  fi
  _dc_row FAIL revision "installed ${installed:-unknown}${head:+ at $head} (requested $want)" "cd $SRC && git fetch origin && git checkout $want && ./setup, or run $SRC/bin/gstack-upgrade to move to the latest release (interactive: /gstack-upgrade)" REVISION_UNMET
}

# _dc_check_floor — the project's own gstack floor: `min_gstack_version` in
# its .gstack/ship-policy.json (GSTACK_PROJECT_FLOOR_FILE/FIELD, the field
# gstack-ship-queue already validates). A consuming repo raises it in one
# commit instead of broadcasting a minimum to every thread; the next session
# check on each machine then WARNs with the upgrade as its fix. It is a
# project rule, never a security minimum, so the row is PASS, SKIP or WARN
# and never fails the run (the supported minimum is _dc_check_min_revision).
_dc_check_floor() {
  local project="$CHECK_PROJECT" file flat floor installed fix running known as stable
  if [ -z "$project" ]; then
    project=$(git rev-parse --show-toplevel 2>/dev/null)
    [ -n "$project" ] && [ "$(cd "$project" && pwd -P)" = "$ROOT_REAL" ] && project=""
  fi
  if [ -z "$project" ] || [ ! -d "$project" ]; then
    _dc_row SKIP floor "no project to read $GSTACK_PROJECT_FLOOR_FILE from (pass --project <path>)"
    return
  fi
  file="$project/$GSTACK_PROJECT_FLOOR_FILE"
  if [ ! -f "$file" ]; then
    _dc_row SKIP floor "$project declares none ($GSTACK_PROJECT_FLOOR_FILE absent; set $GSTACK_PROJECT_FLOOR_FIELD there to require a gstack version)"
    return
  fi
  # Whitespace-insensitive (the value may sit on the line after its field), the
  # first occurrence wins (the top-level field in a policy file), and only the
  # first 64 KiB are read: a real policy is a few KB.
  flat=$(head -c 65536 "$file" 2>/dev/null | tr '\n\r\t' '   ')
  floor=$(printf '%s' "$flat" | grep -o '"'"$GSTACK_PROJECT_FLOOR_FIELD"'" *: *"[0-9][0-9.]*"' | sed 's/.*"\([0-9][0-9.]*\)"$/\1/' | clamp '0-9.' 32)
  if [ -z "$floor" ]; then
    if printf '%s' "$flat" | grep -q '"'"$GSTACK_PROJECT_FLOOR_FIELD"'" *: *"'; then
      _dc_row SKIP floor "$file sets $GSTACK_PROJECT_FLOOR_FIELD to something other than a plain dotted version"
    else
      _dc_row SKIP floor "$file sets no $GSTACK_PROJECT_FLOOR_FIELD (null or absent)"
    fi
    return
  fi
  installed=$(clamp '0-9A-Za-z.+-' 40 2>/dev/null <"$ROOT/VERSION")
  # The version this checkout reads policies as, the one validatePolicy compares
  # (runningGstackVersion): VERSION, or the newest policy key it knows when that
  # is later, so an unstamped main checkout that already reads a key is not told
  # to upgrade to read it. lib/ship-policy-keys.ts writes every newer key in the
  # `_KEY_VERSION = '<version>'` form its stamp pattern moves.
  running="${installed:-0}"
  for known in $(sed -n "s/.*_KEYS\{0,1\}_VERSION = '\([0-9][0-9.]*\)'.*/\1/p" "$ROOT/lib/ship-policy-keys.ts" 2>/dev/null); do
    _dc_version_below "$running" "$known" && running="$known"
  done
  as=""
  [ "$running" != "${installed:-0}" ] && as=", reads policies as $running"
  if _dc_version_below "$running" "$floor"; then
    stable=$(_dc_newest_stable)
    if [ -n "$stable" ] && _dc_version_below "$stable" "$floor"; then
      _dc_row WARN floor "installed ${installed:-unknown}$as is below the floor $floor that $file declares ($GSTACK_PROJECT_FLOOR_FIELD), and no release meets this floor yet: the newest stable gstack is $stable, so upgrading or rerunning the install cannot clear this row" "fix: none here; the project lowers $GSTACK_PROJECT_FLOOR_FIELD to $stable or below (gstack-ship-policy validate refuses a floor above stable)" PROJECT_FLOOR_UNMET
      return
    fi
    if [ -n "${GSTACK_CAPY_WRAPPER_PATH:-}" ]; then
      fix="bash $GSTACK_CAPY_WRAPPER_PATH${CHECK_FOR:+ --for $CHECK_FOR} (fast-forwards a clean checkout to origin and reinstalls), or $SRC/bin/gstack-upgrade"
    else
      fix="$SRC/bin/gstack-upgrade (fast-forwards to the remote default branch, then reinstalls; interactive: /gstack-upgrade)"
    fi
    _dc_row WARN floor "installed ${installed:-unknown}$as is below the floor $floor that $file declares ($GSTACK_PROJECT_FLOOR_FIELD)" "fix: $fix" PROJECT_FLOOR_UNMET
    return
  fi
  _dc_row PASS floor "$floor declared by $file (installed ${installed:-unknown}$as)"
}

# _dc_newest_stable — the newest stable gstack release, as lib/stable-release.ts
# resolves it: the highest v<version> release tag at origin's stable commit (one
# ls-remote bounded by timeout, skipped where timeout is missing, as on stock
# macOS; any tag when origin has no stable branch), else VERSION at the stable
# ref (origin/stable, then stable), else the highest local release tag. Prints
# nothing when none resolves, or when the root is not the top of its own git
# checkout (a vendored copy).
_dc_newest_stable() {
  local repo="${GSTACK_STABLE_REPO:-$ROOT_REAL}" best="" v ref listed="" top stable_sha
  top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || return 0
  [ "$(cd "$top" 2>/dev/null && pwd -P)" = "$(cd "$repo" 2>/dev/null && pwd -P)" ] || return 0
  _dc_higher() { [ -z "$best" ] || _dc_version_below "$best" "$1" && best="$1"; }
  if command -v timeout >/dev/null 2>&1; then
    listed=$(GIT_TERMINAL_PROMPT=0 timeout 15 git -C "$repo" ls-remote origin refs/heads/stable 'refs/tags/v[0-9]*' 2>/dev/null)
  fi
  stable_sha=$(printf '%s\n' "$listed" | awk -F'\t' '$2 == "refs/heads/stable" { print $1; exit }')
  for v in $(printf '%s\n' "$listed" | awk -F'\t' -v s="$stable_sha" '
      index($2, "refs/tags/v") == 1 { n = substr($2, 11); p = 0
        if (substr(n, length(n) - 2) == "^{}") { n = substr(n, 1, length(n) - 3); p = 1 }
        if (p || !(n in at)) at[n] = $1 }
      END { for (n in at) if (s == "" || at[n] == s) print n }' | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\)$/\1/p'); do _dc_higher "$v"; done
  if [ -z "$best" ]; then
    for ref in refs/remotes/origin/stable refs/heads/stable; do
      git -C "$repo" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 || continue
      v=$(git -C "$repo" show "$ref:VERSION" 2>/dev/null | head -1 | clamp '0-9.' 32)
      case "$v" in [0-9]*.[0-9]*.[0-9]*) _dc_higher "$v" ;; esac
      break
    done
  fi
  if [ -z "$best" ]; then
    for v in $(git -C "$repo" tag --list 'v[0-9]*' 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\(\.[0-9][0-9]*\)\{0,1\}\)$/\1/p'); do _dc_higher "$v"; done
  fi
  printf '%s' "$best"
}

# _dc_wrapper_rev FILE — the GSTACK_CAPY_WRAPPER revision a Capy skill copy
# declares; 0 for a copy without one (the pre-bootstrapper wrapper).
_dc_wrapper_rev() {
  local rev
  rev=$(sed -n 's/^GSTACK_CAPY_WRAPPER=\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -1)
  printf '%s' "${rev:-0}"
}

# _dc_check_wrapper — the Capy skill copy. The active wrapper's provenance
# (GSTACK_CAPY_WRAPPER_REV/PATH, exported by the bootstrapper) decides: current
# passes; an active copy below the minimum, or a stale Drive copy elsewhere, is
# a WARN for the owner (an older copy still works, capy/support.env). Without
# provenance (a direct doctor run, or a wrapper too old to export it) the Drive
# copies decide: GSTACK_CAPY_WRAPPER_PATH when it names one, else every
# ~/.capy/drive/*/skills/gstack/scripts/install.sh, failing only when each is
# stale. The workaround runs the checkout's own copy, which certifies.
_dc_check_wrapper() {
  local min copy rev stale="" current="" pre="" active="${GSTACK_CAPY_WRAPPER_PATH:-}" workaround owner
  min=$(sed -n 's/^GSTACK_CAPY_MIN_WRAPPER=\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$SRC/capy/support.env" 2>/dev/null | head -1); min="${min:-1}"
  workaround="bash $SRC/capy/skill/gstack/scripts/install.sh --check${CHECK_FOR:+ --for $CHECK_FOR} (this session)"
  owner="owner action: copy $SRC/capy/skill/gstack/ over the Drive skill folder, or have Capy re-sync it; this recurs every session until the Drive copy changes"
  for copy in "$HOME"/.capy/drive/*/skills/gstack/scripts/install.sh; do
    [ -f "$copy" ] || continue
    [ -n "${GSTACK_CAPY_WRAPPER_REV:-}" ] && [ "$copy" = "$active" ] && continue
    [ -z "${GSTACK_CAPY_WRAPPER_REV:-}" ] && [ -n "$active" ] && [ -f "$active" ] && [ "$copy" != "$active" ] && continue
    rev=$(_dc_wrapper_rev "$copy")
    [ "$rev" -eq 0 ] 2>/dev/null && pre=1
    if [ "$rev" -lt "$min" ] 2>/dev/null; then stale="${stale:+$stale, }$copy (wrapper $rev)"; else current="${current:+$current, }$copy (wrapper $rev)"; fi
  done
  if [ -z "${GSTACK_CAPY_WRAPPER_REV:-}" ] && [ -n "$active" ] && [ -f "$active" ] && [ -z "$stale$current" ]; then
    rev=$(_dc_wrapper_rev "$active")
    [ "$rev" -eq 0 ] 2>/dev/null && pre=1
    if [ "$rev" -lt "$min" ] 2>/dev/null; then stale="$active (wrapper $rev)"; else current="$active (wrapper $rev)"; fi
  fi
  if [ -n "${GSTACK_CAPY_WRAPPER_REV:-}" ]; then
    if [ "$GSTACK_CAPY_WRAPPER_REV" -lt "$min" ] 2>/dev/null; then
      _dc_row WARN wrapper "the active Capy skill copy ${active:-<unknown>} is wrapper $GSTACK_CAPY_WRAPPER_REV, minimum $min (it still works)" "$owner" CAPY_WRAPPER_STALE
    elif [ -n "$stale" ]; then
      _dc_row WARN wrapper "active wrapper $GSTACK_CAPY_WRAPPER_REV (${active:-unknown path}) is current; stale Drive copies (minimum $min): $stale" "$owner" CAPY_WRAPPER_STALE
    else
      _dc_row PASS wrapper "$GSTACK_CAPY_WRAPPER_REV (${active:-unknown path}; minimum $min)"
    fi
  elif [ -n "$current" ]; then
    _dc_row PASS wrapper "Drive copy $current (minimum $min)${stale:+; stale copies: $stale}"
  elif [ -n "$stale" ] && [ -z "$pre" ]; then
    # Every copy is a bootstrapper below the minimum: it still works (a direct
    # run has no provenance to say so), so the row is the owner action, not a FAIL.
    _dc_row WARN wrapper "every Capy skill copy is below the minimum wrapper $min (it still works): $stale" "$owner" CAPY_WRAPPER_STALE
  elif [ -n "$stale" ]; then
    _dc_row FAIL wrapper "every Capy skill copy is stale (minimum wrapper $min): $stale" "$workaround; owner: ${owner#owner action: }" CAPY_WRAPPER_STALE
  else
    _dc_row SKIP wrapper "no Capy skill copy in ~/.capy/drive and no active wrapper (not a Capy machine)"
  fi
}

_dc_print_json() {
  local status id detail fix code first=1 ok=false
  [ -z "$_dc_failed" ] && ok=true
  printf '{"schema_version":1,"revision":%s,"for":%s,"required":[' "$(_dc_json_str "$_dc_revision")" "$(_dc_json_str "${_dc_label#*=}")"
  for id in $_dc_required; do
    [ "$first" -eq 1 ] || printf ','
    first=0
    _dc_json_str "$id"
  done
  printf '],"ok":%s,"failed":[' "$ok"
  first=1
  for id in $(printf '%s' "$_dc_failed" | tr ',' ' '); do
    [ "$first" -eq 1 ] || printf ','
    first=0
    _dc_json_str "$id"
  done
  printf '],"rows":['
  first=1
  while IFS='	' read -r status id detail fix code; do
    [ -n "$status" ] || continue
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"id":%s,"status":%s,"detail":%s' "$(_dc_json_str "$id")" "$(_dc_json_str "$status")" "$(_dc_json_str "$detail")"
    [ -n "$fix" ] && printf ',"fix":%s' "$(_dc_json_str "$fix")"
    [ -n "$code" ] && printf ',"code":%s,"anchor":%s' "$(_dc_json_str "$code")" "$(_dc_json_str "$(gstack_result_anchor "$code")")"
    printf '}'
  done <<ROWS
$_dc_rows
ROWS
  printf '],"trailer":%s}\n' "$(_dc_json_str "$_dc_trailer")"
}

# gstack_doctor_check — the entry point; returns 0 (ok) or 1 (fail).
gstack_doctor_check() {
  local id
  _dc_bun="" _dc_revision="" _dc_pins_advisory=0 _dc_ln_dir="" _dc_ln_ver="" _dc_ln_fix=""
  _dc_resolve_required
  [ "$CHECK_JSON" -eq 1 ] || echo "required: $_dc_required"
  for id in $GSTACK_DOCTOR_COMPONENTS; do
    case "$id" in
      claude|codex) _dc_check_host "$id" ;;
      patch) _dc_check_patch ;;
      codex-cli) _dc_check_codex_cli ;;
      browse-bundle) _dc_check_browse_bundle ;;
      browser) _dc_check_browser ;;
      cso) _dc_check_cso ;;
      helpers) _dc_check_helpers ;;
      runtime) _dc_check_runtime ;;
      pins) _dc_check_pins ;;
      state-root) _dc_check_state_root ;;
      privacy) _dc_check_privacy ;;
      cores) _dc_check_cores ;;
      revision) _dc_check_revision ;;
      floor) _dc_check_floor ;;
      wrapper) _dc_check_wrapper ;;
      *) _dc_row FAIL "$id" "no check implemented for component '$id'" "report this gstack bug" COMPONENT_MISSING ;;
    esac
  done
  if [ -n "$_dc_failed" ]; then
    _dc_trailer="gstack: fail $_dc_failed"
  else
    _dc_trailer="gstack: ok $_dc_revision $_dc_label"
  fi
  if [ "$CHECK_JSON" -eq 1 ]; then _dc_print_json; else echo "$_dc_trailer"; fi
  [ -z "$_dc_failed" ]
}
