#!/usr/bin/env bash
# gstack Capy skill bootstrapper. FROZEN: this file is copied into the
# owner's Drive skill folder and runs before any checkout code, so it does
# only what a stale checkout cannot do for itself:
#   1. clone gstack when absent (install mode);
#   2. fetch origin's default branch (refs only, no --depth) and read the
#      supported minimum from FETCH_HEAD:capy/support.env (parsed, never sourced);
#   3. in install mode, fast-forward a clean, unpinned checkout below that
#      minimum, under .gstack-capy-install.lock (--check never moves it);
#   4. exec the checkout's full wrapper, bin/gstack-capy-session, with the same
#      arguments, handing the held lock over (GSTACK_CAPY_LOCK_HELD=1) and,
#      from revision 2, origin's VERSION read in this run
#      (GSTACK_CAPY_REMOTE_VERSION, the trailer's `latest:` note) and the repo
#      it just cloned (GSTACK_CAPY_CLONED, the installer's `cloned` line).
#   From revision 3, `--for none` (this session runs no gstack workflow on this
#   machine: a coordinator thread) is check-only and installs nothing: with no
#   checkout it prints `gstack: ok not-needed for=none (...)` and exits 0; with
#   one it prints the same trailer with the checkout's version, running nothing
#   from the checkout. That ok admits no workflow (no verdict is written).
#   From revision 4 the clone and the floor fast-forward follow the update
#   channel (docs/releases.md#channels): GSTACK_UPDATE_CHANNEL=stable|main, else
#   the checkout's bin/gstack-update-channel.sh (auto: stable in team mode),
#   else main. On stable, a fresh clone checks out origin's stable branch and
#   the floor fast-forward goes to stable, each only when stable exists and
#   meets the supported minimum; otherwise main, as before. --revision wins.
#   From revision 5 only GSTACK_UPDATE_CHANNEL=stable follows stable: Capy crews
#   stay on main whatever the machine's update_channel or team_mode says (the
#   checkout's bin/gstack-capy-session pins main for older copies too).
# Everything else (Bun, setup, the doctor, the verdict, the launch line) is
# the checkout's. The last line is the `gstack:` trailer; exit 0 only on
# `gstack: ok`. Contract: docs/capy-install.md; tests:
# test/capy-skill-wrapper.test.ts.
#
# Usage:
#   bash install.sh --check [--for <skill> | --require <id,id>] [--project <path>]
#   bash install.sh --check --for none        this machine runs no workflow: ok not-needed, nothing installed
#   bash install.sh [--for <skill> | --require <id,id>] [--with-browser] [--revision <ref>] [--project <path>]
# Environment: GSTACK_CAPY_ROOT (default ~/.local/share/gstack), GSTACK_CAPY_REPO,
# GSTACK_CAPY_AUTO_UPGRADE=0 (no fast-forward; above the floor the checkout's session
# overrides it past 24 hours behind unless GSTACK_PIN_REASON is set), GSTACK_CAPY_FETCH_TIMEOUT (s),
# GSTACK_UPDATE_CHANNEL=stable (follow the tagged release; default main, every merge).
set -u
GSTACK_CAPY_WRAPPER=5

self="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
root="${GSTACK_CAPY_ROOT:-$HOME/.local/share/gstack}"
repo="${GSTACK_CAPY_REPO:-https://github.com/garrytan/gstack.git}"
echo "gstack-capy-skill: wrapper $GSTACK_CAPY_WRAPPER ($self)"

check=0 skill="" revision="" min_note="" remote_min="" remote_version=""
unset GSTACK_CAPY_CLONED
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --for|--only) skill="${2:-}"; args+=("$1" "${2:-}"); shift ;;
    --revision) revision="${2:-}"; args+=("$1" "${2:-}"); shift ;;
    *) args+=("$1") ;;
  esac
  shift
done
fix_cmd="bash $self${skill:+ --for $skill}"
# The same install for a machine without this skill (gstack_capy_bootstrap_cmd).
no_drive="test -f \"$root/setup\" || git clone --quiet --single-branch --depth 1 https://github.com/garrytan/gstack.git \"$root\" && GSTACK_CAPY_ROOT=\"$root\" bash \"$root/capy/skill/gstack/scripts/install.sh\"${skill:+ --for $skill}"
export GIT_TERMINAL_PROMPT=0
if [ "$skill" = none ]; then
  check=1
  if [ ! -f "$root/setup" ]; then
    echo "gstack: ok not-needed for=none (no checkout at $root; before the first workflow run: bash $self --for <skill>)"
    exit 0
  fi
fi

bounded() { if command -v timeout >/dev/null 2>&1; then timeout "${GSTACK_CAPY_FETCH_TIMEOUT:-60}" "$@"; else "$@"; fi; }
# below A B — dotted numeric A sorts below B.
below() {
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
support_get() { printf '%s\n' "$1" | sed -n "s/^$2=\([0-9][0-9.]*\)[[:space:]]*\$/\1/p" | head -1; }
# channel_stable ROOT MIN [FETCH_FLAG] — true, with origin's stable commit in $stable_sha, when
# GSTACK_UPDATE_CHANNEL=stable and origin's stable exists and meets MIN; says why not otherwise.
# FETCH_FLAG is --depth=1 for a fresh clone only (never --depth into an existing checkout).
channel_stable() {
  local ver
  [ "${GSTACK_UPDATE_CHANNEL:-}" = stable ] || return 1
  if ! bounded git -C "$1" fetch --quiet ${3:+"$3"} origin stable 2>/dev/null; then
    echo "gstack-capy-skill: channel stable, but origin has no stable branch yet (or the fetch failed); following main"
    return 1
  fi
  stable_sha=$(git -C "$1" rev-parse FETCH_HEAD) ver=$(git -C "$1" show FETCH_HEAD:VERSION 2>/dev/null | head -1)
  if [ -n "$2" ] && below "${ver:-0}" "$2"; then
    echo "gstack-capy-skill: channel stable is at ${ver:-unknown}, below the supported minimum $2; following main"
    return 1
  fi
  echo "gstack-capy-skill: channel stable ${ver:-unknown} (GSTACK_UPDATE_CHANNEL=main follows every merge)"
}

mkdir -p "$(dirname "$root")"
if [ "$check" -eq 0 ]; then
  exec 9>"$(dirname "$root")/.gstack-capy-install.lock"
  flock -w 900 9 || { echo "gstack: fail installer — another install holds $(dirname "$root")/.gstack-capy-install.lock; fix: wait for it, then $fix_cmd"; exit 1; }
fi

if [ ! -f "$root/setup" ]; then
  if [ "$check" -eq 1 ]; then
    echo "gstack: fail not-installed — no gstack checkout at $root; fix: $fix_cmd (installs; on a machine without this skill: $no_drive)"
    exit 1
  fi
  if [ -e "$root" ] && [ -n "$(ls -A "$root" 2>/dev/null)" ]; then
    echo "gstack: fail installer — $root exists but is not a gstack checkout; fix: remove it or set GSTACK_CAPY_ROOT"
    exit 3
  fi
  if [ -n "$revision" ]; then
    git clone --quiet --single-branch --depth 1 --branch "$revision" "$repo" "$root" 2>/dev/null \
      || { git clone --quiet "$repo" "$root" && git -C "$root" checkout --quiet "$revision"; } \
      || { echo "gstack: fail installer — could not clone $repo at $revision; fix: check the revision and network, then $fix_cmd"; exit 1; }
  else
    git clone --quiet --single-branch --depth 1 "$repo" "$root" \
      || { echo "gstack: fail installer — could not clone $repo; fix: check network access, then $fix_cmd"; exit 1; }
  fi
  remote_min=$(support_get "$(cat "$root/capy/support.env" 2>/dev/null)" GSTACK_MIN_REVISION)
  remote_version=$(head -1 "$root/VERSION" 2>/dev/null)
  if [ -z "$revision" ] && channel_stable "$root" "$remote_min" --depth=1; then
    git -C "$root" reset --quiet --hard "$stable_sha" \
      || { echo "gstack: fail installer — could not check out origin/stable in $root; fix: GSTACK_UPDATE_CHANNEL=main $fix_cmd"; exit 1; }
  fi
  export GSTACK_CAPY_CLONED="$repo"
else
  # The remote's rules: fetch the default branch into FETCH_HEAD (never --depth
  # into an existing checkout), read capy/support.env from it.
  default=$(bounded git -C "$root" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$|\1|p' | head -1)
  remote_min="" min_note=""
  if [ -n "$default" ] && bounded git -C "$root" fetch --quiet origin "$default" 2>/dev/null; then
    support=$(git -C "$root" show FETCH_HEAD:capy/support.env 2>/dev/null)
    remote_min=$(support_get "$support" GSTACK_MIN_REVISION)
    remote_version=$(git -C "$root" show FETCH_HEAD:VERSION 2>/dev/null | head -1)
  else
    min_note="remote minimum unknown (fetch failed)"
    echo "gstack-capy-skill: $min_note; checking the local install only"
  fi
  installed=$(head -1 "$root/VERSION" 2>/dev/null)
  if [ "$skill" = none ]; then
    # Nothing from the checkout runs: the trailer is honest for any revision.
    note="checkout ${installed:-unknown} at $root, not certified"
    [ -n "$remote_version" ] && [ "$remote_version" != "$installed" ] && note="$note; latest: $remote_version"
    echo "gstack: ok not-needed for=none ($note; before the first workflow run: bash $self --for <skill>)"
    exit 0
  fi
  if [ -n "$remote_min" ] && below "${installed:-0}" "$remote_min"; then
    branch=$(git -C "$root" symbolic-ref -q --short HEAD || true)
    dirty=$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null | cut -c4- | tr '\n' ' ' | sed 's/ $//')
    cause="" fix=""
    if [ -n "$revision" ]; then cause="pinned by --revision $revision"; fix="drop --revision, or pin a revision at or above $remote_min, then $fix_cmd"
    elif [ -z "$branch" ]; then cause="pinned: HEAD is detached at $(git -C "$root" rev-parse --short HEAD)"; fix="git -C $root checkout $default && $fix_cmd"
    elif [ "$branch" != "$default" ]; then cause="pinned: on branch $branch, not $default"; fix="git -C $root checkout $default && $fix_cmd"
    elif [ -n "$dirty" ]; then cause="tracked files changed: $dirty"; fix="git -C $root status --short shows them; commit or move those changes, then $fix_cmd"
    elif [ "${GSTACK_CAPY_AUTO_UPGRADE:-1}" = 0 ]; then cause="auto-upgrade disabled"; fix="unset GSTACK_CAPY_AUTO_UPGRADE, then $fix_cmd (or git -C $root merge --ff-only FETCH_HEAD and $root/bin/gstack-capy-install)"
    elif ! git -C "$root" merge-base --is-ancestor HEAD FETCH_HEAD 2>/dev/null \
         && ! { git -C "$root" fetch --quiet --unshallow origin "$default" 2>/dev/null; git -C "$root" merge-base --is-ancestor HEAD FETCH_HEAD 2>/dev/null; }; then
      cause="diverged: local commits not on origin/$default"; fix="git -C $root log --oneline FETCH_HEAD..HEAD shows them; move them to another branch, then $fix_cmd"
    elif [ "$check" -eq 1 ]; then cause="fast-forward available"; fix="$fix_cmd (fast-forwards)"
    fi
    if [ -n "$cause" ]; then
      echo "gstack: fail revision — installed $installed is below the supported minimum $remote_min ($cause); fix: $fix (REVISION_BELOW_MINIMUM)"
      exit 1
    fi
    target=$(git -C "$root" rev-parse FETCH_HEAD)
    if channel_stable "$root" "$remote_min" && git -C "$root" merge-base --is-ancestor HEAD "$stable_sha" 2>/dev/null; then target=$stable_sha; fi
    if ! git -C "$root" merge --ff-only -q "$target" 2>/dev/null; then
      git -C "$root" fetch --quiet --unshallow origin "$default" 2>/dev/null
      git -C "$root" merge --ff-only -q "$target" 2>/dev/null \
        || { echo "gstack: fail revision — installed $installed is below the supported minimum $remote_min (fast-forward failed); fix: git -C $root status, then $fix_cmd (REVISION_BELOW_MINIMUM)"; exit 1; }
    fi
    echo "gstack-capy-skill: upgraded $installed -> $(head -1 "$root/VERSION")"
    export GSTACK_CAPY_UPGRADED_FROM="$installed"
  fi
fi

session="$root/bin/gstack-capy-session"
if [ ! -x "$session" ]; then
  echo "gstack: fail installer — checkout at $root (installed $(head -1 "$root/VERSION" 2>/dev/null || echo unknown)) predates bin/gstack-capy-session${min_note:+ and the $min_note}; fix: check network access to $(git -C "$root" remote get-url origin 2>/dev/null || echo "$repo"), then $fix_cmd (it fast-forwards a checkout below the supported minimum)"
  exit 1
fi
export GSTACK_CAPY_WRAPPER_REV="$GSTACK_CAPY_WRAPPER" GSTACK_CAPY_WRAPPER_PATH="$self" GSTACK_CAPY_REMOTE_MIN="${remote_min:-unknown}"
if [ -n "$remote_version" ]; then export GSTACK_CAPY_REMOTE_VERSION="$remote_version"; else unset GSTACK_CAPY_REMOTE_VERSION; fi
[ "$check" -eq 0 ] && export GSTACK_CAPY_LOCK_HELD=1
if [ "$check" -eq 1 ]; then
  exec "$session" --check --root "$root" ${args[@]+"${args[@]}"}
fi
exec "$session" --root "$root" ${args[@]+"${args[@]}"}
