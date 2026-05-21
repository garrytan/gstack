import {
  DEFAULT_FACTORY_POLICY,
  compileRunPlan,
  type PolicySpec,
  type WorkflowSpec,
} from './factory-core';
import type {
  FactoryArtifactSummaryDto,
  FactoryFacade,
  FactoryGateDecisionValue,
  FactoryGateInfoDto,
  FactoryPublicRunStatus,
  FactoryRunStatusDto,
} from './factory';
import { FACTORY_WORKFLOWS } from './factory-review-workflow';

export type FactoryProjectExperienceMode = 'easy' | 'hands-on';
export type FactoryProjectCockpitLayer = 'simple' | 'detailed';
export type FactoryProjectBayId = 'drawing-room' | 'workshop' | 'showroom';
export type FactoryProjectBayStatus = 'not-started' | 'active' | 'complete' | 'locked';
export type FactoryProjectStage =
  | 'draft-idea'
  | 'planning'
  | 'design-review'
  | 'building'
  | 'reviewing'
  | 'qa-audit'
  | 'fix-loop'
  | 'ship-readiness'
  | 'ready-for-handoff'
  | 'complete';
export type FactoryProjectPauseReason =
  | 'waiting-for-decision'
  | 'waiting-for-external-work'
  | 'running'
  | 'failed-retryable'
  | 'failed-nonretryable'
  | 'ready-for-handoff'
  | 'complete';
export type FactoryProjectNextActionKind = 'decision' | 'watch' | 'resume' | 'artifact' | 'handoff' | 'inspect';
export type FactoryProjectArtifactState = 'produced' | 'needs-review' | 'evidence' | 'accepted-risk';
export type FactoryProjectSafetyStateView =
  | 'read-only-audit'
  | 'browser-qa-audit'
  | 'safe-local-fixes'
  | 'network-ci-allowed'
  | 'release-action-locked'
  | 'blocked-by-policy';
export type FactoryProjectPhaseState =
  | 'not-started'
  | 'running'
  | 'waiting-for-user'
  | 'blocked'
  | 'complete'
  | 'skipped';

interface AwaitableProject<T> extends PromiseLike<T> {}

type Awaitable<T> = T | AwaitableProject<T>;

export interface FactoryWorkspaceRecord {
  readonly workspaceId: string;
  readonly name: string;
  readonly ownerName?: string;
  readonly safetyDefaults?: Partial<PolicySpec>;
}

export interface FactoryProjectRunLink {
  readonly runId: string;
  readonly workflowId?: string;
  readonly relationship?: 'primary' | 'supporting' | 'qa-audit' | 'qa-fix' | 'ship-readiness';
  readonly stage?: FactoryProjectStage;
  readonly bayId?: FactoryProjectBayId;
  readonly policy?: Partial<PolicySpec>;
}

export interface FactoryProjectRecord {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly oneLineGoal: string;
  readonly primaryRunId?: string;
  readonly linkedRuns: readonly FactoryProjectRunLink[];
  readonly experienceMode?: FactoryProjectExperienceMode;
  readonly cockpitLayer?: FactoryProjectCockpitLayer;
}

export interface FactoryProjectCatalog {
  listWorkspaces(): Awaitable<readonly FactoryWorkspaceRecord[]>;
  listProjects(workspaceId?: string): Awaitable<readonly FactoryProjectRecord[]>;
  readProject(projectId: string): Awaitable<FactoryProjectRecord | null>;
}

export interface FactoryProjectPersonaSummaryDto {
  readonly personaId: string;
  readonly title: string;
  readonly runId: string;
  readonly phaseId: string;
}

export interface FactoryProjectNextActionDto {
  readonly kind: FactoryProjectNextActionKind;
  readonly label: string;
  readonly supportingText?: string;
  readonly runId?: string;
  readonly gateId?: string;
  readonly phaseId?: string;
}

export interface FactoryProjectResumeSummaryDto {
  readonly kind: FactoryProjectPauseReason;
  readonly headline: string;
  readonly supportingText: string;
  readonly recommendedAction: string;
  readonly whatHappensNext: string;
}

export interface FactoryProjectSimpleOverviewDto {
  readonly headline: string;
  readonly currentFocus: string;
  readonly calmState: string;
  readonly recommendedAction: string;
}

export interface FactoryProjectSafetyViewDto {
  readonly state: FactoryProjectSafetyStateView;
  readonly commandSafetyProfile: PolicySpec['commandSafetyProfile'];
  readonly allowWrites: boolean;
  readonly allowBrowser: boolean;
  readonly allowNetwork: boolean;
  readonly plainLanguageSummary: string;
  readonly blockedExamples: readonly string[];
}

export interface FactoryProjectBayViewDto {
  readonly bayId: FactoryProjectBayId;
  readonly title: string;
  readonly status: FactoryProjectBayStatus;
  readonly summary: string;
  readonly runIds: readonly string[];
}

export interface FactoryProjectRunLinkDto {
  readonly runId: string;
  readonly relationship: FactoryProjectRunLink['relationship'];
  readonly stage: FactoryProjectStage;
  readonly bayId: FactoryProjectBayId;
  readonly run: FactoryRunStatusDto;
}

export interface FactoryProjectArtifactViewDto {
  readonly projectId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly displayTitle: string;
  readonly state: FactoryProjectArtifactState;
  readonly linkedGateIds: readonly string[];
  readonly artifact: FactoryArtifactSummaryDto;
}

export interface FactoryProjectPhaseViewDto {
  readonly runId: string;
  readonly workflowId: string;
  readonly bayId: FactoryProjectBayId;
  readonly phaseId: string;
  readonly title: string;
  readonly status: FactoryProjectPhaseState;
  readonly personaId: string;
  readonly personaTitle: string;
  readonly objective: string;
  readonly expectedArtifactKinds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly gateIds: readonly string[];
  readonly safetyState: FactoryProjectSafetyStateView;
}

export interface FactoryProjectPersonaViewDto {
  readonly personaId: string;
  readonly title: string;
  readonly responsibility: string;
  readonly currentTask?: string;
  readonly authorityBoundary: string;
  readonly status: 'active' | 'upcoming' | 'complete' | 'blocked';
  readonly outputArtifactKinds: readonly string[];
}

export interface FactoryProjectDecisionQueueItemDto {
  readonly decisionId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly runId: string;
  readonly gateId: string;
  readonly requestSequence: number;
  readonly title: string;
  readonly plainLanguageQuestion: string;
  readonly recommendation?: FactoryGateDecisionValue;
  readonly allowedDecisions: readonly FactoryGateDecisionValue[];
  readonly phaseId: string;
  readonly activePersona?: FactoryProjectPersonaSummaryDto;
  readonly supportingArtifactIds: readonly string[];
  readonly safetyImpact: FactoryProjectSafetyViewDto;
  readonly whatHappensNext: string;
  readonly gate: FactoryGateInfoDto;
}

export interface FactoryWorkspaceSummaryDto {
  readonly workspaceId: string;
  readonly name: string;
  readonly ownerName?: string;
  readonly projectCount: number;
  readonly pendingDecisionCount: number;
  readonly resumeProjectId?: string;
  readonly safetyDefaults: FactoryProjectSafetyViewDto;
}

export interface FactoryProjectSummaryDto {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly oneLineGoal: string;
  readonly experienceMode: FactoryProjectExperienceMode;
  readonly cockpitLayer: FactoryProjectCockpitLayer;
  readonly projectStatus: FactoryProjectStage;
  readonly activeRunId?: string;
  readonly activeRunStatus?: FactoryPublicRunStatus;
  readonly linkedRunIds: readonly string[];
  readonly currentPhaseId?: string;
  readonly currentPhaseTitle?: string;
  readonly activePersona?: FactoryProjectPersonaSummaryDto;
  readonly nextAction: FactoryProjectNextActionDto;
  readonly progress: {
    readonly completed: number;
    readonly total: number;
  };
  readonly activeRunProgress?: {
    readonly completed: number;
    readonly total: number;
  };
  readonly artifactCount: number;
  readonly pendingDecisionCount: number;
  readonly updatedAt?: string;
  readonly bays: readonly FactoryProjectBayViewDto[];
  readonly safety: FactoryProjectSafetyViewDto;
  readonly resumeSummary: FactoryProjectResumeSummaryDto;
}

export interface FactoryProjectCockpitDto {
  readonly project: FactoryProjectSummaryDto;
  readonly activeRun?: FactoryProjectRunLinkDto;
  readonly runs: readonly FactoryProjectRunLinkDto[];
  readonly bays: readonly FactoryProjectBayViewDto[];
  readonly phases: readonly FactoryProjectPhaseViewDto[];
  readonly personas: readonly FactoryProjectPersonaViewDto[];
  readonly pendingDecision?: FactoryProjectDecisionQueueItemDto;
  readonly decisionQueue: readonly FactoryProjectDecisionQueueItemDto[];
  readonly featuredArtifact?: FactoryProjectArtifactViewDto;
  readonly artifacts: readonly FactoryProjectArtifactViewDto[];
  readonly safety: FactoryProjectSafetyViewDto;
  readonly resumeSummary: FactoryProjectResumeSummaryDto;
  readonly simpleOverview: FactoryProjectSimpleOverviewDto;
}

export interface FactoryProjectListOptions {
  readonly workspaceId?: string;
}

export interface FactoryProjectDecisionQueueOptions {
  readonly workspaceId?: string;
  readonly projectId?: string;
}

export interface FactoryProjectFacadeOptions {
  readonly factory: Pick<FactoryFacade, 'readFactoryRunStatus'>;
  readonly catalog: FactoryProjectCatalog;
  readonly workflows?: readonly WorkflowSpec[];
}

export interface FactoryProjectFacade {
  listFactoryWorkspaces(): Promise<readonly FactoryWorkspaceSummaryDto[]>;
  listFactoryProjects(options?: FactoryProjectListOptions): Promise<readonly FactoryProjectSummaryDto[]>;
  readFactoryProjectSummary(projectId: string): Promise<FactoryProjectSummaryDto>;
  readFactoryProjectCockpit(projectId: string): Promise<FactoryProjectCockpitDto>;
  listFactoryProjectDecisionQueue(options?: FactoryProjectDecisionQueueOptions): Promise<readonly FactoryProjectDecisionQueueItemDto[]>;
}

interface ResolvedFactoryProjectRun {
  readonly link: FactoryProjectRunLink;
  readonly workflow: WorkflowSpec;
  readonly stage: FactoryProjectStage;
  readonly bayId: FactoryProjectBayId;
  readonly run: FactoryRunStatusDto;
  readonly plan: ReturnType<typeof compileRunPlan>;
}

interface ResolvedFactoryProject {
  readonly record: FactoryProjectRecord;
  readonly runs: readonly ResolvedFactoryProjectRun[];
  readonly activeRun?: ResolvedFactoryProjectRun;
  readonly safety: FactoryProjectSafetyViewDto;
  readonly bays: readonly FactoryProjectBayViewDto[];
  readonly decisionQueue: readonly FactoryProjectDecisionQueueItemDto[];
  readonly artifacts: readonly FactoryProjectArtifactViewDto[];
  readonly projectStatus: FactoryProjectStage;
  readonly resumeSummary: FactoryProjectResumeSummaryDto;
  readonly nextAction: FactoryProjectNextActionDto;
}

const FACTORY_BAYS: Readonly<Record<FactoryProjectBayId, string>> = Object.freeze({
  'drawing-room': 'Drawing Room',
  workshop: 'Workshop',
  showroom: 'Showroom',
});

export function createFactoryProjectFacade(options: FactoryProjectFacadeOptions): FactoryProjectFacade {
  const workflows = options.workflows ?? FACTORY_WORKFLOWS;

  return {
    async listFactoryWorkspaces() {
      const workspaces = await options.catalog.listWorkspaces();
      const projects = await options.catalog.listProjects();
      const summaries = await Promise.all(workspaces.map(async (workspace) => {
        const workspaceProjects = projects.filter(project => project.workspaceId === workspace.workspaceId);
        const projectSummaries = await Promise.all(workspaceProjects.map(project => readProjectSummary(project, options.factory, workflows)));
        const resumeProject = [...projectSummaries].sort(compareProjectSummaryPriority)[0];
        return {
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          ownerName: workspace.ownerName,
          projectCount: workspaceProjects.length,
          pendingDecisionCount: projectSummaries.reduce((total, project) => total + project.pendingDecisionCount, 0),
          resumeProjectId: resumeProject?.projectId,
          safetyDefaults: safetyViewFromPolicy(workspace.safetyDefaults, undefined),
        } satisfies FactoryWorkspaceSummaryDto;
      }));
      return summaries.sort((left, right) => {
        if (right.pendingDecisionCount !== left.pendingDecisionCount) {
          return right.pendingDecisionCount - left.pendingDecisionCount;
        }
        return left.name.localeCompare(right.name);
      });
    },

    async listFactoryProjects(listOptions = {}) {
      const projects = await options.catalog.listProjects(listOptions.workspaceId);
      const summaries = await Promise.all(projects.map(project => readProjectSummary(project, options.factory, workflows)));
      return summaries.sort(compareProjectSummaryPriority);
    },

    async readFactoryProjectSummary(projectId) {
      const record = await options.catalog.readProject(projectId);
      if (!record) throw new Error(`Factory project '${projectId}' not found`);
      return readProjectSummary(record, options.factory, workflows);
    },

    async readFactoryProjectCockpit(projectId) {
      const record = await options.catalog.readProject(projectId);
      if (!record) throw new Error(`Factory project '${projectId}' not found`);
      return readProjectCockpit(record, options.factory, workflows);
    },

    async listFactoryProjectDecisionQueue(queueOptions = {}) {
      const records = queueOptions.projectId
        ? [await readProjectRecord(options.catalog, queueOptions.projectId)]
        : await options.catalog.listProjects(queueOptions.workspaceId);
      const decisionGroups = await Promise.all(records.map(record => resolveProject(record, options.factory, workflows)));
      return decisionGroups
        .flatMap(project => project.decisionQueue)
        .sort(compareDecisionQueuePriority);
    },
  };
}

async function readProjectRecord(catalog: FactoryProjectCatalog, projectId: string): Promise<FactoryProjectRecord> {
  const record = await catalog.readProject(projectId);
  if (!record) throw new Error(`Factory project '${projectId}' not found`);
  return record;
}

async function readProjectSummary(
  record: FactoryProjectRecord,
  factory: Pick<FactoryFacade, 'readFactoryRunStatus'>,
  workflows: readonly WorkflowSpec[],
): Promise<FactoryProjectSummaryDto> {
  const resolved = await resolveProject(record, factory, workflows);
  return summaryFromResolvedProject(resolved);
}

async function readProjectCockpit(
  record: FactoryProjectRecord,
  factory: Pick<FactoryFacade, 'readFactoryRunStatus'>,
  workflows: readonly WorkflowSpec[],
): Promise<FactoryProjectCockpitDto> {
  const resolved = await resolveProject(record, factory, workflows);
  const project = summaryFromResolvedProject(resolved);
  const runs = resolved.runs.map(run => runLinkDto(run));
  const activeRun = resolved.activeRun ? runLinkDto(resolved.activeRun) : undefined;
  const phases = resolved.activeRun ? phaseViewsFromRun(resolved.activeRun, resolved.safety.state) : [];
  const personas = resolved.activeRun ? personaViewsFromRun(resolved.activeRun, resolved.safety) : [];
  const featuredArtifact = selectFeaturedArtifact(resolved.activeRun, resolved.artifacts, resolved.decisionQueue);
  return {
    project,
    activeRun,
    runs,
    bays: resolved.bays,
    phases,
    personas,
    pendingDecision: resolved.decisionQueue[0],
    decisionQueue: resolved.decisionQueue,
    featuredArtifact,
    artifacts: resolved.artifacts,
    safety: resolved.safety,
    resumeSummary: resolved.resumeSummary,
    simpleOverview: simpleOverviewFromProject(project, resolved.activeRun),
  } satisfies FactoryProjectCockpitDto;
}

async function resolveProject(
  record: FactoryProjectRecord,
  factory: Pick<FactoryFacade, 'readFactoryRunStatus'>,
  workflows: readonly WorkflowSpec[],
): Promise<ResolvedFactoryProject> {
  const runs = await Promise.all(record.linkedRuns.map(link => resolveRun(link, factory, workflows)));
  const activeRun = selectActiveRun(runs, record.primaryRunId);
  const safety = activeRun ? safetyViewFromRun(activeRun) : safetyViewFromPolicy(undefined, undefined);
  const decisionQueue = decisionQueueFromRuns(record, runs);
  const artifacts = artifactViewsFromRuns(record, runs, decisionQueue);
  const projectStatus = projectStatusFromRuns(runs, activeRun);
  const bays = bayViewsFromRuns(runs);
  const resumeSummary = resumeSummaryFromProject(record, activeRun, decisionQueue, projectStatus);
  const nextAction = nextActionFromProject(activeRun, decisionQueue, projectStatus, artifacts);
  return {
    record,
    runs,
    activeRun,
    safety,
    bays,
    decisionQueue,
    artifacts,
    projectStatus,
    resumeSummary,
    nextAction,
  } satisfies ResolvedFactoryProject;
}

async function resolveRun(
  link: FactoryProjectRunLink,
  factory: Pick<FactoryFacade, 'readFactoryRunStatus'>,
  workflows: readonly WorkflowSpec[],
): Promise<ResolvedFactoryProjectRun> {
  const run = await factory.readFactoryRunStatus(link.runId);
  if (link.workflowId && link.workflowId !== run.workflowId) {
    throw new Error(`Factory project run '${link.runId}' expected workflow '${link.workflowId}' but facade returned '${run.workflowId}'`);
  }
  const workflow = workflows.find(candidate => candidate.id === run.workflowId);
  if (!workflow) throw new Error(`Factory workflow '${run.workflowId}' is not registered in the project wrapper`);
  const stage = stageFromRun(link, run);
  const bayId = bayIdFromStage(link.bayId, stage);
  return {
    link,
    workflow,
    stage,
    bayId,
    run,
    plan: compileRunPlan(workflow, {
      workflow: run.workflowId,
      goal: run.goal,
      mode: run.mode,
      policy: link.policy,
    }, run.runId),
  } satisfies ResolvedFactoryProjectRun;
}

function summaryFromResolvedProject(project: ResolvedFactoryProject): FactoryProjectSummaryDto {
  const artifactCount = project.runs.reduce((total, run) => total + run.run.artifacts.length, 0);
  const updatedAt = latestUpdatedAt(project.runs);
  const activePersona = project.activeRun ? activePersonaFromRun(project.activeRun) : undefined;
  return {
    projectId: project.record.projectId,
    workspaceId: project.record.workspaceId,
    name: project.record.name,
    oneLineGoal: project.record.oneLineGoal,
    experienceMode: project.record.experienceMode ?? 'hands-on',
    cockpitLayer: project.record.cockpitLayer ?? 'detailed',
    projectStatus: project.projectStatus,
    activeRunId: project.activeRun?.run.runId,
    activeRunStatus: project.activeRun?.run.status,
    linkedRunIds: project.runs.map(run => run.run.runId),
    currentPhaseId: project.activeRun?.run.currentPhase?.id,
    currentPhaseTitle: project.activeRun?.run.currentPhase?.title,
    activePersona,
    nextAction: project.nextAction,
    progress: bayProgress(project.bays),
    activeRunProgress: project.activeRun ? project.activeRun.run.progress : undefined,
    artifactCount,
    pendingDecisionCount: project.decisionQueue.length,
    updatedAt,
    bays: project.bays,
    safety: project.safety,
    resumeSummary: project.resumeSummary,
  } satisfies FactoryProjectSummaryDto;
}

function stageFromRun(link: FactoryProjectRunLink, run: FactoryRunStatusDto): FactoryProjectStage {
  if (link.stage) return link.stage;
  switch (run.workflowId) {
    case 'review':
      return 'reviewing';
    case 'qa':
      return 'qa-audit';
    case 'qa-fix':
      return 'fix-loop';
    case 'ship':
      return run.status === 'completed' ? 'ready-for-handoff' : 'ship-readiness';
    default:
      return run.status === 'completed' ? 'complete' : 'building';
  }
}

function bayIdFromStage(explicit: FactoryProjectBayId | undefined, stage: FactoryProjectStage): FactoryProjectBayId {
  if (explicit) return explicit;
  switch (stage) {
    case 'planning':
    case 'design-review':
    case 'draft-idea':
      return 'drawing-room';
    case 'building':
    case 'reviewing':
      return 'workshop';
    case 'qa-audit':
    case 'fix-loop':
    case 'ship-readiness':
    case 'ready-for-handoff':
    case 'complete':
      return 'showroom';
  }
}

function selectActiveRun(
  runs: readonly ResolvedFactoryProjectRun[],
  primaryRunId: string | undefined,
): ResolvedFactoryProjectRun | undefined {
  return [...runs].sort((left, right) => compareRunPriority(left, right, primaryRunId))[0];
}

function compareRunPriority(
  left: ResolvedFactoryProjectRun,
  right: ResolvedFactoryProjectRun,
  primaryRunId: string | undefined,
): number {
  const leftRank = runPriority(left, primaryRunId);
  const rightRank = runPriority(right, primaryRunId);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return (right.run.updatedAt ?? '').localeCompare(left.run.updatedAt ?? '');
}

function runPriority(run: ResolvedFactoryProjectRun, primaryRunId: string | undefined): number {
  const pendingGateCount = run.run.gates.filter(gate => gate.status === 'pending').length;
  if (pendingGateCount > 0) return 0;
  if (run.run.status === 'running') return 1;
  if (run.run.status === 'paused' && run.run.pause?.kind === 'external-work') return 2;
  if (run.run.status === 'failed') return 3;
  if (run.run.status === 'paused') return 4;
  if (run.run.status === 'completed' && run.stage === 'ready-for-handoff') return 5;
  if (primaryRunId && run.run.runId === primaryRunId) return 6;
  if (run.run.status === 'completed') return 7;
  return 8;
}

function projectStatusFromRuns(
  runs: readonly ResolvedFactoryProjectRun[],
  activeRun: ResolvedFactoryProjectRun | undefined,
): FactoryProjectStage {
  if (activeRun) return activeRun.stage;
  if (runs.length === 0) return 'draft-idea';
  if (runs.every(run => run.run.status === 'completed')) return 'complete';
  return runs[0]?.stage ?? 'draft-idea';
}

function bayViewsFromRuns(runs: readonly ResolvedFactoryProjectRun[]): readonly FactoryProjectBayViewDto[] {
  const highestKnownIndex = Math.max(-1, ...runs.map(run => bayIndex(run.bayId)));
  return (Object.keys(FACTORY_BAYS) as FactoryProjectBayId[]).map((bayId, index) => {
    const bayRuns = runs.filter(run => run.bayId === bayId);
    const active = bayRuns.find(run => run.run.status === 'running' || run.run.status === 'paused' || run.run.status === 'failed');
    const completed = bayRuns.every(run => run.run.status === 'completed') && bayRuns.length > 0;
    const status: FactoryProjectBayStatus = active
      ? 'active'
      : completed || (bayRuns.length === 0 && highestKnownIndex > index)
        ? 'complete'
        : bayRuns.length === 0 && highestKnownIndex < index
          ? 'locked'
          : bayRuns.length === 0 && index === 0 && highestKnownIndex < 0
            ? 'active'
            : 'not-started';
    return {
      bayId,
      title: FACTORY_BAYS[bayId],
      status,
      summary: baySummary(status, active, bayRuns),
      runIds: bayRuns.map(run => run.run.runId),
    } satisfies FactoryProjectBayViewDto;
  });
}

function baySummary(
  status: FactoryProjectBayStatus,
  activeRun: ResolvedFactoryProjectRun | undefined,
  bayRuns: readonly ResolvedFactoryProjectRun[],
): string {
  if (status === 'active' && activeRun) {
    if (activeRun.run.gates.some(gate => gate.status === 'pending')) {
      return `Waiting on ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}`;
    }
    if (activeRun.run.status === 'failed') {
      return `Blocked in ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}`;
    }
    return `Working in ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}`;
  }
  if (status === 'complete') return bayRuns.length > 0 ? 'Completed linked runs' : 'Completed earlier in the journey';
  if (status === 'locked') return 'Opens after the previous bay';
  return bayRuns.length > 0 ? 'Runs linked but not started' : 'No linked runs yet';
}

function decisionQueueFromRuns(
  project: FactoryProjectRecord,
  runs: readonly ResolvedFactoryProjectRun[],
): readonly FactoryProjectDecisionQueueItemDto[] {
  return runs
    .flatMap(run => run.run.gates
      .filter(gate => gate.status === 'pending')
      .map(gate => decisionItemFromGate(project, run, gate)))
    .sort(compareDecisionQueuePriority);
}

function compareDecisionQueuePriority(
  left: FactoryProjectDecisionQueueItemDto,
  right: FactoryProjectDecisionQueueItemDto,
): number {
  if (right.requestSequence !== left.requestSequence) {
    return right.requestSequence - left.requestSequence;
  }
  return right.runId.localeCompare(left.runId)
    || left.title.localeCompare(right.title);
}

function decisionItemFromGate(
  project: FactoryProjectRecord,
  run: ResolvedFactoryProjectRun,
  gate: FactoryGateInfoDto,
): FactoryProjectDecisionQueueItemDto {
  if (gate.requestSequence === undefined) {
    throw new Error(`Pending factory gate '${gate.id}' for run '${run.run.runId}' is missing requestSequence`);
  }
  const phase = run.plan.phases.find(candidate => candidate.id === gate.phaseId);
  const activePersona = phase ? {
    personaId: phase.role.id,
    title: phase.role.title,
    runId: run.run.runId,
    phaseId: gate.phaseId,
  } satisfies FactoryProjectPersonaSummaryDto : undefined;
  return {
    decisionId: `${run.run.runId}:${gate.id}:${gate.requestSequence}`,
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    projectName: project.name,
    runId: run.run.runId,
    gateId: gate.id,
    requestSequence: gate.requestSequence,
    title: gate.title,
    plainLanguageQuestion: plainLanguageQuestion(gate),
    recommendation: gate.recommendation,
    allowedDecisions: gate.allowedDecisions,
    phaseId: gate.phaseId,
    activePersona,
    supportingArtifactIds: run.run.artifacts.filter(artifact => artifact.phaseId === gate.phaseId).map(artifact => artifact.id),
    safetyImpact: safetyViewFromRun(run),
    whatHappensNext: decisionNextStep(run, gate),
    gate,
  } satisfies FactoryProjectDecisionQueueItemDto;
}

function plainLanguageQuestion(gate: FactoryGateInfoDto): string {
  const description = gate.description.trim();
  if (description.endsWith('?')) return description;
  if (description.length === 0) return `${gate.title}?`;
  return `${gate.title}? ${description}`;
}

function decisionNextStep(run: ResolvedFactoryProjectRun, gate: FactoryGateInfoDto): string {
  if (run.stage === 'fix-loop') {
    return 'Universe applies approved local fixes, records a fix summary, then hands the run back to QA.';
  }
  if (run.stage === 'ship-readiness' || run.stage === 'ready-for-handoff') {
    return 'The ship-readiness run records the decision and advances the handoff checklist. No deploy action is executed.';
  }
  if (run.stage === 'qa-audit') {
    return 'The QA run records the decision and continues collecting browser evidence without editing project files.';
  }
  return `The ${run.run.workflowTitle} run records the decision and continues ${gate.phaseId}.`;
}

function artifactViewsFromRuns(
  project: FactoryProjectRecord,
  runs: readonly ResolvedFactoryProjectRun[],
  decisionQueue: readonly FactoryProjectDecisionQueueItemDto[],
): readonly FactoryProjectArtifactViewDto[] {
  const pendingByRunPhase = new Map<string, Set<string>>();
  for (const decision of decisionQueue) {
    const key = `${decision.runId}:${decision.phaseId}`;
    const phases = pendingByRunPhase.get(key) ?? new Set<string>();
    phases.add(decision.gateId);
    pendingByRunPhase.set(key, phases);
  }
  return runs.flatMap((run) => run.run.artifacts.map((artifact) => {
    const linkedGateIds = [...(pendingByRunPhase.get(`${run.run.runId}:${artifact.phaseId ?? ''}`) ?? [])];
    return {
      projectId: project.projectId,
      runId: run.run.runId,
      artifactId: artifact.id,
      displayTitle: artifactTitle(artifact),
      state: artifactStateFromSummary(run, artifact, linkedGateIds),
      linkedGateIds,
      artifact,
    } satisfies FactoryProjectArtifactViewDto;
  })).sort((left, right) => {
    const leftPending = left.state === 'needs-review' ? 0 : left.state === 'evidence' ? 1 : 2;
    const rightPending = right.state === 'needs-review' ? 0 : right.state === 'evidence' ? 1 : 2;
    if (leftPending !== rightPending) return leftPending - rightPending;
    return left.displayTitle.localeCompare(right.displayTitle);
  });
}

function artifactStateFromSummary(
  run: ResolvedFactoryProjectRun,
  artifact: FactoryArtifactSummaryDto,
  linkedGateIds: readonly string[],
): FactoryProjectArtifactState {
  if (linkedGateIds.length > 0) return 'needs-review';
  if (artifact.kind === 'qa-report' || artifact.kind === 'browser-trace' || artifact.kind === 'screenshot' || artifact.kind === 'test-result') {
    return 'evidence';
  }
  if (artifact.kind === 'release-note' && run.stage === 'ready-for-handoff') return 'accepted-risk';
  return 'produced';
}

function artifactTitle(artifact: FactoryArtifactSummaryDto): string {
  const fromMetadata = stringMetadata(artifact.metadata, 'displayTitle') ?? stringMetadata(artifact.metadata, 'title');
  if (fromMetadata) return fromMetadata;
  return titleCase(artifact.id);
}

function runLinkDto(run: ResolvedFactoryProjectRun): FactoryProjectRunLinkDto {
  return {
    runId: run.run.runId,
    relationship: run.link.relationship,
    stage: run.stage,
    bayId: run.bayId,
    run: run.run,
  } satisfies FactoryProjectRunLinkDto;
}

function phaseViewsFromRun(
  run: ResolvedFactoryProjectRun,
  safetyState: FactoryProjectSafetyStateView,
): readonly FactoryProjectPhaseViewDto[] {
  return run.plan.phases.map((phase) => ({
    runId: run.run.runId,
    workflowId: run.run.workflowId,
    bayId: run.bayId,
    phaseId: phase.id,
    title: phase.title,
    status: phaseState(run.run, phase.id),
    personaId: phase.role.id,
    personaTitle: phase.role.title,
    objective: phase.objective,
    expectedArtifactKinds: phase.expectedArtifacts.map(artifact => artifact.kind),
    artifactIds: run.run.artifacts.filter(artifact => artifact.phaseId === phase.id).map(artifact => artifact.id),
    gateIds: run.run.gates.filter(gate => gate.phaseId === phase.id).map(gate => gate.id),
    safetyState,
  } satisfies FactoryProjectPhaseViewDto));
}

function personaViewsFromRun(
  run: ResolvedFactoryProjectRun,
  safety: FactoryProjectSafetyViewDto,
): readonly FactoryProjectPersonaViewDto[] {
  return run.plan.phases.map((phase) => ({
    personaId: phase.role.id,
    title: phase.role.title,
    responsibility: phase.objective,
    currentTask: run.run.currentPhase?.id === phase.id ? phase.objective : undefined,
    authorityBoundary: authorityBoundaryFromSafety(safety),
    status: personaStatusFromPhaseState(phaseState(run.run, phase.id)),
    outputArtifactKinds: phase.expectedArtifacts.map(artifact => artifact.kind),
  } satisfies FactoryProjectPersonaViewDto));
}

function phaseState(run: FactoryRunStatusDto, phaseId: string): FactoryProjectPhaseState {
  if (run.completedPhaseIds.includes(phaseId)) return 'complete';
  if (run.currentPhase?.id !== phaseId) {
    if (run.status === 'completed' || run.status === 'cancelled') return 'skipped';
    return 'not-started';
  }
  if (run.status === 'failed') return 'blocked';
  if (run.status === 'paused' && run.pause?.kind === 'gate') return 'waiting-for-user';
  if (run.status === 'paused' && run.pause?.kind === 'external-work') return 'running';
  if (run.status === 'cancelled') return 'skipped';
  return 'running';
}

function personaStatusFromPhaseState(phase: FactoryProjectPhaseState): FactoryProjectPersonaViewDto['status'] {
  switch (phase) {
    case 'complete':
      return 'complete';
    case 'blocked':
      return 'blocked';
    case 'running':
    case 'waiting-for-user':
      return 'active';
    default:
      return 'upcoming';
  }
}

function safetyViewFromRun(run: ResolvedFactoryProjectRun): FactoryProjectSafetyViewDto {
  const inferredPolicy: Partial<PolicySpec> | undefined = run.run.workflowId === 'qa-fix'
    ? { allowWrites: true, allowBrowser: true, commandSafetyProfile: 'non-destructive-write' }
    : run.run.workflowId === 'qa'
      ? { allowBrowser: true }
      : undefined;
  return safetyViewFromPolicy({
    ...(run.workflow.defaultPolicy ?? {}),
    ...(inferredPolicy ?? {}),
    ...(run.link.policy ?? {}),
  }, run.run);
}

function safetyViewFromPolicy(
  policy: Partial<PolicySpec> | undefined,
  run: FactoryRunStatusDto | undefined,
): FactoryProjectSafetyViewDto {
  const merged: PolicySpec = {
    ...DEFAULT_FACTORY_POLICY,
    ...(policy ?? {}),
  };
  if (run?.workflowId === 'ship') {
    return {
      state: 'release-action-locked',
      commandSafetyProfile: merged.commandSafetyProfile,
      allowWrites: false,
      allowBrowser: merged.allowBrowser,
      allowNetwork: merged.allowNetwork,
      plainLanguageSummary: 'Ship readiness only. No tag, publish, push, or deploy action is executed from this cockpit.',
      blockedExamples: ['git push', 'publish', 'deploy', 'release'],
    } satisfies FactoryProjectSafetyViewDto;
  }
  if (hasBlockingPolicyRisk(run)) {
    return {
      state: 'blocked-by-policy',
      commandSafetyProfile: merged.commandSafetyProfile,
      allowWrites: merged.allowWrites,
      allowBrowser: merged.allowBrowser,
      allowNetwork: merged.allowNetwork,
      plainLanguageSummary: 'The run is blocked by current safety settings or missing runtime capabilities.',
      blockedExamples: ['file edits without approval', 'browser work without browser access', 'network checks without approval'],
    } satisfies FactoryProjectSafetyViewDto;
  }
  if (merged.allowWrites && merged.commandSafetyProfile === 'non-destructive-write') {
    return {
      state: 'safe-local-fixes',
      commandSafetyProfile: merged.commandSafetyProfile,
      allowWrites: true,
      allowBrowser: merged.allowBrowser,
      allowNetwork: merged.allowNetwork,
      plainLanguageSummary: 'Universe can edit project files locally and run non-destructive checks. It cannot push, deploy, or read secrets.',
      blockedExamples: ['push', 'deploy', 'force reset', 'read secrets'],
    } satisfies FactoryProjectSafetyViewDto;
  }
  if (merged.allowBrowser) {
    return {
      state: 'browser-qa-audit',
      commandSafetyProfile: merged.commandSafetyProfile,
      allowWrites: false,
      allowBrowser: true,
      allowNetwork: merged.allowNetwork,
      plainLanguageSummary: 'Universe can exercise browser flows and capture evidence. It does not edit project files in this mode.',
      blockedExamples: ['code edits', 'push', 'deploy'],
    } satisfies FactoryProjectSafetyViewDto;
  }
  if (merged.allowNetwork) {
    return {
      state: 'network-ci-allowed',
      commandSafetyProfile: merged.commandSafetyProfile,
      allowWrites: merged.allowWrites,
      allowBrowser: merged.allowBrowser,
      allowNetwork: true,
      plainLanguageSummary: 'Universe can inspect approved CI or network-backed checks. Riskier publish actions remain locked.',
      blockedExamples: ['publish', 'deploy', 'release'],
    } satisfies FactoryProjectSafetyViewDto;
  }
  return {
    state: 'read-only-audit',
    commandSafetyProfile: merged.commandSafetyProfile,
    allowWrites: false,
    allowBrowser: false,
    allowNetwork: false,
    plainLanguageSummary: 'Universe can inspect project state and produce artifacts. It cannot edit project files in this mode.',
    blockedExamples: ['file edits', 'push', 'deploy'],
  } satisfies FactoryProjectSafetyViewDto;
}

function hasBlockingPolicyRisk(run: FactoryRunStatusDto | undefined): boolean {
  return run?.risks.some(risk => risk.severity === 'blocking' && (
    risk.id === 'writes-disabled'
    || risk.id === 'browser-disabled'
    || risk.id === 'network-disabled'
    || risk.id === 'write-safety-profile-required'
    || risk.id === 'command-safety-profile-disallowed'
  )) ?? false;
}

function activePersonaFromRun(run: ResolvedFactoryProjectRun): FactoryProjectPersonaSummaryDto | undefined {
  const phaseId = run.run.currentPhase?.id;
  if (!phaseId) return undefined;
  const phase = run.plan.phases.find(candidate => candidate.id === phaseId);
  if (!phase) return undefined;
  return {
    personaId: phase.role.id,
    title: phase.role.title,
    runId: run.run.runId,
    phaseId,
  } satisfies FactoryProjectPersonaSummaryDto;
}

function resumeSummaryFromProject(
  project: FactoryProjectRecord,
  activeRun: ResolvedFactoryProjectRun | undefined,
  decisions: readonly FactoryProjectDecisionQueueItemDto[],
  projectStatus: FactoryProjectStage,
): FactoryProjectResumeSummaryDto {
  const pendingDecision = decisions[0];
  if (pendingDecision) {
    return {
      kind: 'waiting-for-decision',
      headline: `${project.name} is waiting for your decision`,
      supportingText: pendingDecision.plainLanguageQuestion,
      recommendedAction: pendingDecision.title,
      whatHappensNext: pendingDecision.whatHappensNext,
    } satisfies FactoryProjectResumeSummaryDto;
  }
  if (!activeRun) {
    return {
      kind: 'complete',
      headline: `${project.name} has no linked factory runs yet`,
      supportingText: 'Create or attach a factory run to populate the cockpit.',
      recommendedAction: 'Start a project run',
      whatHappensNext: 'The workspace dashboard can then show resume, inbox, and artifact state.',
    } satisfies FactoryProjectResumeSummaryDto;
  }
  if (activeRun.run.status === 'failed') {
    return {
      kind: activeRun.run.error?.retryable === true ? 'failed-retryable' : 'failed-nonretryable',
      headline: `${project.name} is blocked in ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}`,
      supportingText: activeRun.run.error?.message ?? 'The active run failed and needs inspection.',
      recommendedAction: 'Inspect the failed run',
      whatHappensNext: 'Once the failure is understood, the run can be continued or replaced with a follow-up run.',
    } satisfies FactoryProjectResumeSummaryDto;
  }
  if (activeRun.run.status === 'paused' && activeRun.run.pause?.kind === 'external-work') {
    return {
      kind: 'waiting-for-external-work',
      headline: `${project.name} is waiting for external work to finish`,
      supportingText: `Current phase: ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}. Open the latest evidence or wait for the external step to resolve.`,
      recommendedAction: projectStatus === 'qa-audit' ? 'Open QA evidence' : 'Open latest artifact',
      whatHappensNext: 'The wrapper will surface the next artifact or decision as soon as the active run records it.',
    } satisfies FactoryProjectResumeSummaryDto;
  }
  if (projectStatus === 'ready-for-handoff' || (activeRun.run.status === 'completed' && activeRun.run.workflowId === 'ship')) {
    return {
      kind: 'ready-for-handoff',
      headline: `${project.name} is ready for handoff`,
      supportingText: 'Ship readiness is complete. No deploy action was executed.',
      recommendedAction: 'Export the handoff bundle',
      whatHappensNext: 'A developer or future deployment workflow can pick up from the packaged artifacts and decisions.',
    } satisfies FactoryProjectResumeSummaryDto;
  }
  if (activeRun.run.status === 'completed') {
    return {
      kind: 'complete',
      headline: `${project.name} has completed its active factory run`,
      supportingText: `Latest completed run: ${activeRun.run.workflowTitle}. Review artifacts or attach a follow-up run if more work is needed.`,
      recommendedAction: 'Open the latest artifact',
      whatHappensNext: 'The project can stay as-is, or a new linked run can continue the next bay.',
    } satisfies FactoryProjectResumeSummaryDto;
  }
  return {
    kind: 'running',
    headline: `${project.name} is currently in ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}`,
    supportingText: activeRun.run.resultSummary ?? 'Universe is actively moving the linked run forward.',
    recommendedAction: 'Open the cockpit',
    whatHappensNext: 'The workspace dashboard will surface the next artifact, decision, or failure as the run changes state.',
  } satisfies FactoryProjectResumeSummaryDto;
}

function nextActionFromProject(
  activeRun: ResolvedFactoryProjectRun | undefined,
  decisions: readonly FactoryProjectDecisionQueueItemDto[],
  projectStatus: FactoryProjectStage,
  artifacts: readonly FactoryProjectArtifactViewDto[],
): FactoryProjectNextActionDto {
  const pendingDecision = decisions[0];
  if (pendingDecision) {
    return {
      kind: 'decision',
      label: pendingDecision.title,
      supportingText: pendingDecision.plainLanguageQuestion,
      runId: pendingDecision.runId,
      gateId: pendingDecision.gateId,
      phaseId: pendingDecision.phaseId,
    } satisfies FactoryProjectNextActionDto;
  }
  if (!activeRun) {
    return {
      kind: 'resume',
      label: 'Start a project run',
      supportingText: 'No linked runs exist yet.',
    } satisfies FactoryProjectNextActionDto;
  }
  if (activeRun.run.status === 'failed') {
    return {
      kind: 'inspect',
      label: 'Inspect the failed run',
      supportingText: activeRun.run.error?.message,
      runId: activeRun.run.runId,
      phaseId: activeRun.run.currentPhase?.id,
    } satisfies FactoryProjectNextActionDto;
  }
  if (activeRun.run.status === 'paused' && activeRun.run.pause?.kind === 'external-work') {
    return {
      kind: 'artifact',
      label: projectStatus === 'qa-audit' ? 'Open QA evidence' : 'Open latest artifact',
      supportingText: 'External work is pending.',
      runId: activeRun.run.runId,
      phaseId: activeRun.run.pause.phaseId,
    } satisfies FactoryProjectNextActionDto;
  }
  if (projectStatus === 'ready-for-handoff' || (activeRun.run.status === 'completed' && activeRun.run.workflowId === 'ship')) {
    return {
      kind: 'handoff',
      label: 'Export handoff bundle',
      supportingText: 'Readiness is complete. No deploy action was run.',
      runId: activeRun.run.runId,
    } satisfies FactoryProjectNextActionDto;
  }
  if (activeRun.run.status === 'running' || activeRun.run.status === 'paused') {
    return {
      kind: 'watch',
      label: `Open ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}`,
      supportingText: 'Universe is still working in the active run.',
      runId: activeRun.run.runId,
      phaseId: activeRun.run.currentPhase?.id,
    } satisfies FactoryProjectNextActionDto;
  }
  const latestArtifact = artifacts[0];
  if (latestArtifact) {
    return {
      kind: 'artifact',
      label: `Open ${latestArtifact.displayTitle}`,
      supportingText: latestArtifact.artifact.summary,
      runId: latestArtifact.runId,
      phaseId: latestArtifact.artifact.phaseId,
    } satisfies FactoryProjectNextActionDto;
  }
  return {
    kind: 'resume',
    label: 'Open the cockpit',
    runId: activeRun.run.runId,
  } satisfies FactoryProjectNextActionDto;
}

function selectFeaturedArtifact(
  activeRun: ResolvedFactoryProjectRun | undefined,
  artifacts: readonly FactoryProjectArtifactViewDto[],
  decisions: readonly FactoryProjectDecisionQueueItemDto[],
): FactoryProjectArtifactViewDto | undefined {
  const decisionArtifactId = decisions[0]?.supportingArtifactIds[0];
  if (decisionArtifactId) {
    const matchingDecisionArtifact = artifacts.find(artifact => artifact.artifactId === decisionArtifactId);
    if (matchingDecisionArtifact) return matchingDecisionArtifact;
  }
  if (activeRun?.run.currentPhase?.id) {
    const currentArtifact = artifacts.find(artifact => artifact.runId === activeRun.run.runId && artifact.artifact.phaseId === activeRun.run.currentPhase?.id);
    if (currentArtifact) return currentArtifact;
  }
  return artifacts[0];
}

function simpleOverviewFromProject(
  project: FactoryProjectSummaryDto,
  activeRun: ResolvedFactoryProjectRun | undefined,
): FactoryProjectSimpleOverviewDto {
  const currentFocus = activeRun
    ? `Right now: ${activeRun.run.currentPhase?.title ?? activeRun.run.workflowTitle}`
    : 'Right now: no active run is linked yet';
  const calmState = project.pendingDecisionCount > 0
    ? `${project.pendingDecisionCount} decision${project.pendingDecisionCount === 1 ? '' : 's'} waiting on you.`
    : project.activeRunStatus === 'running'
      ? 'Nothing needs you right now.'
      : project.projectStatus === 'ready-for-handoff'
        ? 'Everything is ready for handoff.'
        : 'All clear for now.';
  return {
    headline: project.resumeSummary.headline,
    currentFocus,
    calmState,
    recommendedAction: project.nextAction.label,
  } satisfies FactoryProjectSimpleOverviewDto;
}

function authorityBoundaryFromSafety(safety: FactoryProjectSafetyViewDto): string {
  return safety.plainLanguageSummary;
}

function compareProjectSummaryPriority(
  left: FactoryProjectSummaryDto,
  right: FactoryProjectSummaryDto,
): number {
  const leftRank = projectSummaryRank(left);
  const rightRank = projectSummaryRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.name.localeCompare(right.name);
}

function projectSummaryRank(project: FactoryProjectSummaryDto): number {
  if (project.pendingDecisionCount > 0) return 0;
  if (project.activeRunStatus === 'running') return 1;
  if (project.activeRunStatus === 'paused') return 2;
  if (project.activeRunStatus === 'failed') return 3;
  if (project.projectStatus === 'ready-for-handoff') return 4;
  if (project.activeRunStatus === 'completed') return 5;
  return 6;
}

function latestUpdatedAt(runs: readonly ResolvedFactoryProjectRun[]): string | undefined {
  return runs
    .map(run => run.run.updatedAt)
    .filter((value): value is string => typeof value === 'string')
    .sort((left, right) => right.localeCompare(left))[0];
}

function bayProgress(bays: readonly FactoryProjectBayViewDto[]): { readonly completed: number; readonly total: number } {
  return {
    completed: bays.filter(bay => bay.status === 'complete').length,
    total: bays.length,
  };
}

function bayIndex(bayId: FactoryProjectBayId): number {
  switch (bayId) {
    case 'drawing-room':
      return 0;
    case 'workshop':
      return 1;
    case 'showroom':
      return 2;
  }
}

function titleCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
