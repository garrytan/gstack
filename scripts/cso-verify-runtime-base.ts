#!/usr/bin/env bun
/** Native trusted-CI verification for reviewed OCI build inputs. */
import { spawnSync } from 'node:child_process';
import { committedImageBuildMatrix, type ImageBuildRow } from './cso-image-matrix';

const MAX_OUTPUT = 1024 * 1024;
const TIMEOUT = 120_000;

interface VersionProbe {
  image: string;
  executable: string;
  args: string[];
  version: string;
  name: string;
}

export function assertVersionOutput(name: string, expected: string, output: string): void {
  if (Buffer.byteLength(output) > 64 * 1024) throw new Error(`VERSION_OUTPUT_TOO_LARGE: ${name}`);
  const first = output.match(/(?<!\d)(\d+\.\d+(?:\.\d+)?)(?![\d.])/);
  if (!first || first[1] !== expected) throw new Error(`RUNTIME_VERSION_MISMATCH: ${name} expected ${expected}`);
}

export function probesForBuildRow(row: ImageBuildRow): VersionProbe[] {
  const base = row.baseImage;
  switch (row.stack) {
    case 'node':
      return [
        { image: base, executable: '/usr/local/bin/node', args: ['--version'], version: row.versions.node, name: 'node' },
        { image: base, executable: '/usr/local/bin/npm', args: ['--version'], version: row.versions.npm, name: 'npm' },
      ];
    case 'bun':
      return [{ image: base, executable: '/usr/local/bin/bun', args: ['--version'], version: row.versions.bun, name: 'bun' }];
    case 'python':
      return [
        { image: base, executable: '/usr/local/bin/python', args: ['--version'], version: row.versions.python, name: 'python' },
        { image: row.uvImage, executable: '/uv', args: ['--version'], version: row.versions.uv, name: 'uv' },
      ];
    case 'rails':
      return [
        { image: base, executable: '/usr/local/bin/ruby', args: ['--version'], version: row.versions.ruby, name: 'ruby' },
        { image: base, executable: '/usr/local/bin/bundle', args: ['--version'], version: row.versions.bundler, name: 'bundler' },
      ];
    case 'postgresql':
      return [{ image: base, executable: '/usr/lib/postgresql/17/bin/postgres', args: ['--version'], version: row.versions.postgresql, name: 'postgresql' }];
  }
}

function command(docker: string, args: string[], timeout = TIMEOUT): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  const result = spawnSync(docker, args, { encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT, env });
  if (result.error || result.status !== 0) {
    const message = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n').slice(0, 4096);
    throw new Error(`DOCKER_INPUT_VERIFICATION_FAILED: ${args[0]} ${message}`);
  }
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT) throw new Error('DOCKER_INPUT_VERIFICATION_OUTPUT_TOO_LARGE');
  return result.stdout;
}

function inspectManifest(docker: string, image: string): any {
  const raw = command(docker, ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Manifest}}']);
  try { return JSON.parse(raw); } catch { throw new Error(`INVALID_OCI_MANIFEST: ${image}`); }
}

function inspectImage(docker: string, image: string): any {
  const raw = command(docker, ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Image}}']);
  try { return JSON.parse(raw); } catch { throw new Error(`INVALID_OCI_IMAGE_CONFIG: ${image}`); }
}

function digestOf(image: string): string {
  return image.slice(image.lastIndexOf('@') + 1);
}

function assertSourceIndex(docker: string, source: string, indexImage: string, platformImage: string, row: ImageBuildRow): void {
  const sourceManifest = inspectManifest(docker, source);
  if (sourceManifest?.digest !== digestOf(indexImage)) throw new Error(`SOURCE_TAG_MOVED: ${source}`);
  const indexManifest = inspectManifest(docker, indexImage);
  const platformDigest = digestOf(platformImage);
  const match = indexManifest?.manifests?.find((manifest: any) =>
    manifest?.digest === platformDigest && manifest?.platform?.os === 'linux' && manifest?.platform?.architecture === row.arch);
  if (!match) throw new Error(`PLATFORM_MANIFEST_NOT_IN_INDEX: ${platformImage}`);
  const config = inspectImage(docker, platformImage);
  if (config?.os !== 'linux' || config?.architecture !== row.arch) throw new Error(`PLATFORM_CONFIG_MISMATCH: ${platformImage}`);
}

export function verifyRuntimeBuildRow(row: ImageBuildRow, docker = Bun.which('docker')): void {
  if (!docker || !docker.startsWith('/')) throw new Error('TRUSTED_DOCKER_NOT_FOUND');
  command(docker, ['--host', 'unix:///var/run/docker.sock', 'info'], 30_000);
  assertSourceIndex(docker, row.baseSource, row.baseIndexImage, row.baseImage, row);
  assertSourceIndex(docker, row.sbomGeneratorSource, row.sbomGeneratorIndexImage, row.sbomGeneratorImage, row);
  if (row.stack === 'python') assertSourceIndex(docker, row.uvSource, row.uvIndexImage, row.uvImage, row);
  const images = [...new Set(probesForBuildRow(row).map(probe => probe.image))];
  for (const image of images) command(docker, ['--host', 'unix:///var/run/docker.sock', 'pull', '--platform', row.platform, image], 5 * 60_000);
  for (const probe of probesForBuildRow(row)) {
    const output = command(docker, [
      '--host', 'unix:///var/run/docker.sock', 'run', '--rm', '--pull', 'never', '--network', 'none',
      '--entrypoint', probe.executable, probe.image, ...probe.args,
    ], 30_000);
    assertVersionOutput(probe.name, probe.version, output);
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments accepted; the selected row comes from committed inputs and trusted CI environment.');
    const stack = process.env.CSO_STACK;
    const platform = process.env.CSO_PLATFORM;
    const rows = committedImageBuildMatrix().include.filter(row => row.stack === stack && row.platform === platform);
    if (rows.length !== 1) throw new Error('INVALID_RUNTIME_BUILD_ROW');
    verifyRuntimeBuildRow(rows[0]);
    process.stdout.write(`verified ${rows[0].runtimeId} base manifests and versions\n`);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'RUNTIME_BASE_VERIFICATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
