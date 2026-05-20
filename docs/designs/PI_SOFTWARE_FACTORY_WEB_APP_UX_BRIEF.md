# Pi Software Factory Web Application UX Brief

Status: design brief for first web-app prototype. No implementation started.

## 1. Product thesis

Pi Software Factory is a guided web application platform where a non-expert user collaborates with a small AI product team to shape, plan, build, review, QA, and prepare an app for handoff or launch. The core experience is a **factory cockpit**: one place where the conversation, expert personas, phase progress, artifacts, safety gates, browser evidence, and ship-readiness state are visible together. The user should not feel like they are prompting a black-box app generator. They should feel like they are moving through a clear production line with a product coach, designer, engineering architect, implementation agent, reviewer, QA lead, and release coordinator.

Differentiation versus Lovable, Replit, and site-builder-style products: this product is not primarily a code editor, sandbox, or instant site generator. It is a phase-based software factory for common users who need confidence, structure, review, and handoff. The wedge is **trust through visible process**: every meaningful factory action creates an understandable artifact, every risky step has a plain-language approval, and every automated persona has a role, current task, evidence trail, and next action.

### Product promise in plain English

**Pi is an AI product team with receipts.** You describe what you want to build. Pi turns that into visible phases, readable artifacts, review checkpoints, and evidence-backed recommendations. You always know what happened, what changed, what still looks risky, and what decision is needed from you.

Use this landing-page contrast:

- **Not:** prompt in, mystery app out.
- **Not:** an IDE, code sandbox, or developer-first site builder.
- **Yes:** guided product work with visible steps, artifacts, evidence, and approvals.
- **Yes:** confidence without code fluency.

### UX invariants

Every primary surface should answer these questions without forcing the user to read raw logs or code:

1. What is happening now?
2. Who or which persona is doing it?
3. What can that persona/automation touch?
4. What artifact or evidence was produced?
5. What decision is needed from the user?
6. What happens next?

Design shorthand: **artifacts beat chat**. Chat supports progress; artifacts, decisions, and evidence define progress.

## 2. Target users

### Primary personas

1. **Founder with an idea but no engineering team**
   - Motivation: turn a rough product idea into a credible prototype or MVP plan quickly.
   - Anxieties: wasting money, building the wrong thing, being tricked by AI output, not knowing whether the app is actually usable or ready.

2. **Operator / small business owner**
   - Motivation: automate a workflow, build an internal tool, or launch a simple customer-facing app.
   - Anxieties: technical jargon, security risk, fear that automation will break something, lack of confidence reviewing code or deployment decisions.

3. **Product-minded non-technical team member**
   - Motivation: clarify requirements, coordinate feedback, and create a build-ready artifact for an engineering partner or AI implementation flow.
   - Anxieties: losing context across chats, not knowing what decisions are still open, difficulty explaining tradeoffs to stakeholders.

4. **Lightly technical builder**
   - Motivation: use the factory as a disciplined assistant for planning, review, QA, and release readiness.
   - Anxieties: black-box automation, unsafe writes, missing tests, shallow code review, ambiguous release state.

### Shared motivations

- Feel accompanied by expert help without hiring a full team.
- See progress in phases, not an infinite chat stream.
- Have artifacts they can read, share, approve, or hand off.
- Know when automation is read-only versus write-capable.
- Know what changed, what was checked, and what remains risky.

### Shared anxieties

- “Is this really building the right thing?”
- “What did the AI actually do?”
- “Can it break my project or deploy something accidentally?”
- “Am I supposed to understand code to approve this?”
- “If I leave and come back tomorrow, will I know where I was?”

## 3. Core user journey

### First-session outcome

The first session should not promise a finished app. The first win is confidence and momentum: the user leaves with an **Idea Brief**, an **MVP Scope**, a visible phase map, and one clear next step. This keeps the experience concrete before any write-capable build work exists.

### Happy path: signup to completed build/readiness handoff

1. **Landing page**
   - User sees the product positioned as “your AI product team with a visible factory process,” not “type a prompt and get an app.”
   - Primary CTA: “Start a project.” Secondary CTA: “See the factory process.”

2. **Signup / account creation**
   - User creates an account and workspace.
   - Onboarding asks for role and comfort level, not technical stack preferences first.
   - Example comfort levels: “I do not code,” “I can review product decisions,” “I can work with a developer.”

3. **Workspace dashboard**
   - User lands on a simple project list with statuses: Draft idea, Planning, Building, In QA, Fix loop, Ship readiness, Complete.
   - Empty state invites creating the first project using a guided wizard.

4. **New project wizard: idea shaping**
   - User describes the app in plain language.
   - The factory asks short outcome-oriented questions: target user, painful workflow, must-have result, deadline, risk tolerance.
   - Output artifact: **Idea Brief**.
   - Gate: “Does this capture what you want to build?” Approve / edit / ask for alternatives.

5. **Planning / product clarification**
   - Product coach and CEO/product reviewer persona clarify the core promise, MVP scope, non-goals, and success criteria.
   - Output artifacts: **Product Plan**, **MVP Scope**, **Open Decisions**.
   - Gate: user chooses a scope option. Plain-language options, not implementation-heavy choices.

6. **Design review**
   - Designer persona turns the plan into a screen map, key flows, and UX risks.
   - Output artifacts: **Screen Map**, **User Flow**, **Design Review Notes**.
   - Gate: approve screen direction or request another pass.

7. **Implementation/build**
   - Engineering architect explains the build plan in user-friendly terms.
   - Implementation agent performs write-capable work only after an explicit safe-build approval.
   - Output artifacts: **Build Plan**, **Build Summary**, **Changed Areas**, **Known Tradeoffs**.
   - Safety presentation: “Local non-destructive changes only,” “No production deploy,” “You can review before anything ships.”

8. **Code review / quality review**
   - Code reviewer persona audits the implementation.
   - Output artifact: **Quality Review** with findings grouped as Must Fix, Should Fix, Accepted Risk.
   - Gate: user approves the fix loop or asks to pause.

9. **Browser QA audit**
   - QA lead persona runs browser-based checks and records evidence without editing code.
   - Output artifacts: **QA Report**, screenshots, browser trace summary, passed/failed scenarios.
   - Gate: approve a separate fix loop for failed scenarios, accept limitations, or pause. The UI must clearly say: “Browser audit does not change code.”

10. **Fix loop**
    - Factory summarizes failures, proposes a fix plan, and applies non-destructive local fixes only after a second explicit write approval.
    - Output artifacts: **Fix Plan**, **Fix Summary**, **Regression QA Evidence**.
    - The loop is visible as a nested mini-cycle under QA rather than hidden chat churn.
    - Safety presentation: “Apply local fixes edits project files and runs non-destructive checks. It cannot push, deploy, force-reset, or read secrets.”

11. **Ship readiness**
    - Release coordinator prepares a readiness checklist.
    - Output artifacts: **Ship Readiness Report**, **Release Notes Draft**, **Handoff Plan**.
    - Important wording: this is readiness unless a later explicit release-action capability exists. The UI must not imply deploy/publish happened when it only verified readiness. Use “Ready for handoff” rather than “Deployed” or “Shipped.”

12. **Completed app/build handoff**
    - User receives a completion screen with: final app/build location, artifact bundle, unresolved decisions, accepted risks, recommended next step.
    - The project remains resumable for future iterations.

### Common interruption and resume path

1. User leaves mid-phase, after a question, or while external work is pending.
2. Dashboard shows a resume card: “Waiting for your decision,” “QA running,” “Review ready,” or “Blocked by safety setting.”
3. Opening the project lands on the cockpit, not raw chat history.
4. A **Resume Banner** answers four questions:
   - What is happening now?
   - Who is working?
   - What decision is needed?
   - What happens after this?
5. Conversation is summarized into a phase digest, with full transcript available but not primary.
6. The primary CTA is context-specific: “Review Product Plan,” “Approve safe build,” “Open QA evidence,” “Continue fix loop,” or “View ship readiness.”

## 4. Information architecture

### Domain model

The web product should separate product-level concepts from factory-runtime concepts:

- **Workspace**: account/team boundary, billing, members, safety defaults.
- **Project**: user-facing app idea or build effort. A project owns the phase map, artifacts, decisions, and human-friendly status.
- **Factory run**: event-sourced execution record for a workflow such as planning, review, QA audit, QA fix, or ship readiness.
- **Phase**: visible step in the project/factory journey.
- **Persona**: role attached to a phase or action, with a clear authority boundary.
- **Artifact**: durable output that can be read, approved, versioned, exported, or superseded.
- **Gate/decision**: explicit approval or rejection event, sequence-checked so stale approvals cannot apply.

Current factory DTOs are run-scoped. The web app should add a project wrapper layer instead of hiding run semantics. A project may contain multiple linked factory runs, especially for QA audit, QA fix, and future release execution.

### Canonical state taxonomy

Use one vocabulary across dashboard, cockpit, timeline, and notifications:

- **Project status**: Draft idea, Planning, Design review, Building, Reviewing, QA audit, Fix loop, Ship readiness, Ready for handoff, Paused, Blocked, Complete.
- **Run status**: Blocked, Running, Paused, Completed, Failed, Cancelled.
- **Pause kind**: Waiting for decision, Waiting for external work, Waiting for recovery, Waiting for integration.
- **Phase state**: Not started, Active, Running, Waiting for user, Blocked, Complete, Skipped, Needs fix.
- **Gate state**: Not reached, Pending, Approved, Rejected, Waived, Cancelled, Stale.
- **Artifact state**: Draft, Produced, Approved, Superseded, Evidence, Accepted risk, Needs review.
- **Safety state**: Read-only audit, Browser audit, Safe local fixes, Network/CI allowed, Release action locked, Blocked by policy.

### Top-level navigation

- **Home / Dashboard**: workspace overview and active project states.
- **Projects**: all projects, searchable by name, phase, status, owner, last activity.
- **Factory Activity**: cross-project feed of running work, completed artifacts, decisions needed, failures.
- **Templates / Examples**: plain-language starting points such as marketplace, scheduling tool, internal dashboard, landing page plus workflow.
- **Team**: collaborators, roles, approvals, notification routing.
- **Billing**: plan, usage, invoices, limits.
- **Settings**: workspace preferences, safety defaults, integrations, data/export controls.

### Project-level navigation

- **Cockpit**: default project home; phase timeline, current conversation, persona status, next decision, latest artifacts.
- **Plan**: idea brief, product plan, MVP scope, decisions, non-goals.
- **Design**: screen map, user flows, design reviews, visual references.
- **Build**: build plan, implementation summaries, changed areas, fix loop records.
- **Review**: code/quality reviews, severity summaries, accepted risks.
- **QA Evidence**: browser scenarios, screenshots, traces, pass/fail matrix.
- **Ship Readiness**: checklist, release notes draft, handoff readiness. Do not imply deployment execution unless a future release-action workflow exists.
- **Artifacts**: full library with filters by phase, persona, type, date.
- **Decisions**: pending and historical gates/approvals.
- **Settings & Safety**: project safety profile, automation permissions, integrations.

### Factory/workflow-level surfaces

Inside the cockpit, the workflow is organized into five persistent regions:

1. **ProjectStatusHeader**
   - project name, current phase, status, safety mode, last updated, next CTA.
2. **FactoryTimeline**
   - phase rail with completed/current/blocked/upcoming states.
3. **ConversationPhaseWorkspace**
   - structured conversation and action cards for the current phase.
4. **PersonaPanel**
   - active persona, supporting personas, what each is doing, confidence/evidence.
5. **Artifact / Decision Side Panel**
   - latest artifact, pending gate, evidence, or selected timeline item.

## 5. Key screens

### 5.1 Landing / product positioning page

- **Purpose**: explain the visible factory model and set expectations away from “instant magic prompt builder.”
- **Primary user actions**: start project, view sample cockpit, compare process, sign in.
- **Key UI components**:
  - Hero: “Build with an AI product team you can actually see.”
  - Animated factory cockpit preview: phases + chat + artifacts + approval card.
  - Three proof blocks: Guided phases, expert personas, safe approvals.
  - Differentiation strip: “Not just chat. Not a code sandbox. A guided app-building process.”
  - Example artifact gallery: Idea Brief, QA Evidence, Ship Readiness Checklist.
- **Empty/loading/error states**:
  - Loading: skeleton cockpit preview.
  - Error: fallback static screenshot and CTA.
- **Visual hierarchy notes**:
  - Lead with process confidence, not model power.
  - Show a real-looking artifact before showing a chat bubble.

### 5.2 Signup and workspace onboarding

- **Purpose**: create account and calibrate the factory to the user’s confidence level.
- **Primary user actions**: create account, name workspace, select role, choose safety defaults.
- **Key UI components**:
  - Short account form.
  - “What best describes you?” role cards.
  - “How much technical detail do you want?” slider: Simple / Balanced / Detailed.
  - Default safety preset: “Ask before making changes” selected by default.
- **Empty/loading/error states**:
  - Loading: “Preparing your workspace.”
  - Error: account creation retry with support link.
- **Visual hierarchy notes**:
  - Safety defaults should feel reassuring, not like compliance setup.
  - Avoid asking for frameworks, repos, or deployment targets before an idea exists.

### 5.3 Workspace dashboard

- **Purpose**: show all projects and make resume state obvious.
- **Primary user actions**: create project, resume project, review decisions, inspect recent artifacts.
- **Key UI components**:
  - Decision-needed banner.
  - Project cards with phase, status, next action, updated time.
  - Activity feed: “QA report produced,” “Build approval needed.”
  - Empty state: guided “Start your first app idea.”
- **Empty/loading/error states**:
  - Empty: one large new-project card plus sample project option.
  - Loading: project-card skeletons.
  - Error: retry and “download local export” if available.
- **Visual hierarchy notes**:
  - Prioritize “needs your decision” above recency.
  - Use human labels: “Planning your MVP,” not only `plan-only` or `review`.

### 5.4 Project list

- **Purpose**: manage many projects without losing factory state.
- **Primary user actions**: search, filter by phase/status, open project, archive.
- **Key UI components**:
  - Table/card hybrid: project name, current phase, status, active persona, pending decisions, artifacts count.
  - Filters: Needs decision, In progress, Blocked, Complete, Archived.
- **Empty/loading/error states**:
  - Empty filtered state: “No projects need a decision right now.”
  - Error: retry plus last cached list if available.
- **Visual hierarchy notes**:
  - Avoid developer-centric columns like branch/commit unless in expanded technical detail.

### 5.5 New project wizard

- **Purpose**: turn a rough idea into a structured intake artifact.
- **Primary user actions**: describe idea, answer short questions, choose target user, approve Idea Brief.
- **Key UI components**:
  - Conversational question cards, one to three at a time.
  - Idea canvas: Problem, User, Desired outcome, Constraints, Nice-to-haves.
  - Product coach persona card.
  - Generated Idea Brief preview.
  - GateDecisionModal for “Approve Idea Brief.”
- **Empty/loading/error states**:
  - Empty input: examples of good plain-language prompts.
  - Loading: “Product coach is shaping your idea.”
  - Error: preserve answers, allow retry/regenerate.
- **Visual hierarchy notes**:
  - The artifact preview should grow as the user answers.
  - Never make the user stare at a blank chat box.

### 5.6 Project factory cockpit

- **Purpose**: main operating surface for a project.
- **Primary user actions**: continue conversation, approve gates, open artifacts, pause/resume automation, inspect progress.
- **Key UI components**:
  - ProjectStatusHeader.
  - FactoryTimeline left rail or top rail, depending viewport.
  - ConversationThread grouped by phase.
  - PersonaPanel showing active and upcoming personas.
  - Artifact cards and decision cards in right panel.
  - Safety strip: Read-only / Safe local changes / Release action locked.
- **Empty/loading/error states**:
  - New empty project: “Start intake” CTA and sample phase map.
  - Loading: phase rail skeleton, current action spinner with persona.
  - Error: recovery card with last safe event, retry, contact support/export.
- **Visual hierarchy notes**:
  - Current phase and next decision must dominate.
  - Chat input is important but secondary to progress, artifacts, and gates.
  - Use one primary CTA at a time.

### 5.7 Conversational phase workspace

- **Purpose**: support dialogue without making the product feel like endless chat.
- **Primary user actions**: answer questions, ask for clarification, request alternatives, approve artifacts.
- **Key UI components**:
  - Phase intro card: goal, persona, expected artifact, estimated steps.
  - Thread sections: Questions, Factory actions, Artifact produced, Decision needed.
  - Suggested replies tied to the current phase.
  - “Why we are asking” helper text.
- **Empty/loading/error states**:
  - Empty phase: start card explains what will happen.
  - Loading: action card with live steps: reading plan, drafting artifact, preparing review.
  - Error: “This step did not complete” with safe retry and artifact preservation.
- **Visual hierarchy notes**:
  - Keep messages short, but let artifact cards carry detail.
  - Collapse older phase conversation into summaries by default.

### 5.8 Persona panel

- **Purpose**: make AI roles distinct and useful without turning them into gimmicks.
- **Primary user actions**: see who is active, inspect role responsibility, ask a persona-specific question.
- **Key UI components**:
  - Active PersonaCard: title, current task, authority boundary.
  - Supporting personas list.
  - “What this persona can decide” and “What needs you.”
  - Persona handoff chips: Product Coach → Designer → Architect → QA Lead.
- **Empty/loading/error states**:
  - Empty: no active persona before run starts.
  - Loading: persona thinking/working state.
  - Error: persona failed and handoff/retry option.
- **Visual hierarchy notes**:
  - Personas should be functional labels with restrained personality.
  - Avoid avatars that imply fake humans; use role icons or simple portraits.

### 5.9 Artifact library and artifact detail

- **Purpose**: make factory outputs durable, readable, and shareable.
- **Primary user actions**: browse artifacts, filter, compare versions, approve, export/share.
- **Key UI components**:
  - Artifact grid/list with type, phase, persona, status, updated date.
  - Artifact detail viewer with summary, source phase, related decision, version history.
  - Filters: Plan, Design, Review, QA, Build, Ship readiness.
- **Empty/loading/error states**:
  - Empty: “Artifacts will appear here as phases complete.”
  - Loading: document skeleton.
  - Error: missing artifact recovery and event-log reference.
- **Visual hierarchy notes**:
  - Artifact cards should use plain names: “MVP Scope,” not only `plan`.
  - Show artifact status: Draft, Approved, Superseded, Needs review.

### 5.10 Decision / gate modal

- **Purpose**: turn gates into simple, understandable choices.
- **Primary user actions**: approve, reject/request changes, waive when allowed, cancel/pause.
- **Key UI components**:
  - Decision title in user language.
  - Why this decision matters.
  - What the factory will do if approved.
  - Safety impact badges: read-only, browser audit, safe local fixes, network/CI, release locked.
  - Exact capability scope and blocked examples for risky approvals.
  - Linked artifacts/evidence.
  - Primary and secondary actions.
  - Optional reason field. “Request changes” should initially map to `reject + reason` unless a separate backend decision value is added.
- **Empty/loading/error states**:
  - Loading: verifying current gate sequence so stale approvals cannot apply.
  - Error: stale gate; refresh decision state.
  - Conflict: another teammate already decided; show current authoritative decision.
  - Blocked: missing permission or safety setting.
  - Session expired: preserve reason text and ask user to sign in again.
- **Visual hierarchy notes**:
  - Avoid technical ceremony. The modal should answer: “What am I approving?” and “Can this hurt anything?”
  - Use progressive disclosure for technical details like capability names, but never hide material risk behind an advanced toggle.
  - Disable double-submit and show confirmed/recorded state after approval.

### 5.11 QA / browser evidence view

- **Purpose**: show what was tested in the browser and what evidence exists.
- **Primary user actions**: review scenarios, open screenshots, replay trace if available, approve a separate fix loop.
- **Key UI components**:
  - Mode banner: “Browser QA audit — no code changes” or “QA fix — safe local writes approved.”
  - Target environment card: URL, preview/staging/production label, authenticated account if relevant, side-effect warning.
  - Scenario matrix: Passed / Failed / Not tested.
  - Screenshot cards with captions.
  - Browser trace summary: pages visited, key actions, observed failures.
  - QAResultPanel with severity and user impact.
  - Fix recommendation card with separate approval CTA.
- **Empty/loading/error states**:
  - Empty: QA has not run; explain prerequisites.
  - Loading: live browser step indicator with current URL/action, sanitized.
  - Error: browser unavailable, target unreachable, authentication needed.
  - Permission warning: target appears production-like; recommend preview/staging before continuing.
- **Visual hierarchy notes**:
  - Lead with user-visible outcomes, not logs.
  - Evidence should be visual first, raw trace second.
  - Browser QA can click real UI and may create test data; say this plainly before approval.

### 5.12 Build / fix diff summary

- **Purpose**: explain implementation changes without requiring code fluency.
- **Primary user actions**: review what changed, open technical details, approve review/QA, request rollback or fix loop.
- **Key UI components**:
  - BuildSummaryPanel: Changed areas, new behavior, tests run, risks.
  - Before/after user-flow summary.
  - File/diff detail behind “technical details.”
  - Safety note: non-destructive local changes versus release actions.
- **Empty/loading/error states**:
  - Empty: no build yet.
  - Loading: implementation progress grouped by task.
  - Error: build failed; show failed step, preserved artifacts, retry options.
- **Visual hierarchy notes**:
  - Explain impact before files.
  - For common users, “Changed checkout flow validation” beats `src/checkout.ts` as the primary label.

### 5.13 Ship-readiness checklist

- **Purpose**: make final readiness explicit and avoid implying deployment before it exists.
- **Primary user actions**: review checklist, approve readiness, export handoff, connect deployment later.
- **Key UI components**:
  - ShipReadinessChecklist: review clean, QA evidence, tests, open risks, release notes, handoff plan.
  - Readiness status: Not ready / Ready for handoff / Ready for future deploy workflow.
  - Persistent banner: “Ship readiness is not deployment. No tag, publish, push, or deploy happens in this workflow.”
  - Release coordinator persona.
  - Final readiness approval gate.
- **Empty/loading/error states**:
  - Empty: readiness begins after QA/review.
  - Loading: checking artifacts and gates.
  - Error: missing evidence or failed check with next action.
- **Visual hierarchy notes**:
  - Use “ready to ship” carefully. Prefer “Ship readiness complete” unless deployment execution exists.
  - Red/yellow/green checklist should map to user risk, not internal workflow status only.

### 5.14 Project settings and safety controls

- **Purpose**: let users understand and control automation authority.
- **Primary user actions**: set approval defaults, enable/disable browser, allow safe local writes, manage integrations, export/delete project.
- **Key UI components**:
  - Safety mode cards:
    - Read-only audit.
    - Browser QA audit allowed.
    - Safe local fixes allowed.
    - Network/CI allowed.
    - Release/deploy actions locked.
    - Blocked by policy.
  - Capability explanations in plain language.
  - Blocked-command examples for non-destructive write mode: no force reset, no `git clean`, no force push, no publish/deploy, no secret/env dumping.
  - Integration status: repo, browser target, CI, deployment provider.
  - Audit log access: decisions, artifacts, event sequence, recovery attempts.
- **Empty/loading/error states**:
  - Empty integration: guided connect flow.
  - Loading: checking permissions.
  - Error: permission denied with exact next step.
- **Visual hierarchy notes**:
  - Defaults should be conservative.
  - Safety controls should feel empowering, not alarming.

### 5.15 Billing, team, and account area

- **Purpose**: support workspace ownership without distracting from factory work.
- **Primary user actions**: invite teammates, assign approvers, view usage, manage plan.
- **Key UI components**:
  - Team roles: Owner, Approver, Collaborator, Viewer.
  - Usage summary by project and phase.
  - Billing plan and limits.
  - Notification settings for decisions needed.
- **Empty/loading/error states**:
  - Empty team: invite collaborator prompt.
  - Error: billing provider unavailable, preserve workspace access state.
- **Visual hierarchy notes**:
  - Billing should not dominate early prototype unless usage limits require it.

### 5.16 Shared empty/loading/error/recovery states

Use a small set of reusable states instead of inventing one-off error copy per screen:

- **First-use empty**: explains what will appear here and offers one clear start action.
- **Empty filtered/search result**: confirms nothing matches the filter and offers reset.
- **Long-running action**: shows active persona, current step, last safe checkpoint, and whether work continues in the background.
- **Offline/reconnecting**: preserves read-only cached state, blocks new approvals until reconnected.
- **Session expired**: preserves unsaved input and returns to the same gate/artifact after login.
- **Permission mismatch**: user can view evidence but cannot approve; show who can.
- **Concurrent update conflict**: another actor changed the gate/artifact; refresh to authoritative state.
- **Integration disconnected**: preview URL, repo, CI, or browser target unavailable; show the smallest next fix.
- **Policy blocked**: explain which safety setting blocks progress and what approval would change.
- **Recovery needed**: status can be inspected safely; recovery requires an explicit action.

## 6. Conversation model

### Structure

The conversation is not one endless thread. It is a sequence of **phase rooms**. Each phase room contains:

1. **Phase brief**: what this phase is trying to accomplish.
2. **Persona prompt**: who is helping and why.
3. **User questions**: short, outcome-oriented questions.
4. **Factory action cards**: visible units of work, e.g. “Drafting MVP Scope,” “Running QA scenario: signup.”
5. **Artifact cards**: durable outputs created by the action.
6. **Decision cards**: approvals or choices needed to continue.
7. **Phase summary**: what happened, what was produced, what happens next.

Older phases collapse into summaries with expandable transcript and artifacts. The user should be able to resume from a summary without rereading every message.

### Persona appearance

Personas are represented as role-based collaborators, not theatrical characters.

- **Product Coach**: asks clarifying questions, frames choices, translates ideas into product artifacts.
- **CEO/Product Reviewer**: challenges scope, positioning, and user value.
- **Designer**: maps screens, flows, and usability risks.
- **Engineering Architect**: explains build approach and tradeoffs.
- **Implementation Agent**: performs approved build/fix work.
- **Code Reviewer**: finds quality/security/maintainability issues.
- **QA Lead**: runs browser checks and records evidence.
- **Release Coordinator**: verifies readiness and handoff.

Each persona card should show:

- current task;
- what inputs it is using;
- what artifact it will produce;
- whether it can act read-only, browse, write locally, or requires approval.

### Approvals and gates

Approvals appear as decision cards or modals, not buried chat messages. A gate should include:

- plain-language decision;
- recommended choice;
- what happens next;
- safety impact;
- artifacts/evidence supporting the recommendation;
- options: Approve, Request changes (`reject + reason` in the current contract), Reject/Pause, Waive only when allowed.

Gate behavior rules:

- A decision must record actor, timestamp, reason when provided, linked artifacts, safety scope, and the current request sequence.
- Stale gates must refresh instead of applying an old approval.
- “View status” must never mutate run state. “Recover run” is a separate explicit action.
- Waiving a must-fix issue or accepted risk requires stronger confirmation and a reason.

Examples:

- “Approve this MVP scope?”
- “Run browser QA audit against this preview URL? This will not edit code.”
- “Allow the factory to make safe local changes for the fix loop?”
- “Accept these known risks and move to ship readiness?”

### Artifact and decision summaries

Every artifact has a one-paragraph summary, a “why it matters” note, and a source phase. Human-friendly artifact names should map to typed artifact records plus metadata. For example: Idea Brief = `plan` with subtype `idea-brief`; Screen Map = `design-doc`; QA screenshot = `screenshot`; Ship Readiness Report = `release-note` or `plan` with subtype `ship-readiness`.

Every decision creates a durable decision record:

- decision value;
- who decided;
- timestamp;
- request sequence;
- reason, if provided;
- linked gate;
- linked artifacts;
- safety/capability scope at approval time;
- next phase triggered.

## 7. Component system

### ProjectStatusHeader

- Displays project name, current phase, public status, last update, active persona, safety mode, next action.
- Primary CTA should be singular and context-aware.
- Shows resume state: waiting for decision, external work, recovery, integration, or blocked policy.
- Maps later to factory status DTO fields: `workflowId`, `workflowTitle`, `status`, `currentPhase`, `progress`, `pause`, `updatedAt`, plus a project wrapper for `projectId`, project name, and next action.

### FactoryTimeline

- Horizontal on mobile/top layouts; vertical rail on desktop cockpit.
- Phase states: Not started, Active, Waiting for user, Running, Blocked, Complete, Needs fix, Skipped.
- Shows expected artifacts and gates per phase.
- Should support nested loops for QA → fix → regression QA.
- Maps later to `FactoryRunPlan.phases`, `completedPhaseIds`, `currentPhase`, `gates`, `artifacts`.

### PhaseCard

- Summary card for each phase.
- Fields: title, persona, purpose, status, expected artifact, decision needed, safety/capability badge.
- Click opens phase room.

### PersonaCard

- Role, current task, authority boundary, output artifact, status.
- Variants: active, supporting, upcoming, completed handoff.
- Avoid gimmicky personalities; emphasize responsibility.

### ConversationThread

- Phase-scoped thread with grouped message types.
- Supports message, question, action, artifact, decision, system/safety, error/recovery.
- Default view collapses old detail into phase summaries.

### ArtifactCard

- Artifact type, plain-language title, summary, phase, persona, status, timestamp.
- Actions: open, compare, approve, export, share.
- Status variants: Draft, Approved, Superseded, Needs review, Evidence.
- Maps later to `ArtifactRef` and artifact store records.

### GateDecisionModal

- Plain-language approval surface.
- Includes reason, recommendation, safety impact, supporting artifacts, stale-state handling.
- Must validate current gate sequence before recording approval.
- Maps later to gate DTOs: `id`, `requestSequence`, `allowedDecisions`, `recommendation`, `status`.

### SafetyBadge

- Compact label for automation authority.
- Suggested states:
  - Read-only audit.
  - Browser QA audit.
  - Safe local fixes.
  - Network/CI allowed.
  - Release action locked.
  - Blocked by policy.
- Expanded copy should map to command safety profiles:
  - `read-only`: can inspect and produce artifacts, cannot edit project files.
  - `non-destructive-write`: can edit local project files and run safe checks, cannot push, deploy, force-reset, clean, publish, or read secrets.
  - `release-action`: future explicit release/deploy mode only, never implied by ship-readiness.
- Should be clickable for plain-language explanation.
- Maps later to policy and risks: `allowWrites`, `allowBrowser`, `allowNetwork`, `commandSafetyProfile`, `risks`.

### QAResultPanel

- Scenario matrix, screenshots, trace summary, issue list, recommended fix loop.
- Shows evidence quality: Complete, Partial, Needs credentials, Browser unavailable.
- Maps later to QA artifacts: `qa-report`, `screenshot`, `browser-trace`.

### BuildSummaryPanel

- Explains what changed in user terms.
- Sections: New behavior, Changed areas, Tests/checks, Risks, Technical detail.
- Supports before/after and diff detail for technical users.
- Maps later to build/fix artifacts and `diff` artifacts when added.

### ShipReadinessChecklist

- Checklist grouped by Product, Quality, QA, Release, Handoff.
- Status levels: Missing, Needs attention, Ready, Accepted risk.
- Must distinguish readiness from actual deploy/publish execution.
- Maps later to ship workflow gates and release artifacts.

### DecisionQueue

- Global/project component listing all pending decisions.
- Prioritized by blocking impact.
- Each item answers: decision, phase, persona, recommended action, deadline if any.

### ActivityEventCard

- Human-readable event from the event-sourced run.
- Examples: “QA Lead produced browser evidence,” “Release gate requested,” “Product plan approved.”
- Technical event IDs remain hidden unless expanded.

### RecoveryCard

- Appears when a run is blocked, failed, stale, or awaiting external capture.
- Separates inspection from mutation: “View status” refreshes only; “Recover run” is an explicit action with its own confirmation and result.
- Offers safe actions: retry, refresh status, recover artifact, contact support, export run bundle.
- Handles corrupt/quarantined recovery data with plain copy: “Extra events were detected after the last trusted checkpoint and are excluded until reviewed.”
- Must not perform mutating recovery from a pure status view unless user explicitly chooses recovery.

### AuditTrailPanel

- Shows immutable factory receipts: event sequence, phase transitions, gates, decisions, artifacts, recovery attempts, and capability scope at approval time.
- User-facing question it must answer: “Who approved what, when, based on which evidence, and what was the automation allowed to touch?”
- Technical event IDs, run IDs, and request sequences are visible in an expanded detail mode.

## 8. Visual design direction

### Tone and mood

- Calm, competent, transparent, and encouraging.
- Feels like an operations cockpit for normal people, not an IDE.
- Avoid cyber/AI sparkle overload. The trust signal is clarity and evidence.
- Copy should be plain, short, and outcome-focused.

### Color direction

- Base palette: warm neutral background, high-contrast text, soft panels.
- Accent color: trustworthy blue or teal for active progress.
- Success: green, used sparingly for completed gates/evidence.
- Warning: amber for decisions, accepted risks, missing evidence.
- Danger: red only for blocked/failure/destructive/release-action contexts.
- Persona colors can be subtle chips, not full themed screens.

Suggested semantic colors:

- Planning / product: blue.
- Design: violet.
- Build: indigo.
- Review: amber.
- QA: teal.
- Ship readiness: green.
- Safety blocked: red.

### Typography direction

- Use a clean, readable sans-serif with strong UI numerals.
- Headings should be direct and human: “Approve the MVP scope,” not “Gate Request.”
- Use monospace only in technical detail drawers, event IDs, paths, or diffs.
- Artifact titles should feel like documents, not logs.

### Layout principles

- Desktop cockpit: three-column layout.
  - Left: timeline/progress rail.
  - Center: phase workspace/conversation.
  - Right: active persona, decision, artifact preview.
- Suggested responsive rules:
  - Large desktop, 1200px+: persistent three-column cockpit.
  - Tablet, 768–1199px: timeline becomes top rail; persona/artifact panel docks into tabs or drawer.
  - Mobile, <768px: current action first; timeline is a collapsible stepper; artifacts/decisions render as cards below the active task.
- Keep one sticky next-action area in every viewport.
- Preserve readable artifact cards; do not squeeze document previews below useful reading width.
- Persistent next action: the user should never need to search for what to do.
- Prefer cards and document previews over dense tables.

### Motion and interaction principles

- Motion should communicate progress and handoffs, not entertain.
- Use subtle transitions when phases complete or personas hand off.
- Long-running actions show step progress and partial artifacts where possible.
- Decision modals should feel stable and deliberate; avoid auto-advancing after risky approvals without a confirmation state.
- Browser QA can show live status but should avoid overwhelming raw automation logs.

### Accessibility considerations

- WCAG AA color contrast minimum.
- Do not rely on color alone for phase/gate status; pair color with icon, label, and ARIA text.
- Keyboard-navigable decision modals, side panels, artifact viewer, and timeline.
- Gate modals need focus trapping, return-focus behavior, double-submit prevention, and stale-state announcement.
- Screen-reader-friendly timeline as a semantic ordered stepper with phase state labels.
- Live run/persona updates should use polite ARIA live regions.
- Plain-language mode by default; technical detail expandable.
- Respect reduced motion settings.
- Provide downloadable/exportable artifacts for offline review.

## 9. First prototype scope

### Prototype goal

Build a believable web cockpit prototype that proves the product wedge: visible factory process where conversation, personas, artifacts, and approvals are first-class. The prototype does not need real app-building yet. It should feel like the web UX that can later connect to the existing event-sourced factory DTOs.

A user testing the prototype should feel guided, safe, and able to explain the project state in plain English.

### Build first

1. **Landing page with cockpit preview**
   - Position the product around guided factory collaboration.

2. **Workspace dashboard**
   - Show project cards, decision-needed banner, empty state.

3. **New project wizard**
   - Capture idea and produce mocked Idea Brief.

4. **Project factory cockpit**
   - Core three-column layout.
   - Timeline for the nine target phases:
     1. Intake / idea shaping
     2. Planning / product clarification
     3. Design review
     4. Implementation/build
     5. Code review / quality review
     6. Browser QA
     7. Fix loop
     8. Ship readiness
     9. Final build/handoff package

5. **Phase workspace**
   - Mock conversation for one active phase.
   - Include action cards, artifact cards, and a decision card.

6. **Artifact detail view**
   - Mock Product Plan, QA Report, Build Summary, Ship Readiness artifacts.

7. **Gate decision modal**
   - Approve MVP scope.
   - Approve safe local changes.
   - Approve browser QA.
   - Accept ship-readiness handoff.

8. **QA evidence view**
   - Mock browser scenarios, screenshots, pass/fail matrix, fix recommendation.

9. **Ship-readiness checklist**
   - Mock readiness status and handoff bundle.

10. **Project safety settings**
    - Show safety mode cards and explanations.

### Recommended route/screen list

P0 prototype routes:

- `/` — landing page.
- `/signup` — account and workspace onboarding.
- `/app` — workspace dashboard.
- `/app/projects/new` — new project wizard.
- `/app/projects/:projectId` — factory cockpit default.
- `/app/projects/:projectId/artifacts/:artifactId` — artifact detail.
- `/app/projects/:projectId/qa` — QA/browser evidence.

P1 routes:

- `/app/projects` — project list.
- `/app/projects/:projectId/phases/:phaseId` — focused phase workspace, optional route alias.
- `/app/projects/:projectId/artifacts` — artifact library.
- `/app/projects/:projectId/decisions` — decision history and pending gates.
- `/app/projects/:projectId/ship-readiness` — readiness checklist.
- `/app/projects/:projectId/settings/safety` — safety controls.

P2/stub routes:

- `/app/settings` — workspace settings.
- `/app/billing` — billing/usage placeholder.
- `/app/team` — team and approver routing placeholder.
- `/app/activity` — cross-project factory activity placeholder.

### What can be mocked

- Authentication and billing.
- Project data store.
- Persona outputs.
- Browser QA evidence, screenshots, and traces.
- Build/fix summaries and diffs.
- Ship-readiness checklist.
- Handoff package/export.
- Live factory execution.

Mock data should still use shapes inspired by the current factory contracts: workflows, phases, roles, artifacts, gates, risks, status, progress, and policy. Mark prototype-only phases clearly so the UI does not imply current backend support for end-to-end deployment.

### What should connect to existing factory DTOs later

- Project cockpit status → `FactoryRunStatusDto`.
- Phase rail → `FactoryRunPlan.phases`, `completedPhaseIds`, `currentPhase`, `progress`.
- Artifacts → `ArtifactRef`, `FactoryArtifactSummaryDto`, `FactoryArtifactDto`.
- Gates/decisions → `FactoryGateInfoDto`, `FactoryGateDecisionInput`.
- Safety badges → `PolicySpec`, `RiskFinding`, `CommandSafetyProfile`.
- Run list/dashboard → `FactoryRunListItemDto` plus project metadata.
- QA evidence → `qa-report`, `screenshot`, and `browser-trace` artifact kinds.
- Ship readiness → ship-readiness workflow gates and release-note/test-result/pr artifacts.

DTO extensions likely needed for the web layer:

- Project wrapper fields: `workspaceId`, `projectId`, project name, user-facing project status, active run ids.
- Resume fields: next action, active persona, supporting personas, user-facing pause reason.
- Artifact fields: display title, subtype, status, version, linked gate ids, content type, binary/URL evidence support.
- Gate fields: supporting artifact ids, safety impact, what happens next, deadline/expiry, current approver permissions.
- Activity fields: timestamp, actor/persona, human-readable event, technical event reference.

### Future web API shape

The web app can wrap the existing run facade with project-scoped endpoints:

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:projectId`
- `POST /api/projects/:projectId/runs`
- `GET /api/projects/:projectId/runs`
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/continue`
- `GET /api/runs/:runId/events` or stream via SSE/WebSocket
- `GET /api/runs/:runId/artifacts`
- `GET /api/runs/:runId/artifacts/:artifactId`
- `GET /api/runs/:runId/gates`
- `POST /api/runs/:runId/gates/:gateId/decisions`
- `GET /api/projects/:projectId/decision-queue`
- `GET /api/projects/:projectId/activity`
- `GET /api/projects/:projectId/resume`
- `GET/PUT /api/projects/:projectId/safety-policy`

### Prototype acceptance criteria

- A non-technical user can explain what phase they are in and what happens next.
- The cockpit makes artifacts and approvals as visible as chat.
- The user can distinguish read-only work, browser QA, local fixes, and release/deploy locks.
- Personas feel like useful roles with boundaries, not mascots.
- The prototype clearly differs from an IDE, sandbox, or prompt-only builder.

## 10. Open product questions

1. **Project source**: does the first web product create apps from scratch, connect to an existing repo, or support both?
2. **Artifact ownership**: are artifacts customer-facing deliverables, internal run records, or both?
3. **Implementation boundary**: when the factory builds, does it write to a repo, generate a downloadable bundle, open a PR, or hand off to another build service?
4. **Deployment promise**: will the product eventually deploy apps, or only prepare handoff/readiness in early versions?
5. **User permissions**: who can approve write-capable automation, browser QA, network/CI access, and release actions in a team workspace?
6. **Safety defaults**: should browser QA require explicit per-run approval, or can a workspace enable it by default?
7. **Persona control**: can users summon a specific persona, or should personas appear only as the workflow requires?
8. **Transcript retention**: how long are conversation transcripts, browser traces, screenshots, and artifacts retained?
9. **Technical detail mode**: should the UI default to simple language with a global “show technical detail” preference?
10. **External integrations**: which integrations matter first: GitHub repo, preview URL, CI provider, deployment provider, issue tracker, design tool?
11. **Pricing unit**: should billing be by project, factory run, phase, artifact, automation minutes, or team seats?
12. **Human handoff**: should the app support exporting a complete handoff package for a human developer or agency?
13. **Templates**: should templates be app-type templates, business-goal templates, or phase-process templates?
14. **Evidence standard**: what evidence is required before the UI can call a phase complete, especially QA and ship readiness?
15. **Recovery model**: how should users see and resolve stuck external work, stale approvals, failed browser sessions, or missing artifacts?
16. **Speed promise**: what should a user expect after 5 minutes, one session, one day, and one full factory pass?
17. **Stop recommendation**: when should the product recommend “do not build this yet” or “narrow scope first”?
18. **Shareability**: what can a user share with a stakeholder who never logs in?
19. **QA/fix run model**: is the fix loop a continuation of a QA run, a linked child run, or a new run in the same project?
20. **Evidence retention**: how should screenshots, browser traces, event logs, and recovery/quarantine records be retained, redacted, or deleted?

## Design north star

The web app should make the factory feel like a trustworthy production system for normal people. The user should always know:

- what is happening now;
- which persona is working;
- what authority that persona has;
- what decision is needed from the user;
- what artifact was produced;
- what evidence supports it;
- what safety boundary is active;
- what happens next.

If the UI succeeds, “chat” becomes only one part of the experience. The product becomes a visible, guided factory cockpit for turning intent into app-building progress with artifacts, reviews, QA evidence, and safe approvals at every meaningful step.
