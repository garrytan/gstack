#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CAPABILITY_LAUNCHERS,
  installManagedRuntime,
  runtimeNativePackagePaths,
} from '../../runtime/install.js';
import { atomicWriteJson } from '../../runtime/storage.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const FORBIDDEN_COMPONENT = /browserbase|browserless|huggingface|onnxruntime|claude-agent-sdk/i;

export interface RuntimeBundleAudit {
  schemaVersion: 1;
  platform: string;
  arch: string;
  sourceBundleVersion: string;
  generatedAt: string;
  sourceGitCommit: string;
  sourceGitDirty: boolean;
  components: number;
  files: number;
  bytes: number;
  capabilityLaunchers: number;
  nativeComponents: string[];
  forbiddenComponents: string[];
  bundleManifestSha256: string;
  reproductionCommand: string;
}

export function summarizeRuntimeBundle(
  manifest: Record<string, unknown> & {
    version: string;
    components: string[];
    files: Array<{ path: string; size: number; mode: number; sha256: string }>;
  },
): RuntimeBundleAudit {
  const nativeComponents = runtimeNativePackagePaths();
  const forbiddenComponents = manifest.components.filter((component) => FORBIDDEN_COMPONENT.test(component));
  const digestInput = JSON.stringify(manifest);
  return {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    sourceBundleVersion: manifest.version,
    generatedAt: new Date().toISOString(),
    sourceGitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    sourceGitDirty: execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim().length > 0,
    components: manifest.components.length,
    files: manifest.files.length,
    bytes: manifest.files.reduce((total, file) => total + file.size, 0),
    capabilityLaunchers: Object.keys(DEFAULT_CAPABILITY_LAUNCHERS).length,
    nativeComponents: [...nativeComponents],
    forbiddenComponents,
    bundleManifestSha256: createHash('sha256').update(digestInput).digest('hex'),
    reproductionCommand: `bun run scripts/gstack2/audit-runtime-bundle.ts --output evals/runtime-bundle/${process.platform}-${process.arch}.json`,
  };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const outputIndex = argv.indexOf('--output');
  if (argv.length !== 0 && (outputIndex !== 0 || argv.length !== 2 || !argv[1])) {
    throw new TypeError('Usage: audit-runtime-bundle.ts [--output <path>]');
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gstack2-runtime-bundle-audit-'));
  try {
    const result = await installManagedRuntime({
      sourceDir: REPO_ROOT,
      home: path.join(scratch, 'home'),
      buildMissing: false,
    });
    const manifest = JSON.parse(await fs.readFile(path.join(result.path, '.gstack-bundle.json'), 'utf8'));
    const audit = summarizeRuntimeBundle(manifest);
    if (audit.forbiddenComponents.length > 0) {
      throw new Error(`Forbidden production components: ${audit.forbiddenComponents.join(', ')}`);
    }
    if (outputIndex === 0) {
      const output = path.resolve(REPO_ROOT, argv[1]);
      await atomicWriteJson(output, audit, { mode: 0o644 });
    }
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
