import { createHash } from 'node:crypto';

export type ModelProvider = 'anthropic' | 'openai';
export type ModelTier = 'frontier' | 'smart';

export const MODEL_PROVIDERS: readonly ModelProvider[] = Object.freeze(['anthropic', 'openai'] as const);
export const MODEL_TIERS: readonly ModelTier[] = Object.freeze(['frontier', 'smart'] as const);
export const MODEL_CATALOG_VERSION = 1 as const;

export interface ModelCatalogEntry {
  readonly provider: ModelProvider;
  readonly tier: ModelTier;
  readonly model: string;
  readonly sourceUrl: string;
  readonly verifiedAt: string;
}

const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/models/overview';
const OPENAI_SOURCE = 'https://developers.openai.com/api/docs/models';

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = Object.freeze([
  { provider: 'anthropic', tier: 'frontier', model: 'claude-fable-5-1', sourceUrl: ANTHROPIC_SOURCE, verifiedAt: '2026-10-07' },
  { provider: 'openai', tier: 'frontier', model: 'gpt-6-astra', sourceUrl: OPENAI_SOURCE, verifiedAt: '2026-10-07' },
  { provider: 'anthropic', tier: 'smart', model: 'claude-opus-5-5', sourceUrl: ANTHROPIC_SOURCE, verifiedAt: '2026-10-07' },
  { provider: 'openai', tier: 'smart', model: 'gpt-6.1-sol', sourceUrl: OPENAI_SOURCE, verifiedAt: '2026-10-07' },
].map(entry => Object.freeze(entry as ModelCatalogEntry)));

export function catalogEntry(provider: ModelProvider, tier: ModelTier): ModelCatalogEntry {
  const entry = MODEL_CATALOG.find(e => e.provider === provider && e.tier === tier);
  if (!entry) throw new Error(`model catalog has no ${tier} entry for ${provider}`);
  return entry;
}

export function modelCatalogCanonicalJson(): string {
  return JSON.stringify({
    version: MODEL_CATALOG_VERSION,
    entries: MODEL_CATALOG.map(e => ({ provider: e.provider, tier: e.tier, model: e.model, sourceUrl: e.sourceUrl, verifiedAt: e.verifiedAt })),
  });
}

export function modelCatalogSha256(): string {
  return createHash('sha256').update(modelCatalogCanonicalJson()).digest('hex');
}
