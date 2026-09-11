#!/usr/bin/env bash
set -eu

CSO_BUILD_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$CSO_BUILD_ROOT"
umask 077
BUN_CMD="${BUN_CMD:-bun}"
CSO_CC="${CSO_CC:-cc}"
CSO_EXE=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) CSO_EXE=".exe" ;;
esac

CSO_FINAL_CORE="$CSO_BUILD_ROOT/bin/gstack-cso-core$CSO_EXE"
CSO_FINAL_LAUNCHER="$CSO_BUILD_ROOT/bin/gstack-cso-launcher$CSO_EXE"
CSO_FINAL_WATCHDOG="$CSO_BUILD_ROOT/bin/gstack-cso-watchdog"
CSO_FINAL_GENERATION="$CSO_BUILD_ROOT/bin/.gstack-cso-generation"
CSO_STAGE=""
CSO_PUBLISHING=0
CSO_COMMITTED=0
CSO_OLD_COHERENT=0
CSO_OLD_LAUNCHER_MOVED=0
CSO_OLD_CORE_MOVED=0
CSO_OLD_WATCHDOG_MOVED=0
CSO_OLD_GENERATION_MOVED=0
CSO_NEW_LAUNCHER_INSTALLED=0
CSO_NEW_CORE_INSTALLED=0
CSO_NEW_WATCHDOG_INSTALLED=0
CSO_NEW_GENERATION_INSTALLED=0

cso_checkpoint() {
  [ "${GSTACK_CSO_BUILD_TESTING:-0}" = 1 ] || return 0
  if [ "${GSTACK_CSO_BUILD_TEST_FAIL_AFTER:-}" = "$1" ]; then
    echo "Injected CSO build failure after $1" >&2
    exit 86
  fi
  if [ "${GSTACK_CSO_BUILD_TEST_KILL_AFTER:-}" = "$1" ]; then
    kill -KILL "$$"
  fi
}

cso_restore_previous() {
  rollback_ok=1
  # A public launcher is removed before any supporting artifact is restored.
  if [ "$CSO_NEW_LAUNCHER_INSTALLED" -eq 1 ]; then rm -f "$CSO_FINAL_LAUNCHER" || rollback_ok=0; fi
  if [ "$CSO_NEW_CORE_INSTALLED" -eq 1 ]; then rm -f "$CSO_FINAL_CORE" || rollback_ok=0; fi
  if [ -z "$CSO_EXE" ] && [ "$CSO_NEW_WATCHDOG_INSTALLED" -eq 1 ]; then rm -f "$CSO_FINAL_WATCHDOG" || rollback_ok=0; fi
  if [ "$CSO_NEW_GENERATION_INSTALLED" -eq 1 ];then rm -f "$CSO_FINAL_GENERATION"||rollback_ok=0;fi
  if [ "$CSO_OLD_CORE_MOVED" -eq 1 ]; then
    if [ "${GSTACK_CSO_BUILD_TESTING:-0}" = 1 ] && [ "${GSTACK_CSO_BUILD_TEST_FAIL_RESTORE:-}" = core ];then rollback_ok=0
    elif cso_present "$CSO_STAGE/previous/core";then cso_move "$CSO_STAGE/previous/core" "$CSO_FINAL_CORE" || rollback_ok=0
    elif ! cso_valid_artifact "$CSO_FINAL_CORE";then rollback_ok=0;fi
  fi
  if [ -z "$CSO_EXE" ] && [ "$CSO_OLD_WATCHDOG_MOVED" -eq 1 ]; then
    if cso_present "$CSO_STAGE/previous/watchdog";then cso_move "$CSO_STAGE/previous/watchdog" "$CSO_FINAL_WATCHDOG" || rollback_ok=0
    elif ! cso_valid_artifact "$CSO_FINAL_WATCHDOG";then rollback_ok=0;fi
  fi
  if [ "$CSO_OLD_GENERATION_MOVED" -eq 1 ];then
    if cso_present "$CSO_STAGE/previous/generation";then cso_move "$CSO_STAGE/previous/generation" "$CSO_FINAL_GENERATION"||rollback_ok=0
    elif ! cso_valid_generation "$CSO_FINAL_GENERATION";then rollback_ok=0;fi
  fi
  # Restore the old launcher last, and only beside the complete old support set.
  if [ "$CSO_OLD_LAUNCHER_MOVED" -eq 1 ]; then
    if [ "$rollback_ok" -eq 1 ] && [ "$CSO_OLD_COHERENT" -eq 1 ]; then
      if cso_present "$CSO_STAGE/previous/launcher";then cso_move "$CSO_STAGE/previous/launcher" "$CSO_FINAL_LAUNCHER" || rollback_ok=0
      elif ! cso_valid_artifact "$CSO_FINAL_LAUNCHER";then rollback_ok=0;fi
    else
      rollback_ok=0
    fi
  fi
  if [ "$rollback_ok" -ne 1 ]; then
    rm -f "$CSO_FINAL_LAUNCHER"
    : > "$CSO_STAGE/.retain-recovery"
    echo "CSO build rollback was incomplete; the public launcher is withheld and recovery files remain in $CSO_STAGE" >&2
    return 1
  fi
  return 0
}

cso_cleanup() {
  status=$1
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  cleanup_stage=1
  if [ "$CSO_PUBLISHING" -eq 1 ] && [ "$CSO_COMMITTED" -ne 1 ]; then
    if ! cso_restore_previous; then status=1; cleanup_stage=0; fi
  fi
  if [ "$cleanup_stage" -eq 1 ] && [ -n "$CSO_STAGE" ] && [ ! -f "$CSO_STAGE/.retain-recovery" ]; then rm -rf "$CSO_STAGE"; fi
  exit "$status"
}
trap 'cso_cleanup $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cso_valid_artifact() { [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ]; }
cso_present() { [ -e "$1" ] || [ -L "$1" ]; }
cso_valid_generation() {
  [ -f "$1" ]&&[ ! -L "$1" ]||return 1
  generation_size="$(wc -c < "$1" 2>/dev/null||true)"
  generation_size="${generation_size//[[:space:]]/}"
  [ "$generation_size" = 65 ]||return 1
  generation="$(cat "$1" 2>/dev/null)";[ "${#generation}" -eq 64 ]||return 1
  case "$generation" in *[!a-f0-9]*) return 1;;esac
}
cso_move() {
  move_attempts=0
  while ! mv "$1" "$2";do
    move_attempts=$((move_attempts+1))
    if [ -z "$CSO_EXE" ] || [ "$move_attempts" -ge 50 ];then return 1;fi
    sleep .02
  done
}

cso_sign_macos_artifact() {
  artifact=$1
  hardened=$2
  if [ "$(uname -m)" = arm64 ]; then
    sig_end="$(otool -l "$artifact" 2>/dev/null | awk '/LC_CODE_SIGNATURE/{f=1} f&&/dataoff/{o=$2} f&&/datasize/{print o+$2; exit}')"
    file_size="$(stat -f%z "$artifact" 2>/dev/null || true)"
    if [ -n "$sig_end" ] && [ -n "$file_size" ] && [ "$sig_end" -gt 0 ] 2>/dev/null && [ "$sig_end" -lt "$file_size" ] 2>/dev/null; then
      truncated="$CSO_STAGE/.codesign-truncated"
      head -c "$sig_end" "$artifact" > "$truncated"
      cat "$truncated" > "$artifact"
      rm -f "$truncated"
      chmod +x "$artifact"
    fi
  fi
  codesign --remove-signature "$artifact" 2>/dev/null || true
  if [ "$hardened" -eq 1 ]; then codesign --force --sign - --options runtime "$artifact"
  else codesign --force --sign - "$artifact"; fi
  codesign --verify --strict "$artifact"
  if [ "$hardened" -eq 1 ]; then codesign -d --verbose=4 "$artifact" 2>&1 | grep -q 'runtime'; fi
}

cso_sha256() {
  if [ -x /usr/bin/sha256sum ];then digest="$(/usr/bin/sha256sum "$1")";digest=${digest%% *}
  elif [ -x /usr/bin/shasum ];then digest="$(/usr/bin/shasum -a 256 "$1")";digest=${digest%% *}
  else echo 'CSO build requires sha256sum or shasum to bind the native launcher to its core.' >&2;return 1;fi
  case "$digest" in *[!a-f0-9]*|'') echo 'CSO build received an invalid core SHA-256 digest.' >&2;return 1;;esac
  [ "${#digest}" -eq 64 ] || { echo 'CSO build received an invalid core SHA-256 digest.' >&2;return 1; }
  printf '%s\n' "$digest"
}

cso_publish_locked() {
  [ "${GSTACK_CSO_PUBLISH_LOCKED:-}" = 1 ] || { echo 'CSO publication requires the native publisher lock.' >&2;return 73; }
  [ "$#" -eq 1 ] && [ -d "$1" ] && [ ! -L "$1" ] || { echo 'CSO publication stage is invalid.' >&2;return 69; }
  CSO_STAGE="$(cd "$1" && pwd -P)"
  case "$CSO_STAGE" in "$CSO_BUILD_ROOT"/bin/.gstack-cso-stage.*) ;; *) echo 'CSO publication stage escaped the trusted bin directory.' >&2;return 69;;esac
  CSO_STAGE_CORE="$CSO_STAGE/gstack-cso-core$CSO_EXE"
  CSO_STAGE_LAUNCHER="$CSO_STAGE/gstack-cso-launcher$CSO_EXE"
  CSO_STAGE_WATCHDOG="$CSO_STAGE/gstack-cso-watchdog"
  CSO_STAGE_GENERATION="$CSO_STAGE/.gstack-cso-generation"
  cso_valid_artifact "$CSO_STAGE_CORE" || { echo 'Staged CSO core is not one executable regular file.' >&2;return 1; }
  cso_valid_artifact "$CSO_STAGE_LAUNCHER" || { echo 'Staged CSO launcher is not one executable regular file.' >&2;return 1; }
  if [ -z "$CSO_EXE" ];then cso_valid_artifact "$CSO_STAGE_WATCHDOG" || { echo 'Staged CSO watchdog is not one executable regular file.' >&2;return 1; };fi
  cso_valid_generation "$CSO_STAGE_GENERATION"||{ echo 'Staged CSO generation manifest is invalid.' >&2;return 1; }

  old_present=0
  for artifact in "$CSO_FINAL_LAUNCHER" "$CSO_FINAL_CORE";do
    if cso_present "$artifact";then cso_valid_artifact "$artifact" || { echo 'Existing CSO artifacts contain an unsafe file.' >&2;return 1; };old_present=$((old_present+1));fi
  done
  if [ -z "$CSO_EXE" ]&&cso_present "$CSO_FINAL_WATCHDOG";then cso_valid_artifact "$CSO_FINAL_WATCHDOG" || { echo 'Existing CSO artifacts contain an unsafe file.' >&2;return 1; };old_present=$((old_present+1));fi
  if cso_present "$CSO_FINAL_GENERATION";then cso_valid_generation "$CSO_FINAL_GENERATION"||{ echo 'Existing CSO generation manifest is unsafe.' >&2;return 1; };old_present=$((old_present+1));fi
  expected=3;[ -n "$CSO_EXE" ]||expected=4
  if [ "$old_present" -eq "$expected" ];then CSO_OLD_COHERENT=1;fi

  CSO_PUBLISHING=1
  # Ignored signals remain ignored in mv children. SIGKILL is handled by the
  # launcher-first withdrawal and launcher-last commit order.
  trap '' HUP INT TERM
  if cso_present "$CSO_FINAL_LAUNCHER";then
    CSO_OLD_LAUNCHER_MOVED=1
    cso_move "$CSO_FINAL_LAUNCHER" "$CSO_STAGE/previous/launcher"
    cso_checkpoint withdraw-launcher
  fi
  if cso_present "$CSO_FINAL_CORE";then CSO_OLD_CORE_MOVED=1;cso_move "$CSO_FINAL_CORE" "$CSO_STAGE/previous/core";fi
  if [ -z "$CSO_EXE" ]&&cso_present "$CSO_FINAL_WATCHDOG";then CSO_OLD_WATCHDOG_MOVED=1;cso_move "$CSO_FINAL_WATCHDOG" "$CSO_STAGE/previous/watchdog";fi
  if cso_present "$CSO_FINAL_GENERATION";then CSO_OLD_GENERATION_MOVED=1;cso_move "$CSO_FINAL_GENERATION" "$CSO_STAGE/previous/generation";fi

  CSO_NEW_CORE_INSTALLED=1
  cso_move "$CSO_STAGE_CORE" "$CSO_FINAL_CORE"
  cso_checkpoint publish-core
  if [ -z "$CSO_EXE" ];then
    CSO_NEW_WATCHDOG_INSTALLED=1
    cso_move "$CSO_STAGE_WATCHDOG" "$CSO_FINAL_WATCHDOG"
    cso_checkpoint publish-watchdog
  fi
  CSO_NEW_GENERATION_INSTALLED=1
  cso_move "$CSO_STAGE_GENERATION" "$CSO_FINAL_GENERATION"
  cso_checkpoint before-publish-launcher
  CSO_NEW_LAUNCHER_INSTALLED=1
  cso_move "$CSO_STAGE_LAUNCHER" "$CSO_FINAL_LAUNCHER"
  cso_checkpoint publish-launcher
  CSO_COMMITTED=1
}

if [ "${1:-}" = __publish_locked ];then
  shift
  cso_publish_locked "$@"
  exit 0
fi

# This entrypoint can be run directly. Once it may publish a CSO generation,
# the previous whole-build completion proof no longer describes all outputs.
rm -f "$CSO_BUILD_ROOT/browse/dist/.build-complete"

if ! command -v "$CSO_CC" >/dev/null 2>&1 && [ -z "$CSO_EXE" ]; then
  echo 'CSO build requires a C compiler (cc/clang/gcc) for the trusted launcher and watchdog.' >&2
  exit 1
fi
if [ "$(uname -s)" = Darwin ] && ! command -v codesign >/dev/null 2>&1; then
  echo 'CSO build requires macOS codesign so staged artifacts can be verified before publication.' >&2
  exit 1
fi

CSO_STAGE="$(mktemp -d "$CSO_BUILD_ROOT/bin/.gstack-cso-stage.XXXXXX")"
CSO_STAGE_CORE="$CSO_STAGE/gstack-cso-core$CSO_EXE"
CSO_STAGE_LAUNCHER="$CSO_STAGE/gstack-cso-launcher$CSO_EXE"
CSO_STAGE_WATCHDOG="$CSO_STAGE/gstack-cso-watchdog"
CSO_STAGE_GENERATION="$CSO_STAGE/.gstack-cso-generation"
CSO_STAGE_LOCKER="$CSO_STAGE/gstack-cso-publish-lock$CSO_EXE"
mkdir -m 700 "$CSO_STAGE/previous"
if [ -n "$CSO_EXE" ];then : > "$CSO_STAGE/.gstack-cso-generation.lock";fi

# These are compile-time switches. Bun otherwise discovers configuration in
# the audited working directory before the helper can apply its own policy.
"$BUN_CMD" build --compile \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  --no-compile-autoload-tsconfig \
  --no-compile-autoload-package-json \
  lib/cso/cli.ts --outfile "$CSO_STAGE_CORE"
chmod +x "$CSO_STAGE_CORE"
cso_checkpoint core

# POSIX process groups are required by the detached watchdog. Windows keeps
# comprehensive execution unavailable instead of substituting a weaker timer.
if [ -z "$CSO_EXE" ]; then
  "$CSO_CC" -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra \
    lib/cso/watchdog.c -o "$CSO_STAGE_WATCHDOG"
  chmod +x "$CSO_STAGE_WATCHDOG"
  cso_checkpoint watchdog
fi

if [ "$(uname -s)" = Darwin ]; then
  cso_sign_macos_artifact "$CSO_STAGE_CORE" 0
  cso_sign_macos_artifact "$CSO_STAGE_WATCHDOG" 0
fi
CSO_CORE_SHA256="$(cso_sha256 "$CSO_STAGE_CORE")"
printf '%s\n' "$CSO_CORE_SHA256" > "$CSO_STAGE_GENERATION"

if [ -n "$CSO_EXE" ];then
  if ! command -v powershell.exe >/dev/null 2>&1||! command -v cygpath >/dev/null 2>&1;then
    echo 'CSO Windows build requires Git Bash and Windows PowerShell with MSVC Build Tools.' >&2;exit 1
  fi
  CSO_WINDOWS_GIT="$(type -P git 2>/dev/null || true)"
  [ -n "$CSO_WINDOWS_GIT" ] && [ -f "$CSO_WINDOWS_GIT" ] || { echo 'CSO Windows build requires the Git for Windows git.exe selected by Git Bash.' >&2;exit 1; }
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$(cygpath -w "$CSO_BUILD_ROOT/scripts/build-cso-windows.ps1")" \
    -RepoRoot "$(cygpath -w "$CSO_BUILD_ROOT")" \
    -OutputPath "$(cygpath -w "$CSO_STAGE_LAUNCHER")" \
    -LockOutputPath "$(cygpath -w "$CSO_STAGE_LOCKER")" \
    -CoreSha256 "$CSO_CORE_SHA256" \
    -GitExePath "$(cygpath -aw "$CSO_WINDOWS_GIT")"
else
  CSO_LAUNCHER_FLAGS="";if [ "$(uname -s)" = Linux ];then CSO_LAUNCHER_FLAGS="-static";fi
  # shellcheck disable=SC2086 -- the only optional flag is the literal -static.
  "$CSO_CC" -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra $CSO_LAUNCHER_FLAGS \
    "-DGSTACK_CSO_CORE_SHA256=\"$CSO_CORE_SHA256\"" lib/cso/launcher.c -o "$CSO_STAGE_LAUNCHER"
  "$CSO_CC" -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra lib/cso/publish-lock.c -o "$CSO_STAGE_LOCKER"
fi
chmod +x "$CSO_STAGE_LAUNCHER" "$CSO_STAGE_LOCKER"
cso_checkpoint launcher
cso_checkpoint publish-lock

if [ "$(uname -s)" = Darwin ];then cso_sign_macos_artifact "$CSO_STAGE_LAUNCHER" 1;fi

cso_valid_artifact "$CSO_STAGE_CORE" || { echo 'Staged CSO core is not one executable regular file.' >&2; exit 1; }
cso_valid_artifact "$CSO_STAGE_LAUNCHER" || { echo 'Staged CSO launcher is not one executable regular file.' >&2; exit 1; }
cso_valid_artifact "$CSO_STAGE_LOCKER" || { echo 'Staged CSO publisher lock is not one executable regular file.' >&2; exit 1; }
if [ -z "$CSO_EXE" ]; then cso_valid_artifact "$CSO_STAGE_WATCHDOG" || { echo 'Staged CSO watchdog is not one executable regular file.' >&2; exit 1; }; fi
cso_valid_generation "$CSO_STAGE_GENERATION"||{ echo 'Staged CSO generation manifest is invalid.' >&2;exit 1; }
[ "$(cso_sha256 "$CSO_STAGE_CORE")" = "$CSO_CORE_SHA256" ] || { echo 'Staged CSO core changed after launcher binding.' >&2;exit 1; }
"$CSO_STAGE_LAUNCHER" --version >/dev/null
cso_checkpoint validated

if [ -n "$CSO_EXE" ];then
  [ -f /usr/bin/bash.exe ] || { echo 'CSO publication requires the Git Bash executable.' >&2;exit 1; }
  CSO_PUBLISH_SHELL="$(cygpath -aw /usr/bin/bash.exe)"
else
  case "${BASH:-}" in /*) CSO_PUBLISH_SHELL=$BASH;; *) echo 'CSO publication requires an absolute Bash executable.' >&2;exit 1;;esac
fi
exec "$CSO_STAGE_LOCKER" "$CSO_BUILD_ROOT/bin" "$CSO_PUBLISH_SHELL" "$CSO_BUILD_ROOT/scripts/build-cso.sh" __publish_locked "$CSO_STAGE"
