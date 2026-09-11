/** Reviewed, helper-owned scanner images. Repository/model input cannot add entries. */
import { CsoError, ABI, canonical, sha256 } from './contracts';
import { ISOLATION_POLICY_HASH } from './docker';
import { SCANNER_IDS, ScannerId, scannerPlans } from './scanners';
import type { RuntimePlatform } from './runtime-catalog';
import committedCatalog from './scanner-images/catalog.json';

export interface QualifiedScanner {
  id: string;
  scanner: ScannerId;
  state: 'qualified';
  platform: RuntimePlatform;
  image: string;
  entrypoint: '/opt/cso/entrypoint';
  executable: string;
  version: string;
  /** Hash of canonical {stdout: trimmed version stdout, stderr: trimmed version stderr}. */
  versionOutputSha256: string;
  helperAbi: 3;
  isolationPolicyHash: string;
  capabilities: string[];
  /** Assets are baked into the immutable image, never acquired during a scan. */
  assets?: {
    semgrepRules?: { path: string; sha256: string };
    advisoryDatabase?: { path: string; contentSha256: string; updatedAt: string; ecosystems: string[] };
  };
  qualifiedAt: string;
  qualification: {
    sourceCommit: string;
    workflow: string;
    sbomDigest: string;
    provenanceDigest: string;
    verifiedProvenance: true;
    containmentPassed: true;
    adapterContractPassed: true;
    offlineAssetsPassed: true;
  };
}
export interface ScannerCatalog {
  schemaVersion: 1;
  revision: string;
  previousRevision?: string | null;
  helperAbi: 3;
  promotion?: {
    sourceCommit: string;
    workflow: string;
    evidenceDigest: string;
  };
  scanners: QualifiedScanner[];
}
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const QUALIFICATION_WORKFLOW = /^https:\/\/github\.com\/garrytan\/gstack\/actions\/runs\/[0-9]+$/;
const PLATFORMS: RuntimePlatform[] = ['linux/amd64', 'linux/arm64'];
const path = (s: unknown, prefix: string): s is string => typeof s === 'string' && s.startsWith(prefix) && !/[\x00-\x20\\,]/.test(s) && !s.split('/').some(x => x === '..' || x === '.') && !s.includes('//');
function invalid(message: string): never { throw new CsoError('INCOMPATIBLE_INPUT', message); }
function sameStrings(left: string[], right: string[]): boolean {
  return canonical([...left].sort()) === canonical([...right].sort());
}

export function scannerVersionHash(stdout: string, stderr = ''): string {
  return sha256(canonical({ stdout: stdout.trim(), stderr: stderr.trim() }));
}
/**
 * Accept the common scanner `--version` layouts while requiring the catalog
 * version to be one complete version token. A substring such as `1.2.3` in
 * `11.2.3`, `1.2.30`, or `1.2.3-dev` is not qualification evidence.
 */
export function assertScannerVersionOutput(scanner:ScannerId,version:string,stdout:string,stderr=''):void{
  if(!/^[0-9][A-Za-z0-9.+_-]{0,100}$/.test(version))invalid('Scanner version evidence has an invalid expected version');
  const output=`${stdout}\n${stderr}`;
  if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>8192)invalid('Scanner version evidence exceeds the bounded output limit');
  const escaped=version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const labels:Record<ScannerId,string>={gitleaks:'gitleaks',osv:'(?:osv|osv-scanner)',semgrep:'semgrep',zizmor:'zizmor',trivy:'trivy',schemathesis:'schemathesis'};
  const primary=output.split(/\r?\n/).map(line=>line.trim()).find(Boolean)??'';
  const exact=new RegExp(`^(?:v?${escaped}|${labels[scanner]},?\\s+(?:version\\s*:?\\s*)?v?${escaped}|version\\s*:\\s*v?${escaped})$`,'i');
  if(!exact.test(primary))invalid('Scanner primary version output does not match the exact catalog version');
}
export function validateQualifiedScanner(s: QualifiedScanner): void {
    if (!SCANNER_IDS.includes(s.scanner) || !['linux/amd64', 'linux/arm64'].includes(s.platform)) invalid('Unsupported scanner or platform');
    const arch = s.platform === 'linux/amd64' ? 'amd64' : 'arm64';
    const expectedImage = new RegExp(`^ghcr\\.io/garrytan/gstack/cso-scanners/${s.scanner}-${arch}@sha256:[a-f0-9]{64}$`);
    if (s.state !== 'qualified' || !IMAGE.test(s.image) || !expectedImage.test(s.image) || s.entrypoint !== '/opt/cso/entrypoint' || s.helperAbi !== ABI || s.isolationPolicyHash !== ISOLATION_POLICY_HASH) invalid('Scanner profile is not qualified for this helper isolation policy');
    if (s.executable !== '/opt/cso/bin/scanner' || !/^[0-9][A-Za-z0-9.+_-]{0,100}$/.test(s.version) || !HASH.test(s.versionOutputSha256)) invalid('Scanner executable and version must be pinned');
    if (!Array.isArray(s.capabilities) || !s.capabilities.length || s.capabilities.length > 100 || s.capabilities.some(x => typeof x !== 'string' || !x || x.length > 100)) invalid('Scanner capabilities must be reviewed');
    const required = scannerPlans({ snapshotRoot: '/source', offline: true, selected: [s.scanner] })[0].requiredFeatures;
    if (!sameStrings(s.capabilities, required)) invalid('Scanner capabilities do not match the helper adapter contract');
    const rules = s.assets?.semgrepRules, db = s.assets?.advisoryDatabase;
    if (rules && (s.scanner !== 'semgrep' || !path(rules.path, '/policy/catalog/') || !HASH.test(rules.sha256))) invalid('Invalid immutable Semgrep rules');
    if (db && (!['osv', 'trivy'].includes(s.scanner) || !path(db.path, '/opt/cso/scanner-data/') || !HASH.test(db.contentSha256) || !Number.isFinite(Date.parse(db.updatedAt)) || !Array.isArray(db.ecosystems) || !db.ecosystems.length || db.ecosystems.some(x => typeof x !== 'string' || !x || x.length > 100))) invalid('Invalid immutable scanner database');
    if (s.scanner === 'semgrep' && !rules) invalid('Qualified Semgrep profiles require an immutable rules bundle');
    if (['osv', 'trivy'].includes(s.scanner) && !db) invalid(`Qualified ${s.scanner} profiles require an immutable offline database`);
    const q = s.qualification;
    if (!Number.isFinite(Date.parse(s.qualifiedAt)) || !q || !/^[a-f0-9]{40}$/.test(q.sourceCommit) || !QUALIFICATION_WORKFLOW.test(q.workflow) || !DIGEST.test(q.sbomDigest) || !DIGEST.test(q.provenanceDigest) || q.verifiedProvenance !== true || q.containmentPassed !== true || q.adapterContractPassed !== true || q.offlineAssetsPassed !== true) invalid('Missing trusted scanner qualification');
}
export function validateScannerCatalog(value: unknown): asserts value is ScannerCatalog {
  const c = value as ScannerCatalog;
  if (!c || c.schemaVersion !== 1 || c.helperAbi !== ABI || typeof c.revision !== 'string' || !ID.test(c.revision) || !Array.isArray(c.scanners) || ![0, SCANNER_IDS.length * PLATFORMS.length].includes(c.scanners.length)) invalid('Incompatible scanner catalog');
  if (c.previousRevision !== undefined && c.previousRevision !== null && (typeof c.previousRevision !== 'string' || !ID.test(c.previousRevision) || c.previousRevision === c.revision)) invalid('Invalid previous scanner catalog revision');
  if (c.promotion !== undefined && (!/^[a-f0-9]{40}$/.test(c.promotion.sourceCommit) || !QUALIFICATION_WORKFLOW.test(c.promotion.workflow) || !DIGEST.test(c.promotion.evidenceDigest))) invalid('Invalid scanner catalog promotion');
  if (c.scanners.length === 0) {
    if (c.promotion !== undefined) invalid('Empty scanner catalog cannot have a promotion');
    return;
  }
  if (!c.promotion) invalid('Qualified scanner catalog requires trusted promotion evidence');
  const ids = new Set<string>(), identities = new Set<string>();
  for (const s of c.scanners) {
    if (!s || typeof s.id !== 'string' || !ID.test(s.id) || ids.has(s.id)) invalid('Invalid or duplicate scanner profile');
    const identity = `${s.scanner}:${s.platform}`;
    if (identities.has(identity)) invalid('Invalid or duplicate scanner profile');
    ids.add(s.id); identities.add(identity);
    validateQualifiedScanner(s);
    if (s.qualification.sourceCommit !== c.promotion.sourceCommit || s.qualification.workflow !== c.promotion.workflow) invalid('Scanner qualification does not match catalog promotion');
  }
  for (const scanner of SCANNER_IDS) for (const platform of PLATFORMS) if (!identities.has(`${scanner}:${platform}`)) invalid('Incomplete qualified scanner matrix');
  if (c.promotion.evidenceDigest !== `sha256:${sha256(canonical(c.scanners))}`) invalid('Scanner catalog promotion does not bind the qualified matrix');
}
export const SCANNER_CATALOG = committedCatalog as unknown as ScannerCatalog;
// A malformed source-controlled catalog must break the helper build/startup;
// it can never degrade into an unreviewed executable fallback.
validateScannerCatalog(SCANNER_CATALOG);
export function selectScanner(scanner: ScannerId, platform: RuntimePlatform, profile?: string, catalog: ScannerCatalog = SCANNER_CATALOG): QualifiedScanner {
  validateScannerCatalog(catalog);
  const matches = catalog.scanners.filter(s => s.scanner === scanner && s.platform === platform && (!profile || s.id === profile));
  if (!matches.length) throw new CsoError('PREREQUISITE', `No qualified ${scanner} image for ${platform}${profile ? ` (${profile})` : ''}; qualify and review an immutable scanner catalog before execution`);
  if (matches.length !== 1) throw new CsoError('PREREQUISITE', `Select an exact qualified ${scanner} profile for ${platform}`);
  return matches[0];
}
