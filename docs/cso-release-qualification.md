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

No qualified runtime or scanner image exists yet, so contained runtime and
scanner execution is unavailable and setup preloads nothing: the scanner
catalog is empty while its build inputs await review, and the runtime catalog's
profiles stay unqualified until a private evaluator, still being built, can
qualify them.

Every successful fresh install or upgrade asks the trusted launcher to preload
the current host platform's qualified runtime and scanner images. This is the
only automatic image acquisition path. It first validates the committed
catalogs, pins a local Unix-socket Docker endpoint, rejects remote TCP/SSH
contexts, and uses a new empty Docker configuration so pulls are anonymous.
Only fully qualified `registry/repository@sha256:...` catalog entries are
requested. Missing Docker or public registry access is a visible, nonfatal
prerequisite: static audits remain available and a later `./setup` retries.
The preload stage reserves 30 seconds for endpoint admission and gives each
declared image a separate 30-second inspection/download window. Set
`GSTACK_CSO_IMAGE_PULL_TIMEOUT_SECONDS=120` when registry speed requires a
longer per-image window (accepted range: 5–300 seconds). The helper derives an aggregate deadline from the
catalog size and caps the complete stage at one hour. A per-image timeout leaves
that digest unavailable and continues with the next entry; reaching the hard
aggregate deadline stops all remaining work. When a registry prerequisite stops
further downloads, setup still checks later catalog entries locally and reports
every already-present digest. A later setup resumes from exact local digests.
Application, verifier, and scanner execution still use `--pull=never` with no
egress. `gstack-cso doctor --repo PATH` never downloads; it reports a qualified
profile unavailable until that exact digest and platform are already present
in the local daemon.

The ordinary free suite exercises contracts without requiring Docker. The free
lane's `cso-docker-integration` job sets `GSTACK_CSO_DOCKER_TESTS=1` and runs
`test/cso-docker-integration.test.ts`; unavailable Docker or missing containment
prerequisites fail that job. The node-lifecycle and stack-cold files need a
staged stack image, so they run in the CSO runtime workflows through
`test:cso:docker`. Run all three locally with a working local daemon:

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

Preparation output leaves its containers through `docker cp`, which cannot read
a tmpfs mount. The acquisition `/archives` directory and the offline `/work`
directory are therefore Docker local volumes backed by bounded tmpfs, created
per container with private mode, the runtime uid/gid, `nosuid`, and `nodev`
(`/archives` is also `noexec`; `/work` must stay executable for virtualenv and
binstub launchers). The runner inspects each container and refuses to start it
if Docker did not preserve those options. npm's user and global configs point
at two different empty files, because npm refuses to load one file in both
roles. Rails application and test containers hold on `sleep` after `run-app`
copies the source; `db:prepare` starts only once that copy has finished.
Changes to `/opt/cso/preparation` or an image recipe need a new staging run
before native qualification can pass.

Each supervised command has a 300-second ceiling (`COMMAND_TIMEOUT_MS` in
`lib/cso/process.ts`). Only the dependency fetch and install commands of the
acquisition and offline preparation phases get `PREPARATION_COMMAND_TIMEOUT_MS`,
900 seconds. A Rails lockfile that lists only the `ruby` platform compiles
nokogiri, sqlite3 and pg offline, which takes about 385 seconds at the app
role's 0.85 CPU share. Both ceilings are cut to the time left before the
journey's aggregate deadline, so the longer ceiling never extends a journey.
Helper probes, exports, application starts, `db:prepare` and project tests keep
the 300-second ceiling. A free test in `test/cso-docker-mounts.test.ts` pins
which calls may request the longer ceiling. The CPU share is unchanged, so
`ISOLATION_POLICY_HASH` and the profiles bound to it are unaffected.

When the in-image helper refuses to export a prepared tree, preparation fails
with error code `PREPARED_EXPORT_REJECTED` instead of the generic
`TOOL_FAILED`. The message carries the helper's exit status and its fixed
reason, such as `prepared tree contains a hard-linked file`, or the filesystem
errno and syscall. It never includes target paths. Nothing retries. Treat a
recurrence as evidence for a defect, not as a flake to rerun.

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
journey. Each native job is named `qualify-native <runtimeId>` and runs the
Docker suites with Bun's JUnit reporter
(`--reporter=junit --reporter-outfile=native-tests.junit.xml`).
[`cso-native-evidence.ts`](../scripts/cso-native-evidence.ts) maps every native
check key to the named tests that prove it for that stack and records the key
true only when the report has no failed testcase and each named test appears
once, passed, and made at least one assertion. A test that the environment
skips, such as the staged-runtime smoke test without `GSTACK_CSO_TEST_IMAGE`,
reports as skipped and leaves its checks false; any false native check fails the
job. The pending private checks are the stack's required release gates from
`cso-runtime-promotion.ts` minus its native keys: `secretCanaryPassed` and
`watchdogCleanupPassed` for PostgreSQL, plus `heldOutRepairPassed` and
`accuracyGatesPassed` for application stacks. The job uploads the JUnit report
beside `qualification-evidence.json`, which records its digest.
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

The first protected-main staging run therefore stops at the public-package
check by design: its push creates the ten `cso-staging` packages as private. A
package administrator makes those ten packages public, then dispatches the
staging workflow again. Later runs publish new digests into the same public
packages.

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
normal review PR. Pushes and pull requests made with the workflow's
`GITHUB_TOKEN` start no workflows, so after pushing the branch the job dispatches
[`free-tests.yml`](../.github/workflows/free-tests.yml) on it with
`gh workflow run free-tests.yml --ref <branch>` (its `actions: write` grant).
That run reports the required `free-tests` check on the branch head the PR
proposes. Opening the PR also requires the repository setting **Allow GitHub
Actions to create and approve pull requests** (Settings → Actions → General →
Workflow permissions). Without it `gh pr create` fails after the push and the
dispatch, and a maintainer opens the PR from the pushed branch. A concurrent
catalog promotion fails the compare-and-swap or
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
`cso-runtime-qualified`. The payload has the key `statements` and, optionally,
`evaluationRef`; no other key is accepted. `statements` contains ten objects
with `schemaVersion`, `helperAbi`, `state`, `buildRevision`, `runtimeId`,
`stack`, `platform`, immutable `image`, exact `versions`, `sourceCommit`, and
the true-valued `checks` accepted by `cso-runtime-promotion.ts`. All ten name
one `sourceCommit`. `evaluationRef` is an opaque `sha256:<64 hex>` reference
that lets the approver match the dispatch to the private evaluator's verdict.
An unprotected `dispatch-summary` job with no token permissions validates the
payload shape and writes `evaluationRef`, the source commit, and each
`runtimeId` and `image` pair to the run's job summary. The reviewer reads it
there before approving the protected `qualify` job. `evaluationRef` never enters
the normalized statements, the uploaded evidence, or the catalog.

The protected job checks the actor, re-verifies both OCI attestations against
the protected staging workflow and source commit, and replaces the workflow,
time, SBOM digest, and provenance digest with values it observed. Attestations
are signed in the staging job, before native qualification runs, so a valid
attestation alone does not show that native gates passed.
[`cso-staging-run.ts`](../scripts/cso-staging-run.ts) therefore resolves the
staging run from each verified SLSA provenance statement: the predicate's
`runDetails.metadata.invocationId` must equal the signing certificate's
`runInvocationURI`, and all ten images must resolve to the same run of this
repository. Through the Actions API (`actions: read`) the ingress then requires
that run to be `.github/workflows/cso-runtime-images.yml`, started by
`workflow_dispatch` on `main` in this repository, completed with conclusion
`success`, and built from the statements' `sourceCommit`. The latest attempt's
`qualify-native <runtimeId>` jobs, read across every page of the jobs API, must
be exactly one per committed matrix row (ten) and all `success`. The run and job
records are retained as `staging-run-evidence`. The catalog generator runs last
as the final schema gate, and the ingress uploads the statements only after that
gate passes. The payload carries no held-out assertion, application source,
finding, or repair bundle.

A qualification stays valid only while the inputs it was measured under are
unchanged. [`cso-requalification.ts`](../scripts/cso-requalification.ts) defines
four requalification triggers: the helper ABI (`CSO_HELPER_ABI`), the isolation
policy (`ISOLATION_POLICY_HASH`, which covers the `cso-isolation-v1` policy
version and every limit), `preparationSha256` (a digest of every source byte
compiled or copied into a runtime image: the import closure of the image's
verifier and preparation helpers plus the image build context), and the
`build-inputs.json` revision. The staging run's `reviewed-inputs` job records
these values for its source commit as the `cso-requalification-triggers`
artifact. The ingress downloads that artifact from the verified staging run
into the evidence, and the promotion generator writes it into
`promotion.requalification`. Generation refuses triggers that differ from the
promoting checkout, so a trigger that changed between staging and promotion
requires a new staging run. The free suite's
[`cso-requalification.test.ts`](../test/cso-requalification.test.ts) compares
the committed catalog's recorded triggers with the current source and fails
when any differs. A change to a trigger therefore either lands with a
requalified catalog or withdraws the catalog's runtimes in the same pull
request. Independently, the helper refuses to select a runtime recorded under
another isolation policy.

The judge observes held-out attacks in one boot: a `VerificationRequest`'s
`security` field is either one assertion or an array of up to eight assertions
with distinct names, judged in a single before/after pair. The before phase is
`intended_failure` only when every assertion shows its vulnerable expectation,
and the after phase passes only when every assertion passes its fixed
expectation. A single assertion keeps its original hashes. The verifier is
compiled into the runtime images, so array requests need images staged from a
commit that includes it.

### Evaluation-only helper builds

The private evaluator drives the real helper against staged digests before
any gate is measured. It never edits the committed catalog. Instead,
`bun scripts/cso-runtime-promotion.ts evaluation-candidate --staged-root <dir>
--output <new-file>` converts one staging run's ten `staged-image.json` records
into an evaluation-only catalog. Its revision is `cso-eval-<runId>-<sha12>`, it
carries an `evaluation` record instead of `promotion`, and every runtime is an
`evaluation_candidate` whose qualification has `kind: "evaluation"` and no
release-gate field. Then

```bash
bun run build:cso -- --evaluation-candidate <catalog.json> --output <new-directory>
```

compiles the helper core and `cso-eval-producer` from a private copy of the
source with that catalog embedded, adds the native launcher and watchdog, and
writes the five-artifact producer unit to a new directory outside the checkout.
Beside the unchanged `.gstack-cso-generation` manifest, it writes
`.gstack-cso-evaluation`, which marks the unit evaluation-only and records the
catalog revision, catalog SHA-256, and core SHA-256. The helper reports
`"evaluationOnly": true` from `--version`, labels its catalog evaluation-only
in runtime readiness, and refuses `provision-images --setup-summary`.
Distribution refuses it at every step. A normal `build:cso` stops when
`lib/cso/runtime-catalog.json` carries a `cso-eval-` revision. Setup fails when
`bin/` holds an `.gstack-cso-evaluation` manifest or a launcher that reports
`evaluationOnly`. Catalog promotion and transitions reject evaluation catalogs,
and the runtime catalog validator rejects an evaluation catalog that carries
`promotion`, release-gate fields, or a revision that does not name its staging
run and source commit.

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
