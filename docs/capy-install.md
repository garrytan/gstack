# Installing gstack on a Capy cloud machine

`bin/gstack-capy-install` installs gstack on a fresh Capy cloud machine
(Ubuntu) and ends with one line a parent agent greps. It is the repo-owned
installer the user-scope Capy skill runs after cloning; nothing in the skill
decides what "installed" means.

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.local/share/gstack
~/.local/share/gstack/bin/gstack-capy-install --for autoplan
```

What it does, in order:

1. Reuses the checkout it lives in (or clones into `--root <dir>`), under a
   lock. It never resets or pulls an existing checkout. `--revision <ref>`
   pins a fresh clone; an existing checkout at another revision is reused and
   the trailer says `(requested <ref>; run gstack-upgrade to move)`.
2. Preflight: `git`, `curl`, `node`, `jq`, then Bun. The default Capy image
   ships Bun 1.3.14, below gstack's supported minimum (1.4.2), so the installer
   downloads the exact release archive, verifies its SHA-256 against
   `bin/gstack-bun-version.sh` and installs it to `$BUN_INSTALL` (default
   `~/.bun`). It does that only when gstack's minimum and the target project's
   Bun pin (`--project <path>`, default the git toplevel of the current
   directory) agree; a conflict prints both constraints and stops
   (`RUNTIME_PIN_CONFLICT`, exit 3) before anything is installed.
3. `./setup --host claude --no-prefix`, then `./setup --host codex --model
   gpt-6-astra`, both with `--no-browser`: Chromium is lazy by default.
4. `gstack-doctor --check` for the requested workflow (`--for <skill>`,
   `--only <skill>`, or `--require <id,id>`; default `claude,codex,patch`).

## The one line to grep

The last line is the doctor's trailer:

```
gstack: ok 1.91.70.0 for=autoplan
gstack: fail runtime,pins
```

Exit 0 only with `gstack: ok`. Read the exit status and the trailer directly:

```bash
out=$(~/.local/share/gstack/bin/gstack-capy-install --for autoplan 2>&1); rc=$?
printf '%s\n' "$out" | grep '^gstack: '
[ "$rc" -eq 0 ]
```

Never pipe `--check` (or the installer) through `tail`, `head` or `grep`
alone: the pipe's exit status replaces the doctor's, and a silent failure is
the incident this installer exists to end. Every `FAIL <id>` row carries a
`fix:` clause and a reason code with its [troubleshooting
anchor](troubleshooting.md#install-check-gstack-doctor---check-and-the-capy-installer).
A parent agent confirms each subagent machine with this grep; one machine's
install never covers another.

## Browser

The default install prints `SKIP browser (lazy; gstack-browser-ensure
installs on first use)` and downloads nothing. The first browser skill run
(`/browse`, `/qa`, `/design-review`, ...) calls `bin/gstack-browser-ensure`
from its preflight, which installs Chromium (~115 MiB, about 86 s on a Capy
machine) under setup's lock and prints `BROWSER_OK` or `BROWSER_UNAVAILABLE
<reason>`. `--with-browser` installs it during the install instead, and the
installer then prints the planning-only install time and the browser bootstrap
time separately.

## The launch line

The installer's last lines include:

```
GSTACK_LAUNCH: GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=<path> GSTACK_EPHEMERAL=1
```

A child shell's `export` cannot configure the parent's later commands, so the
parent supplies these assignments to every gstack command it launches (prefix
the command, or export them once in the shell that runs it).
`GSTACK_EPHEMERAL=1` tells gstack the disk vanishes with the machine, so the
doctor's `state root` row reads `durable=no` and unattended runs say
`learnings: skipped` instead of writing silently. A durable root is opt-in:
set `GSTACK_STATE_ROOT` to a directory that outlives the machine. The
installer only prints the option and never writes to the Capy drive (its
policy excludes memory and verification evidence). See
[docs/state-root.md](state-root.md#ephemeral-machines).

## Exit codes

| Exit | Meaning |
|-----:|---------|
| 0 | `gstack: ok` — every required component passed |
| 1 | `gstack: fail <ids>` — a required component failed; each row has a fix |
| 2 | usage error |
| 3 | preflight stopped before `./setup` (`INSTALL_PREFLIGHT_FAILED`, `RUNTIME_PIN_CONFLICT`); nothing was installed |
