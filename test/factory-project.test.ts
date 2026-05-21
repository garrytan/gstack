import { describe, expect, test } from 'bun:test';
import type { FactoryRunStatusDto } from '../lib/factory';
import {
  createFactoryProjectFacade,
  type FactoryProjectCatalog,
  type FactoryProjectRecord,
  type FactoryWorkspaceRecord,
} from '../lib/factory-project';
import { FACTORY_QA_FIX_WORKFLOW } from '../lib/factory-qa-workflow';
import { FACTORY_REVIEW_WORKFLOW } from '../lib/factory-review-workflow';
import { FACTORY_SHIP_WORKFLOW } from '../lib/factory-ship-workflow';

const REVIEW_STATUS: FactoryRunStatusDto = {
  runId: 'run-review',
  workflowId: 'review',
  workflowTitle: 'Structured Review',
  mode: 'review',
  goal: 'Review Tutor Match',
  status: 'paused',
  pause: { kind: 'gate', phaseId: 'diff-review', gateIds: ['approve-review'] },
  createdAt: '2026-05-20T09:00:00.000Z',
  updatedAt: '2026-05-20T09:15:00.000Z',
  currentPhase: { id: 'diff-review', title: 'Diff Review' },
  progress: { completed: 1, total: 3 },
  completedPhaseIds: ['review-intake'],
  artifacts: [
    { id: 'review-intake-artifact', kind: 'plan', phaseId: 'review-intake', summary: 'Review intake artifact' },
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
    requestSequence: 7,
    allowedDecisions: ['approve', 'reject', 'cancel'],
    recommendation: 'approve',
  }],
  risks: [],
};

const QA_FIX_STATUS: FactoryRunStatusDto = {
  runId: 'run-qa-fix',
  workflowId: 'qa-fix',
  workflowTitle: 'Structured QA Fix',
  mode: 'review',
  goal: 'Fix Tutor Match QA findings',
  status: 'running',
  createdAt: '2026-05-20T11:00:00.000Z',
  updatedAt: '2026-05-20T11:10:00.000Z',
  currentPhase: { id: 'qa-execution', title: 'QA Fix Execution' },
  progress: { completed: 1, total: 3 },
  completedPhaseIds: ['qa-intake'],
  artifacts: [
    { id: 'qa-report', kind: 'qa-report', phaseId: 'qa-execution', summary: 'Browser QA evidence' },
  ],
  gates: [],
  risks: [],
  resultSummary: 'Applying non-destructive local fixes and preparing regression QA.',
};

const SHIP_STATUS: FactoryRunStatusDto = {
  runId: 'run-ship',
  workflowId: 'ship',
  workflowTitle: 'Structured Ship Readiness',
  mode: 'ship',
  goal: 'Prepare Tutor Match for handoff',
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
    { id: 'ship-summary', kind: 'release-note', phaseId: 'ship-summary', summary: 'Handoff bundle ready' },
  ],
  gates: [],
  risks: [],
  resultSummary: 'Ready for handoff. No deploy action was executed.',
};

const WORKSPACES: readonly FactoryWorkspaceRecord[] = [{
  workspaceId: 'workspace-1',
  name: "Maya's Studio",
  ownerName: 'Maya',
}];

const PROJECTS: readonly FactoryProjectRecord[] = [
  {
    projectId: 'project-review',
    workspaceId: 'workspace-1',
    name: 'Tutor Match',
    oneLineGoal: 'Review the current Tutor Match build',
    primaryRunId: 'run-review',
    linkedRuns: [{ runId: 'run-review', workflowId: 'review', relationship: 'primary' }],
    experienceMode: 'hands-on',
    cockpitLayer: 'detailed',
  },
  {
    projectId: 'project-qa-fix',
    workspaceId: 'workspace-1',
    name: 'Bakery POS',
    oneLineGoal: 'Fix QA issues in Bakery POS',
    primaryRunId: 'run-qa-fix',
    linkedRuns: [{ runId: 'run-qa-fix', workflowId: 'qa-fix', relationship: 'qa-fix' }],
    experienceMode: 'hands-on',
    cockpitLayer: 'detailed',
  },
  {
    projectId: 'project-ship',
    workspaceId: 'workspace-1',
    name: 'Wedding Site',
    oneLineGoal: 'Package the handoff bundle',
    primaryRunId: 'run-ship',
    linkedRuns: [{ runId: 'run-ship', workflowId: 'ship', relationship: 'ship-readiness' }],
    experienceMode: 'easy',
    cockpitLayer: 'simple',
  },
];

function catalog(): FactoryProjectCatalog {
  return {
    listWorkspaces() {
      return WORKSPACES;
    },
    listProjects(workspaceId) {
      return workspaceId ? PROJECTS.filter(project => project.workspaceId === workspaceId) : PROJECTS;
    },
    readProject(projectId) {
      return PROJECTS.find(project => project.projectId === projectId) ?? null;
    },
  };
}

function facade() {
  const statuses = new Map<string, FactoryRunStatusDto>([
    ['run-review', REVIEW_STATUS],
    ['run-qa-fix', QA_FIX_STATUS],
    ['run-ship', SHIP_STATUS],
  ]);
  return createFactoryProjectFacade({
    factory: {
      async readFactoryRunStatus(runId: string) {
        const status = statuses.get(runId);
        if (!status) throw new Error(`Unknown run '${runId}'`);
        return status;
      },
    },
    catalog: catalog(),
    workflows: [FACTORY_REVIEW_WORKFLOW, FACTORY_QA_FIX_WORKFLOW, FACTORY_SHIP_WORKFLOW],
  });
}

describe('factory project workspace wrapper', () => {
  test('projects surface decision-first dashboard summaries and three-bay progress', async () => {
    const projectFacade = facade();

    const summary = await projectFacade.readFactoryProjectSummary('project-review');
    expect(summary).toMatchObject({
      projectId: 'project-review',
      projectStatus: 'reviewing',
      activeRunId: 'run-review',
      activeRunStatus: 'paused',
      pendingDecisionCount: 1,
      currentPhaseId: 'diff-review',
      currentPhaseTitle: 'Diff Review',
      experienceMode: 'hands-on',
      cockpitLayer: 'detailed',
      activePersona: {
        personaId: 'gstack-review',
        title: 'GStack Review',
      },
      nextAction: {
        kind: 'decision',
        label: 'Approve review findings',
      },
      safety: {
        state: 'read-only-audit',
      },
      resumeSummary: {
        kind: 'waiting-for-decision',
      },
      progress: { completed: 1, total: 3 },
      activeRunProgress: { completed: 1, total: 3 },
    });
    expect(summary.bays).toEqual([
      {
        bayId: 'drawing-room',
        title: 'Drawing Room',
        status: 'complete',
        summary: 'Completed earlier in the journey',
        runIds: [],
      },
      {
        bayId: 'workshop',
        title: 'Workshop',
        status: 'active',
        summary: 'Waiting on Diff Review',
        runIds: ['run-review'],
      },
      {
        bayId: 'showroom',
        title: 'Showroom',
        status: 'locked',
        summary: 'Opens after the previous bay',
        runIds: [],
      },
    ]);

    const queue = await projectFacade.listFactoryProjectDecisionQueue({ projectId: 'project-review' });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      decisionId: 'run-review:approve-review:7',
      projectId: 'project-review',
      runId: 'run-review',
      gateId: 'approve-review',
      requestSequence: 7,
      title: 'Approve review findings',
      allowedDecisions: ['approve', 'reject', 'cancel'],
      phaseId: 'diff-review',
      supportingArtifactIds: ['diff-review-artifact'],
      safetyImpact: { state: 'read-only-audit' },
    });

    const cockpit = await projectFacade.readFactoryProjectCockpit('project-review');
    expect(cockpit.simpleOverview).toEqual({
      headline: 'Tutor Match is waiting for your decision',
      currentFocus: 'Right now: Diff Review',
      calmState: '1 decision waiting on you.',
      recommendedAction: 'Approve review findings',
    });
    expect(cockpit.pendingDecision?.decisionId).toBe('run-review:approve-review:7');
  });

  test('qa-fix infers safe local fix safety without mutating run DTOs', async () => {
    const projectFacade = facade();

    const summary = await projectFacade.readFactoryProjectSummary('project-qa-fix');
    expect(summary).toMatchObject({
      projectId: 'project-qa-fix',
      projectStatus: 'fix-loop',
      activeRunStatus: 'running',
      safety: {
        state: 'safe-local-fixes',
        allowWrites: true,
        allowBrowser: true,
        commandSafetyProfile: 'non-destructive-write',
      },
      nextAction: {
        kind: 'watch',
        label: 'Open QA Fix Execution',
      },
    });

    const cockpit = await projectFacade.readFactoryProjectCockpit('project-qa-fix');
    expect(cockpit.featuredArtifact).toMatchObject({
      artifactId: 'qa-report',
      state: 'evidence',
    });
    expect(cockpit.personas[1]).toMatchObject({
      personaId: 'gstack-qa',
      status: 'active',
    });
  });

  test('artifact views expose descriptor summaries with provenance-aware safety labels', async () => {
    const projectFacade = facade();

    const cockpit = await projectFacade.readFactoryProjectCockpit('project-review');
    const intakeView = cockpit.artifacts.find(view => view.artifactId === 'review-intake-artifact');
    expect(intakeView).toBeDefined();
    // Mock artifacts have no path/uri, so the descriptor must collapse to
    // metadata-only without escalating provenance.
    expect(intakeView!.safetyLabel).toBe('metadata-only');
    expect(intakeView!.primaryAction).toBe('inspect-metadata');
    expect(intakeView!.content.primaryKind).toBe('external-uri');
    expect(intakeView!.content.primaryDescriptor.provenance).toEqual({
      source: 'event-metadata',
      trusted: false,
      note: 'Artifact has no trusted content; only summary metadata is available.',
    });
    expect(intakeView!.content.primaryDescriptor.safeUri).toBeUndefined();
  });

  test('trusted artifact-store path drives an open-text descriptor; raw event uri stays metadata-only', async () => {
    const trustedStatus: FactoryRunStatusDto = {
      ...REVIEW_STATUS,
      runId: 'run-trusted',
      artifacts: [
        {
          id: 'review-intake-artifact',
          kind: 'plan',
          phaseId: 'review-intake',
          summary: 'Review intake artifact',
          // path mirrors what FileFactoryArtifactStore returns after attestation:
          // it appears on the summary only after the artifact store hits.
          path: '/tmp/factory/run-trusted/artifacts/review-intake-artifact.md',
          metadata: { createdAt: '2026-05-21T10:00:00.000Z' },
        },
        {
          id: 'diff-review-artifact',
          kind: 'review',
          phaseId: 'diff-review',
          summary: 'Diff review artifact',
          uri: 'https://untrusted.example.test/raw-event-uri',
        },
      ],
      gates: [],
    };
    const trustedProject: FactoryProjectRecord = {
      projectId: 'project-trusted',
      workspaceId: 'workspace-1',
      name: 'Trusted Path Demo',
      oneLineGoal: 'Demonstrate descriptor provenance handling',
      primaryRunId: 'run-trusted',
      linkedRuns: [{ runId: 'run-trusted', workflowId: 'review', relationship: 'primary' }],
      experienceMode: 'hands-on',
      cockpitLayer: 'detailed',
    };
    const facadeWithTrust = createFactoryProjectFacade({
      factory: {
        async readFactoryRunStatus(runId: string) {
          if (runId === 'run-trusted') return trustedStatus;
          throw new Error(`Unknown run '${runId}'`);
        },
      },
      catalog: {
        listWorkspaces: () => WORKSPACES,
        listProjects: () => [trustedProject],
        readProject: (projectId: string) => projectId === trustedProject.projectId ? trustedProject : null,
      },
      workflows: [FACTORY_REVIEW_WORKFLOW, FACTORY_QA_FIX_WORKFLOW, FACTORY_SHIP_WORKFLOW],
    });

    const cockpit = await facadeWithTrust.readFactoryProjectCockpit('project-trusted');
    const trustedView = cockpit.artifacts.find(view => view.artifactId === 'review-intake-artifact');
    expect(trustedView).toBeDefined();
    expect(trustedView!.safetyLabel).toBe('trusted-local');
    expect(trustedView!.primaryAction).toBe('open-text');
    expect(trustedView!.content.primaryKind).toBe('text');
    expect(trustedView!.content.primaryDescriptor).toMatchObject({
      provenance: { source: 'artifact-store', trusted: true },
      hasInlineText: true,
      mediaType: 'text/markdown',
    });
    // The trusted descriptor must never include the raw event uri/path.
    expect(trustedView!.content.primaryDescriptor.safeUri).toBeUndefined();

    const untrustedView = cockpit.artifacts.find(view => view.artifactId === 'diff-review-artifact');
    expect(untrustedView).toBeDefined();
    expect(untrustedView!.safetyLabel).toBe('metadata-only');
    expect(untrustedView!.primaryAction).toBe('inspect-metadata');
    expect(untrustedView!.content.primaryDescriptor.provenance).toEqual({
      source: 'event-metadata',
      trusted: false,
      note: 'Event metadata uri is untrusted until attested by artifact-store or trusted external system.',
    });
    expect(untrustedView!.content.primaryDescriptor.safeUri).toBeUndefined();
  });

  test('ship readiness projects resolve to handoff-ready summaries and workspace resume priority stays decision-first', async () => {
    const projectFacade = facade();

    const summary = await projectFacade.readFactoryProjectSummary('project-ship');
    expect(summary).toMatchObject({
      projectId: 'project-ship',
      experienceMode: 'easy',
      cockpitLayer: 'simple',
      projectStatus: 'ready-for-handoff',
      activeRunStatus: 'completed',
      safety: {
        state: 'release-action-locked',
      },
      nextAction: {
        kind: 'handoff',
        label: 'Export handoff bundle',
      },
      resumeSummary: {
        kind: 'ready-for-handoff',
      },
    });

    const workspaces = await projectFacade.listFactoryWorkspaces();
    expect(workspaces).toEqual([{
      workspaceId: 'workspace-1',
      name: "Maya's Studio",
      ownerName: 'Maya',
      projectCount: 3,
      pendingDecisionCount: 1,
      resumeProjectId: 'project-review',
      safetyDefaults: {
        state: 'read-only-audit',
        commandSafetyProfile: 'read-only',
        allowWrites: false,
        allowBrowser: false,
        allowNetwork: false,
        plainLanguageSummary: 'Universe can inspect project state and produce artifacts. It cannot edit project files in this mode.',
        blockedExamples: ['file edits', 'push', 'deploy'],
      },
    }]);
  });
});
