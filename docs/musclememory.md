# MuscleMemory with gstack

MuscleMemory is optional procedural memory for Claude Code. It helps reuse reviewed project workflows across sessions, which can reduce repeated instructions and re-discovery. The gstack connection is off until you run `musclememory connect claude` in a project. Its hooks capture prompts and mapped tool calls for the configured MuscleMemory service (local by default). A run with a passing test after its last code change may produce a provisional procedure; independent checks and review are required before it’s ready. A later compatible prompt may receive a short pointer to that procedure. The pointer is guidance: Claude Code still reads the current files and decides what to do. The hooks apply to every Claude Code session in the connected project, whether or not a gstack skill started it. gstack does not install, bundle, or invoke MuscleMemory.

## Connect it

Install MuscleMemory using its [installation guide](https://github.com/TheWariend/MuscleMemory/blob/main/docs/install.md), then initialize and start its local service:

```sh
pipx install thewariend-musclememory
musclememory init
musclememory start
```

Run this from each project where you want the Claude Code hooks:

```sh
musclememory connect claude
```

This creates a Claude Code key and hook configuration under `~/.musclememory`, then adds hooks to the project's `.claude/settings.json`. Existing hooks and permission rules are preserved, with a backup saved if the file changes. Restart Claude Code to load the hooks.

## What happens

- At a prompt, MuscleMemory can add a short pointer when a compatible procedure is available. A missing or ineligible procedure adds no guidance.
- The hooks record mapped Claude Code prompts and tool calls, including arguments, results, failures, and timing. A local queue holds events until the configured MuscleMemory service accepts them.
- At session stop, a run with a passing test after its last code change can become a provisional procedure. It still needs independent checks and review before it is treated as ready.
- MuscleMemory suggests procedures as guidance. Claude Code still reads the current files, follows the normal approval flow, and runs the work; gstack does not replay stored commands.

The integration is separate from gstack's `/learn` workflow.

## What leaves the machine

| Action | Data and destination |
|---|---|
| `pipx install thewariend-musclememory` | Downloads the MuscleMemory package from the Python package index. |
| `musclememory init` | Creates local config and a database, then downloads the local search model (about 90 MB). It does not send project content. |
| `musclememory start` | Starts the service at `http://127.0.0.1:8080` by default. |
| `musclememory connect claude` | Creates a local agent key/config and edits `.claude/settings.json`; setup does not send project prompts or tool history. |
| Prompt and tool hooks | Send prompts and mapped tool-call evidence to the URL in MuscleMemory's hook config. The default URL is loopback; if you configure a remote service, that service receives the captured data. Hooks redact recognized secrets locally and keep unsent events in a private queue. |
| Optional model curation | If you explicitly select a learning agent, MuscleMemory sends bounded, redacted evidence to that configured provider for review. With curation off, the local compiler is used. |

These setup and behavior details follow MuscleMemory's documented hook contract; gstack does not implement the hook service. Requests are made by MuscleMemory's hooks and service, not by gstack, so they do not appear in gstack's `gstack-egress` ledger. See MuscleMemory's [Claude Code integration guide](https://github.com/TheWariend/MuscleMemory/blob/main/integrations/claude-code/README.md) for verification and capture details.

## Check and remove it

Run `musclememory status` to confirm Claude Code is connected. After a task, the dashboard's Activity page should show the recording; a verified session can produce a procedure marked **Needs your OK**.

To stop capture in one project, remove the MuscleMemory entries from that project's `.claude/settings.json`. To revoke the Claude Code key and remove the shared hook configuration, revoke the key from the dashboard's API keys page, then delete `~/.musclememory/keys/claude.env` and `~/.musclememory/hooks/claude.json`. Removing hooks stops future capture; it does not erase sessions or procedures already stored in MuscleMemory.

Adding MuscleMemory's MCP server alone does not capture Claude Code's other tools; use `musclememory connect claude` for the native hooks.
