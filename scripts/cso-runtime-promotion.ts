#!/usr/bin/env bun
/** Generate a reviewable catalog candidate from authenticated qualification statements. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonical, sha256 as sha256Hex } from '../lib/cso/contracts';
import committedCatalog from '../lib/cso/runtime-catalog.json';
import buildInputs from '../lib/cso/images/build-inputs.json';
import {
  CSO_HELPER_ABI,
  type QualifiedRuntime,
  type RuntimeCatalog,
  type RuntimeQualification,
  validateRuntimeCatalog,
} from '../lib/cso/runtime-catalog';
import { imageBuildMatrix, type ImageBuildRow } from './cso-image-matrix';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/;
const OUTPUT_IMAGE = /^ghcr\.io\/garrytan\/gstack\/cso-staging\/(node|bun|python|rails|postgresql)-(amd64|arm64)@sha256:[a-f0-9]{64}$/;
const MAX_EVIDENCE_FILES = 10;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

export interface RuntimeQualificationStatement {
  schemaVersion: 1;
  helperAbi: 3;
  state: 'qualified';
  buildRevision: string;
  runtimeId: string;
  stack: ImageBuildRow['stack'];
  platform: ImageBuildRow['platform'];
  image: string;
  versions: Record<string, string>;
  sourceCommit: string;
  workflow: string;
  qualifiedAt: string;
  sbomDigest: string;
  provenanceDigest: string;
  checks: Record<string, true>;
}

function sha256(value: string | Buffer): string {
  return `sha256:${sha256Hex(value)}`;
}

function versionsKey(value: Record<string, string>): string {
  return canonical(value);
}

function requiredChecks(stack: ImageBuildRow['stack']): string[] {
  if (stack === 'postgresql') return [
    'containmentPassed', 'coldStartPassed', 'multiDatabasePassed', 'readinessPassed',
    'secretCanaryPassed', 'watchdogCleanupPassed',
  ].sort();
  const common = [
    'accuracyGatesPassed', 'acquisitionPublicOnlyPassed', 'coldStartPassed', 'containmentPassed',
    'heldOutRepairPassed', 'offlineLifecyclePassed', 'positiveNegativeAssertionsPassed',
    'secretCanaryPassed', 'watchdogCleanupPassed',
  ];
  return stack === 'rails'
    ? [...common, 'nativeExtensionsPassed', 'railsPostgresqlPassed', 'railsSqlitePassed'].sort()
    : common.sort();
}

function qualification(statement: RuntimeQualificationStatement): RuntimeQualification {
  if (statement.stack === 'postgresql') return {
    kind: 'postgresql',
    sourceCommit: statement.sourceCommit,
    workflow: statement.workflow,
    sbomDigest: statement.sbomDigest,
    provenanceDigest: statement.provenanceDigest,
    verifiedProvenance: true,
    containmentPassed: true,
    coldStartPassed: true,
    multiDatabasePassed: true,
    readinessPassed: true,
  };
  return {
    kind: 'application',
    sourceCommit: statement.sourceCommit,
    workflow: statement.workflow,
    sbomDigest: statement.sbomDigest,
    provenanceDigest: statement.provenanceDigest,
    verifiedProvenance: true,
    containmentPassed: true,
    coldStartPassed: true,
    positiveNegativeAssertionsPassed: true,
    heldOutRepairPassed: true,
  };
}

function validateStatement(raw: unknown, row: ImageBuildRow): RuntimeQualificationStatement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_QUALIFICATION_STATEMENT');
  const statement = raw as RuntimeQualificationStatement;
  const expectedFields = [
    'buildRevision', 'checks', 'helperAbi', 'image', 'platform', 'provenanceDigest',
    'qualifiedAt', 'runtimeId', 'sbomDigest', 'schemaVersion', 'sourceCommit', 'stack',
    'state', 'versions', 'workflow',
  ];
  if (canonical(Object.keys(statement).sort()) !== canonical(expectedFields.sort())) throw new Error('INVALID_QUALIFICATION_STATEMENT_FIELDS');
  if (statement.schemaVersion !== 1 || statement.helperAbi !== CSO_HELPER_ABI || statement.state !== 'qualified') throw new Error('UNQUALIFIED_RUNTIME_EVIDENCE');
  if (statement.buildRevision !== row.inputRevision || statement.runtimeId !== row.runtimeId ||
    statement.stack !== row.stack || statement.platform !== row.platform ||
    versionsKey(statement.versions) !== versionsKey(row.versions)) throw new Error(`QUALIFICATION_BUILD_MISMATCH: ${row.runtimeId}`);
  if (!OUTPUT_IMAGE.test(statement.image) || !statement.image.includes(`/${row.stack}-${row.arch}@`)) throw new Error(`INVALID_QUALIFIED_IMAGE: ${row.runtimeId}`);
  if (!/^[a-f0-9]{40}$/.test(statement.sourceCommit) || !WORKFLOW.test(statement.workflow) ||
    !Number.isFinite(Date.parse(statement.qualifiedAt)) || !DIGEST.test(statement.sbomDigest) ||
    !DIGEST.test(statement.provenanceDigest)) throw new Error(`MISSING_QUALIFICATION_PROVENANCE: ${row.runtimeId}`);
  if (!statement.checks || typeof statement.checks !== 'object' || Array.isArray(statement.checks)) throw new Error(`MISSING_RELEASE_GATES: ${row.runtimeId}`);
  const expected = requiredChecks(row.stack);
  const actual = Object.keys(statement.checks).sort();
  if (canonical(actual) !== canonical(expected) || actual.some(key => statement.checks[key] !== true)) throw new Error(`MISSING_RELEASE_GATES: ${row.runtimeId}`);
  return statement;
}

export function catalogPromotionCandidate(
  currentValue: unknown,
  inputValue: unknown,
  evidenceValues: unknown[],
): RuntimeCatalog {
  validateRuntimeCatalog(currentValue);
  const current = currentValue as RuntimeCatalog;
  const rows = imageBuildMatrix(inputValue).include;
  if (!current.profiles || current.buildRevision !== rows[0].inputRevision) throw new Error('CATALOG_BUILD_REVISION_MISMATCH');
  const profiles = new Map(current.profiles.map(profile => [profile.id, profile]));
  if (profiles.size !== rows.length) throw new Error('CATALOG_PROFILE_MATRIX_MISMATCH');
  for (const row of rows) {
    const profile = profiles.get(row.runtimeId);
    if (!profile || profile.stack !== row.stack || profile.platform !== row.platform ||
      versionsKey(profile.versions) !== versionsKey(row.versions)) throw new Error(`CATALOG_PROFILE_MATRIX_MISMATCH: ${row.runtimeId}`);
  }
  if (evidenceValues.length !== rows.length) throw new Error('INCOMPLETE_QUALIFICATION_MATRIX');
  const byId = new Map<string, unknown>();
  for (const value of evidenceValues) {
    const id = (value as any)?.runtimeId;
    if (typeof id !== 'string' || byId.has(id)) throw new Error('DUPLICATE_QUALIFICATION_STATEMENT');
    byId.set(id, value);
  }
  const statements = rows.map(row => {
    if (!byId.has(row.runtimeId)) throw new Error(`MISSING_QUALIFICATION_STATEMENT: ${row.runtimeId}`);
    return validateStatement(byId.get(row.runtimeId), row);
  });
  const sourceCommits = new Set(statements.map(item => item.sourceCommit));
  const workflows = new Set(statements.map(item => item.workflow));
  if (sourceCommits.size !== 1 || workflows.size !== 1) throw new Error('SPLIT_QUALIFICATION_RUN');
  const sourceCommit = statements[0].sourceCommit;
  const workflow = statements[0].workflow;
  const runId = workflow.slice(workflow.lastIndexOf('/') + 1);
  const runtimes: QualifiedRuntime[] = statements.map(statement => ({
    id: statement.runtimeId,
    stack: statement.stack,
    platform: statement.platform,
    state: 'qualified',
    image: statement.image,
    entrypoint: '/opt/cso/entrypoint',
    helperAbi: CSO_HELPER_ABI,
    versions: statement.versions,
    policyVersion: 'cso-isolation-v1',
    qualifiedAt: statement.qualifiedAt,
    qualification: qualification(statement),
  }));
  const qualificationEvidenceDigest = sha256(canonical(statements));
  const evidenceDigest = sha256(canonical(runtimes));
  const candidate: RuntimeCatalog = {
    schemaVersion: 1,
    revision: `cso-v3-${runId}-${sourceCommit.slice(0, 12)}`,
    previousRevision: current.revision,
    helperAbi: CSO_HELPER_ABI,
    buildRevision: current.buildRevision,
    profiles: current.profiles,
    promotion: { sourceCommit, workflow, evidenceDigest, qualificationEvidenceDigest },
    runtimes,
  };
  validateRuntimeCatalog(candidate);
  return candidate;
}

/** A promotion may only replace the exact catalog revision it was generated from. */
export function validateRuntimeCatalogTransition(currentValue: unknown, proposedValue: unknown): void {
  validateRuntimeCatalog(currentValue);
  validateRuntimeCatalog(proposedValue);
  const current = currentValue as RuntimeCatalog;
  const proposed = proposedValue as RuntimeCatalog;
  if (!proposed.promotion || proposed.runtimes.length === 0) throw new Error('UNQUALIFIED_RUNTIME_CATALOG_PROMOTION');
  if (proposed.revision === current.revision || proposed.previousRevision !== current.revision) {
    throw new Error('RUNTIME_CATALOG_BASE_REVISION_MISMATCH');
  }
  if (proposed.buildRevision !== current.buildRevision ||
    canonical(proposed.profiles) !== canonical(current.profiles)) {
    throw new Error('RUNTIME_CATALOG_PROFILE_TRANSITION_MISMATCH');
  }
}

function collectEvidence(root: string): unknown[] {
  const absolute = path.resolve(root);
  const rootStat = fs.lstatSync(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('UNSAFE_EVIDENCE_ROOT');
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4) throw new Error('EVIDENCE_TREE_TOO_DEEP');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('UNSAFE_EVIDENCE_ENTRY');
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.name === 'qualified-runtime.json') files.push(file);
      if (files.length > MAX_EVIDENCE_FILES) throw new Error('TOO_MANY_QUALIFICATION_STATEMENTS');
    }
  };
  visit(absolute, 0);
  return files.sort().map(file => {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_EVIDENCE_BYTES) throw new Error('UNSAFE_QUALIFICATION_STATEMENT');
    const body = fs.readFileSync(file, 'utf8');
    const after = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('QUALIFICATION_EVIDENCE_RACE');
    try { return JSON.parse(body); } catch { throw new Error('INVALID_QUALIFICATION_STATEMENT'); }
  });
}

function readCatalogArtifact(file: string): unknown {
  const absolute = path.resolve(file);
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_EVIDENCE_BYTES) {
    throw new Error('UNSAFE_RUNTIME_CATALOG_ARTIFACT');
  }
  const body = fs.readFileSync(absolute, 'utf8');
  const after = fs.lstatSync(absolute);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
    before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs) throw new Error('RUNTIME_CATALOG_ARTIFACT_RACE');
  try { return JSON.parse(body); } catch { throw new Error('INVALID_RUNTIME_CATALOG_ARTIFACT'); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'validate-transition') {
      if (args.length !== 3) throw new Error('Usage: cso-runtime-promotion.ts validate-transition <current-catalog> <proposed-catalog>');
      validateRuntimeCatalogTransition(readCatalogArtifact(args[1]), readCatalogArtifact(args[2]));
      process.stdout.write('VALID TRANSITION\n');
    } else {
      if (args.length !== 4 || args[0] !== '--evidence-root' || args[2] !== '--output') {
        throw new Error('Usage: cso-runtime-promotion.ts --evidence-root <directory> --output <new-file>');
      }
      const candidate = catalogPromotionCandidate(committedCatalog, buildInputs, collectEvidence(args[1]));
      const output = path.resolve(args[3]);
      fs.writeFileSync(output, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${output}\n`);
    }
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'RUNTIME_PROMOTION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
