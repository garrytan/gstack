import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { assertDiaSocketPath, browserPreflightError, browserStartupCategory, captureUserKeychains, fixtureKeychainRestoreCommands, FRESH_WORK_PREFIX, type FreshAccount,
  nativeDiaLaunchOptions, observeBrowserLaunches, observeFixtureKeychain, ownsFreshAccount, parseDirectoryRecord, stopOwnedBrowserGroup,
  inspectMachOArchitectures, playwrightModuleLoadFacts, prepareKeychainHome, readFreshAccountConfiguration, runDiaLaunchComparison, runGuiReadiness,
  validateQualificationHost, writePrivateReceipt } from './qualify-dia-macos';
export { FRESH_WORK_PREFIX, ownsFreshAccount, parseDirectoryRecord } from './qualify-dia-macos';

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dir, '../..');

interface UserDomainObservation {
  uid: number;
  state: 'present' | 'absent' | 'unavailable';
  hasGuiDomain: boolean;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  structure?: {
    complete: boolean;
    type: 'user' | 'other' | 'unavailable';
    handleMatchesUid: boolean | null;
    creator: 'launchctl' | 'other' | 'unavailable';
    creatorIsProbe: boolean | null;
    counts: Record<string, number | null>;
    sectionNonemptyLines: Record<string, number | null>;
  };
}

export function classifyUserDomain(uid: number, result: { status: number | null; stdout: string; stderr: string; error?: unknown }, probePid?: number): UserDomainObservation {
  if (!Number.isSafeInteger(uid) || uid < 20_000 || uid >= 60_000) throw new Error('invalid_fresh_user_domain');
  const text = result.stdout.trimStart();
  const diagnostic = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  const missing = new RegExp('^(?:Bad request\\.\\s*)?Could not find domain for (?:(?:user (?:uid|user)|uid|user):\\s*' + uid + '|user/' + uid + ')\\.?$');
  const present = !result.error && result.status === 0
    && (text.startsWith('user/' + uid + ' = {') || text.startsWith('com.apple.xpc.launchd.domain.user.' + uid + ' = {'));
  const absent = !result.error && Number.isInteger(result.status) && result.status! > 0 && missing.test(diagnostic);
  const observation: UserDomainObservation = { uid, state: present ? 'present' : absent ? 'absent' : 'unavailable',
    hasGuiDomain: present && (new RegExp('\\bgui/' + uid + '(?:\\b|/)').test(text) || /\bsession\s*=\s*Aqua\b/.test(text)
      || new RegExp('com\\.apple\\.xpc\\.launchd\\.user\\.domain\\.' + uid + '\\.\\d+\\.Aqua\\b').test(text)),
    exitCode: result.status, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) };
  if (!present || observation.stdoutBytes > 1024 * 1024) return observation;
  const lines = text.trimEnd().split('\n');
  const indent = lines.find(line => /^\s+type = \S+\s*$/.test(line))?.match(/^(\s+)/)?.[1];
  const fields = new Map<string, string>();
  const sections: Record<string, number | null> = Object.fromEntries(['services', 'jobs', 'subdomains', 'unmanaged processes', 'endpoints',
    'externally-hosted endpoints', 'pending requests', 'pending attachments'].map(key => [key, null]));
  let complete = Boolean(indent) && lines.at(-1) === '}';
  for (let index = 1; indent && index < lines.length - 1; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (!line.startsWith(indent) || /^\s/.test(line.slice(indent.length))) { complete = false; break; }
    const entry = line.slice(indent.length).match(/^([^=]+?) = (.*)$/);
    if (!entry || fields.has(entry[1])) { complete = false; break; }
    fields.set(entry[1], entry[2]);
    if (entry[2] === '{') {
      let nonemptyLines = 0;
      while (++index < lines.length - 1 && lines[index] !== indent + '}') {
        if (lines[index].trim()) nonemptyLines++;
      }
      if (index >= lines.length - 1) { complete = false; break; }
      if (Object.hasOwn(sections, entry[1])) sections[entry[1]] = nonemptyLines;
    } else if (entry[2] === '{}' && Object.hasOwn(sections, entry[1])) sections[entry[1]] = 0;
  }
  const counts = Object.fromEntries(['active count', 'on-demand count', 'service count', 'active service count', 'external activation count',
    'in-progress bootstraps', 'pended requests', 'creator euid'].map(key => {
    const value = fields.get(key);
    return [key, value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null];
  }));
  const creatorMatch = fields.get('creator')?.match(/^launchctl(?:\.([1-9]\d*)|\[([1-9]\d*)\])$/);
  const creatorPid = creatorMatch?.[1] ?? creatorMatch?.[2];
  observation.structure = { complete, type: fields.has('type') ? fields.get('type') === 'user' ? 'user' : 'other' : 'unavailable',
    handleMatchesUid: fields.has('handle') ? fields.get('handle') === String(uid) : null,
    creator: creatorPid ? 'launchctl' : fields.has('creator') ? 'other' : 'unavailable',
    creatorIsProbe: creatorPid && Number.isSafeInteger(probePid) && probePid! > 0 ? Number(creatorPid) === probePid : null,
    counts, sectionNonemptyLines: sections };
  return observation;
}

export function inspectUserDomain(uid: number, deadline: number, env: Record<string, string>, spawn: typeof spawnSync = spawnSync): UserDomainObservation {
  if (!Number.isSafeInteger(uid) || uid < 20_000 || uid >= 60_000) throw new Error('invalid_fresh_user_domain');
  if (!Number.isFinite(deadline)) throw new Error('fresh_launcher_deadline');
  const timeout = Math.floor(Math.min(3_000, deadline - performance.now()));
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error('fresh_launcher_deadline');
  const result = spawn('/usr/bin/sudo', ['-n', '/bin/sh', '-c', 'printf "GSTACK_DIA_DOMAIN_PROBE_PID=%s\\n" "$$"; exec /bin/launchctl print "$1"',
    'gstack-dia-domain-probe', 'user/' + uid], { env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const prefix = stdout.match(/^GSTACK_DIA_DOMAIN_PROBE_PID=([1-9]\d*)\n/);
  const pid = prefix ? Number(prefix[1]) : undefined;
  return classifyUserDomain(uid, { ...result, stdout: prefix ? stdout.slice(prefix[0].length) : stdout, stderr,
    error: result.error || (!Number.isSafeInteger(pid) ? new Error('domain_probe_pid_unavailable') : undefined) }, pid);
}

export function classifyParentDomain(uid: number, result: { status: number | null; stdout: string; stderr: string; error?: unknown }) {
  if (!Number.isSafeInteger(uid) || uid < 20_000 || uid >= 60_000) throw new Error('invalid_fresh_user_domain');
  const observation = { uid, state: 'unavailable' as 'present' | 'absent' | 'unavailable', parseStage: 'command_failure',
    subdomainCount: 0, matchingUserDomains: 0, matchingGuiDomains: 0, unrecognizedEntries: 0, duplicateEntries: 0,
    exitCode: result.status, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) };
  if (result.error || result.status !== 0) return observation;
  observation.parseStage = 'oversized';
  if (observation.stdoutBytes > 1024 * 1024) return observation;
  observation.parseStage = 'unexpected_parent';
  const lines = result.stdout.trim().split('\n');
  if (!['system = {', 'com.apple.xpc.launchd.domain.system = {'].includes(lines[0]) || lines.at(-1) !== '}') return observation;
  const indent = lines.find(line => /^\s+type = system$/.test(line))?.match(/^(\s+)/)?.[1];
  if (!indent) return observation;
  const fields = new Set<string>();
  let subdomains: string[] | undefined;
  observation.parseStage = 'malformed_structure';
  for (let index = 1; index < lines.length - 1; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (!line.startsWith(indent) || /^\s/.test(line.slice(indent.length))) return observation;
    const entry = line.slice(indent.length).match(/^([^=]+?) = (.*)$/);
    if (!entry || fields.has(entry[1])) return observation;
    fields.add(entry[1]);
    if (entry[2] === '{') {
      const start = index + 1;
      while (++index < lines.length - 1 && lines[index] !== indent + '}') {}
      if (index >= lines.length - 1) return observation;
      if (entry[1] === 'subdomains') subdomains = lines.slice(start, index).map(line => line.trim()).filter(Boolean);
    } else if (entry[1] === 'subdomains' && entry[2] === '{}') subdomains = [];
  }
  observation.parseStage = 'missing_subdomains';
  if (!subdomains) return observation;
  const seen = new Set<string>();
  for (const entry of subdomains) {
    observation.subdomainCount++;
    const user = entry.match(/^(?:user\/|com\.apple\.xpc\.launchd\.domain\.user\.)(\d+)$/);
    const gui = entry.match(/^(?:gui\/(\d+)|com\.apple\.xpc\.launchd\.user\.domain\.(\d+)\.\d+\.Aqua)$/);
    const listedUid = user?.[1] ?? gui?.[1] ?? gui?.[2];
    const process = entry.match(/^(?:pid\/(\d+)|com\.apple\.xpc\.launchd\.domain\.pid\.[^{}\r\n]+\.(\d+))$/);
    const session = entry.match(/^(?:session\/(\d+)|com\.apple\.xpc\.launchd\.domain\.session\.(\d+))$/);
    const identity = user ? 'user/' + listedUid : gui ? 'gui/' + listedUid : process ? 'pid/' + (process[1] ?? process[2])
      : session ? 'session/' + (session[1] ?? session[2]) : entry;
    if (seen.has(identity)) observation.duplicateEntries++;
    seen.add(identity);
    if (listedUid && (!Number.isSafeInteger(Number(listedUid)) || String(Number(listedUid)) !== listedUid)) observation.unrecognizedEntries++;
    else if (user) observation.matchingUserDomains += Number(user[1]) === uid ? 1 : 0;
    else if (gui) observation.matchingGuiDomains += Number(gui[1] ?? gui[2]) === uid ? 1 : 0;
    else if (!/^(?:(?:pid|session|login)\/\d+|com\.apple\.xpc\.launchd\.domain\.(?:pid\.[^{}\r\n]+\.\d+|session\.\d+))$/.test(entry)) observation.unrecognizedEntries++;
  }
  observation.parseStage = observation.unrecognizedEntries ? 'unrecognized_subdomain' : observation.duplicateEntries ? 'duplicate_subdomain' : 'parsed';
  if (!observation.unrecognizedEntries && !observation.duplicateEntries) observation.state = observation.matchingUserDomains || observation.matchingGuiDomains ? 'present' : 'absent';
  return observation;
}

type ParentDomainObservation = ReturnType<typeof classifyParentDomain>;

export function passiveUserDomainState(observation: ParentDomainObservation | undefined, uid: number): 'absent' | 'present' | 'unavailable' {
  if (!observation || observation.uid !== uid || observation.exitCode !== 0 || observation.parseStage !== 'parsed'
    || observation.duplicateEntries !== 0 || observation.unrecognizedEntries !== 0 || observation.matchingGuiDomains !== 0) return 'unavailable';
  if (observation.state === 'absent' && observation.matchingUserDomains === 0) return 'absent';
  if (observation.state === 'present' && observation.matchingUserDomains === 1) return 'present';
  return 'unavailable';
}

export function inspectParentDomain(uid: number, deadline: number, env: Record<string, string>, spawn: typeof spawnSync = spawnSync) {
  if (!Number.isSafeInteger(uid) || uid < 20_000 || uid >= 60_000) throw new Error('invalid_fresh_user_domain');
  const timeout = Math.floor(Math.min(3_000, deadline - performance.now()));
  if (!Number.isFinite(deadline) || !Number.isFinite(timeout) || timeout < 1) throw new Error('fresh_launcher_deadline');
  const result = spawn('/usr/bin/sudo', ['-n', '/bin/launchctl', 'print', 'system'], { env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  return classifyParentDomain(uid, { ...result, stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '' });
}

export const ARCHIVE_CHECK = `import json, posixpath, sys, tarfile, unicodedata
try:
    with tarfile.open(sys.argv[1], 'r:') as archive:
        members = archive.getmembers()
        if len(members) > 200000 or sum(item.size for item in members) > 2 * 1024**3:
            raise ValueError()
        seen, links = set(), set()
        for item in members:
            name = item.name.rstrip('/')
            if not name or name.startswith('/') or '\\\\' in name or any(ord(char) < 32 for char in name):
                raise ValueError()
            canonical = unicodedata.normalize('NFC', name).casefold()
            if '..' in name.split('/') or posixpath.normpath(name) != name or canonical in seen:
                raise ValueError()
            if not (item.isfile() or item.isdir() or item.issym()):
                raise ValueError()
            seen.add(canonical)
            if item.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname))
                if item.linkname.startswith('/') or '\\\\' in item.linkname or '..' in item.linkname.split('/') or target == '..' or target.startswith('../'):
                    raise ValueError()
                links.add(canonical)
        for item in members:
            parts = unicodedata.normalize('NFC', item.name.rstrip('/')).casefold().split('/')
            if any('/'.join(parts[:index]) in links for index in range(1, len(parts))):
                raise ValueError()
    print(json.dumps({'valid': True, 'members': len(members)}))
except Exception:
    print(json.dumps({'valid': False, 'reason': 'unsafe_source_archive'}))
    sys.exit(2)
`;

export const PRIVATE_RECEIPT_READ = `import json, os, stat, sys
fds = []
try:
    file, uid, root = sys.argv[1], int(sys.argv[2]), os.path.realpath(sys.argv[3])
    if root != sys.argv[3] or not os.path.isabs(file) or os.path.normpath(file) != file or os.path.commonpath([file, root]) != root:
        raise ValueError()
    parts = os.path.relpath(file, root).split(os.sep)
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError()
    fds.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
    for part in parts[:-1]:
        fds.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fds[-1]))
        parent = os.fstat(fds[-1])
        if parent.st_uid != uid or parent.st_mode & 0o022:
            raise ValueError()
    fds.append(os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fds[-1]))
    fd = fds[-1]
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022 or info.st_size > 1024**2:
        raise ValueError()
    data = os.read(fd, 1024**2 + 1)
    after = os.fstat(fd)
    if len(data) != info.st_size or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError()
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError()
    print(json.dumps(value))
except Exception:
    sys.exit(2)
finally:
    for fd in reversed(fds):
        os.close(fd)
`;

export function uidProcessFacts(output: string, uid: number) {
  const known = ['bun', 'security', 'osascript', 'launchd', 'cfprefsd', 'trustd', 'distnoted', 'lsd', 'tccd', 'securityd', 'secd', 'usernoted',
    'UserEventAgent', 'pkd', 'nsurlsessiond', 'containermanagerd', 'Google Chrome for Testing', 'Google Chrome', 'Chromium',
    'Chromium Helper', 'Dia', 'Dia Helper', 'chrome', 'chrome_crashpad_handler'];
  const aliases = new Map(known.flatMap(name => [name, name.slice(0, 15), name.slice(0, 16)].map(alias => [alias, name] as const)));
  const processes: Array<{ pid: number; ppid: number; state: string; basename: string }> = [];
  for (const line of output.split('\n').filter(line => line.trim())) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) throw new Error('invalid_uid_process_snapshot');
    if (Number(match[1]) !== uid) continue;
    const pid = Number(match[2]);
    const ppid = Number(match[3]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(ppid) || ppid < 0) throw new Error('invalid_uid_process_snapshot');
    const state = ['I', 'R', 'S', 'T', 'U', 'Z', 'D', 'X'].includes(match[4][0]) ? match[4][0] : 'other';
    processes.push({ pid, ppid, state, basename: aliases.get(match[5]) ?? 'other' });
  }
  return { available: true, count: processes.length, zombies: processes.filter(process => process.state === 'Z').length,
    live: processes.filter(process => process.state !== 'Z').length, truncated: processes.length > 64, processes: processes.slice(0, 64) };
}

export function inspectUidProcesses(uid: number, deadline: number, env: Record<string, string>, spawn: typeof spawnSync = spawnSync) {
  if (!Number.isSafeInteger(uid) || uid < 20_000 || uid >= 60_000) throw new Error('invalid_fresh_user_domain');
  try {
    const timeout = Math.floor(Math.min(2_000, deadline - performance.now()));
    if (!Number.isFinite(deadline) || !Number.isFinite(timeout) || timeout < 1) throw new Error('fresh_launcher_deadline');
    const result = spawn('/bin/ps', ['-axo', 'uid=,pid=,ppid=,state=,ucomm='], { env, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) throw new Error('uid_process_snapshot_failed');
    return uidProcessFacts(result.stdout, uid);
  } catch { return { available: false }; }
}

export function freshQualificationPassed(workerExit: number | undefined, backgroundStatus: unknown, qualificationStatus: unknown, cleanup: Record<string, unknown>): boolean {
  return workerExit === 0 && backgroundStatus === 'passed' && qualificationStatus === 'passed'
    && ['serviceStopped', 'userDomainStopped', 'userProcessesStopped', 'accountRemoved', 'groupRemoved', 'stagingRemoved'].every(key => cleanup[key] === true)
    && Object.values(cleanup).every(value => value === true);
}

export function parseDirectoryIds(output: string): Set<number> {
  const ids = new Set<number>();
  for (const line of output.split('\n').filter(line => line.trim())) {
    const value = line.match(/^\S.*?\s+(-?\d+)\s*$/)?.[1];
    if (!value || !Number.isSafeInteger(Number(value))) throw new Error('invalid_directory_id_list');
    ids.add(Number(value));
  }
  if (!ids.size) throw new Error('empty_directory_id_list');
  return ids;
}

export function ownedUserDomainTarget(record: Record<string, string>, account: Pick<FreshAccount, 'guid' | 'uid' | 'gid' | 'home'>,
  beforeCreation: ParentDomainObservation | undefined, current: ParentDomainObservation, currentUid = process.getuid?.()): string | null {
  const currentState = passiveUserDomainState(current, account.uid);
  if (!Number.isSafeInteger(account.uid) || account.uid < 20_000 || account.uid >= 60_000 || account.uid === currentUid
    || !Number.isSafeInteger(currentUid) || !ownsFreshAccount(record, account)
    || passiveUserDomainState(beforeCreation, account.uid) !== 'absent' || currentState === 'unavailable') {
    throw new Error('fresh_user_domain_ownership_unconfirmed');
  }
  return currentState === 'present' ? 'user/' + account.uid : null;
}

export function freshLaunchDefinition(account: FreshAccount) {
  return {
    Label: account.label, UserName: account.account, GroupName: account.account, SessionCreate: true,
    RunAtLoad: true, KeepAlive: false, ExitTimeOut: 5, Umask: 63,
    WorkingDirectory: account.snapshot,
    ProgramArguments: [account.bun, '--no-env-file', '--no-install', '--no-macros', '--config=/dev/null',
      path.join(account.snapshot, '.github/scripts/run-dia-native-qualification.ts'), '--fresh-worker', account.configFile],
    EnvironmentVariables: account.environment,
    StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null',
  };
}

export function ownsLaunchService(state: string, account: Pick<FreshAccount, 'label' | 'bun' | 'account'>): boolean {
  return state.trimStart().startsWith('system/' + account.label + ' = {')
    && state.match(/^\s*program = (.+)$/m)?.[1].trim() === account.bun
    && state.match(/^\s*username = (.+)$/m)?.[1].trim() === account.account
    && state.match(/^\s*group = (.+)$/m)?.[1].trim() === account.account;
}

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeCommand(command: string, args: string[], timeout: number, env: NodeJS.ProcessEnv, cwd?: string) {
  timeout = Math.floor(timeout);
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error('native_operation_timed_out');
  const result = spawnSync(command, args, { env, cwd, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const elevated = command === '/usr/bin/sudo';
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    throw Object.assign(new Error('native_command_failed'), { diagnostic: {
      command: path.basename(elevated ? args[1] : command), operation: args[elevated ? 2 : 0], exitCode: result.status,
      stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || ''),
      spawnError: result.error ? (['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(errorCode || '') ? errorCode : 'spawn_failed') : undefined,
    } });
  }
  return result.stdout.trim();
}

async function limit<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('native_operation_timed_out')), timeout);
    })]);
  } finally { clearTimeout(timer!); }
}

async function freshWorker(configFile: string) {
  validateQualificationHost(process.env);
  const account = readFreshAccountConfiguration(configFile);
  const preflightFile = path.join(account.temporary, 'dia-background-preflight.json');
  const seed = lstatSync(preflightFile);
  if (!seed.isFile() || seed.uid !== process.getuid?.() || realpathSync(preflightFile) !== preflightFile) throw new Error('unsafe_preflight_receipt');
  const receipt: Record<string, any> = { status: 'incomplete', reason: 'fresh_identity_preflight', nativeCasesRun: false,
    preflight: { registeredIdentity: false, foundationHome: false, keychain: false, headlessChromium: false },
    cleanup: { probeBrowsersStopped: false, probeKeychainRestored: false }, sessionCreate: true };
  const env = account.environment;
  let cleaning = false;
  const run = (command: string, args: string[], timeout = 10_000) => {
    try { return safeCommand(command, args, timeout, env, account.snapshot); }
    catch (error) {
      const diagnostic = (error as { diagnostic?: object }).diagnostic ?? { command: path.basename(command), operation: args[0] };
      if (cleaning) (receipt.cleanupCommandFailures ??= []).push(diagnostic);
      else receipt.initialCommandFailure ??= diagnostic;
      throw new Error('native_command_failed');
    }
  };
  let context: any;
  let observer: ReturnType<typeof observeBrowserLaunches> | undefined;
  let comparisonControl: Record<string, any> | undefined;
  let launchAttempted = false;
  let keychainCreated = false;
  let keychainChanged = false;
  let snapshot: ReturnType<typeof captureUserKeychains> | undefined;
  const probe = path.join(account.temporary, 'probe');
  const keychain = path.join(probe, 'probe.keychain-db');
  try {
    if (!/^[a-z][a-z0-9]{8,24}$/.test(account.account) || process.getuid?.() !== account.uid || process.geteuid?.() !== account.uid
      || process.getgid?.() !== account.gid || realpathSync(homedir()) !== account.home || realpathSync(account.work) !== account.work) throw new Error('fresh_identity_mismatch');
    for (const directory of [account.home, account.temporary, account.snapshot, path.dirname(account.bun),
      ...(account.guiReadiness ? [] : [path.join(account.snapshot, 'node_modules')])]) {
      if (!directory.startsWith(account.work + path.sep) || realpathSync(directory) !== directory || lstatSync(directory).uid !== account.uid) throw new Error('fresh_directory_ownership_mismatch');
    }
    const record = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + account.account, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID']));
    if (!ownsFreshAccount(record, account)) throw new Error('fresh_registered_identity_mismatch');
    receipt.preflight.registeredIdentity = true;
    if (account.guiReadiness) {
      if (await digest(account.bun) !== account.bunSha256) throw new Error('staged_executable_changed');
      receipt.reason = 'gui_readiness_only';
      receipt.operations = { dependencyInstall: false, browserLaunch: false, keychainAccess: false, diaDownload: false };
      receipt.guiReadiness = await runGuiReadiness(account.guiReadiness.executable, account.guiReadiness.executableSha256,
        path.join(account.snapshot, '.github/scripts/dia-gui-readiness.c'), account.guiReadiness.sourceSha256, false, env);
      return receipt.guiReadiness.available && receipt.guiReadiness.observation.identity.effectiveUidMatches
        && receipt.guiReadiness.observation.identity.homeMatchesRegistered ? 0 : 2;
    }
    if (!account.destinationExecutable || !account.destinationSha256) throw new Error('browser_qualification_authority_required');
    const foundationHome = run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("Foundation"); $.NSHomeDirectory().js']);
    if (realpathSync(foundationHome) !== account.home) throw new Error('foundation_home_mismatch');
    receipt.preflight.foundationHome = true;
    receipt.keychainHome = prepareKeychainHome(account.home, account.uid);
    receipt.dependencyDirectoryPresentBeforeInstall = true;
    for (const executable of [account.bun, account.destinationExecutable]) {
      accessSync(executable, constants.X_OK);
      if (!path.isAbsolute(executable) || realpathSync(executable) !== executable || !executable.startsWith(account.work + path.sep)) throw new Error('staged_executable_escape');
    }
    if (await digest(account.bun) !== account.bunSha256 || await digest(account.destinationExecutable) !== account.destinationSha256) throw new Error('staged_executable_changed');
    receipt.reason = 'fresh_dependency_install';
    run(account.bun, ['install', '--frozen-lockfile', '--ignore-scripts'], 180_000);
    if (Bun.version !== '1.4.0' || require(path.join(account.snapshot, 'node_modules/playwright/package.json')).version !== '1.62.1') throw new Error('pinned_runtime_mismatch');
    mkdirSync(probe, { mode: 0o700 });
    receipt.reason = 'background_keychain_preflight';
    snapshot = captureUserKeychains(env, [account.home, account.temporary]);
    const password = randomBytes(24).toString('hex');
    const value = randomBytes(24).toString('hex');
    keychainChanged = true;
    run('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    keychainCreated = true;
    run('/usr/bin/security', ['set-keychain-settings', '-lut', '300', keychain]);
    run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain]);
    run('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', keychain]);
    run('/usr/bin/security', ['add-generic-password', '-s', 'Gstack Native Probe', '-a', 'fixture', '-w', value,
      '-T', '/usr/bin/security', keychain]);
    const observed = observeFixtureKeychain(env, [account.home, account.temporary], keychain, value);
    receipt.keychainObservations = { ...observed, preferencesFileExists: existsSync(path.join(account.home, 'Library/Preferences/com.apple.security.plist')) };
    if (!observed.searchPathMatches || !observed.defaultPathMatches || !observed.explicitReadMatches) throw new Error('native_keychain_probe_failed');
    receipt.preflight.keychain = true;
    if (account.launchComparison) {
      receipt.reason = 'comparison_chromium_control';
      launchAttempted = true;
      comparisonControl = await runDiaLaunchComparison(account, 'control');
      receipt.comparisonControl = comparisonControl;
      if (!comparisonControl.ready || !comparisonControl.cleanup?.confirmed) throw new Error('comparison_control_failed');
      receipt.preflight.headlessChromium = true;
      receipt.status = 'passed';
      receipt.reason = 'background_session_ready';
    } else {
      receipt.browserPreflight = { stage: 'runtime_import', launchReturned: false, ownedRootCount: 0,
        startupPageCount: null, startupPageCategories: [], pageSelected: false, contentSet: false, readbackMatched: false };
      receipt.reason = 'background_browser_runtime_import';
      const { chromium } = await import('playwright');
      const profile = path.join(probe, 'chromium');
      observer = observeBrowserLaunches(new Map([[account.destinationExecutable, profile]]));
      launchAttempted = true;
      receipt.browserPreflight.stage = 'launch';
      receipt.reason = 'background_browser_launch';
      context = await limit(chromium.launchPersistentContext(profile, nativeDiaLaunchOptions(account.destinationExecutable, env)), 40_000);
      receipt.browserPreflight.launchReturned = true;
      receipt.browserPreflight.stage = 'ownership';
      receipt.reason = 'background_browser_ownership';
      receipt.browserPreflight.ownedRootCount = observer.children.length;
      if (observer.children.length !== 1) throw new Error('background_browser_ownership_failed');
      receipt.browserPreflight.stage = 'startup_pages';
      receipt.reason = 'background_browser_startup_pages';
      const pages = context.pages();
      const startupUrls = pages.map((page: any) => page.url());
      receipt.browserPreflight.startupPageCount = pages.length;
      receipt.browserPreflight.startupPageCategories = startupUrls.map(browserStartupCategory);
      if (startupUrls.some((url: string) => url !== 'about:blank')) throw new Error('background_browser_startup_page_rejected');
      receipt.browserPreflight.stage = 'page_selection';
      receipt.reason = 'background_browser_page_selection';
      const page = pages[0] ?? await limit(context.newPage(), 5_000);
      receipt.browserPreflight.pageSelected = true;
      receipt.browserPreflight.stage = 'content_set';
      receipt.reason = 'background_browser_content_set';
      await limit(page.setContent('<div id="fixture">background browser ready</div>'), 5_000);
      receipt.browserPreflight.contentSet = true;
      receipt.browserPreflight.stage = 'readback';
      receipt.reason = 'background_browser_readback';
      receipt.browserPreflight.readbackMatched = await limit(page.locator('#fixture').innerText(), 5_000) === 'background browser ready';
      if (!receipt.browserPreflight.readbackMatched) throw new Error('background_browser_render_failed');
      receipt.browserPreflight.stage = 'completed';
      receipt.preflight.headlessChromium = true;
      receipt.status = 'passed';
      receipt.reason = 'background_session_ready';
    }
  } catch (error) {
    receipt.status = 'incomplete';
    if (error instanceof Error && ['fresh_identity_mismatch', 'fresh_directory_ownership_mismatch', 'fresh_registered_identity_mismatch',
      'foundation_home_mismatch', 'staged_executable_escape', 'staged_executable_changed', 'pinned_runtime_mismatch',
      'user_keychain_search_unavailable', 'user_default_keychain_unavailable', 'keychain_outside_owned_home_refused',
      'keychain_home_unsafe', 'fixture_keychain_not_owned', 'native_keychain_probe_failed', 'comparison_control_failed',
      'gui_readiness_inputs_changed', 'gui_readiness_budget_exhausted'].includes(error.message)) receipt.blocker = error.message;
    if (receipt.browserPreflight) {
      receipt.blocker = browserPreflightError(error);
      receipt.browserPreflight.error = receipt.blocker;
      if (receipt.browserPreflight.stage === 'runtime_import') receipt.browserPreflight.moduleLoad = playwrightModuleLoadFacts(account.snapshot, error);
      receipt.browserPreflight.ownedRootCount = observer?.children.length ?? 0;
      receipt.browserPreflight.launchAttempts = observer?.attempts ?? [];
    }
    receipt.initialFailure = { stage: receipt.reason, blocker: receipt.blocker ?? 'native_preflight_failed' };
  } finally {
    cleaning = true;
    if (receipt.browserPreflight) {
      receipt.browserPreflight.launchAttempts ??= observer?.attempts ?? [];
      receipt.browserPreflight.rootStatesBeforeCleanup = (observer?.children ?? []).map(child => ({
        pid: child.pid, exitCode: Number.isInteger(child.process.exitCode) ? child.process.exitCode : null,
        signal: child.process.signalCode == null ? null
          : ['SIGABRT', 'SIGTRAP', 'SIGSEGV', 'SIGBUS', 'SIGKILL', 'SIGTERM', 'SIGILL'].includes(child.process.signalCode) ? child.process.signalCode : 'other',
      }));
    }
    observer?.stop();
    if (context) await limit(context.close().catch(() => {}), 5_000).catch(() => {});
    let stopped = !launchAttempted || (account.launchComparison ? comparisonControl?.cleanup?.confirmed === true : observer?.children.length === 1);
    for (const child of observer?.children ?? []) {
      const until = performance.now() + 5_000;
      try {
        await stopOwnedBrowserGroup(child, until, {});
      } catch { stopped = false; }
    }
    receipt.cleanup.probeBrowsersStopped = stopped;
    if (stopped) {
      try {
        if (keychainChanged && snapshot) {
          let restored = true;
          for (const args of fixtureKeychainRestoreCommands(snapshot, keychain, keychainCreated)) {
            try { run('/usr/bin/security', args); } catch { restored = false; }
          }
          if (!restored || JSON.stringify(captureUserKeychains(env, [account.home, account.temporary])) !== JSON.stringify(snapshot)) throw new Error('probe_keychain_restore_failed');
        }
        receipt.cleanup.probeKeychainRestored = true;
        if (existsSync(probe) && realpathSync(probe) === probe) rmSync(probe, { recursive: true, force: true });
      } catch { receipt.cleanupFailure = 'probe_keychain_restore_failed'; }
    }
    if (!receipt.cleanup.probeBrowsersStopped || !receipt.cleanup.probeKeychainRestored) { receipt.status = 'incomplete'; receipt.reason = 'background_probe_cleanup_incomplete'; }
    writePrivateReceipt(preflightFile, receipt, true);
  }
  if (receipt.status !== 'passed') return 2;
  const result = spawnSync(account.bun, ['--no-env-file', '--no-install', '--no-macros', '--config=/dev/null',
    path.join(account.snapshot, '.github/scripts/qualify-dia-macos.ts'), '--fresh-account', account.configFile], {
    cwd: account.snapshot, env, stdio: 'ignore', timeout: 660_000, killSignal: 'SIGKILL',
  });
  return !result.error && result.status === 0 ? 0 : 2;
}

export async function runFreshAccountQualification(comparisonRuntime?: 'bun' | 'node', guiReadinessOnly = false) {
  validateQualificationHost(process.env);
  if (comparisonRuntime !== undefined && !['bun', 'node'].includes(comparisonRuntime)) throw new Error('invalid_comparison_runtime');
  if (guiReadinessOnly && comparisonRuntime !== undefined) throw new Error('conflicting_diagnostic_modes');
  if (process.getuid?.() === 0 || Bun.version !== '1.4.0') throw new Error('run_as_unprivileged_pinned_ci_runner');
  const outputRoot = realpathSync(process.env.RUNNER_TEMP!);
  const output = path.join(outputRoot, 'dia-native-qualification.json');
  if (existsSync(output)) throw new Error('fresh_output_required');
  const work = realpathSync(mkdtempSync(FRESH_WORK_PREFIX));
  const home = path.join(work, 'home');
  const temporary = path.join(work, 'tmp');
  const snapshot = path.join(work, 'repo');
  const bin = path.join(work, 'bin');
  const browserDirectory = path.join(work, 'browser');
  const archive = path.join(work, 'source.tar');
  const suffix = randomBytes(6).toString('hex');
  const accountName = 'gsdia' + suffix;
  const label = 'ai.gstack.dia.' + suffix;
  const deadline = performance.now() + 16 * 60_000;
  const hostEnv = { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
  let cleanupDeadline = 0;
  const run = (command: string, args: string[], timeout = 10_000) => {
    const remaining = (cleanupDeadline || deadline) - performance.now();
    if (remaining <= 0) throw new Error('fresh_launcher_deadline');
    return safeCommand(command, args, Math.min(timeout, remaining), hostEnv);
  };
  const rootCommand = (command: string, args: string[], timeout = 10_000) => run('/usr/bin/sudo', ['-n', command, ...args], timeout);
  let account: FreshAccount | undefined;
  let userCreated = false;
  let groupCreated = false;
  let serviceAttempted = false;
  let domainBeforeCreation: ParentDomainObservation | undefined;
  let stage = 'fresh_launcher_preflight';
  const receipt: Record<string, any> = { status: 'incomplete', reason: stage, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    counts: { pass: 0, fail: 0, skip: 0 }, launcher: { sessionCreate: true, aquaLogin: false },
    launcherCleanup: { serviceStopped: false, userDomainStopped: false, userProcessesStopped: false, accountRemoved: false, groupRemoved: false, stagingRemoved: false } };
  let workerExit: number | undefined;
  let pythonExecutable: string | undefined;
  const probeParentDomain = (uid: number) => inspectParentDomain(uid, cleanupDeadline || deadline, hostEnv);
  const snapshotProcesses = (phase: string, uid: number) => {
    const facts = inspectUidProcesses(uid, cleanupDeadline || deadline, hostEnv);
    (receipt.uidProcessSnapshots ??= {})[phase] = facts;
    return facts;
  };
  try {
    rootCommand('/usr/bin/true', []);
    for (const directory of [home, temporary, snapshot, bin, ...(guiReadinessOnly ? [] : [browserDirectory])]) mkdirSync(directory, { mode: 0o700 });
    assertDiaSocketPath(path.join(home, 'Library/Application Support/Dia/User Data'));
    writeFileSync(path.join(temporary, 'dia-background-preflight.json'), JSON.stringify({ status: 'incomplete', reason: 'fresh_worker_not_started',
      nativeCasesRun: false, preflight: { registeredIdentity: false, foundationHome: false, keychain: false, headlessChromium: false } }) + '\n', { mode: 0o600, flag: 'wx' });
    const sourceRevision = run('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('invalid_source_revision');
    const python = Bun.which('python3');
    if (!python) throw new Error('archive_validator_unavailable');
    pythonExecutable = realpathSync(python);
    stage = 'source_archive_preflight';
    run('/usr/bin/git', ['-C', repository, 'archive', '--format=tar', '--output', archive, 'HEAD'], 30_000);
    const archiveResult = JSON.parse(run(pythonExecutable, ['-I', '-c', ARCHIVE_CHECK, archive], 30_000));
    if (archiveResult.valid !== true) throw new Error('unsafe_source_archive');
    run('/usr/bin/tar', ['--no-same-owner', '--no-same-permissions', '-xf', archive, '-C', snapshot], 30_000);
    if (!guiReadinessOnly) mkdirSync(path.join(snapshot, 'node_modules'), { mode: 0o700 });
    const sourceBun = realpathSync(process.execPath);
    const bun = path.join(bin, 'bun');
    copyFileSync(sourceBun, bun);
    chmodSync(bun, 0o755);
    let guiReadiness: FreshAccount['guiReadiness'];
    if (guiReadinessOnly) {
      stage = 'gui_readiness_build';
      const source = path.join(snapshot, '.github/scripts/dia-gui-readiness.c');
      const executable = path.join(bin, 'gui-readiness');
      const sourceSha256 = await digest(source);
      run('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-std=c11', '-O2', '-Wall', '-Wextra', source,
        '-framework', 'Security', '-framework', 'ApplicationServices', '-o', executable], 30_000);
      if (await digest(source) !== sourceSha256 || !inspectMachOArchitectures(executable).architectures.includes('arm64')) throw new Error('gui_readiness_build_unconfirmed');
      chmodSync(executable, 0o755);
      guiReadiness = { mode: 'gui-readiness-only', executable, sourceSha256, executableSha256: await digest(executable) };
      stage = 'gui_readiness_original_runner';
      receipt.guiReadiness = { mode: 'gui-readiness-only', qualificationCredit: false,
        helper: { sourceSha256, executableSha256: guiReadiness.executableSha256 },
        originalRunner: await runGuiReadiness(executable, guiReadiness.executableSha256, source, sourceSha256, true, hostEnv,
          Math.min(5000, deadline - performance.now())) };
    }
    let launchComparison: FreshAccount['launchComparison'];
    if (comparisonRuntime) {
      let executable = bun;
      if (comparisonRuntime === 'node') {
        const sourceNode = Bun.which('node');
        if (!sourceNode) throw new Error('pinned_node_unavailable');
        const resolvedNode = realpathSync(sourceNode);
        const node = JSON.parse(run(resolvedNode, ['-p', 'JSON.stringify({version:process.versions.node,arch:process.arch,os:process.platform,bun:Boolean(process.versions.bun)})']));
        if (node.version !== '24.18.0' || node.arch !== 'arm64' || node.os !== 'darwin' || node.bun) throw new Error('pinned_node_required');
        executable = path.join(bin, 'node');
        copyFileSync(resolvedNode, executable);
        chmodSync(executable, 0o755);
      }
      launchComparison = { mode: 'launch-only', runtime: comparisonRuntime, executable, executableSha256: await digest(executable),
        driverSha256: await digest(path.join(snapshot, '.github/scripts/dia-launch-driver.mjs')),
        helpersSha256: await digest(path.join(snapshot, '.github/scripts/qualify-dia-macos.ts')) };
    }
    let destination: Pick<FreshAccount, 'destinationExecutable' | 'destinationSha256'> = {};
    if (!guiReadinessOnly) {
      const { chromium } = await import('playwright');
      if (require('playwright/package.json').version !== '1.62.1') throw new Error('pinned_playwright_required');
      const originalExecutable = realpathSync(chromium.executablePath());
      let bundle = path.dirname(originalExecutable);
      while (!bundle.endsWith('.app')) {
        const parent = path.dirname(bundle);
        if (parent === bundle) throw new Error('destination_app_bundle_missing');
        bundle = parent;
      }
      const copiedBundle = path.join(browserDirectory, path.basename(bundle));
      run('/usr/bin/ditto', ['--rsrc', '--extattr', bundle, copiedBundle], 45_000);
      const destinationExecutable = realpathSync(path.join(copiedBundle, path.relative(bundle, originalExecutable)));
      if (!destinationExecutable.startsWith(browserDirectory + path.sep)) throw new Error('destination_bundle_escape');
      destination = { destinationExecutable, destinationSha256: await digest(originalExecutable) };
    }
    const userIds = parseDirectoryIds(run('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID']));
    const groupIds = parseDirectoryIds(run('/usr/bin/dscl', ['.', '-list', '/Groups', 'PrimaryGroupID']));
    const used = new Set([...userIds, ...groupIds]);
    for (const uid of run('/bin/ps', ['-axo', 'uid=']).split(/\s+/).filter(Boolean)) used.add(Number(uid));
    let uid = 20_000;
    while (used.has(uid) && uid < 60_000) uid++;
    if (uid >= 60_000) throw new Error('fresh_uid_unavailable');
    stage = 'fresh_user_domain_preflight';
    domainBeforeCreation = probeParentDomain(uid);
    receipt.userDomain = { beforeCreation: domainBeforeCreation };
    receipt.candidateIdentity = { uid, accountUidAbsent: !userIds.has(uid), groupUidAbsent: !groupIds.has(uid) };
    const candidateProcesses = snapshotProcesses('before_account_creation', uid);
    if (passiveUserDomainState(domainBeforeCreation, uid) !== 'absent' || !('count' in candidateProcesses) || candidateProcesses.count !== 0
      || !receipt.candidateIdentity.accountUidAbsent || !receipt.candidateIdentity.groupUidAbsent) {
      throw new Error('candidate_domain_baseline_unconfirmed');
    }
    const configFile = path.join(work, 'account.json');
    const metadata = Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT', 'GSTACK_DIA_NATIVE_QUALIFY'].map(name => [name, process.env[name]!]));
    account = { work, home, temporary, snapshot, bun, ...destination, uid, gid: uid, account: accountName,
      ...(launchComparison ? { launchComparison } : {}), ...(guiReadiness ? { guiReadiness } : {}),
      guid: randomUUID().toUpperCase(), groupGuid: randomUUID().toUpperCase(), label, sourceRevision,
      archiveSha256: await digest(archive), bunSha256: await digest(bun), configFile,
      environment: { ...metadata, HOME: home, TMPDIR: temporary, RUNNER_TEMP: temporary, PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
        GSTACK_DIA_EXPECT_UID: String(uid), GSTACK_DIA_SOURCE_REVISION: sourceRevision,
        ...(destination.destinationExecutable ? { GSTACK_DIA_DESTINATION_EXECUTABLE: destination.destinationExecutable } : {}) } };
    stage = 'fresh_account_creation';
    rootCommand('/usr/bin/dscl', ['.', '-create', '/Groups/' + accountName]);
    groupCreated = true;
    for (const [name, value] of [['GeneratedUID', account.groupGuid], ['PrimaryGroupID', String(uid)], ['RealName', 'gstack native fixture group']]) {
      rootCommand('/usr/bin/dscl', ['.', '-create', '/Groups/' + accountName, name, value]);
    }
    rootCommand('/usr/bin/dscl', ['.', '-create', '/Users/' + accountName]);
    userCreated = true;
    for (const [name, value] of [['GeneratedUID', account.guid], ['UniqueID', String(uid)], ['PrimaryGroupID', String(uid)],
      ['NFSHomeDirectory', home], ['UserShell', '/usr/bin/false'], ['RealName', 'gstack native fixture'], ['IsHidden', '1'], ['Password', '*']]) {
      rootCommand('/usr/bin/dscl', ['.', '-create', '/Users/' + accountName, name, value]);
    }
    if (!ownsFreshAccount(parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID'])), account)) throw new Error('fresh_account_not_registered');
    for (const directory of [home, temporary, snapshot, bin, ...(guiReadinessOnly ? [] : [browserDirectory])]) rootCommand('/usr/sbin/chown', ['-R', '-P', `${uid}:${uid}`, directory], 30_000);
    writeFileSync(configFile, JSON.stringify(account), { mode: 0o644, flag: 'wx' });
    const json = path.join(work, 'service.json');
    const plist = path.join(work, label + '.plist');
    writeFileSync(json, JSON.stringify(freshLaunchDefinition(account)), { mode: 0o600, flag: 'wx' });
    run('/usr/bin/plutil', ['-convert', 'xml1', '-o', plist, json]);
    rootCommand('/usr/sbin/chown', ['root:wheel', configFile, plist, work]);
    rootCommand('/bin/chmod', ['644', configFile, plist]);
    rootCommand('/bin/chmod', ['755', work]);
    stage = 'background_session_bootstrap';
    serviceAttempted = true;
    rootCommand('/bin/launchctl', ['bootstrap', 'system', plist]);
    stage = 'background_session_probe';
    while (performance.now() < deadline) {
      const state = rootCommand('/bin/launchctl', ['print', 'system/' + label]);
      const exit = state.match(/^\s*last exit code = (\d+)\s*$/m);
      const running = /^\s*pid = \d+\s*$/m.test(state);
      if (!running && exit) { workerExit = Number(exit[1]); break; }
      await Bun.sleep(500);
    }
    if (workerExit === undefined) throw new Error('background_session_timeout');
    receipt.reason = workerExit === 0 ? 'fresh_account_qualification_completed' : 'fresh_account_preflight_or_qualification_failed';
  } catch (error) {
    receipt.reason = stage;
    receipt.failureStage = stage;
    if ((error as { diagnostic?: object }).diagnostic) receipt.commandFailure = (error as { diagnostic: object }).diagnostic;
  } finally {
    cleanupDeadline = performance.now() + 60_000;
    if (serviceAttempted && account) {
      try {
        if (!ownsLaunchService(rootCommand('/bin/launchctl', ['print', 'system/' + label]), account)) throw new Error('service_identity_changed');
        rootCommand('/bin/launchctl', ['bootout', 'system/' + label], 10_000);
        receipt.launcherCleanup.serviceStopped = true;
      } catch {}
    } else receipt.launcherCleanup.serviceStopped = true;
    let owned = false;
    if (account && userCreated) {
      try { owned = ownsFreshAccount(parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID'])), account); } catch {}
    }
    if (owned && account) {
      const collect = (phase: string) => {
        const results: Record<string, string> = {};
        for (const [name, filename] of [['backgroundPreflight', 'dia-background-preflight.json'], ['qualification', 'dia-native-qualification.json']]) {
          try {
            if (!pythonExecutable) throw new Error('receipt_reader_unavailable');
            const text = rootCommand(pythonExecutable, ['-I', '-c', PRIVATE_RECEIPT_READ, path.join(temporary, filename), String(account!.uid), work], 3_000);
            if (text.length > 1024 * 1024) throw new Error('oversized_receipt');
            receipt[name] = JSON.parse(text);
            results[name] = 'captured';
          } catch { results[name] = 'unavailable'; }
        }
        (receipt.diagnosticCollection ??= {})[phase] = results;
      };
      const active = () => {
        const facts = inspectUidProcesses(account!.uid, cleanupDeadline, hostEnv);
        if (!('count' in facts)) throw new Error('uid_process_snapshot_unavailable');
        return facts.count !== 0;
      };
      collect('before_signal');
      snapshotProcesses('before_signal', account.uid);
      let domainOwnershipConfirmed = false;
      try {
        if (!receipt.launcherCleanup.serviceStopped) throw new Error('service_still_loaded');
        const record = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID']));
        const before = probeParentDomain(account.uid);
        (receipt.userDomain ??= {}).beforeTeardown = before;
        const domain = ownedUserDomainTarget(record, account, domainBeforeCreation, before);
        domainOwnershipConfirmed = true;
        if (domain !== null) {
          try { rootCommand('/bin/launchctl', ['bootout', domain], 10_000); }
          catch (error) {
            receipt.userDomain.teardownCommandFailure = (error as { diagnostic?: object }).diagnostic ?? { failed: true };
          }
        }
        receipt.userDomain.afterTeardown = probeParentDomain(account.uid);
        receipt.launcherCleanup.userDomainStopped = passiveUserDomainState(receipt.userDomain.afterTeardown, account.uid) === 'absent';
      } catch { (receipt.userDomain ??= {}).teardownRefusedOrUnconfirmed = true; }
      snapshotProcesses('after_domain_teardown', account.uid);
      try {
        if (!domainOwnershipConfirmed || !receipt.launcherCleanup.userDomainStopped) throw new Error('user_domain_ownership_or_absence_unconfirmed');
        if (active()) {
          const record = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID']));
          if (!ownsFreshAccount(record, account)) throw new Error('account_identity_changed');
          try { rootCommand('/usr/bin/pkill', ['-KILL', '-u', String(account.uid)]); } catch {}
          const until = Math.min(cleanupDeadline, performance.now() + 10_000);
          snapshotProcesses('after_signal', account.uid);
          while (active() && performance.now() < until) await Bun.sleep(100);
        }
        receipt.launcherCleanup.userProcessesStopped = !active();
      } catch {}
      snapshotProcesses('after_wait', account.uid);
      if (domainOwnershipConfirmed) {
        try {
          receipt.userDomain.afterWait = probeParentDomain(account.uid);
          receipt.launcherCleanup.userDomainStopped = passiveUserDomainState(receipt.userDomain.afterWait, account.uid) === 'absent';
        } catch { receipt.launcherCleanup.userDomainStopped = false; }
      }
      collect('after_wait');
      if (receipt.launcherCleanup.userProcessesStopped) {
        try {
          if (!receipt.launcherCleanup.serviceStopped || !receipt.launcherCleanup.userDomainStopped) throw new Error('owned_domain_or_service_still_loaded');
          const record = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Users/' + accountName, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'GeneratedUID']));
          if (!ownsFreshAccount(record, account)) throw new Error('account_identity_changed');
          receipt.userDomain.beforeAccountRemoval = probeParentDomain(account.uid);
          receipt.launcherCleanup.userDomainStopped = passiveUserDomainState(receipt.userDomain.beforeAccountRemoval, account.uid) === 'absent';
          if (!receipt.launcherCleanup.userDomainStopped) throw new Error('fresh_uid_domain_reappeared');
          if (active()) { receipt.launcherCleanup.userProcessesStopped = false; throw new Error('fresh_uid_processes_reappeared'); }
          rootCommand('/usr/bin/dscl', ['.', '-delete', '/Users/' + accountName]);
          receipt.launcherCleanup.accountRemoved = true;
        } catch {}
      }
    } else if (!userCreated) {
      receipt.launcherCleanup.userDomainStopped = true;
      receipt.launcherCleanup.userProcessesStopped = true;
      receipt.launcherCleanup.accountRemoved = true;
    }
    if (account && groupCreated && receipt.launcherCleanup.accountRemoved) {
      try {
        const group = parseDirectoryRecord(run('/usr/bin/dscl', ['.', '-read', '/Groups/' + accountName, 'GeneratedUID', 'PrimaryGroupID']));
        if (group.GeneratedUID?.toUpperCase() !== account.groupGuid || group.PrimaryGroupID !== String(account.gid)) throw new Error('group_identity_changed');
        rootCommand('/usr/bin/dscl', ['.', '-delete', '/Groups/' + accountName]);
        receipt.launcherCleanup.groupRemoved = true;
      } catch {}
    } else if (!groupCreated) receipt.launcherCleanup.groupRemoved = true;
    const mountSafe = !serviceAttempted || (receipt.qualification ? receipt.qualification.cleanup?.mountDetached === true
      : receipt.backgroundPreflight?.status === 'incomplete');
    if (receipt.launcherCleanup.serviceStopped && receipt.launcherCleanup.userDomainStopped && receipt.launcherCleanup.userProcessesStopped && receipt.launcherCleanup.accountRemoved
      && receipt.launcherCleanup.groupRemoved && mountSafe && (workerExit !== undefined || !serviceAttempted)) {
      try {
        const owner = lstatSync(work).uid;
        if (realpathSync(work) !== work || path.dirname(work) !== '/private/tmp' || !path.basename(work).startsWith(path.basename(FRESH_WORK_PREFIX))
          || (owner !== 0 && owner !== process.getuid?.())) throw new Error('staging_identity_changed');
        rootCommand('/bin/rm', ['-rf', '--', work], 20_000);
        receipt.launcherCleanup.stagingRemoved = true;
      } catch {}
    }
    if (receipt.qualification) receipt.counts = receipt.qualification.counts;
    if (account) receipt.launcher = { ...receipt.launcher, uid: account.uid, gid: account.gid, accountGuid: account.guid, groupGuid: account.groupGuid, serviceLabel: account.label,
      sourceRevision: account.sourceRevision, archiveSha256: account.archiveSha256, bunSha256: account.bunSha256, destinationSha256: account.destinationSha256 };
    if (account?.launchComparison) receipt.launchComparison = { mode: 'launch-only', runtime: account.launchComparison.runtime,
      executableSha256: account.launchComparison.executableSha256, driverSha256: account.launchComparison.driverSha256,
      helpersSha256: account.launchComparison.helpersSha256, qualificationCredit: false };
    const clean = Object.values(receipt.launcherCleanup).every(value => value === true);
    receipt.workerExitCode = workerExit ?? null;
    receipt.status = !account?.launchComparison && !account?.guiReadiness && freshQualificationPassed(workerExit, receipt.backgroundPreflight?.status, receipt.qualification?.status, receipt.launcherCleanup) ? 'passed' : 'incomplete';
    if (account?.guiReadiness) {
      receipt.reason = 'gui_readiness_only';
      receipt.guiReadiness.freshUser = receipt.backgroundPreflight?.guiReadiness ?? { available: false, reason: 'fresh_probe_receipt_unavailable' };
    }
    if (account?.launchComparison && receipt.qualification?.reason === 'diagnostic_launch_comparison_only') receipt.reason = 'diagnostic_launch_comparison_only';
    if (!clean) receipt.recovery = 'Discard this disposable runner. Do not reuse its account, session, profile, or Keychain.';
    if (receipt.backgroundPreflight?.status !== 'passed' && receipt.backgroundPreflight) receipt.reason = receipt.backgroundPreflight.reason;
    writePrivateReceipt(output, receipt);
  }
  return receipt;
}

if (import.meta.main) {
  try {
    if (process.argv[2] === '--fresh-worker') process.exitCode = await freshWorker(process.argv[3]);
    else {
      const args = process.argv.slice(2);
      const readinessOnly = args.length === 1 && args[0] === '--gui-readiness-only';
      if (args.length && !readinessOnly && (args.length !== 2 || args[0] !== '--launch-comparison' || !['bun', 'node'].includes(args[1]))) throw new Error('invalid_comparison_arguments');
      const receipt = await runFreshAccountQualification(args[1] as 'bun' | 'node' | undefined, readinessOnly);
      console.log(JSON.stringify({ status: receipt.status, reason: receipt.reason, counts: receipt.counts, artifact: 'dia-native-qualification.json' }));
      process.exitCode = receipt.status === 'passed' ? 0 : 2;
    }
  } catch {
    console.log(JSON.stringify({ status: 'incomplete', reason: 'fresh_account_launcher_preflight_failed', counts: { pass: 0, fail: 0, skip: 0 } }));
    process.exitCode = 2;
  }
}
