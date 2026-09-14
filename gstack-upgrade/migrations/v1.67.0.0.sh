#!/usr/bin/env bash
# Migration: v1.67.0.0 — restore tracked files dirtied by the legacy in-place
# gbrain render (#2569, F12).
#
# Why a migration: pre-v1.67, gbrain-enabled setups ran `gen:skill-docs:user
# --host claude` IN PLACE inside the global install checkout
# (~/.claude/skills/gstack), rewriting ~16 TRACKED SKILL.md files. The
# checkout stayed permanently dirty, and every /gstack-upgrade `git stash`
# saved a redundant snapshot of generated content — stashes that invite a
# dangerous `git stash pop` of stale instruction markdown over a newer
# version. v1.67 renders to an untracked out-dir (~/.gstack/render/claude)
# instead, so this migration does the ONE-TIME cleanup of the legacy dirt:
# `git checkout --` on the modified generated files.
#
# Restore scope is deliberately narrow: only UNSTAGED MODIFIED files whose
# path is a SKILL.md or lives under a sections/ directory — the exact
# footprint of the legacy render. Anything else a user changed by hand
# (untracked files, staged work, non-generated edits) is left alone and
# reported. setup's gbrain step re-renders the brain-aware variant into the
# out-dir immediately after migrations run, so no capability is lost.
#
# Affected: global-git installs that ever ran ./setup or `gstack-config
# gbrain-refresh` with gbrain detected, before v1.67.0.0.
#
# Idempotent: a clean checkout is a no-op. Non-fatal throughout.
set -u

INSTALL_DIR="${GSTACK_INSTALL_DIR:-$HOME/.claude/skills/gstack}"

# Only operate on a real (non-symlink) git checkout that looks like gstack.
[ -d "$INSTALL_DIR" ] || exit 0
[ -L "$INSTALL_DIR" ] && exit 0
[ -f "$INSTALL_DIR/VERSION" ] || exit 0
git -C "$INSTALL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

_DIRTY="$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)"
[ -n "$_DIRTY" ] || exit 0

_RESTORED=0
_LEFT=0
while IFS= read -r _LINE; do
  [ -n "$_LINE" ] || continue
  _CODE="${_LINE:0:2}"
  _PATH="${_LINE:3}"
  # Legacy render footprint: unstaged modifications to generated markdown.
  case "$_CODE" in
    " M")
      case "$_PATH" in
        SKILL.md|*/SKILL.md|*/sections/*.md)
          if git -C "$INSTALL_DIR" checkout -- "$_PATH" 2>/dev/null; then
            _RESTORED=$((_RESTORED + 1))
          else
            _LEFT=$((_LEFT + 1))
          fi
          ;;
        *) _LEFT=$((_LEFT + 1)) ;;
      esac
      ;;
    *) _LEFT=$((_LEFT + 1)) ;;
  esac
done <<EOF_DIRTY
$_DIRTY
EOF_DIRTY

if [ "$_RESTORED" -gt 0 ]; then
  echo "  v1.67.0.0: restored $_RESTORED tracked file(s) dirtied by the legacy in-place gbrain render (#2569)."
  echo "  Brain-aware blocks now render to ~/.gstack/render/claude — the checkout stays clean from here on."
fi
if [ "$_LEFT" -gt 0 ]; then
  echo "  v1.67.0.0: left $_LEFT non-render change(s) in $INSTALL_DIR untouched (not the legacy render footprint)."
fi

exit 0
