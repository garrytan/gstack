import { DISPATCHERS, SOURCE_ASSIGNMENTS, assignmentBySource } from './assignments';
import type { ScenarioFixture, TreeName } from './types';
import { evaluateAuthorityPolicy, type AdversarialAttempt } from './authority-policy';
import { inferExecutionProfile } from './execution-profiles';

export interface StructuredRoute {
  tree: TreeName;
  mode: string;
  depth: ScenarioFixture['expected']['depth'];
  mutation: string;
  active_modules: string[];
  skipped_modules: string[];
  web_context: ScenarioFixture['expected']['web_context'];
}

export function routeAndAuthorize(
  signals: Record<string, unknown>,
  instruction: { rawText: string; semantic: AdversarialAttempt },
) {
  if (!instruction || typeof instruction.rawText !== 'string' || !instruction.semantic) {
    throw new TypeError('A raw instruction and independently decoded semantic envelope are required');
  }
  const route = routeStructured(signals);
  return {
    route,
    authorization: evaluateAuthorityPolicy(route, instruction.semantic),
    instruction: { rawText: instruction.rawText, semantic: instruction.semantic },
  };
}

/**
 * Deterministic evaluator used by parity fixtures. It intentionally accepts no
 * prompt text: decisions come from product-stage, surface, authorization, and
 * evidence signals, which prevents fixtures from passing through keyword echo.
 */
export function routeStructured(signals: Record<string, unknown>): StructuredRoute {
  let tree: TreeName;
  let mode: string;
  let source: string;
  let activeModules: string[] | undefined;

  if (signals.release_stage) {
    tree = 'ship';
    if (signals.release_stage === 'working-branch') {
      mode = 'Prepare'; source = 'ship';
    } else if (signals.release_stage === 'approved-pr') {
      mode = 'Land'; source = 'land-and-deploy';
    } else if (signals.release_stage === 'landed') {
      mode = 'Deploy'; source = 'land-and-deploy';
    } else if (signals.release_stage === 'monitoring') {
      mode = 'Monitor'; source = 'canary';
    } else if (signals.release_stage === 'interrupted') {
      mode = 'Resume'; source = 'land-and-deploy'; activeModules = ['context-restore', 'land-and-deploy'];
    } else {
      mode = 'Prepare'; source = 'document-release';
    }
  } else if (signals.failure) {
    tree = 'debug';
    if (signals.mutation_authorized === true) {
      mode = 'Fix';
      source = signals.platform === 'ios' && signals.reproducible === true ? 'ios-fix' : 'investigate';
    } else {
      mode = 'Diagnose-only'; source = 'investigate';
    }
  } else if (signals.audit_focus) {
    tree = 'review';
    if (signals.audit_focus === 'security') {
      mode = 'Security'; source = 'cso';
    } else if (signals.audit_focus === 'performance') {
      mode = 'Performance'; source = 'review';
    } else if (signals.audit_focus === 'deep') {
      mode = 'Deep'; source = 'review'; activeModules = ['review', 'health', 'codex', 'claude'];
    } else {
      mode = 'Normal'; source = 'review';
    }
  } else if (signals.deployed === true) {
    tree = 'qa'; mode = 'Report'; source = 'canary';
  } else if (signals.measurement === 'performance') {
    tree = 'qa'; mode = 'Report'; source = 'benchmark';
  } else if (signals.surface === 'developer-workflow') {
    tree = 'qa';
    if (signals.mutation_authorized === true) {
      mode = 'Fix'; source = 'qa'; activeModules = ['devex-review', 'qa', 'investigate', 'system-functional'];
    } else {
      mode = 'Report'; source = 'devex-review'; activeModules = ['devex-review', 'qa-only', 'investigate', 'system-functional'];
    }
  } else if (signals.surface === 'ios' && signals.real_device === true) {
    if (signals.interaction_required === true) {
      tree = 'qa'; mode = 'Report'; source = 'ios-qa';
    } else {
      tree = 'design'; mode = 'Critique'; source = 'ios-design-review';
    }
  } else if (signals.surface === 'design-system') {
    tree = 'design'; mode = 'Generate'; source = 'design-consultation';
  } else if (signals.alternatives_requested === true) {
    tree = 'design'; mode = 'Explore'; source = 'design-shotgun';
  } else if (signals.output === 'html-css') {
    tree = 'design'; mode = 'Implement'; source = 'design-html';
  } else if (signals.surface === 'web' && signals.implementation_exists === false) {
    tree = 'design'; mode = 'Critique'; source = 'plan-design-review';
  } else if (signals.surface === 'web' && signals.evidence === 'before-after') {
    tree = 'design'; mode = 'Implement'; source = 'design-review';
  } else if (signals.surface === 'web' && signals.implementation_exists === true) {
    tree = 'qa';
    if (signals.mutation_authorized === true) {
      mode = 'Fix'; source = 'qa';
    } else {
      mode = 'Report'; source = 'qa-only';
    }
  } else {
    tree = 'plan';
    if (signals.output === 'executable-backlog-item') {
      mode = 'Specification'; source = 'spec';
    } else if (Array.isArray(signals.review_axes) && signals.automatic_decisions === true) {
      mode = 'Full chain'; source = 'autoplan';
    } else if (signals.audience === 'developers') {
      mode = 'DX'; source = 'plan-devex-review';
    } else if (signals.uncertainty === 'architecture-data') {
      mode = 'Engineering'; source = 'plan-eng-review';
    } else if (signals.uncertainty === 'scope-strategy') {
      mode = 'Product'; source = 'plan-ceo-review';
    } else {
      mode = 'Discovery'; source = 'office-hours';
    }
  }

  const dispatcher = DISPATCHERS.find((entry) => entry.name === tree);
  if (!dispatcher?.modes.some((entry) => entry.mode === mode)) throw new Error(`No dispatcher route for ${tree}:${mode}`);
  const specialist = assignmentBySource(source);
  const active = activeModules ?? [source];
  const primary = SOURCE_ASSIGNMENTS
    .filter((entry) => entry.tree === tree && entry.visibility === 'primary')
    .map((entry) => entry.source);
  let mutation = mode === 'Fix' && source === 'investigate'
    ? 'fix-safe-after-root-cause'
    : specialist.defaultMutation;

  // Structured routing may select a useful review mode without granting the
  // mutation that specialist can perform. Missing authority fails closed;
  // fixing code requires an affirmative grant, not merely the absence of a
  // denial. Irreversible ship stages use their separate external grant below.
  if (signals.mutation_authorized !== true && ['fix-safe', 'fix-safe-after-root-cause', 'code-generation'].includes(mutation)) {
    mutation = 'report-only';
  }
  if (source === 'spec' && mutation === 'spec-and-issue' && signals.issue_mutation_allowed !== true) {
    mutation = 'spec-only';
  }
  if (
    tree === 'ship'
    && ['commit-push-pr', 'merge-deploy', 'deploy'].includes(mutation)
    && signals.external_mutation_authorized !== true
  ) {
    mutation = 'approval-required';
  }
  return {
    tree,
    mode,
    depth: inferExecutionProfile(signals, specialist.defaultDepth),
    mutation,
    active_modules: active,
    skipped_modules: primary.filter((candidate) => !active.includes(candidate)),
    web_context: specialist.webContext,
  };
}
