# Pi Software Factory Parallel Execution Plan

Status: operating plan for running multiple Pi/Claude agent instances in isolated worktrees against the same repo.

## Goal

Increase delivery velocity on Pi Software Factory by splitting independent work across multiple agent instances while keeping the platform coherent through a shared mission plan, stable contracts, and serial integration.

This document is the instruction set for:

- the orchestrator/integration agent;
- each parallel worker agent;
- the validation/review agent;
- the user coordinating multiple Pi windows.

## Current baseline

Repository:

```text
/home/claude/workspaces/garrytan/gstack
```

Branch:

```text
pi-software-factory-core
```

Recent factory checkpoints:

```text
335ff293 Harden factory UX and web planning docs
3e6dcec2 Harden plan skill floor tests
6ec1ee54 Document factory artifact content strategy
8fb77f8d Document factory safe command guard design
64d467ba Add factory safe command classifier
```

Known protected unrelated local noise in the main checkout:

```text
CLAUDE.md
package-lock.json
```

Do not edit, stage, or commit those files unless the user explicitly asks.

## Core strategy

Use one main checkout as the **integration lane** and one git worktree per worker lane.

```text
main checkout: orchestrator/integration only
worktree A: design/product reconciliation
worktree B: web cockpit P0 spec/prototype
worktree C: project/workspace API
worktree D: artifact descriptor/content API
worktree E: safe-command runtime wrapper
worktree F: durable QA capture
worktree G: Pi distribution/package path
worktree H: validation/review
```

Parallel workers may write in their own worktree. Only the orchestrator merges/cherry-picks into the main branch, one lane at a time.

## Non-negotiable rules

1. **No parallel writes in the same worktree.**
2. **No worker edits the main checkout.**
3. **No worker touches `CLAUDE.md` or `package-lock.json`.**
4. **No dependency additions or package manifest changes without explicit approval.**
5. **No production web app scaffold until design + stack/location are approved.**
6. **No `/factory-qa-fix` exposure until runtime command guard attestation exists.**
7. **No release/deploy/publish automation in this phase.**
8. **`lib/factory-core.ts` remains pure:** no filesystem, shell, browser, network, Pi SDK, or web UI actions.
9. **Project/web concepts wrap run-scoped factory DTOs.** Do not mutate run DTOs to carry web-only concerns unless an interface contract is approved.
10. **Roadmap consolidation is serial.** Workers may write lane-specific docs; orchestrator owns final roadmap edits.

## Shared planning model

Every lane must align to these shared source-of-truth docs:

```text
docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md
docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md
docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md
docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md
docs/designs/PI_FACTORY_PUBLIC_API_REVIEW.md
docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md
docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md
```

If the user provides an updated design brief, the design lane must reconcile it first and produce a P0 acceptance contract before web implementation begins.

## Worktree setup

From the repo parent:

```bash
cd /home/claude/workspaces/garrytan/gstack
git status --short --branch
BASE=$(git rev-parse HEAD)
cd /home/claude/workspaces/garrytan

git worktree add gstack-wt-design        -b sf/design-brief-reconcile     "$BASE"
git worktree add gstack-wt-web-p0        -b sf/web-p0-cockpit             "$BASE"
git worktree add gstack-wt-project-api   -b sf/project-wrapper-api        "$BASE"
git worktree add gstack-wt-artifacts     -b sf/artifact-descriptor-api    "$BASE"
git worktree add gstack-wt-safe-guard    -b sf/safe-command-runtime       "$BASE"
git worktree add gstack-wt-qa-capture    -b sf/qa-durable-capture         "$BASE"
git worktree add gstack-wt-distribution  -b sf/pi-distribution-path       "$BASE"
git worktree add gstack-wt-validation    -b sf/validation-review          "$BASE"
```

If worktrees already exist, reuse them after verifying they are clean:

```bash
git -C /home/claude/workspaces/garrytan/gstack-wt-design status --short --branch
```

## Orchestrator instructions

Use main checkout:

```text
/home/claude/workspaces/garrytan/gstack
```

Prompt:

```text
You are the orchestrator for the Pi Software Factory parallel execution push.

Repo: /home/claude/workspaces/garrytan/gstack
Branch: pi-software-factory-core

Do not implement feature work directly unless needed for integration.
Do not touch CLAUDE.md or package-lock.json.
Do not push.

Coordinate these worktrees:
- ../gstack-wt-design
- ../gstack-wt-web-p0
- ../gstack-wt-project-api
- ../gstack-wt-artifacts
- ../gstack-wt-safe-guard
- ../gstack-wt-qa-capture
- ../gstack-wt-distribution
- ../gstack-wt-validation

For each worker:
1. inspect branch status and commits;
2. read its handoff;
3. review relevant diff;
4. run targeted tests;
5. merge/cherry-pick serially only if coherent;
6. resolve conflicts conservatively;
7. update consolidated roadmap/mission notes after integration.

Preserve ACD layering:
- lib/factory-core.ts stays pure;
- runtime/filesystem/shell/browser/Pi SDK actions stay at adapter/facade edges.

Stop and report if integration requires dependency changes, broad refactors, protected-file edits, or design choices that need user approval.
```

Orchestrator checklist for every branch:

```text
[ ] git status clean except intentional files
[ ] no protected files touched
[ ] no package/dependency drift unless approved
[ ] lane handoff exists
[ ] targeted tests pass or failures documented
[ ] no contradiction with shared docs
[ ] no stale syntax/copy introduced
[ ] commit is coherent
[ ] merge/cherry-pick serially
[ ] run integration tests
[ ] update consolidated plan if needed
```

## Worker universal instructions

Every worker starts with this shared prompt prefix:

```text
You are a worker in the Pi Software Factory parallel execution mission.

Work only in your assigned worktree. Do not edit the main checkout.
Do not touch CLAUDE.md or package-lock.json.
Do not push.
Do not add dependencies or edit package manifests unless explicitly approved.
Do not expose /factory-qa-fix.
Do not scaffold a production web app unless explicitly approved.

Before editing:
1. run git status --short --branch;
2. read docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md;
3. read the docs relevant to your lane;
4. inspect relevant source/tests.

Preserve ACD layering:
- lib/factory-core.ts stays pure data/calculation;
- action-backed logic belongs in runtime/adapters/facades/extensions;
- avoid unrelated refactors.

At completion:
1. run targeted tests/checks;
2. commit your work locally;
3. write a handoff summary:
   - Branch
   - Worktree
   - Commit(s)
   - Files changed
   - What changed
   - Tests run
   - Known risks
   - Integration notes
```

## Lane A — Design/product reconciliation

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-design
```

Primary output:

```text
docs/designs/PI_SOFTWARE_FACTORY_DESIGN_BRIEF_RECONCILIATION.md
docs/designs/PI_SOFTWARE_FACTORY_P0_PRODUCT_ACCEPTANCE.md
```

Prompt:

```text
You are the design/product reconciliation agent.

Goal:
Reconcile the user-provided design brief with existing Pi Software Factory web-app planning docs. Produce no application code.

Read:
- docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md
- docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md
- docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md
- docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md
- docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md
- user-provided design brief

Deliver:
1. docs/designs/PI_SOFTWARE_FACTORY_DESIGN_BRIEF_RECONCILIATION.md
2. docs/designs/PI_SOFTWARE_FACTORY_P0_PRODUCT_ACCEPTANCE.md

Include:
- target users and non-developer language;
- cockpit mental model;
- P0 screens and user journeys;
- artifact/evidence UX;
- approval/gate UX;
- persona/safety UX;
- out-of-scope list;
- unresolved design decisions.

Do not scaffold a web app. Do not add dependencies. Commit your work.
```

## Lane B — Web cockpit P0 spec/prototype

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-web-p0
```

Primary output:

```text
docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md
docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_COMPONENT_MODEL.md
```

Optional only with explicit approval:

```text
docs/prototypes/factory-cockpit-p0/index.html
docs/prototypes/factory-cockpit-p0/styles.css
```

Prompt:

```text
You are the web cockpit P0 product/UI agent.

Goal:
Produce a no-dependency P0 screen/component spec for the Factory Cockpit. Do not scaffold a production web app.

Read:
- docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md
- docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md
- docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md
- docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md
- design reconciliation docs if available

Deliver:
- docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md
- docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_COMPONENT_MODEL.md

Rules:
- no package.json changes;
- no dependencies;
- no production web app scaffold;
- common-user-friendly language;
- projects, runs, approvals, artifacts, personas, and safety are first-class.

Commit your work.
```

## Lane C — Project/workspace wrapper API

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-project-api
```

Primary output:

```text
docs/designs/PI_FACTORY_PROJECT_WORKSPACE_API.md
```

Optional low-risk code:

```text
lib/factory-project.ts
test/factory-project.test.ts
```

Prompt:

```text
You are the project/workspace API agent.

Goal:
Design and, if low-risk, implement an additive project/workspace wrapper around the existing run-scoped factory facade.

Read:
- lib/factory.ts
- lib/factory-core.ts
- docs/designs/PI_FACTORY_PUBLIC_API_REVIEW.md
- docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md
- docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md

Deliver:
1. docs/designs/PI_FACTORY_PROJECT_WORKSPACE_API.md
2. Optional low-risk code:
   - lib/factory-project.ts
   - test/factory-project.test.ts

Rules:
- do not break existing facade DTOs;
- do not add web dependencies;
- project concepts wrap runs;
- wrapper DTOs may include project summary, decision queue, artifact views, and safety summary;
- run targeted tests if code is added.

Commit your work.
```

## Lane D — Artifact descriptor/content API

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-artifacts
```

Primary output:

```text
lib/factory-artifact-content.ts
test/factory-artifact-content.test.ts
```

Potential facade additions only if additive:

```text
listFactoryArtifactContent(...)
```

Prompt:

```text
You are the artifact descriptor API agent.

Goal:
Implement the first additive artifact-content descriptor slice from docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md.

Read:
- docs/designs/PI_FACTORY_ARTIFACT_CONTENT_STRATEGY.md
- lib/factory.ts
- lib/factory-artifact-store.ts
- lib/factory-core.ts
- test/factory-artifact-store.test.ts
- test/factory-facade.test.ts

Preferred first slice:
- pure DTO/helper layer for text/binary/external-uri/bundle descriptors;
- preserve readFactoryArtifact() as text-only;
- raw event path/uri remains untrusted metadata;
- focused tests.

Rules:
- keep lib/factory-core.ts pure;
- no dependencies;
- no full browser screenshot storage unless explicitly needed;
- never expose untrusted event URI/path as safe.

Run targeted tests and commit your work.
```

## Lane E — Safe-command runtime wrapper

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-safe-guard
```

Primary output options:

```text
lib/factory-guarded-runtime.ts
test/factory-guarded-runtime.test.ts
```

or a design if runtime interface changes are risky.

Prompt:

```text
You are the safe-command runtime wrapper agent.

Goal:
Implement the next safe-command guard slice after the pure classifier. Do not expose /factory-qa-fix.

Read:
- lib/factory-command-guard.ts
- test/factory-command-guard.test.ts
- docs/designs/PI_FACTORY_SAFE_COMMAND_GUARD_DESIGN.md
- lib/factory-capabilities.ts
- lib/factory-runner.ts
- lib/pi-runtime-adapter.ts
- .pi/extensions/pi-gstack/index.ts

Deliver:
- guarded runtime/command execution wrapper or design if runtime interface changes are risky;
- tests proving denied commands are not executed;
- tests proving safe-command-guard capability is advertised only when wrapper is active;
- no /factory-qa-fix exposure.

Rules:
- classifier stays pure;
- runtime wrapper lives at action boundary;
- fail closed on classifier/parser errors;
- tests use harmless fixture commands only.

Run targeted tests and commit your work.
```

## Lane F — Durable QA capture

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-qa-capture
```

Primary output options:

```text
lib/factory-qa-capture.ts
test/factory-qa-capture.test.ts
```

Potential Pi extension updates if low-risk:

```text
.pi/extensions/pi-gstack/index.ts
test/pi-extension.test.ts
```

Prompt:

```text
You are the durable QA capture agent.

Goal:
Bring QA audit capture closer to the structured review capture model.

Read:
- lib/factory-review-capture.ts
- test/factory-review-capture.test.ts
- lib/factory-qa-workflow.ts
- test/factory-qa-workflow.test.ts
- .pi/extensions/pi-gstack/index.ts
- test/pi-extension.test.ts
- docs/designs/PI_FACTORY_REVIEW_WORKFLOW.md
- docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md

Deliver:
- design or implementation for durable QA log correlation/capture;
- prefer pure parser/calculation tests first;
- Pi recovery behavior only if low-risk.

Rules:
- QA audit remains no-edit;
- QA fix remains hidden;
- status remains inspect-only;
- no dependencies.

Run targeted tests and commit your work.
```

## Lane G — Pi distribution/package path

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-distribution
```

Primary output:

```text
docs/designs/PI_FACTORY_DISTRIBUTION_PACKAGE_PATH.md
```

Prompt:

```text
You are the Pi distribution/package path agent.

Goal:
Design how the gstack Pi extension and generated skills should ship for non-dev users.

Read:
- package.json
- scripts/gen-skill-docs.ts
- test/gen-skill-docs.test.ts
- .pi/extensions/pi-gstack/index.ts
- docs/designs/PI_SOFTWARE_FACTORY_ROADMAP.md
- docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_IMPLEMENTATION_PLAN.md

Deliver:
- docs/designs/PI_FACTORY_DISTRIBUTION_PACKAGE_PATH.md

Cover:
- generated .pi/skills packaging;
- extension versioning;
- migration/upgrade path;
- install/update UX;
- local dev vs packaged distribution;
- private/internal vs public.

Rules:
- do not publish;
- do not change package manifests unless explicitly required and approved;
- do not touch package-lock.json.

Commit your work.
```

## Lane H — Validation/review

Worktree:

```text
/home/claude/workspaces/garrytan/gstack-wt-validation
```

Prompt:

```text
You are the validation/review agent.

Goal:
Provide independent review and validation for worker branches before integration.

Start read-only:
- review docs/API decisions for consistency;
- review implementation branches when orchestrator points you to them;
- identify conflicts, safety gaps, missing tests.

Do not modify files unless orchestrator explicitly assigns a validation-fix branch.

Focus:
- ACD layering;
- lib/factory-core.ts purity;
- no dependency/package manifest drift;
- no QA-fix exposure before runtime guard;
- no web scaffold before approval;
- tests cover behavior, not just shape;
- docs do not overclaim production/runtime enforcement.
```

## Integration order

Recommended serial merge order:

1. Design/product reconciliation.
2. Distribution/package path docs.
3. Artifact descriptor/content API.
4. Project/workspace wrapper API.
5. Safe-command runtime wrapper.
6. Durable QA capture.
7. Web cockpit P0 spec/prototype.
8. Final roadmap consolidation.

Rationale:

- design establishes user/product constraints;
- distribution docs are mostly independent;
- artifact descriptors inform project wrapper/web views;
- safe-command wrapper and QA capture may conflict in Pi/runtime files, so merge them carefully;
- roadmap should be updated once at the end.

## Test budget and commands

Workers should run targeted tests only.

Suggested by lane:

```bash
# project/facade
bun test test/factory-facade.test.ts test/factory-core.test.ts

# artifact descriptor
bun test test/factory-artifact-store.test.ts test/factory-facade.test.ts

# safe command guard/runtime
bun test test/factory-command-guard.test.ts test/factory-qa-workflow.test.ts test/factory-core.test.ts

# QA capture / Pi extension
bun test test/factory-qa-workflow.test.ts test/pi-extension.test.ts test/factory-review-capture.test.ts

# generated skills/distribution
bun test test/gen-skill-docs.test.ts test/host-config.test.ts
```

Orchestrator final focused suite after integrations:

```bash
bun test \
  test/factory-command-guard.test.ts \
  test/factory-facade.test.ts \
  test/factory-runner.test.ts \
  test/factory-qa-workflow.test.ts \
  test/factory-ship-workflow.test.ts \
  test/factory-event-store.test.ts \
  test/pi-extension.test.ts
```

## Handoff template

Every worker final response should use this exact structure:

```text
Branch:
Worktree:
Base commit:
Commit(s):

Files changed:
- ...

What changed:
- ...

Tests run:
- command — result

Known risks / unresolved decisions:
- ...

Integration notes:
- likely conflicts:
- docs to update after merge:
- follow-up work:
```

## Alignment mechanisms

### 1. Shared source docs

Workers read the same docs first. They do not invent conflicting product/API contracts.

### 2. Lane-local docs

Each lane creates or updates a lane-specific doc. The orchestrator later consolidates into roadmap.

### 3. Stable contracts before UI

Project wrapper, artifact descriptors, and safety guard contracts should stabilize before production web implementation.

### 4. Serial roadmap edits

Only orchestrator updates `PI_SOFTWARE_FACTORY_ROADMAP.md` during integration.

### 5. Review before integration

Validation lane reviews each branch for contradictions before it lands.

### 6. No premature expansion

Workers must stop when they hit:

- dependency change;
- protected file change;
- web stack choice;
- `/factory-qa-fix` exposure;
- production/deploy/release behavior;
- broad architecture change outside lane scope.

## Success metrics for this parallel push

A successful push should produce:

```text
[ ] design brief reconciled into P0 acceptance criteria
[ ] project/workspace API contract ready or first slice implemented
[ ] artifact descriptor API first slice implemented or ready
[ ] safe-command runtime wrapper designed/started without exposing qa-fix
[ ] durable QA capture parser/design/first slice completed
[ ] Pi distribution plan documented
[ ] all branches reviewed and integrated serially
[ ] final roadmap updated once
[ ] protected files untouched
[ ] targeted factory test suite green
```

Target production-completion movement:

```text
before: ~33% overall production complete
after:  ~45–55% if Wave 1 integrates cleanly
```

## Recommended launch sequence

Start immediately:

1. Design/product reconciliation.
2. Project/workspace API.
3. Artifact descriptor/content API.
4. Safe-command runtime wrapper.
5. Durable QA capture.
6. Distribution/package path.

Start after design first pass:

7. Web cockpit P0 spec/prototype.

Keep active throughout:

8. Validation/review.
