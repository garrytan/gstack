#!/usr/bin/env bun
/** Assemble and validate a complete source-controlled scanner catalog proposal. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { canonical, sha256 } from '../lib/cso/contracts';
import { QualifiedScanner, ScannerCatalog, scannerVersionHash, validateQualifiedScanner, validateScannerCatalog } from '../lib/cso/scanner-catalog';
import { SCANNER_IDS, scannerPlans } from '../lib/cso/scanners';

const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
const REVISION = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const WORKFLOW = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/;
const MAX_ARTIFACT = 1_048_576;
const MAX_TREE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size;
}
function hashRegularFile(path: string, expected: fs.Stats): string {
  const hash = createHash('sha256'), fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !sameFile(expected, before)) throw new Error('UNSAFE_SCANNER_ASSET');
    const buffer = Buffer.alloc(1024 * 1024); let count = 0, bytes = 0;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > expected.size || bytes > MAX_TREE_BYTES) throw new Error('SCANNER_ASSET_LIMIT');
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd), pathname = fs.lstatSync(path);
    if (bytes !== expected.size || !sameFile(before, after) || !sameFile(after, pathname)) throw new Error('UNSAFE_SCANNER_ASSET');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function sameStrings(left: string[], right: string[]): boolean {
  return canonical([...left].sort()) === canonical([...right].sort());
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`UNEXPECTED_${label.toUpperCase()}_FIELD`);
}
function strictProfile(value: unknown): QualifiedScanner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SCANNER_FRAGMENT');
  const profile = value as QualifiedScanner & Record<string, unknown>;
  exactKeys(profile, ['id', 'scanner', 'state', 'platform', 'image', 'entrypoint', 'executable', 'version', 'versionOutputSha256', 'helperAbi', 'isolationPolicyHash', 'capabilities', 'assets', 'qualifiedAt', 'qualification'], 'scanner_profile');
  if (!profile.qualification || typeof profile.qualification !== 'object' || Array.isArray(profile.qualification)) throw new Error('INVALID_SCANNER_QUALIFICATION');
  exactKeys(profile.qualification as unknown as Record<string, unknown>, ['sourceCommit', 'workflow', 'sbomDigest', 'provenanceDigest', 'verifiedProvenance', 'containmentPassed', 'adapterContractPassed', 'offlineAssetsPassed'], 'scanner_qualification');
  if (profile.assets !== undefined) {
    if (!profile.assets || typeof profile.assets !== 'object' || Array.isArray(profile.assets)) throw new Error('INVALID_SCANNER_ASSETS');
    exactKeys(profile.assets as unknown as Record<string, unknown>, ['semgrepRules', 'advisoryDatabase'], 'scanner_assets');
    for (const [name, asset] of Object.entries(profile.assets)) {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new Error('INVALID_SCANNER_ASSETS');
      exactKeys(asset as unknown as Record<string, unknown>, name === 'semgrepRules' ? ['path', 'sha256'] : ['path', 'contentSha256', 'updatedAt', 'ecosystems'], 'scanner_asset');
    }
  }
  validateQualifiedScanner(profile);
  const required = scannerPlans({ snapshotRoot: '/source', offline: true, selected: [profile.scanner] })[0].requiredFeatures;
  if (!sameStrings(profile.capabilities, required)) throw new Error(`CAPABILITY_CONTRACT_MISMATCH: ${profile.scanner}`);
  return profile;
}

export function scannerCatalogProposal(current: ScannerCatalog, fragments: unknown[], revision: string, expected: { sourceCommit: string; workflow: string; imagePrefix: string }): ScannerCatalog {
  validateScannerCatalog(current);
  if (!REVISION.test(revision) || revision === current.revision) throw new Error('INVALID_SCANNER_CATALOG_REVISION');
  if (!expected || !/^[a-f0-9]{40}$/.test(expected.sourceCommit)) throw new Error('INVALID_EXPECTED_SOURCE_COMMIT');
  if (!WORKFLOW.test(expected.workflow) || !expected.workflow.startsWith('https://github.com/garrytan/gstack/actions/runs/')) throw new Error('INVALID_EXPECTED_WORKFLOW');
  if (expected.imagePrefix !== 'ghcr.io/garrytan/gstack/cso-scanners/') throw new Error('INVALID_EXPECTED_IMAGE_PREFIX');
  const scanners = fragments.map(strictProfile), identities = new Set<string>();
  if (scanners.length !== SCANNER_IDS.length * PLATFORMS.length) throw new Error('INCOMPLETE_SCANNER_CATALOG_MATRIX');
  for (const profile of scanners) {
    const identity = `${profile.scanner}:${profile.platform}`;
    if (identities.has(identity)) throw new Error(`DUPLICATE_SCANNER_CATALOG_PROFILE: ${identity}`);
    identities.add(identity);
    if (profile.qualification.sourceCommit !== expected.sourceCommit) throw new Error(`SOURCE_COMMIT_MISMATCH: ${identity}`);
    if (profile.qualification.workflow !== expected.workflow) throw new Error(`WORKFLOW_IDENTITY_MISMATCH: ${identity}`);
    if (!profile.image.startsWith(expected.imagePrefix)) throw new Error(`IMAGE_REPOSITORY_MISMATCH: ${identity}`);
  }
  for (const scanner of SCANNER_IDS) for (const platform of PLATFORMS) if (!identities.has(`${scanner}:${platform}`)) throw new Error(`MISSING_SCANNER_CATALOG_PROFILE: ${scanner}:${platform}`);
  scanners.sort((a, b) => a.scanner.localeCompare(b.scanner) || a.platform.localeCompare(b.platform));
  const proposal: ScannerCatalog = {
    schemaVersion: 1,
    revision,
    previousRevision: current.revision,
    helperAbi: 3,
    promotion: { sourceCommit: expected.sourceCommit, workflow: expected.workflow, evidenceDigest: `sha256:${sha256(canonical(scanners))}` },
    scanners,
  };
  validateScannerCatalog(proposal);
  return proposal;
}

/** Promotion is a compare-and-swap against the catalog revision reviewed by qualification. */
export function validateScannerCatalogTransition(current: ScannerCatalog, proposed: ScannerCatalog): void {
  validateScannerCatalog(current); validateScannerCatalog(proposed);
  if (proposed.revision === current.revision || proposed.previousRevision !== current.revision)
    throw new Error('SCANNER_CATALOG_BASE_REVISION_MISMATCH');
}

function readJson(path: string): unknown {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARTIFACT) throw new Error(`UNSAFE_CATALOG_ARTIFACT: ${basename(path)}`);
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}
function fragments(directory: string): unknown[] {
  const root = fs.realpathSync(directory), values: unknown[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!/^[a-z0-9._-]+\.json$/.test(name)) throw new Error(`UNSAFE_FRAGMENT_NAME: ${name}`);
    values.push(readJson(join(root, name)));
  }
  return values;
}

/** A file hashes as its bytes; a directory hashes a canonical regular-file inventory. */
export function scannerAssetHash(path: string): string {
  const supplied = fs.lstatSync(path);
  if (supplied.isSymbolicLink()) throw new Error('UNSAFE_SCANNER_ASSET');
  const root = fs.realpathSync(path), initial = fs.lstatSync(root);
  if (initial.isFile()) {
    if (initial.nlink !== 1 || initial.size > MAX_TREE_BYTES) throw new Error('UNSAFE_SCANNER_ASSET');
    return hashRegularFile(root, initial);
  }
  if (!initial.isDirectory()) throw new Error('UNSAFE_SCANNER_ASSET');
  const entries: Array<[string, number, string]> = [], pending = [root]; let bytes = 0, objects = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const item of fs.readdirSync(directory).sort()) {
      const full = join(directory, item), stat = fs.lstatSync(full), rel = relative(root, full).split(sep).join('/');
      if (!rel || rel.startsWith('../') || stat.isSymbolicLink() || ++objects > MAX_TREE_ENTRIES) throw new Error('UNSAFE_SCANNER_ASSET');
      if (stat.isDirectory()) { pending.push(full); continue; }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('UNSAFE_SCANNER_ASSET');
      bytes += stat.size;
      if (bytes > MAX_TREE_BYTES) throw new Error('SCANNER_ASSET_LIMIT');
      entries.push([rel, stat.size, hashRegularFile(full, stat)]);
    }
  }
  if (!entries.length) throw new Error('EMPTY_SCANNER_ASSET');
  entries.sort(([left], [right]) => left.localeCompare(right));
  return sha256(canonical(entries));
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name); if (at < 0) return undefined;
  const value = args[at + 1]; if (!value || value.startsWith('--')) throw new Error(`MISSING_${name.slice(2).toUpperCase().replaceAll('-', '_')}`);
  args.splice(at, 2); return value;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), command = args.shift();
    if (command === 'validate') {
      const path = args.shift(); if (!path || args.length) throw new Error('Usage: validate CATALOG.json');
      const value = readJson(resolve(path)); validateScannerCatalog(value); process.stdout.write('VALID\n');
    } else if (command === 'validate-transition') {
      const current = args.shift(), proposed = args.shift(); if (!current || !proposed || args.length) throw new Error('Usage: validate-transition CURRENT.json PROPOSED.json');
      validateScannerCatalogTransition(readJson(resolve(current)) as ScannerCatalog, readJson(resolve(proposed)) as ScannerCatalog); process.stdout.write('VALID TRANSITION\n');
    } else if (command === 'assemble') {
      const directory = args.shift(), currentPath = args.shift(), output = args.shift(), revision = option(args, '--revision'), sourceCommit = option(args, '--source-commit'), workflow = option(args, '--workflow'), imagePrefix = option(args, '--image-prefix');
      if (!directory || !currentPath || !output || !revision || !sourceCommit || !workflow || !imagePrefix || args.length) throw new Error('Usage: assemble FRAGMENTS CURRENT OUTPUT --revision ID --source-commit SHA --workflow URL --image-prefix PREFIX');
      const proposal = scannerCatalogProposal(readJson(resolve(currentPath)) as ScannerCatalog, fragments(resolve(directory)), revision, { sourceCommit, workflow, imagePrefix });
      fs.writeFileSync(resolve(output), JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${proposal.scanners.length} QUALIFIED PROFILES\n`);
    } else if (command === 'hash-asset') {
      const path = args.shift(); if (!path || args.length) throw new Error('Usage: hash-asset PATH'); process.stdout.write(scannerAssetHash(resolve(path)) + '\n');
    } else if (command === 'version-hash') {
      const stdout = args.shift(), stderr = args.shift(); if (!stdout || !stderr || args.length) throw new Error('Usage: version-hash STDOUT STDERR');
      const read = (path: string) => { const stat = fs.lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('UNSAFE_VERSION_OUTPUT'); return fs.readFileSync(path, 'utf8'); };
      process.stdout.write(scannerVersionHash(read(resolve(stdout)), read(resolve(stderr))) + '\n');
    } else throw new Error('Usage: cso-scanner-catalog <validate|validate-transition|assemble|hash-asset|version-hash> ...');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'SCANNER_CATALOG_ERROR') + '\n'); process.exitCode = 1;
  }
}
