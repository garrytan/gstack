# GitHub Copilot CLI integration

gstack ships first-class support for the standalone GitHub Copilot CLI
(`copilot` binary, GA February 2026). This document describes the integration
in detail; see the README for the quick install steps.

## Why a dedicated host

Before April 24, 2026, Copilot CLI auto-loaded skills from `~/.claude/`,
which let users run gstack via the existing Claude install. **As of v1.0.36
(April 24, 2026) Copilot CLI no longer reads `~/.claude/`** (see the
[Copilot CLI changelog](https://docs.github.com/copilot/changelog/copilot-cli)).
That means a dedicated host install is required to use gstack with Copilot.

The `--host copilot` flag wires gstack into Copilot's official skill location:
`~/.copilot/skills/<skill-name>/SKILL.md`. Each gstack skill becomes a
`/skill-name` slash command that Copilot auto-discovers via `/skills list`.

## Install

```bash
# 1. Install Copilot CLI
npm install -g @github/copilot
# or: brew install copilot
# or: winget install GitHub.CopilotCLI
# or: curl -fsSL https://aka.ms/copilot-cli-install.sh | sh

# 2. Install gstack
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup --host copilot

# 3. Verify in Copilot
copilot
> /skills list                # should show 43 gstack-* skills
> /gstack-review              # try a skill
```

`./setup --host auto` also works — auto-detection runs `command -v copilot`
and installs gstack for Copilot if the binary is on `$PATH`.

## What gets installed

- **`~/.copilot/skills/gstack/`** - runtime root with symlinks to `bin/`,
  `browse/dist/`, `design/dist/`, `ETHOS.md`, `gstack-upgrade/`, `qa/`,
  `review/specialists/`, etc.
- **`~/.copilot/skills/gstack-<skill>/`** - one symlinked skill directory
  per gstack skill (43 in the v1 build), each containing the host-adapted
  `SKILL.md`. Copilot auto-discovers these and exposes each as a slash
  command at session start.

## Tool-name translation

Copilot CLI uses a different tool catalog than Claude Code. The host config
rewrites Claude tool references in skill content to their Copilot equivalents:

| Claude Code     | Copilot CLI |
|-----------------|-------------|
| Bash            | bash        |
| Read            | view        |
| Write           | create      |
| Edit            | edit        |
| Agent           | task        |
| Grep            | grep        |
| Glob            | glob        |
| AskUserQuestion | ask_user    |

See the official Copilot CLI tool docs at
<https://docs.github.com/copilot/concepts/agents/about-copilot-cli> for the
full catalog including `/fleet`, `web_search`, `web_fetch`, MCP integration,
and per-tool approval flow.

## v1 scope

The following gstack orchestration features are **suppressed** in the v1
Copilot host because they embed Claude-specific Agent dispatch syntax
(`subagent_type` parameter) that Copilot's `task` tool doesn't accept:

- `REVIEW_ARMY` (parallel specialist dispatch in `/gstack-review`)
- `ADVERSARIAL_STEP` (adversarial reviewer in `/gstack-review`)
- `DESIGN_OUTSIDE_VOICES` (parallel design committee in design skills)

Two skills are also **skipped** as they're not portable to Copilot:

- `codex` - Claude wrapper around the `codex exec` binary
- `pair-agent` - depends on Claude streaming semantics

The core sprint methodology works as designed:

- `/gstack-review` (without parallel specialists - sequential review still works)
- `/gstack-ship`, `/gstack-investigate`, `/gstack-cso`, `/gstack-office-hours`
- `/gstack-autoplan` (with sequential review pipeline)
- `/gstack-plan-ceo-review`, `/gstack-plan-eng-review`, `/gstack-plan-design-review`
- `/gstack-retro`, `/gstack-canary`, `/gstack-health`, `/gstack-learn`
- ... and 30+ more

These suppressions can be re-enabled in a follow-up after validating
Copilot CLI's `task` tool semantics with real sessions.

## Custom instructions

Copilot CLI auto-loads custom instructions from several locations
(see [Copilot CLI custom instructions docs](https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)):

- `$HOME/.copilot/copilot-instructions.md` (personal, all sessions)
- `<repo>/.github/copilot-instructions.md` (project-wide)
- `<repo>/AGENTS.md`, `<repo>/CLAUDE.md`, `<repo>/GEMINI.md` (also auto-loaded)
- `<repo>/.github/instructions/**/*.instructions.md` (scoped to file globs)

gstack respects all of these. CLAUDE.md is intentionally **not** rewritten
to AGENTS.md by the host config: gstack templates use CLAUDE.md as state
storage (skill routing, state hooks, telemetry), and Copilot CLI reads both.

## Uninstall

`bin/gstack-uninstall` includes Copilot CLI cleanup. To remove manually:

```bash
rm -rf ~/.copilot/skills/gstack*
```

## Troubleshooting

### `copilot` command not found

Install via `npm install -g @github/copilot` (or `brew install copilot` /
`winget install GitHub.CopilotCLI`). The standalone Copilot CLI is **not**
the same as the older `gh copilot` extension; gstack auto-detection looks
for the `copilot` binary specifically.

### Skills not showing in `/skills list`

1. Confirm install: `ls ~/.copilot/skills/` should show `gstack-*` directories.
2. Reload skills inside Copilot: `/skills reload`.
3. Check `SKILL.md` is present in each skill dir:
   `ls ~/.copilot/skills/gstack-review/SKILL.md`.

### A skill mentions "Agent tool" or "Bash tool"

Tool name rewrites cover the documented patterns (`use the X tool`,
`the X tool`, bare `X tool`). If you find a leak, please file an issue at
<https://github.com/garrytan/gstack/issues> with the skill name and the
exact phrase - it just needs another rewrite rule.

### Want the orchestration features back

Track the follow-up work to enable `REVIEW_ARMY`, `ADVERSARIAL_STEP`, and
`DESIGN_OUTSIDE_VOICES` for Copilot at <https://github.com/garrytan/gstack/issues/393>.
