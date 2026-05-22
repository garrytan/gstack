# Universe AI Software Factory — Web Cockpit P0 Screen Spec

Status: lane B P0 screen spec (doc-only). No production web scaffold, no dependency changes.

Grounded in:
- `docs/designs/external/universe-ai-wireframes-round-1/software-factory/project/Universe AI - Wireframes round 1.html` (+ imported files)
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_UX_BRIEF.md`
- `docs/designs/PI_SOFTWARE_FACTORY_WEB_APP_P0_PROTOTYPE_PACKAGE.md`
- `docs/designs/PI_SOFTWARE_FACTORY_DESIGN_BRIEF_RECONCILIATION.md`
- `docs/designs/PI_SOFTWARE_FACTORY_P0_PRODUCT_ACCEPTANCE.md`

## 1. P0 product shape (locked)

Universe AI Software Factory P0 should feel like:
- **an AI product team you can see**,
- with clear steps, evidence, and approvals,
- in language a common user understands.

It should **not** feel like:
- an IDE,
- a prompt-only app generator,
- or a hidden black box.

## 2. Mode + layer model (P0)

P0 uses a two-mode, two-depth project experience:

1. **Easy Mode (default)**
   - Calm daily surface.
   - Universe handles routine reversible choices.
   - User is interrupted only for meaningful decisions.

2. **Hands-on Mode**
   - User can inspect process details.
   - Shows **3-bay factory map** first, then bay overview, then detailed cockpit.

And within Hands-on Mode:
- **Simple overview layer** (default inside bay)
- **Detailed cockpit layer** (one click deeper)

## 3. P0 route/state map

| Route/state | P0 surface | Primary question answered |
|---|---|---|
| `/` | Landing | “What is Universe AI Software Factory and why trust it?” |
| `/signup` | Onboarding | “How much detail do I want?” |
| `/app` | Dashboard | “What needs me now, and what should I resume?” |
| `/app/projects/new` | Idea wizard + mode picker | “What am I building, and how hands-on do I want to be?” |
| `/app/projects/:projectId` (Easy) | Easy project home | “What is Universe doing right now?” |
| `/app/projects/:projectId` (Hands-on map) | 3-bay map | “Where is my project in Shape/Build/Ship?” |
| `/app/projects/:projectId` (Hands-on bay simple) | Simplified bay overview | “What happened, what’s next, anything needed from me?” |
| `/app/projects/:projectId` (Hands-on cockpit) | Detailed cockpit | “Which phase, persona, artifact, gate, and safety scope are active?” |
| Gate state (modal/split) | Decision surface | “What am I approving, what can Universe touch, what happens next?” |
| `/app/projects/:projectId/qa` | QA evidence | “What was tested, what failed, and what proof exists?” |
| Ship-readiness state | Readiness + handoff | “Are we ready for handoff (not deploy)?” |
| `/app/projects/:projectId/artifacts/:artifactId` | Artifact detail | “What is this artifact and why does it matter?” |

## 4. Screen-level specs

## 4.1 Landing (`/`)

**Goal**: Position Universe AI as guided software factory, not magic prompt box.

**Required content**:
- Product name: **Universe AI Software Factory**.
- Promise line allowed: “Build anything in the universe with Universe AI.”
- Trust framing: visible phases, personas, artifacts, approvals, safety.
- Visual preview of cockpit/factory flow.

**Primary CTA**: Start project.

## 4.2 Dashboard (`/app`)

**Canonical P0 take**: Hybrid of wireframe Dash A + Dash B.

**Must include**:
- **Decision-needed banner** (top priority).
- **Resume hero card** (“pick up where you left off”).
- Project cards/rows with:
  - current phase/status,
  - active persona,
  - next action,
  - safety state.

**Copy style**: plain status labels (“Planning”, “Fix loop”, “Ready for handoff”).

## 4.3 New project wizard + mode picker (`/app/projects/new`)

### Idea wizard
- No blank chat start.
- Guided intake questions.
- Live-growing Idea Brief preview.

### Mode picker (shown once at project start)
- Easy Mode vs Hands-on Mode explained in common-user language.
- “You can switch anytime” statement.
- Easy recommended for most users.

## 4.4 Easy Mode project home (`/app/projects/:projectId`)

**Intent**: calm, single-focus daily surface.

**Core blocks**:
1. Right-now hero card (what Universe is doing now).
2. Compressed progress strip.
3. “Anything for me?” status.
4. “Universe handled this” feed with reversible actions.
5. Persistent top-bar mode pill.

**Behavior**:
- Easy → Hands-on always allowed.
- Hands-on → Easy requires confirmation and does not auto-approve pending decision.

## 4.5 Hands-on Mode: 3-bay factory map (`/app/projects/:projectId` state)

**Intent**: give a simple mental model above phase-level detail.

**Bays**:
- **Shape it** (Drawing Room)
- **Build it** (Workshop)
- **Ship it** (Showroom)

**Rules**:
- Bays unlock in order.
- Current bay visually dominant.
- Future bay visible but clearly locked.
- Each bay shows crew + expected outputs.

## 4.6 Hands-on bay simple overview (`/app/projects/:projectId` state)

**Intent**: first stop inside bay before detailed cockpit.

**Must answer quickly**:
- what’s happening now,
- what just finished,
- whether user input is needed,
- what happens next.

**Must include**:
- latest artifact preview,
- next action card,
- handle/button to open detailed cockpit.

## 4.7 Detailed cockpit (`/app/projects/:projectId` state)

**Canonical P0 baseline**: variation A (classic 3-column) for clarity and lowest risk.

**Layout**:
- Left: timeline (9 phases, nested QA→Fix loop visible).
- Center: phase-room conversation + action cards.
- Right: persona panel + artifacts + pending decision.

**Interaction priority**:
1. active phase,
2. pending decision,
3. artifact/evidence,
4. conversation context.

## 4.8 Gate / decision surface

**Canonical P0 baseline**: centered high-friction modal for capability-changing approvals.

**Alternative supported**: in-context split panel for lower-friction review.

**Every gate must show**:
- plain-language decision,
- why it matters,
- what Universe will do,
- what Universe cannot do,
- supporting artifacts/evidence,
- safety impact badges.

**Must support states**:
- loading,
- stale gate,
- already decided/conflict,
- permission blocked,
- double-submit prevention.

## 4.9 QA evidence (`/app/projects/:projectId/qa`)

**Canonical P0 baseline**: post-run evidence matrix (QAa), with optional replay timeline style cues.

**Must include**:
- Mode banner: **Browser QA audit — no code changes**.
- Target environment card.
- Scenario pass/fail matrix.
- Screenshot evidence.
- Trace summary.
- Separate CTA: approve safe local fix loop.

**Critical separation**:
- QA audit and QA fix are different runs/states.

## 4.10 Ship-readiness state

**Canonical P0 baseline**: checklist-first readiness view (ShipA), with bundle-preview cues from ShipB.

**Must include**:
- persistent disclaimer: **Ship readiness is not deployment**.
- readiness checklist grouped by quality/product/QA/release/handoff.
- accepted risks visibility.
- clear completion language: **Ready for handoff**.

**Never say**: deployed/released/published/shipped.

## 4.11 Artifact detail (`/app/projects/:projectId/artifacts/:artifactId`)

**Must include**:
- human-readable title,
- summary and “why it matters,”
- source phase/persona,
- linked gate/evidence,
- provenance (`contract-backed`, `wrapper-derived`, `mocked`).

## 5. Cross-screen UX rules

1. **Artifacts + decisions are as visible as chat.**
2. **Safety state appears near risky actions.**
3. **One primary next action at a time.**
4. **Resume without rereading transcript.**
5. **Status view is non-mutating; recovery is explicit.**
6. **Ship-readiness never implies deploy.**

## 5.1 Visual skin direction for P0

P0 builds **Direction 04 — Soft Modern Studio** first, from
`docs/designs/external/universe-ai-four-directions/software-factory/project/Universe AI - Four Directions.html`.
The skin is intentionally calm and extensible: cream background, sage status
accent, ink text, rounded white cards, soft shadows, and a quiet dot texture.

Skin modularity is a requirement, but not a runtime feature in the static P0
prototype. The implementation seam is `body[data-skin="soft-modern-studio"]`:
semantic component markup stays stable, and visual systems live in replaceable
skin token/override blocks. Future skins can target different audiences without
reshaping the dashboard, Easy Mode, 3-bay map, gate, QA, artifact, or mobile
contracts.

## 6. Mobile implications (P0)

P0 mobile is responsive-first (not separate app), with three required states proven:

1. **Mobile cockpit stack**
   - phase header + compressed timeline,
   - stacked cards,
   - sticky next-action bar.

2. **Mobile gate decision**
   - full-screen decision card,
   - explicit can/can’t safety list,
   - sticky approve/reject actions.

3. **Mobile dashboard resume**
   - resume hero first,
   - decision chips visible,
   - quick open to project.

## 7. P0 acceptance checks (screen scope)

P0 screen spec is satisfied if a non-technical user can, on any project state, say:
- what Universe is doing now,
- whether Universe needs them,
- what Universe can/can’t touch,
- what artifact/evidence just changed,
- what decision is next,
- and why “ready for handoff” is not deployment.

## 8. Out of scope for this spec

- Production web app scaffolding.
- Runtime integration implementation.
- Dependency/package changes.
- Roadmap consolidation edits.
