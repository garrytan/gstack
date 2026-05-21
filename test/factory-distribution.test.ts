import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DISTRIBUTION_MANIFEST_FILENAME,
  DISTRIBUTION_MANIFEST_VERSION,
  assertSafeBundlePath,
  buildDistributionManifest,
  isSafeRelativeBundlePath,
  planDistributionBundle,
  stageDistributionBundle,
  validateDistributionManifest,
  type BuildDistributionManifestInput,
} from '../lib/factory-distribution';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function plantPiSource(sourceRoot: string) {
  writeFile(sourceRoot, '.pi/extensions/pi-gstack/index.ts', '// extension entry\n');
  writeFile(sourceRoot, '.pi/skills/gstack-review/SKILL.md', '# gstack-review\n');
  writeFile(sourceRoot, '.pi/skills/gstack-ship/SKILL.md', '# gstack-ship\n');
  writeFile(sourceRoot, 'ETHOS.md', 'ethos body\n');
  writeFile(sourceRoot, 'browse/dist/browse', 'fake binary');
  writeFile(sourceRoot, 'review/checklist.md', 'checklist body\n');
}

function piManifestInput(overrides: Partial<BuildDistributionManifestInput> = {}): BuildDistributionManifestInput {
  return {
    bundleVersion: '1.27.1.0',
    commit: 'abc123def',
    builtAt: '2026-05-21T00:00:00.000Z',
    compatibility: {
      host: 'pi',
      minHostVersion: '1.0.0',
      requiredCapabilities: ['safe-command-guard'],
    },
    extensionFiles: [
      { sourcePath: '.pi/extensions/pi-gstack/index.ts', bundlePath: '.pi/extensions/pi-gstack/index.ts', required: true },
    ],
    generatedSkillFiles: [
      { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: '.pi/skills/gstack-review/SKILL.md', required: true },
      { sourcePath: '.pi/skills/gstack-ship/SKILL.md', bundlePath: '.pi/skills/gstack-ship/SKILL.md', required: true },
    ],
    runtimeSidecars: [
      { sourcePath: 'ETHOS.md', bundlePath: 'ETHOS.md', required: true },
      { sourcePath: 'browse/dist/browse', bundlePath: 'browse/dist/browse', required: true },
      { sourcePath: 'review/checklist.md', bundlePath: 'review/checklist.md', required: true },
    ],
    ...overrides,
  };
}

describe('isSafeRelativeBundlePath / assertSafeBundlePath', () => {
  test('accepts safe relative paths', () => {
    expect(isSafeRelativeBundlePath('.pi/skills/gstack-review/SKILL.md')).toBe(true);
    expect(isSafeRelativeBundlePath('ETHOS.md')).toBe(true);
    expect(isSafeRelativeBundlePath('browse/dist/browse')).toBe(true);
  });

  test('rejects absolute, parent-traversal, and tilde paths', () => {
    expect(isSafeRelativeBundlePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativeBundlePath('../escape.md')).toBe(false);
    expect(isSafeRelativeBundlePath('a/../b')).toBe(false);
    expect(isSafeRelativeBundlePath('~/home.md')).toBe(false);
    expect(isSafeRelativeBundlePath('')).toBe(false);
    expect(isSafeRelativeBundlePath('.')).toBe(false);
    expect(() => assertSafeBundlePath('../escape')).toThrow('Unsafe distribution bundle path');
  });
});

describe('buildDistributionManifest', () => {
  test('produces a versioned manifest with categorized entries and copied capabilities', () => {
    const manifest = buildDistributionManifest(piManifestInput());

    expect(manifest.manifestVersion).toBe(DISTRIBUTION_MANIFEST_VERSION);
    expect(manifest.bundleVersion).toBe('1.27.1.0');
    expect(manifest.commit).toBe('abc123def');
    expect(manifest.builtAt).toBe('2026-05-21T00:00:00.000Z');
    expect(manifest.compatibility).toEqual({
      host: 'pi',
      minHostVersion: '1.0.0',
      maxHostVersion: undefined,
      requiredCapabilities: ['safe-command-guard'],
    });

    const categories = manifest.files.map(f => f.category);
    expect(categories).toEqual([
      'extension',
      'generated-skill',
      'generated-skill',
      'runtime-sidecar',
      'runtime-sidecar',
      'runtime-sidecar',
    ]);

    // Manifest data is a plain copy: mutating the input array shouldn't affect the manifest.
    const requiredCaps = (manifest.compatibility.requiredCapabilities as string[]) ?? [];
    expect(requiredCaps).toEqual(['safe-command-guard']);
  });

  test('rejects unsafe bundle paths and reserved manifest filename', () => {
    expect(() =>
      buildDistributionManifest(
        piManifestInput({
          runtimeSidecars: [
            { sourcePath: '../escape.md', bundlePath: 'ETHOS.md', required: true },
          ],
        }),
      ),
    ).toThrow('Unsafe distribution bundle path');

    expect(() =>
      buildDistributionManifest(
        piManifestInput({
          runtimeSidecars: [
            { sourcePath: 'ETHOS.md', bundlePath: DISTRIBUTION_MANIFEST_FILENAME, required: true },
          ],
        }),
      ),
    ).toThrow('reserved for the manifest');
  });

  test('rejects duplicate bundle paths across categories', () => {
    expect(() =>
      buildDistributionManifest(
        piManifestInput({
          extensionFiles: [
            { sourcePath: '.pi/extensions/pi-gstack/index.ts', bundlePath: 'collision.md', required: true },
          ],
          runtimeSidecars: [
            { sourcePath: 'ETHOS.md', bundlePath: 'collision.md', required: true },
          ],
        }),
      ),
    ).toThrow('Duplicate distribution bundle path');
  });

  test('rejects empty bundleVersion and non-pi host', () => {
    expect(() => buildDistributionManifest(piManifestInput({ bundleVersion: '' }))).toThrow(
      'non-empty bundleVersion',
    );
    expect(() =>
      buildDistributionManifest(piManifestInput({
        compatibility: { host: 'claude' as unknown as 'pi' },
      })),
    ).toThrow("only supports host 'pi'");
  });
});

describe('validateDistributionManifest', () => {
  test('fail closed: missing required file returns ok=false with the missing entry', () => {
    const sourceRoot = tempDir('factory-dist-validate-');
    try {
      plantPiSource(sourceRoot);
      rmSync(path.join(sourceRoot, '.pi/skills/gstack-ship/SKILL.md'));

      const manifest = buildDistributionManifest(piManifestInput());
      const result = validateDistributionManifest(manifest, sourceRoot);

      expect(result.ok).toBe(false);
      expect(result.missingRequired).toEqual([
        {
          category: 'generated-skill',
          sourcePath: '.pi/skills/gstack-ship/SKILL.md',
          bundlePath: '.pi/skills/gstack-ship/SKILL.md',
        },
      ]);
      expect(result.missingOptional).toEqual([]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  test('missing optional file reports a warning but ok stays true', () => {
    const sourceRoot = tempDir('factory-dist-validate-opt-');
    try {
      plantPiSource(sourceRoot);

      const manifest = buildDistributionManifest(
        piManifestInput({
          runtimeSidecars: [
            { sourcePath: 'ETHOS.md', bundlePath: 'ETHOS.md', required: true },
            { sourcePath: 'browse/dist/browse', bundlePath: 'browse/dist/browse', required: true },
            { sourcePath: 'review/checklist.md', bundlePath: 'review/checklist.md', required: true },
            { sourcePath: 'design/dist/design', bundlePath: 'design/dist/design', required: false },
          ],
        }),
      );

      const result = validateDistributionManifest(manifest, sourceRoot);
      expect(result.ok).toBe(true);
      expect(result.missingRequired).toEqual([]);
      expect(result.missingOptional).toEqual([
        { category: 'runtime-sidecar', sourcePath: 'design/dist/design', bundlePath: 'design/dist/design' },
      ]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  test('passes when every required source exists', () => {
    const sourceRoot = tempDir('factory-dist-validate-ok-');
    try {
      plantPiSource(sourceRoot);
      const manifest = buildDistributionManifest(piManifestInput());
      const result = validateDistributionManifest(manifest, sourceRoot);
      expect(result.ok).toBe(true);
      expect(result.missingRequired).toEqual([]);
      expect(result.missingOptional).toEqual([]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});

describe('planDistributionBundle (dry-run)', () => {
  test('reports planned files, sizes, and writes nothing to disk', () => {
    const sourceRoot = tempDir('factory-dist-plan-src-');
    const outputDir = tempDir('factory-dist-plan-out-');
    try {
      plantPiSource(sourceRoot);
      // outputDir is an empty tempdir; verify it stays empty after planning.
      rmSync(outputDir, { recursive: true, force: true });

      const manifest = buildDistributionManifest(piManifestInput());
      const plan = planDistributionBundle(manifest, { sourceRoot, outputDir });

      expect(plan.totalFiles).toBe(6);
      expect(plan.totalBytes).toBeGreaterThan(0);
      expect(plan.entries.every(entry => !entry.missing)).toBe(true);
      expect(plan.entries.every(entry => entry.absoluteBundlePath.startsWith(path.resolve(outputDir)))).toBe(true);
      expect(plan.manifestPath).toBe(path.join(path.resolve(outputDir), DISTRIBUTION_MANIFEST_FILENAME));
      expect(plan.conflicts).toEqual([]);
      expect(plan.validation.ok).toBe(true);

      // Dry-run must not write anything: outputDir should still not exist.
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('detects bundle conflicts when target paths already exist', () => {
    const sourceRoot = tempDir('factory-dist-plan-conflict-src-');
    const outputDir = tempDir('factory-dist-plan-conflict-out-');
    try {
      plantPiSource(sourceRoot);
      // Plant a colliding user-managed file in the output dir.
      writeFile(outputDir, 'ETHOS.md', 'user-managed ethos\n');

      const manifest = buildDistributionManifest(piManifestInput());
      const plan = planDistributionBundle(manifest, { sourceRoot, outputDir });

      expect(plan.conflicts.map(c => c.bundlePath)).toContain('ETHOS.md');
      expect(plan.conflicts.every(c => c.reason === 'file-exists')).toBe(true);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('records missing required files via plan.validation', () => {
    const sourceRoot = tempDir('factory-dist-plan-missing-src-');
    const outputDir = tempDir('factory-dist-plan-missing-out-');
    try {
      plantPiSource(sourceRoot);
      rmSync(path.join(sourceRoot, 'ETHOS.md'));

      const manifest = buildDistributionManifest(piManifestInput());
      const plan = planDistributionBundle(manifest, { sourceRoot, outputDir });

      const missingEntry = plan.entries.find(e => e.sourcePath === 'ETHOS.md');
      expect(missingEntry?.missing).toBe(true);
      expect(missingEntry?.sizeBytes).toBe(0);
      expect(plan.validation.ok).toBe(false);
      expect(plan.validation.missingRequired.map(i => i.sourcePath)).toEqual(['ETHOS.md']);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('rejects source entries that are not regular files', () => {
    const sourceRoot = tempDir('factory-dist-plan-dir-src-');
    const outputDir = tempDir('factory-dist-plan-dir-out-');
    try {
      plantPiSource(sourceRoot);
      // Replace ETHOS.md with a directory of the same name to simulate a misclassified entry.
      rmSync(path.join(sourceRoot, 'ETHOS.md'));
      mkdirSync(path.join(sourceRoot, 'ETHOS.md'));

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => planDistributionBundle(manifest, { sourceRoot, outputDir })).toThrow(
        'not a regular file',
      );
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe('stageDistributionBundle', () => {
  test('stages all files to caller output dir and writes manifest JSON', () => {
    const sourceRoot = tempDir('factory-dist-stage-src-');
    const outputDir = tempDir('factory-dist-stage-out-');
    try {
      plantPiSource(sourceRoot);
      // Use a fresh, nonexistent subdir so we can assert "did not exist before" semantics.
      rmSync(outputDir, { recursive: true, force: true });

      const manifest = buildDistributionManifest(piManifestInput());
      const result = stageDistributionBundle(manifest, { sourceRoot, outputDir });

      expect(result.filesWritten).toBe(6);
      expect(result.bytesWritten).toBeGreaterThan(0);
      expect(result.writtenBundlePaths).toContain(DISTRIBUTION_MANIFEST_FILENAME);

      // Each source file should now exist at its bundle path.
      const stagedExtension = readFileSync(path.join(outputDir, '.pi/extensions/pi-gstack/index.ts'), 'utf-8');
      expect(stagedExtension).toBe('// extension entry\n');
      const stagedEthos = readFileSync(path.join(outputDir, 'ETHOS.md'), 'utf-8');
      expect(stagedEthos).toBe('ethos body\n');

      // Manifest is staged at the bundle root and round-trips through JSON.
      const staged = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
      expect(staged.bundleVersion).toBe('1.27.1.0');
      expect(staged.manifestVersion).toBe(DISTRIBUTION_MANIFEST_VERSION);
      expect(staged.compatibility.host).toBe('pi');
      expect(Array.isArray(staged.files)).toBe(true);
      expect(staged.files.length).toBe(6);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite a conflicting user-managed file by default', () => {
    const sourceRoot = tempDir('factory-dist-stage-conflict-src-');
    const outputDir = tempDir('factory-dist-stage-conflict-out-');
    try {
      plantPiSource(sourceRoot);
      writeFile(outputDir, 'ETHOS.md', 'user-managed ethos\n');

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => stageDistributionBundle(manifest, { sourceRoot, outputDir })).toThrow(
        /Refusing to stage distribution bundle/,
      );

      // The user's file must be untouched after a refused stage.
      const preserved = readFileSync(path.join(outputDir, 'ETHOS.md'), 'utf-8');
      expect(preserved).toBe('user-managed ethos\n');
      // And the manifest file must not have been created.
      expect(existsSync(path.join(outputDir, DISTRIBUTION_MANIFEST_FILENAME))).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('refuses to stage into an output dir containing unrelated content', () => {
    const sourceRoot = tempDir('factory-dist-stage-extras-src-');
    const outputDir = tempDir('factory-dist-stage-extras-out-');
    try {
      plantPiSource(sourceRoot);
      // Unrelated user file at root of outputDir.
      writeFile(outputDir, 'user-notes.txt', 'mine\n');

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => stageDistributionBundle(manifest, { sourceRoot, outputDir })).toThrow(
        /contains unrelated content/,
      );

      // With explicit opt-in, the extra file is preserved and the bundle is staged.
      const result = stageDistributionBundle(manifest, {
        sourceRoot,
        outputDir,
        allowExtraFilesInOutputDir: true,
      });
      expect(result.filesWritten).toBe(6);
      expect(readFileSync(path.join(outputDir, 'user-notes.txt'), 'utf-8')).toBe('mine\n');
      expect(existsSync(result.manifestPath)).toBe(true);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('fail-closed: refuses to stage when a required source file is missing', () => {
    const sourceRoot = tempDir('factory-dist-stage-missing-src-');
    const outputDir = tempDir('factory-dist-stage-missing-out-');
    try {
      plantPiSource(sourceRoot);
      rmSync(path.join(sourceRoot, 'browse/dist/browse'));
      rmSync(outputDir, { recursive: true, force: true });

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => stageDistributionBundle(manifest, { sourceRoot, outputDir })).toThrow(
        /Distribution validation failed/,
      );

      // The output dir must not have been created/populated by a failed validation.
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
