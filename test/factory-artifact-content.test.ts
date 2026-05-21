import { describe, expect, test } from 'bun:test';
import {
  createFactoryArtifactBundle,
  createFactoryArtifactContentDescriptor,
  createFactoryBinaryArtifactContentDescriptor,
  createFactoryBundleArtifactContentDescriptor,
  createFactoryExternalUriArtifactContentDescriptor,
  createStoredTextArtifactContentDescriptor,
  createUntrustedEventMetadataUriDescriptor,
  isAllowedFactoryArtifactSafeUri,
  isFactoryArtifactContentKind,
  isFactoryArtifactContentProvenanceSource,
  primaryActionFromDescriptor,
  safetyLabelFromDescriptor,
  summarizeFactoryArtifactContent,
} from '../lib/factory-artifact-content';

describe('factory artifact content descriptors', () => {
  test('supports text, binary, external-uri, and bundle descriptor concepts', () => {
    const text = createStoredTextArtifactContentDescriptor({
      runId: 'run-1',
      artifactId: 'summary',
      artifactKind: 'review',
      byteLength: 42,
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const binary = createFactoryBinaryArtifactContentDescriptor({
      runId: 'run-1',
      artifactId: 'screenshot-main',
      artifactKind: 'screenshot',
      mediaType: 'image/png',
      fileName: 'home.png',
      byteLength: 2048,
      digest: { algorithm: 'sha256', value: 'abc123' },
      provenance: { source: 'artifact-store', trusted: true },
    });
    const external = createFactoryExternalUriArtifactContentDescriptor({
      runId: 'run-1',
      artifactId: 'ci-link',
      artifactKind: 'qa-report',
      safeUri: 'https://ci.example.test/runs/123',
      provenance: { source: 'external-system', trusted: true },
    });
    const bundle = createFactoryBundleArtifactContentDescriptor({
      runId: 'run-1',
      artifactId: 'qa-bundle',
      artifactKind: 'browser-trace',
      provenance: { source: 'artifact-store', trusted: true },
    });

    expect(text.kind).toBe('text');
    expect(binary.kind).toBe('binary');
    expect(external.kind).toBe('external-uri');
    expect(bundle.kind).toBe('bundle');
    expect(text.hasInlineText).toBe(true);
    expect(binary.hasInlineText).toBe(false);
    expect(external.hasInlineText).toBe(false);
    expect(bundle.hasInlineText).toBe(false);
  });

  test('marks untrusted event metadata uri descriptors as metadata-only', () => {
    const descriptor = createUntrustedEventMetadataUriDescriptor({
      runId: 'run-2',
      artifactId: 'qa-report-link',
      artifactKind: 'qa-report',
    });

    expect(descriptor).toMatchObject({
      runId: 'run-2',
      artifactId: 'qa-report-link',
      kind: 'external-uri',
      provenance: {
        source: 'event-metadata',
        trusted: false,
      },
      safeUri: undefined,
      hasInlineText: false,
    });
  });

  test('allows trusted https safeUri and normalizes it', () => {
    const descriptor = createFactoryExternalUriArtifactContentDescriptor({
      runId: 'run-3',
      artifactId: 'external-proof',
      artifactKind: 'qa-report',
      safeUri: 'https://example.test/results?id=7',
      provenance: { source: 'external-system', trusted: true },
    });

    expect(descriptor.safeUri).toBe('https://example.test/results?id=7');
  });

  test('allows file safeUri only for trusted artifact-store provenance', () => {
    expect(isAllowedFactoryArtifactSafeUri('file:///tmp/factory/report.md', 'artifact-store')).toBe(true);
    expect(isAllowedFactoryArtifactSafeUri('file:///tmp/factory/report.md', 'external-system')).toBe(false);

    const descriptor = createFactoryBinaryArtifactContentDescriptor({
      runId: 'run-4',
      artifactId: 'screenshot',
      artifactKind: 'screenshot',
      safeUri: 'file:///tmp/factory/screenshot.png',
      provenance: { source: 'artifact-store', trusted: true },
    });

    expect(descriptor.safeUri).toBe('file:///tmp/factory/screenshot.png');
  });

  test('rejects unsafe or trust-escalated safeUri descriptors', () => {
    expect(() => createFactoryExternalUriArtifactContentDescriptor({
      runId: 'run-5',
      artifactId: 'bad-uri',
      artifactKind: 'qa-report',
      safeUri: 'javascript:alert(1)',
      provenance: { source: 'external-system', trusted: true },
    })).toThrow('is not allowed');

    expect(() => createFactoryExternalUriArtifactContentDescriptor({
      runId: 'run-5',
      artifactId: 'event-uri',
      artifactKind: 'qa-report',
      safeUri: 'https://example.test/raw-event',
      provenance: { source: 'event-metadata', trusted: false },
    })).toThrow('safeUri requires trusted provenance');

    expect(() => createFactoryArtifactContentDescriptor({
      runId: 'run-5',
      artifactId: 'trust-escalation',
      artifactKind: 'qa-report',
      kind: 'external-uri',
      hasInlineText: false,
      provenance: { source: 'event-metadata', trusted: true },
    })).toThrow('event-metadata provenance cannot be trusted');
  });

  test('builds bundle DTOs with validated items', () => {
    const bundle = createFactoryArtifactBundle({
      runId: 'run-6',
      artifactId: 'bundle-1',
      items: [
        createStoredTextArtifactContentDescriptor({
          runId: 'run-6',
          artifactId: 'bundle-1',
          artifactKind: 'qa-report',
          byteLength: 88,
        }),
        createFactoryBinaryArtifactContentDescriptor({
          runId: 'run-6',
          artifactId: 'bundle-1',
          artifactKind: 'screenshot',
          mediaType: 'image/webp',
          byteLength: 1024,
          provenance: { source: 'artifact-store', trusted: true },
        }),
      ],
    });

    expect(bundle.items).toHaveLength(2);
    expect(bundle.items.map(item => item.kind)).toEqual(['text', 'binary']);
  });

  test('exposes kind/source guards for callers handling untyped input', () => {
    expect(isFactoryArtifactContentKind('bundle')).toBe(true);
    expect(isFactoryArtifactContentKind('unknown')).toBe(false);
    expect(isFactoryArtifactContentProvenanceSource('artifact-store')).toBe(true);
    expect(isFactoryArtifactContentProvenanceSource('unsafe')).toBe(false);
  });

  test('summarizes trusted stored text artifacts as open-text trusted-local', () => {
    const summary = summarizeFactoryArtifactContent({
      runId: 'run-summary-1',
      artifactId: 'review-summary',
      artifactKind: 'review',
      trustedStorePath: '/tmp/factory/run-summary-1/artifacts/review-summary.md',
      createdAt: '2026-05-21T00:00:00.000Z',
    });
    expect(summary.primaryKind).toBe('text');
    expect(summary.safetyLabel).toBe('trusted-local');
    expect(summary.primaryAction).toBe('open-text');
    expect(summary.descriptors).toHaveLength(1);
    expect(summary.primaryDescriptor).toMatchObject({
      kind: 'text',
      provenance: { source: 'artifact-store', trusted: true },
      hasInlineText: true,
      mediaType: 'text/markdown',
    });
  });

  test('treats raw event uri/path as untrusted metadata-only descriptors', () => {
    const uriOnly = summarizeFactoryArtifactContent({
      runId: 'run-summary-2',
      artifactId: 'qa-link',
      artifactKind: 'qa-report',
      eventUri: 'https://ci.example.test/raw',
    });
    expect(uriOnly.primaryKind).toBe('external-uri');
    expect(uriOnly.safetyLabel).toBe('metadata-only');
    expect(uriOnly.primaryAction).toBe('inspect-metadata');
    expect(uriOnly.primaryDescriptor).toMatchObject({
      provenance: { source: 'event-metadata', trusted: false },
      safeUri: undefined,
      hasInlineText: false,
    });

    const pathOnly = summarizeFactoryArtifactContent({
      runId: 'run-summary-2',
      artifactId: 'qa-path',
      artifactKind: 'qa-report',
      eventPath: '/tmp/untrusted',
    });
    expect(pathOnly.safetyLabel).toBe('metadata-only');
    expect(pathOnly.primaryAction).toBe('inspect-metadata');
    expect(pathOnly.primaryDescriptor.provenance.trusted).toBe(false);
  });

  test('keeps event metadata as a secondary descriptor when a trusted store path is present', () => {
    const summary = summarizeFactoryArtifactContent({
      runId: 'run-summary-3',
      artifactId: 'review-summary',
      artifactKind: 'review',
      trustedStorePath: '/tmp/factory/run-summary-3/artifacts/review-summary.md',
      eventUri: 'https://untrusted.example.test/raw',
    });
    expect(summary.primaryKind).toBe('text');
    expect(summary.safetyLabel).toBe('trusted-local');
    expect(summary.descriptors).toHaveLength(2);
    expect(summary.descriptors[1].provenance.trusted).toBe(false);
    expect(summary.descriptors[1].kind).toBe('external-uri');
  });

  test('summarizes trusted binary attestations as preview/download depending on media type', () => {
    const image = summarizeFactoryArtifactContent({
      runId: 'run-summary-4',
      artifactId: 'home-screenshot',
      artifactKind: 'screenshot',
      trustedBinary: { mediaType: 'image/png', byteLength: 1024 },
    });
    expect(image.primaryKind).toBe('binary');
    expect(image.safetyLabel).toBe('trusted-local');
    expect(image.primaryAction).toBe('open-preview');

    const trace = summarizeFactoryArtifactContent({
      runId: 'run-summary-4',
      artifactId: 'trace',
      artifactKind: 'browser-trace',
      trustedBinary: { mediaType: 'application/zip', byteLength: 4096 },
    });
    expect(trace.primaryAction).toBe('download');
  });

  test('summarizes trusted external uris and bundle descriptors safely', () => {
    const external = summarizeFactoryArtifactContent({
      runId: 'run-summary-5',
      artifactId: 'ci-run',
      artifactKind: 'qa-report',
      trustedExternalUri: { safeUri: 'https://ci.example.test/runs/42' },
    });
    expect(external.primaryKind).toBe('external-uri');
    expect(external.safetyLabel).toBe('trusted-external');
    expect(external.primaryAction).toBe('open-external');

    const bundle = summarizeFactoryArtifactContent({
      runId: 'run-summary-5',
      artifactId: 'qa-bundle',
      artifactKind: 'browser-trace',
      bundleItems: [
        createStoredTextArtifactContentDescriptor({
          runId: 'run-summary-5',
          artifactId: 'qa-bundle',
          artifactKind: 'qa-report',
        }),
        createFactoryBinaryArtifactContentDescriptor({
          runId: 'run-summary-5',
          artifactId: 'qa-bundle',
          artifactKind: 'screenshot',
          mediaType: 'image/webp',
          provenance: { source: 'artifact-store', trusted: true },
        }),
      ],
    });
    expect(bundle.primaryKind).toBe('bundle');
    expect(bundle.safetyLabel).toBe('trusted-local');
    expect(bundle.primaryAction).toBe('open-preview');
    expect(bundle.descriptors.length).toBeGreaterThanOrEqual(3);
  });

  test('falls back to metadata-only when no trusted or event reference is provided', () => {
    const summary = summarizeFactoryArtifactContent({
      runId: 'run-summary-6',
      artifactId: 'orphan',
      artifactKind: 'plan',
    });
    expect(summary.primaryKind).toBe('external-uri');
    expect(summary.safetyLabel).toBe('metadata-only');
    expect(summary.primaryAction).toBe('inspect-metadata');
  });

  test('exposes safety/action helpers for descriptors built directly', () => {
    const stored = createStoredTextArtifactContentDescriptor({
      runId: 'run-summary-7',
      artifactId: 'plan',
      artifactKind: 'plan',
    });
    expect(safetyLabelFromDescriptor(stored)).toBe('trusted-local');
    expect(primaryActionFromDescriptor(stored)).toBe('open-text');

    const untrusted = createUntrustedEventMetadataUriDescriptor({
      runId: 'run-summary-7',
      artifactId: 'plan',
      artifactKind: 'plan',
    });
    expect(safetyLabelFromDescriptor(untrusted)).toBe('metadata-only');
    expect(primaryActionFromDescriptor(untrusted)).toBe('inspect-metadata');
  });
});
