/**
 * pricing — the per-model price table gstack's estimators share (plan E1;
 * moved from test/helpers/pricing.ts, which re-exports it). Prices are USD
 * per million tokens as of `as_of`; update quarterly from the provider pages.
 *
 * What the table can and cannot promise (why every admission is an
 * *estimate* and `lib/spend-ledger.ts` reconciles actual cost at settle time):
 * the rows price standard text tokens only. EXCLUDED billing categories, each
 * of which appears on the invoice and not here:
 *   - prompt-cache writes (cache *reads* are priced when `cached_input_per_mtok`
 *     is set, else at the historical 10% of input)
 *   - tool and connector fees (web search, code execution, file search, MCP)
 *   - service-tier multipliers (priority / flex / batch) and long-context
 *     surcharges above a provider's standard window
 *   - image, audio and video tokens
 *   - subscription seats and CLI-metered runs (a Codex CLI or host-subagent
 *     call is `unknown` spend, never zero: lib/spend-ledger.ts `settle(…, 'unknown')`)
 * When a model is not in the table, `estimateCostUsd` returns 0 with one
 * stderr warning per model; `hasPricing` is the dry-run check that refuses to
 * start a priced run on such a model (bin/gstack-eval-plan dry-run).
 *   - Anthropic: https://www.anthropic.com/pricing#api
 *   - OpenAI: https://openai.com/api/pricing/
 *   - Google AI: https://ai.google.dev/gemini-api/docs/pricing
 *   - Voyage AI (embeddings, rerankers): https://docs.voyageai.com/docs/pricing
 */

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cached_input_per_mtok?: number;
  as_of: string; // YYYY-MM
}

/** Billing categories the table does not price; printed by the dry-run checklist. */
export const EXCLUDED_BILLING_CATEGORIES: readonly string[] = Object.freeze([
  'prompt-cache writes',
  'tool and connector fees (web search, code execution, file search, MCP)',
  'service-tier multipliers (priority, flex, batch) and long-context surcharges',
  'image, audio and video tokens',
  'subscription seats and CLI-metered runs (recorded as unknown spend)',
]);

export const PRICING: Record<string, ModelPricing> = {
  // Claude (Anthropic)
  // https://platform.claude.com/docs/en/models/fable-5-1/overview#pricing
  'claude-fable-5-1':  { input_per_mtok: 10.00, output_per_mtok: 50.00, cached_input_per_mtok: 0.25, as_of: '2026-09' },
  // https://platform.claude.com/docs/en/models/opus-5-5/overview#pricing (list prices effective 2026-10-07)
  'claude-opus-5-5':    { input_per_mtok: 4.00,  output_per_mtok: 20.00, cached_input_per_mtok: 0.20, as_of: '2026-10' },
  // https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-12)
  'claude-opus-4-7':    { input_per_mtok: 5.00,  output_per_mtok: 25.00, cached_input_per_mtok: 0.50, as_of: '2026-10' },
  // https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-12)
  'claude-sonnet-5-5':  { input_per_mtok: 2.00,  output_per_mtok: 10.00, cached_input_per_mtok: 0.10, as_of: '2026-10' },
  'claude-sonnet-4-6':  { input_per_mtok: 3.00,  output_per_mtok: 15.00, as_of: '2026-04' },
  'claude-haiku-4-5':   { input_per_mtok: 1.00,  output_per_mtok: 5.00,  as_of: '2026-04' },

  // OpenAI (GPT + o-series)
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  'gpt-6-astra':        { input_per_mtok: 10.00, output_per_mtok: 50.00, cached_input_per_mtok: 1.00, as_of: '2026-09' },
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol (standard tier, up to 272K input)
  'gpt-6.1-sol':        { input_per_mtok: 2.00,  output_per_mtok: 10.00, cached_input_per_mtok: 0.10, as_of: '2026-10' },
  'gpt-5.4':            { input_per_mtok: 2.50,  output_per_mtok: 10.00, as_of: '2026-04' },
  // https://developers.openai.com/api/docs/models/gpt-4o (fetched 2026-10-13; gbrain's LongMemEval judge, the official scorer's model;
  // the alias only: the gpt-4o-2024-05-13 snapshot has its own price)
  'gpt-4o':             { input_per_mtok: 2.50,  output_per_mtok: 10.00, cached_input_per_mtok: 1.25, as_of: '2026-10' },
  'gpt-5.4-mini':       { input_per_mtok: 0.60,  output_per_mtok: 2.40,  as_of: '2026-04' },
  'o3':                 { input_per_mtok: 15.00, output_per_mtok: 60.00, as_of: '2026-04' },
  'o4-mini':            { input_per_mtok: 1.10,  output_per_mtok: 4.40,  as_of: '2026-04' },

  // Google
  // https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-12; standard tier through 2026-12-31,
  // the page lists $1.50 / $7.50 / $0.15 cached starting 2027-01-01)
  'gemini-3.8-flash':   { input_per_mtok: 0.75,  output_per_mtok: 3.75,  cached_input_per_mtok: 0.075, as_of: '2026-10' },
  // https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-12; same schedule as gemini-3.8-flash)
  'gemini-3.6-flash':   { input_per_mtok: 0.75,  output_per_mtok: 3.75,  cached_input_per_mtok: 0.075, as_of: '2026-10' },
  // https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-12; prompts <= 200k tokens, the long-context rate is excluded)
  'gemini-3.1-pro-preview': { input_per_mtok: 2.00, output_per_mtok: 12.00, cached_input_per_mtok: 0.20, as_of: '2026-10' },
  'gemini-2.5-pro':     { input_per_mtok: 1.25,  output_per_mtok: 5.00,  as_of: '2026-04' },
  'gemini-2.5-flash':   { input_per_mtok: 0.30,  output_per_mtok: 1.20,  as_of: '2026-04' },

  // Particle AI: https://docs.particle.ai/usage-billing (fetched 2026-10-30; peak rates, off-peak and flex are 50% lower;
  // OpenRouter serves particle-ai/particle-1 at the same rates)
  'particle-1':         { input_per_mtok: 0.25,  output_per_mtok: 1.00,  cached_input_per_mtok: 0.03, as_of: '2026-10' },
  // https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017 (fetched 2026-10-30; the route the model panel runs it on)
  'deepseek-v4.1-flash-1017': { input_per_mtok: 0.15, output_per_mtok: 0.60, cached_input_per_mtok: 0.003, as_of: '2026-10' },
};

/**
 * Embedding models bill input tokens only (output_per_mtok 0), so they live
 * beside PRICING rather than in it: eval arms never resolve to an embedding
 * model, but a call plan (docs/eval-calls.md) prices gbrain's embedding calls.
 */
export const EMBEDDING_PRICING: Record<string, ModelPricing> = {
  // https://docs.voyageai.com/docs/pricing (fetched 2026-10-12; list price after the free-token allowance)
  'voyage-4':             { input_per_mtok: 0.06, output_per_mtok: 0, as_of: '2026-10' },
  'voyage-4-large':       { input_per_mtok: 0.12, output_per_mtok: 0, as_of: '2026-10' },
  'voyage-4-lite':        { input_per_mtok: 0.02, output_per_mtok: 0, as_of: '2026-10' },
  'voyage-code-4':        { input_per_mtok: 0.12, output_per_mtok: 0, as_of: '2026-10' },
  'voyage-code-3':        { input_per_mtok: 0.18, output_per_mtok: 0, as_of: '2026-10' },
  'voyage-3-large':       { input_per_mtok: 0.18, output_per_mtok: 0, as_of: '2026-10' },
  'voyage-multimodal-3':  { input_per_mtok: 0.12, output_per_mtok: 0, as_of: '2026-10' }, // text tokens; pixels excluded
  // https://docs.voyageai.com/docs/pricing (fetched 2026-10-13; rerankers bill query tokens x documents plus document tokens)
  'rerank-2.5':           { input_per_mtok: 0.05, output_per_mtok: 0, as_of: '2026-10' },
  'rerank-2.5-lite':      { input_per_mtok: 0.02, output_per_mtok: 0, as_of: '2026-10' },
  // https://developers.openai.com/api/docs/pricing (fetched 2026-10-12)
  'text-embedding-3-large': { input_per_mtok: 0.13, output_per_mtok: 0, as_of: '2026-10' },
  'text-embedding-3-small': { input_per_mtok: 0.02, output_per_mtok: 0, as_of: '2026-10' },
  // https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-10-12; text input, standard tier)
  'gemini-embedding-2':   { input_per_mtok: 0.20, output_per_mtok: 0, as_of: '2026-10' },
};

/**
 * A provider-prefixed id (`openai/gpt-6-astra`, `anthropic/claude-fable-5-1`,
 * or gbrain's `voyage:voyage-4`) resolves to its table row, and so does a
 * dated Claude snapshot (`claude-haiku-4-5-20251001`, Anthropic's `-YYYYMMDD`
 * form), which bills at its alias's price. Dated OpenAI snapshots are not
 * folded: some are priced differently from their alias.
 */
export function pricingRow(model: string | undefined): ModelPricing | undefined {
  if (!model) return undefined;
  const bare = model.replace(/^[a-z-]+[/:]/, '');
  const undated = /^claude-/.test(bare) ? bare.replace(/-\d{8}$/, '') : bare;
  return PRICING[model] ?? PRICING[bare] ?? PRICING[undated] ?? EMBEDDING_PRICING[model] ?? EMBEDDING_PRICING[bare];
}

export function hasPricing(model: string | undefined): boolean {
  return pricingRow(model) !== undefined;
}

const WARNED = new Set<string>();

export function estimateCostUsd(
  tokens: { input: number; output: number; cached?: number },
  model: string | undefined
): number {
  if (!model) return 0;
  const row = pricingRow(model);
  if (!row) {
    if (!WARNED.has(model)) {
      WARNED.add(model);
      console.error(`WARN: no pricing for model ${model}; returning 0. Add it to lib/pricing.ts.`);
    }
    return 0;
  }
  // This helper expects uncached input and cache reads as disjoint counts.
  // Preserve the historical 10% rate for rows without an explicit cache-read price.
  const cachedRate = row.cached_input_per_mtok ?? row.input_per_mtok * 0.1;
  const inputCost = tokens.input * row.input_per_mtok / 1_000_000;
  const cachedCost = (tokens.cached ?? 0) * cachedRate / 1_000_000;
  const outputCost = tokens.output * row.output_per_mtok / 1_000_000;
  return +(inputCost + cachedCost + outputCost).toFixed(6);
}
