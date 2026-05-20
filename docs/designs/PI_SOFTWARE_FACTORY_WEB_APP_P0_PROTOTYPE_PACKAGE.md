# Pi Software Factory Web App P0 Prototype Package

Status: frozen P0 planning package. No implementation started.

Companion docs:

- [PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md](PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md)
- [PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md](PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md)

## 1. Purpose

This document is the implementation-ready P0 package for a frontend/design implementation agent. It freezes the P0 route list, component package, fixture scenarios, view-model contracts, safety copy, and prototype honesty rules.

P0 should prove the product wedge: a visible factory cockpit where conversation, expert personas, artifacts, approvals, safety state, browser QA evidence, and ship-readiness are first-class. It should not start real app-building, repo writes, browser automation, CI, deployment, billing, or team permissions.

## 2. P0 truth statement

P0 is a believable mocked prototype. It demonstrates workflow, evidence, decisions, safety boundaries, and handoff/readiness. Some actions are mocked and do not perform real code changes, browser sessions, CI runs, or deployment.

Use this banner in prototype/demo contexts:

> P0 prototype: this demo shows the workflow, evidence, and approvals. Some actions are mocked and do not perform real code changes, browser sessions, CI runs, or deployment.

## 3. P0 non-goals

- Do not implement a production web app.
- Do not add dependencies or scaffold a web framework without approval.
- Do not perform real repo writes.
- Do not run real browser automation.
- Do not run CI or deployment flows.
- Do not implement billing.
- Do not implement team authorization.
- Do not imply that ship-readiness means deployment.

## 4. Final P0 routes

Freeze these seven routes for P0:

| Route | Surface | Purpose | P0 backing |
|---|---|---|---|
| `/` | Landing page | Position the visible factory cockpit, not prompt-only app generation. | Mock/static |
| `/signup` | Signup/onboarding | Mock account/workspace setup and safety comfort level. | Mock/static |
| `/app` | Workspace dashboard | Show project resume cards and decisions needed. | Fixture-backed |
| `/app/projects/new` | New project wizard | Capture idea and produce mocked Idea Brief/MVP Scope. | Fixture-backed |
| `/app/projects/:projectId` | Factory cockpit | Main project cockpit with timeline, conversation, persona, artifacts, decisions, safety. | Fixture-backed view model |
| `/app/projects/:projectId/artifacts/:artifactId` | Artifact detail | Read artifact content, metadata, provenance, and linked decisions. | Fixture-backed view model |
| `/app/projects/:projectId/qa` | QA evidence | Show browser QA audit evidence, failed scenarios, and fix-loop approval. | Fixture-backed view model |

P1 routes such as project list, decisions, artifact library, ship-readiness route, and safety settings can appear as disabled nav items or stubs only if useful for orientation. They are not P0 implementation requirements.

## 5. Final P0 component package

### 5.1 Required components

- `ProjectStatusHeader`
- `FactoryTimeline`
- `ConversationPhaseWorkspace`
- `PersonaPanel`
- `PersonaCard`
- `ArtifactCard`
- `ArtifactDetailView`
- `GateDecisionModal`
- `SafetyBadge`
- `QAResultPanel`
- `BuildSummaryPanel`
- `ShipReadinessChecklist`
- `RecoveryCard`
- `AuditTrailPanel`
- `DecisionNeededBanner`
- `ResumeBanner`

### 5.2 Implementation order

1. Fixture and projection layer.
2. App shell and responsive cockpit layout.
3. `ProjectStatusHeader`.
4. `FactoryTimeline`.
5. `ConversationPhaseWorkspace`.
6. `PersonaPanel` / `PersonaCard`.
7. `ArtifactCard` / `ArtifactDetailView`.
8. `SafetyBadge` and expanded safety explanation.
9. `GateDecisionModal` with stale/conflict/loading states.
10. `QAResultPanel`.
11. `BuildSummaryPanel`.
12. `ShipReadinessChecklist`.
13. `RecoveryCard`.
14. `AuditTrailPanel`.
15. Polish pass for empty/loading/error/accessibility states.

### 5.3 Component rules

- Components consume explicit view models, not raw run events.
- Components should not parse factory events directly.
- Artifact labels must be human-readable before technical kind/path.
- Safety state must appear near risky CTAs.
- Gate modal must handle loading, stale sequence, conflict/already-decided, permission blocked, and double-submit prevention.
- Timeline must support a visually nested QA fix loop.
- The active decision/next action must remain visible on desktop, tablet, and mobile.

## 6. Required fixture scenarios

Use deterministic fixture ids so designers, frontend agents, and tests refer to the same states.

### 6.1 Scenario: new intake

- `projectId`: `project-intake-new`
- Status: `draft-idea`
- Active persona: Product Coach
- Artifacts: none
- Next action: answer intake question
- Safety: read-only audit
- Purpose: prove the product does not start from an empty chat box.

### 6.2 Scenario: planning approval needed

- `projectId`: `project-planning-approval`
- Status: `planning`
- Active persona: Product Coach
- Artifacts:
  - Idea Brief
  - MVP Scope
- Pending gate: approve MVP scope
- Safety: read-only audit
- Purpose: prove artifacts and approvals are first-class.

### 6.3 Scenario: build approval needed

- `projectId`: `project-build-approval`
- Status: `building`
- Active persona: Engineering Architect / Implementation Agent
- Artifacts:
  - Build Plan
  - Changed Areas preview
- Pending gate: approve safe local fixes/build
- Safety: safe local fixes pending approval
- Purpose: prove write-capable automation is explicit and understandable.

### 6.4 Scenario: QA audit failed

- `projectId`: `project-qa-audit-failed`
- Status: `qa-audit`
- Active persona: QA Lead
- Artifacts:
  - QA Report
  - Screenshot evidence
  - Browser trace summary
- QA mode: audit, no code changes
- Failed scenarios: at least 3
- Pending gate: approve safe local fix loop
- Purpose: prove browser evidence and QA/fix separation.

### 6.5 Scenario: ship readiness complete

- `projectId`: `project-ship-readiness-complete`
- Status: `ready-for-handoff`
- Active persona: Release Coordinator
- Artifacts:
  - Ship Readiness Report
  - Release Notes Draft
  - Handoff Plan
- Checklist: mostly green with at least one accepted risk
- Persistent banner: no deploy/publish/push happened
- Purpose: prove ship-readiness cannot be mistaken for deployment.

### 6.6 Scenario: stale gate conflict

- `projectId`: `project-stale-gate`
- Status: `paused`
- Gate state: stale or already decided
- UI copy: “This decision is stale. Refresh to load the current gate state.”
- Purpose: prove request-sequence safety in the modal.

### 6.7 Scenario: policy blocked

- `projectId`: `project-policy-blocked`
- Status: `blocked`
- Blocker: policy denies browser or write action
- Safety: blocked by policy
- Purpose: prove blocked states explain the exact policy and next safe action.

### 6.8 Scenario: recovery needed

- `projectId`: `project-recovery-needed`
- Status: `paused`
- Pause reason: waiting for recovery
- RecoveryCard shown
- Status view remains inspect-only
- Purpose: prove recovery is explicit and auditable.

## 7. DTO and view-model layering

P0 fixtures should keep three layers separate:

1. **Factory-shaped data**: resembles current facade/core DTOs.
2. **Project wrapper data**: adds workspace/project concepts around one or more runs.
3. **Component view models**: what routes/components consume.

Components should use layer 3. Fixtures should preserve layers 1 and 2 so later real facade-backed reads can replace mocks.

## 8. Current contract alignment

### 8.1 Factory contracts to preserve

The P0 package should name and shape fixtures around these contracts:

- `FactoryRunStatusDto`
- `FactoryRunListItemDto`
- `FactoryArtifactSummaryDto`
- `FactoryArtifactDto`
- `FactoryGateInfoDto`
- `FactoryGateDecisionInput`
- `PolicySpec`
- `RiskFinding`

### 8.2 Project wrapper fields

Freeze these web-layer wrapper fields for P0:

```ts
interface ProjectWrapperDto {
  workspaceId: string;
  projectId: string;
  projectName: string;
  oneLineGoal: string;
  projectStatus: ProjectStatusView;
  activeRunId?: string;
  linkedRunIds: string[];
  currentPhaseId?: string;
  currentPhaseTitle?: string;
  nextAction: NextActionView;
  resumeSummary: ResumeSummaryView;
  activePersona?: PersonaView;
  supportingPersonas: PersonaView[];
}
```

### 8.3 Fixture envelope

Each P0 project fixture should follow this envelope:

```ts
interface P0ProjectFixture {
  project: ProjectWrapperDto;
  runs: Record<string, {
    status: FactoryRunStatusDtoLike;
    listItem?: FactoryRunListItemDtoLike;
    artifacts: FactoryArtifactDtoLike[];
    gates: FactoryGateInfoDtoLike[];
  }>;
  views: {
    cockpit: ProjectCockpitDto;
    qaEvidence?: QaEvidenceBundle;
    shipReadiness?: ShipReadinessView;
    artifactDetails: Record<string, ArtifactDetailView>;
  };
  provenance: Record<string, PrototypeProvenance>;
}

type PrototypeProvenance = 'contract-backed' | 'wrapper-derived' | 'mocked';
```

## 9. Contract-backed, wrapper-derived, and mocked truth table

| Surface/feature | P0 status | Notes |
|---|---|---|
| Project concept | Wrapper-derived | Current factory is run-scoped. |
| Workspace concept | Mocked | P0 single workspace/owner. |
| Dashboard cards | Wrapper-derived | Use `FactoryRunListItemDto`-like data plus project metadata. |
| Cockpit run status | Wrapper-derived | Use `FactoryRunStatusDto`-like data inside project wrapper. |
| Phase timeline | Wrapper-derived | Combines mocked product phases with factory-shaped run phases. |
| Persona panel | Mocked | Personas are UX roles, not current runtime DTOs. |
| Conversation thread | Mocked | P0 should show phase rooms, not raw transcripts. |
| Artifact cards | Wrapper-derived | Preserve `FactoryArtifactSummaryDto`-like fields plus display metadata. |
| Artifact detail | Wrapper-derived | Text content can resemble `FactoryArtifactDto`; screenshots/traces use URI/content-type wrappers. |
| Gate modal | Mixed | Ship gates are contract-backed examples; planning/build/QA-fix gates are prototype wrapper gates. |
| Gate stale handling | Contract-backed behavior, mocked UI | Current facade requires `requestSequence`; P0 must show stale/conflict states. |
| QA audit evidence | Mocked | Current QA workflow can produce QA artifacts later; P0 evidence is fixture data. |
| QA fix loop approval | Wrapper-derived/mocked | Represents linked `qa-fix` run; approval gate is prototype-level. |
| Ship-readiness checklist | Contract-aligned | Use current ship workflow gate/artifact ids. No deployment execution. |
| Safety badges | Wrapper-derived | Map `PolicySpec`, `RiskFinding`, and `commandSafetyProfile` to user copy. |
| Recovery card | Mocked UI for real boundary | Status is inspect-only; recovery is explicit. |
| Audit trail | Wrapper-derived/mocked | Projection of event-sourced receipts; P0 data is fixture-backed. |

## 10. Workflow mapping for fixtures

### 10.1 Review workflow

Current workflow id: `review`.

Contract-aligned phases/artifacts:

- `review-intake` → `review-plan`
- `diff-review` → `review-report`
- `review-summary` → `review-summary`

Current native gates: none.

P0 note: planning/build approval cards are mocked or wrapper-derived; do not label them as native review workflow gates.

### 10.2 QA audit workflow

Current workflow id: `qa`.

Contract-aligned phases/artifacts:

- `qa-intake` → `qa-plan`
- `qa-execution` → `qa-report`
- `qa-summary` → `qa-summary`

Current native gates: none.

P0 note: browser evidence, screenshots, and fix-loop approval are prototype fixtures/wrapper projections unless later connected to runtime artifacts.

### 10.3 QA fix workflow

Current workflow id: `qa-fix`.

Contract-aligned phases/artifacts:

- `qa-intake` → `qa-plan`
- `qa-execution` → `qa-report`
- `qa-summary` → `qa-summary`

Current native gates: none.

P0 note: distinguish QA fix from QA audit through safety/policy state and linked run id. Use `non-destructive-write` in safety copy. Do not imply production deploy or external release actions.

### 10.4 Ship-readiness workflow

Current workflow id: `ship`.

Contract-aligned phases/artifacts:

- `ship-intake` → `ship-plan`
- `ship-readiness` → `test-results`, `release-notes`
- `ship-publication-readiness` → `release-pr`
- `ship-release-gate` → `release-approval`
- `ship-summary` → `ship-summary`

Contract-backed gate ids:

- `review-status-clean`
- `tests-passing`
- `version-bump-ready`
- `changelog-ready`
- `ci-green`
- `pr-ready`
- `release-approved`
- `deploy-readiness-confirmed`

P0 note: these gates verify readiness only. No tag, publish, push, deploy, or release execution happens.

## 11. View-model contracts

These are P0 web view models. They are not proposed core changes.

### 11.1 ProjectCockpitDto

```ts
interface ProjectCockpitDto {
  project: ProjectWrapperDto;
  phases: ProjectPhaseView[];
  activePhaseId: string;
  personas: PersonaView[];
  conversation: ConversationEventView[];
  featuredArtifact?: ArtifactSummaryView;
  pendingDecision?: DecisionQueueItem;
  safety: SafetyPolicyView;
  resumeSummary: ResumeSummaryView;
  auditTrailPreview: ActivityEventView[];
}
```

### 11.2 ProjectPhaseView

```ts
interface ProjectPhaseView {
  phaseId: string;
  title: string;
  status: 'not-started' | 'active' | 'running' | 'waiting-for-user' | 'blocked' | 'complete' | 'skipped' | 'needs-fix';
  personaId: string;
  objective: string;
  expectedArtifactTitles: string[];
  artifactIds: string[];
  gateIds: string[];
  safetyState: SafetyStateView;
  linkedRunId?: string;
  nestedLoop?: 'qa-fix' | 'regression-qa';
  provenance: PrototypeProvenance;
}
```

### 11.3 PersonaView

```ts
interface PersonaView {
  personaId: string;
  title: string;
  responsibility: string;
  currentTask?: string;
  authorityBoundary: string;
  status: 'active' | 'supporting' | 'upcoming' | 'complete' | 'blocked';
  outputArtifactKinds: string[];
}
```

### 11.4 DecisionQueueItem

```ts
interface DecisionQueueItem {
  decisionId: string;
  runId: string;
  gateId: string;
  requestSequence: number;
  title: string;
  plainLanguageQuestion: string;
  recommendation?: 'approve' | 'reject' | 'waive' | 'cancel';
  allowedDecisions: Array<'approve' | 'reject' | 'waive' | 'cancel'>;
  reasonRequired?: boolean;
  phaseId: string;
  personaId?: string;
  supportingArtifactIds: string[];
  safetyImpact: SafetyImpactView;
  whatHappensNext: string;
  provenance: PrototypeProvenance;
}
```

### 11.5 ArtifactSummaryView and ArtifactDetailView

```ts
interface ArtifactSummaryView {
  artifactId: string;
  runId: string;
  displayTitle: string;
  kind: string;
  subtype?: string;
  status: 'draft' | 'produced' | 'approved' | 'superseded' | 'evidence' | 'accepted-risk' | 'needs-review';
  version: number;
  summary: string;
  phaseId?: string;
  personaId?: string;
  linkedGateIds: string[];
  createdAt: string;
  updatedAt?: string;
  provenance: PrototypeProvenance;
}

interface ArtifactDetailView extends ArtifactSummaryView {
  contentType: 'markdown' | 'image' | 'json' | 'trace' | 'diff' | 'external-url';
  content?: string;
  uri?: string;
  evidenceRefs?: EvidenceRefView[];
  versionHistory?: ArtifactSummaryView[];
}
```

### 11.6 QaEvidenceBundle

```ts
interface QaEvidenceBundle {
  projectId: string;
  runId: string;
  mode: 'audit' | 'fix';
  target: {
    url: string;
    environment: 'preview' | 'staging' | 'production-like' | 'unknown';
    authenticatedAs?: string;
    sideEffectWarning: string;
  };
  scenarios: QaScenarioView[];
  screenshots: EvidenceRefView[];
  trace?: EvidenceRefView;
  summary: string;
  recommendedNextAction: NextActionView;
  provenance: PrototypeProvenance;
}
```

### 11.7 ShipReadinessView

```ts
interface ShipReadinessView {
  projectId: string;
  runId: string;
  status: 'not-ready' | 'ready-for-handoff' | 'ready-for-future-deploy-workflow';
  noDeploymentExecuted: true;
  checklist: ShipReadinessItemView[];
  releaseNotesArtifactId?: string;
  handoffArtifactId?: string;
  finalGateId?: string;
  provenance: PrototypeProvenance;
}
```

### 11.8 SafetyPolicyView

```ts
interface SafetyPolicyView {
  state: SafetyStateView;
  allowWrites: boolean;
  allowBrowser: boolean;
  allowNetwork: boolean;
  commandSafetyProfile: 'read-only' | 'non-destructive-write' | 'release-action';
  plainLanguageSummary: string;
  blockedExamples: string[];
}

type SafetyStateView =
  | 'read-only-audit'
  | 'browser-qa-audit'
  | 'safe-local-fixes'
  | 'network-ci-allowed'
  | 'release-action-locked'
  | 'blocked-by-policy';
```

## 12. Gate and stale-decision rules

P0 must visibly support the current facade's fail-closed gate semantics.

- `requestSequence` is authoritative only for a currently pending gate.
- A gate decision must submit the exact current `requestSequence`.
- The UI must never invent, increment, or repair a `requestSequence`.
- The UI must re-read gate state after stale/conflict errors.
- A gate is stale when:
  - `requestSequence` mismatches;
  - gate is no longer pending;
  - another actor already decided;
  - gate reopened with a newer request.
- “Request changes” maps to `reject + reason`.
- The UI must not offer decisions that the facade would reject.
- `approve` and `waive` may require a runtime-backed facade to resume progress; P0 should not imply runtime continuation if mocked.

Locked stale/conflict copy:

- “This decision is stale. Refresh to load the current gate state.”
- “Another decision was recorded first. Showing the current authoritative state.”

## 13. Locked vocabulary

Use these terms consistently in P0:

- QA audit
- QA fix
- Browser QA audit
- Safe local writes
- Safe local fix loop
- Ship readiness
- Ready for handoff
- Future deploy workflow
- View status
- Recover run
- Stale gate
- Audit trail
- Prototype fixture

Avoid these terms unless a real workflow supports them:

- Deployed
- Released
- Published
- Shipped
- Production deploy
- Live release

## 14. Locked UI copy

Use this copy verbatim in P0 where applicable.

### 14.1 Prototype honesty

- “P0 prototype: this demo shows the workflow, evidence, and approvals. Some actions are mocked and do not perform real code changes, browser sessions, CI runs, or deployment.”
- “Sample artifact for prototype review.”
- “Future workflow — not available in P0.”

### 14.2 QA audit vs QA fix

- Mode banner: “Browser QA audit — no code changes.”
- Mode banner: “QA fix — safe local writes approved.”
- CTA: “Run browser QA audit”
- CTA: “Approve safe local fix loop”
- Explainer: “This starts a separate fix run. It can edit local project files and run non-destructive checks only.”

### 14.3 Browser side effects

- “Browser QA can click real UI and may create test data. Use a preview or staging URL unless you intend live changes.”
- “This target looks production-like. We recommend a preview or staging URL before continuing.”

### 14.4 Non-destructive write mode

- “Safe local writes can edit project files and run safe local checks. They cannot push, deploy, force-reset, clean the repo, publish, or read secrets.”
- “Blocked in this mode: push, deploy, publish, force reset, git clean, secret/env dumping.”

### 14.5 Status vs recovery

- “Viewing status never changes run state.”
- “Recovery is a separate action.”
- “Recover run will attempt to attach existing evidence to this run. It will record a recovery event if successful.”

### 14.6 Ship-readiness vs deploy

- “Ship readiness is not deployment. No tag, publish, push, or deploy happens in this workflow.”
- Completion state: “Ready for handoff”

### 14.7 Audit trail

- “Who approved what, when, based on which evidence, and what the automation was allowed to touch.”

## 15. Safety interaction rules

- Read-only is the default.
- Separate audit from mutation everywhere: badges, CTAs, timeline nodes, and modal copy.
- Browser QA audit approval comes before any browser-like evidence is shown as running.
- QA fix requires a second approval after QA audit evidence exists.
- Safe local writes must show blocked actions before approval.
- Status/refresh controls are inspection-only.
- Recovery requires explicit confirmation and an audit-trail entry.
- Waivers for must-fix or accepted-risk items require a reason.
- Release-action remains locked/unavailable in P0.
- Ship-readiness completion must not use “deployed,” “released,” “published,” or “shipped.”

## 16. AuditTrailPanel schema

The audit trail should let a user answer: who approved what, when, based on which evidence, and what the automation was allowed to touch?

P0 audit entries should include:

```ts
interface AuditTrailEntryView {
  entryId: string;
  timestamp: string;
  actor: 'user' | 'persona' | 'system' | 'adapter' | 'policy';
  actorLabel: string;
  eventType: 'phase' | 'artifact' | 'gate-request' | 'gate-decision' | 'safety' | 'recovery' | 'status';
  title: string;
  summary: string;
  linkedArtifactIds: string[];
  gateId?: string;
  requestSequence?: number;
  decision?: 'approve' | 'reject' | 'waive' | 'cancel';
  reason?: string;
  safetyScope?: SafetyPolicyView;
  provenance: PrototypeProvenance;
}
```

## 17. Responsive and accessibility requirements

- Desktop, 1200px+: three-column cockpit.
- Tablet, 768–1199px: timeline becomes top rail; persona/artifact panel docks into tabs/drawer.
- Mobile, <768px: current action first; timeline collapses to stepper; artifacts/decisions render as cards.
- One sticky next-action area in every viewport.
- Do not rely on color alone for status.
- Gate modal must trap focus, return focus after close, prevent double submit, and announce stale/conflict states.
- Timeline should be a semantic ordered stepper.
- Live progress/persona updates should use polite announcements if implemented.

## 18. P0 acceptance checklist

A P0 implementation is acceptable if:

- A non-technical user can identify current phase, active persona, current safety mode, next decision, and next step.
- Artifacts and approvals are as visually prominent as conversation.
- The cockpit does not feel like an IDE, code sandbox, or prompt-only builder.
- Every P0 route renders from fixtures without undefined-state gaps.
- The required fixture scenarios are all represented.
- Safety copy appears near risky CTAs.
- QA audit and QA fix are visibly distinct.
- Browser side-effect warning appears before QA audit approval.
- Safe local writes require separate approval and show blocked actions.
- Ship-readiness cannot be mistaken for deployment.
- Status inspection is clearly non-mutating.
- Recovery is explicit, confirmable, and auditable.
- Gate modal handles stale, conflict, loading, permission blocked, and double-submit states.
- Fixture data includes provenance markers: `contract-backed`, `wrapper-derived`, or `mocked`.
- Ship workflow gate ids match the current contract-backed list in this document.

## 19. Validation commands for this package doc

```bash
rg "^## " docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md
rg "FactoryRunStatusDto|FactoryRunListItemDto|FactoryArtifactDto|FactoryGateInfoDto|FactoryGateDecisionInput" docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md
rg "review-status-clean|tests-passing|version-bump-ready|changelog-ready|ci-green|pr-ready|release-approved|deploy-readiness-confirmed" docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md
rg "Browser QA audit — no code changes|Ship readiness is not deployment|Viewing status never changes run state|requestSequence" docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md
```

## 20. Handoff instructions for a future implementation agent

When implementation is approved, the frontend/design implementation agent should:

1. Read this P0 package first.
2. Read the UX brief second.
3. Read the implementation plan third.
4. Confirm no implementation requires new dependencies without approval.
5. Build from fixtures and view models before connecting runtime APIs.
6. Preserve prototype honesty and locked safety copy.
7. Keep `CLAUDE.md`, `package-lock.json`, generated files, and unrelated code untouched unless explicitly instructed.
