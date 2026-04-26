/**
 * Overlay-efficacy fixture registry.
 *
 * Each fixture defines a reproducible A/B test for one behavioral nudge
 * embedded in a model-overlays/*.md file. The harness at
 * test/skill-e2e-overlay-harness.test.ts iterates this registry and runs
 * `fixture.trials` A/B trials per fixture, asserting `fixture.pass(arms)`.
 *
 * Adding a new overlay eval = one entry in this list. The harness handles
 * arm wiring, concurrency, artifact storage, rate-limit retries, and the
 * cross-harness diagnostic.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  firstTurnParallelism,
  type AgentSdkResult,
} from '../helpers/agent-sdk-runner';

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
   * increase the metric (e.g. fanout, files touched for literal scope).
   * `lower_is_better` = overlay should decrease it (e.g. Bash count, turn count).
   * Used only for cosmetic logging in the test output; `pass` is the actual gate.
   */
  direction?: 'higher_is_better' | 'lower_is_better';
  /** Compute the per-trial metric from the typed SDK result. */
  metric: (r: AgentSdkResult) => number;
  /** Acceptance predicate across all arms' per-trial metrics. */
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
 * Standard fanout predicate: overlay mean beats off mean by at least 0.5
 * parallel tool_use blocks in first turn, AND at least 3 of the overlay
 * trials emit >= 2 parallel tool_use blocks.
 *
 * The combined rule catches both "overlay nudges every trial slightly"
 * (mean) and "overlay sometimes triggers real fanout" (floor). A single
 * 0.5 lift with every trial still emitting 1 call would be suspicious;
 * this predicate rejects it.
 */
export function fanoutPass(arms: { overlay: number[]; off: number[] }): boolean {
  const lift = mean(arms.overlay) - mean(arms.off);
  const floorHits = arms.overlay.filter((n) => n >= 2).length;
  return lift >= 0.5 && floorHits >= 3;
}

/**
 * Generic "lower is better" pass predicate: overlay mean should drop the
 * metric by at least 20% vs baseline. Used for nudges like "effort-match"
 * (fewer turns) and "dedicated tools vs Bash" (fewer Bash calls).
 */
export function lowerIsBetter20Pct(arms: { overlay: number[]; off: number[] }): boolean {
  const meanOff = mean(arms.off);
  if (meanOff === 0) return mean(arms.overlay) <= meanOff;
  return mean(arms.overlay) <= meanOff * 0.8;
}

/**
 * Generic "higher is better" pass predicate: overlay mean should lift the
 * metric by at least 20% vs baseline. Used for nudges like "literal
 * interpretation" (more files touched when scope is ambiguous).
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

/**
 * Total turns the session used to complete. Signal for "effort-match the
 * step" nudge in opus-4-7.md — trivial prompts should complete quickly.
 */
export function turnsToCompletion(r: AgentSdkResult): number {
  return r.turnsUsed;
}

/**
 * Count of unique files the model edited or wrote. Signal for "literal
 * interpretation" nudge in opus-4-7.md — "fix the tests" with multiple
 * failures should touch all of them.
 */
export function uniqueFilesEdited(r: AgentSdkResult): number {
  const touched = new Set<string>();
  for (const call of r.toolCalls) {
    if (call.tool === 'Edit' || call.tool === 'Write' || call.tool === 'MultiEdit') {
      const input = call.input as { file_path?: string } | null;
      if (input?.file_path) touched.add(input.file_path);
    }
  }
  return touched.size;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const OVERLAY_FIXTURES: OverlayFixture[] = [
  {
    id: 'opus-4-7-fanout-toy',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-opus-4-7',
    trials: 10,
    concurrency: 3,
    setupWorkspace: (dir) => {
      fs.writeFileSync(path.join(dir, 'alpha.txt'), 'Alpha file: used in module A.\n');
      fs.writeFileSync(path.join(dir, 'beta.txt'), 'Beta file: used in module B.\n');
      fs.writeFileSync(path.join(dir, 'gamma.txt'), 'Gamma file: used in module C.\n');
    },
    userPrompt:
      'Read alpha.txt, beta.txt, and gamma.txt and summarize each in one line.',
    metric: (r) => firstTurnParallelism(r.assistantTurns[0]),
    pass: fanoutPass,
  },
  {
    id: 'opus-4-7-fanout-realistic',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-opus-4-7',
    trials: 10,
    concurrency: 3,
    setupWorkspace: (dir) => {
      fs.writeFileSync(
        path.join(dir, 'app.ts'),
        "import { config } from './config';\nimport { util } from './src/util';\n\nexport function main() { return config.name + ':' + util(); }\n",
      );
      fs.writeFileSync(
        path.join(dir, 'config.ts'),
        "export const config = { name: 'demo', version: 1 };\n",
      );
      fs.writeFileSync(
        path.join(dir, 'README.md'),
        '# demo project\n\nA small demo. Entry: `app.ts`. Config: `config.ts`.\n',
      );
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'util.ts'),
        "export function util() { return 'util-result'; }\n",
      );
    },
    userPrompt:
      'Audit this project: read app.ts, config.ts, and README.md, and glob for ' +
      'every .ts file under src/. Summarize what you find in 3 bullet points.',
    metric: (r) => firstTurnParallelism(r.assistantTurns[0]),
    pass: fanoutPass,
  },

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
      "You may use any tools available.",
    // Metric: total Bash tool_use count across the whole session.
    // The overlay says "prefer Read/Glob/Grep over cat/find/grep shell."
    // A model following that should emit Glob + Read, not Bash ls/find/cat.
    metric: bashToolCallCount,
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
    userPrompt: "What's the version in config.json?",
    // Metric: turns used to reach a result.
    // The overlay says "simple lookups don't need deep reasoning."
    // A trivial prompt like this should complete in 2 turns
    // (Read, respond). Extended deliberation bumps this up.
    metric: turnsToCompletion,
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
    // Allow Edit and Write so the model can fix the tests.
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    maxTurns: 15,
    setupWorkspace: (dir) => {
      // Three failing test files. The "obvious" one is named first; the
      // other two require the model to enumerate to notice them.
      fs.writeFileSync(
        path.join(dir, 'auth.test.ts'),
        "import { test, expect } from 'bun:test';\n" +
          "test('auth returns true', () => { expect(1).toBe(2); });\n",
      );
      fs.writeFileSync(
        path.join(dir, 'billing.test.ts'),
        "import { test, expect } from 'bun:test';\n" +
          "test('billing computes total', () => { expect('ten').toBe('10'); });\n",
      );
      fs.writeFileSync(
        path.join(dir, 'notifications.test.ts'),
        "import { test, expect } from 'bun:test';\n" +
          "test('notifications fire on save', () => { expect([1,2]).toEqual([1,2,3]); });\n",
      );
      fs.writeFileSync(
        path.join(dir, 'README.md'),
        "# demo\n\nSmall project with three failing test files.\n",
      );
    },
    userPrompt: "Fix the failing tests.",
    // Metric: number of unique test files the model edited/wrote.
    // The overlay says "fix ALL failing tests, not just the obvious one."
    // Overlay-ON should touch all 3 test files. Overlay-OFF might stop
    // at the first one after making it pass.
    metric: uniqueFilesEdited,
    pass: higherIsBetter20Pct,
  },

  // =========================================================================
  // Sonnet 4.6 variants of the Opus-4.7 fixtures.
  //
  // Rationale: /claude.md + /opus-4-7.md overlays measured as no-op or
  // counterproductive on Opus 4.7. Before deleting the whole overlay stack,
  // check whether weaker Claude models (Sonnet, Haiku) benefit from the same
  // nudges. Same overlays, same prompts, same metrics, different model ID.
  // Sonnet is ~4x cheaper than Opus so these 5 add ~$3 to a run.
  // =========================================================================

  {
    id: 'opus-4-7-fanout-toy-sonnet',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-sonnet-4-6',
    trials: 10,
    concurrency: 3,
    setupWorkspace: (dir) => {
      fs.writeFileSync(path.join(dir, 'alpha.txt'), 'Alpha file: used in module A.\n');
      fs.writeFileSync(path.join(dir, 'beta.txt'), 'Beta file: used in module B.\n');
      fs.writeFileSync(path.join(dir, 'gamma.txt'), 'Gamma file: used in module C.\n');
    },
    userPrompt:
      'Read alpha.txt, beta.txt, and gamma.txt and summarize each in one line.',
    metric: (r) => firstTurnParallelism(r.assistantTurns[0]),
    pass: fanoutPass,
  },

  {
    id: 'opus-4-7-fanout-realistic-sonnet',
    overlayPath: 'model-overlays/opus-4-7.md',
    model: 'claude-sonnet-4-6',
    trials: 10,
    concurrency: 3,
    setupWorkspace: (dir) => {
      fs.writeFileSync(
        path.join(dir, 'app.ts'),
        "import { config } from './config';\nimport { util } from './src/util';\n\nexport function main() { return config.name + ':' + util(); }\n",
      );
      fs.writeFileSync(
        path.join(dir, 'config.ts'),
        "export const config = { name: 'demo', version: 1 };\n",
      );
      fs.writeFileSync(
        path.join(dir, 'README.md'),
        '# demo project\n\nA small demo. Entry: `app.ts`. Config: `config.ts`.\n',
      );
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src', 'util.ts'),
        "export function util() { return 'util-result'; }\n",
      );
    },
    userPrompt:
      'Audit this project: read app.ts, config.ts, and README.md, and glob for ' +
      'every .ts file under src/. Summarize what you find in 3 bullet points.',
    metric: (r) => firstTurnParallelism(r.assistantTurns[0]),
    pass: fanoutPass,
  },

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
      "You may use any tools available.",
    metric: bashToolCallCount,
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
    userPrompt: "What's the version in config.json?",
    metric: turnsToCompletion,
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
    setupWorkspace: (dir) => {
      fs.writeFileSync(
        path.join(dir, 'auth.test.ts'),
        "import { test, expect } from 'bun:test';\n" +
          "test('auth returns true', () => { expect(1).toBe(2); });\n",
      );
      fs.writeFileSync(
        path.join(dir, 'billing.test.ts'),
        "import { test, expect } from 'bun:test';\n" +
          "test('billing computes total', () => { expect('ten').toBe('10'); });\n",
      );
      fs.writeFileSync(
        path.join(dir, 'notifications.test.ts'),
        "import { test, expect } from 'bun:test';\n" +
          "test('notifications fire on save', () => { expect([1,2]).toEqual([1,2,3]); });\n",
      );
      fs.writeFileSync(
        path.join(dir, 'README.md'),
        "# demo\n\nSmall project with three failing test files.\n",
      );
    },
    userPrompt: "Fix the failing tests.",
    metric: uniqueFilesEdited,
    pass: higherIsBetter20Pct,
  },
];

// Validate at module load so a broken fixture fails fast at test startup,
// not mid-run after burning API dollars.
validateFixtures(OVERLAY_FIXTURES);
