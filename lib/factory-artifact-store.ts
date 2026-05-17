import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef } from './factory-core';
import { assertSafeRunId } from './factory-event-store';

export interface StoredFactoryArtifact {
  readonly ref: ArtifactRef;
  readonly content: string;
  readonly createdAt: string;
}

export interface FileFactoryArtifactStoreOptions {
  readonly rootDir: string;
  readonly now?: () => Date;
}

export class FileFactoryArtifactStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: FileFactoryArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? (() => new Date());
  }

  writeText(runId: string, artifact: ArtifactRef, content: string): ArtifactRef {
    assertSafeRunId(runId);
    assertSafeArtifactId(artifact.id);
    const createdAt = this.now().toISOString();
    const artifactDir = this.artifactsDir(runId);
    mkdirSync(artifactDir, { recursive: true });

    const contentPath = this.artifactContentPath(runId, artifact.id);
    const metadataPath = this.artifactMetadataPath(runId, artifact.id);
    const ref: ArtifactRef = {
      ...artifact,
      path: contentPath,
      metadata: {
        ...(artifact.metadata || {}),
        createdAt,
      },
    };

    writeFileSync(contentPath, content, 'utf-8');
    writeFileSync(metadataPath, `${JSON.stringify({ ref, createdAt }, null, 2)}\n`, 'utf-8');
    return ref;
  }

  readText(runId: string, artifactId: string): StoredFactoryArtifact {
    assertSafeRunId(runId);
    assertSafeArtifactId(artifactId);
    const metadataPath = this.artifactMetadataPath(runId, artifactId);
    if (!existsSync(metadataPath)) {
      throw new Error(`Factory artifact '${artifactId}' not found for run '${runId}'`);
    }

    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as { ref: ArtifactRef; createdAt: string };
    if (!metadata.ref || metadata.ref.id !== artifactId) {
      throw new Error(`Factory artifact metadata for '${artifactId}' is invalid`);
    }

    return {
      ref: {
        ...metadata.ref,
        path: this.artifactContentPath(runId, artifactId),
      },
      createdAt: metadata.createdAt,
      content: readFileSync(this.artifactContentPath(runId, artifactId), 'utf-8'),
    };
  }

  listArtifactIds(runId: string): string[] {
    assertSafeRunId(runId);
    const artifactDir = this.artifactsDir(runId);
    if (!existsSync(artifactDir)) return [];
    return readdirSync(artifactDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -'.json'.length))
      .filter(isSafeArtifactId)
      .sort();
  }

  artifactsDir(runId: string): string {
    assertSafeRunId(runId);
    return join(this.rootDir, runId, 'artifacts');
  }

  artifactContentPath(runId: string, artifactId: string): string {
    assertSafeRunId(runId);
    assertSafeArtifactId(artifactId);
    return join(this.artifactsDir(runId), `${artifactId}.md`);
  }

  artifactMetadataPath(runId: string, artifactId: string): string {
    assertSafeRunId(runId);
    assertSafeArtifactId(artifactId);
    return join(this.artifactsDir(runId), `${artifactId}.json`);
  }
}

export function isSafeArtifactId(artifactId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactId) && !artifactId.includes('..');
}

export function assertSafeArtifactId(artifactId: string): void {
  if (!isSafeArtifactId(artifactId)) {
    throw new Error(`Unsafe factory artifact id '${artifactId}'`);
  }
}
