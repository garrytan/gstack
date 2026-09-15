import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import committedCatalog from '../lib/cso/runtime-catalog.json';
import buildInputs from '../lib/cso/images/build-inputs.json';
import { validateRuntimeCatalog } from '../lib/cso/runtime-catalog';
import { imageBuildMatrix, type ImageBuildRow } from '../scripts/cso-image-matrix';
import { catalogPromotionCandidate, validateRuntimeCatalogTransition, type RuntimeQualificationStatement } from '../scripts/cso-runtime-promotion';
import { assertVersionOutput, probesForBuildRow } from '../scripts/cso-verify-runtime-base';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function checks(row: ImageBuildRow): Record<string, true> {
  if (row.stack === 'postgresql') return {
    containmentPassed: true,
    coldStartPassed: true,
    multiDatabasePassed: true,
    readinessPassed: true,
    secretCanaryPassed: true,
    watchdogCleanupPassed: true,
  };
  const value: Record<string, true> = {
    accuracyGatesPassed: true,
    acquisitionPublicOnlyPassed: true,
    coldStartPassed: true,
    containmentPassed: true,
    heldOutRepairPassed: true,
    offlineLifecyclePassed: true,
    positiveNegativeAssertionsPassed: true,
    secretCanaryPassed: true,
    watchdogCleanupPassed: true,
  };
  if (row.stack === 'rails') {
    value.nativeExtensionsPassed = true;
    value.railsPostgresqlPassed = true;
    value.railsSqlitePassed = true;
  }
  return value;
}

function statements(): RuntimeQualificationStatement[] {
  return imageBuildMatrix(buildInputs).include.map(row => ({
    schemaVersion: 1,
    helperAbi: 3,
    state: 'qualified',
    buildRevision: row.inputRevision,
    runtimeId: row.runtimeId,
    stack: row.stack,
    platform: row.platform,
    image: `ghcr.io/garrytan/gstack/cso-staging/${row.stack}-${row.arch}@${digest(row.runtimeId)}`,
    versions: row.versions,
    sourceCommit: 'a'.repeat(40),
    workflow: 'https://github.com/garrytan/gstack/actions/runs/123456',
    qualifiedAt: '2026-09-10T12:00:00.000Z',
    sbomDigest: digest(`sbom:${row.runtimeId}`),
    provenanceDigest: digest(`provenance:${row.runtimeId}`),
    checks: checks(row),
  }));
}

describe('CSO runtime catalog promotion', () => {
  test('committed build review declares both native profiles without admitting unpublished images', () => {
    const matrix = imageBuildMatrix(buildInputs);
    expect(matrix.include).toHaveLength(10);
    expect(committedCatalog.profiles).toHaveLength(10);
    expect(committedCatalog.runtimes).toEqual([]);
    expect(committedCatalog.buildRevision).toBe(buildInputs.revision);
    expect(matrix.include.find(row => row.stack === 'bun')!.versions).not.toHaveProperty('node');
    validateRuntimeCatalog(committedCatalog);
  });

  test('complete same-run evidence generates a validated review candidate bound to its evidence', () => {
    const candidate = catalogPromotionCandidate(committedCatalog, buildInputs, statements());
    expect(candidate.previousRevision).toBe(committedCatalog.revision);
    expect(candidate.runtimes).toHaveLength(10);
    expect(candidate.promotion).toMatchObject({
      sourceCommit: 'a'.repeat(40),
      workflow: 'https://github.com/garrytan/gstack/actions/runs/123456',
    });
    expect(candidate.promotion!.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(candidate.promotion!.qualificationEvidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(candidate.runtimes.every(runtime => runtime.image.includes('@sha256:'))).toBe(true);
    validateRuntimeCatalog(candidate);
  });

  test('missing release checks, mutable images, and split qualification runs cannot be promoted', () => {
    const missing = statements();
    delete missing[0].checks.heldOutRepairPassed;
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, missing)).toThrow('MISSING_RELEASE_GATES');

    const mutable = statements();
    mutable[0].image = 'ghcr.io/garrytan/gstack/cso-staging/node-amd64:latest';
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, mutable)).toThrow('INVALID_QUALIFIED_IMAGE');

    const split = statements();
    split[0].workflow = 'https://github.com/garrytan/gstack/actions/runs/999999';
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, split)).toThrow('SPLIT_QUALIFICATION_RUN');

    const extra = statements() as Array<RuntimeQualificationStatement & { finding?: string }>;
    extra[0].finding = 'must not enter a public release artifact';
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, extra)).toThrow('INVALID_QUALIFICATION_STATEMENT_FIELDS');
  });

  test('qualification statements must match reviewed versions and every expected platform row', () => {
    const drift = statements();
    drift[0].versions = { ...drift[0].versions, node: '24.5.0' };
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, drift)).toThrow('QUALIFICATION_BUILD_MISMATCH');
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, statements().slice(1))).toThrow('INCOMPLETE_QUALIFICATION_MATRIX');
  });

  test('promotion is a compare-and-swap against the exact reviewed catalog revision', () => {
    const candidate = catalogPromotionCandidate(committedCatalog, buildInputs, statements());
    expect(() => validateRuntimeCatalogTransition(committedCatalog, candidate)).not.toThrow();
    expect(() => validateRuntimeCatalogTransition(
      { ...committedCatalog, revision: 'catalog-advanced-concurrently' },
      candidate,
    )).toThrow('RUNTIME_CATALOG_BASE_REVISION_MISMATCH');
    expect(() => validateRuntimeCatalogTransition(committedCatalog, {
      ...candidate,
      profiles: candidate.profiles.map((profile, index) => index === 0
        ? { ...profile, reviewedAt: '2026-09-11T00:00:00.000Z' }
        : profile),
    })).toThrow('RUNTIME_CATALOG_PROFILE_TRANSITION_MISMATCH');
  });

  test('retained promotion evidence rejects a post-generation runtime image substitution', () => {
    const candidate = catalogPromotionCandidate(committedCatalog, buildInputs, statements());
    const altered = structuredClone(candidate);
    altered.runtimes[0].image = altered.runtimes[0].image.replace(/[a-f0-9]{64}$/, 'e'.repeat(64));
    expect(altered.promotion!.evidenceDigest).toBe(candidate.promotion!.evidenceDigest);
    expect(() => validateRuntimeCatalog(altered)).toThrow('RUNTIME_PROMOTION_EVIDENCE_MISMATCH');
    expect(() => validateRuntimeCatalogTransition(committedCatalog, altered)).toThrow('RUNTIME_PROMOTION_EVIDENCE_MISMATCH');
  });
});

describe('CSO reviewed base version probes', () => {
  test('uses only real executables declared by each base profile', () => {
    const rows = imageBuildMatrix(buildInputs).include.filter(row => row.platform === 'linux/amd64');
    expect(probesForBuildRow(rows.find(row => row.stack === 'node')!).map(item => item.name)).toEqual(['node', 'npm']);
    expect(probesForBuildRow(rows.find(row => row.stack === 'bun')!).map(item => item.name)).toEqual(['bun']);
    expect(probesForBuildRow(rows.find(row => row.stack === 'python')!).map(item => item.name)).toEqual(['python', 'uv']);
    expect(probesForBuildRow(rows.find(row => row.stack === 'rails')!).map(item => item.name)).toEqual(['ruby', 'bundler']);
    expect(probesForBuildRow(rows.find(row => row.stack === 'postgresql')!).map(item => item.name)).toEqual(['postgresql']);
  });

  test('rejects a probe that reports any different release', () => {
    expect(() => assertVersionOutput('node', '24.4.0', 'v24.4.0\n')).not.toThrow();
    expect(() => assertVersionOutput('node', '24.4.0', 'v24.5.0\n')).toThrow('RUNTIME_VERSION_MISMATCH');
    expect(() => assertVersionOutput('bundler', '2.6.7', 'Bundler version 2.6.7\n')).not.toThrow();
  });
});
