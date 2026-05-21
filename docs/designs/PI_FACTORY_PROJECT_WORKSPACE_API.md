# Pi Factory Project / Workspace API

Status: additive read-only wrapper design, with a low-risk projection module implemented in `lib/factory-project.ts`.

## Goal
Expose workspace and project cockpit view models around the existing run-scoped factory facade so Universe AI can power workspace dashboards, resume heroes, decision inboxes, simple/detailed cockpit layers, and the three-bay factory metaphor without changing existing run DTOs.

## Existing API Conventions
- `lib/factory.ts` is the current stable public factory facade.
  - Start / resume / decide operations stay run-scoped.
  - Read DTOs are `FactoryRunStatusDto`, `FactoryRunListItemDto`, `FactoryArtifactDto`, `FactoryGateInfoDto`.
- `lib/factory-core.ts` stays pure.
  - No filesystem, shell, browser, network, Pi SDK, or web dependencies.
- `docs/designs/PI_FACTORY_PUBLIC_API_REVIEW.md` already recommends a wrapper instead of mutating run DTOs.
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md` and the Universe AI wireframes use this hierarchy:

```text
Workspace
  Project
    FactoryRun[]
```

- `readFactoryArtifact()` remains text-first.
  - Richer artifact display should stay wrapper-first until the additive artifact-content contract lands.
- Current stable workflows are still runtime-oriented:
  - `review`
  - `qa`
  - `qa-fix`
  - `ship`

## Proposed Contract

### 1. Module boundary
Add a separate wrapper module:

```text
lib/factory-project.ts
```

This module should:
- depend on the existing `FactoryFacade` read surface;
- accept an injected workspace/project catalog;
- reconstruct project-level views from linked run status;
- remain additive and read-only in the first slice.

This module should not:
- change `lib/factory.ts` DTOs;
- persist new event types;
- import web framework types;
- move any IO into `lib/factory-core.ts`.

### 2. Source records
Because the repo does not yet have a durable project/workspace store, the wrapper should consume lightweight metadata records supplied by the caller.

```ts
interface FactoryWorkspaceRecord {
  workspaceId: string;
  name: string;
  ownerName?: string;
  safetyDefaults?: Partial<PolicySpec>;
}

interface FactoryProjectRunLink {
  runId: string;
  workflowId?: string;
  relationship?: 'primary' | 'supporting' | 'qa-audit' | 'qa-fix' | 'ship-readiness';
  stage?: FactoryProjectStage;
  bayId?: FactoryProjectBayId;
  policy?: Partial<PolicySpec>;
}

interface FactoryProjectRecord {
  projectId: string;
  workspaceId: string;
  name: string;
  oneLineGoal: string;
  primaryRunId?: string;
  linkedRuns: readonly FactoryProjectRunLink[];
  experienceMode?: 'easy' | 'hands-on';
  cockpitLayer?: 'simple' | 'detailed';
}
```

Why this shape:
- `runId` keeps the existing run facade authoritative.
- optional `stage` / `bayId` lets project metadata override heuristics later without touching run DTOs.
- optional `policy` lets the wrapper produce honest safety summaries for write-capable runs like `qa-fix`, since `FactoryRunStatusDto` does not currently expose persisted policy.

### 3. Read operations
First-slice operations should be read-only and projection-oriented.

#### `listFactoryWorkspaces()`
Returns workspace dashboard cards.

```ts
interface FactoryWorkspaceSummaryDto {
  workspaceId: string;
  name: string;
  ownerName?: string;
  projectCount: number;
  pendingDecisionCount: number;
  resumeProjectId?: string;
  safetyDefaults: FactoryProjectSafetyViewDto;
}
```

Wireframe alignment:
- workspace dashboard;
- “Good morning” / production floor summary;
- decision-needed counts;
- resume hero source selection.

#### `listFactoryProjects({ workspaceId? })`
Returns workspace project cards / rows.

```ts
interface FactoryProjectSummaryDto {
  projectId: string;
  workspaceId: string;
  name: string;
  oneLineGoal: string;
  experienceMode: 'easy' | 'hands-on';
  cockpitLayer: 'simple' | 'detailed';
  projectStatus: FactoryProjectStage;
  activeRunId?: string;
  activeRunStatus?: FactoryPublicRunStatus;
  linkedRunIds: readonly string[];
  currentPhaseId?: string;
  currentPhaseTitle?: string;
  activePersona?: FactoryProjectPersonaSummaryDto;
  nextAction: FactoryProjectNextActionDto;
  progress: { completed: number; total: number };      // bay progress
  activeRunProgress?: { completed: number; total: number };
  artifactCount: number;
  pendingDecisionCount: number;
  updatedAt?: string;
  bays: readonly FactoryProjectBayViewDto[];
  safety: FactoryProjectSafetyViewDto;
  resumeSummary: FactoryProjectResumeSummaryDto;
}
```

Wireframe alignment:
- project cards / project rows;
- resume hero content;
- “what’s happening / who’s working / what needs me / what happens next”;
- easy vs hands-on mode badge;
- three-bay overview on the dashboard surface.

#### `readFactoryProjectSummary(projectId)`
Direct summary lookup for a single project.

Use cases:
- dashboard resume hero;
- mobile resume card;
- cross-link from decision inbox back to the owning project.

#### `readFactoryProjectCockpit(projectId)`
Returns the detailed cockpit view model for one project.

```ts
interface FactoryProjectCockpitDto {
  project: FactoryProjectSummaryDto;
  activeRun?: FactoryProjectRunLinkDto;
  runs: readonly FactoryProjectRunLinkDto[];
  bays: readonly FactoryProjectBayViewDto[];
  phases: readonly FactoryProjectPhaseViewDto[];
  personas: readonly FactoryProjectPersonaViewDto[];
  pendingDecision?: FactoryProjectDecisionQueueItemDto;
  decisionQueue: readonly FactoryProjectDecisionQueueItemDto[];
  featuredArtifact?: FactoryProjectArtifactViewDto;
  artifacts: readonly FactoryProjectArtifactViewDto[];
  safety: FactoryProjectSafetyViewDto;
  resumeSummary: FactoryProjectResumeSummaryDto;
  simpleOverview: FactoryProjectSimpleOverviewDto;
}
```

Wireframe alignment:
- simple/detailed cockpit layers;
- right-now card / calm layer;
- detailed cockpit rails;
- persona panel;
- artifact prominence;
- decision-stage surfaces;
- bay map above the current run.

#### `listFactoryProjectDecisionQueue({ workspaceId?, projectId? })`
Returns the decision inbox projection.

```ts
interface FactoryProjectDecisionQueueItemDto {
  decisionId: string; // `${runId}:${gateId}:${requestSequence}`
  workspaceId: string;
  projectId: string;
  projectName: string;
  runId: string;
  gateId: string;
  requestSequence: number;
  title: string;
  plainLanguageQuestion: string;
  recommendation?: 'approve' | 'reject' | 'waive' | 'cancel';
  allowedDecisions: readonly ('approve' | 'reject' | 'waive' | 'cancel')[];
  phaseId: string;
  activePersona?: FactoryProjectPersonaSummaryDto;
  supportingArtifactIds: readonly string[];
  safetyImpact: FactoryProjectSafetyViewDto;
  whatHappensNext: string;
  gate: FactoryGateInfoDto;
}
```

Wireframe alignment:
- workspace decision banner;
- decision inbox;
- in-context / full-screen decision stage;
- safety explanation next to risky approvals.

### 4. Supporting DTOs

#### Three-bay projection

```ts
type FactoryProjectBayId = 'drawing-room' | 'workshop' | 'showroom';
type FactoryProjectBayStatus = 'not-started' | 'active' | 'complete' | 'locked';

interface FactoryProjectBayViewDto {
  bayId: FactoryProjectBayId;
  title: string;
  status: FactoryProjectBayStatus;
  summary: string;
  runIds: readonly string[];
}
```

Default mapping for current workflows:
- `review` → `workshop`
- `qa` / `qa-fix` / `ship` → `showroom`
- planning/design/build workflows can override later via `FactoryProjectRunLink.stage` / `bayId`

This keeps the wireframe’s three-bay abstraction honest without pretending today’s run facade already has a baked-in nine-phase product model.

#### Safety summary

```ts
interface FactoryProjectSafetyViewDto {
  state:
    | 'read-only-audit'
    | 'browser-qa-audit'
    | 'safe-local-fixes'
    | 'network-ci-allowed'
    | 'release-action-locked'
    | 'blocked-by-policy';
  commandSafetyProfile: PolicySpec['commandSafetyProfile'];
  allowWrites: boolean;
  allowBrowser: boolean;
  allowNetwork: boolean;
  plainLanguageSummary: string;
  blockedExamples: readonly string[];
}
```

This is intentionally wrapper-first. It translates policy/runtime safety into Universe-friendly copy for:
- safety strips;
- approval cards;
- artifact / QA surfaces;
- ship-readiness disclaimers.

#### Simple layer summary

```ts
interface FactoryProjectSimpleOverviewDto {
  headline: string;
  currentFocus: string;
  calmState: string;
  recommendedAction: string;
}
```

This powers:
- Easy Mode day-to-day surface;
- simple cockpit layer;
- mobile summary card.

### 5. Error cases
The wrapper should fail closed for contract mismatches rather than silently normalizing them.

Recommended errors:
- `Factory project '<id>' not found`
- linked run workflow mismatch between metadata and facade status
- unknown workflow id not registered in wrapper options
- pending gate missing `requestSequence`
- underlying `readFactoryRunStatus()` failures bubble through unchanged

This matches the existing factory stance that inspection APIs should remain trustworthy and should not invent recovery behavior.

## Compatibility / Versioning
- Entirely additive.
- `lib/factory.ts` remains unchanged.
- Existing run DTOs stay authoritative and are embedded under wrapper DTOs instead of being reshaped.
- No core/event schema changes.
- No package or dependency changes.
- No web stack commitment.
- No mutation endpoints in the first slice.

Important compatibility note:
- accurate safety summaries for `qa-fix` and future write-capable flows are best when the project catalog stores the run’s approved policy in `FactoryProjectRunLink.policy`.
- the low-risk implementation also applies conservative workflow-based inference for current built-in workflows, but policy metadata remains the more future-proof contract.

## Implementation Plan
1. Add `lib/factory-project.ts` as a read-only wrapper over `FactoryFacade.readFactoryRunStatus()` plus an injected catalog.
2. Reconstruct workflow-phase projections from registered workflow specs, filtered by each run’s persisted mode.
3. Derive workspace/project summaries, decision queues, three-bay status, persona summaries, artifact views, and safety summaries without touching run DTOs.
4. Keep project creation, project persistence, run linking writes, and HTTP transport out of this slice.
5. Later, if the web app is approved, wrap these DTOs in route handlers or SDK endpoints instead of coupling web concerns into core factory modules.

## Validation
- Add focused unit tests in `test/factory-project.test.ts` for:
  - decision-first dashboard projection;
  - resume hero selection;
  - three-bay status derivation;
  - safety summary derivation for review / QA / QA-fix / ship;
  - ready-for-handoff ship projection;
  - failure on pending gate missing `requestSequence`.
- Keep existing factory facade/core tests untouched.
- If a future HTTP/API layer is added, validate transport shape separately there.

## Risks / Open Questions
- There is still no durable project/workspace store in-repo. The first slice must stay catalog-injected, not persistence-owning.
- The current stable workflows do not yet cover all nine user-facing product phases from the wireframes. Planning/design/build bays beyond `review` / `qa` / `ship` still need either future workflows or explicit metadata overrides.
- `FactoryRunStatusDto` does not expose persisted policy, so project safety views depend on `FactoryProjectRunLink.policy` or workflow-based inference.
- Artifact views remain summary-first until the additive artifact-content descriptor API is integrated.
- Team/approver authorization is out of scope in this slice; today’s wrapper assumes one workspace owner / approver model from the P0 plan.

## Low-risk implementation included
Implemented in `lib/factory-project.ts`:
- `createFactoryProjectFacade(...)`
- `listFactoryWorkspaces()`
- `listFactoryProjects(...)`
- `readFactoryProjectSummary(...)`
- `readFactoryProjectCockpit(...)`
- `listFactoryProjectDecisionQueue(...)`

The implemented slice is read-only, wrapper-only, and preserves all existing factory facade DTOs.
