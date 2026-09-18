/**
 * Deterministic orchestration for dependency acquisition and offline target
 * preparation. This module never opens a network connection or invokes Docker;
 * a qualified helper adapter implements those effects and returns a receipt
 * which is checked again here before any archive becomes executable input.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PublicArchiveCache } from './cache';
import { canonical, CsoError, MAX_OUTPUT, sha256 } from './contracts';
import {
  inspectPreparation, railsTestConfiguration, type CsoStack, type PreparationCommand,
  type PreparationInput, type PreparationPlan,
} from './preparation';
import {
  assertRuntimeCompatible, CSO_HELPER_ABI, RUNTIME_CATALOG, selectRuntime, validateRuntimeCatalog,
  type QualifiedRuntime, type RuntimeCatalog, type RuntimePlatform,
} from './runtime-catalog';

const SHA256 = /^[a-f0-9]{64}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RELATIVE_ARCHIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[A-Za-z0-9@._+\/-]{1,1024}$/;
const MAX_ARCHIVES = 25_000;
const MAX_TREE_FILES = 200_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
// The smallest automatic execution role is the tests container: 768 MiB at
// /work after its fixed /tmp allocation. Reserve 32 MiB for filesystem and
// package-manager bookkeeping so a declared prepared tree is executable in
// every before/after/test phase rather than merely exportable.
const MAX_PREPARED_BYTES = 736 * 1024 * 1024;
// Anchor/application work consume 784 MiB and acquisition metadata is capped
// at 400 MiB. Archive and export tmpfs each use at most 384 MiB, keeping the
// aggregate below the 2 GiB group policy while avoiding writable host binds.
const MAX_ACQUISITION_ARCHIVE_BYTES = 384 * 1024 * 1024;
const admittedRuntimes = new WeakSet<object>();

function fail(code: ConstructorParameters<typeof CsoError>[0], message: string): never { throw new CsoError(code, message); }
function sameStrings(left: string[], right: string[]): boolean {
  return canonical([...left].sort()) === canonical([...right].sort());
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function checkDeadline(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED', 'Preparation was cancelled before the operation completed');
  if (!Number.isSafeInteger(deadline) || deadline <= 0) fail('INVALID_ARGUMENT', 'Preparation deadline must be an absolute millisecond timestamp');
  if (Date.now() >= deadline) fail('DEADLINE', 'Preparation deadline was reached before the operation completed');
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : 'Runtime catalog admission failed'; }

export interface PreparationRuntimeAdmission {
  schemaVersion: 1;
  catalogRevision: string;
  runtime: QualifiedRuntime;
}

/** Select an application runtime from a reviewed catalog. The default empty catalog blocks execution. */
export function admitPreparationRuntime(options: {
  plan: PreparationPlan;
  platform: RuntimePlatform;
  profile?: string;
  catalog?: RuntimeCatalog;
}): PreparationRuntimeAdmission {
  const catalog = options.catalog ?? RUNTIME_CATALOG;
  try { validateRuntimeCatalog(catalog); }
  catch (error) { fail('PREREQUISITE', `Runtime catalog is not qualified: ${safeMessage(error)}`); }
  let runtime: QualifiedRuntime;
  try { runtime = selectRuntime(options.profile ?? options.plan.runtimeProfile, options.platform, catalog); }
  catch (error) { fail('PREREQUISITE', safeMessage(error)); }
  assertRuntimeCompatible(options.plan, runtime!);
  const admission = Object.freeze({ schemaVersion: 1 as const, catalogRevision: catalog.revision, runtime: runtime! });
  admittedRuntimes.add(admission);
  return admission;
}

/** PostgreSQL is admitted independently and must match the application's platform/catalog revision. */
export function admitPreparationSidecar(options: {
  platform: RuntimePlatform;
  profile?: string;
  catalog?: RuntimeCatalog;
}): PreparationRuntimeAdmission {
  const catalog = options.catalog ?? RUNTIME_CATALOG;
  try { validateRuntimeCatalog(catalog); }
  catch (error) { fail('PREREQUISITE', `Runtime catalog is not qualified: ${safeMessage(error)}`); }
  let runtime: QualifiedRuntime;
  try { runtime = selectRuntime(options.profile ?? 'postgresql', options.platform, catalog); }
  catch (error) { fail('PREREQUISITE', safeMessage(error)); }
  if (runtime!.stack !== 'postgresql') fail('INCOMPATIBLE_INPUT', 'Rails PostgreSQL preparation requires a qualified PostgreSQL runtime');
  const admission = Object.freeze({ schemaVersion: 1 as const, catalogRevision: catalog.revision, runtime: runtime! });
  admittedRuntimes.add(admission);
  return admission;
}

export interface PreparationRunnerQualification {
  schemaVersion: 1;
  helperAbi: number;
  runnerId: string;
  policyVersion: 'cso-preparation-v1';
  supportedStacks: CsoStack[];
  registryRestrictionQualified: true;
  dnsRebindingTestsPassed: true;
  acquisitionExcludesSource: true;
  offlineContainmentQualified: true;
  immutableArchiveMounts: true;
  resourceLimitsEnforced: true;
}

export interface PreparationCommandReceipt {
  index: number;
  commandHash: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface AcquisitionArtifactReceipt {
  inputIndex: number;
  stagingPath: string;
  installPath: string;
  sha256: string;
  bytes: number;
  requestedHost: string;
  requestedUrl: string;
  /** Final response URL only when the trusted helper performed the download directly. */
  resolvedUrl: string | null;
  /** Digest calculated over the registry response before it entered staging. */
  registryResponseSha256: string;
}

export interface AcquisitionReceipt {
  schemaVersion: 1;
  planHash: string;
  runtimeId: string;
  runtimeImage: string;
  platform: RuntimePlatform;
  deadlineEnforced: true;
  network: {
    mode: 'registry-restricted';
    allowedHosts: string[];
    contactedHosts: string[];
    /** CONNECT host allowlisting is enforced, but paths and redirects inside TLS are unobservable. */
    redirectVisibility: 'opaque-tls';
    dnsRebindingBlocked: true;
    credentialsMounted: false;
    sourceMounted: false;
    dockerSocketMounted: false;
  };
  lifecycleScriptsExecuted: false;
  targetCodeExecuted: false;
  commands: PreparationCommandReceipt[];
  artifacts: AcquisitionArtifactReceipt[];
}

export interface PreparationAcquireRequest {
  schemaVersion: 1;
  planHash: string;
  stack: CsoStack;
  runtime: { id: string; image: string; platform: RuntimePlatform };
  metadata: PreparationPlan['metadata'];
  inputs: Array<{ index: number; input: PreparationInput }>;
  commands: PreparationCommand[];
  stagingRoot: string;
  deadline: number;
  limits: { maxArchives: number; maxArchiveBytes: number; maxTotalArchiveBytes: number; maxOutputBytes: number };
  network: { mode: 'registry-restricted'; allowedHosts: string[] };
  sourceMounted: false;
}

export interface CachedArchiveMount {
  inputIndex: number;
  name: string;
  version: string;
  declaredIntegrity: string;
  requestedUrl: string;
  resolvedUrl: string | null;
  hostPath: string;
  containerPath: string;
  sha256: string;
  bytes: number;
}

export type RailsDatabaseSelection =
  | { adapter: 'sqlite' }
  | { adapter: 'postgresql'; sidecar: PreparationRuntimeAdmission };

export type PreparedDatabaseContract =
  | { adapter: 'sqlite'; connections: string[] }
  | { adapter: 'postgresql'; connections: string[]; sidecar: { id: string; image: string } };

export interface OfflinePreparationRequest {
  schemaVersion: 1;
  planHash: string;
  stack: CsoStack;
  runtime: { id: string; image: string; platform: RuntimePlatform };
  sourceRoot: string;
  sourceHash: string;
  /** Sanitized inert files used only by offline package-manager metadata commands. */
  metadata: PreparationPlan['metadata'];
  dependencyClosureHash: string;
  commands: PreparationCommand[];
  archives: CachedArchiveMount[];
  transformations: Array<{ path: string; content: string; sha256: string; reason: string }>;
  configurationHash: string;
  database?: PreparedDatabaseContract;
  databaseHash: string;
  deadline: number;
  limits: { cpus: 2; memoryBytes: number; pids: 256; writableBytes: number; maxOutputBytes: number };
  network: { mode: 'none'; sharedLoopbackNamespace: true; publishedPorts: false };
  inputSourceReadOnly: true;
  archivesReadOnly: true;
}

export interface OfflinePreparationReceipt {
  schemaVersion: 1;
  planHash: string;
  runtimeId: string;
  runtimeImage: string;
  platform: RuntimePlatform;
  sourceHash: string;
  dependencyClosureHash: string;
  configurationHash: string;
  databaseHash: string;
  deadlineEnforced: true;
  network: {
    mode: 'none';
    namespaceAnchor: string;
    externalEgress: false;
    dnsAvailable: false;
    publishedPorts: false;
    services: Array<'application' | 'postgresql'>;
  };
  commands: PreparationCommandReceipt[];
  inputSourceReadOnly: true;
  preparedCopySeparate: true;
  archivesReadOnly: true;
  applicationCodeExecutedOnlyOffline: true;
}

export interface OfflinePreparationResult {
  preparedRoot: string;
  receipt: OfflinePreparationReceipt;
}

export interface PreparationSandboxRunner {
  readonly qualification: PreparationRunnerQualification;
  acquire(request: PreparationAcquireRequest): Promise<AcquisitionReceipt>;
  prepareOffline(request: OfflinePreparationRequest): Promise<OfflinePreparationResult>;
  disposePrepared(preparedRoot: string): Promise<void> | void;
}

export interface DependencyArchive {
  inputIndex: number;
  name: string;
  version: string;
  installPath: string;
  sha256: string;
  bytes: number;
  requestedHost: string;
  requestedUrl: string;
  resolvedUrl: string | null;
  declaredIntegrity: string;
}

export interface DependencyClosure {
  schemaVersion: 1;
  stack: CsoStack;
  planHash: string;
  catalogRevision: string;
  runtimeId: string;
  runtimeImage: string;
  platform: RuntimePlatform;
  archives: DependencyArchive[];
  acquisitionReceiptHash: string | null;
  closureHash: string;
}

export interface PreparedApplication {
  schemaVersion: 1;
  stack: CsoStack;
  preparedRoot: string;
  sourceHash: string;
  preparedManifestHash: string;
  preparedDependencyHash: string;
  dependencyClosureHash: string;
  configurationHash: string;
  databaseHash: string;
  database?: PreparedDatabaseContract;
  sourceProjectionHash: string;
  transformations: Array<{ path: string; sha256: string; mode: number; reason: string }>;
  executionEnvironment: Record<string, string>;
  receiptHash: string;
  receipt: OfflinePreparationReceipt;
}

function runtimeFromAdmission(plan: PreparationPlan, admission: PreparationRuntimeAdmission): QualifiedRuntime {
  if (!admission || !admittedRuntimes.has(admission)) fail('PREREQUISITE', 'Runtime must be selected through current-process catalog admission');
  assertRuntimeCompatible(plan, admission.runtime);
  return admission.runtime;
}

/** Trusted adapters use this to bind themselves to a current-process catalog admission. */
export function admittedPreparationRuntime(admission: PreparationRuntimeAdmission): QualifiedRuntime {
  if (!admission || !admittedRuntimes.has(admission)) fail('PREREQUISITE', 'Runtime must be selected through current-process catalog admission');
  return admission.runtime;
}

function planHash(plan: PreparationPlan): string { return sha256(canonical(plan)); }
function commandHash(command: PreparationCommand): string { return sha256(canonical(command)); }

function validateRunner(runner: PreparationSandboxRunner, stack: CsoStack): void {
  const q = runner?.qualification;
  if (!q || q.schemaVersion !== 1 || q.helperAbi !== CSO_HELPER_ABI || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(q.runnerId) ||
    q.policyVersion !== 'cso-preparation-v1' || !Array.isArray(q.supportedStacks) || !q.supportedStacks.includes(stack) ||
    new Set(q.supportedStacks).size !== q.supportedStacks.length || q.registryRestrictionQualified !== true ||
    q.dnsRebindingTestsPassed !== true || q.acquisitionExcludesSource !== true || q.offlineContainmentQualified !== true ||
    q.immutableArchiveMounts !== true || q.resourceLimitsEnforced !== true || typeof runner.disposePrepared !== 'function')
    fail('ISOLATION_FAILED', `Preparation runner is not qualified for ${stack}`);
}

function validatePlan(plan: PreparationPlan, snapshot: string): string {
  if (!plan || plan.schemaVersion !== 1 || plan.status !== 'ready') fail('PREREQUISITE', 'Dependency metadata is not ready for automatic preparation');
  const current = inspectPreparation(snapshot, plan.stack);
  if (current.status !== 'ready' || canonical(current) !== canonical(plan))
    fail('INCOMPATIBLE_INPUT', 'Preparation plan does not match the current retained snapshot');
  const hosts = plan.registryHosts;
  if (!hosts.length || hosts.some(host => host !== host.toLowerCase() || !HOST.test(host)) || new Set(hosts).size !== hosts.length)
    fail('INVALID_SCHEMA', 'Preparation plan contains invalid or duplicate registry hosts');
  if (plan.inputs.filter(input => input.kind === 'public').length && !plan.acquisition.length)
    fail('INVALID_SCHEMA', 'Public dependencies require a constrained acquisition command');
  for (const command of [...plan.acquisition, ...plan.offline]) {
    if (!command.executable.startsWith('/') || !['/metadata', '/work', '/archives'].includes(command.cwd) || !Array.isArray(command.args) ||
      command.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\0\r\n]/.test(arg)) ||
      Object.entries(command.env).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || /[\0\r\n]/.test(value)))
      fail('INVALID_SCHEMA', 'Preparation command is not a bounded absolute argv/env description');
  }
  for (const command of plan.acquisition) {
    if (command.cwd === '/work' || command.args.some(arg => arg === '/work' || arg.startsWith('/work/')))
      fail('ISOLATION_FAILED', 'Acquisition commands must not receive application source');
  }
  if (plan.stack === 'node' && plan.acquisition.some(command => !command.args.includes('--ignore-scripts')))
    fail('ISOLATION_FAILED', 'Node acquisition must disable lifecycle scripts');
  if (plan.stack === 'bun' && plan.acquisition.some(command => !command.args.includes('--ignore-scripts')))
    fail('ISOLATION_FAILED', 'Bun acquisition must disable lifecycle scripts');
  if (plan.stack === 'python' && plan.acquisition.some(command => !['/usr/local/bin/uv', '/usr/local/bin/python'].includes(command.executable) || command.args.includes('install')))
    fail('ISOLATION_FAILED', 'Python acquisition may only export metadata or download public wheels');
  if (plan.stack === 'rails' && plan.acquisition.some(command => command.executable !== '/usr/local/bin/gem' || command.args[0] !== 'fetch' || !command.args.includes('--norc')))
    fail('ISOLATION_FAILED', 'Rails acquisition may only fetch exact gems without evaluating application code');
  return planHash(plan);
}

function validateCommandReceipts(receipts: PreparationCommandReceipt[], commands: PreparationCommand[]): void {
  if (!Array.isArray(receipts) || receipts.length !== commands.length) fail('TOOL_FAILED', 'Preparation receipt omitted a command result');
  const seen = new Set<number>();
  for (const receipt of receipts) {
    if (!Number.isInteger(receipt.index) || receipt.index < 0 || receipt.index >= commands.length || seen.has(receipt.index) ||
      receipt.commandHash !== commandHash(commands[receipt.index]) || receipt.exitCode !== 0 || receipt.timedOut !== false || receipt.outputTruncated !== false)
      fail('TOOL_FAILED', 'Preparation command failed or its exact argv receipt is invalid');
    seen.add(receipt.index);
  }
}

function validateUrl(value: string, host: string, allowed: string[]): void {
  let url: URL;
  try { url = new URL(value); } catch { fail('TOOL_FAILED', 'Acquisition receipt contains an invalid source URL'); }
  if (url!.protocol !== 'https:' || url!.username || url!.password || url!.port || url!.search || url!.hash ||
    url!.hostname !== host || !allowed.includes(host)) fail('ISOLATION_FAILED', 'Acquisition receipt escaped its public registry allowlist');
}

function relativeArchivePath(value: string, label: string): string {
  if (typeof value !== 'string' || !RELATIVE_ARCHIVE.test(value) || value.split('/').some(part => !part || part === '.' || part === '..'))
    fail('UNSAFE_PATH', `${label} must be a contained archive path`);
  return value;
}

function stagedFileHashes(root: string, relativePath: string, expectedBytes: number, deadline: number,
  signal?: AbortSignal): { sha256: string; sha512: string } {
  checkDeadline(deadline, signal);
  const parts = relativeArchivePath(relativePath, 'Staged archive').split('/');
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    checkDeadline(deadline, signal);
    cursor = join(cursor, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); } catch { fail('MISSING_INPUT', 'Acquisition staging directory is missing'); }
    if (!stat!.isDirectory() || stat!.isSymbolicLink() || (process.getuid && stat!.uid !== process.getuid()) || (stat!.mode & 0o022) !== 0)
      fail('UNSAFE_PATH', 'Acquisition staging path has an unsafe ancestor');
  }
  const path = resolve(root, ...parts);
  if (!path.startsWith(`${root}${sep}`)) fail('UNSAFE_PATH', 'Staged archive escaped acquisition storage');
  const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow); }
  catch { fail('UNSAFE_PATH', 'Staged archive could not be opened without following links'); }
  try {
    const before = fs.fstatSync(fd!);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid()) ||
      before.size !== expectedBytes) fail('UNSAFE_PATH', 'Staged archive is not the bounded regular file in its receipt');
    const h256 = createHash('sha256'), h512 = createHash('sha512'), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      checkDeadline(deadline, signal);
      const count = fs.readSync(fd!, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > expectedBytes) fail('SNAPSHOT_RACE', 'Staged archive grew while it was verified');
      h256.update(buffer.subarray(0, count)); h512.update(buffer.subarray(0, count));
      checkDeadline(deadline, signal);
    }
    checkDeadline(deadline, signal);
    const after = fs.fstatSync(fd!);
    if (bytes !== expectedBytes || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.nlink !== after.nlink)
      fail('SNAPSHOT_RACE', 'Staged archive changed while it was verified');
    return { sha256: h256.digest('hex'), sha512: h512.digest('base64') };
  } finally { fs.closeSync(fd!); }
}

function integrityMatches(integrity: string | undefined, hashes: { sha256: string; sha512: string }): boolean {
  if (!integrity) return false;
  return integrity.split(/\s+/).some(value => value === `sha256:${hashes.sha256}` ||
    value === `sha256-${Buffer.from(hashes.sha256, 'hex').toString('base64')}` || value === `sha512-${hashes.sha512}`);
}

function closureIdentity(closure: Omit<DependencyClosure, 'closureHash'>): string { return sha256(canonical(closure)); }
function logicalInput(input: PreparationInput): string { return `${input.name}\0${input.version}`; }

function validateClosure(plan: PreparationPlan, admission: PreparationRuntimeAdmission, closure: DependencyClosure,
  cache: PublicArchiveCache, deadline: number, signal?: AbortSignal,
  materializationBase?: string): { mounts: CachedArchiveMount[]; materializedRoot?: string } {
  checkDeadline(deadline, signal);
  const runtime = admission.runtime, expectedPlanHash = planHash(plan);
  const { closureHash, ...closureBody } = closure ?? ({} as DependencyClosure);
  if (!closure || closure.schemaVersion !== 1 || closure.stack !== plan.stack || closure.planHash !== expectedPlanHash ||
    closure.catalogRevision !== admission.catalogRevision || closure.runtimeId !== runtime.id || closure.runtimeImage !== runtime.image ||
    closure.platform !== runtime.platform || !Array.isArray(closure.archives) || closure.archives.length > MAX_ARCHIVES || !SHA256.test(closureHash) ||
    closureHash !== closureIdentity(closureBody))
    fail('INCOMPATIBLE_INPUT', 'Dependency closure does not match the admitted plan and runtime');
  const publicInputs = plan.inputs.map((input, index) => ({ input, index })).filter(item => item.input.kind === 'public');
  if (publicInputs.length > MAX_ARCHIVES) fail('INSUFFICIENT_CAPACITY', 'Dependency closure exceeds the archive-count limit');
  const publicInputsByIndex = new Map(publicInputs.map(item => [item.index, item]));
  const covered = new Set<string>(), paths = new Set<string>(), pending: Array<{ archive: DependencyArchive; input: PreparationInput }> = [];
  for (const archive of closure.archives) {
    checkDeadline(deadline, signal);
    const selected = publicInputsByIndex.get(archive.inputIndex);
    if (!selected || archive.name !== selected.input.name || archive.version !== selected.input.version ||
      archive.declaredIntegrity !== (selected.input.integrity ?? 'registry-on-acquisition') || !SHA256.test(archive.sha256) ||
      !Number.isSafeInteger(archive.bytes) || archive.bytes < 0 || !plan.registryHosts.includes(archive.requestedHost))
      fail('INCOMPATIBLE_INPUT', 'Dependency closure contains an invalid public archive');
    relativeArchivePath(archive.installPath, 'Dependency install path');
    validateUrl(archive.requestedUrl, archive.requestedHost, plan.registryHosts);
    if (archive.resolvedUrl !== null) validateUrl(archive.resolvedUrl, new URL(archive.resolvedUrl).hostname, plan.registryHosts);
    if (paths.has(archive.installPath)) fail('INCOMPATIBLE_INPUT', 'Dependency closure contains colliding archive install paths');
    paths.add(archive.installPath); covered.add(logicalInput(selected.input));
    pending.push({ archive, input: selected.input });
  }
  for (const { input } of publicInputs) {
    checkDeadline(deadline, signal);
    if (!covered.has(logicalInput(input)))
      fail('MISSING_INPUT', `Dependency closure does not contain a compatible public archive for ${input.name}@${input.version}`);
  }
  if (!pending.length) return { mounts: [] };
  let base: string;
  if (materializationBase) {
    base = resolve(materializationBase);
    const stat = fs.lstatSync(base), real = fs.realpathSync(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== base || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0)
      fail('UNSAFE_PATH', 'Archive materialization root must be one private owned directory');
  } else base = tmpdir();
  const materializedRoot = fs.mkdtempSync(join(base, 'gstack-cso-archives-'));
  fs.chmodSync(materializedRoot, 0o700);
  try {
    checkDeadline(deadline, signal);
    const copies = cache.materialize(pending.map(item => item.archive.sha256), materializedRoot, { deadline, signal }),
      byDigest = new Map(copies.map(copy => [copy.sha256, copy]));
    const mounts = pending.map(({ archive }) => {
      checkDeadline(deadline, signal);
      const copy = byDigest.get(archive.sha256);
      if (!copy || copy.bytes !== archive.bytes) fail('MISSING_INPUT', `Verified public archive is missing from the offline cache: ${archive.name}@${archive.version}`);
      return { inputIndex: archive.inputIndex, name: archive.name, version: archive.version,
        declaredIntegrity: archive.declaredIntegrity, requestedUrl: archive.requestedUrl, resolvedUrl: archive.resolvedUrl, hostPath: copy.path,
        containerPath: `/archives/${archive.installPath}`, sha256: archive.sha256, bytes: archive.bytes };
    });
    return { mounts: mounts.sort((a, b) => a.containerPath.localeCompare(b.containerPath)), materializedRoot };
  } catch (error) {
    try { fs.rmSync(materializedRoot, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

type TreeEntry = { path: string; kind: 'file' | 'symlink'; mode: number; bytes: number; sha256: string };
function boundedTreeNames(directory: string, deadline: number, signal?: AbortSignal): string[] {
  checkDeadline(deadline, signal);
  const handle = fs.opendirSync(directory), names: string[] = [];
  try {
    for (;;) {
      checkDeadline(deadline, signal);
      const entry = handle.readSync();
      if (!entry) break;
      if (names.length >= MAX_TREE_FILES) fail('INSUFFICIENT_CAPACITY', 'Preparation directory exceeds its bounded manifest limit');
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  checkDeadline(deadline, signal);
  names.sort();
  checkDeadline(deadline, signal);
  return names;
}
function treeManifest(rootPath: string, maxBytes: number, deadline: number, allowContainedSymlinks = false,
  signal?: AbortSignal): TreeEntry[] {
  checkDeadline(deadline, signal);
  const root = resolve(rootPath);
  let rootStat: fs.Stats, canonicalRoot: string;
  try { rootStat = fs.lstatSync(root); canonicalRoot = fs.realpathSync(root); }
  catch { fail('MISSING_INPUT', 'Preparation source or output directory is missing'); }
  if (!rootStat!.isDirectory() || rootStat!.isSymbolicLink() || canonicalRoot! !== root ||
    (process.getuid && rootStat!.uid !== process.getuid()) || (rootStat!.mode & 0o022) !== 0)
    fail('UNSAFE_PATH', 'Preparation source or output must be one private real directory');
  const entries: TreeEntry[] = [];
  let total = 0, nodes = 0;
  const walk = (directory: string, prefix = ''): void => {
    checkDeadline(deadline, signal);
    const before = boundedTreeNames(directory, deadline, signal);
    for (const name of before) {
      checkDeadline(deadline, signal);
      const path = join(directory, name), relativePath = prefix ? `${prefix}/${name}` : name;
      nodes++;
      if (nodes > MAX_TREE_FILES || Buffer.byteLength(name) > 255 || Buffer.byteLength(relativePath) > 4096)
        fail('INSUFFICIENT_CAPACITY', 'Preparation tree exceeds its bounded manifest limit');
      const stat = fs.lstatSync(path);
      if (process.getuid && stat.uid !== process.getuid())
        fail('UNSAFE_PATH', `Preparation tree contains an unsafe object: ${relativePath}`);
      if (stat.isSymbolicLink()) {
        if (!allowContainedSymlinks) fail('UNSAFE_PATH', `Preparation tree contains an unsafe object: ${relativePath}`);
        const target = fs.readlinkSync(path);
        if (!target || isAbsolute(target) || target.includes('\0')) fail('UNSAFE_PATH', `Prepared dependency symlink is not relative: ${relativePath}`);
        const lexicalTarget = resolve(dirname(path), target);
        if (lexicalTarget !== root && !lexicalTarget.startsWith(`${root}${sep}`)) fail('UNSAFE_PATH', `Prepared dependency symlink escapes its execution copy: ${relativePath}`);
        let resolvedTarget: string, targetStat: fs.Stats;
        try { resolvedTarget = fs.realpathSync(path); targetStat = fs.statSync(path); }
        catch { fail('UNSAFE_PATH', `Prepared dependency symlink is dangling or cyclic: ${relativePath}`); }
        if (resolvedTarget! !== root && !resolvedTarget!.startsWith(`${root}${sep}`)) fail('UNSAFE_PATH', `Prepared dependency symlink escapes its execution copy: ${relativePath}`);
        if (!targetStat!.isFile() && !targetStat!.isDirectory()) fail('UNSAFE_PATH', `Prepared dependency symlink resolves to a special object: ${relativePath}`);
        const after = fs.lstatSync(path);
        if (!after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode ||
          after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || fs.readlinkSync(path) !== target)
          fail('SNAPSHOT_RACE', `Prepared dependency symlink changed while hashing: ${relativePath}`);
        entries.push({ path: relativePath, kind: 'symlink', mode: stat.mode & 0o777, bytes: Buffer.byteLength(target), sha256: sha256(`symlink\0${target}`) });
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) fail('UNSAFE_PATH', `Preparation tree contains an unsafe object: ${relativePath}`);
      if (stat.isDirectory()) { if ((stat.mode & 0o022) !== 0) fail('UNSAFE_PATH', 'Preparation tree contains a publicly writable directory'); walk(path, relativePath); continue; }
      if (stat.nlink !== 1) fail('UNSAFE_PATH', `Preparation tree contains a hard-linked file: ${relativePath}`);
      total += stat.size;
      if (total > maxBytes) fail('INSUFFICIENT_CAPACITY', 'Preparation tree exceeds its bounded manifest limit');
      const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
      let fd: number;
      try { fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow); } catch { fail('UNSAFE_PATH', 'Preparation file could not be opened without following links'); }
      try {
        const initial = fs.fstatSync(fd!), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
        let readBytes = 0;
        for (;;) { checkDeadline(deadline, signal); const count = fs.readSync(fd!, buffer, 0, buffer.length, null); if (!count) break; readBytes += count; hash.update(buffer.subarray(0, count)); checkDeadline(deadline, signal); }
        checkDeadline(deadline, signal);
        const final = fs.fstatSync(fd!);
        if (readBytes !== initial.size || initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size ||
          initial.mode !== final.mode || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs)
          fail('SNAPSHOT_RACE', `Preparation file changed while hashing: ${relativePath}`);
        entries.push({ path: relativePath, kind: 'file', mode: initial.mode & 0o777, bytes: initial.size, sha256: hash.digest('hex') });
      } finally { fs.closeSync(fd!); }
    }
    checkDeadline(deadline, signal);
    if (canonical(before) !== canonical(boundedTreeNames(directory, deadline, signal))) fail('SNAPSHOT_RACE', 'Preparation tree membership changed while hashing');
  };
  walk(root);
  return entries;
}
function treeHash(rootPath: string, maxBytes: number, deadline: number, allowContainedSymlinks = false,
  signal?: AbortSignal): string {
  return sha256(canonical(treeManifest(rootPath, maxBytes, deadline, allowContainedSymlinks, signal)));
}
function dependencyOutput(stack: CsoStack, path: string): boolean {
  const first = path.split('/')[0];
  if (stack === 'node') return first === 'node_modules' || first === '.cso-npm-cache';
  if (stack === 'bun') return first === 'node_modules' || first === '.cso-bun-cache';
  if (stack === 'python') return first === '.venv' || first === '.cso-uv-cache' || path === '.gstack-cso-public-requirements.txt';
  return path.startsWith('vendor/bundle/') || first === '.cso-bundle' || first === '.cso-gems';
}
function installedDependencyOutput(stack:CsoStack,path:string):boolean{
  const first=path.split('/')[0];return stack==='node'||stack==='bun'?first==='node_modules':stack==='python'?first==='.venv':path.startsWith('vendor/bundle/');
}
function preparedEnvironment(plan: PreparationPlan): Record<string, string> {
  if (plan.stack === 'python') return { PATH: '/work/.venv/bin:/usr/local/bin:/usr/bin:/bin', VIRTUAL_ENV: '/work/.venv', PYTHONNOUSERSITE: '1' };
  if (plan.stack !== 'rails') return { PATH: '/usr/local/bin:/usr/bin:/bin' };
  const dependencyKeys = new Set(['BUNDLE_PATH', 'BUNDLE_FROZEN', 'BUNDLE_DEPLOYMENT', 'BUNDLE_DISABLE_SHARED_GEMS',
    'BUNDLE_IGNORE_CONFIG', 'BUNDLE_ALLOW_OFFLINE_INSTALL', 'BUNDLE_CACHE_PATH', 'BUNDLE_USER_HOME', 'GEM_HOME', 'GEM_PATH']);
  const verifierOwnedKeys = new Set(['RAILS_ENV', 'RACK_ENV', 'SECRET_KEY_BASE']);
  const environment: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin' };
  for (const command of plan.offline) for (const [key, value] of Object.entries(command.env)) {
    if (verifierOwnedKeys.has(key)) continue;
    if (!dependencyKeys.has(key)) fail('INVALID_SCHEMA', `Rails preparation attempted to forward unsupported execution environment key ${key}`);
    if (environment[key] !== undefined && environment[key] !== value) fail('INVALID_SCHEMA', `Rails preparation commands disagree on ${key}`);
    environment[key] = value;
  }
  return environment;
}
function provePreparedProjection(snapshot: string, preparedRoot: string, stack: CsoStack,
  transformations: OfflinePreparationRequest['transformations'], deadline: number, signal?: AbortSignal): { hash: string; transformations: PreparedApplication['transformations']; manifestHash: string; dependencyHash:string } {
  const source = treeManifest(snapshot, MAX_SOURCE_BYTES, deadline, false, signal), prepared = treeManifest(preparedRoot, MAX_PREPARED_BYTES, deadline, true, signal),
    sourceByPath = new Map(source.map(entry => [entry.path, entry])), preparedByPath = new Map(prepared.map(entry => [entry.path, entry])),
    synthetic = new Map(transformations.map(item => [item.path, item]));
  if (synthetic.size !== transformations.length) fail('INVALID_SCHEMA', 'Offline preparation transformations contain duplicate paths');
  const actualTransformations: PreparedApplication['transformations'] = [];
  for (const entry of source) {
    checkDeadline(deadline, signal);
    const actual = preparedByPath.get(entry.path), transformed = synthetic.get(entry.path);
    if (!actual || actual.kind !== 'file') fail('ISOLATION_FAILED', `Offline lifecycle execution removed or replaced captured source: ${entry.path}`);
    if (transformed) {
      if (actual.sha256 !== transformed.sha256) fail('ISOLATION_FAILED', `Offline lifecycle execution changed a synthetic test transformation: ${entry.path}`);
    } else if (canonical(actual) !== canonical(entry)) fail('ISOLATION_FAILED', `Offline lifecycle execution changed captured source bytes or mode: ${entry.path}`);
  }
  for (const transformed of transformations) {
    checkDeadline(deadline, signal);
    const actual = preparedByPath.get(transformed.path);
    if (!actual || actual.kind !== 'file' || actual.sha256 !== transformed.sha256)
      fail('ISOLATION_FAILED', `Offline preparation did not preserve its declared transformation: ${transformed.path}`);
    actualTransformations.push({ path: transformed.path, sha256: transformed.sha256, mode: actual.mode, reason: transformed.reason });
  }
  for (const entry of prepared) {
    checkDeadline(deadline, signal);
    if (sourceByPath.has(entry.path) || synthetic.has(entry.path) || dependencyOutput(stack, entry.path)) continue;
    fail('ISOLATION_FAILED', `Offline lifecycle execution wrote outside its dependency roots: ${entry.path}`);
  }
  actualTransformations.sort((a, b) => a.path.localeCompare(b.path));
  return { hash: sha256(canonical({ source, transformations: actualTransformations })), transformations: actualTransformations,
    manifestHash: sha256(canonical(prepared)), dependencyHash:sha256(canonical(prepared.filter(entry=>installedDependencyOutput(stack,entry.path)))) };
}

function validateAcquisitionReceipt(receipt: AcquisitionReceipt, request: PreparationAcquireRequest, plan: PreparationPlan): void {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.planHash !== request.planHash || receipt.runtimeId !== request.runtime.id ||
    receipt.runtimeImage !== request.runtime.image || receipt.platform !== request.runtime.platform || receipt.deadlineEnforced !== true ||
    receipt.lifecycleScriptsExecuted !== false || receipt.targetCodeExecuted !== false)
    fail('TOOL_FAILED', 'Acquisition receipt does not bind the admitted plan and runtime');
  const network = receipt.network;
  if (!network || network.mode !== 'registry-restricted' || !sameStrings(network.allowedHosts, plan.registryHosts) ||
    !Array.isArray(network.contactedHosts) || network.contactedHosts.some(host => !plan.registryHosts.includes(host)) ||
    new Set(network.contactedHosts).size !== network.contactedHosts.length || network.dnsRebindingBlocked !== true ||
    network.credentialsMounted !== false || network.sourceMounted !== false || network.dockerSocketMounted !== false ||
    network.redirectVisibility !== 'opaque-tls')
    fail('ISOLATION_FAILED', 'Acquisition network receipt did not prove registry-restricted, credential-free execution');
  validateCommandReceipts(receipt.commands, plan.acquisition);
}

function validateOfflineReceipt(receipt: OfflinePreparationReceipt, request: OfflinePreparationRequest): void {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.planHash !== request.planHash || receipt.runtimeId !== request.runtime.id ||
    receipt.runtimeImage !== request.runtime.image || receipt.platform !== request.runtime.platform || receipt.sourceHash !== request.sourceHash ||
    receipt.dependencyClosureHash !== request.dependencyClosureHash || receipt.configurationHash !== request.configurationHash ||
    receipt.databaseHash !== request.databaseHash || request.databaseHash !== sha256(canonical(request.database ?? null)) ||
    receipt.deadlineEnforced !== true || receipt.inputSourceReadOnly !== true || receipt.preparedCopySeparate !== true ||
    receipt.archivesReadOnly !== true || receipt.applicationCodeExecutedOnlyOffline !== true)
    fail('TOOL_FAILED', 'Offline preparation receipt does not bind its immutable inputs');
  const expectedServices: Array<'application' | 'postgresql'> = ['application'];
  const network = receipt.network;
  if (!network || network.mode !== 'none' || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(network.namespaceAnchor) ||
    network.externalEgress !== false || network.dnsAvailable !== false || network.publishedPorts !== false ||
    !sameStrings(network.services, expectedServices)) fail('ISOLATION_FAILED', 'Offline preparation did not remain in the shared no-egress loopback namespace');
  validateCommandReceipts(receipt.commands, request.commands);
}
function offlineReceiptIdentity(receipt: OfflinePreparationReceipt): string {
  return sha256(canonical({ ...receipt, network: { ...receipt.network, namespaceAnchor: '<run-owned-network-namespace>' } }));
}

export class PreparationExecutor {
  constructor(private readonly options: { cache: PublicArchiveCache; runner: PreparationSandboxRunner; materializationRoot?: string }) {
    if (!options?.cache || !options?.runner) fail('INVALID_ARGUMENT', 'Preparation executor requires a cache and qualified runner');
  }

  async acquire(options: {
    plan: PreparationPlan;
    admission: PreparationRuntimeAdmission;
    snapshot: string;
    deadline: number;
    signal?: AbortSignal;
    offline?: boolean;
    existingClosure?: DependencyClosure;
  }): Promise<DependencyClosure> {
    checkDeadline(options.deadline, options.signal);
    const hash = validatePlan(options.plan, options.snapshot), runtime = runtimeFromAdmission(options.plan, options.admission);
    checkDeadline(options.deadline, options.signal);
    validateRunner(this.options.runner, options.plan.stack);
    if (options.existingClosure) {
      const verified = validateClosure(options.plan, options.admission, options.existingClosure, this.options.cache,
        options.deadline, options.signal, this.options.materializationRoot);
      if (verified.materializedRoot) fs.rmSync(verified.materializedRoot, { recursive: true, force: true });
      return options.existingClosure;
    }
    const publicInputs = options.plan.inputs.map((input, index) => ({ input, index })).filter(item => item.input.kind === 'public');
    if (publicInputs.length > MAX_ARCHIVES) fail('INSUFFICIENT_CAPACITY', 'Preparation plan exceeds the archive-count limit');
    const publicInputsByIndex = new Map(publicInputs.map(item => [item.index, item]));
    if (options.offline && publicInputs.length) fail('MISSING_INPUT', 'Offline preparation requires a matching retained dependency closure and verified cache entries');
    if (!publicInputs.length) {
      const body: Omit<DependencyClosure, 'closureHash'> = { schemaVersion: 1, stack: options.plan.stack, planHash: hash,
        catalogRevision: options.admission.catalogRevision, runtimeId: runtime.id, runtimeImage: runtime.image, platform: runtime.platform,
        archives: [], acquisitionReceiptHash: null };
      return Object.freeze({ ...body, closureHash: closureIdentity(body) });
    }
    const acquisitionStaging = fs.mkdtempSync(join(this.options.cache.stagingRoot, 'acquire-'));
    fs.chmodSync(acquisitionStaging, 0o700);
    const stagingIdentity = fs.lstatSync(acquisitionStaging);
    const request: PreparationAcquireRequest = {
      schemaVersion: 1, planHash: hash, stack: options.plan.stack,
      runtime: { id: runtime.id, image: runtime.image, platform: runtime.platform }, metadata: structuredClone(options.plan.metadata),
      inputs: structuredClone(publicInputs), commands: structuredClone(options.plan.acquisition), stagingRoot: acquisitionStaging,
      deadline: options.deadline, limits: { maxArchives: MAX_ARCHIVES,
        maxArchiveBytes: Math.min(this.options.cache.maxEntryBytes, MAX_ACQUISITION_ARCHIVE_BYTES),
        maxTotalArchiveBytes: Math.min(this.options.cache.maxBytes, MAX_ACQUISITION_ARCHIVE_BYTES), maxOutputBytes: MAX_OUTPUT },
      network: { mode: 'registry-restricted', allowedHosts: [...options.plan.registryHosts] }, sourceMounted: false,
    };
    try {
    const receipt = await this.options.runner.acquire(deepFreeze(request));
    checkDeadline(options.deadline, options.signal);
    validateAcquisitionReceipt(receipt, request, options.plan);
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > request.limits.maxArchives)
      fail('TOOL_FAILED', 'Acquisition receipt contains an invalid number of archives');
    const archives: DependencyArchive[] = [], seenInputs = new Set<number>(), seenPaths = new Set<string>(), seenStagingPaths = new Set<string>(),
      uniqueBytes = new Map<string, number>(), validated: Array<{ artifact: AcquisitionArtifactReceipt; selected: typeof publicInputs[number] }> = [];
    let totalUniqueBytes = 0;
    for (const artifact of receipt.artifacts) {
      checkDeadline(options.deadline, options.signal);
      const selected = publicInputsByIndex.get(artifact.inputIndex);
      if (!selected || seenInputs.has(artifact.inputIndex) || !SHA256.test(artifact.sha256) || artifact.registryResponseSha256 !== artifact.sha256 ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > this.options.cache.maxEntryBytes ||
        !options.plan.registryHosts.includes(artifact.requestedHost) || !receipt.network.contactedHosts.includes(artifact.requestedHost))
        fail('TOOL_FAILED', 'Acquisition artifact is not a unique bounded public dependency');
      seenInputs.add(artifact.inputIndex);
      relativeArchivePath(artifact.stagingPath, 'Staged archive'); relativeArchivePath(artifact.installPath, 'Dependency install path');
      if (seenPaths.has(artifact.installPath) || seenStagingPaths.has(artifact.stagingPath)) fail('TOOL_FAILED', 'Acquisition artifact paths collide');
      seenPaths.add(artifact.installPath); seenStagingPaths.add(artifact.stagingPath);
      validateUrl(artifact.requestedUrl, artifact.requestedHost, options.plan.registryHosts);
      if (artifact.resolvedUrl !== null) {
        let resolvedHost = ''; try { resolvedHost = new URL(artifact.resolvedUrl).hostname; } catch {}
        validateUrl(artifact.resolvedUrl, resolvedHost, options.plan.registryHosts);
        if (!receipt.network.contactedHosts.includes(resolvedHost)) fail('TOOL_FAILED', 'Direct archive response host was not contacted through the registry broker');
      }
      if (selected.input.url && artifact.requestedUrl !== selected.input.url) fail('TOOL_FAILED', 'Acquired archive request URL does not match its lockfile URL');
      const hashes = stagedFileHashes(request.stagingRoot, artifact.stagingPath, artifact.bytes, options.deadline, options.signal);
      if (hashes.sha256 !== artifact.sha256 || (selected.input.integritySource === 'lock' && !integrityMatches(selected.input.integrity, hashes)) ||
        (selected.input.integritySource !== 'lock' && selected.input.integritySource !== 'registry-on-acquisition'))
        fail('INCOMPATIBLE_INPUT', `Acquired archive failed lock/registry integrity verification: ${selected.input.name}@${selected.input.version}`);
      const priorBytes = uniqueBytes.get(artifact.sha256);
      if (priorBytes !== undefined && priorBytes !== artifact.bytes) fail('TOOL_FAILED', 'One acquisition digest was reported with inconsistent sizes');
      if (priorBytes === undefined) { uniqueBytes.set(artifact.sha256, artifact.bytes); totalUniqueBytes += artifact.bytes; }
      if (totalUniqueBytes > request.limits.maxTotalArchiveBytes)
        fail('INSUFFICIENT_CAPACITY', 'Acquisition archives exceed the immutable-cache byte ceiling');
      validated.push({ artifact, selected });
    }
    // No cache mutation occurs until the complete receipt, every staged byte,
    // and the aggregate unique-byte ceiling have been validated.
    try {
      for (const { artifact, selected } of validated) {
        checkDeadline(options.deadline, options.signal);
        const absoluteStaged = resolve(request.stagingRoot, ...artifact.stagingPath.split('/'));
        const cacheRelative = relative(this.options.cache.stagingRoot, absoluteStaged).split(sep).join('/');
        const cached = this.options.cache.promote(cacheRelative, artifact.sha256, { deadline: options.deadline, signal: options.signal });
        archives.push({ inputIndex: artifact.inputIndex, name: selected.input.name, version: selected.input.version,
          installPath: artifact.installPath, sha256: cached.sha256, bytes: cached.bytes, requestedHost: artifact.requestedHost,
          requestedUrl: artifact.requestedUrl, resolvedUrl: artifact.resolvedUrl,
          declaredIntegrity: selected.input.integrity ?? 'registry-on-acquisition' });
      }
    } finally {
      for (const { artifact } of validated) if (artifact.stagingPath.startsWith('cso-public/')) {
        const path = resolve(request.stagingRoot, ...artifact.stagingPath.split('/'));
        try { const stat = fs.lstatSync(path); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (process.getuid ? stat.uid === process.getuid() : true)) fs.unlinkSync(path); } catch {}
      }
    }
    const covered = new Set(archives.map(archive => logicalInput(options.plan.inputs[archive.inputIndex])));
    for (const { input } of publicInputs) {
      checkDeadline(options.deadline, options.signal);
      if (!covered.has(logicalInput(input))) fail('MISSING_INPUT', `Acquisition did not produce a compatible archive for ${input.name}@${input.version}`);
    }
    checkDeadline(options.deadline, options.signal);
    archives.sort((a, b) => a.installPath.localeCompare(b.installPath));
    const body: Omit<DependencyClosure, 'closureHash'> = { schemaVersion: 1, stack: options.plan.stack, planHash: hash,
      catalogRevision: options.admission.catalogRevision, runtimeId: runtime.id, runtimeImage: runtime.image, platform: runtime.platform,
      archives, acquisitionReceiptHash: sha256(canonical(receipt)) };
    return Object.freeze({ ...body, closureHash: closureIdentity(body) });
    } finally {
      let current: fs.Stats | undefined;
      try { current = fs.lstatSync(acquisitionStaging); } catch {}
      if (current && (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stagingIdentity.dev || current.ino !== stagingIdentity.ino))
        fail('SNAPSHOT_RACE', 'Run-private acquisition staging was replaced before cleanup');
      if (current) fs.rmSync(acquisitionStaging, { recursive: true, force: false });
    }
  }

  async prepareOffline(options: {
    plan: PreparationPlan;
    admission: PreparationRuntimeAdmission;
    snapshot: string;
    closure: DependencyClosure;
    deadline: number;
    signal?: AbortSignal;
    database?: RailsDatabaseSelection;
  }): Promise<PreparedApplication> {
    checkDeadline(options.deadline, options.signal);
    const hash = validatePlan(options.plan, options.snapshot), runtime = runtimeFromAdmission(options.plan, options.admission);
    checkDeadline(options.deadline, options.signal);
    validateRunner(this.options.runner, options.plan.stack);
    const materialized = validateClosure(options.plan, options.admission, options.closure, this.options.cache,
      options.deadline, options.signal, this.options.materializationRoot),
      archives = materialized.mounts;
    let database: OfflinePreparationRequest['database'];
    let synthetic: Array<{ path: string; content: string }> = [];
    if (options.plan.stack === 'rails') {
      if (!options.database) fail('INVALID_ARGUMENT', 'Rails offline preparation requires an explicit SQLite or PostgreSQL selection');
      if (!options.plan.database?.supported.includes(options.database.adapter)) fail('PREREQUISITE', `Rails ${options.database.adapter} preparation is not supported by this plan`);
      synthetic = railsTestConfiguration(options.plan.database.connections, options.database.adapter);
      if (options.database.adapter === 'postgresql') {
        const sidecar = options.database.sidecar;
        if (!sidecar || !admittedRuntimes.has(sidecar) || sidecar.runtime.stack !== 'postgresql' ||
          sidecar.runtime.platform !== runtime.platform || sidecar.catalogRevision !== options.admission.catalogRevision)
          fail('PREREQUISITE', 'Rails PostgreSQL preparation requires a qualified same-platform sidecar from the same catalog');
        database = { adapter: 'postgresql', connections: [...options.plan.database.connections],
          sidecar: { id: sidecar.runtime.id, image: sidecar.runtime.image } };
      } else database = { adapter: 'sqlite', connections: [...options.plan.database.connections] };
    } else if (options.database) fail('INVALID_ARGUMENT', 'Database preparation is only valid for Rails');
    const transformations = synthetic.map(file => ({ ...file, sha256: sha256(file.content), reason: 'Synthetic isolated Rails test configuration' }));
    const configurationHash = sha256(canonical(transformations)), databaseHash = sha256(canonical(database ?? null));
    const sourceHash = treeHash(options.snapshot, MAX_SOURCE_BYTES, options.deadline, false, options.signal);
    const request: OfflinePreparationRequest = {
      schemaVersion: 1, planHash: hash, stack: options.plan.stack,
      runtime: { id: runtime.id, image: runtime.image, platform: runtime.platform }, sourceRoot: resolve(options.snapshot), sourceHash,
      metadata: structuredClone(options.plan.metadata), dependencyClosureHash: options.closure.closureHash,
      commands: structuredClone(options.plan.offline), archives,
      transformations, configurationHash, database, databaseHash, deadline: options.deadline,
      limits: { cpus: 2, memoryBytes: 4 * 1024 * 1024 * 1024, pids: 256, writableBytes: MAX_PREPARED_BYTES, maxOutputBytes: MAX_OUTPUT },
      network: { mode: 'none', sharedLoopbackNamespace: true, publishedPorts: false }, inputSourceReadOnly: true, archivesReadOnly: true,
    };
    let returnedPreparedRoot: string | undefined, completed = false;
    try {
      const result = await this.options.runner.prepareOffline(deepFreeze(request));
      returnedPreparedRoot = typeof result?.preparedRoot === 'string' ? result.preparedRoot : undefined;
      checkDeadline(options.deadline, options.signal);
      validateOfflineReceipt(result?.receipt, request);
      const preparedRoot = resolve(result.preparedRoot);
      const sourceRoot = resolve(options.snapshot);
      if (preparedRoot === sourceRoot || preparedRoot.startsWith(`${sourceRoot}${sep}`) || sourceRoot.startsWith(`${preparedRoot}${sep}`) ||
        preparedRoot === this.options.cache.root || preparedRoot.startsWith(`${this.options.cache.root}${sep}`))
        fail('UNSAFE_PATH', 'Prepared application must be a separate disposable copy outside cache and source roots');
      const projection = provePreparedProjection(options.snapshot, preparedRoot, options.plan.stack, request.transformations, options.deadline, options.signal),
        preparedManifestHash = projection.manifestHash,preparedDependencyHash=projection.dependencyHash;
      if (treeHash(options.snapshot, MAX_SOURCE_BYTES, options.deadline, false, options.signal) !== sourceHash)
        fail('SNAPSHOT_RACE', 'Offline preparation changed its read-only input source');
      completed = true;
      return Object.freeze({ schemaVersion: 1 as const, stack: options.plan.stack, preparedRoot, sourceHash, preparedManifestHash,preparedDependencyHash,
        dependencyClosureHash: options.closure.closureHash, configurationHash, databaseHash, database,
        sourceProjectionHash: projection.hash,
        transformations: projection.transformations, executionEnvironment: Object.freeze(preparedEnvironment(options.plan)),
        receiptHash: offlineReceiptIdentity(result.receipt), receipt: result.receipt });
    } catch (error) {
      if (!completed && returnedPreparedRoot) {
        try { await this.options.runner.disposePrepared(returnedPreparedRoot); }
        catch { fail('PERSISTENCE_FAILED', 'Invalid prepared execution copy could not be disposed safely'); }
      }
      throw error;
    } finally {
      if (materialized.materializedRoot) fs.rmSync(materialized.materializedRoot, { recursive: true, force: true });
    }
  }

  async dispose(prepared: PreparedApplication): Promise<void> {
    if (!prepared || prepared.schemaVersion !== 1 || typeof prepared.preparedRoot !== 'string')
      fail('INVALID_ARGUMENT', 'Prepared application handle is invalid');
    await this.options.runner.disposePrepared(prepared.preparedRoot);
  }
}
