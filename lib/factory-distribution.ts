import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export const DISTRIBUTION_MANIFEST_VERSION = 1 as const;
export const DISTRIBUTION_MANIFEST_FILENAME = 'bundle-manifest.json';

export type DistributionFileCategory = 'extension' | 'generated-skill' | 'runtime-sidecar';

export interface DistributionFileEntry {
  readonly category: DistributionFileCategory;
  /** Relative source path inside the source root. */
  readonly sourcePath: string;
  /** Relative target path inside the staged bundle. */
  readonly bundlePath: string;
  /** When true, missing source file fails validation. When false, missing is reported as a warning. */
  readonly required: boolean;
}

export interface DistributionCompatibility {
  readonly host: 'pi';
  readonly minHostVersion?: string;
  readonly maxHostVersion?: string;
  readonly requiredCapabilities?: readonly string[];
}

export interface DistributionManifest {
  readonly manifestVersion: typeof DISTRIBUTION_MANIFEST_VERSION;
  readonly bundleVersion: string;
  readonly commit?: string;
  readonly builtAt: string;
  readonly compatibility: DistributionCompatibility;
  readonly files: readonly DistributionFileEntry[];
}

export interface BuildDistributionManifestInput {
  readonly bundleVersion: string;
  readonly commit?: string;
  readonly builtAt?: string;
  readonly compatibility: DistributionCompatibility;
  readonly extensionFiles?: readonly Omit<DistributionFileEntry, 'category'>[];
  readonly generatedSkillFiles?: readonly Omit<DistributionFileEntry, 'category'>[];
  readonly runtimeSidecars?: readonly Omit<DistributionFileEntry, 'category'>[];
}

export interface DistributionValidationIssue {
  readonly category: DistributionFileCategory;
  readonly sourcePath: string;
  readonly bundlePath: string;
}

export interface DistributionValidationResult {
  readonly ok: boolean;
  readonly missingRequired: readonly DistributionValidationIssue[];
  readonly missingOptional: readonly DistributionValidationIssue[];
}

export interface DistributionBundlePlanEntry {
  readonly category: DistributionFileCategory;
  readonly sourcePath: string;
  readonly bundlePath: string;
  readonly absoluteSourcePath: string;
  readonly absoluteBundlePath: string;
  readonly sizeBytes: number;
  readonly required: boolean;
  readonly missing: boolean;
}

export interface DistributionBundleConflict {
  readonly bundlePath: string;
  readonly absoluteBundlePath: string;
  readonly reason: 'file-exists';
}

export interface DistributionBundlePlan {
  readonly outputDir: string;
  readonly manifestPath: string;
  readonly entries: readonly DistributionBundlePlanEntry[];
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly conflicts: readonly DistributionBundleConflict[];
  readonly validation: DistributionValidationResult;
}

export interface DistributionBundleStageResult {
  readonly outputDir: string;
  readonly manifestPath: string;
  readonly filesWritten: number;
  readonly bytesWritten: number;
  readonly writtenBundlePaths: readonly string[];
}

export interface PlanDistributionBundleOptions {
  readonly sourceRoot: string;
  readonly outputDir: string;
}

export interface StageDistributionBundleOptions extends PlanDistributionBundleOptions {
  /** When true (default), output dir must contain no colliding files. */
  readonly refuseConflicts?: boolean;
  /** When false (default), bundle output dir must not contain unrelated files at the root. */
  readonly allowExtraFilesInOutputDir?: boolean;
}

export function isSafeRelativeBundlePath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  if (isAbsolute(p)) return false;
  if (p.startsWith('~')) return false;
  // Reject any parent traversal segment in the *raw* input, even when it would
  // normalize away (a/../b -> b). A legitimate distribution entry never needs
  // it, and refusing pre-normalization avoids defense-in-depth surprises.
  const rawSegments = p.split(/[\\/]+/);
  if (rawSegments.some(seg => seg === '..')) return false;
  const normalized = normalize(p);
  if (normalized === '' || normalized === '.') return false;
  if (normalized.startsWith('..')) return false;
  const segments = normalized.split(/[\\/]+/);
  if (segments.some(seg => seg === '..' || seg === '')) return false;
  return true;
}

export function assertSafeBundlePath(p: string): void {
  if (!isSafeRelativeBundlePath(p)) {
    throw new Error(`Unsafe distribution bundle path '${p}'`);
  }
}

export function buildDistributionManifest(input: BuildDistributionManifestInput): DistributionManifest {
  if (!input.bundleVersion || typeof input.bundleVersion !== 'string') {
    throw new Error('Distribution manifest requires a non-empty bundleVersion');
  }
  if (!input.compatibility || input.compatibility.host !== 'pi') {
    throw new Error("Distribution manifest only supports host 'pi'");
  }

  const entries: DistributionFileEntry[] = [];
  const seenBundlePaths = new Set<string>();
  const addAll = (
    category: DistributionFileCategory,
    raw: readonly Omit<DistributionFileEntry, 'category'>[] | undefined,
  ) => {
    if (!raw) return;
    for (const entry of raw) {
      assertSafeBundlePath(entry.sourcePath);
      assertSafeBundlePath(entry.bundlePath);
      if (entry.bundlePath === DISTRIBUTION_MANIFEST_FILENAME) {
        throw new Error(`Distribution bundle path '${entry.bundlePath}' is reserved for the manifest`);
      }
      const normalizedBundlePath = normalize(entry.bundlePath);
      if (seenBundlePaths.has(normalizedBundlePath)) {
        throw new Error(`Duplicate distribution bundle path '${entry.bundlePath}'`);
      }
      seenBundlePaths.add(normalizedBundlePath);
      entries.push({
        category,
        sourcePath: entry.sourcePath,
        bundlePath: entry.bundlePath,
        required: entry.required,
      });
    }
  };

  addAll('extension', input.extensionFiles);
  addAll('generated-skill', input.generatedSkillFiles);
  addAll('runtime-sidecar', input.runtimeSidecars);

  return {
    manifestVersion: DISTRIBUTION_MANIFEST_VERSION,
    bundleVersion: input.bundleVersion,
    commit: input.commit,
    builtAt: input.builtAt ?? new Date().toISOString(),
    compatibility: {
      host: input.compatibility.host,
      minHostVersion: input.compatibility.minHostVersion,
      maxHostVersion: input.compatibility.maxHostVersion,
      requiredCapabilities: input.compatibility.requiredCapabilities
        ? [...input.compatibility.requiredCapabilities]
        : undefined,
    },
    files: entries,
  };
}

export function validateDistributionManifest(
  manifest: DistributionManifest,
  sourceRoot: string,
): DistributionValidationResult {
  const absoluteSourceRoot = resolve(sourceRoot);
  const missingRequired: DistributionValidationIssue[] = [];
  const missingOptional: DistributionValidationIssue[] = [];

  for (const file of manifest.files) {
    const absoluteSource = resolveInsideRoot(absoluteSourceRoot, file.sourcePath);
    if (!existsSync(absoluteSource)) {
      const issue: DistributionValidationIssue = {
        category: file.category,
        sourcePath: file.sourcePath,
        bundlePath: file.bundlePath,
      };
      if (file.required) missingRequired.push(issue);
      else missingOptional.push(issue);
    }
  }

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingOptional,
  };
}

export function planDistributionBundle(
  manifest: DistributionManifest,
  options: PlanDistributionBundleOptions,
): DistributionBundlePlan {
  const absoluteSourceRoot = resolve(options.sourceRoot);
  const absoluteOutputDir = resolve(options.outputDir);
  const manifestPath = join(absoluteOutputDir, DISTRIBUTION_MANIFEST_FILENAME);

  const entries: DistributionBundlePlanEntry[] = [];
  const conflicts: DistributionBundleConflict[] = [];
  let totalBytes = 0;

  for (const file of manifest.files) {
    const absoluteSource = resolveInsideRoot(absoluteSourceRoot, file.sourcePath);
    const absoluteBundle = resolveInsideRoot(absoluteOutputDir, file.bundlePath);
    const exists = existsSync(absoluteSource);
    let sizeBytes = 0;
    if (exists) {
      const stat = statSync(absoluteSource);
      if (!stat.isFile()) {
        throw new Error(
          `Distribution source '${file.sourcePath}' is not a regular file; entries must be individual files`,
        );
      }
      sizeBytes = stat.size;
      totalBytes += sizeBytes;
    }
    entries.push({
      category: file.category,
      sourcePath: file.sourcePath,
      bundlePath: file.bundlePath,
      absoluteSourcePath: absoluteSource,
      absoluteBundlePath: absoluteBundle,
      sizeBytes,
      required: file.required,
      missing: !exists,
    });

    if (existsSync(absoluteBundle)) {
      conflicts.push({
        bundlePath: file.bundlePath,
        absoluteBundlePath: absoluteBundle,
        reason: 'file-exists',
      });
    }
  }

  if (existsSync(manifestPath)) {
    conflicts.push({
      bundlePath: DISTRIBUTION_MANIFEST_FILENAME,
      absoluteBundlePath: manifestPath,
      reason: 'file-exists',
    });
  }

  return {
    outputDir: absoluteOutputDir,
    manifestPath,
    entries,
    totalFiles: entries.length,
    totalBytes,
    conflicts,
    validation: validateDistributionManifest(manifest, absoluteSourceRoot),
  };
}

export function stageDistributionBundle(
  manifest: DistributionManifest,
  options: StageDistributionBundleOptions,
): DistributionBundleStageResult {
  const refuseConflicts = options.refuseConflicts ?? true;
  const allowExtras = options.allowExtraFilesInOutputDir ?? false;
  const plan = planDistributionBundle(manifest, options);

  if (!plan.validation.ok) {
    const missing = plan.validation.missingRequired
      .map(issue => `${issue.category}:${issue.sourcePath}`)
      .join(', ');
    throw new Error(`Distribution validation failed; required sources missing: ${missing}`);
  }

  if (refuseConflicts && plan.conflicts.length > 0) {
    const conflictPaths = plan.conflicts.map(c => c.bundlePath).join(', ');
    throw new Error(
      `Refusing to stage distribution bundle: output dir already contains '${conflictPaths}'. ` +
        'Pass refuseConflicts: false to override (not recommended for user-managed paths).',
    );
  }

  if (!allowExtras && existsSync(plan.outputDir)) {
    const stat = statSync(plan.outputDir);
    if (!stat.isDirectory()) {
      throw new Error(`Distribution output path '${plan.outputDir}' exists but is not a directory`);
    }
    const planned = new Set<string>();
    for (const entry of plan.entries) {
      planned.add(normalize(entry.bundlePath).split(/[\\/]+/)[0]);
    }
    planned.add(DISTRIBUTION_MANIFEST_FILENAME);
    const existing = readdirSync(plan.outputDir);
    const unrelated = existing.filter(name => !planned.has(name));
    if (unrelated.length > 0) {
      throw new Error(
        `Distribution output dir '${plan.outputDir}' contains unrelated content: ${unrelated.join(', ')}. ` +
          'Pass allowExtraFilesInOutputDir: true to ignore.',
      );
    }
  }

  mkdirSync(plan.outputDir, { recursive: true });

  const writtenBundlePaths: string[] = [];
  let filesWritten = 0;
  let bytesWritten = 0;

  for (const entry of plan.entries) {
    mkdirSync(dirname(entry.absoluteBundlePath), { recursive: true });
    copyFileSync(entry.absoluteSourcePath, entry.absoluteBundlePath);
    writtenBundlePaths.push(entry.bundlePath);
    filesWritten += 1;
    bytesWritten += entry.sizeBytes;
  }

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(plan.manifestPath, manifestJson, 'utf-8');
  writtenBundlePaths.push(DISTRIBUTION_MANIFEST_FILENAME);

  return {
    outputDir: plan.outputDir,
    manifestPath: plan.manifestPath,
    filesWritten,
    bytesWritten,
    writtenBundlePaths,
  };
}

function resolveInsideRoot(absoluteRoot: string, relativePath: string): string {
  assertSafeBundlePath(relativePath);
  const absolute = resolve(absoluteRoot, relativePath);
  const rel = relative(absoluteRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`Path '${relativePath}' escapes root '${absoluteRoot}'`);
  }
  return absolute;
}
