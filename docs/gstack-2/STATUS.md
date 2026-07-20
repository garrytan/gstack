# GStack 2 status

**Status at the 2026-07-20 documentation checkpoint: `BLOCKED`.**

The candidate contains substantial implementation, but it is not a released or
verified GStack 2. `DONE` is prohibited until every P0 gate is backed by the
required evidence layer. The physical-iPhone P0 gate is now green. The current
blocker is the failed live v3 installed-host adversarial gate, including
incomplete representative host UI/process coverage. Native CI is green on
macOS, Ubuntu, Windows, and the Dev Container. No release-branch push, draft
PR, or PR-ready claim is authorized by this status.

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
- [x] A standards-based Codex runtime-absent run passed. The canonical root
  `--list` returned exactly six skills; the selected install used
  `time-attack/gstack/skills --skill qa` and installed only byte-identical
  `qa`. `skills` 1.5.19 can count hidden aliases in its pre-filter display, so
  that display is not the installed subset count. Codex then preserved pure
  judgment, reported the capability setup gate and one approval prompt, made
  no file changes, started no browser, created no runtime, and contacted no
  GStack external service. Artifact:
  [`evals/installation/standard-codex-runtime-absent-2026-07-17.json`](../../evals/installation/standard-codex-runtime-absent-2026-07-17.json).
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
- [x] The current macOS GStack 2 suite is green: 151 pass / 0 fail and 1,194
  assertions across 16 files.
- [x] Optional host-neutral runtime implemented with canonical paths,
  repo/worktree state identity, locks, atomic writes, effect claims,
  doctor/config/state/cleanup, migrations, upgrade/rollback, and uninstall.
- [x] Managed runtime installer coverage is green at 25 pass / 0 fail and 341
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
- [x] The current candidate additionally captures a runtime-owned Bun 1.3.14
  executable under `.gstack-runtime-tools`, records its path/version in the
  bundle manifest, vendors the tagged license/source notices, and routes the
  compiled browser to adjacent `server-node.mjs` on every platform. Focused
  tests cover managed-Bun launch with host Bun absent. The older native-CI and
  bundle-size evidence above predates this payload; the new six-target signed
  release workflow must execute before this layer is called verified. Windows
  Bash and specialist Python checks are reported separately and are not native
  browser/design/PDF dependencies.
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
  Context.dev consent. A verified-key live smoke passed the official Markdown
  scrape endpoint using protected input and an isolated temporary home; the key
  was not persisted in the repository or permanent GStack state.
- [x] iOS candidate fixes implemented for UDID/CoreDevice identity, malformed
  device-list errors, suspended-app bounded timeout, and active-bundle checks.
- [x] Default/free-test roots now include `design/test` and
  `ios-qa/daemon/test`.
- [x] Focused retained capability suites are green: iOS daemon 95 pass / 0 fail
  / 229 assertions; design 101 pass / 0 fail / 381 assertions; PDF 189 pass / 0
  fail / 398 assertions; and diagram 51 pass / 0 fail / 1 skip / 120
  assertions. The opt-in paid diagram lane recorded two skips and is not live
  provider evidence.
- [x] After the user re-authorized the connected test phone, the physical-iOS
  lane passed 12/12. The existing Apple-signed wildcard development profile and
  matching private key signed the reserved fixture; no fabricated profile was
  needed. Release guard, safe in-place install, launch, CoreDevice bootstrap,
  boot-token rotation, all five session acquire/release cycles, ten live
  screenshots, accessibility elements, coordinate taps, bundle checks, state
  cleanup, tunnel shutdown, and temporary-workspace cleanup passed. Artifact:
  [`evidence/ios-physical-device-2026-07-20T17-49-19-302Z.json`](./evidence/ios-physical-device-2026-07-20T17-49-19-302Z.json).
- [x] Installed-host adversarial evidence is retained without relabeling:
  v1 **failed**; immutable v2 **failed** even though QA passed because the
  classifier produced false negatives for debug, review, and ship; v3 offline
  harness coverage is green at 18 pass / 0 fail and 111 assertions. Paid live
  v3 was a one-shot run and **failed 3/4** because review failed compound
  inspection. It was not retried or relabeled. Artifact SHA-256:
  `fcffdf2b0ee7bb9ac1351e246546af2cd352779bda7b1f8dc4a08f51fc66ef2f`.
- [x] A current managed-bundle audit confirms no model-weight download path in
  setup. The standard Agent Skills installation remains Markdown-only and
  independent of the optional runtime.
- [x] An isolated local-browser journey completed navigation, snapshot,
  screenshot, status, and stop cleanup. The stop acknowledgement regression
  has a 2 pass / 0 fail focused test.
- [x] The live aggregate SIGINT cancellation gate passed against an isolated
  local-file fixture: shutdown returned an in-memory authenticated `503`, all
  five owned processes exited, and no listener, root credential state,
  credential-shaped file, or device session remained; an unrelated browser
  daemon survived. The focused server-factory regression passed 34/0 with 62
  assertions. Artifact:
  [`evals/browser/cancellation-2026-07-17.json`](../../evals/browser/cancellation-2026-07-17.json).
- [x] The uninterrupted macOS broad suite is green under singleton isolation:
  6,255 pass / 226 expected skips / 0 fail and 25,509 assertions across all
  384 files. This includes the complete local-browser suite. The local
  Windows-safe singleton lane is also green at 2,829 pass / 57 expected skips
  / 0 fail and 8,648 assertions across all 214 selected files.
- [x] Native CI run
  [`29615621805`](https://github.com/time-attack/gstack/actions/runs/29615621805)
  passed at commit `a8a5fa1a`: macOS 150/0/1,189, Ubuntu 150/0/1,189,
  Windows 150/0/1,145, Dev Container 150/0/1,188, and the standard installer
  470/470. Each native installer discovery found exactly six skills. Sanitized
  artifact:
  [`evals/ci/native-2026-07-17.json`](../../evals/ci/native-2026-07-17.json).
- [x] Architecture, privacy, Context.dev, host compatibility, upgrade/rollback,
  migration, and governance documentation added.

## Blocking or incomplete P0 evidence

- [ ] The paid live v3 installed-host adversarial gate is failed, not pending:
  the immutable one-shot result is **3/4**, with review failing compound
  inspection. Do not retry or relabel it. The six hosts remain **Verified at
  the installer layer only**; representative UI/process coverage is incomplete.
- [ ] Finish final evidence-linked disposition for every infrastructure item;
  see the 25-row table in [ARCHITECTURE.md](./ARCHITECTURE.md). Current focused
  evidence does not replace the remaining live gates.

## Evidence index

| Evidence | Path | State |
|---|---|---|
| Measured baseline | [BASELINE.md](./BASELINE.md) | Recorded |
| Candidate and baseline command ledger | [TEST-EVIDENCE.md](./TEST-EVIDENCE.md) | Runtime-absent, SIGINT, and native matrix pass; live v3 failed |
| Native CI matrix | [native-2026-07-17.json](../../evals/ci/native-2026-07-17.json) | macOS, Ubuntu, Windows, installer, and Dev Container green |
| Complete skill migration | [SKILL-MIGRATION.md](./SKILL-MIGRATION.md) | Generated; 55/55 assignments |
| Judgment provenance | [JUDGMENT-PROVENANCE.json](./JUDGMENT-PROVENANCE.json) | Generated; 4,681-check parity rerun green |
| Parity contract | [JUDGMENT-PARITY.md](./JUDGMENT-PARITY.md) | Green for source/render/contract/asset fixtures |
| Semantic parity | [SEMANTIC-PARITY.md](./SEMANTIC-PARITY.md) | Deterministic 295-check corpus green; retained live samples are regressions |
| Installed-host adversarial | [eval overview](../../evals/host-adversarial/README.md), [immutable live v3 artifact](../../evals/host-adversarial/runs/2026-07-17T19-48-45Z-v3-live-gpt-5-4.json) | V1/V2 failed; V3 offline 18/111 green; paid live V3 one-shot failed 3/4 (review) |
| Structured scenarios | [SCENARIOS.md](./SCENARIOS.md) | 25/25 structured routing fixtures green |
| Backlog traceability | [BACKLOG-MAP.json](./BACKLOG-MAP.json) | 755 unique items mapped |
| Context integration | [CONTEXT-DEV.md](./CONTEXT-DEV.md) | Automated contract 22/139 green; verified-key official-endpoint live smoke passed |
| Host matrix | [HOST-COMPATIBILITY.md](./HOST-COMPATIBILITY.md) | 470/470 checks; Codex runtime-absent run passed; live v3 failed; other UI launches pending |
| Privacy boundary | [PRIVACY.md](./PRIVACY.md) | Implemented contract; full retained-tool egress audit pending |
| Physical iOS | [IOS-PHYSICAL-DEVICE.md](./IOS-PHYSICAL-DEVICE.md), [live artifact](./evidence/ios-physical-device-2026-07-20T17-49-19-302Z.json) | 12/12 harness tests and five-of-five live iterations passed on a wired paired iPhone |
| Upgrade/recovery | [UPGRADE-AND-ROLLBACK.md](./UPGRADE-AND-ROLLBACK.md) | Runtime installer 25 pass / 341 assertions; deterministic clean macOS arm64 bundle audit recorded |

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
