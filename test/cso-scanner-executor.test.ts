import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { CsoError, SnapshotManifest, canonical, sha256, snapshotPathHandle, snapshotPathId } from '../lib/cso/contracts';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { QualifiedScanner, SCANNER_CATALOG, ScannerCatalog, scannerVersionHash, selectScanner, validateScannerCatalog } from '../lib/cso/scanner-catalog';
import { ScannerRequest, ScannerRunInput, ScannerRunnerContext, executeScanner, prepareDockerScannerApplication, schemathesisControlRole, validateScannerRequest } from '../lib/cso/scanner-executor';
import { total } from '../lib/cso/admission';
import { SCANNER_IDS, ScannerExecution, ScannerId, scannerPlans } from '../lib/cso/scanners';
import { type PreparationSandboxRunner } from '../lib/cso/preparation-executor';
import { canonicalStartPlan } from '../lib/cso/verification';
import { completeRuntimeCatalogFixture } from './helpers/cso-runtime-catalog';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const HASH = 'a'.repeat(64), DIGEST = `sha256:${HASH}`;
const version = (id: ScannerId) => `${id} version ${id === 'osv' ? '2.4.0' : '4.0.0'}\n`;
function profile(id: ScannerId, platform: 'linux/amd64' | 'linux/arm64' = 'linux/amd64'): QualifiedScanner {
  const arch = platform.endsWith('arm64') ? 'arm64' : 'amd64';
  return { id: `${id}-test-${arch}`, scanner: id, state: 'qualified', platform, image: `ghcr.io/garrytan/gstack/cso-scanners/${id}-${arch}@${DIGEST}`,
    entrypoint: '/opt/cso/entrypoint', executable: '/opt/cso/bin/scanner', version: id === 'osv' ? '2.4.0' : '4.0.0', versionOutputSha256: scannerVersionHash(version(id)), helperAbi: 3, isolationPolicyHash: ISOLATION_POLICY_HASH,
    capabilities: scannerPlans({ snapshotRoot: '/source', offline: true, selected: [id] })[0].requiredFeatures,
    ...(id === 'semgrep' ? { assets: { semgrepRules: { path: '/policy/catalog/semgrep.yml', sha256: HASH } } } : {}),
    ...(['osv', 'trivy'].includes(id) ? { assets: { advisoryDatabase: { path: '/opt/cso/scanner-data/db', contentSha256: HASH, updatedAt: '2026-09-09T00:00:00.000Z', ecosystems: ['npm'] } } } : {}),
    qualifiedAt: '2026-09-09T00:00:00.000Z', qualification: { sourceCommit: 'b'.repeat(40), workflow: 'https://github.com/garrytan/gstack/actions/runs/42', sbomDigest: DIGEST, provenanceDigest: DIGEST, verifiedProvenance: true, containmentPassed: true, adapterContractPassed: true, offlineAssetsPassed: true } };
}
function catalog(..._ids: ScannerId[]): ScannerCatalog {
  const scanners = SCANNER_IDS.flatMap(id => [profile(id), profile(id, 'linux/arm64')]);
  return { schemaVersion: 1, helperAbi: 3, revision: 'unit-fixture-only', promotion: { sourceCommit: 'b'.repeat(40), workflow: 'https://github.com/garrytan/gstack/actions/runs/42', evidenceDigest: `sha256:${sha256(canonical(scanners))}` }, scanners };
}
const scannerProfile = (c: ScannerCatalog, id: ScannerId, platform: 'linux/amd64' | 'linux/arm64' = 'linux/amd64') => c.scanners.find(item => item.scanner === id && item.platform === platform)!;
const runtimes = completeRuntimeCatalogFixture('scanner-runtime-fixture');
function request(): ScannerRequest {
  return { api: { runtimeProfile: 'node', port: 3100, start: { executable: '/usr/local/bin/node', args: ['app.js'] }, control: { name: 'legitimate user', path: '/users', method: 'GET', expected: { status: 200, includes: 'users' } }, boundaryFiles: ['app.js'], operationIds: ['readUsers'], schema: { openapi: '3.1.0', info: { title: 'Unit fixture', version: '1.0.0' }, paths: { '/users': { get: { operationId: 'readUsers', responses: { '200': { description: 'Users' } } } } } } } };
}
function input(id: ScannerId): ScannerRunInput {
  const dir = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), 'cso-scanner-executor-')); roots.push(dir);
  const root = join(dir, 'snapshot'); fs.mkdirSync(root, { mode: 0o700 });
  const files = { 'app.js': 'export const app = true;\n', 'package.json': '{"name":"fixture","version":"1.0.0"}\n', 'package-lock.json': '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n' };
  const entries = Object.entries(files).map(([path, body]) => { fs.writeFileSync(join(root, path), body, { mode: 0o600 }); return { path, pathId: snapshotPathId(root,path), originalHash: sha256(body), executionHash: sha256(body), mode: 0o600, bytes: Buffer.byteLength(body) }; }).sort((a, b) => a.path.localeCompare(b.path));
  const manifest: SnapshotManifest = { version: 3, root, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), entries, headCommit: 'b'.repeat(40), originalHash: sha256(canonical(entries.map(e => [e.path, e.originalHash, e.mode]))), executionHash: sha256(canonical(entries.map(e => [e.path, e.executionHash, e.mode]))) };
  return { id, runId: 'unit-scanner-run', runDir: dir, manifest, policy: { mode: id === 'schemathesis' ? 'comprehensive' : 'daily', scope: 'default', diff: false, base: 'origin/main', offline: true, budgetSeconds: 600, maxWorkers: 3, maxRepairs: 3 }, executionDeadline: Date.now() + 300000, platform: 'linux/amd64', watchdogPath: '/trusted/test-watchdog', ...(id === 'schemathesis' ? { request: request() } : {}) };
}
function preparedApplication(spec: ScannerRunInput, cleanup: () => void = () => {}) {
  return { sourceRoot: join(spec.runDir, 'snapshot'), environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    proof: { dependencyClosureHash: HASH, preparedManifestHash: HASH, sourceProjectionHash: HASH, receiptHash: HASH, executionEnvironmentHash: HASH, databaseHash: HASH },
    cleanup: async () => { cleanup(); } };
}
function result(id: ScannerId): ScannerExecution {
  const data: Record<ScannerId, unknown> = {
    gitleaks: [{ RuleID: 'test-rule', Description: 'Candidate secret', File: '/source/app.js', StartLine: 1 }],
    osv: { results: [{ source: { path: '/source/package-lock.json' }, packages: [{ package: { name: 'fixture-package', version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: [{ id: 'CVE-2026-12345', summary: 'Candidate dependency defect' }] }] }] },
    semgrep: { results: [{ check_id: 'test-rule', path: '/source/app.js', start: { line: 1, col: 1 }, extra: { message: 'Candidate code defect', severity: 'ERROR' } }], errors: [], paths: { scanned: ['/source/app.js'] } },
    zizmor: { version: '2.1.0', runs: [{ tool: { driver: { name: 'zizmor', version: '4.0.0' } }, results: [{ ruleId: 'test-rule', message: { text: 'Candidate workflow defect' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'app.js' }, region: { startLine: 1 } } }] }] }] },
    trivy: { SchemaVersion: 2, Results: [{ Target: 'app.js', Secrets: [{ RuleID: 'test-rule', Title: 'Candidate secret', Severity: 'HIGH', StartLine: 1 }] }] },
    schemathesis: { schemathesis_version: '4.0.0', complete: true, stop_reason: 'completed', operations: { selected: 1, tested: 1, errored: 0, skipped: 0 }, errors: [], failures: [{ type: 'ServerError', title: 'Candidate API failure', severity: 'high', operations: ['GET /users'] }] },
  };
  return { stdout: JSON.stringify(data[id]), stderr: '', exitCode: id === 'gitleaks' ? 10 : ['osv', 'schemathesis'].includes(id) ? 1 : 0 };
}

describe('reviewed scanner catalog contract', () => {
  test('the shipped catalog has no executable unqualified fallback', () => { expect(SCANNER_CATALOG.scanners).toEqual([]); expect(() => selectScanner('gitleaks', 'linux/amd64')).toThrow('No qualified'); });
  test.each(SCANNER_IDS)('selects a qualified immutable %s profile', id => { const c = catalog(id); validateScannerCatalog(c); expect(selectScanner(id, 'linux/amd64', undefined, c)).toEqual(scannerProfile(c, id)); });
  test.each(['tag', 'entrypoint', 'policy', 'abi', 'qualification', 'executable', 'version', 'capabilities'])('rejects unreviewed %s', field => {
    const c = catalog('gitleaks'), p = scannerProfile(c, 'gitleaks') as any;
    if (field === 'tag') p.image = 'gitleaks:latest';
    if (field === 'entrypoint') p.entrypoint = '/bin/sh';
    if (field === 'policy') p.isolationPolicyHash = HASH;
    if (field === 'abi') p.helperAbi = 2;
    if (field === 'qualification') p.qualification.verifiedProvenance = false;
    if (field === 'executable') p.executable = '/source/scanner';
    if (field === 'version') p.versionOutputSha256 = 'unknown';
    if (field === 'capabilities') p.capabilities = [];
    expect(() => validateScannerCatalog(c)).toThrow();
  });
  test('missing IDs, duplicates, and platform substitution are rejected', () => {
    const c = catalog('gitleaks'); delete (scannerProfile(c, 'gitleaks') as any).id; expect(() => validateScannerCatalog(c)).toThrow();
    const duplicate = catalog('gitleaks'); duplicate.scanners[1].id = duplicate.scanners[0].id; expect(() => validateScannerCatalog(duplicate)).toThrow();
    expect(() => selectScanner('gitleaks', 'linux/arm64', 'missing-profile', catalog('gitleaks'))).toThrow('No qualified');
  });
  test('rules and databases cannot point into repository source or mutable work space', () => {
    const rules = catalog('semgrep'); scannerProfile(rules, 'semgrep').assets!.semgrepRules!.path = '/source/rules.yml'; expect(() => validateScannerCatalog(rules)).toThrow();
    const db = catalog('osv'); scannerProfile(db, 'osv').assets!.advisoryDatabase!.path = '/work/cache'; expect(() => validateScannerCatalog(db)).toThrow();
  });
  test('rejects a self-asserted partial catalog even when its one profile is otherwise plausible', () => {
    const c = catalog('gitleaks'); c.scanners = [scannerProfile(c, 'gitleaks')]; expect(() => validateScannerCatalog(c)).toThrow('Incompatible scanner catalog');
  });
});

describe('all six helper-owned scanner execution paths', () => {
  test.each(SCANNER_IDS)('%s reaches version, scan, normalization, and cleanup through an injected runner', async id => {
    const calls: string[] = []; let captured: ScannerRunnerContext | undefined;
    const spec = input(id), record = await executeScanner(spec, { catalog: catalog(id), runtimes,
      ...(id === 'schemathesis' ? { applicationPreparer: async () => preparedApplication(spec) } : {}),
      runnerFactory: async context => { captured = context; return { version: async () => { calls.push('version'); return { stdout: version(id), exitCode: 0 }; }, scan: async () => { calls.push('scan'); return result(id); }, cleanup: async () => { calls.push('cleanup'); } }; } });
    expect(calls).toEqual(['version', 'scan', 'cleanup']);
    expect(captured!.plan.execution).toBe('sandbox');
    expect(captured!.plan.network).toBe(id === 'schemathesis' ? 'loopback' : 'none');
    expect(captured!.plan.args.join(' ')).not.toMatch(/download|--network|docker.sock|--metrics=on/);
    expect(captured!.deadline).toBeLessThanOrEqual(Date.now() + 300000);
    expect(record.outcome.status).toBe('complete'); expect(record.outcome.candidates).toHaveLength(1);
    expect(record.outcome.candidates[0]).toMatchObject({ evidence: 'scanner-candidate', trust: 'untrusted' });
    expect(record.outcome.candidates[0]).not.toHaveProperty('reproduced'); expect(record.outcome.candidates[0]).not.toHaveProperty('repair');
    expect(record.coverage).toMatchObject({ domain: `scanner:${id}`, status: 'assessed' });
    expect(record.provenance.versionOutputSha256).toBe(profile(id).versionOutputSha256);
    expect(record.provenance.image).toBe(profile(id).image);
    if (id === 'schemathesis') { expect(captured!.application?.sourceRoot).toBe(join(spec.runDir, 'snapshot')); expect(record.provenance.preparation?.dependencyClosureHash).toBe(HASH); }
    else expect(record.provenance.preparation).toBeNull();
    if (id === 'osv' || id === 'trivy') expect(record.outcome.databaseUpdatedAt).toBe('2026-09-09T00:00:00.000Z');
  });
  test('missing catalog never creates a runner and records the exact prerequisite', async () => {
    let calls = 0; const out = await executeScanner(input('gitleaks'), { runnerFactory: async () => { calls++; throw new Error('must not run'); } });
    expect(calls).toBe(0); expect(out.coverage.status).toBe('not_assessed'); expect(out.outcome.gaps[0].message).toContain('No qualified gitleaks');
  });
  test.each(['semgrep', 'osv', 'trivy'] as ScannerId[])('%s missing baked assets cannot launch a scanner or download replacements', async id => {
    let calls = 0; const c = catalog(id); delete scannerProfile(c, id).assets;
    const out = await executeScanner(input(id), { catalog: c, runnerFactory: async () => { calls++; throw new Error('must not run'); } });
    expect(calls).toBe(0); expect(out.outcome.status).toBe('not_assessed'); expect(out.outcome.gaps[0].code).toBe('PREREQUISITE');
  });
  test('version mismatch cleans up without scanning', async () => {
    const calls: string[] = [];
    const out = await executeScanner(input('gitleaks'), { catalog: catalog('gitleaks'), runnerFactory: async () => ({ version: async () => ({ stdout: 'different version', exitCode: 0 }), scan: async () => { calls.push('scan'); return result('gitleaks'); }, cleanup: async () => { calls.push('cleanup'); } }) });
    expect(calls).toEqual(['cleanup']); expect(out.outcome.status).toBe('not_assessed'); expect(out.outcome.version).toBeNull(); expect(out.outcome.gaps[0].message).toContain('version output');
  });
  test.each([['timeout', 'TIMEOUT'], ['redaction', 'REDACTION_FAILED'], ['invalid-output', 'INVALID_OUTPUT'], ['tool', 'TOOL_FAILED'], ['cleanup', 'ISOLATION_FAILED']] as const)('%s preserves truthful scanner coverage', async (failure, code) => {
    let cleaned = false;
    const out = await executeScanner(input('gitleaks'), { catalog: catalog('gitleaks'), runnerFactory: async () => ({ version: async () => ({ stdout: version('gitleaks'), exitCode: 0 }), scan: async () => { if (failure === 'timeout') throw new CsoError('DEADLINE', 'Scanner timed out'); if (failure === 'redaction') throw new CsoError('REDACTION_FAILED', 'Scanner output withheld'); if (failure === 'tool') throw new CsoError('TOOL_FAILED', 'Scanner process failed'); return failure === 'invalid-output' ? { stdout: '{', exitCode: 0 } : result('gitleaks'); }, cleanup: async () => { cleaned = true; if (failure === 'cleanup') throw new CsoError('ISOLATION_FAILED', 'Exact cleanup failed'); } }) });
    expect(cleaned).toBe(true); expect(out.outcome.status).toBe('not_assessed'); expect(out.outcome.candidates).toEqual([]); expect(out.outcome.gaps[0].code).toBe(code);
  });
  test('online policy still supplies only offline scanner plans', async () => {
    const spec = input('osv'); spec.policy.offline = false;
    await executeScanner(spec, { catalog: catalog('osv'), runnerFactory: async c => { expect(c.plan.network).toBe('none'); expect(c.plan.args).toContain('--offline'); return { version: async () => ({ stdout: version('osv'), exitCode: 0 }), scan: async () => result('osv'), cleanup: async () => {} }; } });
  });
  test('expired or changed retained source cannot enter the runner', async () => {
    for (const expired of [true, false]) {
      const spec = input('gitleaks'); if (expired) spec.manifest.expiresAt = '2000-01-01T00:00:00.000Z'; else fs.writeFileSync(join(spec.runDir, 'snapshot/app.js'), 'changed');
      let calls = 0; const out = await executeScanner(spec, { catalog: catalog('gitleaks'), runnerFactory: async () => { calls++; throw new Error('must not run'); } });
      expect(calls).toBe(0); expect(out.outcome.status).toBe('not_assessed');
    }
  });
  test('source changed during collection invalidates the candidate evidence', async () => {
    const spec = input('gitleaks');
    const out = await executeScanner(spec, { catalog: catalog('gitleaks'), runnerFactory: async () => ({ version: async () => ({ stdout: version('gitleaks'), exitCode: 0 }), scan: async () => { fs.writeFileSync(join(spec.runDir, 'snapshot/app.js'), 'racing change'); return result('gitleaks'); }, cleanup: async () => {} }) });
    expect(out.outcome.candidates).toEqual([]); expect(out.outcome.gaps[0].message).toContain('snapshot changed');
  });
  test('deadline is subordinate to the reporting reserve', async () => {
    const spec = input('gitleaks'); spec.executionDeadline = Date.now() - 1; let calls = 0;
    const out = await executeScanner(spec, { catalog: catalog('gitleaks'), runnerFactory: async () => { calls++; throw new Error('must not run'); } });
    expect(calls).toBe(0); expect(out.outcome.gaps[0].code).toBe('TIMEOUT');
  });
});

describe('Schemathesis application admission', () => {
  test('opaque boundary and startup handles resolve only against the retained manifest',async()=>{
    const spec=input('schemathesis'),raw=request(),app=spec.manifest.entries.find(entry=>entry.path==='app.js')!,handle=snapshotPathHandle(app.pathId);raw.api!.boundaryFiles=[handle];raw.api!.start.args=[handle];spec.request=raw;let captured:ScannerRunnerContext|undefined;
    const record=await executeScanner(spec,{catalog:catalog('schemathesis'),runtimes,applicationPreparer:async()=>preparedApplication(spec),runnerFactory:async context=>{captured=context;return{version:async()=>({stdout:version('schemathesis'),exitCode:0}),scan:async()=>result('schemathesis'),cleanup:async()=>{}};}});
    expect(record.outcome.status).toBe('complete');expect(captured!.input.request!.api).toMatchObject({boundaryFiles:['app.js'],start:{args:['app.js']}});expect(record.provenance.requestHash).toBe(sha256(canonical(validateScannerRequest(raw,'schemathesis'))));
  });
  test('Rails with PostgreSQL and its control verifier fits the aggregate group admission', () => {
    expect(schemathesisControlRole()).toBe('verifier');
    expect(total(['anchor', 'postgres', 'app', schemathesisControlRole()]).memoryMiB).toBe(3904);
    expect(() => total(['anchor', 'postgres', 'app', 'tests'])).toThrow('aggregate reproduction-group limit');
  });
  test('daily mode blocks application execution before creating a runner', async () => {
    const spec = input('schemathesis'); spec.policy.mode = 'daily'; let calls = 0;
    const out = await executeScanner(spec, { catalog: catalog('schemathesis'), runtimes, runnerFactory: async () => { calls++; throw new Error('must not run'); } });
    expect(calls).toBe(0); expect(out.outcome.gaps[0].message).toContain('comprehensive mode');
  });
  test('transformed security boundaries block API execution', async () => {
    const spec = input('schemathesis'); spec.manifest.entries.find(e => e.path === 'app.js')!.transformation = 'sanitized'; let calls = 0;
    const out = await executeScanner(spec, { catalog: catalog('schemathesis'), runtimes, runnerFactory: async () => { calls++; throw new Error('must not run'); } });
    expect(calls).toBe(0); expect(out.outcome.gaps[0].message).toContain('boundary is missing or transformed');
  });
  test('no runtime profile means a prerequisite, not a scanner success', async () => {
    const out = await executeScanner(input('schemathesis'), { catalog: catalog('schemathesis') });
    expect(out.outcome.status).toBe('not_assessed'); expect(out.outcome.gaps[0].message).toContain('runtime is unavailable');
  });
  test.each(['remote-ref', 'server', 'hook', 'callback', 'operation', 'unbounded', 'source-command'])('rejects hostile or ambiguous %s harness input', kind => {
    const raw = request() as any;
    if (kind === 'remote-ref') raw.api.schema.components = { schemas: { User: { $ref: 'https://example.test/user.json' } } };
    if (kind === 'server') raw.api.schema.servers = [{ url: 'https://example.test' }];
    if (kind === 'hook') raw.api.schema['x-hooks'] = 'module.py';
    if (kind === 'callback') raw.api.schema.callbacks = {};
    if (kind === 'operation') raw.api.operationIds = ['not-declared'];
    if (kind === 'unbounded') raw.api.maxExamples = 100000;
    if (kind === 'source-command') raw.api.start = { executable: 'node', args: [] };
    expect(() => validateScannerRequest(raw, 'schemathesis')).toThrow();
  });
  test('rejects an absolute synthetic server and startup boundaries that omit the canonical entrypoint', async () => {
    for (const kind of ['synthetic', 'missing-entrypoint'] as const) {
      const spec = input('schemathesis'), api = spec.request!.api!; let prepared = 0, runners = 0;
      if (kind === 'synthetic') api.start = { executable: '/usr/local/bin/node', args: ['-e', "require('http').createServer((q,s)=>s.end('synthetic')).listen(3100)"] };
      else api.boundaryFiles = ['package.json'];
      const out = await executeScanner(spec, { catalog: catalog('schemathesis'), runtimes,
        applicationPreparer: async () => { prepared++; return preparedApplication(spec); },
        runnerFactory: async () => { runners++; throw new Error('must not run'); } });
      expect(prepared).toBe(0); expect(runners).toBe(0); expect(out.outcome.status).toBe('not_assessed');
      expect(out.outcome.gaps[0].message).toMatch(/helper-derived|canonical startup input/);
    }
  });
  test('materialized application cleanup failure withholds otherwise complete API coverage', async () => {
    const spec = input('schemathesis');
    const out = await executeScanner(spec, { catalog: catalog('schemathesis'), runtimes,
      applicationPreparer: async () => ({ ...preparedApplication(spec), cleanup: async () => { throw new CsoError('ISOLATION_FAILED', 'prepared source cleanup failed'); } }),
      runnerFactory: async () => ({ version: async () => ({ stdout: version('schemathesis'), exitCode: 0 }), scan: async () => result('schemathesis'), cleanup: async () => {} }) });
    expect(out.outcome.status).toBe('not_assessed'); expect(out.outcome.candidates).toEqual([]); expect(out.outcome.gaps[0].message).toContain('cleanup failed');
  });
  test('scanner preparation construction failure preserves Docker watchdog journals for detached recovery',async()=>{const spec=input('schemathesis'),snapshot=join(spec.runDir,'snapshot'),integrity=Buffer.alloc(64,7).toString('base64');spec.policy.offline=false;fs.writeFileSync(join(snapshot,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',dependencies:{cookie:'1.0.0'}}));fs.writeFileSync(join(snapshot,'package-lock.json'),JSON.stringify({name:'fixture',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0',dependencies:{cookie:'1.0.0'}},'node_modules/cookie':{name:'cookie',version:'1.0.0',resolved:'https://registry.npmjs.org/cookie/-/cookie-1.0.0.tgz',integrity:`sha512-${integrity}`}}}));const runtime=runtimes.runtimes.find(item=>item.stack==='node'&&item.platform==='linux/amd64')!,qualification={schemaVersion:1 as const,helperAbi:3,runnerId:'scanner-construction-fault',policyVersion:'cso-preparation-v1' as const,supportedStacks:['node','bun','python','rails'] as any,registryRestrictionQualified:true as const,dnsRebindingTestsPassed:true as const,acquisitionExcludesSource:true as const,offlineContainmentQualified:true as const,immutableArchiveMounts:true as const,resourceLimitsEnforced:true as const};let control='';const runnerFactory=(options:any):PreparationSandboxRunner=>({qualification,acquire:async()=>{control=join(options.controlRoot,'acquisition-fault');fs.mkdirSync(control,{recursive:true});fs.writeFileSync(join(control,'watchdog.ready'),'ready\n',{mode:0o600});fs.writeFileSync(join(control,'watchdog.event'),'cleanup incomplete; retrying exact journaled resources\n',{mode:0o600});fs.writeFileSync(join(control,'resources.journal'),`container:${'a'.repeat(64)}\n`,{mode:0o600});throw new CsoError('ISOLATION_FAILED','Exact preparation cleanup failed; detached watchdog remains responsible');},prepareOffline:async()=>{throw new Error('must not prepare');},disposePrepared:()=>{}});await expect(prepareDockerScannerApplication({input:spec,runtime,stack:'node',startPlan:canonicalStartPlan(snapshot,'node',3100),deadline:Date.now()+30_000,catalog:runtimes},{endpoint:{} as any,runnerFactory,cacheRoot:join(spec.runDir,'cache')})).rejects.toThrow('detached watchdog remains responsible');expect(fs.existsSync(join(control,'resources.journal'))).toBe(true);expect(fs.existsSync(join(control,'watchdog.ready'))).toBe(true);expect(fs.existsSync(control)).toBe(true);});
  test('static scanners cannot accept application commands or arbitrary extra runner fields', () => {
    expect(() => validateScannerRequest(request(), 'semgrep')).toThrow('Only Schemathesis');
    expect(() => validateScannerRequest({ image: 'evil:latest' }, 'gitleaks')).toThrow('Unexpected');
  });
});
