---
name: gstack-upgrade
version: 1.1.0
description: Upgrade gstack to the latest version.
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


## When to invoke this skill

Detects global vs vendored install,
runs the upgrade, and shows what's new. Use when asked to "upgrade gstack",
"update gstack", or "get latest version".

Voice triggers (speech-to-text aliases): "upgrade the tools", "update the tools", "gee stack upgrade", "g stack upgrade".

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

**If `AUTO_UPGRADE=true` or `AUTO_UPGRADE=1`:** Skip AskUserQuestion. Log "Auto-upgrading gstack v{old} → v{new}..." and proceed directly to Step 2. If `./setup` fails during auto-upgrade, restore from backup (`.bak` directory) and warn the user: "Auto-upgrade failed — restored previous version. Run `/gstack-upgrade` manually to retry."

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

**For git installs** (global-git, local-git):
```bash
cd "$INSTALL_DIR"
if ! git diff --quiet || ! git diff --cached --quiet || \
  [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "ERROR: gstack has local changes. Commit or move them aside, then run /gstack-upgrade again."
  exit 1
fi
CURRENT_BRANCH=$(git branch --show-current)
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)
if [ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]; then
  echo "ERROR: gstack is on '$CURRENT_BRANCH', not its default branch '$DEFAULT_BRANCH'. Switch branches manually, then retry."
  exit 1
fi
git fetch origin "$DEFAULT_BRANCH"
git merge --ff-only "origin/$DEFAULT_BRANCH"
./setup
```
This never rewrites `origin`, stores work away automatically, or discards local
changes. If a fast-forward is not possible, stop and show the Git error. A
deliberate `git reset --hard` recovery is a manual operator decision, not an
upgrade step.

**For vendored installs** (vendored, vendored-global):
```bash
PARENT=$(dirname "$INSTALL_DIR")
if [ -e "$INSTALL_DIR.bak" ]; then
  echo "ERROR: backup path '$INSTALL_DIR.bak' already exists. Verify it, then move or remove it manually before retrying."
  exit 1
fi
TMP_DIR=$(mktemp -d "$PARENT/.gstack-upgrade.XXXXXX")
# Explicit GSTACK_REMOTE_REPO wins when it is a public GitHub HTTPS/SSH URL.
# Otherwise use this checkout's public origin; malformed or credential-bearing
# values fall back to the upstream repository without printing the value.
UPDATE_REPO="garrytan/gstack"
for CANDIDATE in "${GSTACK_REMOTE_REPO:-}" "$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"; do
  case "$CANDIDATE" in
    https://github.com/*) REPO="${CANDIDATE#https://github.com/}" ;;
    git@github.com:*) REPO="${CANDIDATE#git@github.com:}" ;;
    ssh://git@github.com/*) REPO="${CANDIDATE#ssh://git@github.com/}" ;;
    *) continue ;;
  esac
  REPO="${REPO%/}"
  REPO="${REPO%.git}"
  if [[ "$REPO" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    UPDATE_REPO="$REPO"
    break
  fi
done
SOURCE_URL="https://github.com/${UPDATE_REPO}.git"
DEFAULT_BRANCH=$(git ls-remote --symref "$SOURCE_URL" HEAD 2>/dev/null | awk '$1 == "ref:" && $2 ~ /^refs\/heads\// && $3 == "HEAD" {sub(/^refs\/heads\//, "", $2); print $2; exit}')
case "$DEFAULT_BRANCH" in
  ''|*..*|/*|*/|*[!A-Za-z0-9._/-]*) DEFAULT_BRANCH="main" ;;
esac
if ! git clone --depth 1 --branch "$DEFAULT_BRANCH" "$SOURCE_URL" "$TMP_DIR/gstack"; then
  rm -rf "$TMP_DIR"
  echo "ERROR: clone failed; the existing vendored copy was not changed."
  exit 1
fi
if ! mv "$INSTALL_DIR" "$INSTALL_DIR.bak"; then
  rm -rf "$TMP_DIR"
  echo "ERROR: could not back up the existing vendored copy; it was not changed."
  exit 1
fi
if ! mv "$TMP_DIR/gstack" "$INSTALL_DIR"; then
  rm -rf "$INSTALL_DIR"
  if ! mv "$INSTALL_DIR.bak" "$INSTALL_DIR"; then
    echo "CRITICAL: replacement and restore failed. Recover '$INSTALL_DIR.bak' manually."
    exit 1
  fi
  rm -rf "$TMP_DIR"
  echo "ERROR: replacement failed; restored the previous vendored copy."
  exit 1
fi
if ! (cd "$INSTALL_DIR" && ./setup); then
  rm -rf "$INSTALL_DIR"
  if ! mv "$INSTALL_DIR.bak" "$INSTALL_DIR"; then
    echo "CRITICAL: setup and restore failed. Recover '$INSTALL_DIR.bak' manually."
    exit 1
  fi
  rm -rf "$TMP_DIR"
  echo "ERROR: setup failed; restored the previous vendored copy."
  exit 1
fi
rm -rf "$INSTALL_DIR.bak" "$TMP_DIR"
```

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
# Transactional local vendored sync: prepare and verify a sibling before swap.
if [ -e "$LOCAL_GSTACK.bak" ] || [ -e "$LOCAL_GSTACK.new" ]; then
  echo "ERROR: '$LOCAL_GSTACK.bak' or '$LOCAL_GSTACK.new' already exists. Verify it, then move or remove it manually before retrying."
  exit 1
fi
if ! cp -Rf "$INSTALL_DIR" "$LOCAL_GSTACK.new"; then
  rm -rf "$LOCAL_GSTACK.new"
  echo "ERROR: copy failed; the previous local vendored copy was not changed."
  exit 1
fi
rm -rf "$LOCAL_GSTACK.new/.git"
if ! (cd "$LOCAL_GSTACK.new" && bash ./setup); then
  rm -rf "$LOCAL_GSTACK.new"
  echo "ERROR: setup failed; the previous local vendored copy was not changed."
  exit 1
fi
if ! mv "$LOCAL_GSTACK" "$LOCAL_GSTACK.bak"; then
  rm -rf "$LOCAL_GSTACK.new"
  echo "ERROR: could not back up the local vendored copy; it was not changed."
  exit 1
fi
if ! mv "$LOCAL_GSTACK.new" "$LOCAL_GSTACK"; then
  rm -rf "$LOCAL_GSTACK"
  if ! mv "$LOCAL_GSTACK.bak" "$LOCAL_GSTACK"; then
    echo "CRITICAL: local replacement and restore failed. Recover '$LOCAL_GSTACK.bak' manually."
    exit 1
  fi
  rm -rf "$LOCAL_GSTACK.new"
  echo "ERROR: replacement failed; restored the previous local vendored copy."
  exit 1
fi
rm -rf "$LOCAL_GSTACK.bak"
```
Tell user: "Also updated vendored copy at `$LOCAL_GSTACK` — commit `.claude/skills/gstack/` when you're ready."

Copy and setup failures are handled transactionally by the block above. Tell
the user when the previous version was restored and ask them to run
`/gstack-upgrade` manually after resolving the reported problem.

### Step 4.75: Migrations are dispatched by setup

`./setup` is the single migration dispatcher. It runs ordinary migrations once
for the version transition and retries only explicitly listed privacy or state
repairs whose completion marker is still absent. This also repairs an older
installation when a prerequisite such as `jq` becomes available after a prior
upgrade.

Do not invoke migration scripts separately here: doing so can duplicate a
transition that `./setup` has already dispatched. See CONTRIBUTING.md for the
completion-marker and retry-manifest contract for new migrations.

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
