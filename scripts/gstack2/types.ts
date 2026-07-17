export const GSTACK2_BASE_SHA = 'bb57306d98c97011b0919c6132705a15b1579781';

export const TREE_NAMES = ['plan', 'design', 'qa', 'debug', 'review', 'ship'] as const;
export type TreeName = (typeof TREE_NAMES)[number];

export type ModuleVisibility = 'primary' | 'internal';

export interface BehavioralContract {
  question_order: string;
  pressure: string;
  smart_skips: string;
  stop_approval_gates: string;
  evidence: string;
  artifacts: string;
  mutation: string;
  exit: string;
  voice: string;
}

export interface SourceAssignment {
  source: string;
  tree: TreeName;
  /** Public dispatcher mode. Legacy `mode` remains an internal alias only. */
  publicMode: string;
  mode: string;
  visibility: ModuleVisibility;
  mandatory: boolean;
  replacement: string;
  summary: string;
  defaultDepth: 'quick' | 'standard' | 'deep';
  defaultMutation: string;
  webContext: 'none' | 'optional' | 'local-browser' | 'production';
  overlays?: number[];
  contract?: Partial<BehavioralContract>;
}

export interface DispatcherMode {
  mode: string;
  target: string;
  modules: string[];
  inferWhen: string;
  depth: 'quick' | 'standard' | 'deep';
  mutation: string;
  webContext: 'none' | 'optional' | 'local-browser' | 'production';
}

export interface DispatcherDefinition {
  name: TreeName;
  displayName: string;
  description: string;
  shortDescription: string;
  defaultPrompt: string;
  purpose: string;
  modes: DispatcherMode[];
  hardRules: string[];
}

export interface BugFixOverlay {
  pr: number;
  url: string;
  title: string;
  targets: string[] | ['*'];
  anchor: string;
  body: string;
  regression: {
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
  };
}

export interface ScenarioFixture {
  id: string;
  prompt: string;
  signals: Record<string, unknown>;
  expected: {
    tree: TreeName;
    mode: string;
    depth: 'quick' | 'standard' | 'deep';
    mutation: string;
    active_modules: string[];
    skipped_modules: string[];
    web_context: 'none' | 'optional' | 'local-browser' | 'production';
    decision_basis: string[];
    gap?: string;
  };
}
