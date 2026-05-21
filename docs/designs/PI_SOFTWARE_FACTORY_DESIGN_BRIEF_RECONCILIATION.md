# Pi Software Factory Design Brief Reconciliation

Status: lane A reconciliation between the current Pi factory planning docs and the external Universe AI wireframes. No product code or roadmap edits included.

## 1. Purpose

This document reconciles the current Pi Software Factory planning set with the external **Universe AI Software Factory** wireframes so downstream product, design, and prototype work can move from one coherent brief.

Audience:

- product/design owners deciding the P0 web experience;
- lane B and later UI/spec lanes;
- the orchestrator consolidating roadmap updates later.

## 2. Reconciliation outcome in one page

### Keep from the current Pi planning docs

The current planning docs are still directionally correct on the core wedge:

- common users need a visible process, not a black-box prompt builder;
- artifacts, evidence, approvals, and safety must be first-class;
- QA audit and QA fix remain separate;
- ship readiness is not deployment;
- the product layer is project-scoped even though the current facade is run-scoped;
- the cockpit remains the detailed operating surface when a user wants to look under the hood.

### Change or clarify based on the Universe wireframes

The wireframes add a stronger product framing and a more consumer-friendly information architecture:

1. **User-facing naming shifts to Universe AI Software Factory.**
   - Public P0 copy should use **Universe AI Software Factory** rather than **Pi Software Factory**.
   - Internal repo and architecture docs can keep Pi naming until the orchestrator consolidates.

2. **The product promise becomes more common-user-friendly.**
   - Use the Universe framing: **“build anything in the universe with Universe AI.”**
   - Pair it with trust language so the promise does not read as magic or overclaim runtime behavior.

3. **The detailed cockpit is no longer the only mental model.**
   - The wireframes introduce a layered experience:
     - dashboard;
     - idea-shaping wizard;
     - **Easy Mode vs Hands-on Mode** choice;
     - **3-bay factory map** in Hands-on Mode;
     - **simplified overview** inside a bay;
     - **detailed cockpit** one click deeper.

4. **The 9-phase model should remain real, but sit below a 3-bay abstraction.**
   - The wireframes make the top-level project story easier to understand through three rooms/bays.
   - The existing 9 phases still matter for detailed views, audit trail, and later runtime mapping.

5. **Simple view becomes the default day-to-day surface for common users.**
   - The wireframes argue that most users should not land inside a dense multi-panel cockpit every time.
   - The detailed cockpit stays important, but as the deeper layer.

## 3. Naming and framing

### 3.1 Product name

For user-facing P0 product/UI work, the preferred public name is:

- **Universe AI Software Factory**

Recommended supporting line:

- **Build anything in the universe with Universe AI.**

Recommended trust-restoring subtext:

- Universe is an AI product team with visible steps, receipts, approvals, and evidence.
- It is not “prompt in, mystery app out.”

### 3.2 Naming guidance by surface

| Surface | Recommendation |
|---|---|
| Landing / signup / dashboard / project UI | Use **Universe AI** and **Universe AI Software Factory** |
| User-facing helper copy | Say **Universe** instead of **Pi** |
| Repo-internal architecture/planning references | May continue to say **Pi Software Factory** until consolidated |
| Safety/runtime copy | Be explicit and operational, not magical |

### 3.3 Framing guardrail

“Build anything in the universe” should be treated as a **brand promise / aspiration line**, not a literal runtime capability claim. Runtime surfaces must still say exactly what Universe can and cannot do in the current mode.

## 4. Target users

The current target users still hold, but the wireframes clarify mode fit.

### 4.1 Primary audiences

1. **Founder with an idea and no engineering team**
   - best fit for **Easy Mode**;
   - needs visible progress, calm reassurance, and plain-language decisions.

2. **Operator / small business owner**
   - best fit for **Easy Mode** by default;
   - wants outcomes, safety, and handoff confidence without learning engineering workflows.

3. **Product-minded non-technical teammate**
   - may start in Easy Mode, then dip into Hands-on for reviews and approvals;
   - needs durable artifacts and decision history.

4. **Lightly technical builder / technical reviewer**
   - best fit for **Hands-on Mode**;
   - wants access to phases, personas, artifacts, and approvals without turning the product into a code IDE.

### 4.2 Audience implication

The product should feel **common-user-friendly first** and **detail-rich second**.
That means:

- defaulting to simple language and calm summaries;
- exposing detailed panels, rails, and traces on demand;
- never requiring code fluency to understand status, safety, or next steps.

## 5. Recommended experience architecture

## 5.1 The layered model

The biggest reconciliation change is the view hierarchy.

### Recommended top-level project layering

1. **Workspace dashboard**
   - decision-needed and resume-first.

2. **New project wizard**
   - structured intake, never a blank chat box.

3. **Mode picker**
   - first project-level choice after idea capture.

4. **Project home is mode-aware**
   - **Easy Mode:** calm “right now” view with minimal interruptions.
   - **Hands-on Mode:** 3-bay map first, then simplified bay overview.

5. **Detailed cockpit**
   - one click beneath the simplified bay view;
   - still the place for full timeline, persona handoffs, artifacts, evidence, and approvals.

This is the key change versus the current UX brief, which centers the cockpit earlier and more often.

## 5.2 Easy Mode vs Hands-on Mode

### Easy Mode

Easy Mode means:

- Universe drives routine decisions;
- the user sees only must-decide moments;
- day-to-day UI is calm, sparse, and reassuring;
- the product surfaces “what Universe handled for you” with undo/change affordances;
- future rooms/phases/persona chatter stay collapsed unless the user opts in.

Easy Mode is the default fit for founders and operators.

### Hands-on Mode

Hands-on Mode means:

- the user opts into visible rooms, crews, artifacts, and gate-by-gate progress;
- the 3-bay factory abstraction becomes visible;
- the simplified overview still exists, but the detailed cockpit is closer at hand;
- the user should be able to see why something is happening, not just that it is happening.

Hands-on Mode is not a developer IDE mode. It is a **process visibility mode**.

### Toggle behavior

The wireframes introduce an important behavior that should be accepted into the product brief:

- the mode toggle is persistent in the project top bar;
- **Easy → Hands-on** should always be allowed;
- **Hands-on → Easy** should confirm once and should not silently auto-approve any currently pending decision.

## 5.3 The 3-bay factory abstraction

The wireframes add a top-level abstraction that should sit above the 9-phase timeline.

### Recommended bay model

| User-facing bay | Friendly room name | Maps to existing phases |
|---|---|---|
| **Shape it** | Drawing Room | intake / idea shaping, planning / product clarification, design review |
| **Build it** | Workshop | implementation / build, code review |
| **Ship it** | Showroom | browser QA, fix loop, ship readiness, final handoff |

### Recommendation

Use **plain verb labels first** and **room names second**:

- **Shape it** (Drawing Room)
- **Build it** (Workshop)
- **Ship it** (Showroom)

This preserves the wireframe personality while staying understandable for common users.

### Important guardrail

The bay label **Ship it** is acceptable as a chapter/story label, but any operational state inside that bay must still use the current accurate terms:

- **Browser QA**
- **Fix loop**
- **Ship readiness**
- **Ready for handoff**

Never imply deployment.

## 5.4 Simplified overview vs detailed cockpit

### Recommended rule

Inside a bay, users should land on a **simplified overview first** and open the **detailed cockpit second**.

### Simplified overview responsibilities

The simplified layer should answer:

- what is happening right now;
- whether anything needs the user;
- what just finished;
- what happens next;
- how far through the factory the project is.

It should intentionally hide by default:

- full persona handoff chains;
- raw logs or dense traces;
- exhaustive artifact trees;
- low-level progress chatter.

### Detailed cockpit responsibilities

The detailed cockpit should answer:

- which exact phase is active;
- which persona is acting now and next;
- which artifact is in focus;
- which gate is blocking;
- what evidence exists;
- what safety scope is active.

This layering reconciles the current “factory cockpit” brief with the wireframe’s stronger consumer simplification.

## 6. P0 screens and journeys to carry forward

The existing P0 route plan remains usable, but the route states must reflect the new layering.

## 6.1 Required P0 screens/states

| Surface | Reconciled requirement |
|---|---|
| Landing `/` | Universe AI naming, visible-process framing, consumer-friendly promise |
| Dashboard `/app` | decisions-first and resume-first patterns from the wireframes |
| New project `/app/projects/new` | idea shaping wizard plus mode selection before project execution |
| Project home `/app/projects/:projectId` | must support Easy Mode view, Hands-on 3-bay map, simplified bay overview, and detailed cockpit states |
| Artifact detail `/app/projects/:projectId/artifacts/:artifactId` | readable artifact detail with provenance/evidence framing |
| QA `/app/projects/:projectId/qa` | browser audit evidence with strict audit-vs-fix separation |
| Gate state | modal, split, or decision-stage presentation is acceptable if criteria are met |
| Ship-readiness state | may live inside the project route in P0 even if a dedicated route remains P1 |
| Mobile responsive states | resume, decision, and cockpit stack states must be represented |

## 6.2 Required P0 journeys

1. **Start a project**
   - landing → wizard → mode picker → first project state.

2. **Resume work**
   - dashboard resume card → project home → clear next action.

3. **Hands-on exploration**
   - project home → 3-bay map → simplified overview → detailed cockpit.

4. **QA audit to fix-loop approval**
   - QA evidence view → separate fix approval → return to project progress.

5. **Ship-readiness to handoff**
   - readiness checklist/bundle view → ready-for-handoff outcome.

## 7. Artifact and evidence UX reconciliation

The wireframes reinforce the current doc principle that **artifacts beat chat**.

### Accepted artifact/evidence direction

- project progress should be legible through artifacts first;
- latest artifact previews should appear on dashboard, project home, and detailed views;
- artifact titles must be plain-language first;
- QA evidence should be visual first:
  - scenario matrix;
  - screenshots;
  - trace summary/replay second;
- ship-readiness should culminate in a visible handoff bundle or checklist, not only a status badge.

### Runtime alignment implication

Because the current facade is still text-oriented for artifact reads, P0 should treat screenshots, traces, and external evidence as **descriptor-style evidence views**, not as raw file-path surfaces. That matches the current artifact content strategy.

## 8. Approval and gate UX reconciliation

The wireframes sharpen a principle already present in the current docs:

- approvals are not ordinary chat messages;
- risky approvals deserve focused UI.

### Recommended gate rule set

1. **Low-risk content choices** may appear inline or side-by-side with context.
2. **Capability-changing approvals** should use a more focused gate surface.
   - browser audit against a target;
   - safe local fixes;
   - future release-action approvals if they ever exist.
3. A gate must always show:
   - what is being approved;
   - why it matters;
   - what Universe will do next;
   - what Universe cannot do;
   - supporting artifacts/evidence.
4. P0 may explore multiple gate layouts, but the product contract should treat the decision itself as a first-class screen moment.

## 9. Persona and safety UX reconciliation

### Personas

The current docs and the wireframes agree that personas should be:

- role-based and functional;
- clearly bounded by authority;
- visually restrained rather than gimmicky.

### Universe vs personas

The wireframes introduce a useful split:

- **Universe** can appear as the calm, umbrella guide in simplified/Easy Mode;
- detailed views should still name the specific acting persona:
  - Product Coach;
  - CEO/Product Reviewer;
  - Designer;
  - Engineering Architect;
  - Implementation Agent;
  - Code Reviewer;
  - QA Lead;
  - Release Coordinator.

### Safety

The safety strip and safety copy from current docs remain correct and should be carried forward:

- read-only audit;
- browser audit;
- safe local fixes;
- release locked.

The wireframes strengthen one additional rule:

- the UI should repeatedly answer **“What can Universe touch?”** in plain language.

## 10. What is out of scope for P0

These wireframe ideas should not be interpreted as P0 commitments beyond the current plan:

- real repo writes or real build execution in the web app;
- real browser automation in the web app;
- deployment, publish, or release execution;
- billing, team permissions, or advanced approver routing;
- fully connected artifact binary storage UX;
- production-ready notifications;
- deep IDE-style technical tooling;
- changing the current run-scoped core contracts instead of wrapping them.

## 11. Unresolved design decisions

These decisions still need owner choice before implementation is frozen.

1. **Public naming hierarchy**
   - Is the shipped product strictly Universe AI, with Pi fully hidden from the UI?

2. **Canonical dashboard take**
   - Should P0 favor the decisions-first dashboard, the resume-hero production-floor dashboard, or a hybrid?

3. **Canonical cockpit take**
   - Which detailed cockpit variation becomes the baseline P0 spec?
   - Classic 3-column, artifact-stage, conveyor, or decision-stage?

4. **Canonical gate presentation**
   - Should risky gates default to a centered modal, in-context split, or full decision-stage page?

5. **Bay naming lock**
   - Are the primary labels “Shape it / Build it / Ship it,” or “Drawing Room / Workshop / Showroom,” or both?

6. **Project-home default in Hands-on Mode**
   - Should the 3-bay map be the first thing every time, or only until a user enters the active bay?

7. **Easy Mode review queue behavior**
   - Which auto-decisions remain silently reversible versus explicitly shown in a “Universe handled this” list?

8. **Ship-readiness placement in P0**
   - Does ship-readiness remain a cockpit/project state in P0, or does it need its own dedicated route sooner?

9. **Mobile ambition for P0**
   - Are the mobile states only responsive proof points, or must they be fully implemented in the first interactive prototype?

10. **Universe promise wording**
   - How prominently should “build anything in the universe” appear without creating unrealistic expectations about current scope?

## 12. Recommendation for downstream lanes

Downstream screen/component planning should assume this stack:

- **Universe AI Software Factory** user-facing naming;
- **Easy Mode vs Hands-on Mode** as a first-class project setting;
- **3-bay abstraction** above the current 9 phases;
- **simplified overview by default** for common users;
- **detailed cockpit one layer deeper**;
- **artifacts/evidence/gates/safety** still treated as the hard product core.

That is the cleanest reconciliation between the existing Pi planning docs and the external design source.