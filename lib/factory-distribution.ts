import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';

export const DISTRIBUTION_MANIFEST_VERSION = 1 as const;
export const DISTRIBUTION_MANIFEST_FILENAME = 'bundle-manifest.json';

export type DistributionFileCategory = 'extension' | 'generated-skill' | 'runtime-sidecar';

export interface DistributionFileEntry {
  readonly category: DistributionFileCategory;
  /** Relative source path inside the source root. */
  readonly sourcePath: string;
  /** Relative target path inside the staged bundle. */
  readonly bundlePath: string;
  /** Relative target path inside the managed install root. Defaults to bundlePath. */
  readonly installPath?: string;
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
  readonly reason: 'file-exists' | 'parent-not-directory' | 'output-root-not-directory' | 'unrelated-output-content';
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

export type DistributionInstallDryRunMode = 'install' | 'update';
export type DistributionInstallDryRunAction = 'create' | 'update' | 'keep' | 'skip-missing-optional';

export interface DistributionInstallDryRunEntry {
  readonly category: DistributionFileCategory;
  readonly bundlePath: string;
  readonly installPath: string;
  readonly absoluteBundlePath: string;
  readonly absoluteInstallPath: string;
  readonly sizeBytes: number;
  readonly action: DistributionInstallDryRunAction;
  readonly reason:
    | 'target-missing'
    | 'target-differs'
    | 'target-matches'
    | 'optional-bundle-file-missing';
}

export interface DistributionInstallDryRunRemoval {
  readonly category: DistributionFileCategory;
  readonly bundlePath: string;
  readonly installPath: string;
  readonly absoluteInstallPath: string;
  readonly exists: boolean;
  readonly reason: 'removed-from-next-manifest';
}

export type DistributionInstallDryRunConflictReason =
  | 'required-bundle-file-missing'
  | 'bundle-root-not-directory'
  | 'bundle-parent-not-directory'
  | 'bundle-entry-not-file'
  | 'install-root-not-directory'
  | 'target-parent-not-directory'
  | 'target-not-regular-file'
  | 'unmanaged-target-exists'
  | 'removed-target-not-regular-file';

export interface DistributionInstallDryRunConflict {
  readonly installPath: string;
  readonly absoluteInstallPath: string;
  readonly bundlePath?: string;
  readonly absoluteBundlePath?: string;
  readonly reason: DistributionInstallDryRunConflictReason;
}

export interface DistributionInstallDryRunSummary {
  readonly createCount: number;
  readonly updateCount: number;
  readonly keepCount: number;
  readonly removeCount: number;
  readonly skippedOptionalCount: number;
  readonly bytesToWrite: number;
}

export interface DistributionInstallUpdateDryRunPlan {
  readonly mode: DistributionInstallDryRunMode;
  readonly ok: boolean;
  readonly bundleRoot: string;
  readonly installRoot: string;
  readonly entries: readonly DistributionInstallDryRunEntry[];
  readonly removals: readonly DistributionInstallDryRunRemoval[];
  readonly conflicts: readonly DistributionInstallDryRunConflict[];
  readonly summary: DistributionInstallDryRunSummary;
}

export interface PlanDistributionInstallUpdateDryRunOptions {
  /** Root of an already staged bundle. This function reads from it but never writes to it. */
  readonly bundleRoot: string;
  /** Managed install root. This function reads from it but never writes to it. */
  readonly installRoot: string;
  /** Manifest for the currently installed managed bundle, if any. */
  readonly currentManifest?: DistributionManifest | null;
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
  const seenInstallPaths = new Set<string>();
  const addAll = (
    category: DistributionFileCategory,
    raw: readonly Omit<DistributionFileEntry, 'category'>[] | undefined,
  ) => {
    if (!raw) return;
    for (const entry of raw) {
      assertSafeBundlePath(entry.sourcePath);
      assertSafeBundlePath(entry.bundlePath);
      if (entry.installPath !== undefined) assertSafeBundlePath(entry.installPath);
      if (entry.bundlePath === DISTRIBUTION_MANIFEST_FILENAME) {
        throw new Error(`Distribution bundle path '${entry.bundlePath}' is reserved for the manifest`);
      }
      if (entry.installPath === DISTRIBUTION_MANIFEST_FILENAME) {
        throw new Error(`Distribution install path '${entry.installPath}' is reserved for the manifest`);
      }
      const normalizedBundlePath = normalize(entry.bundlePath);
      if (seenBundlePaths.has(normalizedBundlePath)) {
        throw new Error(`Duplicate distribution bundle path '${entry.bundlePath}'`);
      }
      seenBundlePaths.add(normalizedBundlePath);
      const normalizedInstallPath = normalize(entry.installPath ?? entry.bundlePath);
      if (seenInstallPaths.has(normalizedInstallPath)) {
        throw new Error(`Duplicate distribution install path '${entry.installPath ?? entry.bundlePath}'`);
      }
      seenInstallPaths.add(normalizedInstallPath);
      entries.push({
        category,
        sourcePath: entry.sourcePath,
        bundlePath: entry.bundlePath,
        installPath: entry.installPath,
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
  assertNoSymlinkInExistingPath(absoluteSourceRoot, 'sourceRoot');
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
  assertNoSymlinkInExistingPath(absoluteSourceRoot, 'sourceRoot');
  assertNoSymlinkInExistingPath(absoluteOutputDir, 'outputDir');
  const manifestPath = join(absoluteOutputDir, DISTRIBUTION_MANIFEST_FILENAME);

  const entries: DistributionBundlePlanEntry[] = [];
  const conflicts: DistributionBundleConflict[] = [];
  let totalBytes = 0;

  const outputRootExists = existsSync(absoluteOutputDir);
  if (outputRootExists && !lstatSync(absoluteOutputDir).isDirectory()) {
    conflicts.push({
      bundlePath: '.',
      absoluteBundlePath: absoluteOutputDir,
      reason: 'output-root-not-directory',
    });
  }

  for (const file of manifest.files) {
    const absoluteSource = resolveInsideRoot(absoluteSourceRoot, file.sourcePath);
    const absoluteBundle = resolveInsideRoot(absoluteOutputDir, file.bundlePath);
    const exists = existsSync(absoluteSource);
    let sizeBytes = 0;
    if (exists) {
      const stat = lstatSync(absoluteSource);
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

    const blockingBundleParent = firstNonDirectoryAncestor(absoluteOutputDir, absoluteBundle);
    if (blockingBundleParent) {
      conflicts.push({
        bundlePath: file.bundlePath,
        absoluteBundlePath: blockingBundleParent,
        reason: 'parent-not-directory',
      });
    } else if (existsSync(absoluteBundle)) {
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

  if (existsSync(absoluteOutputDir) && statSync(absoluteOutputDir).isDirectory()) {
    const plannedFiles = new Set<string>();
    for (const entry of entries) {
      if (!entry.missing) plannedFiles.add(normalize(entry.bundlePath));
    }
    plannedFiles.add(DISTRIBUTION_MANIFEST_FILENAME);
    for (const unrelated of collectUnrelatedExistingPaths(absoluteOutputDir, plannedFiles)) {
      conflicts.push({
        bundlePath: unrelated,
        absoluteBundlePath: join(absoluteOutputDir, unrelated),
        reason: 'unrelated-output-content',
      });
    }
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

  const blockingConflicts = allowExtras
    ? plan.conflicts.filter(conflict => conflict.reason !== 'unrelated-output-content')
    : plan.conflicts;
  if (refuseConflicts && blockingConflicts.length > 0) {
    const conflictPaths = blockingConflicts.map(c => c.bundlePath).join(', ');
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
    const plannedFiles = new Set<string>();
    for (const entry of plan.entries) {
      if (!entry.missing) plannedFiles.add(normalize(entry.bundlePath));
    }
    plannedFiles.add(DISTRIBUTION_MANIFEST_FILENAME);
    const unrelated = collectUnrelatedExistingPaths(plan.outputDir, plannedFiles);
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
    if (entry.missing && !entry.required) continue;
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

export function planDistributionInstallUpdateDryRun(
  manifest: DistributionManifest,
  options: PlanDistributionInstallUpdateDryRunOptions,
): DistributionInstallUpdateDryRunPlan {
  const absoluteBundleRoot = resolve(options.bundleRoot);
  const absoluteInstallRoot = resolve(options.installRoot);
  assertNoSymlinkInExistingPath(absoluteBundleRoot, 'bundleRoot');
  assertNoSymlinkInExistingPath(absoluteInstallRoot, 'installRoot');
  const mode: DistributionInstallDryRunMode = options.currentManifest ? 'update' : 'install';
  const currentInstallPaths = new Set(
    (options.currentManifest?.files ?? []).map(file => normalize(file.installPath ?? file.bundlePath)),
  );
  const nextInstallPaths = new Set(manifest.files.map(file => normalize(file.installPath ?? file.bundlePath)));

  const entries: DistributionInstallDryRunEntry[] = [];
  const removals: DistributionInstallDryRunRemoval[] = [];
  const conflicts: DistributionInstallDryRunConflict[] = [];
  let bytesToWrite = 0;

  if (existsSync(absoluteBundleRoot) && !lstatSync(absoluteBundleRoot).isDirectory()) {
    conflicts.push({
      installPath: '.',
      absoluteInstallPath: absoluteInstallRoot,
      absoluteBundlePath: absoluteBundleRoot,
      reason: 'bundle-root-not-directory',
    });
  }
  if (existsSync(absoluteInstallRoot) && !lstatSync(absoluteInstallRoot).isDirectory()) {
    conflicts.push({
      installPath: '.',
      absoluteInstallPath: absoluteInstallRoot,
      reason: 'install-root-not-directory',
    });
  }

  for (const file of manifest.files) {
    const installPath = file.installPath ?? file.bundlePath;
    const normalizedInstallPath = normalize(installPath);
    const absoluteBundlePath = resolveInsideRoot(absoluteBundleRoot, file.bundlePath);
    const absoluteInstallPath = resolveInsideRoot(absoluteInstallRoot, installPath);
    const blockingBundleParent = firstNonDirectoryAncestor(absoluteBundleRoot, absoluteBundlePath);
    const blockingInstallParent = firstNonDirectoryAncestor(absoluteInstallRoot, absoluteInstallPath);

    if (blockingBundleParent) {
      if (file.required) {
        conflicts.push({
          installPath,
          absoluteInstallPath,
          bundlePath: file.bundlePath,
          absoluteBundlePath: blockingBundleParent,
          reason: 'bundle-parent-not-directory',
        });
      }
      entries.push({
        category: file.category,
        bundlePath: file.bundlePath,
        installPath,
        absoluteBundlePath,
        absoluteInstallPath,
        sizeBytes: 0,
        action: file.required ? 'create' : 'skip-missing-optional',
        reason: file.required ? 'target-missing' : 'optional-bundle-file-missing',
      });
      continue;
    }

    const bundleExists = existsSync(absoluteBundlePath);

    if (!bundleExists) {
      if (file.required) {
        conflicts.push({
          installPath,
          absoluteInstallPath,
          bundlePath: file.bundlePath,
          absoluteBundlePath,
          reason: 'required-bundle-file-missing',
        });
        entries.push({
          category: file.category,
          bundlePath: file.bundlePath,
          installPath,
          absoluteBundlePath,
          absoluteInstallPath,
          sizeBytes: 0,
          action: 'create',
          reason: 'target-missing',
        });
      } else {
        entries.push({
          category: file.category,
          bundlePath: file.bundlePath,
          installPath,
          absoluteBundlePath,
          absoluteInstallPath,
          sizeBytes: 0,
          action: 'skip-missing-optional',
          reason: 'optional-bundle-file-missing',
        });
      }
      continue;
    }

    const bundleStat = lstatSync(absoluteBundlePath);
    if (!bundleStat.isFile()) {
      conflicts.push({
        installPath,
        absoluteInstallPath,
        bundlePath: file.bundlePath,
        absoluteBundlePath,
        reason: 'bundle-entry-not-file',
      });
      entries.push({
        category: file.category,
        bundlePath: file.bundlePath,
        installPath,
        absoluteBundlePath,
        absoluteInstallPath,
        sizeBytes: 0,
        action: 'create',
        reason: 'target-missing',
      });
      continue;
    }

    const sizeBytes = bundleStat.size;
    let action: DistributionInstallDryRunAction = 'create';
    let reason: DistributionInstallDryRunEntry['reason'] = 'target-missing';

    if (blockingInstallParent) {
      conflicts.push({
        installPath,
        absoluteInstallPath: blockingInstallParent,
        bundlePath: file.bundlePath,
        absoluteBundlePath,
        reason: 'target-parent-not-directory',
      });
      bytesToWrite += sizeBytes;
      entries.push({
        category: file.category,
        bundlePath: file.bundlePath,
        installPath,
        absoluteBundlePath,
        absoluteInstallPath,
        sizeBytes,
        action: 'create',
        reason: 'target-missing',
      });
      continue;
    }

    if (existsSync(absoluteInstallPath)) {
      const targetStat = lstatSync(absoluteInstallPath);
      if (!targetStat.isFile()) {
        conflicts.push({
          installPath,
          absoluteInstallPath,
          bundlePath: file.bundlePath,
          absoluteBundlePath,
          reason: 'target-not-regular-file',
        });
        action = 'update';
        reason = 'target-differs';
      } else if (!currentInstallPaths.has(normalizedInstallPath)) {
        conflicts.push({
          installPath,
          absoluteInstallPath,
          bundlePath: file.bundlePath,
          absoluteBundlePath,
          reason: 'unmanaged-target-exists',
        });
        action = 'update';
        reason = 'target-differs';
      } else if (filesEqual(absoluteBundlePath, absoluteInstallPath)) {
        action = 'keep';
        reason = 'target-matches';
      } else {
        action = 'update';
        reason = 'target-differs';
      }
    }

    if (action === 'create' || action === 'update') bytesToWrite += sizeBytes;
    entries.push({
      category: file.category,
      bundlePath: file.bundlePath,
      installPath,
      absoluteBundlePath,
      absoluteInstallPath,
      sizeBytes,
      action,
      reason,
    });
  }

  for (const file of options.currentManifest?.files ?? []) {
    const installPath = file.installPath ?? file.bundlePath;
    const normalizedInstallPath = normalize(installPath);
    if (nextInstallPaths.has(normalizedInstallPath)) continue;

    const absoluteInstallPath = resolveInsideRoot(absoluteInstallRoot, installPath);
    const blockingInstallParent = firstNonDirectoryAncestor(absoluteInstallRoot, absoluteInstallPath);
    const exists = !blockingInstallParent && existsSync(absoluteInstallPath);
    if (blockingInstallParent) {
      conflicts.push({
        installPath,
        absoluteInstallPath: blockingInstallParent,
        bundlePath: file.bundlePath,
        reason: 'removed-target-not-regular-file',
      });
    } else if (exists && !lstatSync(absoluteInstallPath).isFile()) {
      conflicts.push({
        installPath,
        absoluteInstallPath,
        bundlePath: file.bundlePath,
        reason: 'removed-target-not-regular-file',
      });
    }
    removals.push({
      category: file.category,
      bundlePath: file.bundlePath,
      installPath,
      absoluteInstallPath,
      exists,
      reason: 'removed-from-next-manifest',
    });
  }

  const summary: DistributionInstallDryRunSummary = {
    createCount: entries.filter(entry => entry.action === 'create').length,
    updateCount: entries.filter(entry => entry.action === 'update').length,
    keepCount: entries.filter(entry => entry.action === 'keep').length,
    removeCount: removals.filter(removal => removal.exists).length,
    skippedOptionalCount: entries.filter(entry => entry.action === 'skip-missing-optional').length,
    bytesToWrite,
  };

  return {
    mode,
    ok: conflicts.length === 0,
    bundleRoot: absoluteBundleRoot,
    installRoot: absoluteInstallRoot,
    entries,
    removals,
    conflicts,
    summary,
  };
}

function filesEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

function assertNoSymlinkInExistingPath(absolutePath: string, label: string): void {
  const symlink = firstSymlinkInExistingPath(absolutePath);
  if (symlink) {
    throw new Error(`Unsafe distribution ${label} '${absolutePath}' contains symlink segment '${symlink}'`);
  }
}

function firstSymlinkInExistingPath(absolutePath: string): string | undefined {
  const parsed = parse(absolutePath);
  let current = parsed.root;
  const rest = relative(parsed.root, absolutePath);
  if (!rest || rest === '.') return undefined;

  let depth = 0;
  for (const segment of rest.split(sep)) {
    if (!segment || segment === '.') continue;
    depth += 1;
    current = join(current, segment);
    if (!existsSync(current)) return undefined;
    // Allow known OS-level root aliases such as macOS /tmp -> /private/tmp and
    // /var -> /private/var. Those sit at the first path segment and are outside
    // the caller-controlled workspace/bundle/install tree. Reject deeper or
    // unknown root symlinks because they can redirect staged bundle reads or
    // install writes.
    if (lstatSync(current).isSymbolicLink() && !(depth === 1 && isAllowedSystemRootAlias(current))) return current;
  }
  return undefined;
}

function isAllowedSystemRootAlias(absolutePath: string): boolean {
  if (process.platform !== 'darwin') return false;
  const name = basename(absolutePath);
  const real = realpathSync.native(absolutePath);
  return (name === 'tmp' && real === '/private/tmp') || (name === 'var' && real === '/private/var');
}

function collectUnrelatedExistingPaths(absoluteRoot: string, plannedFiles: ReadonlySet<string>): string[] {
  const plannedAncestors = new Set<string>();
  for (const plannedFile of plannedFiles) {
    const segments = normalize(plannedFile).split(/[\\/]+/);
    for (let i = 1; i < segments.length; i += 1) {
      plannedAncestors.add(segments.slice(0, i).join(sep));
    }
  }

  const unrelated: string[] = [];
  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!plannedAncestors.has(relativePath) && !plannedFiles.has(relativePath)) {
          unrelated.push(relativePath);
          continue;
        }
        visit(join(absoluteDir, entry.name), relativePath);
      } else if (!plannedFiles.has(relativePath)) {
        unrelated.push(relativePath);
      }
    }
  };
  visit(absoluteRoot, '');
  return unrelated;
}

function firstNonDirectoryAncestor(absoluteRoot: string, absolutePath: string): string | undefined {
  const relativeParent = relative(absoluteRoot, dirname(absolutePath));
  if (!relativeParent || relativeParent === '.') return undefined;
  if (relativeParent.startsWith('..') || isAbsolute(relativeParent)) return undefined;

  let current = absoluteRoot;
  for (const segment of relativeParent.split(sep)) {
    if (!segment || segment === '.') continue;
    current = join(current, segment);
    if (existsSync(current) && !lstatSync(current).isDirectory()) return current;
  }
  return undefined;
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
