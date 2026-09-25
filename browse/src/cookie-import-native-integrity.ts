import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export const NATIVE_QUALIFICATION_DATA = 'browse/src/cookie-import-native-qualification.json';
export const NATIVE_BROWSER_VERSION_COMMAND = '$ErrorActionPreference = "Stop"; [Diagnostics.FileVersionInfo]::GetVersionInfo($env:GSTACK_QUALIFY_BROWSER_EXE).ProductVersion';

export const NATIVE_CODE_INPUTS = Object.freeze([
  'browse/src/cookie-import-browser.ts',
  'browse/src/cookie-database.ts',
  'browse/src/cookie-import-native.ts',
  'browse/src/cookie-import-native-integrity.ts',
  'browse/src/cookie-import-native-job.ts',
  'browse/src/cookie-import-native-worker.ts',
  'browse/src/bun-polyfill.cjs',
  'browse/scripts/build-node-server.sh',
  '.github/scripts/run-cookie-native-qualification.ps1',
  'browse/dist/server-node.mjs',
  'browse/dist/bun-polyfill.cjs',
  'browse/test/cookie-import-native.test.ts',
  'browse/test/cookie-import-native-job.test.ts',
  'browse/test/cookie-import-native-qualification.ts',
  'browse/test/fixtures/native-cookie-process.cjs',
  'browse/test/fixtures/native-cookie-launch.cjs',
  'browse/test/fixtures/native-cookie-process-observer.ts',
  'browse/test/fixtures/native-cookie-file-owners.ts',
  'browse/test/fixtures/native-cookie-remove-fixture.cjs',
  'node_modules/playwright/package.json',
  'node_modules/playwright/index.js',
  'node_modules/playwright-core/package.json',
  'node_modules/playwright-core/index.js',
  'node_modules/playwright-core/lib/bootstrap.js',
  'node_modules/playwright-core/lib/coreBundle.js',
  'node_modules/playwright-core/lib/utilsBundle.js',
]);

export interface NativeQualifiedBuild {
  browserName: 'Chrome' | 'Chromium' | 'Brave' | 'Edge';
  architecture: 'x64' | 'arm64';
  windowsRelease: string;
  executableSha256: string;
  nodeVersion: string;
  bunVersion: string;
  playwrightVersion: string;
  sourceHashes: Record<string, string>;
}

async function readBoundedFile(file: string, deadline: number, maximumBytes: number): Promise<Buffer> {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error('native_timeout');
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), Math.max(0, deadline - Date.now()));
  const stream = createReadStream(file, { signal: cancellation.signal });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error('native_unqualified');
      chunks.push(chunk);
    }
    if (Date.now() >= deadline) throw new Error('native_timeout');
    return Buffer.concat(chunks);
  } catch (error) {
    if (cancellation.signal.aborted) throw new Error('native_timeout');
    throw error;
  } finally {
    stream.destroy();
    clearTimeout(timer);
  }
}

export async function readNativeQualifications(root: string, deadline: number): Promise<NativeQualifiedBuild[]> {
  const builds = JSON.parse((await readBoundedFile(path.join(root, NATIVE_QUALIFICATION_DATA), deadline, 1024 * 1024)).toString('utf8'));
  if (!Array.isArray(builds) || builds.some(build => !build || typeof build !== 'object')) throw new Error('native_unqualified');
  return builds;
}

export async function hashNativeFile(file: string, deadline: number): Promise<string> {
  return createHash('sha256').update(await readBoundedFile(file, deadline, 64 * 1024 * 1024)).digest('hex');
}

export async function nativeCodeHashes(root: string, deadline: number): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of NATIVE_CODE_INPUTS) hashes[file] = await hashNativeFile(path.join(root, file), deadline);
  return hashes;
}

export function nativeCodeMatches(expected: unknown, actual: Record<string, string>): boolean {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== NATIVE_CODE_INPUTS.length) return false;
  return NATIVE_CODE_INPUTS.every(file => {
    const hash = (expected as Record<string, unknown>)[file];
    return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) && hash === actual[file];
  });
}
