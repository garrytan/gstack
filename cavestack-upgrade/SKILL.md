---
name: cavestack-upgrade
version: 1.1.0
description: |
  Upgrade cavestack to latest version. Detects global vs vendored install,
  runs upgrade, shows what's new. Use when: "upgrade cavestack",
  "update cavestack", "get latest version".
  Voice triggers (speech-to-text aliases): "upgrade the tools", "update the tools", "gee stack upgrade", "g stack upgrade".
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /cavestack-upgrade

Upgrade cavestack to latest version and show what's new.

## Inline upgrade flow

Referenced by all skill preambles when they detect `UPGRADE_AVAILABLE`.

### Step 1: Ask user (or auto-upgrade)

First, check if auto-upgrade enabled:
```bash
_AUTO=""
[ "${CAVESTACK_AUTO_UPGRADE:-}" = "1" ] && _AUTO="true"
[ -z "$_AUTO" ] && _AUTO=$(~/.claude/skills/cavestack/bin/cavestack-config get auto_upgrade 2>/dev/null || true)
echo "AUTO_UPGRADE=$_AUTO"
```

**If `AUTO_UPGRADE=true` or `AUTO_UPGRADE=1`:** Skip AskUserQuestion. Log "Auto-upgrading cavestack v{old} → v{new}..." and proceed directly to Step 2. If `./setup` fails during auto-upgrade, restore from backup (`.bak` directory) and warn user: "Auto-upgrade failed — restored previous version. Run `/cavestack-upgrade` manually to retry."

**Otherwise**, use AskUserQuestion:
- Question: "cavestack **v{new}** is available (you're on v{old}). Upgrade now?"
- Options: ["Yes, upgrade now", "Always keep me up to date", "Not now", "Never ask again"]

**If "Yes, upgrade now":** Proceed to Step 2.

**If "Always keep me up to date":**
```bash
~/.claude/skills/cavestack/bin/cavestack-config set auto_upgrade true
```
Tell user: "Auto-upgrade enabled. Future updates install automatically." Then proceed to Step 2.

**If "Not now":** Write snooze state with escalating backoff (first snooze = 24h, second = 48h, third+ = 1 week), then continue with current skill. Do not mention upgrade again.
```bash
_SNOOZE_FILE=~/.cavestack/update-snoozed
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
Note: `{new}` is remote version from `UPGRADE_AVAILABLE` output — substitute from update check result.

Tell user snooze duration: "Next reminder in 24h" (or 48h or 1 week, depending on level). Tip: "Set `auto_upgrade: true` in `~/.cavestack/config.yaml` for automatic upgrades."

**If "Never ask again":**
```bash
~/.claude/skills/cavestack/bin/cavestack-config set update_check false
```
Tell user: "Update checks disabled. Run `~/.claude/skills/cavestack/bin/cavestack-config set update_check true` to re-enable."
Continue with current skill.

### Step 2: Detect install type

```bash
if [ -d "$HOME/.claude/skills/cavestack/.git" ]; then
  INSTALL_TYPE="global-git"
  INSTALL_DIR="$HOME/.claude/skills/cavestack"
elif [ -d "$HOME/.cavestack/repos/cavestack/.git" ]; then
  INSTALL_TYPE="global-git"
  INSTALL_DIR="$HOME/.cavestack/repos/cavestack"
elif [ -d ".claude/skills/cavestack/.git" ]; then
  INSTALL_TYPE="local-git"
  INSTALL_DIR=".claude/skills/cavestack"
elif [ -d ".agents/skills/cavestack/.git" ]; then
  INSTALL_TYPE="local-git"
  INSTALL_DIR=".agents/skills/cavestack"
elif [ -d ".claude/skills/cavestack" ]; then
  INSTALL_TYPE="vendored"
  INSTALL_DIR=".claude/skills/cavestack"
elif [ -d "$HOME/.claude/skills/cavestack" ]; then
  INSTALL_TYPE="vendored-global"
  INSTALL_DIR="$HOME/.claude/skills/cavestack"
else
  echo "ERROR: cavestack not found"
  exit 1
fi
echo "Install type: $INSTALL_TYPE at $INSTALL_DIR"
```

Install type and directory path printed above used in all subsequent steps.

### Step 3: Save old version

Use install directory from Step 2's output:

```bash
OLD_VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
```

### Step 4: Upgrade

Use install type and directory detected in Step 2:

**For git installs** (global-git, local-git):
```bash
cd "$INSTALL_DIR"
STASH_OUTPUT=$(git stash 2>&1)
git fetch origin
git reset --hard origin/main
./setup
```
If `$STASH_OUTPUT` contains "Saved working directory", warn user: "Note: local changes were stashed. Run `git stash pop` in skill directory to restore them."

**For vendored installs** (vendored, vendored-global):
```bash
PARENT=$(dirname "$INSTALL_DIR")
TMP_DIR=$(mktemp -d)
git clone --depth 1 https://github.com/JerkyJesse/cavestack.git "$TMP_DIR/cavestack"
mv "$INSTALL_DIR" "$INSTALL_DIR.bak"
mv "$TMP_DIR/cavestack" "$INSTALL_DIR"
cd "$INSTALL_DIR" && ./setup
rm -rf "$INSTALL_DIR.bak" "$TMP_DIR"
```

### Step 4.5: Handle local vendored copy

Use install directory from Step 2. Check if there's also local vendored copy, and whether team mode active:

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
LOCAL_CAVESTACK=""
if [ -n "$_ROOT" ] && [ -d "$_ROOT/.claude/skills/cavestack" ]; then
  _RESOLVED_LOCAL=$(cd "$_ROOT/.claude/skills/cavestack" && pwd -P)
  _RESOLVED_PRIMARY=$(cd "$INSTALL_DIR" && pwd -P)
  if [ "$_RESOLVED_LOCAL" != "$_RESOLVED_PRIMARY" ]; then
    LOCAL_CAVESTACK="$_ROOT/.claude/skills/cavestack"
  fi
fi
_TEAM_MODE=$(~/.claude/skills/cavestack/bin/cavestack-config get team_mode 2>/dev/null || echo "false")
echo "LOCAL_CAVESTACK=$LOCAL_CAVESTACK"
echo "TEAM_MODE=$_TEAM_MODE"
```

**If `LOCAL_CAVESTACK` is non-empty AND `TEAM_MODE` is `true`:** Remove vendored copy. Team mode uses global install as single source of truth.

```bash
cd "$_ROOT"
git rm -r --cached .claude/skills/cavestack/ 2>/dev/null || true
if ! grep -qF '.claude/skills/cavestack/' .gitignore 2>/dev/null; then
  echo '.claude/skills/cavestack/' >> .gitignore
fi
rm -rf "$LOCAL_CAVESTACK"
```
Tell user: "Removed vendored copy at `$LOCAL_CAVESTACK` (team mode active — global install is the source of truth). Commit the `.gitignore` change when ready."

**If `LOCAL_CAVESTACK` is non-empty AND `TEAM_MODE` is NOT `true`:** Update by copying from freshly-upgraded primary install (same approach as README vendored install):
```bash
mv "$LOCAL_CAVESTACK" "$LOCAL_CAVESTACK.bak"
cp -Rf "$INSTALL_DIR" "$LOCAL_CAVESTACK"
rm -rf "$LOCAL_CAVESTACK/.git"
cd "$LOCAL_CAVESTACK" && ./setup
rm -rf "$LOCAL_CAVESTACK.bak"
```
Tell user: "Also updated vendored copy at `$LOCAL_CAVESTACK` — commit `.claude/skills/cavestack/` when you're ready."

If `./setup` fails, restore from backup and warn user:
```bash
rm -rf "$LOCAL_CAVESTACK"
mv "$LOCAL_CAVESTACK.bak" "$LOCAL_CAVESTACK"
```
Tell user: "Sync failed — restored previous version at `$LOCAL_CAVESTACK`. Run `/cavestack-upgrade` manually to retry."

### Step 4.75: Run version migrations

After `./setup` completes, run migration scripts for versions between old
and new version. Migrations handle state fixes `./setup` alone can't cover
(stale config, orphaned files, directory structure changes).

```bash
MIGRATIONS_DIR="$INSTALL_DIR/cavestack-upgrade/migrations"
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

Migrations are idempotent bash scripts in `cavestack-upgrade/migrations/`. Each named
`v{VERSION}.sh`, runs only when upgrading from older version. See CONTRIBUTING.md
for adding new migrations.

### Step 5: Write marker + clear cache

```bash
mkdir -p ~/.cavestack
echo "$OLD_VERSION" > ~/.cavestack/just-upgraded-from
rm -f ~/.cavestack/last-update-check
rm -f ~/.cavestack/update-snoozed
```

### Step 6: Show What's New

Read `$INSTALL_DIR/CHANGELOG.md`. Find all version entries between old and new version. Summarize as 5-7 bullets grouped by theme. Don't overwhelm — focus on user-facing changes. Skip internal refactors unless significant.

Format:
```
cavestack v{new} — upgraded from v{old}!

What's new:
- [bullet 1]
- [bullet 2]
- ...

Happy shipping!
```

### Step 7: Continue

After showing What's New, continue with whatever skill user originally invoked. Upgrade done — no further action needed.

---

## Standalone usage

When invoked directly as `/cavestack-upgrade` (not from preamble):

1. Force fresh update check (bypass cache):
```bash
~/.claude/skills/cavestack/bin/cavestack-update-check --force 2>/dev/null || \
.claude/skills/cavestack/bin/cavestack-update-check --force 2>/dev/null || true
```
Use output to determine if upgrade available.

2. If `UPGRADE_AVAILABLE <old> <new>`: follow Steps 2-6 above.

3. If no output (primary up to date): check for stale local vendored copy.

Run Step 2 bash block to detect primary install type and directory (`INSTALL_TYPE` and `INSTALL_DIR`). Then run Step 4.5 detection bash block to check for local vendored copy (`LOCAL_CAVESTACK`) and team mode status (`TEAM_MODE`).

**If `LOCAL_CAVESTACK` is empty** (no local vendored copy): tell user "You're already on the latest version (v{version})."

**If `LOCAL_CAVESTACK` is non-empty AND `TEAM_MODE` is `true`:** Remove vendored copy using Step 4.5 team-mode removal bash block. Tell user: "Global v{version} is up to date. Removed stale vendored copy (team mode active). Commit the `.gitignore` change when ready."

**If `LOCAL_CAVESTACK` is non-empty AND `TEAM_MODE` is NOT `true`**, compare versions:
```bash
PRIMARY_VER=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "unknown")
LOCAL_VER=$(cat "$LOCAL_CAVESTACK/VERSION" 2>/dev/null || echo "unknown")
echo "PRIMARY=$PRIMARY_VER LOCAL=$LOCAL_VER"
```

**If versions differ:** follow Step 4.5 sync bash block to update local copy from primary. Tell user: "Global v{PRIMARY_VER} is up to date. Updated local vendored copy from v{LOCAL_VER} → v{PRIMARY_VER}. Commit `.claude/skills/cavestack/` when you're ready."

**If versions match:** tell user "You're on the latest version (v{PRIMARY_VER}). Global and local vendored copy are both up to date."
