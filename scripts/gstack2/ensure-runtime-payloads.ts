#!/usr/bin/env bun
import fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  DEFAULT_CAPABILITY_LAUNCHERS,
  DEFAULT_RUNTIME_BUNDLE,
  defaultBunBuilder,
} from '../../runtime/install.js';

const ROOT = path.resolve(import.meta.dir, '../..');
const REQUIRED_CAPABILITIES = [
  'browse',
  'gstack-design',
  'make-pdf',
  ...(process.platform === 'darwin' ? ['gstack-ios-qa-daemon', 'gstack-ios-qa-mint'] : []),
] as const;

export interface RuntimePayloadEntry {
  path: string;
  build?: string;
  executable?: boolean;
}

export interface EnsureRuntimePayloadsOptions {
  sourceDir?: string;
  exists?: (absolutePath: string) => boolean | Promise<boolean>;
  builder?: (options: {
    sourceDir: string;
    missing: readonly RuntimePayloadEntry[];
    bunCommand?: string;
  }) => Promise<unknown>;
  bunCommand?: string;
}

export const REQUIRED_RUNTIME_PAYLOADS: readonly RuntimePayloadEntry[] = Object.freeze(
  REQUIRED_CAPABILITIES.map((capability) => {
    const payloadPath = DEFAULT_CAPABILITY_LAUNCHERS[capability];
    const entry = DEFAULT_RUNTIME_BUNDLE.find((candidate) => candidate.path === payloadPath);
    if (!entry?.build) throw new Error(`Runtime capability ${capability} has no buildable bundle entry at ${payloadPath}`);
    return Object.freeze({ ...entry });
  }),
);

async function defaultExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function missingPayloads(
  sourceDir: string,
  exists: NonNullable<EnsureRuntimePayloadsOptions['exists']>,
): Promise<RuntimePayloadEntry[]> {
  const missing: RuntimePayloadEntry[] = [];
  for (const entry of REQUIRED_RUNTIME_PAYLOADS) {
    if (!(await exists(path.join(sourceDir, entry.path)))) missing.push(entry);
  }
  return missing;
}

export async function ensureRuntimePayloads(options: EnsureRuntimePayloadsOptions = {}): Promise<{
  built: boolean;
  payloads: readonly RuntimePayloadEntry[];
}> {
  const sourceDir = path.resolve(options.sourceDir ?? ROOT);
  const exists = options.exists ?? defaultExists;
  const builder = options.builder ?? defaultBunBuilder;
  const missing = await missingPayloads(sourceDir, exists);

  if (missing.length === 0) return { built: false, payloads: REQUIRED_RUNTIME_PAYLOADS };

  await builder({
    sourceDir,
    missing: Object.freeze(missing.map((entry) => Object.freeze({ ...entry }))),
    bunCommand: options.bunCommand ?? process.env.BUN_CMD ?? 'bun',
  });

  const remaining = await missingPayloads(sourceDir, exists);
  if (remaining.length > 0) {
    throw new Error(`Runtime payload build did not produce: ${remaining.map((entry) => entry.path).join(', ')}`);
  }

  return { built: true, payloads: REQUIRED_RUNTIME_PAYLOADS };
}

if (import.meta.main) await ensureRuntimePayloads();
