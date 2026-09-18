/**
 * Per-model pricing tables.
 *
 * Prices are USD per million tokens as of `as_of`. Update quarterly.
 * Standard text-token estimates, not billed totals: excludes cache writes,
 * tool fees, and service-tier or long-context multipliers.
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
  cached_input_per_mtok?: number;
  as_of: string; // YYYY-MM
}

export const PRICING: Record<string, ModelPricing> = {
  // Claude (Anthropic)
  // https://platform.claude.com/docs/en/models/fable-5-1/overview#pricing
  'claude-fable-5-1':  { input_per_mtok: 10.00, output_per_mtok: 50.00, cached_input_per_mtok: 0.25, as_of: '2026-09' },
  'claude-opus-4-7':    { input_per_mtok: 15.00, output_per_mtok: 75.00, as_of: '2026-04' },
  'claude-sonnet-4-6':  { input_per_mtok: 3.00,  output_per_mtok: 15.00, as_of: '2026-04' },
  'claude-haiku-4-5':   { input_per_mtok: 1.00,  output_per_mtok: 5.00,  as_of: '2026-04' },

  // OpenAI (GPT + o-series)
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  'gpt-6-astra':        { input_per_mtok: 10.00, output_per_mtok: 50.00, cached_input_per_mtok: 1.00, as_of: '2026-09' },
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
  // This helper expects uncached input and cache reads as disjoint counts.
  // Preserve the historical 10% rate for rows without an explicit cache-read price.
  const cachedRate = row.cached_input_per_mtok ?? row.input_per_mtok * 0.1;
  const inputCost = tokens.input * row.input_per_mtok / 1_000_000;
  const cachedCost = (tokens.cached ?? 0) * cachedRate / 1_000_000;
  const outputCost = tokens.output * row.output_per_mtok / 1_000_000;
  return +(inputCost + cachedCost + outputCost).toFixed(6);
}
