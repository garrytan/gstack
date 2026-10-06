/** Audited cache adapter for runWorkflowJudge only. Native/PTY evals stay fresh. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_JUDGE_MAX_TOKENS, resolveEvalModel } from '../../lib/eval-model';
import { JUDGE_MS } from './eval-budgets';
import { JUDGE_PANEL_SAMPLES, JUDGE_SCORE_DIMENSIONS, judgePanelMedian, type JudgeScore } from './llm-judge';
import { readWorkflowJudgeInput, buildWorkflowJudgePrompt, WORKFLOW_JUDGE_RESPONSE_SCHEMA, WORKFLOW_JUDGE_REASONING_WORD_LIMIT } from './workflow-judge-input';
import { buildEvalInputIdentity, lookupEvalInputCache, sourceDependencyClosure, storeEvalInputCache,
  type EvalCacheValue, type EvalInputIdentity, type EvalPassingProof } from '../../scripts/eval-input-cache';

type Thresholds = { clarity: number; completeness: number; actionability: number };
export interface WorkflowCacheOptions {
  root: string; testName: string; skillPath: string; startMarker: string; endMarker: string | RegExp | null;
  judgeContext: string; judgeGoal: string; model?: string; thresholds: Thresholds; prompt: string; attempt: number;
  references?: readonly string[];
  agentCapability?: 'frontier';
  /** Sends WORKFLOW_JUDGE_RESPONSE_SCHEMA as the structured-output format. */
  schemaTransport?: boolean;
  /** Validates the compact response contract: exact keys, non-empty reasoning under the word limit. */
  compactReasoning?: boolean;
  maxTokens?: number;
  stream?: boolean;
  effort?: 'medium';
  env?: NodeJS.ProcessEnv;
}
export interface WorkflowJudgeReuse {
  key: string; source: EvalPassingProof['source'];
}

/** The judge's audited closure: its runner, rubric and documents, installed SDK bytes included. */
export function workflowJudgeDependencies(root: string, documents: string[]): string[] {
  return sourceDependencyClosure(root, ['test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-cache.ts',
    'test/helpers/llm-judge.ts', 'lib/eval-model.ts', 'test/helpers/eval-budgets.ts',
    'scripts/test-paid-shards.ts', 'scripts/test-strict-output.ts', 'scripts/eval-select.ts',
    'scripts/test-pr-profile.ts', '.github/workflows/evals.yml',
    'package.json', 'bun.lock', '.github/docker/Dockerfile.ci', ...documents]);
}

export function validWorkflowJudgeScore(value: EvalCacheValue, thresholds: Thresholds, compactReasoning = false): value is JudgeScore & EvalCacheValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'actionability,clarity,completeness,reasoning'
    || typeof value.reasoning !== 'string'
    || (compactReasoning && (!value.reasoning.trim()
      || value.reasoning.trim().split(/\s+/).length >= WORKFLOW_JUDGE_REASONING_WORD_LIMIT))) return false;
  return JUDGE_SCORE_DIMENSIONS.every(key =>
    typeof value[key] === 'number' && Number.isInteger(value[key]) && value[key] >= thresholds[key] && value[key] <= 5);
}

const SAMPLE_RANGE: Thresholds = { clarity: 1, completeness: 1, actionability: 1 };

/** A complete judge panel: exactly JUDGE_PANEL_SAMPLES of valid samples whose per-dimension median (2 of 3) meets every threshold. */
export function validWorkflowJudgePanel(value: EvalCacheValue, thresholds: Thresholds, compactReasoning = false): value is { samples: Array<JudgeScore & EvalCacheValue> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'samples'
    || !Array.isArray(value.samples) || value.samples.length !== JUDGE_PANEL_SAMPLES
    || !value.samples.every(sample => validWorkflowJudgeScore(sample, SAMPLE_RANGE, compactReasoning))) return false;
  const median = judgePanelMedian(value.samples as JudgeScore[], JUDGE_SCORE_DIMENSIONS);
  return JUDGE_SCORE_DIMENSIONS.every(key => median[key] >= thresholds[key]);
}

export function prepareWorkflowJudgeCache(opts: WorkflowCacheOptions): {
  lookup(): { samples: JudgeScore[]; reuse: WorkflowJudgeReuse } | null;
  /** The attempt guard is rechecked after synchronous input/provenance reads. */
  publish(samples: JudgeScore[], isActive?: () => boolean): (() => void) | undefined;
} {
  const env = opts.env ?? process.env;
  const noCache = { lookup: () => null, publish: (_samples: JudgeScore[]) => undefined };
  const pr = Number(env.EVALS_CACHE_PR);
  // Runtime ID is the immutable CI image manifest, not a mutable image tag.
  // Nonstandard Node/Bun preload code or custom model endpoints need a separate
  // audited adapter: they can change the request outside the consumed source.
  if (!env.EVALS_CACHE_DIR || !env.EVALS_CACHE_REPOSITORY || !Number.isSafeInteger(pr) || pr <= 0
    || !/^(?:sha256:)?[a-f0-9]{64}$/.test(env.EVALS_CACHE_RUNTIME_ID ?? '')
    || env.EVALS_TIER !== 'gate' || env.EVALS_FRESH === '1'
    || ['release', 'periodic'].includes(env.EVALS_CACHE_PURPOSE ?? '')
    || opts.attempt !== 1 || env.NODE_OPTIONS || env.BUN_OPTIONS
    || (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== 'https://api.anthropic.com')) return noCache;

  const currentIdentity = (): EvalInputIdentity | null => {
    try {
      const input = readWorkflowJudgeInput(opts);
      const prompt = buildWorkflowJudgePrompt(opts, input);
      // Never substitute this adapter's interpretation for the actual API input.
      if (prompt !== opts.prompt) return null;
      const { version: _releaseLabel, ...rootPackage } = JSON.parse(fs.readFileSync(path.join(opts.root, 'package.json'), 'utf8'));
      const identity = buildEvalInputIdentity({ root: opts.root,
        scope: { repository: env.EVALS_CACHE_REPOSITORY!, pullRequest: pr },
        coverage: { dependencies: 'complete', prompts: 'complete', environment: 'complete' }, unknownDependencies: [],
        files: workflowJudgeDependencies(opts.root, input.files.map(file => file.path)),
        prompts: { [opts.testName]: prompt },
        parameters: { rootPackage, thresholds: opts.thresholds, max_tokens: opts.maxTokens ?? DEFAULT_JUDGE_MAX_TOKENS, temperature: null, budget_ms: JUDGE_MS,
          request: opts.stream ? 'messages.stream/user' : 'messages.create/user', retries: 0,
          panel: { samples: JUDGE_PANEL_SAMPLES, numeric: 'mean', boolean: 'majority' },
          ...(opts.stream ? { stream: true } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.schemaTransport ? { output_config: { format: { type: 'json_schema', schema: WORKFLOW_JUDGE_RESPONSE_SCHEMA } } } : {}),
          ...(opts.compactReasoning ? { response_validation: { reasoning_words_below: WORKFLOW_JUDGE_REASONING_WORD_LIMIT } } : {}) },
        runtime: { image: env.EVALS_CACHE_RUNTIME_ID!, bun: Bun.version, node: process.versions.node,
          platform: process.platform, arch: process.arch, judge: resolveEvalModel('judge', opts.model, env),
          anthropic_base_url: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
          anthropic_log: env.ANTHROPIC_LOG ?? null,
          proxies: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
            .map(name => [name, env[name] ?? null])) },
      });
      return identity.status === 'eligible' ? identity.identity : null;
    } catch { return null; }
  };
  const before = currentIdentity();
  if (!before) return noCache;
  const common = { cacheDir: env.EVALS_CACHE_DIR, purpose: 'gate' as const };
  return {
    lookup() {
      const result = lookupEvalInputCache({ ...common, identity: before,
        validateResult: value => validWorkflowJudgePanel(value, opts.thresholds, opts.compactReasoning) });
      return result.status === 'reused'
        ? { samples: (result.result as unknown as { samples: JudgeScore[] }).samples, reuse: { key: result.key, source: result.source } } : null;
    },
    publish(samples, isActive = () => true) {
      // Caller reaches here ONLY after its actual assertions passed. A later
      // failed case in the file does not erase this independently completed case.
      const panel = { samples: samples.map(({ clarity, completeness, actionability, reasoning }) => ({ clarity, completeness, actionability, reasoning })) };
      if (!isActive() || !validWorkflowJudgePanel(panel as unknown as EvalCacheValue, opts.thresholds, opts.compactReasoning)) return;
      const after = currentIdentity();
      const runId = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT ?? '1'}` : env.EVALS_RUN_ID;
      if (!after || !runId || !isActive()) return;
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: opts.root, encoding: 'utf8', timeout: 3000 });
      if (revision.status !== 0 || !isActive()) return;
      const stored = storeEvalInputCache({ ...common, before, after, proof: {
        execution: 'new', finalized: true, completeAttemptHistory: true, exitCode: 0, timedOut: false,
        cancelled: false, skipped: 0, failed: 0, passed: 1,
        cases: [{ id: opts.testName, outcome: 'passed', attempt: 1 }],
        source: { runId, revision: revision.stdout.trim(), completedAt: Date.now() },
        result: panel,
      } });
      // A slow synchronous write can consume the recording allowance. The
      // caller withdraws this new receipt if its final deadline check fails.
      if (stored.status === 'stored') return () => fs.rmSync(path.join(common.cacheDir, `${stored.key}.json`), { force: true });
    },
  };
}

/**
 * Pass floors for the browse reference judge panel, applied to its gating
 * per-dimension median (EVAL_POLICY v3). The stored baseline is recorded for
 * comparison only: a three-sample aggregate is too noisy for a no-dip ratchet,
 * and gating on it silently raised the clarity floor to 4.
 */
export const BROWSE_JUDGE_FLOORS = { clarity: 3, completeness: 4, actionability: 4 } as const;

export function browseJudgeFloorsMet(scores: Record<keyof typeof BROWSE_JUDGE_FLOORS, number>): boolean {
  return (Object.keys(BROWSE_JUDGE_FLOORS) as Array<keyof typeof BROWSE_JUDGE_FLOORS>)
    .every(dim => scores[dim] >= BROWSE_JUDGE_FLOORS[dim]);
}
