**Codex review findings written as numbered headings keep their severity.** A finding like `### 1. High — title` read as having no severity, so a finished second-model review came back `untagged_review`. Contributed by @larsonthune (#4231).

**/autoplan's phase-report check works in sessions where Remote Control was on from the start.** Claude Code writes a `bridge_status` record as the first line of those sessions, and the check skipped itself with a "not verified" warning on every reviewer call. Reported by @exGeni (#4298).

**`gstack-approvals import --autoplan` records an interactive /autoplan run under its own run id.** Without a `run.json`, every interactive run was imported as `autoplan`, so the run id could not be cited and separate runs shared one gate state. A `Plan: approved:` line naming the run's folder resolves the same way. Reported by @exGeni (#4402).

**/ship sees every git worktree of a repo when it picks a version.** Worktrees outside the Conductor layout, such as Claude Code's `.claude/worktrees` or a plain `git worktree add`, were invisible, so two of them could take the same version. `workspace_root: null` still turns the scan off. Contributed by @vilano93 (#4196).

**`gstack-pr-shots --path` compares against the real base branch when `origin/HEAD` points at the feature branch.** Committed changes no longer vanish from the before-and-after image. Contributed by @szsunyuan (#4141, #3733).
