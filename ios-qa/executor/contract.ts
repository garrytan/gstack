export type IOSQATarget =
  | { kind: 'simulator'; udid: string }
  | { kind: 'device'; udid: string };

export type ElementRole =
  | 'button'
  | 'cell'
  | 'link'
  | 'navigationBar'
  | 'secureTextField'
  | 'staticText'
  | 'switch'
  | 'textField';

export interface ElementSelector {
  /** Stable accessibility identifiers are always attempted before fallback fields. */
  identifier?: string;
  label?: string;
  role?: ElementRole;
}

export type Verification =
  | { kind: 'exists'; selector: ElementSelector; timeoutMs?: number }
  | { kind: 'notExists'; selector: ElementSelector; timeoutMs?: number }
  | { kind: 'labelEquals'; selector: ElementSelector; value: string; timeoutMs?: number };

export type FlowStep =
  | { id: string; action: 'launch'; arguments?: string[]; environment?: Record<string, string>; verify?: Verification }
  | { id: string; action: 'tap'; selector: ElementSelector; timeoutMs?: number; verify?: Verification }
  | { id: string; action: 'typeText'; selector: ElementSelector; text: string; clear?: boolean; timeoutMs?: number; verify?: Verification }
  | { id: string; action: 'swipe'; direction: 'up' | 'down' | 'left' | 'right'; selector?: ElementSelector; verify?: Verification }
  | { id: string; action: 'wait'; verification: Verification };

export interface IOSQAFlow {
  version: 1;
  name: string;
  bundleIdentifier?: string;
  steps: FlowStep[];
}

export interface XCUITestRunnerConfig {
  projectPath?: string;
  workspacePath?: string;
  scheme: string;
  testIdentifier: string;
  derivedDataPath?: string;
  resultBundlePath?: string;
}

export interface ExecutorCapabilities {
  semanticSelectors: readonly ['identifier', 'role', 'label'];
  actions: readonly ['launch', 'tap', 'typeText', 'swipe', 'wait'];
  targets: readonly ['simulator', 'device'];
  coordinateTaps: false;
  postActionVerification: true;
}

export const XCUITEST_CAPABILITIES: ExecutorCapabilities = {
  semanticSelectors: ['identifier', 'role', 'label'],
  actions: ['launch', 'tap', 'typeText', 'swipe', 'wait'],
  targets: ['simulator', 'device'],
  coordinateTaps: false,
  postActionVerification: true,
};

export type PlanResult =
  | { status: 'ready'; plan: XCUITestExecutionPlan }
  | { status: 'blocked'; reason: string; remediation: string }
  | { status: 'unsupported'; reason: string; stepId?: string };

export interface XCUITestExecutionPlan {
  backend: 'xcuitest';
  target: IOSQATarget;
  capabilities: ExecutorCapabilities;
  command: { executable: 'xcodebuild'; args: string[]; env: Record<string, string> };
  flow: IOSQAFlow;
}
