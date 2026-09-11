# Building and qualifying CSO runtimes

`bun run build:cso` compiles the trusted launcher, helper, and independent
watchdog. Bun must support all four `--no-compile-autoload-*` switches. macOS and
Linux also require a C compiler (`cc`, Clang, or GCC). Linux links the launcher
statically; macOS signs it with the hardened runtime. `bun run build` includes
this step and remains a strict release/developer build. Setup feature-probes the
four Bun switches and the host native toolchain before building. If either is
unavailable, it builds the rest of gstack, removes any stale CSO helpers, and
reports `/cso` unavailable; the skill then reports `not assessed` and never
substitutes repository tooling. Re-run setup after installing the prerequisite.
When the probe succeeds, setup keeps the strict failure behavior and checks the
artifacts for freshness. The generated
`bin/gstack-cso-launcher` is the setup-built direct command; the compiled core
is not the entrypoint. The core's direct-invocation marker catches accidental
misuse; it does not authenticate a process against the trusted same-user host.
The native launcher is the pre-runtime boundary that strips Bun, Node, and
loader injection variables. CSO is not exposed as an npm package bin: its native
launcher, compiled core, watchdog, and hidden `.gstack-cso-generation` manifest
must be built and installed together for the current host. Windows also requires
the empty `.gstack-cso-generation.lock` file from that same publication. Windows
builds the native launcher with Visual Studio 2022 Build Tools (Desktop
development with C++), discovered from Git Bash through the installed Developer
PowerShell script; only the core is compiled with Bun.
The dedicated Windows CI job checks startup, argument forwarding, and runtime
injection separately from static audit and private-state support. POSIX
watchdog execution remains unavailable there.

Every successful fresh install or upgrade asks the trusted launcher to preload
the current host platform's qualified runtime and scanner images. This is the
only automatic image acquisition path. It first validates the committed
catalogs, pins a local Unix-socket Docker endpoint, rejects remote TCP/SSH
contexts, and uses a new empty Docker configuration so pulls are anonymous.
Only fully qualified `registry/repository@sha256:...` catalog entries are
requested. Missing Docker or public registry access is a visible, nonfatal
prerequisite: static audits remain available and a later `./setup` retries.
The preload stage has one 30-second aggregate deadline across endpoint checks,
local image inspection, downloads, and post-download admission. When a registry
prerequisite stops further downloads, setup still checks later catalog entries
locally and reports every already-present digest. Reaching the aggregate
deadline stops all remaining work, reports the uninspected entries explicitly,
and leaves them for the next setup run.
Application, verifier, and scanner execution still use `--pull=never` with no
egress. `gstack-cso doctor --repo PATH` never downloads; it reports a qualified
profile unavailable until that exact digest and platform are already present
in the local daemon.

The ordinary free suite exercises contracts without requiring Docker. The
`cso-docker-integration` CI job sets `GSTACK_CSO_DOCKER_TESTS=1`; unavailable Docker
or missing containment prerequisites fail that job. Run it locally with a
working local daemon:

```bash
bun run build:cso
GSTACK_CSO_DOCKER_TESTS=1 bun run test:cso:docker
```

When the staged-image workflow supplies `GSTACK_CSO_TEST_IMAGE`, platform,
stack, and exact tool versions, the same command also runs stack-specific
qualification journeys. A second native qualification job waits for every
same-architecture staging job, so Rails receives both its application digest
and the staged PostgreSQL digest; a missing matching artifact fails the gate.
The Node journey starts with an empty public archive
cache, acquires an integrity-pinned dependency through the registry-restricted
broker, installs and executes it offline, reproduces a producer-visible fixture
defect, and verifies a patch bound to its recorded closure and preparation
proofs. The helper issues a `runtime_tested` `RepairBundle` only when its
out-of-process witness authenticates the external assertions. Canonical project
tests run in a target-controlled process, so their completion remains
`self_reported`: target code can forge reporter output or terminate the runner.
Recorded command, count, exit, and output hashes are diagnostic evidence; they
do not establish target-independent test completion. The `tested` state remains
reserved for a future target-independent witness and is not emitted today.
Until the runtime-tested bundle, replay, and current-source recheck journey
passes, the held-out repair gate remains pending and catalog
promotion is prohibited. The candidate journey also asserts that no run-owned
containers, preparation call directories, archive staging directories, or
verification work directories remain. A skipped staged-image journey is not a
passing cold-start or private held-out-repair result. Bun and Python have cold acquisition, offline install,
boot, control, and project-test journeys. Rails runs those checks twice against
the same cold public-gem inputs: once with two disposable SQLite connections
and once with two databases in a fresh staged PostgreSQL sidecar. The Rails
fixture builds the source-platform `sqlite3` and `pg` native gems only in the
offline execution phase.

For hashed Python requirements resolved by pip, the broker records the requested
index URL, allowed contacted hosts, and verified wheel hash. Pip's internal
`files.pythonhosted.org` response URL is opaque to that TLS boundary, so
`resolvedUrl` remains `null`; `registryResponseSha256` identifies the acquired
archive bytes, not a verified response URL.

Image publication starts with the committed
[`build-inputs.json`](../lib/cso/images/build-inputs.json). Its reviewed revision
pins distinct native manifests for every stack and the SBOM generator. Each
profile records the inspected source tag and immutable index for provenance,
then `baseImages` keyed by `linux/amd64` and `linux/arm64`; Python additionally
records native uv manifests. CI fails if a source tag no longer resolves to the
reviewed index, a platform manifest is absent from that index, its image
configuration names another architecture, or an executable reports a different
runtime or package-manager version. Bun does not declare a Node version because
its container's `node` path is a Bun-backed fallback rather than a Node release.
A Bun project with a Node engine constraint therefore receives an explicit
prerequisite instead of a fabricated compatibility result.

Configure the repository's `cso-runtime-release` GitHub environment with required
maintainer review and deployments restricted to protected `main`. The
[`cso-runtime-images.yml`](../.github/workflows/cso-runtime-images.yml) workflow
runs a build-only native matrix on pull requests. Its manual publication jobs
only accept `main`. They build on native amd64 and arm64 runners, publish to
the `cso-staging` namespace, signs provenance and SBOM attestations, and verifies
the workflow identity and source commit. It then pulls that exact digest into
the local daemon for tests that prohibit implicit pulls. The per-image smoke test executes
the embedded verifier against a loopback service with both a passing control
and an intentionally failing control, alongside the containment suite. After
all staging rows finish, native qualification jobs run the matching cold-start
journey described above. The Node row additionally runs the complete lifecycle
journey.
Registry publication is staging, not runtime qualification.

GitHub Container Registry creates new packages private. Before a staging digest
can enter native or private qualification, a package administrator must make
its package public in GitHub's package settings. This is an explicit bootstrap
step because GitHub documents the visibility change as irreversible and does
not provide a supported workflow API for it. The release jobs use their scoped
workflow token to require `visibility: public` from GitHub's package REST
endpoint, then pull the exact platform digest with `docker --config` pointing
at a new directory whose `config.json` contains only an empty `auths` object.
The GitHub token, Docker credentials, contexts, certificate paths, and
credential helpers are absent from that Docker client. A private package,
metadata mismatch, failed anonymous pull, or different returned digest stops
staging, qualification, and promotion. Both
runtime and scanner promotion repeat this anonymous pull check on fresh hosted
runners before opening a catalog PR.

Review the retained staging artifacts together with all checks in
[`qualification.json`](../lib/cso/images/qualification.json). Cold-start fixtures,
held-out repair evaluations, precision/recall thresholds, crash cleanup, and all
secret-canary checks must pass before a reviewed catalog change can make a
digest executable. A successful protected-main qualification run packages one
`qualified-runtime.json` statement for each stack and architecture under the
`cso-qualified-runtime-statements` artifact. All ten statements bind the same
source commit and workflow run. The protected
[`cso-runtime-promote.yml`](../.github/workflows/cso-runtime-promote.yml) workflow
authenticates that run through the Actions API, checks every statement against
the committed build profiles, and emits an attested
`runtime-catalog.candidate.json`. The protected job immediately verifies the
candidate attestation against its workflow identity, protected-main source ref,
source commit, and exact file digest. It then compares `previousRevision` with
the source catalog, commits those same bytes to a fresh branch, and opens a
normal review PR. A concurrent catalog promotion fails the compare-and-swap or
produces a merge conflict instead of silently replacing the newer matrix.
The catalog stores a separately recomputable digest of the retained runtime
matrix and the digest of the complete external qualification statements. The
helper rejects a post-generation image or qualification mutation even if the
statement digest field was left unchanged.
Rollback retains the prior compatible catalog revision.

The public qualification ingress is
[`cso-runtime-qualification.yml`](../.github/workflows/cso-runtime-qualification.yml).
Set the protected environment variable `CSO_QUALIFICATION_ACTOR` to the GitHub
service account used by the private evaluator. After its held-out assertions and
accuracy run pass, that account sends a `repository_dispatch` event of type
`cso-runtime-qualified`. The payload has one key, `statements`, containing ten
objects with `schemaVersion`, `helperAbi`, `state`, `buildRevision`,
`runtimeId`, `stack`, `platform`, immutable `image`, exact `versions`,
`sourceCommit`, and the true-valued `checks` accepted by
`cso-runtime-promotion.ts`. The ingress checks the actor and matrix size,
re-verifies both OCI attestations against the protected staging workflow and
source commit, replaces the workflow, time, SBOM digest, and provenance digest
with values it observed, then runs the catalog generator as its final schema
gate. It uploads the statements only after that gate passes. The payload carries
no held-out assertion, application source, finding, or repair bundle.

The current reviewed profiles and unpromoted catalog establish this release
process; they do not claim published gstack images, passed containment, or
measured security accuracy.
Private held-out find-to-repair evaluations remain mandatory release gates for
Node, Bun, Python, and Rails. The producer-visible Node lifecycle fixture and the
other cold-start journeys do not satisfy those gates. Qualification artifacts
therefore record private checks as `"pending"` and `qualified: false` until all
four private evaluations and the accuracy thresholds pass. The remaining
external prerequisite is one successful protected-main run that uploads all ten
authenticated statements. This sandbox cannot create that evidence because it
has neither a native arm64 runner nor the private held-out assertions.

Attestation behavior follows [Docker's SBOM documentation](https://docs.docker.com/build/metadata/attestations/sbom/)
and [GitHub CLI's verification policy](https://cli.github.com/manual/gh_attestation_verify).
Public-package behavior follows [GitHub's package permissions documentation](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages),
[GitHub's package REST endpoint](https://docs.github.com/en/rest/packages/packages#get-a-package-for-a-user),
and [Docker's client configuration documentation](https://docs.docker.com/reference/cli/docker/),
inspected on September 11, 2026.
