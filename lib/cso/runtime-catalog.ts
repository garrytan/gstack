/** A runtime becomes executable only after trusted CI qualification and catalog review. */
import committedCatalog from './runtime-catalog.json';
import type { CsoStack, PreparationPlan } from './preparation';
import { CsoError, canonical, sha256 } from './contracts';

export const CSO_HELPER_ABI = 3;
export type RuntimePlatform = 'linux/amd64' | 'linux/arm64';

interface RuntimeQualificationProvenance {
  sourceCommit: string;
  workflow: string;
  sbomDigest: string;
  provenanceDigest: string;
  verifiedProvenance: true;
}
export type RuntimeQualification = RuntimeQualificationProvenance & (
  | { kind: 'application'; containmentPassed: true; coldStartPassed: true; positiveNegativeAssertionsPassed: true; heldOutRepairPassed: true }
  | { kind: 'postgresql'; containmentPassed: true; coldStartPassed: true; multiDatabasePassed: true; readinessPassed: true }
);
export interface QualifiedRuntime {
  id: string;
  stack: CsoStack | 'postgresql';
  platform: RuntimePlatform;
  state: 'qualified';
  image: string;
  entrypoint: '/opt/cso/entrypoint';
  helperAbi: number;
  versions: Record<string, string>;
  policyVersion: 'cso-isolation-v1';
  qualifiedAt: string;
  qualification: RuntimeQualification;
}
/** Reviewed build metadata is informative. It never makes an image executable. */
export interface ReviewedRuntimeProfile {
  id: string;
  stack: CsoStack | 'postgresql';
  platform: RuntimePlatform;
  state: 'build_reviewed';
  versions: Record<string, string>;
  reviewedAt: string;
}
export interface RuntimeCatalog {
  schemaVersion: 1;
  revision: string;
  previousRevision: string | null;
  helperAbi: number;
  buildRevision: string;
  profiles: ReviewedRuntimeProfile[];
  promotion?: {
    sourceCommit: string;
    workflow: string;
    /** Canonical digest of the retained executable runtime matrix. */
    evidenceDigest: string;
    /** Canonical digest of the complete release-gate statements retained externally. */
    qualificationEvidenceDigest: string;
  };
  runtimes: QualifiedRuntime[];
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const BUILD_REVISION = /^[a-z0-9][a-z0-9._-]{0,100}$/;
const STACKS = ['node', 'bun', 'python', 'rails', 'postgresql'] as const;
const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
const QUALIFICATION_WORKFLOW = /^https:\/\/github\.com\/garrytan\/gstack\/actions\/runs\/[0-9]+$/;
const REQUIRED: Record<string, string[]> = {
  node: ['node', 'npm', 'cso-preparation'],
  bun: ['bun', 'cso-preparation'],
  python: ['python', 'uv', 'cso-preparation'],
  rails: ['ruby', 'bundler', 'cso-preparation'],
  postgresql: ['postgresql'],
};

function versionsKey(versions: Record<string, string>): string {
  return JSON.stringify(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)));
}

function validateRuntimeIdentity(value: { id: string; stack: string; platform: string; versions: Record<string, string> }): void {
  if (typeof value.id !== 'string' || !ID.test(value.id)) throw new Error('INVALID_RUNTIME_ID');
  if (!STACKS.includes(value.stack as typeof STACKS[number]) || !PLATFORMS.includes(value.platform as RuntimePlatform)) throw new Error('UNSUPPORTED_RUNTIME_PLATFORM');
  if (!value.versions || typeof value.versions !== 'object' || Array.isArray(value.versions) || !Object.keys(value.versions).length ||
    Object.values(value.versions).some(version => typeof version !== 'string' || !/^[0-9][a-zA-Z0-9.+_-]*$/.test(version))) throw new Error('UNPINNED_RUNTIME_VERSION');
  if (Object.keys(value.versions).sort().join(',') !== [...REQUIRED[value.stack]].sort().join(',')) throw new Error('MISSING_RUNTIME_TOOL_VERSION');
  if (['node', 'bun', 'python', 'rails'].includes(value.stack) && value.versions['cso-preparation'] !== '1.0.0') throw new Error('INCOMPATIBLE_PREPARATION_HELPER');
}

export function validateRuntimeCatalog(value: unknown): asserts value is RuntimeCatalog {
  const catalog = value as RuntimeCatalog;
  if (!catalog || catalog.schemaVersion !== 1 || catalog.helperAbi !== CSO_HELPER_ABI ||
    typeof catalog.revision !== 'string' || !BUILD_REVISION.test(catalog.revision) || !Array.isArray(catalog.runtimes)) throw new Error('INCOMPATIBLE_RUNTIME_CATALOG');
  if (catalog.previousRevision !== null && (typeof catalog.previousRevision !== 'string' || !BUILD_REVISION.test(catalog.previousRevision))) throw new Error('INVALID_RUNTIME_CATALOG');

  if (!Array.isArray(catalog.profiles) || catalog.profiles.length !== STACKS.length * PLATFORMS.length ||
    typeof catalog.buildRevision !== 'string' || !BUILD_REVISION.test(catalog.buildRevision)) throw new Error('INVALID_REVIEWED_RUNTIME_PROFILES');
  const profiles = new Map<string, ReviewedRuntimeProfile>(), profileIdentities = new Set<string>();
  for (const profile of catalog.profiles) {
    validateRuntimeIdentity(profile);
    const identity = `${profile.stack}:${profile.platform}`;
    if (profiles.has(profile.id) || profileIdentities.has(identity) || profile.state !== 'build_reviewed' ||
      !Number.isFinite(Date.parse(profile.reviewedAt))) throw new Error('INVALID_REVIEWED_RUNTIME_PROFILE');
    profiles.set(profile.id, profile); profileIdentities.add(identity);
  }
  for (const stack of STACKS) for (const platform of PLATFORMS) {
    if (!profileIdentities.has(`${stack}:${platform}`)) throw new Error('INCOMPLETE_REVIEWED_RUNTIME_MATRIX');
  }
  if (catalog.promotion !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(catalog.promotion.sourceCommit) ||
      !QUALIFICATION_WORKFLOW.test(catalog.promotion.workflow) ||
      !DIGEST.test(catalog.promotion.evidenceDigest) ||
      !DIGEST.test(catalog.promotion.qualificationEvidenceDigest) ||
      Object.keys(catalog.promotion).sort().join(',') !==
        ['evidenceDigest', 'qualificationEvidenceDigest', 'sourceCommit', 'workflow'].sort().join(',')) {
      throw new Error('INVALID_RUNTIME_PROMOTION');
    }
  }

  if (catalog.runtimes.length !== 0 && catalog.runtimes.length !== STACKS.length * PLATFORMS.length) throw new Error('INCOMPLETE_QUALIFIED_RUNTIME_MATRIX');
  const ids = new Set<string>();
  const runtimeIdentities = new Set<string>();
  for (const runtime of catalog.runtimes) {
    const qualification = runtime?.qualification;
    if (!runtime) throw new Error('INVALID_RUNTIME_ID');
    validateRuntimeIdentity(runtime);
    const identity = `${runtime.stack}:${runtime.platform}`;
    if (ids.has(runtime.id) || runtimeIdentities.has(identity)) throw new Error('INVALID_RUNTIME_ID');
    ids.add(runtime.id); runtimeIdentities.add(identity);
    const arch = runtime.platform === 'linux/amd64' ? 'amd64' : 'arm64';
    const expectedImage = new RegExp(`^ghcr\\.io/garrytan/gstack/cso-staging/${runtime.stack}-${arch}@sha256:[a-f0-9]{64}$`);
    if (runtime.state !== 'qualified' || !IMAGE.test(runtime.image) || !expectedImage.test(runtime.image) || runtime.entrypoint !== '/opt/cso/entrypoint' ||
      runtime.helperAbi !== CSO_HELPER_ABI || runtime.policyVersion !== 'cso-isolation-v1') throw new Error('UNQUALIFIED_RUNTIME');
    const reviewed = profiles.get(runtime.id);
    if (!reviewed || reviewed.stack !== runtime.stack || reviewed.platform !== runtime.platform ||
      versionsKey(reviewed.versions) !== versionsKey(runtime.versions)) throw new Error('RUNTIME_BUILD_PROFILE_MISMATCH');
    if (!qualification || !/^[a-f0-9]{40}$/.test(qualification.sourceCommit) ||
      !QUALIFICATION_WORKFLOW.test(qualification.workflow) ||
      !DIGEST.test(qualification.sbomDigest) || !DIGEST.test(qualification.provenanceDigest) || qualification.verifiedProvenance !== true ||
      !Number.isFinite(Date.parse(runtime.qualifiedAt))) throw new Error('MISSING_RUNTIME_QUALIFICATION');
    const keys = Object.keys(qualification).sort();
    const common = ['kind', 'sourceCommit', 'workflow', 'sbomDigest', 'provenanceDigest', 'verifiedProvenance'];
    if (['node', 'bun', 'python', 'rails'].includes(runtime.stack)) {
      if (qualification.kind !== 'application' || qualification.containmentPassed !== true || qualification.coldStartPassed !== true ||
        qualification.positiveNegativeAssertionsPassed !== true || qualification.heldOutRepairPassed !== true ||
        keys.join(',') !== [...common, 'containmentPassed', 'coldStartPassed', 'positiveNegativeAssertionsPassed', 'heldOutRepairPassed'].sort().join(',')) throw new Error('MISSING_APPLICATION_QUALIFICATION');
    } else {
      if (qualification.kind !== 'postgresql' || qualification.containmentPassed !== true || qualification.coldStartPassed !== true ||
        qualification.multiDatabasePassed !== true || qualification.readinessPassed !== true ||
        keys.join(',') !== [...common, 'containmentPassed', 'coldStartPassed', 'multiDatabasePassed', 'readinessPassed'].sort().join(',')) throw new Error('MISSING_POSTGRESQL_QUALIFICATION');
    }
  }
  if (catalog.runtimes.length > 0) {
    for (const identity of profileIdentities) if (!runtimeIdentities.has(identity)) throw new Error('INCOMPLETE_QUALIFIED_RUNTIME_MATRIX');
    if (!catalog.promotion) throw new Error('MISSING_RUNTIME_PROMOTION');
    if (catalog.runtimes.some(runtime => runtime.qualification.sourceCommit !== catalog.promotion!.sourceCommit ||
      runtime.qualification.workflow !== catalog.promotion!.workflow)) throw new Error('RUNTIME_PROMOTION_MISMATCH');
    if (catalog.promotion.evidenceDigest !== `sha256:${sha256(canonical(catalog.runtimes))}`) {
      throw new Error('RUNTIME_PROMOTION_EVIDENCE_MISMATCH');
    }
  } else if (catalog.promotion) throw new Error('INVALID_RUNTIME_PROMOTION');
}

export const RUNTIME_CATALOG = committedCatalog as RuntimeCatalog;
validateRuntimeCatalog(RUNTIME_CATALOG);

export function assertRuntimeCompatible(plan: PreparationPlan, runtime: QualifiedRuntime): void {
  if (plan.schemaVersion !== 1 || plan.status !== 'ready' || runtime.stack !== plan.stack) throw new CsoError('INCOMPATIBLE_INPUT', `Prepared ${plan.stack} source cannot run in ${runtime.stack} runtime ${runtime.id}`);
  for (const [declared, rawRange] of Object.entries(plan.runtimeRequirements)) {
    if (!rawRange) continue;
    let tool = declared, range = rawRange;
    if (declared === 'packageManager') {
      const match = rawRange.match(/^([a-z][a-z0-9_-]*)@(.+)$/i);
      if (!match) throw new CsoError('PREREQUISITE', 'Package manager declaration must bind a named version range');
      tool = match[1]; range = match[2];
    }
    const version = runtime.versions[tool];
    if (!version) throw new CsoError('PREREQUISITE', `Qualified runtime ${runtime.id} does not declare a real ${tool} release`);
    let satisfies = false;
    try { satisfies = Bun.semver.satisfies(version.replace(/^v/, ''), range); } catch {}
    if (!satisfies) throw new CsoError('PREREQUISITE', `Qualified ${tool} ${version} does not satisfy source requirement ${range}`);
  }
}

export function selectRuntime(profile: string, platform: RuntimePlatform, catalog: RuntimeCatalog = RUNTIME_CATALOG): QualifiedRuntime {
  validateRuntimeCatalog(catalog);
  const matches = catalog.runtimes.filter(runtime => runtime.platform === platform && (runtime.id === profile || runtime.stack === profile));
  if (matches.length === 0) {
    const reviewed = catalog.profiles?.filter(item => item.platform === platform && (item.id === profile || item.stack === profile)) ?? [];
    const detail = reviewed.length === 1 ? ` Reviewed build profile ${reviewed[0].id} is awaiting a qualified image promotion.` : '';
    throw new Error(`MISSING_QUALIFIED_RUNTIME: ${profile} on ${platform}; build, qualify, and review a digest catalog before target execution.${detail}`);
  }
  if (matches.length !== 1) throw new Error(`AMBIGUOUS_RUNTIME: select an exact qualified runtime id for ${profile}.`);
  return matches[0];
}

/** Rollback only pairs the previous catalog with a compatible helper; reports have their own schema. */
export function rollbackCatalog(current: RuntimeCatalog, previous: RuntimeCatalog): RuntimeCatalog {
  validateRuntimeCatalog(current); validateRuntimeCatalog(previous);
  if (current.previousRevision !== previous.revision || current.helperAbi !== previous.helperAbi) throw new Error('INCOMPATIBLE_RUNTIME_ROLLBACK');
  return previous;
}
