# Pi Software Factory P0 Product Acceptance

Status: P0 acceptance contract derived from the current Pi planning docs and the Universe AI wireframes. This is a product/design acceptance document, not an implementation plan.

## 1. Purpose

This document defines what the P0 web prototype must communicate and support after the Universe AI reconciliation.

It is intentionally scoped to:

- product acceptance;
- UX/screen acceptance;
- copy and safety acceptance;
- route/state expectations for later implementation lanes.

It does not approve production web implementation, dependency changes, runtime behavior expansion, or roadmap edits.

## 2. Locked P0 product truths

P0 is acceptable only if all of these remain true:

1. The user-facing product is framed as **Universe AI Software Factory**.
2. The product uses **common-user-friendly** language.
3. The landing/message framing can say **“build anything in the universe with Universe AI”**, but runtime surfaces must stay concrete about current limits.
4. The product feels like a visible software factory, not a prompt-only generator or IDE.
5. **Artifacts, evidence, approvals, and safety** are at least as visible as chat.
6. **Easy Mode** and **Hands-on Mode** are first-class project experience states.
7. The current 9-phase model is preserved conceptually, but user-facing navigation may collapse it into a **3-bay factory abstraction**.
8. **QA audit** and **QA fix** remain separate.
9. **Ship readiness is not deployment.**
10. The current runtime remains **run-scoped**, so the prototype must still read as a **project wrapper** over one or more runs rather than pretending project/workspace APIs already exist underneath.

## 3. Target users P0 must serve

P0 must be understandable to all of these users without code fluency:

- founder with an idea but no engineering team;
- operator / small business owner;
- product-minded non-technical teammate;
- lightly technical builder who wants more visibility.

Acceptance implication:

- a founder must be able to stay mostly in Easy Mode;
- a lightly technical builder must be able to switch to Hands-on Mode and inspect the factory process more deeply;
- neither user should need raw logs or source code to know what is happening.

## 4. Required P0 screens and states

## 4.1 Route/state acceptance map

| Route or state | P0 requirement | Must visibly answer |
|---|---|---|
| `/` landing | Universe AI naming and visible-process framing | what this is; why it is different; why it is trustworthy |
| `/signup` | simple onboarding and comfort calibration | who you are; how technical you want the experience |
| `/app` dashboard | decisions-first plus resume-first patterns | what needs you now; where to resume |
| `/app/projects/new` | guided idea-shaping flow | what you are building; what happens next |
| mode-picker state | explicit Easy vs Hands-on choice after idea capture | how much Universe drives; how often it will interrupt |
| `/app/projects/:projectId` Easy Mode state | calm project home | what Universe is doing now; whether anything needs the user |
| `/app/projects/:projectId` Hands-on map state | 3-bay factory abstraction | where the project is in the factory |
| `/app/projects/:projectId` simplified bay state | day-to-day overview inside a bay | current work; recent output; next action |
| `/app/projects/:projectId` detailed cockpit state | deep process view | current phase; persona; artifact; gate; safety |
| `/app/projects/:projectId/artifacts/:artifactId` | artifact detail | what this artifact is; why it matters; provenance/evidence |
| `/app/projects/:projectId/qa` | QA evidence view | what was tested; what failed; what evidence exists |
| gate/decision state | focused approval surface | what is being approved; what changes if approved |
| ship-readiness state | readiness/handoff state | what is ready; what still needs attention; what does not happen |
| mobile responsive states | resume, cockpit, and decision layouts | current action and next decision without desktop assumptions |

## 4.2 Screen-specific acceptance criteria

### Landing

P0 landing is acceptable if it:

- uses **Universe AI Software Factory** naming;
- can carry the line **“build anything in the universe with Universe AI”**;
- immediately shows a visible-process story, not just a prompt box;
- presents artifacts/evidence/approvals as proof of trust.

### Dashboard

P0 dashboard is acceptable if it:

- makes **decision-needed** items more prominent than recency alone;
- makes **resume** obvious;
- uses plain-language project statuses;
- lets a user understand the next action for each project card.

### New project wizard + mode picker

P0 is acceptable if it:

- never starts with a blank chat box;
- grows an Idea Brief or equivalent intake artifact as the user answers;
- asks the user to choose **Easy Mode** or **Hands-on Mode** before project execution;
- explains the difference in interruption frequency and review depth.

### Easy Mode project home

P0 is acceptable if Easy Mode:

- feels calm, sparse, and common-user-friendly;
- leads with “what Universe is doing right now”;
- clearly states whether anything needs the user;
- shows a reversible “Universe handled this for you” pattern for routine choices;
- still allows switching into Hands-on Mode.

### Hands-on map + simplified overview

P0 is acceptable if Hands-on Mode:

- shows a clear 3-bay factory map;
- maps current project position into one active bay;
- uses a simplified overview inside the active bay before opening the detailed cockpit;
- makes the detailed cockpit reachable in one obvious click/tap.

### Detailed cockpit

P0 is acceptable if the detailed cockpit:

- makes the current phase dominant;
- shows the acting persona and the upcoming handoff clearly;
- shows the active artifact or active decision as a first-class panel or stage;
- keeps chat secondary to artifacts, evidence, and approvals;
- shows current safety scope near risky actions.

### QA evidence

P0 is acceptable if the QA surface:

- clearly says **Browser QA audit — no code changes**;
- shows scenario outcomes, screenshots, and trace/replay cues;
- shows the target environment and possible side effects;
- requires a separate approval before any fix loop begins.

### Ship-readiness / handoff

P0 is acceptable if the ship surface:

- clearly says **Ship readiness is not deployment**;
- ends in **Ready for handoff**, not deployed/released/published;
- shows checklist or bundle-style proof of readiness;
- makes accepted risks visible;
- never suggests that push, publish, tag, or deploy already happened.

## 5. Required P0 journeys

## 5.1 Journey A — new common user project

A common user must be able to:

1. start from landing;
2. complete idea shaping in plain language;
3. choose Easy Mode;
4. land in a calm project home;
5. understand what Universe is doing now;
6. identify the next moment where user input will be needed.

Acceptance test:

- a non-technical user can summarize the current state in one sentence without reading a transcript.

## 5.2 Journey B — hands-on inspection journey

A more detail-seeking user must be able to:

1. start a project;
2. choose Hands-on Mode;
3. see the 3-bay map;
4. enter the active bay;
5. open the simplified overview;
6. open the detailed cockpit;
7. inspect artifact, persona, and gate state.

Acceptance test:

- the user can tell both the top-level bay and the underlying detailed phase.

## 5.3 Journey C — QA audit to fix loop

The user must be able to:

1. open QA evidence;
2. understand that QA audit produced evidence only;
3. see visual proof of failures;
4. approve or reject a separate fix loop;
5. understand that the fix loop changes safety scope.

Acceptance test:

- the user can explain the difference between audit and fix without reading technical docs.

## 5.4 Journey D — ready for handoff

The user must be able to:

1. reach ship-readiness state;
2. understand that this is readiness, not deployment;
3. review checklist/bundle output;
4. see accepted risks and missing items;
5. mark the project **Ready for handoff**.

Acceptance test:

- the user does not come away believing the app was deployed.

## 5.5 Journey E — interruption and resume

The user must be able to:

1. leave mid-flow;
2. return via dashboard or mobile;
3. understand what changed while away;
4. identify the single next action.

Acceptance test:

- resume is understandable without opening old chat history.

## 6. Cross-cutting acceptance criteria

## 6.1 Easy Mode vs Hands-on Mode

P0 is acceptable only if:

- Easy Mode and Hands-on Mode feel materially different;
- the mode toggle is persistent at project level;
- Easy Mode collapses process detail without hiding critical decisions;
- Hands-on Mode exposes rooms/layers/process without becoming an IDE;
- switching from Easy to Hands-on does not lose project state;
- switching from Hands-on to Easy does not auto-approve an already-pending decision.

## 6.2 3-bay abstraction

P0 is acceptable only if:

- the 3-bay model is visible in Hands-on Mode;
- the product clearly communicates movement through **Shape it / Build it / Ship it** or equivalent friendly bay names;
- the active bay is obvious;
- future bays are visible but not misleadingly accessible;
- the detailed 9-phase logic remains representable underneath.

## 6.3 Simplified overview vs detailed cockpit

P0 is acceptable only if:

- the simplified layer is calmer and less dense than the cockpit;
- the simplified layer still exposes next decision, latest output, and current status;
- the detailed cockpit is one clear step deeper, not hidden in settings or obscure nav;
- both layers read from the same project truth, not different mock narratives.

## 6.4 Artifact and evidence UX

P0 is acceptable only if:

- artifact titles are plain-language first;
- latest artifacts are visible on dashboard and project surfaces;
- artifact detail explains why the artifact matters;
- QA evidence is visual first and log-like detail second;
- ship-readiness includes a visible handoff/checklist outcome;
- evidence rendering does not depend on raw path parsing in the UI model.

## 6.5 Approval and gate UX

P0 is acceptable only if every meaningful gate shows:

- the plain-language decision;
- why the decision matters;
- what happens if approved;
- safety impact;
- supporting artifact/evidence;
- clear approve / reject / request-changes behavior.

Additional acceptance:

- risky approvals must feel deliberate and focused;
- capability-changing approvals must explain blocked actions;
- stale/conflict states must be representable even if mocked in P0.

## 6.6 Persona and safety UX

P0 is acceptable only if:

- personas are role-based and bounded;
- simplified layers can speak as Universe while deeper layers still identify the acting persona;
- safety state is visible wherever action authority matters;
- the UI can answer “What can Universe touch?” in plain language;
- these safety states remain legible:
  - read-only audit;
  - browser audit;
  - safe local fixes;
  - release locked.

## 6.7 Copy locks

P0 must preserve these language rules:

- use **Universe AI** in user-facing product copy;
- use **Browser QA audit — no code changes** or equivalent meaning;
- use **Ship readiness is not deployment** or equivalent meaning;
- use **Ready for handoff** as the success outcome;
- avoid claiming deploy, release, publish, or shipped status when P0 did not do those things.

## 7. Out of scope for P0 acceptance

The following are not required for P0 acceptance:

- real authenticated multi-user workflows;
- billing or plan enforcement;
- real browser automation;
- real repo writes from the web prototype;
- real deploy/release execution;
- connected CI, GitHub, or environment management;
- full artifact binary storage implementation;
- final visual design polish beyond proving the product structure;
- dependency additions or production web scaffolding approval.

## 8. Unresolved decisions still requiring owner review

1. Which dashboard variant becomes canonical?
2. Which detailed cockpit variant becomes canonical?
3. Which gate presentation becomes canonical for risky approvals?
4. Which bay labels are primary in final copy: verbs, room names, or both?
5. Should Hands-on project home always open on the 3-bay map, or jump directly into the active bay after the first visit?
6. How much of ship-readiness needs a dedicated route in P0 versus a project-state surface?
7. How prominently should the “build anything in the universe” line appear outside marketing surfaces?
8. How far mobile should go in P0: responsive proof or full fidelity?

## 9. Acceptance summary

P0 is approved from a product/design perspective only if a common user can say all of the following after a short walkthrough:

- “I know what Universe is doing right now.”
- “I know whether it needs me.”
- “I know what it can and cannot touch.”
- “I can find the latest artifact or evidence.”
- “I can tell the difference between QA audit, QA fix, and ship readiness.”
- “I do not think this prototype already deployed my app.”
- “If I want more detail, I can open the factory and look deeper.”