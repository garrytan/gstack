# Universe AI Software Factory Alpha/Beta Execution Plan

Status: detailed autonomous execution plan for the next Alpha and Beta deliverables. This is a planning artifact, not a release claim.

Companion docs:

- `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md`
- `docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_COMPONENT_MODEL.md`
- `docs/designs/PI_FACTORY_PROJECT_WORKSPACE_API.md`
- `docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md`
- `docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md`
- `docs/designs/PI_FACTORY_DISTRIBUTION_PACKAGE_PATH.md`

## 1. Mission

Move from post-Wave-1 readiness to executable Alpha/Beta milestones with enough detail that agents can work without asking the user for routine decisions.

The desired end state is a safe, common-user-friendly **Universe AI Software Factory** where a user can:

1. start from an idea;
2. see what Universe AI is doing;
3. approve meaningful decisions;
4. inspect artifacts and QA evidence;
5. understand safety boundaries;
6. reach ship-readiness/handoff without confusing it for deployment.

## 2. Autonomy envelope

Agents may proceed autonomously inside this envelope:

- source changes in factory libraries, tests, and docs;
- no-dependency TypeScript modules under `lib/`;
- tests under `test/`;
- docs under `docs/designs/`;
- fixture JSON or static planning artifacts under `docs/`;
- Pi extension changes that preserve existing command safety and do not expose new write-capable commands;
- generated skill source changes if they do not add dependencies or package scripts;
- exact-path commits after focused tests pass.

Agents must not proceed autonomously outside this envelope:

- protected-file edits: `CLAUDE.md`, `package-lock.json`;
- dependency additions/removals/upgrades;
- package manifest changes;
- production web app scaffold or framework selection;
- publishing, deploying, tagging, pushing, or release automation;
- `/factory-qa-fix` public exposure before live safe-command attestation;
- production/external-system mutations;
- secret or credential file edits;
- destructive git or filesystem commands.

If a milestone appears to require a blocked action, use the no-intervention fallback in this plan rather than asking immediately.

## 3. Default decisions to avoid user blockers

| Topic | Default autonomous decision | Why |
|---|---|---|
| Web stack | Do not choose one yet. Build library DTOs, fixtures, docs, and optional no-dependency static artifacts only if explicitly approved in-session. | Avoids dependency/package and scaffold approval blockers. |
| Project persistence | Use filesystem JSONL/JSON under `.gstack/factory/projects/` with atomic write patterns mirroring existing factory stores. | Fits local Pi/source mode and requires no new dependencies. |
| Project ID format | Use slugified stable IDs with collision-safe suffixes, matching existing factory ID style. | Keeps URLs readable and deterministic. |
| Artifact content | Keep `readFactoryArtifact()` text-only; expose descriptors through additive APIs. | Preserves stable facade contract. |
| QA logs | Emit machine-readable JSONL records from generated QA skill/runtime paths; parse fail-closed. | Enables recovery without guessing from prose. |
| QA fix | Keep hidden until guarded execution is proven end-to-end. | Safety > feature exposure. |
| Command guard | Deny by default; advertise `safe-command-guard` only when all relevant execution paths are actually wrapped. | Prevents false safety claims. |
| Ship readiness | Continue readiness/handoff only; no tag/publish/push/deploy. | Avoids release-action risk. |
| Distribution | Build dry-run/staged bundle validation first; no publishing. | Supports Beta 0 prep without external release actions. |
| Auth/tenant model | Local-only single-user for Alpha unless a real web app is approved. Document workspace boundaries for Beta. | Avoids premature multi-tenant design changes. |

## 4. Workstream dependency graph

```text
A. Durable project catalog
   ├─ enables B. Connected project/web view DTOs
   ├─ enables E. Cockpit fixtures/screen data
   └─ enables Beta 1 cockpit beta

C. Artifact descriptor integration
   ├─ enables E. cockpit artifact/evidence views
   └─ enables Beta 1 safe artifact rendering

D. QA durable log emission + recovery
   ├─ enables Alpha 0 stronger QA audit recovery
   ├─ enables Alpha 2 QA-fix preconditions
   └─ enables Beta operations evidence

F. Live safe-command path attestation
   ├─ requires existing command classifier/runtime wrapper
   ├─ blocks /factory-qa-fix exposure until complete
   └─ enables Alpha 2

G. Distribution dry-run bundle
   ├─ enables Beta 0 packaged user beta
   └─ remains non-publishing until explicitly approved

H. Production smoke/security plan
   ├─ validates Beta 2
   └─ should be drafted before any real public beta
```

Recommended serial/parallel shape:

1. Start A, C, D in parallel worktrees.
2. Start F in a separate worktree after D identifies generated QA command paths.
3. Start E after A and C APIs are stable enough for fixtures.
4. Start G after A/D/F interfaces stop moving.
5. Start H as a read-only planning/validation lane throughout.
6. Integrate serially: A → C → D → F → E → G → H → roadmap/readiness consolidation.

## 5. Milestone plan

## 5.1 Alpha 0 — internal Pi factory alpha hardening

Purpose: make the existing Pi/CLI factory reliable enough for trusted internal dogfooding.

Current status: mostly met, but still missing durable QA recovery and stronger no-overclaim runtime evidence.

### Deliverables

#### A0.1 Durable QA log emission contract

Files likely touched:

- generated QA skill source or templates;
- `lib/factory-qa-capture.ts` only for additive parser support;
- `test/factory-qa-capture.test.ts`;
- `test/pi-extension.test.ts`.

Requirements:

- QA skill outputs durable JSONL entries to a deterministic per-project log path.
- Each entry includes:
  - `factory_run_id`;
  - skill family (`qa` or `qa-only`);
  - status;
  - timestamp;
  - summary;
  - browser evidence summaries;
  - checked URL or target when available;
  - errors/failures when available.
- Log writer never stores secrets or raw environment dumps.
- Missing or malformed log leaves run pending.
- Multiple matching entries are ambiguous and fail closed.

Validation:

```bash
bun test test/factory-qa-capture.test.ts test/pi-extension.test.ts test/factory-qa-workflow.test.ts
```

#### A0.2 `/factory-recover-qa` command

Only after A0.1 is real.

Files likely touched:

- `.pi/extensions/pi-gstack/index.ts`;
- `test/pi-extension.test.ts`.

Requirements:

- Mirrors `/factory-recover-review` behavior for QA.
- Requires exact run ID.
- Reads durable QA log.
- Captures exactly one correlated post-dispatch entry.
- Idempotent on repeated recovery.
- Does not edit repository files.
- Does not expose QA fix.

Validation:

```bash
bun test test/pi-extension.test.ts test/factory-qa-capture.test.ts
```

#### A0.3 Alpha 0 status audit

Files likely touched:

- docs only, unless tests reveal copy drift.

Requirements:

- `/factory-status` for QA audit says no-edit.
- `/factory-status` for ship says readiness-only/no-deploy.
- `/factory-list` keeps next action clear.
- Gate commands still require `requestSequence`.

Validation:

```bash
bun test test/pi-extension.test.ts test/factory-facade.test.ts
```

### Alpha 0 exit criteria

- Review and QA audit can both recover from durable logs.
- Manual fallback remains available.
- Status/list/gates/decide flows remain green.
- `/factory-qa-fix` remains hidden.
- No package/dependency changes.

## 5.2 Alpha 1 — connected web/API cockpit alpha prep

Purpose: make the cockpit data real enough that a UI can connect later without reshaping core contracts.

This milestone should not choose a production web stack. It should produce the backend/view-model foundation for a future cockpit.

### Deliverables

#### A1.1 Durable project/workspace catalog

Files likely touched:

- `lib/factory-project-store.ts` (new);
- `lib/factory-project.ts` additive updates;
- `test/factory-project-store.test.ts` (new);
- `test/factory-project.test.ts` additive cases.

Storage default:

```text
.gstack/factory/projects/projects.jsonl
.gstack/factory/projects/<project-id>/project.json
.gstack/factory/projects/<project-id>/links.jsonl
```

Data model:

- Workspace:
  - id;
  - title;
  - project IDs;
  - created/updated timestamps.
- Project:
  - id;
  - title;
  - idea brief;
  - mode preference (`easy` or `hands-on`);
  - safety preference;
  - run links.
- Run link:
  - project ID;
  - run ID;
  - workflow ID;
  - relationship (`primary`, `qa-audit`, `qa-fix`, `ship-readiness`, `supporting`);
  - created/updated timestamps.

Rules:

- Catalog writes are append/atomic where practical.
- Unsafe IDs are rejected.
- Missing linked runs degrade gracefully in view DTOs.
- Project DTOs wrap run-scoped facade output; they do not mutate core run contracts.

Validation:

```bash
bun test test/factory-project-store.test.ts test/factory-project.test.ts test/factory-event-store.test.ts
```

#### A1.2 Connected artifact descriptor views

Files likely touched:

- `lib/factory-artifact-content.ts` additive updates;
- `lib/factory-project.ts` artifact view integration;
- optionally `lib/factory.ts` additive DTO helpers only if needed;
- `test/factory-artifact-content.test.ts`;
- `test/factory-project.test.ts`;
- `test/factory-facade.test.ts` if facade additions happen.

Requirements:

- Project artifact cards use descriptor summaries.
- Trusted artifact-store text remains readable.
- Untrusted event `path`/`uri` remains metadata-only.
- Binary/URI/bundle descriptors are displayable without fetching unsafe content.
- User-facing views show provenance.

Validation:

```bash
bun test test/factory-artifact-content.test.ts test/factory-project.test.ts test/factory-facade.test.ts test/factory-artifact-store.test.ts
```

#### A1.3 Fixture-backed cockpit view models

Files likely touched:

- `lib/factory-cockpit-view.ts` (new, pure calculations);
- `test/factory-cockpit-view.test.ts` (new);
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_COMPONENT_MODEL.md` only if linking is needed.

Requirements:

- Produces screen-ready view models for:
  - dashboard;
  - idea wizard state;
  - Easy Mode project home;
  - Hands-on 3-bay map;
  - bay simple overview;
  - detailed cockpit;
  - gate decision surface;
  - QA evidence panel;
  - ship-readiness/handoff.
- Each view model marks data provenance:
  - `persisted`;
  - `contract-backed`;
  - `wrapper-derived`;
  - `mocked`.
- No UI framework imports.
- No filesystem access in view calculations.

Validation:

```bash
bun test test/factory-cockpit-view.test.ts test/factory-project.test.ts test/factory-artifact-content.test.ts
```

#### A1.4 Optional static prototype decision

Default autonomous action: **do not build the static prototype yet**.

Reason: earlier guardrail says static no-dependency prototype under `docs/prototypes` is allowed only with explicit approval.

No-intervention fallback:

- produce fixture JSON and view-model tests instead;
- update docs to say the prototype can be generated later from stable view models.

### Alpha 1 exit criteria

- Durable project/workspace catalog exists and is tested.
- Project views can be produced from persisted project records plus run DTOs.
- Artifact descriptor views are safe and provenance-aware.
- Cockpit view models satisfy the screen spec without a production web scaffold.
- No package/dependency changes.

## 5.3 Alpha 2 — safe local QA-fix alpha

Purpose: make write-capable local QA fixes possible only when every execution path is guarded and auditable.

Important: Alpha 2 may reveal a platform limitation. If the Pi/Claude environment cannot enforce command routing through the guard, keep `/factory-qa-fix` hidden and ship only the proof/audit pieces.

### Deliverables

#### A2.1 Live execution path inventory

Files likely touched:

- `docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md` additive appendix;
- tests only if inventory creates fixtures.

Requirements:

- Identify every path a QA-fix agent could use to mutate files or run commands:
  - factory runtime command execution;
  - Pi custom tools;
  - generated skill instructions;
  - browser sidecars;
  - shell/tool access not controlled by factory code.
- Mark each path:
  - guarded;
  - guardable;
  - not enforceable from repo code;
  - out of scope.

Exit rule:

- If any required write path is not enforceable, do not expose `/factory-qa-fix`.

#### A2.2 Guarded command tool/adapter integration

Files likely touched:

- `.pi/extensions/pi-gstack/index.ts`;
- `lib/factory-guarded-runtime.ts` additive updates;
- `test/factory-guarded-runtime.test.ts`;
- `test/pi-extension.test.ts`.

Requirements:

- All factory-owned command execution goes through `withGuardedCommandRuntime` or equivalent.
- Denied command returns structured denial; it does not execute.
- Classifier failure is a denial.
- Denial includes reason/category/profile without leaking secrets.
- Capability `safe-command-guard` is advertised only when wrapper is active.

Validation:

```bash
bun test test/factory-guarded-runtime.test.ts test/factory-command-guard.test.ts test/pi-extension.test.ts
```

#### A2.3 Denial audit artifacts/events

Files likely touched:

- `lib/factory-runner.ts` or adapter boundary if artifact emission belongs there;
- `lib/factory-artifact-content.ts` if descriptor support is needed;
- tests for denial artifacts.

Requirements:

- Denied commands produce durable evidence.
- Evidence includes sanitized command summary and guard decision.
- Evidence never includes secret values.
- Denial can be shown in status/artifact views.

Validation:

```bash
bun test test/factory-guarded-runtime.test.ts test/factory-runner.test.ts test/factory-artifact-content.test.ts
```

#### A2.4 Explicit QA-fix command exposure gate

Default autonomous action: **do not expose `/factory-qa-fix` until A2.1–A2.3 prove all required paths are enforceable**.

If enforceability is proven, expose only with:

- explicit opt-in command;
- strong copy distinguishing audit vs fix;
- required `non-destructive-write` profile;
- denial audit artifacts;
- negative tests for blocked operations.

Validation if exposed:

```bash
bun test test/pi-extension.test.ts test/factory-qa-workflow.test.ts test/factory-command-guard.test.ts test/factory-guarded-runtime.test.ts
```

### Alpha 2 exit criteria

- Either `/factory-qa-fix` remains hidden with documented enforceability blocker, or it is exposed only after full path attestation and negative tests.
- No release/deploy/publish actions are possible.
- Denied commands are auditable.

## 5.4 Beta 0 — packaged Pi user beta prep

Purpose: prepare install/update/distribution for non-developer users without publishing anything.

### Deliverables

#### B0.1 Runtime bundle manifest

Files likely touched:

- `lib/factory-distribution.ts` or `scripts/` helper if needed;
- `test/factory-distribution.test.ts`;
- `docs/designs/PI_FACTORY_DISTRIBUTION_PACKAGE_PATH.md` additive implementation notes.

Requirements:

- Manifest lists:
  - extension files;
  - generated skill files;
  - runtime sidecars;
  - version/commit metadata;
  - compatibility constraints.
- Manifest can be validated without writing to Pi install paths.
- Missing expected files fail closed.

Validation:

```bash
bun test test/factory-distribution.test.ts
```

#### B0.2 Dry-run bundle builder

Autonomous limit: may create local staging under temp dirs in tests; must not publish or install globally.

Requirements:

- Builds/stages a bundle in a caller-provided output directory.
- Supports dry-run validation.
- Does not overwrite user-managed paths.
- Does not edit package manifests.

Validation:

```bash
bun test test/factory-distribution.test.ts
```

#### B0.3 Install/update/rollback plan tests

Requirements:

- Simulated install detects existing files.
- Simulated upgrade preserves user-managed content.
- Simulated rollback identifies previous bundle.
- All tests run in temp dirs.

### Beta 0 exit criteria

- A non-publishing bundle validation path exists.
- Source mode remains unchanged.
- No external release or package registry action occurs.

## 5.5 Beta 1 — common-user cockpit beta prep

Purpose: make the cockpit journey coherent for a common user once a web stack is approved.

Autonomous default: implement data/view contracts and fixtures, not a production web app.

### Deliverables

#### B1.1 End-to-end cockpit journey fixtures

Files likely touched:

- `test/fixtures/factory-cockpit/`;
- `test/factory-cockpit-view.test.ts`;
- docs if needed.

Fixtures should cover:

1. new idea with Easy Mode;
2. active build with no decision needed;
3. decision-needed gate;
4. QA audit with evidence;
5. denied unsafe command evidence if Alpha 2 implemented;
6. ship-readiness/handoff complete.

Requirements:

- Fixtures use stable DTOs, not arbitrary UI-only shapes.
- Provenance is explicit.
- No copy implies deployment.

#### B1.2 Mobile/responsive acceptance contract

Files likely touched:

- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md` additive appendix;
- `docs/designs/PI_SOFTWARE_FACTORY_P0_PRODUCT_ACCEPTANCE.md` additive checks.

Requirements:

- Mobile dashboard shows decision-needed first.
- Easy Mode remains the default.
- Gate decisions remain clear and safe on small screens.
- Artifact/evidence details show provenance.

#### B1.3 Auth/workspace boundary design

Autonomous default: document local-only and future hosted modes; do not implement auth.

Requirements:

- Local-only Alpha mode has single-user filesystem trust boundary.
- Hosted/future mode requires workspace/tenant isolation design before implementation.
- Artifact rendering and command execution are isolated per workspace.

### Beta 1 exit criteria

- A common-user journey can be validated from fixtures and view models.
- Web implementation can begin later without redesigning contracts.
- Auth/tenant risks are documented before hosted work starts.

## 5.6 Beta 2 — production operations beta prep

Purpose: define and begin the checks that make the platform supportable.

### Deliverables

#### B2.1 Production-like smoke contract

Files likely touched:

- `docs/designs/PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md` additive appendix;
- test helpers if local smoke checks can run without services.

Checks:

- module load;
- factory facade plan/status/list/artifact read;
- project catalog read/write;
- QA log parse/recover fixture;
- guarded command denial fixture;
- distribution bundle dry-run;
- web health endpoint only after a real web app exists.

#### B2.2 Backup/migration plan

Requirements:

- Factory run event store backup approach.
- Project catalog backup approach.
- Artifact store backup approach.
- Migration/version marker for project catalog and distribution bundle manifests.

#### B2.3 Security review contract

Must cover:

- command execution;
- artifact descriptor rendering;
- external URI handling;
- browser evidence capture;
- project/workspace path boundaries;
- prompt-injection surfaces in QA/browser logs;
- stale gate decisions;
- secret redaction.

### Beta 2 exit criteria

- Production-like checks are defined and partially automated where possible.
- State backup/migration story exists.
- Security review has a concrete checklist and can be delegated to `security-auditor` before beta.

## 6. Validation contract by layer

### Pure calculations

Must have deterministic tests and no IO:

- project/catalog DTO derivation;
- cockpit view models;
- artifact descriptor validation;
- QA capture selection;
- command classification;
- scheduling/gate calculations.

Preferred command:

```bash
bun test test/factory-core.test.ts test/factory-project.test.ts test/factory-artifact-content.test.ts test/factory-qa-capture.test.ts test/factory-command-guard.test.ts
```

### Store/adapters

Must use temp dirs and reject unsafe IDs/paths:

- event store;
- artifact store;
- project catalog store;
- distribution staging.

Preferred command:

```bash
bun test test/factory-event-store.test.ts test/factory-artifact-store.test.ts test/factory-project-store.test.ts test/factory-distribution.test.ts
```

### Pi extension

Must preserve no-overclaim UX and hidden QA-fix default:

```bash
bun test test/pi-extension.test.ts test/factory-qa-workflow.test.ts test/factory-facade.test.ts
```

### Integration smoke

After each integration wave:

```bash
bun test \
  test/pi-extension.test.ts \
  test/factory-facade.test.ts \
  test/factory-core.test.ts \
  test/factory-project.test.ts \
  test/factory-artifact-content.test.ts \
  test/factory-qa-capture.test.ts \
  test/factory-command-guard.test.ts \
  test/factory-guarded-runtime.test.ts \
  test/factory-event-store.test.ts \
  test/factory-artifact-store.test.ts

git diff --check -- docs/designs lib test .pi/extensions/pi-gstack/index.ts
```

Add new test files to this smoke as they land.

## 7. Parallel execution lanes for the next wave

Use isolated worktrees again. Suggested lanes:

| Lane | Worktree | Output |
|---|---|---|
| A | `gstack-wt-project-catalog` | Durable project/workspace catalog. |
| B | `gstack-wt-artifact-views` | Artifact descriptor integration into project views. |
| C | `gstack-wt-qa-logs` | Generated QA durable log emission and `/factory-recover-qa`. |
| D | `gstack-wt-live-guard` | Live guard path inventory/wrapping/denial audit. |
| E | `gstack-wt-cockpit-view` | Cockpit view models and fixtures. |
| F | `gstack-wt-distribution-dryrun` | Bundle manifest/dry-run validation. |
| G | `gstack-wt-ops-security` | Smoke/backup/security contracts. |
| H | `gstack-wt-validation` | Read-only review across lanes. |

Integration order:

1. Project catalog.
2. Artifact views.
3. QA logs/recovery.
4. Live guard inventory/wrapping.
5. Cockpit view models/fixtures.
6. Distribution dry-run.
7. Ops/security contracts.
8. Roadmap/readiness consolidation.

## 8. Stop/continue rules

Continue autonomously when:

- changes are additive and within `lib/`, `test/`, `.pi/extensions/pi-gstack/index.ts`, or docs;
- tests can be written in temp dirs;
- no package/dependency changes are required;
- `/factory-qa-fix` remains hidden or fully gated by proven guard attestation;
- web work remains data/view/docs only.

Stop and report only when:

- a dependency or package manifest change is required;
- a production web stack/location decision is required;
- protected files must be changed;
- a live Pi/Claude command path cannot be guarded but is necessary for QA-fix exposure;
- an external service, production deploy, publish, tag, or push would be required;
- a security invariant cannot be satisfied without user/product decision.

No-intervention fallback for stops:

- document the blocker in the lane handoff;
- keep unsafe feature hidden;
- land tests/docs for the safe subset;
- proceed with independent lanes.

## 9. Definition of done for the next planning-to-execution wave

The next wave is complete when:

- Alpha 0 durable QA recovery is real or explicitly blocked by missing generated log emission;
- Alpha 1 data/view foundation exists without a production web scaffold;
- Alpha 2 either proves guard attestation and keeps/exposes QA-fix accordingly, or keeps QA-fix hidden with documented unguardable paths;
- Beta 0 has a dry-run bundle manifest/validator, not a publish action;
- Beta 1 has common-user cockpit fixtures/view models and mobile/auth boundary contracts;
- Beta 2 has smoke/backup/security contracts;
- roadmap and readiness docs are consolidated once;
- focused factory tests pass;
- protected files remain untouched.
