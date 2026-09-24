/** Audited cache adapter for runWorkflowJudge only. Native/PTY evals stay fresh. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import { DEFAULT_JUDGE_MAX_TOKENS, resolveEvalModel } from '../../lib/eval-model';
import { JUDGE_MS } from './eval-budgets';
import type { JudgeScore } from './llm-judge';
import { readWorkflowJudgeInput, buildWorkflowJudgePrompt } from './workflow-judge-input';
import { buildEvalInputIdentity, lookupEvalInputCache, storeEvalInputCache,
  type EvalCacheValue, type EvalInputIdentity, type EvalPassingProof } from '../../scripts/eval-input-cache';

type Thresholds = { clarity: number; completeness: number; actionability: number };
export interface WorkflowCacheOptions {
  root: string; testName: string; skillPath: string; startMarker: string; endMarker: string | null;
  judgeContext: string; judgeGoal: string; thresholds: Thresholds; prompt: string; attempt: number;
  env?: NodeJS.ProcessEnv;
}
export interface WorkflowJudgeReuse {
  key: string; source: EvalPassingProof['source'];
}

/** Follow literal module imports, including installed SDK bytes, without executing them. */
export function workflowJudgeDependencies(root: string, documents: string[]): string[] {
  const seen = new Set<string>();
  const scan = new Bun.Transpiler({ loader: 'tsx' });
  const visit = (file: string) => {
    file = path.resolve(file);
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Dependency outside checkout');
    // Root version labels collector output only; its remaining semantic fields
    // are hashed separately. Installed package manifests remain byte-exact.
    if (relative === 'package.json') return;
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = fs.readFileSync(file, 'utf8');
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    // Entrypoint scripts carry hashbangs, which scanImports does not accept.
    // Strip only for parsing; buildEvalInputIdentity still hashes the full file.
    for (const entry of scan.scanImports(source.replace(/^#![^\n]*(?:\n|$)/, '\n'))) {
      if (isBuiltin(entry.path) || entry.path.startsWith('bun:')) continue;
      const resolved = Bun.resolveSync(entry.path, path.dirname(file));
      visit(resolved);
      // Package export maps/defaults affect resolution independently of code.
      let directory = path.dirname(resolved);
      while (directory !== root && directory.startsWith(root + path.sep)) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest)) { visit(manifest); break; }
        directory = path.dirname(directory);
      }
    }
  };
  for (const file of ['test/skill-llm-eval.test.ts', 'test/helpers/workflow-judge-cache.ts',
    'test/helpers/llm-judge.ts', 'lib/eval-model.ts', 'test/helpers/eval-budgets.ts',
    'scripts/test-paid-shards.ts', 'scripts/test-strict-output.ts', 'scripts/eval-select.ts',
    'scripts/test-pr-profile.ts', '.github/workflows/evals.yml',
    'package.json', 'bun.lock', '.github/docker/Dockerfile.ci', ...documents]) visit(path.join(root, file));
  for (const file of ['bunfig.toml', 'tsconfig.json', 'jsconfig.json'])
    if (fs.existsSync(path.join(root, file))) visit(path.join(root, file));
  return [...seen].sort();
}

export function validWorkflowJudgeScore(value: EvalCacheValue, thresholds: Thresholds): value is JudgeScore & EvalCacheValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'actionability,clarity,completeness,reasoning'
    || typeof value.reasoning !== 'string') return false;
  return (['clarity', 'completeness', 'actionability'] as const).every(key =>
    typeof value[key] === 'number' && Number.isInteger(value[key]) && value[key] >= thresholds[key] && value[key] <= 5);
}

export function prepareWorkflowJudgeCache(opts: WorkflowCacheOptions): {
  lookup(): { scores: JudgeScore; reuse: WorkflowJudgeReuse } | null;
  /** The attempt guard is rechecked after synchronous input/provenance reads. */
  publish(scores: JudgeScore, isActive?: () => boolean): (() => void) | undefined;
} {
  const env = opts.env ?? process.env;
  const noCache = { lookup: () => null, publish: (_scores: JudgeScore) => undefined };
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
        parameters: { rootPackage, thresholds: opts.thresholds, max_tokens: DEFAULT_JUDGE_MAX_TOKENS, temperature: null, budget_ms: JUDGE_MS,
          request: 'messages.create/user', retries: 1 },
        runtime: { image: env.EVALS_CACHE_RUNTIME_ID!, bun: Bun.version, node: process.versions.node,
          platform: process.platform, arch: process.arch, judge: resolveEvalModel('judge', undefined, env),
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
        validateResult: value => validWorkflowJudgeScore(value, opts.thresholds) });
      return result.status === 'reused'
        ? { scores: result.result as JudgeScore, reuse: { key: result.key, source: result.source } } : null;
    },
    publish(scores, isActive = () => true) {
      // Caller reaches here ONLY after its actual assertions passed. A later
      // failed case in the file does not erase this independently completed case.
      if (!isActive() || !validWorkflowJudgeScore(scores as unknown as EvalCacheValue, opts.thresholds)) return;
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
        result: { clarity: scores.clarity, completeness: scores.completeness, actionability: scores.actionability, reasoning: scores.reasoning },
      } });
      // A slow synchronous write can consume the recording allowance. The
      // caller withdraws this new receipt if its final deadline check fails.
      if (stored.status === 'stored') return () => fs.rmSync(path.join(common.cacheDir, `${stored.key}.json`), { force: true });
    },
  };
}
