# Universe AI Software Factory — Web Cockpit P0 Component Model

Status: lane B P0 component model (doc-only). No production scaffold or dependency changes.

Companion:
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md`

## 1. Purpose

Define the P0 component system for a common-user-friendly Universe AI cockpit that supports:
- Easy Mode and Hands-on Mode,
- dashboard + idea wizard,
- 3-bay factory abstraction,
- simplified overview + detailed cockpit,
- gate approvals,
- QA evidence,
- ship-readiness,
- mobile-responsive behavior.

## 2. Data and projection layers (locked)

Components should only consume **view models**, not raw event logs.

1. **Factory-shaped layer** (contract-like)
   - run status, gates, artifacts, policy data.
2. **Project wrapper layer**
   - project/workspace concepts, mode, next action.
3. **Route/component view-model layer**
   - screen-ready fields with plain language and provenance.

Provenance is required in P0 fixture-backed views:
- `contract-backed`
- `wrapper-derived`
- `mocked`

## 3. Top-level composition

```text
AppShell
  ├─ WorkspaceNav
  ├─ Route: Dashboard
  ├─ Route: NewProjectWizard
  └─ Route: ProjectExperience
       ├─ ModePill (persistent)
       ├─ EasyModeSurface | HandsOnSurface
       └─ Decision/Gate overlays and drawers
```

## 4. Component package

## 4.1 Required P0 package (from prototype contract)

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

## 4.2 Added mode/layer components (wireframe reconciliation)

- `ModePill`
- `ModePickerScreen`
- `BayMap3`
- `BayCard`
- `SimpleOverviewPanel`
- `RightNowCard`
- `UniverseHandledFeed`
- `DetailsHandle`

## 5. Route-level component model

## 5.1 Dashboard (`/app`)

```text
DashboardScreen
  ├─ DecisionNeededBanner
  ├─ ResumeBanner (hero)
  ├─ ProjectListOrFloor
  │   └─ ProjectCard[]
  └─ QuickActions
```

## 5.2 New project (`/app/projects/new`)

```text
NewProjectWizardScreen
  ├─ IdeaQuestionFlow
  ├─ IdeaBriefPreview
  └─ ModePickerScreen
       ├─ ModeOptionCard (Easy)
       └─ ModeOptionCard (Hands-on)
```

## 5.3 Project route (`/app/projects/:projectId`)

```text
ProjectExperienceScreen
  ├─ ProjectStatusHeader
  ├─ ModePill
  ├─ if EasyMode:
  │    ├─ RightNowCard
  │    ├─ SimpleProgressStrip
  │    ├─ UniverseHandledFeed
  │    └─ DetailsHandle (enter Hands-on depth)
  └─ if HandsOnMode:
       ├─ BayMap3 (Shape/Build/Ship)
       ├─ SimpleOverviewPanel (inside active bay)
       └─ DetailedCockpit
            ├─ FactoryTimeline
            ├─ ConversationPhaseWorkspace
            ├─ PersonaPanel
            ├─ ArtifactCard (featured/latest)
            ├─ BuildSummaryPanel (when relevant)
            └─ DecisionQueue/Gate trigger
```

## 5.4 QA route (`/app/projects/:projectId/qa`)

```text
QaEvidenceScreen
  ├─ ModeBanner (audit vs fix)
  ├─ TargetEnvironmentCard
  ├─ QAResultPanel
  │   ├─ ScenarioMatrix
  │   ├─ ScreenshotGrid
  │   └─ TraceSummary
  └─ FixLoopDecisionCard (separate approval)
```

## 5.5 Artifact route (`/app/projects/:projectId/artifacts/:artifactId`)

```text
ArtifactDetailScreen
  ├─ ArtifactDetailView
  ├─ LinkedDecisionsPanel
  ├─ EvidenceRefsPanel
  └─ VersionHistoryPanel
```

## 6. Core component contracts (behavior)

## 6.1 `ModePill`

**Responsibility**: show and toggle current project mode.

**Inputs**:
- `mode: 'easy' | 'hands-on'`
- `canSwitchToEasy: boolean`
- `pendingDecisionCount: number`

**Rules**:
- Easy → Hands-on: immediate.
- Hands-on → Easy: confirm once if pending decision exists.

## 6.2 `BayMap3`

**Responsibility**: top-level project progress map in Hands-on.

**Inputs**:
- `bays: [{ id, label, roomName, status, crew, outputs }]`
- `activeBayId`

**Rules**:
- Locked bay visible but non-enterable.
- Active bay visually dominant.

## 6.3 `SimpleOverviewPanel`

**Responsibility**: low-noise summary inside active bay.

**Must surface**:
- right-now activity,
- latest output,
- decision-needed state,
- one next action,
- “open detailed cockpit” affordance.

## 6.4 `FactoryTimeline`

**Responsibility**: detailed phase progression (9-phase line).

**Needs**:
- nested loop representation for QA → Fix.
- status labels beyond color.

## 6.5 `GateDecisionModal`

**Responsibility**: focused approval surface for risky actions.

**Inputs (minimum)**:
- decision question,
- recommendation,
- safety impact,
- supporting artifacts,
- `requestSequence`, allowed decisions.

**Must handle**:
- stale sequence,
- conflict/already decided,
- permission blocked,
- loading and submit lock.

## 6.6 `QAResultPanel`

**Responsibility**: browser QA evidence with audit/fix distinction.

**Modes**:
- `audit` → “no code changes”.
- `fix` → “safe local writes approved”.

## 6.7 `ShipReadinessChecklist`

**Responsibility**: readiness evidence, never deployment claim.

**Hard UI copy requirement**:
- “Ship readiness is not deployment. No tag, publish, push, or deploy happens in this workflow.”

## 6.8 `SafetyBadge`

**Responsibility**: compact state + expanded explanation.

**Supported states**:
- `read-only-audit`
- `browser-qa-audit`
- `safe-local-fixes`
- `network-ci-allowed`
- `release-action-locked`
- `blocked-by-policy`

## 7. Interaction contracts

1. **Decision correctness over speed**
   - gate decisions must submit current `requestSequence` only.
2. **Audit vs mutation split**
   - status view and evidence browsing are non-mutating.
3. **QA split**
   - QA audit and QA fix are separate states/runs.
4. **Ship terminology guard**
   - completion label is “Ready for handoff.”

## 8. Mobile behavior model

At `<768px`:
- `FactoryTimeline` collapses to compact stepper.
- Right-rail content reflows under main content as cards.
- Gate actions move to sticky bottom bar.
- Next-action CTA stays persistent.

## 9. Accessibility model (component-level)

- `GateDecisionModal`: focus trap, escape close, return focus, stale/conflict announcement.
- `FactoryTimeline`: semantic ordered steps + text state labels.
- Status and safety badges: icon + text, not color alone.
- Live activity updates: polite announcements where applicable.
- Keyboard support for mode toggle, bay cards, artifact cards, and decision actions.

## 10. P0 implementation guardrails implied by this model

- No direct event parsing inside visual components.
- No dependency additions required by component model.
- No production runtime claims from fixture-only screens.
- No release/deploy action exposure in P0 component states.
