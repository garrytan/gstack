/**
 * Per-model pricing tables: re-exported from lib/pricing.ts (plan E1), which
 * documents the billing categories the table excludes. Test and script
 * importers keep this path; add rows in lib/pricing.ts.
 */
export { EXCLUDED_BILLING_CATEGORIES, PRICING, estimateCostUsd, hasPricing, pricingRow, type ModelPricing } from '../../lib/pricing';
