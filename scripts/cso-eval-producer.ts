#!/usr/bin/env bun
/** Generic producer runner. Compile this file before moving it to a clean producer host. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readBoundedStable } from '../lib/cso/bounded-file';
import { CsoError } from '../lib/cso/contracts';
import { executable, redact } from '../lib/cso/process';
import { atomicWriteSync } from '../lib/fs-atomic';
import { resolveClaudeCommand } from '../lib/claude-bin';
import runtimeCatalog from '../lib/cso/runtime-catalog.json';
import scannerCatalog from '../lib/cso/scanner-images/catalog.json';
import { ClaudeAdapter } from '../test/helpers/providers/claude';
import { GptAdapter } from '../test/helpers/providers/gpt';
import { GeminiAdapter, prepareGeminiProducerState, removeGeminiProducerState } from '../test/helpers/providers/gemini';
import { PRICING } from '../test/helpers/pricing';
import type { ProviderAdapter, RunOpts, RunResult } from '../test/helpers/providers/types';
import {
  PRODUCER_PLATFORMS,
  producerHostPlatform,
  producerInputHash,
  producerArtifactInventoryHash,
  producerInstallationIdentityHash,
  producerProviderIdentityHash,
  producerReceiptHash,
  sha256,
  type ProducerExecution,
  type ProducerHost,
  type ProducerInput,
  type ProducerArtifactInventory,
  type ProducerInstallationIdentity,
  type ProducerProviderIdentity,
  type ProducerReceipt,
  type ProducerSourceEntry,
} from './cso-eval-protocol';

const HEX = /^[a-f0-9]{64}$/;
const GENERATION_MANIFEST_BYTES = 65;
const INPUT_LIMIT = 4 * 1024 * 1024;
const OUTPUT_LIMIT = 32 * 1024 * 1024;
const ARTIFACT_FILE_LIMIT = 32 * 1024 * 1024;
const ARTIFACT_TOTAL_LIMIT = 128 * 1024 * 1024;
const ARTIFACT_COUNT_LIMIT = 4096;
/**
 * `/cso --budget` bounds the helper run: it accepts evidence until its deadline (start + budget) and `finish` writes the
 * report after it. A user's agent is never killed at the budget, so the provider gets the budget, the agent's time
 * before `start`, and the reporting time after the deadline. Matches the evaluator's frozen `graceSeconds`.
 */
export const PRODUCER_REPORTING_GRACE_SECONDS = 300;

export function producerProviderTimeoutMs(budgetSeconds: number): number {
  return (budgetSeconds + PRODUCER_REPORTING_GRACE_SECONDS) * 1000;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function sourceError(path: string, rule: string): Error {
  return new Error(`INVALID_PRODUCER_SOURCE: ${JSON.stringify(path.length > 200 ? `${path.slice(0, 200)}...` : path)} ${rule}`);
}

function regularFile(path: string, relativePath: string): fs.Stats {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw sourceError(relativePath, 'is not a regular file');
  if (stat.nlink !== 1) throw sourceError(relativePath, `has ${stat.nlink} hard links; expected 1`);
  return stat;
}

function safeDirectory(path: string): void {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(path) !== path) throw new Error('NON_ISOLATED_PRODUCER_LAYOUT');
}

function assertIsolatedLayout(controlPath: string, receiptPath: string): { jobRoot: string; sourceRoot: string } {
  const jobRoot = dirname(controlPath), producerRoot = dirname(jobRoot), sourceRoot = join(jobRoot, 'source');
  safeDirectory(producerRoot); safeDirectory(jobRoot); safeDirectory(sourceRoot);
  if (basename(jobRoot) !== 'job' || basename(controlPath) !== 'producer-input.json') throw new Error('NON_ISOLATED_PRODUCER_LAYOUT');
  if (JSON.stringify(fs.readdirSync(producerRoot).sort()) !== JSON.stringify(['job'])) throw new Error('NON_ISOLATED_PRODUCER_LAYOUT');
  if (JSON.stringify(fs.readdirSync(jobRoot).sort()) !== JSON.stringify(['producer-input.json', 'source'])) throw new Error('NON_ISOLATED_PRODUCER_LAYOUT');
  if (inside(producerRoot, receiptPath)) throw new Error('NON_ISOLATED_PRODUCER_LAYOUT');
  return { jobRoot, sourceRoot };
}

function assertReceiptDestination(path: string): void {
  const parent = dirname(path), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent || fs.existsSync(path)) throw new Error('UNSAFE_RECEIPT_DESTINATION');
}

function walk(root: string, directory = root): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(directory, entry.name), relativePath = relative(root, full).split(sep).join('/');
    if (directory === root && entry.name === '.git') {
      if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(join(root, '.git')) !== join(root, '.git')) throw sourceError('.git', 'is not a real directory');
      continue;
    }
    if (entry.isSymbolicLink()) throw sourceError(relativePath, 'is a symbolic link');
    if (entry.isDirectory()) output.push(...walk(root, full));
    else if (entry.isFile()) output.push(relativePath);
    else throw sourceError(relativePath, 'is not a regular file or directory');
  }
  return output.sort();
}

function validateSource(root: string, entries: ProducerSourceEntry[], expectedHash: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(entry.path) || !HEX.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('INVALID_PRODUCER_INPUT');
    seen.add(entry.path);
  }
  const actualPaths = walk(root), actual = new Set(actualPaths);
  const expectedPaths = entries.map(entry => entry.path).sort(), expected = new Set(expectedPaths);
  const firstMismatch = [
    ...actualPaths.filter(path => !expected.has(path)).map(path => [path, 'is not in the expected source listing']),
    ...expectedPaths.filter(path => !actual.has(path)).map(path => [path, 'is missing from the source']),
  ].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0];
  if (firstMismatch) throw sourceError(firstMismatch[0], firstMismatch[1]);
  const hashed: Array<[string, string]> = [];
  for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const path = resolve(root, ...entry.path.split('/'));
    if (!inside(root, path)) throw sourceError(entry.path, 'resolves outside the source root');
    const stat = regularFile(path, entry.path);
    const contents = readBoundedStable(path, 2 * 1024 * 1024, 'Producer source file');
    if (stat.size !== entry.bytes || contents.byteLength !== entry.bytes) throw sourceError(entry.path, `is ${contents.byteLength} bytes; expected ${entry.bytes}`);
    if (sha256(contents) !== entry.sha256) throw sourceError(entry.path, 'does not match its expected sha256');
    hashed.push([entry.path, entry.sha256]);
  }
  if (sha256(JSON.stringify(hashed)) !== expectedHash) throw sourceError('.', 'listing does not match the cell sourceHash');
}

/** Seal the one-cell source copy before a provider starts. Production producers are macOS/Linux only. */
export function sealProducerSource(root: string): void {
  if (process.platform === 'win32') return;
  const directories: string[] = [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw sourceError(relative(root, directory) || '.', 'is not a real directory');
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw sourceError(relative(root, full), 'is a symbolic link');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
      else throw sourceError(relative(root, full), 'is not a regular file or directory');
    }
  };
  visit(root);
  for (const file of files) fs.chmodSync(file, 0o444);
  // Children first so traversal stays available while modes are changed.
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o555);
  assertProducerSourceSealed(root);
}

export function assertProducerSourceSealed(root: string): void {
  if (process.platform === 'win32') return;
  const visit = (directory: string): void => {
    const modeError = (path: string, rule: string) => new Error(`PRODUCER_CHANGED_SOURCE_MODE: ${JSON.stringify(relative(root, path) || '.')} ${rule}`);
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw modeError(directory, 'is not a real directory');
    if ((directoryStat.mode & 0o777) !== 0o555) throw modeError(directory, `has mode ${(directoryStat.mode & 0o777).toString(8)}; expected 555`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name), stat = fs.lstatSync(full);
      if (entry.isSymbolicLink()) throw modeError(full, 'is a symbolic link');
      if (entry.isDirectory()) visit(full);
      else if (!entry.isFile()) throw modeError(full, 'is not a regular file or directory');
      else if ((stat.mode & 0o777) !== 0o444) throw modeError(full, `has mode ${(stat.mode & 0o777).toString(8)}; expected 444`);
    }
  };
  visit(root);
}

function emptyArtifactInventory(): ProducerArtifactInventory {
  const base = { schemaVersion: 1 as const, root: 'security/cso' as const, entries: [], totalBytes: 0 };
  return { ...base, identityHash: producerArtifactInventoryHash(base) };
}

/** A whole path component that is one of the helper's own identifiers: `<epoch ms>-<hex>` run and replay IDs, retired runs, and hex artifact IDs with an optional lowercase-word prefix (`gitleaks-<hex>-<hex>.json`). */
const HELPER_ID_COMPONENT = /^(?:\d{13}-[a-f0-9]{16}|\.retired-\d{13}-[a-f0-9]{16}-[a-f0-9]{32}|(?:[a-z]+-)*[a-f0-9]{16,64}(?:-[a-f0-9]{16})*(?:\.[a-z]+)?)$/;

/**
 * Helper artifact paths are `<repoId>/<runId>/...` plus the helper's public-cache/ and legacy-imports/. Components that
 * are wholly a helper identifier are checked by shape, because the secret redactor reads them as data (a 13-digit epoch
 * as a phone number, some 32-hex IDs as wallets). Every other component (fixed helper names, and source paths mirrored
 * under snapshot/ and readable/) still goes through the redactor.
 */
export function assertProducerArtifactPath(relativePath: string): void {
  const parts = relativePath.split('/');
  const reject = (rule: string): never => { throw new Error(`INVALID_PRODUCER_ARTIFACTS: ${rule}`); };
  if (!relativePath || relativePath.length > 1024) reject('an artifact path is empty or longer than 1024 bytes');
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath) || parts.some(part => !part || part === '.' || part === '..')) reject('an artifact path has a component outside [A-Za-z0-9._-]');
  const inRun = /^[a-f0-9]{24}$/.test(parts[0]) && /^(?:\d{13}-[a-f0-9]{16}|\.retired-\d{13}-[a-f0-9]{16}-[a-f0-9]{32})$/.test(parts[1] ?? '');
  if (parts.length < 2 || !(inRun ? parts.length >= 3 : ['public-cache', 'legacy-imports'].includes(parts[0]))) reject('an artifact lies outside <repoId>/<runId>/, public-cache/ and legacy-imports/');
  const schemaId = (part: string, index: number) => index === 0 ? /^[a-f0-9]{24}$/.test(part) : HELPER_ID_COMPONENT.test(part);
  for (const [index, part] of parts.entries()) {
    if (schemaId(part, index)) continue;
    let clean: boolean;
    try { clean = redact(part) === part; } catch { clean = false; }
    if (!clean) {
      const parent = parts.slice(0, index).map((item, at) => schemaId(item, at) ? 'ID' : item).join('/');
      throw new CsoError('REDACTION_FAILED', `artifact path component ${index + 1} under ${JSON.stringify(parent)} looks like a secret; the component is withheld`);
    }
  }
}

export function inventoryProducerArtifacts(helperHome: string): ProducerArtifactInventory {
  const security = join(helperHome, 'security'), artifactRoot = join(security, 'cso');
  for (const directory of [security, artifactRoot]) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyArtifactInventory(); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('INVALID_PRODUCER_ARTIFACTS');
  }
  const entries: ProducerSourceEntry[] = [];
  let totalBytes = 0, visited = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 32 || ++visited > ARTIFACT_COUNT_LIMIT * 2) throw new Error('INVALID_PRODUCER_ARTIFACTS');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(directory, entry.name);
      if (++visited > ARTIFACT_COUNT_LIMIT * 2) throw new Error('INVALID_PRODUCER_ARTIFACTS');
      if (entry.isSymbolicLink()) throw new Error('INVALID_PRODUCER_ARTIFACTS');
      if (entry.isDirectory()) { visit(full, depth + 1); continue; }
      if (!entry.isFile() || entries.length >= ARTIFACT_COUNT_LIMIT) throw new Error('INVALID_PRODUCER_ARTIFACTS');
      const relativePath = relative(artifactRoot, full).split(sep).join('/');
      assertProducerArtifactPath(relativePath);
      const contents = readBoundedStable(full, ARTIFACT_FILE_LIMIT, 'Producer artifact');
      totalBytes += contents.byteLength;
      if (totalBytes > ARTIFACT_TOTAL_LIMIT) throw new Error('PRODUCER_ARTIFACTS_TOO_LARGE');
      entries.push({ path: relativePath, sha256: sha256(contents), bytes: contents.byteLength });
    }
  };
  visit(artifactRoot, 0);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const base = { schemaVersion: 1 as const, root: 'security/cso' as const, entries, totalBytes };
  return { ...base, identityHash: producerArtifactInventoryHash(base) };
}

function repositoryIdentity(root: string): string {
  const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullPath, GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
  const git = executable('git');
  const config = readBoundedStable(join(root, '.git', 'config'), 1024 * 1024, 'Producer Git configuration').toString('utf8');
  if (/^\s*\[\s*include(?:if)?(?=[\s."\]])/im.test(config)) throw sourceError('.git/config', 'contains an include directive');
  const common = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', `core.hooksPath=${nullPath}`, '-c', `core.attributesFile=${nullPath}`, '-c', `core.excludesFile=${nullPath}`, '-c', 'core.pager=cat', '-C', root];
  const read = (args: string[]) => execFileSync(git, [...common, ...args], { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  return sha256(JSON.stringify({ config: sha256(config), head: read(['rev-parse', '--verify', 'HEAD']).trim(), branch: read(['symbolic-ref', '--short', 'HEAD']).trim(), status: read(['status', '--porcelain=v2', '--untracked-files=all']) }));
}

const INPUT_FIELDS = 'cellRef,execution,schemaVersion,skill,source';
const EXECUTION_FIELDS = 'budgetSeconds,host,mode,model,skillHash,sourceHash';
/** The input has exactly the opaque fields: no case, variant, version, or repetition can ride along. */
function validateInput(input: ProducerInput): void {
  const execution = input?.execution;
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== INPUT_FIELDS || input.schemaVersion !== 2 || !HEX.test(input.cellRef) ||
      typeof input.skill !== 'string' || Buffer.byteLength(input.skill) > INPUT_LIMIT || !Array.isArray(input.source) ||
      !execution || typeof execution !== 'object' || Object.keys(execution).filter(key => key !== 'platform').sort().join(',') !== EXECUTION_FIELDS ||
      !['daily', 'comprehensive'].includes(execution.mode) || typeof execution.model !== 'string' || !execution.model || !['claude', 'codex', 'gemini'].includes(execution.host) ||
      !Number.isInteger(execution.budgetSeconds) || execution.budgetSeconds <= 60 || execution.budgetSeconds > 3600 || !HEX.test(execution.sourceHash) || !HEX.test(execution.skillHash) ||
      ('platform' in execution && !PRODUCER_PLATFORMS.includes(execution.platform!))) throw new Error('INVALID_PRODUCER_INPUT');
  if (execution.platform !== undefined && execution.platform !== producerHostPlatform()) throw new Error('UNMATCHED_PRODUCER_PLATFORM');
}

export interface ProducerHelperBinding {
  producer: string;
  launcher: string;
  core: string;
  watchdog: string;
  generation: string;
}

function boundExecutable(path: string): void {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(path) !== path ||
      (process.platform !== 'win32' && ((stat.mode & 0o111) === 0 || (stat.mode & 0o6000) !== 0))) throw new Error('INVALID_PRODUCER_HELPER');
}

function readGenerationManifest(path: string): string {
  const bytes = readBoundedStable(path, GENERATION_MANIFEST_BYTES, 'Producer helper generation manifest');
  const value = bytes.toString('utf8');
  if (bytes.byteLength !== GENERATION_MANIFEST_BYTES || !/^[a-f0-9]{64}\n$/.test(value)) {
    throw new Error('INVALID_PRODUCER_GENERATION');
  }
  return value.slice(0, -1);
}

function boundGenerationManifest(path: string): void {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(path) !== path ||
      stat.size !== GENERATION_MANIFEST_BYTES || (process.platform !== 'win32' && ((stat.mode & 0o444) === 0 || (stat.mode & 0o6111) !== 0))) {
    throw new Error('INVALID_PRODUCER_HELPER');
  }
  readGenerationManifest(path);
}

function writableByProducer(path: string): boolean {
  try { fs.accessSync(path, fs.constants.W_OK); return true; }
  catch { return false; }
}

/** Production bundles must remain immutable to the unprivileged producing agent. */
export function validateProductionProducerInstallation(binding: ProducerHelperBinding, producerExecutable = process.execPath): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('ROOT_PRODUCER_UNSUPPORTED');
  if (producerExecutable !== binding.producer || !isAbsolute(producerExecutable) || resolve(producerExecutable) !== producerExecutable || dirname(producerExecutable) !== dirname(binding.launcher)) {
    throw new Error('INVALID_PRODUCER_HELPER');
  }
  const executables = [producerExecutable, binding.launcher, binding.core, binding.watchdog];
  for (const path of executables) boundExecutable(path);
  boundGenerationManifest(binding.generation);
  const files = [...executables, binding.generation];

  const directories: string[] = [];
  for (let current = dirname(producerExecutable);;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of directories) {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(path) !== path) throw new Error('INVALID_PRODUCER_HELPER');
  }
  if ([...files, ...directories].some(writableByProducer)) throw new Error('WRITABLE_PRODUCER_INSTALLATION');
  if (process.platform !== 'win32') {
    for (const path of [...files, ...directories]) {
      const stat = fs.lstatSync(path);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('UNTRUSTED_PRODUCER_INSTALLATION');
    }
  }
}

export function resolveProducerHelperBinding(
  sourceRoot: string,
  stateRoot: string,
  testLauncherPath?: string,
): ProducerHelperBinding {
  if (process.platform === 'win32' && testLauncherPath === undefined) throw new Error('UNSUPPORTED_PRODUCER_PLATFORM');
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const launcher = testLauncherPath ?? join(dirname(process.execPath), `gstack-cso-launcher${executableSuffix}`);
  if (!isAbsolute(launcher) || resolve(launcher) !== launcher || basename(launcher) !== `gstack-cso-launcher${executableSuffix}`) {
    throw new Error('INVALID_PRODUCER_HELPER');
  }
  const directory = dirname(launcher);
  if (inside(sourceRoot, directory) || inside(directory, sourceRoot) || inside(stateRoot, directory) || inside(directory, stateRoot)) {
    throw new Error('INVALID_PRODUCER_HELPER');
  }
  const binding = {
    producer: testLauncherPath === undefined ? process.execPath : join(dirname(launcher), `cso-eval-producer${executableSuffix}`),
    launcher,
    core: join(directory, `gstack-cso-core${executableSuffix}`),
    watchdog: join(directory, `gstack-cso-watchdog${executableSuffix}`),
    generation: join(directory, '.gstack-cso-generation'),
  };
  try {
    boundExecutable(binding.producer);
    boundExecutable(binding.launcher);
    boundExecutable(binding.core);
    boundExecutable(binding.watchdog);
    boundGenerationManifest(binding.generation);
  } catch {
    throw new Error('INVALID_PRODUCER_HELPER');
  }
  // The explicit path exists solely for source-level unit tests. The production
  // CLI has no override and enforces an unprivileged, nonwritable installation.
  if (testLauncherPath === undefined) validateProductionProducerInstallation(binding);
  return binding;
}

const PRODUCER_ARTIFACT_LIMIT = 512 * 1024 * 1024;

function artifactIdentity(path: string): { sha256: string; bytes: number } {
  const named = fs.lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size <= 0 || named.size > PRODUCER_ARTIFACT_LIMIT) {
    throw new Error('INVALID_PRODUCER_INSTALLATION');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || opened.mode !== named.mode || opened.size !== named.size) {
      throw new Error('PRODUCER_INSTALLATION_RACE');
    }
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > PRODUCER_ARTIFACT_LIMIT) throw new Error('INVALID_PRODUCER_INSTALLATION');
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor), current = fs.lstatSync(path);
    if (bytes !== opened.size || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino || current.mode !== opened.mode || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error('PRODUCER_INSTALLATION_RACE');
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function generationIdentity(path: string, core: { sha256: string; bytes: number }): ProducerInstallationIdentity['generation'] {
  const manifest = artifactIdentity(path);
  const coreSha256 = readGenerationManifest(path);
  if (manifest.bytes !== GENERATION_MANIFEST_BYTES || manifest.sha256 !== sha256(`${coreSha256}\n`)) {
    throw new Error('PRODUCER_INSTALLATION_RACE');
  }
  if (coreSha256 !== core.sha256) throw new Error('PRODUCER_HELPER_GENERATION_MISMATCH');
  return { coreSha256, manifest };
}

export function producerInstallationIdentity(binding: ProducerHelperBinding): ProducerInstallationIdentity {
  const core = artifactIdentity(binding.core);
  const withoutHash: Omit<ProducerInstallationIdentity, 'identityHash'> = {
    schemaVersion: 1,
    producer: artifactIdentity(binding.producer),
    launcher: artifactIdentity(binding.launcher),
    core,
    watchdog: artifactIdentity(binding.watchdog),
    generation: generationIdentity(binding.generation, core),
    embeddedCatalogs: {
      runtimeRevision: runtimeCatalog.revision,
      runtimeBuildRevision: runtimeCatalog.buildRevision,
      runtimeSha256: sha256(JSON.stringify(runtimeCatalog)),
      scannerRevision: scannerCatalog.revision,
      scannerSha256: sha256(JSON.stringify(scannerCatalog)),
    },
  };
  return { ...withoutHash, identityHash: producerInstallationIdentityHash(withoutHash) };
}

export const PRODUCER_PROVIDER_POLICY: Record<ProducerHost, { family: ProducerProviderIdentity['family']; policyRevision: string; version: string }> = {
  claude: { family: 'claude', policyRevision: 'claude-2.1.263-cso-v1', version: '2.1.263 (Claude Code)' },
  codex: { family: 'gpt', policyRevision: 'codex-0.153.4-cso-v3-generation', version: 'codex-cli 0.153.4' },
  gemini: { family: 'gemini', policyRevision: 'gemini-0.59.0-cso-v1', version: '0.59.0' },
};

function validateProviderIdentity(identity: ProducerProviderIdentity, family: ProducerProviderIdentity['family']): ProducerProviderIdentity {
  if (!identity || identity.schemaVersion !== 1 || identity.family !== family || !identity.policyRevision || !identity.version ||
      !Array.isArray(identity.argsPrefix) || identity.argsPrefix.some(value => typeof value !== 'string' || value.includes('\0')) ||
      !identity.executable || !HEX.test(identity.executable.sha256) || !Number.isSafeInteger(identity.executable.bytes) || identity.executable.bytes <= 0 ||
      !HEX.test(identity.identityHash)) throw new Error('INVALID_PRODUCER_PROVIDER_IDENTITY');
  const { identityHash, ...withoutHash } = identity;
  if (producerProviderIdentityHash(withoutHash) !== identityHash) throw new Error('INVALID_PRODUCER_PROVIDER_IDENTITY');
  return identity;
}

export interface ProducerProviderResolution {
  identity: ProducerProviderIdentity;
  command: { executable: string; argsPrefix: string[] };
}

export function resolveProducerProviderIdentity(host: ProducerHost, stateRoot: string): ProducerProviderResolution {
  const policy = PRODUCER_PROVIDER_POLICY[host];
  const resolved = host === 'claude'
    ? resolveClaudeCommand()
    : { command: executable(host === 'codex' ? 'codex' : 'gemini'), argsPrefix: [] as string[] };
  if (!resolved) throw new Error('PRODUCER_UNAVAILABLE: provider CLI not found');
  const command = fs.realpathSync(resolved.command);
  const versionOutput = execFileSync(resolved.command, [...resolved.argsPrefix, '--version'], {
    cwd: dirname(command),
    env: { PATH: process.env.PATH ?? '', HOME: stateRoot, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  }).trim();
  if (policy.version !== versionOutput || redact(versionOutput) !== versionOutput) throw new Error('UNQUALIFIED_PRODUCER_PROVIDER_VERSION');
  const withoutHash: Omit<ProducerProviderIdentity, 'identityHash'> = {
    schemaVersion: 1,
    family: policy.family,
    policyRevision: policy.policyRevision,
    executable: artifactIdentity(command),
    argsPrefix: [...resolved.argsPrefix],
    version: versionOutput,
  };
  return {
    identity: { ...withoutHash, identityHash: producerProviderIdentityHash(withoutHash) },
    command: { executable: command, argsPrefix: [...resolved.argsPrefix] },
  };
}

function promptFor(cell: ProducerExecution, skill: string, sourceRoot: string, helper: ProducerHelperBinding): string {
  const invocation = `/cso${cell.mode === 'comprehensive' ? ' --comprehensive' : ''} --budget ${cell.budgetSeconds}`;
  const sourceAccess = cell.host === 'codex'
    ? 'The Codex permission profile grants read-only access to exactly that immutable snapshot so the trusted helper can read it. Use only the trusted helper to inspect or act on source; direct provider file or shell access is outside this evaluation policy.'
    : 'The application snapshot is available to the producing agent only through the trusted helper.';
  const sourceLocation = `The neutral current working directory contains no application source. The application repository at ${sourceRoot} is your entire source scope. ${sourceAccess}`;
  return `You are the producing agent in a matched security evaluation. ${sourceLocation} The only trusted gstack-cso for this run is the absolute launcher path ${JSON.stringify(helper.launcher)}. Interpret every \`gstack-cso\` command in the skill as that exact path; do not discover or invoke another helper through PATH. Do not inspect parent directories, process metadata, evaluation control files, sibling jobs, alternative source variants, expected labels, or evaluator assertions. Follow the exact CSO skill instructions below and perform this invocation: ${invocation}\n\nDo not ask questions. Leave the application branch unchanged. End with the normal CSO report. Producer statements are claims that an independent evaluator will challenge; never infer private assertions or call a result tested without the helper evidence required by the skill.\n\n<exact-cso-skill sha256="${cell.skillHash}">\n${skill}\n</exact-cso-skill>\n`;
}

export function adapterFor(host: ProducerHost): ProviderAdapter {
  return host === 'claude' ? new ClaudeAdapter() : host === 'codex' ? new GptAdapter() : new GeminiAdapter();
}

function writeExclusiveAtomic(path: string, value: unknown): void {
  const parent = dirname(path);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_RECEIPT_DESTINATION');
  try { atomicWriteSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, noReplace: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('RECEIPT_EXISTS'); throw error; }
}

/** Redact both channels and both concatenation orders before a receipt can bind them. */
export function sanitizeProducerRun(run: RunResult): RunResult {
  if (typeof run.output !== 'string' || (run.error && typeof run.error.reason !== 'string')) {
    throw new CsoError('REDACTION_FAILED', 'Producer output withheld because it was not valid text');
  }
  const reason = run.error?.reason ?? '';
  try {
    const views = [run.output, reason, run.output + reason, reason + run.output];
    if (views.some(value => redact(value) !== value)) {
      return {
        ...run,
        output: '[sensitive producer output redacted]',
        error: { code: run.error?.code ?? 'unknown', reason: 'Sensitive producer output or error withheld' },
      };
    }
    return run;
  } catch {
    throw new CsoError('REDACTION_FAILED', 'Producer output withheld because redaction could not safely inspect it');
  }
}

export function producerFailureMessage(error: unknown): string {
  if (error instanceof CsoError && error.code === 'REDACTION_FAILED') return 'REDACTION_FAILED: producer payload withheld';
  const message = error instanceof Error ? error.message : 'CSO producer failed';
  try { return redact(message); }
  catch { return 'REDACTION_FAILED: producer error withheld'; }
}

/** A post-run check failed: the receipt records it as a failed cell with no output or artifacts, keeping the run's usage. */
export function producerIntegrityFailure(error: unknown): { code: string; reason: string } {
  if (error instanceof CsoError) {
    let reason: string;
    try { reason = redact(error.message); } catch { reason = 'detail withheld'; }
    return { code: error.code, reason };
  }
  const message = producerFailureMessage(error);
  const named = error instanceof Error && !(error as NodeJS.ErrnoException).code ? /^([A-Z][A-Z0-9_]+)(?::\s*([\s\S]*))?$/.exec(message) : null;
  return named ? { code: named[1], reason: named[2] || named[1] } : { code: 'PRODUCER_POST_RUN_CHECK_FAILED', reason: message };
}

export async function runProducerCell(inputPath: string, receiptPath: string, options: {
  adapter?: ProviderAdapter;
  paidExecutionAuthorized: boolean;
  /** Unit tests run this source file through Bun; production always uses the adjacent compiled bundle. */
  testHelperLauncherPath?: string;
  /** Unit tests never execute a provider CLI; production always measures the reviewed binary. */
  testProviderIdentity?: ProducerProviderIdentity;
  /** Test-only exact command paired with testProviderIdentity. */
  testProviderCommand?: { executable: string; argsPrefix: string[] };
}): Promise<ProducerReceipt> {
  if (!options.paidExecutionAuthorized) throw new Error('PAID_EXECUTION_NOT_AUTHORIZED');
  const controlPath = resolve(inputPath);
  const receipt = resolve(receiptPath);
  const { jobRoot, sourceRoot } = assertIsolatedLayout(controlPath, receipt);
  assertReceiptDestination(receipt);
  const bytes = readBoundedStable(controlPath, INPUT_LIMIT, 'Producer input');
  let input: ProducerInput;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('INVALID_PRODUCER_INPUT'); }
  validateInput(input);
  const cell = input.execution;
  if (basename(receipt) !== `${input.cellRef}.json`) throw new Error('UNMATCHED_RECEIPT_DESTINATION');
  if (sha256(input.skill) !== cell.skillHash) throw new Error('INVALID_PRODUCER_SKILL');
  validateSource(sourceRoot, input.source, cell.sourceHash);
  sealProducerSource(sourceRoot);
  validateSource(sourceRoot, input.source, cell.sourceHash);
  const originalRepositoryIdentity = repositoryIdentity(sourceRoot);
  const stateRoot = join(jobRoot, 'state');
  const helperHome = join(stateRoot, 'cso-home');
  const helper = resolveProducerHelperBinding(sourceRoot, stateRoot, options.testHelperLauncherPath);
  const installationIdentity = producerInstallationIdentity(helper);
  const adapter = options.adapter ?? adapterFor(cell.host);
  if ((cell.host === 'codex' ? 'gpt' : cell.host) !== adapter.family) throw new Error('UNMATCHED_PRODUCER_ADAPTER');
  fs.mkdirSync(stateRoot, { recursive: false, mode: 0o700 });
  fs.mkdirSync(helperHome, { recursive: false, mode: 0o700 });
  const provider = options.testProviderIdentity
    ? {
        identity: validateProviderIdentity(options.testProviderIdentity, adapter.family),
        command: options.testProviderCommand ?? { executable: process.execPath, argsPrefix: [] },
      }
    : resolveProducerProviderIdentity(cell.host, stateRoot);
  const providerIdentity = provider.identity;
  const runOptions = {
    prompt: promptFor(cell, input.skill, sourceRoot, helper),
    workdir: stateRoot,
    timeoutMs: producerProviderTimeoutMs(cell.budgetSeconds),
    model: cell.model,
    csoProducer: {
      stateDirectory: stateRoot,
      sourceDirectory: sourceRoot,
      helperLauncher: helper.launcher,
      helperGeneration: helper.generation,
      providerCommand: provider.command,
    },
  } satisfies RunOpts;
  const availability = await adapter.available(runOptions);
  if (!availability.ok) throw new Error(`PRODUCER_UNAVAILABLE: ${availability.reason ?? cell.host}`);
  const inputHash = producerInputHash(input);

  // Load the opaque metadata into memory, then remove it before starting the
  // agent. A clean producer host exposes only source + installed product bits.
  fs.unlinkSync(controlPath);
  const previousHome = process.env.GSTACK_HOME;
  const previousSessionKind = process.env.GSTACK_SESSION_KIND;
  const previousHeadless = process.env.GSTACK_HEADLESS;
  process.env.GSTACK_HOME = helperHome;
  process.env.GSTACK_SESSION_KIND = 'spawned';
  process.env.GSTACK_HEADLESS = '1';
  const startedAt = new Date().toISOString();
  let run: RunResult;
  try {
    if (cell.host === 'gemini') prepareGeminiProducerState(stateRoot, helper.launcher);
    run = await adapter.run(runOptions);
  } finally {
    try {
      if (cell.host === 'gemini') removeGeminiProducerState(stateRoot);
    } finally {
      if (previousHome === undefined) delete process.env.GSTACK_HOME; else process.env.GSTACK_HOME = previousHome;
      if (previousSessionKind === undefined) delete process.env.GSTACK_SESSION_KIND; else process.env.GSTACK_SESSION_KIND = previousSessionKind;
      if (previousHeadless === undefined) delete process.env.GSTACK_HEADLESS; else process.env.GSTACK_HEADLESS = previousHeadless;
    }
  }
  const finishedAt = new Date().toISOString();
  let artifacts = emptyArtifactInventory();
  let integrityFailure: { code: string; reason: string } | undefined;
  let check = '';
  try {
    check = 'helper installation';
    const installationAfter = producerInstallationIdentity(helper);
    if (installationAfter.identityHash !== installationIdentity.identityHash) {
      throw new Error('PRODUCER_HELPER_GENERATION_CHANGED: installed helper identity changed during the run');
    }
    check = 'provider installation';
    const providerAfter = artifactIdentity(provider.command.executable);
    if (providerAfter.sha256 !== providerIdentity.executable.sha256 || providerAfter.bytes !== providerIdentity.executable.bytes) {
      throw new Error('PRODUCER_PROVIDER_INSTALLATION_RACE: provider executable changed during the run');
    }
    check = 'source modes';
    assertProducerSourceSealed(sourceRoot);
    check = 'source content';
    validateSource(sourceRoot, input.source, cell.sourceHash);
    check = 'source Git state';
    if (repositoryIdentity(sourceRoot) !== originalRepositoryIdentity) throw new Error('PRODUCER_CHANGED_SOURCE: Git HEAD, branch, config or status changed during the run');
    check = 'artifact inventory';
    artifacts = inventoryProducerArtifacts(helperHome);
    check = 'output size';
    const outputBytes = typeof run.output === 'string' ? Buffer.byteLength(run.output) : 0;
    if (outputBytes > OUTPUT_LIMIT) throw new Error(`PRODUCER_OUTPUT_TOO_LARGE: output is ${outputBytes} bytes; the limit is ${OUTPUT_LIMIT}`);
  } catch (error) {
    const failure = producerIntegrityFailure(error);
    integrityFailure = { code: failure.code, reason: `${check} check: ${failure.reason}${run.error ? `; the provider run also failed (${run.error.code})` : ''}` };
    artifacts = emptyArtifactInventory();
  }
  if (!integrityFailure) {
    run = sanitizeProducerRun(run);
    if(!run.error&&!run.output.trim())run={...run,error:{code:'unknown',reason:'empty output from provider CLI (exit 0)'}};
  }
  const tokensReported = run.tokens.input > 0 || run.tokens.output > 0 || (run.tokens.cached ?? 0) > 0;
  const estimatedCostUSD = tokensReported && PRICING[run.modelUsed] ? adapter.estimateCost(run.tokens, run.modelUsed) : null;
  const failure = integrityFailure ?? run.error, output = integrityFailure ? '' : run.output;
  const withoutHash: Omit<ProducerReceipt, 'receiptHash'> = {
    schemaVersion: 2,
    cellRef: input.cellRef,
    inputHash,
    installationIdentity,
    providerIdentity,
    artifacts,
    startedAt,
    finishedAt,
    status: failure ? 'failed' : 'succeeded',
    requestedModel: cell.model,
    modelUsed: run.modelUsed,
    modelIdentitySource: run.modelUsed === cell.model ? 'requested_pin' : 'provider_reported',
    durationMs: run.durationMs,
    firstUsefulResultMs: null,
    toolCalls: run.toolCalls,
    output,
    outputHash: sha256(output),
    usage: {
      inputTokens: tokensReported ? run.tokens.input : null,
      outputTokens: tokensReported ? run.tokens.output : null,
      cachedTokens: tokensReported && run.tokens.cached !== undefined ? run.tokens.cached : null,
      estimatedCostUSD,
    },
    ...(failure ? { error: failure } : {}),
  };
  const result = { ...withoutHash, receiptHash: producerReceiptHash(withoutHash) };
  writeExclusiveAtomic(receipt, result);
  return result;
}

async function cli(args: string[]): Promise<void> {
  if (args.length !== 4 || args[0] !== 'run' || args[3] !== '--execute-paid') throw new Error('Usage: cso-eval-producer run <consumable-input.json> <new-receipt.json> --execute-paid');
  if (process.env.CSO_EVAL_PAID !== '1') throw new Error('PAID_EXECUTION_NOT_AUTHORIZED: also set CSO_EVAL_PAID=1 on the isolated producer host');
  const receipt = await runProducerCell(args[1], args[2], { paidExecutionAuthorized: true });
  console.log(JSON.stringify({ cellRef: receipt.cellRef, status: receipt.status, durationMs: receipt.durationMs, receiptHash: receipt.receiptHash }));
}

if (import.meta.main) {
  cli(process.argv.slice(2)).catch(error => { console.error(producerFailureMessage(error)); process.exitCode = 1; });
}
