# shellcheck shell=bash
# gstack-doctor-check.sh — `gstack-doctor --check`: the one-line install verdict.
#
# Sourced by bin/gstack-doctor after its prelude (ROOT, ROOT_REAL, BIN, SRC,
# DOCS, STATE_ROOT, EXE, clamp, the launch probe, the codex status helpers)
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
# CHECK_JSON (0|1), CHECK_PROJECT (path or ""), CHECK_REVISION (ref or ""), LIVE.

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

# _dc_row STATUS ID DETAIL [FIX] [CODE] — record and (in text mode) print one row.
_dc_row() {
  local status="$1" id="$2" detail="$3" fix="${4:-}" code="${5:-}"
  _dc_rows="$_dc_rows$status	$id	$detail	$fix	$code
"
  [ "$status" = FAIL ] && _dc_failed="${_dc_failed:+$_dc_failed,}$id"
  [ "$CHECK_JSON" -eq 1 ] && return 0
  case "$status" in
    PASS) printf 'PASS %s%s\n' "$id" "${detail:+ $detail}" ;;
    SKIP) printf 'SKIP %s (%s)\n' "$id" "$detail" ;;
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
  model=$(grep -F 'Model-Specific Behavioral Patch (' "$file" 2>/dev/null | head -1 | sed 's/.*Model-Specific Behavioral Patch (\([^)]*\)).*/\1/' | clamp 'A-Za-z0-9._:/-' 60)
  if [ -n "$model" ]; then
    _dc_row PASS patch "$model (${file#"$_dc_hs_dest"/})"
  else
    _dc_fail_or_skip patch "no 'Model-Specific Behavioral Patch' heading in $file (rendered without --model)" "$fix" COMPONENT_MISSING "not needed; no model patch in the Codex render"
  fi
}

_dc_check_codex_cli() {
  local probe="$BIN/gstack-codex-probe" reviews sel rc model out state optional_note="optional; a Claude subagent serves as the outside voice"
  reviews=$("$BIN/gstack-config" get codex_reviews 2>/dev/null || echo enabled)
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
    out=$(cd "$ROOT" && bun -e "$script" </dev/null 2>&1); rc=$?
  else
    _dc_row FAIL browser "neither node nor bun is on PATH to launch Chromium" "install Node.js (https://nodejs.org) or Bun, then $fix" BROWSER_UNAVAILABLE
    return
  fi
  if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^RENDER_OK'; then
    _dc_row PASS browser "Chromium $(printf '%s\n' "$out" | sed -n 's/^RENDER_OK //p' | clamp '0-9.' 20) launched and rendered ($engine)"
  else
    _dc_row FAIL browser "Chromium did not launch and render via $engine (exit $rc: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | head -1 | clamp ' -~' 160))" "$fix" BROWSER_UNAVAILABLE
  fi
}

_dc_check_cso() {
  local file="$SRC/bin/.gstack-cso-build-result" reason=""
  if [ -x "$SRC/bin/gstack-cso-launcher$EXE" ] && [ -x "$SRC/bin/gstack-cso-core$EXE" ]; then
    _dc_row PASS cso "native helper built"
    return
  fi
  [ -f "$file" ] && reason=$(sed -n 's/^reason=//p' "$file" 2>/dev/null | head -1 | clamp ' -~' 100)
  _dc_fail_or_skip cso "native helper not built${reason:+ ($reason)}" "cd $SRC && ./setup (it names any missing build prerequisite)" COMPONENT_MISSING "optional; toolchain absent or helper not built${reason:+: $reason}"
}

_dc_check_runtime() {
  local where found fix="install Bun $GSTACK_BUN_TESTED with the checksum-verified recipe in $SRC/bin/gstack-capy-install (or: bun upgrade), then cd $SRC && ./setup"
  if ! where=$(command -v bun 2>/dev/null); then
    _dc_row FAIL runtime "bun not found on PATH (gstack needs $GSTACK_BUN_TESTED; floor $GSTACK_BUN_FLOOR)" "$fix" RUNTIME_BELOW_MINIMUM
    return
  fi
  found=$(bun --version </dev/null 2>/dev/null | clamp 'A-Za-z0-9.+-' 40)
  _dc_bun="$found"
  case "$(gstack_bun_status "$found")" in
    ok) _dc_row PASS runtime "bun $found at $where (floor $GSTACK_BUN_FLOOR, supported minimum $GSTACK_BUN_TESTED)" ;;
    untested) _dc_row FAIL runtime "bun $found at $where is below the supported minimum $GSTACK_BUN_TESTED (above the security floor $GSTACK_BUN_FLOOR)" "$fix" RUNTIME_BELOW_MINIMUM ;;
    too-old) _dc_row FAIL runtime "bun $found at $where is below the security floor $GSTACK_BUN_FLOOR (supported minimum $GSTACK_BUN_TESTED)" "$fix" RUNTIME_BELOW_MINIMUM ;;
    *) _dc_row FAIL runtime "could not read the version of $where" "$fix" RUNTIME_BELOW_MINIMUM ;;
  esac
}

_dc_check_pins() {
  local project="$CHECK_PROJECT" node="" out rc verdict summary failline
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
  out=$(bun "$BIN/gstack-runtime-pins.ts" --project "$project" ${_dc_bun:+--bun "$_dc_bun"} ${node:+--node "$node"} </dev/null 2>&1); rc=$?
  verdict=$(printf '%s\n' "$out" | sed -n 's/^PINS_VERDICT: //p' | tail -1 | clamp 'a-z' 8)
  summary=$(printf '%s\n' "$out" | sed -n 's/^PIN_SUMMARY: //p' | tr '\n' '|' | sed 's/|$//; s/|/; /g')
  case "$verdict" in
    pass) _dc_row PASS pins "$project: $summary" ;;
    none) _dc_row PASS pins "$project pins no runtime (no engines, .tool-versions, .nvmrc, .bun-version or CI pin)" ;;
    fail) failline=$(printf '%s\n' "$out" | sed -n 's/^PIN_FAIL: //p' | tr '\n' '|' | sed 's/|$//; s/|/; /g')
          _dc_row FAIL pins "$failline" "install the pinned version for this platform (bin/gstack-capy-install upgrades Bun when gstack and the project agree), or change the pin in $project" PROJECT_PIN_MISMATCH ;;
    *) _dc_row SKIP pins "gstack-runtime-pins could not evaluate $project (exit $rc: $(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | head -1 | clamp ' -~' 120))" ;;
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
_dc_cfg() { local v; v=$("$BIN/gstack-config" get "$1" 2>/dev/null </dev/null | clamp 'a-z0-9_-' 24); printf '%s' "${v:-$2}"; }

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
  backend=$("$BIN/gstack-config" get test_backend 2>/dev/null </dev/null | clamp 'a-z' 8); backend=${backend:-local}
  case "$n" in ''|0) _dc_row PASS cores "unknown CPU count test_backend=$backend"; return ;; esac
  if [ "$n" -lt 8 ] && [ "$backend" = local ]; then
    _dc_row PASS cores "$n test_backend=local (under 8: run full unit and E2E tiers on a remote gate; set gstack-config set test_backend ubicloud, scripts/ubicloud/ubi-runner.sh)"
  else
    _dc_row PASS cores "$n test_backend=$backend"
  fi
}

_dc_check_revision() {
  local installed head="" want="$CHECK_REVISION" target=""
  installed=$(head -1 "$ROOT/VERSION" 2>/dev/null | clamp '0-9A-Za-z.+-' 40)
  head=$(git -C "$ROOT_REAL" rev-parse --short HEAD 2>/dev/null | clamp '0-9a-f' 12)
  _dc_revision="${installed:-unknown}"
  if [ -z "$want" ]; then
    _dc_row PASS revision "${installed:-unknown}${head:+ ($head)}"
    return
  fi
  if [ "$want" = "$installed" ] || [ "$want" = "v$installed" ]; then
    _dc_row PASS revision "$installed${head:+ ($head)} matches --revision $want"
    return
  fi
  target=$(git -C "$ROOT_REAL" rev-parse --verify --quiet "$want^{commit}" 2>/dev/null | clamp '0-9a-f' 40)
  if [ -n "$target" ] && [ "$target" = "$(git -C "$ROOT_REAL" rev-parse HEAD 2>/dev/null)" ]; then
    _dc_row PASS revision "$installed ($head) is --revision $want"
    return
  fi
  _dc_row FAIL revision "installed ${installed:-unknown}${head:+ at $head} (requested $want)" "cd $SRC && git fetch origin && git checkout $want && ./setup, or run /gstack-upgrade" REVISION_UNMET
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
  _dc_bun="" _dc_revision=""
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
      runtime) _dc_check_runtime ;;
      pins) _dc_check_pins ;;
      state-root) _dc_check_state_root ;;
      privacy) _dc_check_privacy ;;
      cores) _dc_check_cores ;;
      revision) _dc_check_revision ;;
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
