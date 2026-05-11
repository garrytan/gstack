---
name: gstack-upgrade
version: 1.1.0
description: |
  Upgrade gstack to the latest version. Detects global vs vendored install,
  runs the upgrade, and shows what's new. Use when asked to "upgrade gstack",
  "update gstack", or "get latest version".
  Voice triggers (speech-to-text aliases): "upgrade the tools", "update the tools", "gee stack upgrade", "g stack upgrade".
triggers:
  - upgrade gstack
  - update gstack version
  - get latest gstack
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /gstack-upgrade

Upgrade gstack to the latest version and show what's new.

## Inline upgrade flow

This section is referenced by all skill preambles when they detect `UPGRADE_AVAILABLE`.

### Step 1: Ask the user (or auto-upgrade)

First, check if auto-upgrade is enabled:
```bash
_AUTO=""
[ "${GSTACK_AUTO_UPGRADE:-}" = "1" ] && _AUTO="true"
[ -z "$_AUTO" ] && _AUTO=$(~/.claude/skills/gstack/bin/gstack-config get auto_upgrade 2>/dev/null || true)
echo "AUTO_UPGRADE=$_AUTO"
```

**If `AUTO_UPGRADE=true` or `AUTO_UPGRADE=1`:** Skip AskUserQuestion. Log "Auto-upgrading gstack v{old} → v{new}..." and proceed directly to Step 2. If `./setup` fails during auto-upgrade, restore from backup when a `.bak` directory exists; for git installs, leave the merge state intact and warn the user: "Auto-upgrade failed — resolve the install at `$INSTALL_DIR` and run `/gstack-upgrade` manually to retry."

**Otherwise**, use AskUserQuestion:
- Question: "gstack **v{new}** is available (you're on v{old}). Upgrade now?"
- Options: ["Yes, upgrade now", "Always keep me up to date", "Not now", "Never ask again"]

**If "Yes, upgrade now":** Proceed to Step 2.

**If "Always keep me up to date":**
```bash
~/.claude/skills/gstack/bin/gstack-config set auto_upgrade true
```
Tell user: "Auto-upgrade enabled. Future updates will install automatically." Then proceed to Step 2.

**If "Not now":** Write snooze state with escalating backoff (first snooze = 24h, second = 48h, third+ = 1 week), then continue with the current skill. Do not mention the upgrade again.
```bash
_SNOOZE_FILE="$HOME/.gstack/update-snoozed"
_REMOTE_VER="{new}"
_CUR_LEVEL=0
if [ -f "$_SNOOZE_FILE" ]; then
  _SNOOZED_VER=$(awk '{print $1}' "$_SNOOZE_FILE")
  if [ "$_SNOOZED_VER" = "$_REMOTE_VER" ]; then
    _CUR_LEVEL=$(awk '{print $2}' "$_SNOOZE_FILE")
    case "$_CUR_LEVEL" in *[!0-9]*) _CUR_LEVEL=0 ;; esac
  fi
fi
_NEW_LEVEL=$((_CUR_LEVEL + 1))
[ "$_NEW_LEVEL" -gt 3 ] && _NEW_LEVEL=3
echo "$_REMOTE_VER $_NEW_LEVEL $(date +%s)" > "$_SNOOZE_FILE"
```
Note: `{new}` is the remote version from the `UPGRADE_AVAILABLE` output — substitute it from the update check result.

Tell user the snooze duration: "Next reminder in 24h" (or 48h or 1 week, depending on level). Tip: "Set `auto_upgrade: true` in `~/.gstack/config.yaml` for automatic upgrades."

**If "Never ask again":**
```bash
~/.claude/skills/gstack/bin/gstack-config set update_check false
```
Tell user: "Update checks disabled. Run `~/.claude/skills/gstack/bin/gstack-config set update_check true` to re-enable."
Continue with the current skill.

### Step 2: Detect install type

```bash
if [ -d "$HOME/.claude/skills/gstack/.git" ]; then
  INSTALL_TYPE="global-git"
  INSTALL_DIR="$HOME/.claude/skills/gstack"
elif [ -d "$HOME/.gstack/repos/gstack/.git" ]; then
  INSTALL_TYPE="global-git"
  INSTALL_DIR="$HOME/.gstack/repos/gstack"
elif [ -d ".claude/skills/gstack/.git" ]; then
  INSTALL_TYPE="local-git"
  INSTALL_DIR=".claude/skills/gstack"
elif [ -d ".agents/skills/gstack/.git" ]; then
  INSTALL_TYPE="local-git"
  INSTALL_DIR=".agents/skills/gstack"
elif [ -d ".claude/skills/gstack" ]; then
  INSTALL_TYPE="vendored"
  INSTALL_DIR=".claude/skills/gstack"
elif [ -d "$HOME/.claude/skills/gstack" ]; then
  INSTALL_TYPE="vendored-global"
  INSTALL_DIR="$HOME/.claude/skills/gstack"
else
  echo "ERROR: gstack not found"
  exit 1
fi
echo "Install type: $INSTALL_TYPE at $INSTALL_DIR"
```

The install type and directory path printed above will be used in all subsequent steps.

### Step 3: Save old version

Use the install directory from Step 2's output below:

```bash
OLD_VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
```

### Step 4: Upgrade

Use the install type and directory detected in Step 2:

**Core rule:** preserve the user's own gstack version. Do not replace a customized
install with a hard reset. Fetch upstream, merge it into the current local
version, then run setup. If a merge conflict appears, stop and tell the user the
upgrade needs manual conflict resolution in `$INSTALL_DIR`; do not continue to
migrations or cache clearing.

**For git installs** (global-git, local-git):
```bash
cd "$INSTALL_DIR"
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
if [ -z "$CURRENT_BRANCH" ]; then
  CURRENT_BRANCH="gstack-local"
  git switch "$CURRENT_BRANCH" 2>/dev/null || git switch -c "$CURRENT_BRANCH"
fi

STASH_OUTPUT=""
if [ -n "$(git status --porcelain)" ]; then
  STASH_OUTPUT=$(git stash push -u -m "gstack-upgrade local changes $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>&1)
fi

git fetch origin main
if ! git merge --no-edit origin/main; then
  echo "ERROR: gstack upgrade merge has conflicts in $INSTALL_DIR"
  echo "Resolve conflicts, run ./setup, then rerun /gstack-upgrade if needed."
  exit 1
fi

if echo "$STASH_OUTPUT" | grep -q "Saved working directory"; then
  if ! git stash pop; then
    echo "ERROR: stashed local changes conflicted after the upgrade merge."
    echo "Resolve conflicts in $INSTALL_DIR, run ./setup, then rerun /gstack-upgrade if needed."
    exit 1
  fi
fi

if ! ./setup; then
  echo "ERROR: ./setup failed after merging upstream."
  exit 1
fi
```
If `$STASH_OUTPUT` contains "Saved working directory", tell the user: "Local uncommitted changes were stashed before the upstream merge and reapplied after it."

**For vendored installs** (vendored, vendored-global):
```bash
PARENT=$(dirname "$INSTALL_DIR")
TMP_DIR=$(mktemp -d)
git clone https://github.com/garrytan/gstack.git "$TMP_DIR/gstack"
mv "$INSTALL_DIR" "$INSTALL_DIR.bak"
cd "$TMP_DIR/gstack"

if [ "$OLD_VERSION" != "unknown" ] && git rev-parse "v$OLD_VERSION" >/dev/null 2>&1; then
  git switch -c gstack-local "v$OLD_VERSION"
else
  echo "ERROR: cannot preserve customized vendored install safely; missing upstream tag v$OLD_VERSION."
  echo "Restored previous vendored copy. Convert it to a git install or upgrade manually."
  rm -rf "$INSTALL_DIR"
  mv "$INSTALL_DIR.bak" "$INSTALL_DIR"
  rm -rf "$TMP_DIR"
  exit 1
fi

rsync -a --delete --exclude .git "$INSTALL_DIR.bak"/ "$TMP_DIR/gstack"/
git add -A
git -c user.email=gstack-upgrade@example.invalid -c user.name=gstack-upgrade \
  commit -m "Preserve local gstack customization before upgrade" 2>/dev/null || true
git fetch origin main
if ! git merge --no-edit origin/main; then
  echo "ERROR: gstack vendored upgrade merge has conflicts in $TMP_DIR/gstack"
  echo "Restored previous vendored copy at $INSTALL_DIR."
  rm -rf "$INSTALL_DIR"
  mv "$INSTALL_DIR.bak" "$INSTALL_DIR"
  exit 1
fi

mv "$TMP_DIR/gstack" "$INSTALL_DIR"
if ! (cd "$INSTALL_DIR" && ./setup); then
  rm -rf "$INSTALL_DIR"
  mv "$INSTALL_DIR.bak" "$INSTALL_DIR"
  echo "ERROR: ./setup failed — restored previous vendored copy."
  exit 1
fi
rm -rf "$INSTALL_DIR.bak" "$TMP_DIR"
```
Tell user: "Converted vendored gstack to a git-backed local customization branch, merged upstream, and preserved the previous copy in git history."

### Step 4.5: Handle local vendored copy

Use the install directory from Step 2. Check if there's also a local vendored copy, and whether team mode is active:

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
LOCAL_GSTACK=""
if [ -n "$_ROOT" ] && [ -d "$_ROOT/.claude/skills/gstack" ]; then
  _RESOLVED_LOCAL=$(cd "$_ROOT/.claude/skills/gstack" && pwd -P)
  _RESOLVED_PRIMARY=$(cd "$INSTALL_DIR" && pwd -P)
  if [ "$_RESOLVED_LOCAL" != "$_RESOLVED_PRIMARY" ]; then
    LOCAL_GSTACK="$_ROOT/.claude/skills/gstack"
  fi
fi
_TEAM_MODE=$(~/.claude/skills/gstack/bin/gstack-config get team_mode 2>/dev/null || echo "false")
echo "LOCAL_GSTACK=$LOCAL_GSTACK"
echo "TEAM_MODE=$_TEAM_MODE"
```

**If `LOCAL_GSTACK` is non-empty AND `TEAM_MODE` is `true`:** Remove the vendored copy. Team mode uses the global install as the single source of truth.

```bash
cd "$_ROOT"
git rm -r --cached .claude/skills/gstack/ 2>/dev/null || true
if ! grep -qF '.claude/skills/gstack/' .gitignore 2>/dev/null; then
  echo '.claude/skills/gstack/' >> .gitignore
fi
rm -rf "$LOCAL_GSTACK"
```
Tell user: "Removed vendored copy at `$LOCAL_GSTACK` (team mode active — global install is the source of truth). Commit the `.gitignore` change when ready."

**If `LOCAL_GSTACK` is non-empty AND `TEAM_MODE` is NOT `true`:** Update it by copying from the freshly-upgraded primary install (same approach as README vendored install):
```bash
mv "$LOCAL_GSTACK" "$LOCAL_GSTACK.bak"
cp -Rf "$INSTALL_DIR" "$LOCAL_GSTACK"
rm -rf "$LOCAL_GSTACK/.git"
cd "$LOCAL_GSTACK" && ./setup
rm -rf "$LOCAL_GSTACK.bak"
```
Tell user: "Also updated vendored copy at `$LOCAL_GSTACK` — commit `.claude/skills/gstack/` when you're ready."

If `./setup` fails, restore from backup and warn the user:
```bash
rm -rf "$LOCAL_GSTACK"
mv "$LOCAL_GSTACK.bak" "$LOCAL_GSTACK"
```
Tell user: "Sync failed — restored previous version at `$LOCAL_GSTACK`. Run `/gstack-upgrade` manually to retry."

### Step 4.6: Regenerate and audit skill consistency

After the upstream merge and any local vendored sync, verify that the shared
generated portions of every skill still match the current repo. This matters for
customized gstack forks: upstream often changes preambles, host path rewrites,
tool names, or shared sections while the user's branch keeps custom workflow
content.

Run from the primary install directory:

```bash
cd "$INSTALL_DIR"
bun run gen:skill-docs --host all
bun run skill:check
```

If `skill:check` reports stale or invalid generated files, inspect and update the
source templates, not generated `SKILL.md` files. Pay special attention to:

- `build/SKILL.md.tmpl`, `build/configure.cm`, and `build/orchestrator/README.md`
  because `/build` shells out to other skills and is sensitive to command names,
  model/provider defaults, and host-specific path rewrites.
- Any custom skill template containing the PREAMBLE placeholder; it should use
  the current generated preamble rather than a copied older preamble block.
- Any custom non-templated `SKILL.md` that copied old preamble text, old
  `UPGRADE_AVAILABLE` instructions, hardcoded Claude/Codex paths, or stale shared
  boilerplate. Update only the shared boilerplate/preexisting sections needed for
  consistency; preserve the custom workflow content.

Rerun `bun run gen:skill-docs --host all` and `bun run skill:check` until they
pass or until a real merge conflict requires user input.

### Step 4.75: Run version migrations

After `./setup` completes, run any migration scripts for versions between the old
and new version. Migrations handle state fixes that `./setup` alone can't cover
(stale config, orphaned files, directory structure changes).

```bash
MIGRATIONS_DIR="$INSTALL_DIR/gstack-upgrade/migrations"
if [ -d "$MIGRATIONS_DIR" ]; then
  for migration in $(find "$MIGRATIONS_DIR" -maxdepth 1 -name 'v*.sh' -type f 2>/dev/null | sort -V); do
    # Extract version from filename: v0.15.2.0.sh → 0.15.2.0
    m_ver="$(basename "$migration" .sh | sed 's/^v//')"
    # Run if this migration version is newer than old version
    # (simple string compare works for dotted versions with same segment count)
    if [ "$OLD_VERSION" != "unknown" ] && [ "$(printf '%s\n%s' "$OLD_VERSION" "$m_ver" | sort -V | head -1)" = "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$m_ver" ]; then
      echo "Running migration $m_ver..."
      bash "$migration" || echo "  Warning: migration $m_ver had errors (non-fatal)"
    fi
  done
fi
```

Migrations are idempotent bash scripts in `gstack-upgrade/migrations/`. Each is named
`v{VERSION}.sh` and runs only when upgrading from an older version. See CONTRIBUTING.md
for how to add new migrations.

### Step 4.8: Fork skill overlay

After migrations, overlay any custom SKILL.md.tmpl files from the user's configured fork repo onto the installed gstack, then regenerate all hosts. This ensures fork-local skill changes (e.g., custom build orchestration, added steps) survive upstream merges.

```bash
_FORK_REPO=$("$INSTALL_DIR/bin/gstack-config" get fork_repo_path 2>/dev/null || echo "")
echo "FORK_REPO: ${_FORK_REPO:-none}"
```

**If `FORK_REPO` is empty or the directory does not exist:** skip this step and continue to Step 4.9.

**If `FORK_REPO` is set and the directory exists:**

1. Use `git` to find only templates that were intentionally modified in the fork relative to upstream (not just "different from installed gstack"). This avoids accidentally overwriting upstream improvements with older fork versions:
   ```bash
   cd "$_FORK_REPO"
   # Try upstream remote first, fall back to origin
   _BASE_REF=""
   if git remote get-url upstream >/dev/null 2>&1; then
     git fetch upstream main --quiet 2>/dev/null && _BASE_REF="upstream/main" || \
       echo "Warning: git fetch upstream failed — diff results may be incomplete"
   elif git remote get-url origin >/dev/null 2>&1; then
     git fetch origin main --quiet 2>/dev/null && _BASE_REF="origin/main" || \
       echo "Warning: git fetch origin failed — diff results may be incomplete"
   fi
   echo "FORK_BASE_REF: ${_BASE_REF:-none}"
   ```

   If `_BASE_REF` is empty (no git remote): fall back to comparing all tmpl files by content against `$INSTALL_DIR` (using `diff -q`). Warn the user that configuring an `upstream` remote pointing to garrytan/gstack gives more precise results.

   If `_BASE_REF` is set, get the fork-specific tmpl files:
   ```bash
   _FORK_TMPLS=$(git diff "$_BASE_REF"...HEAD --name-only 2>/dev/null | grep '/SKILL\.md\.tmpl$' || true)
   echo "Fork-specific templates: ${_FORK_TMPLS:-none}"
   ```

2. For each fork-specific tmpl file, copy it to the corresponding path in `$INSTALL_DIR`:
   ```bash
   _overlaid=0
   while IFS= read -r _rel; do
     [ -z "$_rel" ] && continue
     case "$_rel" in
       *..*)  echo "SKIP: suspicious path (traversal): $_rel"; continue ;;
     esac
     _src="$_FORK_REPO/$_rel"
     _installed="$INSTALL_DIR/$_rel"
     [ -f "$_src" ] || continue
     mkdir -p "$(dirname "$_installed")"
     cp "$_src" "$_installed"
     echo "  overlaid: $_rel"
     _overlaid=$(( _overlaid + 1 ))
   done < <(printf '%s\n' "$_FORK_TMPLS")
   echo "Fork overlay: $_overlaid template(s) updated"
   ```

3. If any files were overlaid (`_overlaid > 0`), re-run gen:skill-docs and skill:check from `$INSTALL_DIR`:
   ```bash
   cd "$INSTALL_DIR"
   bun run gen:skill-docs --host all
   bun run skill:check
   ```
   Tell the user: "Fork overlay: N template(s) overlaid and regenerated."

4. If `_FORK_TMPLS` is empty: tell the user "Fork skills are up to date — no fork-specific templates detected."

### Step 4.9: Sync to non-registered AI hosts (gemini, kimi)

After gen:skill-docs has run (either in Step 4.6 or re-run in Step 4.8), sync generated SKILL.md files to gemini and kimi skill directories. These are not registered gstack hosts and are not handled by `./setup` — they need explicit file copies.

Note: Claude reads directly from `$INSTALL_DIR`. Codex's `~/.codex/skills/gstack/SKILL.md` is already symlinked to `$INSTALL_DIR/.agents/skills/gstack/SKILL.md` (set up by `./setup`), so it updates automatically when gen:skill-docs runs. Only gemini and kimi need explicit sync.

```bash
_SYNCED_ANY=0
for _HOST_DIR in "$HOME/.gemini/skills/gstack" "$HOME/.kimi/skills/gstack"; do
  [ -d "$_HOST_DIR" ] || continue
  _HOST_NAME=$(basename "$(dirname "$(dirname "$_HOST_DIR")")" | sed 's/^\.//')
  echo "Syncing to $_HOST_NAME ($_HOST_DIR)..."
  # Sync root SKILL.md and ETHOS.md
  for _f in SKILL.md ETHOS.md; do
    if [ -f "$INSTALL_DIR/$_f" ]; then
      cp "$INSTALL_DIR/$_f" "$_HOST_DIR/$_f"
      echo "  synced: $_f"
      _SYNCED_ANY=1
    fi
  done
  # Sync each skill subdirectory that exists in the host install
  for _skill_dir in "$_HOST_DIR"/*/; do
    [ -d "$_skill_dir" ] || continue
    _skill_name=$(basename "$_skill_dir")
    if [ -f "$INSTALL_DIR/$_skill_name/SKILL.md" ]; then
      cp "$INSTALL_DIR/$_skill_name/SKILL.md" "$_HOST_DIR/$_skill_name/SKILL.md"
      echo "  synced: $_skill_name/SKILL.md"
      _SYNCED_ANY=1
    fi
  done
done
if [ "$_SYNCED_ANY" -eq 0 ]; then echo "No gemini/kimi skill dirs found (nothing to sync)."; fi
```

Tell the user which hosts were synced (gemini, kimi) or "not found" if those directories don't exist.

### Step 5: Write marker + clear cache

```bash
mkdir -p ~/.gstack
echo "$OLD_VERSION" > ~/.gstack/just-upgraded-from
rm -f ~/.gstack/last-update-check
rm -f ~/.gstack/update-snoozed
```

### Step 6: Show What's New

Read `$INSTALL_DIR/CHANGELOG.md`. Find all version entries between the old version and the new version. Summarize as 5-7 bullets grouped by theme. Don't overwhelm — focus on user-facing changes. Skip internal refactors unless they're significant.

Format:
```
gstack v{new} — upgraded from v{old}!

What's new:
- [bullet 1]
- [bullet 2]
- ...

Happy shipping!
```

### Step 7: Continue

After showing What's New, continue with whatever skill the user originally invoked. The upgrade is done — no further action needed.

---

## Standalone usage

When invoked directly as `/gstack-upgrade` (not from a preamble):

1. Force a fresh update check (bypass cache):
```bash
~/.claude/skills/gstack/bin/gstack-update-check --force 2>/dev/null || \
.claude/skills/gstack/bin/gstack-update-check --force 2>/dev/null || true
```
Use the output to determine if an upgrade is available.

2. If `UPGRADE_AVAILABLE <old> <new>`: follow Steps 2-6 above.

3. If no output (primary is up to date): check for a stale local vendored copy.

Run the Step 2 bash block above to detect the primary install type and directory (`INSTALL_TYPE` and `INSTALL_DIR`). Then run the Step 4.5 detection bash block above to check for a local vendored copy (`LOCAL_GSTACK`) and team mode status (`TEAM_MODE`).

**If `LOCAL_GSTACK` is empty** (no local vendored copy): tell the user "You're already on the latest version (v{version})."

**If `LOCAL_GSTACK` is non-empty AND `TEAM_MODE` is `true`:** Remove the vendored copy using the Step 4.5 team-mode removal bash block above. Tell user: "Global v{version} is up to date. Removed stale vendored copy (team mode active). Commit the `.gitignore` change when ready."

**If `LOCAL_GSTACK` is non-empty AND `TEAM_MODE` is NOT `true`**, compare versions:
```bash
PRIMARY_VER=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
LOCAL_VER=$(cat "$LOCAL_GSTACK/VERSION" 2>/dev/null || echo "unknown")
echo "PRIMARY=$PRIMARY_VER LOCAL=$LOCAL_VER"
```

**If versions differ:** follow the Step 4.5 sync bash block above to update the local copy from the primary. Tell user: "Global v{PRIMARY_VER} is up to date. Updated local vendored copy from v{LOCAL_VER} → v{PRIMARY_VER}. Commit `.claude/skills/gstack/` when you're ready."

**If versions match:** tell the user "You're on the latest version (v{PRIMARY_VER}). Global and local vendored copy are both up to date."

4. After vendored copy handling, always run the fork skill overlay and multi-host sync:

```bash
_FORK_REPO=$("$INSTALL_DIR/bin/gstack-config" get fork_repo_path 2>/dev/null || echo "")
echo "FORK_REPO: ${_FORK_REPO:-none}"
```

**If `FORK_REPO` is set and the directory exists:** run Step 4.8 (fork skill overlay) then Step 4.9 (gemini/kimi sync) from the Inline upgrade flow above. Use `$INSTALL_DIR` from the Step 2 detection. Report how many templates were overlaid and which hosts were synced. This is the primary path for "I updated my fork's build skill — now install it everywhere."

**If `FORK_REPO` is not set:** tell the user:
```
Tip: configure a fork repo to auto-sync custom skill changes on every upgrade:
  gstack-config set fork_repo_path /path/to/your/gstack/fork

Once set, /gstack-upgrade will diff your fork's SKILL.md.tmpl files against
the installed gstack, copy any that changed, regenerate for all hosts, and
sync gemini/kimi skill dirs — even when no upstream upgrade is available.
```
