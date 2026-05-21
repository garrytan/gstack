# Universe AI Software Factory Beta Operations & Security Contract

Status: planning artifact for Beta 2 operations/security prep. This is a planning artifact, not a release claim. No external services, deploys, publishes, tags, or pushes are introduced by this document.

Companion docs:

- `docs/designs/PI_SOFTWARE_FACTORY_ALPHA_BETA_EXECUTION_PLAN.md` (Beta 2 section)
- `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md` (Beta 2 gates)
- `docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md`
- `docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md`
- `docs/designs/PI_FACTORY_DISTRIBUTION_PACKAGE_PATH.md`
- `docs/designs/PI_FACTORY_PROJECT_WORKSPACE_API.md`

## 1. Mission

Define the operations and security contracts a future Beta 2 milestone must satisfy before the Universe AI Software Factory can be called supportable for real users.

Three deliverables, all read-only/planning, all in scope of the autonomy envelope in the Alpha/Beta execution plan:

1. **B2.1 production-like smoke contract** — what must run green before any beta release gate flips to ready.
2. **B2.2 backup/migration plan** — how factory state survives upgrades, rollbacks, and incident recovery.
3. **B2.3 security review checklist** — concrete items a `security-auditor` review must cover before user-facing beta.

This document does not pick a web stack, add dependencies, scaffold a production app, build install/upgrade automation, change `CLAUDE.md` or `package-lock.json`, or expose `/factory-qa-fix`. Smoke and security items that depend on those surfaces are explicitly marked **not-ready-until** here, so future agents can see what still blocks Beta 2.

## 2. Autonomy envelope (recap)

Lane G follows the same envelope as the Alpha/Beta execution plan:

- additive design docs under `docs/designs/`;
- additive references in `docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md` and `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md` only if needed;
- no dependency changes, no package manifest edits, no production web scaffold, no release actions;
- no edits to `CLAUDE.md`, `package-lock.json`, or any secret/credential file;
- no expansion of `/factory-qa-fix` or any write-capable factory exposure.

If a Beta 2 item requires something outside the envelope, this doc records the gate as **not-ready-until** rather than dispatching the work.

## 3. B2.1 — Production-like smoke contract

### 3.1 Purpose

The Beta 2 smoke contract is the minimum executable proof that the factory engine boots, reads, and writes the state it advertises. It is the layer below feature tests and above type checking. It must run from a clean checkout with no external services and complete within seconds.

Smoke does not validate quality, agent behavior, or LLM output. It validates that the **engine surface area** behaves the way the docs say it does.

### 3.2 Required smoke checks

| ID | Check | Source of truth | Status |
|---|---|---|---|
| S1 | Module load | All `lib/factory-*.ts` modules import without side effects under Bun. | Ready — existing tests touch every module. |
| S2 | Facade plan | `planFactoryRun()` for `review`, `qa`, `ship` workflows returns deterministic phase/gate/artifact graphs. | Ready — covered by `test/factory-facade.test.ts`. |
| S3 | Facade status | `FactoryFacade.status(runId)` returns a `FactoryRunStatusDto` against fixture event stores. | Ready — covered by `test/factory-facade.test.ts`. |
| S4 | Facade list | `FactoryFacade.list()` returns stable `FactoryRunListItemDto[]` order against fixture event stores. | Ready — covered by `test/factory-facade.test.ts`. |
| S5 | Facade artifact read | `readFactoryArtifact()` returns text-only DTOs against fixture artifact stores; non-text artifacts error clearly. | Partial — text path covered by `test/factory-artifact-store.test.ts`; descriptor wiring pending Lane B. |
| S6 | Project catalog read/write | `lib/factory-project-store.ts` round-trips workspace/project/run-link records under temp dirs; unsafe IDs rejected; missing linked runs degrade gracefully. | Pending Lane A. Smoke fixture must land with the store. |
| S7 | QA log parse fixture | `lib/factory-qa-capture.ts` parses durable JSONL fixtures, fails closed on missing/malformed entries, marks ambiguous matches as ambiguous. | Ready — covered by `test/factory-qa-capture.test.ts`. |
| S8 | QA recover fixture | `/factory-recover-qa` reads a durable QA log fixture, captures exactly one correlated post-dispatch entry, idempotent on repeated recovery. | Pending Lane C. Cannot land in smoke until generated QA skills emit the durable log contract. |
| S9 | Guarded denial fixture | `withGuardedCommandRuntime` denies a fixture command (e.g., `rm -rf /`, `git push --force`, `cat .env`) without execution and emits a sanitized denial artifact/event. | Partial — pure classifier covered by `test/factory-command-guard.test.ts` and wrapper by `test/factory-guarded-runtime.test.ts`; denial-artifact wiring pending Lane D. |
| S10 | Distribution dry-run | `lib/factory-distribution.ts` (or equivalent) builds a staged bundle into a caller-provided temp directory, validates the manifest, refuses to overwrite user-managed paths, never publishes. | Pending Lane F. |
| S11 | Web health | `/health` endpoint on the production web app returns OK with no secrets. | **Not-ready-until** a real web app exists. Explicitly not part of Beta 2 smoke until Beta 1 ships an approved web stack. |

S11 must remain a documented gate, not a stubbed test. Faking `/health` against a non-existent app is the kind of false safety claim §5 of the execution plan and `PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md` forbid for the safe-command guard, and the same rule applies here.

### 3.3 Smoke fixtures

All smoke checks must:

- run in temp directories created per-test;
- never read or write `~/.gstack/`, `~/.pi/`, `~/.config/env-master/`, or any path outside the temp dir and the repo source tree;
- never read user environment variables beyond what Bun needs to start;
- treat fixture data as the authoritative input — no live LLM calls, no real browser, no real shell-out for the smoke pass;
- emit a single deterministic transcript when a check fails so CI logs are diff-friendly.

Recommended command shape once all dependent lanes have landed:

```bash
bun test \
  test/factory-core.test.ts \
  test/factory-facade.test.ts \
  test/factory-project-store.test.ts \
  test/factory-project.test.ts \
  test/factory-artifact-content.test.ts \
  test/factory-artifact-store.test.ts \
  test/factory-qa-capture.test.ts \
  test/factory-command-guard.test.ts \
  test/factory-guarded-runtime.test.ts \
  test/factory-distribution.test.ts \
  test/pi-extension.test.ts
```

Missing files in that list correspond to pending lanes (A, C/D, F). The smoke contract is not satisfied until every test in this list exists and passes.

### 3.4 Smoke posture rules

- **Fail closed.** Any smoke check that cannot run because its dependency module is missing must fail the smoke gate. Do not skip-mark missing modules as green.
- **No environment leaks.** Smoke must not echo, log, or persist values from any env var whose name matches `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, or any path under `~/.config/env-master/`.
- **No external network.** Smoke must not perform DNS or socket connections except over `127.0.0.1`/`::1` for in-process workers. CI runners must enforce this where practical.
- **No release vocabulary.** Smoke output must never say "deployed", "published", "released", "tagged", or "pushed". Ship-readiness language stays inspect-only per the execution plan.

### 3.5 Smoke not-ready-until

The Beta 2 smoke gate is **not ready** until all of the following are true:

1. Lane A landed `lib/factory-project-store.ts` and `test/factory-project-store.test.ts`.
2. Lane C landed durable QA log emission from generated QA skills and `/factory-recover-qa` with its fixture.
3. Lane D landed live guard wrapping for at least one execution path and the denial artifact/event contract.
4. Lane F landed `lib/factory-distribution.ts` with the dry-run bundle test.
5. The combined smoke command above runs green from a clean checkout in under 30 seconds.

S11 web health remains separately deferred until a web app is approved and built.

## 4. B2.2 — Backup and migration plan

### 4.1 Purpose

Beta 2 must promise that a user's project state survives:

- factory engine upgrades;
- distribution bundle swaps;
- failed runs;
- corrupted or partially-written event/artifact files;
- user-initiated rollback to a prior bundle.

Today's stores are local, JSONL-oriented, and additive by design. The backup/migration plan keeps them that way.

### 4.2 State surfaces

| Surface | Location (default) | Owner | Format |
|---|---|---|---|
| Factory run event store | `.gstack/factory/runs/<run-id>/events.jsonl` | `lib/factory-event-store.ts` | append-only JSONL |
| Factory artifact store | `.gstack/factory/runs/<run-id>/artifacts/<artifact-id>.md` plus paired `<artifact-id>.json` (legacy text); future directory layout `.gstack/factory/runs/<run-id>/artifacts/<artifact-id>/` with `metadata.json`, `content.md`, `files/<content-id>` | `lib/factory-artifact-store.ts` | file tree |
| Project/workspace catalog | `.gstack/factory/projects/projects.jsonl` plus per-project `.gstack/factory/projects/<project-id>/project.json` and `links.jsonl` | `lib/factory-project-store.ts` (pending Lane A) | JSONL + JSON |
| Durable QA log | per-project deterministic path emitted by generated QA skills (Lane C) | generated skill + `lib/factory-qa-capture.ts` | JSONL |
| Denial audit artifacts | factory artifact store with `kind: 'safety-denial'` (Lane D) | runtime wrapper + artifact store | JSONL/metadata |
| Distribution bundle manifest | inside packaged bundle, plus install marker on disk (Lane F) | `lib/factory-distribution.ts` (pending) | JSON |

State surfaces deliberately do **not** include:

- `~/.config/env-master/`;
- `~/.ssh/`;
- any user shell config;
- repository working trees outside `.gstack/`.

Backup procedures must not touch those.

### 4.3 Backup approach

For each state surface the contract is:

1. **Read-only copy.** A backup must produce a copy of the relevant directory tree without invoking any factory action. No facade calls, no runtime hooks, no LLM calls.
2. **Atomic capture.** Backups should capture event JSONL by file boundary (each `.jsonl` is append-only, so a snapshot of byte length plus file contents is sufficient).
3. **No transformations.** Backups preserve original bytes. Reformatting, prettification, or "helpful" merging is forbidden because it breaks digest verification.
4. **No secrets.** Backups must refuse to include any file under `~/.config/env-master/`, any `*.env` outside `.gstack/factory/`, and any file matching the redaction patterns in §5.8.
5. **Targeted scope.** Backups operate on a single workspace/project tree at a time. They never sweep the user home dir.

Concrete approach for each surface:

- **Event store:** snapshot `.gstack/factory/runs/<run-id>/events.jsonl` and write a sidecar `events.jsonl.sha256` recording the captured digest. Replay is whole-file; partial replay is not supported in Beta 2.
- **Artifact store:** snapshot the artifact directory; record per-file digests in a `MANIFEST.sha256`. Mixed legacy text + future directory layouts both supported as additive coverage.
- **Project catalog:** snapshot `projects.jsonl` and per-project subtrees; record per-file digests.
- **QA log:** snapshot the durable JSONL plus its sha256 digest.
- **Denial artifacts:** included in the artifact store snapshot — no separate path.
- **Distribution bundle manifest:** snapshot the manifest JSON only; the bundle itself is reproducible from source and does not need backup.

Beta 2 does not yet require automated scheduled backups. It requires a documented, reproducible backup procedure and at least one passing fixture-backed test that backup + restore + replay produces identical run state.

### 4.4 Migration markers

Each state surface must carry a small `schema_version` marker.

- Event store: first event payload includes `schemaVersion: <int>`; older runs without a marker assumed `schemaVersion: 0` and treated as read-only on upgrade.
- Artifact store: `metadata.json` for new directory-layout artifacts includes `schemaVersion`. Legacy `<artifact-id>.json` continues to be readable without one and is treated as `schemaVersion: 0`.
- Project catalog: each `project.json` includes `schemaVersion`. `projects.jsonl` lines include `schemaVersion`.
- Durable QA log: each JSONL line includes `schemaVersion`.
- Distribution bundle manifest: top-level `manifestVersion` and `runtimeVersion` fields.
- Denial artifacts: covered by artifact-store `schemaVersion`.

Migration rules:

1. **Forward-compatible reads.** A new factory version must read old `schemaVersion` values. Reads that encounter a newer-than-known `schemaVersion` must refuse to interpret unknown fields silently — fail closed and surface an upgrade prompt.
2. **No silent rewrites.** A migration that changes on-disk shape must be explicit, idempotent, and logged. Reuse the `gstack-upgrade/migrations/` mechanism described in CONTRIBUTING.md for Pi runtime layout migrations.
3. **Preserve unmanaged user content.** Mirror the existing setup-script posture: never overwrite user-managed paths during migration. Warn and require explicit user action when in doubt.
4. **One direction.** Beta 2 supports forward migration only. Rollback is handled by bundle swap (see §4.5), not by reverse-migrating state.

### 4.5 Bundle rollback story

For packaged Pi runtime bundles (Lane F future work):

- the installer keeps the previous bundle on disk until the new bundle is verified;
- a rollback flips the stable-install pointer back to the previous bundle without touching `.gstack/factory/` state;
- if a forward migration of `.gstack/factory/` state has already been applied, rollback to a bundle that cannot read the new `schemaVersion` must fail closed — the installer must refuse the rollback and require explicit user confirmation, preserving the new state intact.

This rule keeps the rollback path safe for the user's data even when the bundle they rolled back to is older than their data shape.

### 4.6 Backup/migration not-ready-until

The Beta 2 backup/migration gate is **not ready** until:

1. `schemaVersion` markers exist in every state surface listed in §4.2 (Lanes A, C, D, F deliverables must include them).
2. At least one round-trip fixture test exists for each surface: backup the temp-dir state, restore into a new temp dir, replay/read, verify byte-identical results and identical facade DTOs.
3. The packaged-bundle install/rollback flow has at least a documented simulated test, even if the public bundle does not exist yet.
4. The migration registry under `gstack-upgrade/migrations/` accepts Pi-runtime-aware migrations.

## 5. B2.3 — Security review checklist

This is the checklist a `security-auditor` review must work through before any beta with real users. Each item names the surface, the invariant, and the existing source-of-truth design where applicable. The checklist is intentionally narrow — items outside scope are listed in §5.10 as out-of-scope.

### 5.1 Command execution

Source of truth: `docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md`.

Invariants:

- Pure command classifier in `lib/factory-command-guard.ts` denies by default and fails closed on parser ambiguity.
- Runtime wrapper in `lib/factory-guarded-runtime.ts` (or equivalent) refuses to execute denied commands and emits a structured denial.
- Capability `safe-command-guard` is advertised on `availableCapabilities` only when **every** command-capable pathway for the workflow is wrapped.
- Minimum deny set per the guard design: `rm -rf`/equivalents, `git reset --hard`, `git clean`, `git push --force`, all `npm/bun/pnpm/yarn/cargo publish`, all deploy/release tool CLIs, all secret/env dumping reads, all external-system mutations.
- Control-operator chaining (`;`, `&&`, `||`, pipes, command substitution, backticks, process substitution) denied unless explicitly allowlisted.
- Package-manager scripts (`npm run …`, `bun run …`) remain denied under `non-destructive-write` until recursive manifest inspection ships.
- `/factory-qa-fix` is **not** exposed until live attestation is proven and negative tests for all of the above pass.

Reviewer must verify: capability attestation is wired (not just declared); denied commands cannot execute via any reachable adapter; classifier tests cover Windows-style and backslash path operands; denied commands produce a sanitized record without raw command text when the command may contain secrets.

### 5.2 Artifact descriptor rendering

Source of truth: `docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md`.

Invariants:

- `readFactoryArtifact()` remains text-only. Non-text content reached through that method must error clearly, not auto-coerce.
- Content descriptors carry `provenance.source` of `artifact-store` (trusted), `external-system`, or `event-metadata` (untrusted by default) and a boolean `trusted`.
- Raw event-provided `path`/`uri` is metadata-only and never rendered as a clickable link in user-facing UI without trusted provenance.
- Binary reads require exact `runId` + `artifactId` + `contentId`. No directory traversal through ids or filenames.
- Status/list commands never auto-open a browser or local file.
- Binary content is never inlined in status/list responses.

Reviewer must verify: descriptor provenance is honest for every artifact kind in use; legacy text artifacts still read correctly; tampered metadata is normalized or marked untrusted; bundle descriptors enumerate items without reading binary payloads.

### 5.3 External URI handling

Invariants:

- Allowed schemes: `https:` for external systems; `file:` only when the runtime itself converted a trusted artifact-store path into a URI.
- Blocked schemes: `javascript:`, `data:` (unless a narrow inline-image policy is approved later), shell-like pseudo schemes, relative paths from event payloads.
- External URI rendering requires `provenance.trusted = true` **and** an allowed scheme. Both checks must hold.
- No automatic prefetch or navigation. URIs are opt-in user actions.

Reviewer must verify: URI scheme allowlist matches the design doc; untrusted URIs surface as inspectable metadata, not clickable links; URI display in Pi status remains suppressed for untrusted sources.

### 5.4 Browser evidence capture

Invariants:

- Browser evidence (screenshots, traces, HAR, console logs) reaches the user only through the factory artifact store, not through raw event payloads.
- Artifact metadata records `mediaType`, `byteLength`, `sha256`, and origin metadata supplied by the runtime — not inferred at render time.
- Headless browser sessions that drive QA do not read or write files outside the workspace root and the artifact-store directory.
- Browser sessions never auto-execute downloaded files.
- Browser-driven navigation respects the URI scheme rules in §5.3.

Reviewer must verify: at least one end-to-end fixture proves a captured screenshot lands as a trusted descriptor; trace/HAR artifacts cannot trigger auto-open behavior; browser tooling cannot mutate filesystem outside the workspace via download paths.

### 5.5 Project/workspace path boundaries

Invariants:

- Project IDs and workspace IDs are slugified and collision-safe; unsafe IDs (path separators, `..`, leading dots, absolute paths, URL-encoded escapes) are rejected at the catalog store boundary.
- The project catalog writes only under `.gstack/factory/projects/`. No writes outside.
- Facade reads cross workspace boundaries only via explicit workspace IDs; there is no global enumeration that leaks one workspace's runs into another's view.
- For local-only Alpha mode, the trust boundary is the user's filesystem. For any future hosted mode, the design must add explicit tenant isolation before implementation begins (see `PI_FACTORY_PROJECT_WORKSPACE_API.md` and the Alpha/Beta plan's Beta 1 B1.3).

Reviewer must verify: unsafe ID inputs fail closed; workspace queries reject cross-workspace probes; the catalog cannot be coerced into reading or writing outside its directory.

### 5.6 Prompt-injection surfaces in QA and browser logs

Invariants:

- QA and browser log content is treated as **data**, not as instructions to any subsequent agent. Reduction/parsing modules consume the content but do not feed it back into LLM prompts without explicit envelope wrapping.
- Logs are normalized through `content-security.ts` patterns (datamarking, hidden element strip, ARIA regex, URL blocklist, envelope wrapping) before any agent sees them, mirroring the gstack sidebar security stack.
- Browser-captured DOM/text content is summarized into artifact descriptors with provenance, not pasted verbatim into agent context.
- "Ignore previous instructions"-class strings in captured content do not influence factory orchestration. Orchestration takes structured DTOs only, never free-form agent quotes from log content.
- Stale or attacker-controlled log fixtures fail closed in `lib/factory-qa-capture.ts` parsing (malformed → ignored; ambiguous → fail closed; multiple matches → ambiguous).

Reviewer must verify: QA log parser rejects malformed and ambiguous entries; browser evidence content cannot reach agent context outside an envelope wrapper; injection attempts in fixture logs do not flip a factory run's state or gate decisions.

### 5.7 Stale gate decisions

Invariants:

- Every `/factory-decide` invocation requires the current `requestSequence` for the gate. Mismatched sequences are rejected.
- Gate decisions are bound to a specific gate ID + run ID + sequence triple. Replaying an old `(runId, gateId, sequence)` cannot apply against a newer gate state.
- Cancelled, waived, rejected, or already-approved gates are immutable; a second decision against the same triple is a no-op and surfaces as such, not as an error that could be retried into success.
- UI surfaces showing pending gates must always read the latest `requestSequence` before submitting a decision — never render a sequence captured at page load if the gate has since advanced.

Reviewer must verify: stale sequence rejection is tested in `test/factory-facade.test.ts` and `test/pi-extension.test.ts`; cancelled/waived/rejected states cannot be flipped; decision DTOs include the sequence at the protocol boundary, not just internally.

### 5.8 Secret redaction

Invariants:

- Factory code never reads files under `~/.config/env-master/` for any reason. The classifier in §5.1 blocks the read paths.
- Denied-command audit artifacts record a sanitized command summary plus a digest, not the raw command text, when the command's tokens match a redaction pattern.
- Redaction patterns include token names containing any case-insensitive substring of `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `BEARER`, `AUTH`, `SESSION`, `COOKIE`, `OTP`, `PRIVATE_KEY`, plus values that look like high-entropy hex/base64 strings of length ≥ 32.
- Logs (event store, artifact store, QA log, denial artifacts, smoke transcripts) never store environment dumps. The denial path for `env`, `printenv`, `set`, `export -p`, `cat .env`, `cat ~/.ssh/*`, `cat ~/.config/env-master/*` is the canonical deny set.
- Status/list/artifact-read DTOs never embed raw environment values.

Reviewer must verify: a fixture that attempts to exfiltrate `ANTHROPIC_API_KEY` or `GH_TOKEN` is blocked at the classifier, produces a denial artifact without the secret value, and does not leak into status output; redaction patterns match both the variable name and the value entropy heuristic.

### 5.9 Ship-readiness language

Invariants:

- All ship-readiness output remains inspect-only. Strings like "deployed", "published", "released", "tagged", "pushed" do not appear in `/factory-status`, `/factory-list`, or any ship workflow artifact.
- `/factory-decide` cannot trigger any deploy/publish/tag/push automation, full stop. The ship workflow's "ready" terminal state means handoff readiness, not a release action.

Reviewer must verify: a grep across factory workflow output for release vocabulary returns nothing; ship-readiness artifacts use handoff language; no factory adapter wires `/factory-decide` to release tooling.

### 5.10 Explicitly out of scope for the Beta 2 security review

The following are documented as out of scope so reviewers do not block on them and so future agents know they are deliberate gaps to address later:

- production web app threat model (deferred until a web stack is approved);
- hosted/multi-tenant auth model (deferred until Beta 1 B1.3 implementation begins);
- supply-chain review of npm/Bun packages used by the engine (deferred — depends on dependency policy that itself sits outside the autonomy envelope);
- network-level DoS or rate-limit modeling (no public network surface yet);
- OS-level sandboxing of the agent host (the safe-command guard is a fail-closed command policy, not a sandbox — explicit non-goal in the guard design).

### 5.11 Security not-ready-until

The Beta 2 security gate is **not ready** until:

1. Every checklist item §5.1–§5.9 has at least one passing test or auditor-signed-off attestation in this branch's history.
2. A `security-auditor` review pass has been requested and its output stored as an audit artifact alongside the branch (per the readiness map Beta 2 exit gate).
3. Negative tests cover the §5.1 minimum deny set and the §5.8 secret-exfiltration fixture.
4. The §5.6 prompt-injection fixture set exercises QA log, browser evidence, and event-payload paths and confirms factory state does not change in response.
5. Ship-readiness vocabulary remains free of release language across the entire workflow surface.

## 6. Beta 2 exit-gate consolidation

Beta 2 is ready when **all three** of these are true simultaneously:

1. Smoke contract (§3) runs green from a clean checkout, with S11 explicitly deferred and documented.
2. Backup/migration plan (§4) has fixture-backed round-trip tests for every state surface and `schemaVersion` markers in place.
3. Security checklist (§5) has its tests, auditor sign-off, and negative-test fixtures committed.

If any of the three is partial, Beta 2 is not ready. Mark the gate as **not-ready** in the production readiness map until all three flip green together.

## 7. Production-not-ready gates

This section restates the readiness-map "Not production-ready until these are true" items through the operations/security lens, so a reader who lands here first knows what still blocks production:

1. **No real user UI surface.** A production web app or packaged local UI is approved, shipped, and serving requests with the §3.2 S11 `/health` check live.
2. **No durable project state.** Project catalog exists, survives process restarts, has `schemaVersion` markers, and has round-trip backup tests.
3. **No artifact descriptor integration.** Artifact descriptor work (Lane B) wires through all user-facing artifact views.
4. **No durable QA log emission.** Generated QA skills emit the JSONL contract; `/factory-recover-qa` exists and is idempotent.
5. **No live guard attestation.** Safe-command guard wraps every live execution path the factory can reach; `safe-command-guard` capability is only advertised when the wrapper is active.
6. **No QA-fix exposure path proven.** `/factory-qa-fix` is either still hidden with a documented unguardable-path blocker, or exposed with opt-in UX, negative tests, and denial artifacts.
7. **No distribution dry-run.** Bundle manifest plus dry-run validator exists; non-publishing install/upgrade/rollback simulated tests pass.
8. **No production-like smoke gate.** The §3 contract is wired into the release gate.
9. **No security review pass.** §5 checklist has run with a `security-auditor` and any blockers are resolved.
10. **No release-language safety.** Ship-readiness output cannot be confused with deploy/publish/tag/push automation.

When any of these is false, the platform is not production-ready, regardless of any other readiness signal.

## 8. Handoff

This document is read-only planning. It does not change any executable behavior. The next concrete actions are owned by other lanes:

- Lane A: durable project catalog → unblocks §3.2 S6 and §4.2 catalog backup.
- Lane B: artifact descriptor integration → unblocks §5.2 / §5.4 reviewer verification.
- Lane C: durable QA log emission + `/factory-recover-qa` → unblocks §3.2 S7/S8 and §5.6 prompt-injection fixtures.
- Lane D: live guard wrapping + denial audit → unblocks §3.2 S9 and §5.1 / §5.8.
- Lane F: distribution dry-run bundle → unblocks §3.2 S10 and §4.5 rollback story.

Lane G's deliverable is this contract. Implementation activations happen as the other lanes land. When all dependent lanes have landed, the Beta 2 milestone owner consolidates §6 into a release gate.
