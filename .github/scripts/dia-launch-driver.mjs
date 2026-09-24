import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertOwnedDiaProfile, browserOperationTimedOut, browserPreflightError, browserRootFacts, browserStartupFacts, browserStderrFacts,
  nativeDiaLaunchOptions, observeBrowserLaunches, ownsFreshAccount, parseDirectoryRecord,
  readFreshAccountConfiguration, stopOwnedBrowserGroup, validateQualificationHost } from './qualify-dia-macos.ts';

const require = createRequire(import.meta.url);
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

export function normalizedLaunchHashes(args, env, ownedPaths) {
  const paths = Object.entries(ownedPaths).sort(([, left], [, right]) => right.length - left.length);
  const normalize = value => {
    const equals = value.startsWith('--') ? value.indexOf('=') : -1;
    const prefix = equals >= 0 ? value.slice(0, equals + 1) : '';
    const candidate = equals >= 0 ? value.slice(equals + 1) : value;
    for (const [role, owned] of paths) {
      if (candidate === owned || candidate.startsWith(owned + path.sep)) return prefix + '<' + role + '>' + candidate.slice(owned.length);
    }
    return value;
  };
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { argvSha256: hash(args.map(normalize)), environmentSha256: hash(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, normalize(value)])) };
}

export function compareDiaLaunchReceipts(left, right) {
  const invalid = { comparable: false, qualificationCredit: false, reason: 'incomplete_or_incompatible_arms' };
  if (!left?.launcher?.accountGuid || left.launcher.accountGuid === right?.launcher?.accountGuid) return invalid;
  const fingerprints = [];
  for (const [receipt, runtime] of [[left, 'bun'], [right, 'node']]) {
    const qualification = receipt?.qualification;
    const control = receipt?.backgroundPreflight?.comparisonControl;
    const source = qualification?.launchComparison?.source;
    const config = receipt?.launchComparison;
    if (config?.mode !== 'launch-only' || config.runtime !== runtime || config.qualificationCredit !== false
      || receipt.backgroundPreflight?.status !== 'passed' || !control?.ready || qualification?.launchComparison?.qualificationCredit !== false
      || qualification.keychainStage !== 'completed' || qualification.isolation?.registeredIdentity !== true
      || qualification.isolation?.sharedRegisteredHome !== true || qualification.artifact?.signatureVerified !== true
      || qualification.artifact?.gatekeeperNotarized !== true || qualification.artifact?.macosCompatibility?.compatible !== true
      || qualification.platform?.os !== 'darwin' || qualification.platform?.architecture !== 'arm64'
      || qualification.platform?.bun !== '1.4.0' || qualification.platform?.playwright !== '1.62.1'
      || !/^\d+(?:\.\d+){1,2}$/.test(qualification.artifact.macosCompatibility.hostVersion)
      || qualification.artifact?.architectures?.includes('arm64') !== true
      || ['serviceStopped', 'userDomainStopped', 'userProcessesStopped', 'accountRemoved', 'groupRemoved', 'stagingRemoved'].some(key => receipt.launcherCleanup?.[key] !== true)
      || ['ownedBrowsersStopped', 'sourceProfileRemoved', 'keychainRestored', 'mountDetached', 'fixtureRemoved'].some(key => qualification.cleanup?.[key] !== true)
      || ['pass', 'fail', 'skip'].some(key => receipt.counts?.[key] !== 0 || qualification.counts?.[key] !== 0)) return invalid;
    for (const [result, purpose] of [[control, 'control'], [source, 'source']]) {
      const policy = result?.launchAttempts?.[0];
      if (result?.protocol !== 1 || result.purpose !== purpose || result.samplingEnabled !== false || result.rootCount !== 1
        || result.supervisor?.closed !== true || result.supervisor?.exitCode !== 0 || result.cleanup?.confirmed !== true
        || result.cleanup?.childClosed !== true || result.cleanup?.groupAbsent !== true || result.cleanup?.launchSettled !== true || result.launchAttempts?.length !== 1
        || result.cleanup?.groups?.length !== 1 || result.cleanup.groups[0].absenceConfirmed !== true || result.cleanup.groups[0].childCloseObserved !== true
        || typeof result.ready !== 'boolean' || typeof result.launchReturned !== 'boolean'
        || policy?.sandboxRequired !== true || policy?.sandboxDisablingFlag !== false || policy?.pipeFlag !== true || policy?.tcpDebuggingFlag !== false
        || policy?.mockKeychainFlag !== false || policy?.passwordStoreFlag !== false || policy?.firstRunSuppressed !== false
        || policy?.headlessFlag !== true || policy?.expectedProfile !== true || policy?.detached !== true || policy?.shellDisabled !== true
        || policy?.stdioCount !== 5 || policy?.extraPipeDescriptors !== true || policy?.profileArgumentCount !== 1
        || result.driver?.runtime !== runtime || result.driver?.version !== (runtime === 'bun' ? '1.4.0' : '24.18.0')
        || result.driver?.os !== 'darwin' || result.driver?.architecture !== 'arm64' || result.driver?.playwright !== '1.62.1'
        || result.driver?.release !== qualification.platform.release
        || result.driver?.executableSha256 !== config.executableSha256 || result.driver?.driverSha256 !== config.driverSha256
        || result.driver?.helpersSha256 !== config.helpersSha256 || (result.ready && (!result.protocolResponded || !result.startupPages?.allowed || !result.postProbePages?.allowed))
        || ![result.argvSha256, result.environmentSha256, config.executableSha256, config.driverSha256, config.helpersSha256].every(value => /^[a-f0-9]{64}$/.test(value))) return invalid;
    }
    const hashes = [receipt.launcher?.sourceRevision, receipt.launcher?.archiveSha256, receipt.launcher?.destinationSha256,
      qualification.artifact.sha256, qualification.artifact.executableSha256];
    if (!/^[a-f0-9]{40}$/.test(hashes[0]) || !hashes.slice(1).every(value => /^[a-f0-9]{64}$/.test(value))) return invalid;
    fingerprints.push(JSON.stringify({ hashes, platform: qualification.platform, compatibility: qualification.artifact.macosCompatibility,
      version: qualification.artifact.version, bundle: qualification.artifact.bundleId, team: qualification.artifact.team,
      driver: config.driverSha256, helpers: config.helpersSha256, controlArgs: control.argvSha256, controlEnv: control.environmentSha256,
      sourceArgs: source.argvSha256, sourceEnv: source.environmentSha256 }));
  }
  if (fingerprints[0] !== fingerprints[1]) return { ...invalid, reason: 'comparison_inputs_differ' };
  const bun = left.qualification.launchComparison.source.ready === true;
  const node = right.qualification.launchComparison.source.ready === true;
  return { comparable: true, qualificationCredit: false, outcome: bun ? node ? 'both_ready' : 'bun_only_ready' : node ? 'node_only_ready' : 'neither_ready' };
}

export async function runProtectedLaunch(executable, profile, env, purpose, ownedPaths) {
  const result = { protocol: 1, purpose, stage: 'runtime_import', launchReturned: false, protocolResponded: false, ready: false,
    timedOut: false, error: null, samplingEnabled: false, cleanup: { childClosed: false, groupAbsent: false, confirmed: false } };
  const { chromium } = await import('playwright');
  const cp = require('node:child_process');
  const original = cp.spawn;
  cp.spawn = function(command, args, options) {
    if (command === executable) Object.assign(result, normalizedLaunchHashes(args, options.env, ownedPaths));
    return original.call(this, command, args, options);
  };
  const observer = observeBrowserLaunches(new Map([[executable, profile]]));
  let context;
  let timer;
  let launchSettled = false;
  try {
    result.stage = 'launch';
    const launch = chromium.launchPersistentContext(profile, nativeDiaLaunchOptions(executable, env));
    void launch.then(() => { launchSettled = true; }, () => { launchSettled = true; });
    context = await Promise.race([launch,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation_timeout')), 30_000); })]);
    clearTimeout(timer);
    result.launchReturned = true;
    result.stage = 'ownership';
    if (observer.children.length !== 1) throw new Error('source_process_ownership_unconfirmed');
    result.stage = 'startup_pages';
    const urls = context.pages().map(page => page.url());
    result.startupPages = { ...browserStartupFacts(urls, 'http://127.0.0.1:1'), allowed: urls.every(url => url === 'about:blank') };
    if (!result.startupPages.allowed) throw new Error('onboarding_or_external_page');
    result.stage = 'protocol_probe';
    if (!context.pages()[0]) throw new Error('source_protocol_page_unavailable');
    result.protocolResponded = await Promise.race([context.pages()[0].evaluate(() => 1).then(value => value === 1),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation_timeout')), 5000); })]);
    clearTimeout(timer);
    const after = context.pages().map(page => page.url());
    result.postProbePages = { ...browserStartupFacts(after, 'http://127.0.0.1:1'), allowed: after.every(url => url === 'about:blank') };
    if (!result.postProbePages.allowed) throw new Error('onboarding_or_external_page');
    result.ready = result.protocolResponded;
    result.stage = 'ready';
  } catch (error) {
    const reasons = browserStderrFacts(observer.children).flatMap(facts => Object.entries(facts.reasonCounts ?? {})
      .filter(([, count]) => count > 0).map(([reason]) => reason));
    result.error = browserPreflightError(error, reasons);
    result.timedOut = browserOperationTimedOut(error);
  } finally {
    clearTimeout(timer);
    const deadline = performance.now() + 5_000;
    observer.stop();
    result.rootCount = observer.children.length;
    result.launchAttempts = observer.attempts;
    result.rootsBeforeCleanup = browserRootFacts(observer.children);
    result.stderrBeforeCleanup = browserStderrFacts(observer.children);
    if (context) void context.close().catch(() => {});
    const groups = [];
    for (const child of observer.children) {
      const facts = { pid: child.pid, signalSent: false, absenceConfirmed: false, childCloseObserved: false };
      try { await stopOwnedBrowserGroup(child, deadline, facts); }
      catch { facts.failed = true; }
      groups.push(facts);
    }
    result.cleanup.groups = groups;
    result.cleanup.childClosed = observer.children.length === 1 && observer.children.every(child => child.closeObserved);
    result.cleanup.groupAbsent = groups.length === 1 && groups.every(group => group.absenceConfirmed);
    result.cleanup.launchSettled = launchSettled;
    result.cleanup.confirmed = result.cleanup.childClosed && result.cleanup.groupAbsent && launchSettled;
    result.rootsAfterCleanup = browserRootFacts(observer.children);
    result.stderrAfterCleanup = browserStderrFacts(observer.children);
    if (launchSettled) { observer.restore(); cp.spawn = original; }
  }
  return result;
}

export function readComparisonRequest() {
  const buffer = Buffer.alloc(16 * 1024 + 1);
  let length = 0;
  while (length < buffer.length) {
    const read = readSync(0, buffer, length, buffer.length - length, null);
    if (!read) break;
    length += read;
  }
  if (length > 16 * 1024) throw new Error('invalid_driver_request');
  const request = JSON.parse(buffer.subarray(0, length).toString());
  if (!request || !['control', 'source'].includes(request.purpose)
    || Object.keys(request).some(key => !(request.purpose === 'control' ? ['purpose'] : ['purpose', 'assetRoot', 'executableName', 'executableSha256']).includes(key))) throw new Error('invalid_driver_request');
  return request;
}

async function main() {
  validateQualificationHost(process.env);
  const request = readComparisonRequest();
  const account = readFreshAccountConfiguration(process.argv[2], 'comparison-driver');
  const config = account.launchComparison;
  const runtimeVersion = process.versions.bun ?? process.versions.node;
  if ((config.runtime === 'bun' ? process.versions.bun !== '1.4.0' : Boolean(process.versions.bun) || runtimeVersion !== '24.18.0')
    || process.arch !== 'arm64' || require('playwright/package.json').version !== '1.62.1') throw new Error('invalid_driver_runtime');
  if (await sha256(process.execPath) !== config.executableSha256 || await sha256(import.meta.filename) !== config.driverSha256
    || await sha256(path.join(import.meta.dirname, 'qualify-dia-macos.ts')) !== config.helpersSha256) throw new Error('driver_inputs_changed');
  const identity = spawnSync('/usr/bin/dscl', ['.', '-read', '/Users/' + account.account, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID'],
    { env: account.environment, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
  if (identity.error || identity.status !== 0 || !ownsFreshAccount(parseDirectoryRecord(identity.stdout), account)) throw new Error('driver_identity_unconfirmed');
  let executable = account.destinationExecutable;
  let profile = path.join(account.temporary, 'probe/chromium');
  let temporary = account.temporary;
  const ownedPaths = { home: account.home, snapshot: account.snapshot, temporary: account.temporary, work: account.work };
  if (request.purpose === 'source') {
    const root = request.assetRoot;
    if (typeof root !== 'string' || realpathSync(root) !== root || path.dirname(root) !== account.temporary || !path.basename(root).startsWith('dia-')
      || lstatSync(root).uid !== account.uid || typeof request.executableName !== 'string' || !request.executableName
      || path.basename(request.executableName) !== request.executableName || ['.', '..'].includes(request.executableName)) throw new Error('invalid_source_request');
    executable = realpathSync(path.join(root, 'Dia.app/Contents/MacOS', request.executableName));
    if (!executable.startsWith(path.join(root, 'Dia.app/Contents/MacOS') + path.sep)
      || !/^[a-f0-9]{64}$/.test(request.executableSha256) || await sha256(executable) !== request.executableSha256) throw new Error('source_identity_unconfirmed');
    profile = path.join(account.home, 'Library/Application Support/Dia/User Data');
    if (realpathSync(profile) !== profile || lstatSync(profile).uid !== account.uid) throw new Error('source_profile_unowned');
    if (JSON.stringify(readdirSync(profile)) !== JSON.stringify(['.gstack-dia-owner'])) throw new Error('source_profile_not_fresh');
    const descriptor = openSync(path.join(profile, '.gstack-dia-owner'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const marker = Buffer.alloc(65);
    let bytes;
    try {
      const entry = fstatSync(descriptor);
      if (!entry.isFile() || entry.uid !== account.uid || entry.nlink !== 1 || entry.size !== 64 || (entry.mode & 0o077) !== 0) throw new Error('source_profile_unowned');
      bytes = readSync(descriptor, marker, 0, marker.length, 0);
    } finally { closeSync(descriptor); }
    if (bytes !== 64) throw new Error('source_profile_unowned');
    const info = lstatSync(profile, { bigint: true });
    assertOwnedDiaProfile({ home: account.home, profile, uid: account.uid, dev: info.dev, ino: info.ino, nonce: marker.subarray(0, bytes).toString() });
    temporary = path.join(root, 't');
    ownedPaths.assets = root;
  } else {
    if (await sha256(executable) !== account.destinationSha256) throw new Error('control_identity_unconfirmed');
    try { lstatSync(profile); throw new Error('control_profile_not_fresh'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const env = { HOME: account.home, TMPDIR: temporary, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
  const result = await runProtectedLaunch(executable, profile, env, request.purpose, ownedPaths);
  result.driver = { runtime: config.runtime, version: runtimeVersion, architecture: process.arch, os: process.platform, release: release(),
    executableSha256: config.executableSha256, driverSha256: config.driverSha256, helpersSha256: config.helpersSha256, playwright: '1.62.1' };
  return result;
}

if (import.meta.main) {
  main().then(result => { process.stdout.write(JSON.stringify(result) + '\n'); }, () => {
    process.stdout.write(JSON.stringify({ protocol: 1, ready: false, error: 'driver_admission_failed', cleanup: { confirmed: false } }) + '\n');
    process.exitCode = 2;
  });
}
