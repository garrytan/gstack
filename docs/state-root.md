# Where gstack keeps its state

gstack keeps everything it remembers — config, analytics, sessions, projects,
learnings, review logs, the egress ledger, the trust-policy store, hook error
logs — under one directory, the **state root**. By default that is
`~/.gstack`. Set `GSTACK_HOME` to put it somewhere else.

One rule picks the root, and every gstack script, hook and skill uses it. The
rule lives in two owner files that a parity test keeps identical:
`bin/gstack-state-root.sh` (bash) and `lib/state-root.ts` (TypeScript).

## How the root is chosen

The first variable in this list with a non-empty value wins. Empty values count
as unset.

| Order | Source | When to use it |
|------:|--------|----------------|
| 1 | `GSTACK_STATE_ROOT` | `gstack-paths`' own output. It is also honored as input, so re-reading it in the same environment returns the same root. Do not set it by hand. |
| 2 | `GSTACK_HOME` | **The one variable to set** when you want your state somewhere other than `~/.gstack`. |
| 3 | `GSTACK_STATE_DIR` | Legacy alias, honored for compatibility. |
| 4 | `CLAUDE_PLUGIN_DATA` | Only when `CLAUDE_PLUGIN_ROOT` contains `gstack` (any case), so another plugin's data directory never captures gstack state. |
| 5 | `$HOME/.gstack` | The default. On Windows shells, `USERPROFILE` stands in when `HOME` is unset. |
| 6 | `.gstack` | Last resort when there is no home directory at all (some containers). |

## See which root is in use

```bash
~/.claude/skills/gstack/bin/gstack-paths --explain
```

Real output with `GSTACK_HOME` set while `~/.gstack` still holds older state:

```
state root: /home/you/work-state (selected by GSTACK_HOME)
chain (first non-empty wins):
  GSTACK_STATE_ROOT    unset
  GSTACK_HOME          /home/you/work-state  selected
  GSTACK_STATE_DIR     unset
  CLAUDE_PLUGIN_DATA   unset
  default              /home/you/.gstack  ignored
default root /home/you/.gstack also holds gstack state: yes
merged privacy keys (most restrictive value across roots wins):
  telemetry:        off (from /home/you/.gstack/config.yaml)
  memorable_recall: not set (default applies)
  codex_reviews:    not set (default applies)
  update_check:     not set (default applies)
docs: https://github.com/garrytan/gstack/blob/main/docs/state-root.md
```

`--explain` only reads; it writes nothing and exits 0. `gstack-config list`
also prints a one-line note when `GSTACK_STATE_ROOT`, `GSTACK_HOME` and
`GSTACK_STATE_DIR` name different directories.

## Move your state

gstack never moves state for you. To relocate it:

```bash
cp -a ~/.gstack /new/place/gstack-state
export GSTACK_HOME=/new/place/gstack-state   # add this to your shell profile
~/.claude/skills/gstack/bin/gstack-paths --explain   # confirm: selected by GSTACK_HOME
```

Keep or delete the old `~/.gstack` once you have checked the new root works.
Until you delete it, its privacy settings still count (next section).

## Privacy settings never get looser when the root moves

Four config keys are opt-outs: `telemetry` (off < anonymous < community),
`memorable_recall` (off < on), `codex_reviews` (disabled < enabled) and
`update_check` (false < true). gstack reads each of them from the resolved root
**and** from `~/.gstack`, and uses the most restrictive value. So turning
telemetry off once in `~/.gstack` keeps it off after you set `GSTACK_HOME`.
Every other key, including `proactive` and `founder_resources`, reads the
resolved root only.

When `gstack-config set` writes a merged key but the other root still holds a
more restrictive value, it tells you which root overrides it and prints the
command that changes that root, for example:

```bash
GSTACK_STATE_ROOT='/home/you/.gstack' ~/.claude/skills/gstack/bin/gstack-config set codex_reviews enabled
```

`gstack-config list` shows the winning root for merged keys, for example
`telemetry: off (set, /home/you/.gstack)`.

Trust-policy deny tiers merge the same way: a `deny` or `read-only` entry in
`~/.gstack/gbrain-repo-policy.json` still applies when your resolved root is
elsewhere. Nothing is ever written to the other root.

## Project buckets

Per-project state (checkpoints, learnings, timeline, question preferences)
lives in `projects/<slug>/`. `bin/gstack-slug` picks the slug from the git
`origin` remote:

- A 2-segment remote (`github.com/owner/repo`) files under `owner-repo`.
- A remote with 3 or more path segments (GitLab nested groups such as
  `gitlab.com/customer-a/product/repo`, Azure DevOps) files under
  `product-repo-<16 hex>`. The hex is a digest of the canonical remote, so
  `customer-a/product/repo` and `customer-b/product/repo` get separate buckets,
  and the ssh, https and ssh-with-port spellings of one repository share one.
- Without a remote, the project root's directory name is used.

The first slug gstack resolves in a directory sticks (it is cached under
`slug-cache/`), so a project keeps its bucket when it adds a remote later.

**Upgrading from a version that used one bucket for nested groups.** Earlier
versions filed every `<group>/product/repo` under `product-repo`. That bucket
stays where it is; gstack neither moves nor deletes it. The first time gstack
resolves the new slug it prints one notice naming both buckets, and
`/context-restore` reports the old bucket while it still holds checkpoints. To
bring earlier files across, run this in the project:

```bash
~/.claude/skills/gstack/bin/gstack-slug --adopt-legacy
```

It lists every file in the old bucket. Checkpoints are marked as matching this
project, another project (never copied), or unknown (saved before checkpoints
recorded their project). Files with no project identity (question
preferences, learnings, timeline) may belong to any project that shared the
bucket, so they are listed for you to decide. On a terminal it asks per file;
otherwise copy chosen files with
`gstack-slug --adopt-legacy --copy <path> [<path>...]`. Nothing is copied
without your confirmation, and nothing in the new bucket is overwritten.

**Pinning a slug.** Set `GSTACK_PROJECT_SLUG=<name>` to choose the bucket
yourself, for example in the project's `.claude/settings.local.json`
(`"env": {"GSTACK_PROJECT_SLUG": "<name>"}`). Use it when an ssh host alias
(`git@work-gitlab:group/sub/repo`) gives a different host than the https
remote, or for a vendored sub-repo that should be its own project. The pin is
applied per run and never cached.

## Ephemeral machines

A Capy cloud machine, a CI runner or a throwaway VM loses its disk when the
run ends, and with it every learning, decision, review-log row and timing
record gstack wrote under the default root. gstack does not guess this from
the path (a tmpfs and a home directory look alike); the host says so with one
environment marker:

```
GSTACK_EPHEMERAL=1
```

What the marker changes:

- `gstack-doctor` and `gstack-doctor --check` report the `state root` row as
  `durable=no` (the dashboard warns, the check still passes: an ephemeral root
  is a fact, not a broken install).
- Unattended sessions print `learnings: skipped (state root is ephemeral; set
  GSTACK_STATE_ROOT)` instead of writing silently to a disk that will vanish.

A durable root is opt-in: the owner sets `GSTACK_STATE_ROOT` (or `GSTACK_HOME`)
to a directory that outlives the machine. The installer never picks one for
you. On Capy the drive is governed by Capy's own drive policy, which excludes
memory and verification evidence, so `bin/gstack-capy-install` only prints the
option and never writes there.

A child shell's `export` cannot configure the parent's later commands
(`lib/state-root.ts` reads each process's own environment), so the installer
ends with one machine-readable line the parent supplies to every gstack
command it launches:

```
GSTACK_LAUNCH: GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=<path> GSTACK_EPHEMERAL=1
```

Prefix each command with those assignments (or export them once in the shell
that runs them). See [docs/capy-install.md](capy-install.md).

## Uninstall

`gstack-uninstall` deletes state only at `~/.gstack`.

- It first refuses (exit 2) when `~/.gstack` resolves — following symlinks —
  to `/`, your home directory or one of its parents, the gstack checkout, the
  current git repository, or a parent of either. The message names the reason
  and a `fix:` line.
- When the resolved root is somewhere else (you set `GSTACK_HOME`, for
  example), uninstall leaves it in place and prints
  `left in place: <path> (selected by <VAR>=<value>)` plus the exact
  `rm -rf -- '<path>'` command to run after you have checked it.
- `--keep-state` never deletes any state. `--force` only skips the prompt.

## If gstack-paths is missing

Skill blocks resolve the root with

```bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
```

(No `eval`: worktree-isolated Claude Code sessions refuse it.)

The second half stops the block instead of writing under `/` if the resolver
is broken. If you see `gstack-paths failed` or
`cannot resolve the gstack state root`, reinstall: run `./setup` in the gstack
checkout, or `/gstack-upgrade`.

## Claude Code plugin installs

gstack does not ship an official Claude Code plugin distribution today (no
`.claude-plugin` manifest has ever been on `main`; some forks publish one), and
telemetry does not report plugin-mode installs. When gstack does run as a
plugin, `CLAUDE_PLUGIN_ROOT` names gstack and state lives in
`CLAUDE_PLUGIN_DATA`, while a terminal run outside the plugin session uses
`~/.gstack`. Those are two different roots; run `gstack-paths --explain` in
each environment to see which one is active. Cross-environment support (a
pointer from `~/.gstack` to the plugin root) is deferred until a plugin
distribution exists.

## For contributors

- Bash: executables source `bin/gstack-state-root.sh` beside them and call
  `gstack_state_root_select` (sets `$_gstack_sr_root`), or `eval` gstack-paths
  with the guard above. Hooks must source the twin; never spawn gstack-paths
  from a hook.
- TypeScript: `resolveStateRoot()` and `readConfigKey()` from
  `lib/state-root.ts`.
- `test/state-root-ratchet.test.ts` fails on a hand-rolled chain, an
  executable `~/.gstack` in a template bash block, an unguarded gstack-paths
  eval or `export GSTACK_STATE_ROOT` in prose. Its allowlist
  (`test/state-root-ratchet.allowlist.json`) needs a reason per entry.
