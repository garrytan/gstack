/**
 * Tests for lib/eval-cost.ts — per-model cost tracking.
 */

import { describe, test, expect } from 'bun:test';
import {
  MODEL_PRICING,
  computeCosts,
  formatCostDashboard,
  aggregateCosts,
} from '../lib/eval-cost';
import type { CostEntry, StandardEvalResult } from '../lib/eval-format';

describe('lib/eval-cost', () => {
  describe('MODEL_PRICING', () => {
    test('includes current Claude models', () => {
      expect(MODEL_PRICING['claude-opus-4-6']).toBeDefined();
      expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
      expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
    });

    test('has input and output pricing for each model', () => {
      for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.input).toBeGreaterThan(0);
        expect(pricing.output).toBeGreaterThan(0);
        expect(pricing.output).toBeGreaterThanOrEqual(pricing.input);
      }
    });
  });

  describe('computeCosts', () => {
    test('computes cost for a single model', () => {
      const costs: CostEntry[] = [{
        model: 'claude-sonnet-4-6',
        calls: 10,
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      }];
      const dashboard = computeCosts(costs);
      expect(dashboard.entries.length).toBe(1);
      expect(dashboard.entries[0].model).toBe('claude-sonnet-4-6');
      expect(dashboard.entries[0].calls).toBe(10);
      // $3/M input + $15/M * 0.5 = $3 + $7.5 = $10.5
      expect(dashboard.total).toBeCloseTo(10.5, 2);
    });

    test('aggregates multiple entries for same model', () => {
      const costs: CostEntry[] = [
        { model: 'claude-haiku-4-5', calls: 5, input_tokens: 100_000, output_tokens: 50_000 },
        { model: 'claude-haiku-4-5', calls: 3, input_tokens: 200_000, output_tokens: 100_000 },
      ];
      const dashboard = computeCosts(costs);
      expect(dashboard.entries.length).toBe(1);
      expect(dashboard.entries[0].calls).toBe(8);
      expect(dashboard.entries[0].input_tokens).toBe(300_000);
      expect(dashboard.entries[0].output_tokens).toBe(150_000);
    });

    test('handles multiple models', () => {
      const costs: CostEntry[] = [
        { model: 'claude-haiku-4-5', calls: 5, input_tokens: 100_000, output_tokens: 50_000 },
        { model: 'claude-opus-4-6', calls: 1, input_tokens: 100_000, output_tokens: 50_000 },
      ];
      const dashboard = computeCosts(costs);
      expect(dashboard.entries.length).toBe(2);
      // Sorted by cost desc — opus is more expensive
      expect(dashboard.entries[0].model).toBe('claude-opus-4-6');
    });

    test('uses fallback pricing for unknown models', () => {
      const costs: CostEntry[] = [{
        model: 'unknown-model-xyz',
        calls: 1,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }];
      const dashboard = computeCosts(costs);
      expect(dashboard.entries.length).toBe(1);
      // Fallback is sonnet pricing: $3 + $15 = $18
      expect(dashboard.total).toBeCloseTo(18, 2);
    });

    test('computes what-if at fast and full tiers', () => {
      const costs: CostEntry[] = [{
        model: 'claude-sonnet-4-6',
        calls: 1,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }];
      const dashboard = computeCosts(costs);
      expect(dashboard.at_fast_tier).toBeLessThan(dashboard.total);
      expect(dashboard.at_full_tier).toBeGreaterThan(dashboard.total);
    });

    test('handles empty input', () => {
      const dashboard = computeCosts([]);
      expect(dashboard.entries.length).toBe(0);
      expect(dashboard.total).toBe(0);
    });
  });

  describe('formatCostDashboard', () => {
    test('produces readable output', () => {
      const costs: CostEntry[] = [{
        model: 'claude-sonnet-4-6',
        calls: 10,
        input_tokens: 500_000,
        output_tokens: 250_000,
      }];
      const dashboard = computeCosts(costs);
      const output = formatCostDashboard(dashboard);
      expect(output).toContain('Cost Breakdown');
      expect(output).toContain('claude-sonnet-4-6');
      expect(output).toContain('10');
      expect(output).toContain('Total:');
      expect(output).toContain('fast tier');
      expect(output).toContain('full tier');
    });
  });

  describe('aggregateCosts', () => {
    test('merges costs from multiple results', () => {
      const results: StandardEvalResult[] = [
        {
          schema_version: 1, version: '1.0', git_branch: 'main', git_sha: 'abc',
          timestamp: '', hostname: '', tier: 'e2e', total: 1, passed: 1, failed: 0,
          total_cost_usd: 1, duration_seconds: 10, all_results: [],
          costs: [{ model: 'claude-haiku-4-5', calls: 5, input_tokens: 100_000, output_tokens: 50_000 }],
        },
        {
          schema_version: 1, version: '1.0', git_branch: 'main', git_sha: 'def',
          timestamp: '', hostname: '', tier: 'e2e', total: 1, passed: 1, failed: 0,
          total_cost_usd: 2, duration_seconds: 20, all_results: [],
          costs: [{ model: 'claude-haiku-4-5', calls: 3, input_tokens: 200_000, output_tokens: 100_000 }],
        },
      ];
      const dashboard = aggregateCosts(results);
      expect(dashboard.entries.length).toBe(1);
      expect(dashboard.entries[0].calls).toBe(8);
    });

    test('handles results without costs field', () => {
      const results: StandardEvalResult[] = [
        {
          schema_version: 1, version: '1.0', git_branch: 'main', git_sha: 'abc',
          timestamp: '', hostname: '', tier: 'e2e', total: 1, passed: 1, failed: 0,
          total_cost_usd: 1, duration_seconds: 10, all_results: [],
        },
      ];
      const dashboard = aggregateCosts(results);
      expect(dashboard.entries.length).toBe(0);
      expect(dashboard.total).toBe(0);
    });
  });
});
