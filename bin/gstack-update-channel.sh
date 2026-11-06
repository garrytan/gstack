#!/usr/bin/env bash
# gstack-update-channel.sh — which branch of garrytan/gstack an install follows.
#
# Sourced by bin/gstack-session-update, bin/gstack-update-check and
# bin/gstack-upgrade; runnable by the /gstack-upgrade skill. Bash 3.2 plus git.
#
# Channels (docs/releases.md):
#   main    every merge to main (a version per merge, a dozen a day)
#   stable  the twice-weekly tagged release: refs/heads/stable on origin, moved only
#           forward along main's first-parent history by the release workflow
#
# The config key update_channel (bin/gstack-config) is auto | stable | main.
# ./setup records it once, on a fresh state root (gstack_update_channel_initial):
# stable for a user's checkout, the GSTACK_UPDATE_CHANNEL value when one is set,
# and nothing for a contributor checkout. auto, which every install set up
# before that record existed still has, is stable when team_mode is true and
# main otherwise, so an existing install keeps the branch it followed.
# GSTACK_UPDATE_CHANNEL overrides the config (tests, a one-off command, Capy
# sessions: bin/gstack-capy-session pins main). Any other value counts as auto.
#
# Functions (never fail; a broken config means main, the behaviour before
# channels existed):
#   gstack_update_channel <install dir>          prints stable | main
#   gstack_update_channel_refspec <channel>      prints the fetch refspec for
#                                                stable, "" for main (callers
#                                                keep their @{upstream} /
#                                                default-branch path)
#   gstack_update_channel_missing <git stderr>   true when a fetch failed only
#                                                because origin has no such ref
#                                                (no release cut yet): callers
#                                                fall back to main
#
#   gstack_update_channel_initial <install dir> <state root>
#                                                setup's first-install choice:
#                                                prints `<stable|main|auto> <why>`
#                                                (auto records nothing), or
#                                                nothing for an existing install
#
# CLI (the /gstack-upgrade skill): `bash bin/gstack-update-channel.sh [--fetch-ref] [<install dir>]`
#   (./setup: `--initial <state root> <install dir>` prints gstack_update_channel_initial)
#   prints the channel; --fetch-ref fetches the channel ref from origin and
#   prints the revision to fast-forward to (origin/stable or origin/main),
#   falling back to origin/main only when origin has no stable yet. Any other
#   fetch failure keeps origin/stable (the fast-forward then stops or finds
#   nothing new); a team install never moves to main because the network
#   blinked.

gstack_update_channel() {
  _uc_dir=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
  _uc_value=${GSTACK_UPDATE_CHANNEL:-}
  if [ -z "$_uc_value" ] && [ -x "$_uc_dir/bin/gstack-config" ]; then
    _uc_value=$("$_uc_dir/bin/gstack-config" get update_channel 2>/dev/null) || _uc_value=""
  fi
  case "$_uc_value" in
    stable|main) printf '%s\n' "$_uc_value"; return 0 ;;
  esac
  _uc_team=""
  [ -x "$_uc_dir/bin/gstack-config" ] && { _uc_team=$("$_uc_dir/bin/gstack-config" get team_mode 2>/dev/null) || _uc_team=""; }
  if [ "$_uc_team" = true ]; then printf 'stable\n'; else printf 'main\n'; fi
}

gstack_update_channel_refspec() {
  case "${1:-}" in stable) printf '+refs/heads/stable:refs/remotes/origin/stable\n' ;; *) printf '\n' ;; esac
}

gstack_update_channel_missing() {
  printf '%s' "${1:-}" | grep -qiE "couldn't find remote ref|no such ref was fetched|invalid refspec" 2>/dev/null
}

# A state root (or the legacy ~/.gstack) that holds a setup marker or a config
# is an existing install: it keeps auto, so nothing changes under it. A Capy
# machine (CAPY_MACHINE_CONFIG or ~/.capy/system, as bin/gstack-capy-install
# detects it) records main, even for a ./setup run outside a Capy session. A contributor checkout keeps
# auto too: gstack.contributor (bin/dev-setup) or GSTACK_CONTRIBUTOR=1, CI, a
# checkout that is not its own git repository, a detached HEAD, a branch other
# than origin's default, no upstream, or commits the upstream does not have.
gstack_update_channel_initial() {
  _uc_dir=$1 _uc_state=$2
  for _uc_m in "$_uc_state/.last-setup-version" "$_uc_state/config.yaml" "$HOME/.gstack/.last-setup-version" "$HOME/.gstack/config.yaml"; do
    [ -e "$_uc_m" ] && return 0
  done
  case "${GSTACK_UPDATE_CHANNEL:-}" in stable|main) printf '%s set by GSTACK_UPDATE_CHANNEL at install\n' "$GSTACK_UPDATE_CHANNEL"; return 0 ;; esac
  if [ -n "${CAPY_MACHINE_CONFIG:-}" ] || [ -d "$HOME/.capy/system" ]; then printf 'main Capy machine: crews follow every merge\n'; return 0; fi
  if [ "${GSTACK_CONTRIBUTOR:-}" = 1 ] || [ "$(git -C "$_uc_dir" config --bool --get gstack.contributor 2>/dev/null)" = true ]; then
    printf 'auto contributor checkout: gstack.contributor is set\n'; return 0
  fi
  [ -z "${CI:-}" ] || { printf 'auto contributor checkout: CI\n'; return 0; }
  _uc_top=$(git -C "$_uc_dir" rev-parse --show-toplevel 2>/dev/null) && _uc_top=$(cd "$_uc_top" && pwd -P) || _uc_top=""
  [ -n "$_uc_top" ] && [ "$_uc_top" = "$(cd "$_uc_dir" && pwd -P)" ] || { printf 'auto not a git checkout of its own\n'; return 0; }
  _uc_branch=$(git -C "$_uc_dir" symbolic-ref -q --short HEAD 2>/dev/null) || { printf 'auto contributor checkout: HEAD is detached\n'; return 0; }
  _uc_default=$(git -C "$_uc_dir" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null) || _uc_default=origin/main
  [ "$_uc_branch" = "${_uc_default#origin/}" ] || { printf 'auto contributor checkout: on branch %s\n' "$_uc_branch"; return 0; }
  _uc_up=$(git -C "$_uc_dir" rev-parse -q --verify '@{upstream}' 2>/dev/null) || { printf 'auto contributor checkout: no upstream branch\n'; return 0; }
  [ "$(git -C "$_uc_dir" rev-list --count "$_uc_up..HEAD" 2>/dev/null)" = 0 ] || { printf 'auto contributor checkout: local commits\n'; return 0; }
  printf 'stable new install\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _uc_fetch=0 _uc_arg=""
  if [ "${1:-}" = --initial ]; then
    [ -n "${2:-}" ] || { echo "usage: gstack-update-channel.sh --initial <state root> [<install dir>]" >&2; exit 2; }
    gstack_update_channel_initial "${3:-$(cd "$(dirname "$0")/.." && pwd)}" "$2"; exit 0
  fi
  for _uc_a in "$@"; do
    case "$_uc_a" in
      --fetch-ref) _uc_fetch=1 ;;
      -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) _uc_arg=$_uc_a ;;
    esac
  done
  _uc_root=${_uc_arg:-$(cd "$(dirname "$0")/.." && pwd)}
  _uc_ch=$(gstack_update_channel "$_uc_root")
  if [ "$_uc_fetch" -eq 0 ]; then printf '%s\n' "$_uc_ch"; exit 0; fi
  # Egress receipts for the fetches below, fail-open like /gstack-upgrade's own.
  . "$(dirname "$0")/gstack-egress-lib.sh" 2>/dev/null || _receipted_git() { shift 5; "$@"; }
  _uc_host=$(git -C "$_uc_root" remote get-url origin 2>/dev/null); _uc_host=${_uc_host#*://}; _uc_host=${_uc_host#*@}; _uc_host=${_uc_host%%[/:]*}
  export GIT_TERMINAL_PROMPT=0
  if [ "$_uc_ch" = stable ]; then
    _uc_err=$(_receipted_git open gstack-upgrade "${_uc_host:-unknown}" gstack-self-update-pull "user ran /gstack-upgrade" git -C "$_uc_root" fetch -q origin "$(gstack_update_channel_refspec stable)" 2>&1 >/dev/null) \
      && { printf 'origin/stable\n'; exit 0; }
    if gstack_update_channel_missing "$_uc_err"; then
      echo "gstack-update-channel: origin has no stable release yet; following origin/main until the first stable release is cut" >&2
    else
      echo "gstack-update-channel: fetching origin/stable failed ($(printf '%s' "$_uc_err" | head -1 | head -c 200)); staying on origin/stable as last fetched" >&2
      printf 'origin/stable\n'; exit 0
    fi
  fi
  _receipted_git open gstack-upgrade "${_uc_host:-unknown}" gstack-self-update-pull "user ran /gstack-upgrade" git -C "$_uc_root" fetch -q origin 2>/dev/null || true
  printf 'origin/main\n'
fi
