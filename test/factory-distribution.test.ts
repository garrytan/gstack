import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  planDistributionInstallUpdateDryRun,
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

    expect(() =>
      buildDistributionManifest(
        piManifestInput({
          runtimeSidecars: [
            { sourcePath: 'ETHOS.md', bundlePath: 'ETHOS.md', installPath: DISTRIBUTION_MANIFEST_FILENAME, required: true },
          ],
        }),
      ),
    ).toThrow('reserved for the manifest');
  });

  test('supports explicit install paths distinct from staged bundle paths', () => {
    const manifest = buildDistributionManifest(
      piManifestInput({
        extensionFiles: [
          {
            sourcePath: '.pi/extensions/pi-gstack/index.ts',
            bundlePath: '.pi/extensions/pi-gstack/index.ts',
            installPath: 'extensions/gstack/index.ts',
            required: true,
          },
        ],
      }),
    );

    expect(manifest.files[0]).toMatchObject({
      bundlePath: '.pi/extensions/pi-gstack/index.ts',
      installPath: 'extensions/gstack/index.ts',
    });
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

    expect(() =>
      buildDistributionManifest(
        piManifestInput({
          extensionFiles: [
            {
              sourcePath: '.pi/extensions/pi-gstack/index.ts',
              bundlePath: '.pi/extensions/pi-gstack/index.ts',
              installPath: 'extensions/gstack/index.ts',
              required: true,
            },
          ],
          runtimeSidecars: [
            {
              sourcePath: 'ETHOS.md',
              bundlePath: 'ETHOS.md',
              installPath: 'extensions/gstack/index.ts',
              required: true,
            },
          ],
        }),
      ),
    ).toThrow('Duplicate distribution install path');
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
      // Plant a colliding user-managed file and stale nested content in the output dir.
      writeFile(outputDir, 'ETHOS.md', 'user-managed ethos\n');
      writeFile(outputDir, 'review/stale.md', 'stale nested file\n');

      const manifest = buildDistributionManifest(piManifestInput());
      const plan = planDistributionBundle(manifest, { sourceRoot, outputDir });

      expect(plan.conflicts).toContainEqual({
        bundlePath: 'ETHOS.md',
        absoluteBundlePath: path.join(outputDir, 'ETHOS.md'),
        reason: 'file-exists',
      });
      expect(plan.conflicts).toContainEqual({
        bundlePath: path.join('review', 'stale.md'),
        absoluteBundlePath: path.join(outputDir, 'review', 'stale.md'),
        reason: 'unrelated-output-content',
      });
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('detects output parent collisions before staging', () => {
    const sourceRoot = tempDir('factory-dist-plan-parent-src-');
    const outputDir = tempDir('factory-dist-plan-parent-out-');
    try {
      plantPiSource(sourceRoot);
      writeFileSync(path.join(outputDir, '.pi'), 'not a directory\n');

      const manifest = buildDistributionManifest(piManifestInput());
      const plan = planDistributionBundle(manifest, { sourceRoot, outputDir });

      expect(plan.conflicts).toContainEqual({
        bundlePath: '.pi/extensions/pi-gstack/index.ts',
        absoluteBundlePath: path.join(outputDir, '.pi'),
        reason: 'parent-not-directory',
      });
      expect(() => stageDistributionBundle(manifest, { sourceRoot, outputDir })).toThrow(
        /Refusing to stage distribution bundle/,
      );
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

  test('reports a non-directory output root before staging', () => {
    const sourceRoot = tempDir('factory-dist-plan-output-file-src-');
    const outputDir = tempDir('factory-dist-plan-output-file-out-');
    try {
      plantPiSource(sourceRoot);
      rmSync(outputDir, { recursive: true, force: true });
      writeFileSync(outputDir, 'not a directory\n');

      const manifest = buildDistributionManifest(piManifestInput());
      const plan = planDistributionBundle(manifest, { sourceRoot, outputDir });
      expect(plan.conflicts).toContainEqual({
        bundlePath: '.',
        absoluteBundlePath: path.resolve(outputDir),
        reason: 'output-root-not-directory',
      });
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

  test('rejects symlinked source roots and output ancestors', () => {
    const realSourceRoot = tempDir('factory-dist-plan-real-source-');
    const sourceLinkParent = tempDir('factory-dist-plan-source-link-parent-');
    const outputRealParent = tempDir('factory-dist-plan-output-real-parent-');
    const outputLinkParent = tempDir('factory-dist-plan-output-link-parent-');
    try {
      plantPiSource(realSourceRoot);
      const sourceLink = path.join(sourceLinkParent, 'source-link');
      const outputLink = path.join(outputLinkParent, 'output-link');
      symlinkSync(realSourceRoot, sourceLink);
      symlinkSync(outputRealParent, outputLink);

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => planDistributionBundle(manifest, { sourceRoot: sourceLink, outputDir: path.join(outputRealParent, 'out') })).toThrow(
        'contains symlink segment',
      );
      expect(() => planDistributionBundle(manifest, { sourceRoot: realSourceRoot, outputDir: path.join(outputLink, 'out') })).toThrow(
        'contains symlink segment',
      );
    } finally {
      rmSync(realSourceRoot, { recursive: true, force: true });
      rmSync(sourceLinkParent, { recursive: true, force: true });
      rmSync(outputRealParent, { recursive: true, force: true });
      rmSync(outputLinkParent, { recursive: true, force: true });
    }
  });

  test('rejects symlinked source entries instead of packaging link targets', () => {
    const sourceRoot = tempDir('factory-dist-plan-symlink-src-');
    const outputDir = tempDir('factory-dist-plan-symlink-out-');
    const outside = tempDir('factory-dist-plan-symlink-outside-');
    try {
      plantPiSource(sourceRoot);
      rmSync(path.join(sourceRoot, 'ETHOS.md'));
      writeFile(outside, 'ETHOS.md', 'outside ethos\n');
      symlinkSync(path.join(outside, 'ETHOS.md'), path.join(sourceRoot, 'ETHOS.md'));

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => planDistributionBundle(manifest, { sourceRoot, outputDir })).toThrow(
        'not a regular file',
      );
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('planDistributionInstallUpdateDryRun', () => {
  test('plans first install without mutating the managed install root', () => {
    const bundleRoot = tempDir('factory-dist-install-bundle-');
    const installRoot = tempDir('factory-dist-install-root-');
    try {
      plantPiSource(bundleRoot);
      rmSync(installRoot, { recursive: true, force: true });

      const manifest = buildDistributionManifest(piManifestInput({
        extensionFiles: [
          {
            sourcePath: '.pi/extensions/pi-gstack/index.ts',
            bundlePath: '.pi/extensions/pi-gstack/index.ts',
            installPath: 'extensions/gstack/index.ts',
            required: true,
          },
        ],
      }));
      const plan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot });

      expect(plan.mode).toBe('install');
      expect(plan.ok).toBe(true);
      expect(plan.conflicts).toEqual([]);
      expect(plan.entries).toHaveLength(6);
      expect(plan.entries.every(entry => entry.action === 'create')).toBe(true);
      expect(plan.entries[0].installPath).toBe('extensions/gstack/index.ts');
      expect(plan.summary.createCount).toBe(6);
      expect(plan.summary.bytesToWrite).toBeGreaterThan(0);
      expect(existsSync(installRoot)).toBe(false);
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test('rejects symlinked bundle roots and install ancestors', () => {
    const realBundleRoot = tempDir('factory-dist-install-real-bundle-');
    const bundleLinkParent = tempDir('factory-dist-install-bundle-link-parent-');
    const installRealParent = tempDir('factory-dist-install-real-parent-');
    const installLinkParent = tempDir('factory-dist-install-link-parent-');
    try {
      plantPiSource(realBundleRoot);
      const bundleLink = path.join(bundleLinkParent, 'bundle-link');
      const installLink = path.join(installLinkParent, 'install-link');
      symlinkSync(realBundleRoot, bundleLink);
      symlinkSync(installRealParent, installLink);

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => planDistributionInstallUpdateDryRun(manifest, { bundleRoot: bundleLink, installRoot: path.join(installRealParent, 'root') })).toThrow(
        'contains symlink segment',
      );
      expect(() => planDistributionInstallUpdateDryRun(manifest, { bundleRoot: realBundleRoot, installRoot: path.join(installLink, 'root') })).toThrow(
        'contains symlink segment',
      );
    } finally {
      rmSync(realBundleRoot, { recursive: true, force: true });
      rmSync(bundleLinkParent, { recursive: true, force: true });
      rmSync(installRealParent, { recursive: true, force: true });
      rmSync(installLinkParent, { recursive: true, force: true });
    }
  });

  test('reports non-directory bundle and install roots', () => {
    const bundleRoot = tempDir('factory-dist-install-root-file-bundle-');
    const installRoot = tempDir('factory-dist-install-root-file-root-');
    try {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
      writeFileSync(bundleRoot, 'not a directory\n');
      writeFileSync(installRoot, 'not a directory\n');

      const manifest = buildDistributionManifest(piManifestInput({
        generatedSkillFiles: [
          { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: '.pi/skills/gstack-review/SKILL.md', installPath: 'skills/gstack-review/SKILL.md', required: true },
        ],
      }));
      const plan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot });

      expect(plan.ok).toBe(false);
      expect(plan.conflicts.map(conflict => conflict.reason)).toContain('bundle-root-not-directory');
      expect(plan.conflicts.map(conflict => conflict.reason)).toContain('install-root-not-directory');
      expect(readFileSync(bundleRoot, 'utf-8')).toBe('not a directory\n');
      expect(readFileSync(installRoot, 'utf-8')).toBe('not a directory\n');
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test('rejects symlinked staged bundle entries instead of blessing link targets', () => {
    const bundleRoot = tempDir('factory-dist-install-symlink-bundle-');
    const installRoot = tempDir('factory-dist-install-symlink-root-');
    const outside = tempDir('factory-dist-install-symlink-outside-');
    try {
      plantPiSource(bundleRoot);
      rmSync(path.join(bundleRoot, 'ETHOS.md'));
      writeFile(outside, 'ETHOS.md', 'outside ethos\n');
      symlinkSync(path.join(outside, 'ETHOS.md'), path.join(bundleRoot, 'ETHOS.md'));

      const manifest = buildDistributionManifest(piManifestInput({
        runtimeSidecars: [
          { sourcePath: 'ETHOS.md', bundlePath: 'ETHOS.md', installPath: 'skills/gstack/ETHOS.md', required: true },
        ],
      }));
      const plan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot });

      expect(plan.ok).toBe(false);
      expect(plan.conflicts).toContainEqual({
        installPath: 'skills/gstack/ETHOS.md',
        absoluteInstallPath: path.join(installRoot, 'skills/gstack/ETHOS.md'),
        bundlePath: 'ETHOS.md',
        absoluteBundlePath: path.join(bundleRoot, 'ETHOS.md'),
        reason: 'bundle-entry-not-file',
      });
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('plans update creates, updates, keeps, and removals from manifests only', () => {
    const bundleRoot = tempDir('factory-dist-update-bundle-');
    const installRoot = tempDir('factory-dist-update-root-');
    try {
      plantPiSource(bundleRoot);
      writeFile(bundleRoot, '.pi/skills/gstack-new/SKILL.md', '# new skill\n');

      writeFile(installRoot, 'skills/gstack-review/SKILL.md', '# gstack-review\n');
      writeFile(installRoot, 'skills/gstack-ship/SKILL.md', '# old ship\n');
      writeFile(installRoot, 'skills/gstack-old/SKILL.md', '# old skill\n');

      const currentManifest = buildDistributionManifest({
        bundleVersion: '1.27.0.0',
        builtAt: '2026-05-20T00:00:00.000Z',
        compatibility: { host: 'pi' },
        generatedSkillFiles: [
          { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: '.pi/skills/gstack-review/SKILL.md', installPath: 'skills/gstack-review/SKILL.md', required: true },
          { sourcePath: '.pi/skills/gstack-ship/SKILL.md', bundlePath: '.pi/skills/gstack-ship/SKILL.md', installPath: 'skills/gstack-ship/SKILL.md', required: true },
          { sourcePath: '.pi/skills/gstack-old/SKILL.md', bundlePath: '.pi/skills/gstack-old/SKILL.md', installPath: 'skills/gstack-old/SKILL.md', required: true },
        ],
      });
      const nextManifest = buildDistributionManifest({
        bundleVersion: '1.27.1.0',
        builtAt: '2026-05-21T00:00:00.000Z',
        compatibility: { host: 'pi' },
        generatedSkillFiles: [
          { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: '.pi/skills/gstack-review/SKILL.md', installPath: 'skills/gstack-review/SKILL.md', required: true },
          { sourcePath: '.pi/skills/gstack-ship/SKILL.md', bundlePath: '.pi/skills/gstack-ship/SKILL.md', installPath: 'skills/gstack-ship/SKILL.md', required: true },
          { sourcePath: '.pi/skills/gstack-new/SKILL.md', bundlePath: '.pi/skills/gstack-new/SKILL.md', installPath: 'skills/gstack-new/SKILL.md', required: true },
        ],
      });

      const plan = planDistributionInstallUpdateDryRun(nextManifest, { bundleRoot, installRoot, currentManifest });
      const byInstallPath = new Map(plan.entries.map(entry => [entry.installPath, entry]));

      expect(plan.mode).toBe('update');
      expect(plan.ok).toBe(true);
      expect(byInstallPath.get('skills/gstack-review/SKILL.md')?.action).toBe('keep');
      expect(byInstallPath.get('skills/gstack-ship/SKILL.md')?.action).toBe('update');
      expect(byInstallPath.get('skills/gstack-new/SKILL.md')?.action).toBe('create');
      expect(plan.removals.map(removal => removal.installPath)).toEqual(['skills/gstack-old/SKILL.md']);
      expect(plan.summary).toMatchObject({ createCount: 1, updateCount: 1, keepCount: 1, removeCount: 1 });
      expect(readFileSync(path.join(installRoot, 'skills/gstack-ship/SKILL.md'), 'utf-8')).toBe('# old ship\n');
      expect(existsSync(path.join(installRoot, 'skills/gstack-new/SKILL.md'))).toBe(false);
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test('fails closed on install parent collisions before mutation', () => {
    const bundleRoot = tempDir('factory-dist-update-parent-bundle-');
    const installRoot = tempDir('factory-dist-update-parent-root-');
    try {
      plantPiSource(bundleRoot);
      writeFileSync(path.join(installRoot, 'skills'), 'not a directory\n');

      const manifest = buildDistributionManifest(piManifestInput({
        generatedSkillFiles: [
          { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: '.pi/skills/gstack-review/SKILL.md', installPath: 'skills/gstack-review/SKILL.md', required: true },
        ],
      }));

      const plan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot });
      expect(plan.ok).toBe(false);
      expect(plan.conflicts).toContainEqual({
        installPath: 'skills/gstack-review/SKILL.md',
        absoluteInstallPath: path.join(installRoot, 'skills'),
        bundlePath: '.pi/skills/gstack-review/SKILL.md',
        absoluteBundlePath: path.join(bundleRoot, '.pi/skills/gstack-review/SKILL.md'),
        reason: 'target-parent-not-directory',
      });
      expect(readFileSync(path.join(installRoot, 'skills'), 'utf-8')).toBe('not a directory\n');
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test('fails closed on non-file staged bundle parent collisions', () => {
    const bundleRoot = tempDir('factory-dist-update-bundle-parent-');
    const installRoot = tempDir('factory-dist-update-bundle-parent-root-');
    try {
      writeFileSync(path.join(bundleRoot, '.pi'), 'not a directory\n');

      const manifest = buildDistributionManifest(piManifestInput({
        generatedSkillFiles: [
          { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: '.pi/skills/gstack-review/SKILL.md', installPath: 'skills/gstack-review/SKILL.md', required: true },
        ],
      }));

      const plan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot });
      expect(plan.ok).toBe(false);
      expect(plan.conflicts.map(conflict => conflict.reason)).toContain('bundle-parent-not-directory');
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test('fails closed on unmanaged targets and missing required bundle files', () => {
    const bundleRoot = tempDir('factory-dist-update-conflict-bundle-');
    const installRoot = tempDir('factory-dist-update-conflict-root-');
    try {
      plantPiSource(bundleRoot);
      rmSync(path.join(bundleRoot, '.pi/skills/gstack-ship/SKILL.md'));
      writeFile(installRoot, 'skills/gstack-review/SKILL.md', 'user managed review\n');

      const manifest = buildDistributionManifest(piManifestInput({
        generatedSkillFiles: [
          { sourcePath: '.pi/skills/gstack-review/SKILL.md', bundlePath: '.pi/skills/gstack-review/SKILL.md', installPath: 'skills/gstack-review/SKILL.md', required: true },
          { sourcePath: '.pi/skills/gstack-ship/SKILL.md', bundlePath: '.pi/skills/gstack-ship/SKILL.md', installPath: 'skills/gstack-ship/SKILL.md', required: true },
        ],
      }));

      const plan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot });
      expect(plan.ok).toBe(false);
      expect(plan.conflicts.map(conflict => conflict.reason).sort()).toEqual([
        'required-bundle-file-missing',
        'unmanaged-target-exists',
      ]);
      expect(readFileSync(path.join(installRoot, 'skills/gstack-review/SKILL.md'), 'utf-8')).toBe('user managed review\n');
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  test('skips missing optional bundle files without blocking install dry-run', () => {
    const bundleRoot = tempDir('factory-dist-update-optional-bundle-');
    const installRoot = tempDir('factory-dist-update-optional-root-');
    try {
      plantPiSource(bundleRoot);
      const manifest = buildDistributionManifest(piManifestInput({
        runtimeSidecars: [
          { sourcePath: 'ETHOS.md', bundlePath: 'ETHOS.md', required: true },
          { sourcePath: 'design/dist/design', bundlePath: 'design/dist/design', required: false },
        ],
      }));

      const plan = planDistributionInstallUpdateDryRun(manifest, { bundleRoot, installRoot });
      expect(plan.ok).toBe(true);
      expect(plan.summary.skippedOptionalCount).toBe(1);
      const optional = plan.entries.find(entry => entry.bundlePath === 'design/dist/design');
      expect(optional?.action).toBe('skip-missing-optional');
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
      rmSync(installRoot, { recursive: true, force: true });
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
      // Unrelated user files at root and nested below a planned top-level directory.
      writeFile(outputDir, 'user-notes.txt', 'mine\n');
      writeFile(outputDir, 'review/stale.md', 'stale nested file\n');

      const manifest = buildDistributionManifest(piManifestInput());
      expect(() => stageDistributionBundle(manifest, { sourceRoot, outputDir })).toThrow(
        /Refusing to stage distribution bundle/,
      );

      // With explicit opt-in, the extra file is preserved and the bundle is staged.
      const result = stageDistributionBundle(manifest, {
        sourceRoot,
        outputDir,
        allowExtraFilesInOutputDir: true,
      });
      expect(result.filesWritten).toBe(6);
      expect(readFileSync(path.join(outputDir, 'user-notes.txt'), 'utf-8')).toBe('mine\n');
      expect(readFileSync(path.join(outputDir, 'review/stale.md'), 'utf-8')).toBe('stale nested file\n');
      expect(existsSync(result.manifestPath)).toBe(true);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('skips missing optional files when staging', () => {
    const sourceRoot = tempDir('factory-dist-stage-optional-src-');
    const outputDir = tempDir('factory-dist-stage-optional-out-');
    try {
      plantPiSource(sourceRoot);
      rmSync(outputDir, { recursive: true, force: true });

      const manifest = buildDistributionManifest(piManifestInput({
        runtimeSidecars: [
          { sourcePath: 'ETHOS.md', bundlePath: 'ETHOS.md', required: true },
          { sourcePath: 'design/dist/design', bundlePath: 'design/dist/design', required: false },
        ],
      }));
      const result = stageDistributionBundle(manifest, { sourceRoot, outputDir });

      expect(result.filesWritten).toBe(4);
      expect(result.writtenBundlePaths).not.toContain('design/dist/design');
      expect(existsSync(path.join(outputDir, 'design/dist/design'))).toBe(false);
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
