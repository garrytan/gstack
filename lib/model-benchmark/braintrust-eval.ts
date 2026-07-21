/**
 * Braintrust-backed benchmark core.
 *
 * Braintrust owns scoring, experiment tracking, comparison, and reporting. GStack
 * keeps only the unavoidable CLI-agent shims (providers/*.ts) as the eval `task`,
 * plus operational metrics (latency/tokens/cost) the CLIs report and Braintrust
 * doesn't measure for us.
 *
 * Local by default: with no BRAINTRUST_API_KEY, runs with `noSendLogs` and ships
 * nothing. Setting the key opts into the cloud dashboard (the consent boundary).
 * Runs under bun (the adapters use Bun.which), so invoke via `bun run`, never the
 * node-based `braintrust eval` CLI.
 */
import { Eval } from 'braintrust';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeAdapter } from './providers/claude';
import { GptAdapter } from './providers/gpt';
import { GeminiAdapter } from './providers/gemini';
import type { ProviderAdapter } from './providers/types';

export type ProviderName = 'claude' | 'gpt' | 'gemini';

const ADAPTERS: Record<ProviderName, () => ProviderAdapter> = {
  claude: () => new ClaudeAdapter(),
  gpt: () => new GptAdapter(),
  gemini: () => new GeminiAdapter(),
};

export interface BenchCase {
  id: string;
  input: string;
  required: string[];
}

export interface BenchOpts {
  timeoutMs?: number;
  /** Add an autoevals LLM judge (ClosedQA). Needs OPENAI_API_KEY. */
  judge?: boolean;
}

/** Per-case operational metric Braintrust doesn't capture for a CLI subprocess: wall-clock. */
export interface CaseOps {
  id: string;
  durationMs: number;
  modelUsed: string;
  error?: string;
}

export interface ProviderBenchmark {
  provider: ProviderName;
  /** Mean required-terms score 0..1 from Braintrust, or null if every case errored. */
  score: number | null;
  ops: CaseOps[];
}

export const DEFAULT_CORPUS_PATH = path.join(__dirname, '..', '..', 'evals', 'model-benchmark', 'corpus.json');

export function loadCorpus(corpusPath = DEFAULT_CORPUS_PATH): BenchCase[] {
  return JSON.parse(fs.readFileSync(corpusPath, 'utf-8'));
}

interface ScorerArgs {
  input: string;
  output: string;
  expected: string[];
}
type ScoreResult = { name: string; score: number };
type Scorer = (args: ScorerArgs) => ScoreResult | Promise<ScoreResult>;

/** Deterministic scorer: fraction of required terms present. Replaces the old in-house evaluation.ts. */
const requiredTerms: Scorer = ({ output, expected }) => {
  const norm = (output ?? '').toLowerCase();
  const matched = (expected ?? []).filter((t) => norm.includes(t.toLowerCase()));
  return { name: 'required-terms', score: expected?.length ? matched.length / expected.length : 1 };
};

/**
 * Run one provider across the cases through Braintrust and return its score + ops.
 * The adapter is the `task`; requiredTerms (and optionally an autoevals judge) are
 * the `scores`. Empty output with zero tokens is thrown so it can't fake a 0.
 */
export async function runProviderBenchmark(
  provider: ProviderName,
  cases: BenchCase[],
  opts: BenchOpts = {},
): Promise<ProviderBenchmark> {
  const factory = ADAPTERS[provider];
  if (!factory) throw new Error(`unknown provider '${provider}' (claude|gpt|gemini)`);
  const adapter = factory();
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const ops: CaseOps[] = [];
  const byInput = new Map(cases.map((c) => [c.input, c]));

  // Braintrust calls scorers with { input, output, expected, metadata }.
  const scores: Scorer[] = [requiredTerms];
  if (opts.judge) {
    // autoevals ClosedQA = Braintrust's own LLM-judge, replacing the in-house judge.ts.
    // Normalize its result to a plain { name, score } so cross-package Score types don't clash.
    const { ClosedQA } = await import('autoevals');
    const closedQa = ClosedQA as unknown as (a: Record<string, unknown>) => Promise<{ score?: number }>;
    scores.push(async ({ input, output, expected }) => {
      const r = await closedQa({
        input,
        output,
        criteria: `Addresses the task and mentions: ${(expected ?? []).join(', ')}`,
      });
      return { name: 'judge-closedqa', score: typeof r?.score === 'number' ? r.score : 0 };
    });
  }

  const noSendLogs = !process.env.BRAINTRUST_API_KEY;

  const result = await Eval(
    `gstack-model-benchmark:${provider}`,
    {
      data: () => cases.map((c) => ({ input: c.input, expected: c.required, metadata: { id: c.id } })),
      task: async (input: string) => {
        const c = byInput.get(input);
        const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bench-'));
        try {
          const r = await adapter.run({ prompt: input, workdir, timeoutMs });
          ops.push({
            id: c?.id ?? input.slice(0, 24),
            durationMs: r.durationMs,
            modelUsed: r.modelUsed,
            error: r.error ? `${r.error.code}: ${r.error.reason}` : undefined,
          });
          if (r.error) throw new Error(`${provider} failed: ${r.error.code} — ${r.error.reason}`);
          // Empty output = provider never answered (silent auth/CLI failure). Fail
          // loud so it can't masquerade as a 0.0 score.
          if (!r.output.trim()) {
            throw new Error(`${provider} returned empty output (likely auth/CLI failure, not a real result)`);
          }
          return r.output;
        } finally {
          fs.rmSync(workdir, { recursive: true, force: true });
        }
      },
      scores,
    },
    { noSendLogs },
  );

  const scoreSummary = result.summary?.scores?.['required-terms'];
  const score = typeof scoreSummary?.score === 'number' ? scoreSummary.score : null;
  return { provider, score, ops };
}
