# CSO scanner image release inputs

The committed scanner catalog is intentionally empty until trusted CI produces
real qualification evidence. Nothing in this directory authorizes a host tool,
a mutable tag, or an agent-supplied image.

`build-inputs.json` is the review gate. A reviewed file contains exactly six
profiles, two native image digests per profile, and one immutable SBOM generator.
Every image records its source repository and commit, signer workflow and
digest, and reviewed canonical SLSA/SPDX statement-set digests. CI uses
`gh attestation verify` with all of those identities and rejects a statement
digest mismatch before the image participates in a build. Each upstream image
must already expose the declared scanner executable. Semgrep images must contain the
reviewed local rules at `/policy/catalog/...`. OSV and Trivy images must contain
their complete offline data below `/opt/cso/scanner-data/...`; the release job
copies that path out of the staged image and recomputes its canonical content
hash before running the network-none adapter test. Preparing those asset-bearing
upstream images is an external publication prerequisite, not something an audit
may download on demand.

The wrapper normalizes every image to `/opt/cso/entrypoint` and
`/opt/cso/bin/scanner`, embeds the trusted HTTP assertion verifier needed by the
Schemathesis qualification fixture, and runs as a fixed non-root image user.
The product runner still supplies the effective host uid, read-only root,
dropped capabilities, seccomp, no-new-privileges, bounded tmpfs and shared
memory, network
namespace, disabled daemon logging, and watchdog cleanup.
Images that declare `VOLUME` are rejected; exact cleanup also removes anonymous
volumes defensively.

`.github/workflows/cso-scanner-images.yml` lets a dispatched branch run only its
read-only input and contract checks. Publishing and native qualification require
a dispatch from protected `main` plus approval through the
`cso-scanner-release` environment. That protected lane emits a complete
`catalog.json` proposal with image, version-output, asset, SBOM, provenance,
source-commit, and workflow identities. Selecting the promotion input may then
open a catalog update pull request. Review that PR like code. The helper
validates the committed catalog at startup and has no fallback when a profile is
absent or incompatible.
Promotion also requires the proposal's `previousRevision` to equal the catalog
currently on `main`, so a stale qualification run cannot overwrite a newer one.

GHCR creates a new scanner package private. A package administrator must make
the bootstrap package public in GitHub's package settings before its wrapper can
qualify; GitHub documents this change as irreversible. The qualification row
and the protected promotion job both require public package metadata and pull
the exact platform digest through a fresh Docker client config containing empty
`auths`. A workflow GHCR login cannot satisfy this gate.
