/**
 * GStack model benchmark — Braintrust entrypoint for `bun run` / CI.
 *
 * Braintrust owns scoring, comparison, and reporting. See
 * lib/model-benchmark/braintrust-eval.ts for the core; the user-facing CLI is
 * bin/gstack-model-benchmark.
 *
 * Local run, nothing leaves the machine:
 *   GSTACK_BENCH_PROVIDER=claude bun run evals/model-benchmark/gstack.eval.ts
 *
 * Opt into the Braintrust dashboard (consent-gated cloud):
 *   export BRAINTRUST_API_KEY=...
 *   for p in claude gpt gemini; do GSTACK_BENCH_PROVIDER=$p bun run evals/model-benchmark/gstack.eval.ts; done
 */
import { loadCorpus, runProviderBenchmark, type ProviderName } from '../../lib/model-benchmark/braintrust-eval';

const provider = (process.env.GSTACK_BENCH_PROVIDER ?? 'claude') as ProviderName;
const timeoutMs = Number(process.env.GSTACK_BENCH_TIMEOUT_MS ?? 300_000);
const judge = process.env.GSTACK_BENCH_JUDGE === '1';

await runProviderBenchmark(provider, loadCorpus(), { timeoutMs, judge });
