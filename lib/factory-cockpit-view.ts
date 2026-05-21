// Pure cockpit screen-ready view models for the Universa AI Software Factory
// web cockpit. Inputs are the typed wrapper DTOs from `factory-project.ts`
// plus optional persisted project-catalog context. Outputs are deterministic
// objects suitable for direct rendering by a future UI layer.
//
// Hard rules enforced here:
//   - no UI framework imports
//   - no filesystem access
//   - no production scaffold dependencies
//   - every section carries a `provenance` tag so a renderer can show users
//     where the value came from (persisted catalog, factory contract, project
//     wrapper, or mocked alpha placeholder).
//
// Copy locks enforced here:
//   - product name is "Universe AI Software Factory"
//   - ship readiness never implies deployment
//   - QA audit and QA fix are framed as separate states
//   - the success outcome is "Ready for handoff"
//
// References:
//   - docs/designs/PI_SOFTWARE_FACTORY_ALPHA_BETA_EXECUTION_PLAN.md (A1.3/B1.1-3)
//   - docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_SCREEN_SPEC.md
//   - docs/designs/PI_SOFTWARE_FACTORY_WEB_COCKPIT_COMPONENT_MODEL.md
//   - docs/designs/PI_SOFTWARE_FACTORY_P0_PRODUCT_ACCEPTANCE.md
import type {
  FactoryGateDecisionValue,
  FactoryGateInfoDto,
  FactoryRunStatusDto,
} from './factory';
import type {
  FactoryArtifactContentSummaryDto,
  FactoryArtifactPrimaryAction,
  FactoryArtifactSafetyLabel,
} from './factory-artifact-content';
import type {
  FactoryProjectArtifactViewDto,
  FactoryProjectBayId,
  FactoryProjectBayStatus,
  FactoryProjectBayViewDto,
  FactoryProjectCockpitDto,
  FactoryProjectCockpitLayer,
  FactoryProjectDecisionQueueItemDto,
  FactoryProjectExperienceMode,
  FactoryProjectPersonaSummaryDto,
  FactoryProjectPersonaViewDto,
  FactoryProjectPhaseViewDto,
  FactoryProjectResumeSummaryDto,
  FactoryProjectRunLinkDto,
  FactoryProjectSafetyStateView,
  FactoryProjectSafetyViewDto,
  FactoryProjectStage,
  FactoryProjectSummaryDto,
  FactoryWorkspaceSummaryDto,
} from './factory-project';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type FactoryCockpitProvenance =
  | 'persisted'
  | 'contract-backed'
  | 'wrapper-derived'
  | 'mocked';

export interface FactoryCockpitProvenanceTag {
  readonly source: FactoryCockpitProvenance;
  readonly note?: string;
}

const PROVENANCE_NOTE: Readonly<Record<FactoryCockpitProvenance, string>> = Object.freeze({
  persisted: 'From the project catalog record on disk.',
  'contract-backed': 'From a factory run status DTO produced by the factory facade.',
  'wrapper-derived': 'Computed by the project wrapper over one or more run DTOs.',
  mocked: 'Alpha placeholder until the supporting data source ships.',
});

function provenance(
  source: FactoryCockpitProvenance,
  note?: string,
): FactoryCockpitProvenanceTag {
  return { source, note: note ?? PROVENANCE_NOTE[source] } satisfies FactoryCockpitProvenanceTag;
}

// ---------------------------------------------------------------------------
// Product copy locks
// ---------------------------------------------------------------------------

export const FACTORY_COCKPIT_PRODUCT_NAME = 'Universe AI Software Factory';
export const FACTORY_COCKPIT_SUCCESS_LABEL = 'Ready for handoff';
export const FACTORY_COCKPIT_SHIP_DISCLAIMER =
  'Ship readiness is not deployment. No tag, publish, push, or deploy happens in this workflow.';
export const FACTORY_COCKPIT_QA_AUDIT_BANNER =
  'Browser QA audit — no code changes';
export const FACTORY_COCKPIT_QA_FIX_BANNER =
  'Safe local QA fix — Universe edits files locally and reruns QA';

// ---------------------------------------------------------------------------
// Shared view types
// ---------------------------------------------------------------------------

export interface FactoryCockpitSafetyBadgeViewModel {
  readonly state: FactoryProjectSafetyStateView;
  readonly label: string;
  readonly summary: string;
  readonly blockedExamples: readonly string[];
  readonly allowWrites: boolean;
  readonly allowBrowser: boolean;
  readonly allowNetwork: boolean;
  readonly commandSafetyProfile: FactoryProjectSafetyViewDto['commandSafetyProfile'];
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitPersonaSummaryView {
  readonly personaId: string;
  readonly title: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitNextActionView {
  readonly kind: 'decision' | 'watch' | 'resume' | 'artifact' | 'handoff' | 'inspect';
  readonly label: string;
  readonly supportingText?: string;
  readonly runId?: string;
  readonly gateId?: string;
  readonly phaseId?: string;
  readonly provenance: FactoryCockpitProvenanceTag;
}

// ---------------------------------------------------------------------------
// Workspace dashboard view model
// ---------------------------------------------------------------------------

export interface FactoryCockpitDashboardInput {
  readonly workspace: FactoryWorkspaceSummaryDto;
  readonly projects: readonly FactoryProjectSummaryDto[];
}

export interface FactoryCockpitDashboardDecisionItemView {
  readonly projectId: string;
  readonly projectName: string;
  readonly question: string;
  readonly recommendedAction: string;
  readonly runId: string;
  readonly gateId?: string;
}

export interface FactoryCockpitDashboardDecisionBannerView {
  readonly headline: string;
  readonly items: readonly FactoryCockpitDashboardDecisionItemView[];
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitDashboardResumeHeroView {
  readonly projectId?: string;
  readonly headline: string;
  readonly supportingText: string;
  readonly recommendedAction: string;
  readonly whatHappensNext: string;
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitDashboardProjectCardView {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly oneLineGoal: string;
  readonly statusLabel: string;
  readonly statusTone: 'decision' | 'running' | 'paused' | 'failed' | 'handoff' | 'completed' | 'idle';
  readonly activePersona?: FactoryCockpitPersonaSummaryView;
  readonly nextAction: FactoryCockpitNextActionView;
  readonly safetyBadge: FactoryCockpitSafetyBadgeViewModel;
  readonly experienceMode: FactoryProjectExperienceMode;
  readonly bayProgress: { readonly completed: number; readonly total: number };
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitDashboardViewModel {
  readonly screenId: 'dashboard';
  readonly productName: string;
  readonly title: string;
  readonly subtitle: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly ownerName?: string;
  readonly workspaceProvenance: FactoryCockpitProvenanceTag;
  readonly decisionBanner?: FactoryCockpitDashboardDecisionBannerView;
  readonly resumeHero: FactoryCockpitDashboardResumeHeroView;
  readonly projectCards: readonly FactoryCockpitDashboardProjectCardView[];
  readonly safetyDefaults: FactoryCockpitSafetyBadgeViewModel;
  readonly emptyState?: string;
}

export function buildFactoryCockpitDashboardView(
  input: FactoryCockpitDashboardInput,
): FactoryCockpitDashboardViewModel {
  const projectCards = input.projects.map(project => projectCardFromSummary(project));
  const decisionItems = collectDecisionBannerItems(input.projects);
  const resumeProject = input.projects.find(project => project.projectId === input.workspace.resumeProjectId)
    ?? input.projects[0];

  return {
    screenId: 'dashboard',
    productName: FACTORY_COCKPIT_PRODUCT_NAME,
    title: `${input.workspace.name} · ${FACTORY_COCKPIT_PRODUCT_NAME}`,
    subtitle: 'Build anything in the universe with Universe AI.',
    workspaceId: input.workspace.workspaceId,
    workspaceName: input.workspace.name,
    ownerName: input.workspace.ownerName,
    workspaceProvenance: provenance('persisted', 'Workspace name and owner are persisted in the project catalog.'),
    decisionBanner: decisionItems.length === 0
      ? undefined
      : {
        headline: decisionItems.length === 1
          ? `${decisionItems.length} project is waiting on your decision`
          : `${decisionItems.length} projects are waiting on your decision`,
        items: decisionItems,
        provenance: provenance('wrapper-derived', 'Banner items are projected from each project\'s pending gate queue.'),
      },
    resumeHero: resumeHeroFromProject(resumeProject),
    projectCards,
    safetyDefaults: safetyBadgeFromView(input.workspace.safetyDefaults),
    emptyState: input.projects.length === 0
      ? 'No projects yet. Start an idea to see the factory build it in front of you.'
      : undefined,
  } satisfies FactoryCockpitDashboardViewModel;
}

function projectCardFromSummary(project: FactoryProjectSummaryDto): FactoryCockpitDashboardProjectCardView {
  return {
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    name: project.name,
    oneLineGoal: project.oneLineGoal,
    statusLabel: statusLabelFromProject(project),
    statusTone: statusToneFromProject(project),
    activePersona: project.activePersona ? personaSummaryView(project.activePersona) : undefined,
    nextAction: nextActionViewFromProject(project),
    safetyBadge: safetyBadgeFromView(project.safety),
    experienceMode: project.experienceMode,
    bayProgress: project.progress,
    provenance: provenance('wrapper-derived'),
  } satisfies FactoryCockpitDashboardProjectCardView;
}

function statusLabelFromProject(project: FactoryProjectSummaryDto): string {
  if (project.pendingDecisionCount > 0) {
    return project.pendingDecisionCount === 1
      ? 'Decision needed'
      : `${project.pendingDecisionCount} decisions needed`;
  }
  switch (project.projectStatus) {
    case 'draft-idea':
      return 'Drafting the idea';
    case 'planning':
      return 'Planning';
    case 'design-review':
      return 'Reviewing the design';
    case 'building':
      return 'Building';
    case 'reviewing':
      return 'Reviewing the build';
    case 'qa-audit':
      return 'QA audit in progress';
    case 'fix-loop':
      return 'Safe local fix loop';
    case 'ship-readiness':
      return 'Ship readiness check';
    case 'ready-for-handoff':
      return FACTORY_COCKPIT_SUCCESS_LABEL;
    case 'complete':
      return 'Completed';
  }
}

function statusToneFromProject(
  project: FactoryProjectSummaryDto,
): FactoryCockpitDashboardProjectCardView['statusTone'] {
  if (project.pendingDecisionCount > 0) return 'decision';
  if (project.projectStatus === 'ready-for-handoff') return 'handoff';
  if (project.activeRunStatus === 'failed') return 'failed';
  if (project.activeRunStatus === 'running') return 'running';
  if (project.activeRunStatus === 'paused') return 'paused';
  if (project.activeRunStatus === 'completed' || project.projectStatus === 'complete') return 'completed';
  return 'idle';
}

function collectDecisionBannerItems(
  projects: readonly FactoryProjectSummaryDto[],
): readonly FactoryCockpitDashboardDecisionItemView[] {
  return projects
    .filter(project => project.pendingDecisionCount > 0 && project.nextAction.kind === 'decision')
    .map((project) => ({
      projectId: project.projectId,
      projectName: project.name,
      question: project.nextAction.supportingText ?? project.nextAction.label,
      recommendedAction: project.nextAction.label,
      runId: project.nextAction.runId ?? project.activeRunId ?? '',
      gateId: project.nextAction.gateId,
    } satisfies FactoryCockpitDashboardDecisionItemView));
}

function resumeHeroFromProject(
  project: FactoryProjectSummaryDto | undefined,
): FactoryCockpitDashboardResumeHeroView {
  if (!project) {
    return {
      headline: 'Start an idea',
      supportingText: 'No projects exist yet. Universe will guide you through the first idea-shaping flow.',
      recommendedAction: 'Start a new project',
      whatHappensNext: 'Universe captures the idea brief, then picks Easy or Hands-on Mode with you.',
      provenance: provenance('wrapper-derived'),
    } satisfies FactoryCockpitDashboardResumeHeroView;
  }
  return {
    projectId: project.projectId,
    headline: project.resumeSummary.headline,
    supportingText: project.resumeSummary.supportingText,
    recommendedAction: project.resumeSummary.recommendedAction,
    whatHappensNext: project.resumeSummary.whatHappensNext,
    provenance: provenance('wrapper-derived'),
  } satisfies FactoryCockpitDashboardResumeHeroView;
}

// ---------------------------------------------------------------------------
// Idea wizard
// ---------------------------------------------------------------------------

export type FactoryCockpitIdeaWizardStep =
  | 'capture-idea'
  | 'shape-audience'
  | 'shape-outcome'
  | 'review-brief'
  | 'pick-mode'
  | 'ready';

export interface FactoryCockpitIdeaWizardQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly helpText?: string;
  readonly required: boolean;
  readonly answer?: string;
}

export interface FactoryCockpitIdeaWizardDraft {
  readonly title?: string;
  readonly oneLineGoal?: string;
  readonly audience?: string;
  readonly outcome?: string;
  readonly experienceMode?: FactoryProjectExperienceMode;
  readonly cockpitLayer?: FactoryProjectCockpitLayer;
}

export interface FactoryCockpitIdeaWizardInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly draft: FactoryCockpitIdeaWizardDraft;
}

export interface FactoryCockpitModePickerOption {
  readonly mode: FactoryProjectExperienceMode;
  readonly title: string;
  readonly summary: string;
  readonly bestFor: string;
  readonly interruptions: string;
  readonly canSwitch: string;
  readonly recommended: boolean;
}

export interface FactoryCockpitIdeaWizardViewModel {
  readonly screenId: 'idea-wizard';
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly currentStep: FactoryCockpitIdeaWizardStep;
  readonly stepOrder: readonly FactoryCockpitIdeaWizardStep[];
  readonly questions: readonly FactoryCockpitIdeaWizardQuestion[];
  readonly ideaBriefPreview: {
    readonly headline: string;
    readonly bullets: readonly string[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly modePicker: {
    readonly headline: string;
    readonly subhead: string;
    readonly options: readonly FactoryCockpitModePickerOption[];
    readonly selectedMode?: FactoryProjectExperienceMode;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly questionsProvenance: FactoryCockpitProvenanceTag;
  readonly draftProvenance: FactoryCockpitProvenanceTag;
  readonly readyForStart: boolean;
  readonly recommendedAction: string;
}

const IDEA_WIZARD_STEP_ORDER: readonly FactoryCockpitIdeaWizardStep[] = Object.freeze([
  'capture-idea',
  'shape-audience',
  'shape-outcome',
  'review-brief',
  'pick-mode',
  'ready',
]);

const IDEA_WIZARD_QUESTION_TEMPLATE: readonly FactoryCockpitIdeaWizardQuestion[] = Object.freeze([
  Object.freeze({
    id: 'idea-title',
    prompt: 'What would you like Universe to build?',
    helpText: 'A short working name is fine. You can rename later.',
    required: true,
  }),
  Object.freeze({
    id: 'one-line-goal',
    prompt: 'In one sentence, what should it do for someone using it?',
    helpText: 'Universe will turn this into the project headline.',
    required: true,
  }),
  Object.freeze({
    id: 'audience',
    prompt: 'Who is this for?',
    helpText: 'A specific person or group helps Universe pick examples.',
    required: false,
  }),
  Object.freeze({
    id: 'outcome',
    prompt: 'What changes for them if it works?',
    helpText: 'Outcomes guide the Shape It crew.',
    required: false,
  }),
]);

export function buildFactoryCockpitIdeaWizardView(
  input: FactoryCockpitIdeaWizardInput,
): FactoryCockpitIdeaWizardViewModel {
  const draft = input.draft;
  const questions = IDEA_WIZARD_QUESTION_TEMPLATE.map(question => ({
    ...question,
    answer: answerForQuestion(question.id, draft),
  } satisfies FactoryCockpitIdeaWizardQuestion));
  const currentStep = nextIdeaWizardStep(draft);
  const bullets: string[] = [];
  if (draft.title) bullets.push(`Working name: ${draft.title}`);
  if (draft.oneLineGoal) bullets.push(`One-line goal: ${draft.oneLineGoal}`);
  if (draft.audience) bullets.push(`Audience: ${draft.audience}`);
  if (draft.outcome) bullets.push(`Outcome: ${draft.outcome}`);
  return {
    screenId: 'idea-wizard',
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    currentStep,
    stepOrder: IDEA_WIZARD_STEP_ORDER,
    questions,
    ideaBriefPreview: {
      headline: draft.title ? `Idea brief: ${draft.title}` : 'Idea brief preview',
      bullets,
      provenance: provenance('wrapper-derived', 'The brief preview grows as the user answers wizard questions.'),
    },
    modePicker: {
      headline: 'Pick how hands-on you want to be',
      subhead: 'You can switch anytime.',
      options: [
        {
          mode: 'easy',
          title: 'Easy Mode',
          summary: 'Universe drives the routine work and only interrupts for decisions that matter.',
          bestFor: 'Founders and operators who want progress without daily review.',
          interruptions: 'Only when Universe needs you.',
          canSwitch: 'You can open Hands-on Mode anytime.',
          recommended: true,
        },
        {
          mode: 'hands-on',
          title: 'Hands-on Mode',
          summary: 'See the 3-bay factory map, open each bay, and inspect every persona and artifact.',
          bestFor: 'Builders and product folks who want to see how the work happens.',
          interruptions: 'You will review more checkpoints by choice.',
          canSwitch: 'You can switch back to Easy Mode after the current decision finishes.',
          recommended: false,
        },
      ],
      selectedMode: draft.experienceMode,
      provenance: provenance('persisted', 'Mode choice is stored on the project record.'),
    },
    questionsProvenance: provenance('mocked', 'Idea wizard questions are a fixed Alpha template until the AI intake ships.'),
    draftProvenance: provenance('persisted', 'Draft answers land on the project record once submitted.'),
    readyForStart: Boolean(draft.title) && Boolean(draft.oneLineGoal) && Boolean(draft.experienceMode),
    recommendedAction: draft.experienceMode
      ? `Start the project in ${draft.experienceMode === 'easy' ? 'Easy Mode' : 'Hands-on Mode'}`
      : draft.title && draft.oneLineGoal
        ? 'Pick a mode'
        : 'Answer the next question',
  } satisfies FactoryCockpitIdeaWizardViewModel;
}

function answerForQuestion(
  id: string,
  draft: FactoryCockpitIdeaWizardDraft,
): string | undefined {
  switch (id) {
    case 'idea-title':
      return draft.title;
    case 'one-line-goal':
      return draft.oneLineGoal;
    case 'audience':
      return draft.audience;
    case 'outcome':
      return draft.outcome;
    default:
      return undefined;
  }
}

function nextIdeaWizardStep(draft: FactoryCockpitIdeaWizardDraft): FactoryCockpitIdeaWizardStep {
  if (!draft.title) return 'capture-idea';
  if (!draft.audience) return 'shape-audience';
  if (!draft.outcome) return 'shape-outcome';
  if (!draft.oneLineGoal) return 'review-brief';
  if (!draft.experienceMode) return 'pick-mode';
  return 'ready';
}

// ---------------------------------------------------------------------------
// Easy Mode home
// ---------------------------------------------------------------------------

export interface FactoryCockpitEasyHandledFeedItem {
  readonly id: string;
  readonly summary: string;
  readonly reversible: boolean;
  readonly happenedAt?: string;
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitEasyModeViewModel {
  readonly screenId: 'easy-mode-home';
  readonly projectId: string;
  readonly projectName: string;
  readonly modePill: {
    readonly currentMode: FactoryProjectExperienceMode;
    readonly canSwitchToEasy: boolean;
    readonly pendingDecisionCount: number;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly rightNowCard: {
    readonly headline: string;
    readonly detail: string;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly progressStrip: {
    readonly completed: number;
    readonly total: number;
    readonly bays: readonly FactoryCockpitBayBadgeView[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly attentionState: {
    readonly headline: string;
    readonly detail: string;
    readonly nextAction: FactoryCockpitNextActionView;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly handledFeed: {
    readonly items: readonly FactoryCockpitEasyHandledFeedItem[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly detailsHandle: {
    readonly label: string;
    readonly hint: string;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly safetyBadge: FactoryCockpitSafetyBadgeViewModel;
}

export interface FactoryCockpitBayBadgeView {
  readonly bayId: FactoryProjectBayId;
  readonly title: string;
  readonly status: FactoryProjectBayStatus;
  readonly summary: string;
}

export interface FactoryCockpitEasyModeInput {
  readonly project: FactoryProjectSummaryDto;
  readonly cockpit: FactoryProjectCockpitDto;
  readonly handledFeed?: readonly FactoryCockpitEasyHandledFeedItem[];
}

export function buildFactoryCockpitEasyModeView(
  input: FactoryCockpitEasyModeInput,
): FactoryCockpitEasyModeViewModel {
  const { project, cockpit } = input;
  const overview = cockpit.simpleOverview;
  const handled = input.handledFeed ?? [];
  return {
    screenId: 'easy-mode-home',
    projectId: project.projectId,
    projectName: project.name,
    modePill: {
      currentMode: project.experienceMode,
      canSwitchToEasy: project.pendingDecisionCount === 0,
      pendingDecisionCount: project.pendingDecisionCount,
      provenance: provenance('persisted'),
    },
    rightNowCard: {
      headline: overview.headline,
      detail: overview.currentFocus,
      provenance: provenance('wrapper-derived'),
    },
    progressStrip: {
      completed: project.progress.completed,
      total: project.progress.total,
      bays: project.bays.map(bayBadgeFromBay),
      provenance: provenance('wrapper-derived'),
    },
    attentionState: {
      headline: overview.calmState,
      detail: project.pendingDecisionCount > 0
        ? 'Universe is holding the run until you decide.'
        : 'Universe will let you know if it needs anything.',
      nextAction: nextActionViewFromProject(project),
      provenance: provenance('wrapper-derived'),
    },
    handledFeed: {
      items: handled,
      provenance: provenance('mocked', 'Alpha returns an empty handled feed until reversible-action events ship.'),
    },
    detailsHandle: {
      label: 'Open the factory floor',
      hint: 'Switch to Hands-on Mode to see the 3-bay map and detailed cockpit.',
      provenance: provenance('persisted'),
    },
    safetyBadge: safetyBadgeFromView(project.safety),
  } satisfies FactoryCockpitEasyModeViewModel;
}

function bayBadgeFromBay(bay: FactoryProjectBayViewDto): FactoryCockpitBayBadgeView {
  return {
    bayId: bay.bayId,
    title: bay.title,
    status: bay.status,
    summary: bay.summary,
  } satisfies FactoryCockpitBayBadgeView;
}

// ---------------------------------------------------------------------------
// Hands-on 3-bay map
// ---------------------------------------------------------------------------

export interface FactoryCockpitBayCardView {
  readonly bayId: FactoryProjectBayId;
  readonly title: string;
  readonly roomName: string;
  readonly verb: string;
  readonly status: FactoryProjectBayStatus;
  readonly statusLabel: string;
  readonly summary: string;
  readonly crew: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly runIds: readonly string[];
  readonly locked: boolean;
  readonly active: boolean;
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitBayMapViewModel {
  readonly screenId: 'bay-map';
  readonly projectId: string;
  readonly projectName: string;
  readonly activeBayId: FactoryProjectBayId | undefined;
  readonly cards: readonly FactoryCockpitBayCardView[];
  readonly modePill: {
    readonly currentMode: FactoryProjectExperienceMode;
    readonly canSwitchToEasy: boolean;
    readonly pendingDecisionCount: number;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly safetyBadge: FactoryCockpitSafetyBadgeViewModel;
}

const BAY_VERBS: Readonly<Record<FactoryProjectBayId, string>> = Object.freeze({
  'drawing-room': 'Shape it',
  workshop: 'Build it',
  showroom: 'Ship it',
});

const BAY_ROOM_NAMES: Readonly<Record<FactoryProjectBayId, string>> = Object.freeze({
  'drawing-room': 'Drawing Room',
  workshop: 'Workshop',
  showroom: 'Showroom',
});

const BAY_CREW: Readonly<Record<FactoryProjectBayId, readonly string[]>> = Object.freeze({
  'drawing-room': Object.freeze(['Product Shaper', 'Design Lead']),
  workshop: Object.freeze(['Builder', 'GStack Reviewer']),
  showroom: Object.freeze(['QA Auditor', 'Ship-readiness Lead']),
});

const BAY_EXPECTED_OUTPUTS: Readonly<Record<FactoryProjectBayId, readonly string[]>> = Object.freeze({
  'drawing-room': Object.freeze(['Idea brief', 'Approved plan']),
  workshop: Object.freeze(['Implementation', 'Reviewed change']),
  showroom: Object.freeze(['Browser QA evidence', 'Handoff bundle']),
});

export function buildFactoryCockpitBayMapView(
  input: FactoryCockpitEasyModeInput,
): FactoryCockpitBayMapViewModel {
  const { project, cockpit } = input;
  const activeBayId = cockpit.activeRun?.bayId ?? findActiveBayId(project.bays);
  const cards = project.bays.map(bay => bayCardFromBay(bay, activeBayId === bay.bayId));
  return {
    screenId: 'bay-map',
    projectId: project.projectId,
    projectName: project.name,
    activeBayId,
    cards,
    modePill: {
      currentMode: project.experienceMode,
      canSwitchToEasy: project.pendingDecisionCount === 0,
      pendingDecisionCount: project.pendingDecisionCount,
      provenance: provenance('persisted'),
    },
    safetyBadge: safetyBadgeFromView(project.safety),
  } satisfies FactoryCockpitBayMapViewModel;
}

function findActiveBayId(
  bays: readonly FactoryProjectBayViewDto[],
): FactoryProjectBayId | undefined {
  return bays.find(bay => bay.status === 'active')?.bayId;
}

function bayCardFromBay(
  bay: FactoryProjectBayViewDto,
  isActive: boolean,
): FactoryCockpitBayCardView {
  return {
    bayId: bay.bayId,
    title: BAY_VERBS[bay.bayId],
    roomName: BAY_ROOM_NAMES[bay.bayId],
    verb: BAY_VERBS[bay.bayId],
    status: bay.status,
    statusLabel: bayStatusLabel(bay.status),
    summary: bay.summary,
    crew: BAY_CREW[bay.bayId],
    expectedOutputs: BAY_EXPECTED_OUTPUTS[bay.bayId],
    runIds: bay.runIds,
    locked: bay.status === 'locked',
    active: isActive,
    provenance: provenance('wrapper-derived'),
  } satisfies FactoryCockpitBayCardView;
}

function bayStatusLabel(status: FactoryProjectBayStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'complete':
      return 'Complete';
    case 'locked':
      return 'Locked';
    case 'not-started':
      return 'Not started';
  }
}

// ---------------------------------------------------------------------------
// Bay simple overview
// ---------------------------------------------------------------------------

export interface FactoryCockpitBaySimpleOverviewViewModel {
  readonly screenId: 'bay-simple-overview';
  readonly projectId: string;
  readonly projectName: string;
  readonly bayId: FactoryProjectBayId;
  readonly bayTitle: string;
  readonly rightNow: {
    readonly headline: string;
    readonly detail: string;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly latestArtifact?: {
    readonly artifactId: string;
    readonly displayTitle: string;
    readonly summary: string;
    readonly safetyLabel: FactoryArtifactSafetyLabel;
    readonly primaryAction: FactoryArtifactPrimaryAction;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly nextActionCard: {
    readonly headline: string;
    readonly nextAction: FactoryCockpitNextActionView;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly detailsHandle: {
    readonly label: string;
    readonly hint: string;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly safetyBadge: FactoryCockpitSafetyBadgeViewModel;
}

export function buildFactoryCockpitBaySimpleOverviewView(
  input: FactoryCockpitEasyModeInput,
): FactoryCockpitBaySimpleOverviewViewModel {
  const { project, cockpit } = input;
  const activeBayId = cockpit.activeRun?.bayId ?? findActiveBayId(project.bays) ?? 'drawing-room';
  const bayCard = project.bays.find(bay => bay.bayId === activeBayId) ?? project.bays[0];
  const featured = cockpit.featuredArtifact;
  const overview = cockpit.simpleOverview;
  return {
    screenId: 'bay-simple-overview',
    projectId: project.projectId,
    projectName: project.name,
    bayId: bayCard.bayId,
    bayTitle: BAY_VERBS[bayCard.bayId],
    rightNow: {
      headline: overview.headline,
      detail: overview.currentFocus,
      provenance: provenance('wrapper-derived'),
    },
    latestArtifact: featured ? {
      artifactId: featured.artifactId,
      displayTitle: featured.displayTitle,
      summary: featured.artifact.summary,
      safetyLabel: featured.safetyLabel,
      primaryAction: featured.primaryAction,
      provenance: featuredArtifactProvenance(featured),
    } : undefined,
    nextActionCard: {
      headline: overview.calmState,
      nextAction: nextActionViewFromProject(project),
      provenance: provenance('wrapper-derived'),
    },
    detailsHandle: {
      label: 'Open detailed cockpit',
      hint: 'See the 9-phase timeline, persona panel, and active artifact.',
      provenance: provenance('persisted'),
    },
    safetyBadge: safetyBadgeFromView(project.safety),
  } satisfies FactoryCockpitBaySimpleOverviewViewModel;
}

function featuredArtifactProvenance(
  artifact: FactoryProjectArtifactViewDto,
): FactoryCockpitProvenanceTag {
  if (artifact.safetyLabel === 'metadata-only') {
    return provenance('contract-backed', 'Artifact metadata is from the run; trusted content has not been attested.');
  }
  return provenance('contract-backed');
}

// ---------------------------------------------------------------------------
// Detailed cockpit
// ---------------------------------------------------------------------------

export interface FactoryCockpitTimelinePhaseView {
  readonly phaseId: string;
  readonly title: string;
  readonly bayId: FactoryProjectBayId;
  readonly statusLabel: string;
  readonly phaseStatus: FactoryProjectPhaseViewDto['status'];
  readonly personaTitle: string;
  readonly artifactIds: readonly string[];
  readonly gateIds: readonly string[];
  readonly isCurrent: boolean;
}

export interface FactoryCockpitDetailedCockpitViewModel {
  readonly screenId: 'detailed-cockpit';
  readonly projectId: string;
  readonly projectName: string;
  readonly activeRun?: {
    readonly runId: string;
    readonly workflowId: string;
    readonly workflowTitle: string;
    readonly stage: FactoryProjectStage;
    readonly bayId: FactoryProjectBayId;
    readonly statusLabel: string;
    readonly currentPhaseTitle?: string;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly timeline: {
    readonly phases: readonly FactoryCockpitTimelinePhaseView[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly conversationWorkspace: {
    readonly phaseId?: string;
    readonly phaseTitle?: string;
    readonly objective?: string;
    readonly activePersona?: FactoryCockpitPersonaSummaryView;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly personaPanel: {
    readonly personas: readonly FactoryProjectPersonaViewDto[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly featuredArtifact?: {
    readonly artifactId: string;
    readonly displayTitle: string;
    readonly summary: string;
    readonly safetyLabel: FactoryArtifactSafetyLabel;
    readonly primaryAction: FactoryArtifactPrimaryAction;
    readonly content: FactoryArtifactContentSummaryDto;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly decisionQueue: {
    readonly items: readonly FactoryCockpitDashboardDecisionItemView[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly safetyBadge: FactoryCockpitSafetyBadgeViewModel;
  readonly nextAction: FactoryCockpitNextActionView;
}

export function buildFactoryCockpitDetailedView(
  input: FactoryCockpitEasyModeInput,
): FactoryCockpitDetailedCockpitViewModel {
  const { project, cockpit } = input;
  const activeRun = cockpit.activeRun;
  const decisionItems = cockpit.decisionQueue.map(decision => ({
    projectId: project.projectId,
    projectName: project.name,
    question: decision.plainLanguageQuestion,
    recommendedAction: decision.title,
    runId: decision.runId,
    gateId: decision.gateId,
  } satisfies FactoryCockpitDashboardDecisionItemView));
  return {
    screenId: 'detailed-cockpit',
    projectId: project.projectId,
    projectName: project.name,
    activeRun: activeRun ? {
      runId: activeRun.runId,
      workflowId: activeRun.run.workflowId,
      workflowTitle: activeRun.run.workflowTitle,
      stage: activeRun.stage,
      bayId: activeRun.bayId,
      statusLabel: runStatusLabel(activeRun.run),
      currentPhaseTitle: activeRun.run.currentPhase?.title,
      provenance: provenance('contract-backed'),
    } : undefined,
    timeline: {
      phases: cockpit.phases.map(phase => phaseTimelineFromPhase(phase, activeRun)),
      provenance: provenance('contract-backed'),
    },
    conversationWorkspace: {
      phaseId: activeRun?.run.currentPhase?.id,
      phaseTitle: activeRun?.run.currentPhase?.title,
      objective: cockpit.phases.find(phase => phase.phaseId === activeRun?.run.currentPhase?.id)?.objective,
      activePersona: project.activePersona ? personaSummaryView(project.activePersona) : undefined,
      provenance: provenance('contract-backed'),
    },
    personaPanel: {
      personas: cockpit.personas,
      provenance: provenance('contract-backed'),
    },
    featuredArtifact: cockpit.featuredArtifact ? {
      artifactId: cockpit.featuredArtifact.artifactId,
      displayTitle: cockpit.featuredArtifact.displayTitle,
      summary: cockpit.featuredArtifact.artifact.summary,
      safetyLabel: cockpit.featuredArtifact.safetyLabel,
      primaryAction: cockpit.featuredArtifact.primaryAction,
      content: cockpit.featuredArtifact.content,
      provenance: featuredArtifactProvenance(cockpit.featuredArtifact),
    } : undefined,
    decisionQueue: {
      items: decisionItems,
      provenance: provenance('wrapper-derived'),
    },
    safetyBadge: safetyBadgeFromView(project.safety),
    nextAction: nextActionViewFromProject(project),
  } satisfies FactoryCockpitDetailedCockpitViewModel;
}

function phaseTimelineFromPhase(
  phase: FactoryProjectPhaseViewDto,
  activeRun: FactoryProjectRunLinkDto | undefined,
): FactoryCockpitTimelinePhaseView {
  const isCurrent = activeRun?.run.currentPhase?.id === phase.phaseId;
  return {
    phaseId: phase.phaseId,
    title: phase.title,
    bayId: phase.bayId,
    statusLabel: phaseStatusLabel(phase.status),
    phaseStatus: phase.status,
    personaTitle: phase.personaTitle,
    artifactIds: phase.artifactIds,
    gateIds: phase.gateIds,
    isCurrent,
  } satisfies FactoryCockpitTimelinePhaseView;
}

function phaseStatusLabel(status: FactoryProjectPhaseViewDto['status']): string {
  switch (status) {
    case 'running':
      return 'In progress';
    case 'waiting-for-user':
      return 'Waiting on you';
    case 'blocked':
      return 'Blocked';
    case 'complete':
      return 'Complete';
    case 'skipped':
      return 'Skipped';
    case 'not-started':
      return 'Not started';
  }
}

function runStatusLabel(run: FactoryRunStatusDto): string {
  switch (run.status) {
    case 'running':
      return 'In progress';
    case 'paused':
      return run.pause?.kind === 'gate' ? 'Waiting on a decision' : 'Waiting on external work';
    case 'completed':
      return run.workflowId === 'ship' ? FACTORY_COCKPIT_SUCCESS_LABEL : 'Completed';
    case 'failed':
      return 'Blocked';
    case 'cancelled':
      return 'Cancelled';
    case 'blocked':
      return 'Blocked';
  }
}

// ---------------------------------------------------------------------------
// Gate decision surface
// ---------------------------------------------------------------------------

export interface FactoryCockpitGateDecisionSurfaceViewModel {
  readonly screenId: 'gate-decision';
  readonly decisionId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly runId: string;
  readonly gateId: string;
  readonly requestSequence: number;
  readonly title: string;
  readonly plainLanguageQuestion: string;
  readonly whyItMatters: string;
  readonly whatUniverseWillDo: string;
  readonly whatUniverseCannotDo: readonly string[];
  readonly supportingArtifactIds: readonly string[];
  readonly safetyImpact: FactoryCockpitSafetyBadgeViewModel;
  readonly allowedDecisions: readonly FactoryGateDecisionValue[];
  readonly recommendation?: FactoryGateDecisionValue;
  readonly activePersona?: FactoryCockpitPersonaSummaryView;
  readonly states: {
    readonly canLoad: true;
    readonly canBecomeStale: true;
    readonly canConflict: true;
    readonly canBePermissionBlocked: true;
    readonly preventsDoubleSubmit: true;
  };
  readonly provenance: FactoryCockpitProvenanceTag;
  readonly gate: FactoryGateInfoDto;
}

export function buildFactoryCockpitGateDecisionView(
  decision: FactoryProjectDecisionQueueItemDto,
): FactoryCockpitGateDecisionSurfaceViewModel {
  return {
    screenId: 'gate-decision',
    decisionId: decision.decisionId,
    projectId: decision.projectId,
    projectName: decision.projectName,
    runId: decision.runId,
    gateId: decision.gateId,
    requestSequence: decision.requestSequence,
    title: decision.title,
    plainLanguageQuestion: decision.plainLanguageQuestion,
    whyItMatters: decision.gate.description.length > 0
      ? decision.gate.description
      : 'Universe is pausing here so you can confirm the next step.',
    whatUniverseWillDo: decision.whatHappensNext,
    whatUniverseCannotDo: decision.safetyImpact.blockedExamples,
    supportingArtifactIds: decision.supportingArtifactIds,
    safetyImpact: safetyBadgeFromView(decision.safetyImpact),
    allowedDecisions: decision.allowedDecisions,
    recommendation: decision.recommendation,
    activePersona: decision.activePersona ? personaSummaryView(decision.activePersona) : undefined,
    states: {
      canLoad: true,
      canBecomeStale: true,
      canConflict: true,
      canBePermissionBlocked: true,
      preventsDoubleSubmit: true,
    },
    provenance: provenance('contract-backed', 'Gate fields come from the factory run; safety/copy are wrapper-derived.'),
    gate: decision.gate,
  } satisfies FactoryCockpitGateDecisionSurfaceViewModel;
}

// ---------------------------------------------------------------------------
// QA evidence panel
// ---------------------------------------------------------------------------

export type FactoryCockpitQAMode = 'audit' | 'fix';

export interface FactoryCockpitQAScenarioView {
  readonly artifactId: string;
  readonly displayTitle: string;
  readonly summary: string;
  readonly status: 'evidence' | 'needs-review' | 'produced' | 'accepted-risk';
  readonly safetyLabel: FactoryArtifactSafetyLabel;
  readonly primaryAction: FactoryArtifactPrimaryAction;
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitQAEvidenceViewModel {
  readonly screenId: 'qa-evidence';
  readonly projectId: string;
  readonly projectName: string;
  readonly mode: FactoryCockpitQAMode;
  readonly banner: string;
  readonly targetEnvironment: {
    readonly headline: string;
    readonly description: string;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly scenarios: {
    readonly items: readonly FactoryCockpitQAScenarioView[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly fixLoopCta?: {
    readonly headline: string;
    readonly disclaimer: string;
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly safetyBadge: FactoryCockpitSafetyBadgeViewModel;
}

export function buildFactoryCockpitQAEvidenceView(
  input: FactoryCockpitEasyModeInput,
): FactoryCockpitQAEvidenceViewModel {
  const { project, cockpit } = input;
  const isFixRun = cockpit.activeRun?.run.workflowId === 'qa-fix' || project.projectStatus === 'fix-loop';
  const mode: FactoryCockpitQAMode = isFixRun ? 'fix' : 'audit';
  const evidenceArtifacts = cockpit.artifacts.filter(artifact => isQAEvidenceArtifact(artifact));
  return {
    screenId: 'qa-evidence',
    projectId: project.projectId,
    projectName: project.name,
    mode,
    banner: mode === 'audit' ? FACTORY_COCKPIT_QA_AUDIT_BANNER : FACTORY_COCKPIT_QA_FIX_BANNER,
    targetEnvironment: {
      headline: mode === 'audit'
        ? 'Browser audit target'
        : 'Safe local fix target',
      description: mode === 'audit'
        ? 'Universe drives the live browser surface only; it does not edit project files in this state.'
        : 'Universe can edit project files locally with the non-destructive-write profile and rerun browser QA.',
      provenance: provenance('wrapper-derived'),
    },
    scenarios: {
      items: evidenceArtifacts.map(artifact => qaScenarioFromArtifact(artifact)),
      provenance: provenance('contract-backed'),
    },
    fixLoopCta: mode === 'audit' ? {
      headline: 'Start a safe local fix loop',
      disclaimer: 'The fix loop is a separate approval. It does not deploy.',
      provenance: provenance('wrapper-derived'),
    } : undefined,
    safetyBadge: safetyBadgeFromView(project.safety),
  } satisfies FactoryCockpitQAEvidenceViewModel;
}

function isQAEvidenceArtifact(artifact: FactoryProjectArtifactViewDto): boolean {
  return artifact.artifact.kind === 'qa-report'
    || artifact.artifact.kind === 'browser-trace'
    || artifact.artifact.kind === 'screenshot'
    || artifact.artifact.kind === 'test-result';
}

function qaScenarioFromArtifact(
  artifact: FactoryProjectArtifactViewDto,
): FactoryCockpitQAScenarioView {
  return {
    artifactId: artifact.artifactId,
    displayTitle: artifact.displayTitle,
    summary: artifact.artifact.summary,
    status: artifact.state,
    safetyLabel: artifact.safetyLabel,
    primaryAction: artifact.primaryAction,
    provenance: featuredArtifactProvenance(artifact),
  } satisfies FactoryCockpitQAScenarioView;
}

// ---------------------------------------------------------------------------
// Ship readiness / handoff
// ---------------------------------------------------------------------------

export type FactoryCockpitShipChecklistGroup = 'quality' | 'product' | 'qa' | 'release' | 'handoff';
export type FactoryCockpitShipChecklistStatus = 'complete' | 'pending' | 'accepted-risk';

export interface FactoryCockpitShipChecklistItem {
  readonly id: string;
  readonly group: FactoryCockpitShipChecklistGroup;
  readonly label: string;
  readonly status: FactoryCockpitShipChecklistStatus;
  readonly note?: string;
  readonly provenance: FactoryCockpitProvenanceTag;
}

export interface FactoryCockpitShipReadinessViewModel {
  readonly screenId: 'ship-readiness';
  readonly projectId: string;
  readonly projectName: string;
  readonly disclaimer: string;
  readonly successLabel: string;
  readonly readyForHandoff: boolean;
  readonly checklist: readonly FactoryCockpitShipChecklistItem[];
  readonly acceptedRisks: readonly string[];
  readonly handoffBundle: {
    readonly artifactIds: readonly string[];
    readonly provenance: FactoryCockpitProvenanceTag;
  };
  readonly safetyBadge: FactoryCockpitSafetyBadgeViewModel;
  readonly nextAction: FactoryCockpitNextActionView;
}

export function buildFactoryCockpitShipReadinessView(
  input: FactoryCockpitEasyModeInput,
): FactoryCockpitShipReadinessViewModel {
  const { project, cockpit } = input;
  const shipRun = cockpit.runs.find(run => run.run.workflowId === 'ship') ?? cockpit.activeRun;
  const readyForHandoff = project.projectStatus === 'ready-for-handoff'
    || (shipRun?.run.status === 'completed' && shipRun.run.workflowId === 'ship');
  const checklist = shipChecklistFromProject(project, readyForHandoff);
  const acceptedRisks = cockpit.artifacts
    .filter(artifact => artifact.state === 'accepted-risk')
    .map(artifact => artifact.displayTitle);
  const handoffArtifactIds = shipRun
    ? cockpit.artifacts.filter(artifact => artifact.runId === shipRun.runId).map(artifact => artifact.artifactId)
    : [];
  return {
    screenId: 'ship-readiness',
    projectId: project.projectId,
    projectName: project.name,
    disclaimer: FACTORY_COCKPIT_SHIP_DISCLAIMER,
    successLabel: FACTORY_COCKPIT_SUCCESS_LABEL,
    readyForHandoff,
    checklist,
    acceptedRisks,
    handoffBundle: {
      artifactIds: handoffArtifactIds,
      provenance: provenance('contract-backed'),
    },
    safetyBadge: safetyBadgeFromView(project.safety),
    nextAction: nextActionViewFromProject(project),
  } satisfies FactoryCockpitShipReadinessViewModel;
}

function shipChecklistFromProject(
  project: FactoryProjectSummaryDto,
  readyForHandoff: boolean,
): readonly FactoryCockpitShipChecklistItem[] {
  const phasesComplete = project.activeRunProgress
    ? project.activeRunProgress.completed >= project.activeRunProgress.total
    : project.progress.completed >= project.progress.total;
  return [
    {
      id: 'quality-review-complete',
      group: 'quality',
      label: 'Build review is complete',
      status: phasesComplete ? 'complete' : 'pending',
      note: phasesComplete ? undefined : 'The build review is still in progress.',
      provenance: provenance('wrapper-derived'),
    },
    {
      id: 'product-decisions-resolved',
      group: 'product',
      label: 'Product decisions are resolved',
      status: project.pendingDecisionCount === 0 ? 'complete' : 'pending',
      note: project.pendingDecisionCount === 0
        ? undefined
        : `${project.pendingDecisionCount} decision${project.pendingDecisionCount === 1 ? '' : 's'} still waiting on you.`,
      provenance: provenance('wrapper-derived'),
    },
    {
      id: 'qa-evidence-captured',
      group: 'qa',
      label: 'Browser QA evidence captured',
      status: project.artifactCount > 0 ? 'complete' : 'pending',
      note: project.artifactCount === 0 ? 'Run QA before continuing.' : undefined,
      provenance: provenance('wrapper-derived'),
    },
    {
      id: 'release-actions-locked',
      group: 'release',
      label: 'Release actions remain locked in this workflow',
      status: 'complete',
      note: 'No tag, publish, push, or deploy happens in this workflow.',
      provenance: provenance('wrapper-derived', 'Copy lock enforced by the wrapper.'),
    },
    {
      id: 'handoff-bundle-ready',
      group: 'handoff',
      label: 'Handoff bundle is ready',
      status: readyForHandoff ? 'complete' : 'pending',
      note: readyForHandoff
        ? 'A developer or future deployment workflow can pick up from here.'
        : 'The bundle finalizes when ship readiness completes.',
      provenance: provenance('wrapper-derived'),
    },
  ] satisfies readonly FactoryCockpitShipChecklistItem[];
}

// ---------------------------------------------------------------------------
// Aggregate bundle
// ---------------------------------------------------------------------------

export interface FactoryCockpitBundleInput extends FactoryCockpitEasyModeInput {
  readonly workspace: FactoryWorkspaceSummaryDto;
  readonly workspaceProjects: readonly FactoryProjectSummaryDto[];
  readonly ideaDraft?: FactoryCockpitIdeaWizardDraft;
  readonly handledFeed?: readonly FactoryCockpitEasyHandledFeedItem[];
}

export interface FactoryCockpitBundle {
  readonly dashboard: FactoryCockpitDashboardViewModel;
  readonly ideaWizard?: FactoryCockpitIdeaWizardViewModel;
  readonly easyMode: FactoryCockpitEasyModeViewModel;
  readonly bayMap: FactoryCockpitBayMapViewModel;
  readonly baySimpleOverview: FactoryCockpitBaySimpleOverviewViewModel;
  readonly detailedCockpit: FactoryCockpitDetailedCockpitViewModel;
  readonly gateDecision?: FactoryCockpitGateDecisionSurfaceViewModel;
  readonly qaEvidence: FactoryCockpitQAEvidenceViewModel;
  readonly shipReadiness: FactoryCockpitShipReadinessViewModel;
}

export function buildFactoryCockpitBundle(input: FactoryCockpitBundleInput): FactoryCockpitBundle {
  const baseInput: FactoryCockpitEasyModeInput = {
    project: input.project,
    cockpit: input.cockpit,
    handledFeed: input.handledFeed,
  };
  const dashboard = buildFactoryCockpitDashboardView({
    workspace: input.workspace,
    projects: input.workspaceProjects,
  });
  const ideaWizard = input.ideaDraft
    ? buildFactoryCockpitIdeaWizardView({
      workspaceId: input.workspace.workspaceId,
      workspaceName: input.workspace.name,
      draft: input.ideaDraft,
    })
    : undefined;
  const gateDecision = input.cockpit.pendingDecision
    ? buildFactoryCockpitGateDecisionView(input.cockpit.pendingDecision)
    : undefined;
  return {
    dashboard,
    ideaWizard,
    easyMode: buildFactoryCockpitEasyModeView(baseInput),
    bayMap: buildFactoryCockpitBayMapView(baseInput),
    baySimpleOverview: buildFactoryCockpitBaySimpleOverviewView(baseInput),
    detailedCockpit: buildFactoryCockpitDetailedView(baseInput),
    gateDecision,
    qaEvidence: buildFactoryCockpitQAEvidenceView(baseInput),
    shipReadiness: buildFactoryCockpitShipReadinessView(baseInput),
  } satisfies FactoryCockpitBundle;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function safetyBadgeFromView(
  view: FactoryProjectSafetyViewDto,
): FactoryCockpitSafetyBadgeViewModel {
  return {
    state: view.state,
    label: safetyStateLabel(view.state),
    summary: view.plainLanguageSummary,
    blockedExamples: view.blockedExamples,
    allowWrites: view.allowWrites,
    allowBrowser: view.allowBrowser,
    allowNetwork: view.allowNetwork,
    commandSafetyProfile: view.commandSafetyProfile,
    provenance: provenance('wrapper-derived'),
  } satisfies FactoryCockpitSafetyBadgeViewModel;
}

function safetyStateLabel(state: FactoryProjectSafetyStateView): string {
  switch (state) {
    case 'read-only-audit':
      return 'Read-only audit';
    case 'browser-qa-audit':
      return 'Browser QA audit';
    case 'safe-local-fixes':
      return 'Safe local fixes';
    case 'network-ci-allowed':
      return 'Network CI allowed';
    case 'release-action-locked':
      return 'Release actions locked';
    case 'blocked-by-policy':
      return 'Blocked by policy';
  }
}

function personaSummaryView(
  persona: FactoryProjectPersonaSummaryDto,
): FactoryCockpitPersonaSummaryView {
  return {
    personaId: persona.personaId,
    title: persona.title,
    runId: persona.runId,
    phaseId: persona.phaseId,
    provenance: provenance('contract-backed'),
  } satisfies FactoryCockpitPersonaSummaryView;
}

function nextActionViewFromProject(
  project: FactoryProjectSummaryDto,
): FactoryCockpitNextActionView {
  return {
    kind: project.nextAction.kind,
    label: project.nextAction.label,
    supportingText: project.nextAction.supportingText,
    runId: project.nextAction.runId,
    gateId: project.nextAction.gateId,
    phaseId: project.nextAction.phaseId,
    provenance: provenance('wrapper-derived'),
  } satisfies FactoryCockpitNextActionView;
}
