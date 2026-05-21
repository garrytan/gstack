import type { ArtifactKind } from './factory-core';

export type FactoryArtifactContentKind = 'text' | 'binary' | 'external-uri' | 'bundle';
export type FactoryArtifactContentProvenanceSource = 'artifact-store' | 'external-system' | 'event-metadata';

export type FactoryArtifactSafetyLabel =
  | 'trusted-local'
  | 'trusted-external'
  | 'metadata-only'
  | 'blocked';

export type FactoryArtifactPrimaryAction =
  | 'open-text'
  | 'open-preview'
  | 'download'
  | 'open-external'
  | 'inspect-metadata';

export interface FactoryArtifactDigestDto {
  readonly algorithm: 'sha256';
  readonly value: string;
}

export interface FactoryArtifactContentProvenanceDto {
  readonly source: FactoryArtifactContentProvenanceSource;
  readonly trusted: boolean;
  readonly note?: string;
}

export interface FactoryArtifactContentDescriptorDto {
  readonly runId: string;
  readonly artifactId: string;
  readonly kind: FactoryArtifactContentKind;
  readonly artifactKind: ArtifactKind;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly fileName?: string;
  readonly digest?: FactoryArtifactDigestDto;
  readonly safeUri?: string;
  readonly hasInlineText: boolean;
  readonly createdAt?: string;
  readonly provenance: FactoryArtifactContentProvenanceDto;
}

export interface FactoryArtifactBundleDto {
  readonly runId: string;
  readonly artifactId: string;
  readonly items: readonly FactoryArtifactContentDescriptorDto[];
}

export interface CreateFactoryArtifactContentDescriptorInput extends FactoryArtifactContentDescriptorDto {}

export interface CreateStoredTextArtifactContentDescriptorInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly fileName?: string;
  readonly digest?: FactoryArtifactDigestDto;
  readonly createdAt?: string;
}

export interface CreateFactoryBinaryArtifactContentDescriptorInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly fileName?: string;
  readonly digest?: FactoryArtifactDigestDto;
  readonly safeUri?: string;
  readonly createdAt?: string;
  readonly provenance: FactoryArtifactContentProvenanceDto;
}

export interface CreateFactoryExternalUriArtifactContentDescriptorInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly safeUri?: string;
  readonly createdAt?: string;
  readonly provenance: FactoryArtifactContentProvenanceDto;
}

export interface CreateUntrustedEventMetadataUriDescriptorInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly createdAt?: string;
  readonly note?: string;
}

export interface CreateFactoryBundleInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly items: readonly FactoryArtifactContentDescriptorDto[];
}

const FACTORY_ARTIFACT_CONTENT_KINDS: readonly FactoryArtifactContentKind[] = ['text', 'binary', 'external-uri', 'bundle'];
const FACTORY_ARTIFACT_CONTENT_PROVENANCE_SOURCES: readonly FactoryArtifactContentProvenanceSource[] = ['artifact-store', 'external-system', 'event-metadata'];

export function isFactoryArtifactContentKind(value: unknown): value is FactoryArtifactContentKind {
  return FACTORY_ARTIFACT_CONTENT_KINDS.includes(String(value) as FactoryArtifactContentKind);
}

export function isFactoryArtifactContentProvenanceSource(value: unknown): value is FactoryArtifactContentProvenanceSource {
  return FACTORY_ARTIFACT_CONTENT_PROVENANCE_SOURCES.includes(String(value) as FactoryArtifactContentProvenanceSource);
}

export function createFactoryArtifactContentDescriptor(input: CreateFactoryArtifactContentDescriptorInput): FactoryArtifactContentDescriptorDto {
  assertNonEmptyString(input.runId, 'runId');
  assertNonEmptyString(input.artifactId, 'artifactId');
  if (!isFactoryArtifactContentKind(input.kind)) {
    throw new Error(`Invalid factory artifact content kind '${String(input.kind)}'`);
  }
  if (!isFactoryArtifactContentProvenanceSource(input.provenance.source)) {
    throw new Error(`Invalid factory artifact content provenance source '${String(input.provenance.source)}'`);
  }
  if (input.provenance.source === 'event-metadata' && input.provenance.trusted) {
    throw new Error('Factory artifact event-metadata provenance cannot be trusted');
  }
  if (input.kind === 'text' && input.hasInlineText !== true) {
    throw new Error("Factory text artifact descriptors must set hasInlineText to true");
  }
  if (input.kind !== 'text' && input.hasInlineText) {
    throw new Error(`Factory artifact content kind '${input.kind}' cannot set hasInlineText to true`);
  }
  if (input.byteLength !== undefined && (!Number.isInteger(input.byteLength) || input.byteLength < 0)) {
    throw new Error(`Factory artifact byteLength must be a non-negative integer`);
  }
  if (input.fileName !== undefined) {
    assertNonEmptyString(input.fileName, 'fileName');
  }
  if (input.mediaType !== undefined) {
    assertNonEmptyString(input.mediaType, 'mediaType');
  }
  if (input.createdAt !== undefined) {
    assertNonEmptyString(input.createdAt, 'createdAt');
  }
  if (input.digest) {
    if (input.digest.algorithm !== 'sha256') {
      throw new Error(`Unsupported factory artifact digest algorithm '${String(input.digest.algorithm)}'`);
    }
    assertNonEmptyString(input.digest.value, 'digest.value');
  }
  const safeUri = normalizedSafeUri(input.safeUri, input.provenance);

  return {
    runId: input.runId,
    artifactId: input.artifactId,
    kind: input.kind,
    artifactKind: input.artifactKind,
    mediaType: input.mediaType,
    byteLength: input.byteLength,
    fileName: input.fileName,
    digest: input.digest,
    safeUri,
    hasInlineText: input.hasInlineText,
    createdAt: input.createdAt,
    provenance: {
      source: input.provenance.source,
      trusted: input.provenance.trusted,
      note: input.provenance.note,
    },
  };
}

export function createStoredTextArtifactContentDescriptor(input: CreateStoredTextArtifactContentDescriptorInput): FactoryArtifactContentDescriptorDto {
  return createFactoryArtifactContentDescriptor({
    runId: input.runId,
    artifactId: input.artifactId,
    kind: 'text',
    artifactKind: input.artifactKind,
    mediaType: input.mediaType ?? 'text/markdown',
    byteLength: input.byteLength,
    fileName: input.fileName,
    digest: input.digest,
    hasInlineText: true,
    createdAt: input.createdAt,
    provenance: {
      source: 'artifact-store',
      trusted: true,
      note: 'Stored artifact content resolved through artifact-store provenance.',
    },
  });
}

export function createFactoryBinaryArtifactContentDescriptor(input: CreateFactoryBinaryArtifactContentDescriptorInput): FactoryArtifactContentDescriptorDto {
  return createFactoryArtifactContentDescriptor({
    runId: input.runId,
    artifactId: input.artifactId,
    kind: 'binary',
    artifactKind: input.artifactKind,
    mediaType: input.mediaType,
    byteLength: input.byteLength,
    fileName: input.fileName,
    digest: input.digest,
    safeUri: input.safeUri,
    hasInlineText: false,
    createdAt: input.createdAt,
    provenance: input.provenance,
  });
}

export function createFactoryExternalUriArtifactContentDescriptor(input: CreateFactoryExternalUriArtifactContentDescriptorInput): FactoryArtifactContentDescriptorDto {
  return createFactoryArtifactContentDescriptor({
    runId: input.runId,
    artifactId: input.artifactId,
    kind: 'external-uri',
    artifactKind: input.artifactKind,
    safeUri: input.safeUri,
    hasInlineText: false,
    createdAt: input.createdAt,
    provenance: input.provenance,
  });
}

export function createUntrustedEventMetadataUriDescriptor(input: CreateUntrustedEventMetadataUriDescriptorInput): FactoryArtifactContentDescriptorDto {
  return createFactoryExternalUriArtifactContentDescriptor({
    runId: input.runId,
    artifactId: input.artifactId,
    artifactKind: input.artifactKind,
    createdAt: input.createdAt,
    provenance: {
      source: 'event-metadata',
      trusted: false,
      note: input.note ?? 'Raw event URI/path metadata is not trusted until attested by artifact-store/runtime provenance.',
    },
  });
}

export function createFactoryBundleArtifactContentDescriptor(input: {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly createdAt?: string;
  readonly provenance: FactoryArtifactContentProvenanceDto;
}): FactoryArtifactContentDescriptorDto {
  return createFactoryArtifactContentDescriptor({
    runId: input.runId,
    artifactId: input.artifactId,
    kind: 'bundle',
    artifactKind: input.artifactKind,
    hasInlineText: false,
    createdAt: input.createdAt,
    provenance: input.provenance,
  });
}

export function createFactoryArtifactBundle(input: CreateFactoryBundleInput): FactoryArtifactBundleDto {
  assertNonEmptyString(input.runId, 'runId');
  assertNonEmptyString(input.artifactId, 'artifactId');
  return {
    runId: input.runId,
    artifactId: input.artifactId,
    items: input.items.map(item => createFactoryArtifactContentDescriptor(item)),
  };
}

function normalizedSafeUri(
  safeUri: string | undefined,
  provenance: FactoryArtifactContentProvenanceDto,
): string | undefined {
  if (safeUri === undefined) return undefined;
  assertNonEmptyString(safeUri, 'safeUri');
  if (!provenance.trusted) {
    throw new Error('Factory artifact safeUri requires trusted provenance');
  }
  if (!isAllowedFactoryArtifactSafeUri(safeUri, provenance.source)) {
    throw new Error(`Factory artifact safeUri '${safeUri}' is not allowed for provenance source '${provenance.source}'`);
  }
  return new URL(safeUri).toString();
}

export function isAllowedFactoryArtifactSafeUri(uri: string, source: FactoryArtifactContentProvenanceSource): boolean {
  if (!isFactoryArtifactContentProvenanceSource(source)) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'file:') return source === 'artifact-store';
  return false;
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Factory artifact ${fieldName} must be a non-empty string`);
  }
}

export interface FactoryArtifactContentSummaryDto {
  readonly descriptors: readonly FactoryArtifactContentDescriptorDto[];
  readonly primaryDescriptor: FactoryArtifactContentDescriptorDto;
  readonly primaryKind: FactoryArtifactContentKind;
  readonly safetyLabel: FactoryArtifactSafetyLabel;
  readonly primaryAction: FactoryArtifactPrimaryAction;
}

export interface FactoryArtifactTrustedBinaryInput {
  readonly mediaType?: string;
  readonly fileName?: string;
  readonly byteLength?: number;
  readonly digest?: FactoryArtifactDigestDto;
  readonly safeUri?: string;
}

export interface FactoryArtifactTrustedExternalInput {
  readonly safeUri: string;
  readonly note?: string;
}

export interface SummarizeFactoryArtifactContentInput {
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly createdAt?: string;
  // Trusted stored-text input. Set only when the artifact was attested by the
  // artifact-store path normalization (i.e., the on-disk artifact exists).
  readonly trustedStorePath?: string;
  readonly trustedStoreMediaType?: string;
  readonly trustedStoreByteLength?: number;
  readonly trustedStoreDigest?: FactoryArtifactDigestDto;
  // Trusted binary input. Set when the runtime/store has attested binary content.
  readonly trustedBinary?: FactoryArtifactTrustedBinaryInput;
  // Trusted external URI input. Set when a runtime-attested external system
  // (e.g., CI URL) is the canonical reference.
  readonly trustedExternalUri?: FactoryArtifactTrustedExternalInput;
  // Optional pre-computed bundle children (caller is responsible for trust).
  readonly bundleItems?: readonly FactoryArtifactContentDescriptorDto[];
  // Raw event-provided uri/path. Always treated as untrusted metadata.
  readonly eventUri?: string;
  readonly eventPath?: string;
}

export function summarizeFactoryArtifactContent(
  input: SummarizeFactoryArtifactContentInput,
): FactoryArtifactContentSummaryDto {
  const descriptors: FactoryArtifactContentDescriptorDto[] = [];

  if (input.bundleItems && input.bundleItems.length > 0) {
    descriptors.push(createFactoryBundleArtifactContentDescriptor({
      runId: input.runId,
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      createdAt: input.createdAt,
      provenance: {
        source: 'artifact-store',
        trusted: true,
        note: 'Bundle descriptor produced from attested artifact-store children.',
      },
    }));
    for (const item of input.bundleItems) descriptors.push(item);
  } else if (input.trustedBinary) {
    descriptors.push(createFactoryBinaryArtifactContentDescriptor({
      runId: input.runId,
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      mediaType: input.trustedBinary.mediaType,
      fileName: input.trustedBinary.fileName,
      byteLength: input.trustedBinary.byteLength,
      digest: input.trustedBinary.digest,
      safeUri: input.trustedBinary.safeUri,
      createdAt: input.createdAt,
      provenance: {
        source: 'artifact-store',
        trusted: true,
        note: 'Binary content attested through artifact-store provenance.',
      },
    }));
  } else if (input.trustedStorePath) {
    descriptors.push(createStoredTextArtifactContentDescriptor({
      runId: input.runId,
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      mediaType: input.trustedStoreMediaType ?? 'text/markdown',
      byteLength: input.trustedStoreByteLength,
      digest: input.trustedStoreDigest,
      createdAt: input.createdAt,
    }));
  } else if (input.trustedExternalUri) {
    descriptors.push(createFactoryExternalUriArtifactContentDescriptor({
      runId: input.runId,
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      safeUri: input.trustedExternalUri.safeUri,
      createdAt: input.createdAt,
      provenance: {
        source: 'external-system',
        trusted: true,
        note: input.trustedExternalUri.note ?? 'External URI attested by trusted runtime.',
      },
    }));
  }

  if (input.eventUri || input.eventPath) {
    descriptors.push(createUntrustedEventMetadataUriDescriptor({
      runId: input.runId,
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      createdAt: input.createdAt,
      note: input.eventUri
        ? 'Event metadata uri is untrusted until attested by artifact-store or trusted external system.'
        : 'Event metadata path is untrusted until attested by artifact-store.',
    }));
  }

  if (descriptors.length === 0) {
    descriptors.push(createUntrustedEventMetadataUriDescriptor({
      runId: input.runId,
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      createdAt: input.createdAt,
      note: 'Artifact has no trusted content; only summary metadata is available.',
    }));
  }

  const primary = descriptors[0];
  return {
    descriptors,
    primaryDescriptor: primary,
    primaryKind: primary.kind,
    safetyLabel: safetyLabelFromDescriptor(primary),
    primaryAction: primaryActionFromDescriptor(primary),
  } satisfies FactoryArtifactContentSummaryDto;
}

export function safetyLabelFromDescriptor(
  descriptor: FactoryArtifactContentDescriptorDto,
): FactoryArtifactSafetyLabel {
  if (!descriptor.provenance.trusted) return 'metadata-only';
  if (descriptor.provenance.source === 'external-system') return 'trusted-external';
  return 'trusted-local';
}

export function primaryActionFromDescriptor(
  descriptor: FactoryArtifactContentDescriptorDto,
): FactoryArtifactPrimaryAction {
  if (!descriptor.provenance.trusted) return 'inspect-metadata';
  switch (descriptor.kind) {
    case 'text':
      return 'open-text';
    case 'binary':
      return descriptor.mediaType?.startsWith('image/') ? 'open-preview' : 'download';
    case 'external-uri':
      return 'open-external';
    case 'bundle':
      return 'open-preview';
  }
}
