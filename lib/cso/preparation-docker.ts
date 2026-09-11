/** Concrete constrained-Docker adapter for PreparationExecutor. */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { promises as dns } from 'node:dns';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { atomicWriteSync } from '../fs-atomic';
import { canonical, CsoError, sha256 } from './contracts';
import { DockerGroup, type DockerEndpoint } from './docker';
import { secureDirectory } from './state';
import {
  admittedPreparationRuntime, type AcquisitionArtifactReceipt, type AcquisitionReceipt,
  type OfflinePreparationReceipt, type OfflinePreparationRequest, type OfflinePreparationResult,
  type PreparationAcquireRequest, type PreparationCommandReceipt, type PreparationRuntimeAdmission,
  type PreparationSandboxRunner,
} from './preparation-executor';
import type { CsoStack, PreparationCommand } from './preparation';
import { CSO_HELPER_ABI } from './runtime-catalog';
import type { PreparedExportEntry, PreparedExportManifest } from './preparation-container';

const RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[A-Za-z0-9@._+\/-]{1,1024}$/;
const MAX_MANIFEST = 32 * 1024 * 1024;
const MAX_PREPARED_EXPORT_ENTRIES = 200_000;

function fail(code: ConstructorParameters<typeof CsoError>[0], message: string): never { throw new CsoError(code, message); }
function contained(root: string, path: string): string {
  if (!RELATIVE.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', 'Preparation path escaped its private root');
  const target = resolve(root, ...path.split('/'));
  if (!target.startsWith(`${root}${sep}`)) fail('UNSAFE_PATH', 'Preparation path escaped its private root');
  return target;
}
function commandReceipt(command: PreparationCommand, index: number, exitCode: number): PreparationCommandReceipt {
  return { index, commandHash: sha256(canonical(command)), exitCode, timedOut: false, outputTruncated: false };
}
function writePolicy(path: string, value: unknown): void {
  try { atomicWriteSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, noReplace: true }); }
  catch { fail('PERSISTENCE_FAILED', 'Preparation policy could not be written atomically'); }
}
function readManifest(path: string): { artifacts: AcquisitionArtifactReceipt[] } {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(path); } catch { fail('TOOL_FAILED', 'Qualified acquisition helper did not produce an archive manifest'); }
  if (!stat!.isFile() || stat!.isSymbolicLink() || stat!.nlink !== 1 || stat!.size > MAX_MANIFEST ||
    (process.getuid && stat!.uid !== process.getuid()) || (stat!.mode & 0o077) !== 0)
    fail('UNSAFE_PATH', 'Acquisition archive manifest is not one bounded private file');
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { fail('TOOL_FAILED', 'Qualified acquisition helper returned invalid archive JSON'); }
  const value = parsed as { artifacts?: unknown };
  if (!value || Object.keys(value).sort().join(',') !== 'artifacts' || !Array.isArray(value.artifacts))
    fail('TOOL_FAILED', 'Qualified acquisition helper returned an invalid archive manifest schema');
  return value as { artifacts: AcquisitionArtifactReceipt[] };
}
function fileSha256(path: string, maxBytes: number): string {
  const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow); } catch { fail('UNSAFE_PATH', 'Archive copy could not be opened without following links'); }
  try {
    const before = fs.fstatSync(fd!), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
    for (;;) { const count = fs.readSync(fd!, buffer, 0, buffer.length, null); if (!count) break; bytes += count; if (bytes > maxBytes) fail('INSUFFICIENT_CAPACITY', 'Archive copy exceeded its declared size'); hash.update(buffer.subarray(0, count)); }
    const after = fs.fstatSync(fd!);
    if (bytes !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      fail('SNAPSHOT_RACE', 'Archive copy changed while it was hashed');
    return hash.digest('hex');
  } finally { fs.closeSync(fd!); }
}
function validateAcquisitionOutput(root: string, artifacts: AcquisitionArtifactReceipt[]): void {
  const top = fs.readdirSync(root).sort();
  if (canonical(top) !== canonical(['archives', 'artifacts.json'])) fail('TOOL_FAILED', 'Acquisition output contains undeclared objects');
  const archiveRoot = join(root, 'archives'), stat = fs.lstatSync(archiveRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0)
    fail('UNSAFE_PATH', 'Acquisition archive output is not one private directory');
  for(const artifact of artifacts)if(typeof artifact?.stagingPath!=='string'||!/^cso-public\/[A-Za-z0-9._-]{1,255}$/.test(artifact.stagingPath))fail('TOOL_FAILED','Acquisition manifest contains an unsafe staging path');
  const expected = artifacts.map(artifact => artifact.stagingPath.slice('cso-public/'.length)).sort(), actual = fs.readdirSync(archiveRoot).sort();
  if(new Set(expected).size!==expected.length)fail('TOOL_FAILED','Acquisition manifest contains duplicate staging paths');
  if (canonical(actual) !== canonical(expected)) fail('TOOL_FAILED', 'Acquisition output archive membership does not match its manifest');
  for (const name of actual) {
    if (!name || name.includes('/') || name === '.' || name === '..') fail('UNSAFE_PATH', 'Acquisition output archive name is unsafe');
    const file = fs.lstatSync(join(archiveRoot, name));
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid()) || (file.mode & 0o022) !== 0)
      fail('UNSAFE_PATH', 'Acquisition output contains a link or special file');
  }
}

function preparedRelative(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') &&
    Buffer.byteLength(path) <= 4096 && path.split('/').every(part => part && part !== '.' && part !== '..' &&
      Buffer.byteLength(part) <= 255 && !/[\0-\x1f\x7f]/.test(part));
}
function preparedTarget(root: string, relativePath: string): string {
  if (!preparedRelative(relativePath)) fail('UNSAFE_PATH', 'Prepared export contains an unsafe path');
  const target = resolve(root, ...relativePath.split('/'));
  if (!target.startsWith(`${root}${sep}`)) fail('UNSAFE_PATH', 'Prepared export path escaped its private root');
  return target;
}
function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function copyPreparedBlob(source: string, destination: string, expected: Extract<PreparedExportEntry, {kind:'file'}>): void {
  const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
  let sourceFd = -1, destinationFd = -1;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(sourceFd);
    if (!before.isFile() || before.nlink !== 1 || before.size !== expected.bytes ||
      (process.getuid && before.uid !== process.getuid())) fail('UNSAFE_PATH', 'Prepared export blob is not one owned regular file');
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
    for (;;) {
      const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null); if (!count) break;
      bytes += count; if (bytes > expected.bytes) fail('INSUFFICIENT_CAPACITY', 'Prepared export blob exceeded its declared size');
      hash.update(buffer.subarray(0, count));
      let offset = 0; while (offset < count) offset += fs.writeSync(destinationFd, buffer, offset, count - offset);
    }
    const after = fs.fstatSync(sourceFd);
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256 || !sameFileIdentity(before, after))
      fail('SNAPSHOT_RACE', 'Prepared export blob changed during bounded import');
    fs.fchmodSync(destinationFd, expected.mode); fs.fsyncSync(destinationFd);
    const copied = fs.fstatSync(destinationFd);
    if (!copied.isFile() || copied.nlink !== 1 || copied.size !== expected.bytes)
      fail('PERSISTENCE_FAILED', 'Prepared export blob was not materialized as one regular file');
  } finally {
    if (sourceFd >= 0) fs.closeSync(sourceFd);
    if (destinationFd >= 0) fs.closeSync(destinationFd);
  }
}

/** Validate an inert container export and reconstruct its prepared tree using host no-follow writes. */
export function materializePreparedExport(exportRoot: string, destinationRoot: string, maxBytes: number): PreparedExportManifest {
  const source = resolve(exportRoot), destination = resolve(destinationRoot);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 2 * 1024 * 1024 * 1024)
    fail('INVALID_ARGUMENT', 'Prepared export byte ceiling is invalid');
  for (const [path, label, empty] of [[source, 'Prepared inert export', false], [destination, 'Prepared output', true]] as const) {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(path) !== path ||
      (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0 || (empty && fs.readdirSync(path).length))
      fail('UNSAFE_PATH', `${label} must be one private${empty ? ' empty' : ''} owned directory`);
  }
  if (fs.readdirSync(source).sort().join('\0') !== 'blobs\0manifest.json') fail('UNSAFE_PATH', 'Prepared inert export contains undeclared top-level objects');
  const manifestPath = join(source, 'manifest.json'), manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1 || manifestStat.size < 1 || manifestStat.size > MAX_MANIFEST ||
    (process.getuid && manifestStat.uid !== process.getuid())) fail('UNSAFE_PATH', 'Prepared export manifest is not one bounded owned file');
  let manifest: PreparedExportManifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { fail('TOOL_FAILED', 'Prepared export manifest is invalid JSON'); }
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'entries,schemaVersion' || manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.entries) || manifest.entries.length > MAX_PREPARED_EXPORT_ENTRIES)
    fail('TOOL_FAILED', 'Prepared export manifest has an invalid schema');

  const paths = new Set<string>(), directories = new Set<string>(), blobs = new Set<string>(); let totalBytes = 0;
  for (const raw of manifest.entries) {
    const entry = raw as PreparedExportEntry, keys = Object.keys(entry).sort().join(',');
    if (!preparedRelative(entry?.path) || paths.has(entry.path) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
      fail('TOOL_FAILED', 'Prepared export contains a duplicate or invalid path record');
    paths.add(entry.path);
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    if (parent && !directories.has(parent)) fail('TOOL_FAILED', 'Prepared export entry is missing its declared parent directory');
    if (entry.kind === 'directory') {
      if (keys !== 'kind,mode,path' || (entry.mode & 0o022) !== 0) fail('TOOL_FAILED', 'Prepared export directory record is invalid');
      directories.add(entry.path);
    } else if (entry.kind === 'file') {
      if (keys !== 'blob,bytes,kind,mode,path,sha256' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^blob-\d{6}$/.test(entry.blob) || blobs.has(entry.blob))
        fail('TOOL_FAILED', 'Prepared export file record is invalid');
      blobs.add(entry.blob); totalBytes += entry.bytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) fail('INSUFFICIENT_CAPACITY', 'Prepared export exceeds its aggregate byte ceiling');
    } else if (entry.kind === 'symlink') {
      if (keys !== 'kind,mode,path,target' || typeof entry.target !== 'string' || !entry.target || isAbsolute(entry.target) ||
        entry.target.includes('\0') || /[\x01-\x1f\x7f]/.test(entry.target)) fail('TOOL_FAILED', 'Prepared export symlink record is invalid');
      const lexical = resolve(dirname(preparedTarget(destination, entry.path)), entry.target);
      if (lexical !== destination && !lexical.startsWith(`${destination}${sep}`)) fail('UNSAFE_PATH', 'Prepared export symlink escapes its destination');
    } else fail('TOOL_FAILED', 'Prepared export entry kind is invalid');
  }
  const ordered = manifest.entries.map(entry => entry.path);
  if (ordered.join('\0') !== [...ordered].sort().join('\0')) fail('TOOL_FAILED', 'Prepared export manifest is not in deterministic path order');
  const blobRoot = join(source, 'blobs'), blobRootStat = fs.lstatSync(blobRoot);
  if (!blobRootStat.isDirectory() || blobRootStat.isSymbolicLink() || (process.getuid && blobRootStat.uid !== process.getuid()) ||
    fs.readdirSync(blobRoot).sort().join('\0') !== [...blobs].sort().join('\0')) fail('UNSAFE_PATH', 'Prepared export blob membership does not match its manifest');

  for (const entry of manifest.entries) if (entry.kind === 'directory') fs.mkdirSync(preparedTarget(destination, entry.path), { mode: 0o700 });
  for (const entry of manifest.entries) if (entry.kind === 'file') copyPreparedBlob(join(blobRoot, entry.blob), preparedTarget(destination, entry.path), entry);
  for (const entry of manifest.entries) if (entry.kind === 'symlink') fs.symlinkSync(entry.target, preparedTarget(destination, entry.path));
  for (const entry of manifest.entries) if (entry.kind === 'symlink') {
    const path = preparedTarget(destination, entry.path); let real: string, stat: fs.Stats;
    try { real = fs.realpathSync(path); stat = fs.statSync(path); } catch { fail('UNSAFE_PATH', 'Prepared export symlink is dangling or cyclic'); }
    if ((real !== destination && !real.startsWith(`${destination}${sep}`)) || (!stat.isFile() && !stat.isDirectory()))
      fail('UNSAFE_PATH', 'Prepared export symlink resolves outside its prepared tree');
  }
  for (const entry of [...manifest.entries].reverse()) if (entry.kind === 'directory') fs.chmodSync(preparedTarget(destination, entry.path), entry.mode);
  return manifest;
}

function addBlockedIpv4Ranges(blocked: net.BlockList): void {
  for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as Array<[string, number]>)
    blocked.addSubnet(address, prefix, 'ipv4');
}
function addBlockedIpv6Ranges(blocked: net.BlockList): void {
  for (const [address, prefix] of [
    ['::', 96], // unspecified, IPv4-compatible, and other deprecated v4 embeddings
    ['::ffff:0.0.0.0', 96], // IPv4-mapped addresses must not bypass the IPv4 ranges
    ['64:ff9b::', 96], ['64:ff9b:1::', 48], // public and local-use NAT64 translators
    ['100::', 64], // discard-only
    ['2001::', 23], // IETF special-purpose assignments (Teredo, ORCHID, benchmarking)
    ['2001:db8::', 32], // documentation prefix
    ['2002::', 16], // 6to4 can embed otherwise blocked IPv4 destinations
    ['3fff::', 20], // documentation prefix
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ] as Array<[string, number]>)
    blocked.addSubnet(address, prefix, 'ipv6');
}

const registryBlockedAddresses = new net.BlockList();
const registryBlockedIpv6Addresses = new net.BlockList();
addBlockedIpv4Ranges(registryBlockedAddresses);
addBlockedIpv6Ranges(registryBlockedIpv6Addresses);

/** Pure classification used before any registry connection is attempted. */
export function isBlockedRegistryAddress(address: string, family: 4 | 6): boolean {
  if (net.isIP(address) !== family) return true;
  return (family === 6 ? registryBlockedIpv6Addresses : registryBlockedAddresses).check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export interface RegistryDnsAddress { address: string; family: 4 | 6 }
export interface RegistryDnsResolution { promise: Promise<RegistryDnsAddress[]>; cancel(): void }
export type RegistryDnsResolver = (host: string) => RegistryDnsResolution;

function systemRegistryDnsResolver(host: string): RegistryDnsResolution {
  const resolver = new dns.Resolver();
  const promise = Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]).then(results => {
    const answers: RegistryDnsAddress[] = [];
    if (results[0].status === 'fulfilled') for (const address of results[0].value) answers.push({ address, family: 4 });
    if (results[1].status === 'fulfilled') for (const address of results[1].value) answers.push({ address, family: 6 });
    if (!answers.length) {
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    return answers;
  });
  return { promise, cancel: () => resolver.cancel() };
}

/**
 * Host-side CONNECT broker. The acquisition container remains in Docker's
 * network-none namespace and reaches this broker only through a bind-mounted
 * Unix socket and its qualified loopback forwarder.
 */
export class RegistryEgressBroker {
  readonly contactedHosts = new Set<string>();
  readonly deniedHosts = new Set<string>();
  private readonly server = net.createServer(socket => this.accept(socket));
  private readonly sockets = new Set<net.Socket>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly resolutions = new Set<{ cancel(error: CsoError): void }>();
  private readonly pinned = new Map<string, string>();
  private transferred = 0;
  private violation: string | undefined;
  private started = false;
  private closing = false;

  constructor(readonly socketPath: string, readonly allowedHosts: string[], private readonly deadline: number, private readonly maxBytes: number,
    private readonly resolveDns: RegistryDnsResolver = systemRegistryDnsResolver) {
    if (!socketPath.startsWith('/') || !allowedHosts.length || new Set(allowedHosts).size !== allowedHosts.length ||
      allowedHosts.some(host => host !== host.toLowerCase() || !/^[a-z0-9.-]{1,253}$/.test(host)) ||
      !Number.isSafeInteger(deadline) || deadline <= Date.now() || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      fail('INVALID_ARGUMENT', 'Registry broker requires a bounded allowlist, deadline, and byte ceiling');
  }

  async start(): Promise<void> {
    if (this.started || this.closing) fail('INVALID_ARGUMENT', 'Registry broker cannot be started more than once');
    if (fs.existsSync(this.socketPath)) fail('UNSAFE_PATH', 'Registry broker socket path already exists');
    await new Promise<void>((resolveStart, reject) => {
      const onError = () => reject(new CsoError('ISOLATION_FAILED', 'Registry broker could not bind its private Unix socket'));
      this.server.once('error', onError);
      this.server.listen(this.socketPath, () => { this.server.off('error', onError); resolveStart(); });
    });
    this.started = true;
    this.server.on('error', () => { this.violation ??= 'Registry broker listener failed'; });
    fs.chmodSync(this.socketPath, 0o600);
    const stat = fs.lstatSync(this.socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
      fail('UNSAFE_PATH', 'Registry broker did not create an owned Unix socket');
  }

  private deny(socket: net.Socket, message: string, host?: string): void {
    this.violation ??= message;
    if (host) this.deniedHosts.add(host);
    try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { socket.destroy(); }
  }

  private async lookup(host: string, lookupDeadline: number): Promise<RegistryDnsAddress[]> {
    const resolution = this.resolveDns(host);
    if (!resolution || typeof resolution.cancel !== 'function' || !resolution.promise || typeof resolution.promise.then !== 'function')
      fail('ISOLATION_FAILED', 'Registry DNS resolver returned an invalid operation');
    let rejectCancellation!: (error: CsoError) => void, settled = false;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const active = {
      cancel: (error: CsoError) => {
        if (settled) return;
        try { resolution.cancel(); } catch {}
        rejectCancellation(error);
      },
    };
    this.resolutions.add(active);
    const remaining = lookupDeadline - Date.now();
    if (remaining <= 0) active.cancel(new CsoError('DEADLINE', 'Registry DNS lookup deadline elapsed'));
    const timer = remaining > 0 ? setTimeout(() => active.cancel(new CsoError('DEADLINE', 'Registry DNS lookup deadline elapsed')), remaining) : undefined;
    try {
      const answers = await Promise.race([resolution.promise, cancelled]);
      if (!Array.isArray(answers) || answers.some(answer => !answer || typeof answer.address !== 'string' || (answer.family !== 4 && answer.family !== 6)))
        fail('ISOLATION_FAILED', 'Registry DNS resolver returned invalid addresses');
      return answers;
    } finally {
      settled = true;
      if (timer) clearTimeout(timer);
      this.resolutions.delete(active);
    }
  }

  private async openTunnel(socket: net.Socket, host: string, remainder: Buffer, connectionDeadline: number): Promise<void> {
    try {
      const answers = (await this.lookup(host, connectionDeadline)).filter(answer => !isBlockedRegistryAddress(answer.address, answer.family));
      if (this.closing || socket.destroyed) return;
      if (Date.now() >= this.deadline || Date.now() >= connectionDeadline) {
        this.deny(socket, 'Registry acquisition deadline elapsed', host); return;
      }
      if (!answers.length) { this.deny(socket, 'Registry DNS resolved only to blocked or invalid addresses', host); return; }
      const identity = answers.map(answer => `${answer.family}:${answer.address}`).sort().join(',');
      const prior = this.pinned.get(host);
      if (prior && prior !== identity) { this.deny(socket, 'Registry DNS answers changed during one acquisition', host); return; }
      this.pinned.set(host, identity);
      const selected = answers.sort((a, b) => a.address.localeCompare(b.address))[0];
      // No await is permitted between the closing/deadline check and socket
      // registration: close() must either prevent this dial or destroy it.
      if (this.closing || socket.destroyed || Date.now() >= this.deadline) return;
      const upstream = net.connect({ host: selected.address, port: 443, family: selected.family });
      this.sockets.add(upstream); upstream.setTimeout(Math.max(1, Math.min(30_000, this.deadline - Date.now())));
      upstream.once('close', () => this.sockets.delete(upstream));
      upstream.once('error', () => { if (!this.closing) this.violation ??= 'Registry connection failed after DNS pinning'; socket.destroy(); });
      upstream.once('connect', () => {
        if (this.closing || socket.destroyed || Date.now() >= this.deadline) {
          upstream.destroy(); socket.destroy(); return;
        }
        const addBytes = (bytes: number) => {
          this.transferred += bytes;
          if (this.transferred <= this.maxBytes) return true;
          this.violation = 'Registry transfer exceeded its byte ceiling'; socket.destroy(); upstream.destroy(); return false;
        };
        const count = (chunk: Buffer) => { addBytes(chunk.length); };
        socket.on('data', count); upstream.on('data', count); socket.pipe(upstream); upstream.pipe(socket);
        this.contactedHosts.add(host); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (remainder.length && addBytes(remainder.length)) upstream.write(remainder);
      });
    } catch {
      if (this.closing || socket.destroyed) return;
      this.deny(socket, 'Registry DNS lookup or pinned connection failed', host);
    }
  }

  private accept(socket: net.Socket): void {
    if (this.closing || Date.now() >= this.deadline) { socket.destroy(); return; }
    if (this.sockets.size >= 64) { this.deny(socket, 'Registry broker connection limit exceeded'); return; }
    const connectionDeadline = Math.min(this.deadline, Date.now() + 30_000);
    this.sockets.add(socket); socket.setTimeout(Math.max(1, connectionDeadline - Date.now()));
    socket.once('close', () => this.sockets.delete(socket));
    let pending = Buffer.alloc(0), handled = false;
    const first = (chunk: Buffer) => {
      if (handled) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 16 * 1024) { handled = true; this.deny(socket, 'Registry proxy request exceeded its header limit'); return; }
      const end = pending.indexOf('\r\n\r\n'); if (end < 0) return;
      handled = true; socket.off('data', first);
      const header = pending.subarray(0, end + 4).toString('ascii'), remainder = pending.subarray(end + 4);
      const line = header.slice(0, header.indexOf('\r\n'));
      const match = line.match(/^CONNECT ([a-zA-Z0-9.-]+):443 HTTP\/1\.[01]$/);
      const host = match?.[1].toLowerCase();
      if (!host || header.toLowerCase().includes('\r\nproxy-authorization:') || !this.allowedHosts.includes(host)) {
        this.deny(socket, 'Registry proxy rejected a non-allowlisted CONNECT request', host); return;
      }
      const task = this.openTunnel(socket, host, remainder, connectionDeadline);
      this.tasks.add(task); void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    };
    socket.on('data', first); socket.once('timeout', () => this.deny(socket, 'Registry proxy connection timed out'));
    socket.once('error', () => {});
  }

  assertClean(): void { if (this.violation) fail('ISOLATION_FAILED', this.violation); }

  async close(): Promise<void> {
    this.closing = true;
    for (const resolution of this.resolutions) resolution.cancel(new CsoError('ISOLATION_FAILED', 'Registry broker closed during DNS resolution'));
    for (const socket of this.sockets) socket.destroy();
    if (this.started && this.server.listening) await new Promise<void>(resolveClose => this.server.close(() => resolveClose()));
    await Promise.allSettled([...this.tasks]);
    this.started = false;
    try {
      const stat = fs.lstatSync(this.socketPath);
      if (!stat.isSocket() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Registry broker socket changed before cleanup');
      fs.unlinkSync(this.socketPath);
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export interface DockerPreparationRunnerOptions {
  endpoint: DockerEndpoint;
  watchdogPath: string;
  controlRoot: string;
  runRoot?: string;
  admission: PreparationRuntimeAdmission;
}

export interface PreparedCallGuard { callRoot: string; controlRoot: string; dispose(): Promise<void> }
export interface SupervisedRegistrySocket { root: string; socketPath: string; dispose(): Promise<void> }
/** Darwin's sockaddr_un.sun_path is 104 bytes including its terminator. */
export const REGISTRY_SOCKET_PATH_MAX_BYTES = 90;
function sameDirectory(left:fs.Stats,right:fs.Stats):boolean{return left.dev===right.dev&&left.ino===right.ino&&left.uid===right.uid;}
function ownedDirectory(path:string,label:string):fs.Stats{
  let stat:fs.Stats;try{stat=fs.lstatSync(path);}catch{fail('PERSISTENCE_FAILED',`${label} disappeared`);}
  if(!stat!.isDirectory()||stat!.isSymbolicLink()||(process.getuid&&stat!.uid!==process.getuid()))fail('UNSAFE_PATH',`${label} is not one owned directory`);
  return stat!;
}
/** Detached guard for a successful retained preparation copy. Exported for fault-injection qualification. */
export async function supervisePreparedCall(options:{watchdogPath:string;ownerPid:number;deadline:number;runRoot:string;callRoot:string;controlRoot:string}):Promise<PreparedCallGuard>{
  const run=fs.realpathSync(options.runRoot),call=fs.realpathSync(options.callRoot),control=fs.realpathSync(options.controlRoot);
  if(!Number.isSafeInteger(options.ownerPid)||options.ownerPid<=1||!Number.isSafeInteger(options.deadline)||options.deadline<=Date.now()||
    !call.startsWith(`${run}${sep}`)||!control.startsWith(`${run}${sep}`)||call===control)fail('ISOLATION_FAILED','Prepared-copy supervision paths or deadline are invalid');
  const callIdentity=ownedDirectory(call,'Prepared call root'),controlIdentity=ownedDirectory(control,'Prepared supervision control');
  if(!fs.existsSync(options.watchdogPath)||fs.lstatSync(options.watchdogPath).isSymbolicLink())fail('ISOLATION_FAILED','Prepared-copy watchdog is missing from the trusted helper distribution');
  const ready=join(control,'attempt.ready'),terminal=join(control,'attempt.terminal'),stopped=join(control,'attempt.stopped'),event=join(control,'attempt.event');
  const child=spawn(options.watchdogPath,['--attempt-owner',String(options.ownerPid),'--deadline',String(Math.ceil(options.deadline/1000)),
    '--control-dir',control,'--work-root',call,'--run-root',run],{cwd:control,env:{PATH:'/usr/bin:/bin'},detached:true,stdio:'ignore'});
  let failed=false;child.once('error',()=>{failed=true;});child.unref();
  for(let attempt=0;attempt<100&&!failed&&!fs.existsSync(ready);attempt++)await new Promise(resolveWait=>setTimeout(resolveWait,10));
  let alive=false;try{if(child.pid){process.kill(child.pid,0);alive=true;}}catch{}
  if(failed||!alive||!fs.existsSync(ready)){
    try{if(child.pid)process.kill(child.pid,'SIGKILL');}catch{}
    fail('ISOLATION_FAILED','Prepared-copy watchdog failed its startup handshake');
  }
  let disposed=false;
  return {callRoot:call,controlRoot:control,dispose:async()=>{
    if(disposed)fail('PERSISTENCE_FAILED','Prepared-copy guard was already disposed');
    disposed=true;let supervised=false;
    try{
      const current=fs.lstatSync(call);
      if(!sameDirectory(callIdentity,current)||!current.isDirectory()||current.isSymbolicLink())fail('SNAPSHOT_RACE','Prepared call root changed before cleanup');
      fs.rmSync(call,{recursive:true,force:false});supervised=true;
    }catch(error:any){
      if(error instanceof CsoError)throw error;
      if(error?.code!=='ENOENT'||!fs.existsSync(event))fail('PERSISTENCE_FAILED','Prepared execution copy could not be removed exactly');
    }
    if(supervised){fs.writeFileSync(terminal,'normal cleanup complete\n',{mode:0o600,flag:'wx'});for(let attempt=0;attempt<100&&!fs.existsSync(stopped);attempt++)await new Promise(resolveWait=>setTimeout(resolveWait,10));if(!fs.existsSync(stopped))fail('ISOLATION_FAILED','Prepared-copy watchdog did not acknowledge exact cleanup');}
    const currentControl=ownedDirectory(control,'Prepared supervision control');if(!sameDirectory(controlIdentity,currentControl))fail('SNAPSHOT_RACE','Prepared supervision control changed before cleanup');
    fs.rmSync(control,{recursive:true,force:false});
  }};
}

function removeExactDirectory(path:string,identity:fs.Stats,label:string):void{
  let current:fs.Stats;
  try{current=fs.lstatSync(path);}catch(error:any){if(error?.code==='ENOENT')return;fail('PERSISTENCE_FAILED',`${label} disappeared before exact cleanup`);}
  if(!current!.isDirectory()||current!.isSymbolicLink()||!sameDirectory(identity,current!))fail('SNAPSHOT_RACE',`${label} changed before exact cleanup`);
  try{fs.rmSync(path,{recursive:true,force:false});}catch{fail('PERSISTENCE_FAILED',`${label} could not be removed exactly`);}
  if(fs.existsSync(path))fail('PERSISTENCE_FAILED',`${label} cleanup could not be proven`);
}
function registrySocketBase():{path:string;uid:number}{
  const getuid=process.getuid;
  if(process.platform==='win32'||!getuid)fail('PREREQUISITE','Registry acquisition requires local Unix sockets');
  const uid=getuid();
  let temporary:string;
  try{temporary=fs.realpathSync('/tmp');}catch{fail('PREREQUISITE','A canonical local temporary directory is required for registry acquisition');}
  const stat=fs.lstatSync(temporary!);
  if(temporary==='/'||!stat.isDirectory()||stat.isSymbolicLink()||(stat.uid!==0&&stat.uid!==uid)||
    ((stat.mode&0o022)!==0&&(stat.mode&0o1000)===0))fail('UNSAFE_PATH','The local temporary directory is not a trusted sticky directory');
  return {path:temporary!,uid};
}

/**
 * Create a collision-resistant, Darwin-safe registry socket path and place its
 * entire per-call root under an independent owner/deadline watchdog. The
 * watchdog control directory is nested deliberately, so normal termination,
 * owner death, and deadline expiry all remove the same exact root without a
 * caller-only cleanup interval.
 */
export async function superviseRegistrySocket(options:{watchdogPath:string;ownerPid:number;deadline:number}):Promise<SupervisedRegistrySocket>{
  if(!Number.isSafeInteger(options.ownerPid)||options.ownerPid<=1||!Number.isSafeInteger(options.deadline)||options.deadline<=Date.now())
    fail('ISOLATION_FAILED','Registry socket supervision owner or deadline is invalid');
  let watchdog='',watchdogStat:fs.Stats;
  try{watchdog=fs.realpathSync(options.watchdogPath);watchdogStat=fs.lstatSync(options.watchdogPath);}catch{fail('ISOLATION_FAILED','Registry socket watchdog is missing from the trusted helper distribution');}
  if(!isAbsolute(options.watchdogPath)||watchdog!==options.watchdogPath||!watchdogStat!.isFile()||watchdogStat!.isSymbolicLink()||
    (watchdogStat!.mode&0o111)===0||(process.getuid&&watchdogStat!.uid!==0&&watchdogStat!.uid!==process.getuid()))
    fail('ISOLATION_FAILED','Registry socket watchdog must be one canonical owned executable');
  const {path:base,uid}=registrySocketBase();let root='';
  for(let attempt=0;attempt<4&&!root;attempt++){
    const candidate=join(base,`gscso-${uid}-${randomBytes(16).toString('hex')}`);
    try{fs.mkdirSync(candidate,{mode:0o700});root=candidate;}catch(error:any){if(error?.code!=='EEXIST')throw error;}
  }
  if(!root)fail('INSUFFICIENT_CAPACITY','A unique private registry socket directory could not be allocated');
  fs.chmodSync(root,0o700);
  const rootIdentity=ownedDirectory(root,'Registry socket root'),socketPath=join(root,'r.sock');
  if(fs.realpathSync(root)!==root||Buffer.byteLength(socketPath)>REGISTRY_SOCKET_PATH_MAX_BYTES){
    removeExactDirectory(root,rootIdentity,'Registry socket root');
    fail('PREREQUISITE',`The canonical registry socket path exceeds ${REGISTRY_SOCKET_PATH_MAX_BYTES} bytes`);
  }
  let control='';let child:ReturnType<typeof spawn>|undefined;let failed=false;let exitCode:number|null|undefined;
  try{
    control=secureDirectory(join(root,'control'));
    const ready=join(control,'attempt.ready'),terminal=join(control,'attempt.terminal');
    child=spawn(watchdog,['--ephemeral-owner',String(options.ownerPid),'--deadline',String(Math.ceil(options.deadline/1000)),
      '--control-dir',control,'--work-root',root,'--run-root',base],{cwd:control,env:{PATH:'/usr/bin:/bin'},detached:true,stdio:'ignore'});
    const exited=new Promise<number|null>(resolveExit=>child!.once('close',code=>{exitCode=code;resolveExit(code);}));
    child.once('error',()=>{failed=true;});child.unref();
    for(let attempt=0;attempt<100&&!failed&&!fs.existsSync(ready);attempt++)await new Promise(resolveWait=>setTimeout(resolveWait,10));
    let alive=false;try{if(child.pid){process.kill(child.pid,0);alive=true;}}catch{}
    if(failed||!alive||!fs.existsSync(ready)){
      try{if(child.pid)process.kill(child.pid,'SIGKILL');}catch{}
      await Promise.race([exited,new Promise(resolveWait=>setTimeout(resolveWait,1000))]);
      fail('ISOLATION_FAILED','Registry socket watchdog failed its startup handshake');
    }
    let disposed=false;
    return {root,socketPath,dispose:async()=>{
      if(disposed)fail('PERSISTENCE_FAILED','Registry socket guard was already disposed');
      disposed=true;
      let current:fs.Stats;
      try{current=fs.lstatSync(root);}catch(error:any){
        if(error?.code!=='ENOENT')fail('PERSISTENCE_FAILED','Registry socket root disappeared during cleanup');
        const code=exitCode===undefined?await Promise.race([exited,new Promise<undefined>(resolveWait=>setTimeout(()=>resolveWait(undefined),5000))]):exitCode;
        if(code!==0)fail('ISOLATION_FAILED','Registry socket watchdog did not complete abnormal exact cleanup');
        return;
      }
      if(!current!.isDirectory()||current!.isSymbolicLink()||!sameDirectory(rootIdentity,current!))fail('SNAPSHOT_RACE','Registry socket root changed before cleanup');
      try{fs.writeFileSync(terminal,'normal cleanup complete\n',{mode:0o600,flag:'wx'});}catch(error:any){
        if(error?.code!=='ENOENT')throw error;
      }
      for(let attempt=0;attempt<500&&fs.existsSync(root);attempt++)await new Promise(resolveWait=>setTimeout(resolveWait,10));
      if(fs.existsSync(root))fail('ISOLATION_FAILED','Registry socket watchdog did not remove the exact private root');
      const code=exitCode===undefined?await Promise.race([exited,new Promise<undefined>(resolveWait=>setTimeout(()=>resolveWait(undefined),5000))]):exitCode;
      if(code!==0)fail('ISOLATION_FAILED','Registry socket watchdog exited without completing exact cleanup');
    }};
  }catch(error){
    try{if(child?.pid)process.kill(child.pid,'SIGKILL');}catch{}
    let cleanupError:unknown;try{removeExactDirectory(root,rootIdentity,'Registry socket root');}catch(failure){cleanupError=failure;}
    if(cleanupError)throw cleanupError;
    throw error;
  }
}

/**
 * Requires qualified runtime images to contain the fixed, compiled
 * /opt/cso/preparation@1.0.0 helper contract.
 */
export class DockerPreparationSandboxRunner implements PreparationSandboxRunner {
  readonly qualification;
  private readonly runtime;
  private readonly controlRoot: string;
  private readonly preparedRoots = new Map<string, { guard: PreparedCallGuard; callDir: string; callIdentity: fs.Stats }>();

  constructor(private readonly options: DockerPreparationRunnerOptions) {
    this.runtime = admittedPreparationRuntime(options.admission);
    if (!['node', 'bun', 'python', 'rails'].includes(this.runtime.stack) || this.runtime.versions['cso-preparation'] !== '1.0.0')
      fail('PREREQUISITE', 'Qualified runtime lacks the cso-preparation=1.0.0 container helper contract');
    this.controlRoot = secureDirectory(resolve(options.controlRoot));
    this.qualification = Object.freeze({ schemaVersion: 1 as const, helperAbi: CSO_HELPER_ABI,
      runnerId: 'docker-registry-broker-v1', policyVersion: 'cso-preparation-v1' as const,
      supportedStacks: [this.runtime.stack as CsoStack], registryRestrictionQualified: true as const,
      dnsRebindingTestsPassed: true as const, acquisitionExcludesSource: true as const,
      offlineContainmentQualified: true as const, immutableArchiveMounts: true as const, resourceLimitsEnforced: true as const });
  }

  private assertRuntime(request: PreparationAcquireRequest | OfflinePreparationRequest): void {
    if (request.runtime.id !== this.runtime.id || request.runtime.image !== this.runtime.image || request.runtime.platform !== this.runtime.platform || request.stack !== this.runtime.stack)
      fail('INCOMPATIBLE_INPUT', 'Docker preparation request does not match its admitted runtime');
  }

  private callDirectory(prefix: string): string {
    return secureDirectory(join(this.controlRoot, `${prefix}-${Date.now()}-${randomBytes(8).toString('hex')}`));
  }
  private removeCallDirectory(path:string,identity:fs.Stats):void{
    let current:fs.Stats;try{current=fs.lstatSync(path);}catch{fail('PERSISTENCE_FAILED','Preparation call directory disappeared before exact cleanup');}
    if(!current!.isDirectory()||current!.isSymbolicLink()||current!.dev!==identity.dev||current!.ino!==identity.ino)fail('SNAPSHOT_RACE','Preparation call directory changed before cleanup');
    try{fs.rmSync(path,{recursive:true,force:false});}catch{fail('PERSISTENCE_FAILED','Preparation call directory could not be removed');}
    if(fs.existsSync(path))fail('PERSISTENCE_FAILED','Preparation call directory cleanup could not be proven');
  }

  private publishArtifacts(artifacts: AcquisitionArtifactReceipt[], output: string, stagingRoot: string, maxBytes: number): void {
    const created: string[] = [];
    try {
      for (const artifact of artifacts) {
        if (typeof artifact.stagingPath !== 'string' || !artifact.stagingPath.startsWith('cso-public/') ||
          artifact.stagingPath.slice('cso-public/'.length).includes('/')) fail('TOOL_FAILED', 'Qualified helper returned an invalid staging artifact path');
        const name = artifact.stagingPath.slice('cso-public/'.length), source = contained(join(output, 'archives'), name),
          target = contained(stagingRoot, artifact.stagingPath);
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== artifact.bytes || stat.size > maxBytes ||
          (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0 || fileSha256(source, maxBytes) !== artifact.sha256)
          fail('TOOL_FAILED', 'Qualified helper output did not match its archive receipt');
        secureDirectory(resolve(target, '..'));
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600); created.push(target);
        const copied = fs.lstatSync(target);
        if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1 || copied.size !== artifact.bytes ||
          fileSha256(target, maxBytes) !== artifact.sha256) fail('SNAPSHOT_RACE', 'Staged acquisition artifact changed during publication');
      }
    } catch (error) {
      for (const path of created.reverse()) { try { const stat = fs.lstatSync(path); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) fs.unlinkSync(path); } catch {} }
      throw error;
    }
  }

  private execClean(group: DockerGroup, id: string, command: string[], options: { workdir?: string; env?: Record<string, string> } = {}) {
    const forbidden = new Set(['BUN_OPTIONS', 'BUN_BE_BUN', 'NODE_OPTIONS', 'RUBYOPT', 'RUBYLIB', 'PYTHONPATH', 'PYTHONHOME',
      'LD_PRELOAD', 'LD_LIBRARY_PATH', 'ENV', 'BASH_ENV', 'CDPATH']);
    if (Object.keys(options.env ?? {}).some(key => forbidden.has(key))) fail('ISOLATION_FAILED', 'Preparation command attempted to restore a runtime injection variable');
    const clean = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work/.cso-home', ...(options.env ?? {}) };
    const argv = ['/usr/bin/env', '-i', ...Object.entries(clean).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`), ...command];
    return group.execCapture(id, argv, { workdir: options.workdir });
  }

  async acquire(request: PreparationAcquireRequest): Promise<AcquisitionReceipt> {
    this.assertRuntime(request);
    const dir = this.callDirectory('acquire'),callIdentity = fs.lstatSync(dir);
    let group: DockerGroup | undefined, broker: RegistryEgressBroker | undefined,guard:PreparedCallGuard|undefined,
      registrySocket:SupervisedRegistrySocket|undefined;
    const commandResults: PreparationCommandReceipt[] = [];
    try {
      const executionCopies=secureDirectory(join(dir,'execution-copies')),metadata = secureDirectory(join(executionCopies, 'metadata')),
        policyDir = secureDirectory(join(executionCopies, 'policy')),output = secureDirectory(join(executionCopies, 'output')),
        runRoot=secureDirectory(resolve(this.options.runRoot??this.controlRoot)),supervision=secureDirectory(join(runRoot,'supervision')),
        guardControl=secureDirectory(join(supervision,`acquisition-${randomBytes(12).toString('hex')}`));
      guard=await supervisePreparedCall({watchdogPath:this.options.watchdogPath,ownerPid:process.pid,deadline:request.deadline,
        runRoot,callRoot:executionCopies,controlRoot:guardControl});
      for (const item of request.metadata) {
        if (sha256(item.content) !== item.sha256) fail('INCOMPATIBLE_INPUT', `Acquisition metadata hash changed: ${item.path}`);
        const file = contained(metadata, item.path); secureDirectory(resolve(file, '..')); fs.writeFileSync(file, item.content, { mode: 0o600, flag: 'wx' });
      }
      const policyFile = join(policyDir, 'acquisition.json');
      writePolicy(policyFile, { schemaVersion: 1, planHash: request.planHash, stack: request.stack, inputs: request.inputs,
        commands: request.commands, allowedHosts: request.network.allowedHosts, archiveRoot: '/archives', limits: request.limits });
      group = await DockerGroup.create(this.options.endpoint, `prep-a-${randomBytes(10).toString('hex')}`, dir,
        request.deadline, this.runtime.image, this.options.watchdogPath);
      registrySocket=await superviseRegistrySocket({watchdogPath:this.options.watchdogPath,ownerPid:process.pid,deadline:request.deadline});
      broker = new RegistryEgressBroker(registrySocket.socketPath, request.network.allowedHosts, request.deadline,
        request.limits.maxTotalArchiveBytes + Math.min(64 * 1024 * 1024, request.limits.maxTotalArchiveBytes));
      await broker.start();
      const container = await group.createContainer({ role: 'app', image: this.runtime.image,
        command: ['/opt/cso/preparation', 'forwarder', '/run/cso-registry.sock', '127.0.0.1:18443'],
        readonlyFiles: [{ host: policyFile, container: '/policy/acquisition.json' }], readonlyInputMetadata: metadata,
        workTmpfsBytes: 64 * 1024 * 1024, temporaryTmpfsBytes: 64 * 1024 * 1024,
        metadataTmpfsBytes: (request.stack === 'node' || request.stack === 'bun' ? 1024 : 64) * 1024 * 1024,
        archiveTmpfsBytes: request.limits.maxTotalArchiveBytes, registrySocket: broker.socketPath });
      await group.start(container);
      let ready = false;
      for (let attempt = 0; attempt < 20 && !ready; attempt++) {
        const health = await this.execClean(group, container, ['/opt/cso/preparation', 'health', '127.0.0.1', '18443']);
        ready = health.code === 0; if (!ready) await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      if (!ready) fail('ISOLATION_FAILED', 'Qualified registry forwarder did not become ready');
      const proxy = { HTTP_PROXY: 'http://127.0.0.1:18443', HTTPS_PROXY: 'http://127.0.0.1:18443',
        ALL_PROXY: 'http://127.0.0.1:18443', NO_PROXY: '' };
      for (let index = 0; index < request.commands.length; index++) {
        const command = request.commands[index], result = await this.execClean(group, container,
          [command.executable, ...command.args], { workdir: command.cwd, env: { ...command.env, ...proxy } });
        broker.assertClean(); commandResults.push(commandReceipt(command, index, result.code));
        if (result.code !== 0) fail('TOOL_FAILED', `Dependency acquisition command ${index + 1} failed`);
      }
      await group.assertOnlyInitProcess(container);
      const containerExport = `/archives/.gstack-cso-acquisition-export-${randomBytes(12).toString('hex')}`;
      const manifest = await this.execClean(group, container,
        ['/opt/cso/preparation', 'manifest', '/policy/acquisition.json', '/archives', `${containerExport}/artifacts.json`], { workdir: '/archives', env: proxy });
      if (manifest.code !== 0) fail('TOOL_FAILED', 'Qualified archive manifest helper failed');
      broker.assertClean();
      await group.assertOnlyInitProcess(container);
      await group.pause(container);
      await group.copyAcquisitionExport(container, containerExport, output);
      const artifacts = readManifest(join(output, 'artifacts.json')).artifacts;
      validateAcquisitionOutput(output, artifacts);
      this.publishArtifacts(artifacts, output, request.stagingRoot, request.limits.maxArchiveBytes);
      return { schemaVersion: 1, planHash: request.planHash, runtimeId: request.runtime.id, runtimeImage: request.runtime.image,
        platform: request.runtime.platform, deadlineEnforced: true, network: { mode: 'registry-restricted',
          allowedHosts: [...request.network.allowedHosts], contactedHosts: [...broker.contactedHosts].sort(),
          redirectVisibility: 'opaque-tls',
          dnsRebindingBlocked: true, credentialsMounted: false, sourceMounted: false, dockerSocketMounted: false },
        lifecycleScriptsExecuted: false, targetCodeExecuted: false, commands: commandResults, artifacts };
    } finally {
      let cleanupError: unknown;
      try { if (broker) await broker.close(); } catch (error) { cleanupError = error; }
      try { if (group) await group.cleanup(); } catch (error) { cleanupError ??= error; }
      try { if (registrySocket) await registrySocket.dispose(); } catch (error) { cleanupError ??= error; }
      try { if (guard) await guard.dispose(); } catch (error) { cleanupError ??= error; }
      if (cleanupError) throw cleanupError;
      this.removeCallDirectory(dir,callIdentity);
    }
  }

  private materializeArchives(request: OfflinePreparationRequest, root: string): void {
    for (const archive of request.archives) {
      if (!archive.containerPath.startsWith('/archives/')) fail('UNSAFE_PATH', 'Offline archive mount escaped /archives');
      const relativePath = archive.containerPath.slice('/archives/'.length), target = contained(root, relativePath), source = resolve(archive.hostPath);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== archive.bytes || (stat.mode & 0o222) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) fail('UNSAFE_PATH', 'Offline archive is not an immutable cache file');
      secureDirectory(resolve(target, '..')); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o400);
      const hash = fileSha256(target, archive.bytes);
      if (hash !== archive.sha256) fail('INCOMPATIBLE_INPUT', 'Offline archive changed while its execution view was materialized');
    }
  }

  async prepareOffline(request: OfflinePreparationRequest): Promise<OfflinePreparationResult> {
    this.assertRuntime(request);
    const dir = this.callDirectory('offline'),callIdentity=fs.lstatSync(dir);let preparedRoot='',group: DockerGroup | undefined,success=false,guard:PreparedCallGuard|undefined;
    try {
    // Docker supervision owns `dir`; the retained-copy watchdog owns this
    // child. An owner death can therefore remove every execution input without
    // deleting the Docker watchdog's journal or control files.
    const executionCopies=secureDirectory(join(dir,'execution-copies')),
      source = secureDirectory(join(executionCopies, 'source')), metadata = secureDirectory(join(executionCopies, 'metadata')),
      archives = secureDirectory(join(executionCopies, 'archives')), policyDir = secureDirectory(join(executionCopies, 'policy'));
    preparedRoot = secureDirectory(join(executionCopies, 'prepared'));
    const runRoot=secureDirectory(resolve(this.options.runRoot??this.controlRoot)),supervision=secureDirectory(join(runRoot,'supervision')),
      guardControl=secureDirectory(join(supervision,`prepared-${randomBytes(12).toString('hex')}`));
    // Supervision is acknowledged before the first potentially large source
    // or dependency copy. It remains the retained-copy guard after Docker
    // teardown, closing the owner-death handoff window.
    guard=await supervisePreparedCall({watchdogPath:this.options.watchdogPath,ownerPid:process.pid,deadline:request.deadline,
      runRoot,callRoot:executionCopies,controlRoot:guardControl});
    fs.cpSync(request.sourceRoot, source, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: false });
    for (const transformation of request.transformations) {
      if (sha256(transformation.content) !== transformation.sha256) fail('INCOMPATIBLE_INPUT', 'Offline transformation content hash changed');
      const file = contained(source, transformation.path); secureDirectory(resolve(file, '..')); fs.writeFileSync(file, transformation.content, { mode: 0o600 });
    }
    for (const item of request.metadata) {
      if (sha256(item.content) !== item.sha256) fail('INCOMPATIBLE_INPUT', `Offline metadata hash changed: ${item.path}`);
      const file = contained(metadata, item.path); secureDirectory(resolve(file, '..')); fs.writeFileSync(file, item.content, { mode: 0o600, flag: 'wx' });
    }
    this.materializeArchives(request, archives);
    const offlinePolicy = join(policyDir, 'offline.json');
    writePolicy(offlinePolicy, { schemaVersion: 1, planHash: request.planHash, stack: request.stack,
      inputs: request.archives.map(archive => ({ index: archive.inputIndex, input: { kind: 'public', name: archive.name,
        version: archive.version, url: archive.requestedUrl, integrity: archive.declaredIntegrity,
        integritySource: archive.declaredIntegrity === 'registry-on-acquisition' ? 'registry-on-acquisition' : 'lock' } })),
      archives: request.archives.map(archive => ({ inputIndex: archive.inputIndex, name: archive.name, version: archive.version,
        declaredIntegrity: archive.declaredIntegrity, requestedUrl: archive.requestedUrl, resolvedUrl: archive.resolvedUrl,
        containerPath: archive.containerPath,
        sha256: archive.sha256, bytes: archive.bytes })) });
    const commands: PreparationCommandReceipt[] = [];
      group = await DockerGroup.create(this.options.endpoint, `prep-o-${randomBytes(10).toString('hex')}`, dir,
        request.deadline, this.runtime.image, this.options.watchdogPath);
      const app = await group.createContainer({ role: 'app', image: this.runtime.image, source,
        readonlyFiles: [{ host: offlinePolicy, container: '/policy/offline.json' }], readonlyMetadata: metadata, readonlyArchiveDirectory: archives,
        command: ['/opt/cso/run-app', '/opt/cso/preparation', 'seed', '/policy/offline.json'] });
      await group.start(app);
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        const result = await this.execClean(group, app, ['/opt/cso/preparation', 'ready']);
        ready = result.code === 0; if (!ready) await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      if (!ready) fail('TOOL_FAILED', 'Offline cache seeding did not become ready');
      for (let index = 0; index < request.commands.length; index++) {
        const command = request.commands[index], result = await this.execClean(group, app,
          [command.executable, ...command.args], { workdir: command.cwd, env: command.env });
        commands.push(commandReceipt(command, index, result.code));
        if (result.code !== 0) fail('TOOL_FAILED', `Offline dependency preparation command ${index + 1} failed`);
      }
      const finalized = await this.execClean(group, app, ['/opt/cso/preparation', 'finalize']);
      if (finalized.code !== 0) fail('TOOL_FAILED', 'Offline preparation scratch cleanup failed');
      await group.assertOnlyInitProcess(app);
      const containerExport = `/work/.gstack-cso-export-${randomBytes(12).toString('hex')}`;
      const exported = await this.execClean(group, app,
        ['/opt/cso/preparation', 'export-prepared', '/work', containerExport, String(request.limits.writableBytes)]);
      if (exported.code !== 0) fail('TOOL_FAILED', 'Qualified prepared-tree export rejected offline application output');
      await group.assertOnlyInitProcess(app);
      await group.pause(app);
      const inertExport = secureDirectory(join(executionCopies, 'prepared-export')), inertIdentity = fs.lstatSync(inertExport);
      await group.copyPreparedExport(app, containerExport, inertExport);
      materializePreparedExport(inertExport, preparedRoot, request.limits.writableBytes);
      this.removeCallDirectory(inertExport,inertIdentity);
      const services: Array<'application' | 'postgresql'> = ['application'];
      const receipt: OfflinePreparationReceipt = { schemaVersion: 1, planHash: request.planHash, runtimeId: request.runtime.id,
        runtimeImage: request.runtime.image, platform: request.runtime.platform, sourceHash: request.sourceHash,
        dependencyClosureHash: request.dependencyClosureHash, configurationHash: request.configurationHash,
        databaseHash: request.databaseHash, deadlineEnforced: true,
        network: { mode: 'none', namespaceAnchor: group.anchor, externalEgress: false, dnsAvailable: false, publishedPorts: false, services },
        commands, inputSourceReadOnly: true, preparedCopySeparate: true, archivesReadOnly: true, applicationCodeExecutedOnlyOffline: true };
      // The guard is live before Docker teardown starts. Remove redundant
      // source, metadata, archives, and policy now; only the prepared tree is
      // retained. Docker's independent watchdog keeps its parent control root.
      for(const current of [source,metadata,archives,policyDir])this.removeCallDirectory(current,fs.lstatSync(current));
      const completedGroup=group;await completedGroup.cleanup();group=undefined;
      this.preparedRoots.set(resolve(preparedRoot),{guard,callDir:dir,callIdentity});
      success=true;
      return { preparedRoot, receipt };
    } finally {
      let cleanupError:unknown;
      if (group) {
        try { await group.cleanup(); }
        catch (error) { cleanupError=error; }
      }
      if(cleanupError){if(preparedRoot)this.preparedRoots.delete(resolve(preparedRoot));if(guard)try{await guard.dispose();}catch{}throw cleanupError;}
      if(!success){
        if(preparedRoot)this.preparedRoots.delete(resolve(preparedRoot));
        // Once the retained-copy watchdog has acknowledged supervision it is
        // the only actor allowed to consume its call root. Stop and
        // acknowledge it before removing the Docker call directory.
        if(guard)await guard.dispose();
        this.removeCallDirectory(dir,callIdentity);
      }
    }
  }

  async disposePrepared(preparedRoot: string): Promise<void> {
    const root = resolve(preparedRoot), owned = this.preparedRoots.get(root),guard=owned?.guard,call=guard?.callRoot;
    if (!guard || !call || !owned || root !== join(call, 'prepared') || !owned.callDir.startsWith(`${this.controlRoot}${sep}`))
      fail('UNSAFE_PATH', 'Prepared execution copy is not owned by this runner');
    this.preparedRoots.delete(root);
    await guard.dispose();
    this.removeCallDirectory(owned.callDir,owned.callIdentity);
  }
}
