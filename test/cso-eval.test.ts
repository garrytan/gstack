import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectProducerReceipts, createEvalMatrix, createPortableSkillPayload, loadPortableSkillPayload, prepareEvalJobs, REQUIRED_CONTAINMENT, scoreCollectedEval, scoreEval, validateMatrix, validatePortableSkillPayload, type EvalCell, type EvalResult, type PreparedEvalSchedule } from '../scripts/cso-eval';
import { PRODUCER_PROVIDER_POLICY, producerFailureMessage, producerInstallationIdentity, resolveProducerHelperBinding, runProducerCell, validateProductionProducerInstallation } from '../scripts/cso-eval-producer';
import { producerArtifactInventoryHash, producerInstallationIdentityHash, producerProviderIdentityHash, producerReceiptHash, sha256, type ProducerArtifactInventory, type ProducerInstallationIdentity, type ProducerProviderIdentity, type ProducerReceipt } from '../scripts/cso-eval-protocol';
import type { Family, ProviderAdapter, RunOpts, RunResult } from './helpers/providers/types';
import { CORPUS_VERSION, FAMILIES, STACKS, loadCorpusManifest, materializeCase, sourceFiles, sourceHash } from './fixtures/cso-eval/materialize';
import { judgeRepair, oracleFor, type PrivateEvidence } from './helpers/cso-eval-oracles';
import { inspectPreparation } from '../lib/cso/preparation';
import { assertRuntimeCompatible, RUNTIME_CATALOG } from '../lib/cso/runtime-catalog';
import { canonicalStartPlan, canonicalTestPlan } from '../lib/cso/verification';
import { CsoError } from '../lib/cso/contracts';
import { geminiProducerPaths, geminiProducerSystemSettings } from './helpers/providers/gemini';

const temporary: string[] = [];
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
function syntheticResult(cell: EvalCell): EvalResult {
  const runtime = cell.mode === 'comprehensive';
  const positive = cell.variant === 'vulnerable';
  return { cellId: cell.id, sourceHash: cell.sourceHash, skillHash: cell.skillHash, model: cell.model, host: cell.host, budgetSeconds: cell.budgetSeconds,
    reportPresent: true, reportComplete: true,
    findings: positive ? [{ id: 'finding-1', evidence: cell.version === 'v2' ? 'legacy_review' : 'supported', claimedTested: runtime && cell.version === 'v3', judgment: 'correct', matchedCaseId: cell.caseId }] : [],
    setup: runtime ? 'passed' : 'not_attempted', reproduction: runtime && positive ? 'passed' : 'not_attempted', repair: runtime && positive ? 'passed' : 'not_attempted', recheck: runtime && positive ? 'passed' : 'not_attempted',
    ...(runtime && positive ? { oracleEvidenceHash: 'c'.repeat(64), oracleVersion: CORPUS_VERSION, currentSourceHash: corpus.cases.find(fixture => fixture.id === cell.caseId)!.filesHash.fixed, recheckEvidenceHash: 'd'.repeat(64) } : {}),
    heldOutAssertionsPassed: runtime && positive, freshRecheck: runtime && positive, latencyMs: 1500, firstUsefulResultMs: positive ? 500 : null,
  };
}
const group = (score: ReturnType<typeof scoreEval>, version: string, mode: string) => score.groups.find(item => item.version === version && item.mode === mode)!;
function syntheticInstallationIdentity(seed = '1'): ProducerInstallationIdentity {
  const artifact = (offset: number) => ({ sha256: sha256(`${seed}:artifact:${offset}`), bytes: 100 + offset });
  const core = artifact(3);
  const withoutHash: Omit<ProducerInstallationIdentity, 'identityHash'> = {
    schemaVersion: 1,
    producer: artifact(1), launcher: artifact(2), core, watchdog: artifact(4),
    generation: { coreSha256: core.sha256, manifest: { sha256: sha256(`${core.sha256}\n`), bytes: 65 } },
    embeddedCatalogs: {
      runtimeRevision: 'runtime-test', runtimeBuildRevision: 'runtime-build-test', runtimeSha256: sha256(`${seed}:runtime`),
      scannerRevision: 'scanner-test', scannerSha256: sha256(`${seed}:scanner`),
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
function syntheticReceipt(cell: EvalCell): ProducerReceipt {
  const withoutHash: Omit<ProducerReceipt, 'receiptHash'> = { schemaVersion: 1, cell, inputHash: 'e'.repeat(64), installationIdentity: syntheticInstallationIdentity(), providerIdentity: syntheticProviderIdentity(cell.host === 'codex' ? 'gpt' : cell.host), artifacts: syntheticArtifactInventory(), startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', status: 'succeeded', requestedModel: cell.model, modelUsed: `resolved-${cell.model}`, modelIdentitySource: 'provider_reported', durationMs: 1000, firstUsefulResultMs: null, toolCalls: 1, output: 'synthetic producer transcript', outputHash: sha256('synthetic producer transcript'), usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, estimatedCostUSD: 0.001 } };
  return { ...withoutHash, receiptHash: producerReceiptHash(withoutHash) };
}
function syntheticSchedule(): PreparedEvalSchedule {
  return { schemaVersion: 1, matrixHash: createHash('sha256').update(JSON.stringify(matrix)).digest('hex'), scheduledCells: matrix.cells.length, preparedCells: matrix.cells.length, jobs: matrix.cells.map(cell => ({ cellId: cell.id, relativePath: `jobs/${cell.id}`, inputHash: 'e'.repeat(64) })) };
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
      expect(input.cell.skillHash).toBe(sha256(input.skill));
      expect(input.skill).toContain(`${cell.version.toUpperCase()}_SECTION_ONLY`);
      expect(input.skill).not.toContain(cell.version === 'v2' ? 'V3_SECTION_ONLY' : 'V2_SECTION_ONLY');
      expect(validatePortableSkillPayload(input.skill, cell.version).files.map(file => file.path)).toEqual(['SKILL.md', 'sections/manifest.json', 'sections/audit-phases.md']);
    }
    expect(() => prepareEvalJobs(producerMatrix, { ...skills, v3: portableSkill('v3', 'CHANGED_V3_SECTION') }, join(root(), 'bad'), selected.map(cell => cell.id))).toThrow('EVAL_SKILL_HASH_MISMATCH');
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
        timeoutMs: cell.budgetSeconds * 1000,
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
      const artifactRoot = join(process.env.GSTACK_HOME!, 'security', 'cso', 'run-1');
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
    expect(receipt.artifacts.entries.map(entry => entry.path)).toEqual(['run-1/repair.patch', 'run-1/report.json']);
    expect(receipt.artifacts.identityHash).toBe(producerArtifactInventoryHash({ schemaVersion: 1, root: 'security/cso', entries: receipt.artifacts.entries, totalBytes: receipt.artifacts.totalBytes }));
    const retainedHome = join(isolated.job, 'state', 'cso-home');
    expect(readFileSync(join(retainedHome, 'security', 'cso', 'run-1', 'report.json'), 'utf8')).toContain('complete');
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
      expect(receipt.error).toEqual({ code: 'unknown', reason: 'Sensitive producer output or error withheld' });
      const stored = readFileSync(receiptPath, 'utf8');
      expect(stored).not.toContain('sk-proj-');
      expect(stored).not.toContain('b'.repeat(40));
    }
  });

  test('withholds the receipt when the bound provider executable changes during a cell', async () => {
    const destination = join(root(), 'provider-race-prepared'), cell = selected[0];
    prepareEvalJobs(producerMatrix, skills, destination, [cell.id]);
    const isolated = isolate(destination, cell), launcher = helperBundle();
    const outputRoot = join(root(), 'provider-race-receipts'); mkdirSync(outputRoot);
    const receiptPath = join(outputRoot, `${cell.id}.json`);
    const adapter = new FakeAdapter(opts => writeFileSync(opts.csoProducer!.providerCommand.executable, '#!/bin/sh\nexit 1\n'));
    await expect(runProducerCell(isolated.input, receiptPath, withHelper({ adapter, paidExecutionAuthorized: true }, launcher))).rejects.toThrow('PRODUCER_PROVIDER_INSTALLATION_RACE');
    expect(existsSync(receiptPath)).toBe(false);
  });

  test('withholds the receipt when the helper generation changes during a cell', async () => {
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
    await expect(runProducerCell(isolated.input, receiptPath, withHelper({ adapter, paidExecutionAuthorized: true }, launcher))).rejects.toThrow('PRODUCER_HELPER_GENERATION_CHANGED');
    expect(existsSync(receiptPath)).toBe(false);
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

  test('seals source read-only and withholds a receipt after a mode/content mutation', async () => {
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
    await expect(runProducerCell(isolated.input, receipt, withHelper({ adapter, paidExecutionAuthorized: true }))).rejects.toThrow(process.platform === 'win32' ? 'INVALID_PRODUCER_SOURCE' : 'PRODUCER_CHANGED_SOURCE_MODE');
    expect(readFileSync(join(isolated.source, 'app.mjs'), 'utf8')).not.toBe(original);
    expect(existsSync(receipt)).toBe(false);
  });
});
