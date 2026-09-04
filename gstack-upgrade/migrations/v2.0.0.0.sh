#!/usr/bin/env bash
# Migration: v2.0.0.0 — remove the retired browser-surface skills from every
# installed skills tree.
#
# Why a migration: v2.0 consolidated gstack's own browser features (GStack
# Browser, cookie import, pair-agent, browser-skills) into the Aside browser
# and deleted the skill directories. `./setup` links the skills that exist in
# the source tree; it never reaps entries for skills that no longer exist, so
# every pre-v2 install keeps stale entries for /open-gstack-browser,
# /connect-chrome (a rewritten alias COPY, not a symlink), /pair-agent,
# /setup-browser-cookies and /skillify — dead slash commands that still show
# up in the host's skill list. gen-skill-docs never deletes stale out-dir
# renders either, so the per-host generated trees (.agents/.factory/.opencode/
# .cursor/skills) and the gbrain render dir keep serving the old bodies.
#
# Affected: every install upgraded from a version that shipped those skills,
# on every host (Claude, Codex, Factory, OpenCode, Cursor, Kiro).
#
# Safety: an entry is removed ONLY when its provenance is gstack — a symlink
# into a gstack install / generated tree / render dir, a directory whose
# SKILL.md symlinks into one, or a directory whose real-file SKILL.md is a
# gstack-generated copy (frontmatter name is one of the retired names AND the
# generated banner is present). A user's unrelated skill that happens to share
# a name is left alone. Idempotent (content-based, nothing to remove = no-op)
# and non-fatal (always exits 0).
#
# Env contract (gstack-upgrade Step 4.75 passes GSTACK_INSTALL_DIR only): the
# Claude skills dir is GSTACK_SKILLS_DIR when set, else the install's parent —
# a project-local install (<repo>/.claude/skills/gstack) must not no-op.
set -u

INSTALL_DIR="${GSTACK_INSTALL_DIR:-$HOME/.claude/skills/gstack}"
SKILLS_DIR="${GSTACK_SKILLS_DIR:-$(dirname "$INSTALL_DIR")}"
GH="${GSTACK_HOME:-$HOME/.gstack}"
RETIRED="connect-chrome open-gstack-browser pair-agent setup-browser-cookies skillify"
RETIRED_NAMES=" $RETIRED gstack-connect-chrome gstack-open-gstack-browser gstack-pair-agent gstack-setup-browser-cookies gstack-skillify "

# Provenance: anchored path segments (same as bin/gstack-uninstall — a bare
# *gstack* substring would match ~/tools/gstack-fork/), plus the two shapes
# setup produces with NO /gstack/ segment: the gbrain render dir (#2569,
# setup's cleanup_old_claude_symlinks special-cases it too) and the per-host
# generated trees that ~/.codex|.factory|.config/opencode|.cursor/skills
# entries link into.
_into_gstack() {
  case "$1" in
    gstack/*|*/gstack/*|*/.gstack/render/claude/*|*/.agents/skills/gstack-*|*/.factory/skills/gstack-*|*/.opencode/skills/gstack-*|*/.cursor/skills/gstack-*) return 0 ;;
    *) return 1 ;;
  esac
}

# Reap one entry ($1 = skills dir, $2 = entry name) when provenance is ours.
_reap() {
  local entry="$1/$2" md fm_name
  if [ -L "$entry" ]; then
    if _into_gstack "$(readlink "$entry" 2>/dev/null || true)"; then
      rm -f "$entry" && echo "  [v2.0.0.0] removed retired skill link: $entry"
    fi
  elif [ -d "$entry" ]; then
    md="$entry/SKILL.md"
    if [ -L "$md" ]; then
      if _into_gstack "$(readlink "$md" 2>/dev/null || true)"; then
        rm -rf "$entry" && echo "  [v2.0.0.0] removed retired skill dir: $entry"
      fi
    elif [ -f "$md" ]; then
      fm_name="$(sed -n '1,/^---$/ s/^name:[[:space:]]*//p' "$md" 2>/dev/null | head -1 | tr -d '[:space:]')"
      case "$RETIRED_NAMES" in
        *" $fm_name "*)
          if grep -q '<!-- AUTO-GENERATED from' "$md" 2>/dev/null; then
            rm -rf "$entry" && echo "  [v2.0.0.0] removed retired skill copy: $entry"
          fi ;;
      esac
    fi
  fi
}

# Every host skills dir setup can populate (setup: CODEX_SKILLS, FACTORY_SKILLS,
# OPENCODE_SKILLS, CURSOR_SKILLS, KIRO_SKILLS). Kiro entries are real dirs with
# sed-copied SKILL.md files — the banner arm of _reap covers them.
for dir in "$SKILLS_DIR" "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.factory/skills" "$HOME/.config/opencode/skills" "$HOME/.cursor/skills" "$HOME/.kiro/skills"; do
  [ -d "$dir" ] || continue
  for base in $RETIRED; do
    _reap "$dir" "$base"
    _reap "$dir" "gstack-$base"
  done
done

# Stale renders the reaped entries pointed at: the gbrain render dir and the
# per-host generated trees under the install. Only the retired names, only
# under dirs gstack itself writes.
for base in $RETIRED; do
  for d in "$GH/render/claude/$base" \
           "$INSTALL_DIR/.agents/skills/gstack-$base" "$INSTALL_DIR/.factory/skills/gstack-$base" \
           "$INSTALL_DIR/.opencode/skills/gstack-$base" "$INSTALL_DIR/.cursor/skills/gstack-$base"; do
    if [ -d "$d" ]; then
      rm -rf "$d" && echo "  [v2.0.0.0] removed stale render: $d"
    fi
  done
done

exit 0
