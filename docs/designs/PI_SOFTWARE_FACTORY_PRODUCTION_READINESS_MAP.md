# Universe AI Software Factory Production Readiness Map

Status: post-parallel Wave 1 readiness level-set. This is a planning artifact, not a release claim.

Last updated after:

- `f2f53c65 Add Universe AI design wireframes`
- `6c06d989 Reconcile Universe AI design brief`
- `799a31d1 Add factory artifact content descriptors`
- `36c0f899 Add factory project workspace wrapper`
- `8b6836c5 Add factory guarded runtime wrapper`
- `626cfd04 Add durable factory QA capture calculations`
- `92e6e06c Specify Universe AI web cockpit P0`
- `5cf6273b Consolidate Universe AI factory roadmap`

## Executive summary

Wave 1 moved the factory from a Pi/CLI-oriented event-sourced core with web intent into a clearer **Universe AI Software Factory** platform plan with first-slice wrapper APIs and safety/runtime primitives.

The follow-on autonomous Alpha/Beta execution wave added durable project state, durable QA recovery, artifact-content integration, cockpit view models, distribution dry-run primitives, and operations/security contracts. It also confirmed that `/factory-qa-fix` must remain hidden until the host can route dispatched skill Bash/Read/Write/Edit paths through factory guard code.

Current readiness estimate:

| Scope | Before Wave 1 | After Wave 1 | After Alpha/Beta execution wave | Meaning |
|---|---:|---:|---:|---|
| Internal Pi/CLI factory core | ~60–65% | ~70–75% | **~78–82%** | Review/QA/status/gates now include durable QA recovery and stronger stores, but write-capable QA fix and release actions remain blocked. |
| Common-user web cockpit/platform | ~30–35% | ~45–50% | **~58–63%** | Durable project/catalog DTOs, artifact descriptors, and pure cockpit view models exist, but no production web app scaffold/runtime exists. |
| Weighted overall production readiness | ~33% | ~48–52% | **~60–65%** | The platform now has Alpha/Beta data contracts and validation foundations, discounted for missing live UI/package surface and host-level guard enforcement. |

The branch is **not production-ready** for public users yet. It is ready for validation consolidation, optional no-dependency cockpit prototyping if approved, and host-enforced command-guard design work.

## What changed in Wave 1

### Product/design readiness

Improved from “factory cockpit idea exists” to “P0 product contract exists.”

New durable decisions:

- Product name/framing: **Universe AI Software Factory**.
- Promise: common users can “build anything in the universe with Universe AI.”
- Easy Mode is the default user experience.
- Hands-on Mode exposes the factory without making the whole app developer-first.
- The 9-phase factory model is nested under a simpler 3-bay model:
  - Shape;
  - Build;
  - Ship.
- Gates, QA evidence, artifacts, safety state, and ship readiness are first-class UI surfaces.

Remaining gap:

- A real web stack/location has not been approved.
- No production cockpit app exists yet.
- Visual implementation is represented by pure view models and contracts unless a static prototype or real app scaffold is explicitly approved.

### API/platform readiness

Improved from run-scoped facade only to first-slice project/workspace and artifact view contracts.

New pieces:

- `lib/factory-project.ts` projects run DTOs into dashboard/project/workspace summaries.
- `lib/factory-artifact-content.ts` models text, binary, URI, and bundle descriptors with provenance.
- Existing `lib/factory.ts` remains the stable run-scoped facade.

Remaining gap:

- Durable local project/workspace catalog exists, but has not yet been exercised by a live UI.
- Artifact descriptors are wired into project/facade views, but binary/bundle storage is still future work.
- Multi-run project relationships are persisted locally, but hosted/workspace auth boundaries remain design-only.

### Runtime/safety readiness

Improved from pure safe-command classifier to classifier plus guarded runtime wrapper first slice.

New pieces:

- `lib/factory-command-guard.ts` pure deny-first classifier.
- `lib/factory-guarded-runtime.ts` wrapper proving denied commands do not execute.
- Tests cover fail-closed command classification and capability advertisement.

Remaining gap:

- Dispatched Pi/Claude skill Bash/Read/Write/Edit paths are not enforceable from repository code.
- Sanitized guard-decision audit seams exist, but denied-command artifacts/events are not yet emitted by live factory runs.
- `/factory-qa-fix` remains intentionally hidden.
- Release/deploy/publish automation remains out of scope.

### QA evidence readiness

Improved from manual QA completion only to durable QA log parser/correlation calculations.

New pieces:

- `lib/factory-qa-capture.ts` parses/correlates machine-readable QA log entries.
- Tests cover malformed lines, wrong/missing correlation, ambiguity, post-dispatch matching, and browser evidence artifact rendering.

Remaining gap:

- Generated QA skill instructions now emit durable QA logs through `bin/gstack-qa-log`, and `/factory-recover-qa` exists.
- Future work should dogfood the emitted logs in live Pi sessions and add production-like smoke coverage.

### Distribution readiness

Improved from implicit source-checkout assumptions to a concrete package path plan.

New doc:

- `docs/designs/PI_FACTORY_DISTRIBUTION_PACKAGE_PATH.md`

Remaining gap:

- Distribution manifest/dry-run/stage helpers exist, but no installable Pi runtime package has been built.
- Generated skills, extension, and runtime sidecars still need a versioned real installer/update path.

## Readiness scorecard

Scores are directional and intentionally conservative.

| Area | Weight | Current score | Evidence | Biggest blocker |
|---|---:|---:|---|---|
| Product definition | 15% | 80% | Design import, reconciliation, P0 acceptance, cockpit specs, Beta 1 cockpit contract. | Owner approval of final P0 visual/product choices. |
| Core factory engine | 20% | 80% | Pure core, runner, facade, gates, event/artifact/project stores, tests. | Real subagent/worktree execution and broader lifecycle hardening. |
| Pi adapter/CLI UX | 15% | 75% | Review/QA/status/list/gates/decide/recover commands, inspect-only UX, durable QA recovery. | Safe write-capable paths not live. |
| Project/web API layer | 15% | 70% | Durable project catalog, wrapper DTOs, artifact descriptors, cockpit view models. | No live UI consumer or hosted boundary implementation. |
| Web cockpit surface | 15% | 55% | P0 UX brief, screen/component spec, pure view models and journey fixtures. | No approved stack/scaffold or running UI. |
| Safety/permissions | 10% | 55% | Command classifier, guarded runtime tests, live path inventory, sanitized audit seam. | Host-level command/edit/write path attestation missing. |
| Distribution/operations | 10% | 50% | Distribution package path design, dry-run bundle helpers, ops/security contract. | No packaged install/update/recovery implementation. |

Weighted result: **~69% by artifact maturity**, discounted to **~60–65% production readiness** because the highest-risk missing items are runtime-connected: live web surface, host-level command-path attestation, packaged distribution, and production-like smoke automation.

## Alpha gates

### Alpha 0 — internal Pi factory alpha

Purpose: dogfood the factory through Pi commands on trusted repos.

Status: **met for trusted internal dogfooding, with caveats**.

Must hold:

- `/factory-review`, `/factory-qa`, `/factory-status`, `/factory-list`, `/factory-gates`, `/factory-decide`, `/factory-recover-review`, and `/factory-recover-qa` work on local projects.
- Status views remain inspect-only.
- QA audit remains no-edit.
- Ship readiness remains no-deploy/no-release.
- `/factory-qa-fix` remains hidden.
- Focused factory tests stay green.

Not included:

- public/common-user onboarding;
- installable package;
- production web app;
- release/deploy execution.

### Alpha 1 — connected web cockpit alpha

Purpose: let a trusted user see a project dashboard/cockpit backed by factory state.

Entry gates:

- Approve web stack and repo/app location.
- Create durable project/workspace catalog.
- Connect `lib/factory-project.ts` view DTOs to real persisted project records.
- Wire artifact content descriptors into project artifact cards/details.
- Render fixture-backed and then store-backed versions of:
  - dashboard;
  - idea wizard;
  - Easy Mode project home;
  - Hands-on 3-bay map;
  - gate decision surface;
  - QA evidence panel;
  - ship-readiness/handoff surface.
- Preserve all no-overclaim copy:
  - QA audit is no-edit;
  - QA fix is separate and gated;
  - ship readiness is not deployment.

Exit gates:

- A fresh trusted user can understand what Universe AI is doing, what needs approval, what evidence exists, and what is safe/unsafe.
- UI has provenance labels for mocked vs contract-backed vs persisted data.
- No dependency/package changes happened without approval.

### Alpha 2 — safe local QA-fix alpha

Purpose: enable write-capable local fixes only after real guard enforcement exists.

Entry gates:

- All Pi/agent shell/file-write execution paths used by QA fix are wrapped by guarded runtime.
- `safe-command-guard` capability is advertised only when the wrapper is active for every relevant path.
- Denied commands create durable audit artifacts/events.
- Generated QA skill emits machine-readable durable QA logs.
- `/factory-recover-qa` exists and is idempotent after durable QA log emission is real.
- Negative tests prove no push, deploy, publish, force reset, `git clean`, secret/env dumping, package publish, or opaque shell composition can execute.

Exit gates:

- `/factory-qa-fix` can be exposed as an explicit opt-in command in trusted local projects.
- User-facing copy clearly distinguishes audit from fix mode.
- Failed/denied commands are visible in artifacts without leaking secrets.

## Beta gates

### Beta 0 — packaged Pi user beta

Purpose: install/update Universe AI Software Factory without a source checkout.

Entry gates:

- Versioned package includes extension, generated skills, sidecars, and compatibility metadata.
- Install/update/migrate path is scripted and tested.
- Existing source-checkout users are not broken.
- Browser runtime discovery is predictable and documented.
- Rollback/recovery path exists.

Exit gates:

- A non-repo maintainer can install, run a review, run QA audit, inspect status, and update safely.

### Beta 1 — common-user cockpit beta

Purpose: a common user can start and monitor a project from the web cockpit.

Entry gates:

- Web app stack/location approved and implemented.
- Project catalog and factory runs are connected.
- Gate decisions are safe against stale requests.
- Artifacts show trusted/untrusted provenance and safe content descriptors.
- Mobile layouts cover the dashboard, decision-needed state, simple overview, and evidence detail.
- Authentication/workspace boundaries are designed if the app leaves local-only mode.

Exit gates:

- User can start from an idea, choose Easy/Hands-on Mode, see progress, approve decisions, inspect QA evidence, and reach handoff readiness without CLI knowledge.

### Beta 2 — production operations beta

Purpose: prove the platform can survive real usage and support incidents.

Entry gates:

- Production-like smoke checks cover module load, app boot, factory status read, artifact read, and health endpoint if web app exists.
- Backups/migrations exist for factory/project state.
- Error/audit logs avoid secrets.
- Security review covers command execution, artifact rendering, browser evidence, tenant/workspace boundaries, and prompt-injection surfaces.
- Release/deploy automation remains disabled unless a separate release-action safety design ships.

Exit gates:

- A failed run is recoverable without data loss.
- A stale or malicious gate/artifact/command input fails closed.
- A new user can complete the P0 journey with supportable docs.

## Not production-ready until these are true

Do not call the Universe AI Software Factory production-ready until all are true:

1. A production web or packaged local UI exists and is approved.
2. Durable project/workspace state exists and survives process restarts.
3. Artifact descriptors are integrated into all user-facing artifact views.
4. QA durable logs are emitted by the generated QA skills, not only parsed by library tests.
5. Safe-command guard wraps live execution paths before any write-capable QA fix is exposed.
6. `/factory-qa-fix` has explicit opt-in UX, negative tests, and denial audit artifacts.
7. Distribution/install/update path is tested outside the source checkout.
8. Production-like smoke checks are part of the release gate.
9. Security review has passed for command execution, artifacts, browser evidence, and workspace/tenant boundaries.
10. Ship-readiness language cannot be confused with tag/publish/push/deploy automation.

## Recommended next wave

Highest-value next work:

1. Durable project/workspace catalog.
2. Artifact descriptor integration into project/facade views.
3. Generated QA durable log emission plus `/factory-recover-qa`.
4. Live safe-command guard wrapping and denial audit artifacts.
5. Approved no-dependency cockpit prototype or approved production web stack/location.
6. Packaged Pi install/update spike.

Keep roadmap consolidation serial after that wave, as in Wave 1.
