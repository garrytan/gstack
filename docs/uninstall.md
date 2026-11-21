# Uninstall

## Option 1: Run the uninstall script

If gstack is installed on your machine:

```bash
~/.claude/skills/gstack/bin/gstack-uninstall
```

This handles skills, symlinks, harness registrations (the files `gstack-harness` wrote into OpenClaw, Hermes, a Dot or another harness, from their ledgers, plus the opt-in [start hook](hosts.md#start-hook), which it turns off through the harness's own CLI), global state (`~/.gstack/`), project-local state, browse daemons, and temp files. Use `--keep-state` to preserve config and analytics. Use `--force` to skip confirmation.

## Option 2: Manual removal (no local repo)

If you don't have the repo cloned (e.g. you installed via a Claude Code paste and later deleted the clone):

```bash
# 0. A delete that stops for unsaved git work: each folder goes only when no git
#    checkout inside it has uncommitted changes, commits that neither a
#    remote-tracking branch nor a fetch from one of its remotes holds, or a
#    locked worktree. A symlink is only unlinked.
# The FETCH_HEAD commits a fetch from one of checkout $1's remotes wrote.
gstack_remote_fetch_heads() (
  cd "$1" || exit 0
  git remote | while IFS= read -r n; do git remote get-url --all "$n"; done |
    sed -E 's#^([a-z+]+://)?[^@/]+@#\1#; s#/+$##; s#\.git$##' |
    awk 'NR == FNR { u[$0]; next } { n = split($0, a, " of "); if (n > 1 && (a[n] in u)) print $1 }' - "$(git rev-parse --git-path FETCH_HEAD)" 2>/dev/null
)
gstack_rm_checked() {
  local d g r s ok
  for d in "$@"; do
    if [ -L "$d" ]; then rm -f -- "$d"; continue; fi
    [ -d "$d" ] || continue
    ok=1
    while IFS= read -r -d '' g; do
      r=${g%/.git}
      s=$(git -C "$r" status --porcelain --untracked-files=all) && [ -z "$s" ] &&
        s=$(git -C "$r" rev-list -n 1 --all --not --remotes $(gstack_remote_fetch_heads "$r")) && [ -z "$s" ] &&
        git -C "$r" worktree list --porcelain -z >/dev/null 2>&1 &&
        ! git -C "$r" worktree list --porcelain -z | tr '\0' '\n' | grep -q '^locked' ||
        { echo "kept $d: $r has uncommitted changes, unpushed commits or a locked worktree" >&2; ok=0; break; }
    done < <(find "$d" -name .git -prune -print0 2>/dev/null)
    [ "$ok" = 1 ] && rm -rf -- "$d"
  done
  return 0
}

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
gstack_rm_checked ~/.claude/skills/gstack

# 4. Remove global state
gstack_rm_checked ~/.gstack

# 5. Remove integrations (skip any you never installed)
gstack_rm_checked "${CODEX_HOME:-$HOME/.codex}/skills/gstack"*
gstack_rm_checked ~/.factory/skills/gstack*
gstack_rm_checked ~/.kiro/skills/gstack*
gstack_rm_checked "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/skills/gstack"* "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/skills/.gstack-skills"
gstack_rm_checked "${HERMES_HOME:-$HOME/.hermes}/skills/gstack"
gstack_rm_checked ~/.cursor/skills/gstack*
gstack_rm_checked ~/.config/opencode/skills/gstack*
gstack_rm_checked ~/.gemini/antigravity-cli/skills/gstack*
gstack_rm_checked ~/.gemini/skills/gstack*

# 6. Remove temp files
rm -f /tmp/gstack-* 2>/dev/null

# 7. Per-project cleanup (run from each project root; uses gstack_rm_checked from step 0)
gstack_rm_checked .claude/skills/gstack .agents/skills/gstack* .factory/skills/gstack*
# Browse state: removes only the files git ignores, so tracked files such as
# ship policy, and a .gstack/ that is its own git repo, stay.
git clean -fdXq -- .gstack 2>/dev/null
# Worktrees, deepest first: each goes only when it has no uncommitted changes,
# no commits a branch or tag lacks, and no checkout inside it. git refuses a
# locked one. Anything printed as kept still holds work: save it, then re-run.
root=$(git rev-parse --show-toplevel)
git worktree list --porcelain | sed -n 's/^worktree //p' | sort -r |
while IFS= read -r wt; do
  case "$wt" in "$root/.gstack-worktrees/"*) ;; *) continue ;; esac
  if [ -z "$(git -C "$wt" status --porcelain --untracked-files=all)" ] &&
     [ -z "$(git -C "$wt" log --oneline -1 HEAD --not --branches --tags)" ] &&
     [ -z "$(find "$wt" -mindepth 2 -name .git -print -quit)" ]; then
    git worktree remove "$wt" || echo "kept $wt"
  else
    echo "kept $wt: it holds work or another checkout"
  fi
done
find .gstack-worktrees -depth -type d -empty -delete 2>/dev/null || true
```

Anything `gstack_rm_checked` prints as kept still holds work: push or move it,
then run that step again. Never `rm -rf .gstack-worktrees` by hand: a checkout there can hold uncommitted
work, commits no branch has, or another worktree nested inside it, and `rm -rf`
deletes all of it. Anything the loop above keeps, check and remove yourself.

Manual removal leaves gstack's hook entries behind in `~/.claude/settings.json`
(the uninstall script removes all of them for you, including entries whose
`_gstack_source` tag was stripped). Edit that file and delete every hook whose
command path points into `.claude/skills/gstack/`: the SessionStart auto-update
hook, the AskUserQuestion PreToolUse/PostToolUse hooks, the Stop hooks
(session timeline, plus verify-gate and skill contracts if you opted in), and
the skill-routing UserPromptSubmit hook if you turned it on, and the
/plan-ceo-review and /autoplan skill-gate hooks if you turned those on. Left in place, they error
on every matching event once the install directory is gone.

If you turned on the OpenClaw or Hermes [start hook](hosts.md#start-hook),
manual removal also leaves its `gstack-start` plugin turned on. Turn it off
with `openclaw config unset plugins.entries.gstack-start` or `hermes plugins
disable gstack-start`, then delete
`${OPENCLAW_STATE_DIR:-~/.openclaw}/extensions/gstack-start` or
`${HERMES_HOME:-~/.hermes}/plugins/gstack-start`.

## Clean up CLAUDE.md

The uninstall script does not edit CLAUDE.md. In each project where gstack was added, remove the `## gstack` and `## Skill routing` sections.

## Playwright

`~/Library/Caches/ms-playwright/` (macOS) is left in place because other tools may share it. Remove it if nothing else needs it.

## Aside

gstack never installed Aside, so it never uninstalls it. Keep it or remove it like any other app.
