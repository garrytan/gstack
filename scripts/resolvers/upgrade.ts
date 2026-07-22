import type { TemplateContext } from './types';

const DEFAULT_LOCAL_INSTALL_SYNC = `### Step 4.5: Handle local vendored copy

Use the install directory from Step 2. Check if there's also a local vendored copy, and whether team mode is active:

\`\`\`bash
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
\`\`\`

**If \`LOCAL_GSTACK\` is non-empty AND \`TEAM_MODE\` is \`true\`:** Remove the vendored copy. Team mode uses the global install as the single source of truth.

\`\`\`bash
cd "$_ROOT"
git rm -r --cached .claude/skills/gstack/ 2>/dev/null || true
if ! grep -qF '.claude/skills/gstack/' .gitignore 2>/dev/null; then
  echo '.claude/skills/gstack/' >> .gitignore
fi
rm -rf "$LOCAL_GSTACK"
\`\`\`
Tell user: "Removed vendored copy at \`$LOCAL_GSTACK\` (team mode active — global install is the source of truth). Commit the \`.gitignore\` change when ready."

**If \`LOCAL_GSTACK\` is non-empty AND \`TEAM_MODE\` is NOT \`true\`:** Update it by copying from the freshly-upgraded primary install (same approach as README vendored install):
\`\`\`bash
mv "$LOCAL_GSTACK" "$LOCAL_GSTACK.bak"
cp -Rf "$INSTALL_DIR" "$LOCAL_GSTACK"
rm -rf "$LOCAL_GSTACK/.git"
cd "$LOCAL_GSTACK" && ./setup
rm -rf "$LOCAL_GSTACK.bak"
\`\`\`
Tell user: "Also updated vendored copy at \`$LOCAL_GSTACK\` — commit \`.claude/skills/gstack/\` when you're ready."

If \`./setup\` fails, restore from backup and warn the user:
\`\`\`bash
rm -rf "$LOCAL_GSTACK"
mv "$LOCAL_GSTACK.bak" "$LOCAL_GSTACK"
\`\`\`
Tell user: "Sync failed — restored previous version at \`$LOCAL_GSTACK\`. Run \`/gstack-upgrade\` manually to retry."`;

const COPILOT_LOCAL_INSTALL_SYNC = `### Step 4.5: Refresh a repository-local Copilot install

Copilot repository installs are machine-local. If the current repository has one,
rerun setup from its recorded source checkout so Windows copies and Unix symlinks
both receive the upgraded generated skills and runtime assets.

\`\`\`bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
LOCAL_GSTACK=""
TEAM_MODE="false"
if [ -n "$_ROOT" ] && [ -f "$_ROOT/.github/skills/gstack/.source-path" ]; then
  LOCAL_SOURCE=$(cat "$_ROOT/.github/skills/gstack/.source-path")
  if [ ! -x "$LOCAL_SOURCE/setup" ]; then
    echo "Copilot repository install source is unavailable: $LOCAL_SOURCE" >&2
    exit 1
  fi
  (cd "$_ROOT" && "$LOCAL_SOURCE/setup" --host copilot --local)
  echo "Refreshed repository Copilot skills at $_ROOT/.github/skills"
fi
echo "LOCAL_GSTACK=$LOCAL_GSTACK"
echo "TEAM_MODE=$TEAM_MODE"
\`\`\``;

export function generateUpgradeLocalInstallSync(ctx: TemplateContext): string {
  return ctx.host === 'copilot' ? COPILOT_LOCAL_INSTALL_SYNC : DEFAULT_LOCAL_INSTALL_SYNC;
}
