/** Scanner orchestration is helper-owned; target/scanner commands only enter DockerGroup. */
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Command, CoverageRecord, CsoError, HttpAssertion, RunPolicy, SnapshotManifest, canonical, object, relativePath, sha256, snapshotPathHandleId, snapshotReference, string, strings, validateCommand, validateVerificationObservation, type ErrorCode } from './contracts';
import { DockerEndpoint, DockerGroup, dockerEndpoint } from './docker';
import { inspectPreparation, type CsoStack } from './preparation';
import { redact } from './process';
import { QualifiedRuntime, RUNTIME_CATALOG, RuntimeCatalog, RuntimePlatform, assertRuntimeCompatible, selectRuntime } from './runtime-catalog';
import { QualifiedScanner, SCANNER_CATALOG, ScannerCatalog, scannerVersionHash, selectScanner } from './scanner-catalog';
import { ScannerExecution, ScannerGap, ScannerId, ScannerOutcome, ScannerPlan, parseScannerOutput, scannerPlans } from './scanners';
import { assertSnapshot } from './snapshot';
import { hasPendingWatchdogCleanup, secureDirectory } from './state';
import { PublicArchiveCache, publicArchiveCacheRoot } from './cache';
import { admitPreparationRuntime, admitPreparationSidecar, PreparationExecutor, type PreparationSandboxRunner, type RailsDatabaseSelection } from './preparation-executor';
import type { PreparedDatabaseContract } from './preparation-executor';
import { DockerPreparationSandboxRunner } from './preparation-docker';
import { canonicalStartPlan, type CanonicalStartPlan } from './verification';

export interface ScannerRequest {
  profile?: string;
  api?: {
    runtimeProfile: string;
    port: number;
    start: Command;
    control: HttpAssertion;
    boundaryFiles: string[];
    schema: Record<string, unknown>;
    operationIds: string[];
    seed?: number;
    maxExamples?: number;
  };
}
export interface ScannerRunInput {
  id: ScannerId;
  runId: string;
  runDir: string;
  manifest: SnapshotManifest;
  policy: RunPolicy;
  executionDeadline: number;
  platform: RuntimePlatform;
  request?: ScannerRequest;
  watchdogPath: string;
}
export interface ScannerRunRecord {
  outcome: ScannerOutcome;
  coverage: CoverageRecord;
  provenance: {
    scannerCatalog: string;
    profile: string | null;
    image: string | null;
    platform: RuntimePlatform;
    isolationPolicyHash: string | null;
    sourceHash: string;
    requestHash: string;
    versionOutputSha256: string | null;
    assets: QualifiedScanner['assets'] | null;
    network: 'none' | 'isolated-loopback';
    preparation: ScannerApplicationPreparation['proof'] | null;
  };
}
export interface ScannerApplicationPreparation {
  sourceRoot: string;
  environment: Record<string, string>;
  database?: PreparedDatabaseContract;
  proof: {
    dependencyClosureHash: string;
    preparedManifestHash: string;
    sourceProjectionHash: string;
    receiptHash: string;
    executionEnvironmentHash: string;
    databaseHash: string;
  };
  cleanup(): Promise<void>;
}
export interface ScannerRunner {
  version(): Promise<ScannerExecution>;
  scan(): Promise<ScannerExecution>;
  cleanup(): Promise<void>;
}
/** The trusted HTTP control probe is always the bounded verifier process. */
export function schemathesisControlRole(): 'verifier' { return 'verifier'; }
export interface ScannerRunnerContext {
  input: ScannerRunInput;
  plan: ScannerPlan;
  profile: QualifiedScanner;
  runtime?: QualifiedRuntime;
  application?: ScannerApplicationPreparation;
  deadline: number;
}
export type ScannerRunnerFactory = (context: ScannerRunnerContext) => Promise<ScannerRunner>;
export type ScannerApplicationPreparer = (context: {
  input: ScannerRunInput;
  runtime: QualifiedRuntime;
  stack: CsoStack;
  startPlan: CanonicalStartPlan;
  deadline: number;
  catalog: RuntimeCatalog;
}) => Promise<ScannerApplicationPreparation>;
export interface ScannerRunDependencies {
  catalog?: ScannerCatalog;
  runtimes?: RuntimeCatalog;
  /** Unit tests inject a runner to check dispatch/claims; this does not attest containment. */
  runnerFactory?: ScannerRunnerFactory;
  /** Unit tests may inject a materializer; production always uses the qualified offline preparation path. */
  applicationPreparer?: ScannerApplicationPreparer;
}

function exact(v: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new CsoError('INVALID_SCHEMA', `Unexpected ${name} field: ${key}`);
}
function boundedInt(v: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw new CsoError('INVALID_SCHEMA', `${name} must be ${min}..${max}`);
  return v as number;
}
function control(value: unknown): HttpAssertion {
  const v = object(value, 'API control'), expected = object(v.expected, 'API control expected');
  exact(v, ['name', 'path', 'method', 'headers', 'body', 'expected'], 'API control');
  exact(expected, ['status', 'includes', 'excludes'], 'API control expected');
  const path = string(v.path, 'API control path', 4096);
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path)) throw new CsoError('INVALID_SCHEMA', 'API control path must remain on numeric loopback');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(v.method)) throw new CsoError('INVALID_SCHEMA', 'Invalid API control method');
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(v.headers === undefined ? {} : object(v.headers, 'API control headers'))) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) throw new CsoError('INVALID_SCHEMA', 'Invalid API control header');
    headers[key] = value;
  }
  return { name: string(v.name, 'API control name', 200), path, method: v.method, headers,
    ...(v.body === undefined ? {} : { body: string(v.body, 'API control body', 65536) }),
    expected: { status: boundedInt(expected.status, 100, 599, 'API control status'),
      ...(expected.includes === undefined ? {} : { includes: string(expected.includes, 'API control includes', 8192) }),
      ...(expected.excludes === undefined ? {} : { excludes: string(expected.excludes, 'API control excludes', 8192) }) } };
}
/** Accept a bounded OpenAPI document, with internal references and selected path operations only. */
export function validateScannerRequest(value: unknown, id: ScannerId): ScannerRequest {
  const v = object(value, 'scanner request');
  exact(v, ['profile', 'api'], 'scanner request');
  const request: ScannerRequest = v.profile === undefined ? {} : { profile: string(v.profile, 'scanner profile', 100) };
  if (v.api === undefined) return request;
  if (id !== 'schemathesis') throw new CsoError('INVALID_SCHEMA', 'Only Schemathesis accepts application execution inputs');
  const api = object(v.api, 'API scan');
  exact(api, ['runtimeProfile', 'port', 'start', 'control', 'boundaryFiles', 'schema', 'operationIds', 'seed', 'maxExamples'], 'API scan');
  const schema = object(api.schema, 'OpenAPI schema'), operations = strings(api.operationIds, 'operation IDs');
  if (operations.length < 1 || operations.length > 20 || new Set(operations).size !== operations.length || operations.some(x => x.length > 200 || /[\x00-\x1f]/.test(x))) throw new CsoError('INVALID_SCHEMA', 'Declare 1..20 unique bounded operation IDs');
  if (typeof schema.openapi !== 'string' || !/^3\.[01]\.\d+$/.test(schema.openapi)) throw new CsoError('PREREQUISITE', 'Schemathesis requires a reviewed OpenAPI 3.0/3.1 JSON document');
  if (Buffer.byteLength(JSON.stringify(schema)) > 262144) throw new CsoError('INVALID_SCHEMA', 'OpenAPI schema exceeds 256 KiB');
  let nodes = 0;
  const inspect = (x: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 32) throw new CsoError('INVALID_SCHEMA', 'OpenAPI schema exceeds structural bounds');
    if (!x || typeof x !== 'object') return;
    for (const [key, value] of Object.entries(x)) {
      if (['__proto__', 'prototype', 'constructor', 'externalValue', 'callbacks', 'webhooks'].includes(key) || /hooks?/i.test(key)) throw new CsoError('PREREQUISITE', 'OpenAPI external examples, callbacks, webhooks, and hooks are not admitted');
      if (key === '$ref' && (typeof value !== 'string' || !value.startsWith('#/'))) throw new CsoError('PREREQUISITE', 'OpenAPI references must be internal JSON pointers');
      if (key === 'servers' && (!Array.isArray(value) || value.length)) throw new CsoError('PREREQUISITE', 'Remove server overrides from the reviewed API harness; its target is the isolated loopback application');
      inspect(value, depth + 1);
    }
  };
  inspect(schema, 0);
  const declared: string[] = [];
  for (const [path, item] of Object.entries(object(schema.paths, 'OpenAPI paths'))) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\?#]/.test(path)) throw new CsoError('INVALID_SCHEMA', 'OpenAPI paths must be relative to the loopback target');
    const methods = object(item, 'OpenAPI path');
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']) {
      if (methods[method] === undefined) continue;
      const op = object(methods[method], 'OpenAPI operation');
      if (typeof op.operationId === 'string') declared.push(op.operationId);
    }
  }
  if (operations.some(op => declared.filter(x => x === op).length !== 1)) throw new CsoError('INVALID_SCHEMA', 'Every selected operation must identify exactly one declared OpenAPI path operation');
  const boundaries = strings(api.boundaryFiles, 'API boundary files').map(snapshotReference);
  if (!boundaries.length || new Set(boundaries).size !== boundaries.length) throw new CsoError('INVALID_SCHEMA', 'API scan needs unique security-boundary source paths');
  request.api = { runtimeProfile: string(api.runtimeProfile, 'API runtime profile', 100), port: boundedInt(api.port, 1024, 65535, 'API port'), start: validateCommand(api.start, 'API start'), control: control(api.control), boundaryFiles: boundaries, schema, operationIds: operations,
    ...(api.seed === undefined ? {} : { seed: boundedInt(api.seed, 1, 2147483647, 'API seed') }),
    ...(api.maxExamples === undefined ? {} : { maxExamples: boundedInt(api.maxExamples, 1, 100, 'API maxExamples') }) };
  const raw = JSON.stringify(request);
  if (redact(raw) !== raw) throw new CsoError('REDACTION_FAILED', 'Scanner harness contains secret-bearing material; use synthetic inputs');
  return request;
}

/** Resolve only helper-issued path references before any application command reaches containment. */
export function resolveScannerRequestPaths(manifest:SnapshotManifest,request:ScannerRequest):ScannerRequest{
  if(!request.api)return request;
  const resolve=(reference:string):string=>{const id=snapshotPathHandleId(reference);if(!id)return relativePath(reference);const entry=manifest.entries.find(item=>item.pathId===id);if(!entry)throw new CsoError('INVALID_SCHEMA',`API path handle is outside the retained snapshot: ${reference}`);return entry.path;};
  const argument=(value:string):string=>{if(snapshotPathHandleId(value))return resolve(value);if(value.startsWith('./')&&snapshotPathHandleId(value.slice(2)))return `./${resolve(value.slice(2))}`;return value;};
  return{...request,api:{...request.api,start:{...request.api.start,args:request.api.start.args.map(argument)},boundaryFiles:request.api.boundaryFiles.map(resolve)}};
}

export function scannerCoverage(outcome: ScannerOutcome, scope: string): CoverageRecord {
  return { domain: `scanner:${outcome.tool}`, scope, status: outcome.status === 'complete' ? 'assessed' : outcome.status,
    method: outcome.tool === 'sarif' ? 'bounded untrusted SARIF import' : 'qualified offline Docker scanner; candidate evidence only',
    gaps: outcome.gaps.map(g => g.message), exclusions: outcome.exclusions,
    evidence: [`${outcome.candidates.length} scanner candidates; plan ${outcome.planSha256}`],
    tool: { name: outcome.tool, version: outcome.version ?? 'unavailable', freshness: outcome.databaseUpdatedAt ?? 'not reported', outcome: outcome.status } };
}
function failure(plan: ScannerPlan, error: unknown, version?: string): ScannerOutcome {
  const e = error instanceof CsoError ? error : new CsoError('ISOLATION_FAILED', 'Scanner execution failed before bounded evidence was established');
  const codes: Record<ErrorCode, ScannerGap['code']> = {
    INVALID_ARGUMENT: 'INVALID_OUTPUT', INVALID_SCHEMA: 'INVALID_OUTPUT', MISSING_INPUT: 'MISSING_INPUT', SNAPSHOT_RACE: 'SNAPSHOT_RACE',
    UNSAFE_PATH: 'UNSAFE_PATH', REDACTION_FAILED: 'REDACTION_FAILED', PERSISTENCE_FAILED: 'PERSISTENCE_FAILED', TOOL_UNAVAILABLE: 'UNAVAILABLE',
    TOOL_FAILED: 'TOOL_FAILED', ISOLATION_FAILED: 'ISOLATION_FAILED', INSUFFICIENT_CAPACITY: 'INSUFFICIENT_CAPACITY', DEADLINE: 'TIMEOUT',
    CANCELLED: 'CANCELLED', PREREQUISITE: 'PREREQUISITE', INCOMPATIBLE_INPUT: 'PREREQUISITE', ASSERTION_FAILED: 'TOOL_FAILED',
  };
  const code = codes[e.code];
  return { ...parseScannerOutput(plan, { stdout: '', exitCode: null, version }), status: 'not_assessed', candidates: [], gaps: [{ code, message: e.message }] };
}

/** Empty catalogs and missing assets produce coverage gaps without opening Docker. */
export async function executeScanner(input: ScannerRunInput, dependencies: ScannerRunDependencies = {}): Promise<ScannerRunRecord> {
  const identityRequest = validateScannerRequest(input.request ?? {}, input.id), catalog = dependencies.catalog ?? SCANNER_CATALOG;
  const timeout = Math.min(300, Math.floor((input.executionDeadline - Date.now()) / 1000));
  let profile: QualifiedScanner | undefined, runtime: QualifiedRuntime | undefined, observedVersion: string | undefined, versionHash: string | null = null;
  let application: ScannerApplicationPreparation | undefined,request=identityRequest;
  let plan = scannerPlans({ snapshotRoot: '/source', offline: input.policy.offline, selected: [input.id], deadlineSeconds: Math.max(1, timeout) })[0];
  let outcome: ScannerOutcome, runner: ScannerRunner | undefined;
  try {
    if (timeout < 1) throw new CsoError('DEADLINE', 'No scanner time remains before the reporting reserve');
    assertSnapshot(input.runDir, input.manifest);
    request=resolveScannerRequestPaths(input.manifest,identityRequest);
    if (input.id === 'schemathesis' && input.policy.mode !== 'comprehensive') throw new CsoError('PREREQUISITE', 'Schemathesis requires comprehensive mode; daily audits do not execute applications');
    profile = selectScanner(input.id, input.platform, request.profile, catalog);
    const api = request.api;
    plan = scannerPlans({ snapshotRoot: '/source', offline: input.policy.offline, selected: [input.id], deadlineSeconds: timeout,
      tools: { [input.id]: { available: true, version: profile.version, capabilities: profile.capabilities } },
      semgrepRules: profile.assets?.semgrepRules?.path, advisoryCache: profile.assets?.advisoryDatabase?.path,
      ...(api ? { schemaPath: '/policy/openapi.json', baseUrl: `http://127.0.0.1:${api.port}/`, operationIds: api.operationIds, seed: api.seed, maxExamples: api.maxExamples } : {}) })[0];
    if (plan.prerequisites.length) throw new CsoError('PREREQUISITE', plan.prerequisites.join('; '));
    if (input.id === 'schemathesis') {
      if (!api) throw new CsoError('PREREQUISITE', 'Schemathesis requires a reviewed API harness and legitimate control');
      for (const file of api.boundaryFiles) {
        const entry = input.manifest.entries.find(e => e.path === file);
        if (!entry || !entry.executionHash || entry.transformation) throw new CsoError('INCOMPATIBLE_INPUT', `API security boundary is missing or transformed: ${file}`);
      }
      try { runtime = selectRuntime(api.runtimeProfile, input.platform, dependencies.runtimes ?? RUNTIME_CATALOG); }
      catch { throw new CsoError('PREREQUISITE', `Qualified application runtime is unavailable: ${api.runtimeProfile}`); }
      if (!['node', 'bun', 'python', 'rails'].includes(runtime.stack)) throw new CsoError('INCOMPATIBLE_INPUT', 'Schemathesis requires a qualified application runtime');
      const stack = runtime.stack as CsoStack, sourceRoot = join(input.runDir, 'snapshot');
      const preparation = inspectPreparation(sourceRoot, stack);
      assertRuntimeCompatible(preparation, runtime);
      const startPlan = canonicalStartPlan(sourceRoot, stack, api.port);
      if (canonical(api.start) !== canonical(startPlan.command)) throw new CsoError('INVALID_SCHEMA', `API start must use the helper-derived ${startPlan.kind} command`);
      for (const file of startPlan.entrypointFiles) if (!api.boundaryFiles.includes(file))
        throw new CsoError('INVALID_SCHEMA', `API boundary files must include canonical startup input: ${file}`);
      application = await (dependencies.applicationPreparer ?? prepareDockerScannerApplication)({
        input: { ...input, request }, runtime, stack, startPlan,
        deadline: Math.min(input.executionDeadline, Date.now() + timeout * 1000), catalog: dependencies.runtimes ?? RUNTIME_CATALOG,
      });
      const preparedStart = canonicalStartPlan(application.sourceRoot, stack, api.port);
      if (preparedStart.signature !== startPlan.signature || canonical(preparedStart.command) !== canonical(startPlan.command))
        throw new CsoError('ISOLATION_FAILED', 'Offline API preparation changed the canonical application startup inputs');
    }
    runner = await (dependencies.runnerFactory ?? createDockerScannerRunner)({ input: { ...input, request }, plan, profile, runtime, application, deadline: Math.min(input.executionDeadline, Date.now() + timeout * 1000) });
    const version = await runner.version();
    if (version.exitCode !== 0 || version.timedOut || version.truncated || version.unavailable || Buffer.byteLength(version.stdout) + Buffer.byteLength(version.stderr ?? '') > 8192) throw new CsoError('TOOL_UNAVAILABLE', 'Scanner version probe did not complete within the qualified sandbox');
    versionHash = scannerVersionHash(version.stdout, version.stderr);
    if (versionHash !== profile.versionOutputSha256) throw new CsoError('INCOMPATIBLE_INPUT', 'Scanner version output does not match its reviewed image profile');
    observedVersion = profile.version;
    const execution = await runner.scan();
    assertSnapshot(input.runDir, input.manifest);
    outcome = parseScannerOutput(plan, { ...execution, version: profile.version, databaseUpdatedAt: profile.assets?.advisoryDatabase?.updatedAt });
  } catch (error) { outcome = failure(plan, error, observedVersion); }
  finally {
    let cleanupError: unknown;
    if (runner) try { await runner.cleanup(); } catch (error) { cleanupError = error; }
    if (application) try { await application.cleanup(); } catch (error) { cleanupError ??= error; }
    if (cleanupError) outcome = failure(plan, cleanupError, observedVersion);
  }
  return { outcome: outcome!, coverage: scannerCoverage(outcome!, input.policy.scope), provenance: {
    scannerCatalog: catalog.revision, profile: profile?.id ?? null, image: profile?.image ?? null, platform: input.platform,
    isolationPolicyHash: profile?.isolationPolicyHash ?? null, sourceHash: input.manifest.executionHash, requestHash: sha256(canonical(identityRequest)), versionOutputSha256: versionHash,
    assets: profile?.assets ?? null, network: plan.network === 'loopback' ? 'isolated-loopback' : 'none', preparation: application?.proof ?? null } };
}

export async function prepareDockerScannerApplication(context: Parameters<ScannerApplicationPreparer>[0],dependencies:{endpoint?:DockerEndpoint;runnerFactory?:(options:ConstructorParameters<typeof DockerPreparationSandboxRunner>[0])=>PreparationSandboxRunner;cacheRoot?:string}={}): Promise<ScannerApplicationPreparation> {
  const { input, runtime, stack, deadline, catalog } = context;
  const root = secureDirectory(join(input.runDir, 'supervision', `scanner-preparation-${randomBytes(12).toString('hex')}`));
  let executor: PreparationExecutor | undefined, prepared: Awaited<ReturnType<PreparationExecutor['prepareOffline']>> | undefined;
  try {
    const plan = inspectPreparation(join(input.runDir, 'snapshot'), stack);
    const admission = admitPreparationRuntime({ plan, platform: input.platform, profile: runtime.id, catalog });
    const endpoint = dependencies.endpoint??await dockerEndpoint(root),runnerOptions={ endpoint, watchdogPath: input.watchdogPath,
      runRoot: root, controlRoot: secureDirectory(join(root, 'execution')), admission },runner=dependencies.runnerFactory?dependencies.runnerFactory(runnerOptions):new DockerPreparationSandboxRunner(runnerOptions);
    executor = new PreparationExecutor({ cache: new PublicArchiveCache({ root: dependencies.cacheRoot??publicArchiveCacheRoot(), stagingRoot: secureDirectory(join(root, 'staging')) }),
      runner, materializationRoot: secureDirectory(join(root, 'materializations')) });
    const closure = await executor.acquire({ plan, admission, snapshot: join(input.runDir, 'snapshot'), deadline, offline: input.policy.offline });
    let database:RailsDatabaseSelection|undefined;
    if(stack==='rails'){
      if(!plan.database?.selected)throw new CsoError('PREREQUISITE','Rails API preparation could not select one locked database adapter');
      database=plan.database.selected==='postgresql'
        ?{adapter:'postgresql',sidecar:admitPreparationSidecar({platform:input.platform,catalog})}:{adapter:'sqlite'};
    }
    prepared = await executor.prepareOffline({ plan, admission, snapshot: join(input.runDir, 'snapshot'), closure, deadline, database });
    const proof = { dependencyClosureHash: prepared.dependencyClosureHash, preparedManifestHash: prepared.preparedManifestHash,
      sourceProjectionHash: prepared.sourceProjectionHash, receiptHash: prepared.receiptHash,
      executionEnvironmentHash: sha256(canonical(prepared.executionEnvironment)), databaseHash: prepared.databaseHash };
    let cleaned = false;
    return { sourceRoot: prepared.preparedRoot, environment: prepared.executionEnvironment, database: prepared.database, proof, cleanup: async () => {
      if (cleaned) return; cleaned = true;
      await executor!.dispose(prepared!);
      fs.rmSync(root, { recursive: true, force: false });
    } };
  } catch (error) {
    let cleanupError:unknown;
    if (prepared && executor) try { await executor.dispose(prepared); } catch (failed) { cleanupError=failed; }
    // A failed Docker/retained-copy cleanup deliberately hands ownership to a
    // detached watchdog. Its journals and label-sweep scratch files live below
    // this root, so only remove the tree after every watchdog acknowledged.
    let pending=true;try{pending=hasPendingWatchdogCleanup(input.runDir);}catch(failed){cleanupError??=failed;}
    if(!cleanupError&&!pending)try { fs.rmSync(root, { recursive: true, force: false }); } catch {}
    if(cleanupError)throw cleanupError;
    throw error;
  }
}

/** No arbitrary runner configuration crosses this boundary; images and paths came from the catalog. */
export async function createDockerScannerRunner(context: ScannerRunnerContext): Promise<ScannerRunner> {
  const { input, plan, profile, runtime, application, deadline } = context;
  const attempt = `scanner-${input.id}-${randomBytes(12).toString('hex')}`;
  const controlDir = secureDirectory(join(input.runDir, 'supervision', attempt));
  const policyDir = secureDirectory(join(controlDir, 'policy'));
  const files: Array<{ host: string; container: string }> = [];
  const writePolicy = (container: string, content: string): void => {
    if (redact(content) !== content) throw new CsoError('REDACTION_FAILED', 'Scanner policy contains secret-bearing material');
    const host = join(policyDir, String(files.length)); fs.writeFileSync(host, content, { mode: 0o600, flag: 'wx' });
    files.push({ host, container });
  };
  let group: DockerGroup | undefined;
  try {
    for (const file of plan.trustedFiles) writePolicy(file.path, file.content);
    if (input.request?.api) writePolicy('/policy/openapi.json', JSON.stringify(input.request.api.schema));
    const endpoint: DockerEndpoint = await dockerEndpoint(controlDir);
    group = await DockerGroup.create(endpoint, attempt, controlDir, deadline, profile.image, input.watchdogPath);
    const createScanner=()=>group!.createContainer({ role: runtime ? 'verifier' : 'app', image: profile.image, source: join(input.runDir, 'snapshot'), command: ['/bin/sleep', '2147483647'], env: plan.env, readonlyFiles: files });
    let scanner = await createScanner();
    await group.start(scanner);
    const capture = async (command: string[]): Promise<ScannerExecution> => {
      if(!scanner)throw new CsoError('ISOLATION_FAILED','Scanner container is unavailable');
      const result = await group!.execCapture(scanner, command, { workdir: '/work', env: plan.env });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
    };
    return {
      version: () => capture([profile.executable, ...plan.versionArgs]),
      scan: async () => {
        const api = input.request?.api;
        if (api && runtime) {
          if (!application) throw new CsoError('ISOLATION_FAILED', 'Schemathesis application was not materialized through offline preparation');
          const env={ ...application.environment, PORT: String(api.port), HOST: '127.0.0.1', NODE_ENV: 'test', RAILS_ENV: 'test', RACK_ENV: 'test', PYTHONUNBUFFERED: '1', CI: '1', SECRET_KEY_BASE: 'cso-synthetic-test-key' };
          const rails=runtime.stack==='rails';
          if(rails){await group!.removeContainer(scanner);scanner='';}
          if(application.database?.adapter==='postgresql'){
            const databaseFile=join(policyDir,'postgresql.databases'),names=application.database.connections.map(name=>`cso_${name}`);
            if(!names.length||names.some(name=>!/^cso_[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name)))throw new CsoError('INCOMPATIBLE_INPUT','Prepared PostgreSQL connection names are invalid');
            fs.writeFileSync(databaseFile,names.join('\n')+'\n',{mode:0o444,flag:'wx'});
            const postgres=await group!.createContainer({role:'postgres',image:application.database.sidecar.image,command:['/opt/cso/run-postgresql','/policy/postgresql.databases'],postgresDatabasePolicy:databaseFile});await group!.start(postgres);
            let ready=false;for(let attempt=0;attempt<100&&!ready;attempt++){const checked=await group!.execCapture(postgres,['/opt/cso/postgresql-ready','/policy/postgresql.databases']);ready=checked.code===0;if(!ready)await new Promise(resolveWait=>setTimeout(resolveWait,50));}
            if(!ready)throw new CsoError('TOOL_FAILED','Disposable PostgreSQL did not become ready for Rails API scanning');
          }
          const app = await group!.createContainer({ role: 'app', image: runtime.image, source: application.sourceRoot, env,
            command:rails?['/opt/cso/run-app','/bin/sleep','2147483647']:['/opt/cso/run-app', api.start.executable, ...api.start.args] });
          await group!.start(app);
          if(rails){const clean=['/usr/bin/env','-i',...Object.entries(env).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`),'/usr/local/bin/bundle','exec','rails','db:prepare'];const prepared=await group!.execCapture(app,clean,{workdir:'/work'});if(prepared.code!==0)throw new CsoError('TOOL_FAILED','Rails API database preparation failed');await group!.execDetached(app,[api.start.executable,...api.start.args]);}
          const security = { ...api.control, vulnerable: { status: api.control.expected.status === 599 ? 598 : 599 } };
          const controlFile = join(policyDir, 'control.json');
          fs.writeFileSync(controlFile, JSON.stringify({ phase: 'after', port: api.port, legitimate: [api.control], security }), { mode: 0o600, flag: 'wx' });
          const probe = await group!.createContainer({ role: schemathesisControlRole(), image: runtime.image, command: ['/opt/cso/verifier', '/policy/control.json'], readonlyFiles: [{ host: controlFile, container: '/policy/control.json' }] });
          const observed = await group!.startAttach(probe); await group!.removeContainer(probe);
          let valid = false;
          try { const v = validateVerificationObservation(JSON.parse(observed.output)); valid = observed.code === 0 && v.booted && v.legitimate && v.security === 'pass'; } catch {}
          if (!valid) throw new CsoError('PREREQUISITE', 'API application boot or legitimate control failed; no Schemathesis requests were sent');
          if(rails){scanner=await createScanner();await group!.start(scanner);}
        }
        const execution = await capture([profile.executable, ...plan.args]);
        if (plan.outputPath) {
          const report = await capture(['/bin/cat', plan.outputPath]);
          if (report.exitCode !== 0) throw new CsoError('PREREQUISITE', 'Scanner did not produce its required bounded report file');
          return { ...execution, stdout: report.stdout, stderr: [execution.stderr, report.stderr].filter(Boolean).join('\n') };
        }
        return execution;
      },
      cleanup: async () => { await group!.cleanup(); fs.rmSync(policyDir, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (group) await group.cleanup();
    fs.rmSync(policyDir, { recursive: true, force: true });
    throw error;
  }
}
