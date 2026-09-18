/**
 * Overlay behavior regression fixtures with comparative research measurements.
 *
 * Each paid wrapper runs both arms against the real Claude Code preset.
 * Complete, valid measurements and exact ON behavior are blocking; the original
 * `fixture.pass(arms)` efficacy comparator is retained as research evidence.
 * New records use the versioned contract in helpers/overlay-case-policy.ts.
 *
 * A new eval needs a fixture, paid wrapper/census, and selection dependencies.
 * The harness handles
 * arm wiring, concurrency, artifact storage, rate-limit retries, and records.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentSdkResult } from '../helpers/agent-sdk-runner';
import { reportedThinkingTokens, type ComparisonSpec } from '../helpers/overlay-measurement';
import { setupLiteralWorkspace, correctLiteralTargets, assertFinalJson } from '../helpers/overlay-workspace';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverlayFixture {
  /** Unique, lowercase/digits/dash only. Used in artifact paths. */
  id: string;
  /** Path to the overlay file, relative to repo root. */
  overlayPath: string;
  /** API model ID, not the overlay family name. */
  model: string;
  /** Integer >= 3. Trials per arm. */
  trials: number;
  /** Max concurrent queries for this fixture's arms. Default 3. */
  concurrency?: number;
  /** Populate the workspace dir before each trial. */
  setupWorkspace: (dir: string) => void;
  /** The prompt the model receives. Non-empty. */
  userPrompt: string;
  /** Per-fixture tool allowlist. Omit to use runner default [Read, Glob, Grep, Bash]. */
  allowedTools?: string[];
  /** Max turns per trial. Omit to use runner default (5). */
  maxTurns?: number;
  /**
   * Direction of the expected effect. `higher_is_better` = overlay should
   * increase the metric (e.g. batched calls, correct target behaviors).
   * `lower_is_better` = overlay should decrease it (e.g. Bash count, reported reasoning tokens).
   * Used for logging; the numeric `pass` comparator is research evidence only.
   */
  direction?: 'higher_is_better' | 'lower_is_better';
  /** Compute the per-trial metric from the typed SDK result. */
  metric: (r: AgentSdkResult, workspace?: string, deadlineAt?: number) => number;
  /** Exact task correctness, separate from comparative efficacy. */
  verify?: (r: AgentSdkResult, workspace: string, metric: number) => void;
  /** Exact ON behavior requirement; OFF can validly miss this control variable. */
  taskCorrect?: (metric: number) => boolean;
  /** Exact permitted paths; read-only by default. */
  allowedChanges?: string[];
  metricName?: string;
  comparison?: ComparisonSpec;
  /** Original comparative efficacy predicate; never the behavior release gate. */
  pass: (arms: { overlay: number[]; off: number[] }) => boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateFixtures(fixtures: OverlayFixture[]): void {
  const ids = new Set<string>();
  for (const f of fixtures) {
    if (!f.id || !/^[a-z0-9-]+$/.test(f.id)) {
      throw new Error(
        `fixture id must be non-empty, lowercase/digits/dash only: ${JSON.stringify(f.id)}`,
      );
    }
    if (ids.has(f.id)) {
      throw new Error(`duplicate fixture id: ${f.id}`);
    }
    ids.add(f.id);

    if (!Number.isInteger(f.trials) || f.trials < 3) {
      throw new Error(`${f.id}: trials must be an integer >= 3 (got ${f.trials})`);
    }
    if (
      f.concurrency !== undefined &&
      (!Number.isInteger(f.concurrency) || f.concurrency < 1)
    ) {
      throw new Error(
        `${f.id}: concurrency must be an integer >= 1 (got ${f.concurrency})`,
      );
    }

    if (!f.model) throw new Error(`${f.id}: model must be non-empty`);
    if (!f.userPrompt) throw new Error(`${f.id}: userPrompt must be non-empty`);

    if (path.isAbsolute(f.overlayPath) || f.overlayPath.includes('..')) {
      throw new Error(
        `${f.id}: overlayPath must be relative and must not contain '..' (got ${f.overlayPath})`,
      );
    }
    const fullPath = path.resolve(REPO_ROOT, f.overlayPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`${f.id}: overlay file not found at ${f.overlayPath}`);
    }

    for (const fn of ['setupWorkspace', 'metric', 'pass'] as const) {
      if (typeof f[fn] !== 'function') {
        throw new Error(`${f.id}: ${fn} must be a function`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Metric + predicate helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Retired paid fanout predicate, retained for free regressions: overlay mean
 * beats OFF by at least 0.5 tool_use blocks in the first complete assistant
 * message, AND at least 3 ON trials emit >= 2 blocks in the same message.
 *
 * The combined rule catches both "overlay nudges every trial slightly"
 * (mean) and "overlay sometimes triggers batching" (floor). A single
 * 0.5 lift with every trial still emitting 1 call would be suspicious;
 * this predicate rejects it.
 */
export function fanoutPass(arms: { overlay: number[]; off: number[] }): boolean {
  const lift = mean(arms.overlay) - mean(arms.off);
  const floorHits = arms.overlay.filter((n) => n >= 2).length;
  return lift >= 0.5 && floorHits >= 3;
}

/**
 * Original "lower is better" research comparator: overlay mean should drop the
 * metric by at least 20% vs baseline. Used for nudges like "effort-match"
 * (reported reasoning tokens) and "dedicated tools vs Bash" (fewer Bash calls).
 */
export function lowerIsBetter20Pct(arms: { overlay: number[]; off: number[] }): boolean {
  const meanOff = mean(arms.off);
  if (meanOff === 0) return false; // Equality at the optimum is not efficacy lift.
  return mean(arms.overlay) <= meanOff * 0.8;
}

/**
 * Original "higher is better" research comparator: overlay mean should lift the
 * metric by at least 20% vs baseline. Used for nudges like "literal
 * interpretation" (more target behaviors completed).
 */
export function higherIsBetter20Pct(arms: { overlay: number[]; off: number[] }): boolean {
  const meanOff = mean(arms.off);
  const meanOn = mean(arms.overlay);
  if (meanOff === 0) return meanOn > 0;
  return meanOn >= meanOff * 1.2;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Count the total number of Bash tool_use blocks across ALL assistant turns.
 * Signal for "dedicated tools over Bash" nudge in claude.md.
 */
export function bashToolCallCount(r: AgentSdkResult): number {
  return r.toolCalls.filter((c) => c.tool === 'Bash').length;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const OVERLAY_FIXTURES: OverlayFixture[] = [
  // -------------------------------------------------------------------------
  // claude.md / "Dedicated tools over Bash"
  // -------------------------------------------------------------------------
  {
    id: 'claude-dedicated-tools-vs-bash',
    overlayPath: 'model-overlays/claude.md',
    model: 'claude-opus-4-7',
    trials: 10,
    concurrency: 3,
    direction: 'lower_is_better',
    // 5 files + summary = needs more than default 5 turns. SDK throws
    // instead of returning a result when it hits the cap.
    maxTurns: 15,
    setupWorkspace: (dir) => {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), "export const x = 1;\n");
      fs.writeFileSync(path.join(dir, 'src', 'util.ts'), "export function util() { return 42; }\n");
      fs.writeFileSync(path.join(dir, 'src', 'types.ts'), "export type Foo = { a: number };\n");
      fs.writeFileSync(path.join(dir, 'src', 'config.ts'), "export const c = { n: 'demo' };\n");
      fs.writeFileSync(path.join(dir, 'src', 'api.ts'), "export async function fetchFoo() { return null; }\n");
    },
    userPrompt:
      "List every TypeScript file under src/ and tell me what each exports. " +
      "Return only a JSON object mapping each src/ path to an array of its exported symbol names. " +
      "The final message is consumed directly by JSON.parse: return the exact JSON object, with no Markdown fences and no other prose. " +
      "You may use any tools available.",
    // Metric: total Bash tool_use count across the whole session.
    // The overlay says "prefer Read/Glob/Grep over cat/find/grep shell."
    // A model following that should emit Glob + Read, not Bash ls/find/cat.
    metric: bashToolCallCount,
    metricName: 'bash_tool_calls',
    verify: (r) => assertFinalJson(r, { 'src/index.ts': ['x'], 'src/util.ts': ['util'], 'src/types.ts': ['Foo'], 'src/config.ts': ['c'], 'src/api.ts': ['fetchFoo'] }),
    taskCorrect: (metric) => metric === 0,
    comparison: { direction: 'lower_is_better', minimum: 0 },
    pass: lowerIsBetter20Pct,
  },

  // -------------------------------------------------------------------------
  // opus-4-7.md / "Effort-match the step"
  // -------------------------------------------------------------------------
  {
    id: 'opus-4-7-effort-match-trivial',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-opus-4-7',
    trials: 10,
    concurrency: 3,
    direction: 'lower_is_better',
    maxTurns: 8,
    setupWorkspace: (dir) => {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        '{"name": "demo", "version": "1.0.0"}\n',
      );
    },
    userPrompt: "What's the version in config.json? Return only a JSON object with the version key and its exact string value. " +
      "The final message is consumed directly by JSON.parse: return the exact JSON object, with no Markdown fences and no other prose.",
    // Use the SDK's reported reasoning tokens. Lookup/tool counts do not
    // measure extended thinking; absent usage metadata is an error.
    metric: reportedThinkingTokens,
    metricName: 'reported_thinking_tokens',
    verify: (r) => assertFinalJson(r, { version: '1.0.0' }),
    comparison: { direction: 'lower_is_better', minimum: 0 },
    pass: lowerIsBetter20Pct,
  },

  // -------------------------------------------------------------------------
  // opus-4-7.md / "Literal interpretation awareness"
  // -------------------------------------------------------------------------
  {
    id: 'opus-4-7-literal-interpretation',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-opus-4-7',
    trials: 10,
    concurrency: 3,
    direction: 'higher_is_better',
    // Allow repairs to real implementations; the public tests stay frozen.
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    maxTurns: 15,
    setupWorkspace: setupLiteralWorkspace,
    userPrompt: 'Fix the failing tests. Preserve the specified behavior and repair the implementation.',
    metric: (_r, dir, deadlineAt) => {
      if (!dir) throw new Error('literal fixture metric needs its workspace');
      return correctLiteralTargets(dir, deadlineAt);
    },
    metricName: 'correct_target_behaviors',
    taskCorrect: (metric) => metric === 3,
    allowedChanges: ['src/auth.ts', 'src/billing.ts', 'src/notifications.ts'],
    comparison: { direction: 'higher_is_better', minimum: 0, maximum: 3 },
    pass: higherIsBetter20Pct,
  },

  // =========================================================================
  // Sonnet 4.6 variants of the Opus-4.7 fixtures.
  //
  // Same overlays, prompts, metrics and trial counts; different pinned model.
  // Model effects remain separate instead of pooling their observations.
  // =========================================================================

  {
    id: 'claude-dedicated-tools-vs-bash-sonnet',
    overlayPath: 'model-overlays/claude.md',
    model: 'claude-sonnet-4-6',
    trials: 10,
    concurrency: 3,
    direction: 'lower_is_better',
    maxTurns: 15,
    setupWorkspace: (dir) => {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), "export const x = 1;\n");
      fs.writeFileSync(path.join(dir, 'src', 'util.ts'), "export function util() { return 42; }\n");
      fs.writeFileSync(path.join(dir, 'src', 'types.ts'), "export type Foo = { a: number };\n");
      fs.writeFileSync(path.join(dir, 'src', 'config.ts'), "export const c = { n: 'demo' };\n");
      fs.writeFileSync(path.join(dir, 'src', 'api.ts'), "export async function fetchFoo() { return null; }\n");
    },
    userPrompt:
      "List every TypeScript file under src/ and tell me what each exports. " +
      "Return only a JSON object mapping each src/ path to an array of its exported symbol names. " +
      "The final message is consumed directly by JSON.parse: return the exact JSON object, with no Markdown fences and no other prose. " +
      "You may use any tools available.",
    metric: bashToolCallCount,
    metricName: 'bash_tool_calls',
    verify: (r) => assertFinalJson(r, { 'src/index.ts': ['x'], 'src/util.ts': ['util'], 'src/types.ts': ['Foo'], 'src/config.ts': ['c'], 'src/api.ts': ['fetchFoo'] }),
    taskCorrect: (metric) => metric === 0,
    comparison: { direction: 'lower_is_better', minimum: 0 },
    pass: lowerIsBetter20Pct,
  },

  {
    id: 'opus-4-7-effort-match-trivial-sonnet',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-sonnet-4-6',
    trials: 10,
    concurrency: 3,
    direction: 'lower_is_better',
    maxTurns: 8,
    setupWorkspace: (dir) => {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        '{"name": "demo", "version": "1.0.0"}\n',
      );
    },
    userPrompt: "What's the version in config.json? Return only a JSON object with the version key and its exact string value. " +
      "The final message is consumed directly by JSON.parse: return the exact JSON object, with no Markdown fences and no other prose.",
    metric: reportedThinkingTokens,
    metricName: 'reported_thinking_tokens',
    verify: (r) => assertFinalJson(r, { version: '1.0.0' }),
    comparison: { direction: 'lower_is_better', minimum: 0 },
    pass: lowerIsBetter20Pct,
  },

  {
    id: 'opus-4-7-literal-interpretation-sonnet',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-sonnet-4-6',
    trials: 10,
    concurrency: 3,
    direction: 'higher_is_better',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    maxTurns: 15,
    setupWorkspace: setupLiteralWorkspace,
    userPrompt: 'Fix the failing tests. Preserve the specified behavior and repair the implementation.',
    metric: (_r, dir, deadlineAt) => {
      if (!dir) throw new Error('literal fixture metric needs its workspace');
      return correctLiteralTargets(dir, deadlineAt);
    },
    metricName: 'correct_target_behaviors',
    taskCorrect: (metric) => metric === 3,
    allowedChanges: ['src/auth.ts', 'src/billing.ts', 'src/notifications.ts'],
    comparison: { direction: 'higher_is_better', minimum: 0, maximum: 3 },
    pass: higherIsBetter20Pct,
  },
];

// Validate at module load so a broken fixture fails fast at test startup,
// not mid-run after burning API dollars.
validateFixtures(OVERLAY_FIXTURES);
