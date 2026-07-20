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
npx skills add time-attack/gstack/skills
```

The standards installer owns host detection, destination paths, project/global
scope, copy versus symlink, updates, removal, and selected-skill installation.
Review its detected-host prompt; detection must never silently enroll a host.

Examples supported by the installer interface:

```bash
# One public skill only (point selection at the canonical skill directory)
npx skills add time-attack/gstack/skills --skill qa

# Installer-managed global scope
npx skills add time-attack/gstack/skills -g
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

With `skills` CLI 1.5.19, the repository-root `--list` result is exactly these
six names. For selected installation, use the canonical `skills/` source as in
the example above. That CLI version's pre-filter display can count hidden
compatibility aliases, but the committed actual-host artifact proves that only
the selected `qa` directory was installed; the display count is not an
installed-skill count.

## Candidate installer matrix

The isolated standard-installer matrix passed 510/510 checks with `skills` CLI
1.5.19: 18 install cases and two removal cases. Default discovery projected
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
| OpenAI Codex | yes | pass | pass | global `qa`, `review`, `ship` pass + removal pass; actual selected `qa` runtime-absent run; opt-in alias covered | **Verified — installer**; runtime-absent invocation passed | live v1/v2/v3 failed; v3 was 3/4 |
| Kimi Code CLI | yes | pass | pass | no separate subset case | **Verified — installer** | browser automation uses the consented GStack local-browser fallback; host skill invocation pending |
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

This is filesystem/installer verification, not a claim that seven host UIs loaded
or executed the skills. A separate actual Codex invocation installed only `qa`
from `time-attack/gstack/skills`, with the optional runtime absent, and passed
the judgment/setup-gate behavior without changing its workspace or creating a
runtime or browser. The Codex adversarial lane still has no passing live result:
v1 and immutable v2 failed; the v3 offline harness is green at 18 tests / 111
assertions, but paid live v3 was a one-shot **3/4 failure** because review
failed compound inspection. It was not retried or relabeled. The installer
matrix used the current local canonical projection through the published
`npx skills` CLI. The release branch remained unpushed; native CI used the
temporary `codex/gstack-2-ci-20260717-39bc307b` ref only.

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

The current matrix passed 510/510 installer CLI checks across 18 installs and two
removals; its JSON artifact is committed at
[`evals/installation/install-matrix.json`](../../evals/installation/install-matrix.json).
Steps 8–9 passed for the recorded Codex runtime-absent invocation; actual UI
loading for the other representative hosts remains separate. The paid live v3
adversarial run is retained as a failed 3/4 gate, not a pending run. Evidence:
[`standard-codex-runtime-absent-2026-07-17.json`](../../evals/installation/standard-codex-runtime-absent-2026-07-17.json)
and [`2026-07-17T19-48-45Z-v3-live-gpt-5-4.json`](../../evals/host-adversarial/runs/2026-07-17T19-48-45Z-v3-live-gpt-5-4.json).

## Optional runtime/platform matrix

The optional runtime is separate from skill placement. From a repository
checkout, the one host-neutral setup entrypoint is:

```bash
./setup
~/.gstack/bin/gstack doctor --json
```

`./setup` resolves a symlinked checkout, reinstalls the frozen production
dependency set on every run,
builds missing allowlisted capabilities through the runtime-only build target,
validates and hashes every staged file, smoke-tests the CLI, atomically
activates the version, and writes stable POSIX and Windows launchers under
`$GSTACK_HOME/bin` (default `~/.gstack/bin`). The bundle uses `.exe` targets on
Windows and includes the CoreDevice/iOS bundle only on Darwin. Add the bin
directory to `PATH` if the short `gstack` command is desired.

Official bundles capture the pinned Bun 1.3.14 executable inside the immutable
runtime and expose it as `$GSTACK_HOME/bin/bun`; browser/design/PDF launchers do
not use host-global Bun. Node remains the bootstrap/launcher floor. On Windows,
Git for Windows Bash is required only for retained shell helpers and is a
separate doctor check. Python 3 is an optional prerequisite only for specialist
flows that name it. Doctor reports both tools independently of native
browser/design/PDF readiness.

Twenty-five focused installer tests pass with 341 assertions. They cover
manifests, paths with spaces,
source-root symlinks, internal-link/path-escape rejection, failed build/
validation/smoke rollback including native-load rollback smoke,
interrupted-pointer recovery, stable POSIX/Windows launchers, runtime-only
builder selection, deterministic exact Sharp/ngrok platform closure, managed
uninstall, and the host-neutral wrapper.

The deterministic clean macOS arm64 managed-bundle audit records 110
components, 1,829 files, 450,044,315 bytes, and 50 capability launchers. This
is a platform-specific bundle measurement, not a universal byte count;
platform-native package payloads differ. Setup installs frozen production-only
dependencies and excludes the development-only Claude Agent SDK. The
Sharp/ngrok closure is included. The Hugging Face sidecar is excluded and its
package is development-only, so setup installs neither its inference runtime
nor model weights and reports the L4 capability unavailable.

| Platform | Source-level target | Candidate evidence |
|---|---|---|
| macOS | Node runtime + local browser + physical iOS where applicable | Runtime installer 25/341 and the deterministic clean macOS arm64 bundle audit pass. The final native job passed 150/0 with 1,189 assertions. The uninterrupted broad singleton run is green at 6,255 pass / 226 expected skips / 0 fail and 25,509 assertions across 384 files. The physical lane later passed 12/12 harness checks and five-of-five live iterations on an explicitly authorized wired paired `iPhone17,1`; this is device-specific evidence, not universal iOS coverage. Artifact: [`ios-physical-device-2026-07-20T17-49-19-302Z.json`](./evidence/ios-physical-device-2026-07-20T17-49-19-302Z.json). |
| Linux | Node runtime + local browser | Official release artifacts currently target glibc on x64 and arm64; musl is rejected before network and is not claimed. Final native Ubuntu passed 150/0 with 1,189 assertions across 16 files. A clean glibc Linux arm64 container also passed the production-only runtime/browser lifecycle. |
| Native Windows | Node bootstrap/launcher; managed Bun; native browser/design/PDF. Git for Windows Bash only for retained shell helpers; Python 3 only for labeled specialist flows. | Doctor verifies and discloses Bun, Bash, and Python separately. Final native Windows passed 150/0 with 1,145 assertions across 16 files and standard-installer discovery found exactly six skills. The local Windows-safe singleton lane also passed 2,829 / 57 expected skips / 0 fail with 8,648 assertions across all 214 selected files. The older run predates the managed-Bun release artifact, so the new six-target release workflow remains the evidence gate for that layer. |
| Dev Container | Pure skills and optional runtime; browser only when container supports it | The declared image built; the GStack 2 suite passed 150/0 with 1,188 assertions across 16 files, followed by the clean runtime install/browser smoke and state-preserving uninstall. |

Native CI run [`29615621805`](https://github.com/time-attack/gstack/actions/runs/29615621805)
passed every job at commit `a8a5fa1aa381f9b948dfc57af26016092fc33277`:
macOS, Ubuntu, native Windows, the 470-check installer matrix, and the Dev
Container. The sanitized committed record is
[`evals/ci/native-2026-07-17.json`](../../evals/ci/native-2026-07-17.json).
Runs `29608904265`, `29611504979`, `29611757175`, `29612056517` (cancelled),
`29613668419`, `29614448170`, and `29614899434` are retained as superseded
diagnostic evidence, not substituted for the passing run.

The six portable skills remain useful when runtime installation fails. A
runtime failure must not remove or corrupt their standard-installer placement.

## Native adapters

No GStack 2 native tier is currently required or awarded. A future native
bundle needs an accepted issue showing that a host API is necessary, must load
the same canonical judgment modules, and must pass the portable parity suite.
Host-specific presentation metadata such as `agents/openai.yaml` does not by
itself create a second judgment source or a Native claim.
