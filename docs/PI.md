# Pi integration

[gstack](../README.md) supports [Pi](https://pi.dev) as a native host. Pi keeps
its core CLI intentionally small and does not include sub-agents, so the Pi
integration uses the [`pi-subagents`](https://pi.dev/packages/pi-subagents)
package for delegation.

## Install

Run the normal setup command with the Pi host selected:

```bash
./setup --host pi
```

If Pi is installed and you use automatic host detection, this also works:

```bash
./setup --host auto
```

Setup installs the package at user scope when it is missing:

```bash
pi install npm:pi-subagents
```

The package provides the `subagent` and `subagent_wait` tools, the builtin
`reviewer`, `worker`, `scout`, `researcher`, `delegate`, and `oracle` agents,
and the `workflowScript` API for sequential and parallel workflows. Review the
package source before installing it because Pi packages run with full system
access.

## What setup installs

- Generated Pi skills under `~/.pi/agent/skills/gstack-*`.
- A small runtime root at `~/.pi/agent/skills/gstack` containing gstack's
  binaries and runtime assets.
- The `pi-subagents` package in Pi's global package settings.

Pi skill files are generated from the same `.tmpl` sources as the other hosts,
but their frontmatter and paths are rewritten for Pi. Delegation sections stay
enabled and refer to `pi-subagents` workflows instead of Claude Code's Agent
tool.

## Updating

Run setup again after pulling a gstack update:

```bash
cd /path/to/gstack
./setup --host pi
```

Update the Pi package separately when desired:

```bash
pi update npm:pi-subagents
```

Use `pi list` to confirm that the package is installed. If it is missing, run
`pi install npm:pi-subagents` and restart Pi (or use `/reload`).

## Troubleshooting

### `subagent` is unavailable

Install the package at user scope and restart Pi:

```bash
pi install npm:pi-subagents
pi list
```

If the package appears in `pi list` but the tool is still unavailable, run
`/subagents-doctor` inside Pi and then `/reload`.

### Skills are stale

Regenerate the Pi output from the gstack checkout and rerun setup:

```bash
bun run gen:skill-docs --host pi
./setup --host pi
```

Pi skills are generated into `.pi/skills/` in the checkout and copied or linked
to the user skill directory by setup. The generated `.pi/` directory is
runtime output and is intentionally gitignored.
