#!/usr/bin/env bun
/** Trusted corpus preparation, producer receipt collection, and objective result accounting. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readBoundedStable } from '../lib/cso/bounded-file';
import { executable } from '../lib/cso/process';
import { atomicWriteSync } from '../lib/fs-atomic';
import { loadCorpusManifest, materializeCase, sourceFiles, STACKS, type CorpusManifest, type EvalStack, type EvalVariant } from '../test/fixtures/cso-eval/materialize';
import {
  producerArtifactInventoryHash,
  producerInputHash,
  producerInstallationIdentityHash,
  producerProviderIdentityHash,
  producerReceiptHash,
  sha256,
  type ProducerCell,
  type ProducerArtifactInventory,
  type ProducerHost,
  type ProducerInput,
  type ProducerInstallationIdentity,
  type ProducerProviderIdentity,
  type ProducerReceipt,
  type ProducerReceiptIndex,
  type ProducerSourceEntry,
} from './cso-eval-protocol';

export type EvalVersion = 'v2' | 'v3';
export type EvalMode = 'daily' | 'comprehensive';
export type Outcome = 'passed' | 'failed' | 'blocked' | 'not_attempted';
export interface EvalCell extends ProducerCell {
  id: string; caseId: string; stack: EvalStack; variant: EvalVariant; version: EvalVersion; mode: EvalMode;
  repetition: 1 | 2 | 3; model: string; host: ProducerHost; budgetSeconds: number; sourceHash: string; skillHash: string;
}
export interface EvalMatrix {
  schemaVersion: 1; corpusVersion: string; corpusHash: string; model: string; host: ProducerHost;
  budgets: { daily: number; comprehensive: number }; skillHashes: { v2: string; v3: string }; repetitions: 3; cells: EvalCell[];
}
export interface PortableSkillFile {
  path: string;
  contents: string;
}
export interface PortableSkillFileIdentity {
  path: string;
  sha256: string;
  bytes: number;
}
export interface PortableSkillPayloadIdentity {
  schemaVersion: 1;
  version: EvalVersion;
  files: PortableSkillFileIdentity[];
}
export interface EvalFinding {
  id: string; evidence: 'supported' | 'hypothesis' | 'legacy_review'; claimedTested: boolean;
  /** Written only by the independent evaluator after reviewing the reported trace. */
  judgment: 'correct' | 'incorrect' | 'unadjudicated'; matchedCaseId?: string;
  /**
   * Written only by the independent evaluator.  A producer's tested claim is
   * valid only when this finding, rather than merely another finding in the
   * same corpus cell, owns the trusted repair and recheck observations.
   */
  trustedVerification?: {
    repair: Outcome;
    repairEvidenceHash?: string;
    recheck: Outcome;
    recheckEvidenceHash?: string;
  };
}
export interface EvalResult {
  cellId: string; sourceHash: string; skillHash: string; model: string; host: string; budgetSeconds: number;
  reportPresent: boolean; reportComplete: boolean; findings: EvalFinding[];
  setup: Outcome; reproduction: Outcome; repair: Outcome; recheck: Outcome;
  /** Hash of trusted private observations; never a producer's claimed verification status. */
  oracleEvidenceHash?: string;
  oracleVersion?: string;
  heldOutAssertionsPassed: boolean;
  currentSourceHash?: string;
  recheckEvidenceHash?: string;
  freshRecheck: boolean;
  latencyMs: number;
  firstUsefulResultMs: number | null;
  /** Required by the release scorer; omitted only by isolated accounting tests. */
  producerReceiptHash?: string;
  usage?: { source: 'host'; tokens?: number; costUSD?: number };
  prerequisite?: string;
}
export interface Rate { numerator: number; denominator: number; value: number | null }
export interface ReleaseQualification {
  containment: Record<string, 'passed' | 'failed' | 'not_run'>;
}
export interface PreparedEvalSchedule {
  schemaVersion: 1;
  matrixHash: string;
  scheduledCells: number;
  preparedCells: number;
  jobs: Array<{ cellId: string; relativePath: string; inputHash: string }>;
}
export interface ProducerGroupSummary {
  version: EvalVersion;
  mode: EvalMode;
  scheduled: number;
  submitted: number;
  missing: number;
  succeeded: number;
  failed: number;
  latency: { samples: number; denominator: number; p95Ms: number | null };
  firstUsefulResult: { samples: 0; denominator: number; p95Ms: null };
  modelTokens: { measured: number; denominator: number; total: number | null };
  estimatedCost: { measured: number; denominator: number; totalUSD: number | null; source: 'pricing-table-estimate' };
}
export interface ProducerBatch {
  schemaVersion: 1;
  matrixHash: string;
  scheduleHash: string;
  receipts: ProducerReceiptIndex[];
  summary: {
    scheduled: number;
    prepared: number;
    submitted: number;
    missing: number;
    matchedPairsExpected: number;
    matchedPairsSubmitted: number;
    modelMismatches: Array<{ pair: string; v2: string; v3: string }>;
    groups: ProducerGroupSummary[];
    note: string;
  };
  batchHash: string;
}
export const REQUIRED_CONTAINMENT = [
  'hostile-startup-configuration', 'environment-canary', 'remote-docker-context', 'ipv4-egress', 'ipv6-egress', 'dns-egress',
  'archive-traversal-and-poisoning', 'symlink-traversal', 'split-output-secrets', 'concurrent-admission', 'expired-snapshot-replay',
  'watchdog-survival', 'failed-report-writes', 'held-out-oracle-visibility',
] as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const validNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const PORTABLE_PAYLOAD_HEADER = '<!-- GSTACK_CSO_EVAL_PAYLOAD ';
const PORTABLE_PAYLOAD_HEADER_END = ' -->\n';
const PORTABLE_FILE_END = '\n<<<END_GSTACK_CSO_EVAL_FILE>>>\n';
const PORTABLE_FILE_LIMIT = 2 * 1024 * 1024;
const PORTABLE_PAYLOAD_LIMIT = 4 * 1024 * 1024;

function portablePayloadPreamble(version: EvalVersion): string {
  return `# Complete portable CSO evaluation instructions (${version})\n\nThis package is the sole CSO instruction input for this evaluation cell. Apply the embedded SKILL.md and every embedded manifest-listed section. Resolve any SKILL.md reference to cso/sections/<file> or sections/<file> from the matching embedded file below. Do not read an installed, user-home, repository, or other-version CSO skill or section. The file bodies are exact generated bytes; package markers are transport metadata.\n\n`;
}

function portableFileOpen(identity: PortableSkillFileIdentity): string {
  return `<<<GSTACK_CSO_EVAL_FILE ${JSON.stringify(identity)}>>>\n`;
}

function parsePortableManifest(contents: string): { files: string[] } {
  let manifest: any;
  try { manifest = JSON.parse(contents); } catch { throw new Error('INVALID_CSO_EVAL_PAYLOAD_MANIFEST'); }
  if (!manifest || manifest.skill !== 'cso' || manifest.version !== 1 || !Array.isArray(manifest.sections) || manifest.sections.length === 0) throw new Error('INVALID_CSO_EVAL_PAYLOAD_MANIFEST');
  const files: string[] = [];
  const ids = new Set<string>();
  for (const section of manifest.sections) {
    if (!section || typeof section.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(section.id) || ids.has(section.id) || typeof section.file !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(section.file) || files.includes(section.file) || typeof section.title !== 'string' || !section.title.trim() || typeof section.trigger !== 'string' || !section.trigger.trim()) throw new Error('INVALID_CSO_EVAL_PAYLOAD_MANIFEST');
    ids.add(section.id); files.push(section.file);
  }
  return { files };
}

function validatePortableSkillFiles(version: EvalVersion, files: PortableSkillFile[]): PortableSkillFile[] {
  if (!['v2', 'v3'].includes(version) || !Array.isArray(files)) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
  const byPath = new Map<string, string>();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.contents !== 'string' || byPath.has(file.path) || Buffer.byteLength(file.contents) > PORTABLE_FILE_LIMIT || file.contents.includes(PORTABLE_FILE_END.trim())) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
    byPath.set(file.path, file.contents);
  }
  const root = byPath.get('SKILL.md'), manifest = byPath.get('sections/manifest.json');
  if (root === undefined || manifest === undefined) throw new Error('INCOMPLETE_CSO_EVAL_PAYLOAD');
  const frontmatter = root.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const versionMatch = frontmatter?.match(/^version:\s*([0-9]+)(?:\.[0-9]+){0,2}\s*$/m);
  if (!versionMatch || Number(versionMatch[1]) !== Number(version.slice(1))) throw new Error('CSO_EVAL_PAYLOAD_VERSION_MISMATCH');
  const sectionFiles = parsePortableManifest(manifest).files;
  const expectedPaths = ['SKILL.md', 'sections/manifest.json', ...sectionFiles.map(file => `sections/${file}`)];
  if (byPath.size !== expectedPaths.length || expectedPaths.some(path => !byPath.has(path))) throw new Error('INCOMPLETE_CSO_EVAL_PAYLOAD');
  return expectedPaths.map(path => ({ path, contents: byPath.get(path)! }));
}

/** Render the only portable instruction format accepted by matrix preparation. */
export function createPortableSkillPayload(version: EvalVersion, inputFiles: PortableSkillFile[]): string {
  const files = validatePortableSkillFiles(version, inputFiles);
  const identities = files.map(file => ({ path: file.path, sha256: sha256(file.contents), bytes: Buffer.byteLength(file.contents) }));
  const identity: PortableSkillPayloadIdentity = { schemaVersion: 1, version, files: identities };
  let payload = `${PORTABLE_PAYLOAD_HEADER}${JSON.stringify(identity)}${PORTABLE_PAYLOAD_HEADER_END}${portablePayloadPreamble(version)}`;
  for (let index = 0; index < files.length; index++) payload += `${portableFileOpen(identities[index])}${files[index].contents}${PORTABLE_FILE_END}`;
  if (Buffer.byteLength(payload) > PORTABLE_PAYLOAD_LIMIT) throw new Error('CSO_EVAL_PAYLOAD_TOO_LARGE');
  return payload;
}

/** Validate canonical serialization and return the identities bound by its hash. */
export function validatePortableSkillPayload(payload: string, expectedVersion?: EvalVersion): PortableSkillPayloadIdentity {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > PORTABLE_PAYLOAD_LIMIT || !payload.startsWith(PORTABLE_PAYLOAD_HEADER)) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
  const headerEnd = payload.indexOf(PORTABLE_PAYLOAD_HEADER_END, PORTABLE_PAYLOAD_HEADER.length);
  if (headerEnd < 0) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
  let identity: PortableSkillPayloadIdentity;
  try { identity = JSON.parse(payload.slice(PORTABLE_PAYLOAD_HEADER.length, headerEnd)); } catch { throw new Error('INVALID_CSO_EVAL_PAYLOAD'); }
  if (identity?.schemaVersion !== 1 || !['v2', 'v3'].includes(identity.version) || (expectedVersion && identity.version !== expectedVersion) || !Array.isArray(identity.files)) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
  let cursor = headerEnd + PORTABLE_PAYLOAD_HEADER_END.length;
  const preamble = portablePayloadPreamble(identity.version);
  if (payload.slice(cursor, cursor + preamble.length) !== preamble) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
  cursor += preamble.length;
  const files: PortableSkillFile[] = [];
  for (const file of identity.files) {
    if (!file || typeof file.path !== 'string' || !HEX.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > PORTABLE_FILE_LIMIT) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
    const open = portableFileOpen(file);
    if (payload.slice(cursor, cursor + open.length) !== open) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
    cursor += open.length;
    const end = payload.indexOf(PORTABLE_FILE_END, cursor);
    if (end < 0) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
    const contents = payload.slice(cursor, end);
    if (Buffer.byteLength(contents) !== file.bytes || sha256(contents) !== file.sha256) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
    files.push({ path: file.path, contents }); cursor = end + PORTABLE_FILE_END.length;
  }
  if (cursor !== payload.length || createPortableSkillPayload(identity.version, files) !== payload) throw new Error('INVALID_CSO_EVAL_PAYLOAD');
  return identity;
}

/** Read one generated CSO skill tree and package every manifest-listed section. */
export function loadPortableSkillPayload(version: EvalVersion, skillDirectory: string): string {
  const root = resolve(skillDirectory), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw new Error('UNSAFE_CSO_EVAL_SKILL_DIRECTORY');
  const read = (relativePath: string) => {
    const bytes = readBoundedStable(join(root, ...relativePath.split('/')), PORTABLE_FILE_LIMIT, `CSO ${version} ${relativePath}`);
    const contents = bytes.toString('utf8');
    if (!Buffer.from(contents).equals(bytes)) throw new Error('INVALID_CSO_EVAL_PAYLOAD_ENCODING');
    return contents;
  };
  const rootSkill = read('SKILL.md'), manifest = read('sections/manifest.json');
  const sectionFiles = parsePortableManifest(manifest).files;
  const sectionsRoot = join(root, 'sections'), sectionStat = lstatSync(sectionsRoot);
  if (!sectionStat.isDirectory() || sectionStat.isSymbolicLink() || realpathSync(sectionsRoot) !== sectionsRoot) throw new Error('UNSAFE_CSO_EVAL_SKILL_DIRECTORY');
  const listed = new Set(sectionFiles);
  const inventory = () => readdirSync(sectionsRoot, { withFileTypes: true }).filter(entry => entry.name.endsWith('.md')).map(entry => {
    if (!entry.isFile() || entry.isSymbolicLink() || !listed.has(entry.name)) throw new Error('UNLISTED_CSO_EVAL_SECTION');
    return entry.name;
  }).sort();
  const firstInventory = inventory();
  const files = [
    { path: 'SKILL.md', contents: rootSkill },
    { path: 'sections/manifest.json', contents: manifest },
    ...sectionFiles.map(file => ({ path: `sections/${file}`, contents: read(`sections/${file}`) })),
  ];
  if (JSON.stringify(inventory()) !== JSON.stringify(firstInventory) || files.some(file => read(file.path) !== file.contents)) throw new Error('CSO_EVAL_SKILL_CHANGED_DURING_PACKAGING');
  return createPortableSkillPayload(version, files);
}

function matrixHash(matrix: EvalMatrix): string { return digest(JSON.stringify(matrix)); }

function safeWriteNew(path: string, value: unknown): void {
  const target = resolve(path), parent = dirname(target), stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('UNSAFE_EVAL_DESTINATION');
  atomicWriteSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, noReplace: true });
}

function readJsonBounded(path: string, max: number, label: string): any {
  try { return JSON.parse(readBoundedStable(resolve(path), max, label).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error(`INVALID_${label.toUpperCase().replaceAll(' ', '_')}`); throw error; }
}

function initializeFixtureRepository(path: string): void {
  const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = {
    PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullPath, GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'CSO Eval', GIT_AUTHOR_EMAIL: 'cso-eval@invalid',
    GIT_COMMITTER_NAME: 'CSO Eval', GIT_COMMITTER_EMAIL: 'cso-eval@invalid',
  };
  const git = executable('git');
  execFileSync(git, ['init', '--quiet', '--initial-branch=main'], { cwd: path, env, stdio: 'ignore' });
  const safe = ['-c', `core.hooksPath=${nullPath}`, '-c', `core.attributesFile=${nullPath}`, '-c', `core.excludesFile=${nullPath}`];
  execFileSync(git, [...safe, 'add', '--all'], { cwd: path, env, stdio: 'ignore' });
  execFileSync(git, [...safe, 'commit', '--quiet', '-m', 'immutable evaluation fixture'], { cwd: path, env, stdio: 'ignore' });
}

function sourceEntries(caseId: string, variant: EvalVariant): ProducerSourceEntry[] {
  return Object.entries(sourceFiles(caseId, variant)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([path, contents]) => ({ path, sha256: sha256(contents), bytes: Buffer.byteLength(contents) }));
}

/**
 * Prepare independent one-cell jobs. The returned schedule is trusted
 * evaluator metadata; transfer one job at a time and never give the schedule
 * or sibling jobs to the producing agent.
 */
export function prepareEvalJobs(matrix: EvalMatrix, payloads: { v2: string; v3: string }, destination: string, selectedCellIds?: string[]): PreparedEvalSchedule {
  validateMatrix(matrix);
  validatePortableSkillPayload(payloads.v2, 'v2'); validatePortableSkillPayload(payloads.v3, 'v3');
  if (sha256(payloads.v2) !== matrix.skillHashes.v2 || sha256(payloads.v3) !== matrix.skillHashes.v3) throw new Error('EVAL_SKILL_HASH_MISMATCH');
  const root = resolve(destination);
  if (existsSync(root)) throw new Error('EVAL_DESTINATION_EXISTS');
  const parent = dirname(root);
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) throw new Error('UNSAFE_EVAL_DESTINATION');
  const selected = selectedCellIds === undefined ? matrix.cells : selectedCellIds.map(id => {
    const cell = matrix.cells.find(item => item.id === id);
    if (!cell) throw new Error('UNKNOWN_EVAL_CELL');
    return cell;
  });
  if (new Set(selected.map(cell => cell.id)).size !== selected.length) throw new Error('DUPLICATE_EVAL_CELL');
  mkdirSync(root, { mode: 0o700 });
  const jobsRoot = join(root, 'jobs'); mkdirSync(jobsRoot, { mode: 0o700 });
  const jobs: PreparedEvalSchedule['jobs'] = [];
  for (const cell of selected) {
    const jobRoot = join(jobsRoot, cell.id); mkdirSync(jobRoot, { mode: 0o700 });
    const source = materializeCase(cell.caseId, cell.variant, join(jobRoot, 'source'));
    if (source.sourceHash !== cell.sourceHash) throw new Error('CORPUS_INTEGRITY_MISMATCH');
    initializeFixtureRepository(source.path);
    const input: ProducerInput = { schemaVersion: 1, cell, skill: payloads[cell.version], source: sourceEntries(cell.caseId, cell.variant) };
    const inputHash = producerInputHash(input);
    safeWriteNew(join(jobRoot, 'producer-input.json'), input);
    jobs.push({ cellId: cell.id, relativePath: `jobs/${cell.id}`, inputHash });
  }
  const schedule: PreparedEvalSchedule = { schemaVersion: 1, matrixHash: matrixHash(matrix), scheduledCells: matrix.cells.length, preparedCells: jobs.length, jobs };
  safeWriteNew(join(root, 'schedule.json'), schedule);
  return schedule;
}

function validateSchedule(matrix: EvalMatrix, schedule: PreparedEvalSchedule): void {
  if (schedule?.schemaVersion !== 1 || schedule.matrixHash !== matrixHash(matrix) || schedule.scheduledCells !== matrix.cells.length || !Array.isArray(schedule.jobs) || schedule.preparedCells !== schedule.jobs.length) throw new Error('INVALID_EVAL_SCHEDULE');
  const known = new Set(matrix.cells.map(cell => cell.id));
  const seen = new Set<string>();
  for (const job of schedule.jobs) {
    if (!job || !known.has(job.cellId) || seen.has(job.cellId) || job.relativePath !== `jobs/${job.cellId}` || !HEX.test(job.inputHash)) throw new Error('INVALID_EVAL_SCHEDULE');
    seen.add(job.cellId);
  }
}

function validateReceipt(receipt: ProducerReceipt, cell: EvalCell, inputHash: string): void {
  if (receipt?.schemaVersion !== 1 || JSON.stringify(receipt.cell) !== JSON.stringify(cell) || receipt.inputHash !== inputHash || receipt.requestedModel !== cell.model || !['succeeded', 'failed'].includes(receipt.status) || typeof receipt.modelUsed !== 'string' || !receipt.modelUsed || !['provider_reported', 'requested_pin'].includes(receipt.modelIdentitySource) || (receipt.modelIdentitySource === 'requested_pin' && receipt.modelUsed !== receipt.requestedModel) || (receipt.modelIdentitySource === 'provider_reported' && receipt.modelUsed === receipt.requestedModel) || !validNumber(receipt.durationMs) || receipt.firstUsefulResultMs !== null || !Number.isSafeInteger(receipt.toolCalls) || receipt.toolCalls < 0 || typeof receipt.output !== 'string' || receipt.outputHash !== sha256(receipt.output) || !HEX.test(receipt.receiptHash)) throw new Error('INVALID_PRODUCER_RECEIPT');
  const { receiptHash, ...withoutHash } = receipt;
  if (producerReceiptHash(withoutHash) !== receiptHash) throw new Error('INVALID_PRODUCER_RECEIPT');
  const started = Date.parse(receipt.startedAt), finished = Date.parse(receipt.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) throw new Error('INVALID_PRODUCER_RECEIPT');
  if (!receipt.usage || !['inputTokens', 'outputTokens', 'cachedTokens', 'estimatedCostUSD'].every(field => receipt.usage[field as keyof typeof receipt.usage] === null || validNumber(receipt.usage[field as keyof typeof receipt.usage]))) throw new Error('INVALID_PRODUCER_RECEIPT');
  const hasError = !!receipt.error;
  if ((receipt.status === 'failed') !== hasError || (hasError && (!receipt.error!.code || typeof receipt.error!.reason !== 'string'))) throw new Error('INVALID_PRODUCER_RECEIPT');
  validateInstallationIdentity(receipt.installationIdentity, 'INVALID_PRODUCER_RECEIPT');
  validateProviderIdentity(receipt.providerIdentity, cell.host === 'codex' ? 'gpt' : cell.host, 'INVALID_PRODUCER_RECEIPT');
  validateArtifactInventory(receipt.artifacts, 'INVALID_PRODUCER_RECEIPT');
}

function validateInstallationIdentity(identity: ProducerInstallationIdentity, error: string): void {
  const artifact = (value: any) => value && HEX.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0;
  if (!identity || identity.schemaVersion !== 1 || !artifact(identity.producer) || !artifact(identity.launcher) || !artifact(identity.core) || !artifact(identity.watchdog) ||
      !identity.embeddedCatalogs || !identity.embeddedCatalogs.runtimeRevision || !identity.embeddedCatalogs.runtimeBuildRevision || !HEX.test(identity.embeddedCatalogs.runtimeSha256) ||
      !identity.embeddedCatalogs.scannerRevision || !HEX.test(identity.embeddedCatalogs.scannerSha256) || !HEX.test(identity.identityHash)) throw new Error(error);
  const { identityHash, ...withoutHash } = identity;
  if (producerInstallationIdentityHash(withoutHash) !== identityHash) throw new Error(error);
}

function validateProviderIdentity(identity: ProducerProviderIdentity, family: 'claude' | 'gpt' | 'gemini', error: string): void {
  if (!identity || identity.schemaVersion !== 1 || identity.family !== family || !identity.policyRevision || !identity.version ||
      !identity.executable || !HEX.test(identity.executable.sha256) || !Number.isSafeInteger(identity.executable.bytes) || identity.executable.bytes <= 0 ||
      !Array.isArray(identity.argsPrefix) || identity.argsPrefix.some(value => typeof value !== 'string' || value.includes('\0')) || !HEX.test(identity.identityHash)) throw new Error(error);
  const { identityHash, ...withoutHash } = identity;
  if (producerProviderIdentityHash(withoutHash) !== identityHash) throw new Error(error);
}

function validateArtifactInventory(inventory: ProducerArtifactInventory, error: string): void {
  if (!inventory || inventory.schemaVersion !== 1 || inventory.root !== 'security/cso' || !Array.isArray(inventory.entries) || inventory.entries.length > 4096 ||
      !Number.isSafeInteger(inventory.totalBytes) || inventory.totalBytes < 0 || inventory.totalBytes > 128 * 1024 * 1024 || !HEX.test(inventory.identityHash)) throw new Error(error);
  let previous = '', total = 0;
  for (const entry of inventory.entries) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length > 1024 || !/^[A-Za-z0-9._/-]+$/.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..') ||
        entry.path <= previous || !HEX.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 32 * 1024 * 1024) throw new Error(error);
    previous = entry.path; total += entry.bytes;
  }
  if (total !== inventory.totalBytes) throw new Error(error);
  const { identityHash, ...withoutHash } = inventory;
  if (producerArtifactInventoryHash(withoutHash) !== identityHash) throw new Error(error);
}

function validateReceiptIndex(receipt: ProducerReceiptIndex, cell: EvalCell): void {
  if (!receipt || receipt.schemaVersion !== 1 || JSON.stringify(receipt.cell) !== JSON.stringify(cell) || !HEX.test(receipt.inputHash) || receipt.requestedModel !== cell.model || !receipt.modelUsed || !['provider_reported', 'requested_pin'].includes(receipt.modelIdentitySource) || (receipt.modelIdentitySource === 'requested_pin' && receipt.modelUsed !== receipt.requestedModel) || (receipt.modelIdentitySource === 'provider_reported' && receipt.modelUsed === receipt.requestedModel) || !['succeeded', 'failed'].includes(receipt.status) || !HEX.test(receipt.outputHash) || !HEX.test(receipt.receiptHash) || !validNumber(receipt.durationMs) || receipt.firstUsefulResultMs !== null || !Number.isSafeInteger(receipt.toolCalls) || receipt.toolCalls < 0 || !receipt.usage) throw new Error('INVALID_PRODUCER_BATCH');
  const started = Date.parse(receipt.startedAt), finished = Date.parse(receipt.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started || !['inputTokens', 'outputTokens', 'cachedTokens', 'estimatedCostUSD'].every(field => receipt.usage[field as keyof typeof receipt.usage] === null || validNumber(receipt.usage[field as keyof typeof receipt.usage])) || ((receipt.status === 'failed') !== !!receipt.error) || (receipt.error && !receipt.error.code)) throw new Error('INVALID_PRODUCER_BATCH');
  validateInstallationIdentity(receipt.installationIdentity, 'INVALID_PRODUCER_BATCH');
  validateProviderIdentity(receipt.providerIdentity, cell.host === 'codex' ? 'gpt' : cell.host, 'INVALID_PRODUCER_BATCH');
  validateArtifactInventory(receipt.artifacts, 'INVALID_PRODUCER_BATCH');
}

const matchedPairKey = (cell: EvalCell): string => [cell.caseId, cell.variant, cell.mode, cell.repetition, cell.model, cell.host, cell.budgetSeconds, cell.sourceHash].join('|');

export function collectProducerReceipts(matrix: EvalMatrix, schedule: PreparedEvalSchedule, receipts: ProducerReceipt[]): ProducerBatch {
  validateMatrix(matrix); validateSchedule(matrix, schedule);
  if (!Array.isArray(receipts)) throw new Error('INVALID_PRODUCER_RECEIPTS');
  const cells = new Map(matrix.cells.map(cell => [cell.id, cell]));
  const jobs = new Map(schedule.jobs.map(job => [job.cellId, job]));
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const cell = cells.get(receipt?.cell?.id), job = jobs.get(receipt?.cell?.id);
    if (!cell || !job || seen.has(cell.id)) throw new Error('UNKNOWN_OR_DUPLICATE_PRODUCER_RECEIPT');
    validateReceipt(receipt, cell, job.inputHash); seen.add(cell.id);
  }
  if (new Set(receipts.map(receipt => receipt.installationIdentity.identityHash)).size > 1) throw new Error('UNMATCHED_PRODUCER_INSTALLATIONS');
  if (new Set(receipts.map(receipt => receipt.providerIdentity.identityHash)).size > 1) throw new Error('UNMATCHED_PRODUCER_PROVIDERS');
  const pairs = new Map<string, Partial<Record<EvalVersion, ProducerReceipt>>>();
  for (const receipt of receipts) {
    const key = matchedPairKey(receipt.cell as EvalCell);
    const pair = pairs.get(key) ?? {}; pair[receipt.cell.version] = receipt; pairs.set(key, pair);
  }
  const completePairs = [...pairs.entries()].filter(([, pair]) => pair.v2 && pair.v3) as Array<[string, { v2: ProducerReceipt; v3: ProducerReceipt }]>;
  const modelMismatches = completePairs.filter(([, pair]) => pair.v2.modelUsed !== pair.v3.modelUsed).map(([pair, value]) => ({ pair: digest(pair), v2: value.v2.modelUsed, v3: value.v3.modelUsed }));
  if (modelMismatches.length) throw new Error(`UNMATCHED_EFFECTIVE_MODELS: ${modelMismatches.length} matched v2/v3 pair(s) used different normalized model identities`);
  const groups: ProducerGroupSummary[] = [];
  for (const version of ['v2', 'v3'] as const) for (const mode of ['daily', 'comprehensive'] as const) {
    const expected = matrix.cells.filter(cell => cell.version === version && cell.mode === mode);
    const submitted = receipts.filter(receipt => receipt.cell.version === version && receipt.cell.mode === mode);
    const tokens = submitted.flatMap(receipt => receipt.usage.inputTokens === null || receipt.usage.outputTokens === null ? [] : [receipt.usage.inputTokens + receipt.usage.outputTokens]);
    const costs = submitted.flatMap(receipt => receipt.usage.estimatedCostUSD === null ? [] : [receipt.usage.estimatedCostUSD]);
    groups.push({ version, mode, scheduled: expected.length, submitted: submitted.length, missing: expected.length - submitted.length, succeeded: submitted.filter(receipt => receipt.status === 'succeeded').length, failed: submitted.filter(receipt => receipt.status === 'failed').length,
      latency: { samples: submitted.length, denominator: expected.length, p95Ms: quantile(submitted.map(receipt => receipt.durationMs), 0.95) },
      firstUsefulResult: { samples: 0, denominator: expected.length, p95Ms: null },
      modelTokens: { measured: tokens.length, denominator: expected.length, total: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null },
      estimatedCost: { measured: costs.length, denominator: expected.length, totalUSD: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null, source: 'pricing-table-estimate' },
    });
  }
  const indexes: ProducerReceiptIndex[] = receipts.map(({ output: _output, error, ...receipt }) => ({ ...receipt, ...(error ? { error: { code: error.code } } : {}) }));
  const base = { schemaVersion: 1 as const, matrixHash: matrixHash(matrix), scheduleHash: digest(JSON.stringify(schedule)), receipts: indexes.sort((left, right) => left.cell.id.localeCompare(right.cell.id)), summary: {
    scheduled: matrix.cells.length, prepared: schedule.preparedCells, submitted: receipts.length, missing: matrix.cells.length - receipts.length,
    matchedPairsExpected: matrix.cells.length / 2, matchedPairsSubmitted: completePairs.length, modelMismatches, groups,
    note: 'Costs are pricing-table estimates. First-useful timing is unmeasured because the reused provider adapters return completed runs. Trusted findings and runtime outcomes require separate oracle adjudication.',
  } };
  return { ...base, batchHash: digest(JSON.stringify(base)) };
}

export function createEvalMatrix(options: { model: string; host: ProducerHost; skillHashes: { v2: string; v3: string }; budgets?: { daily: number; comprehensive: number } }, corpus: CorpusManifest = loadCorpusManifest()): EvalMatrix {
  if (!options.model?.trim() || !['claude', 'codex', 'gemini'].includes(options.host) || !HEX.test(options.skillHashes.v2) || !HEX.test(options.skillHashes.v3) || options.skillHashes.v2 === options.skillHashes.v3) throw new Error('INVALID_MATCHED_EVAL_INPUT');
  const budgets = options.budgets ?? { daily: 600, comprehensive: 1800 };
  if (![budgets.daily, budgets.comprehensive].every(value => Number.isInteger(value) && value > 60 && value <= 3600)) throw new Error('INVALID_EVAL_BUDGET');
  const cells: EvalCell[] = [];
  for (const fixture of corpus.cases) for (const variant of ['vulnerable', 'fixed'] as const) for (const mode of ['daily', 'comprehensive'] as const) for (const repetition of [1, 2, 3] as const) for (const version of ['v2', 'v3'] as const) {
    const cell = { caseId: fixture.id, stack: fixture.stack, variant, version, mode, repetition, model: options.model, host: options.host, budgetSeconds: budgets[mode], sourceHash: fixture.filesHash[variant], skillHash: options.skillHashes[version] };
    cells.push({ id: digest(JSON.stringify(cell)), ...cell });
  }
  return { schemaVersion: 1, corpusVersion: corpus.version, corpusHash: digest(JSON.stringify(corpus)), model: options.model, host: options.host, budgets, skillHashes: options.skillHashes, repetitions: 3, cells };
}

export function validateMatrix(matrix: EvalMatrix, corpus: CorpusManifest = loadCorpusManifest()): void {
  const expected = createEvalMatrix({ model: matrix.model, host: matrix.host, skillHashes: matrix.skillHashes, budgets: matrix.budgets }, corpus);
  if (JSON.stringify(matrix) !== JSON.stringify(expected)) throw new Error('UNMATCHED_OR_INCOMPLETE_EVAL_MATRIX');
}
function validateResult(result: EvalResult, cell: EvalCell, corpus: CorpusManifest): void {
  if (result.sourceHash !== cell.sourceHash || result.skillHash !== cell.skillHash || result.model !== cell.model || result.host !== cell.host || result.budgetSeconds !== cell.budgetSeconds) throw new Error('UNMATCHED_EVAL_RESULT');
  for (const field of ['setup', 'reproduction', 'repair', 'recheck'] as const) if (!['passed', 'failed', 'blocked', 'not_attempted'].includes(result[field])) throw new Error('INVALID_EVAL_OUTCOME');
  for (const field of ['reportPresent', 'reportComplete', 'heldOutAssertionsPassed', 'freshRecheck'] as const) if (typeof result[field] !== 'boolean') throw new Error('INVALID_EVAL_RESULT');
  if (!Array.isArray(result.findings) || !validNumber(result.latencyMs) || (result.firstUsefulResultMs !== null && (!validNumber(result.firstUsefulResultMs) || result.firstUsefulResultMs > result.latencyMs))) throw new Error('INVALID_EVAL_RESULT');
  if (result.reportComplete && !result.reportPresent) throw new Error('MISSING_EVAL_REPORT');
  if (!result.reportPresent && result.findings.length) throw new Error('FINDINGS_WITHOUT_REPORT');
  if (result.setup === 'blocked' && !result.prerequisite?.trim()) throw new Error('MISSING_SETUP_PREREQUISITE');
  if (result.oracleEvidenceHash !== undefined && (!HEX.test(result.oracleEvidenceHash) || result.oracleVersion !== corpus.version)) throw new Error('INVALID_ORACLE_PROVENANCE');
  if (result.currentSourceHash !== undefined && !HEX.test(result.currentSourceHash)) throw new Error('INVALID_RECHECK_SOURCE');
  if (result.recheckEvidenceHash !== undefined && !HEX.test(result.recheckEvidenceHash)) throw new Error('INVALID_RECHECK_EVIDENCE');
  if (result.usage && (result.usage.source !== 'host' || (result.usage.tokens !== undefined && !validNumber(result.usage.tokens)) || (result.usage.costUSD !== undefined && !validNumber(result.usage.costUSD)))) throw new Error('INVALID_EVAL_USAGE');
  if (result.producerReceiptHash !== undefined && !HEX.test(result.producerReceiptHash)) throw new Error('INVALID_PRODUCER_RECEIPT_PROVENANCE');
  const ids = new Set<string>(), repairEvidence = new Set<string>(), recheckEvidence = new Set<string>();
  for (const finding of result.findings) {
    if (!finding.id || ids.has(finding.id) || !['supported', 'hypothesis', 'legacy_review'].includes(finding.evidence) || !['correct', 'incorrect', 'unadjudicated'].includes(finding.judgment) || typeof finding.claimedTested !== 'boolean') throw new Error('INVALID_FINDING_JUDGMENT');
    ids.add(finding.id);
    if (finding.judgment === 'correct' && (cell.variant !== 'vulnerable' || finding.matchedCaseId !== cell.caseId)) throw new Error('INVALID_ORACLE_MATCH');
    if (finding.trustedVerification !== undefined) {
      const verification = finding.trustedVerification as Record<string, unknown>, allowed = new Set(['repair', 'repairEvidenceHash', 'recheck', 'recheckEvidenceHash']);
      if (!verification || typeof verification !== 'object' || Array.isArray(verification) || Object.keys(verification).some(key => !allowed.has(key)) ||
        !['passed', 'failed', 'blocked', 'not_attempted'].includes(String(verification.repair)) ||
        !['passed', 'failed', 'blocked', 'not_attempted'].includes(String(verification.recheck)) || !finding.claimedTested || cell.version !== 'v3' || cell.mode !== 'comprehensive')
        throw new Error('INVALID_TRUSTED_FINDING_VERIFICATION');
      const repairHash = verification.repairEvidenceHash, recheckHash = verification.recheckEvidenceHash;
      if (!(repairHash === undefined || (typeof repairHash === 'string' && HEX.test(repairHash))) ||
        !(recheckHash === undefined || (typeof recheckHash === 'string' && HEX.test(recheckHash))) ||
        (verification.repair === 'passed') !== (repairHash !== undefined) ||
        (verification.recheck === 'passed') !== (recheckHash !== undefined) ||
        (verification.recheck === 'passed' && verification.repair !== 'passed'))
        throw new Error('INVALID_TRUSTED_FINDING_VERIFICATION');
      if (typeof repairHash === 'string') {
        if (repairEvidence.has(repairHash)) throw new Error('DUPLICATE_TRUSTED_REPAIR_BINDING');
        repairEvidence.add(repairHash);
      }
      if (typeof recheckHash === 'string') {
        if (recheckEvidence.has(recheckHash)) throw new Error('DUPLICATE_TRUSTED_RECHECK_BINDING');
        recheckEvidence.add(recheckHash);
      }
    }
  }
  if (cell.mode === 'daily' && [result.setup, result.reproduction, result.repair, result.recheck].some(value => value !== 'not_attempted')) throw new Error('DAILY_EVAL_EXECUTED_APPLICATION');
}
function quantile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  return [...values].sort((left, right) => left - right)[Math.ceil(values.length * fraction) - 1];
}
function measuredRate(cells: EvalCell[], results: Map<string, EvalResult>, field: 'setup' | 'reproduction' | 'repair' | 'recheck', corpus: CorpusManifest): Rate {
  return rate(cells.filter(cell => {
    const result = results.get(cell.id);
    if (!result?.reportPresent || !result.reportComplete || result[field] !== 'passed') return false;
    if (field === 'setup') return true;
    if (!result.oracleEvidenceHash || result.oracleVersion !== corpus.version || result.setup !== 'passed') return false;
    if (field === 'reproduction') return true;
    if (result.reproduction !== 'passed' || result.repair !== 'passed' || !result.heldOutAssertionsPassed) return false;
    if (cell.version === 'v3' && !result.findings.some(finding => trustedFindingVerification(cell, result, finding, 'repair', corpus))) return false;
    if (field === 'repair') return true;
    // Correct alternative patches need not match the reference fix byte-for-byte.
    // Closure needs a fresh source and a separate trusted current-source observation.
    return result.freshRecheck && !!result.currentSourceHash && result.currentSourceHash !== cell.sourceHash &&
      !!result.recheckEvidenceHash && result.recheckEvidenceHash !== result.oracleEvidenceHash &&
      (cell.version !== 'v3' || result.findings.some(finding => trustedFindingVerification(cell, result, finding, 'recheck', corpus)));
  }).length, cells.length);
}

function trustedFindingVerification(cell: EvalCell, result: EvalResult, finding: EvalFinding, stage: 'repair' | 'recheck', corpus: CorpusManifest): boolean {
  const verification = finding.trustedVerification;
  if (!result.reportPresent || !result.reportComplete || cell.version !== 'v3' || cell.mode !== 'comprehensive' || cell.variant !== 'vulnerable' || finding.evidence !== 'supported' ||
    finding.judgment !== 'correct' || finding.matchedCaseId !== cell.caseId || !finding.claimedTested || !verification ||
    result.setup !== 'passed' || result.reproduction !== 'passed' || result.repair !== 'passed' || !result.heldOutAssertionsPassed ||
    verification.repair !== 'passed' || verification.repairEvidenceHash !== result.oracleEvidenceHash || result.oracleVersion !== corpus.version)
    return false;
  if (stage === 'repair') return true;
  return result.recheck === 'passed' && verification.recheck === 'passed' && verification.recheckEvidenceHash === result.recheckEvidenceHash &&
    result.freshRecheck && !!result.currentSourceHash && result.currentSourceHash !== cell.sourceHash &&
    !!result.recheckEvidenceHash && result.recheckEvidenceHash !== result.oracleEvidenceHash;
}

export function scoreEval(matrix: EvalMatrix, observations: EvalResult[], qualification: ReleaseQualification = { containment: {} }, corpus: CorpusManifest = loadCorpusManifest()) {
  validateMatrix(matrix, corpus);
  if (!Array.isArray(observations)) throw new Error('INVALID_EVAL_RESULTS');
  const cells = new Map(matrix.cells.map(cell => [cell.id, cell]));
  const results = new Map<string, EvalResult>();
  for (const result of observations) {
    const cell = cells.get(result.cellId);
    if (!cell || results.has(result.cellId)) throw new Error('UNKNOWN_OR_DUPLICATE_EVAL_RESULT');
    validateResult(result, cell, corpus); results.set(result.cellId, result);
  }
  const eligibleFinding = (cell: EvalCell, finding: EvalFinding) => finding.evidence === 'supported' || (cell.version === 'v2' && finding.evidence === 'legacy_review');
  const found = (cell: EvalCell) => {
    const result = results.get(cell.id);
    return result?.reportPresent === true && result.reportComplete === true &&
      result.findings.some(finding => eligibleFinding(cell, finding) && finding.judgment === 'correct');
  };
  const groups: any[] = [];
  for (const version of ['v2', 'v3'] as const) for (const mode of ['daily', 'comprehensive'] as const) {
    const selected = matrix.cells.filter(cell => cell.version === version && cell.mode === mode);
    const completed = selected.map(cell => results.get(cell.id)).filter((result): result is EvalResult => !!result);
    const expected = selected.filter(cell => cell.variant === 'vulnerable');
    const highCritical = expected.filter(cell => ['critical','high'].includes(corpus.cases.find(fixture => fixture.id === cell.caseId)!.severity));
    let correct = 0, reported = 0, unadjudicated = 0;
    for (const cell of selected) {
      const result = results.get(cell.id);
      const findings = result?.reportPresent && result.reportComplete ? result.findings.filter(finding => finding.evidence !== 'hypothesis') : [];
      reported += findings.length;
      unadjudicated += findings.filter(finding => finding.judgment === 'unadjudicated').length;
      correct += Number(findings.some(finding => eligibleFinding(cell, finding) && finding.judgment === 'correct')); // Duplicate reports do not increase true positives.
    }
    const firstUseful = completed.flatMap(result => result.firstUsefulResultMs === null ? [] : [result.firstUsefulResultMs]);
    const costs = completed.flatMap(result => result.usage?.costUSD === undefined ? [] : [result.usage.costUSD]);
    const tokens = completed.flatMap(result => result.usage?.tokens === undefined ? [] : [result.usage.tokens]);
    const falseTested = selected.reduce((count, cell) => {
      const result = results.get(cell.id); if (!result) return count;
      return count + result.findings.filter(finding => finding.claimedTested && !trustedFindingVerification(cell, result, finding, 'repair', corpus)).length;
    }, 0);
    groups.push({ version, mode, cells: selected.length, submitted: completed.length, missing: selected.length - completed.length,
      reports: rate(completed.filter(result => result.reportPresent && result.reportComplete).length, selected.length), precision: rate(correct, reported), recall: rate(expected.filter(found).length, expected.length), highCriticalRecall: rate(highCritical.filter(found).length, highCritical.length),
      unadjudicated, falseTested, setup: mode === 'comprehensive' ? measuredRate(selected, results, 'setup', corpus) : null,
      reproduction: mode === 'comprehensive' ? measuredRate(expected, results, 'reproduction', corpus) : null,
      repair: mode === 'comprehensive' ? measuredRate(expected, results, 'repair', corpus) : null,
      recheck: mode === 'comprehensive' ? measuredRate(expected, results, 'recheck', corpus) : null,
      setupBlocked: completed.filter(result => result.setup === 'blocked').length,
      firstUsefulResult: { samples: firstUseful.length, denominator: selected.length, medianMs: quantile(firstUseful, 0.5), p95Ms: quantile(firstUseful, 0.95) },
      latency: { samples: completed.length, p95Ms: quantile(completed.map(result => result.latencyMs), 0.95) },
      cost: { measured: costs.length, denominator: selected.length, totalUSD: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null },
      modelTokens: { measured: tokens.length, denominator: selected.length, total: tokens.length ? tokens.reduce((sum, count) => sum + count, 0) : null },
    });
  }
  const daily = groups.find(group => group.version === 'v3' && group.mode === 'daily');
  const comprehensive = groups.find(group => group.version === 'v3' && group.mode === 'comprehensive');
  const baseline = groups.find(group => group.version === 'v2' && group.mode === 'comprehensive');
  const perStack = Object.fromEntries(STACKS.map(stack => {
    const eligible = matrix.cells.filter(cell => cell.version === 'v3' && cell.mode === 'comprehensive' && cell.variant === 'vulnerable' && cell.stack === stack);
    // A repaired oracle case demonstrates the full find-to-repair workflow only
    // when the producer also reported the matching supported finding.
    const successful = new Set(eligible.filter(cell => {
      const result = results.get(cell.id);
      return result?.findings.some(finding => trustedFindingVerification(cell, result, finding, 'repair', corpus));
    }).map(cell => cell.caseId));
    return [stack, { correctHeldOutRepairs: successful.size, denominator: new Set(eligible.map(cell => cell.caseId)).size }];
  }));
  const assessedAll = observations.length === matrix.cells.length && observations.every(result => result.reportPresent && result.reportComplete) && groups.every(group => !group.unadjudicated);
  const gate = (condition: boolean | null, hasData: boolean): 'pass' | 'fail' | 'unmeasured' => !hasData || condition === null ? 'unmeasured' : condition ? 'pass' : 'fail';
  const containmentValues = REQUIRED_CONTAINMENT.map(name => qualification.containment?.[name]);
  if (containmentValues.some(value => value !== undefined && !['passed', 'failed', 'not_run'].includes(value))) throw new Error('INVALID_CONTAINMENT_RESULT');
  const gates = {
    matchedCompleteMatrix: gate(assessedAll, observations.length > 0),
    mandatoryReports: gate(groups.every(group => group.reports.numerator === group.reports.denominator), observations.length === matrix.cells.length),
    dailyPrecision95: gate(daily.precision.value === null ? null : daily.precision.value >= 0.95, daily.submitted === daily.cells && !daily.unadjudicated),
    comprehensiveHighCriticalRecall80: gate(comprehensive.highCriticalRecall.value >= 0.8, comprehensive.submitted === comprehensive.cells && !comprehensive.unadjudicated),
    noHighCriticalRecallRegression: gate(comprehensive.highCriticalRecall.value >= baseline.highCriticalRecall.value, comprehensive.submitted === comprehensive.cells && baseline.submitted === baseline.cells && !comprehensive.unadjudicated && !baseline.unadjudicated),
    allCoreColdStarts: gate(comprehensive.setup.numerator === comprehensive.setup.denominator, comprehensive.submitted === comprehensive.cells),
    zeroFalselyTestedRepairs: gate(comprehensive.falseTested === 0 && daily.falseTested === 0, comprehensive.submitted === comprehensive.cells && daily.submitted === daily.cells),
    heldOutRepairEachStack: gate(Object.values(perStack).every(value => value.correctHeldOutRepairs >= 1), comprehensive.submitted === comprehensive.cells),
    containmentAndCanaries: containmentValues.includes('failed') ? 'fail' as const : containmentValues.every(value => value === 'passed') ? 'pass' as const : 'unmeasured' as const,
  };
  return { schemaVersion: 1, corpusVersion: corpus.version, model: matrix.model, host: matrix.host,
    status: Object.values(gates).every(value => value === 'pass') ? 'qualified' : observations.length ? 'partial' : 'unmeasured', groups, perStack, gates,
    notes: ['Missing and setup-blocked supported scenarios remain in recall and workflow denominators.', 'Costs and tokens come only from host-reported usage; wall-clock budgets are not model-spend caps.', 'Oracle judgments and qualification receipts must come from the trusted evaluator, never producing agents.'] };
}

/** Release scoring path: every trusted judgment must bind to a collected producer receipt. */
export function scoreCollectedEval(matrix: EvalMatrix, batch: ProducerBatch, observations: EvalResult[], qualification: ReleaseQualification = { containment: {} }, corpus: CorpusManifest = loadCorpusManifest()) {
  validateMatrix(matrix, corpus);
  if (!Array.isArray(observations)) throw new Error('INVALID_EVAL_RESULTS');
  if (!batch || batch.schemaVersion !== 1 || batch.matrixHash !== matrixHash(matrix) || !HEX.test(batch.scheduleHash) || !HEX.test(batch.batchHash)) throw new Error('INVALID_PRODUCER_BATCH');
  const { batchHash, ...withoutHash } = batch;
  if (digest(JSON.stringify(withoutHash)) !== batchHash || !Array.isArray(batch.receipts) || batch.receipts.length !== matrix.cells.length || batch.summary.scheduled !== matrix.cells.length || batch.summary.prepared !== matrix.cells.length || batch.summary.submitted !== matrix.cells.length || batch.summary.missing !== 0 || batch.summary.matchedPairsExpected !== matrix.cells.length / 2 || batch.summary.matchedPairsSubmitted !== matrix.cells.length / 2 || batch.summary.modelMismatches.length !== 0) throw new Error('INCOMPLETE_PRODUCER_BATCH');
  const cells = new Map(matrix.cells.map(cell => [cell.id, cell]));
  const receipts = new Map<string, ProducerReceiptIndex>();
  for (const receipt of batch.receipts) {
    const cell = cells.get(receipt?.cell?.id);
    if (!cell || receipts.has(cell.id)) throw new Error('INVALID_PRODUCER_BATCH');
    validateReceiptIndex(receipt, cell); receipts.set(cell.id, receipt);
  }
  if (new Set(batch.receipts.map(receipt => receipt.installationIdentity.identityHash)).size !== 1) throw new Error('UNMATCHED_PRODUCER_INSTALLATIONS');
  if (new Set(batch.receipts.map(receipt => receipt.providerIdentity.identityHash)).size !== 1) throw new Error('UNMATCHED_PRODUCER_PROVIDERS');
  const actualModels = new Map<string, Partial<Record<EvalVersion, string>>>();
  for (const receipt of batch.receipts) {
    const key = matchedPairKey(receipt.cell as EvalCell), pair = actualModels.get(key) ?? {};
    pair[receipt.cell.version] = receipt.modelUsed; actualModels.set(key, pair);
  }
  if (actualModels.size !== matrix.cells.length / 2 || [...actualModels.values()].some(pair => !pair.v2 || !pair.v3 || pair.v2 !== pair.v3)) throw new Error('UNMATCHED_EFFECTIVE_MODELS');
  for (const result of observations) {
    const receipt = receipts.get(result.cellId);
    if (!receipt || result.producerReceiptHash !== receipt.receiptHash) throw new Error('UNBOUND_EVAL_RESULT');
  }
  const score = scoreEval(matrix, observations, qualification, corpus);
  return { ...score, producerBatchHash: batch.batchHash };
}

function cli(args: string[]): void {
  const [command, ...rest] = args;
  if (command === 'payload') {
    if (rest.length !== 6 || rest[0] !== '--version' || !['v2', 'v3'].includes(rest[1]) || rest[2] !== '--skill-dir' || rest[4] !== '--output') throw new Error('Usage: cso-eval payload --version <v2|v3> --skill-dir <directory> --output <new-file>');
    const payload = loadPortableSkillPayload(rest[1] as EvalVersion, rest[3]);
    const target = resolve(rest[5]), parent = dirname(target), stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('UNSAFE_EVAL_DESTINATION');
    atomicWriteSync(target, payload, { mode: 0o600, noReplace: true });
    console.log(JSON.stringify({ version: rest[1], files: validatePortableSkillPayload(payload).files.length, sha256: sha256(payload), output: target, paidCalls: 0 })); return;
  }
  if (command === 'materialize') {
    if (rest.length !== 3 || !['vulnerable', 'fixed'].includes(rest[1])) throw new Error('Usage: cso-eval materialize <case-id> <vulnerable|fixed> <new-directory>');
    console.log(JSON.stringify(materializeCase(rest[0], rest[1] as EvalVariant, rest[2]), null, 2)); return;
  }
  if (command === 'matrix') {
    const values: Record<string, string> = {};
    for (let index = 0; index < rest.length; index += 2) {
      if (!['--model', '--host', '--v2-payload', '--v3-payload', '--output'].includes(rest[index]) || !rest[index + 1] || values[rest[index]]) throw new Error('Usage: cso-eval matrix --model <id> --host <claude|codex|gemini> --v2-payload <file> --v3-payload <file> --output <new-file>');
      values[rest[index]] = rest[index + 1];
    }
    if (Object.keys(values).length !== 5) throw new Error('All matrix flags are required; exact portable skill payloads and model identity must be pinned.');
    const payloads = { v2: readBoundedStable(resolve(values['--v2-payload']), PORTABLE_PAYLOAD_LIMIT, 'v2 portable skill payload').toString('utf8'), v3: readBoundedStable(resolve(values['--v3-payload']), PORTABLE_PAYLOAD_LIMIT, 'v3 portable skill payload').toString('utf8') };
    validatePortableSkillPayload(payloads.v2, 'v2'); validatePortableSkillPayload(payloads.v3, 'v3');
    const matrix = createEvalMatrix({ model: values['--model'], host: values['--host'] as ProducerHost, skillHashes: { v2: digest(payloads.v2), v3: digest(payloads.v3) } });
    safeWriteNew(values['--output'], matrix); console.log(JSON.stringify({ cells: matrix.cells.length, output: values['--output'], paidCalls: 0 })); return;
  }
  if (command === 'prepare') {
    if (rest.length !== 7 || rest[1] !== '--v2-payload' || rest[3] !== '--v3-payload' || rest[5] !== '--output') throw new Error('Usage: cso-eval prepare <matrix.json> --v2-payload <file> --v3-payload <file> --output <new-directory>');
    const matrix = readJsonBounded(rest[0], 16 * 1024 * 1024, 'evaluation matrix') as EvalMatrix;
    const schedule = prepareEvalJobs(matrix, { v2: readBoundedStable(resolve(rest[2]), PORTABLE_PAYLOAD_LIMIT, 'v2 portable skill payload').toString('utf8'), v3: readBoundedStable(resolve(rest[4]), PORTABLE_PAYLOAD_LIMIT, 'v3 portable skill payload').toString('utf8') }, rest[6]);
    console.log(JSON.stringify({ scheduled: schedule.scheduledCells, prepared: schedule.preparedCells, output: resolve(rest[6]), paidCalls: 0 })); return;
  }
  if (command === 'collect') {
    if (rest.length !== 4) throw new Error('Usage: cso-eval collect <matrix.json> <schedule.json> <receipts-directory> <new-batch.json>');
    const matrix = readJsonBounded(rest[0], 16 * 1024 * 1024, 'evaluation matrix') as EvalMatrix;
    const schedule = readJsonBounded(rest[1], 16 * 1024 * 1024, 'evaluation schedule') as PreparedEvalSchedule;
    const receiptRoot = resolve(rest[2]), stat = lstatSync(receiptRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(receiptRoot) !== receiptRoot) throw new Error('UNSAFE_RECEIPT_DIRECTORY');
    const receipts: ProducerReceipt[] = [];
    for (const entry of readdirSync(receiptRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('UNSAFE_RECEIPT_DIRECTORY');
      receipts.push(readJsonBounded(join(receiptRoot, entry.name), 40 * 1024 * 1024, 'producer receipt'));
    }
    const batch = collectProducerReceipts(matrix, schedule, receipts);
    safeWriteNew(resolve(rest[3]), batch);
    console.log(JSON.stringify({ output: resolve(rest[3]), submitted: batch.summary.submitted, missing: batch.summary.missing, modelMismatches: batch.summary.modelMismatches.length, paidCalls: 0 })); return;
  }
  if (command === 'score') {
    if (rest.length < 3 || rest.length > 4) throw new Error('Usage: cso-eval score <matrix.json> <producer-batch.json> <trusted-results.json> [qualification.json]');
    console.log(JSON.stringify(scoreCollectedEval(readJsonBounded(rest[0], 16 * 1024 * 1024, 'evaluation matrix'), readJsonBounded(rest[1], 16 * 1024 * 1024, 'producer batch'), readJsonBounded(rest[2], 64 * 1024 * 1024, 'trusted results'), rest[3] ? readJsonBounded(rest[3], 4 * 1024 * 1024, 'qualification') : undefined), null, 2)); return;
  }
  throw new Error('Usage: cso-eval <payload|matrix|prepare|materialize|collect|score>');
}
if (import.meta.main) { try { cli(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : 'CSO evaluation failed'); process.exitCode = 1; } }
