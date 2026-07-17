# GStack 2 host compatibility

This matrix uses evidence tiers. It does not call a host “supported” merely
because its directory name exists in legacy setup code.

## Tiers

| Tier | Meaning |
|---|---|
| **Portable** | The canonical `skills/<name>/SKILL.md` tree follows the Agent Skills specification and uses no required host-private placement logic. This is a source-format claim. |
| **Verified** | The named layer and matrix cells passed against a recorded host/installer version. A scoped “Verified — installer” claim does not imply the host UI launched or executed judgment. |
| **Native** | A necessary host API adds behavior unavailable through portable skills while consuming the same canonical judgment source. Native is not “better”; it carries an additional adapter maintenance contract. |

Tiers are cumulative only when evidence says so. A portable host is not
automatically verified. A legacy generated host output is not a native GStack 2
bundle.

## Canonical installation

```bash
npx skills add time-attack/gstack
```

The standards installer owns host detection, destination paths, project/global
scope, copy versus symlink, updates, removal, and selected-skill installation.
Review its detected-host prompt; detection must never silently enroll a host.

Examples supported by the installer interface:

```bash
# One public skill only
npx skills add time-attack/gstack --skill plan

# Installer-managed global scope
npx skills add time-attack/gstack -g
```

Run `npx skills add --help` for the installed CLI version before scripting
agent-selection flags. GStack deliberately does not reproduce those flags or
host paths in `./setup`.

The expected discoverable names are exactly:

```text
plan
design
qa
debug
review
ship
```

`compat/*.md` and `references/legacy/*.md` are not `SKILL.md` files and must not
appear as additional skills. Installing a subset must not pull the other five
public entries unless the user selected them.

## Candidate installer matrix

The isolated standard-installer matrix passed 470/470 checks with `skills` CLI
1.5.19: 16 install cases and two removal cases. Default discovery projected
only canonical `skills/`; separate explicit-selection cases covered a single
canonical skill and an opt-in legacy alias. The matrix used symlinked and spaced
source paths matching a clean checkout where ignored legacy host trees are
absent. Every installed file was a physical copy and its hash matched the
selected source. The standard skill installation remains Markdown-only and
does not install the optional runtime. The committed evidence artifact is
[`evals/installation/install-matrix.json`](../../evals/installation/install-matrix.json).

| Host | Portable | Project all-six | Global all-six | Selected-skill coverage | Installer tier | Host UI/process |
|---|---|---|---|---|---|---|
| Claude Code | yes | pass | pass | no separate subset case | **Verified — installer** | pending |
| OpenAI Codex | yes | pass | pass | global `qa`, `review`, `ship` pass + removal pass; opt-in alias covered | **Verified — installer** | v1/v2 failed; live v3 pending |
| Cursor | yes | pass | pass | project `qa`, `review`, `ship` pass + removal pass | **Verified — installer** | pending |
| Pi | yes | pass | pass | no separate subset case | **Verified — installer** | pending |
| OpenClaw | yes | pass | pass | project `ship` single-skill pass | **Verified — installer** | pending |
| GitHub Copilot | yes | pass | pass | no separate subset case | **Verified — installer** | pending |

The representative selection cases installed exactly `qa`, `review`, and
`ship`, independently at project scope for Cursor and global scope for Codex,
then removed them noninteractively. Separate cases installed only `ship` for
OpenClaw and explicitly selected the `office-hours` compatibility alias for
Codex; neither alias nor unselected canonical skill was silently enrolled.
`--copy` was advertised and used.

This is filesystem/installer verification, not a claim that six host UIs loaded
or executed the skills. The Codex adversarial lane has no passing live result:
v1 and immutable v2 failed, while v3 is green only in its offline 18-test /
111-assertion harness and has not run live. The installer matrix used the
current local canonical projection through the published `npx skills` CLI, not
the still-unpushed GitHub branch URL.

Legacy generators currently know ten host names. That is historical breadth,
not proof that all ten install correctly. Kiro's old Codex-rewrite behavior and
other host-output transforms are outside the canonical 2.0 path.

## Verification procedure and evidence

Use a clean temporary home and project for every cell; never test against an
operator's live skill directory.

1. Record OS, host version, Node/npm version, and `skills` CLI version.
2. List the source and assert exactly six default entries.
3. Install all six at project scope and verify each host discovers only those
   six GStack public skills.
4. Remove them through the standard installer.
5. Repeat at global scope.
6. Install a selected subset; verify unselected skills were not enrolled.
7. Reinstall/update without re-detecting or enrolling an unselected host.
8. Invoke a pure judgment mode with `gstack` absent from `PATH`.
9. Invoke a capability-dependent mode and verify one actionable runtime offer,
   without breaking judgment.
10. Exercise a path containing spaces and, where supported, symlink and
    read-only failure behavior.
11. Record exact command, exit status, output artifact, and cleanup result in
    [TEST-EVIDENCE.md](./TEST-EVIDENCE.md).

The automated filesystem portion is:

```bash
bun test test/gstack2-installation.test.ts
bun run scripts/gstack2/test-install-matrix.ts --full \
  --output /tmp/gstack2-install-matrix.json
```

The current matrix passed 470/470 installer CLI checks across 16 installs and two
removals; its JSON artifact is committed at
[`evals/installation/install-matrix.json`](../../evals/installation/install-matrix.json).
Steps 8–9, a passing live v3 adversarial run, and actual host UI loading remain
separate behavioral gates.

## Optional runtime/platform matrix

The optional runtime is separate from skill placement. From a repository
checkout, the one host-neutral setup entrypoint is:

```bash
./setup
~/.gstack/bin/gstack doctor --json
```

`./setup` resolves a symlinked checkout, installs dependencies only when absent,
builds missing allowlisted capabilities through the runtime-only build target,
validates and hashes every staged file, smoke-tests the CLI, atomically
activates the version, and writes stable POSIX and Windows launchers under
`$GSTACK_HOME/bin` (default `~/.gstack/bin`). The bundle uses `.exe` targets on
Windows and includes the CoreDevice/iOS bundle only on Darwin. Add the bin
directory to `PATH` if the short `gstack` command is desired.

Twenty-one focused installer tests pass with 307 assertions. They cover
manifests, paths with spaces,
source-root symlinks, internal-link/path-escape rejection, failed build/
validation/smoke rollback, interrupted-pointer recovery, stable POSIX/Windows
launchers, runtime-only builder selection, managed uninstall, and the
host-neutral wrapper.

The current managed-bundle audit records 107 components, 1,830 files,
459,056,031 bytes, and 50 launchers. Setup installs frozen production-only
dependencies and excludes the development-only Claude Agent SDK. The
Sharp/ngrok closure is included. The Hugging Face sidecar is excluded and its
package is development-only, so setup installs neither its inference runtime
nor model weights and reports the L4 capability unavailable.

| Platform | Source-level target | Candidate evidence |
|---|---|---|
| macOS | Node runtime + local browser + physical iOS where applicable | Runtime installer 21/307 and current bundle audit pass. The uninterrupted broad singleton run is green at 6,234 pass / 226 expected skips / 0 fail across 383 files. The signed-device gate remains pending. |
| Linux | Node runtime + local browser | Declared Dev Container focused suite passed at 43/0 with 265 assertions. A clean Linux arm64 container used production-only install with the development SDK absent, passed a local-browser journey and Sharp full-page screenshot, and uninstalled while preserving state. Native-host broad Linux remains pending. |
| Native Windows | Node runtime; curated free tests; browser fallback where retained | **Blocked:** native Windows CI pending. The local Windows-safe singleton lane is green at 2,813 pass / 57 expected skips / 0 fail across 213 files, but it is not native evidence. |
| Dev Container | Pure skills and optional runtime; browser only when container supports it | Declared image builds; focused GStack 2 suite and clean runtime install smoke pass. Full broad/browser coverage remains pending. |

The six portable skills remain useful when runtime installation fails. A
runtime failure must not remove or corrupt their standard-installer placement.

## Native adapters

No GStack 2 native tier is currently required or awarded. A future native
bundle needs an accepted issue showing that a host API is necessary, must load
the same canonical judgment modules, and must pass the portable parity suite.
Host-specific presentation metadata such as `agents/openai.yaml` does not by
itself create a second judgment source or a Native claim.
