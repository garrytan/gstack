#!/usr/bin/env bun
/** Trusted CI input validation. Qualification evidence is handled separately. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CSO_RUNTIME_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export const CSO_RUNTIME_STACKS = ['node', 'bun', 'python', 'rails', 'postgresql'] as const;
export type CsoRuntimeBuildPlatform = typeof CSO_RUNTIME_PLATFORMS[number];
export type CsoRuntimeBuildStack = typeof CSO_RUNTIME_STACKS[number];

const IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const TAGGED_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVISION = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const REQUIRED_VERSIONS: Record<CsoRuntimeBuildStack, string[]> = {
  node: ['node', 'npm', 'cso-preparation'],
  // oven/bun exposes a Bun-backed `node` fallback, not a real Node release.
  // Recording a Node version here would make package engine admission unsound.
  bun: ['bun', 'cso-preparation'],
  python: ['python', 'uv', 'cso-preparation'],
  rails: ['ruby', 'bundler', 'cso-preparation'],
  postgresql: ['postgresql'],
};

export interface ImageBuildRow {
  inputRevision: string;
  profileId: string;
  runtimeId: string;
  stack: CsoRuntimeBuildStack;
  platform: CsoRuntimeBuildPlatform;
  arch: 'amd64' | 'arm64';
  runner: 'ubuntu-24.04' | 'ubuntu-24.04-arm';
  baseSource: string;
  baseIndexImage: string;
  baseImage: string;
  uvSource: string;
  uvIndexImage: string;
  uvImage: string;
  sbomGeneratorSource: string;
  sbomGeneratorIndexImage: string;
  sbomGeneratorImage: string;
  versions: Record<string, string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function repositoryOfPinned(image: string): string {
  return image.slice(0, image.lastIndexOf('@'));
}

function repositoryOfTag(image: string): string {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon <= slash) throw new Error('INVALID_SOURCE_REFERENCE');
  return image.slice(0, colon);
}

function assertPinnedFamily(source: unknown, indexImage: unknown, images: unknown, label: string): Record<CsoRuntimeBuildPlatform, string> {
  if (typeof source !== 'string' || !TAGGED_IMAGE.test(source)) throw new Error(`INVALID_${label}_SOURCE`);
  if (typeof indexImage !== 'string' || !IMAGE.test(indexImage)) throw new Error(`UNPINNED_${label}_INDEX`);
  if (!record(images)) throw new Error(`MISSING_${label}_IMAGES`);
  const repository = repositoryOfTag(source);
  if (repositoryOfPinned(indexImage) !== repository) throw new Error(`MISMATCHED_${label}_REPOSITORY`);
  const pinned = {} as Record<CsoRuntimeBuildPlatform, string>;
  for (const platform of CSO_RUNTIME_PLATFORMS) {
    const image = images[platform];
    if (typeof image !== 'string' || !IMAGE.test(image)) throw new Error(`UNPINNED_${label}_IMAGE: ${platform}`);
    if (repositoryOfPinned(image) !== repository) throw new Error(`MISMATCHED_${label}_REPOSITORY`);
    pinned[platform] = image;
  }
  if (pinned['linux/amd64'] === pinned['linux/arm64']) throw new Error(`DUPLICATE_${label}_PLATFORM_MANIFEST`);
  return pinned;
}

/** Every declared stack must have both native platform manifests. */
export function imageBuildMatrix(input: unknown): { include: ImageBuildRow[] } {
  if (!record(input)) throw new Error('INVALID_BUILD_INPUTS');
  if (input.schemaVersion !== 1 || input.helperAbi !== 3) throw new Error('INCOMPATIBLE_BUILD_INPUTS');
  if (input.state !== 'reviewed') throw new Error('MISSING_REVIEWED_BUILD_INPUTS: review pinned images and exact tool versions before staging publication.');
  if (typeof input.revision !== 'string' || !REVISION.test(input.revision)) throw new Error('INVALID_BUILD_INPUT_REVISION');
  if (typeof input.reviewedAt !== 'string' || !Number.isFinite(Date.parse(input.reviewedAt))) throw new Error('MISSING_BUILD_INPUT_REVIEW');
  if (typeof input.reviewMethod !== 'string' || input.reviewMethod.length < 40 || input.reviewMethod.length > 500) throw new Error('MISSING_BUILD_INPUT_REVIEW');
  if (!record(input.sbomGenerator)) throw new Error('UNPINNED_SBOM_GENERATOR');
  const sbomImages = assertPinnedFamily(
    input.sbomGenerator.source,
    input.sbomGenerator.indexImage,
    input.sbomGenerator.images,
    'SBOM_GENERATOR',
  );
  if (!Array.isArray(input.profiles) || input.profiles.length !== CSO_RUNTIME_STACKS.length) throw new Error('INCOMPLETE_STACK_MATRIX');

  const rows: ImageBuildRow[] = [];
  const seenStacks = new Set<string>();
  const seenProfileIds = new Set<string>();
  for (const raw of input.profiles) {
    if (!record(raw)) throw new Error('INVALID_PROFILE');
    const { id, stack, source, indexImage, baseImages, versions } = raw;
    if (typeof id !== 'string' || !REVISION.test(id) || seenProfileIds.has(id)) throw new Error('INVALID_PROFILE_ID');
    seenProfileIds.add(id);
    if (typeof stack !== 'string' || !CSO_RUNTIME_STACKS.includes(stack as CsoRuntimeBuildStack) || seenStacks.has(stack)) throw new Error('INVALID_STACK');
    seenStacks.add(stack);
    const typedStack = stack as CsoRuntimeBuildStack;
    const bases = assertPinnedFamily(source, indexImage, baseImages, 'BASE');
    if (!record(versions)) throw new Error('MISSING_TOOL_VERSIONS');
    const exactVersion = (value: unknown) => typeof value === 'string' &&
      (typedStack === 'postgresql'
        ? /^\d+\.\d+(?:\.\d+)?(?:[.+_-][A-Za-z0-9.-]+)?$/
        : /^\d+\.\d+\.\d+(?:[.+_-][A-Za-z0-9.-]+)?$/).test(value);
    const expectedKeys = [...REQUIRED_VERSIONS[typedStack]].sort();
    const suppliedKeys = Object.keys(versions).sort();
    if (expectedKeys.join(',') !== suppliedKeys.join(',') || expectedKeys.some(key => !exactVersion(versions[key]))) throw new Error('UNPINNED_TOOL_VERSION');
    if (typedStack !== 'postgresql' && versions['cso-preparation'] !== '1.0.0') throw new Error('INCOMPATIBLE_PREPARATION_HELPER');

    let uvImages = {} as Record<CsoRuntimeBuildPlatform, string>;
    if (typedStack === 'python') uvImages = assertPinnedFamily(raw.uvSource, raw.uvIndexImage, raw.uvImages, 'UV');
    else if (raw.uvSource !== undefined || raw.uvIndexImage !== undefined || raw.uvImages !== undefined) throw new Error('UNEXPECTED_UV_IMAGE');

    for (const platform of CSO_RUNTIME_PLATFORMS) {
      const arch = platform === 'linux/amd64' ? 'amd64' : 'arm64';
      rows.push({
        inputRevision: input.revision,
        profileId: id,
        runtimeId: `${id}-${arch}`,
        stack: typedStack,
        platform,
        arch,
        runner: arch === 'amd64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm',
        baseSource: source as string,
        baseIndexImage: indexImage as string,
        baseImage: bases[platform],
        uvSource: typedStack === 'python' ? raw.uvSource as string : '',
        uvIndexImage: typedStack === 'python' ? raw.uvIndexImage as string : '',
        uvImage: typedStack === 'python' ? uvImages[platform] : '',
        sbomGeneratorSource: input.sbomGenerator.source as string,
        sbomGeneratorIndexImage: input.sbomGenerator.indexImage as string,
        sbomGeneratorImage: sbomImages[platform],
        versions: versions as Record<string, string>,
      });
    }
  }
  return { include: rows };
}

export function committedImageBuildMatrix(): { include: ImageBuildRow[] } {
  const file = resolve(import.meta.dir, '../lib/cso/images/build-inputs.json');
  return imageBuildMatrix(JSON.parse(readFileSync(file, 'utf8')));
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments accepted; build inputs come from the reviewed repository file.');
    process.stdout.write(JSON.stringify(committedImageBuildMatrix()) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'INVALID_BUILD_INPUTS') + '\n');
    process.exitCode = 1;
  }
}
