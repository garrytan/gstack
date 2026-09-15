#!/usr/bin/env bun
/**
 * Runtime-image half of the CSO preparation contract.  This executable runs
 * only inside a qualified, network-none container.  Acquisition egress is a
 * loopback TCP forwarder to the host's allowlisted Unix-socket broker.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';

const VERSION = '1.0.0';
const MAX_POLICY = 32 * 1024 * 1024;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 200_000;
const SHA256 = /^[a-f0-9]{64}$/;
const RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[A-Za-z0-9@._+\/-]{1,1024}$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const VERSION_VALUE = /^[0-9][0-9A-Za-z.+_-]*$/;

type Stack = 'node' | 'bun' | 'python' | 'rails';
interface Input {
  index: number;
  input: { kind: 'public'; name: string; version: string; url?: string; integrity?: string; integritySource?: string; platform?: string };
}
interface Policy {
  schemaVersion: 1;
  planHash: string;
  stack: Stack;
  inputs: Input[];
  allowedHosts?: string[];
  limits?: { maxArchives?: number; maxArchiveBytes?: number; maxTotalArchiveBytes?: number };
  archives?: Array<{ inputIndex: number; name: string; version: string; declaredIntegrity: string; requestedUrl: string; resolvedUrl: string | null; containerPath: string; sha256: string; bytes: number }>;
}
interface Artifact {
  inputIndex: number; stagingPath: string; installPath: string; sha256: string; bytes: number;
  requestedHost: string; requestedUrl: string; resolvedUrl: string | null; registryResponseSha256: string;
}

export type PreparedExportEntry =
  | { path: string; kind: 'directory'; mode: number }
  | { path: string; kind: 'file'; mode: number; bytes: number; sha256: string; blob: string }
  | { path: string; kind: 'symlink'; mode: number; target: string };
export interface PreparedExportManifest { schemaVersion: 1; entries: PreparedExportEntry[] }

function die(message: string): never { process.stderr.write(`${message}\n`); process.exit(70); }
/** Count every materialized tar header, including zero-byte directories. */
export function recordNpmArchiveEntry(previous: number, type: string): number {
  if (!Number.isSafeInteger(previous) || previous < 0 || typeof type !== 'string' || type.length !== 1)
    throw new Error('invalid npm archive entry counter');
  const next = previous + 1;
  if (next > MAX_FILES) throw new Error('npm archive exceeded extraction limits');
  return next;
}
function strictPath(root: string, relative: string): string {
  if (!RELATIVE.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) die('unsafe relative path');
  const target = resolve(root, ...relative.split('/'));
  if (!target.startsWith(`${resolve(root)}${sep}`)) die('path escaped root');
  return target;
}
function mkdirPrivate(path: string): void {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) die('private directory changed unexpectedly');
  fs.chmodSync(path, 0o700);
}
function readPolicy(path: string): Policy {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_POLICY) die('invalid preparation policy file');
  let value: any;
  try { value = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { die('invalid preparation policy JSON'); }
  if (!value || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.planHash) ||
    !['node', 'bun', 'python', 'rails'].includes(value.stack) || !Array.isArray(value.inputs) || value.inputs.length > 25_000)
    die('invalid preparation policy schema');
  const indexes = new Set<number>();
  for (const item of value.inputs) {
    const input = item?.input;
    if (!Number.isSafeInteger(item?.index) || item.index < 0 || indexes.has(item.index) || input?.kind !== 'public' ||
      !NAME.test(input.name) || !VERSION_VALUE.test(input.version) || typeof input.integritySource !== 'string') die('invalid preparation input');
    indexes.add(item.index);
  }
  return value as Policy;
}
function openRegular(path: string, max = MAX_ARCHIVE): { fd: number; stat: fs.Stats } {
  const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow); } catch { die('archive is missing or unsafe'); }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 0 || stat.size > max) { fs.closeSync(fd); die('archive is not one bounded regular file'); }
  return { fd, stat };
}
function hashes(path: string, max = MAX_ARCHIVE): { sha256: string; sha512: string; bytes: number } {
  const { fd, stat } = openRegular(path, max), h256 = createHash('sha256'), h512 = createHash('sha512'), buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  try {
    for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; bytes += count; if (bytes > max) die('archive exceeded byte ceiling'); h256.update(buffer.subarray(0, count)); h512.update(buffer.subarray(0, count)); }
    const after = fs.fstatSync(fd);
    if (bytes !== stat.size || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) die('archive changed while hashing');
    return { sha256: h256.digest('hex'), sha512: h512.digest('base64'), bytes };
  } finally { fs.closeSync(fd); }
}

function preparedPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || Buffer.byteLength(path) > 4096) return false;
  return path.split('/').every(part => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255 && !/[\0-\x1f\x7f]/.test(part));
}
function samePreparedObject(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function preparedFileHash(path: string, expected: fs.Stats, maxBytes: number): string {
  const noFollow = (fs.constants as any).O_NOFOLLOW ?? 0;
  const fd = fs.openSync(path, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !samePreparedObject(expected, before)) throw new Error('prepared file changed before export');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
      bytes += count; if (bytes > maxBytes) throw new Error('prepared tree exceeded its byte ceiling');
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    if (bytes !== expected.size || !samePreparedObject(before, after)) throw new Error('prepared file changed during export');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/**
 * Build an inert export from an offline-prepared /work tree. Regular files are
 * hard-linked into a helper-owned directory on the same tmpfs, so exporting
 * does not require a second dependency-sized writable allocation. Symlinks are
 * represented as manifest data and special files are rejected before Docker
 * is allowed to copy anything to the host.
 */
export function createPreparedExport(sourceRoot: string, exportRoot: string, maxBytes = MAX_EXPANDED, maxEntries = MAX_FILES): PreparedExportManifest {
  const root = resolve(sourceRoot), output = resolve(exportRoot);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_EXPANDED ||
    !Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > MAX_FILES ||
    output === root || !output.startsWith(`${root}${sep}`) || !/^\.gstack-cso-export-[a-f0-9]{24}$/.test(output.slice(root.length + 1)))
    throw new Error('prepared export arguments escaped their bounded contract');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('prepared export source is unsafe');

  type Scanned = PreparedExportEntry & { source?: string; identity?: fs.Stats };
  const scanned: Scanned[] = []; let nodes = 0, totalBytes = 0;
  const walk = (directory: string, prefix = ''): void => {
    const before = fs.readdirSync(directory).sort();
    for (const name of before) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (!preparedPath(relativePath) || ++nodes > maxEntries) throw new Error('prepared tree exceeded its entry or path ceiling');
      const path = join(directory, name), stat = fs.lstatSync(path);
      if (process.getuid && stat.uid !== process.getuid()) throw new Error('prepared tree contains an object owned by another identity');
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(path);
        if (!target || isAbsolute(target) || target.includes('\0') || /[\x01-\x1f\x7f]/.test(target)) throw new Error('prepared tree contains an unsafe symlink');
        const lexical = resolve(dirname(path), target);
        if (lexical !== root && !lexical.startsWith(`${root}${sep}`)) throw new Error('prepared tree contains an escaping symlink');
        let real: string, resolvedStat: fs.Stats;
        try { real = fs.realpathSync(path); resolvedStat = fs.statSync(path); } catch { throw new Error('prepared tree contains a dangling or cyclic symlink'); }
        if ((real !== root && !real.startsWith(`${root}${sep}`)) || (!resolvedStat.isFile() && !resolvedStat.isDirectory()))
          throw new Error('prepared tree symlink resolves outside the prepared boundary');
        const after = fs.lstatSync(path);
        if (!samePreparedObject(stat, after) || fs.readlinkSync(path) !== target) throw new Error('prepared symlink changed during export');
        scanned.push({ path: relativePath, kind: 'symlink', mode: stat.mode & 0o777, target });
      } else if (stat.isDirectory()) {
        if ((stat.mode & 0o022) !== 0) throw new Error('prepared tree contains a publicly writable directory');
        scanned.push({ path: relativePath, kind: 'directory', mode: stat.mode & 0o777 });
        walk(path, relativePath);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error('prepared tree contains a hard-linked file');
        totalBytes += stat.size; if (totalBytes > maxBytes) throw new Error('prepared tree exceeded its byte ceiling');
        const digest = preparedFileHash(path, stat, maxBytes);
        scanned.push({ path: relativePath, kind: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: digest, blob: '', source: path, identity: stat });
      } else throw new Error('prepared tree contains a FIFO, socket, device, or other special object');
    }
    if (before.join('\0') !== fs.readdirSync(directory).sort().join('\0')) throw new Error('prepared tree membership changed during export');
  };
  walk(root);
  scanned.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (fs.existsSync(output)) throw new Error('prepared export destination already exists');
  fs.mkdirSync(output, { mode: 0o700 });
  const blobs = join(output, 'blobs'); fs.mkdirSync(blobs, { mode: 0o700 });
  let fileIndex = 0;
  try {
    for (const entry of scanned) {
      if (entry.kind !== 'file') continue;
      const current = fs.lstatSync(entry.source!);
      if (!samePreparedObject(entry.identity!, current)) throw new Error('prepared file changed before inert export');
      const blob = `blob-${String(fileIndex++).padStart(6, '0')}`;
      fs.linkSync(entry.source!, join(blobs, blob));
      const linked = fs.lstatSync(join(blobs, blob));
      if (!linked.isFile() || linked.dev !== current.dev || linked.ino !== current.ino || linked.nlink !== 2)
        throw new Error('prepared file could not be bound into inert export');
      entry.blob = blob;
      delete entry.source; delete entry.identity;
    }
    const manifest: PreparedExportManifest = { schemaVersion: 1, entries: scanned as PreparedExportEntry[] };
    const encoded = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(encoded) > MAX_POLICY) throw new Error('prepared export manifest exceeded its byte ceiling');
    fs.writeFileSync(join(output, 'manifest.json'), encoded, { mode: 0o600, flag: 'wx' });
    return manifest;
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}
function matchesIntegrity(value: string | undefined, valueHashes: { sha256: string; sha512: string }): boolean {
  if (!value) return false;
  return value.split(/\s+/).some(item => item === `sha256:${valueHashes.sha256}` ||
    item === `sha256-${Buffer.from(valueHashes.sha256, 'hex').toString('base64')}` || item === `sha512-${valueHashes.sha512}`);
}
function moveVerified(source: string, outputRoot: string, relative: string, max: number): { path: string; sha256: string; bytes: number } {
  const before = hashes(source, max), target = strictPath(outputRoot, relative);
  mkdirPrivate(dirname(target));
  if (fs.existsSync(target)) die('archive staging destination already exists');
  // Both paths are on the bounded /archives tmpfs. Rename the verified final
  // bytes into the inert export so no second archive-sized allocation exists.
  fs.renameSync(source, target);
  fs.chmodSync(target, 0o600);
  const after = hashes(target, max);
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) die('archive changed while moved to inert staging');
  return { path: relative, sha256: after.sha256, bytes: after.bytes };
}
function requestedUrl(item: Input, stack: Stack, filename?: string): string {
  if (item.input.url) return item.input.url;
  if (stack === 'python') return `https://pypi.org/simple/${item.input.name.toLowerCase().replace(/[_.]+/g, '-')}/`;
  if (stack === 'rails' && filename) return `https://rubygems.org/gems/${filename}`;
  die('archive URL is unavailable');
}
function checkedUrl(raw: string, hosts: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { die('invalid archive URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !hosts.includes(url.hostname)) die('archive URL escaped registry policy');
  return url;
}

async function download(raw: string, hosts: string[], destination: string, max: number): Promise<string> {
  let current = checkedUrl(raw, hosts);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(current, { redirect: 'manual', proxy: 'http://127.0.0.1:18443', headers: { 'user-agent': `gstack-cso-preparation/${VERSION}`, accept: 'application/octet-stream' } } as any);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) die('registry redirect exceeded policy');
      current = checkedUrl(new URL(location, current).href, hosts); continue;
    }
    if (response.status !== 200 || !response.body) die(`registry returned HTTP ${response.status}`);
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) die('registry response exceeded byte ceiling');
    mkdirPrivate(dirname(destination));
    const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > max) { await reader.cancel(); die('registry response exceeded byte ceiling'); }
        let offset = 0; while (offset < part.value.byteLength) offset += fs.writeSync(fd, part.value, offset, part.value.byteLength - offset);
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (declared && bytes !== Number(declared)) die('registry response was truncated');
    return current.href;
  }
  die('registry redirect failed');
}

function npmCacheSource(item: Input): string | undefined {
  const tokens = (item.input.integrity ?? '').split(/\s+/);
  for (const token of tokens) {
    const match = token.match(/^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/);
    if (!match) continue;
    const digest = Buffer.from(match[2], 'base64').toString('hex');
    if ((match[1] === 'sha256' && digest.length !== 64) || (match[1] === 'sha512' && digest.length !== 128)) continue;
    const candidate = `/archives/npm/_cacache/content-v2/${match[1]}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest.slice(4)}`;
    try { if (fs.lstatSync(candidate).isFile()) return candidate; } catch {}
  }
  return undefined;
}
function regularFiles(directory: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(directory).sort(); } catch { return []; }
  const files: string[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9@._+-]{1,512}$/.test(name)) die('archive directory contains an unexpected filename');
    const path = join(directory, name), stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) die('archive directory contains an unsafe object');
    files.push(path);
  }
  return files;
}

async function manifest(policyPath: string, archiveRoot: string, outputPath: string): Promise<void> {
  const outputMatch = outputPath.match(/^\/archives\/(\.gstack-cso-acquisition-export-[a-f0-9]{24})\/artifacts\.json$/);
  if (resolve(archiveRoot) !== '/archives' || !outputMatch) die('manifest paths do not match the container contract');
  const policy = readPolicy(policyPath), hosts = policy.allowedHosts ?? [], maxEntry = Math.min(policy.limits?.maxArchiveBytes ?? MAX_ARCHIVE, MAX_ARCHIVE),
    maxTotal = Math.min(policy.limits?.maxTotalArchiveBytes ?? MAX_EXPANDED, MAX_EXPANDED), artifacts: Artifact[] = [];
  // Package managers write only to the size-bounded /archives tmpfs. After all
  // untrusted manager processes have exited, move verified regular artifacts
  // into one unpredictable helper-owned export on that same tmpfs.
  const exportRoot = join('/archives', outputMatch[1]);
  if (fs.existsSync(exportRoot)) die('acquisition export destination already exists');
  fs.mkdirSync(exportRoot, { mode: 0o700 });
  const publicRoot = join(exportRoot, 'archives'); fs.mkdirSync(publicRoot, { mode: 0o700 });
  const add = (item: Input, source: string, installPath: string, requestedUrl: string, resolvedUrl: string | null, ordinal: number) => {
    const original = hashes(source, maxEntry);
    if (item.input.integritySource === 'lock' && !matchesIntegrity(item.input.integrity, original)) die(`archive failed lock integrity: ${item.input.name}@${item.input.version}`);
    const copied = moveVerified(source, publicRoot, `${policy.planHash.slice(0, 16)}-${policy.stack}-${ordinal}.archive`, maxEntry), requested = checkedUrl(requestedUrl, hosts);
    if (resolvedUrl !== null) checkedUrl(resolvedUrl, hosts);
    artifacts.push({ inputIndex: item.index, stagingPath: `cso-public/${copied.path}`, installPath, sha256: copied.sha256,
      bytes: copied.bytes, requestedHost: requested.hostname, requestedUrl: requested.href, resolvedUrl,
      registryResponseSha256: original.sha256 });
  };

  if (policy.stack === 'node') {
    const logical = new Set<string>();
    for (let ordinal = 0; ordinal < policy.inputs.length; ordinal++) {
      const item = policy.inputs[ordinal], key = `${item.input.name}\0${item.input.version}`;
      if (logical.has(key)) continue; logical.add(key);
      const url = requestedUrl(item, policy.stack); let source = npmCacheSource(item);
      const temporary = `/archives/.cso-download-${ordinal}`;
      let resolvedUrl: string | null = null;
      if (!source) { resolvedUrl = await download(url, hosts, temporary, maxEntry); source = temporary; }
      try { add(item, source, `node/${ordinal}.tgz`, url, resolvedUrl, ordinal); }
      finally { if (source === temporary) try { fs.unlinkSync(temporary); } catch {} }
    }
  } else if (policy.stack === 'bun') {
    const logical = new Set<string>();
    for (let ordinal = 0; ordinal < policy.inputs.length; ordinal++) {
      const item = policy.inputs[ordinal], url = requestedUrl(item, policy.stack), temporary = `/archives/.cso-download-${ordinal}`;
      const key = `${item.input.name}\0${item.input.version}`; if (logical.has(key)) continue; logical.add(key);
      const resolvedUrl = await download(url, hosts, temporary, maxEntry);
      try { add(item, temporary, `bun/${ordinal}.tgz`, url, resolvedUrl, ordinal); } finally { try { fs.unlinkSync(temporary); } catch {} }
    }
  } else if (policy.stack === 'python') {
    const candidates = regularFiles('/archives/wheels').map(path => ({ path, values: hashes(path, maxEntry) })), used = new Set<string>(), logical = new Set<string>();
    for (const item of policy.inputs) {
      const key = `${item.input.name.toLowerCase().replace(/[_.]+/g, '-')}\0${item.input.version}`;
      if (logical.has(key)) continue;
      const match = candidates.find(candidate => !used.has(candidate.path) && matchesIntegrity(item.input.integrity, candidate.values));
      if (!match) continue;
      logical.add(key); used.add(match.path);
      const name = match.path.slice(match.path.lastIndexOf('/') + 1), ordinal = artifacts.length;
      add(item, match.path, `wheels/${name}`, requestedUrl(item, policy.stack), null, ordinal);
    }
  } else {
    for (let ordinal = 0; ordinal < policy.inputs.length; ordinal++) {
      const item = policy.inputs[ordinal], suffix = item.input.platform && item.input.platform !== 'ruby' ? `-${item.input.platform}` : '',
        filename = `${item.input.name}-${item.input.version}${suffix}.gem`, path = join('/archives', filename);
      add(item, path, filename, requestedUrl(item, policy.stack, filename), null, ordinal);
    }
  }
  if (!artifacts.length && policy.inputs.length) die('acquisition produced no lock-bound public archives');
  if (artifacts.length > (policy.limits?.maxArchives ?? 25_000) || artifacts.reduce((sum, item) => sum + item.bytes, 0) > maxTotal) die('acquisition artifacts exceeded policy');
  mkdirPrivate(dirname(outputPath));
  fs.writeFileSync(outputPath, `${JSON.stringify({ artifacts })}\n`, { mode: 0o600, flag: 'wx' });
}

async function forwarder(socketPath: string, listen: string): Promise<void> {
  if (socketPath !== '/run/cso-registry.sock' || listen !== '127.0.0.1:18443') die('forwarder endpoints do not match the qualified policy');
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink()) die('registry broker is not a Unix socket');
  let metadataBytes = 0, metadataFiles = 0;
  const copyMetadata = (source: string, destination: string) => {
    const directory = fs.lstatSync(source);
    if (!directory.isDirectory() || directory.isSymbolicLink()) die('acquisition metadata input is unsafe');
    mkdirPrivate(destination);
    for (const name of fs.readdirSync(source).sort()) {
      if (!/^[A-Za-z0-9@._+-]{1,255}$/.test(name)) die('acquisition metadata contains an unsafe name');
      const from = join(source, name), to = join(destination, name), child = fs.lstatSync(from);
      if (child.isDirectory() && !child.isSymbolicLink()) { copyMetadata(from, to); continue; }
      if (!child.isFile() || child.isSymbolicLink() || child.nlink !== 1) die('acquisition metadata contains a link or special file');
      metadataBytes += child.size; metadataFiles++;
      if (metadataBytes > MAX_POLICY || metadataFiles > 50_000) die('acquisition metadata exceeds its bounded copy limit');
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600);
    }
  };
  copyMetadata('/input-metadata', '/metadata');
  const server = net.createServer(client => {
    const upstream = net.createConnection({ path: socketPath });
    client.setTimeout(30_000); upstream.setTimeout(30_000);
    client.once('error', () => upstream.destroy()); upstream.once('error', () => client.destroy());
    client.once('timeout', () => { client.destroy(); upstream.destroy(); });
    upstream.once('timeout', () => { client.destroy(); upstream.destroy(); });
    client.pipe(upstream); upstream.pipe(client);
  });
  server.listen(18443, '127.0.0.1');
  await once(server, 'listening');
  await new Promise<void>((_resolve, reject) => server.once('error', reject));
}
async function health(host: string, port: string): Promise<void> {
  if (host !== '127.0.0.1' || port !== '18443') die('invalid forwarder health endpoint');
  const socket = net.createConnection({ host, port: 18443 });
  await Promise.race([once(socket, 'connect'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))]);
  socket.destroy();
}

function tarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start); return block.subarray(start, end < 0 || end > start + length ? start + length : end).toString('utf8');
}
function tarNumber(block: Buffer, start: number, length: number): number {
  const value = tarString(block, start, length).trim();
  if (!/^[0-7]+$/.test(value)) die('invalid tar numeric field');
  const number = Number.parseInt(value, 8); if (!Number.isSafeInteger(number) || number < 0) die('invalid tar size'); return number;
}
function tarChecksum(block: Buffer): void {
  const declared = tarNumber(block, 148, 8); let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : block[index];
  if (sum !== declared) die('invalid tar header checksum');
}
async function extractNpmArchive(source: string, destination: string, expectedName: string, expectedVersion: string): Promise<void> {
  mkdirPrivate(destination);
  const stream = fs.createReadStream(source).pipe(createGunzip()), chunks: Buffer[] = [];
  let buffered = 0, current: { remaining: number; padding: number; fd?: number; mode?: number } | undefined, expanded = 0, entries = 0, zeroBlocks = 0;
  const consume = () => {
    let buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered); chunks.length = 0; buffered = 0; let offset = 0;
    while (offset < buffer.length) {
      if (current) {
        const count = Math.min(current.remaining, buffer.length - offset);
        if (count && current.fd !== undefined) { let written = 0; while (written < count) written += fs.writeSync(current.fd, buffer, offset + written, count - written); }
        offset += count; current.remaining -= count;
        if (!current.remaining) {
          if (current.fd !== undefined) { fs.fchmodSync(current.fd, current.mode ?? 0o600); fs.fsyncSync(current.fd); fs.closeSync(current.fd); current.fd = undefined; }
          const skip = Math.min(current.padding, buffer.length - offset); offset += skip; current.padding -= skip;
          if (!current.padding) current = undefined;
        }
        continue;
      }
      if (buffer.length - offset < 512) break;
      const header = buffer.subarray(offset, offset + 512); offset += 512;
      if (header.every(byte => byte === 0)) { zeroBlocks++; if (zeroBlocks >= 2 && offset !== buffer.length) die('tar contains data after end marker'); continue; }
      if (zeroBlocks) die('tar has an invalid end marker');
      tarChecksum(header);
      const prefix = tarString(header, 345, 155), rawName = `${prefix ? `${prefix}/` : ''}${tarString(header, 0, 100)}`, type = String.fromCharCode(header[156] || 48), size = tarNumber(header, 124, 12), archivedMode = tarNumber(header, 100, 8), safeMode = archivedMode & 0o755;
      if (!rawName.startsWith('package/')) die('npm archive entry lacks package prefix');
      const relative = rawName.slice(8).replace(/\/$/, '');
      if (!relative) { if (type !== '5') die('invalid npm archive root'); current = { remaining: size, padding: (512 - size % 512) % 512 }; continue; }
      try { entries = recordNpmArchiveEntry(entries, type); } catch { die('npm archive exceeded extraction limits'); }
      const target = strictPath(destination, relative);
      if (type === '5') { if (size !== 0) die('tar directory has content'); mkdirPrivate(target); current = { remaining: 0, padding: 0 }; continue; }
      if (type !== '0') die('npm archive contains a link or special entry');
      expanded += size; if (expanded > MAX_EXPANDED) die('npm archive exceeded extraction limits');
      mkdirPrivate(dirname(target));
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      current = { remaining: size, padding: (512 - size % 512) % 512, fd, mode: safeMode || 0o600 };
      if (!size) { fs.fchmodSync(fd, current.mode); fs.closeSync(fd); current.fd = undefined; if (!current.padding) current = undefined; }
    }
    if (offset < buffer.length) { const rest = buffer.subarray(offset); chunks.push(rest); buffered = rest.length; }
  };
  for await (const chunk of stream) { const value = Buffer.from(chunk); chunks.push(value); buffered += value.length; if (buffered > MAX_ARCHIVE + 1024) die('tar parser buffering exceeded limit'); consume(); }
  consume();
  if (current || buffered || zeroBlocks < 2) die('npm archive is truncated');
  let manifest: any;
  try { manifest = JSON.parse(fs.readFileSync(join(destination, 'package.json'), 'utf8')); } catch { die('npm archive package manifest is missing'); }
  if (manifest?.name !== expectedName || manifest?.version !== expectedVersion) die('npm archive identity does not match the lock');
}

interface BunSeedPackage {
  inputIndex: number;
  name: string;
  version: string;
  archive: string;
  integrity: string;
  manifest: Record<string, unknown>;
}

const BUN_REGISTRY_PORT = 4873;
function bunRegistryManifest(value: unknown, name: string, version: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) die('Bun seed package manifest is invalid');
  const source = value as Record<string, unknown>, clean: Record<string, unknown> = { name, version };
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'os', 'cpu', 'bin']) {
    if (source[key] !== undefined) clean[key] = source[key];
  }
  return clean;
}
function bunRegistryPathName(pathname: string): string | undefined {
  if (!pathname.startsWith('/') || pathname.includes('\0')) return undefined;
  try {
    const decoded = decodeURIComponent(pathname.slice(1));
    return NAME.test(decoded) ? decoded : undefined;
  } catch { return undefined; }
}
async function runBunSeedInstall(directory: string): Promise<void> {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work/.cso-home',
    BUN_INSTALL_CACHE_DIR: '/work/.cso-bun-cache', BUN_CONFIG_NO_CLEAR_TERMINAL: '1',
    BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER: '1',
  };
  const child = spawn('/usr/local/bin/bun', ['install', '--config=/opt/cso/empty-config', '--ignore-scripts', '--no-progress',
    `--registry=http://127.0.0.1:${BUN_REGISTRY_PORT}`, '--backend=copyfile'], {
    cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = Buffer.alloc(0), overflow = false;
  child.stderr.on('data', chunk => {
    if (stderr.length >= 64 * 1024) { overflow = true; return; }
    const value = Buffer.from(chunk), remaining = 64 * 1024 - stderr.length;
    stderr = Buffer.concat([stderr, value.subarray(0, remaining)]); if (value.length > remaining) overflow = true;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  clearTimeout(timeout);
  if (code !== 0 || signal || overflow) die('offline Bun cache seeding failed');
}
async function seedBunCache(archives: NonNullable<Policy['archives']>): Promise<void> {
  const cacheRoot = '/work/.cso-bun-cache', seedRoot = '/tmp/gstack-cso-bun-seed';
  mkdirPrivate(cacheRoot); mkdirPrivate(seedRoot);
  const packages: BunSeedPackage[] = [];
  for (const archive of archives) {
    const extracted = strictPath(seedRoot, `packages/${archive.inputIndex}`);
    await extractNpmArchive(archive.containerPath, extracted, archive.name, archive.version);
    let source: unknown;
    try { source = JSON.parse(fs.readFileSync(join(extracted, 'package.json'), 'utf8')); }
    catch { die('Bun seed package manifest is invalid'); }
    packages.push({ inputIndex: archive.inputIndex, name: archive.name, version: archive.version,
      archive: archive.containerPath, integrity: `sha512-${createHash('sha512').update(fs.readFileSync(archive.containerPath)).digest('base64')}`,
      manifest: bunRegistryManifest(source, archive.name, archive.version) });
  }
  const byName = new Map<string, BunSeedPackage[]>();
  for (const pkg of packages) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${BUN_REGISTRY_PORT}`);
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
    const archiveMatch = url.pathname.match(/^\/archives\/([0-9]+)\.tgz$/);
    if (archiveMatch) {
      const pkg = packages.find(item => item.inputIndex === Number(archiveMatch[1]));
      if (!pkg) { response.writeHead(404).end(); return; }
      const stat = fs.lstatSync(pkg.archive);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size),
        'Cache-Control': 'no-store' }); fs.createReadStream(pkg.archive).pipe(response); return;
    }
    const name = bunRegistryPathName(url.pathname), versions = name ? byName.get(name) : undefined;
    if (!name || !versions?.length) { response.writeHead(404).end(); return; }
    const metadata: Record<string, unknown> = { name, 'dist-tags': { latest: versions.at(-1)!.version }, versions: {} };
    for (const pkg of versions) (metadata.versions as Record<string, unknown>)[pkg.version] = {
      ...pkg.manifest,
      dist: { tarball: `http://127.0.0.1:${BUN_REGISTRY_PORT}/archives/${pkg.inputIndex}.tgz`, integrity: pkg.integrity },
    };
    const body = JSON.stringify(metadata);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store' }).end(body);
  });
  server.listen(BUN_REGISTRY_PORT, '127.0.0.1'); await once(server, 'listening');
  try {
    // Seed every exact logical identity independently. This supports multiple
    // locked versions of one package while letting Bun own its cache format.
    for (const pkg of packages) {
      const directory = strictPath(seedRoot, `installs/${pkg.inputIndex}`); mkdirPrivate(directory);
      const manifest = { name: `gstack-cso-seed-${pkg.inputIndex}`, private: true, dependencies: { [pkg.name]: pkg.version } };
      fs.writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest) + '\n', { mode: 0o600, flag: 'wx' });
      await runBunSeedInstall(directory);
    }
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    fs.rmSync(seedRoot, { recursive: true, force: true });
  }
}

async function seed(policyPath: string): Promise<void> {
  const policy = readPolicy(policyPath);
  if (!Array.isArray(policy.archives)) die('offline policy omitted archives');
  for (const archive of policy.archives) {
    if (!Number.isSafeInteger(archive.inputIndex) || !NAME.test(archive.name) || !VERSION_VALUE.test(archive.version) ||
      !archive.containerPath.startsWith('/archives/') || !SHA256.test(archive.sha256) || !Number.isSafeInteger(archive.bytes) || archive.bytes < 0)
      die('offline archive policy is invalid');
    const checked = hashes(archive.containerPath, Math.min(MAX_ARCHIVE, archive.bytes));
    if (checked.bytes !== archive.bytes || checked.sha256 !== archive.sha256 ||
      (archive.declaredIntegrity !== 'registry-on-acquisition' && !matchesIntegrity(archive.declaredIntegrity, checked))) die('offline archive failed integrity verification');
  }
  if (policy.stack === 'node' && policy.archives.length) {
    mkdirPrivate('/work/.cso-npm-cache');
    for (const archive of policy.archives) {
      const result = spawnSync('/usr/local/bin/npm', ['cache', 'add', archive.containerPath, '--cache', '/work/.cso-npm-cache', '--userconfig', '/opt/cso/empty-config', '--globalconfig', '/opt/cso/empty-config'],
        { cwd: '/work', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work/.cso-home', NPM_CONFIG_UPDATE_NOTIFIER: 'false' }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 });
      if (result.status !== 0 || result.error) die('offline npm cache seeding failed');
    }
  }
  if (policy.stack === 'bun') {
    await seedBunCache(policy.archives);
  }
  fs.writeFileSync('/work/.gstack-cso-preparation-ready', `${policy.planHash}\n`, { mode: 0o400, flag: 'wx' });
  await new Promise<void>(() => {});
}

function ready(): void {
  const stat = fs.lstatSync('/work/.gstack-cso-preparation-ready');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 65) die('offline preparation is not ready');
}

function finalize(): void {
  for (const path of ['/work/.cso-home', '/work/.cso-npm-cache', '/work/.cso-bun-cache', '/work/.cso-uv-cache', '/work/.gstack-cso-public-requirements.txt'])
    fs.rmSync(path, { recursive: true, force: true });
  fs.rmSync('/work/.gstack-cso-preparation-ready', { force: true });
  for (const path of ['/work/.cso-home', '/work/.cso-npm-cache', '/work/.cso-bun-cache', '/work/.cso-uv-cache', '/work/.gstack-cso-public-requirements.txt', '/work/.gstack-cso-preparation-ready'])
    if (fs.existsSync(path)) die('offline preparation scratch cleanup was incomplete');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' && !args.length) { process.stdout.write(`${VERSION}\n`); return; }
  if (command === 'forwarder' && args.length === 2) return forwarder(args[0], args[1]);
  if (command === 'health' && args.length === 2) return health(args[0], args[1]);
  if (command === 'manifest' && args.length === 3) return manifest(args[0], args[1], args[2]);
  if (command === 'seed' && args.length === 1) return seed(args[0]);
  if (command === 'ready' && !args.length) return ready();
  if (command === 'finalize' && !args.length) return finalize();
  if (command === 'export-prepared' && args.length === 3 && args[0] === '/work' && /^\/work\/\.gstack-cso-export-[a-f0-9]{24}$/.test(args[1]) && /^\d+$/.test(args[2])) {
    createPreparedExport(args[0], args[1], Number(args[2])); return;
  }
  die('usage: preparation {--version|forwarder|health|manifest|seed|ready|finalize|export-prepared}');
}

if (import.meta.main) main().catch(error => die(error instanceof Error ? error.message : 'preparation helper failed'));
