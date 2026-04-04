/**
 * Per-model cost tracking for eval runs.
 *
 * Computes cost breakdowns from CostEntry arrays and formats
 * them as terminal tables. Supports aggregation across multiple runs.
 */

import type { CostEntry, StandardEvalResult } from './eval-format';

// --- Interfaces ---

export interface CostSummary {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

export interface CostDashboard {
  entries: CostSummary[];
  total: number;
  at_fast_tier: number;
  at_full_tier: number;
}

// --- Pricing ---

/**
 * Per-million-token pricing for Claude models.
 * Last verified: 2025-05-01
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6':       { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':     { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':      { input: 0.80,  output: 4.00  },
  // Legacy model IDs
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output: 4.00  },
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 },
};

/** Fallback pricing for unknown models (use sonnet pricing as a safe middle ground). */
const FALLBACK_PRICING = { input: 3.00, output: 15.00 };

// --- Computation ---

function getPricing(model: string): { input: number; output: number } {
  return MODEL_PRICING[model] || FALLBACK_PRICING;
}

/**
 * Compute per-model cost summaries from an array of CostEntry records.
 */
export function computeCosts(costs: CostEntry[]): CostDashboard {
  const byModel = new Map<string, CostSummary>();

  // Track exact cost_usd sums per model (from API-provided costs)
  const exactCosts = new Map<string, number>();

  for (const entry of costs) {
    const existing = byModel.get(entry.model);
    if (existing) {
      existing.calls += entry.calls;
      existing.input_tokens += entry.input_tokens;
      existing.output_tokens += entry.output_tokens;
    } else {
      byModel.set(entry.model, {
        model: entry.model,
        calls: entry.calls,
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        estimated_cost_usd: 0,
      });
    }
    if (entry.cost_usd !== undefined) {
      exactCosts.set(entry.model, (exactCosts.get(entry.model) || 0) + entry.cost_usd);
    }
  }

  // Calculate costs — prefer exact cost_usd (accounts for cache discounts)
  let total = 0;
  let atFast = 0;
  let atFull = 0;
  const fastPricing = MODEL_PRICING['claude-haiku-4-5'] || FALLBACK_PRICING;
  const fullPricing = MODEL_PRICING['claude-opus-4-6'] || FALLBACK_PRICING;

  for (const summary of byModel.values()) {
    const exact = exactCosts.get(summary.model);
    if (exact !== undefined) {
      summary.estimated_cost_usd = exact;
    } else {
      const pricing = getPricing(summary.model);
      summary.estimated_cost_usd =
        (summary.input_tokens / 1_000_000) * pricing.input +
        (summary.output_tokens / 1_000_000) * pricing.output;
    }
    total += summary.estimated_cost_usd;

    // What-if at fast/full tiers (always from token counts)
    atFast +=
      (summary.input_tokens / 1_000_000) * fastPricing.input +
      (summary.output_tokens / 1_000_000) * fastPricing.output;
    atFull +=
      (summary.input_tokens / 1_000_000) * fullPricing.input +
      (summary.output_tokens / 1_000_000) * fullPricing.output;
  }

  const entries = [...byModel.values()].sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd);

  return {
    entries,
    total: Math.round(total * 1_000_000) / 1_000_000,
    at_fast_tier: Math.round(atFast * 1_000_000) / 1_000_000,
    at_full_tier: Math.round(atFull * 1_000_000) / 1_000_000,
  };
}

/**
 * Format a CostDashboard as a terminal table.
 */
export function formatCostDashboard(dashboard: CostDashboard): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Cost Breakdown');
  lines.push('═'.repeat(75));
  lines.push(
    '  ' +
    'Model'.padEnd(32) +
    'Calls'.padEnd(8) +
    'In Tokens'.padEnd(12) +
    'Out Tokens'.padEnd(12) +
    'Cost'
  );
  lines.push('─'.repeat(75));

  for (const entry of dashboard.entries) {
    const model = entry.model.length > 30 ? entry.model.slice(0, 27) + '...' : entry.model.padEnd(32);
    lines.push(
      `  ${model}` +
      `${entry.calls}`.padEnd(8) +
      `${entry.input_tokens.toLocaleString()}`.padEnd(12) +
      `${entry.output_tokens.toLocaleString()}`.padEnd(12) +
      `$${entry.estimated_cost_usd.toFixed(4)}`
    );
  }

  lines.push('─'.repeat(75));
  lines.push(`  Total: $${dashboard.total.toFixed(4)}`);
  lines.push(`  At fast tier (Haiku):  $${dashboard.at_fast_tier.toFixed(4)}`);
  lines.push(`  At full tier (Opus):   $${dashboard.at_full_tier.toFixed(4)}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Aggregate costs across multiple StandardEvalResult runs.
 * Merges all costs[] arrays and computes a single dashboard.
 */
export function aggregateCosts(results: StandardEvalResult[]): CostDashboard {
  const allCosts: CostEntry[] = [];
  for (const r of results) {
    if (r.costs) {
      allCosts.push(...r.costs);
    }
  }
  return computeCosts(allCosts);
}
