#!/usr/bin/env bash
# Migration: v1.91.58.0 — install footprint (#1694). The release queue may
# rename this file at /ship; it must match VERSION.
#
# Installs used to render every host's skills inside the checkout, so a global
# Claude install carried ~576 extra SKILL.md files (32 MB) that Claude Code and
# Cursor-agent scan. Record the hosts this install already serves (registry
# rows, install roots that resolve here, host skills that link into its
# renders), then prune the renders of every other host with
# bin/gstack-host-renders.sh: generated files are backed up under
# $GSTACK_STATE_ROOT/backups/host-renders/, anything not proven generated stays.
# ./setup runs the same prune on every run; this covers an install upgraded
# without one. Idempotent and non-fatal.
set -u
_gstack_migration_dir="${BASH_SOURCE[0]//\\//}"; _gstack_migration_dir="${_gstack_migration_dir%/*}"
_gstack_bin="${_gstack_migration_dir}/../../bin"
. "$_gstack_bin/gstack-state-root.sh" 2>/dev/null || { echo "$0: cannot resolve the gstack state root: $_gstack_bin/gstack-state-root.sh is missing. fix: reinstall with ./setup or /gstack-upgrade (docs/state-root.md)" >&2; exit 1; }
gstack_state_root_select; GSTACK_STATE_ROOT="$_gstack_sr_root"
. "$_gstack_bin/gstack-install-registry.sh" 2>/dev/null || exit 0
. "$_gstack_bin/gstack-host-renders.sh" 2>/dev/null || exit 0

INSTALL="${GSTACK_INSTALL_DIR:-${HOME:-}/.claude/skills/gstack}"
[ -f "$INSTALL/VERSION" ] && [ -f "$INSTALL/setup" ] || exit 0

gstack_render_hosts_seed "$INSTALL"
if [ ! -f "$(gstack_render_hosts_file "$INSTALL")" ]; then
  echo "host renders: no install from $INSTALL was found, so its renders were left alone; ./setup --host <name> records and prunes"
  exit 0
fi
gstack_prune_host_renders "$INSTALL" || echo "host renders: some generated files could not be backed up and were left in place; the next ./setup retries" >&2
exit 0
