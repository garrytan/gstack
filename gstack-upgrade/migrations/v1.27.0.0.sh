#!/usr/bin/env bash
# Migration: v1.27.0.0 — rename gstack-brain-* → gstack-artifacts-*
#
# Phase C of the v1.27.0.0 plan. Hard-rename, no compat shim. Steps:
#   1. gh_repo_renamed       — gh/glab repo rename gstack-brain-$USER →
#                              gstack-artifacts-$USER (skipped on user opt-out)
#   2. remote_txt_renamed    — mv ~/.gstack-brain-remote.txt → artifacts-remote.txt
#   3. config_key_renamed    — rewrite gbrain_sync_mode → artifacts_sync_mode
#                              in ~/.gstack/config.yaml
#   4. claude_md_block_rewritten — find-and-replace any existing GBrain
#                              Configuration block that references "Memory sync"
#   5. sources_swapped       — gbrain sources add new (verify) → remove old
#                              (codex Finding #6: add-before-remove ordering)
#   6. done                  — write touchfile, delete journal
#
# Interruption-safe via journal at ~/.gstack/.migrations/v1.27.0.0.journal:
# each step writes its name on success; re-entry resumes from the next un-done
# step. Done touchfile at ~/.gstack/.migrations/v1.27.0.0.done.
#
# Three host-mode branches per the plan:
#   Local CLI + GitHub  — all steps run automatically
#   Local CLI + GitLab  — same with glab repo rename
#   Remote MCP only     — steps 1-4 still run; step 5 prints commands for
#                         the brain admin to run on the brain host
#
# All steps are idempotent. Re-running after partial completion is safe.
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  echo "  [v1.27.0.0] HOME is unset — skipping migration." >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GSTACK_HOME="${HOME}/.gstack"
SKILLS_DIR="${HOME}/.claude/skills"
BIN_DIR="${SKILLS_DIR}/gstack/bin"
CONFIG_BIN="${BIN_DIR}/gstack-config"
URL_BIN="${BIN_DIR}/gstack-artifacts-url"

MIGRATION_DIR="${GSTACK_HOME}/.migrations"
JOURNAL="${MIGRATION_DIR}/v1.27.0.0.journal"
DONE="${MIGRATION_DIR}/v1.27.0.0.done"
SKIPPED="${MIGRATION_DIR}/v1.27.0.0.skipped-by-user"

USER_NAME="${USER:-$(whoami 2>/dev/null || echo unknown)}"
OLD_REPO_NAME="gstack-brain-${USER_NAME}"
NEW_REPO_NAME="gstack-artifacts-${USER_NAME}"
OLD_REMOTE_TXT="${HOME}/.gstack-brain-remote.txt"
NEW_REMOTE_TXT="${HOME}/.gstack-artifacts-remote.txt"
OLD_SOURCE_ID="${OLD_REPO_NAME}"
NEW_SOURCE_ID="${NEW_REPO_NAME}"

# ---------------------------------------------------------------------------
# Journal helpers
# ---------------------------------------------------------------------------
mkdir -p "$MIGRATION_DIR"

# Already done? exit silently.
[ -f "$DONE" ] && exit 0

# User opted out previously? exit silently. (Re-invoke via
# `/setup-gbrain --rerun-migration` removes this marker.)
[ -f "$SKIPPED" ] && exit 0

journal_done() {
  # Returns 0 if the named step is recorded as complete in the journal.
  local step="$1"
  [ -f "$JOURNAL" ] && grep -q "^${step}$" "$JOURNAL" 2>/dev/null
}

mark_done() {
  local step="$1"
  echo "$step" >> "$JOURNAL"
}

# ---------------------------------------------------------------------------
# Detect environment + ask once if there's anything to migrate
# ---------------------------------------------------------------------------

# Has the user ever opted into brain sync? Two signals:
#   - presence of ~/.gstack-brain-remote.txt (legacy file)
#   - presence of ~/.gstack/.git (brain-init ever ran)
HAS_LEGACY_STATE=0
[ -f "$OLD_REMOTE_TXT" ] && HAS_LEGACY_STATE=1
[ -d "$GSTACK_HOME/.git" ] && HAS_LEGACY_STATE=1

# If nothing to migrate, finalize silently.
if [ "$HAS_LEGACY_STATE" = "0" ]; then
  echo "  [v1.27.0.0] no legacy gstack-brain state detected — nothing to migrate." >&2
  touch "$DONE"
  rm -f "$JOURNAL" 2>/dev/null || true
  exit 0
fi

# Ask once (idempotent: if journal exists from a prior partial run, skip ask).
if [ ! -f "$JOURNAL" ]; then
  cat >&2 <<EOF

  [v1.27.0.0] gstack-brain has been renamed to gstack-artifacts.
  This is a clearer name for what it actually holds: CEO plans, designs,
  /investigate reports, retros (i.e. artifacts, not behavioral memory).

  This migration will:
    1. Rename your private GitHub/GitLab repo "$OLD_REPO_NAME" → "$NEW_REPO_NAME"
    2. mv ~/.gstack-brain-remote.txt → ~/.gstack-artifacts-remote.txt
    3. Rename gbrain_sync_mode → artifacts_sync_mode in ~/.gstack/config.yaml
    4. Update any "## GBrain Configuration" block in CLAUDE.md
    5. Update gbrain federated source registration (local CLI mode)
       OR print commands for your brain admin (remote MCP mode)

  Each step is journaled so a Ctrl-C mid-flight is safe to re-run.

EOF
  if [ -t 0 ]; then
    printf "  Proceed? [Y/n/skip-for-now]: " >&2
    read -r REPLY || REPLY=""
    case "$REPLY" in
      n|N|no|No|NO)
        echo "  Skipping migration. Re-run via /setup-gbrain --rerun-migration." >&2
        touch "$SKIPPED"
        exit 0
        ;;
      skip|skip-for-now|s)
        echo "  Skipping for now. Will ask again next upgrade." >&2
        # Don't write SKIPPED — leave both old + new state untouched, ask again next time.
        exit 0
        ;;
    esac
  else
    # Non-interactive (CI, scripted upgrade): proceed automatically.
    echo "  (non-interactive: proceeding automatically)" >&2
  fi
fi

# ---------------------------------------------------------------------------
# Detect host (gh / glab / manual) for steps 1 + 5
# ---------------------------------------------------------------------------
detect_host() {
  # Read the canonical-form remote URL (the legacy file in the migration window).
  local url=""
  if [ -f "$OLD_REMOTE_TXT" ]; then
    url=$(head -1 "$OLD_REMOTE_TXT" 2>/dev/null | tr -d '[:space:]' || echo "")
  elif [ -f "$NEW_REMOTE_TXT" ]; then
    url=$(head -1 "$NEW_REMOTE_TXT" 2>/dev/null | tr -d '[:space:]' || echo "")
  fi
  if echo "$url" | grep -q 'github\.com'; then
    echo "github"
  elif echo "$url" | grep -q 'gitlab'; then
    echo "gitlab"
  else
    echo "manual"
  fi
}

HOST=$(detect_host)

# ---------------------------------------------------------------------------
# Detect MCP mode (so step 5 knows whether to execute or print)
# ---------------------------------------------------------------------------
detect_mcp_mode() {
  # Cheap probe: ~/.claude.json type field. Defense-in-depth tier 3 only;
  # the migration script avoids invoking `claude` to keep upgrade fast.
  if command -v jq >/dev/null 2>&1 && [ -f "$HOME/.claude.json" ]; then
    local t
    t=$(jq -r '.mcpServers.gbrain.type // .mcpServers.gbrain.transport // empty' "$HOME/.claude.json" 2>/dev/null)
    case "$t" in
      url|http|sse) echo "remote-http"; return ;;
      stdio) echo "local-stdio"; return ;;
    esac
  fi
  echo "none"
}

MCP_MODE=$(detect_mcp_mode)

# ---------------------------------------------------------------------------
# Step 1: gh/glab repo rename
# ---------------------------------------------------------------------------
if ! journal_done "gh_repo_renamed"; then
  echo "  [v1.27.0.0] step 1: rename remote repo $OLD_REPO_NAME → $NEW_REPO_NAME" >&2
  case "$HOST" in
    github)
      if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
        # Idempotent: if new name already exists, treat as success.
        if gh repo view "$NEW_REPO_NAME" >/dev/null 2>&1; then
          echo "    repo already named $NEW_REPO_NAME on GitHub — no-op" >&2
          mark_done "gh_repo_renamed"
        else
          if gh repo rename "$NEW_REPO_NAME" --repo "$OLD_REPO_NAME" --yes 2>/dev/null \
              || gh repo edit "$OLD_REPO_NAME" --name "$NEW_REPO_NAME" 2>/dev/null; then
            echo "    renamed on GitHub" >&2
            mark_done "gh_repo_renamed"
          else
            echo "    WARNING: gh rename failed (repo may not exist or permission denied)" >&2
            echo "    skipping step 1; subsequent steps still run" >&2
            mark_done "gh_repo_renamed"
          fi
        fi
      else
        echo "    gh CLI not available — skipping rename step (manual: gh repo rename ...)" >&2
        mark_done "gh_repo_renamed"
      fi
      ;;
    gitlab)
      if command -v glab >/dev/null 2>&1 && glab auth status >/dev/null 2>&1; then
        if glab repo view "$NEW_REPO_NAME" >/dev/null 2>&1; then
          echo "    repo already named $NEW_REPO_NAME on GitLab — no-op" >&2
          mark_done "gh_repo_renamed"
        else
          # GitLab CLI doesn't have a direct rename; user has to do it via API.
          echo "    glab repo rename isn't a single command on GitLab." >&2
          echo "    Manual: visit your GitLab project Settings → General → Advanced → Rename" >&2
          echo "    or use: glab api projects/:id -X PUT -f name=$NEW_REPO_NAME -f path=$NEW_REPO_NAME" >&2
          mark_done "gh_repo_renamed"
        fi
      else
        echo "    glab not available — manual rename required" >&2
        mark_done "gh_repo_renamed"
      fi
      ;;
    manual|*)
      echo "    unknown host (not github/gitlab) — manual rename required" >&2
      mark_done "gh_repo_renamed"
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Step 2: rename ~/.gstack-brain-remote.txt → ~/.gstack-artifacts-remote.txt
# ---------------------------------------------------------------------------
if ! journal_done "remote_txt_renamed"; then
  echo "  [v1.27.0.0] step 2: rename ~/.gstack-brain-remote.txt → ~/.gstack-artifacts-remote.txt" >&2
  if [ -f "$OLD_REMOTE_TXT" ] && [ ! -f "$NEW_REMOTE_TXT" ]; then
    # Update the URL inside if the rename happened on the host: replace
    # gstack-brain-$USER with gstack-artifacts-$USER in the URL.
    OLD_URL=$(head -1 "$OLD_REMOTE_TXT" 2>/dev/null)
    NEW_URL=$(echo "$OLD_URL" | sed "s|/${OLD_REPO_NAME}|/${NEW_REPO_NAME}|; s|:${OLD_REPO_NAME}|:${NEW_REPO_NAME}|")
    echo "$NEW_URL" > "$NEW_REMOTE_TXT"
    chmod 600 "$NEW_REMOTE_TXT"
    rm -f "$OLD_REMOTE_TXT"
    echo "    moved + URL rewritten: $OLD_URL → $NEW_URL" >&2
  elif [ -f "$NEW_REMOTE_TXT" ]; then
    echo "    new file already exists — no-op" >&2
    rm -f "$OLD_REMOTE_TXT" 2>/dev/null || true
  else
    echo "    no $OLD_REMOTE_TXT to migrate — no-op" >&2
  fi
  mark_done "remote_txt_renamed"
fi

# ---------------------------------------------------------------------------
# Step 3: rename gbrain_sync_mode → artifacts_sync_mode in config.yaml
# ---------------------------------------------------------------------------
if ! journal_done "config_key_renamed"; then
  echo "  [v1.27.0.0] step 3: rename gbrain_sync_mode → artifacts_sync_mode in config.yaml" >&2
  CFG="$GSTACK_HOME/config.yaml"
  if [ -f "$CFG" ]; then
    # Atomic in-place rewrite with a tmpfile.
    TMP=$(mktemp "${CFG}.v1.27.0.0.XXXXXX")
    sed -e 's/^gbrain_sync_mode:/artifacts_sync_mode:/' \
        -e 's/^gbrain_sync_mode_prompted:/artifacts_sync_mode_prompted:/' \
        "$CFG" > "$TMP" && mv "$TMP" "$CFG"
    echo "    rewritten in place" >&2
  else
    echo "    no $CFG to migrate — no-op" >&2
  fi
  mark_done "config_key_renamed"
fi

# ---------------------------------------------------------------------------
# Step 4: rewrite CLAUDE.md "## GBrain Configuration" block fields
# ---------------------------------------------------------------------------
if ! journal_done "claude_md_block_rewritten"; then
  echo "  [v1.27.0.0] step 4: rewrite CLAUDE.md GBrain Configuration block fields" >&2
  # Look in cwd's CLAUDE.md (where /setup-gbrain wrote it) and ~/.gstack/CLAUDE.md
  # if it exists. We can't know every project's CLAUDE.md; users rerunning
  # /setup-gbrain in any project will overwrite that block fresh anyway.
  for CMD in "$PWD/CLAUDE.md" "$GSTACK_HOME/CLAUDE.md"; do
    [ -f "$CMD" ] || continue
    if grep -q "## GBrain Configuration" "$CMD"; then
      TMP=$(mktemp "${CMD}.v1.27.0.0.XXXXXX")
      sed -e 's/^- Memory sync:/- Artifacts sync:/' "$CMD" > "$TMP" && mv "$TMP" "$CMD"
      echo "    rewritten field in $CMD" >&2
    fi
  done
  mark_done "claude_md_block_rewritten"
fi

# ---------------------------------------------------------------------------
# Step 5: gbrain sources swap (add-new before remove-old per codex Finding #6)
# ---------------------------------------------------------------------------
if ! journal_done "sources_swapped"; then
  echo "  [v1.27.0.0] step 5: gbrain federated source rename" >&2
  if [ "$MCP_MODE" = "remote-http" ]; then
    # Print commands for the brain admin; we can't execute them locally.
    cat >&2 <<EOF
    Remote MCP detected. The local gbrain CLI can't update the brain's
    federated source registration. Send this to your brain admin:

      gbrain sources add ${NEW_SOURCE_ID} --path <new-clone-path> --federated
      # verify the new source is searching as expected, then:
      gbrain sources remove ${OLD_SOURCE_ID} --yes

    (Add-new before remove-old keeps search uninterrupted.)

EOF
    mark_done "sources_swapped"
  elif command -v gbrain >/dev/null 2>&1 && [ -d "$GSTACK_HOME/.git" ]; then
    # Local CLI mode. Sources point at the worktree path; rename the source
    # ID add-then-remove. The actual on-disk worktree path stays the same.
    WORKTREE="${GSTACK_BRAIN_WORKTREE:-$HOME/.gstack-brain-worktree}"
    if gbrain sources list 2>/dev/null | grep -q "$OLD_SOURCE_ID"; then
      if gbrain sources add "$NEW_SOURCE_ID" --path "$WORKTREE" --federated 2>/dev/null; then
        echo "    added $NEW_SOURCE_ID" >&2
        if gbrain sources remove "$OLD_SOURCE_ID" --yes 2>/dev/null; then
          echo "    removed $OLD_SOURCE_ID" >&2
        else
          echo "    WARNING: failed to remove $OLD_SOURCE_ID; both registered. Run manually:" >&2
          echo "    gbrain sources remove $OLD_SOURCE_ID --yes" >&2
        fi
      else
        echo "    WARNING: failed to add $NEW_SOURCE_ID. Old source still registered." >&2
      fi
    else
      echo "    no $OLD_SOURCE_ID source registered — no-op" >&2
    fi
    mark_done "sources_swapped"
  else
    echo "    gbrain CLI not available or no ~/.gstack/.git — skipping" >&2
    mark_done "sources_swapped"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: finalize (touchfile + clear journal)
# ---------------------------------------------------------------------------
touch "$DONE"
rm -f "$JOURNAL"

echo "  [v1.27.0.0] migration complete." >&2
exit 0
