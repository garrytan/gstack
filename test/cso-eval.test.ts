import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectProducerReceipts, createEvalBaseline, createEvalMatrix, createPortableSkillPayload, loadPortableSkillPayload, prepareEvalJobs, REQUIRED_CONTAINMENT, scoreCollectedEval, scoreEval, validateMatrix, validatePortableSkillPayload, type EvalBaseline, type EvalCell, type EvalMatrix, type EvalResult, type PreparedEvalSchedule } from '../scripts/cso-eval';
import { assertProducerArtifactPath, PRODUCER_PROVIDER_POLICY, producerFailureMessage, producerProviderTimeoutMs, producerInstallationIdentity, resolveProducerHelperBinding, runProducerCell, sanitizeProducerRun, validateProductionProducerInstallation } from '../scripts/cso-eval-producer';
import { producerArtifactInventoryHash, producerHostPlatform, producerInstallationIdentityHash, producerProviderIdentityHash, producerReceiptHash, sha256, type ProducerArtifactInventory, type ProducerInstallationIdentity, type ProducerProviderIdentity, type ProducerReceipt } from '../scripts/cso-eval-protocol';
import type { Family, ProviderAdapter, RunOpts, RunResult } from './helpers/providers/types';
import { CORPUS_VERSION, FAMILIES, STACKS, defineEvalCorpus, loadCorpusManifest, materializeCase, sourceFiles, sourceHash, validateCorpusManifest, type CorpusManifest, type EvalVariant } from './fixtures/cso-eval/materialize';
import { judgeRepair, oracleFor, type PrivateEvidence } from './helpers/cso-eval-oracles';
import { inspectPreparation } from '../lib/cso/preparation';
import { assertRuntimeCompatible, RUNTIME_CATALOG } from '../lib/cso/runtime-catalog';
import { canonicalStartPlan, canonicalTestPlan } from '../lib/cso/verification';
import { CsoError } from '../lib/cso/contracts';
import { scan } from '../lib/redact-engine';
import { redactProducerText, sourceCredentialValues } from '../scripts/cso-eval-output-redaction';
import { geminiProducerPaths, geminiProducerSystemSettings } from './helpers/providers/gemini';

const temporary: string[] = [];
const randomHex = (bytes: number) => createHash('sha256').update(`${Math.random()}:${process.hrtime.bigint()}`).digest('hex').slice(0, bytes * 2);
const root = () => { const path = mkdtempSync(join(tmpdir(), 'cso-eval-')); temporary.push(path); return path; };
function unlockTemporary(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) { try { chmodSync(path, 0o600); } catch {} return; }
  try { chmodSync(path, 0o700); } catch {}
  for (const entry of readdirSync(path)) unlockTemporary(join(path, entry));
}
afterEach(() => { for (const path of temporary.splice(0)) { unlockTemporary(path); rmSync(path, { recursive: true, force: true }); } });
const corpus = loadCorpusManifest();
const matrix = createEvalMatrix({ model: 'matched-test-model', host: 'codex', skillHashes: { v2: 'a'.repeat(64), v3: 'b'.repeat(64) } });
const qualification = { containment: Object.fromEntries(REQUIRED_CONTAINMENT.map(name => [name, 'passed' as const])) };

function portableSkill(version: 'v2' | 'v3', sectionMarker: string): string {
  const manifest = JSON.stringify({ $schema: 'https://gstack.dev/schemas/section-manifest.json', skill: 'cso', version: 1, sections: [{ id: 'audit-phases', file: 'audit-phases.md', title: 'Audit phases', trigger: 'during audit phases' }] }, null, 2) + '\n';
  return createPortableSkillPayload(version, [
    { path: 'SKILL.md', contents: `---\nname: cso\nversion: ${version.slice(1)}.0.0\n---\n# CSO ${version}\nRead cso/sections/audit-phases.md before auditing.\n` },
    { path: 'sections/manifest.json', contents: manifest },
    { path: 'sections/audit-phases.md', contents: `# Complete ${version} phases\n${sectionMarker}\n` },
  ]);
}

/** Synthetic accounting records exercise the scorer. These are not measured agent results. */
const syntheticResult = (cell: EvalCell): EvalResult => syntheticResultFor(cell, corpus);
function syntheticResultFor(cell: EvalCell, manifest: CorpusManifest<string>): EvalResult {
  const runtime = cell.mode === 'comprehensive';
  const positive = cell.variant === 'vulnerable';
  const repairEvidenceHash = 'c'.repeat(64), recheckEvidenceHash = 'd'.repeat(64);
  return { cellId: cell.id, sourceHash: cell.sourceHash, skillHash: cell.skillHash, model: cell.model, host: cell.host, budgetSeconds: cell.budgetSeconds,
    reportPresent: true, reportComplete: true,
    findings: positive ? [{ id: 'finding-1', evidence: cell.version === 'v2' ? 'legacy_review' : 'supported', claimedTested: runtime && cell.version === 'v3', judgment: 'correct', matchedCaseId: cell.caseId,
      ...(runtime && cell.version === 'v3' ? { trustedVerification: { repair: 'passed' as const, repairEvidenceHash, recheck: 'passed' as const, recheckEvidenceHash } } : {}) }] : [],
    setup: runtime ? 'passed' : 'not_attempted', reproduction: runtime && positive ? 'passed' : 'not_attempted', repair: runtime && positive ? 'passed' : 'not_attempted', recheck: runtime && positive ? 'passed' : 'not_attempted',
    ...(runtime && positive ? { oracleEvidenceHash: repairEvidenceHash, oracleVersion: manifest.version, currentSourceHash: manifest.cases.find(fixture => fixture.id === cell.caseId)!.filesHash.fixed, recheckEvidenceHash } : {}),
    heldOutAssertionsPassed: runtime && positive, freshRecheck: runtime && positive, latencyMs: 1500, firstUsefulResultMs: positive ? 500 : null,
  };
}
const group = (score: ReturnType<typeof scoreEval>, version: string, mode: string) => score.groups.find(item => item.version === version && item.mode === mode)!;
function syntheticInstallationIdentity(seed = '1', catalogSeed = seed): ProducerInstallationIdentity {
  const artifact = (offset: number) => ({ sha256: sha256(`${seed}:artifact:${offset}`), bytes: 100 + offset });
  const core = artifact(3);
  const withoutHash: Omit<ProducerInstallationIdentity, 'identityHash'> = {
    schemaVersion: 1,
    producer: artifact(1), launcher: artifact(2), core, watchdog: artifact(4),
    generation: { coreSha256: core.sha256, manifest: { sha256: sha256(`${core.sha256}\n`), bytes: 65 } },
    embeddedCatalogs: {
      runtimeRevision: 'runtime-test', runtimeBuildRevision: 'runtime-build-test', runtimeSha256: sha256(`${catalogSeed}:runtime`),
      scannerRevision: 'scanner-test', scannerSha256: sha256(`${catalogSeed}:scanner`),
    },
  };
  return { ...withoutHash, identityHash: producerInstallationIdentityHash(withoutHash) };
}
function syntheticProviderIdentity(family: Family = 'gpt', seed = '1'): ProducerProviderIdentity {
  const withoutHash: Omit<ProducerProviderIdentity, 'identityHash'> = {
    schemaVersion: 1, family, policyRevision: `${family}-test-policy`,
    executable: { sha256: sha256(`${seed}:${family}:provider`), bytes: 200 }, argsPrefix: [], version: `${family}-test-version`,
  };
  return { ...withoutHash, identityHash: producerProviderIdentityHash(withoutHash) };
}
function syntheticArtifactInventory(): ProducerArtifactInventory {
  const base = { schemaVersion: 1 as const, root: 'security/cso' as const, entries: [], totalBytes: 0 };
  return { ...base, identityHash: producerArtifactInventoryHash(base) };
}
/** Platform-pinned cells get one native installation and provider binary per platform, sharing catalogs and provider policy. */
function syntheticReceipt(cell: EvalCell): ProducerReceipt {
  const seed = cell.platform ?? '1';
  const withoutHash: Omit<ProducerReceipt, 'receiptHash'> = { schemaVersion: 2, cellRef: cell.id, inputHash: 'e'.repeat(64), installationIdentity: syntheticInstallationIdentity(seed, '1'), providerIdentity: syntheticProviderIdentity(cell.host === 'codex' ? 'gpt' : cell.host, seed), artifacts: syntheticArtifactInventory(), startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', status: 'succeeded', requestedModel: cell.model, modelUsed: `resolved-${cell.model}`, modelIdentitySource: 'provider_reported', durationMs: 1000, firstUsefulResultMs: null, toolCalls: 1, output: 'synthetic producer transcript', outputHash: sha256('synthetic producer transcript'), usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, estimatedCostUSD: 0.001 } };
  return { ...withoutHash, receiptHash: producerReceiptHash(withoutHash) };
}
function syntheticSchedule(target: EvalMatrix = matrix): PreparedEvalSchedule {
  return { schemaVersion: 1, matrixHash: createHash('sha256').update(JSON.stringify(target)).digest('hex'), scheduledCells: target.cells.length, preparedCells: target.cells.length, jobs: target.cells.map(cell => ({ cellId: cell.id, relativePath: `jobs/${cell.id}`, inputHash: 'e'.repeat(64) })) };
}
function rehashReceipt(receipt: ProducerReceipt): ProducerReceipt {
  const { receiptHash: _receiptHash, ...withoutHash } = receipt;
  return { ...withoutHash, receiptHash: producerReceiptHash(withoutHash) };
}
function syntheticBatch() {
  return collectProducerReceipts(matrix, syntheticSchedule(), matrix.cells.map(syntheticReceipt));
}

describe('CSO immutable evaluation corpus', () => {
  test('contains forty distinct vulnerable/fixed pairs across ten families and four stacks', () => {
    expect(corpus.cases).toHaveLength(40);
    for (const stack of STACKS) expect(corpus.cases.filter(fixture => fixture.stack === stack).map(fixture => fixture.family)).toEqual([...FAMILIES]);
    for (const fixture of corpus.cases) {
      expect(fixture.filesHash.vulnerable).not.toBe(fixture.filesHash.fixed);
      for (const variant of ['vulnerable', 'fixed'] as const) expect(sourceHash(sourceFiles(fixture.id, variant))).toBe(fixture.filesHash[variant]);
    }
  });
  test('producer snapshots contain app source but no private oracle, labels, or alternative fixed copy', () => {
    const parent = root(); const result = materializeCase('node-sql-injection', 'vulnerable', join(parent, 'app'));
    expect(result.sourceHash).toBe(corpus.cases[0].filesHash.vulnerable);
    expect(readdirSync(result.path).sort()).toEqual(['README.md', 'app.mjs', 'package-lock.json', 'package.json', 'test']);
    const combined = ['README.md', 'app.mjs', 'package-lock.json', 'package.json', 'test/control.test.mjs']
      .map(file => readFileSync(join(result.path, file), 'utf8')).join('\n');
    expect(combined).not.toContain('ORACLE_SQL_MARKER'); expect(combined).not.toContain('filesHash'); expect(combined).not.toContain('heldOut');
    expect(combined).toContain('the intended member workflow remains available');
    expect(() => materializeCase('node-sql-injection', 'fixed', result.path)).toThrow('CORPUS_DESTINATION_EXISTS');
  });
  test('rejects unknown cases and symlink destination ancestors', () => {
    const parent = root(); symlinkSync(parent, join(parent, 'alias'));
    expect(() => materializeCase('unknown', 'fixed', join(parent, 'no'))).toThrow('UNKNOWN_CORPUS_CASE');
    expect(() => materializeCase('node-sql-injection', 'fixed', join(parent, 'alias', 'no'))).toThrow('UNSAFE_CORPUS_DESTINATION');
  });
  test('all source fixtures have supported inert dependency metadata, including real Rails locks', () => {
    const parent = root();
    for (const fixture of corpus.cases) {
      const { path } = materializeCase(fixture.id, 'vulnerable', join(parent, fixture.id));
      const plan = inspectPreparation(path, fixture.stack);
      expect({ id: fixture.id, status: plan.status, prerequisites: plan.prerequisites }).toEqual({ id: fixture.id, status: 'ready', prerequisites: [] });
      const reviewed = RUNTIME_CATALOG.profiles.find(profile => profile.stack === fixture.stack && profile.platform === 'linux/amd64');
      expect(reviewed).toBeDefined();
      expect(() => assertRuntimeCompatible(plan, reviewed as any)).not.toThrow();
    }
  });
  test('every pair exposes a helper-derived startup and nonempty legitimate regression suite', () => {
    const parent = root();
    for (const fixture of corpus.cases) for (const variant of ['vulnerable', 'fixed'] as const) {
      const { path } = materializeCase(fixture.id, variant, join(parent, `${fixture.id}-${variant}`));
      const start = canonicalStartPlan(path, fixture.stack, 8000);
      const tests = canonicalTestPlan(path, fixture.stack);
      expect(start.command.executable.startsWith('/')).toBe(true);
      expect(start.entrypointFiles.length).toBeGreaterThan(0);
      expect(tests.commands.length).toBeGreaterThan(0);
      expect(tests.minimumPassingTests.every(count => count >= 1)).toBe(true);
      expect(tests.files.some(file => /(?:test|spec)/.test(file))).toBe(true);
    }
  });
  test('Rails lock provenance binds the native resolver inputs and exact public archive metadata', () => {
    const source = sourceFiles('rails-sql-injection', 'vulnerable');
    const provenance = JSON.parse(readFileSync(new URL('./fixtures/cso-eval/rails-lock-provenance.json', import.meta.url), 'utf8'));
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(hash(source.Gemfile)).toBe(provenance.gemfileSha256); expect(hash(source['Gemfile.lock'])).toBe(provenance.lockSha256);
    const pins = [...source['Gemfile.lock'].matchAll(/^    ([A-Za-z0-9_.-]+) \(([^)]+)\)$/gm)];
    expect(provenance.archives).toHaveLength(pins.length);
    for (const [, name, version] of pins) expect(provenance.archives.some((archive: any) => archive.name === name && archive.version === version && /^[a-f0-9]{64}$/.test(archive.sha256))).toBe(true);
    expect(provenance.qualification).toContain('not-run');
  });
});

describe('CSO private repair oracles', () => {
  function validEvidence(): PrivateEvidence {
    const oracle = oracleFor('object-authorization');
    const control = { request: oracle.controls[0].request, response: { status: 200, body: '{"owner":"member-1","total":12}' } };
    return { original: { booted: true, controls: [control], attack: { request: oracle.attack, response: { status: 200, body: '{"owner":"member-2","total":9800}' } } },
      patched: { booted: true, controls: [control], attack: { request: oracle.attack, response: { status: 403, body: '{"error":"forbidden"}' } }, heldOut: oracle.heldOut.map(assertion => ({ request: assertion.request, response: { status: 403, body: '{"error":"forbidden"}' } })), existingTestsPassed: true },
      immutableVerifier: true, independentRootCauseReview: true, featurePreserved: true, boundaryMocks: false };
  }
  test('requires original exploit, unchanged verifier, legitimate behavior, and held-out assertions', () => {
    const evidence = validEvidence(); expect(judgeRepair('object-authorization', evidence).correctRepair).toBe(true);
    for (const mutation of [(item: PrivateEvidence) => { item.original.booted = false; }, (item: PrivateEvidence) => { item.patched.controls = []; }, (item: PrivateEvidence) => { item.patched.heldOut = []; }, (item: PrivateEvidence) => { item.immutableVerifier = false; }, (item: PrivateEvidence) => { item.featurePreserved = false; }, (item: PrivateEvidence) => { item.boundaryMocks = true; }]) {
      const changed = structuredClone(evidence); mutation(changed); expect(judgeRepair('object-authorization', changed).correctRepair).toBe(false);
    }
  });
  test('a setup error cannot become an intended security assertion failure', () => {
    const evidence = validEvidence(); evidence.original.attack.response = { status: 500, body: 'database unavailable' };
    expect(judgeRepair('object-authorization', evidence).reproduced).toBe(false);
  });
  test('every family has a legitimate control and at least one withheld alternate assertion', () => {
    for (const family of FAMILIES) { const oracle = oracleFor(family); expect(oracle.controls.length).toBeGreaterThan(0); expect(oracle.heldOut.length).toBeGreaterThan(0); }
  });
});

describe('CSO matched evaluation accounting', () => {
  test('pins three repetitions and identical models, sources, budgets, and host for v2/v3', () => {
    expect(matrix.cells).toHaveLength(960); expect(matrix.repetitions).toBe(3); expect(new Set(matrix.cells.map(cell => cell.id)).size).toBe(960);
    validateMatrix(matrix);
    const changed = structuredClone(matrix); changed.cells[1].budgetSeconds += 1; expect(() => validateMatrix(changed)).toThrow('UNMATCHED_OR_INCOMPLETE');
    expect(() => createEvalMatrix({ model: 'model', host: 'codex', skillHashes: { v2: 'a'.repeat(64), v3: 'a'.repeat(64) } })).toThrow('INVALID_MATCHED_EVAL_INPUT');
  });
  test('empty results are unmeasured, with honest denominators and unknown cost', () => {
    const score = scoreEval(matrix, []); expect(score.status).toBe('unmeasured'); expect(Object.values(score.gates).every(value => value === 'unmeasured')).toBe(true);
    const comprehensive = group(score, 'v3', 'comprehensive'); expect(comprehensive.reproduction).toEqual({ numerator: 0, denominator: 120, value: 0 }); expect(comprehensive.precision.value).toBeNull(); expect(comprehensive.cost.totalUSD).toBeNull();
  });
  test('fully adjudicated synthetic results exercise all release gates without missing denominators', () => {
    const score = scoreEval(matrix, matrix.cells.map(syntheticResult), qualification);
    expect(score.status).toBe('qualified'); expect(Object.values(score.gates).every(value => value === 'pass')).toBe(true);
    expect(group(score, 'v3', 'daily').precision).toEqual({ numerator: 120, denominator: 120, value: 1 });
    expect(group(score, 'v3', 'comprehensive').highCriticalRecall).toEqual({ numerator: 96, denominator: 96, value: 1 });
    expect(score.perStack.rails).toEqual({ correctHeldOutRepairs: 10, denominator: 10 });
  });
  test('incomplete mandatory reports cannot contribute security evidence or qualify a complete matrix', () => {
    const results = matrix.cells.map(syntheticResult);
    for (const result of results) result.reportComplete = false;
    const score = scoreEval(matrix, results, qualification), daily = group(score, 'v3', 'daily'), comprehensive = group(score, 'v3', 'comprehensive');
    expect(score.status).toBe('partial');
    expect(score.gates.matchedCompleteMatrix).toBe('fail');
    expect(score.gates.mandatoryReports).toBe('fail');
    expect(daily.reports).toEqual({ numerator: 0, denominator: 240, value: 0 });
    expect(daily.precision).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(daily.recall.numerator).toBe(0);
    expect(comprehensive.setup.numerator).toBe(0);
    expect(comprehensive.reproduction.numerator).toBe(0);
    expect(comprehensive.repair.numerator).toBe(0);
    expect(comprehensive.recheck.numerator).toBe(0);
    expect(score.perStack.rails.correctHeldOutRepairs).toBe(0);
  });
  test('release scoring binds every trusted judgment to a complete matched producer batch', () => {
    const batch = syntheticBatch();
    const results = matrix.cells.map(cell => ({ ...syntheticResult(cell), producerReceiptHash: batch.receipts.find(receipt => receipt.cell.id === cell.id)!.receiptHash }));
    expect(scoreCollectedEval(matrix, batch, results, qualification)).toMatchObject({ status: 'qualified', producerBatchHash: batch.batchHash });
    delete results[0].producerReceiptHash;
    expect(() => scoreCollectedEval(matrix, batch, results, qualification)).toThrow('UNBOUND_EVAL_RESULT');
    const incomplete = structuredClone(batch); incomplete.receipts.pop();
    expect(() => scoreCollectedEval(matrix, incomplete, matrix.cells.map(syntheticResult), qualification)).toThrow('INCOMPLETE_PRODUCER_BATCH');
  });
  test('rejects tampered and mixed producer installation/provider identities across incomplete batches', () => {
    const cells = matrix.cells.filter(cell => cell.version === 'v2').slice(0, 2);
    const first = syntheticReceipt(cells[0]);
    const tampered = structuredClone(first);
    tampered.installationIdentity.core.sha256 = 'f'.repeat(64);
    expect(() => collectProducerReceipts(matrix, syntheticSchedule(), [rehashReceipt(tampered)])).toThrow('INVALID_PRODUCER_GENERATION_IDENTITY');

    const artifactTamper = structuredClone(first);
    artifactTamper.artifacts.totalBytes = 1;
    expect(() => collectProducerReceipts(matrix, syntheticSchedule(), [rehashReceipt(artifactTamper)])).toThrow('INVALID_PRODUCER_RECEIPT');

    const mixedInstallation = syntheticReceipt(cells[1]);
    mixedInstallation.installationIdentity = syntheticInstallationIdentity('different-installation');
    expect(() => collectProducerReceipts(matrix, syntheticSchedule(), [first, rehashReceipt(mixedInstallation)])).toThrow('UNMATCHED_PRODUCER_INSTALLATIONS');

    const mixedProvider = syntheticReceipt(cells[1]);
    mixedProvider.providerIdentity = syntheticProviderIdentity('gpt', 'different-provider');
    expect(() => collectProducerReceipts(matrix, syntheticSchedule(), [first, rehashReceipt(mixedProvider)])).toThrow('UNMATCHED_PRODUCER_PROVIDERS');
  });
  test('receipts name only an opaque cellRef that the trusted matrix resolves', () => {
    const cell = matrix.cells.find(item => item.version === 'v3')!, receipt = syntheticReceipt(cell);
    expect(Object.keys(receipt)).not.toContain('cell'); expect(JSON.stringify(receipt)).not.toMatch(/caseId|variant|vulnerable|"fixed"/);
    expect(JSON.stringify(receipt)).not.toContain(cell.caseId);
    const unknown = structuredClone(receipt); unknown.cellRef = 'f'.repeat(64);
    expect(() => collectProducerReceipts(matrix, syntheticSchedule(), [rehashReceipt(unknown)])).toThrow('UNKNOWN_OR_DUPLICATE_PRODUCER_RECEIPT');
    const smuggled = rehashReceipt({ ...structuredClone(receipt), cell } as ProducerReceipt);
    expect(() => collectProducerReceipts(matrix, syntheticSchedule(), [smuggled])).toThrow('INVALID_PRODUCER_RECEIPT');
    const batch = syntheticBatch();
    expect(batch.receipts.every(index => index.cellRef === index.cell.id && JSON.stringify(index.cell) === JSON.stringify(matrix.cells.find(item => item.id === index.cellRef)))).toBe(true);
    const relabeled = structuredClone(batch); relabeled.receipts[0].cellRef = relabeled.receipts[1].cellRef;
    const { batchHash: _hash, ...rest } = relabeled; relabeled.batchHash = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    expect(() => scoreCollectedEval(matrix, relabeled, [], qualification)).toThrow('INVALID_PRODUCER_BATCH');
  });
  test('high/critical recall includes critical cases and detects a v3 regression',()=>{
    const criticalCorpus=structuredClone(corpus);criticalCorpus.cases.find(item=>item.severity==='medium')!.severity='critical';
    const criticalMatrix=createEvalMatrix({model:'matched-test-model',host:'codex',skillHashes:{v2:'a'.repeat(64),v3:'b'.repeat(64)}},criticalCorpus),complete=criticalMatrix.cells.map(syntheticResult);
    expect(group(scoreEval(criticalMatrix,complete,qualification,criticalCorpus),'v3','comprehensive').highCriticalRecall).toEqual({numerator:99,denominator:99,value:1});
    const criticalId=criticalCorpus.cases.find(item=>item.severity==='critical')!.id;
    for(let index=0;index<criticalMatrix.cells.length;index++){const cell=criticalMatrix.cells[index];if(cell.version==='v3'&&cell.mode==='comprehensive'&&cell.variant==='vulnerable'&&cell.caseId===criticalId)complete[index].findings=[];}
    const regressed=scoreEval(criticalMatrix,complete,qualification,criticalCorpus);expect(group(regressed,'v3','comprehensive').highCriticalRecall).toEqual({numerator:96,denominator:99,value:96/99});expect(regressed.gates.noHighCriticalRecallRegression).toBe('fail');
  });
  test('supported setup blocks count as misses, including unreproduced and unrepaired work', () => {
    const cell = matrix.cells.find(item => item.version === 'v3' && item.mode === 'comprehensive' && item.variant === 'vulnerable')!;
    const result = syntheticResult(cell); result.setup = 'blocked'; result.prerequisite = 'missing native library'; result.findings = []; result.reproduction = result.repair = result.recheck = 'blocked';
    const score = scoreEval(matrix, [result]); const comprehensive = group(score, 'v3', 'comprehensive');
    expect(comprehensive.setup).toEqual({ numerator: 0, denominator: 240, value: 0 }); expect(comprehensive.highCriticalRecall.denominator).toBe(96); expect(comprehensive.setupBlocked).toBe(1);
  });
  test('duplicate findings do not inflate precision and fixed-source false positives count', () => {
    const positive = matrix.cells.find(item => item.version === 'v3' && item.mode === 'daily' && item.variant === 'vulnerable')!;
    const negative = matrix.cells.find(item => item.version === 'v3' && item.mode === 'daily' && item.variant === 'fixed')!;
    const one = syntheticResult(positive); one.findings.push({ ...one.findings[0], id: 'duplicate' });
    const two = syntheticResult(negative); two.findings.push({ id: 'false-positive', evidence: 'supported', claimedTested: false, judgment: 'incorrect' });
    expect(group(scoreEval(matrix, [one, two]), 'v3', 'daily').precision).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
  });
  test('producer tested claims require independent successful held-out repair evidence', () => {
    const cell = matrix.cells.find(item => item.version === 'v3' && item.mode === 'comprehensive' && item.variant === 'vulnerable')!;
    const result = syntheticResult(cell); delete result.oracleEvidenceHash;
    const score = scoreEval(matrix, [result]); expect(group(score, 'v3', 'comprehensive').falseTested).toBe(1); expect(group(score, 'v3', 'comprehensive').repair.numerator).toBe(0);
  });
  test('one trusted cell repair cannot certify another claimed-tested finding', () => {
    const results = matrix.cells.map(syntheticResult), cell = matrix.cells.find(item => item.version === 'v3' && item.mode === 'comprehensive' && item.variant === 'vulnerable')!, result = results.find(item => item.cellId === cell.id)!;
    result.findings.push({ id: 'unbound-tested-claim', evidence: 'supported', claimedTested: true, judgment: 'correct', matchedCaseId: cell.caseId });
    const score = scoreEval(matrix, results, qualification);
    expect(group(score, 'v3', 'comprehensive').falseTested).toBe(1); expect(score.gates.zeroFalselyTestedRepairs).toBe('fail'); expect(score.status).toBe('partial');
    result.findings[1].trustedVerification = structuredClone(result.findings[0].trustedVerification);
    expect(() => scoreEval(matrix, results, qualification)).toThrow('DUPLICATE_TRUSTED_REPAIR_BINDING');
  });
  test('per-stack held-out repair requires the matching supported discovery', () => {
    const results = matrix.cells.map(syntheticResult);
    for (let index = 0; index < matrix.cells.length; index++) {
      const cell = matrix.cells[index];
      if (cell.version === 'v3' && cell.mode === 'comprehensive' && cell.variant === 'vulnerable' && cell.stack === 'rails') results[index].findings = [];
    }
    const score = scoreEval(matrix, results, qualification);
    expect(score.perStack.rails).toEqual({ correctHeldOutRepairs: 0, denominator: 10 });
    expect(score.gates.heldOutRepairEachStack).toBe('fail');
  });
  test('legacy review evidence cannot raise v3 recall or earn tested repair', () => {
    const cell = matrix.cells.find(item => item.version === 'v3' && item.mode === 'comprehensive' && item.variant === 'vulnerable')!;
    const result = syntheticResult(cell); result.findings[0].evidence = 'legacy_review';
    const score = scoreEval(matrix, [result]); expect(group(score, 'v3', 'comprehensive').recall.numerator).toBe(0); expect(group(score, 'v3', 'comprehensive').falseTested).toBe(1);
  });
  test('old-source recheck and missing held-out assertions cannot establish repair success', () => {
    const cell = matrix.cells.find(item => item.version === 'v3' && item.mode === 'comprehensive' && item.variant === 'vulnerable')!;
    const result = syntheticResult(cell); result.currentSourceHash = cell.sourceHash;
    expect(group(scoreEval(matrix, [result]), 'v3', 'comprehensive').recheck.numerator).toBe(0);
    result.heldOutAssertionsPassed = false; expect(group(scoreEval(matrix, [result]), 'v3', 'comprehensive').repair.numerator).toBe(0);
  });
  test('accepts a correct alternative patch but rejects reused repair evidence for closure', () => {
    const cell = matrix.cells.find(item => item.version === 'v3' && item.mode === 'comprehensive' && item.variant === 'vulnerable')!;
    const result = syntheticResult(cell); result.currentSourceHash = 'e'.repeat(64);
    expect(group(scoreEval(matrix, [result]), 'v3', 'comprehensive').recheck.numerator).toBe(1);
    result.recheckEvidenceHash = result.oracleEvidenceHash;
    expect(group(scoreEval(matrix, [result]), 'v3', 'comprehensive').recheck.numerator).toBe(0);
  });
  test('rejects mismatched model budgets, duplicate results, and application execution in daily mode', () => {
    const result = syntheticResult(matrix.cells[0]);
    expect(() => scoreEval(matrix, [result, result])).toThrow('UNKNOWN_OR_DUPLICATE');
    expect(() => scoreEval(matrix, [{ ...result, model: 'other-model' }])).toThrow('UNMATCHED_EVAL_RESULT');
    expect(() => scoreEval(matrix, [{ ...result, setup: 'passed' }])).toThrow('DAILY_EVAL_EXECUTED');
    const comprehensive = syntheticResult(matrix.cells.find(cell => cell.version === 'v3' && cell.mode === 'comprehensive' && cell.variant === 'vulnerable')!);
    comprehensive.findings[0].trustedVerification = { repair: 'failed', repairEvidenceHash: 'not-a-hash', recheck: 'not_attempted' };
    expect(() => scoreEval(matrix, [comprehensive])).toThrow('INVALID_TRUSTED_FINDING_VERIFICATION');
  });
  test('missing containment tests remain unmeasured and a failed canary fails qualification', () => {
    const results = matrix.cells.map(syntheticResult);
    expect(scoreEval(matrix, results).gates.containmentAndCanaries).toBe('unmeasured');
    expect(scoreEval(matrix, results, { containment: { 'split-output-secrets': 'failed' } }).gates.containmentAndCanaries).toBe('fail');
  });
  test('precision and high-impact recall thresholds fail independently on a complete matrix', () => {
    const results = matrix.cells.map(syntheticResult);
    let falsePositives = 0, misses = 0;
    for (let index = 0; index < matrix.cells.length; index++) {
      const cell = matrix.cells[index];
      if (cell.version === 'v3' && cell.mode === 'daily' && cell.variant === 'fixed' && falsePositives < 7) {
        results[index].findings = [{ id: 'false-positive', evidence: 'supported', claimedTested: false, judgment: 'incorrect' }]; falsePositives++;
      }
      if (cell.version === 'v3' && cell.mode === 'comprehensive' && cell.variant === 'vulnerable' && corpus.cases.find(fixture => fixture.id === cell.caseId)!.severity === 'high' && misses < 20) {
        results[index].findings = []; misses++;
      }
    }
    const score = scoreEval(matrix, results, qualification);
    expect(score.gates.dailyPrecision95).toBe('fail'); expect(score.gates.comprehensiveHighCriticalRecall80).toBe('fail'); expect(score.gates.noHighCriticalRecallRegression).toBe('fail');
  });
});

/** Synthetic stand-in with the private corpus layout. It is not held-out content. */
const privateFiles = (id: string, variant: EvalVariant): Record<string, string> => ({ 'README.md': '# Synthetic service\n', 'src/app.txt': `synthetic ${id} ${variant}\n` });
const privateManifest: CorpusManifest<string> = { schemaVersion: 1, version: 'synthetic-private-1', cases: STACKS.flatMap(stack => ['alpha-family', 'beta-family'].map((family, index) => {
  const id = `${stack}-${family}`;
  return { id, stack, family, severity: index === 0 ? 'high' as const : 'medium' as const, rootCause: family, location: { path: 'src/app.txt', symbol: 'action' },
    coreColdStart: true as const, heldOut: true as const, filesHash: { vulnerable: sourceHash(privateFiles(id, 'vulnerable')), fixed: sourceHash(privateFiles(id, 'fixed')) } };
})) };
const privateCorpus = defineEvalCorpus(privateManifest, privateFiles);
const releasePlatforms = { daily: 'linux/amd64' as const, comprehensive: Object.fromEntries(privateManifest.cases.map((fixture, index) => [fixture.id, index % 2 ? 'linux/arm64' as const : 'linux/amd64' as const])) };
const releaseOptions = { profile: 'release' as const, model: 'matched-test-model', host: 'codex' as const, skillHashes: { v3: 'b'.repeat(64) }, platforms: releasePlatforms };
function privateBaseline(mutate: (results: EvalResult[], cells: EvalCell[]) => void = () => {}): EvalBaseline {
  const baselineMatrix = createEvalMatrix({ profile: 'baseline', model: 'matched-test-model', host: 'codex', skillHashes: { v2: 'a'.repeat(64) }, platforms: { comprehensive: releasePlatforms.comprehensive } }, privateManifest);
  const batch = collectProducerReceipts(baselineMatrix, syntheticSchedule(baselineMatrix), baselineMatrix.cells.map(syntheticReceipt), privateManifest);
  const results = baselineMatrix.cells.map(cell => ({ ...syntheticResultFor(cell, privateManifest), producerReceiptHash: batch.receipts.find(receipt => receipt.cell.id === cell.id)!.receiptHash }));
  mutate(results, baselineMatrix.cells);
  return createEvalBaseline(baselineMatrix, batch, results, privateManifest);
}
function releaseRun(baseline: EvalBaseline | null = privateBaseline()) {
  const release = createEvalMatrix({ ...releaseOptions, ...(baseline ? { baseline } : {}) }, privateManifest);
  const batch = collectProducerReceipts(release, syntheticSchedule(release), release.cells.map(syntheticReceipt), privateManifest);
  const results = release.cells.map(cell => ({ ...syntheticResultFor(cell, privateManifest), producerReceiptHash: batch.receipts.find(receipt => receipt.cell.id === cell.id)!.receiptHash }));
  return { release, batch, results };
}

describe('CSO release profile on an injected corpus', () => {
  test('the full profile matrix is byte-identical to its pre-release-profile form', () => {
    expect(createHash('sha256').update(JSON.stringify(matrix)).digest('hex')).toBe('a0f20a127c8c92c73bb2a277f740295c153ccf95901e92cffab34a4553ef976b');
    expect('profile' in matrix).toBe(false); expect(matrix.cells.every(cell => !('platform' in cell))).toBe(true);
  });
  test('an injected corpus shares the public layout and binds every generated source', () => {
    expect(validateCorpusManifest(structuredClone(corpus))).toEqual(corpus);
    const destination = join(root(), 'case');
    expect(materializeCase('rails-beta-family', 'fixed', destination, privateCorpus).sourceHash).toBe(privateManifest.cases.find(item => item.id === 'rails-beta-family')!.filesHash.fixed);
    expect(readFileSync(join(destination, 'src/app.txt'), 'utf8')).toBe('synthetic rails-beta-family fixed\n');
    expect(() => defineEvalCorpus({ ...privateManifest, version: CORPUS_VERSION }, privateFiles)).toThrow('INJECTED_CORPUS_REUSES_PUBLIC_VERSION');
    expect(() => defineEvalCorpus(privateManifest, (id, variant) => ({ ...privateFiles(id, variant), extra: 'drift' }))).toThrow('CORPUS_INTEGRITY_MISMATCH');
    expect(() => defineEvalCorpus(privateManifest, () => ({ '../escape.txt': 'x' }))).toThrow('INVALID_CORPUS_SOURCE');
    const unknownStack = structuredClone(privateManifest); (unknownStack.cases[0] as any).stack = 'php';
    expect(() => validateCorpusManifest(unknownStack)).toThrow('INVALID_CORPUS_MANIFEST');
    const extraField = structuredClone(privateManifest); (extraField.cases[0] as any).answer = 'oracle';
    expect(() => validateCorpusManifest(extraField)).toThrow('INVALID_CORPUS_MANIFEST');
  });
  test('release pins v3, one repetition, and one native platform per cell', () => {
    const release = createEvalMatrix(releaseOptions, privateManifest);
    expect(release.cells).toHaveLength(privateManifest.cases.length * 4); expect(release.repetitions).toBe(1); expect(release.baselineHash).toBeNull();
    expect(release.cells.every(cell => cell.version === 'v3' && cell.repetition === 1)).toBe(true);
    expect(release.cells.filter(cell => cell.mode === 'daily').every(cell => cell.platform === 'linux/amd64')).toBe(true);
    for (const cell of release.cells.filter(item => item.mode === 'comprehensive')) expect(cell.platform).toBe(releasePlatforms.comprehensive[cell.caseId]);
    expect(new Set(release.cells.filter(cell => cell.mode === 'comprehensive').map(cell => cell.platform))).toEqual(new Set(['linux/amd64', 'linux/arm64']));
    validateMatrix(release, privateManifest);
    const moved = structuredClone(release); moved.platforms.comprehensive[privateManifest.cases[0].id] = 'linux/arm64';
    expect(() => validateMatrix(moved, privateManifest)).toThrow('UNMATCHED_OR_INCOMPLETE_EVAL_MATRIX');
    const { [privateManifest.cases[0].id]: _omitted, ...partial } = releasePlatforms.comprehensive;
    expect(() => createEvalMatrix({ ...releaseOptions, platforms: { daily: 'linux/amd64', comprehensive: partial } }, privateManifest)).toThrow('INVALID_EVAL_PLATFORMS');
    expect(() => createEvalMatrix({ ...releaseOptions, platforms: { daily: 'linux/riscv64' as any, comprehensive: releasePlatforms.comprehensive } }, privateManifest)).toThrow('INVALID_EVAL_PLATFORMS');
    expect(() => createEvalMatrix({ ...releaseOptions, skillHashes: { v2: 'a'.repeat(64), v3: 'b'.repeat(64) } as any }, privateManifest)).toThrow('INVALID_MATCHED_EVAL_INPUT');
  });
  test('a two-platform batch collects and scores qualified against a hash-bound v2 baseline', () => {
    const { release, batch, results } = releaseRun();
    expect(new Set(batch.receipts.map(receipt => receipt.installationIdentity.identityHash)).size).toBe(2);
    expect(batch.summary.groups.map(group => `${group.version}:${group.mode}`)).toEqual(['v3:daily', 'v3:comprehensive']);
    const baseline = privateBaseline();
    const score = scoreCollectedEval(release, batch, results, qualification, privateManifest, baseline);
    expect(score.status).toBe('qualified'); expect(Object.values(score.gates).every(value => value === 'pass')).toBe(true);
    expect(score.profile).toBe('release'); expect(score.baseline).toEqual({ baselineHash: baseline.baselineHash, highCriticalRecall: { numerator: 4, denominator: 4, value: 1 } });
    expect(score.groups.map(item => `${item.version}:${item.mode}`)).toEqual(['v3:daily', 'v3:comprehensive']);
  });
  test('a mixed-corpus batch is rejected', () => {
    const { release, batch, results } = releaseRun();
    expect(() => scoreCollectedEval(release, batch, results, qualification)).toThrow('UNMATCHED_OR_INCOMPLETE_EVAL_MATRIX');
    expect(() => collectProducerReceipts(release, syntheticSchedule(release), release.cells.map(syntheticReceipt))).toThrow('UNMATCHED_OR_INCOMPLETE_EVAL_MATRIX');
    const mixed = structuredClone(release); mixed.cells[0] = { ...matrix.cells.find(cell => cell.version === 'v3' && cell.repetition === 1)!, platform: 'linux/amd64' };
    expect(() => validateMatrix(mixed, privateManifest)).toThrow('UNMATCHED_OR_INCOMPLETE_EVAL_MATRIX');
    const publicCell = matrix.cells.find(cell => cell.version === 'v3')!;
    expect(() => collectProducerReceipts(release, syntheticSchedule(release), [syntheticReceipt(publicCell)], privateManifest)).toThrow('UNKNOWN_OR_DUPLICATE_PRODUCER_RECEIPT');
    expect(() => scoreCollectedEval(release, syntheticBatch(), results, qualification, privateManifest)).toThrow('INVALID_PRODUCER_BATCH');
    expect(() => scoreEval(release, [syntheticResult(publicCell)], qualification, privateManifest)).toThrow('UNKNOWN_OR_DUPLICATE_EVAL_RESULT');
  });
  test('identity checks hold per platform and require shared catalogs and provider policy across platforms', () => {
    const release = createEvalMatrix(releaseOptions, privateManifest), schedule = syntheticSchedule(release);
    const amd = release.cells.filter(cell => cell.platform === 'linux/amd64'), arm = release.cells.find(cell => cell.platform === 'linux/arm64')!;
    const relabel = (cell: EvalCell, change: (receipt: ProducerReceipt) => void) => { const receipt = syntheticReceipt(cell); change(receipt); return rehashReceipt(receipt); };
    expect(() => collectProducerReceipts(release, schedule, [syntheticReceipt(amd[0]), relabel(amd[1], receipt => { receipt.installationIdentity = syntheticInstallationIdentity('second-amd64', '1'); })], privateManifest)).toThrow('UNMATCHED_PRODUCER_INSTALLATIONS');
    expect(() => collectProducerReceipts(release, schedule, [syntheticReceipt(amd[0]), relabel(amd[1], receipt => { receipt.providerIdentity = syntheticProviderIdentity('gpt', 'second-amd64'); })], privateManifest)).toThrow('UNMATCHED_PRODUCER_PROVIDERS');
    expect(() => collectProducerReceipts(release, schedule, [syntheticReceipt(amd[0]), relabel(arm, receipt => { receipt.installationIdentity = syntheticInstallationIdentity('linux/amd64', '1'); })], privateManifest)).toThrow('UNMATCHED_PRODUCER_PLATFORMS');
    expect(() => collectProducerReceipts(release, schedule, [syntheticReceipt(amd[0]), relabel(arm, receipt => { receipt.installationIdentity = syntheticInstallationIdentity('linux/arm64', 'other-catalog'); })], privateManifest)).toThrow('UNMATCHED_PRODUCER_INSTALLATIONS');
    const otherPolicy = (() => { const { identityHash: _hash, ...base } = syntheticProviderIdentity('gpt', 'linux/arm64'); const changed = { ...base, policyRevision: 'gpt-other-policy' }; return { ...changed, identityHash: producerProviderIdentityHash(changed) }; })();
    expect(() => collectProducerReceipts(release, schedule, [syntheticReceipt(amd[0]), relabel(arm, receipt => { receipt.providerIdentity = otherPolicy; })], privateManifest)).toThrow('UNMATCHED_PRODUCER_PROVIDERS');
    expect(() => collectProducerReceipts(release, schedule, [syntheticReceipt(amd[0]), relabel(amd[1], receipt => { receipt.modelUsed = 'resolved-other-model'; })], privateManifest)).toThrow('UNMATCHED_EFFECTIVE_MODELS');
  });
  test('the external v2 baseline is pre-registered, complete, and bound to the release inputs', () => {
    const unpinned = releaseRun(null);
    const unmeasured = scoreCollectedEval(unpinned.release, unpinned.batch, unpinned.results, qualification, privateManifest);
    expect(unmeasured.gates.noHighCriticalRecallRegression).toBe('unmeasured'); expect(unmeasured.status).toBe('partial'); expect(unmeasured.baseline).toBeNull();
    const baseline = privateBaseline();
    expect(() => scoreCollectedEval(unpinned.release, unpinned.batch, unpinned.results, qualification, privateManifest, baseline)).toThrow('UNBOUND_EVAL_BASELINE');
    const { release, batch, results } = releaseRun(baseline);
    const forged = structuredClone(baseline); forged.cases[0].found = false;
    expect(() => scoreCollectedEval(release, batch, results, qualification, privateManifest, forged)).toThrow('UNBOUND_EVAL_BASELINE');
    const weaker = privateBaseline(found => { found.forEach(result => { result.findings = []; }); });
    expect(() => scoreCollectedEval(release, batch, results, qualification, privateManifest, weaker)).toThrow('UNBOUND_EVAL_BASELINE');
    expect(() => createEvalMatrix({ ...releaseOptions, model: 'other-model', baseline }, privateManifest)).toThrow('UNBOUND_EVAL_BASELINE');
    expect(() => createEvalMatrix({ ...releaseOptions, budgets: { daily: 600, comprehensive: 1200 }, baseline }, privateManifest)).toThrow('UNBOUND_EVAL_BASELINE');
    const otherProvider = structuredClone(baseline); otherProvider.provider.version = 'gpt-other-version';
    const { baselineHash: _hash, ...record } = otherProvider; otherProvider.baselineHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    const rebound = releaseRun(otherProvider);
    expect(() => scoreCollectedEval(rebound.release, rebound.batch, rebound.results, qualification, privateManifest, otherProvider)).toThrow('UNBOUND_EVAL_BASELINE');
    const highId = privateManifest.cases.find(item => item.severity === 'high')!.id;
    for (let index = 0; index < release.cells.length; index++) {
      const cell = release.cells[index];
      if (cell.mode === 'comprehensive' && cell.variant === 'vulnerable' && cell.caseId === highId) results[index].findings = [];
    }
    const regressed = scoreCollectedEval(release, batch, results, qualification, privateManifest, baseline);
    expect(regressed.gates.noHighCriticalRecallRegression).toBe('fail'); expect(regressed.baseline!.highCriticalRecall.value).toBe(1);
  });
  test('baseline records refuse incomplete or unadjudicated runs and baseline matrices never qualify', () => {
    expect(() => privateBaseline(results => { results.pop(); })).toThrow('INCOMPLETE_EVAL_BASELINE');
    expect(() => privateBaseline((results, cells) => { results[cells.findIndex(cell => cell.variant === 'vulnerable')].findings[0].judgment = 'unadjudicated'; })).toThrow('UNADJUDICATED_EVAL_BASELINE');
    const baselineMatrix = createEvalMatrix({ profile: 'baseline', model: 'matched-test-model', host: 'codex', skillHashes: { v2: 'a'.repeat(64) }, platforms: { comprehensive: releasePlatforms.comprehensive } }, privateManifest);
    expect(baselineMatrix.cells.every(cell => cell.version === 'v2' && cell.mode === 'comprehensive')).toBe(true);
    expect(() => scoreEval(baselineMatrix, [], qualification, privateManifest)).toThrow('BASELINE_PROFILE_NOT_QUALIFIABLE');
    expect(() => scoreEval(matrix, [], qualification, corpus, privateBaseline())).toThrow('UNBOUND_EVAL_BASELINE');
  });
});

describe('CSO matched producer orchestration', () => {
  const skills = { v2: portableSkill('v2', 'V2_SECTION_ONLY'), v3: portableSkill('v3', 'V3_SECTION_ONLY') };
  const producerMatrix = createEvalMatrix({ model: 'exact-eval-model', host: 'codex', skillHashes: { v2: sha256(skills.v2), v3: sha256(skills.v3) } });
  const selected = producerMatrix.cells.filter(cell => cell.caseId === 'node-sql-injection' && cell.variant === 'vulnerable' && cell.mode === 'daily' && cell.repetition === 1);
  const isolate = (prepared: string, cell: EvalCell) => {
    const producerRoot = join(root(), 'producer'); mkdirSync(producerRoot);
    const job = join(producerRoot, 'job'); cpSync(join(prepared, 'jobs', cell.id), job, { recursive: true });
    return { job, input: join(job, 'producer-input.json'), source: join(job, 'source') };
  };
  const helperBundle = (directory = join(root(), 'helpers')) => {
    mkdirSync(directory, { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['cso-eval-producer', 'gstack-cso-launcher', 'gstack-cso-core', 'gstack-cso-watchdog']) {
      const path = join(directory, `${name}${suffix}`);
      writeFileSync(path, process.platform === 'win32' ? 'test executable\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      if (process.platform !== 'win32') chmodSync(path, 0o755);
    }
    const core = join(directory, `gstack-cso-core${suffix}`);
    writeFileSync(join(directory, '.gstack-cso-generation'), `${sha256(readFileSync(core))}\n`, { mode: 0o644 });
    writeFileSync(join(directory, `provider-test${suffix}`), process.platform === 'win32' ? 'test provider\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return join(directory, `gstack-cso-launcher${suffix}`);
  };
  const providerCommandFor = (launcher: string) => ({ executable: join(dirname(launcher), `provider-test${process.platform === 'win32' ? '.exe' : ''}`), argsPrefix: [] as string[] });
  const providerIdentityFor = (family: Family, launcher: string): ProducerProviderIdentity => {
    const command = providerCommandFor(launcher), contents = readFileSync(command.executable);
    const withoutHash: Omit<ProducerProviderIdentity, 'identityHash'> = {
      schemaVersion: 1,
      family,
      policyRevision: `${family}-test-policy`,
      executable: { sha256: sha256(contents), bytes: contents.byteLength },
      argsPrefix: [],
      version: `${family}-test-version`,
    };
    return { ...withoutHash, identityHash: producerProviderIdentityHash(withoutHash) };
  };

  test('documents the complete five-artifact production installation', () => {
    const guide = readFileSync(new URL('./fixtures/cso-eval/README.md', import.meta.url), 'utf8');
    expect(guide).toContain('Trusted five-artifact producer unit');
    expect(guide).toContain('bin/.gstack-cso-generation "$stage/.gstack-cso-generation"');
    expect(guide).toContain('/opt/gstack-cso-producer/.gstack-cso-generation');
    expect(guide).toContain('CSO_EVAL_PAID=1 /opt/gstack-cso-producer/cso-eval-producer run');
    expect(guide).not.toMatch(/four-file|all four files|\/usr\/local\/bin\/cso-eval-producer/);
  });
  const withHelper = <T extends { paidExecutionAuthorized: boolean }>(options: T, launcher = helperBundle()) => ({
    ...options,
    testHelperLauncherPath: launcher,
    testProviderIdentity: providerIdentityFor((options as T & { adapter?: ProviderAdapter }).adapter?.family ?? 'gpt', launcher),
    testProviderCommand: providerCommandFor(launcher),
  });

  // The helper's real layout: `<repoId>/<epoch ms>-<hex>`; the secret redactor reads that epoch as a phone number.
  const helperRun = `${'e'.repeat(24)}/${Date.now()}-${'0123456789abcdef'}`;
  class FakeAdapter implements ProviderAdapter {
    readonly name = 'fake';
    constructor(
      private readonly inspect: (opts: RunOpts) => void,
      private readonly actualModel = 'gpt-5.4',
      readonly family: Family = 'gpt',
      private readonly outcome: Partial<RunResult> = {},
    ) {}
    async available() { return { ok: true }; }
    async run(opts: RunOpts) {
      this.inspect(opts);
      return { output: 'complete — assessed source\nNo supported findings in the assessed scope', tokens: { input: 120, output: 30, cached: 10 }, durationMs: 1234, toolCalls: 4, modelUsed: this.actualModel, ...this.outcome };
    }
    estimateCost() { return 0.0042; }
  }

  test('pins reviewed provider CLI versions and policy identities', () => {
    expect(PRODUCER_PROVIDER_POLICY).toEqual({
      claude: { family: 'claude', policyRevision: 'claude-2.1.263-cso-v1', version: '2.1.263 (Claude Code)' },
      codex: { family: 'gpt', policyRevision: 'codex-0.153.4-cso-v3-generation', version: 'codex-cli 0.153.4' },
      gemini: { family: 'gemini', policyRevision: 'gemini-0.59.0-cso-v1', version: '0.59.0' },
    });
  });

  test('prepares independent one-cell producer jobs without private or sibling source inputs', () => {
    const destination = join(root(), 'prepared');
    const schedule = prepareEvalJobs(producerMatrix, skills, destination, selected.map(cell => cell.id));
    expect(schedule).toMatchObject({ scheduledCells: 960, preparedCells: 2 });
    expect(readdirSync(join(destination, 'jobs')).sort()).toEqual(selected.map(cell => cell.id).sort());
    for (const cell of selected) {
      const source = join(destination, 'jobs', cell.id, 'source');
      expect(existsSync(join(source, '.git'))).toBe(true);
      const allSource = readdirSync(source).filter(name => name !== '.git').map(name => name).join('\n') + readFileSync(join(source, 'README.md'), 'utf8');
      expect(allSource).not.toContain('ORACLE_SQL_MARKER');
      expect(allSource).not.toContain('vulnerable');
      expect(existsSync(join(destination, 'jobs', cell.id, 'producer-input.json'))).toBe(true);
      const input = JSON.parse(readFileSync(join(destination, 'jobs', cell.id, 'producer-input.json'), 'utf8'));
      expect(input.skill).toBe(skills[cell.version]);
      expect(input.execution.skillHash).toBe(sha256(input.skill));
      expect(input.cellRef).toBe(cell.id);
      expect(input.skill).toContain(`${cell.version.toUpperCase()}_SECTION_ONLY`);
      expect(input.skill).not.toContain(cell.version === 'v2' ? 'V3_SECTION_ONLY' : 'V2_SECTION_ONLY');
      expect(validatePortableSkillPayload(input.skill, cell.version).files.map(file => file.path)).toEqual(['SKILL.md', 'sections/manifest.json', 'sections/audit-phases.md']);
    }
    expect(() => prepareEvalJobs(producerMatrix, { ...skills, v3: portableSkill('v3', 'CHANGED_V3_SECTION') }, join(root(), 'bad'), selected.map(cell => cell.id))).toThrow('EVAL_SKILL_HASH_MISMATCH');
  });

  test('prepared Git sources start no automatic maintenance before their immediate copy', () => {
    const parent = root(), destination = join(parent, 'prepared'), trace = join(parent, 'git-trace.jsonl');
    const actualExec = childProcess.execFileSync;
    // Observe the real production commands without inheriting a process-wide
    // Git trace setting that the initializer correctly excludes from its env.
    const traced = spyOn(childProcess, 'execFileSync').mockImplementation((command, args, options: any) =>
      actualExec(command, args as string[], { ...options, timeout: 5000, env: { ...options.env, GIT_TRACE2_EVENT: trace } }));
    let git: string, env: NodeJS.ProcessEnv;
    try {
      prepareEvalJobs(producerMatrix, skills, destination, [selected[0].id]);
      expect(traced).toHaveBeenCalledTimes(3);
      git = traced.mock.calls[0]![0] as string;
      env = (traced.mock.calls[0]![2] as childProcess.ExecFileSyncOptions).env!;
    } finally { traced.mockRestore(); }
    const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const starts = events.filter(event => event.event === 'start');
    for (const command of ['init', 'add', 'commit']) expect(starts.some(event => event.argv.includes(command))).toBe(true);
    const maintenance = events.filter(event => event.event === 'child_start' &&
      event.argv?.some((arg: string) => /^(?:maintenance|gc)$/.test(arg)));
    expect(maintenance).toEqual([]);
    const isolated = isolate(destination, selected[0]);
    const options = { cwd: isolated.source, env, encoding: 'utf8' as const, timeout: 5000 };
    expect(actualExec(git, ['log', '-1', '--format=%s'], options).trim()).toBe('immutable evaluation fixture');
    expect(actualExec(git, ['status', '--porcelain'], options)).toBe('');
    expect(existsSync(join(isolated.source, '.git', 'objects', 'maintenance.lock'))).toBe(false);
  });

  test('binds every generated section byte and rejects incomplete or cross-version payloads', () => {
    const changedSection = portableSkill('v3', 'V3_SECTION_CHANGED_BY_ONE_BYTE');
    expect(sha256(changedSection)).not.toBe(sha256(skills.v3));
    expect(validatePortableSkillPayload(skills.v2, 'v2').version).toBe('v2');
    expect(validatePortableSkillPayload(skills.v3, 'v3').version).toBe('v3');
    expect(() => validatePortableSkillPayload(skills.v2, 'v3')).toThrow('INVALID_CSO_EVAL_PAYLOAD');
    expect(() => prepareEvalJobs(producerMatrix, { v2: '# root-only v2', v3: skills.v3 }, join(root(), 'root-only'), selected.map(cell => cell.id))).toThrow('INVALID_CSO_EVAL_PAYLOAD');
    expect(() => createPortableSkillPayload('v3', [
      { path: 'SKILL.md', contents: '---\nname: cso\nversion: 3.0.0\n---\n' },
      { path: 'sections/manifest.json', contents: JSON.stringify({ skill: 'cso', version: 1, sections: [{ id: 'audit-phases', file: 'audit-phases.md', title: 'Audit phases', trigger: 'during audit phases' }] }) },
    ])).toThrow('INCOMPLETE_CSO_EVAL_PAYLOAD');

    const directory = join(root(), 'skill'); mkdirSync(join(directory, 'sections'), { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), '---\nname: cso\nversion: 3.0.0\n---\nRead sections/audit-phases.md.\n');
    writeFileSync(join(directory, 'sections', 'manifest.json'), JSON.stringify({ skill: 'cso', version: 1, sections: [{ id: 'audit-phases', file: 'audit-phases.md', title: 'Audit phases', trigger: 'during audit phases' }] }));
    writeFileSync(join(directory, 'sections', 'audit-phases.md'), 'COMPLETE_DIRECTORY_SECTION\n');
    const loaded = loadPortableSkillPayload('v3', directory);
    expect(loaded).toContain('COMPLETE_DIRECTORY_SECTION');
    expect(() => loadPortableSkillPayload('v2', directory)).toThrow('CSO_EVAL_PAYLOAD_VERSION_MISMATCH');
    writeFileSync(join(directory, 'sections', 'unlisted.md'), 'must not be omitted\n');
    expect(() => loadPortableSkillPayload('v3', directory)).toThrow('UNLISTED_CSO_EVAL_SECTION');
  });

  test('binds only a complete adjacent executable helper bundle outside source and state', () => {
    const source = join(root(), 'source'); mkdirSync(source);
    const state = join(root(), 'state');
    const launcher = helperBundle();
    const suffix = process.platform === 'win32' ? '.exe' : '';
    expect(resolveProducerHelperBinding(source, state, launcher)).toEqual({
      producer: join(dirname(launcher), `cso-eval-producer${suffix}`),
      launcher,
      core: join(dirname(launcher), `gstack-cso-core${suffix}`),
      watchdog: join(dirname(launcher), `gstack-cso-watchdog${suffix}`),
      generation: join(dirname(launcher), '.gstack-cso-generation'),
    });

    const missingGeneration = helperBundle();
    rmSync(join(dirname(missingGeneration), '.gstack-cso-generation'));
    expect(() => resolveProducerHelperBinding(source, state, missingGeneration)).toThrow('INVALID_PRODUCER_HELPER');

    const malformedGeneration = helperBundle();
    writeFileSync(join(dirname(malformedGeneration), '.gstack-cso-generation'), 'f'.repeat(64));
    expect(() => resolveProducerHelperBinding(source, state, malformedGeneration)).toThrow('INVALID_PRODUCER_HELPER');

    const mismatchedGeneration = helperBundle();
    writeFileSync(join(dirname(mismatchedGeneration), '.gstack-cso-generation'), `${'f'.repeat(64)}\n`);
    const mismatchedBinding = resolveProducerHelperBinding(source, state, mismatchedGeneration);
    expect(() => producerInstallationIdentity(mismatchedBinding)).toThrow('PRODUCER_HELPER_GENERATION_MISMATCH');

    const missingWatchdog = helperBundle();
    rmSync(join(dirname(missingWatchdog), `gstack-cso-watchdog${suffix}`));
    expect(() => resolveProducerHelperBinding(source, state, missingWatchdog)).toThrow('INVALID_PRODUCER_HELPER');

    const nonExecutable = helperBundle();
    if (process.platform !== 'win32') {
      chmodSync(join(dirname(nonExecutable), 'gstack-cso-core'), 0o600);
      expect(() => resolveProducerHelperBinding(source, state, nonExecutable)).toThrow('INVALID_PRODUCER_HELPER');
    }

    const symlinked = helperBundle();
    if (process.platform !== 'win32') {
      rmSync(symlinked);
      symlinkSync(join(dirname(symlinked), 'gstack-cso-core'), symlinked);
      expect(() => resolveProducerHelperBinding(source, state, symlinked)).toThrow('INVALID_PRODUCER_HELPER');
    }

    const containedDirectory = join(source, 'helpers'); mkdirSync(containedDirectory);
    const containedLauncher = join(containedDirectory, `gstack-cso-launcher${suffix}`);
    for (const name of ['cso-eval-producer', 'gstack-cso-launcher', 'gstack-cso-core', 'gstack-cso-watchdog']) {
      const path = join(containedDirectory, `${name}${suffix}`);
      writeFileSync(path, 'test executable\n', { mode: 0o755 });
      if (process.platform !== 'win32') chmodSync(path, 0o755);
    }
    expect(() => resolveProducerHelperBinding(source, state, containedLauncher)).toThrow('INVALID_PRODUCER_HELPER');

    const stateContainedLauncher = helperBundle(join(state, 'helpers'));
    expect(() => resolveProducerHelperBinding(source, state, stateContainedLauncher)).toThrow('INVALID_PRODUCER_HELPER');
  });

  test('production binding rejects a privileged or producer-writable binary and directory chain', () => {
    const source = join(root(), 'source'); mkdirSync(source);
    const state = join(root(), 'state');
    const suffix = process.platform === 'win32' ? '.exe' : '';

    const writableBinary = helperBundle();
    const binaryDirectory = dirname(writableBinary);
    const producerBinary = join(binaryDirectory, `cso-eval-producer${suffix}`);
    if (process.platform !== 'win32') {
      chmodSync(binaryDirectory, 0o555);
      chmodSync(producerBinary, 0o555);
      chmodSync(join(binaryDirectory, `gstack-cso-core${suffix}`), 0o555);
      chmodSync(join(binaryDirectory, `gstack-cso-watchdog${suffix}`), 0o555);
      chmodSync(writableBinary, 0o755);
    }
    const writableBinaryBinding = resolveProducerHelperBinding(source, state, writableBinary);
    const binaryError = () => validateProductionProducerInstallation(writableBinaryBinding, producerBinary);
    if (typeof process.getuid === 'function' && process.getuid() === 0) expect(binaryError).toThrow('ROOT_PRODUCER_UNSUPPORTED');
    else expect(binaryError).toThrow('WRITABLE_PRODUCER_INSTALLATION');
    if (process.platform !== 'win32') chmodSync(binaryDirectory, 0o755);

    const writableDirectory = helperBundle();
    const directory = dirname(writableDirectory);
    const adjacentProducer = join(directory, `cso-eval-producer${suffix}`);
    if (process.platform !== 'win32') {
      for (const path of [writableDirectory, join(directory, `gstack-cso-core${suffix}`), join(directory, `gstack-cso-watchdog${suffix}`), adjacentProducer]) chmodSync(path, 0o555);
      chmodSync(directory, 0o755);
    }
    const writableDirectoryBinding = resolveProducerHelperBinding(source, state, writableDirectory);
    const directoryError = () => validateProductionProducerInstallation(writableDirectoryBinding, adjacentProducer);
    if (typeof process.getuid === 'function' && process.getuid() === 0) expect(directoryError).toThrow('ROOT_PRODUCER_UNSUPPORTED');
    else expect(directoryError).toThrow('WRITABLE_PRODUCER_INSTALLATION');
  });

  test('requires explicit authorization, consumes labels before the model starts, and records measured receipts', async () => {
    const destination = join(root(), 'prepared');
    const schedule = prepareEvalJobs(producerMatrix, skills, destination, selected.map(cell => cell.id));
    const cell = selected.find(item => item.version === 'v2')!;
    const inPlace = join(destination, 'jobs', cell.id, 'producer-input.json');
    const receipts = join(root(), 'receipts'); mkdirSync(receipts);
    const output = join(receipts, `${cell.id}.json`);
    const invalidLauncher = join(root(), 'missing', `gstack-cso-launcher${process.platform === 'win32' ? '.exe' : ''}`);
    await expect(runProducerCell(inPlace, output, { adapter: new FakeAdapter(() => {}), paidExecutionAuthorized: false, testHelperLauncherPath: invalidLauncher })).rejects.toThrow('PAID_EXECUTION_NOT_AUTHORIZED');
    await expect(runProducerCell(inPlace, output, { adapter: new FakeAdapter(() => {}), paidExecutionAuthorized: true, testHelperLauncherPath: invalidLauncher })).rejects.toThrow('NON_ISOLATED_PRODUCER_LAYOUT');
    const isolated = isolate(destination, cell), input = isolated.input;
    const launcher = helperBundle();
    const adapter = new FakeAdapter(opts => {
      expect(existsSync(input)).toBe(false);
      expect(opts).toMatchObject({
        model: cell.model,
        timeoutMs: (cell.budgetSeconds + 300) * 1000,
        workdir: join(isolated.job, 'state'),
        csoProducer: {
          stateDirectory: join(isolated.job, 'state'),
          sourceDirectory: isolated.source,
          helperLauncher: launcher,
          helperGeneration: join(dirname(launcher), '.gstack-cso-generation'),
          providerCommand: providerCommandFor(launcher),
        },
      });
      expect(opts.extraArgs).toBeUndefined();
      expect(readdirSync(isolated.job).sort()).toEqual(['source', 'state']);
      expect(opts.prompt).toContain(skills.v2);
      expect(opts.prompt).toContain('/cso --budget 600');
      expect(opts.prompt).toContain(`application repository at ${isolated.source}`);
      expect(opts.prompt).toContain('permission profile grants read-only access to exactly that immutable snapshot');
      expect(opts.prompt).toContain('Use only the trusted helper to inspect or act on source');
      expect(opts.prompt).toContain(`absolute launcher path ${JSON.stringify(launcher)}`);
      expect(opts.prompt).toContain('do not discover or invoke another helper through PATH');
      expect(opts.prompt).not.toContain(cell.caseId);
      expect(opts.prompt).not.toContain(cell.variant);
      expect(opts.prompt).not.toContain('ORACLE_SQL_MARKER');
      const artifactRoot = join(process.env.GSTACK_HOME!, 'security', 'cso', helperRun);
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(join(artifactRoot, 'report.json'), '{"status":"complete"}\n');
      writeFileSync(join(artifactRoot, 'repair.patch'), 'diff --git a/app.mjs b/app.mjs\n');
      if (process.platform !== 'win32') {
        expect(statSync(isolated.source).mode & 0o777).toBe(0o555);
        expect(statSync(join(isolated.source, 'app.mjs')).mode & 0o777).toBe(0o444);
      }
      expect(process.env.GSTACK_SESSION_KIND).toBe('spawned');
      expect(process.env.GSTACK_HEADLESS).toBe('1');
    });
    await expect(runProducerCell(input, output, { adapter, paidExecutionAuthorized: false, testHelperLauncherPath: invalidLauncher })).rejects.toThrow('PAID_EXECUTION_NOT_AUTHORIZED');
    expect(existsSync(input)).toBe(true);
    const receipt = await runProducerCell(input, output, withHelper({ adapter, paidExecutionAuthorized: true }, launcher));
    expect(receipt).toMatchObject({ status: 'succeeded', requestedModel: 'exact-eval-model', modelUsed: 'gpt-5.4', modelIdentitySource: 'provider_reported', durationMs: 1234, firstUsefulResultMs: null, usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 10, estimatedCostUSD: 0.0042 } });
    expect(receipt.installationIdentity.identityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.installationIdentity.schemaVersion).toBe(1);
    expect(receipt.installationIdentity.generation.coreSha256).toBe(receipt.installationIdentity.core.sha256);
    expect(receipt.installationIdentity.generation.manifest).toEqual({
      sha256: sha256(`${receipt.installationIdentity.core.sha256}\n`),
      bytes: 65,
    });
    for (const artifact of [receipt.installationIdentity.producer, receipt.installationIdentity.launcher, receipt.installationIdentity.core, receipt.installationIdentity.watchdog, receipt.installationIdentity.generation.manifest]) {
      expect(artifact.bytes).toBeGreaterThan(0);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(receipt.providerIdentity).toEqual(providerIdentityFor('gpt', launcher));
    expect(receipt.artifacts).toMatchObject({ schemaVersion: 1, root: 'security/cso' });
    expect(receipt.artifacts.totalBytes).toBe(receipt.artifacts.entries.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(receipt.artifacts.entries.map(entry => entry.path)).toEqual([`${helperRun}/repair.patch`, `${helperRun}/report.json`]);
    expect(receipt.artifacts.identityHash).toBe(producerArtifactInventoryHash({ schemaVersion: 1, root: 'security/cso', entries: receipt.artifacts.entries, totalBytes: receipt.artifacts.totalBytes }));
    const retainedHome = join(isolated.job, 'state', 'cso-home');
    expect(readFileSync(join(retainedHome, 'security', 'cso', helperRun, 'report.json'), 'utf8')).toContain('complete');
    expect(receipt.artifacts.entries.every(entry => !/provider|credential|session/i.test(entry.path))).toBe(true);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(receipt);
    const { receiptHash, ...receiptWithoutHash } = receipt;
    expect(producerReceiptHash(receiptWithoutHash)).toBe(receiptHash);
    const batch = collectProducerReceipts(producerMatrix, schedule, [receipt]);
    expect(batch.summary).toMatchObject({ scheduled: 960, prepared: 2, submitted: 1, missing: 959, matchedPairsExpected: 480, matchedPairsSubmitted: 0, modelMismatches: [] });
    expect(batch.summary.groups.find(group => group.version === 'v2' && group.mode === 'daily')).toMatchObject({ scheduled: 240, submitted: 1, missing: 239, latency: { samples: 1, denominator: 240, p95Ms: 1234 }, firstUsefulResult: { samples: 0, denominator: 240, p95Ms: null }, modelTokens: { measured: 1, denominator: 240, total: 150 }, estimatedCost: { measured: 1, denominator: 240, totalUSD: 0.0042 } });
  });

  test('passes the same producer policy to every host and removes Gemini CLI state', async () => {
    for (const [host, family] of [['codex', 'gpt'], ['claude', 'claude'], ['gemini', 'gemini']] as const) {
      const hostMatrix = createEvalMatrix({ model: 'exact-eval-model', host, skillHashes: { v2: sha256(skills.v2), v3: sha256(skills.v3) } });
      const cell = hostMatrix.cells.find(item => item.caseId === 'node-sql-injection' && item.variant === 'vulnerable' && item.version === 'v3' && item.mode === 'daily' && item.repetition === 1)!;
      const destination = join(root(), `${host}-prepared`);
      prepareEvalJobs(hostMatrix, skills, destination, [cell.id]);
      const isolated = isolate(destination, cell), state = join(isolated.job, 'state'), launcher = helperBundle();
      const outputRoot = join(root(), `${host}-receipts`); mkdirSync(outputRoot);
      const adapter = new FakeAdapter(opts => {
        expect(opts.csoProducer).toEqual({
          stateDirectory: state,
          sourceDirectory: isolated.source,
          helperLauncher: launcher,
          helperGeneration: join(dirname(launcher), '.gstack-cso-generation'),
          providerCommand: providerCommandFor(launcher),
        });
        expect(opts.extraArgs).toBeUndefined();
        if (host === 'gemini') {
          const paths = geminiProducerPaths(state);
          expect(JSON.parse(readFileSync(paths.systemDefaults, 'utf8'))).toEqual({});
          const settings = JSON.parse(readFileSync(paths.systemSettings, 'utf8'));
          const contextFileName = settings.context.fileName[0];
          expect(contextFileName).toMatch(/^\.gstack-cso-context-[a-f0-9]{32}\.md$/);
          expect(settings).toEqual(geminiProducerSystemSettings(contextFileName, launcher));
          expect(statSync(paths.root).mode & 0o777).toBe(0o700);
          expect(statSync(paths.home).mode & 0o777).toBe(0o700);
          expect(statSync(paths.workdir).mode & 0o777).toBe(0o700);
          expect(statSync(paths.systemSettings).mode & 0o777).toBe(0o600);
          expect(readdirSync(paths.workdir)).toEqual([]);
          for (const directory of [paths.root, paths.home, paths.workdir]) {
            expect(existsSync(join(directory, 'GEMINI.md'))).toBe(false);
            expect(existsSync(join(directory, 'AGENTS.md'))).toBe(false);
            expect(existsSync(join(directory, 'MEMORY.md'))).toBe(false);
          }
          expect(opts.prompt).toContain(`application repository at ${isolated.source}`);
          expect(opts.prompt).toContain('neutral current working directory');
          if (process.platform !== 'win32') {
            expect(statSync(isolated.source).mode & 0o777).toBe(0o555);
            expect(statSync(join(isolated.source, 'app.mjs')).mode & 0o777).toBe(0o444);
          }
        }
      }, cell.model, family);
      const receipt = await runProducerCell(isolated.input, join(outputRoot, `${cell.id}.json`), withHelper({ adapter, paidExecutionAuthorized: true }, launcher));
      expect(receipt.status).toBe('succeeded');
      if (host === 'gemini') expect(existsSync(geminiProducerPaths(state).root)).toBe(false);
    }
  });

  test('removes disposable Gemini CLI state when the provider throws', async () => {
    const hostMatrix = createEvalMatrix({ model: 'exact-eval-model', host: 'gemini', skillHashes: { v2: sha256(skills.v2), v3: sha256(skills.v3) } });
    const cell = hostMatrix.cells.find(item => item.caseId === 'node-sql-injection' && item.variant === 'vulnerable' && item.version === 'v3' && item.mode === 'daily' && item.repetition === 1)!;
    const destination = join(root(), 'gemini-throw-prepared');
    prepareEvalJobs(hostMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell), state = join(isolated.job, 'state');
    const outputRoot = join(root(), 'gemini-throw-receipts'); mkdirSync(outputRoot);
    const adapter: ProviderAdapter = {
      name: 'fake', family: 'gemini',
      async available() { return { ok: true }; },
      async run() { expect(existsSync(geminiProducerPaths(state).root)).toBe(true); throw new Error('provider stopped'); },
      estimateCost() { return 0; },
    };
    await expect(runProducerCell(isolated.input, join(outputRoot, `${cell.id}.json`), withHelper({ adapter, paidExecutionAuthorized: true }))).rejects.toThrow('provider stopped');
    expect(existsSync(geminiProducerPaths(state).root)).toBe(false);
  });

  test('records an exit-zero blank provider result as a failed receipt',async()=>{
    const destination=join(root(),'blank-prepared'),cell=selected[0];
    prepareEvalJobs(producerMatrix,skills,destination,[cell.id]);
    const isolated=isolate(destination,cell),output=join(root(),`${cell.id}.json`);
    const receipt=await runProducerCell(isolated.input,output,withHelper({adapter:new FakeAdapter(()=>{},cell.model,'gpt',{output:'   \n',tokens:{input:0,output:0}}),paidExecutionAuthorized:true}));
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toEqual({code:'unknown',reason:'empty output from provider CLI (exit 0)'});
    expect(receipt.outputHash).toBe(sha256(receipt.output));
    expect(JSON.parse(readFileSync(output,'utf8'))).toEqual(receipt);
  });

  test('preserves provider-declared exit-zero errors as failed receipts',async()=>{
    const destination=join(root(),'provider-error-prepared'),cell=selected[0];prepareEvalJobs(producerMatrix,skills,destination,[cell.id]);
    const isolated=isolate(destination,cell),output=join(root(),`${cell.id}.json`),error={code:'unknown' as const,reason:'empty or invalid output from claude CLI (exit 0)'};
    const receipt=await runProducerCell(isolated.input,output,withHelper({adapter:new FakeAdapter(()=>{},cell.model,'gpt',{output:'',error}),paidExecutionAuthorized:true}));
    expect(receipt.status).toBe('failed');expect(receipt.error).toEqual(error);expect(receipt.outputHash).toBe(sha256(receipt.output));
  });

  test('redacts producer output and split error canaries into unsuccessful receipts', async () => {
    for (const [suffix, outputText, error] of [
      ['output', `report contains sk-proj-${'a'.repeat(40)}`, undefined],
      ['split', 'diagnostic ends with sk-proj-', { code: 'unknown' as const, reason: 'b'.repeat(40) }],
    ] as const) {
      const destination = join(root(), `${suffix}-prepared`);
      const cell = selected[0];
      prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
      const isolated = isolate(destination, cell);
      const outputRoot = join(root(), `${suffix}-receipts`); mkdirSync(outputRoot);
      const receiptPath = join(outputRoot, `${cell.id}.json`);
      const adapter = new FakeAdapter(() => {}, cell.model, 'gpt', { output: outputText, ...(error ? { error } : {}) });
      const receipt = await runProducerCell(isolated.input, receiptPath, withHelper({ adapter, paidExecutionAuthorized: true }));
      expect(receipt.status).toBe('failed');
      expect(receipt.output).toBe('[sensitive producer output redacted]');
      expect(receipt.outputHash).toBe(sha256(receipt.output));
      expect(receipt.error).toEqual({ code: 'unknown', reason: 'Sensitive producer output or error withheld: credential-class rule openai.key×1' });
      const stored = readFileSync(receiptPath, 'utf8');
      expect(stored).not.toContain('sk-proj-');
      expect(stored).not.toContain('b'.repeat(40));
    }
  });

  test('withholds a source canary quoted without its credential name, whole or split across output and error', () => {
    const source = join(root(), 'canary-source'), canary = `cso_${randomHex(10)}_${randomHex(10)}`;
    mkdirSync(join(source, 'test'), { recursive: true });
    writeFileSync(join(source, '.env'), `API_TOKEN=${canary}\nNODE_ENV=production\n`);
    writeFileSync(join(source, 'test', 'canary.txt'), `${canary}\n`);
    const credentials = sourceCredentialValues(source, ['.env', 'test/canary.txt']);
    expect(credentials).toEqual([canary]);
    const base = { output: '', modelUsed: 'm', durationMs: 1, toolCalls: 1, tokens: { input: 1, output: 1 } } as RunResult;
    expect(sanitizeProducerRun({ ...base, output: `The token is ${canary}` }, [])).toMatchObject({ output: `The token is ${canary}` });
    for (const run of [{ ...base, output: `The token is ${canary}.` }, { ...base, output: canary.slice(0, 12), error: { code: 'unknown', reason: canary.slice(12) } }] as RunResult[]) {
      const sanitized = sanitizeProducerRun(run, credentials);
      expect(sanitized).toMatchObject({ output: '[sensitive producer output redacted]', error: { reason: 'Sensitive producer output or error withheld: credential-class rule source.env.kv×1' } });
      expect(JSON.stringify(sanitized)).not.toContain(canary);
    }
  });

  test('keeps a succeeded run that quotes helper identifiers, span-redacts PII shapes, and fails credential-class output by rule', async () => {
    const runId = `${Date.now()}-${randomHex(8)}`;
    let walletShaped = '';
    while (!walletShaped) { const id = randomHex(16); if (redactProducerText(`review ${id}`).text === `review ${id}` && scan(id).findings.some(finding => finding.id === 'pii.wallet')) walletShaped = id; }
    expect(scan(runId).findings.map(finding => finding.id)).toContain('pii.phone.e164');
    const report = [
      `complete — run ${runId}, catalog cso-eval-38078005392-${randomHex(6)}, scanner artifact gitleaks-${randomHex(8)}-${randomHex(8)}.`,
      `Finding ${randomHex(16)} reviewed by ${walletShaped}; snapshot ${randomHex(32)}.`,
      'The /health-hooks route connects to 169.254.169.254:80.',
    ].join('\n');
    const run = async (name: string, output: string) => {
      const destination = join(root(), `${name}-prepared`), cell = selected[0];
      prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
      const isolated = isolate(destination, cell), receiptPath = join(root(), `${cell.id}.json`);
      return runProducerCell(isolated.input, receiptPath, withHelper({ adapter: new FakeAdapter(() => {}, 'gpt-5.4', 'gpt', { output }), paidExecutionAuthorized: true }));
    };
    const kept = await run('helper-ids', report);
    expect(kept.status).toBe('succeeded');
    expect(kept.error).toBeUndefined();
    expect(kept.output).toBe(report.replace('169.254.169.254', '<REDACTED-pii.phone.e164>'));
    const envLine = `API_TOKEN=cso_${randomHex(12)}_${randomHex(12)}`;
    const key = `sk-ant-api03-${randomHex(40)}`;
    for (const [name, leak, rule] of [['env-line', envLine, 'env.kv×1'], ['credential', key, 'anthropic.key×1']] as const) {
      const failed = await run(name, `${report}\n${leak}`);
      expect(failed).toMatchObject({ status: 'failed', output: '[sensitive producer output redacted]', error: { code: 'unknown', reason: `Sensitive producer output or error withheld: credential-class rule ${rule}` }, usage: { inputTokens: 120 } });
      expect(JSON.stringify(failed)).not.toContain(leak);
    }
  });

  const expectIntegrityReceipt = (receipt: ProducerReceipt, receiptPath: string, error: { code: string; reason: string }) => {
    expect(receipt).toMatchObject({ status: 'failed', error, output: '', outputHash: sha256(''), durationMs: 1234, toolCalls: 4, usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 10, estimatedCostUSD: 0.0042 } });
    expect(receipt.artifacts.entries).toEqual([]);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(receipt);
  };

  test('records a failed receipt with usage when the bound provider executable changes during a cell', async () => {
    const destination = join(root(), 'provider-race-prepared'), cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell), launcher = helperBundle();
    const outputRoot = join(root(), 'provider-race-receipts'); mkdirSync(outputRoot);
    const receiptPath = join(outputRoot, `${cell.id}.json`);
    const adapter = new FakeAdapter(opts => writeFileSync(opts.csoProducer!.providerCommand.executable, '#!/bin/sh\nexit 1\n'));
    const receipt = await runProducerCell(isolated.input, receiptPath, withHelper({ adapter, paidExecutionAuthorized: true }, launcher));
    expectIntegrityReceipt(receipt, receiptPath, { code: 'PRODUCER_PROVIDER_INSTALLATION_RACE', reason: 'provider installation check: provider executable changed during the run' });
  });

  test('records a failed receipt with usage when the helper generation changes during a cell', async () => {
    const destination = join(root(), 'helper-generation-race-prepared'), cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell), launcher = helperBundle();
    const outputRoot = join(root(), 'helper-generation-race-receipts'); mkdirSync(outputRoot);
    const receiptPath = join(outputRoot, `${cell.id}.json`);
    const adapter = new FakeAdapter(opts => {
      const core = join(dirname(opts.csoProducer!.helperLauncher), `gstack-cso-core${process.platform === 'win32' ? '.exe' : ''}`);
      writeFileSync(core, process.platform === 'win32' ? 'new test executable\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      writeFileSync(opts.csoProducer!.helperGeneration, `${sha256(readFileSync(core))}\n`);
    });
    const receipt = await runProducerCell(isolated.input, receiptPath, withHelper({ adapter, paidExecutionAuthorized: true }, launcher));
    expectIntegrityReceipt(receipt, receiptPath, { code: 'PRODUCER_HELPER_GENERATION_CHANGED', reason: 'helper installation check: installed helper identity changed during the run' });
  });

  test('records a failed receipt with usage when the provider output exceeds the limit', async () => {
    const destination = join(root(), 'output-limit-prepared'), cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell), receiptPath = join(root(), `${cell.id}.json`);
    const output = 'x'.repeat(32 * 1024 * 1024 + 1);
    const receipt = await runProducerCell(isolated.input, receiptPath, withHelper({ adapter: new FakeAdapter(() => {}, 'gpt-5.4', 'gpt', { output }), paidExecutionAuthorized: true }));
    expectIntegrityReceipt(receipt, receiptPath, { code: 'PRODUCER_OUTPUT_TOO_LARGE', reason: `output size check: output is ${output.length} bytes; the limit is ${32 * 1024 * 1024}` });
  });

  test('accepts real helper artifact names the secret redactor misreads, and names the check that rejects the rest', async () => {
    const { redact } = await import('../lib/cso/process');
    const runId = `${Date.now()}-${'0123456789abcdef'}`;
    let walletShaped = '';
    while (!walletShaped) { const id = randomHex(16); if (redact(id) !== id) walletShaped = id; }
    expect(redact(runId)).not.toBe(runId);
    const repo = 'e'.repeat(24);
    const accepted = [`${repo}/${runId}/report.json`, `${repo}/${runId}/reviews/${walletShaped}.json`, `${repo}/${runId}/scanner-outcomes/gitleaks-${randomHex(8)}-${randomHex(8)}.json`,
      `${repo}/${runId}/snapshot/test/fixtures/cso-canary-token.txt`, 'public-cache/osv/index.json'];
    for (const path of accepted) expect(() => assertProducerArtifactPath(path)).not.toThrow();
    for (const [path, message] of [
      [`run-1/report.json`, 'INVALID_PRODUCER_ARTIFACTS: an artifact lies outside'],
      [`${repo}/report.json`, 'INVALID_PRODUCER_ARTIFACTS: an artifact lies outside'],
      [`${repo}/${runId}/bad name.json`, 'INVALID_PRODUCER_ARTIFACTS: an artifact path has a component outside'],
    ] as const) expect(() => assertProducerArtifactPath(path)).toThrow(message);
    const planted = `sk-ant-api03-${randomHex(24)}`;
    expect(redact(planted)).not.toBe(planted);
    let failure: unknown;
    try { assertProducerArtifactPath(`${repo}/${runId}/notes/${planted}.txt`); } catch (error) { failure = error; }
    expect((failure as CsoError).code).toBe('REDACTION_FAILED');
    expect((failure as Error).message).toBe('artifact path component 4 under "ID/ID/notes" looks like a secret; the component is withheld');
    const destination = join(root(), 'planted-artifact-prepared'), cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell), receiptPath = join(root(), `${cell.id}.json`);
    const adapter = new FakeAdapter(() => {
      const directory = join(process.env.GSTACK_HOME!, 'security', 'cso', repo, runId, 'notes');
      mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `${planted}.txt`), 'x');
    }, 'gpt-5.4', 'gpt', { error: { code: 'timeout', reason: 'exceeded 1ms' } });
    const receipt = await runProducerCell(isolated.input, receiptPath, withHelper({ adapter, paidExecutionAuthorized: true }));
    expectIntegrityReceipt(receipt, receiptPath, { code: 'REDACTION_FAILED', reason: 'artifact inventory check: artifact path component 4 under "ID/ID/notes" looks like a secret; the component is withheld; the provider run also failed (timeout)' });
    expect(readFileSync(receiptPath, 'utf8')).not.toContain(planted);
  });

  test('gives the provider the budget plus the reporting grace and keeps a timed-out run\'s usage and last result', async () => {
    expect(producerProviderTimeoutMs(1800)).toBe(2100 * 1000);
    const destination = join(root(), 'timeout-prepared'), cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell), receiptPath = join(root(), `${cell.id}.json`);
    const adapter = new FakeAdapter(() => {}, 'gpt-5.4', 'gpt', { output: 'last assistant text before the kill', error: { code: 'timeout', reason: 'exceeded 2100000ms' } });
    const receipt = await runProducerCell(isolated.input, receiptPath, withHelper({ adapter, paidExecutionAuthorized: true }));
    expect(receipt).toMatchObject({ status: 'failed', error: { code: 'timeout', reason: 'exceeded 2100000ms' }, output: 'last assistant text before the kill', toolCalls: 4, usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 10, estimatedCostUSD: 0.0042 } });
  });

  test('names the first offending source path and rule in a failed receipt that keeps usage', async () => {
    if (process.platform === 'win32') return;
    const writable = (directory: string, change: () => void) => { chmodSync(directory, 0o755); try { change(); } finally { chmodSync(directory, 0o555); } };
    const cases: Array<[string, (source: string, outside: string) => void, string]> = [
      ['mount-point', source => writable(source, () => writeFileSync(join(source, '.mcp.json'), '', { mode: 0o444 })), '".mcp.json" is not in the expected source listing'],
      ['missing', source => writable(source, () => rmSync(join(source, 'app.mjs'))), '"app.mjs" is missing from the source'],
      ['hard-link', (source, outside) => linkSync(join(source, 'app.mjs'), join(outside, 'app.mjs')), '"app.mjs" has 2 hard links; expected 1'],
      ['content', source => {
        const file = join(source, 'app.mjs'), size = statSync(file).size;
        chmodSync(file, 0o644); writeFileSync(file, 'y'.repeat(size)); chmodSync(file, 0o444);
      }, '"app.mjs" does not match its expected sha256'],
    ];
    for (const [name, mutate, reason] of cases) {
      const destination = join(root(), `${name}-prepared`), cell = selected[0], outside = root();
      const schedule = prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
      const isolated = isolate(destination, cell), receiptPath = join(root(), `${cell.id}.json`);
      const receipt = await runProducerCell(isolated.input, receiptPath, withHelper({ adapter: new FakeAdapter(opts => mutate(opts.csoProducer!.sourceDirectory, outside)), paidExecutionAuthorized: true }));
      expectIntegrityReceipt(receipt, receiptPath, { code: 'INVALID_PRODUCER_SOURCE', reason: `source content check: ${reason}` });
      const group = collectProducerReceipts(producerMatrix, schedule, [receipt]).summary.groups.find(item => item.version === cell.version && item.mode === cell.mode);
      expect(group).toMatchObject({ submitted: 1, succeeded: 0, failed: 1, estimatedCost: { measured: 1, totalUSD: 0.0042 } });
    }
  });

  test('fails closed without a receipt or raw console reason when redaction cannot inspect output', async () => {
    const destination = join(root(), 'redaction-failure-prepared'), cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell);
    const outputRoot = join(root(), 'redaction-failure-receipts'); mkdirSync(outputRoot);
    const receiptPath = join(outputRoot, `${cell.id}.json`);
    const canary = 'secret-canary-' + 'x'.repeat(1024 * 1024 + 1);
    let failure: unknown;
    try {
      await runProducerCell(isolated.input, receiptPath, withHelper({ adapter: new FakeAdapter(() => {}, cell.model, 'gpt', { output: canary }), paidExecutionAuthorized: true }));
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CsoError);
    expect((failure as CsoError).code).toBe('REDACTION_FAILED');
    expect(existsSync(receiptPath)).toBe(false);
    expect(producerFailureMessage(failure)).toBe('REDACTION_FAILED: producer payload withheld');
    expect(producerFailureMessage(failure)).not.toContain(canary.slice(0, 32));
  });

  test('rejects effective-model mismatches between otherwise matched v2 and v3 cells', async () => {
    const destination = join(root(), 'prepared');
    const schedule = prepareEvalJobs(producerMatrix, skills, destination, selected.map(cell => cell.id));
    const receiptsRoot = join(root(), 'receipts'); mkdirSync(receiptsRoot);
    const receipts = [];
    for (const cell of selected) {
      const adapter = new FakeAdapter(() => {}, cell.version === 'v2' ? 'resolved-a' : 'resolved-b');
      const isolated = isolate(destination, cell);
      receipts.push(await runProducerCell(isolated.input, join(receiptsRoot, `${cell.id}.json`), withHelper({ adapter, paidExecutionAuthorized: true })));
    }
    expect(() => collectProducerReceipts(producerMatrix, schedule, receipts)).toThrow('UNMATCHED_EFFECTIVE_MODELS');
    const tampered = structuredClone(receipts[0]); tampered.output += 'changed';
    expect(() => collectProducerReceipts(producerMatrix, schedule, [tampered])).toThrow('INVALID_PRODUCER_RECEIPT');
  });

  test('a platform-pinned release cell runs only on its native producer platform', async () => {
    const release = createEvalMatrix({ ...releaseOptions, skillHashes: { v3: sha256(skills.v3) } }, privateManifest);
    const host = producerHostPlatform(), foreign = host === 'linux/amd64' ? 'linux/arm64' : 'linux/amd64';
    const native = release.cells.find(cell => cell.mode === 'comprehensive' && cell.platform === host);
    const other = release.cells.find(cell => cell.mode === 'comprehensive' && cell.platform === foreign)!;
    const destination = join(root(), 'prepared');
    expect(() => prepareEvalJobs(release, skills, join(root(), 'both'), [other.id], privateCorpus)).toThrow('EVAL_SKILL_HASH_MISMATCH');
    prepareEvalJobs(release, { v3: skills.v3 }, destination, [other.id, ...(native ? [native.id] : [])], privateCorpus);
    const receipts = join(root(), 'receipts'); mkdirSync(receipts);
    const isolatedOther = isolate(destination, other);
    const opaque = readFileSync(isolatedOther.input, 'utf8'), parsed = JSON.parse(opaque);
    expect(Object.keys(parsed).sort()).toEqual(['cellRef', 'execution', 'schemaVersion', 'skill', 'source']);
    expect(parsed).toMatchObject({ schemaVersion: 2, cellRef: other.id, execution: { mode: 'comprehensive', platform: other.platform, sourceHash: other.sourceHash } });
    expect(opaque).not.toMatch(/caseId|variant|vulnerable|"fixed"|"version"|repetition/); expect(opaque).not.toContain(other.caseId);
    const smuggled = isolate(destination, other);
    writeFileSync(smuggled.input, JSON.stringify({ ...parsed, caseId: other.caseId }));
    await expect(runProducerCell(smuggled.input, join(receipts, `${other.id}.json`), withHelper({ adapter: new FakeAdapter(() => {}), paidExecutionAuthorized: true }))).rejects.toThrow('INVALID_PRODUCER_INPUT');
    expect(readFileSync(join(isolatedOther.source, 'src/app.txt'), 'utf8')).toBe(`synthetic ${other.caseId} ${other.variant}\n`);
    await expect(runProducerCell(isolatedOther.input, join(receipts, `${other.id}.json`), withHelper({ adapter: new FakeAdapter(() => {}), paidExecutionAuthorized: true }))).rejects.toThrow('UNMATCHED_PRODUCER_PLATFORM');
    if (!native) return;
    const isolatedNative = isolate(destination, native);
    const receipt = await runProducerCell(isolatedNative.input, join(receipts, `${native.id}.json`), withHelper({ adapter: new FakeAdapter(() => {}), paidExecutionAuthorized: true }));
    expect(receipt.cellRef).toBe(native.id);
    const written = readFileSync(join(receipts, `${native.id}.json`), 'utf8');
    expect(JSON.parse(written)).not.toHaveProperty('cell');
    expect(written).not.toMatch(/caseId|variant|vulnerable|"fixed"/); expect(written).not.toContain(native.caseId);
  });

  test('seals source read-only and records a failed receipt after a mode/content mutation', async () => {
    const destination = join(root(), 'prepared');
    const cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell);
    const receipt = join(root(), `${cell.id}.json`);
    const original = readFileSync(join(isolated.source, 'app.mjs'), 'utf8');
    const adapter = new FakeAdapter(opts => {
      const source = opts.csoProducer!.sourceDirectory;
      expect(source).toBe(isolated.source);
      if (process.platform !== 'win32') {
        expect(statSync(source).mode & 0o777).toBe(0o555);
        expect(statSync(join(source, 'app.mjs')).mode & 0o777).toBe(0o444);
        // Simulate a stronger same-UID compromise: postchecks must still detect it.
        chmodSync(join(source, 'app.mjs'), 0o644);
      }
      writeFileSync(join(source, 'app.mjs'), 'changed by producer\n');
    });
    const written = await runProducerCell(isolated.input, receipt, withHelper({ adapter, paidExecutionAuthorized: true }));
    expectIntegrityReceipt(written, receipt, process.platform === 'win32'
      ? { code: 'INVALID_PRODUCER_SOURCE', reason: `source content check: "app.mjs" is ${'changed by producer\n'.length} bytes; expected ${Buffer.byteLength(original)}` }
      : { code: 'PRODUCER_CHANGED_SOURCE_MODE', reason: 'source modes check: "app.mjs" has mode 644; expected 444' });
    expect(readFileSync(join(isolated.source, 'app.mjs'), 'utf8')).not.toBe(original);
  });
});
