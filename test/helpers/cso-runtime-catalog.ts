import type { CsoStack } from '../../lib/cso/preparation';
import { canonical, sha256 } from '../../lib/cso/contracts';
import {
  CSO_HELPER_ABI,
  type QualifiedRuntime,
  type RuntimeCatalog,
  type RuntimePlatform,
} from '../../lib/cso/runtime-catalog';

const STACKS = ['node', 'bun', 'python', 'rails', 'postgresql'] as const;
const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
const SOURCE_COMMIT = 'b'.repeat(40);
const WORKFLOW = 'https://github.com/garrytan/gstack/actions/runs/1';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const VERSIONS: Record<CsoStack | 'postgresql', Record<string, string>> = {
  node: { node: '24.1.0', npm: '11.3.0', 'cso-preparation': '1.0.0' },
  bun: { bun: '1.3.10', 'cso-preparation': '1.0.0' },
  python: { python: '3.12.9', uv: '0.8.0', 'cso-preparation': '1.0.0' },
  rails: { ruby: '3.3.6', bundler: '2.6.9', 'cso-preparation': '1.0.0' },
  postgresql: { postgresql: '17.2' },
};

function runtimeId(stack: CsoStack | 'postgresql', platform: RuntimePlatform): string {
  return `${stack}-qualified-test-${platform === 'linux/amd64' ? 'amd64' : 'arm64'}`;
}

export function qualifiedRuntimeFixture(
  stack: CsoStack | 'postgresql',
  platform: RuntimePlatform = 'linux/amd64',
): QualifiedRuntime {
  const arch = platform === 'linux/amd64' ? 'amd64' : 'arm64';
  const qualification = stack === 'postgresql'
    ? {
        kind: 'postgresql' as const,
        sourceCommit: SOURCE_COMMIT,
        workflow: WORKFLOW,
        sbomDigest: DIGEST,
        provenanceDigest: DIGEST,
        verifiedProvenance: true as const,
        containmentPassed: true as const,
        coldStartPassed: true as const,
        multiDatabasePassed: true as const,
        readinessPassed: true as const,
      }
    : {
        kind: 'application' as const,
        sourceCommit: SOURCE_COMMIT,
        workflow: WORKFLOW,
        sbomDigest: DIGEST,
        provenanceDigest: DIGEST,
        verifiedProvenance: true as const,
        containmentPassed: true as const,
        coldStartPassed: true as const,
        positiveNegativeAssertionsPassed: true as const,
        heldOutRepairPassed: true as const,
      };

  return {
    id: runtimeId(stack, platform),
    stack,
    platform,
    state: 'qualified',
    image: `ghcr.io/garrytan/gstack/cso-staging/${stack}-${arch}@${DIGEST}`,
    entrypoint: '/opt/cso/entrypoint',
    helperAbi: CSO_HELPER_ABI,
    versions: { ...VERSIONS[stack] },
    policyVersion: 'cso-isolation-v1',
    qualifiedAt: '2026-09-09T00:00:00Z',
    qualification,
  };
}

/** A fresh catalog satisfying the complete reviewed and promoted runtime matrices. */
export function completeRuntimeCatalogFixture(
  revision = 'runtime-test-v1',
  previousRevision: string | null = null,
): RuntimeCatalog {
  const runtimes = STACKS.flatMap(stack => PLATFORMS.map(platform => qualifiedRuntimeFixture(stack, platform)));
  return {
    schemaVersion: 1,
    revision,
    previousRevision,
    helperAbi: CSO_HELPER_ABI,
    buildRevision: 'runtime-test-build-v1',
    profiles: runtimes.map(runtime => ({
      id: runtime.id,
      stack: runtime.stack,
      platform: runtime.platform,
      state: 'build_reviewed' as const,
      versions: { ...runtime.versions },
      reviewedAt: '2026-09-08T00:00:00Z',
    })),
    promotion: {
      sourceCommit: SOURCE_COMMIT,
      workflow: WORKFLOW,
      evidenceDigest: `sha256:${sha256(canonical(runtimes))}`,
      qualificationEvidenceDigest: DIGEST,
    },
    runtimes,
  };
}
