# Uninstall

## Option 1: Run the uninstall script

If gstack is installed on your machine:

```bash
~/.claude/skills/gstack/bin/gstack-uninstall
```

This handles skills, symlinks, harness registrations (the files `gstack-harness` wrote into OpenClaw, Hermes, a Dot or another harness, from their ledgers), global state (`~/.gstack/`), project-local state, browse daemons, and temp files. Use `--keep-state` to preserve config and analytics. Use `--force` to skip confirmation.

## Option 2: Manual removal (no local repo)

If you don't have the repo cloned (e.g. you installed via a Claude Code paste and later deleted the clone):

```bash
# 1. Stop browse daemons
pkill -f "gstack.*browse" 2>/dev/null || true

# 2. Remove per-skill directories whose SKILL.md points into gstack/
#    (rm -rf, not rmdir — installed dirs also contain runtime-asset links)
find ~/.claude/skills -mindepth 1 -maxdepth 1 -type d ! -name gstack 2>/dev/null |
while IFS= read -r dir; do
  link="$dir/SKILL.md"
  [ -L "$link" ] || continue
  target=$(readlink "$link" 2>/dev/null) || continue
  case "$target" in
    gstack/*|*/gstack/*)
      rm -rf "$dir"
      ;;
  esac
done
# Directories gstack created carry a .gstack-owned marker (the only signal on
# Windows, where installs are file copies with no symlink to read)
for marker in ~/.claude/skills/*/.gstack-owned; do
  [ -f "$marker" ] && rm -rf "$(dirname "$marker")"
done
# Alias skills install as copies (no symlink to detect) — remove by name
rm -rf ~/.claude/skills/_gstack-command ~/.claude/skills/connect-chrome 2>/dev/null

# 3. Remove gstack
rm -rf ~/.claude/skills/gstack

# 4. Remove global state
rm -rf ~/.gstack

# 5. Remove integrations (skip any you never installed)
rm -rf "${CODEX_HOME:-$HOME/.codex}/skills/gstack"* 2>/dev/null
rm -rf ~/.factory/skills/gstack* 2>/dev/null
rm -rf ~/.kiro/skills/gstack* 2>/dev/null
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/skills/gstack"* "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/skills/.gstack-skills" 2>/dev/null
rm -rf "${HERMES_HOME:-$HOME/.hermes}/skills/gstack" 2>/dev/null
rm -rf ~/.cursor/skills/gstack* 2>/dev/null
rm -rf ~/.config/opencode/skills/gstack* 2>/dev/null
rm -rf ~/.gemini/antigravity-cli/skills/gstack* 2>/dev/null

# 6. Remove temp files
rm -f /tmp/gstack-* 2>/dev/null

# 7. Per-project cleanup (run from each project root)
rm -rf .gstack .gstack-worktrees .claude/skills/gstack 2>/dev/null
rm -rf .agents/skills/gstack* .factory/skills/gstack* 2>/dev/null
```

Manual removal leaves gstack's hook entries behind in `~/.claude/settings.json`
(the uninstall script removes all of them for you, including entries whose
`_gstack_source` tag was stripped). Edit that file and delete every hook whose
command path points into `.claude/skills/gstack/`: the SessionStart auto-update
hook, the AskUserQuestion PreToolUse/PostToolUse hooks, and the Stop hooks
(session timeline, plus verify-gate if you opted in). Left in place, they error
on every matching event once the install directory is gone.

## Clean up CLAUDE.md

The uninstall script does not edit CLAUDE.md. In each project where gstack was added, remove the `## gstack` and `## Skill routing` sections.

## Playwright

`~/Library/Caches/ms-playwright/` (macOS) is left in place because other tools may share it. Remove it if nothing else needs it.

## Aside

gstack never installed Aside, so it never uninstalls it. Keep it or remove it like any other app.
