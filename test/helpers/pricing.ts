/**
 * Per-model pricing tables.
 *
 * Prices are USD per million tokens as of `as_of`. Update quarterly.
 * Link to provider pricing pages:
 *   - Anthropic: https://www.anthropic.com/pricing#api
 *   - OpenAI: https://openai.com/api/pricing/
 *   - Google AI: https://ai.google.dev/pricing
 *
 * When a model isn't in the table, estimateCost returns 0 with a console warning.
 * Prefer adding a new row to the table over guessing.
 */

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  as_of: string; // YYYY-MM
}

export const PRICING: Record<string, ModelPricing> = {
  // Claude (Anthropic)
  'claude-opus-4-7':    { input_per_mtok: 15.00, output_per_mtok: 75.00, as_of: '2026-04' },
  'claude-sonnet-4-6':  { input_per_mtok: 3.00,  output_per_mtok: 15.00, as_of: '2026-04' },
  'claude-haiku-4-5':   { input_per_mtok: 1.00,  output_per_mtok: 5.00,  as_of: '2026-04' },

  // OpenAI (GPT + o-series)
  'gpt-5.4':            { input_per_mtok: 2.50,  output_per_mtok: 10.00, as_of: '2026-04' },
  'gpt-5.4-mini':       { input_per_mtok: 0.60,  output_per_mtok: 2.40,  as_of: '2026-04' },
  'o3':                 { input_per_mtok: 15.00, output_per_mtok: 60.00, as_of: '2026-04' },
  'o4-mini':            { input_per_mtok: 1.10,  output_per_mtok: 4.40,  as_of: '2026-04' },

  // Google
  'gemini-2.5-pro':     { input_per_mtok: 1.25,  output_per_mtok: 5.00,  as_of: '2026-04' },
  'gemini-2.5-flash':   { input_per_mtok: 0.30,  output_per_mtok: 1.20,  as_of: '2026-04' },
};

const WARNED = new Set<string>();

export function estimateCostUsd(
  tokens: { input: number; output: number; cached?: number },
  model: string | undefined
): number {
  if (!model) return 0;
  const row = PRICING[model];
  if (!row) {
    if (!WARNED.has(model)) {
      WARNED.add(model);
      console.error(`WARN: no pricing for model ${model}; returning 0. Add it to test/helpers/pricing.ts.`);
    }
    return 0;
  }
  // Anthropic and OpenAI report cached tokens as a separate (disjoint) field from
  // uncached input tokens. tokens.input is already the uncached portion; tokens.cached
  // is the cache-read count billed at 10% of the regular input rate. Do NOT subtract
  // cached from input — they don't overlap.
  const cachedDiscount = 0.1;
  const inputCost = tokens.input * row.input_per_mtok / 1_000_000;
  const cachedCost = (tokens.cached ?? 0) * row.input_per_mtok * cachedDiscount / 1_000_000;
  const outputCost = tokens.output * row.output_per_mtok / 1_000_000;
  return +(inputCost + cachedCost + outputCost).toFixed(6);
}
