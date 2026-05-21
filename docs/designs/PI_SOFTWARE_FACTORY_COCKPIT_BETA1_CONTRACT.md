# Universe AI Software Factory Cockpit Beta 1 Contract

Status: Beta 1 common-user cockpit contract after Alpha 1 data/view-model implementation. This is a UI/API contract, not a production web scaffold.

Companion implementation:

- `lib/factory-project-store.ts`
- `lib/factory-project.ts`
- `lib/factory-artifact-content.ts`
- `lib/factory-cockpit-view.ts`
- `test/factory-project-store.test.ts`
- `test/factory-project.test.ts`
- `test/factory-artifact-content.test.ts`
- `test/factory-cockpit-view.test.ts`

## 1. Scope

Beta 1 exists to prove a common user can understand and control a Universe AI Software Factory project without learning the Pi CLI.

This contract covers:

- end-to-end cockpit journey fixtures;
- mobile/responsive acceptance;
- local-only auth/workspace boundary defaults;
- hosted-mode boundary requirements before any future production web app.

It does **not** approve:

- a production web stack;
- dependency additions;
- hosted auth implementation;
- deployment/release automation;
- `/factory-qa-fix` exposure.

## 2. Implemented data/view foundation

The current implementation supports Beta 1 prep through pure DTO/view-model layers:

1. `FileFactoryProjectStore`
   - persists workspaces, projects, and run links under `.gstack/factory/projects/`;
   - rejects unsafe IDs;
   - degrades gracefully when linked runs are missing.
2. Project wrapper DTOs
   - wrap run-scoped factory facade/status data;
   - surface dashboard, resume, 3-bay progress, safety, and artifact views.
3. Artifact content descriptors
   - distinguish trusted local artifact-store content from untrusted event metadata;
   - expose safe primary actions and safety labels.
4. Cockpit view models
   - produce screen-ready data for dashboard, idea wizard, Easy Mode, Hands-on 3-bay map, bay overview, detailed cockpit, gates, QA evidence, and ship readiness;
   - carry provenance labels: `persisted`, `contract-backed`, `wrapper-derived`, `mocked`.

## 3. Beta 1 journey fixtures

A future UI must be able to render these journeys from `lib/factory-cockpit-view.ts` outputs.

### J1 — New idea, Easy Mode default

User goal: “I want Universe AI to help me shape a product idea.”

Required screens:

- dashboard empty state;
- idea wizard;
- mode picker with Easy Mode recommended;
- generated idea brief preview.

Acceptance:

- user is never dropped into a blank prompt;
- user can see what information is still needed;
- Hands-on Mode is available but not pushed as default;
- no project run claims to exist before there is persisted project/run state.

### J2 — Active build, no decision needed

User goal: “What is Universe doing right now?”

Required screens:

- Easy Mode project home;
- compressed progress strip;
- Universe-handled feed;
- optional Hands-on 3-bay map.

Acceptance:

- exactly one primary next action is visible;
- if no user action is needed, the copy says so;
- routine reversible work is summarized without forcing a transcript read.

### J3 — Decision-needed gate

User goal: “What am I approving?”

Required screens:

- dashboard decision-needed banner;
- gate decision surface;
- detailed cockpit phase context.

Acceptance:

- request sequence is visible in the underlying action contract;
- stale decisions are rejected by the factory command/API layer;
- safety impact says what Universe can and cannot touch;
- approve/reject/waive/cancel copy is plain-language.

### J4 — QA audit evidence

User goal: “What was tested, what failed, and what proof exists?”

Required screens:

- QA evidence panel;
- artifact detail;
- recovery/manual fallback hints when relevant.

Acceptance:

- audit mode banner says no code changes;
- recovered durable QA logs show browser evidence without exposing secrets;
- untrusted event URI/path metadata is labeled metadata-only;
- fix mode is shown only for persisted `qa-fix` runs, not ordinary audit runs.

### J5 — Guard denial evidence

User goal: “Why did Universe refuse that action?”

Required screens:

- QA/fix-loop evidence panel or detailed cockpit audit trail;
- denial artifact/detail row.

Acceptance:

- denied command evidence shows reason/category/profile;
- full command text and secrets are not shown;
- command digest/head may be shown for correlation;
- `/factory-qa-fix` remains hidden unless live path attestation is complete.

### J6 — Ship readiness / handoff

User goal: “Is this ready for handoff?”

Required screens:

- ship-readiness checklist;
- handoff summary;
- artifact list.

Acceptance:

- copy says “Ready for handoff,” not “deployed”;
- ship-readiness disclaimer is visible;
- no tag, publish, push, deploy, or release action is implied.

## 4. Mobile/responsive acceptance contract

Beta 1 mobile is responsive web behavior, not a native app.

### M1 — Mobile dashboard

Requirements:

- decision-needed state appears before project browsing;
- resume hero appears above secondary project lists;
- project cards show phase/status, next action, and safety state without horizontal scrolling;
- mode switch is visible but not more prominent than the current action.

Acceptance:

- a user can answer “what needs me?” within the first viewport;
- a project with no needed action does not compete visually with a project blocked on approval.

### M2 — Mobile Easy Mode project home

Requirements:

- right-now card first;
- compressed progress second;
- “Anything for me?” status third;
- Universe-handled feed collapses by default after the newest items.

Acceptance:

- user can see current state and next action without opening detailed cockpit;
- switching to Hands-on Mode is explicit and reversible when no gate is pending.

### M3 — Mobile Hands-on 3-bay map

Requirements:

- Shape/Build/Ship bays stack vertically;
- active bay is visually distinct;
- locked/upcoming bays explain what unlocks them;
- detailed cockpit remains one action deeper.

Acceptance:

- user understands where the project is without seeing all 9 phases at once.

### M4 — Mobile gate decision

Requirements:

- full-screen decision card or equivalent high-focus surface;
- safety can/cannot list visible before action buttons;
- approve/reject actions sticky at bottom;
- request sequence carried in the action payload, not editable by the user.

Acceptance:

- no destructive or write-capable implication is hidden below the fold;
- accidental stale approvals fail closed.

### M5 — Mobile artifact/evidence detail

Requirements:

- provenance label visible near the title;
- primary action reflects descriptor safety (`open-text`, `preview`, `open-link`, `inspect-metadata`, etc.);
- untrusted event metadata never renders as a trusted clickable file/link action.

Acceptance:

- user can tell trusted evidence from metadata-only references.

## 5. Auth/workspace boundary design

### Alpha/Beta local-only default

Until a hosted web app is explicitly approved, the boundary is:

```text
one local user account
one local filesystem trust zone
workspace/project IDs scoped under the local .gstack directory
factory runs scoped under the local project root
```

Local-only rules:

- no network auth layer is assumed;
- no tenant isolation claim is made;
- workspace IDs prevent accidental UI mixing, not hostile multi-tenant access;
- all filesystem paths must still be validated and normalized;
- artifact provenance is required even in local-only mode.

### Hosted/future mode requirements

Before any hosted or multi-user cockpit implementation, design and review must define:

1. Workspace/tenant ownership model.
2. Project membership and role model.
3. Artifact access authorization.
4. Gate decision authorization and stale-request handling.
5. Command execution isolation per workspace.
6. Browser evidence storage isolation.
7. Secret redaction and credential boundary.
8. Audit log retention and export policy.

Hosted mode cannot reuse local-only assumptions. A hosted cockpit must treat every project/workspace ID, artifact ID, run ID, URI, and command request as untrusted input.

## 6. Beta 1 validation checklist

A Beta 1 candidate passes this contract when:

- all six journey fixtures render from view models without special-case UI-only data;
- every view section has provenance;
- mobile dashboard, Easy Mode, 3-bay map, gate decision, and artifact detail satisfy M1–M5;
- local-only boundary is clearly labeled;
- hosted mode remains blocked until tenant/auth design exists;
- QA audit/fix and ship-readiness/deploy boundaries are not blurred;
- no dependency/package changes or production web scaffold are required to validate the data/view contracts.

Recommended checks:

```bash
bun test test/factory-cockpit-view.test.ts test/factory-project.test.ts test/factory-artifact-content.test.ts
rg "Ship readiness is not deployment|Browser QA audit|provenance|metadata-only|Ready for handoff" docs/designs lib/factory-cockpit-view.ts test/factory-cockpit-view.test.ts
```
