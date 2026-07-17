# GStack 2 status

**Status at the 2026-07-17 documentation checkpoint: `BLOCKED`.**

The candidate contains substantial implementation, but it is not a released or
verified GStack 2. `DONE` is prohibited until every P0 gate is backed by the
required evidence layer. Current blockers include physical-iPhone signing, a
verified Context.dev key smoke, native Windows CI, a passing live v3
installed-host adversarial run, native Linux evidence, and the signed physical
iPhone loop. No branch push, draft PR, or PR-ready claim is authorized by this
status.

## Implemented candidate surface

- [x] Pinned audit base:
  `bb57306d98c97011b0919c6132705a15b1579781`.
- [x] Baseline counts and pre-existing failures captured without relabeling
  them candidate regressions.
- [x] 755 unique open issue/PR records reconciled and deterministically mapped;
  all 16 required upstream PR snapshots traced.
- [x] Exactly six canonical skill directories: `plan`, `design`, `qa`,
  `debug`, `review`, and `ship`.
- [x] The six `/plan` top-level modes are exactly **Discovery, Product,
  Engineering, DX, Specification, and Full chain**.
- [x] Standard installer matrix is green: 470/470 checks, 16 installs and two
  removals with CLI 1.5.19. Project/global installs passed for Claude Code,
  Codex, Cursor, Pi, OpenClaw, and GitHub Copilot; selected-skill and opt-in
  compatibility-alias cases, paths with spaces, source symlink, physical
  copies, and canonical hashes passed. The committed artifact is
  [`evals/installation/install-matrix.json`](../../evals/installation/install-matrix.json).
- [x] Current six names/descriptions measure 982 characters (about 246
  four-character token-equivalents), roughly 77.6% below the correctly parsed
  baseline of about 1,100 in the regenerated tree.
- [x] Generated inventory contains 55 preserved modules, 16 carved sections,
  25 scenarios, 16 regression definitions, and 78 assets.
- [x] Compatibility aliases remain opt-in and outside default six-skill
  discovery; each prints its replacement and contains no copied judgment.
- [x] Judgment provenance, behavioral contracts, 25 structured scenarios, and
  16 upstream bug-fix regression definitions implemented.
- [x] The 2026-07-17 regenerated parity rerun is green: 4,681 checks covering
  55 modules, 16 sections, 25 scenarios, 16 regressions, and 78 assets.
- [x] Deterministic semantic parity is green: 295 checks across 14 suites, 15
  executions, 15 comparison dimensions, 16 carved sections, and nine
  authority-policy unit cases, including unsupported numeric claims. Exact
  preserved source bodies are the primary
  oracle. These are deterministic policy checks, not behavioral-adversarial
  proof, and do not close the installed-host gate. All
  three retained Claude Haiku live samples are classified `REGRESSION`; they
  are preserved as noisy supplemental evidence, never cherry-picked as a
  primary gate or represented as green.
- [x] The focused macOS GStack 2 suite is green: 136 pass / 0 fail, 1,128
  assertions across 15 files. Log: `/tmp/gstack2-test-command-candidate-final2.log`.
  This focused surface does not substitute for the broad or native-platform
  gates.
- [x] Optional host-neutral runtime implemented with canonical paths,
  repo/worktree state identity, locks, atomic writes, effect claims,
  doctor/config/state/cleanup, migrations, upgrade/rollback, and uninstall.
- [x] Managed runtime installer coverage is green at 24 pass / 0 fail and 336
  assertions. The deterministic clean macOS arm64 managed-bundle audit records
  110 components, 1,829 files, 450,044,315 bytes, and 50 capability launchers.
  This is a platform-specific bundle measurement, not a universal byte count;
  platform-native package payloads differ. Setup installs frozen
  production-only dependencies; the development-only Claude Agent SDK is
  excluded. The Sharp/ngrok closure is included. The Hugging Face sidecar is
  excluded and its package is development-only, so setup installs neither its
  inference runtime nor model weights and reports the L4
  capability unavailable. A clean Linux arm64 container smoke also used the
  production-only install with the development SDK absent, completed a local
  browser journey and Sharp full-page screenshot, and uninstalled while
  preserving state.
- [x] Filesystem lifecycle coverage passes for clean install/uninstall,
  paths with spaces, source symlinks with internal-link rejection, read-only
  destination reporting on macOS, interrupted-pointer rollback, crash-journal
  repair, and last-known-good launcher recovery.
- [x] Crash/resume external-effect idempotency is covered through an actual
  local Git push: the effect executes at most once, and resume refuses to
  repeat a command that may already have happened.
- [x] Context.dev public-URL/consent/failure contract is green at 22 pass / 0
  fail and 139 assertions; deprecated search is typed unsupported rather than
  fabricated. `context options` and explicit
  `context select host|local-browser|none` choices persist without granting
  Context.dev consent. No verified key was available for the live smoke.
- [x] iOS candidate fixes implemented for UDID/CoreDevice identity, malformed
  device-list errors, suspended-app bounded timeout, and active-bundle checks.
- [x] Default/free-test roots now include `design/test` and
  `ios-qa/daemon/test`.
- [x] Focused retained capability suites are green: iOS daemon 95 pass / 0 fail
  / 229 assertions; design 101 pass / 0 fail / 381 assertions; PDF 189 pass / 0
  fail / 398 assertions; and diagram 51 pass / 0 fail / 1 skip / 120
  assertions. The opt-in paid diagram lane recorded two skips and is not live
  provider evidence.
- [x] Physical-iOS preflight recorded 9 pass / 0 fail / 1 deploy skip and 29
  assertions. The direct smoke then returned typed code
  `signing_unavailable`, category `setup_gate`; it installed no app and wrote no
  pass artifact.
- [x] Installed-host adversarial evidence is retained without relabeling:
  v1 **failed**; immutable v2 **failed** even though QA passed because the
  classifier produced false negatives for debug, review, and ship; v3 offline
  harness coverage is green at 18 pass / 0 fail and 111 assertions. Live v3
  has not run and has no artifact, so there is no passing live installed-host
  adversarial result.
- [x] A current managed-bundle audit confirms no model-weight download path in
  setup. The standard Agent Skills installation remains Markdown-only and
  independent of the optional runtime.
- [x] An isolated local-browser journey completed navigation, snapshot,
  screenshot, status, and stop cleanup. The stop acknowledgement regression
  has a 2 pass / 0 fail focused test.
- [x] The uninterrupted macOS broad suite is green under singleton isolation:
  6,240 pass / 226 expected skips / 0 fail and 25,449 assertions across all
  383 files. This includes the complete local-browser suite. The local
  Windows-safe singleton lane is also green at 2,815 pass / 57 expected skips
  / 0 fail and 8,586 assertions across all 213 curated files; it is not native
  Windows evidence.
- [x] Architecture, privacy, Context.dev, host compatibility, upgrade/rollback,
  migration, and governance documentation added.

## Blocking or incomplete P0 evidence

- [ ] Record a passing live v3 installed-host adversarial run and execute the
  installed skill in each representative host UI. The six hosts are **Verified
  at the installer layer only**; v1 and v2 are retained failed runs, and v3 is
  offline-harness evidence only.
- [ ] Prove runtime-absent judgment behavior through an actual host invocation.
  Runtime install failure and the real default capability lifecycle are covered.
- [ ] Complete native Linux and Windows matrices. The uninterrupted macOS
  broad singleton run is green at 6,240/226/0 across 383 files, and the local
  Windows-safe singleton lane is green at 2,815/57/0 across 213 files. Neither
  substitutes for native execution on its named platform.
- [ ] Integrate the passing complete local-browser suite and live journey into
  final cancellation/leak evidence. The production dependency and managed
  bundle audit contains no cloud-browser provider/path.
- [ ] Complete a live Context.dev smoke with a verified account/key. No verified
  key was available at this checkpoint; the 22-test automated contract is not
  provider evidence.
- [ ] Complete the physical-iPhone five-check loop with a signed test app. The
  unsigned Release guard and preflight passed, but the direct smoke returned
  `signing_unavailable` / `setup_gate`; no app was installed and no pass artifact
  exists. This is a remediable account/provisioning gate.
- [ ] Verify in one real cancellation run that no subprocess, listener,
  credential, browser, or device-session remains after interruption. Existing
  component tests cover each cleanup contract separately but not this aggregate
  live gate.
- [ ] Finish final evidence-linked disposition for every infrastructure item;
  see the 25-row table in [ARCHITECTURE.md](./ARCHITECTURE.md). Current focused
  evidence does not replace the remaining live and native-platform gates.

## Evidence index

| Evidence | Path | State |
|---|---|---|
| Measured baseline | [BASELINE.md](./BASELINE.md) | Recorded |
| Candidate and baseline command ledger | [TEST-EVIDENCE.md](./TEST-EVIDENCE.md) | Broad macOS and local Windows-safe singleton runs green; live/native-platform gates pending |
| Complete skill migration | [SKILL-MIGRATION.md](./SKILL-MIGRATION.md) | Generated; 55/55 assignments |
| Judgment provenance | [JUDGMENT-PROVENANCE.json](./JUDGMENT-PROVENANCE.json) | Generated; 4,681-check parity rerun green |
| Parity contract | [JUDGMENT-PARITY.md](./JUDGMENT-PARITY.md) | Green for source/render/contract/asset fixtures |
| Semantic parity | [SEMANTIC-PARITY.md](./SEMANTIC-PARITY.md) | Deterministic 295-check corpus green; retained live samples are regressions |
| Installed-host adversarial | [eval overview](../../evals/host-adversarial/README.md), [immutable v2 artifact](../../evals/host-adversarial/runs/2026-07-17T04-09-01-809Z-3d23a270.json) | V1 failed; immutable V2 failed; V3 offline 18/111 green, live V3 not run; no passing live run |
| Structured scenarios | [SCENARIOS.md](./SCENARIOS.md) | 25/25 structured routing fixtures green |
| Backlog traceability | [BACKLOG-MAP.json](./BACKLOG-MAP.json) | 755 unique items mapped |
| Context integration | [CONTEXT-DEV.md](./CONTEXT-DEV.md) | Automated contract 22/139 green; live smoke blocked on verified key |
| Host matrix | [HOST-COMPATIBILITY.md](./HOST-COMPATIBILITY.md) | 470/470 checks; six hosts Verified at installer layer; live v3/UI launch pending |
| Privacy boundary | [PRIVACY.md](./PRIVACY.md) | Implemented contract; full retained-tool egress audit pending |
| Physical iOS | [IOS-PHYSICAL-DEVICE.md](./IOS-PHYSICAL-DEVICE.md) | Preflight 9 pass / 1 deploy skip / 29 assertions; signing blocked; no app/pass artifact |
| Upgrade/recovery | [UPGRADE-AND-ROLLBACK.md](./UPGRADE-AND-ROLLBACK.md) | Runtime installer 24 pass / 336 assertions; deterministic clean macOS arm64 bundle audit recorded |

## Interpretation rules

- `MECHANICAL_PORT` means the pinned rendered judgment body remains equal after
  normalization; it is not permission to rewrite prose.
- `BUG_FIX` requires its linked PR/reproduction and regression fixture.
- `NEEDS_EVIDENCE`, `DEFER_COMMUNITY`, and
  `SUPERSEDED_BY_CONSOLIDATION` are auditable dispositions, not GitHub state
  changes. No labels, issues, or PRs are mutated by the map generator.
- A fixture-backed structural result does not replace a live browser, physical
  device, external account, native OS, or host-install result where the gate
  explicitly requires one.
- Do not market or release this branch as GStack 2 while this status is
  `BLOCKED`.
