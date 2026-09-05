#!/usr/bin/env bash
# Migration: v2.0.0.0 — remove the retired browser-surface skills from every
# installed skills tree, then shed the retired browse engine itself (daemon,
# binaries, extension, browser-skills runtime, Chromium profiles).
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

# ── The engine itself. v2.0 deleted the browse daemon sources (browse/src,
# browse/bin, browse/test), extension/ and browser-skills/ from the repo.
# browse/ itself STAYS: browse/SKILL.md.tmpl is the live Aside-powered /browse
# skill. After `git pull` the gitignored browse/dist binaries are the only
# leftover under browse/, and every host runtime root still links to them.
# User-authored skillify output (~/.gstack/browser-skills, <repo>/.gstack/
# browser-skills) is inert now but not ours to delete; it is left alone.
# Stop first: a daemon started pre-upgrade holds the old executable open.
_pid_of() { awk -F'[:,]' '/"pid"/ { for(i=1;i<=NF;i++) if($i ~ /"pid"/) { gsub(/[^0-9]/, "", $(i+1)); print $(i+1); exit } }' "$1" 2>/dev/null; }
_stop_daemon() {
  local pid; pid="$(_pid_of "$1")"
  { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; } || return 0
  # A stale pid file whose pid was recycled by an unrelated process: never kill
  # it. The real daemon's argv was `bun run <install>/browse/src/server.ts`
  # (or `node .../browse/dist/server-node.mjs` on Windows), so anchor on that
  # path: a bare `browse` would also match Firefox/Chrome helper processes
  # (`-isForBrowser`, `--browser-*`).
  ps -o command= -p "$pid" 2>/dev/null | grep -qE 'browse/(src|dist)/' || return 0
  kill "$pid" 2>/dev/null || return 0
  local i=0
  while [ "$i" -lt 4 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.5; i=$((i + 1)); done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  echo "  [v2.0.0.0] stopped browse daemon (PID $pid) from $1"
}
REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO" ] && _stop_daemon "$REPO/.gstack/browse.json"
_stop_daemon "$GH/browse.json"
if [ -d "$GH/projects" ]; then
  while IFS= read -r f; do _stop_daemon "$f"; done < <(find "$GH/projects" -name browse.json 2>/dev/null)
fi

_rm() { if [ -e "$1" ] || [ -L "$1" ]; then rm -rf "$1" && echo "  [v2.0.0.0] removed: $1"; fi; }
# Everything the daemon + terminal-agent wrote into a state dir (<repo>/.gstack
# or ~/.gstack): browse.json, browse-{console,network,dialog}.log,
# browse-audit.jsonl, browse-daemon.log*, browse-startup-error.log,
# browse-states/, and the terminal-agent's pid/tab/session records.
_rm_engine_state() {
  local f
  for f in "$1"/browse.json "$1"/browse-* "$1"/terminal-agent-pid "$1"/tabs.json "$1"/active-tab.json "$1"/claude-available.json "$1"/session-state.json; do _rm "$f"; done
}
_rm "$INSTALL_DIR/browse/dist"
for d in extension browser-skills; do _rm "$INSTALL_DIR/$d"; done
# Host runtime roots (setup: create_*_runtime_root, Kiro block) each carry a
# browse/ dir of links into the install's dist; the repo sidecars link browse/ whole.
for root in "${CODEX_HOME:-$HOME/.codex}/skills/gstack" "$HOME/.factory/skills/gstack" "$HOME/.config/opencode/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.kiro/skills/gstack"; do
  _rm "$root/browse"
done
if [ -n "$REPO" ]; then
  for root in "$REPO/.agents/skills/gstack" "$REPO/.cursor/skills/gstack"; do _rm "$root/browse"; done
  _rm_engine_state "$REPO/.gstack"
fi
_rm "$GH/chromium-profile"
_rm_engine_state "$GH"
for cache in "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright"; do
  [ -d "$cache" ] && echo "  [v2.0.0.0] hint: $cache is Playwright's Chromium download; gstack no longer uses it. Remove it if nothing else on this machine uses Playwright."
done

exit 0
