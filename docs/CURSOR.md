# Cursor support

gstack supports Cursor's IDE Agent and Agent CLI through generated Agent
Skills. Cloud Agent environments can run the same workflows after installing
the skills and runtime in their VM.

## Install

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack
./setup --host cursor
```

The installer:

- generates Cursor-native skills in `.cursor/skills/`
- installs them globally to `~/.cursor/skills/gstack-*/`
- installs shared binaries, browser tooling, templates, and references under
  `~/.cursor/gstack/`
- detects either the official `agent` CLI or the Cursor desktop `cursor`
  command when `./setup --host auto` is used

The runtime lives outside `~/.cursor/skills/` because Cursor scans skill
directories recursively. This prevents support files that contain `SKILL.md`
from appearing as duplicate skills.

## Use in the IDE

Restart Cursor after installation, open Agent, and type `/gstack-` to see the
installed workflows. For example:

```text
/gstack-office-hours
/gstack-plan-eng-review
/gstack-qa
/gstack-review
/gstack-ship
```

Cursor can also select a skill automatically from its description. Skills that
can change safety state, push code, merge, or deploy are marked
`disable-model-invocation: true`, so they require an explicit user invocation.

## Use from Cursor CLI

Run the official Agent CLI in any repository:

```bash
agent
```

The CLI discovers the same global skills and supports the same slash commands.
It also reads the repository's `AGENTS.md` and `.cursor/rules`. Generated
gstack skills use Cursor's shell, file, search, and subagent terminology and
write shared project guidance to `AGENTS.md`.

## Use with Cloud Agents

Cloud Agents run in fresh remote environments, so install gstack in the
environment's update command or save an environment snapshot after installing
it. A reusable update command is:

```bash
export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  mkdir -p "$HOME/.npm-global"
  npm install -g --prefix "$HOME/.npm-global" bun
fi
mkdir -p "$HOME/.gstack/repos"
if [ -d "$HOME/.gstack/repos/gstack/.git" ]; then
  git -C "$HOME/.gstack/repos/gstack" pull --ff-only origin main
else
  git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$HOME/.gstack/repos/gstack"
fi
"$HOME/.gstack/repos/gstack/setup" --host cursor
```

Add project-specific build and test commands under a
`## Cursor Cloud specific instructions` section in `AGENTS.md`. For a
repository-owned environment, put the update command in
`.cursor/environment.json` as its `install` value. Keep credentials in Cursor
Secrets, never in that file.

Cloud Agents support gstack workflows that can run on their Linux VM,
including planning, implementation, review, browser QA, and shipping. Hardware
workflows still need their hardware: the real-device iOS skills require a Mac
and iPhone connection. Cloud MCP servers are configured from the Cloud Agent
MCP controls, independently of gstack.

The Cloud web prompt's slash-command picker runs before the VM and its update
command start. It therefore cannot autocomplete skills installed into
`~/.cursor/skills/` by the environment. Invoke a workflow in ordinary text,
for example:

```text
Use the gstack-office-hours skill installed at
~/.cursor/skills/gstack-office-hours/SKILL.md. Read it and follow its workflow.
```

The workflow runs normally after the VM starts. Pre-launch slash autocomplete
requires a Cursor plugin installed at user/team/workspace scope, or project
skills committed under `.cursor/skills/`; neither distribution channel is
included in this installer.

## Cursor features and gstack

| Cursor capability | gstack integration |
|---|---|
| Agent Skills | All generated workflows install under `~/.cursor/skills/` |
| IDE/CLI slash commands | Skills are invoked as `/gstack-<name>` |
| Automatic skill selection | Enabled for non-sensitive workflows |
| `AGENTS.md` and rules | Generated guidance uses `AGENTS.md`; project rules continue to apply |
| Subagents and terminal tools | Skill wording is adapted to Cursor's tools |
| IDE Agent and CLI | Share the same global installation |
| Cloud Agents | Run the same workflows after environment setup; pre-launch slash autocomplete is not included |
| Browser QA | Shared browse runtime installs under `~/.cursor/gstack/` |
| MCP and hooks | Cursor's project/team configuration continues to work; gstack does not replace it |

No Cursor plugin, MCP server, or custom hook is required for IDE, CLI, or Cloud
runtime execution. A plugin or committed project skill is required only when
Cloud pre-launch slash autocomplete is a requirement.

## Update or uninstall

```bash
cd ~/gstack && git pull --ff-only && ./setup --host cursor
~/.cursor/gstack/bin/gstack-uninstall
```

## Cursor documentation

- [Agent Skills](https://cursor.com/docs/skills)
- [Cursor CLI](https://cursor.com/docs/cli/overview)
- [Cloud Agents](https://cursor.com/docs/cloud-agent)
- [Cloud environment setup](https://cursor.com/docs/cloud-agent/setup)
- [Rules and AGENTS.md](https://cursor.com/docs/rules)
