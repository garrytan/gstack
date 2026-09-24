import { createHash, randomBytes } from 'node:crypto';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, createReadStream, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, release } from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dirname, '../..');
export const DIA_DOWNLOAD = 'https://releases.diabrowser.com/release/Dia-latest.dmg';
export const FRESH_WORK_PREFIX = '/private/tmp/dn-';

export interface FreshAccount {
  work: string; home: string; temporary: string; snapshot: string; bun: string; destinationExecutable?: string;
  uid: number; gid: number; account: string; guid: string; groupGuid: string; label: string;
  sourceRevision: string; archiveSha256: string; bunSha256: string; destinationSha256?: string;
  configFile: string; environment: Record<string, string>;
  launchComparison?: { mode: 'launch-only'; runtime: 'bun' | 'node'; executable: string; executableSha256: string;
    driverSha256: string; helpersSha256: string };
  guiReadiness?: { mode: 'gui-readiness-only'; executable: string; executableSha256: string; sourceSha256: string };
}

export function parseDirectoryRecord(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.trim().split('\n')) {
    const match = line.match(/^([A-Za-z]+):\s+(.+)$/);
    if (!match || Object.hasOwn(result, match[1])) throw new Error('invalid_directory_record');
    result[match[1]] = match[2].trim();
  }
  return result;
}

export function ownsFreshAccount(record: Record<string, string>, account: Pick<FreshAccount, 'guid' | 'uid' | 'gid' | 'home'>): boolean {
  return record.GeneratedUID?.toUpperCase() === account.guid.toUpperCase() && record.UniqueID === String(account.uid)
    && record.PrimaryGroupID === String(account.gid) && record.NFSHomeDirectory === account.home;
}

export function validateGuiReadinessAuthority(account: FreshAccount, role: 'coordinator' | 'comparison-driver') {
  if (account.guiReadiness === undefined) return;
  if (!account.guiReadiness || account.guiReadiness.mode !== 'gui-readiness-only' || account.launchComparison !== undefined
    || account.destinationExecutable !== undefined || account.destinationSha256 !== undefined || role !== 'coordinator'
    || account.guiReadiness.executable !== path.join(account.work, 'bin/gui-readiness')
    || ![account.guiReadiness.executableSha256, account.guiReadiness.sourceSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('gui_readiness_authority_invalid');
  }
}

export function readFreshAccountConfiguration(configFile: string, role: 'coordinator' | 'comparison-driver' = 'coordinator'): FreshAccount {
  const work = path.dirname(configFile);
  if (!path.isAbsolute(configFile) || path.basename(configFile) !== 'account.json' || path.dirname(work) !== '/private/tmp'
    || !path.basename(work).startsWith(path.basename(FRESH_WORK_PREFIX)) || realpathSync(work) !== work) throw new Error('unsafe_fresh_account_configuration');
  const parent = lstatSync(work);
  const info = lstatSync(configFile);
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0 || !info.isFile() || info.uid !== 0
    || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size > 64 * 1024 || realpathSync(configFile) !== configFile) throw new Error('unsafe_fresh_account_configuration');
  const account: FreshAccount = JSON.parse(readFileSync(configFile, 'utf8'));
  validateGuiReadinessAuthority(account, role);
  if (role === 'comparison-driver' && (!account.launchComparison || account.launchComparison.mode !== 'launch-only'
    || !['bun', 'node'].includes(account.launchComparison.runtime)
    || account.launchComparison.executable !== path.join(work, 'bin', account.launchComparison.runtime)
    || ![account.launchComparison.executableSha256, account.launchComparison.driverSha256, account.launchComparison.helpersSha256]
      .every(value => /^[a-f0-9]{64}$/.test(value)))) throw new Error('comparison_driver_authority_missing');
  const expectedRuntime = role === 'comparison-driver' ? account.launchComparison!.executable : account.bun;
  if (account.work !== work || account.configFile !== configFile || account.home !== path.join(work, 'home')
    || account.temporary !== path.join(work, 'tmp') || account.snapshot !== repository || account.snapshot !== path.join(work, 'repo')
    || account.bun !== path.join(work, 'bin/bun') || realpathSync(process.execPath) !== expectedRuntime
    || !Number.isSafeInteger(account.uid) || account.uid < 20_000 || account.uid >= 60_000 || account.gid !== account.uid
    || process.getuid?.() !== account.uid || process.geteuid?.() !== account.uid || process.getgid?.() !== account.gid
    || !/^[a-z][a-z0-9]{8,24}$/.test(account.account) || !/^[A-F0-9-]{36}$/.test(account.guid)
    || process.env.GSTACK_DIA_EXPECT_UID !== String(account.uid) || process.env.GSTACK_DIA_SOURCE_REVISION !== account.sourceRevision
    || realpathSync(homedir()) !== account.home || realpathSync(process.env.HOME!) !== account.home
    || realpathSync(process.env.RUNNER_TEMP!) !== account.temporary) throw new Error('fresh_identity_mismatch');
  for (const directory of [account.home, account.temporary, account.snapshot]) {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.uid !== account.uid || (entry.mode & 0o022) !== 0 || realpathSync(directory) !== directory) throw new Error('fresh_directory_ownership_mismatch');
  }
  if (!account.guiReadiness && (typeof account.destinationExecutable !== 'string' || !/^[a-f0-9]{64}$/.test(account.destinationSha256 ?? '')
    || !account.destinationExecutable.startsWith(path.join(work, 'browser') + path.sep)
    || realpathSync(account.destinationExecutable) !== account.destinationExecutable)) throw new Error('staged_executable_escape');
  return account;
}

export function parseGuiReadiness(value: unknown, browserRootsExpected: boolean) {
  const exact = (item: any, keys: string[]) => item !== null && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));
  const nullableBoolean = (item: unknown) => item === null || typeof item === 'boolean';
  const result: any = value;
  if (!exact(result, ['protocol', 'supported', 'identity', 'security', 'quartz', 'browserRoots']) || result.protocol !== 1 || result.supported !== true
    || !exact(result.identity, ['effectiveUidMatches', 'homeMatchesRegistered']) || Object.values(result.identity).some(item => typeof item !== 'boolean')
    || !exact(result.security, ['status', 'graphicAccess', 'rootSession', 'tty', 'remote']) || !Number.isInteger(result.security.status)
    || result.security.status < -2_147_483_648 || result.security.status > 2_147_483_647
    || ['graphicAccess', 'rootSession', 'tty', 'remote'].some(key => result.security.status === 0 ? typeof result.security[key] !== 'boolean' : result.security[key] !== null)
    || !exact(result.quartz, ['present', 'sameUid', 'loginDone', 'onConsole']) || typeof result.quartz.present !== 'boolean'
    || ['sameUid', 'loginDone', 'onConsole'].some(key => !nullableBoolean(result.quartz[key]))
    || (!result.quartz.present && ['sameUid', 'loginDone', 'onConsole'].some(key => result.quartz[key] !== null))
    || (result.quartz.sameUid !== true && (result.quartz.loginDone !== null || result.quartz.onConsole !== null))) throw new Error('invalid_gui_readiness_receipt');
  if (browserRootsExpected && result.identity.homeMatchesRegistered) {
    if (!exact(result.browserRoots, ['chrome', 'chromium', 'arc', 'dia', 'comet', 'brave', 'edge', 'safari', 'cookies'])) throw new Error('invalid_gui_readiness_receipt');
    for (const fact of Object.values(result.browserRoots) as any[]) {
      if (!exact(fact, ['state', 'kind', 'ownerMatches', 'ancestorBlocked']) || !['present', 'absent', 'unavailable'].includes(fact.state)
        || ![null, 'directory', 'file', 'symlink', 'other'].includes(fact.kind) || !nullableBoolean(fact.ownerMatches) || typeof fact.ancestorBlocked !== 'boolean'
        || (fact.state === 'absent' && (fact.kind !== null || fact.ownerMatches !== null || fact.ancestorBlocked))
        || (fact.state === 'present' && (fact.kind === null || typeof fact.ownerMatches !== 'boolean' || fact.ancestorBlocked))
        || (fact.kind === null && fact.ownerMatches !== null)) throw new Error('invalid_gui_readiness_receipt');
    }
  } else if (result.browserRoots !== null) throw new Error('invalid_gui_readiness_receipt');
  return { ...result, usableGui: result.identity.effectiveUidMatches && result.identity.homeMatchesRegistered
    && result.security.status === 0 && result.security.graphicAccess && result.quartz.present && result.quartz.sameUid === true && result.quartz.loginDone === true };
}

export async function runGuiReadiness(executable: string, executableSha256: string, source: string, sourceSha256: string,
  browserRoots: boolean, env: Record<string, string>, milliseconds = 5000, execute: typeof spawnSync = spawnSync) {
  if (!Number.isFinite(milliseconds) || milliseconds < 1) throw new Error('gui_readiness_budget_exhausted');
  const deadline = performance.now() + Math.min(5000, milliseconds);
  if (await sha256(executable) !== executableSha256 || await sha256(source) !== sourceSha256) throw new Error('gui_readiness_inputs_changed');
  const timeout = Math.floor(deadline - performance.now());
  if (timeout < 1) throw new Error('gui_readiness_budget_exhausted');
  const result = execute(executable, browserRoots ? ['--browser-roots'] : [], { env, encoding: 'utf8', timeout,
    killSignal: 'SIGKILL', maxBuffer: 16 * 1024 });
  const execution = { exitCode: result.status, timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || '') };
  if (result.error || result.status !== 0) return { available: false, reason: 'gui_readiness_probe_failed', execution };
  try { return { available: true, observation: parseGuiReadiness(JSON.parse(result.stdout), browserRoots), execution }; }
  catch { return { available: false, reason: 'gui_readiness_receipt_rejected', execution }; }
}

export function safeDiaComparisonResponse(value: unknown): boolean {
  const keys = new Set(['protocol', 'purpose', 'stage', 'launchReturned', 'protocolResponded', 'ready', 'timedOut', 'error', 'samplingEnabled',
    'cleanup', 'startupPages', 'postProbePages', 'argvSha256', 'environmentSha256', 'rootCount', 'launchAttempts', 'rootsBeforeCleanup',
    'stderrBeforeCleanup', 'stderrAfterCleanup', 'rootsAfterCleanup', 'driver', 'childClosed', 'groupAbsent', 'launchSettled', 'confirmed', 'groups', 'pid', 'signalSent',
    'absenceConfirmed', 'childCloseObserved', 'failed', 'initialSignalFailure', 'reason', 'code', 'errno', 'closeObserved', 'exitCode', 'signal',
    'count', 'categories', 'truncated', 'allowed', 'admissionOpen', 'argumentsArray', 'pipeFlag', 'profileArgumentCount', 'expectedProfile',
    'detached', 'shellDisabled', 'stdioCount', 'extraPipeDescriptors', 'headlessFlag', 'blankStartupArgument', 'tcpDebuggingFlag', 'mockKeychainFlag',
    'passwordStoreFlag', 'firstRunSuppressed', 'sandboxRequired', 'sandboxDisablingFlag', 'available', 'bytesSeen', 'bytesInspected',
    'discardedLongLines', 'ended', 'reasonCounts', ...Object.keys(BROWSER_STDERR_REASONS), 'runtime', 'version', 'architecture', 'os', 'release',
    'executableSha256', 'driverSha256', 'helpersSha256', 'playwright']);
  const strings = new Set(['control', 'source', 'runtime_import', 'launch', 'ownership', 'startup_pages', 'protocol_probe', 'ready',
    'probe_before_signal', 'signal', 'join_child_close', 'probe_after_signal', 'completed', 'signal_or_probe_failed', 'cleanup_deadline',
    'child_close_timeout', 'child_close_unconfirmed', 'group_still_live', 'ESRCH', 'EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'ETIMEDOUT',
    'unclassified', 'SIGABRT', 'SIGTRAP', 'SIGSEGV', 'SIGBUS', 'SIGKILL', 'SIGTERM', 'SIGILL', 'other', 'blank', 'other_about',
    'chromium_new_tab', 'chromium_onboarding', 'chromium_internal', 'dia_internal', 'extension', 'loopback_web', 'external_web', 'file',
    'data', 'other_scheme', 'invalid', 'bun', 'node', 'arm64', 'darwin', ...Object.keys(BROWSER_STDERR_REASONS), 'module_unavailable',
    'module_export_unavailable', 'module_format_error', 'launch_policy_rejected', 'ownership_unconfirmed', 'startup_page_rejected',
    'render_mismatch', 'operation_timeout', 'executable_unavailable', 'permission_denied', 'invalid_runtime_range', 'runtime_type_error',
    'target_closed', 'protocol_error', 'unclassified_browser_error']);
  const safe = (item: unknown): boolean => item === null || typeof item === 'boolean'
    || (typeof item === 'number' && Number.isSafeInteger(item))
    || (typeof item === 'string' && (strings.has(item) || /^[a-f0-9]{64}$/.test(item) || /^\d{1,3}(?:\.\d{1,3}){1,2}$/.test(item)))
    || (Array.isArray(item) && item.length <= 64 && item.every(safe))
    || (typeof item === 'object' && !Array.isArray(item) && item !== null && Object.entries(item).every(([key, child]) => keys.has(key) && safe(child)));
  return safe(value);
}

export async function runDiaLaunchComparison(account: FreshAccount, purpose: 'control' | 'source', source?: {
  assetRoot: string; executableName: string; executableSha256: string;
}, execute: typeof spawnSync = spawnSync, milliseconds = 40_000) {
  const deadline = performance.now() + Math.min(40_000, milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(deadline) || milliseconds < 1) throw new Error('comparison_budget_exhausted');
  const config = account.launchComparison;
  if (!config || config.mode !== 'launch-only' || !['bun', 'node'].includes(config.runtime)
    || config.executable !== path.join(account.work, 'bin', config.runtime)) throw new Error('comparison_driver_authority_missing');
  if (await sha256(config.executable) !== config.executableSha256
    || await sha256(path.join(account.snapshot, '.github/scripts/dia-launch-driver.mjs')) !== config.driverSha256
    || await sha256(path.join(account.snapshot, '.github/scripts/qualify-dia-macos.ts')) !== config.helpersSha256) throw new Error('comparison_driver_inputs_changed');
  const args = [...(config.runtime === 'bun' ? ['--no-env-file', '--no-install', '--no-macros', '--config=/dev/null'] : []),
    path.join(account.snapshot, '.github/scripts/dia-launch-driver.mjs'), account.configFile];
  const timeout = Math.floor(deadline - performance.now());
  if (timeout < 1) throw new Error('comparison_budget_exhausted');
  const result = execute(config.executable, args, { env: account.environment, cwd: account.snapshot,
    input: JSON.stringify({ purpose, ...source }), encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
  const failed = { protocol: 1, purpose, ready: false, launchReturned: false, error: 'driver_exchange_failed',
    cleanup: { confirmed: false }, supervisor: { closed: !result.error && result.status !== null, exitCode: result.status,
      timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', stderrBytes: Buffer.byteLength(result.stderr || '') } };
  if (result.error || result.status !== 0) return failed;
  try {
    const response = JSON.parse(result.stdout);
    const keys = ['protocol', 'purpose', 'stage', 'launchReturned', 'protocolResponded', 'ready', 'timedOut', 'error', 'samplingEnabled', 'cleanup', 'startupPages', 'postProbePages',
      'argvSha256', 'environmentSha256', 'rootCount', 'launchAttempts', 'rootsBeforeCleanup', 'stderrBeforeCleanup', 'stderrAfterCleanup', 'rootsAfterCleanup', 'driver'];
    if (!response || !safeDiaComparisonResponse(response) || Object.keys(response).some(key => !keys.includes(key)) || response.protocol !== 1 || response.purpose !== purpose
      || response.samplingEnabled !== false || response.driver?.runtime !== config.runtime
      || response.driver?.version !== (config.runtime === 'bun' ? '1.4.0' : '24.18.0') || response.driver?.architecture !== 'arm64'
      || response.driver?.os !== 'darwin' || response.driver?.playwright !== '1.62.1'
      || response.driver?.executableSha256 !== config.executableSha256 || response.driver?.driverSha256 !== config.driverSha256
      || response.driver?.helpersSha256 !== config.helpersSha256 || typeof response.ready !== 'boolean'
      || typeof response.launchReturned !== 'boolean' || typeof response.cleanup?.confirmed !== 'boolean') return failed;
    if (response.ready && (response.launchReturned !== true || response.protocolResponded !== true
      || response.startupPages?.allowed !== true || response.postProbePages?.allowed !== true)) return failed;
    if (response.cleanup.confirmed && (response.cleanup.childClosed !== true || response.cleanup.groupAbsent !== true || response.cleanup.launchSettled !== true || response.rootCount !== 1
      || response.cleanup.groups?.length !== 1 || response.cleanup.groups[0].absenceConfirmed !== true || response.cleanup.groups[0].childCloseObserved !== true
      || response.rootsAfterCleanup?.length !== 1 || response.rootsAfterCleanup[0].closeObserved !== true
      || response.launchAttempts?.length !== 1 || response.launchAttempts[0].sandboxRequired !== true || response.launchAttempts[0].sandboxDisablingFlag !== false
      || response.launchAttempts[0].pipeFlag !== true || !/^[a-f0-9]{64}$/.test(response.argvSha256) || !/^[a-f0-9]{64}$/.test(response.environmentSha256))) return failed;
    return { ...response, supervisor: { closed: true, exitCode: 0, timedOut: false, stderrBytes: Buffer.byteLength(result.stderr || '') } };
  } catch { return failed; }
}

export function createOwnedDiaProfile(home: string) {
  const uid = process.getuid?.();
  for (const directory of [home, path.join(home, 'Library'), path.join(home, 'Library/Application Support')]) {
    try { lstatSync(directory); } catch (error: any) {
      if (error.code !== 'ENOENT' || directory === home) throw error;
      mkdirSync(directory, { mode: 0o700 });
    }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0 || realpathSync(directory) !== directory) throw new Error('unsafe_profile_ancestor');
  }
  const browserRoot = path.join(home, 'Library/Application Support/Dia');
  mkdirSync(browserRoot, { mode: 0o700 });
  const profile = path.join(browserRoot, 'User Data');
  mkdirSync(profile, { mode: 0o700 });
  const info = lstatSync(profile, { bigint: true });
  const nonce = randomBytes(32).toString('hex');
  writeFileSync(path.join(profile, '.gstack-dia-owner'), nonce, { mode: 0o600, flag: 'wx' });
  return { home, profile, uid, dev: info.dev, ino: info.ino, nonce };
}

export function assertOwnedDiaProfile(ownership: ReturnType<typeof createOwnedDiaProfile>) {
  const { home, profile, uid, dev, ino, nonce } = ownership;
  if (uid === undefined || uid !== process.getuid?.() || profile !== path.join(home, 'Library/Application Support/Dia/User Data')
    || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error('profile_ownership_unconfirmed');
  for (const directory of [home, path.join(home, 'Library'), path.join(home, 'Library/Application Support'), path.dirname(profile), profile]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0 || realpathSync(directory) !== directory) throw new Error('profile_ownership_unconfirmed');
  }
  const info = lstatSync(profile, { bigint: true });
  if (info.dev !== dev || info.ino !== ino) throw new Error('profile_ownership_unconfirmed');
  const fd = openSync(path.join(profile, '.gstack-dia-owner'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const marker = fstatSync(fd);
    if (!marker.isFile() || marker.uid !== uid || marker.nlink !== 1 || (marker.mode & 0o077) !== 0 || marker.size !== 64) throw new Error('profile_ownership_unconfirmed');
    const buffer = Buffer.alloc(65);
    if (readSync(fd, buffer, 0, 65, 0) !== 64 || buffer.subarray(0, 64).toString() !== nonce) throw new Error('profile_ownership_unconfirmed');
    const after = fstatSync(fd);
    if (after.size !== marker.size || after.mtimeMs !== marker.mtimeMs || after.ctimeMs !== marker.ctimeMs) throw new Error('profile_ownership_unconfirmed');
  } finally { closeSync(fd); }
}

export function removeOwnedDiaProfile(ownership: ReturnType<typeof createOwnedDiaProfile>, browsersStopped: boolean) {
  if (!browsersStopped) throw new Error('owned_browsers_not_stopped');
  assertOwnedDiaProfile(ownership);
  rmSync(ownership.profile, { recursive: true });
  try { lstatSync(ownership.profile); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('owned_profile_still_present');
}

export function assertDiaSocketPath(sourceProfile: string): void {
  if (Buffer.byteLength(path.join(sourceProfile, 'SingletonSocket')) >= 100) throw new Error('fixture_socket_path_too_long');
}

export function inspectMachOArchitectures(file: string, milliseconds = 10_000) {
  if (!Number.isFinite(milliseconds) || milliseconds < 1) throw new Error('macho_read_budget_exhausted');
  const deadline = performance.now() + milliseconds;
  if (realpathSync(file) !== file) throw new Error('unsafe_macho_file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytesRead = 0;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 8n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsafe_macho_file');
    const size = Number(before.size);
    const read = (offset: number, length: number) => {
      if (performance.now() >= deadline || bytesRead + length > 4096) throw new Error('macho_read_budget_exhausted');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size - length) throw new Error('invalid_macho_header');
      const buffer = Buffer.alloc(length);
      if (readSync(fd, buffer, 0, length, offset) !== length) throw new Error('invalid_macho_header');
      bytesRead += length;
      return buffer;
    };
    const thin = (offset: number, sliceSize: number, expectedCpu?: number, expectedSubtype?: number) => {
      const magic = read(offset, 4).readUInt32BE(0);
      const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
      const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
      if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) throw new Error('invalid_macho_header');
      const headerSize = wide ? 32 : 28;
      if (sliceSize < headerSize) throw new Error('invalid_macho_header');
      const header = read(offset, headerSize);
      const word = (at: number) => little ? header.readUInt32LE(at) : header.readUInt32BE(at);
      const cpu = word(4);
      const subtype = word(8);
      if ((expectedCpu !== undefined && cpu !== expectedCpu) || (expectedSubtype !== undefined && subtype !== expectedSubtype)
        || Boolean(cpu & 0x01000000) !== wide || word(12) !== 2 || word(20) > sliceSize - headerSize
        || word(16) * 8 > word(20) || word(20) % (wide ? 8 : 4) !== 0) throw new Error('invalid_macho_header');
      const names: Record<string, string> = { '7:3': 'i386', '16777223:3': 'x86_64', '16777223:8': 'x86_64h',
        '16777228:0': 'arm64', '16777228:1': 'arm64v8', '16777228:2': 'arm64e' };
      const architecture = names[cpu + ':' + (subtype & 0x00ffffff)];
      if (!architecture) throw new Error('unsupported_macho_architecture');
      return architecture;
    };
    const header = read(0, 8);
    const magic = header.readUInt32BE(0);
    const fat = [0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic);
    const architectures: string[] = [];
    let format = 'thin';
    if (!fat) architectures.push(thin(0, size));
    else {
      const little = magic === 0xbebafeca || magic === 0xbfbafeca;
      const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
      format = wide ? 'fat64' : 'fat32';
      const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
      if (count < 1 || count > 32) throw new Error('invalid_macho_header');
      const entrySize = wide ? 32 : 20;
      const tableEnd = 8 + count * entrySize;
      const table = read(8, count * entrySize);
      const word = (at: number) => little ? table.readUInt32LE(at) : table.readUInt32BE(at);
      const wideWord = (at: number) => little ? table.readBigUInt64LE(at) : table.readBigUInt64BE(at);
      const ranges: Array<{ offset: bigint; end: bigint }> = [];
      for (let index = 0; index < count; index++) {
        const at = index * entrySize;
        const offset = wide ? wideWord(at + 8) : BigInt(word(at + 8));
        const sliceSize = wide ? wideWord(at + 16) : BigInt(word(at + 12));
        const align = word(at + (wide ? 24 : 16));
        const end = offset + sliceSize;
        if (offset < BigInt(tableEnd) || sliceSize < 28n || end > before.size || align > 63
          || offset % (1n << BigInt(align)) !== 0n || (wide && word(at + 28) !== 0)
          || ranges.some(range => offset < range.end && end > range.offset)) throw new Error('invalid_macho_header');
        ranges.push({ offset, end });
        const architecture = thin(Number(offset), Number(sliceSize), word(at), word(at + 4));
        if (architectures.includes(architecture)) throw new Error('invalid_macho_header');
        architectures.push(architecture);
      }
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.dev !== before.dev || current.ino !== before.ino
      || !current.isFile() || realpathSync(file) !== file) throw new Error('macho_changed_during_inspection');
    if (performance.now() >= deadline) throw new Error('macho_read_budget_exhausted');
    return { method: 'bounded_macho_headers', format, architectures, slices: architectures.length, bytesRead };
  } finally { closeSync(fd); }
}

export function writePrivateReceipt(file: string, value: unknown, replace = false): void {
  const directory = path.dirname(file);
  const owner = process.getuid?.();
  const parent = lstatSync(directory);
  if (!path.isAbsolute(file) || path.resolve(file) !== file || realpathSync(directory) !== directory
    || !parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o022) !== 0) throw new Error('unsafe_receipt_directory');
  if (replace && existsSync(file)) {
    const previous = lstatSync(file);
    if (!previous.isFile() || previous.uid !== owner || realpathSync(file) !== file || (previous.mode & 0o022) !== 0) throw new Error('unsafe_receipt_replacement');
  }
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('receipt_too_large');
  const temporary = path.join(directory, '.dia-receipt-' + randomBytes(12).toString('hex') + '.json');
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  try {
    if (replace) renameSync(temporary, file);
    else linkSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function validateQualificationHost(env: NodeJS.ProcessEnv, platform = process.platform, architecture = process.arch): void {
  if (platform !== 'darwin' || architecture !== 'arm64' || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'macOS' || env.RUNNER_ARCH !== 'ARM64'
    || env.GSTACK_DIA_NATIVE_QUALIFY !== '1' || !env.RUNNER_TEMP || !env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT) {
    throw new Error('disposable_arm64_macos_ci_required');
  }
}

export function nativeDiaLaunchOptions(executablePath: string, env: Record<string, string>) {
  return {
    executablePath, env, headless: true, chromiumSandbox: true, timeout: 30_000, serviceWorkers: 'block' as const,
    ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic', '--no-first-run'],
    args: ['--disable-sync', '--no-default-browser-check', '--profile-directory=Default'],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  };
}

export function hasSandboxDisablingArgument(args: string[]): boolean {
  return args.some((arg, index) => /^--(?:no-sandbox|no-zygote-sandbox|disable-(?:[a-z0-9-]+-)?sandbox|single-process|in-process-gpu)(?:=|$)/i.test(arg)
    || (/^--disable-features(?:=|$)/i.test(arg) && /sandbox/i.test(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1] ?? '')));
}

export function allowedFixturePage(url: string, origin: string): boolean {
  if (url === 'about:blank') return true;
  try { const page = new URL(url); return !page.username && !page.password && page.origin === origin && new URL(origin).hostname === '127.0.0.1'; }
  catch { return false; }
}

export function browserStartupCategory(value: string): string {
  if (value === 'about:blank') return 'blank';
  try {
    const url = new URL(value);
    if (url.protocol === 'about:') return 'other_about';
    if (url.protocol === 'chrome:' || url.protocol === 'chrome-untrusted:') {
      if (['newtab', 'new-tab-page'].includes(url.hostname)) return 'chromium_new_tab';
      if (['intro', 'welcome', 'first-run', 'signin', 'sync-confirmation', 'profile-picker'].includes(url.hostname)) return 'chromium_onboarding';
      return 'chromium_internal';
    }
    if (url.protocol === 'dia:') return 'dia_internal';
    if (url.protocol === 'chrome-extension:') return 'extension';
    if (['http:', 'https:'].includes(url.protocol)) return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? 'loopback_web' : 'external_web';
    if (url.protocol === 'file:') return 'file';
    if (url.protocol === 'data:') return 'data';
    return 'other_scheme';
  } catch { return 'invalid'; }
}

const BROWSER_STDERR_REASONS = {
  default_profile_policy: /DevTools remote debugging requires a non-default data directory\./i,
  debugging_pipe_unavailable: /Remote debugging pipe file descriptors are not open\./i,
  keychain_interaction_disallowed: /\berrSecInteractionNotAllowed\b|User interaction is not allowed\./,
  keychain_interaction_required: /\berrSecInteractionRequired\b/,
  keychain_access_failed: /\berrSecAuthFailed\b|KeychainReauthorize failed\. Cannot retrieve item\./,
  dynamic_library_error: /Library not loaded:|dyld(?:\[\d+\])?:|no suitable image found/i,
  code_signing_error: /code signature (?:invalid|not valid)|mapped file has no cdhash|library load disallowed by system policy|CODESIGNING/i,
  graphics_or_bootstrap_error: /(?:CGSConnection|WindowServer|bootstrap_check_in)[^\r\n]{0,160}(?:failed|failure|denied|invalid)|Failed to (?:connect to|initialize) (?:the )?WindowServer/i,
  browser_profile_unavailable: /ProcessSingleton|SingletonLock|user data directory is already in use/i,
} as const;

type BrowserStderrReason = keyof typeof BROWSER_STDERR_REASONS;

export function browserStderrReasons(text: string): BrowserStderrReason[] {
  const bounded = text.slice(0, 65_536);
  return (Object.keys(BROWSER_STDERR_REASONS) as BrowserStderrReason[]).filter(reason => BROWSER_STDERR_REASONS[reason].test(bounded));
}

export function createBrowserStderrCapture() {
  const reasonCounts = Object.fromEntries(Object.keys(BROWSER_STDERR_REASONS).map(reason => [reason, 0])) as Record<BrowserStderrReason, number>;
  let bytesSeen = 0;
  let bytesInspected = 0;
  let pending = '';
  let droppingLine = false;
  let discardedLongLines = 0;
  let ended = false;
  const classify = (line: string) => { for (const reason of browserStderrReasons(line)) reasonCounts[reason]++; };
  return {
    consume(chunk: Buffer | string) {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      bytesSeen = Math.min(Number.MAX_SAFE_INTEGER, bytesSeen + size);
      const remaining = 65_536 - bytesInspected;
      if (remaining < 1) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk.subarray(0, remaining) : Buffer.from(chunk.slice(0, remaining)).subarray(0, remaining);
      bytesInspected += buffer.length;
      for (const character of buffer.toString('utf8')) {
        if (character === '\n') {
          if (!droppingLine) classify(pending);
          pending = '';
          droppingLine = false;
        } else if (!droppingLine) {
          pending += character;
          if (pending.length >= 4096) {
            classify(pending);
            pending = '';
            droppingLine = true;
            discardedLongLines++;
          }
        }
      }
    },
    end() { if (!droppingLine) classify(pending); pending = ''; ended = true; },
    clear() { pending = ''; },
    snapshot() {
      const counts = { ...reasonCounts };
      if (!droppingLine) for (const reason of browserStderrReasons(pending)) counts[reason]++;
      return { bytesSeen, bytesInspected, truncated: bytesSeen > bytesInspected || discardedLongLines > 0, discardedLongLines, ended, reasonCounts: counts };
    },
  };
}

export function browserOperationTimedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError'
    || ['native_operation_timed_out', 'operation_timeout', 'qualification_budget_exhausted'].includes(error.message));
}

export function browserPreflightError(error: unknown, stderrReasons: readonly BrowserStderrReason[] = []): string {
  const message = error instanceof Error ? error.message : '';
  const code = (error as { code?: string } | null)?.code;
  if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(code ?? '')) return 'module_unavailable';
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return 'module_export_unavailable';
  if (['ERR_REQUIRE_ESM', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_INVALID_PACKAGE_CONFIG'].includes(code ?? '')) return 'module_format_error';
  if (/\bbrowser_launch_policy_rejected\b/.test(message)) return 'launch_policy_rejected';
  if (['background_browser_ownership_failed', 'source_process_ownership_unconfirmed', 'destination_process_ownership_unconfirmed'].includes(message)) return 'ownership_unconfirmed';
  if (['background_browser_startup_page_rejected', 'onboarding_or_external_page'].includes(message)) return 'startup_page_rejected';
  if (message === 'background_browser_render_failed') return 'render_mismatch';
  const causalReasons = [...stderrReasons, ...browserStderrReasons(message)];
  const causal = (Object.keys(BROWSER_STDERR_REASONS) as BrowserStderrReason[]).find(reason => causalReasons.includes(reason));
  if (causal) return causal;
  if (browserOperationTimedOut(error)) return 'operation_timeout';
  if (code === 'ENOENT' || /Executable doesn't exist|spawn .* ENOENT/.test(message)) return 'executable_unavailable';
  if (['EACCES', 'EPERM'].includes(code ?? '') || /spawn .* EACCES/.test(message)) return 'permission_denied';
  if (code === 'ERR_OUT_OF_RANGE' || (error instanceof Error && error.name === 'RangeError')) return 'invalid_runtime_range';
  if (error instanceof Error && error.name === 'TypeError') return 'runtime_type_error';
  if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(message)) return 'browser_profile_unavailable';
  if (/WindowServer|CGSConnection|audit session|bootstrap_check_in/i.test(message)) return 'graphics_or_bootstrap_error';
  if (/Target page, context or browser has been closed|Browser closed|Target closed/.test(message)) return 'target_closed';
  if (/Protocol error/.test(message)) return 'protocol_error';
  return 'unclassified_browser_error';
}

export function macosCompatibility(plist: unknown, host: string) {
  const properties = plist && typeof plist === 'object' ? plist as Record<string, any> : {};
  const version = (value: unknown) => typeof value === 'string' && /^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value.trim()) ? value.trim() : null;
  const hostVersion = version(host);
  const minimumSystemVersion = version(properties.LSMinimumSystemVersion);
  const minimumArm64Version = version(properties.LSMinimumSystemVersionByArchitecture?.arm64);
  const requirements = [minimumSystemVersion, minimumArm64Version].filter((value): value is string => value !== null);
  const malformed = (properties.LSMinimumSystemVersion !== undefined && minimumSystemVersion === null)
    || (properties.LSMinimumSystemVersionByArchitecture !== undefined && (!properties.LSMinimumSystemVersionByArchitecture
      || typeof properties.LSMinimumSystemVersionByArchitecture !== 'object' || Array.isArray(properties.LSMinimumSystemVersionByArchitecture)))
    || (properties.LSMinimumSystemVersionByArchitecture?.arm64 !== undefined && minimumArm64Version === null);
  const compatible = hostVersion && requirements.length && !malformed ? requirements.every(minimum => {
    const actual = hostVersion.split('.').map(Number);
    const required = minimum.split('.').map(Number);
    for (let index = 0; index < 3; index++) {
      const difference = (actual[index] ?? 0) - (required[index] ?? 0);
      if (difference) return difference > 0;
    }
    return true;
  }) : null;
  return { hostVersion, minimumSystemVersion, minimumArm64Version, compatible };
}

export function browserStartupFacts(urls: string[], origin: string) {
  return { count: urls.length, categories: urls.slice(0, 64).map(browserStartupCategory), truncated: urls.length > 64,
    allowed: urls.every(url => allowedFixturePage(url, origin)) };
}

export function browserRootFacts(children: Array<{ pid: number; closeObserved?: boolean; process: { exitCode: number | null; signalCode: string | null } }>) {
  return children.slice(0, 64).map(child => ({ pid: child.pid, exitCode: Number.isInteger(child.process.exitCode) ? child.process.exitCode : null,
    ...(child.closeObserved === undefined ? {} : { closeObserved: child.closeObserved }),
    signal: child.process.signalCode == null ? null
      : ['SIGABRT', 'SIGTRAP', 'SIGSEGV', 'SIGBUS', 'SIGKILL', 'SIGTERM', 'SIGILL'].includes(child.process.signalCode) ? child.process.signalCode : 'other' }));
}

export function browserCleanupError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  const errno = (error as { errno?: unknown } | null)?.errno;
  const reason = error instanceof Error && error.message === 'owned_process_group_still_live' ? 'group_still_live'
    : error instanceof Error && error.message === 'cleanup_budget_exhausted' ? 'cleanup_deadline'
      : error instanceof Error && error.message === 'operation_timeout' ? 'child_close_timeout'
        : error instanceof Error && error.message === 'owned_child_close_unconfirmed' ? 'child_close_unconfirmed' : 'signal_or_probe_failed';
  return { reason, code: typeof code === 'string' && ['ESRCH', 'EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'ETIMEDOUT'].includes(code) ? code : 'unclassified',
    errno: typeof errno === 'number' && Number.isSafeInteger(errno) ? errno : null };
}

export function browserGroupFacts(output: string, uid: number, pgid: number) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(pgid) || pgid < 1) throw new Error('invalid_group_snapshot_target');
  const processes: Array<{ pid: number; ppid: number; state: string }> = [];
  let foreignUidCount = 0;
  for (const line of output.split('\n').filter(line => line.trim())) {
    const fields = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
    if (!fields) throw new Error('invalid_group_snapshot');
    if (Number(fields[4]) !== pgid) continue;
    if (Number(fields[1]) !== uid) { foreignUidCount++; continue; }
    const pid = Number(fields[2]);
    const ppid = Number(fields[3]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(ppid)) throw new Error('invalid_group_snapshot');
    processes.push({ pid, ppid, state: ['I', 'R', 'S', 'T', 'U', 'Z', 'D', 'X'].includes(fields[5][0]) ? fields[5][0] : 'other' });
  }
  return { available: true, count: processes.length, foreignUidCount, zombies: processes.filter(process => process.state === 'Z').length,
    live: processes.filter(process => process.state !== 'Z').length, truncated: processes.length > 64, processes: processes.slice(0, 64) };
}

export function playwrightModuleLoadFacts(snapshot: string, error: unknown) {
  const detail = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const names = ['Error', 'ResolveMessage', 'BuildMessage', 'SyntaxError', 'TypeError', 'RangeError', 'TimeoutError'];
  const codes = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ERR_UNKNOWN_FILE_EXTENSION',
    'ERR_INVALID_PACKAGE_CONFIG', 'ENOENT', 'EACCES', 'EPERM', 'ERR_OUT_OF_RANGE'];
  const message = typeof detail?.message === 'string' ? detail.message : '';
  const module = ['playwright', 'playwright-core', './lib/bootstrap', './lib/coreBundle']
    .find(name => message.includes("'" + name + "'") || message.includes('"' + name + '"')) ?? 'unclassified';
  const files = Object.fromEntries(['playwright/package.json', 'playwright/index.mjs', 'playwright/index.js', 'playwright-core/package.json',
    'playwright-core/index.mjs', 'playwright-core/index.js', 'playwright-core/lib/bootstrap.js', 'playwright-core/lib/coreBundle.js'].map(name => {
    const file = path.join(snapshot, 'node_modules', name);
    const facts = { exists: false, readable: false, ownedByCurrentUid: false, insideSnapshot: false };
    try {
      const info = lstatSync(file);
      facts.exists = true;
      facts.ownedByCurrentUid = info.uid === process.getuid?.();
      facts.insideSnapshot = realpathSync(file).startsWith(realpathSync(snapshot) + path.sep);
      accessSync(file, constants.R_OK);
      facts.readable = true;
    } catch {}
    return [name, facts];
  }));
  return { errorType: typeof detail?.name === 'string' && names.includes(detail.name) ? detail.name : 'unclassified',
    errorCode: typeof detail?.code === 'string' && codes.includes(detail.code) ? detail.code : 'unclassified', requestedModule: module, files };
}

export function parseKeychainPaths(output: string, allowEmpty = false): string[] {
  const paths = output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const value = JSON.parse(line);
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('invalid_keychain_snapshot');
    return value;
  });
  if (!paths.length && !allowEmpty) throw new Error('empty_keychain_snapshot');
  return paths;
}

export function parseDefaultKeychain(result: { status: number | null; stdout: string; stderr: string; error?: unknown }): string[] {
  if (!result.error && result.status === 1 && !result.stdout.trim()
    && /^security: SecKeychainCopy(?:DomainDefault user|Default): A default keychain could not be found\.$/.test(result.stderr.trim())) return [];
  if (result.error || result.status !== 0 || (!result.stdout.trim() && result.stderr.trim())) throw new Error('user_default_keychain_unavailable');
  const paths = parseKeychainPaths(result.stdout, true);
  if (paths.length > 1) throw new Error('invalid_default_keychain_snapshot');
  return paths;
}

export function prepareKeychainHome(home: string, uid = process.getuid?.()) {
  if (uid === undefined || realpathSync(home) !== home || !lstatSync(home).isDirectory() || lstatSync(home).uid !== uid) throw new Error('keychain_home_unsafe');
  const directories = ['Library', 'Library/Preferences', 'Library/Keychains'];
  const before = Object.fromEntries(directories.map(name => [name, existsSync(path.join(home, name))]));
  for (const name of directories) {
    const directory = path.join(home, name);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0 || realpathSync(directory) !== directory) throw new Error('keychain_home_unsafe');
  }
  return { before, directoriesReady: true };
}

type KeychainResult = { status: number | null; stdout: string; stderr: string; error?: unknown };
type KeychainExecutor = (args: string[], timeout: number) => KeychainResult;

function keychainCommand(env: Record<string, string>, args: string[], deadline: number, execute?: KeychainExecutor, onDispatch?: () => void): KeychainResult {
  const timeout = Math.floor(deadline - performance.now());
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error('user_keychain_probe_timeout');
  onDispatch?.();
  return execute ? execute(args, timeout) : spawnSync('/usr/bin/security', args, {
    env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  });
}

function requireOwnedKeychains(paths: string[], allowedRoots: string[]) {
  for (const keychain of paths) {
    const resolved = existsSync(keychain) ? realpathSync(keychain) : path.resolve(keychain);
    if (!allowedRoots.some(root => resolved.startsWith(realpathSync(root) + path.sep))) throw new Error('keychain_outside_owned_home_refused');
  }
}

export function captureUserKeychains(env: Record<string, string>, allowedRoots: string[], milliseconds = 10_000,
  execute?: KeychainExecutor) {
  const deadline = performance.now() + milliseconds;
  const probe = (args: string[]) => keychainCommand(env, args, deadline, execute);
  const search = probe(['list-keychains', '-d', 'user']);
  if (search.error || search.status !== 0 || (!search.stdout.trim() && search.stderr.trim())) throw new Error('user_keychain_search_unavailable');
  const snapshot = { search: parseKeychainPaths(search.stdout, true), default: parseDefaultKeychain(probe(['default-keychain', '-d', 'user'])) };
  requireOwnedKeychains([...snapshot.search, ...snapshot.default], allowedRoots);
  return snapshot;
}

export function observeFixtureKeychain(env: Record<string, string>, allowedRoots: string[], keychain: string, expected: string,
  milliseconds = 10_000, execute?: KeychainExecutor, service: 'Gstack Native Probe' | 'Dia Safe Storage' = 'Gstack Native Probe') {
  requireOwnedKeychains([keychain], allowedRoots);
  const info = lstatSync(keychain);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('fixture_keychain_not_owned');
  const expectedPath = realpathSync(keychain);
  const deadline = performance.now() + milliseconds;
  const result = { searchCount: null as number | null, searchPathMatches: false, defaultCount: null as number | null,
    defaultPathMatches: false, explicitReadAttempted: false, explicitReadSucceeded: false, explicitReadMatches: false,
    lookupReadAttempted: false, lookupReadSucceeded: false, lookupReadMatches: false,
    preferencesDirectoryExists: existsSync(path.join(env.HOME, 'Library/Preferences')),
    preferencesFileExists: existsSync(path.join(env.HOME, 'Library/Preferences/com.apple.security.plist')) };
  try {
    const search = keychainCommand(env, ['list-keychains', '-d', 'user'], deadline, execute);
    if (search.error || search.status !== 0 || (!search.stdout.trim() && search.stderr.trim())) throw new Error('search_unavailable');
    const paths = parseKeychainPaths(search.stdout, true);
    result.searchCount = paths.length;
    requireOwnedKeychains(paths, allowedRoots);
    result.searchPathMatches = paths.length === 1 && realpathSync(paths[0]) === expectedPath;
  } catch {}
  try {
    const paths = parseDefaultKeychain(keychainCommand(env, ['default-keychain', '-d', 'user'], deadline, execute));
    result.defaultCount = paths.length;
    requireOwnedKeychains(paths, allowedRoots);
    result.defaultPathMatches = paths.length === 1 && realpathSync(paths[0]) === expectedPath;
  } catch {}
  try {
    const read = keychainCommand(env, ['find-generic-password', '-s', service, '-w', keychain], deadline, execute,
      () => { result.explicitReadAttempted = true; });
    result.explicitReadSucceeded = !read.error && read.status === 0;
    result.explicitReadMatches = result.explicitReadSucceeded && read.stdout.trim() === expected;
  } catch {}
  if (service === 'Dia Safe Storage' && result.searchPathMatches && result.defaultPathMatches && result.explicitReadMatches) {
    try {
      const read = keychainCommand(env, ['find-generic-password', '-s', service, '-w'], deadline, execute,
        () => { result.lookupReadAttempted = true; });
      result.lookupReadSucceeded = !read.error && read.status === 0;
      result.lookupReadMatches = result.lookupReadSucceeded && read.stdout.trim() === expected;
    } catch {}
  }
  return result;
}

export function observeDiaKeychainEnvironments(environments: { keychainHome: Record<string, string>; profileHome: Record<string, string> },
  allowedRoots: string[], keychain: string, expected: string, milliseconds = 20_000,
  execute?: (env: Record<string, string>, args: string[], timeout: number) => KeychainResult) {
  const deadline = performance.now() + milliseconds;
  const environmentsObserved: Record<string, ReturnType<typeof observeFixtureKeychain> | { unavailable: true }> = {};
  for (const label of ['keychainHome', 'profileHome'] as const) {
    const env = environments[label];
    try {
      environmentsObserved[label] = observeFixtureKeychain(env, allowedRoots, keychain, expected, Math.min(10_000, deadline - performance.now()),
        execute ? (args, timeout) => execute(env, args, timeout) : undefined, 'Dia Safe Storage');
    } catch { environmentsObserved[label] = { unavailable: true }; }
  }
  let firstFailure: { environment: 'keychainHome' | 'profileHome'; check: 'search_path' | 'explicit_read' } | undefined;
  for (const label of ['keychainHome', 'profileHome'] as const) {
    const facts = environmentsObserved[label];
    if (!('searchPathMatches' in facts) || !facts.searchPathMatches) firstFailure ??= { environment: label, check: 'search_path' };
  }
  const keychainFacts = environmentsObserved.keychainHome;
  if (!('explicitReadMatches' in keychainFacts) || !keychainFacts.explicitReadMatches) firstFailure ??= { environment: 'keychainHome', check: 'explicit_read' };
  return { environments: environmentsObserved, firstFailure };
}

export function fixtureKeychainRestoreCommands(snapshot: { search: string[]; default: string[] }, keychain: string, created: boolean): string[][] {
  if (created && [...snapshot.search, ...snapshot.default].some(original => path.resolve(original) === path.resolve(keychain))) throw new Error('fixture_keychain_not_fresh');
  return [
    ...(snapshot.default.length ? [['default-keychain', '-d', 'user', '-s', ...snapshot.default]] : []),
    ...(created ? [['delete-keychain', keychain]] : []),
    ['list-keychains', '-d', 'user', '-s', ...snapshot.search],
  ];
}

export function observeBrowserLaunches(expected: ReadonlyMap<string, string>) {
  const childProcess = require('node:child_process');
  const original = childProcess.spawn;
  const children: Array<{ process: ChildProcess; executable: string; pid: number; closed: Promise<void>; closeObserved: boolean;
    stderr?: ReturnType<typeof createBrowserStderrCapture> }> = [];
  const attempts: Array<Record<string, number | boolean | null>> = [];
  const detachStderr: Array<() => void> = [];
  let accepting = true;
  childProcess.spawn = function(command: string, args: string[], options: any) {
    if (!expected.has(command)) return original.call(this, command, args, options);
    const argumentsArray = Array.isArray(args);
    const sandboxRequired = process.platform === 'darwin';
    const sandboxDisablingFlag = argumentsArray && hasSandboxDisablingArgument(args);
    attempts.push({ admissionOpen: accepting, argumentsArray, pipeFlag: argumentsArray && args.includes('--remote-debugging-pipe'),
      profileArgumentCount: argumentsArray ? args.filter(arg => arg.startsWith('--user-data-dir')).length : null,
      expectedProfile: argumentsArray && args.includes('--user-data-dir=' + expected.get(command)),
      detached: options?.detached === true, shellDisabled: options?.shell === undefined || options.shell === false,
      stdioCount: Array.isArray(options?.stdio) ? options.stdio.length : null,
      extraPipeDescriptors: Array.isArray(options?.stdio) && options.stdio[3] === 'pipe' && options.stdio[4] === 'pipe',
      headlessFlag: argumentsArray && args.some(arg => /^--headless(?:=|$)/.test(arg)),
      blankStartupArgument: argumentsArray && args.includes('about:blank'),
      tcpDebuggingFlag: argumentsArray && args.some(arg => /^--remote-debugging-port(?:=|$)/.test(arg)),
      mockKeychainFlag: argumentsArray && args.some(arg => /^--use-mock-keychain(?:=|$)/.test(arg)),
      passwordStoreFlag: argumentsArray && args.some(arg => /^--password-store(?:=|$)/.test(arg)),
      firstRunSuppressed: argumentsArray && args.some(arg => /^--no-first-run(?:=|$)/.test(arg)), sandboxRequired, sandboxDisablingFlag });
    if (!accepting || !Array.isArray(args) || !args.includes('--remote-debugging-pipe')
      || (sandboxRequired && sandboxDisablingFlag)
      || args.filter(arg => arg.startsWith('--user-data-dir')).length !== 1 || !args.includes('--user-data-dir=' + expected.get(command))
      || options?.detached !== true || (options.shell !== undefined && options.shell !== false) || !Array.isArray(options?.stdio)
      || options.stdio.length !== 5 || options.stdio[3] !== 'pipe' || options.stdio[4] !== 'pipe'
      || args.some(arg => /^--(?:remote-debugging-port|use-mock-keychain|password-store|no-first-run)(?:=|$)/.test(arg))) {
      throw new Error('browser_launch_policy_rejected');
    }
    const child: ChildProcess = original.call(this, command, args, options);
    if (child.pid) {
      let resolveClose!: () => void;
      const closed = new Promise<void>(resolve => { resolveClose = resolve; });
      const observed = { process: child, executable: command, pid: child.pid, closed, closeObserved: false,
        stderr: child.stderr ? createBrowserStderrCapture() : undefined };
      child.once('close', () => { observed.closeObserved = true; resolveClose(); });
      const stderr = observed.stderr;
      if (stderr && child.stderr) {
        const stream = child.stderr;
        stream.on('data', stderr.consume);
        stream.once('end', stderr.end);
        detachStderr.push(() => { stream.off('data', stderr.consume); stream.off('end', stderr.end); stderr.clear(); });
      }
      children.push(observed);
    }
    return child;
  };
  return { children, attempts, stop() { accepting = false; }, restore() { childProcess.spawn = original; for (const detach of detachStderr) detach(); } };
}

export function browserStderrFacts(children: ReturnType<typeof observeBrowserLaunches>['children']) {
  return children.slice(0, 64).map(child => ({ pid: child.pid, available: Boolean(child.stderr), ...child.stderr?.snapshot() }));
}

export async function joinOwnedBrowserClose(child: ReturnType<typeof observeBrowserLaunches>['children'][number], deadline: number) {
  const remaining = deadline - performance.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('cleanup_budget_exhausted');
  await bounded(child.closed, remaining);
  if (!child.closeObserved) throw new Error('owned_child_close_unconfirmed');
}

export async function stopOwnedBrowserGroup(child: ReturnType<typeof observeBrowserLaunches>['children'][number], deadline: number,
  facts: Record<string, any>, signal: (pid: number, signal: 0 | 'SIGKILL') => unknown = (pid, signal) => process.kill(pid, signal)) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1 || child.pid === process.pid) throw new Error('owned_browser_pid_unconfirmed');
  if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new Error('cleanup_budget_exhausted');
  facts.stage = 'probe_before_signal';
  try {
    signal(-child.pid, 0);
    facts.stage = 'signal';
    signal(-child.pid, 'SIGKILL');
    facts.signalSent = true;
  } catch (error: any) {
    if (error.code !== 'ESRCH') facts.initialSignalFailure = { stage: facts.stage, ...browserCleanupError(error) };
  }
  facts.stage = 'join_child_close';
  await joinOwnedBrowserClose(child, deadline);
  facts.childCloseObserved = child.closeObserved;
  facts.stage = 'probe_after_signal';
  while (true) {
    try { signal(-child.pid, 0); }
    catch (error: any) {
      if (error.code !== 'ESRCH') throw error;
      facts.absenceConfirmed = true;
      facts.stage = 'completed';
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('owned_process_group_still_live');
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
}

export async function observePendingBrowserLaunch<T>(launch: () => Promise<T>, observe: (deadline: number) => void,
  deadline: number, delay = 10_000): Promise<T> {
  const sampleDeadline = Math.min(deadline, performance.now() + 25_000);
  const timer = setTimeout(() => {
    if (performance.now() + 1000 >= sampleDeadline) return;
    observe(sampleDeadline);
  }, delay);
  try { return await launch(); }
  finally { clearTimeout(timer); }
}

export function classifyNativeWaitSample(output: string) {
  const families = {
    security_keychain: /\b(?:SecKeychain\w*|SecItem\w*|securityd|Security)\b|libsecurity_keychain/,
    appkit_bootstrap: /\b(?:AppKit|NSApplication\w*|SkyLight|HIToolbox|CGSConnection\w*|bootstrap_\w+)\b/,
    network: /\b(?:CFNetwork|NSURLSession\w*|nw_connection_\w*)\b|Network\.framework/,
    runloop: /\b(?:CFRunLoop\w*|__CFRunLoop\w*|NSRunLoop\w*|mach_msg\w*|__psynch_cvwait|__ulock_wait|kevent\w*)\b/,
  };
  const frameCounts = Object.fromEntries(Object.keys(families).map(name => [name, 0]));
  const mainThreadFrameCounts = { ...frameCounts };
  let callGraphSeen = false;
  let mainThreadSeen = false;
  let mainThread = false;
  let frames = 0;
  const shape = { graphLines: 0, nonemptyGraphLines: 0, threadTokenLines: 0, numericPrefixLines: 0, imageAnnotatedLines: 0,
    nonAsciiGraphLines: 0, unrecognizedGraphLines: 0, graphEnd: 'missing', binaryImagesSeen: /^Binary Images:/m.test(output) };
  if (Buffer.byteLength(output) > 1024 * 1024) return { available: false, reason: 'sample_output_oversized' };
  for (const line of output.split('\n')) {
    if (/^Call graph:\s*$/.test(line)) { callGraphSeen = true; shape.graphEnd = 'eof'; continue; }
    if (!callGraphSeen) continue;
    if (/^(?:Total number in stack|Sort by top of stack|Binary Images:)/.test(line)) {
      shape.graphEnd = line.startsWith('Binary Images:') ? 'binary_images' : line.startsWith('Total number') ? 'totals' : 'top_of_stack';
      break;
    }
    shape.graphLines++;
    if (line.trim()) shape.nonemptyGraphLines++;
    if (/\bThread[_\s]/.test(line)) shape.threadTokenLines++;
    if (/^\s*\d+\s/.test(line)) shape.numericPrefixLines++;
    if (/\(in [^)]+\)/.test(line)) shape.imageAnnotatedLines++;
    if (/[^\x00-\x7f]/.test(line)) shape.nonAsciiGraphLines++;
    if (/^\s*\d+\s+Thread_/.test(line)) {
      mainThread = /\bcom\.apple\.main-thread\b/.test(line);
      mainThreadSeen ||= mainThread;
      continue;
    }
    if (!/^\s*[+|:! ]*\d+\s+\S/.test(line)) { if (line.trim()) shape.unrecognizedGraphLines++; continue; }
    frames++;
    for (const [name, pattern] of Object.entries(families)) {
      if (!pattern.test(line)) continue;
      frameCounts[name]++;
      if (mainThread) mainThreadFrameCounts[name]++;
    }
  }
  return { available: callGraphSeen && frames > 0, callGraphSeen, mainThreadSeen, frames, frameCounts, mainThreadFrameCounts, shape };
}

export function sampleOwnedDiaWait(child: ReturnType<typeof observeBrowserLaunches>['children'][number], uid: number, expectedExecutable: string,
  deadline: number, env: Record<string, string>, spawn: typeof spawnSync = spawnSync) {
  const result: Record<string, any> = { available: false, reason: 'target_not_live_owned_child', attempted: false };
  if (child.executable !== expectedExecutable || path.basename(expectedExecutable) !== 'Dia' || !Number.isSafeInteger(child.pid) || child.pid < 1
    || child.process.pid !== child.pid || child.closeObserved || child.process.exitCode !== null || child.process.signalCode !== null
    || uid !== process.getuid?.() || uid !== process.geteuid?.() || !Number.isFinite(deadline)) return result;
  const until = Math.min(deadline, performance.now() + 5_000);
  const timeout = (limit: number) => {
    const value = Math.floor(Math.min(limit, until - performance.now()));
    if (value < 1) throw new Error('sample_budget_exhausted');
    return value;
  };
  try {
    const identity = spawn('/bin/ps', ['-p', String(child.pid), '-o', 'uid=,pid=,ppid=,state=,ucomm='], {
      env, encoding: 'utf8', timeout: timeout(2_000), maxBuffer: 16 * 1024, killSignal: 'SIGKILL',
    });
    if (identity.error || identity.status !== 0 || typeof identity.stdout !== 'string') { result.reason = 'ownership_probe_unavailable'; return result; }
    const row = identity.stdout.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([IRSUTD][^\s]*)\s+Dia$/);
    if (!row || Number(row[1]) !== uid || Number(row[2]) !== child.pid || Number(row[3]) !== process.pid) return result;
    result.ownedLiveChildConfirmed = true;
    result.attempted = true;
    const sample = spawn('/usr/bin/sample', [String(child.pid), '1', '10', '-file', '/dev/stdout'], {
      env, encoding: 'utf8', timeout: timeout(5_000), maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
    });
    const stdout = typeof sample.stdout === 'string' ? sample.stdout : '';
    const stderr = typeof sample.stderr === 'string' ? sample.stderr : '';
    result.exitCode = sample.status;
    result.stdoutBytes = Buffer.byteLength(stdout);
    result.stderrBytes = Buffer.byteLength(stderr);
    result.timedOut = (sample.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    if (sample.error || sample.status !== 0) {
      result.reason = /not permitted|permission denied|(?:unable|failed) to (?:get|obtain).*task|task_for_pid.*fail|requires root/i.test((stdout + '\n' + stderr).slice(0, 65_536))
        ? 'sampling_permission_denied' : result.timedOut ? 'sampling_timeout' : 'sampling_failed';
      return result;
    }
    result.waitFamilies = classifyNativeWaitSample(stdout);
    result.available = result.waitFamilies.available;
    result.reason = result.available ? 'sampled' : result.waitFamilies.reason ?? (!result.waitFamilies.callGraphSeen ? 'sample_call_graph_missing'
      : result.waitFamilies.shape.nonemptyGraphLines === 0 ? 'sample_graph_empty'
        : result.waitFamilies.shape.unrecognizedGraphLines === 0 ? 'sample_no_stack_frames' : 'sample_graph_unrecognized');
  } catch { result.reason = 'sampling_unavailable_or_budget_exhausted'; }
  return result;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation_timeout')), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

export async function qualifyDia(isolation: { root: string; configFile: string }): Promise<Record<string, any>> {
  validateQualificationHost(process.env);
  const account = readFreshAccountConfiguration(isolation.configFile);
  if (account.guiReadiness || !account.destinationExecutable || !account.destinationSha256) throw new Error('browser_qualification_authority_required');
  if (Bun.version !== '1.4.0' || require('playwright/package.json').version !== '1.62.1') throw new Error('pinned_runtimes_required');
  const runnerTemp = realpathSync(process.env.RUNNER_TEMP!);
  const output = path.join(runnerTemp, 'dia-native-qualification.json');
  if (existsSync(output)) throw new Error('fresh_receipt_path_required');
  const root = realpathSync(isolation.root);
  if (path.dirname(root) !== runnerTemp || !path.basename(root).startsWith('dia-')) throw new Error('fixture_root_unowned');
  const home = account.home;
  const temporary = path.join(root, 't');
  const sourceProfile = path.join(home, 'Library/Application Support/Dia/User Data');
  const destinationProfile = path.join(root, 'd');
  const keychain = path.join(root, 'fixture.keychain-db');
  const mount = path.join(root, 'm');
  const image = path.join(root, 'Dia.dmg');
  const app = path.join(root, 'Dia.app');
  const environment = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: temporary };
  const deadline = performance.now() + 9 * 60_000;
  let cleaning = false;
  let cleanupDeadline = 0;
  let stage = 'fixture_preflight';
  let mounted = false;
  let keychainCreated = false;
  let keychainChanged = false;
  let originalSearch: string[] = [];
  let originalDefault: string[] = [];
  let source: BrowserContext | undefined;
  let destination: BrowserContext | undefined;
  let observer: ReturnType<typeof observeBrowserLaunches> | undefined;
  let launchAttempts = 0;
  let comparisonAttempted = false;
  let comparisonSource: Record<string, any> | undefined;
  let profileCreationAttempted = false;
  let profileOwnership: ReturnType<typeof createOwnedDiaProfile> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browserRole: 'source' | 'destination' | undefined;
  const attemptStarts: Partial<Record<'source' | 'destination', number>> = {};
  const receipt: Record<string, any> = {
    status: 'incomplete', reason: 'not_run', runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: { os: 'darwin', architecture: 'arm64', release: release(), bun: Bun.version, playwright: '1.62.1' },
    isolation: { registeredHomeAtStartup: true, sharedRegisteredHome: true, registeredIdentity: false,
      productionLookupMocked: false, keychainCommandHome: 'fresh_registered_home' },
    artifact: { url: DIA_DOWNLOAD }, expectedCases: 8,
    cases: Object.fromEntries(['headless_without_account_interaction', 'synthetic_session_created', 'native_encrypted_cookie_persisted',
      'dia_profile_and_domain_discovered', 'native_keychain_decryption_and_verified_import', 'default_storage_preserved',
      'wrong_identity_not_verified', 'explicit_storage_reset'].map(name => [name, 'not_run'])), counts: { pass: 0, fail: 0, skip: 0 },
    coverage: { mockKeychain: false, nativeKeychainRead: false, nativePermissionPrompts: false, accountLogin: false, sync: false, browserProfileImport: false },
    browsers: { source: { stage: 'not_started', launchReturned: false }, destination: { stage: 'not_started', launchReturned: false } },
    cleanup: { ownedBrowsersStopped: false, sourceProfileRemoved: false, keychainRestored: false, mountDetached: false, fixtureRemoved: false },
  };
  const run = (command: string, args: string[], milliseconds = 10_000, env = environment) => {
    const remaining = (cleaning ? cleanupDeadline : deadline) - performance.now();
    const timeout = Math.floor(Math.min(milliseconds, remaining));
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error('qualification_budget_exhausted');
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      receipt[cleaning ? 'cleanupCommandFailure' : 'commandFailure'] ??= { command: path.basename(command), operation: args[0], exitCode: result.status,
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' };
      throw new Error('command_failed');
    }
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  const check = (name: string, passed: boolean) => {
    receipt.cases[name] = passed ? 'passed' : 'failed';
    if (!passed) throw new Error('case_failed');
  };
  const within = <T>(operation: () => Promise<T>, milliseconds: number) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('qualification_budget_exhausted');
    return bounded(operation(), Math.min(milliseconds, remaining));
  };
  try {
    const record = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + account.account, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID']).stdout);
    if (!ownsFreshAccount(record, account)) throw new Error('fresh_registered_identity_mismatch');
    receipt.isolation.registeredIdentity = true;
    for (const directory of [temporary, mount]) {
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      else if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('fixture_directory_escape');
    }
    receipt.sourceSocketPathBytes = Buffer.byteLength(path.join(sourceProfile, 'SingletonSocket'));
    assertDiaSocketPath(sourceProfile);
    if (existsSync(sourceProfile) || existsSync(destinationProfile)) throw new Error('existing_profile_refused');
    for (const relative of ['Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium',
      'Library/Application Support/Arc', 'Library/Application Support/Dia', 'Library/Application Support/Comet',
      'Library/Application Support/BraveSoftware/Brave-Browser', 'Library/Application Support/Microsoft Edge',
      'Library/Safari', 'Library/Cookies']) {
      if (existsSync(path.join(home, relative))) {
        receipt.preexistingState = relative;
        throw new Error('preexisting_browser_state_refused');
      }
    }
    receipt.keychainHome = prepareKeychainHome(home);
    const revision = process.env.GSTACK_DIA_SOURCE_REVISION;
    if (revision && !/^[0-9a-f]{40}$/.test(revision)) throw new Error('invalid_source_revision');
    receipt.sourceRevision = revision ?? run('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD']).stdout;
    const sourceFiles = ['.github/scripts/qualify-dia-macos.ts', 'browse/src/cookie-import-browser.ts', 'browse/src/cookie-import-operation.ts', 'browse/src/cookie-database.ts', 'browse/src/cookie-auth-verification.ts', 'browse/src/cdp-bridge.ts'];
    receipt.sourceHashes = Object.fromEntries(await within(() => Promise.all(sourceFiles.map(async file => [file, await sha256(path.join(repository, file))])), 10_000));
    stage = 'official_download';
    const downloaded = run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--connect-timeout', '20', '--max-time', '300', '--output', image, '--write-out', '%{url_effective}', DIA_DOWNLOAD], 310_000);
    if (new URL(downloaded.stdout).origin !== 'https://releases.diabrowser.com') throw new Error('unexpected_download_origin');
    chmodSync(image, 0o600);
    receipt.artifact.sha256 = await within(() => sha256(image), 30_000);
    stage = 'signed_app_staging';
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, image], 45_000);
    mounted = true;
    const mountedApp = path.join(mount, 'Dia.app');
    if (!lstatSync(mountedApp).isDirectory() || !realpathSync(mountedApp).startsWith(realpathSync(mount) + path.sep)) throw new Error('mounted_app_escape');
    run('/usr/bin/ditto', ['--rsrc', '--extattr', mountedApp, app], 45_000);
    run('/usr/bin/hdiutil', ['detach', mount], 15_000);
    mounted = false;
    if (realpathSync(app) !== app) throw new Error('staged_app_escape');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 45_000);
    const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', app]).stderr;
    const gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 45_000).stderr;
    const authority = signature.match(/^Authority=(Developer ID Application: .+)$/m)?.[1];
    const team = signature.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
    if (!authority || !team || !gatekeeper.includes('accepted') || !gatekeeper.includes('Notarized Developer ID')) throw new Error('signer_or_notarization_unconfirmed');
    const plist = path.join(app, 'Contents/Info.plist');
    const property = (name: string) => run('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist]).stdout;
    const executableName = property('CFBundleExecutable');
    if (!executableName || path.basename(executableName) !== executableName) throw new Error('invalid_bundle_executable');
    const executable = realpathSync(path.join(app, 'Contents/MacOS', executableName));
    if (!executable.startsWith(realpathSync(app) + path.sep)) throw new Error('bundle_executable_escape');
    receipt.artifact = { ...receipt.artifact, version: property('CFBundleShortVersionString'), bundleId: property('CFBundleIdentifier'), authority, team,
      signatureVerified: true, gatekeeperNotarized: true };
    stage = 'signed_app_architecture';
    receipt.artifact.architectureInspection = inspectMachOArchitectures(executable, Math.min(10_000, deadline - performance.now()));
    receipt.artifact.architectures = receipt.artifact.architectureInspection.architectures;
    if (!receipt.artifact.architectures.includes('arm64')) throw new Error('dia_arm64_binary_required');
    receipt.artifact.executableSha256 = await within(() => sha256(executable), 10_000);
    stage = 'signed_app_os_compatibility';
    receipt.artifact.macosCompatibility = macosCompatibility(JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]).stdout),
      run('/usr/bin/sw_vers', ['-productVersion']).stdout);
    if (receipt.artifact.macosCompatibility.compatible === false) throw new Error('source_macos_version_unsupported');
    stage = 'temporary_keychain';
    receipt.keychainStage = 'capture_original';
    const originalKeychains = captureUserKeychains(environment, [home, root]);
    originalSearch = originalKeychains.search;
    originalDefault = originalKeychains.default;
    const keychainPassword = randomBytes(24).toString('hex');
    const fixtureKey = randomBytes(24).toString('hex');
    let setupFailure: unknown;
    try {
      receipt.keychainStage = 'create_fixture';
      keychainChanged = true;
      run('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychain]);
      keychainCreated = true;
      receipt.keychainStage = 'configure_settings';
      run('/usr/bin/security', ['set-keychain-settings', '-lut', '600', keychain]);
      receipt.keychainStage = 'unlock_fixture';
      run('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychain]);
      receipt.keychainStage = 'seed_fixture';
      run('/usr/bin/security', ['add-generic-password', '-a', 'Dia', '-s', 'Dia Safe Storage', '-w', fixtureKey, '-T', executable, '-T', '/usr/bin/security', keychain]);
      receipt.keychainStage = 'set_search';
      run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain]);
      receipt.keychainStage = 'set_default';
      run('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', keychain]);
      receipt.keychainStage = 'validate_environments';
    } catch (error) { setupFailure = error; }
    if (keychainCreated) {
      receipt.keychainObservations = observeDiaKeychainEnvironments({ keychainHome: environment, profileHome: environment },
        [home, root], keychain, fixtureKey, Math.min(20_000, deadline - performance.now()));
    }
    if (setupFailure !== undefined) throw setupFailure;
    const keychainFailure = receipt.keychainObservations.firstFailure;
    if (keychainFailure) throw new Error(keychainFailure.check === 'search_path' ? 'keychain_search_isolation_failed' : 'fixture_keychain_read_failed');
    receipt.keychainStage = 'completed';
    if (account.launchComparison) {
      stage = 'diagnostic_source_launch';
      profileCreationAttempted = true;
      profileOwnership = createOwnedDiaProfile(home);
      assertOwnedDiaProfile(profileOwnership);
      receipt.isolation.sourceProfileOwnershipConfirmed = true;
      comparisonAttempted = true;
      comparisonSource = await runDiaLaunchComparison(account, 'source', { assetRoot: root, executableName, executableSha256: receipt.artifact.executableSha256 },
        undefined, deadline - performance.now());
      receipt.launchComparison = { mode: 'launch-only', qualificationCredit: false, source: comparisonSource };
      receipt.browsers.source = { stage: 'delegated_comparison', launchReturned: comparisonSource.launchReturned,
        timedOut: comparisonSource.timedOut ?? false, error: comparisonSource.error ?? null };
      receipt.reason = 'diagnostic_launch_comparison_only';
      return receipt;
    }
    delete process.env.DEBUG;
    delete process.env.PWDEBUG;
    browserRole = 'source';
    const sourceFacts = receipt.browsers.source;
    sourceFacts.stage = 'runtime_import';
    const { chromium } = await import('playwright');
    sourceFacts.stage = 'fixture_setup';
    browserRole = undefined;
    stage = 'synthetic_fixture_setup';
    const destinationExecutable = realpathSync(account.destinationExecutable);
    observer = observeBrowserLaunches(new Map([[executable, sourceProfile], [destinationExecutable, destinationProfile]]));
    const token = randomBytes(24).toString('hex');
    const identity = 'Synthetic Dia qualification account';
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/seed') return new Response('Synthetic session seeded.', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': `dia_fixture_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600` } });
      const authenticated = (request.headers.get('cookie') || '').split(';').some(value => value.trim() === `dia_fixture_session=${token}`);
      return new Response(authenticated ? `<div id="fixture-identity">${identity}</div>` : '<form>Not signed in</form>', { status: authenticated ? 200 : 401, headers: { 'Content-Type': 'text/html' } });
    } });
    const origin = `http://127.0.0.1:${server.port}`;
    stage = 'owned_source_profile_creation';
    profileCreationAttempted = true;
    profileOwnership = createOwnedDiaProfile(home);
    assertOwnedDiaProfile(profileOwnership);
    receipt.isolation.sourceProfileOwnershipConfirmed = true;
    stage = 'dia_headless_startup_or_onboarding';
    browserRole = 'source';
    sourceFacts.stage = 'launch';
    attemptStarts.source = observer.attempts.length;
    launchAttempts++;
    sourceFacts.nativeWait = { available: false, attempted: false, reason: 'launch_settled_before_sample_or_window_expired' };
    source = await observePendingBrowserLaunch(
      () => within(() => chromium.launchPersistentContext(sourceProfile, nativeDiaLaunchOptions(executable, environment)), 40_000),
      sampleDeadline => {
        try {
          const children = observer!.children.filter(child => child.executable === executable);
          sourceFacts.nativeWait = children.length === 1
            ? sampleOwnedDiaWait(children[0], account.uid, executable, sampleDeadline, environment)
            : { available: false, attempted: false, reason: 'source_root_ownership_unconfirmed' };
          sourceFacts.nativeWait.phase = 'launch_pending_before_timeout';
        } catch { sourceFacts.nativeWait = { available: false, attempted: false, reason: 'sampling_observer_failed' }; }
      }, deadline);
    sourceFacts.launchReturned = true;
    sourceFacts.stage = 'ownership';
    sourceFacts.ownedRootCount = observer.children.filter(child => child.executable === executable).length;
    if (observer.children.filter(child => child.executable === executable).length !== 1) throw new Error('source_process_ownership_unconfirmed');
    sourceFacts.stage = 'startup_pages';
    sourceFacts.startupPages = browserStartupFacts(source.pages().map(page => page.url()), origin);
    if (!sourceFacts.startupPages.allowed) throw new Error('onboarding_or_external_page');
    sourceFacts.stage = 'route_registration';
    await within(() => source!.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort()), 10_000);
    sourceFacts.stage = 'page_selection';
    const sourcePage = source.pages()[0] ?? await within(() => source!.newPage(), 10_000);
    sourceFacts.stage = 'seed_navigation';
    const seed = await within(() => sourcePage.goto(origin + '/seed', { waitUntil: 'domcontentloaded', timeout: 10_000 }), 10_000);
    sourceFacts.stage = 'seed_validation';
    sourceFacts.seedResponseStatus = seed?.status() ?? null;
    sourceFacts.postNavigationPages = browserStartupFacts(source.pages().map(page => page.url()), origin);
    check('headless_without_account_interaction', seed?.status() === 200 && sourcePage.url() === origin + '/seed'
      && source.pages().every(page => allowedFixturePage(page.url(), origin)));
    receipt.sourceBrowserVersion = source.browser()?.version();
    sourceFacts.stage = 'cookies_readback';
    const sourceCookies = await within(() => source!.cookies(origin), 10_000);
    check('synthetic_session_created', sourceCookies.some(cookie => cookie.name === 'dia_fixture_session' && cookie.value === token));
    sourceFacts.stage = 'close';
    await within(() => source!.close(), 10_000);
    source = undefined;
    sourceFacts.stage = 'completed';
    browserRole = undefined;
    stage = 'native_profile_persistence';
    assertOwnedDiaProfile(profileOwnership);
    const cookieFile = path.join(sourceProfile, 'Default/Cookies');
    if (!existsSync(cookieFile) || !realpathSync(cookieFile).startsWith(sourceProfile + path.sep)) throw new Error('expected_profile_layout_missing');
    for (const metadata of ['Local State', 'Default/Preferences']) {
      const file = path.join(sourceProfile, metadata);
      if (existsSync(file) && !realpathSync(file).startsWith(sourceProfile + path.sep)) throw new Error('profile_metadata_escape');
    }
    const { openCookieDatabase } = await import('../../browse/src/cookie-database');
    const database = openCookieDatabase(cookieFile);
    try {
      const rows = database.query('SELECT value, encrypted_value FROM cookies WHERE host_key = ? AND name = ?').all('127.0.0.1', 'dia_fixture_session') as any[];
      check('native_encrypted_cookie_persisted', rows.length === 1 && !rows[0].value && Buffer.from(rows[0].encrypted_value).subarray(0, 3).toString() === 'v10');
    } finally { database.close(); }
    stage = 'production_import';
    const { listProfiles, listDomains } = await import('../../browse/src/cookie-import-browser');
    check('dia_profile_and_domain_discovered', listProfiles('Dia').some(profile => profile.name === 'Default')
      && listDomains('Dia', 'Default').domains.some(entry => entry.domain === '127.0.0.1' && entry.count >= 1));
    browserRole = 'destination';
    const destinationFacts = receipt.browsers.destination;
    destinationFacts.stage = 'launch';
    attemptStarts.destination = observer.attempts.length;
    launchAttempts++;
    destination = await within(() => chromium.launchPersistentContext(destinationProfile, nativeDiaLaunchOptions(destinationExecutable, environment)), 40_000);
    destinationFacts.launchReturned = true;
    destinationFacts.stage = 'ownership';
    destinationFacts.ownedRootCount = observer.children.filter(child => child.executable === destinationExecutable).length;
    if (observer.children.filter(child => child.executable === destinationExecutable).length !== 1) throw new Error('destination_process_ownership_unconfirmed');
    destinationFacts.stage = 'startup_pages';
    destinationFacts.startupPages = browserStartupFacts(destination.pages().map(page => page.url()), origin);
    destinationFacts.stage = 'page_selection';
    const target = destination.pages()[0] ?? await within(() => destination!.newPage(), 10_000);
    destinationFacts.stage = 'protected_navigation';
    await within(() => target.goto(origin + '/protected', { waitUntil: 'domcontentloaded', timeout: 10_000 }), 10_000);
    destinationFacts.postNavigationPages = browserStartupFacts(destination.pages().map(page => page.url()), origin);
    destinationFacts.stage = 'storage_seed';
    await within(() => target.evaluate(() => { localStorage.setItem('fixture-local', 'preserved'); sessionStorage.setItem('fixture-session', 'preserved'); }), 10_000);
    destinationFacts.stage = 'cookie_import';
    const { runCookieImport } = await import('../../browse/src/cookie-import-operation');
    const tracked: string[] = [];
    const imported = await within(() => runCookieImport({ browser: 'Dia', profile: 'Default', domains: ['127.0.0.1'], verifyAuth: true },
      { page: target, url: target.url() }, domains => tracked.push(...domains), { identitySelector: '#fixture-identity', expectedIdentity: identity }), 30_000);
    check('native_keychain_decryption_and_verified_import', imported.imported >= 1 && imported.failed === 0 && imported.verification.verified && tracked.includes('127.0.0.1'));
    receipt.coverage.nativeKeychainRead = true;
    destinationFacts.stage = 'storage_preservation';
    check('default_storage_preserved', await within(() => target.evaluate(() => localStorage.getItem('fixture-local') === 'preserved' && sessionStorage.getItem('fixture-session') === 'preserved'), 10_000));
    destinationFacts.stage = 'wrong_identity';
    const wrong = await within(() => runCookieImport({ browser: 'Dia', profile: 'Default', domains: ['127.0.0.1'], verifyAuth: true },
      { page: target, url: target.url() }, () => {}, { identitySelector: '#fixture-identity', expectedIdentity: 'Different synthetic account', timeoutMs: 500 }), 15_000);
    check('wrong_identity_not_verified', !wrong.verification.verified && wrong.verification.reason === 'identity_mismatch');
    destinationFacts.stage = 'storage_reset';
    const reset = await within(() => runCookieImport({ browser: 'Dia', profile: 'Default', domains: ['127.0.0.1'], clearStorage: true, verifyAuth: true },
      { page: target, url: target.url() }, () => {}, { identitySelector: '#fixture-identity', expectedIdentity: identity }), 30_000);
    check('explicit_storage_reset', reset.reset === 'cleared' && reset.verification.verified
      && await within(() => target.evaluate(() => localStorage.getItem('fixture-local') === null && sessionStorage.getItem('fixture-session') === null), 10_000));
    destinationFacts.stage = 'completed';
    browserRole = undefined;
    for (const file of sourceFiles) if (await within(() => sha256(path.join(repository, file)), 5_000) !== receipt.sourceHashes[file]) throw new Error('source_changed_during_qualification');
    if (await within(() => sha256(executable), 10_000) !== receipt.artifact.executableSha256) throw new Error('source_app_changed_during_qualification');
    receipt.status = 'passed';
    receipt.reason = 'native_dia_synthetic_profile_verified';
  } catch (error) {
    receipt.reason = stage;
    receipt.failureStage = stage;
    if (browserRole) {
      const facts = receipt.browsers[browserRole];
      const children = (observer?.children ?? []).filter(child => (child.executable === account.destinationExecutable ? 'destination' : 'source') === browserRole);
      const stderrReasons = browserStderrFacts(children).flatMap(fact => Object.entries(fact.reasonCounts ?? {})
        .filter(([, count]) => count > 0).map(([reason]) => reason as BrowserStderrReason));
      facts.timedOut = browserOperationTimedOut(error);
      facts.error = browserPreflightError(error, stderrReasons);
      receipt.blocker = facts.error;
      if (facts.stage === 'runtime_import') facts.moduleLoad = playwrightModuleLoadFacts(repository, error);
    }
    if (error instanceof Error && error.message === 'onboarding_or_external_page') receipt.blocker = 'onboarding_or_unexpected_startup_page';
    if (error instanceof Error && error.message === 'preexisting_browser_state_refused') receipt.blocker = 'preexisting_browser_state_refused';
    if (error instanceof Error && ['user_keychain_search_unavailable', 'user_default_keychain_unavailable', 'invalid_keychain_snapshot',
      'empty_keychain_snapshot', 'invalid_default_keychain_snapshot', 'keychain_outside_owned_home_refused',
      'keychain_search_isolation_failed', 'fixture_keychain_read_failed', 'user_keychain_probe_timeout', 'fixture_keychain_not_owned',
      'fresh_registered_identity_mismatch', 'unsafe_profile_ancestor', 'profile_ownership_unconfirmed', 'source_macos_version_unsupported',
      'invalid_macho_header', 'unsupported_macho_architecture', 'unsafe_macho_file', 'macho_changed_during_inspection',
      'macho_read_budget_exhausted', 'dia_arm64_binary_required', 'comparison_driver_inputs_changed',
      'comparison_driver_authority_missing', 'comparison_budget_exhausted'].includes(error.message)) receipt.blocker = error.message;
    const code = (error as { code?: string } | null)?.code;
    if (code && ['keychain_timeout', 'keychain_denied', 'keychain_not_found', 'keychain_error', 'db_read_error', 'db_corrupt', 'target_changed', 'target_mismatch'].includes(code)) receipt.blocker = code;
    receipt.initialFailure ??= { stage, blocker: receipt.blocker ?? 'qualification_step_failed',
      ...(browserRole ? { browser: browserRole, browserStage: receipt.browsers[browserRole].stage } : {}),
      ...(browserRole ? { timedOut: receipt.browsers[browserRole].timedOut } : {}),
      ...(stage === 'temporary_keychain' ? { keychainStage: receipt.keychainStage } : {}) };
    receipt.status = Object.values(receipt.cases).includes('failed') ? 'failed' : 'incomplete';
  } finally {
    cleaning = true;
    cleanupDeadline = performance.now() + 45_000;
    observer?.stop();
    for (const role of ['source', 'destination'] as const) {
      const facts = receipt.browsers[role];
      if (role === 'source' && comparisonAttempted && comparisonSource) {
        facts.ownedRootCount = comparisonSource.rootCount ?? 0;
        facts.rootStatesBeforeCleanup = comparisonSource.rootsBeforeCleanup ?? [];
        facts.stderrBeforeCleanup = comparisonSource.stderrBeforeCleanup ?? [];
        facts.launchAttempts = comparisonSource.launchAttempts ?? [];
        facts.cleanup = comparisonSource.cleanup;
        continue;
      }
      const children = (observer?.children ?? []).filter(child => (child.executable === account.destinationExecutable ? 'destination' : 'source') === role);
      facts.ownedRootCount = children.length;
      facts.rootStatesBeforeCleanup = browserRootFacts(children);
      facts.stderrBeforeCleanup = browserStderrFacts(children);
      facts.launchAttempts = attemptStarts[role] === undefined ? [] : (observer?.attempts ?? [])
        .slice(attemptStarts[role], role === 'source' ? attemptStarts.destination : undefined);
      facts.cleanup = { closeAttempted: false, groups: [] };
    }
    for (const [role, context] of [['source', source], ['destination', destination]] as const) {
      if (!context) continue;
      receipt.browsers[role].cleanup.closeAttempted = true;
      try { await bounded(context.close(), 5_000); }
      catch (error) { receipt.browsers[role].cleanup.closeError = browserPreflightError(error); }
    }
    let stopped = comparisonAttempted ? comparisonSource?.cleanup?.confirmed === true : !observer || observer.children.length >= launchAttempts;
    receipt.browserCleanup = { launchAttempts: comparisonAttempted ? 1 : launchAttempts,
      capturedRootCount: comparisonAttempted ? comparisonSource?.rootCount ?? 0 : observer?.children.length ?? 0,
      rootCaptureComplete: comparisonAttempted ? comparisonSource?.rootCount === 1 : stopped };
    for (const child of observer?.children ?? []) {
      const role = child.executable === account.destinationExecutable ? 'destination' : 'source';
      const group: Record<string, any> = { pid: child.pid, stage: 'probe_before_signal', signalSent: false, absenceConfirmed: false };
      receipt.browsers[role].cleanup.groups.push(group);
      const until = Math.min(cleanupDeadline, performance.now() + 5_000);
      try {
        await stopOwnedBrowserGroup(child, until, group);
      } catch (error) {
        stopped = false;
        group.childCloseObserved = child.closeObserved;
        group.failure = browserCleanupError(error);
        try {
          const timeout = Math.floor(Math.min(2_000, cleanupDeadline - performance.now()));
          if (timeout < 1) throw new Error('cleanup_budget_exhausted');
          const snapshot = spawnSync('/bin/ps', ['-axo', 'uid=,pid=,ppid=,pgid=,state='], {
            env: environment, encoding: 'utf8', timeout, maxBuffer: 128 * 1024,
          });
          if (snapshot.error || snapshot.status !== 0 || !snapshot.stdout.trim()) throw new Error('process_snapshot_unavailable');
          group.membersAfterFailure = browserGroupFacts(snapshot.stdout, account.uid, child.pid);
        } catch { group.membersAfterFailure = { available: false }; }
      }
      group.rootAfterCleanup = browserRootFacts([child])[0];
    }
    for (const role of ['source', 'destination'] as const) {
      receipt.browsers[role].stderrAfterCleanup = role === 'source' && comparisonAttempted ? comparisonSource?.stderrAfterCleanup ?? []
        : browserStderrFacts((observer?.children ?? []).filter(child => (child.executable === account.destinationExecutable ? 'destination' : 'source') === role));
    }
    receipt.cleanup.ownedBrowsersStopped = stopped;
    receipt.observedBrowserRoots = comparisonAttempted ? comparisonSource?.rootCount ?? 0 : observer?.children.length ?? 0;
    server?.stop(true);
    if (!profileCreationAttempted) receipt.cleanup.sourceProfileRemoved = true;
    else if (stopped && profileOwnership) {
      try { removeOwnedDiaProfile(profileOwnership, stopped); receipt.cleanup.sourceProfileRemoved = true; } catch {}
    }
    if (stopped) {
      try {
        if (keychainChanged) {
          let restored = true;
          for (const args of fixtureKeychainRestoreCommands({ search: originalSearch, default: originalDefault }, keychain, keychainCreated)) {
            try { run('/usr/bin/security', args); } catch { restored = false; }
          }
          if (!restored) throw new Error('keychain_restore_failed');
          const restoredSnapshot = captureUserKeychains(environment, [home, root], cleanupDeadline - performance.now());
          if (JSON.stringify(restoredSnapshot.search) !== JSON.stringify(originalSearch)
            || JSON.stringify(restoredSnapshot.default) !== JSON.stringify(originalDefault)) throw new Error('keychain_restore_failed');
        }
        receipt.cleanup.keychainRestored = true;
      } catch {}
    }
    try {
      if (mounted) run('/usr/bin/hdiutil', ['detach', mount], 10_000);
      receipt.cleanup.mountDetached = true;
    } catch {}
    if (stopped && receipt.cleanup.sourceProfileRemoved && receipt.cleanup.keychainRestored && receipt.cleanup.mountDetached) {
      try {
        if (realpathSync(root) !== root || path.dirname(root) !== runnerTemp) throw new Error('fixture_root_changed');
        rmSync(root, { recursive: true, force: true });
        receipt.cleanup.fixtureRemoved = true;
      } catch {}
    }
    if (Object.values(receipt.cleanup).some(value => value !== true)) { receipt.status = 'failed'; receipt.reason = 'cleanup_incomplete'; }
    receipt.counts = { pass: Object.values(receipt.cases).filter(value => value === 'passed').length,
      fail: Object.values(receipt.cases).filter(value => value === 'failed').length, skip: 0 };
    writePrivateReceipt(output, receipt);
  }
  return receipt;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === '--isolated-worker') {
      const receipt = await qualifyDia({ root: process.argv[3], configFile: process.argv[4] });
      console.log(JSON.stringify({ status: receipt.status, reason: receipt.reason, counts: receipt.counts, artifact: 'dia-native-qualification.json' }));
      process.exitCode = receipt.status === 'passed' ? 0 : 2;
    } else {
      validateQualificationHost(process.env);
      if (process.argv[2] !== '--fresh-account' || !process.argv[3]) throw new Error('fresh_account_configuration_required');
      const account = readFreshAccountConfiguration(process.argv[3]);
      if (account.guiReadiness) throw new Error('browser_qualification_authority_required');
      if (Bun.version !== '1.4.0' || require('playwright/package.json').version !== '1.62.1') throw new Error('pinned_runtimes_required');
      const originalHome = account.home;
      const originalHomeEnvironment = process.env.HOME;
      const runnerTemp = realpathSync(process.env.RUNNER_TEMP!);
      const output = path.join(runnerTemp, 'dia-native-qualification.json');
      if (existsSync(output)) throw new Error('fresh_receipt_path_required');
      const root = realpathSync(mkdtempSync(path.join(runnerTemp, 'dia-')));
      chmodSync(root, 0o700);
      const temporary = path.join(root, 't');
      mkdirSync(temporary, { mode: 0o700 });
      const metadata = Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP',
        'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GSTACK_DIA_NATIVE_QUALIFY', 'GSTACK_DIA_EXPECT_UID', 'GSTACK_DIA_SOURCE_REVISION']
        .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]!]));
      const child = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=/dev/null', import.meta.path,
        '--isolated-worker', root, account.configFile], {
        cwd: repository, env: { ...metadata, HOME: account.home, TMPDIR: temporary, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
        encoding: 'utf8', timeout: 630_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      if (realpathSync(homedir()) !== originalHome || process.env.HOME !== originalHomeEnvironment
        || child.error || ![0, 2].includes(child.status ?? -1) || !existsSync(output)) {
        let receipt: Record<string, any> = { counts: { pass: 0, fail: 0, skip: 0 }, cleanup: { confirmed: false } };
        if (existsSync(output)) {
          if (!lstatSync(output).isFile() || realpathSync(output) !== output || lstatSync(output).size > 1024 * 1024) throw new Error('invalid_worker_receipt');
          try { receipt = JSON.parse(readFileSync(output, 'utf8')); } catch {}
        }
        receipt.status = 'incomplete';
        receipt.reason = 'qualification_worker_did_not_complete';
        receipt.runId = process.env.GITHUB_RUN_ID;
        receipt.runAttempt = process.env.GITHUB_RUN_ATTEMPT;
        receipt.supervisor = { completed: false, exitCode: child.status };
        receipt.recovery = 'Discard this disposable runner; do not reuse its Keychain or staged profile.';
        writePrivateReceipt(output, receipt, existsSync(output));
        console.log(JSON.stringify({ status: 'incomplete', reason: 'qualification_worker_did_not_complete', artifact: 'dia-native-qualification.json' }));
        process.exitCode = 2;
      } else {
        const summary = JSON.parse(child.stdout);
        console.log(JSON.stringify({ status: summary.status, reason: summary.reason, counts: summary.counts, artifact: 'dia-native-qualification.json' }));
        process.exitCode = child.status === 0 && summary.status === 'passed' && summary.counts?.pass === 8 && summary.counts?.fail === 0 && summary.counts?.skip === 0 ? 0 : 2;
      }
    }
  } catch {
    console.log(JSON.stringify({ status: 'incomplete', reason: 'qualification_preflight_failed', counts: { pass: 0, fail: 0, skip: 0 } }));
    process.exitCode = 2;
  }
}
