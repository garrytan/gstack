/**
 * The CI image tag is a content hash computed independently in three
 * workflows — evals.yml, evals-periodic.yml, ci-image.yml — and they were
 * synced by comment only (filed in TODOS.md as the "three-way image-tag
 * drift" gap). If one file's hashFiles() input list drifts, that workflow
 * computes a DIFFERENT tag for the same content: the eval lanes stop finding
 * the prebuilt image and silently rebuild it on every run (minutes per run,
 * no red check), or ci-image prebuilds a tag nobody looks up.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const FILES = ['evals.yml', 'evals-periodic.yml', 'ci-image.yml'];

function hashFilesCalls(name: string): string[] {
  const source = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', name), 'utf-8');
  // Only tag-computation sites: hashFiles() inside a `tag=` output line.
  return [...source.matchAll(/tag=[^\n]*?(hashFiles\([^)]*\))/g)].map((m) => m[1]);
}

describe('ci image tag binding', () => {
  test('all three workflows compute the tag from the identical hashFiles() input list', () => {
    const perFile = FILES.map((f) => ({ file: f, calls: hashFilesCalls(f) }));
    for (const { file, calls } of perFile) {
      // Each workflow computes the tag exactly once; zero means the scan
      // regex rotted (must fail loudly, not vacuously pass).
      expect(calls, `${file}: expected exactly one tag hashFiles() site`).toHaveLength(1);
    }
    const expressions = [...new Set(perFile.map((p) => p.calls[0]))];
    const detail = perFile.map((p) => `${p.file} → ${p.calls[0]}`).join('\n');
    expect(expressions, `image-tag hashFiles() drift:\n${detail}`).toHaveLength(1);
  });
});
