import { resolve } from 'path';
import type {
  ElementSelector,
  IOSQAFlow,
  IOSQATarget,
  PlanResult,
  XCUITestRunnerConfig,
} from './contract';
import { XCUITEST_CAPABILITIES } from './contract';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SelectorCandidate {
  strategy: 'identifier' | 'label';
  value: string;
  role?: ElementSelector['role'];
}

/** Ordered queries for the XCUITest runner. Never lets a human label outrank a stable id. */
export function selectorCandidates(selector: ElementSelector): SelectorCandidate[] {
  const candidates: SelectorCandidate[] = [];
  if (selector.identifier) candidates.push({ strategy: 'identifier', value: selector.identifier, role: selector.role });
  if (selector.label) candidates.push({ strategy: 'label', value: selector.label, role: selector.role });
  return candidates;
}

function selectorError(selector: ElementSelector): string | null {
  if (!selector.identifier && !selector.label) return 'selector needs an accessibility identifier or label';
  if (selector.identifier !== undefined && selector.identifier.trim() === '') return 'selector identifier cannot be empty';
  if (selector.label !== undefined && selector.label.trim() === '') return 'selector label cannot be empty';
  return null;
}

export function normalizeFlow(flow: IOSQAFlow): IOSQAFlow {
  return {
    ...flow,
    steps: flow.steps.map((step) => {
      if (step.action === 'tap' || step.action === 'typeText') {
        return { ...step, timeoutMs: step.timeoutMs ?? DEFAULT_TIMEOUT_MS };
      }
      return step;
    }),
  };
}

export function buildXCUITestPlan(
  flow: IOSQAFlow,
  target: IOSQATarget,
  config: XCUITestRunnerConfig,
  planPath: string,
): PlanResult {
  if (flow.version !== 1) return { status: 'unsupported', reason: `flow version ${String(flow.version)} is unsupported` };
  if (target.kind !== 'simulator' && target.kind !== 'device') {
    return { status: 'unsupported', reason: `target kind ${String(target.kind)} is unsupported` };
  }
  if (!flow.name.trim()) return { status: 'blocked', reason: 'flow name is empty', remediation: 'Give the flow a stable name.' };
  if (!flow.steps.length) return { status: 'blocked', reason: 'flow has no steps', remediation: 'Add at least one semantic action or verification.' };
  if (!target.udid.trim()) return { status: 'blocked', reason: `${target.kind} UDID is missing`, remediation: `Select a booted ${target.kind} and pass its UDID.` };
  if (!!config.projectPath === !!config.workspacePath) {
    return { status: 'blocked', reason: 'runner needs exactly one projectPath or workspacePath', remediation: 'Point to the existing XCUITest runner project or workspace.' };
  }
  if (!config.scheme.trim() || !config.testIdentifier.trim()) {
    return { status: 'blocked', reason: 'runner scheme or test identifier is missing', remediation: 'Configure the checked-in XCUITest runner target.' };
  }

  for (const step of flow.steps) {
    if (!['launch', 'tap', 'typeText', 'swipe', 'wait'].includes(step.action)) {
      return { status: 'unsupported', reason: `action ${String(step.action)} is unsupported`, stepId: step.id };
    }
    const selectors: ElementSelector[] = [];
    if ('selector' in step && step.selector) selectors.push(step.selector);
    const verification = 'verify' in step ? step.verify : step.action === 'wait' ? step.verification : undefined;
    if (verification) selectors.push(verification.selector);
    for (const selector of selectors) {
      const error = selectorError(selector);
      if (error) return { status: 'unsupported', reason: error, stepId: step.id };
    }
  }

  const normalized = normalizeFlow(flow);
  const encodedFlow = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64');
  const args = ['test'];
  if (config.workspacePath) args.push('-workspace', config.workspacePath);
  else args.push('-project', config.projectPath!);
  const destinationPlatform = target.kind === 'simulator' ? 'iOS Simulator' : 'iOS';
  args.push('-scheme', config.scheme, '-destination', `platform=${destinationPlatform},id=${target.udid}`, `-only-testing:${config.testIdentifier}`);
  args.push(
    `GSTACK_IOS_QA_FLOW_PATH_VALUE=${resolve(planPath)}`,
    `GSTACK_IOS_QA_FLOW_JSON_BASE64_VALUE=${encodedFlow}`,
    `GSTACK_IOS_QA_TARGET_KIND_VALUE=${target.kind}`,
  );
  if (config.derivedDataPath) args.push('-derivedDataPath', config.derivedDataPath);
  if (config.resultBundlePath) args.push('-resultBundlePath', config.resultBundlePath);

  return {
    status: 'ready',
    plan: {
      backend: 'xcuitest',
      target,
      capabilities: XCUITEST_CAPABILITIES,
      command: {
        executable: 'xcodebuild',
        args,
        env: {
          GSTACK_IOS_QA_FLOW_PATH: resolve(planPath),
          GSTACK_IOS_QA_FLOW_JSON_BASE64: encodedFlow,
          GSTACK_IOS_QA_TARGET_KIND: target.kind,
        },
      },
      flow: normalized,
    },
  };
}
