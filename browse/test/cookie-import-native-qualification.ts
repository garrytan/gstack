import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release, tmpdir } from 'node:os';
import path from 'node:path';
import { nativeBrowserPaths } from '../src/cookie-import-native';
import { nativeCookieEnvironment, probeNativeCookieMember } from '../src/cookie-import-native-worker';
import { hashNativeFile, nativeCodeHashes, nativeCodeMatches, NATIVE_BROWSER_VERSION_COMMAND, NATIVE_QUALIFICATION_DATA } from '../src/cookie-import-native-integrity';
import { createNativeCookieJob, NativeCookieJobError, nativeCookieDiagnostic, type NativeCookieDiagnostic, type NativeCookieJob } from '../src/cookie-import-native-job';

if (process.platform !== 'win32') {
  console.error('Native cookie qualification requires Windows; no cases ran and no qualification was issued.');
  process.exit(1);
}
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') {
  console.error('Native cookie qualification requires a disposable GitHub Actions runner and never uses an existing browser profile.');
  process.exit(1);
}

const output = mkdtempSync(path.join(process.argv[2] || tmpdir(), 'cookie-native-qualification-'));
function incomplete(reason: string, diagnostic?: NativeCookieDiagnostic): never {
  const receipt = { status: 'incomplete', reason, ...(diagnostic ? { diagnostic } : {}), counts: { pass: 0, fail: 0, skip: 0 }, activation: 'No build was qualified; production extraction remains disabled.' };
  writeFileSync(path.join(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ ...receipt, artifactDirectory: output }));
  process.exit(2);
}
if (Bun.version !== '1.4.0') incomplete('bun_1_4_0_required');
let emptyJob: NativeCookieJob | undefined;
try {
  emptyJob = await createNativeCookieJob();
  if (emptyJob.activeProcesses() !== 0) throw new NativeCookieJobError('job_query');
  emptyJob.terminate();
  if (emptyJob.activeProcesses() !== 0) throw new NativeCookieJobError('job_query');
  emptyJob.close();
  const preflight = { status: 'passed', activeProcesses: 0 };
  writeFileSync(path.join(output, 'job-preflight.json'), JSON.stringify(preflight, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ nativeJobPreflight: preflight }));
} catch (error) {
  const diagnostic = nativeCookieDiagnostic(error, 'job_create');
  try { emptyJob?.close(); } catch {}
  writeFileSync(path.join(output, 'job-preflight.json'), JSON.stringify({ status: 'failed', diagnostic }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  incomplete('native_job_preflight_failed', diagnostic);
}
const memberProbe = await probeNativeCookieMember();
const memberPreflight = 'cookies' in memberProbe ? { status: 'passed', activeProcesses: 0 } : { status: 'failed', error: memberProbe.error, diagnostic: memberProbe.diagnostic };
writeFileSync(path.join(output, 'member-preflight.json'), JSON.stringify(memberPreflight, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ nativeMemberPreflight: memberPreflight }));
if ('error' in memberProbe) incomplete('native_member_preflight_failed', memberProbe.diagnostic);
const root = path.resolve(import.meta.dir, '../..');
let sourceHashes: Record<string, string>;
try {
  sourceHashes = await nativeCodeHashes(root, Date.now() + 25_000);
} catch {
  incomplete('source_inputs_unavailable_or_timed_out');
}
const environment = nativeCookieEnvironment(process.env);
const browser = nativeBrowserPaths('Edge', environment);
const executable = browser.executables.find(existsSync);
const node = Bun.which('node');
if (!executable || !node) incomplete('node_or_edge_not_installed');
if (existsSync(browser.userDataDir)) incomplete('existing_default_profile_refused');
const executableSha256 = await hashNativeFile(executable, Date.now() + 25_000);
const nodeProbe = spawnSync(node, ['-p', 'JSON.stringify({ version: process.version, architecture: process.arch })'], { env: environment, encoding: 'utf8', timeout: 10_000, windowsHide: true });
if (nodeProbe.status !== 0) incomplete('node_runtime_preflight_failed');
const nodeInfo = JSON.parse(nodeProbe.stdout);
if (nodeInfo.architecture !== process.arch || !['x64', 'arm64'].includes(process.arch)) incomplete('runtime_architecture_mismatch');
const require = createRequire(import.meta.url);
const playwrightVersion = require('playwright/package.json').version;
if (playwrightVersion !== '1.62.1') incomplete('playwright_1_62_1_required');
const versionProbe = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
  '-NoProfile', '-NonInteractive', '-Command', NATIVE_BROWSER_VERSION_COMMAND,
], { env: { ...environment, GSTACK_QUALIFY_BROWSER_EXE: executable }, encoding: 'utf8', timeout: 10_000, windowsHide: true });
const versionErrorCode = (versionProbe.error as NodeJS.ErrnoException | undefined)?.code;
const versionMetadata = {
  exitCode: versionProbe.status,
  signal: versionProbe.signal,
  spawnError: versionProbe.error ? (['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(versionErrorCode || '') ? versionErrorCode : 'spawn_failed') : undefined,
  stdoutBytes: Buffer.byteLength(versionProbe.stdout || ''),
  stderrBytes: Buffer.byteLength(versionProbe.stderr || ''),
  versionValid: /^\d+(?:\.\d+){2,3}$/.test((versionProbe.stdout || '').trim()),
};
writeFileSync(path.join(output, 'browser-version-preflight.json'), JSON.stringify(versionMetadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ nativeBrowserVersionPreflight: versionMetadata }));
if (versionProbe.status !== 0 || !versionMetadata.versionValid) incomplete('browser_version_preflight_failed');
const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=NUL', 'test', 'browse/test/cookie-import-native-job.test.ts', '--test-name-pattern', '^native Windows process qualification'], {
  cwd: root,
  env: { ...environment, CI: 'true', GITHUB_ACTIONS: 'true', GSTACK_COOKIE_NATIVE_DEFAULT_FIXTURE: '1', NO_COLOR: '1' },
  encoding: 'utf8',
  timeout: 300_000,
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true,
});
const log = `${result.stdout || ''}\n${result.stderr || ''}`;
writeFileSync(path.join(output, 'qualification.log'), log, { mode: 0o600, flag: 'wx' });
const count = (kind: string) => Number([...log.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}\\b`, 'g'))].at(-1)?.[1] ?? 0);
const counts = { pass: count('pass'), fail: count('fail'), skip: count('skip') };
let inputsUnchanged = false;
try {
  const deadline = Date.now() + 25_000;
  inputsUnchanged = await hashNativeFile(executable, deadline) === executableSha256 && nativeCodeMatches(sourceHashes, await nativeCodeHashes(root, deadline));
} catch {}
const passed = result.status === 0 && !result.error && counts.pass === 7 && counts.fail === 0 && counts.skip === 0 && inputsUnchanged && !existsSync(browser.userDataDir);
const receipt = {
  status: passed ? 'passed' : 'failed',
  scope: 'Edge default-profile v20 extraction, pipe transport, profile identity, and owned-process cleanup',
  qualifiedBuild: {
    browserName: 'Edge',
    architecture: nodeInfo.architecture,
    windowsRelease: release(),
    executableSha256,
    nodeVersion: nodeInfo.version,
    bunVersion: Bun.version,
    playwrightVersion,
    sourceHashes,
  },
  browserVersion: versionProbe.stdout.trim(),
  supervisorArchitecture: process.arch,
  jobPreflight: { status: 'passed', activeProcesses: 0 },
  memberPreflight,
  counts,
  inputsUnchanged,
  sourceHashes,
  activationData: NATIVE_QUALIFICATION_DATA,
  activation: 'Review this receipt and add only this exact qualifiedBuild to the separate activation data; the runner never enables extraction and activation does not modify the recorded code hashes.',
};
writeFileSync(path.join(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: receipt.status, counts, artifactDirectory: output }));
process.exitCode = passed ? 0 : 1;
