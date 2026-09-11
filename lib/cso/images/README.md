# CSO runtime build and qualification

These recipes are trusted runtime inputs, not application Dockerfiles. The base
and tool inputs are reviewed and pinned per native platform; the resulting
gstack images are not yet published or qualified. `runtime-catalog.json`
records all ten build-reviewed profiles and deliberately contains no executable
image until the release gates have passed.

Trusted CI re-resolves each recorded source tag to its reviewed index digest,
proves that the native manifest is a member of that index, inspects its native
image configuration, and executes exact version probes without network access.
It validates `BASE_IMAGE` (and Python's `UV_IMAGE`) as reviewed
`repository@sha256:<64 lowercase hex>` references before building. Build each
profile on Linux amd64 and arm64, record exact runtime and package-manager
versions, generate an SBOM and provenance attestations, and verify those
attestations before proposing a catalog change. The catalog records their
digests, the source commit, and the qualification run. A tag, a successful image
build, or an agent-provided `qualified` assertion is insufficient.

The Rails base additionally needs a compiler, SQLite and PostgreSQL development
headers, and the exact Bundler version from its supported fixture matrix.
Unsupported native libraries are prerequisites. The Python base includes pip;
the separate uv image supplies the exact qualified uv executable.

The PostgreSQL sidecar is a separate qualified image. It runs as fixed uid/gid
10001, creates every validated synthetic Rails database from a read-only policy,
and exposes PostgreSQL only on the reproduction group's loopback namespace.
Qualification must prove readiness for every declared database before Rails is
started and must rebuild a fresh sidecar for each before/after phase.

All recipes use the fixed `/opt/cso/entrypoint`, uid/gid 10001, and no application
source. The runner must still impose network namespaces, seccomp, dropped
capabilities, no-new-privileges, a read-only root, bounded tmpfs mounts, resource
admission, disabled daemon logging, and a detached watchdog. The image's USER and
ENTRYPOINT alone provide none of those guarantees.

Each application image also contains the compiled `/opt/cso/preparation`
helper. Its reviewed version is recorded as `cso-preparation: 1.0.0` in the
image build inputs and runtime catalog. Qualification exercises its
registry-broker forwarder, lock-bound archive manifest, and offline cache
seeding before a digest can be promoted.

Application qualification also exercises the embedded `/opt/cso/verifier`
against positive and deliberately failing assertions. This is independent of
the cold-start and private held-out repair gates. PostgreSQL uses its separate
multi-database and readiness qualification and cannot present application-only
qualification fields.

The Bun image includes a reviewed `/opt/cso/no-auto-install.toml`. Canonical
Bun start and test commands also pass `--no-install` and that exact config, so
target execution cannot trigger Bun's runtime automatic installer. The earlier
offline `bun install` phase still runs admitted lifecycle scripts with network
disabled.

`preparation.ts` emits acquisition metadata and command descriptions. Acquisition
containers receive that metadata and verified public archives only; project code,
Gemfiles, hooks, and native extensions run in subsequent network-none containers.
Registry host restrictions require the trusted runner's deny-by-default egress
mechanism and redirect/DNS checks. Package-manager flags alone are insufficient.

Source references inspected for these contracts:

- [Bun installation and frozen locks](https://bun.com/docs/pm/cli/install)
- [uv export and `--no-emit-local`](https://docs.astral.sh/uv/reference/cli/)
- [RubyGems fetch](https://guides.rubygems.org/command-reference/#gem-fetch)
- [Docker attestations](https://docs.docker.com/build/metadata/attestations/)

Version the catalog together with helper ABI 3. A rollback selects the previous
compatible pair. Persisted reports remain readable independently of which
runtime pair is active.

Pull requests run the native build-only matrix without registry publication.
Protected main publishes staging images. A separate protected promotion
workflow accepts exactly ten `qualified-runtime.json` statements from one
successful main run, checks them against the reviewed build matrix, and emits an
attested `runtime-catalog.candidate.json`. It verifies that attestation against
the exact candidate bytes, source commit, protected-main ref, and promotion
workflow identity. A previous-revision compare-and-swap then copies those exact
bytes to a fresh branch and opens an ordinary review PR. The workflow never
updates `main` directly. The catalog validator also recomputes the retained
runtime-matrix digest; the complete release-gate statement digest remains a
separate provenance field.

GHCR creates each new staging package private. After its bootstrap publication,
a package administrator must make it public in GitHub's package settings before
the workflow can continue; GitHub treats that visibility change as
irreversible. Staging, native qualification, private qualification ingress, and
catalog promotion all fail closed unless GitHub's package API reports `public`
and a Docker client using a fresh config with empty `auths`
pulls the exact platform digest. The protected workflows never treat their own
GHCR login as evidence that users can acquire a promoted runtime.

Each application statement must attest successful containment, public-only
acquisition, offline lifecycle work, cold start, positive and deliberately
failing verifier assertions, watchdog cleanup, secret-canary checks, the
accuracy gates, and a private held-out runtime-tested repair. Rails also requires both
database modes and native extensions. PostgreSQL requires containment, cold
start, multiple databases, readiness, watchdog cleanup, and secret canaries.
Until a protected run produces all ten statements, the reviewed profiles remain
visible to `--doctor` but target execution returns
`MISSING_QUALIFIED_RUNTIME`.

The protected `cso-runtime-release` environment also defines
`CSO_QUALIFICATION_ACTOR`, the service account allowed to send the
`cso-runtime-qualified` repository dispatch. The ingress workflow verifies the
actor, re-verifies each staged OCI provenance and SBOM attestation, normalizes
the evidence to its own run identity, and validates the full matrix before it
uploads `cso-qualified-runtime-statements`. Private assertion content never
enters this repository or the artifact.
