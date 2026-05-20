# Pi Software Factory Web App Implementation Plan

Status: planning artifact for the first web-app prototype. No implementation started.

Companion docs:

- [PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md](PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md)
- [PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md](PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md)

## 1. Purpose

This document translates the web-app UX brief into an implementation-ready plan. It bridges the product experience — a visible, phase-based factory cockpit for common users — with the current run-scoped, event-sourced factory contracts in `lib/factory-core.ts` and `lib/factory.ts`.

The immediate goal is **not** to build a production web app. The immediate goal is to define a safe, coherent P0 prototype plan that can absorb the designer's visual direction and then guide a frontend/design implementation agent without drifting away from the existing factory architecture.

## 2. Default decisions and assumptions

These defaults are chosen so the plan can move forward without blocking on additional product answers.

1. **P0 is a believable mocked prototype.**
   - It proves the cockpit, phase timeline, personas, artifacts, decisions, QA evidence, and safety model.
   - It does not perform real app-building, repo writes, browser automation, deployment, billing, or team permissions.

2. **One workspace, one owner, one approver in P0.**
   - Team roles, approval routing, and delegated permissions are P2.
   - P0 still designs the UI so future multi-approver support can fit.

3. **The web UX is project-scoped; current factory runtime is run-scoped.**
   - Add a web-layer project wrapper over one or more factory runs.
   - Do not pretend the current factory facade already has native project/workspace contracts.

4. **A project can own multiple linked factory runs.**
   - Example: one project may have an intake/planning mock run, a QA audit run, a linked QA fix child run, and a ship-readiness run.

5. **QA audit and QA fix are separate.**
   - QA audit means browser evidence and no code edits.
   - QA fix means explicit non-destructive write approval and should be represented as a linked `qa-fix` run, visually nested under QA.

6. **"Request changes" maps to `reject + reason` initially.**
   - The current gate contract supports `approve`, `reject`, `waive`, and `cancel`.
   - Do not invent a separate persisted decision value until the backend adds it.

7. **Ship-readiness is not deployment.**
   - P0/P1 must use "Ship readiness," "Ready for handoff," and "future deploy workflow" language.
   - No copy should imply tag, publish, push, production deploy, or release execution happened.

8. **Safety defaults are conservative.**
   - Read-only by default.
   - Browser QA requires explicit approval.
   - Local fixes require a second explicit approval.
   - Release actions are locked/unavailable.

9. **Simple language is the default.**
   - Technical details are expandable.
   - Common users should not need code fluency to understand status, artifacts, or approvals.

10. **No new dependencies or stack changes are part of this plan.**
    - Choosing/scaffolding a web framework is a later implementation decision and should be approved separately.

## 3. Non-goals

- No production deployment or release execution.
- No real GitHub/repo write flow in P0.
- No real browser automation in P0; QA evidence can be mocked.
- No billing implementation.
- No team/role authorization implementation.
- No dependency additions without explicit approval.
- No changes to existing generated skills or factory runtime behavior as part of this planning doc.

## 4. Product/runtime model

### 4.1 Conceptual hierarchy

```text
Workspace
  Project
    FactoryRun[]
      Phase[]
      Gate[]
      Artifact[]
      Event[]
```

### 4.2 Concepts

- **Workspace**: account/team boundary, billing, members, safety defaults.
- **Project**: user-facing app idea/build effort. Owns the visible phase journey, project status, artifacts, decisions, and resume state.
- **Factory run**: event-sourced runtime record for a workflow such as review, QA audit, QA fix, or ship readiness.
- **Phase**: a visible step in the project journey.
- **Persona**: role assigned to a phase/action, with a clear authority boundary.
- **Artifact**: durable output that can be read, approved, versioned, exported, or superseded.
- **Gate/decision**: explicit approval/rejection/waiver/cancellation. Stale approvals fail closed through request sequencing.
- **Activity event**: human-readable projection of event-sourced state, not the primary source of truth.

### 4.3 Relationship to current contracts

Current stable inner contracts are run-oriented:

- `FactoryRunRequest`
- `FactoryRunPlan`
- `FactoryEvent`
- `FactoryRunStatusDto`
- `FactoryRunListItemDto`
- `FactoryArtifactSummaryDto`
- `FactoryArtifactDto`
- `FactoryGateInfoDto`
- `FactoryGateDecisionInput`

The web app should add project/workspace wrapper DTOs around these rather than replacing them.

## 5. State model

### 5.1 Project-facing statuses

Use these on dashboards and cockpit headers:

- `draft-idea`
- `planning`
- `design-review`
- `building`
- `reviewing`
- `qa-audit`
- `fix-loop`
- `ship-readiness`
- `ready-for-handoff`
- `paused`
- `blocked`
- `complete`

### 5.2 Run-facing statuses

Align directly with the facade:

- `blocked`
- `running`
- `paused`
- `completed`
- `failed`
- `cancelled`

### 5.3 Pause reasons

Project-level resume UI should normalize pause state into:

- `waiting-for-decision`
- `waiting-for-external-work`
- `waiting-for-recovery`
- `waiting-for-integration`
- `blocked-by-policy`
- `failed-retryable`
- `failed-nonretryable`

Current `FactoryRunStatusDto.pause.kind` supports `gate` and `external-work`. The web wrapper should derive richer user-facing reasons from run status, pending gates, pending external artifacts, risks, and recovery metadata.

### 5.4 Gate states

Align with `FactoryGateStatus`:

- `not-reached`
- `pending`
- `approved`
- `rejected`
- `waived`
- `cancelled`

Add web-only display state:

- `stale` — shown when the gate request sequence has changed or another actor has already decided.

### 5.5 Artifact states

Use web-layer metadata for:

- `draft`
- `produced`
- `approved`
- `superseded`
- `evidence`
- `accepted-risk`
- `needs-review`

The current core artifact kind should remain coarse; web metadata can hold display title, subtype, version, and status.

## 6. Milestone scope

### 6.1 P0 — mocked cockpit prototype

P0 proves the product wedge with stable mocked data.

#### P0 screens/routes

- `/` — landing/product positioning.
- `/signup` — account and workspace onboarding mock.
- `/app` — workspace dashboard with resume and decision-needed cards.
- `/app/projects/new` — new project wizard that produces mocked Idea Brief and MVP Scope.
- `/app/projects/:projectId` — main factory cockpit.
- `/app/projects/:projectId/artifacts/:artifactId` — artifact detail.
- `/app/projects/:projectId/qa` — QA/browser evidence view.

#### P0 components

- `ProjectStatusHeader`
- `FactoryTimeline`
- `ConversationPhaseWorkspace`
- `PersonaPanel`
- `PersonaCard`
- `ArtifactCard`
- `GateDecisionModal`
- `SafetyBadge`
- `QAResultPanel`
- `BuildSummaryPanel`
- `ShipReadinessChecklist`
- `RecoveryCard`
- `AuditTrailPanel`

#### P0 mocked states

Seed at least these project scenarios:

1. **New project / intake**
   - No artifacts yet.
   - Product Coach active.
   - Next action: answer intake question.

2. **Planning approval needed**
   - Idea Brief and MVP Scope produced.
   - Gate pending: approve MVP scope.
   - Safety: read-only.

3. **Build approval needed**
   - Build Plan produced.
   - Gate pending: allow safe local fixes/build.
   - Safety: non-destructive write explanation.

4. **QA audit failed**
   - Browser QA evidence exists.
   - No code changes made.
   - Gate pending: approve fix loop.

5. **Ship readiness complete**
   - Checklist mostly green.
   - Persistent copy: no deploy/publish/push happened.
   - Next action: export handoff or start future deploy workflow.

### 6.2 P1 — structured prototype with lightweight state

P1 adds broader navigation and local/persisted UI state, still without full production runtime.

- `/app/projects` project list/filter.
- `/app/projects/:projectId/phases/:phaseId` focused phase route.
- `/app/projects/:projectId/artifacts` artifact library.
- `/app/projects/:projectId/decisions` pending and historical decisions.
- `/app/projects/:projectId/ship-readiness` readiness checklist route.
- `/app/projects/:projectId/settings/safety` project safety settings.
- Local mock persistence or fixture-backed state.
- Polling-style status refresh simulation.
- More complete artifact version/comparison UX.

### 6.3 P2 — production integration preparation

P2 prepares for real authenticated app behavior.

- Team and approver model.
- Workspace settings.
- Billing/usage placeholder to real flow.
- Cross-project factory activity.
- Export/handoff package.
- Real facade-backed reads for run status, artifacts, and gates.
- SSE/WebSocket event stream for live updates.
- Repo, browser target, CI, and deployment integrations.
- Future release-action workflow, if separately approved.

## 7. Mock data contracts

Use TypeScript-like shapes for prototype fixtures. These are web-layer DTOs, not proposed changes to the pure factory core.

### 7.1 WorkspaceSummary

```ts
interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  ownerName: string;
  safetyDefaults: SafetyPolicyView;
  projectCount: number;
  pendingDecisionCount: number;
}
```

### 7.2 ProjectSummary

```ts
interface ProjectSummary {
  projectId: string;
  workspaceId: string;
  name: string;
  oneLineGoal: string;
  projectStatus: ProjectStatusView;
  activeRunId?: string;
  linkedRunIds: string[];
  currentPhaseId?: string;
  currentPhaseTitle?: string;
  activePersona?: PersonaView;
  nextAction: NextActionView;
  progress: { completed: number; total: number };
  artifactCount: number;
  pendingDecisionCount: number;
  updatedAt: string;
}
```

### 7.3 ProjectCockpitDto

```ts
interface ProjectCockpitDto {
  project: ProjectSummary;
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

### 7.4 ProjectPhaseView

```ts
interface ProjectPhaseView {
  phaseId: string;
  title: string;
  status: PhaseStateView;
  personaId: string;
  objective: string;
  expectedArtifactTitles: string[];
  artifactIds: string[];
  gateIds: string[];
  safetyState: SafetyStateView;
  linkedRunId?: string;
  nestedLoop?: 'qa-fix' | 'regression-qa';
}
```

### 7.5 PersonaView

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

### 7.6 DecisionQueueItem

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
}
```

### 7.7 ArtifactSummaryView and ArtifactDetailView

```ts
interface ArtifactSummaryView {
  artifactId: string;
  runId: string;
  displayTitle: string;
  kind: ArtifactKind;
  subtype?: string;
  status: ArtifactStateView;
  version: number;
  summary: string;
  phaseId?: string;
  personaId?: string;
  linkedGateIds: string[];
  createdAt: string;
  updatedAt?: string;
}

interface ArtifactDetailView extends ArtifactSummaryView {
  contentType: 'markdown' | 'image' | 'json' | 'trace' | 'diff' | 'external-url';
  content?: string;
  uri?: string;
  evidenceRefs?: EvidenceRefView[];
  versionHistory?: ArtifactSummaryView[];
}
```

### 7.8 QaEvidenceBundle

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
}
```

### 7.9 ShipReadinessView

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
}
```

### 7.10 Safety views

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

## 8. DTO and API bridge

### 8.1 Mapping to existing facade DTOs

| Web need | Existing contract | Bridge approach |
|---|---|---|
| Cockpit run status | `FactoryRunStatusDto` | Use directly inside project wrapper. |
| Dashboard run cards | `FactoryRunListItemDto` | Wrap with project name, active persona, next action. |
| Timeline phases | `FactoryRunPlan.phases`, `completedPhaseIds`, `currentPhase` | Project layer can combine phases across linked runs. |
| Artifact cards | `FactoryArtifactSummaryDto` | Add display metadata in web layer. |
| Artifact detail | `FactoryArtifactDto` | Text artifacts direct; image/trace evidence needs URL/binary support later. |
| Gate modal | `FactoryGateInfoDto` | Use `requestSequence`, `allowedDecisions`, status, recommendation. |
| Gate decision | `FactoryGateDecisionInput` | Submit `approve`, `reject`, `waive`, or `cancel`; map request-changes to reject+reason. |
| Safety badges | `PolicySpec`, `RiskFinding` | Summarize policy/risk into plain-language safety state. |
| Activity/audit | `FactoryEventEnvelope` and events | Project activity is a projection, not source of truth. |

### 8.2 Web wrapper DTOs needed later

The first production-facing API should add web wrapper DTOs rather than changing the pure core prematurely:

- `workspaceId`
- `projectId`
- project display name
- project-facing status
- active run id
- linked run ids
- next action
- active persona
- supporting personas
- resume summary
- artifact display title/subtype/status/version
- artifact content type and URL/binary evidence support
- gate supporting artifact ids
- gate safety impact
- gate "what happens next"
- actor/timestamp display for decision and audit views

### 8.3 Future web API shape

Project endpoints wrap run endpoints:

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:projectId`
- `POST /api/projects/:projectId/runs`
- `GET /api/projects/:projectId/runs`
- `GET /api/projects/:projectId/resume`
- `GET /api/projects/:projectId/activity`
- `GET/PUT /api/projects/:projectId/safety-policy`
- `GET /api/projects/:projectId/decision-queue`

Run endpoints expose factory facade behavior:

- `GET /api/runs/:runId`
- `POST /api/runs/:runId/continue`
- `GET /api/runs/:runId/events` or an SSE/WebSocket stream
- `GET /api/runs/:runId/artifacts`
- `GET /api/runs/:runId/artifacts/:artifactId`
- `GET /api/runs/:runId/gates`
- `POST /api/runs/:runId/gates/:gateId/decisions`

### 8.4 Contract rules

- Status/read endpoints must be inspection-only.
- Recovery endpoints must be explicit and mutating.
- Gate decisions must include current `requestSequence`.
- Public web API should not offer decisions that the facade will reject.
- Binary evidence support should not be forced through `FactoryArtifactDto.content` long term.
- Project activity should be a projection; event logs remain authoritative.

## 9. Component backlog and dependencies

### 9.1 P0 component order

1. Mock data fixtures and projection helpers.
2. `ProjectStatusHeader`.
3. `FactoryTimeline`.
4. `ConversationPhaseWorkspace`.
5. `PersonaPanel` / `PersonaCard`.
6. `ArtifactCard` and artifact detail renderer.
7. `GateDecisionModal`.
8. `SafetyBadge` and safety explanation popover/drawer.
9. `QAResultPanel`.
10. `ShipReadinessChecklist`.
11. `RecoveryCard`.
12. `AuditTrailPanel`.

### 9.2 Component acceptance rules

- Components should receive explicit view models, not reach into raw fixtures directly.
- Components should work with mocked data that resembles future DTOs.
- Gate modal must handle stale/conflict/loading/permission states.
- Safety badge must be visible near any risky CTA.
- Artifact components should show plain-language titles before technical kind/path.
- Timeline should visually support nested QA fix loop.

## 10. Safety UX rules

These rules are mandatory for prototype copy and interactions.

1. **Read-only is the default.**
   - Copy: “The factory can inspect and produce artifacts. It cannot edit project files in this mode.”

2. **Browser QA audit does not edit code.**
   - Copy: “Browser QA can click real UI and may create test data. Use a preview or staging URL unless you intend live changes.”

3. **Fix loop requires a second approval.**
   - Copy: “Apply local fixes edits files in this project and runs non-destructive checks only.”

4. **Non-destructive write mode has blocked actions.**
   - Copy: “It cannot push, deploy, force-reset, clean the repo, publish, or read secrets.”

5. **Ship readiness is not deployment.**
   - Copy: “Ship readiness is not deployment. No tag, publish, push, or deploy happens in this workflow.”

6. **Status views are inspection-only.**
   - Copy: “Viewing status never changes run state. Recovery is a separate action.”

7. **Recovery is explicit and auditable.**
   - Copy: “Recover run will attempt to attach existing evidence to this run. It will record a recovery event if successful.”

8. **Quarantined/untrusted recovery data is excluded.**
   - Copy: “Extra events were detected after the last trusted checkpoint and are excluded until reviewed.”

9. **Waivers require care.**
   - Waiving a must-fix item or accepted risk should require a reason and stronger confirmation.

10. **Release actions are locked.**
    - `release-action` should appear only as a future locked state unless separately implemented and approved.

## 11. Resume behavior

### 11.1 Resume banner requirements

Every resumed project should show:

- current phase;
- active persona;
- last completed artifact;
- pending decision or blocker;
- safety mode;
- one recommended next action;
- what happens after that action.

### 11.2 Resume source priority

Derive resume state in this order:

1. Pending gate.
2. Blocking risk/policy.
3. Failed retryable state.
4. Pending external work.
5. Active long-running phase.
6. Latest produced artifact needing review.
7. Next unstarted phase.

### 11.3 Resume examples

- “Product Coach produced MVP Scope. Please approve or request changes.”
- “QA Lead found 3 issues in browser audit. No code was changed. Approve a safe local fix loop?”
- “Release Coordinator completed readiness checks. This project is ready for handoff; no deploy was run.”
- “Recovery needed: review evidence exists but is not attached to the run. View status or recover explicitly.”

## 12. Acceptance checklist

The P0 prototype is successful if:

- A non-technical user can explain the current phase in plain English.
- The user can identify the active persona and what that persona is doing.
- The user can tell what the automation can and cannot touch.
- The next required decision is visible without reading a raw chat transcript.
- Artifacts and approvals are as prominent as conversation.
- The user can open an artifact and understand why it matters.
- QA audit is clearly separate from QA fix.
- Browser QA target/environment and side-effect risks are visible.
- Safe local fixes require a separate approval.
- Ship readiness cannot be mistaken for deployment.
- Status/refresh UI does not imply mutation.
- Recovery UI is explicit and auditable.
- Gate decisions handle stale/conflict/loading states.
- Mock data remains shape-compatible with existing factory facade DTOs.
- The cockpit feels different from an IDE, code sandbox, or prompt-only builder.

## 13. Validation plan for this planning artifact

Before implementation begins:

1. Review headings for completeness:

```bash
rg "^## " docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md
```

2. Verify bridge terms are present:

```bash
rg "FactoryRunStatusDto|FactoryRunListItemDto|FactoryArtifactSummaryDto|FactoryGateInfoDto|FactoryGateDecisionInput" docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md
```

3. Verify safety guardrails are present:

```bash
rg "QA audit|QA fix|Ship readiness is not deployment|View status|requestSequence|non-destructive" docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md
```

4. After designer returns, update this plan only where visual/component direction changes route/component priority or view-model needs.

## 14. Risks and sequencing constraints

### 14.1 Risks

- **Project/run mismatch**: the UX is project-scoped while the current factory is run-scoped.
  - Mitigation: keep a project wrapper DTO and preserve run ids visibly in technical detail.

- **Overpromising build/deploy**: the full journey includes build and final handoff, but current workflows are CLI/Pi-oriented and ship-readiness-only.
  - Mitigation: P0 is mocked; release/deploy copy is locked down.

- **QA safety confusion**: users may not distinguish browser audit from code-fixing.
  - Mitigation: separate modes, separate CTAs, separate approval gate.

- **Artifact taxonomy gap**: core artifact kinds are coarse compared with UX names.
  - Mitigation: web metadata supplies display title, subtype, status, version.

- **Binary evidence gap**: screenshots/traces do not fit cleanly into text-only artifact detail.
  - Mitigation: model content type and URI in web view models.

- **Team approval gap**: current contracts do not model multi-user permissions.
  - Mitigation: P0 assumes one owner/approver and defers team roles to P2.

- **Designer output may change component priority.**
  - Mitigation: keep this document as implementation planning, not visual specification; update after design feedback.

### 14.2 Sequencing constraints

Do these before implementation:

1. Incorporate designer feedback into the UX brief and this plan.
2. Freeze P0 route list and component list.
3. Freeze mock data contracts.
4. Freeze safety copy for QA audit, QA fix, and ship-readiness.
5. Decide whether prototype code lives inside this repo and, if so, which web stack to use.
6. Ask before adding dependencies, scaffolding a web app, or changing package manifests.

## 15. Immediate next actions

1. Wait for designer feedback.
2. Update `PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md` with chosen visual/product direction.
3. Update `PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md` where designer feedback affects P0 routes, components, fixtures, locked copy, or view-model needs.
4. Update this implementation plan only where designer feedback affects scope, routes, components, or mock DTOs.
5. If approved, start a P0 prototype planning pass:
   - select stack/location;
   - define fixture files;
   - define route/component ownership;
   - identify tests/smoke checks.

Until then, do not start UI implementation.
