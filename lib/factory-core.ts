/**
 * Pure software-factory core contracts and calculations.
 *
 * This module intentionally contains no filesystem, shell, browser, network, or
 * Pi SDK calls. Runtime adapters turn these data plans into actions.
 */

export type FactoryMode = 'plan-only' | 'build' | 'review' | 'ship';

export type CapabilityName =
  | 'agent-session'
  | 'artifact-store'
  | 'browser'
  | 'ci'
  | 'filesystem'
  | 'git'
  | 'pull-request'
  | 'questions'
  | 'safe-command-guard'
  | 'subagent-session'
  | 'test-runner'
  | 'worktree';

export type PhaseConcurrency = 'serial' | 'parallel-readonly' | 'isolated-worktree';

export type CommandSafetyProfile = 'read-only' | 'non-destructive-write' | 'release-action';

export interface PolicySpec {
  allowWrites: boolean;
  allowNetwork: boolean;
  allowBrowser: boolean;
  requireHumanForDestructive: boolean;
  maxParallelWriteTimelines: number;
  defaultQuestionMode: 'pause' | 'auto-recommend' | 'fail-closed';
  commandSafetyProfile: CommandSafetyProfile;
}

export const DEFAULT_FACTORY_POLICY: PolicySpec = Object.freeze({
  allowWrites: false,
  allowNetwork: false,
  allowBrowser: false,
  requireHumanForDestructive: true,
  maxParallelWriteTimelines: 1,
  defaultQuestionMode: 'pause',
  commandSafetyProfile: 'read-only',
});

export interface AgentRoleSpec {
  id: string;
  title: string;
  prompt?: string;
}

export interface InputSpec {
  id: string;
  description: string;
  required?: boolean;
}

export interface OutputSpec {
  id: string;
  kind: ArtifactKind;
  description: string;
  required?: boolean;
}

export interface GateSpec {
  id: string;
  title: string;
  description: string;
  kind: 'human-decision' | 'policy' | 'verification';
  failClosed?: boolean;
}

export type ArtifactKind =
  | 'browser-trace'
  | 'design-doc'
  | 'diff'
  | 'plan'
  | 'pr'
  | 'qa-report'
  | 'release-note'
  | 'review'
  | 'screenshot'
  | 'test-result';

export interface ArtifactExpectation {
  phaseId: string;
  kind: ArtifactKind;
  required: boolean;
  description: string;
}

export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  summary: string;
  phaseId?: string;
  uri?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface WorktreePhaseSpec {
  owner: string;
  integrationStrategy: 'merge' | 'cherry-pick' | 'artifact-only';
  branchPrefix?: string;
}

export interface PhaseSpec {
  id: string;
  title: string;
  role: AgentRoleSpec;
  objective: string;
  inputs?: InputSpec[];
  outputs?: OutputSpec[];
  gates?: GateSpec[];
  requiredCapabilities?: CapabilityName[];
  concurrency?: PhaseConcurrency;
  worktree?: WorktreePhaseSpec;
  modes?: FactoryMode[];
}

export interface WorkflowSpec {
  id: string;
  title: string;
  description: string;
  phases: PhaseSpec[];
  requiredCapabilities?: CapabilityName[];
  defaultPolicy?: Partial<PolicySpec>;
  allowedCommandSafetyProfiles?: readonly CommandSafetyProfile[];
}

export interface RepoContext {
  provider?: 'github' | 'gitlab' | 'local';
  owner?: string;
  name?: string;
  branch?: string;
  baseBranch?: string;
}

export interface FactoryRunRequest {
  workflow: string;
  goal: string;
  cwd?: string;
  repo?: RepoContext;
  mode?: FactoryMode;
  policy?: Partial<PolicySpec>;
  context?: Record<string, unknown>;
}

export interface PlannedPhase {
  id: string;
  title: string;
  role: AgentRoleSpec;
  objective: string;
  concurrency: PhaseConcurrency;
  worktree?: WorktreePhaseSpec;
  requiredCapabilities: CapabilityName[];
  gates: GateSpec[];
  expectedArtifacts: ArtifactExpectation[];
}

export interface RiskFinding {
  id: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  recommendation: string;
}

export interface FactoryRunPlan {
  runId: string;
  workflow: string;
  mode: FactoryMode;
  goal: string;
  cwd?: string;
  repo?: RepoContext;
  context?: Record<string, unknown>;
  policy: PolicySpec;
  phases: PlannedPhase[];
  requiredCapabilities: CapabilityName[];
  expectedArtifacts: ArtifactExpectation[];
  risks: RiskFinding[];
}

export interface GateRequest {
  id: string;
  phaseId: string;
  title: string;
  description: string;
  kind?: GateSpec['kind'];
  options?: string[];
  recommendation?: string;
}

export interface GateDecision {
  gateId: string;
  requestSequence?: number;
  decision: string;
  reason?: string;
  decidedBy: 'user' | 'policy' | 'adapter';
}

export type FactoryEvent =
  | { type: 'run_started'; runId: string; plan: FactoryRunPlan }
  | { type: 'phase_started'; runId: string; phaseId: string }
  | { type: 'phase_completed'; runId: string; phaseId: string; artifacts?: ArtifactRef[] }
  | { type: 'gate_requested'; runId: string; gate: GateRequest }
  | { type: 'gate_decision'; runId: string; decision: GateDecision }
  | { type: 'artifact_created'; runId: string; artifact: ArtifactRef }
  | { type: 'risk_detected'; runId: string; risk: RiskFinding }
  | { type: 'run_completed'; runId: string; result: FactoryRunResult }
  | { type: 'run_failed'; runId: string; error: FactoryError };

export interface FactoryError {
  code: string;
  message: string;
  phaseId?: string;
  retryable?: boolean;
}

export interface FactoryRunResult {
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  artifacts: ArtifactRef[];
}

export interface FactoryRunState {
  runId?: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentPhaseId?: string;
  completedPhaseIds: string[];
  pendingGates: GateRequest[];
  gateDecisions: GateDecision[];
  artifacts: ArtifactRef[];
  risks: RiskFinding[];
  error?: FactoryError;
  result?: FactoryRunResult;
}

export function mergePolicy(base: Partial<PolicySpec> | undefined, override: Partial<PolicySpec> | undefined): PolicySpec {
  return {
    ...DEFAULT_FACTORY_POLICY,
    ...(base || {}),
    ...(override || {}),
  };
}

export function selectWorkflow(workflows: WorkflowSpec[], workflowId: string): WorkflowSpec {
  const workflow = workflows.find(candidate => candidate.id === workflowId);
  if (!workflow) {
    throw new Error(`Unknown workflow '${workflowId}'. Available workflows: ${workflows.map(w => w.id).join(', ')}`);
  }
  return workflow;
}

export function compileRunPlan(workflow: WorkflowSpec, request: FactoryRunRequest, runId: string): FactoryRunPlan {
  const mode = request.mode || 'plan-only';
  const policy = mergePolicy(workflow.defaultPolicy, request.policy);
  const phases = workflow.phases
    .filter(phase => !phase.modes || phase.modes.includes(mode))
    .map(phase => planPhase(phase));

  const requiredCapabilities = uniqueSorted([
    ...(workflow.requiredCapabilities || []),
    ...phases.flatMap(phase => phase.requiredCapabilities),
  ]);
  const expectedArtifacts = phases.flatMap(phase => phase.expectedArtifacts);

  return {
    runId,
    workflow: workflow.id,
    mode,
    goal: request.goal,
    cwd: request.cwd,
    repo: request.repo,
    context: request.context,
    policy,
    phases,
    requiredCapabilities,
    expectedArtifacts,
    risks: detectPlanRisks({ workflow, request, phases, policy }),
  };
}

export function missingCapabilities(plan: FactoryRunPlan, available: Iterable<CapabilityName>): CapabilityName[] {
  const availableSet = new Set(available);
  return plan.requiredCapabilities.filter(capability => !availableSet.has(capability));
}

export function reduceFactoryEvents(events: readonly FactoryEvent[]): FactoryRunState {
  const state: FactoryRunState = {
    status: 'idle',
    completedPhaseIds: [],
    pendingGates: [],
    gateDecisions: [],
    artifacts: [],
    risks: [],
  };

  for (const event of events) {
    switch (event.type) {
      case 'run_started':
        state.runId = event.runId;
        state.status = 'running';
        state.currentPhaseId = event.plan.phases[0]?.id;
        state.risks = [...state.risks, ...event.plan.risks];
        break;
      case 'phase_started':
        state.runId = event.runId;
        state.status = 'running';
        state.currentPhaseId = event.phaseId;
        break;
      case 'phase_completed':
        state.completedPhaseIds = uniquePreserveOrder([...state.completedPhaseIds, event.phaseId]);
        state.artifacts = [...state.artifacts, ...(event.artifacts || [])];
        if (state.currentPhaseId === event.phaseId) state.currentPhaseId = undefined;
        break;
      case 'gate_requested':
        state.pendingGates = replaceById(state.pendingGates, event.gate);
        state.gateDecisions = state.gateDecisions.filter(decision => decision.gateId !== event.gate.id);
        break;
      case 'gate_decision':
        state.gateDecisions = replaceByGateId(state.gateDecisions, event.decision);
        state.pendingGates = state.pendingGates.filter(gate => gate.id !== event.decision.gateId);
        break;
      case 'artifact_created':
        state.artifacts = replaceById(state.artifacts, event.artifact);
        break;
      case 'risk_detected':
        state.risks = replaceById(state.risks, event.risk);
        break;
      case 'run_completed':
        state.status = event.result.status;
        state.result = event.result;
        state.artifacts = mergeArtifacts(state.artifacts, event.result.artifacts);
        state.currentPhaseId = undefined;
        break;
      case 'run_failed':
        state.status = 'failed';
        state.error = event.error;
        state.currentPhaseId = event.error.phaseId;
        break;
    }
  }

  return state;
}

export function slugifyFactoryId(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'run';
}

function planPhase(phase: PhaseSpec): PlannedPhase {
  return {
    id: phase.id,
    title: phase.title,
    role: phase.role,
    objective: phase.objective,
    concurrency: phase.concurrency || 'serial',
    worktree: phase.worktree,
    requiredCapabilities: requiredCapabilitiesForPhase(phase),
    gates: phase.gates || [],
    expectedArtifacts: (phase.outputs || []).map(output => ({
      phaseId: phase.id,
      kind: output.kind,
      required: output.required !== false,
      description: output.description,
    })),
  };
}

function requiredCapabilitiesForPhase(phase: PhaseSpec): CapabilityName[] {
  const concurrencyCapabilities: CapabilityName[] = phase.concurrency === 'parallel-readonly'
    ? ['subagent-session']
    : phase.concurrency === 'isolated-worktree'
      ? ['subagent-session', 'worktree']
      : [];
  return uniqueSorted([...(phase.requiredCapabilities || []), ...concurrencyCapabilities]);
}

function detectPlanRisks(input: {
  workflow: WorkflowSpec;
  request: FactoryRunRequest;
  phases: PlannedPhase[];
  policy: PolicySpec;
}): RiskFinding[] {
  const risks: RiskFinding[] = [];
  const writePhases = input.phases.filter(phase => phase.requiredCapabilities.includes('filesystem') || phase.requiredCapabilities.includes('git'));
  const browserPhases = input.phases.filter(phase => phase.requiredCapabilities.includes('browser'));
  const networkPhases = input.phases.filter(phase => phase.requiredCapabilities.includes('ci') || phase.requiredCapabilities.includes('pull-request'));
  const isolatedWorktreePhases = input.phases.filter(phase => phase.concurrency === 'isolated-worktree');

  if (writePhases.length > 0 && !input.policy.allowWrites) {
    risks.push({
      id: 'writes-disabled',
      severity: 'blocking',
      message: 'The selected workflow includes write-capable phases but policy.allowWrites is false.',
      recommendation: 'Run in plan-only/review mode or enable writes in the runtime policy after an explicit user decision.',
    });
  }

  if (writePhases.length > 0 && input.policy.allowWrites && input.policy.commandSafetyProfile === 'read-only') {
    risks.push({
      id: 'write-safety-profile-required',
      severity: 'blocking',
      message: 'The selected workflow includes write-capable phases but policy.commandSafetyProfile is read-only.',
      recommendation: 'Choose a non-destructive-write or release-action safety profile after an explicit user decision.',
    });
  }

  if (input.workflow.allowedCommandSafetyProfiles && !input.workflow.allowedCommandSafetyProfiles.includes(input.policy.commandSafetyProfile)) {
    risks.push({
      id: 'command-safety-profile-disallowed',
      severity: 'blocking',
      message: `The selected workflow does not allow command safety profile '${input.policy.commandSafetyProfile}'.`,
      recommendation: `Choose one of: ${input.workflow.allowedCommandSafetyProfiles.join(', ')}.`,
    });
  }

  if (browserPhases.length > 0 && !input.policy.allowBrowser) {
    risks.push({
      id: 'browser-disabled',
      severity: 'blocking',
      message: 'The selected workflow includes browser-capable phases but policy.allowBrowser is false.',
      recommendation: 'Enable the browser capability only after an explicit user decision or choose a non-browser review path.',
    });
  }

  if (networkPhases.length > 0 && !input.policy.allowNetwork) {
    risks.push({
      id: 'network-disabled',
      severity: 'blocking',
      message: 'The selected workflow includes external network capabilities but policy.allowNetwork is false.',
      recommendation: 'Enable network access only after an explicit user decision or choose a non-network plan path.',
    });
  }

  if (!input.request.cwd && input.phases.some(phase => phase.requiredCapabilities.includes('filesystem') || phase.requiredCapabilities.includes('git'))) {
    risks.push({
      id: 'missing-cwd',
      severity: 'blocking',
      message: 'The workflow needs repository actions but the run request has no cwd.',
      recommendation: 'Provide a repository working directory before starting the run.',
    });
  }

  if (isolatedWorktreePhases.length > 0 && !input.policy.allowWrites) {
    risks.push({
      id: 'isolated-worktrees-require-writes',
      severity: 'blocking',
      message: 'The selected workflow includes isolated worktree phases but policy.allowWrites is false.',
      recommendation: 'Enable writes only after an explicit user decision or choose a serial/readonly workflow.',
    });
  }

  if (isolatedWorktreePhases.some(phase => !phase.worktree)) {
    risks.push({
      id: 'isolated-worktree-metadata-required',
      severity: 'blocking',
      message: 'Every isolated-worktree phase must declare ownership and integration metadata.',
      recommendation: 'Add phase.worktree owner and integrationStrategy before dispatching isolated work.',
    });
  }

  if (input.policy.maxParallelWriteTimelines > 1 && isolatedWorktreePhases.length > 0) {
    risks.push({
      id: 'parallel-writes-require-integration-plan',
      severity: 'info',
      message: 'The workflow permits parallel write timelines in isolated worktrees.',
      recommendation: 'Record ownership boundaries and an integration branch before dispatching write-capable agents.',
    });
  }

  return risks;
}

function uniqueSorted<T extends string>(items: T[]): T[] {
  return Array.from(new Set(items)).sort();
}

function uniquePreserveOrder<T extends string>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function replaceById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex(item => item.id === next.id);
  if (index === -1) return [...items, next];
  return [...items.slice(0, index), next, ...items.slice(index + 1)];
}

function replaceByGateId<T extends { gateId: string }>(items: T[], next: T): T[] {
  const index = items.findIndex(item => item.gateId === next.gateId);
  if (index === -1) return [...items, next];
  return [...items.slice(0, index), next, ...items.slice(index + 1)];
}

function mergeArtifacts(current: ArtifactRef[], next: ArtifactRef[]): ArtifactRef[] {
  return next.reduce((acc, artifact) => replaceById(acc, artifact), current);
}
