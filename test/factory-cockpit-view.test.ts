import { describe, expect, test } from 'bun:test';
import type { FactoryRunStatusDto } from '../lib/factory';
import {
  createFactoryProjectFacade,
  type FactoryProjectCatalog,
  type FactoryProjectRecord,
  type FactoryWorkspaceRecord,
} from '../lib/factory-project';
import { FACTORY_QA_FIX_WORKFLOW, FACTORY_QA_WORKFLOW } from '../lib/factory-qa-workflow';
import { FACTORY_REVIEW_WORKFLOW } from '../lib/factory-review-workflow';
import { FACTORY_SHIP_WORKFLOW } from '../lib/factory-ship-workflow';
import {
  buildFactoryCockpitBayMapView,
  buildFactoryCockpitBaySimpleOverviewView,
  buildFactoryCockpitBundle,
  buildFactoryCockpitDashboardView,
  buildFactoryCockpitDetailedView,
  buildFactoryCockpitEasyModeView,
  buildFactoryCockpitGateDecisionView,
  buildFactoryCockpitIdeaWizardView,
  buildFactoryCockpitQAEvidenceView,
  buildFactoryCockpitShipReadinessView,
  FACTORY_COCKPIT_PRODUCT_NAME,
  FACTORY_COCKPIT_QA_AUDIT_BANNER,
  FACTORY_COCKPIT_QA_FIX_BANNER,
  FACTORY_COCKPIT_SHIP_DISCLAIMER,
  FACTORY_COCKPIT_SUCCESS_LABEL,
} from '../lib/factory-cockpit-view';

const WORKFLOWS = [
  FACTORY_REVIEW_WORKFLOW,
  FACTORY_QA_WORKFLOW,
  FACTORY_QA_FIX_WORKFLOW,
  FACTORY_SHIP_WORKFLOW,
];

const WORKSPACE: FactoryWorkspaceRecord = {
  workspaceId: 'workspace-cockpit',
  name: "Maya's Studio",
  ownerName: 'Maya',
};

// --- Fixture 1: new idea with Easy Mode (no linked runs yet) ----------------
const IDEA_PROJECT: FactoryProjectRecord = {
  projectId: 'project-new-idea',
  workspaceId: WORKSPACE.workspaceId,
  name: 'Tutor Match',
  oneLineGoal: 'Match tutors and students nearby',
  experienceMode: 'easy',
  cockpitLayer: 'simple',
  linkedRuns: [],
};

// --- Fixture 2: active build with no decision needed ------------------------
const ACTIVE_BUILD_STATUS: FactoryRunStatusDto = {
  runId: 'run-active-build',
  workflowId: 'review',
  workflowTitle: 'Structured Review',
  mode: 'review',
  goal: 'Build Tutor Match feature',
  status: 'running',
  createdAt: '2026-05-20T09:00:00.000Z',
  updatedAt: '2026-05-20T09:30:00.000Z',
  currentPhase: { id: 'diff-review', title: 'Diff Review' },
  progress: { completed: 1, total: 3 },
  completedPhaseIds: ['review-intake'],
  artifacts: [
    { id: 'plan-artifact', kind: 'plan', phaseId: 'review-intake', summary: 'Build plan' },
  ],
  gates: [],
  risks: [],
};

const ACTIVE_BUILD_PROJECT: FactoryProjectRecord = {
  projectId: 'project-active-build',
  workspaceId: WORKSPACE.workspaceId,
  name: 'Tutor Match',
  oneLineGoal: 'Build the matchmaking flow',
  primaryRunId: 'run-active-build',
  linkedRuns: [{ runId: 'run-active-build', workflowId: 'review', relationship: 'primary' }],
  experienceMode: 'hands-on',
  cockpitLayer: 'detailed',
};

// --- Fixture 3: decision-needed gate ----------------------------------------
const DECISION_STATUS: FactoryRunStatusDto = {
  runId: 'run-pending-gate',
  workflowId: 'review',
  workflowTitle: 'Structured Review',
  mode: 'review',
  goal: 'Approve the structured review',
  status: 'paused',
  pause: { kind: 'gate', phaseId: 'diff-review', gateIds: ['approve-review'] },
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:15:00.000Z',
  currentPhase: { id: 'diff-review', title: 'Diff Review' },
  progress: { completed: 1, total: 3 },
  completedPhaseIds: ['review-intake'],
  artifacts: [
    { id: 'diff-review-artifact', kind: 'review', phaseId: 'diff-review', summary: 'Diff review artifact' },
  ],
  gates: [{
    id: 'approve-review',
    phaseId: 'diff-review',
    title: 'Approve review findings',
    description: 'Approve the current review findings.',
    kind: 'human-decision',
    failClosed: true,
    status: 'pending',
    requestSequence: 11,
    allowedDecisions: ['approve', 'reject', 'cancel'],
    recommendation: 'approve',
  }],
  risks: [],
};

const DECISION_PROJECT: FactoryProjectRecord = {
  projectId: 'project-decision-needed',
  workspaceId: WORKSPACE.workspaceId,
  name: 'Bakery POS',
  oneLineGoal: 'Approve the review findings',
  primaryRunId: 'run-pending-gate',
  linkedRuns: [{ runId: 'run-pending-gate', workflowId: 'review', relationship: 'primary' }],
  experienceMode: 'hands-on',
  cockpitLayer: 'detailed',
};

// --- Fixture 4: QA audit with evidence --------------------------------------
const QA_AUDIT_STATUS: FactoryRunStatusDto = {
  runId: 'run-qa-audit',
  workflowId: 'qa',
  workflowTitle: 'Structured QA Audit',
  mode: 'review',
  goal: 'Audit Tutor Match browser flows',
  status: 'running',
  createdAt: '2026-05-20T11:00:00.000Z',
  updatedAt: '2026-05-20T11:10:00.000Z',
  currentPhase: { id: 'qa-execution', title: 'QA Execution' },
  progress: { completed: 1, total: 3 },
  completedPhaseIds: ['qa-intake'],
  artifacts: [
    {
      id: 'qa-report-1',
      kind: 'qa-report',
      phaseId: 'qa-execution',
      summary: '3 of 5 browser scenarios passed.',
      path: '/tmp/factory/run-qa-audit/artifacts/qa-report-1.md',
    },
    {
      id: 'qa-screenshot-1',
      kind: 'screenshot',
      phaseId: 'qa-execution',
      summary: 'Login failure screenshot.',
    },
  ],
  gates: [],
  risks: [],
};

const QA_AUDIT_PROJECT: FactoryProjectRecord = {
  projectId: 'project-qa-audit',
  workspaceId: WORKSPACE.workspaceId,
  name: 'Tutor Match',
  oneLineGoal: 'Audit the build with browser QA',
  primaryRunId: 'run-qa-audit',
  linkedRuns: [{ runId: 'run-qa-audit', workflowId: 'qa', relationship: 'qa-audit' }],
  experienceMode: 'hands-on',
  cockpitLayer: 'detailed',
};

// --- Fixture 5: QA fix loop (post-approval) ---------------------------------
const QA_FIX_STATUS: FactoryRunStatusDto = {
  runId: 'run-qa-fix',
  workflowId: 'qa-fix',
  workflowTitle: 'Structured QA Fix',
  mode: 'review',
  goal: 'Apply safe local fixes',
  status: 'running',
  createdAt: '2026-05-20T11:30:00.000Z',
  updatedAt: '2026-05-20T11:40:00.000Z',
  currentPhase: { id: 'qa-execution', title: 'QA Fix Execution' },
  progress: { completed: 1, total: 3 },
  completedPhaseIds: ['qa-intake'],
  artifacts: [
    {
      id: 'qa-fix-report',
      kind: 'qa-report',
      phaseId: 'qa-execution',
      summary: 'Fix loop in progress.',
    },
  ],
  gates: [],
  risks: [],
};

const QA_FIX_PROJECT: FactoryProjectRecord = {
  projectId: 'project-qa-fix',
  workspaceId: WORKSPACE.workspaceId,
  name: 'Bakery POS',
  oneLineGoal: 'Apply approved safe local fixes',
  primaryRunId: 'run-qa-fix',
  linkedRuns: [{ runId: 'run-qa-fix', workflowId: 'qa-fix', relationship: 'qa-fix' }],
  experienceMode: 'hands-on',
  cockpitLayer: 'detailed',
};

// --- Fixture 6: ship readiness / ready for handoff --------------------------
const SHIP_STATUS: FactoryRunStatusDto = {
  runId: 'run-ship-ready',
  workflowId: 'ship',
  workflowTitle: 'Structured Ship Readiness',
  mode: 'ship',
  goal: 'Prepare handoff bundle',
  status: 'completed',
  createdAt: '2026-05-20T12:00:00.000Z',
  updatedAt: '2026-05-20T12:30:00.000Z',
  progress: { completed: 5, total: 5 },
  completedPhaseIds: [
    'ship-intake',
    'ship-readiness',
    'ship-publication-readiness',
    'ship-release-gate',
    'ship-summary',
  ],
  artifacts: [
    {
      id: 'release-note-final',
      kind: 'release-note',
      phaseId: 'ship-summary',
      summary: 'Handoff bundle is ready.',
    },
  ],
  gates: [],
  risks: [],
  resultSummary: 'Ready for handoff. No deploy action was executed.',
};

const SHIP_PROJECT: FactoryProjectRecord = {
  projectId: 'project-ship-ready',
  workspaceId: WORKSPACE.workspaceId,
  name: 'Wedding Site',
  oneLineGoal: 'Package the handoff bundle',
  primaryRunId: 'run-ship-ready',
  linkedRuns: [{ runId: 'run-ship-ready', workflowId: 'ship', relationship: 'ship-readiness' }],
  experienceMode: 'easy',
  cockpitLayer: 'simple',
};

const PROJECTS: readonly FactoryProjectRecord[] = [
  IDEA_PROJECT,
  ACTIVE_BUILD_PROJECT,
  DECISION_PROJECT,
  QA_AUDIT_PROJECT,
  QA_FIX_PROJECT,
  SHIP_PROJECT,
];

const STATUSES = new Map<string, FactoryRunStatusDto>([
  ['run-active-build', ACTIVE_BUILD_STATUS],
  ['run-pending-gate', DECISION_STATUS],
  ['run-qa-audit', QA_AUDIT_STATUS],
  ['run-qa-fix', QA_FIX_STATUS],
  ['run-ship-ready', SHIP_STATUS],
]);

function catalog(): FactoryProjectCatalog {
  return {
    listWorkspaces() { return [WORKSPACE]; },
    listProjects(workspaceId) {
      return workspaceId
        ? PROJECTS.filter(project => project.workspaceId === workspaceId)
        : PROJECTS;
    },
    readProject(projectId) {
      return PROJECTS.find(project => project.projectId === projectId) ?? null;
    },
  };
}

function projectFacade() {
  return createFactoryProjectFacade({
    factory: {
      async readFactoryRunStatus(runId: string) {
        const status = STATUSES.get(runId);
        if (!status) throw new Error(`Unknown run '${runId}'`);
        return status;
      },
    },
    catalog: catalog(),
    workflows: WORKFLOWS,
  });
}

describe('factory cockpit view models', () => {
  describe('dashboard view (Alpha 1 / Beta 1 dashboard fixture)', () => {
    test('surfaces decision banner, resume hero, and per-project cards with provenance', async () => {
      const facade = projectFacade();
      const [workspace] = await facade.listFactoryWorkspaces();
      const projects = await facade.listFactoryProjects({ workspaceId: workspace.workspaceId });
      const view = buildFactoryCockpitDashboardView({ workspace, projects });

      expect(view.screenId).toBe('dashboard');
      expect(view.productName).toBe(FACTORY_COCKPIT_PRODUCT_NAME);
      expect(view.title).toContain(FACTORY_COCKPIT_PRODUCT_NAME);
      expect(view.subtitle).toBe('Build anything in the universe with Universe AI.');
      expect(view.workspaceProvenance.source).toBe('persisted');

      // Decision banner is wrapper-derived from the pending gate queue.
      expect(view.decisionBanner).toBeDefined();
      expect(view.decisionBanner!.provenance.source).toBe('wrapper-derived');
      expect(view.decisionBanner!.items).toHaveLength(1);
      expect(view.decisionBanner!.items[0]).toMatchObject({
        projectId: 'project-decision-needed',
        recommendedAction: 'Approve review findings',
        runId: 'run-pending-gate',
        gateId: 'approve-review',
      });

      // Resume hero should land on the decision project (highest priority).
      expect(view.resumeHero.projectId).toBe('project-decision-needed');
      expect(view.resumeHero.provenance.source).toBe('wrapper-derived');
      expect(view.resumeHero.headline).toContain('waiting for your decision');

      // Project cards carry status labels in common-user language.
      const decisionCard = view.projectCards.find(card => card.projectId === 'project-decision-needed');
      expect(decisionCard?.statusLabel).toBe('Decision needed');
      expect(decisionCard?.statusTone).toBe('decision');
      expect(decisionCard?.safetyBadge.label).toBe('Read-only audit');
      expect(decisionCard?.provenance.source).toBe('wrapper-derived');

      const shipCard = view.projectCards.find(card => card.projectId === 'project-ship-ready');
      expect(shipCard?.statusLabel).toBe(FACTORY_COCKPIT_SUCCESS_LABEL);
      expect(shipCard?.statusTone).toBe('handoff');
      // Copy lock: success label is "Ready for handoff", never "deployed".
      expect(shipCard?.statusLabel.toLowerCase()).not.toContain('deploy');

      const ideaCard = view.projectCards.find(card => card.projectId === 'project-new-idea');
      expect(ideaCard?.statusLabel).toBe('Drafting the idea');

      const qaAuditCard = view.projectCards.find(card => card.projectId === 'project-qa-audit');
      expect(qaAuditCard?.safetyBadge.label).toBe('Browser QA audit');

      const qaFixCard = view.projectCards.find(card => card.projectId === 'project-qa-fix');
      expect(qaFixCard?.safetyBadge.label).toBe('Safe local fixes');
      expect(qaFixCard?.safetyBadge.allowWrites).toBe(true);
    });

    test('empty workspace renders an idea-first empty state', () => {
      const view = buildFactoryCockpitDashboardView({
        workspace: {
          workspaceId: 'workspace-empty',
          name: 'Empty Studio',
          projectCount: 0,
          pendingDecisionCount: 0,
          safetyDefaults: {
            state: 'read-only-audit',
            commandSafetyProfile: 'read-only',
            allowWrites: false,
            allowBrowser: false,
            allowNetwork: false,
            plainLanguageSummary: 'Read-only.',
            blockedExamples: [],
          },
        },
        projects: [],
      });

      expect(view.decisionBanner).toBeUndefined();
      expect(view.projectCards).toEqual([]);
      expect(view.emptyState).toMatch(/No projects yet/);
      expect(view.resumeHero.headline).toBe('Start an idea');
      expect(view.resumeHero.provenance.source).toBe('wrapper-derived');
    });
  });

  describe('idea wizard view (Beta 1 new-idea fixture)', () => {
    test('progresses through capture → audience → outcome → mode without leaving the wizard', () => {
      const empty = buildFactoryCockpitIdeaWizardView({
        workspaceId: WORKSPACE.workspaceId,
        workspaceName: WORKSPACE.name,
        draft: {},
      });
      expect(empty.currentStep).toBe('capture-idea');
      expect(empty.readyForStart).toBe(false);
      expect(empty.recommendedAction).toBe('Answer the next question');
      expect(empty.ideaBriefPreview.headline).toBe('Idea brief preview');
      expect(empty.questionsProvenance.source).toBe('mocked');
      expect(empty.draftProvenance.source).toBe('persisted');
      expect(empty.modePicker.options).toHaveLength(2);
      expect(empty.modePicker.options[0]).toMatchObject({ mode: 'easy', recommended: true });

      const partial = buildFactoryCockpitIdeaWizardView({
        workspaceId: WORKSPACE.workspaceId,
        workspaceName: WORKSPACE.name,
        draft: { title: 'Tutor Match', audience: 'Tutors near campus' },
      });
      expect(partial.currentStep).toBe('shape-outcome');
      expect(partial.ideaBriefPreview.bullets).toContain('Working name: Tutor Match');
      expect(partial.ideaBriefPreview.bullets).toContain('Audience: Tutors near campus');

      const ready = buildFactoryCockpitIdeaWizardView({
        workspaceId: WORKSPACE.workspaceId,
        workspaceName: WORKSPACE.name,
        draft: {
          title: 'Tutor Match',
          oneLineGoal: 'Match tutors with students near them.',
          audience: 'Local tutors and students',
          outcome: 'Faster, calmer scheduling',
          experienceMode: 'easy',
        },
      });
      expect(ready.currentStep).toBe('ready');
      expect(ready.readyForStart).toBe(true);
      expect(ready.recommendedAction).toBe('Start the project in Easy Mode');
      expect(ready.modePicker.selectedMode).toBe('easy');
    });
  });

  describe('Easy Mode home (Alpha 1 calm surface)', () => {
    test('renders right-now card, calm-state attention, and mocked handled feed', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-active-build');
      const cockpit = await facade.readFactoryProjectCockpit('project-active-build');
      const view = buildFactoryCockpitEasyModeView({ project, cockpit });

      expect(view.screenId).toBe('easy-mode-home');
      expect(view.rightNowCard.provenance.source).toBe('wrapper-derived');
      expect(view.rightNowCard.detail).toBe('Right now: Diff Review');
      expect(view.attentionState.headline).toBe('Nothing needs you right now.');
      expect(view.handledFeed.items).toEqual([]);
      expect(view.handledFeed.provenance.source).toBe('mocked');
      expect(view.detailsHandle.label).toBe('Open the factory floor');
      expect(view.modePill.currentMode).toBe('hands-on');
      expect(view.safetyBadge.state).toBe('read-only-audit');
    });

    test('blocks hands-on → easy switch when a decision is pending', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-decision-needed');
      const cockpit = await facade.readFactoryProjectCockpit('project-decision-needed');
      const view = buildFactoryCockpitEasyModeView({ project, cockpit });

      expect(view.modePill.pendingDecisionCount).toBe(1);
      expect(view.modePill.canSwitchToEasy).toBe(false);
      expect(view.attentionState.detail).toBe('Universe is holding the run until you decide.');
    });
  });

  describe('Hands-on 3-bay map', () => {
    test('marks active bay and surfaces crew/output labels for each bay card', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-decision-needed');
      const cockpit = await facade.readFactoryProjectCockpit('project-decision-needed');
      const view = buildFactoryCockpitBayMapView({ project, cockpit });

      expect(view.activeBayId).toBe('workshop');
      const workshop = view.cards.find(card => card.bayId === 'workshop');
      expect(workshop).toMatchObject({
        verb: 'Build it',
        roomName: 'Workshop',
        statusLabel: 'Active',
        active: true,
        locked: false,
      });
      expect(workshop?.crew).toContain('GStack Reviewer');
      expect(workshop?.expectedOutputs).toContain('Reviewed change');

      const showroom = view.cards.find(card => card.bayId === 'showroom');
      expect(showroom?.locked).toBe(true);
      expect(showroom?.statusLabel).toBe('Locked');

      const drawingRoom = view.cards.find(card => card.bayId === 'drawing-room');
      // The fixture has no drawing-room runs, so it shows complete (earlier in journey).
      expect(drawingRoom?.statusLabel).toBe('Complete');
    });
  });

  describe('Bay simple overview', () => {
    test('summarizes right-now state and links into the detailed cockpit', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-qa-audit');
      const cockpit = await facade.readFactoryProjectCockpit('project-qa-audit');
      const view = buildFactoryCockpitBaySimpleOverviewView({ project, cockpit });

      expect(view.bayId).toBe('showroom');
      expect(view.rightNow.detail).toBe('Right now: QA Execution');
      expect(view.latestArtifact?.artifactId).toBe('qa-report-1');
      // qa-report-1 has trusted path -> trusted-local label.
      expect(view.latestArtifact?.safetyLabel).toBe('trusted-local');
      expect(view.detailsHandle.label).toBe('Open detailed cockpit');
      expect(view.safetyBadge.state).toBe('browser-qa-audit');
    });
  });

  describe('Detailed cockpit', () => {
    test('builds a timeline with current-phase markers and contract-backed provenance', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-decision-needed');
      const cockpit = await facade.readFactoryProjectCockpit('project-decision-needed');
      const view = buildFactoryCockpitDetailedView({ project, cockpit });

      expect(view.activeRun?.workflowTitle).toBe('Structured Review');
      expect(view.activeRun?.statusLabel).toBe('Waiting on a decision');
      expect(view.activeRun?.provenance.source).toBe('contract-backed');

      const currentPhase = view.timeline.phases.find(phase => phase.isCurrent);
      expect(currentPhase?.phaseId).toBe('diff-review');
      expect(currentPhase?.statusLabel).toBe('Waiting on you');

      expect(view.conversationWorkspace.phaseTitle).toBe('Diff Review');
      expect(view.conversationWorkspace.activePersona?.title).toBe('GStack Review');
      expect(view.conversationWorkspace.provenance.source).toBe('contract-backed');

      expect(view.featuredArtifact?.artifactId).toBe('diff-review-artifact');
      expect(view.featuredArtifact?.safetyLabel).toBe('metadata-only');

      expect(view.decisionQueue.items[0]).toMatchObject({
        projectId: 'project-decision-needed',
        gateId: 'approve-review',
      });
      expect(view.decisionQueue.provenance.source).toBe('wrapper-derived');

      expect(view.nextAction.kind).toBe('decision');
      expect(view.nextAction.label).toBe('Approve review findings');
    });
  });

  describe('Gate decision surface', () => {
    test('hydrates plain-language decision, safety impact, and state envelope', async () => {
      const facade = projectFacade();
      const cockpit = await facade.readFactoryProjectCockpit('project-decision-needed');
      const decision = cockpit.pendingDecision;
      expect(decision).toBeDefined();
      const view = buildFactoryCockpitGateDecisionView(decision!);

      expect(view.screenId).toBe('gate-decision');
      expect(view.decisionId).toBe('run-pending-gate:approve-review:11');
      expect(view.requestSequence).toBe(11);
      expect(view.allowedDecisions).toEqual(['approve', 'reject', 'cancel']);
      expect(view.recommendation).toBe('approve');
      expect(view.safetyImpact.label).toBe('Read-only audit');
      expect(view.safetyImpact.blockedExamples).toContain('file edits');
      expect(view.whatUniverseWillDo).toMatch(/records the decision/i);
      expect(view.whatUniverseCannotDo).toContain('file edits');
      expect(view.states).toEqual({
        canLoad: true,
        canBecomeStale: true,
        canConflict: true,
        canBePermissionBlocked: true,
        preventsDoubleSubmit: true,
      });
      expect(view.provenance.source).toBe('contract-backed');
    });
  });

  describe('QA evidence panel', () => {
    test('audit mode banner stays "no code changes" and exposes fix-loop CTA', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-qa-audit');
      const cockpit = await facade.readFactoryProjectCockpit('project-qa-audit');
      const view = buildFactoryCockpitQAEvidenceView({ project, cockpit });

      expect(view.mode).toBe('audit');
      expect(view.banner).toBe(FACTORY_COCKPIT_QA_AUDIT_BANNER);
      expect(view.banner).toMatch(/no code changes/);
      expect(view.scenarios.items.map(item => item.artifactId)).toEqual(
        expect.arrayContaining(['qa-report-1', 'qa-screenshot-1']),
      );
      expect(view.fixLoopCta?.headline).toBe('Start a safe local fix loop');
      expect(view.fixLoopCta?.disclaimer).toMatch(/does not deploy/i);
      expect(view.safetyBadge.state).toBe('browser-qa-audit');
    });

    test('fix mode flips the banner and hides the fix-loop CTA', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-qa-fix');
      const cockpit = await facade.readFactoryProjectCockpit('project-qa-fix');
      const view = buildFactoryCockpitQAEvidenceView({ project, cockpit });

      expect(view.mode).toBe('fix');
      expect(view.banner).toBe(FACTORY_COCKPIT_QA_FIX_BANNER);
      expect(view.fixLoopCta).toBeUndefined();
      expect(view.safetyBadge.state).toBe('safe-local-fixes');
      // Audit and fix must read as different states.
      expect(view.banner).not.toBe(FACTORY_COCKPIT_QA_AUDIT_BANNER);
    });
  });

  describe('Ship readiness / handoff', () => {
    test('always carries the no-deployment disclaimer and lands the handoff success label', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-ship-ready');
      const cockpit = await facade.readFactoryProjectCockpit('project-ship-ready');
      const view = buildFactoryCockpitShipReadinessView({ project, cockpit });

      expect(view.disclaimer).toBe(FACTORY_COCKPIT_SHIP_DISCLAIMER);
      expect(view.disclaimer).toMatch(/not deployment/);
      expect(view.successLabel).toBe(FACTORY_COCKPIT_SUCCESS_LABEL);
      expect(view.readyForHandoff).toBe(true);
      expect(view.safetyBadge.state).toBe('release-action-locked');

      // Copy lock: nothing in the rendered checklist should claim deploy/publish.
      for (const item of view.checklist) {
        expect(item.label.toLowerCase()).not.toContain('deploy');
        expect(item.label.toLowerCase()).not.toContain('publish');
      }

      // Release-actions item is always a "complete" copy lock.
      const releaseLocked = view.checklist.find(item => item.group === 'release');
      expect(releaseLocked?.status).toBe('complete');
      expect(releaseLocked?.note).toMatch(/No tag, publish, push, or deploy/);

      // Handoff bundle artifacts come from the ship run only.
      expect(view.handoffBundle.artifactIds).toEqual(['release-note-final']);
      expect(view.nextAction.kind).toBe('handoff');
    });

    test('flags pending checklist items while a decision is still open', async () => {
      const facade = projectFacade();
      const project = await facade.readFactoryProjectSummary('project-decision-needed');
      const cockpit = await facade.readFactoryProjectCockpit('project-decision-needed');
      const view = buildFactoryCockpitShipReadinessView({ project, cockpit });

      expect(view.readyForHandoff).toBe(false);
      const productItem = view.checklist.find(item => item.group === 'product');
      expect(productItem?.status).toBe('pending');
      expect(productItem?.note).toMatch(/decision/);
    });
  });

  describe('aggregate bundle (Beta 1 cockpit journey fixtures)', () => {
    test('packs every screen for the decision-needed fixture with shared provenance discipline', async () => {
      const facade = projectFacade();
      const [workspace] = await facade.listFactoryWorkspaces();
      const workspaceProjects = await facade.listFactoryProjects({ workspaceId: workspace.workspaceId });
      const project = await facade.readFactoryProjectSummary('project-decision-needed');
      const cockpit = await facade.readFactoryProjectCockpit('project-decision-needed');

      const bundle = buildFactoryCockpitBundle({
        workspace,
        workspaceProjects,
        project,
        cockpit,
        ideaDraft: { title: 'Bakery POS' },
      });

      // Each screen carries the canonical id.
      expect(bundle.dashboard.screenId).toBe('dashboard');
      expect(bundle.easyMode.screenId).toBe('easy-mode-home');
      expect(bundle.bayMap.screenId).toBe('bay-map');
      expect(bundle.baySimpleOverview.screenId).toBe('bay-simple-overview');
      expect(bundle.detailedCockpit.screenId).toBe('detailed-cockpit');
      expect(bundle.qaEvidence.screenId).toBe('qa-evidence');
      expect(bundle.shipReadiness.screenId).toBe('ship-readiness');
      expect(bundle.gateDecision?.screenId).toBe('gate-decision');
      expect(bundle.ideaWizard?.screenId).toBe('idea-wizard');

      // Provenance discipline: every screen exposes at least one persisted,
      // contract-backed, or wrapper-derived tag — never silent mocked-only.
      const provenanceSources = new Set<string>([
        bundle.dashboard.workspaceProvenance.source,
        bundle.dashboard.safetyDefaults.provenance.source,
        bundle.easyMode.rightNowCard.provenance.source,
        bundle.bayMap.cards[0].provenance.source,
        bundle.baySimpleOverview.rightNow.provenance.source,
        bundle.detailedCockpit.timeline.provenance.source,
        bundle.qaEvidence.scenarios.provenance.source,
        bundle.shipReadiness.handoffBundle.provenance.source,
      ]);
      expect(provenanceSources.has('persisted')).toBe(true);
      expect(provenanceSources.has('contract-backed')).toBe(true);
      expect(provenanceSources.has('wrapper-derived')).toBe(true);

      // Gate decision must be present when one is pending on the cockpit DTO.
      expect(bundle.gateDecision?.decisionId).toBe('run-pending-gate:approve-review:11');
    });

    test('omits the gate decision screen and idea wizard when neither applies', async () => {
      const facade = projectFacade();
      const [workspace] = await facade.listFactoryWorkspaces();
      const workspaceProjects = await facade.listFactoryProjects({ workspaceId: workspace.workspaceId });
      const project = await facade.readFactoryProjectSummary('project-ship-ready');
      const cockpit = await facade.readFactoryProjectCockpit('project-ship-ready');

      const bundle = buildFactoryCockpitBundle({
        workspace,
        workspaceProjects,
        project,
        cockpit,
      });

      expect(bundle.gateDecision).toBeUndefined();
      expect(bundle.ideaWizard).toBeUndefined();
      expect(bundle.shipReadiness.readyForHandoff).toBe(true);
    });
  });
});
