import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileFactoryArtifactStore, assertSafeArtifactId } from '../lib/factory-artifact-store';

function tempStore() {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'factory-artifacts-'));
  return { rootDir, store: new FileFactoryArtifactStore({ rootDir, now: () => new Date('2026-01-01T00:00:00.000Z') }) };
}

describe('FileFactoryArtifactStore', () => {
  test('writes text artifacts with metadata and stable references', () => {
    const { rootDir, store } = tempStore();
    try {
      const ref = store.writeText('run-1', {
        id: 'review-summary',
        kind: 'review',
        phaseId: 'review-summary',
        summary: 'Review summary',
      }, '# Review\n\nLooks good.\n');

      expect(ref.path).toBe(path.join(rootDir, 'run-1', 'artifacts', 'review-summary.md'));
      expect(ref.metadata?.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(existsSync(path.join(rootDir, 'run-1', 'artifacts', 'review-summary.json'))).toBe(true);
      expect(store.listArtifactIds('run-1')).toEqual(['review-summary']);
      expect(store.readText('run-1', 'review-summary')).toEqual({
        ref,
        createdAt: '2026-01-01T00:00:00.000Z',
        content: '# Review\n\nLooks good.\n',
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('normalizes tampered metadata paths on read', () => {
    const { rootDir, store } = tempStore();
    try {
      store.writeText('run-1', { id: 'review-summary', kind: 'review', summary: 'Review summary' }, 'safe content');
      writeFileSync(store.artifactMetadataPath('run-1', 'review-summary'), `${JSON.stringify({
        ref: { id: 'review-summary', kind: 'review', summary: 'Review summary', path: '/tmp/evil' },
        createdAt: '2026-01-01T00:00:00.000Z',
      })}\n`);

      expect(store.readText('run-1', 'review-summary').ref.path).toBe(store.artifactContentPath('run-1', 'review-summary'));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('rejects unsafe run and artifact ids', () => {
    const { rootDir, store } = tempStore();
    try {
      expect(() => assertSafeArtifactId('../escape')).toThrow('Unsafe factory artifact id');
      expect(() => store.writeText('../run', { id: 'ok', kind: 'review', summary: 'x' }, 'x')).toThrow('Unsafe factory run id');
      expect(() => store.writeText('run-1', { id: '../escape', kind: 'review', summary: 'x' }, 'x')).toThrow('Unsafe factory artifact id');
      expect(() => store.readText('run-1', 'missing')).toThrow("Factory artifact 'missing' not found");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
