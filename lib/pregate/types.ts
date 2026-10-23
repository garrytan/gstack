/**
 * pregate/types — the shapes every pre-gate check shares (plan C8). One check
 * per file under lib/pregate/checks/, registered in lib/pregate/index.ts.
 */
import type { PregateCheck } from '../headless-artifacts';
import type { Registry } from '../regen';
import type { PregateConfig } from './config';
import type { Lane } from './workflows';

export type CheckStatus = PregateCheck['status'];
export type Stage = 'preflight' | 'tests';

export interface TouchedFile {
  path: string;
  /** A = added, M = modified, D = deleted, R = renamed (from `renamedFrom`). */
  status: 'A' | 'M' | 'D' | 'R';
  renamedFrom?: string;
  /** True when the change is only in the working tree (uncommitted or untracked). */
  uncommitted: boolean;
}

export interface PregateContext {
  repoRoot: string;
  /** Base branch name without `origin/`. */
  base: string;
  baseRef: string;
  baseSha: string;
  /** merge-base of origin/<base> and HEAD: the diff anchor. */
  mergeBase: string;
  head: string;
  /** Working-tree content fingerprint at the start of the run (bin/gstack-wtree). */
  wtree: string;
  touched: TouchedFile[];
  config: PregateConfig;
  configLabel: string;
  /** The policy file to edit: the user-owned path when it is the active policy, else `.gstack/pregate.json`. */
  configFile: string;
  /** sha256 of the user-owned policy's bytes when it is active; recorded as `inputs.policy` (a base copy is pinned by `inputs.base`). */
  configDigest?: string;
  /** The user-owned policy path looked for and absent under the defaults; recorded so verify can tell when one appears. */
  absentUserPolicy?: string;
  registry: Registry;
  registryLabel: string;
  lanes: Lane[];
  platform: NodeJS.Platform;
  allowRepoCommands: boolean;
  timeoutMs: number;
  /** No output for this long kills a test-tier process group (`--stall-timeout`, `stall_timeout_s`); 0 disables. */
  stallTimeoutMs: number;
  /** Live stderr lines: per-file progress, heartbeats, the stage result. */
  progress: (line: string) => void;
  /** CPU count and `gstack-config test_backend`: under 8 cores a configured remote gate records an obligation instead of running locally. */
  cores: number;
  testBackend: string;
  policyFrom: 'base' | 'head';
  /** `--remote`: run the declared remote gate now, under this spend cap. */
  remote: { spendCapUsd: number } | null;
  env: NodeJS.ProcessEnv;
  /** `--explain`: checks append provenance lines here. */
  explain: string[];
}

export interface RemoteObligation {
  /** `<workflow file>/<job id>`. */
  lane: string;
  platform: string;
  workflow: string;
  job: string;
  /** Test files this machine cannot run that the touched files select. */
  tests: string[];
  /** What clears it: a run URL or an evidence-bundle lane label, recorded by `gstack-pregate clear`. */
  receipt: string | null;
  cleared_by?: string;
  /** The exact command that discharges the obligation (a small machine's remote gate). */
  command?: string;
}

export interface CheckResult extends PregateCheck {
  stage: Stage;
  /** The input identity the check ran against (tree, selection, registry source). */
  inputs: Record<string, string>;
  /** Exact command or edit an author runs; present on fail/warn/incomplete. */
  fix?: string;
  /** Result code the detail line ends with. */
  code?: string;
  /** Per-file or per-item lines for the table body. */
  lines?: string[];
  remote?: RemoteObligation[];
}

export interface CheckDef {
  id: string;
  stage: Stage;
  tier: 1 | 2;
  /** `secrets` and required lanes can never be downgraded to warn. */
  downgradable: boolean;
  /** True when the check executes commands the repo declares (pin files or its test runner). */
  needsRepoCommands: boolean;
  run(ctx: PregateContext): CheckResult | Promise<CheckResult>;
}
