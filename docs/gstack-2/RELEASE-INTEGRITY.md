# Release integrity

GStack has two explicit version identities during the 2.0 migration:

- `VERSION` and `package.json.version` are the repository/package release
  counter. They remain byte-equal and retain the existing four-slot format so
  the 1.x compatibility ship queue does not silently fail open.
- `package.json.gstack.runtimeVersion`, `runtime/index.js`, and
  `runtime/install.js` declare the managed-runtime protocol release `2.0.0`.
  Each standards-installed bootstrap separately pins one immutable artifact
  release tag. Candidate bootstraps use `v2.0.0-rc.N`; the manifest and bundle
  remain runtime-compatible with `2.0.0`. Stable bootstraps use `v2.0.0`.

They are intentionally different namespaces. CI fails if either identity
drifts inside its own namespace.

## Runtime release

The `Release runtime artifacts` workflow builds the complete managed bundle on
six native targets:

```text
darwin-arm64  darwin-x64
linux-arm64   linux-x64   (glibc)
windows-arm64 windows-x64
```

Both `v2.0.0-rc.*` and `v2.0.0` tags use the same build, signing, manifest,
attestation, and smoke path. RC tags publish GitHub prereleases so the exact
fresh-machine production bootstrap can be exercised before the stable tag is
created. Runtime compatibility and release-channel identity are deliberately
separate: archive names and manifest `version` remain `2.0.0`, while URLs and
Sigstore certificate identity bind to the immutable RC or stable tag that
actually published them.

Each archive has one `gstack/` root and no symlinks. CI records an exact byte
count and SHA-256, signs the archive keylessly with Cosign, emits a Sigstore
bundle, and also creates a GitHub build-provenance attestation. The release
manifest contains only official GitHub Release URLs and the fixed workflow
certificate identity.

Browser-capable archives include the Playwright-managed Chromium directory at
`.gstack-runtime-browsers`. The builder runs `playwright-core install chromium`
only—never `--with-deps` or `sudo`—copies physical files into the immutable
slot, and launch-smokes that exact Chromium on every native release runner.
The stable capability launcher sets `PLAYWRIGHT_BROWSERS_PATH` to the active
slot; it does not rely on an operator's global Playwright cache.

Each official artifact also owns its Bun executable. Release CI pins Bun
1.3.14, copies that physical executable into
`.gstack-runtime-tools/bun[.exe]`, records its relative path and probed version
in `.gstack-bundle.json`, and exposes it through the stable `$GSTACK_HOME/bin/bun`
launcher. The tagged Bun license inventory and source/relink notice are
vendored under `runtime/licenses/` and their expected hashes are release-gated.

The native release smoke removes the `setup-bun` directory from `PATH`, supplies
only an explicit `GSTACK_NODE`, runs the stable managed-Bun launcher, and opens
`about:blank` through the installed browser before cleanup. Compiled browser
clients use their adjacent `server-node.mjs` on every platform, so browser,
design, and PDF readiness does not depend on a host-global Bun installation.

The bootstrap always verifies the manifest schema, target, exact byte count,
and SHA-256 before extraction. If Cosign is already installed it additionally
verifies the Sigstore bundle, certificate identity, and GitHub Actions OIDC
issuer. Cosign is not downloaded or required on an end-user machine.

The official Linux archives are glibc builds. The bootstrap detects a musl
host before any network request and returns a typed unsupported-platform error;
it does not download a glibc archive that cannot validate on Alpine. Musl is
not claimed by the current six-artifact release matrix.

Runtime tool requirements are capability-scoped. Node is the bootstrap and
stable-launcher floor. On Windows, retained shell-based helpers additionally
require Git for Windows Bash; doctor reports that check explicitly. Python 3 is
only required by specialist flows that label it as a prerequisite. Missing
Bash or Python does not change the native browser/design/PDF payload or turn
those capabilities into host-global Bun consumers.

## npm package

The npm tarball is a small runtime-control/bootstrap package, not a second
GStack installer. Its allowlist contains the Node-only runtime control plane,
the `gstack` launcher, documentation, license, and version marker. It excludes
the six skills and large compiled capability payloads. Skills come from the
Agent Skills installer; optional capability payloads come from the verified
runtime release only after approval.

CI packs the tarball, installs it into an isolated directory, invokes
`gstack --version`, initializes isolated state through `gstack setup`, and
invokes `gstack-runtime-bootstrap --help`. It also enforces conservative packed
size and entry-count ceilings.

## Dependency audit policy

`puppeteer-core` was unused and removed. Playwright remains the only browser
manager. Bun's current audit command does not distinguish production from
development dependencies, so CI gates critical advisories across the entire
lockfile and reports the complete audit. At the 2026-07-20 checkpoint, the
remaining high advisories are under the retained development-only Claude Agent
SDK and Hugging Face evaluation stack; neither is copied into the managed
runtime. They must be re-audited before changing those test SDKs or promoting
the release status.

## Static-analysis disposition

- Shell syntax and high-confidence ShellCheck errors are gated on setup and
  release/build boundaries. Runtime JavaScript is syntax-checked with the
  supported Node floor. Workflow actions are pinned and actionlint remains its
  own gate.
- Added production/docs lines are scanned by GStack's deterministic redaction
  engine. Removed lines do not block credential cleanup. Known synthetic-secret
  fixture/evaluation paths are excluded so the gate stays meaningful; those
  paths retain dedicated redaction tests.
- The repository has no TypeScript compiler dependency or `tsconfig.json`.
  Calling Bun transpilation a typecheck would be false, while enabling `tsc`
  across the legacy mixed JS/TS/generated tree is a separate migration. This
  candidate records typecheck as not yet enforceable rather than a green gate.
- There is no repository formatter or general source-linter configuration.
  Introducing one during release hardening would mechanically rewrite
  byte-pinned generated and parity corpora. Actionlint, ShellCheck, runtime
  syntax, existing tests, and generated-freshness checks are enforced now; a
  formatter/linter migration remains explicit follow-up work.
- No `CODEOWNERS` file is invented. Git history identifies contributors but
  does not prove the current GitHub user/team with review authority in the
  `time-attack` organization. Repository administrators must name a real team
  and enable required CODEOWNER review together; until then ownership review
  is an open governance control, not a fabricated file.
