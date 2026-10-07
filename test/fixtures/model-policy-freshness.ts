import { readFileSync } from 'node:fs';
import { FRESHNESS_SOURCES, parseOfficialSource, sha256, type SourceId, type SourceResult } from '../../lib/model-policy-freshness-sources';
import type { CatalogIdentity, FreshnessObservation } from '../../lib/model-policy-freshness';

export const freshnessCatalog: CatalogIdentity = {
  sha256: sha256('catalog-v1'), sourceSha256: sha256('catalog-source-v1'), version: 1,
  models: [
    { provider: 'anthropic', tier: 'frontier', modelId: 'claude-fable-5-1' },
    { provider: 'anthropic', tier: 'smart', modelId: 'claude-opus-5-5' },
    { provider: 'openai', tier: 'frontier', modelId: 'gpt-6-astra' },
    { provider: 'openai', tier: 'smart', modelId: 'gpt-6.1-sol' },
  ],
};

export function freshnessFixture(id: SourceId): string {
  return readFileSync(new URL(`./model-policy-freshness/${id}.md`, import.meta.url), 'utf8');
}

export function freshnessObservation(id = '100', at = '2026-10-07T12:00:00.000Z', overrides: Partial<Record<SourceId, string | null>> = {}): FreshnessObservation {
  const sources: SourceResult[] = FRESHNESS_SOURCES.map(source => {
    const text = overrides[source.id] === undefined ? freshnessFixture(source.id) : overrides[source.id];
    return text === null ? { id: source.id, error: 'http-503' } : {
      id: source.id, receipt: { id: source.id, url: source.url, finalUrl: source.url, sha256: sha256(text!), bytes: Buffer.byteLength(text!), parsed: parseOfficialSource(source.id, text!) },
    };
  });
  return { catalog: structuredClone(freshnessCatalog), checkedAt: at, run: { id, attempt: 1, startedAt: new Date(Date.parse(at) - 1000).toISOString(), headSha: 'a'.repeat(40) }, sources };
}

export function retirementFixture(): string {
  return freshnessFixture('anthropic-lifecycle').replace('claude-fable-5-1 | Active | N/A | Not sooner than September 1, 2027', 'claude-fable-5-1 | Deprecated | October 1, 2026 | November 1, 2026');
}

export function freshnessReplacementObservation(): FreshnessObservation {
  const observation = freshnessObservation('101', '2026-10-08T12:00:00.000Z', {
    'anthropic-models': freshnessFixture('anthropic-models').replaceAll('fable-5-1', 'fable-5-2'),
    'anthropic-lifecycle': freshnessFixture('anthropic-lifecycle').replaceAll('fable-5-1', 'fable-5-2'),
  });
  observation.catalog.models[0].modelId = 'claude-fable-5-2';
  observation.catalog.sha256 = 'b'.repeat(64);
  observation.catalog.sourceSha256 = 'c'.repeat(64);
  return observation;
}
