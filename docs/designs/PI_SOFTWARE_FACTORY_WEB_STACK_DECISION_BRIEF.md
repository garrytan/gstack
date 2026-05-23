# Universe AI Software Factory — Web Stack Decision Brief

Status: approval-gated planning brief. This document does **not** approve a production web app, dependency changes, package-manifest edits, or lockfile changes.

Companion docs:

- [PI_SOFTWARE_FACTORY_ROADMAP.md](PI_SOFTWARE_FACTORY_ROADMAP.md)
- [PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md](PI_SOFTWARE_FACTORY_PRODUCTION_READINESS_MAP.md)
- [PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md](PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md)
- [PI_SOFTWARE_FACTORY_COCKPIT_BETA1_CONTRACT.md](PI_SOFTWARE_FACTORY_COCKPIT_BETA1_CONTRACT.md)

## 1. Purpose

Record the current decision boundary for the Universe AI Software Factory web cockpit.

This brief answers one question only:

> Should the project move beyond the existing no-dependency static prototype, and if so, what is the default implementation direction once explicit approval is given?

This brief is intentionally conservative. It preserves the current posture:

- no production web app yet;
- no dependency additions now;
- no package changes now;
- no deploy/release scope;
- no hosted auth/workspace implementation;
- no change to `/factory-qa-fix` exposure.

## 2. Current approved state

Today, the approved web surface is still documentation-first:

- screen and component contracts in `docs/designs/`;
- a no-dependency static prototype in `docs/prototypes/factory-cockpit-p0/`;
- pure cockpit view-model DTOs in `lib/factory-cockpit-view.ts`;
- project/workspace wrapper DTOs in `lib/factory-project.ts`;
- run-scoped factory facade DTOs in `lib/factory.ts`.

What is **not** approved yet:

- a production cockpit app scaffold;
- any new frontend package;
- framework selection as an implementation commitment;
- package-manifest or lockfile edits;
- hosted deployment/platform work.

## 3. Options considered

### 3.1 Option A — stay docs-only and static-prototype-only

Description:

- Keep the current design docs, view-model contracts, and static HTML/CSS prototype as the only web-facing deliverables.
- Continue refining UX/specs without introducing a runtime package.

Pros:

- zero dependency risk;
- zero package-manifest churn;
- keeps the project honest about current production readiness;
- lets product/design settle before implementation.

Cons:

- no live cockpit runtime to validate data flow;
- no real browser-state, routing, or interaction layer;
- readiness remains capped for the common-user web surface.

Best when:

- approval for package/dependency changes is not available yet;
- design iteration is still higher value than scaffolding.

### 3.2 Option B — future local-first TypeScript package (recommended default after approval)

Description:

- Add **one dedicated local-first TypeScript package** for the cockpit once approval is explicitly granted.
- Likely stack: **Vite + React + Bun**.
- Start from fixture-backed and local-catalog-backed reads, not hosted multi-tenant assumptions.
- Consume the existing cockpit/project DTOs instead of inventing a frontend-only model.

Default contract for this option:

- treat `lib/factory-cockpit-view.ts` as the screen-ready view-model source for the first UI slice;
- keep `lib/factory-project.ts`, `lib/factory-artifact-content.ts`, and `lib/factory.ts` as upstream contract sources;
- stay local-first until a hosted auth/workspace design is separately approved;
- if a dev server is introduced, use a local port in **8200-8299**;
- keep ship-readiness language non-deploying and QA audit/fix clearly separated.

Why this is the default recommendation:

- It matches the existing local-only Alpha/Beta boundary.
- It can render the already-landed cockpit view-model DTOs directly.
- It gives a practical path to validate the cockpit without prematurely taking on hosted auth, deployment, or release complexity.
- Vite + React is a straightforward fit for a view-model-driven cockpit, while Bun stays aligned with the repo's existing runtime/tooling direction.

Constraints:

- exact package location is still approval-gated;
- exact dependency list is still approval-gated;
- no scaffold should land until the checklist in §5 is approved.

### 3.3 Option C — server-rendered or minimal HTML shell

Description:

- Build a very small server-rendered or mostly-static HTML surface with minimal client-side behavior.

Pros:

- lower frontend-framework surface area;
- simpler bootstrap story than a richer SPA;
- could preserve the current documentation/prototype feel.

Cons:

- less natural fit for cockpit-style state transitions, evidence drawers, and decision surfaces;
- likely duplicates interaction logic that the view-model layer already expects a richer renderer to consume;
- still requires a package/runtime decision, so it does not avoid the approval step.

Best when:

- the goal is a highly constrained read-mostly local surface rather than a full cockpit.

### 3.4 Option D — hosted Next.js or Remix app (explicitly deferred)

Description:

- Build the cockpit as a hosted app using a framework such as Next.js or Remix.

Why deferred:

- hosted auth/workspace boundaries are not approved yet;
- deployment/release scope is intentionally out of bounds;
- the current readiness plan still treats hosted mode as a future design problem, not an implementation default;
- this path adds infra, tenancy, and browser-evidence isolation decisions too early.

Decision status:

- **deferred until after local-first scope, auth/workspace design, and deployment scope are separately approved**.

## 4. Recommendation

Recommendation now:

1. **Stay on Option A today** — docs and static prototype remain the only approved web surface.
2. **If approval is granted to move forward, default to Option B** — a future local-first TypeScript package, likely Vite + React + Bun, consuming the existing cockpit/project DTOs.
3. Keep Options C and D as alternatives, but do not treat either as the default.

This is intentionally an approval-gated recommendation, not an implementation authorization.

## 5. Explicit approval checklist before any web package is created

All items below must be answered explicitly before adding a production-style cockpit package, dependencies, or manifests.

### 5.1 Package location

Approve the exact repo location for the future package.

Questions to answer:

- What is the exact directory path?
- Is it a dedicated app-style package or a package-plus-shell arrangement?
- Does the location avoid mixing generated assets, docs prototypes, and runtime code?

### 5.2 Dependency set

Approve the exact dependency list before any scaffold lands.

Questions to answer:

- Are Vite, React, and related tooling approved?
- Are test/build/lint dependencies for that package approved?
- Which package manifests change, if any?
- Are lockfile changes allowed in the same change set?

Default until approved:

- no new dependencies;
- no manifest edits;
- no lockfile edits.

### 5.3 Local dev port

If a local dev server is introduced, approve a port in **8200-8299**.

Questions to answer:

- Which exact default port should the cockpit use?
- Does any existing local tool in this repo already need that port?
- Will documentation and QA examples use the same port consistently?

### 5.4 DTO source of truth

Approve the source contracts the UI must consume.

Default recommendation:

- `lib/factory-cockpit-view.ts` for screen-ready cockpit DTOs;
- `lib/factory-project.ts` for project/workspace wrapper DTOs;
- `lib/factory-artifact-content.ts` for artifact content/provenance descriptors;
- `lib/factory.ts` for stable run-scoped facade DTOs beneath the wrapper layer.

Questions to answer:

- Is the first UI slice required to consume these existing DTOs directly?
- Are any additive UI-only projection seams needed, and where do they live?
- What remains contract-backed vs wrapper-derived vs mocked?

### 5.5 Persistence model

Approve the first persistence boundary.

Questions to answer:

- Fixture-only first, or fixture + local project catalog reads?
- Does the first slice read durable local project/workspace state?
- Are any new stores introduced, or must the UI only consume existing catalog/facade data?

Default recommendation:

- start fixture-backed, then local catalog-backed;
- no hosted persistence design in the first approved slice.

### 5.6 Auth and workspace boundary

Approve whether the first slice stays local-only.

Questions to answer:

- Is the first approved UI explicitly local-only?
- Are workspace IDs for local separation only, not tenant security?
- Is hosted mode deferred until a separate auth/tenant review lands?

Default recommendation:

- local-only first;
- hosted auth/workspace work remains deferred.

### 5.7 Browser QA scope

Approve how the UI represents browser QA.

Questions to answer:

- Does the first slice show QA audit evidence only?
- Can it present a separate CTA for a future fix loop without exposing live `/factory-qa-fix`?
- How are screenshots, traces, and provenance labels rendered safely?

Default recommendation:

- show QA audit evidence;
- keep QA fix as separate, approval-gated, and still hidden in live runtime terms.

### 5.8 No deploy/release scope

Approve the explicit non-goal boundary.

Must remain true unless separately re-approved:

- no deploy flow;
- no publish flow;
- no release automation;
- no language implying tag, publish, push, or deployment happened.

## 6. What this brief does not approve

This document does **not** approve:

- creating a new web package now;
- adding Vite, React, or any other dependency now;
- editing `package.json`, lockfiles, or workspace manifests now;
- introducing a hosted app;
- introducing auth or tenant isolation code;
- changing browser QA into write-capable QA fix;
- deploy, publish, release, or hosting work.

## 7. Trigger for the next step

The next implementation step should happen only after a reviewer/owner explicitly approves the checklist in §5.

Until then, the correct default is:

- keep the cockpit docs and static prototype improving;
- keep production-readiness language honest;
- keep the web stack/location decision documented, not implied.
