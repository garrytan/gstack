#!/usr/bin/env bun
/** Validate reviewed scanner inputs before any image is built or published. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCANNER_IDS, ScannerId, scannerPlans } from '../lib/cso/scanners';

const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
const IMAGE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9][A-Za-z0-9.+_-]{0,100}$/;
const EXECUTABLE = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,100}$/;
const SIGNER_WORKFLOW = /^(?:github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.\/-]+\.ya?ml$/;

type Platform = typeof PLATFORMS[number];
type AssetDeclaration = {
  semgrepRules?: { path: string; sha256: string };
  advisoryDatabase?: { path: string; contentSha256: string; updatedAt: string; ecosystems: string[] };
};
export type ReviewedAttestedImage = {
  image: string;
  repository: string;
  sourceCommit: string;
  release: string;
  signerWorkflow: string;
  signerDigest: string;
  provenanceStatementDigest: string;
  sbomStatementDigest: string;
};
export interface ScannerBuildRow {
  scanner: ScannerId;
  platform: Platform;
  arch: 'amd64' | 'arm64';
  runner: 'ubuntu-24.04' | 'ubuntu-24.04-arm';
  baseImage: string;
  scannerExecutable: string;
  version: string;
  capabilities: string[];
  assets: AssetDeclaration | null;
  applicationExecutable: string;
  sbomGenerator: ReviewedAttestedImage;
  baseAttestation: ReviewedAttestedImage;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: string[], code: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(code);
}
function safePath(value: unknown, prefix: string, code: string): string {
  if (typeof value !== 'string' || !EXECUTABLE.test(value) || !value.startsWith(prefix) || value.split('/').includes('..')) throw new Error(code);
  return value;
}
function digest(value: unknown, code: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(code);
  return value;
}
function attestedImage(value:unknown,code:string):ReviewedAttestedImage{
  const raw=object(value,code);exact(raw,['image','repository','sourceCommit','release','signerWorkflow','signerDigest','provenanceStatementDigest','sbomStatementDigest'],code);
  if(typeof raw.image!=='string'||!IMAGE.test(raw.image)||typeof raw.repository!=='string'||!REPOSITORY.test(raw.repository)||
    typeof raw.sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(raw.sourceCommit)||typeof raw.release!=='string'||!ID.test(raw.release)||
    typeof raw.signerWorkflow!=='string'||!SIGNER_WORKFLOW.test(raw.signerWorkflow)||typeof raw.signerDigest!=='string'||!/^[a-f0-9]{40}$/.test(raw.signerDigest))throw new Error(code);
  return{image:raw.image,repository:raw.repository,sourceCommit:raw.sourceCommit,release:raw.release,signerWorkflow:raw.signerWorkflow,signerDigest:raw.signerDigest,
    provenanceStatementDigest:digest(raw.provenanceStatementDigest,code),sbomStatementDigest:digest(raw.sbomStatementDigest,code)};
}
function assets(value: unknown, scanner: ScannerId): AssetDeclaration | null {
  if (value === undefined || value === null) {
    if (['semgrep', 'osv', 'trivy'].includes(scanner)) throw new Error(`MISSING_OFFLINE_ASSET: ${scanner}`);
    return null;
  }
  const raw = object(value, 'INVALID_SCANNER_ASSET'); exact(raw, ['semgrepRules', 'advisoryDatabase'], 'INVALID_SCANNER_ASSET');
  if (scanner === 'semgrep') {
    const rules = object(raw.semgrepRules, 'MISSING_SEMGREP_RULES'); exact(rules, ['path', 'sha256'], 'INVALID_SEMGREP_RULES');
    if (raw.advisoryDatabase !== undefined) throw new Error('INVALID_SEMGREP_RULES');
    const path = safePath(rules.path, '/policy/catalog/', 'INVALID_SEMGREP_RULES');
    if (typeof rules.sha256 !== 'string' || !HASH.test(rules.sha256)) throw new Error('INVALID_SEMGREP_RULES');
    return { semgrepRules: { path, sha256: rules.sha256 } };
  }
  if (scanner === 'osv' || scanner === 'trivy') {
    const db = object(raw.advisoryDatabase, 'MISSING_ADVISORY_DATABASE'); exact(db, ['path', 'contentSha256', 'updatedAt', 'ecosystems'], 'INVALID_ADVISORY_DATABASE');
    if (raw.semgrepRules !== undefined) throw new Error('INVALID_ADVISORY_DATABASE');
    const path = safePath(db.path, '/opt/cso/scanner-data/', 'INVALID_ADVISORY_DATABASE');
    if (typeof db.contentSha256 !== 'string' || !HASH.test(db.contentSha256) || typeof db.updatedAt !== 'string' || !Number.isFinite(Date.parse(db.updatedAt)) || !Array.isArray(db.ecosystems) || !db.ecosystems.length || new Set(db.ecosystems).size !== db.ecosystems.length || db.ecosystems.some(item => typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(item))) throw new Error('INVALID_ADVISORY_DATABASE');
    return { advisoryDatabase: { path, contentSha256: db.contentSha256, updatedAt: new Date(db.updatedAt).toISOString(), ecosystems: (db.ecosystems as string[]).slice().sort() } };
  }
  throw new Error(`UNEXPECTED_OFFLINE_ASSET: ${scanner}`);
}

/** Every scanner must have both native platforms; partial matrices cannot publish. */
export function scannerBuildMatrix(input: unknown): { include: ScannerBuildRow[] } {
  const data = object(input, 'INVALID_SCANNER_BUILD_INPUTS');
  exact(data, ['schemaVersion', 'helperAbi', 'state', 'sbomGenerator', 'profiles', 'instructions'], 'INVALID_SCANNER_BUILD_INPUTS');
  if (data.schemaVersion !== 1 || data.helperAbi !== 3) throw new Error('INCOMPATIBLE_SCANNER_BUILD_INPUTS');
  if (data.state !== 'reviewed') throw new Error('MISSING_REVIEWED_SCANNER_INPUTS: review immutable images, assets, versions, SBOMs, and provenance before staging.');
  const sbomGenerator=attestedImage(data.sbomGenerator,'UNVERIFIED_SBOM_GENERATOR');
  if (!Array.isArray(data.profiles) || data.profiles.length !== SCANNER_IDS.length) throw new Error('INCOMPLETE_SCANNER_MATRIX');
  const rows: ScannerBuildRow[] = [], seen = new Set<ScannerId>();
  for (const value of data.profiles) {
    const profile = object(value, 'INVALID_SCANNER_PROFILE');
    exact(profile, ['scanner', 'version', 'baseImages', 'executable', 'assets', 'applicationExecutable'], 'INVALID_SCANNER_PROFILE');
    const scanner = profile.scanner as ScannerId;
    if (!SCANNER_IDS.includes(scanner) || seen.has(scanner)) throw new Error('INVALID_OR_DUPLICATE_SCANNER');
    seen.add(scanner);
    if (typeof profile.version !== 'string' || !VERSION.test(profile.version)) throw new Error(`UNPINNED_SCANNER_VERSION: ${scanner}`);
    if (typeof profile.executable !== 'string' || !EXECUTABLE.test(profile.executable)) throw new Error(`INVALID_SCANNER_EXECUTABLE: ${scanner}`);
    const baseImages = object(profile.baseImages, `MISSING_SCANNER_IMAGES: ${scanner}`);
    exact(baseImages, [...PLATFORMS], `INVALID_SCANNER_IMAGES: ${scanner}`);
    const declaredAssets = assets(profile.assets, scanner);
    const applicationExecutable = scanner === 'schemathesis' ? safePath(profile.applicationExecutable, '/', 'MISSING_SCHEMATHESIS_FIXTURE_RUNTIME') : '';
    if (scanner !== 'schemathesis' && profile.applicationExecutable !== undefined) throw new Error(`UNEXPECTED_APPLICATION_EXECUTABLE: ${scanner}`);
    const capabilities = scannerPlans({ snapshotRoot: '/source', offline: true, selected: [scanner] })[0].requiredFeatures.slice().sort();
    for (const platform of PLATFORMS) {
      const baseAttestation=attestedImage(baseImages[platform],`INVALID_UPSTREAM_EVIDENCE: ${scanner} ${platform}`),baseImage=baseAttestation.image;
      const arch = platform === 'linux/amd64' ? 'amd64' : 'arm64';
      rows.push({ scanner, platform, arch, runner: arch === 'amd64' ? 'ubuntu-24.04' : 'ubuntu-24.04-arm', baseImage, scannerExecutable: profile.executable, version: profile.version, capabilities, assets: declaredAssets, applicationExecutable, sbomGenerator, baseAttestation });
    }
  }
  return { include: rows };
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error('No arguments accepted; scanner inputs come from the reviewed repository file.');
    const file = resolve(import.meta.dir, '../lib/cso/scanner-images/build-inputs.json');
    process.stdout.write(JSON.stringify(scannerBuildMatrix(JSON.parse(readFileSync(file, 'utf8')))) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'INVALID_SCANNER_BUILD_INPUTS') + '\n');
    process.exitCode = 1;
  }
}
