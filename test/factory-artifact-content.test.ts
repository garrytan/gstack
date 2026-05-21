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
});
