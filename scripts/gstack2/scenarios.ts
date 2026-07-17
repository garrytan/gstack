import { SOURCE_ASSIGNMENTS } from './assignments';
import type { ScenarioFixture, TreeName } from './types';

type ExpectedInput = Omit<ScenarioFixture['expected'], 'skipped_modules'>;

function fixture(
  id: string,
  prompt: string,
  signals: Record<string, unknown>,
  expected: ExpectedInput,
): ScenarioFixture {
  const eligible = SOURCE_ASSIGNMENTS
    .filter((entry) => entry.tree === expected.tree && entry.visibility === 'primary')
    .map((entry) => entry.source);
  return {
    id,
    prompt,
    signals,
    expected: {
      ...expected,
      skipped_modules: eligible.filter((source) => !expected.active_modules.includes(source)),
    },
  };
}

const E = (
  tree: TreeName,
  mode: string,
  depth: ExpectedInput['depth'],
  mutation: string,
  active_modules: string[],
  web_context: ExpectedInput['web_context'],
  decision_basis: string[],
  gap?: string,
): ExpectedInput => ({ tree, mode, depth, mutation, active_modules, web_context, decision_basis, gap });

/**
 * These prompts deliberately avoid skill and mode names. Routing assertions use
 * structured product-stage, surface, authorization, and evidence signals rather
 * than substring matching against the natural-language prompt.
 */
export const SCENARIOS: ScenarioFixture[] = [
  fixture(
    'idea-before-solution',
    'People abandon restaurant waitlists. Help me decide whether there is a real product here.',
    { phase: 'pre-solution', premise_confidence: 'low', artifact_exists: false, user_surface: 'consumer' },
    E('plan', 'Discovery', 'deep', 'design-doc-only', ['office-hours'], 'optional', ['phase=pre-solution', 'premise_confidence=low']),
  ),
  fixture(
    'scope-and-ambition',
    'This proposal works, but I am unsure whether it is the right-sized bet for the company.',
    { phase: 'proposal', artifact_exists: true, uncertainty: 'scope-strategy', architecture_locked: false },
    E('plan', 'Product', 'deep', 'plan-only', ['plan-ceo-review'], 'optional', ['artifact_exists=true', 'uncertainty=scope-strategy']),
  ),
  fixture(
    'architecture-data-contracts',
    'Pressure-test the persistence model, failure paths, migration, and rollback before anyone codes it.',
    { phase: 'implementation-design', artifact_exists: true, uncertainty: 'architecture-data', developer_product: false },
    E('plan', 'Engineering', 'deep', 'plan-only', ['plan-eng-review'], 'none', ['uncertainty=architecture-data', 'phase=implementation-design']),
  ),
  fixture(
    'developer-first-onboarding',
    'A new SDK user should get their first successful response in five minutes. Review the proposed journey.',
    { phase: 'proposal', artifact_exists: true, audience: 'developers', journey: 'onboarding', measurement_needed: true },
    E('plan', 'DX', 'deep', 'plan-only', ['plan-devex-review'], 'optional', ['audience=developers', 'journey=onboarding']),
  ),
  fixture(
    'cross-functional-decision',
    'Run the complete set of product, interface, architecture, and developer-experience checks on this proposal.',
    { phase: 'proposal', artifact_exists: true, review_axes: ['product', 'interface', 'architecture', 'developer-experience'], automatic_decisions: true },
    E('plan', 'Full chain', 'deep', 'plan-only', ['autoplan'], 'optional', ['review_axes_count=4', 'automatic_decisions=true']),
  ),
  fixture(
    'backlog-ready-handoff',
    'Turn this rough intent into acceptance criteria, edge cases, validation, rollback, and a handoff another engineer can execute.',
    { phase: 'handoff', artifact_exists: false, output: 'executable-backlog-item', issue_mutation_allowed: true },
    E('plan', 'Specification', 'deep', 'spec-and-issue', ['spec'], 'optional', ['output=executable-backlog-item', 'phase=handoff']),
  ),

  fixture(
    'new-visual-system',
    'Define the typography, color, layout, motion, and interaction rationale for a calm clinical product.',
    { surface: 'design-system', implementation_exists: false, alternatives_requested: false, output: 'system-artifacts' },
    E('design', 'Generate', 'deep', 'design-artifacts', ['design-consultation'], 'optional', ['surface=design-system', 'implementation_exists=false']),
  ),
  fixture(
    'compare-directions',
    'I do not know which visual direction is right. Show several concrete options I can react to.',
    { surface: 'visual-direction', implementation_exists: false, alternatives_requested: true, output: 'comparison' },
    E('design', 'Explore', 'deep', 'design-artifacts', ['design-shotgun'], 'optional', ['alternatives_requested=true', 'output=comparison']),
  ),
  fixture(
    'coded-marketing-surface',
    'Produce the responsive page implementation with real text reflow and accessible interactions.',
    { surface: 'web', implementation_exists: false, output: 'html-css', runtime_verification: true },
    E('design', 'Implement', 'standard', 'design-artifacts', ['design-html'], 'local-browser', ['output=html-css', 'runtime_verification=true']),
  ),
  fixture(
    'prebuild-interface-critique',
    'Before implementation, check the states, hierarchy, accessibility, responsive behavior, and interaction decisions in this document.',
    { surface: 'web', implementation_exists: false, artifact_exists: true, output: 'plan-revision' },
    E('design', 'Critique', 'deep', 'plan-only', ['plan-design-review'], 'optional', ['implementation_exists=false', 'artifact_exists=true']),
  ),
  fixture(
    'implemented-interface-audit',
    'Inspect the running dashboard, repair visual inconsistencies, and prove the improvements with before-and-after evidence.',
    { surface: 'web', implementation_exists: true, mutation_authorized: true, evidence: 'before-after' },
    E('design', 'Implement', 'deep', 'fix-safe', ['design-review'], 'local-browser', ['implementation_exists=true', 'mutation_authorized=true']),
  ),
  fixture(
    'real-device-hig-audit',
    'Score every screen of the installed phone app against platform conventions and capture device evidence.',
    { surface: 'ios', implementation_exists: true, real_device: true, mutation_authorized: false },
    E('design', 'Critique', 'deep', 'report-only', ['ios-design-review'], 'none', ['surface=ios', 'real_device=true']),
  ),

  fixture(
    'browser-findings-only',
    'Exercise checkout in the running site and give me reproducible findings, but do not change the repository.',
    { surface: 'web', implementation_exists: true, mutation_authorized: false, evidence_required: true },
    E('qa', 'Report', 'deep', 'report-only', ['qa-only'], 'local-browser', ['surface=web', 'mutation_authorized=false']),
  ),
  fixture(
    'browser-fix-and-verify',
    'Exercise checkout, repair validated defects, and repeat the same interactions to prove each repair.',
    { surface: 'web', implementation_exists: true, mutation_authorized: true, verification_after_mutation: true },
    E('qa', 'Fix', 'deep', 'fix-safe', ['qa'], 'local-browser', ['surface=web', 'mutation_authorized=true']),
  ),
  fixture(
    'device-state-journey',
    'Drive the account flow on the plugged-in phone, recording state and screenshots at each transition.',
    { surface: 'ios', real_device: true, interaction_required: true, mutation_authorized: false },
    E('qa', 'Report', 'deep', 'report-only', ['ios-qa'], 'none', ['surface=ios', 'real_device=true']),
  ),
  fixture(
    'cli-api-journey',
    'Time a new developer from installation through the first successful API call and evaluate the errors they encounter.',
    { surface: 'developer-workflow', channels: ['cli', 'api'], functional_backend_harness: true, journey_measurement: true },
    E('qa', 'Report', 'deep', 'report-only', ['devex-review', 'qa-only', 'investigate', 'system-functional'], 'optional', ['surface=developer-workflow', 'journey_measurement=true', 'functional_backend_harness=true']),
  ),
  fixture(
    'measured-page-regression',
    'Compare this branch with the baseline using load timing, web vitals, and resource-size evidence.',
    { surface: 'web', measurement: 'performance', baseline_exists: true, repeated_samples: true },
    E('qa', 'Report', 'standard', 'report-only', ['benchmark'], 'local-browser', ['measurement=performance', 'baseline_exists=true']),
  ),
  fixture(
    'production-threshold-watch',
    'Watch the newly deployed site against its baseline and alert only when the declared rollback limits are crossed.',
    { surface: 'production', deployed: true, repeated_samples: true, thresholds_declared: true },
    E('qa', 'Report', 'deep', 'report-only', ['canary'], 'production', ['deployed=true', 'thresholds_declared=true']),
  ),

  fixture(
    'unknown-intermittent-cause',
    'This race appears once every few runs. Establish the cause with discriminating evidence before proposing a change.',
    { failure: true, cause_known: false, intermittent: true, platform: 'general' },
    E('debug', 'Diagnose-only', 'deep', 'investigate-only', ['investigate'], 'optional', ['cause_known=false', 'intermittent=true']),
  ),
  fixture(
    'reproducible-device-defect',
    'The crash reproduces on the connected phone. Repair it and preserve the failing state as a regression fixture.',
    { failure: true, cause_known: false, reproducible: true, platform: 'ios', mutation_authorized: true },
    E('debug', 'Fix', 'deep', 'fix-safe', ['ios-fix'], 'none', ['platform=ios', 'reproducible=true']),
  ),

  fixture(
    'ci-script-change-review',
    'Inspect this branch before landing; most edits are workflow and release scripts, and I want consequential findings validated.',
    { change_exists: true, changed_file_classes: { ci: 4, scripts: 2, application: 0 }, audit_focus: 'broad', mutation_authorized: true },
    E('review', 'Normal', 'deep', 'fix-safe', ['review'], 'optional', ['change_exists=true', 'audit_focus=broad']),
  ),
  fixture(
    'threat-surface-audit',
    'Assess authentication, secrets, dependencies, CI trust boundaries, and abuse paths across the repository.',
    { change_exists: false, audit_focus: 'security', threat_model_required: true, mutation_authorized: false },
    E('review', 'Security', 'deep', 'report-only', ['cso'], 'optional', ['audit_focus=security', 'threat_model_required=true']),
  ),

  fixture(
    'branch-to-pull-request',
    'The work is ready. Run the required checks, prepare the release metadata, publish the branch, and open the review request.',
    { release_stage: 'working-branch', external_mutation_authorized: true, pr_exists: false, deploy_requested: false },
    E('ship', 'Prepare', 'deep', 'commit-push-pr', ['ship'], 'optional', ['release_stage=working-branch', 'pr_exists=false']),
  ),
  fixture(
    'approved-change-to-production',
    'The open change is approved. Merge it, wait for delivery, verify production, and be ready to reverse it.',
    { release_stage: 'approved-pr', external_mutation_authorized: true, pr_exists: true, deploy_requested: true },
    E('ship', 'Land', 'deep', 'merge-deploy', ['land-and-deploy'], 'production', ['release_stage=approved-pr', 'deploy_requested=true']),
  ),
  fixture(
    'post-release-doc-alignment',
    'The feature has shipped. Bring the guides, reference, architecture notes, and release narrative into agreement with it.',
    { release_stage: 'post-ship', external_mutation_authorized: false, docs_drift: true, output: 'documentation' },
    E('ship', 'Prepare', 'deep', 'docs-only', ['document-release'], 'optional', ['release_stage=post-ship', 'docs_drift=true']),
  ),
];
