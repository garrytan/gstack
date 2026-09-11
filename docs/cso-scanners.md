# Running CSO scanners

`gstack-cso scan RUN SCANNER [REQUEST.json]` collects candidate evidence through
the trusted helper when a matching qualified scanner catalog profile exists.
Recognized IDs are `gitleaks`, `osv`, `semgrep`, `zizmor`, `trivy`, and
`schemathesis`. Without a qualified profile, the command records a specific
prerequisite; static assessment and importing existing CodeQL or other SARIF
with `gstack-cso import-sarif RUN REPORT.sarif` remain available.
The returned immutable artifact can be read later with
`gstack-cso scanner-outcome RUN ARTIFACT_ID`; callers never need to open private
state files directly.

The source-controlled catalog in
[`scanner-images/catalog.json`](../lib/cso/scanner-images/catalog.json) is empty
until every release gate produces real evidence. Without a reviewed profile,
the command records a specific `not_assessed` prerequisite. Installing a
scanner on the host does not enable execution. Each profile binds a Linux
platform, immutable image digest, fixed entrypoint, absolute scanner executable,
version-probe hash, required adapter capabilities, helper ABI, and the exact
isolation-policy hash. The helper validates that catalog when it starts and has
no executable fallback.
Setup preloads the current platform's qualified scanner digests through the
trusted installation helper using anonymous public-registry access. A failed
preload or the setup-wide 30-second image deadline is a nonfatal prerequisite
and never causes an audit to pull. Doctor is
read-only and reports each scanner unavailable unless its exact catalog digest
is already present locally.

All scanner processes use Docker containment with a watchdog, shared admission
limits, read-only source, bounded output, and an isolated network namespace.
Static scanners have no network access, including when the audit omits
`--offline`. Semgrep rules and OSV/Trivy databases must be baked into the reviewed
image. Their content hashes, scope, and freshness accompany the result. Database
refresh is a separately reviewed image acquisition/release operation; scans
never download missing assets or switch to unrestricted registry networking.

`REQUEST.json` can select an exact scanner `profile`. Schemathesis additionally
requires comprehensive mode and an `api` object; `gstack-cso schema` describes
its fields. The API harness supplies a bounded OpenAPI 3.0/3.1 JSON document,
1–20 unique path operation IDs, a qualified application runtime, an absolute
start command, a numeric loopback port, a legitimate HTTP control, and the
source files defining the security boundary. Internal schema references are
allowed. Server overrides, remote references/examples, hooks, callbacks, and
webhooks are rejected. The application must boot and pass the control before
the scanner starts. Application and scanner share only the admitted loopback
namespace. An API failure is a candidate, never a reproduced vulnerability or
certified repair. Sources needing dependency preparation report that prerequisite
until a prepared offline closure is available to the API runner.

Each execution probes the scanner version before scanning and validates the
retained source both before and after collection. Unknown output, failed
diagnostics, a timeout, changed source, or incomplete cleanup cannot become an
empty clean result. The helper retains valid partial candidates when the
adapter can distinguish them from failed coverage. Output that cannot be
redacted is withheld.

Scanner and SARIF collection hold the run's mutation lock and reject finished
or interrupted reports. Every outcome is written exclusively under a unique
`scanner-outcomes/` name before its coverage record enters the report. The
returned `artifact` path is relative to the run directory. Model submissions
cannot replace `scanner:*` coverage or certify the imported candidates. The
free scanner tests use injected runners and catalogs to verify dispatch and
failure handling; they do not claim real image qualification. The opt-in Docker
qualification test runs the production adapter, image, watchdog, and isolation
policy. It emits the version-output hash only after a representative scan
completes without a coverage gap.

The release inputs in
[`build-inputs.json`](../lib/cso/scanner-images/build-inputs.json) remain
`pending` until reviewers provide all six scanners on both native platforms.
The inputs require immutable base and SBOM-generator image digests, exact source
commits and versions, signer workflow identities and digests, and reviewed
canonical SLSA/SPDX statement-set digests. The workflow cryptographically
re-verifies each image with those repository, source, signer, and predicate
constraints before use. Semgrep additionally requires a reviewed local rules bundle. OSV and
Trivy require complete offline database bundles with recorded content hashes,
freshness, and ecosystem coverage. Publishing those asset-bearing base images
and reviewing their evidence are external prerequisites; the release workflow
does not invent or silently replace them.

[`cso-scanner-images.yml`](../.github/workflows/cso-scanner-images.yml) can build
and qualify reviewed inputs from any dispatched branch without a protected
environment. It builds natively on amd64 and arm64, verifies branch-bound
attestations, recomputes embedded asset hashes, runs common containment and the
real adapter, and emits twelve immutable profile fragments plus a complete
catalog proposal. Before enabling promotion, configure the repository's
`cso-scanner-release` GitHub environment with required maintainer reviewers and
deployments restricted to protected `main`. GitHub otherwise creates a referenced
missing environment without protection rules. Promotion requires an explicit
dispatch from `main` and approval through that configured environment. It opens a pull request
containing only the proposed source catalog, so code review remains the final
authorization step. `previousRevision` records the prior compatible catalog for
rollback and must still equal the current `main` catalog when promotion runs.

Scanner flags follow the primary documentation linked in
[`scanners.ts`](../lib/cso/scanners.ts). Offline qualification must exercise
the exact chosen version: OSV's maintainers documented a cache-location
regression in 2.5.0, which demonstrates why a version string alone is insufficient.
[OSV issue #2983](https://github.com/google/osv-scanner/issues/2983).
Trivy uses an explicit memory scan cache alongside read-only baked databases.
[Trivy filesystem reference](https://trivy.dev/docs/v0.68/guide/references/configuration/cli/trivy_filesystem/).
